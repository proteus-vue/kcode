//! 内嵌浏览器：右栏里的原生子视图。
//!
//! # 为什么是子 webview 而不是 iframe
//!
//! iframe 会被绝大多数站点的 `X-Frame-Options` / CSP `frame-ancestors`
//! 拒绝，用户看到的是一片空白且无从解释。Tauri 的 `Window::add_child`
//! 创建的是**独立 webview**（原生子视图），不受这些响应头限制，
//! 前提是启用 `unstable` feature。
//!
//! # 为什么必须手动同步位置
//!
//! 子 webview 是原生视图，**永远绘制在 DOM 之上**，且不参与 CSS 布局。
//! 因此它只有两种正确状态：
//!
//! - 可见时，位置与尺寸必须精确等于右侧栏里为它预留的矩形；
//! - 不可见时，必须真正 `hide()`。
//!
//! 做不到的话会出现两类「DOM 里完全看不出来」的问题：面板折叠了浏览器
//! 还浮在上面；窗口缩放后它停留在旧位置。所以每次布局变化（面板开关、
//! 拖拽分栏、窗口 resize）都必须重新同步——前端负责在布局变化后调用
//! [`BrowserState::sync_bounds`]。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewBuilder, Window};

/// 内嵌浏览器的 UA。
///
/// 与 webview 实际引擎一致（macOS 上是 WebKit）；声明成 Chrome 会拿到
/// 为 Blink 准备的代码路径，反而更容易出问题。
const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) \
AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";

/// 允许内嵌浏览器访问的 URL 协议。
///
/// 只放开 http/https。`file:` 不在其中——文件内容由应用自己读取后用
/// `data:`/`asset:` 呈现（见 `read_file_detail`），把 `file:` 交给
/// 通用浏览器视图等于给它开一个任意本地文件读取面。
fn is_allowed_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// 判断从 `from` 导航到 `to` 是否属于**安全降级**，应当拒绝。
///
/// 页面里的脚本可以把用户从 https 换到 http：
///
///   location.replace(location.href.replace("https://","http://"));
///
/// 这会让用户在不知情的情况下回到明文传输——地址栏看着还是那个域名，
/// 内容却已经可以被中间人改写。浏览器自身（HSTS）会拦一部分，
/// 但页面脚本主动跳转不在其列。
///
/// **只拦 https→http 这一种方向**：http→https 是升级，应当放行；
/// 同协议内的跳转（站点内导航、重定向到别的域名）都属正常。
pub fn is_downgrade(from: &str, to: &str) -> bool {
    let f = from.trim().to_ascii_lowercase();
    let t = to.trim().to_ascii_lowercase();
    f.starts_with("https://") && t.starts_with("http://")
}

pub struct BrowserState {
    /// 已创建的子 webview，按标签索引。
    views: Mutex<HashMap<String, tauri::Webview<tauri::Wry>>>,
    /// 「选择元素」的结果槽位。
    ///
    /// 为什么需要一个槽位：读取用 `eval_with_callback`，它是**异步回调**
    /// 而命令是同步返回的。所以采用「本次触发、下次轮询取回」的模式。
    pick_result: Arc<Mutex<Option<String>>>,
}

impl Default for BrowserState {
    fn default() -> Self {
        Self {
            views: Mutex::new(HashMap::new()),
            pick_result: Arc::new(Mutex::new(None)),
        }
    }
}

/// 把前端算好的逻辑坐标应用到子 webview。
///
/// 尺寸下限 1px：Tauri 对 0 尺寸会报错，而折叠动画过程中宽度会经过 0。
/// 这种情况按「隐藏」处理而不是报错——动画中间态不该让调用失败。
fn apply_bounds(view: &tauri::Webview<tauri::Wry>, x: f64, y: f64, w: f64, h: f64) -> Result<(), String> {
    if w < 1.0 || h < 1.0 {
        return view.hide().map_err(|e| e.to_string());
    }
    view.set_position(LogicalPosition::new(x, y))
        .map_err(|e| format!("设置浏览器位置失败: {e}"))?;
    view.set_size(LogicalSize::new(w, h))
        .map_err(|e| format!("设置浏览器尺寸失败: {e}"))?;
    view.show().map_err(|e| format!("显示浏览器失败: {e}"))?;
    Ok(())
}

/// 创建（或复用）右侧栏的内嵌浏览器并加载 URL。
///
/// 复用同一个子 webview 而不是每次重建：重建会丢失页面状态
/// （登录、滚动位置、未提交的表单），用户点开一个链接再点回来
/// 发现要重新登录，会认为这个功能不可用。
pub fn open_browser(
    window: &Window<tauri::Wry>,
    state: &BrowserState,
    label: &str,
    url: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    if !is_allowed_url(url) {
        return Err(format!(
            "只允许打开 http/https 地址；收到 `{}`",
            url.chars().take(60).collect::<String>()
        ));
    }

    let mut views = state.views.lock().map_err(|_| "浏览器状态锁被污染")?;

    if let Some(view) = views.get(label) {
        // 拒绝 https → http 的降级：页面脚本常这么干（实测百度在不认识
        // 的 UA 下就返回这种跳转），用户会以为还在安全连接上。
        let current = view.url().map(|u| u.to_string()).unwrap_or_default();
        if is_downgrade(&current, url) {
            return Err("拒绝从 https 降级到 http 的导航".to_owned());
        }
        // 复用：先导航再同步位置。顺序很重要——先显示旧页面再跳转
        // 会让用户看到一瞬间的上一个站点。
        view.navigate(url.parse().map_err(|e| format!("URL 无法解析: {e}"))?)
            .map_err(|e| format!("导航失败: {e}"))?;
        return apply_bounds(view, x, y, w, h);
    }

    let parsed = url.parse().map_err(|e| format!("URL 无法解析: {e}"))?;
    // position/size 只在创建时给初值，随后由 sync_bounds 接管
    //
    // **必须设置浏览器 UA。** 不设置时 webview 使用 Tauri 的默认标识，
    // 不少站点据此判定为爬虫并返回替代内容——实测百度返回一段
    // 227 字节的脚本，把页面从 https **降级** 到 http：
    //
    //   location.replace(location.href.replace("https://","http://"));
    //
    // 结果是白屏，而且用户以为自己在 https 上。设置标准 Safari UA 后
    // 拿到完整的 722KB 页面。
    //
    // 用与 webview 引擎一致的 Safari 标识：声称别的浏览器会拿到
    // 为那个引擎准备的代码路径，而我们实际跑的是 WebKit。
    let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed))
        .user_agent(SAFARI_UA);
    let view = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(w.max(1.0), h.max(1.0)),
        )
        .map_err(|e| format!("创建内嵌浏览器失败: {e}"))?;

    views.insert(label.to_owned(), view);
    Ok(())
}

/// 后退。
///
/// Tauri 没有暴露 history API，用 `eval` 调 history.back() 实现——
/// 这是 WebKit 自己维护的会话历史，与用户在同一 webview 里点链接的
/// 记录是同一份，所以行为与真实浏览器一致。
pub fn go_back(state: &BrowserState, label: &str) -> Result<(), String> {
    let views = state.views.lock().map_err(|_| "浏览器状态锁被污染")?;
    match views.get(label) {
        Some(v) => v.eval("history.back()").map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

pub fn go_forward(state: &BrowserState, label: &str) -> Result<(), String> {
    let views = state.views.lock().map_err(|_| "浏览器状态锁被污染")?;
    match views.get(label) {
        Some(v) => v.eval("history.forward()").map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// 重新加载当前页。
pub fn reload(state: &BrowserState, label: &str) -> Result<(), String> {
    let views = state.views.lock().map_err(|_| "浏览器状态锁被污染")?;
    match views.get(label) {
        Some(v) => v.reload().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// 设置缩放。范围限制在 0.25–3.0（浏览器的常规区间）。
///
/// WebKit 的 `setPageZoom` 是**跟随 webview**而非跟随页面的，
/// 所以缩放值在导航后仍然保持——不需要每次导航后重设。
pub fn set_zoom(state: &BrowserState, label: &str, factor: f64) -> Result<(), String> {
    let clamped = factor.clamp(0.25, 3.0);
    let views = state.views.lock().map_err(|_| "浏览器状态锁被污染")?;
    match views.get(label) {
        Some(v) => v.set_zoom(clamped).map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// 读取当前 URL 与页面标题。
///
/// 用于把地址栏同步成真实地址（用户点链接跳转后地址栏必须跟着变，
/// 否则显示的是他上一次输入的地址，与看到的内容不符）。
pub fn current_url(state: &BrowserState, label: &str) -> Result<String, String> {
    let views = state.views.lock().map_err(|_| "浏览器状态锁被污染")?;
    match views.get(label) {
        Some(v) => Ok(v.url().map(|u| u.to_string()).unwrap_or_default()),
        None => Ok(String::new()),
    }
}

/// 进入「选择元素」模式。
///
/// 注入一段脚本：高亮鼠标下的元素，点击时把它的选择器与文本写进
/// `document.title` 的约定前缀里。
///
/// **为什么用 title 传回而不是 IPC**：内嵌浏览器加载的是任意外部网页，
/// 它**没有**也无法获得 Tauri 的 IPC 权限（capability 用 webviews 精确
/// 限定，见 capabilities/default.json）。若为了这个功能给远程页面开
/// IPC，等于让任意站点都能调用 exec_start 与文件读取——代价远大于收益。
/// 页面拿不到任何能力。
pub fn begin_pick(state: &BrowserState, label: &str, token: &str) -> Result<(), String> {
    let views = state.views.lock().map_err(|_| "浏览器状态锁被污染")?;
    let view = match views.get(label) {
        Some(v) => v,
        None => return Ok(()),
    };

    // **进入选择模式前必须清掉上一次的结果。**
    //
    // 页面全局变量在选过一次之后仍然存在，而前端是轮询 take 的：
    // 第二次点「选择元素」时，第一次轮询就会读到那份残留值并立刻
    // 结束选择模式——用户看到的是「点了没反应、图标没高亮」。
    // 实测踩到过。
    let js = format!(
        "try {{ window.__kcode_pick_result__ = null; }} catch (e) {{}}\n{}",
        PICK_SCRIPT.replace("__TOKEN__", token)
    );
    view.eval(js).map_err(|e| e.to_string())
}

/// 取回一次选择结果（若有）。
///
/// 实现方式：`eval_with_callback` 读取页面上注入脚本留下的全局变量，
/// 结果写进共享槽位，前端轮询本命令取得。
///
/// **读取到即清除**（take 语义）：同一个选择只应被消费一次，
/// 否则前端每次轮询都会重复拿到同一份结果，把它重复加进对话。
pub fn take_pick(state: &BrowserState, label: &str) -> Result<Option<String>, String> {
    let (view, slot) = {
        let views = state.views.lock().map_err(|_| "浏览器状态锁被污染")?;
        match views.get(label) {
            Some(v) => (v.clone(), state.pick_result.clone()),
            None => return Ok(None),
        }
    };

    // 先看有没有已经取回的结果
    {
        let mut guard = slot.lock().map_err(|_| "选择结果锁被污染")?;
        if let Some(v) = guard.take() {
            return Ok(Some(v));
        }
    }

    // 没有就触发一次读取。eval_with_callback 是异步的：
    // 本次调用通常拿不到值，值会在下一次轮询时出现。
    let slot2 = slot.clone();
    view.eval_with_callback(
        "window.__kcode_pick_result__ || null",
        move |raw| {
            // webkit 会把结果 JSON 序列化后传回来；null 表示还没选
            let trimmed = raw.trim();
            if trimmed.is_empty() || trimmed == "null" {
                return;
            }
            // 取回后立刻清空页面侧的变量，避免重复消费
            if let Ok(mut g) = slot2.lock() {
                if g.is_none() {
                    *g = Some(trimmed.to_owned());
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;

    Ok(None)
}

/// 选择元素用的注入脚本。
///
/// 约束（都是实测出来的）：
/// - 不能用 `promise`：`evaluateJavaScript` 不 await Promise，
///   回调拿到的是 Promise 对象本身。所以状态放在全局变量里。
/// - 必须能被重复调用：用户可能取消后重新进入，脚本要幂等。
/// - 高亮用 outline 而不是 border：border 会改变布局，触发页面重排。
const PICK_SCRIPT: &str = r##"
(function () {
  const TOKEN = "__TOKEN__";
  const ID = "__kcode_pick__";
  if (window[ID] && window[ID].active) { window[ID].cancel(); }

  const HL = document.createElement("div");
  HL.setAttribute("data-kcode-pick", "1");
  HL.style.cssText = [
    "position:fixed","pointer-events:none","z-index:2147483647",
    "border:1px solid #6aa5ff","background:rgba(106,165,255,0.16)",
    "display:none","border-radius:2px"
  ].join(";");

  // 元素信息浮层：跟随高亮框显示标签、尺寸、颜色、字体。
  // 与参照一致——用户需要这些来判断自己选中的到底是哪一块、
  // 以及它的样式是不是他想要的那个。
  const INFO = document.createElement("div");
  INFO.setAttribute("data-kcode-pick", "1");
  INFO.style.cssText = [
    "position:fixed","pointer-events:none","z-index:2147483647",
    "display:none","min-width:220px",
    "padding:10px 12px","border-radius:10px",
    "background:rgba(24,28,36,0.97)","color:#e8ecf3",
    'font:12px/1.5 -apple-system,"SF Pro Text","PingFang SC",sans-serif',
    "box-shadow:0 8px 28px rgba(0,0,0,0.5)",
    "border:1px solid rgba(255,255,255,0.12)"
  ].join(";");

  document.documentElement.appendChild(HL);
  document.documentElement.appendChild(INFO);

  function row(name, value, strong) {
    const r = document.createElement("div");
    r.style.cssText = "display:flex;gap:14px;justify-content:space-between;align-items:baseline";
    const n = document.createElement("span");
    n.textContent = name;
    n.style.cssText = "color:#8b95a7;flex-shrink:0";
    const v = document.createElement("span");
    v.textContent = value;
    v.style.cssText = "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;text-align:right;word-break:break-word;" +
      (strong ? "font-weight:600;color:#fff;font-size:13px" : "");
    r.appendChild(n); r.appendChild(v);
    return r;
  }

  let hovered = null;

  function selectorFor(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      if (cur.id) { parts[0] = "#" + CSS.escape(cur.id); break; }
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function styleOf(el) {
    try {
      const c = getComputedStyle(el);
      return {
        color: c.color,
        font: [c.fontSize, c.fontFamily].filter(Boolean).join(" "),
        background: c.backgroundColor
      };
    } catch (e) { return { color: "", font: "", background: "" }; }
  }

  /** 把 rgb(...) 转成 #rrggbb，与参照的显示形式一致。 */
  function hex(rgb) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || "");
    if (!m) return rgb || "";
    const h = (n) => (+n).toString(16).padStart(2, "0");
    return "#" + h(m[1]) + h(m[2]) + h(m[3]);
  }

  function payload(el) {
    const r = el.getBoundingClientRect();
    const st = styleOf(el);
    return {
      token: TOKEN,
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || "").trim().slice(0, 400),
      width: Math.round(r.width),
      height: Math.round(r.height),
      url: location.href,
      title: document.title,
      color: hex(st.color),
      font: st.font,
      background: hex(st.background)
    };
  }

  function place(el) {
    const r = el.getBoundingClientRect();
    HL.style.display = "block";
    HL.style.left = r.left + "px";
    HL.style.top = r.top + "px";
    HL.style.width = r.width + "px";
    HL.style.height = r.height + "px";

    const st = styleOf(el);
    INFO.textContent = "";
    INFO.appendChild(row(el.tagName.toLowerCase(), Math.round(r.width) + "x" + Math.round(r.height), true));
    INFO.appendChild(row("Color", hex(st.color)));
    INFO.appendChild(row("Font", st.font));
    INFO.style.display = "block";

    // 放置规则：优先元素下方；下方放不下就翻到上方。
    // 若上下都放不下（元素本身几乎占满视口高度，实测遇到：欢迎区
    // 高度 473px 而视口不高），则**贴着视口底边**显示——
    // 关键是不能让浮层超出视口，否则标签名那一行会被裁掉，
    // 用户看不到自己选的是什么元素。
    const iw = INFO.offsetWidth, ih = INFO.offsetHeight;
    const GAP = 8;
    let top = r.bottom + GAP;
    if (top + ih > innerHeight - GAP) {
      const above = r.top - ih - GAP;
      top = above >= GAP ? above : Math.max(GAP, innerHeight - ih - GAP);
    }
    const left = Math.min(Math.max(GAP, r.left), Math.max(GAP, innerWidth - iw - GAP));
    INFO.style.left = left + "px";
    INFO.style.top = top + "px";
  }

  function onMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.hasAttribute("data-kcode-pick")) return;
    hovered = el;
    place(el);
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = hovered || document.elementFromPoint(e.clientX, e.clientY);
    if (!el) return;
    // 只写全局变量：页面拿不到任何能力，也不改动页面自身状态
    window.__kcode_pick_result__ = payload(el);
    // 选中后短暂保留标记，让用户看到「就是这一个」
    api.cancel();
  }

  function onKey(e) { if (e.key === "Escape") { api.cancel(); } }

  const api = {
    active: true,
    cancel: function () {
      if (!this.active) return;
      this.active = false;
      HL.remove();
      INFO.remove();
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey, true);
    }
  };
  window[ID] = api;

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  return "picking";
})();
"##;

/// 模拟视口：给定 CSS 尺寸与缩放，把子视图摆到对应位置。
///
/// # 为什么需要它
///
/// 桌面版网页普遍有最小宽度（百度约 1000px）。右栏只有 460px 宽时，
/// 页面无法收缩到视口内，必然横向溢出——表现为滚动条 + 内容被裁。
///
/// 解法与浏览器开发者工具的「设备模拟」相同：让页面以为自己有
/// `css_w` 宽，再把渲染结果整体缩小显示。实现是两步：
///
/// 1. 把子视图的 frame 设为 `css_w * scale`；
/// 2. 把 pageZoom 设为 `scale`。
///
/// WKWebView 的 pageZoom 影响**布局宽度**（frame / zoom = CSS 宽度），
/// 所以两者配合后页面按 `css_w` 布局、按 `scale` 呈现。
///
/// 注意：pageZoom 与「文本缩放」不同，后者不改布局。这里要的正是
/// 改布局——否则页面仍然按窄视口排版。
pub fn emulate_viewport(
    state: &BrowserState,
    label: &str,
    x: f64,
    y: f64,
    css_w: f64,
    css_h: f64,
    scale: f64,
) -> Result<(), String> {
    let views = state.views.lock().map_err(|_| "浏览器状态锁被污染")?;
    let view = match views.get(label) {
        Some(v) => v,
        None => return Ok(()),
    };
    let s = scale.clamp(0.1, 4.0);
    // 先设 frame 再设 zoom：顺序反过来时页面会先按旧 frame 与旧 zoom
    // 排一次版，切换大尺寸时能看到一次跳动。
    view.set_position(LogicalPosition::new(x, y))
        .map_err(|e| format!("设置位置失败: {e}"))?;
    view.set_size(LogicalSize::new(css_w * s, css_h * s))
        .map_err(|e| format!("设置尺寸失败: {e}"))?;
    view.set_zoom(s).map_err(|e| format!("设置缩放失败: {e}"))?;
    view.show().map_err(|e| format!("显示失败: {e}"))?;
    Ok(())
}

/// 同步子 webview 的位置与尺寸。不可见时传 0 尺寸即可隐藏。
pub fn sync_bounds(
    state: &BrowserState,
    label: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let views = state.views.lock().map_err(|_| "浏览器状态锁被污染")?;
    match views.get(label) {
        Some(view) => apply_bounds(view, x, y, w, h),
        // 还没创建就同步位置不是错误——前端可能先渲染占位再创建视图
        None => Ok(()),
    }
}

/// 隐藏（但不销毁）内嵌浏览器。
///
/// 不销毁是有意的：面板折叠再展开时页面应当还在原处。
/// 真正销毁走 [`close_browser`]。
pub fn hide_browser(state: &BrowserState, label: &str) -> Result<(), String> {
    let views = state.views.lock().map_err(|_| "浏览器状态锁被污染")?;
    match views.get(label) {
        Some(view) => view.hide().map_err(|e| e.to_string()),
        None => Ok(()),
    }
}

/// 销毁内嵌浏览器。
pub fn close_browser(window: &Window<tauri::Wry>, state: &BrowserState, label: &str) -> Result<(), String> {
    let mut views = state.views.lock().map_err(|_| "浏览器状态锁被污染")?;
    if let Some(view) = views.remove(label) {
        view.close().map_err(|e| e.to_string())?;
    }
    // 即使 map 里没有，也尝试按标签取一次——应用重启后 map 是空的，
    // 但窗口里可能还残留上次会话的子 webview。
    if let Some(v) = window.get_webview(label) {
        let _ = v.close();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_and_https_are_allowed() {
        assert!(is_allowed_url("https://example.com"));
        assert!(is_allowed_url("http://127.0.0.1:8899/"));
        assert!(is_allowed_url("HTTPS://Example.COM"));
        assert!(is_allowed_url("  https://example.com  "));
    }

    #[test]
    fn dangerous_schemes_are_rejected() {
        // file: 交给通用视图等于开放任意本地文件读取
        assert!(!is_allowed_url("file:///etc/passwd"));
        assert!(!is_allowed_url("javascript:alert(1)"));
        assert!(!is_allowed_url("data:text/html,<script>alert(1)</script>"));
        assert!(!is_allowed_url("ftp://example.com"));
        // 大小写与前缀混淆
        assert!(!is_allowed_url("FILE:///etc/passwd"));
        assert!(!is_allowed_url("java\tscript:alert(1)"));
    }

    #[test]
    fn user_agent_looks_like_a_real_browser() {
        // 这条**不能**证明 UA 被用上了（那只有真实站点能验证，见
        // open_browser 的注释与 baidu 白屏的排查记录），但它能挡住
        // 「手滑把 UA 改成 kcode/x.y」这类退化——UA 里必须同时有
        // Mozilla 与 AppleWebKit，否则站点会走非浏览器分支。
        assert!(SAFARI_UA.contains("Mozilla/5.0"), "UA 必须像浏览器");
        assert!(SAFARI_UA.contains("AppleWebKit"), "要与 WebKit 引擎一致");
        // 不应声明成 Chrome/Firefox：会拿到为别家引擎准备的代码路径
        assert!(!SAFARI_UA.contains("Chrome/"));
        assert!(!SAFARI_UA.contains("Firefox/"));
    }

    #[test]
    fn https_to_http_is_a_downgrade() {
        // 页面脚本可以这么干：实测百度在陌生 UA 下返回的正是
        // location.href.replace("https://","http://")
        assert!(is_downgrade("https://www.baidu.com", "http://www.baidu.com"));
        assert!(is_downgrade("HTTPS://A.com/x", "http://a.com/y"));
    }

    #[test]
    fn upgrading_and_same_scheme_are_allowed() {
        // http → https 是升级
        assert!(!is_downgrade("http://a.com", "https://a.com"));
        // 同协议内跳转都正常
        assert!(!is_downgrade("https://a.com", "https://b.com"));
        assert!(!is_downgrade("http://a.com", "http://b.com"));
        assert!(!is_downgrade("https://a.com", "https://a.com/x"));
    }

    #[test]
    fn empty_url_is_rejected() {
        assert!(!is_allowed_url(""));
        assert!(!is_allowed_url("   "));
        // 无协议的裸域名也不接受——用户可能以为能用，但那会走到
        // WebviewUrl 的解析路径，行为不确定
        assert!(!is_allowed_url("example.com"));
    }
}

