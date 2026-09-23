/**
 * 浏览器场景：真正的浏览器形态。
 *
 * 顶部是工具栏（后退/前进/刷新 + 地址栏 + 缩放 + 选择元素），
 * 下方是网页区域——**网页是原生子视图**，不在 DOM 里，所以这一块
 * 只是个用来量矩形的空槽（见 App 里的 slotRef）。
 *
 * # 为什么地址栏要跟随实际地址
 *
 * 用户点了页面里的链接之后，如果地址栏还显示他上次输入的地址，
 * 那么「地址栏」与「看到的内容」不一致——他复制地址分享出去会指向
 * 错误的页面。所以每次导航后都回读真实 URL。
 *
 * # 为什么「选择元素」不通过 IPC
 *
 * 内嵌浏览器加载的是任意外部网页，它**没有** Tauri 的 IPC 权限
 * （capability 用 webviews 精确限定，见 capabilities/default.json）。
 * 若为了这个功能给远程页面开 IPC，等于让任意站点都能执行命令、
 * 读工作区文件。所以选择结果走 eval 的单向回读，页面拿不到任何能力。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Icon } from './Icon';
import { extractErrorMessage } from '../stores/useKcode';
import { withScheme } from './urlScheme';
import { fillViewport, fitViewport, fixedViewport, SIZE_PRESETS, type Viewport } from './viewportSize';
import type { WebElementAttachment } from '../types/domain';

/** 缩放档位。与主流浏览器一致的常用档。 */
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function BrowserPanel({
  url,
  onNavigate,
  onPick,
  slotRef,
  slotSize,
  onViewport,
  pickRequest,
}: {
  /** 当前要显示的地址（null = 尚未打开任何页面）。 */
  url: string | null;
  onNavigate: (url: string) => void;
  /** 把选中的元素加入对话（作为附件，而不是一段裸文本）。 */
  onPick: (el: WebElementAttachment) => void;
  /**
   * 原生子视图的宿主。
   *
   * **必须放在工具栏之下**：子视图绘制在 DOM 之上，宿主矩形若从面板
   * 顶部算起，网页会把工具栏整个盖住（实测：导航后工具栏消失，
   * 用户再也点不到地址栏与后退）。
   */
  slotRef: (el: HTMLDivElement | null) => void;
  /** 网页区域的可用尺寸（决定模拟视口怎么算）。 */
  slotSize: { width: number; height: number };
  /** 把算好的模拟视口交给原生层。 */
  onViewport: (v: Viewport, slot: { width: number; height: number }) => void;
  /**
   * 外部请求进入「选择元素」模式。
   *
   * 计数器语义：每次递增即触发一次（不能用一个 boolean——那样第二次请求
   * 因为值没变而不会触发）。来源是输入区「+」菜单的「网页元素」项。
   */
  pickRequest?: number;
}) {
  const [addr, setAddr] = useState(url ?? '');
  const [zoom, setZoom] = useState(1);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef<string>('');
  /**
   * 视口模式。
   *
   * - `'fill'`：填满面板（**默认**）——视口即面板、不缩放
   * - `'fit'`：适应窗口——桌面视口（1280×720）缩放后放入面板
   * - number：固定尺寸预设
   *
   * # 为什么默认是「填满面板」
   *
   * 实测右栏可用区域 436×245（逻辑点），把 1280 宽的视口塞进去要缩到
   * 0.34 倍——14px 的字只剩约 9.5 物理像素高，看起来又小又挤。
   * 在窄面板里「整个桌面页可见」与「文字可读」是互斥的。
   *
   * 「填满面板」就是普通浏览器窗口的行为：视口等于可用区域、不缩放、
   * 文字大小正常。想看桌面版布局时再从菜单选尺寸。
   */
  const [mode, setMode] = useState<'fit' | 'fill' | number>('fill');
  /** 尺寸菜单是否展开。 */
  const [sizeMenu, setSizeMenu] = useState(false);

  // 外部（点击会话里的链接）改了地址时同步到地址栏
  useEffect(() => {
    if (url) setAddr(url);
  }, [url]);

  /**
   * 地址栏跟随真实地址。
   *
   * 用户点页面里的链接后 URL 会变，但 React 不知道——子视图是原生的。
   * 用低频轮询把真实地址读回来。间隔 1.2s：地址栏滞后一秒多无伤大雅，
   * 而更高频的轮询要跨进程调用，得不偿失。
   */
  useEffect(() => {
    if (!url) return;
    const timer = window.setInterval(() => {
      void invoke<string>('browser_current_url')
        .then((real) => {
          if (real && real !== addr) setAddr(real);
        })
        .catch(() => {
          /* 视图尚未创建时查询会失败——不是错误 */
        });
    }, 1200);
    return () => window.clearInterval(timer);
  }, [url, addr]);

  /**
   * 选择元素的轮询。
   *
   * 注入脚本把结果写进页面全局变量，Rust 侧用 eval 回读。
   * `take_pick` 是 take 语义（读到即清除），所以拿到就停。
   */
  useEffect(() => {
    if (!picking) return;
    const timer = window.setInterval(() => {
      void invoke<string | null>('browser_take_pick')
        .then((raw) => {
          if (!raw) return;
          setPicking(false);
          try {
            const p = JSON.parse(raw) as WebElementAttachment;
            // 传结构化对象，由输入区负责呈现成附件卡片。
            // 早先直接拼成一段文字塞进输入框，用户看到一大段选择器文本，
            // 既不知道它从哪来、也没法单独移除。
            onPick({ ...p, kind: 'webElement' });
          } catch (e) {
            setError(`选择结果无法解析：${extractErrorMessage(e)}`);
          }
        })
        .catch(() => {
          /* 视图不存在时忽略 */
        });
    }, 400);
    return () => window.clearInterval(timer);
  }, [picking, onPick]);

  /**
   * 计算当前视口并交给原生层。
   *
   * 依赖 slotSize：面板尺寸变化（折叠侧栏、改窗口大小）时必须重算，
   * 否则页面仍按旧宽度排版，出现裁切或空白。
   */
  useEffect(() => {
    if (!url || slotSize.width < 10 || slotSize.height < 10) return;
    const v =
      mode === 'fit'
        ? fitViewport(slotSize.width, slotSize.height)
        : mode === 'fill'
          ? fillViewport(slotSize.width, slotSize.height)
          : fixedViewport(
              SIZE_PRESETS[mode].width,
              SIZE_PRESETS[mode].height,
              slotSize.width,
              slotSize.height,
            );
    onViewport(v, slotSize);
  }, [url, mode, slotSize.width, slotSize.height, onViewport]);

  const go = useCallback(
    (raw: string) => {
      const full = withScheme(raw);
      try {
        const parsed = new URL(full);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          setError('只支持 http/https 地址');
          return;
        }
        setError(null);
        onNavigate(full);
      } catch {
        setError('这个地址无法解析');
      }
    },
    [onNavigate],
  );

  const nav = (cmd: string) => () => {
    void invoke(cmd).catch((e) => setError(extractErrorMessage(e)));
  };

  const changeZoom = (next: number) => {
    setZoom(next);
    void invoke('browser_set_zoom', { factor: next }).catch((e) =>
      setError(extractErrorMessage(e)),
    );
  };

  const startPick = () => {
    // token 让 Rust 侧能区分本次注入与旧的一次
    const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    tokenRef.current = token;
    setError(null);
    void invoke('browser_begin_pick', { token })
      .then(() => setPicking(true))
      .catch((e) => setError(extractErrorMessage(e)));
  };

  // 外部请求进入选择模式（输入区「+」菜单）：pickRequest 递增即触发。
  // 依赖里只放 pickRequest —— startPick 每次渲染都是新函数，放进去会反复触发。
  useEffect(() => {
    if (!pickRequest) return;
    startPick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickRequest]);

  return (
    <div className="browser-panel">
      <div className="browser-toolbar">
        <button className="nav-btn" onClick={nav('browser_back')} title="后退">
          <Icon name="arrow-left" size={12} />
        </button>
        <button className="nav-btn" onClick={nav('browser_forward')} title="前进">
          <Icon name="arrow-right" size={12} />
        </button>
        <button className="nav-btn" onClick={nav('browser_reload')} title="刷新">
          <Icon name="refresh" size={12} />
        </button>

        <input
          className="browser-addr"
          value={addr}
          placeholder="输入网址后回车"
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const t = addr.trim();
              if (t) go(t);
            }
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />

        <label className="browser-zoom" title="缩放">
          <select
            value={String(zoom)}
            onChange={(e) => changeZoom(Number(e.target.value))}
          >
            {ZOOM_STEPS.map((z) => (
              <option key={z} value={z}>
                {Math.round(z * 100)}%
              </option>
            ))}
          </select>
        </label>

        <div className="size-menu-wrap">
          <button
            className={`nav-btn ${mode !== 'fill' ? 'is-active' : ''}`}
            onClick={() => setSizeMenu((v) => !v)}
            title="自由尺寸 / 设备模拟"
            disabled={!url}
          >
            <Icon name="devices" size={12} />
          </button>
          {sizeMenu && (
            <>
              {/* 点外部关闭。浮层不拦截页面的滚动与点击。 */}
              <div className="size-menu-backdrop" onClick={() => setSizeMenu(false)} />
              <div className="size-menu" role="menu">
                <div className="size-menu-head">视口尺寸</div>
                {(
                  [
                    { key: 'fill', label: '填满面板', hint: '不缩放，文字正常大小' },
                    { key: 'fit', label: '适应窗口', hint: '1280×720 桌面视口，缩放显示' },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.key}
                    className={`size-menu-item ${mode === o.key ? 'is-active' : ''}`}
                    onClick={() => {
                      setMode(o.key);
                      setSizeMenu(false);
                    }}
                  >
                    <span className="size-menu-text">
                      <span className="size-menu-label">{o.label}</span>
                      <span className="size-menu-hint">{o.hint}</span>
                    </span>
                    {mode === o.key && <Icon name="check" size={12} />}
                  </button>
                ))}
                <div className="size-menu-sep" />
                <div className="size-menu-head">设备</div>
                {SIZE_PRESETS.map((p, i) => (
                  <button
                    key={p.label}
                    className={`size-menu-item ${mode === i ? 'is-active' : ''}`}
                    onClick={() => {
                      setMode(i);
                      setSizeMenu(false);
                    }}
                  >
                    <span className="size-menu-text">
                      <span className="size-menu-label">{p.label}</span>
                    </span>
                    {mode === i && <Icon name="check" size={12} />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <button
          className={`nav-btn ${picking ? 'is-active' : ''}`}
          onClick={startPick}
          title="选择一个网页元素加入对话"
          disabled={!url}
        >
          <Icon name="pin" size={12} />
        </button>
      </div>

      {picking && (
        <p className="browser-picking">
          在页面上点击要加入对话的元素（Esc 取消）
        </p>
      )}
      {error && <p className="browser-error">{error}</p>}

      {/* 网页区与空态**叠在同一块空间**上（绝对定位），而不是各占一半。
          各占一半时空态会被挤到面板下半部，看起来像没居中（实测如此）。
          网页是原生子视图、不在 DOM 里，.browser-viewport 只用来量矩形。 */}
      <div className="browser-body">
        <div className="browser-viewport" ref={slotRef} />

        {!url && (
          <div className="browser-blank">
            <Icon name="compass" size={40} />
            <p className="browser-blank-title">浏览器</p>
            <p className="browser-blank-hint">粘贴或输入 URL 以打开网页</p>
          </div>
        )}
      </div>
    </div>
  );
}
