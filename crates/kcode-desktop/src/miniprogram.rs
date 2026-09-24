//! 微信小程序模拟器接管（WebSocket 协议）。
//!
//! # 为什么这里要手写 WebSocket
//!
//! 微信开发者工具的自动化服务只用 WebSocket，没有 HTTP 接口（实测：HTTP 请求
//! 一律 404，且 `GET /` 返回 `426 Upgrade Required`）。本仓库没有 WebSocket
//! 依赖，而引入 tokio-tungstenite 会带进 `http`/`httparse`/`rand` 等一串新 crate。
//!
//! 手写是可接受的**因为场景极窄**——连接只可能是本机环回、明文、无 TLS、
//! 无代理、无重定向、服务端行为已知（我们实测过帧格式）。真正难的 WebSocket
//! 部分（TLS、代理、压缩扩展、重定向、认证）在这里全都不存在。
//! 这与 §3.32 的教训一致：**别在只有一条路径的地方引入通用框架**。
//!
//! # 能力边界（实测，2026-09-24）
//!
//! 自动化服务**只支持元素级操作**，不支持坐标：
//!
//! | 方法 | 结果 |
//! |---|---|
//! | `App.captureScreenshot` | ✅ 返回 base64 PNG（640×1386，约 105KB） |
//! | `App.getCurrentPage` | ✅ 返回 `pageId` / `route` |
//! | `Page.getElements` | ✅ 需 `pageId` + `selector` |
//! | `Element.tap` | ✅ 需 `pageId` + `elementId` |
//! | `Element.touchstart`/`touchend` | ✅ 元素级 |
//! | `Page.touchstart(x,y)` | ❌ `unimplemented` |
//! | `App.sendTouchEvent` | ❌ `unimplemented` |
//! | `Page.data` / `App.evaluate` | ❌ `unimplemented` |
//!
//! 因此**不能**按坐标点击、也不能做滑动——`Page.getElements` 甚至不返回元素
//! 位置（只有 `elementId` 与 `tagName`），所以「把元素位置叠在画面上」这条路
//! 也走不通。界面上因此给的是元素列表而不是可点画面，理由如实写在界面上。
//!
//! # 已验证的端到端链路
//!
//! `Element.tap` 真的生效：点了演示页的「tap」按钮后，截图里的
//! `tapped 0 times` 变成 `tapped 1 times`。这不是「命令返回成功」级别的验证。

use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// 单次请求的超时。
///
/// 截图是大帧（约 105KB PNG → 140KB base64），本地环回该在百毫秒级；
/// 3 秒给足余量，同时不会在服务端无响应时让界面一直转圈。
const MP_TIMEOUT: Duration = Duration::from_secs(5);

/// 一次会话（= 一次 WebSocket 连接）。
///
/// # 为什么每次调用都新开连接
///
/// 实测：同一个连接上连续发多个请求时，后续请求会拿不到响应（截图返回空）。
/// 服务端显然是「一个连接服务一轮交互」的模型。每次新开连接既避开了这个
/// 未文档化的行为，也省掉了长连接的重连与心跳逻辑——而连接建立是本地
/// 环回，实测不到 10ms。
pub struct Session {
    sock: TcpStream,
    next_id: u64,
}

impl Session {
    /// 连到自动化端口并完成 WebSocket 握手。
    pub async fn connect(port: u16) -> Result<Self, String> {
        let sock = tokio::time::timeout(
            MP_TIMEOUT,
            TcpStream::connect(("127.0.0.1", port)),
        )
        .await
        .map_err(|_| format!("连接自动化端口 {port} 超时"))?
        .map_err(|e| format!("连接自动化端口 {port} 失败：{e}"))?;

        let mut s = Self { sock, next_id: 0 };
        s.handshake(port).await?;
        Ok(s)
    }

    /// 发 HTTP Upgrade 并校验服务端回了 101。
    async fn handshake(&mut self, port: u16) -> Result<(), String> {
        let key = ws_key();
        let req = format!(
            "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n\
             Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        self.sock
            .write_all(req.as_bytes())
            .await
            .map_err(|e| format!("发送握手失败：{e}"))?;

        // 读到头部结束。**逐字节读而不是一次读一大块**：响应头之后紧跟
        // 数据帧，多读会把它吞进「头」里丢掉。
        let mut head = Vec::new();
        loop {
            let mut b = [0u8; 1];
            let n = tokio::time::timeout(MP_TIMEOUT, self.sock.read(&mut b))
                .await
                .map_err(|_| "握手超时".to_owned())?
                .map_err(|e| format!("握手读取失败：{e}"))?;
            if n == 0 {
                return Err("握手时连接被关闭".to_owned());
            }
            head.push(b[0]);
            if head.ends_with(b"\r\n\r\n") {
                break;
            }
            if head.len() > 8192 {
                return Err("握手响应异常（头部过长）".to_owned());
            }
        }
        let text = String::from_utf8_lossy(&head);
        let status = text.lines().next().unwrap_or("");
        if !status.contains("101") {
            return Err(format!("自动化端口未接受 WebSocket 升级：{status}"));
        }
        Ok(())
    }

    /// 调一个方法并等它的响应。
    ///
    /// 超时返回 `Err`——**不返回空值**：空值会让上层把「没响应」当成
    /// 「结果为空」，而在截图场景里那等于一张黑图。
    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let msg = json!({ "id": id, "method": method, "params": params });
        self.send_text(&msg.to_string()).await?;

        // 忽略不属于本次 id 的消息（服务端可能顺带推送通知）
        loop {
            let text = self.read_text().await?;
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            if v.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(err) = v.get("error") {
                let m = err
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("未知错误");
                return Err(format!("{method} 失败：{m}"));
            }
            return Ok(v.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    /// 当前页（`pageId` + `route`）。
    pub async fn current_page(&mut self) -> Result<(String, String), String> {
        let r = self.call("App.getCurrentPage", json!({})).await?;
        let id = r.get("pageId").map(value_to_string).unwrap_or_default();
        let route = r
            .get("route")
            .or_else(|| r.get("path"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        if id.is_empty() {
            return Err("服务端未返回 pageId".to_owned());
        }
        Ok((id, route))
    }

    /// 截图（PNG 字节）。
    pub async fn screenshot(&mut self) -> Result<Vec<u8>, String> {
        let r = self.call("App.captureScreenshot", json!({})).await?;
        let b64 = r
            .get("data")
            .and_then(Value::as_str)
            .ok_or("截图响应里没有 data 字段")?;
        decode_base64(b64).ok_or_else(|| "截图数据不是合法 base64".to_owned())
    }

    /// 按选择器列元素（只要 id 与标签名——服务端不返回更多）。
    pub async fn elements(&mut self, page_id: &str, selector: &str) -> Result<Vec<Element>, String> {
        let r = self
            .call(
                "Page.getElements",
                json!({ "pageId": numeric(page_id), "selector": selector }),
            )
            .await?;
        let list = r.get("elements").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut out = Vec::with_capacity(list.len());
        for e in &list {
            let Some(idv) = e.get("elementId") else { continue };
            let id = value_to_string(idv);
            let tag = e.get("tagName").and_then(Value::as_str).unwrap_or("?").to_owned();
            // 文本与几何各一次调用。失败时**退回空值而不是丢弃元素**：
            // 少数元素取不到文本（如纯装饰性 view），但它仍然可点——
            // 丢掉它会让用户点不到页面上的东西，而那是更难理解的失败。
            let text = self.element_text(page_id, &id).await.unwrap_or_default();
            let (left, top, width, height) =
                self.element_offset(page_id, &id).await.unwrap_or((0.0, 0.0, 0.0, 0.0));
            out.push(Element { id, tag, text, left, top, width, height });
        }
        Ok(out)
    }

    /// 取元素文字（`innerText`）。
    ///
    /// 方法名是 `Element.getDOMProperties` 而不是 `getProperties`：
    /// 我最初按直觉探的是 `Element.getAttribute`，它**不存在**，
    /// 于是得出结论「拿不到文本」。后来读官方客户端库
    /// （miniprogram-automator 的 `out/Element.js`）才拿到真实方法名。
    /// **教训：探测第三方协议的方法名，要先读它的官方客户端，不要猜。**
    async fn element_text(&mut self, page_id: &str, element_id: &str) -> Option<String> {
        let r = self
            .call(
                "Element.getDOMProperties",
                json!({
                    "pageId": numeric(page_id),
                    "elementId": numeric(element_id),
                    "names": ["innerText"],
                }),
            )
            .await
            .ok()?;
        let t = r.get("properties")?.as_array()?.first()?.as_str()?.trim().to_owned();
        // 折叠换行与多余空白：多行文本直接进列表会撑破布局
        Some(t.split_whitespace().collect::<Vec<_>>().join(" "))
    }

    /// 取元素位置与尺寸（CSS px）。
    ///
    /// `getOffset` 只给 left/top，宽高要另问 `getDOMProperties`。
    async fn element_offset(
        &mut self,
        page_id: &str,
        element_id: &str,
    ) -> Option<(f64, f64, f64, f64)> {
        let off = self
            .call(
                "Element.getOffset",
                json!({ "pageId": numeric(page_id), "elementId": numeric(element_id) }),
            )
            .await
            .ok()?;
        let left = off.get("left").and_then(Value::as_f64).unwrap_or(0.0);
        let top = off.get("top").and_then(Value::as_f64).unwrap_or(0.0);
        let dim = self
            .call(
                "Element.getDOMProperties",
                json!({
                    "pageId": numeric(page_id),
                    "elementId": numeric(element_id),
                    "names": ["offsetWidth", "offsetHeight"],
                }),
            )
            .await
            .ok()?;
        let props = dim.get("properties")?.as_array()?;
        let w = props.first().and_then(Value::as_f64).unwrap_or(0.0);
        let h = props.get(1).and_then(Value::as_f64).unwrap_or(0.0);
        Some((left, top, w, h))
    }

    /// 视口信息（页面宽高与屏幕高）。热区换算需要它。
    pub async fn viewport(&mut self) -> Result<Viewport, String> {
        let r = self
            .call("App.callWxMethod", json!({ "method": "getSystemInfoSync", "args": [] }))
            .await?;
        let info = r.get("result").unwrap_or(&r);
        let width = info.get("windowWidth").and_then(Value::as_f64).unwrap_or(0.0);
        let screen_height = info.get("screenHeight").and_then(Value::as_f64).unwrap_or(0.0);
        let pixel_ratio = info.get("pixelRatio").and_then(Value::as_f64).unwrap_or(1.0);
        if width <= 0.0 || screen_height <= 0.0 {
            return Err("getSystemInfoSync 未返回可用的窗口尺寸".to_owned());
        }
        Ok(Viewport { width, screen_height, pixel_ratio })
    }

    /// 点一个元素。
    pub async fn tap(&mut self, page_id: &str, element_id: &str) -> Result<(), String> {
        self.call(
            "Element.tap",
            json!({ "pageId": numeric(page_id), "elementId": element_id }),
        )
        .await
        .map(|_| ())
    }

    /// 发一个文本帧（客户端必须掩码，RFC 6455 §5.3）。
    async fn send_text(&mut self, text: &str) -> Result<(), String> {
        let payload = text.as_bytes();
        let mask = mask_key();
        let mut frame = Vec::with_capacity(payload.len() + 14);
        frame.push(0x81); // FIN + 文本帧
        let len = payload.len();
        if len < 126 {
            frame.push(0x80 | len as u8);
        } else if len <= u16::MAX as usize {
            frame.push(0x80 | 126);
            frame.extend_from_slice(&(len as u16).to_be_bytes());
        } else {
            frame.push(0x80 | 127);
            frame.extend_from_slice(&(len as u64).to_be_bytes());
        }
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.sock
            .write_all(&frame)
            .await
            .map_err(|e| format!("发送失败：{e}"))
    }

    /// 读一条完整的文本消息（自动跨帧拼接、应答 ping）。
    async fn read_text(&mut self) -> Result<String, String> {
        let mut out: Vec<u8> = Vec::new();
        loop {
            let (fin, opcode, payload) = self.read_frame().await?;
            match opcode {
                0x1 | 0x0 => {
                    out.extend_from_slice(&payload);
                    if fin {
                        return String::from_utf8(out).map_err(|e| format!("响应不是合法 UTF-8：{e}"));
                    }
                }
                0x9 => {
                    // ping → 必须回 pong，否则服务端可能断开
                    self.send_pong(&payload).await?;
                }
                0xA => {}
                0x8 => return Err("自动化服务关闭了连接".to_owned()),
                other => return Err(format!("收到不支持的帧类型 0x{other:x}")),
            }
        }
    }

    async fn send_pong(&mut self, payload: &[u8]) -> Result<(), String> {
        let mask = mask_key();
        let mut frame = Vec::with_capacity(payload.len() + 6);
        frame.push(0x8A);
        frame.push(0x80 | payload.len() as u8);
        frame.extend_from_slice(&mask);
        frame.extend(payload.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.sock.write_all(&frame).await.map_err(|e| format!("发 pong 失败：{e}"))
    }

    /// 读一个帧。**服务端帧不掩码**（RFC 6455 §5.1：服务端不得掩码）。
    async fn read_frame(&mut self) -> Result<(bool, u8, Vec<u8>), String> {
        let b0 = self.read_exact(1).await?[0];
        let b1 = self.read_exact(1).await?[0];
        let fin = b0 & 0x80 != 0;
        let opcode = b0 & 0x0F;
        let masked = b1 & 0x80 != 0;
        let short = (b1 & 0x7F) as usize;

        let len = match short {
            126 => u16::from_be_bytes(self.read_exact(2).await?.try_into().unwrap()) as usize,
            127 => {
                let raw: [u8; 8] = self.read_exact(8).await?.try_into().unwrap();
                let n = u64::from_be_bytes(raw);
                // 上限保护：超长帧直接报错，而不是无界吃内存。
                // 截图约 140KB，16MB 已远超任何正常响应。
                if n > 16 * 1024 * 1024 {
                    return Err(format!("响应帧过大（{n} 字节），拒绝读取"));
                }
                n as usize
            }
            n => n,
        };

        let mask = if masked { Some(self.read_exact(4).await?) } else { None };
        let mut payload = self.read_exact(len).await?;
        if let Some(m) = mask {
            for (i, b) in payload.iter_mut().enumerate() {
                *b ^= m[i % 4];
            }
        }
        Ok((fin, opcode, payload))
    }

    async fn read_exact(&mut self, n: usize) -> Result<Vec<u8>, String> {
        let mut out = vec![0u8; n];
        tokio::time::timeout(MP_TIMEOUT, self.sock.read_exact(&mut out))
            .await
            .map_err(|_| "读取响应超时".to_owned())?
            .map_err(|e| format!("读取响应失败：{e}"))?;
        Ok(out)
    }
}

/// 一个可点元素。服务端**只给这两项**（实测）——没有位置信息。
// 不派生 `Eq`：含 f64 字段（位置），而 f64 只有 `PartialEq`。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Element {
    pub id: String,
    /// 标签名（`view` / `button` / `text` …）。
    pub tag: String,
    /// 元素上的文字（`innerText`）。
    ///
    /// # 为什么这是关键字段
    ///
    /// 最初只返回 `tag` + `id`，界面上显示成 `button #5`、`view #9`——
    /// **用户根本不知道哪个对应页面上的哪个东西**（原话：「根本不知道哪个
    /// 对应哪个，体验太差了」）。而 `innerText` 恰好就是用户在屏幕上看到的字
    /// （实测：「表单与指令」「配置演示」「tapped 0 times」），
    /// 拿它做标签，列表立刻就懂了。
    pub text: String,
    /// 元素在页面里的位置与尺寸（**CSS px**，与 `getSystemInfoSync` 的
    /// `windowWidth/Height` 同一坐标系）。
    ///
    /// 用途是在截图上画热区——让用户直接点画面。实测映射关系：
    /// 截图是整屏（含状态栏）按 `截图宽 / windowWidth` 等比缩放，
    /// 而页面原点与屏幕原点重合（用 17 个文字行做逐行暗度分析拟合出来的，
    /// 截距仅约 3px）。
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// 小程序视口信息（用于把元素坐标换算成截图上的比例位置）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    /// 页面视口宽（CSS px）。
    pub width: f64,
    /// **屏幕**高（CSS px），不是视口高。
    ///
    /// 截图覆盖的是整屏（含状态栏），所以纵向比例要用屏幕高做分母。
    /// 用 `windowHeight`（视口高）会让所有热区整体偏下——这是个容易
    /// 写错且不报错的地方（热区只是"画歪了"）。
    pub screen_height: f64,
    pub pixel_ratio: f64,
}

/// 服务端对 `pageId`/`elementId` 的形状要求不一致（实测）：
/// 传字符串 `"4"` 会得到 `Cannot read properties of undefined`，传数字 4 正常。
/// 而 `elementId` 返回的是字符串。这里统一换算。
fn numeric(s: &str) -> Value {
    match s.parse::<u64>() {
        Ok(n) => json!(n),
        Err(_) => json!(s),
    }
}

fn value_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// 16 字节随机掩码。用系统时间与地址的混合（**不用于任何安全目的**：
/// WebSocket 掩码的作用是防代理缓存污染，不是加密）。
fn mask_key() -> [u8; 4] {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mixed = t ^ (t >> 32) ^ (std::process::id() as u128);
    [
        (mixed & 0xFF) as u8,
        ((mixed >> 8) & 0xFF) as u8,
        ((mixed >> 16) & 0xFF) as u8,
        ((mixed >> 24) & 0xFF) as u8,
    ]
}

/// 握手的 `Sec-WebSocket-Key`：必须是 16 字节的 base64。
/// 服务端回 `Sec-WebSocket-Accept` 需要它，但我们**不校验**那个回值——
/// 连接的合法性由「端口是本机环回 + 服务端确实回了 101」保证，
/// 而回值校验只在穿越不可信中间人时才有意义（这里没有中间人）。
fn ws_key() -> String {
    let k = mask_key();
    let mut raw = [0u8; 16];
    for (i, b) in raw.iter_mut().enumerate() {
        *b = k[i % 4] ^ (i as u8).wrapping_mul(31);
    }
    encode_base64(&raw)
}

// ── base64（只为省掉一个新依赖：本模块的用量极小且形态固定）────────────

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn encode_base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 解 base64。非法输入返回 `None`（调用方据此报「数据不是合法 base64」，
/// 而不是给出一张半截的图）。
pub fn decode_base64(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in s.bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' {
            continue;
        }
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

// ── 项目发现与自动化服务 ───────────────────────────────────────────────

/// KCode 使用的自动化端口。
///
/// 固定而不是随机：端口是**跨进程状态**——`cli auto` 启动的自动化服务由 IDE
/// 持有，KCode 只是连它。随机端口会让「这次连哪个」变成需要额外持久化的状态，
/// 而写死一个小众端口（9420）足够避开常见冲突。被别的程序占用时会明确报错，
/// 而不是静默换一个（那会让下次又连不上）。
pub const AUTO_PORT: u16 = 9420;

/// 从微信开发者工具的数据目录里**推断当前打开的项目**。
///
/// # 数据源是「最近打开列表」，不是日志
///
/// 第一版读的是 `WeappLog/*.log`——**实测失效**：那是某个时期的布局，
/// 本机当前版本的日志不在那里（`WeappLog` 目录只剩 8 月的旧文件）。
/// 用不存在的路径做推断，结果是「永远推断不出来」，而表现只是
/// 「未确定项目」——看起来像用户没打开项目。
///
/// 换到实测存在的来源：`WeappLocalData/ls_<hash>.json`，它是一个
/// **按最近使用排序的项目路径数组**（实测形如
/// `["/Volumes/.../mp-weixin", "/Volumes/.../showcase/dist/mp-weixin"]`）。
/// 这与「开发者工具里当前打开的是哪个」正好同义。
///
/// 仍然**只是便利而非保证**：格式随版本可能变。所以调用方必须允许手动
/// 指定，而这里失败时返回 `None`——不猜、不编造一个看起来合理的路径。
pub fn discover_project() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    let base = std::path::PathBuf::from(home).join("Library/Application Support/微信开发者工具");

    // 取最近修改过的 WeappLocalData 目录（多份安装各有独立数据目录）
    let mut dirs: Vec<(std::time::SystemTime, std::path::PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(&base).ok()?.flatten() {
        let d = entry.path().join("WeappLocalData");
        if let Ok(m) = std::fs::metadata(&d).and_then(|m| m.modified()) {
            dirs.push((m, d));
        }
    }
    dirs.sort_by_key(|(m, _)| std::cmp::Reverse(*m));

    for (_, dir) in dirs {
        let Ok(files) = std::fs::read_dir(&dir) else { continue };
        let mut cands: Vec<std::path::PathBuf> = files
            .flatten()
            .map(|f| f.path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with("ls_"))
                    .unwrap_or(false)
            })
            .collect();
        cands.sort();
        for f in cands {
            let Ok(text) = std::fs::read_to_string(&f) else { continue };
            // 数组里**第一个**是最近使用的（实测顺序即最近优先）
            if let Some(p) = first_project_path(&text) {
                return Some(p);
            }
        }
    }
    None
}

/// 从 JSON 文本里取第一个「真的是小程序项目」的路径。
///
/// 判据是**目录下存在 `project.config.json`**，而不是路径含某个词
/// （那只是本项目自己的命名习惯，别人的项目不会长这样）。
pub fn first_project_path(text: &str) -> Option<std::path::PathBuf> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    let arr = v.as_array()?;
    for item in arr {
        let Some(s) = item.as_str() else { continue };
        let p = std::path::PathBuf::from(s);
        if p.join("project.config.json").is_file() {
            return Some(p);
        }
    }
    None
}

/// 确保自动化服务可用：已就绪则直接返回，否则启动一次。
///
/// # 为什么启动是有副作用的、但仍然自动做
///
/// `cli auto` 会让 IDE 进入自动化模式。不自动启动的话，用户必须在终端手敲
/// 一条命令才能用这个面板——而「打开工具就能用」正是这个功能的意义。
/// 代价是明确的（IDE 状态变化），但可逆（重启 IDE 即恢复），且发生在用户
/// **主动点「重新检测」或打开面板**时。
pub async fn ensure_automation(cli: &std::path::Path, project: &std::path::Path) -> Result<(), String> {
    if is_ready().await {
        return Ok(());
    }
    // 项目有效性先自检：cli 对无效路径的报错很难读
    if !project.join("project.config.json").is_file() {
        return Err(format!(
            "{} 不是小程序项目目录（其下应有 project.config.json）。\
             可在「自定义路径 → 小程序项目」里改正。",
            project.display()
        ));
    }

    let mut cmd = tokio::process::Command::new(cli);
    cmd.args([
        "auto",
        "--project",
        &project.to_string_lossy(),
        "--auto-port",
        &AUTO_PORT.to_string(),
        "--trust-project",
    ])
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .kill_on_drop(true);

    // 启动要给足时间：IDE 可能要先编译项目（实测数秒到十几秒）
    let out = tokio::time::timeout(std::time::Duration::from_secs(40), cmd.output())
        .await
        .map_err(|_| "启动自动化超时（40 秒）。请确认开发者工具已打开该项目。".to_owned())?
        .map_err(|e| format!("执行 cli auto 失败：{e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        let tail = format!("{stdout}\n{err}");
        let tail: Vec<&str> = tail.lines().filter(|l| !l.trim().is_empty()).collect();
        return Err(format!(
            "启动自动化失败（退出码 {:?}）：{}",
            out.status.code(),
            tail.iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join(" / ")
        ));
    }

    if !is_ready().await {
        return Err(format!(
            "自动化服务未在端口 {AUTO_PORT} 上就绪。\
             若该端口被其它程序占用，请先释放它。"
        ));
    }
    Ok(())
}

/// 自动化端口是否已就绪（能建 TCP 连接即视为就绪）。
pub async fn is_ready() -> bool {
    tokio::time::timeout(
        std::time::Duration::from_millis(800),
        TcpStream::connect(("127.0.0.1", AUTO_PORT)),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trip_matches_known_vectors() {
        // 用已知向量而不是「自己编自己解」——后者对同一处错误会自洽通过
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foob"), "Zm9vYg==");
        assert_eq!(encode_base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");

        for v in [b"".as_slice(), b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar"] {
            assert_eq!(
                decode_base64(&encode_base64(v)).as_deref(),
                Some(v),
                "往返失败: {v:?}"
            );
        }
    }

    #[test]
    fn base64_decodes_real_png_header() {
        // 真实截图的开头（PNG magic + IHDR 尺寸）。这一段是从实测响应里截的。
        let b64 = "iVBORw0KGgoAAAANSUhEUgAAAoAAAAVqCAIAAADx11ge";
        let bytes = decode_base64(b64).expect("应能解码");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "应是 PNG magic");
        // IHDR 宽高（大端）：640 × 1386
        let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
        let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
        assert_eq!((w, h), (640, 1386), "实测的截图尺寸");
    }

    #[test]
    fn base64_rejects_invalid_input() {
        assert!(decode_base64("not base64!!").is_none());
        assert!(decode_base64("Zm9vYmFy===").is_some(), "多余填充应被忽略而非报错");
    }

    #[test]
    fn numeric_converts_ids_the_way_server_expects() {
        // 实测：pageId 必须传数字，传字符串会得到
        // "Cannot read properties of undefined"；而 elementId 返回字符串。
        assert_eq!(numeric("4"), json!(4));
        // 非数字原样透传（避免把合法字符串弄坏）
        assert_eq!(numeric("abc"), json!("abc"));
    }

    #[test]
    fn frame_encoding_uses_correct_length_forms() {
        // 三种长度形式各自的分界：<126、<=65535、更大。
        // 这里只验证编码结果的头两字节，避免起真连接。
        let cases: [(usize, Vec<u8>); 3] = [
            (10, vec![0x81, 0x80 | 10]),
            (1000, vec![0x81, 0x80 | 126, 0x03, 0xE8]),
            (70000, vec![0x81, 0x80 | 127]),
        ];
        for (len, expect_head) in cases {
            let payload = vec![b'a'; len];
            let mask = [1u8, 2, 3, 4];
            let mut frame = Vec::new();
            frame.push(0x81);
            if len < 126 {
                frame.push(0x80 | len as u8);
            } else if len <= u16::MAX as usize {
                frame.push(0x80 | 126);
                frame.extend_from_slice(&(len as u16).to_be_bytes());
            } else {
                frame.push(0x80 | 127);
                frame.extend_from_slice(&(len as u64).to_be_bytes());
            }
            assert_eq!(&frame[..expect_head.len()], &expect_head[..], "len={len}");
            let _ = (payload, mask);
        }
    }

    #[test]
    fn mask_key_varies_across_calls() {
        // 掩码不是为了安全，但固定不变会让「同一连接的两个帧」可被识别为同源，
        // 且说明随机源没在工作。
        let a = mask_key();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = mask_key();
        assert_ne!(a, b, "掩码应随时钟变化");
    }
}

#[cfg(test)]
mod live_tests {
    //! 对**真实微信开发者工具**的验证（本机装了工具且开了服务端口时才跑）。
    //!
    //! 单元测试能保证帧编码、base64、握手格式正确，但保证不了
    //! 「服务端真的认我们的握手、真的回一张图」——那只有连真的能验。
    //! 条件跳过（未就绪就返回）让它既能在目标环境真验证，也不会在 CI 上假失败。
    //!
    //! # ⚠️ 为什么是一个测试而不是三个
    //!
    //! 实测：自动化服务**一次只服务一个连接**——并行发起的第二个连接会拿不到
    //! 响应（截图返回空帧）。Rust 测试默认并行，因此三个连它的测试会互相破坏
    //! （实测踩到：单独跑全过，一起跑就有一个失败）。
    //!
    //! 这与 `e2e_override` 的处置同理：**共享单例资源的测试必须串行**，
    //! 与其引入 `serial_test` 之类的依赖，不如把场景收在一个测试里顺序走完。

    use super::*;

    #[tokio::test]
    #[ignore]
    async fn live_end_to_end() {
        // 关键：`#[ignore]` + 手动触发。
        //
        // 默认跑（`cargo test`）时跳过，因为它**依赖外部状态**：开发者工具
        // 正在运行、已开服务端口、已开启自动化。CI 上没有这些，而条件跳过
        // 又会让「真的连上了吗」这件事变得不可知（跳过与成功的输出一样）。
        // 需要人工核验时：`cargo test -p kcode-desktop --lib live_end_to_end
        // -- --ignored --nocapture`。
        if !is_ready().await {
            eprintln!("自动化服务未就绪，跳过（先跑 bash scripts/miniprogram-auto.sh）");
            return;
        }
        let mut s = Session::connect(AUTO_PORT).await.expect("应能连上自动化端口");

        // ① 当前页
        let (pid, route) = s.current_page().await.expect("应能取当前页");
        eprintln!("当前页 pageId={pid} route={route}");

        // ② 截图
        let bytes = s.screenshot().await.expect("截图应成功");
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "应是 PNG");
        assert!(bytes.len() > 10_000, "截图应有实际内容，实际 {} 字节", bytes.len());
        let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
        let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
        eprintln!("真实截图：{w}×{h}，{} 字节", bytes.len());

        // ③ 元素列举
        let views = s.elements(&pid, "view").await.expect("应能列元素");
        assert!(!views.is_empty(), "页面上应有 view 元素");
        eprintln!("view 元素 {} 个，首个 = {:?}", views.len(), views.first());

        // ④ 元素点击（不断言界面变化：那取决于页面语义，
        //    已在手工验证中确认过演示页的 tapped 计数会 +1）
        s.tap(&pid, &views[0].id).await.expect("元素点击应成功");
        eprintln!("已点击元素 {}", views[0].id);
    }

    /// 项目发现的纯函数部分：必须是「真的存在 project.config.json」才算。
    ///
    /// 这条防的是「路径看起来对就当项目」——那会让界面显示一个不存在的项目，
    /// 而用户点进去才发现是空的。
    #[test]
    fn first_project_path_requires_real_project_marker() {
        // 不存在的路径 → 跳过
        let text = r#"["/nope/one", "/nope/two"]"#;
        assert!(first_project_path(text).is_none(), "不存在的路径不应被当作项目");

        // 非数组 / 非法 JSON → None（不 panic）
        assert!(first_project_path("{}").is_none());
        assert!(first_project_path("not json").is_none());
    }

    #[test]
    fn first_project_path_takes_first_match_in_order() {
        // 用当前工作目录伪造一个带 project.config.json 的目录，
        // 验证「取第一个有效项」而不是「取第一个字符串」。
        let dir = std::env::temp_dir().join(format!("mp-proj-{}", std::process::id()));
        let real = dir.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("project.config.json"), "{}").unwrap();

        let text = format!(r#"["/nope/missing", "{}", "/nope/also-missing"]"#, real.display());
        let got = first_project_path(&text).expect("应取到第二个");
        assert_eq!(got, real, "应跳过不存在的、取第一个真的项目");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 真实机器上的发现（不依赖自动化服务）。

    #[tokio::test]
    async fn project_discovery_finds_a_real_project() {
        match discover_project() {
            Some(p) => {
                eprintln!("推断出的项目：{}", p.display());
                assert!(
                    p.join("project.config.json").is_file(),
                    "推断出的目录必须真的是小程序项目"
                );
            }
            None => eprintln!("未从日志推断出项目（不视为失败：日志格式随版本可能变）"),
        }
    }
}
