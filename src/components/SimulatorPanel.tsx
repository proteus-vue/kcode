/**
 * 模拟器面板。
 *
 * # 与参照客户端的差别（实测本机后定的）
 *
 * 参照（MiMo）在未装完整 Xcode 时给的是一个**报错的面板**：一部手机框里
 * 写「未安装完整 Xcode，无法在模拟器中运行」。本机实测也是这个情形
 * （只有 CommandLineTools，`simctl` 不存在）——所以那种面板是它的真实状态，
 * 不是设计。
 *
 * 而我们这台机器上 **Android 可用**（2 个 AVD，`adb exec-out screencap`
 * 单帧约 350ms）。因此这里不抄「一律显示手机框 + 报错」，而是：
 *
 * - **可用就真给画面**：Android 走 adb 截图，能点、能滑、能返回；
 * - **不可用就说清缺什么、怎么装**，并且**该侧不出现在选项里**，
 *   而不是画一个永远空着的手机框。
 *
 * # 性能：只在可见时取帧
 *
 * 1080×2340 的 PNG 约 580KB，base64 后约 780KB。按 600ms 轮询约 1.3MB/s，
 * 只在面板可见时才取——不可见时取帧是纯浪费，而且会拖慢其它 IPC。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { extractErrorMessage } from '../stores/useKcode';
import { invoke } from '@tauri-apps/api/core';
import { Icon } from './Icon';
import type { SimulatorFrame, SimulatorStatus } from '../types/domain';
import { classifyGesture, type Gesture } from './simulatorGesture';

/** 轮询间隔。实测单帧 350ms，取 600ms 留出余量避免请求堆积。 */
const POLL_MS = 600;

/** 落点标记的显示时长——够看清、又不至于停留到干扰下一次操作。 */
const MARKER_MS = 420;

export function SimulatorPanel({
  status,
  onRefreshStatus,
}: {
  status: SimulatorStatus | null;
  onRefreshStatus: () => void;
}) {
  const [avd, setAvd] = useState<string>('');
  const [serial, setSerial] = useState<string>('');
  /**
   * 当前画面。**state 里始终有图像**——服务端下发「内容未变」时
   * 不动它（见 grab），所以这里不需要处理 dataUrl 为 null 的情况。
   */
  const [frame, setFrame] = useState<{ dataUrl: string; width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 进行中的提示（等待设备就绪等）。
   *
   * 与 `error` 分开：`error` 是「出错了」，这里是「正在等」——
   * 混用会让等待中的提示带上报错的视觉重量（红色），明明一切正常。
   */
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 设备级操作（启动/关闭/切换）进行中。
   *
   * 与 `inputBusy` **分开**：点一下屏幕是毫秒级的动作，而它此前会 disable
   * 整排设备按钮（含「关闭模拟器」），表现为按钮无故闪烁变灰。
   * 两类操作的耗时差两个数量级，共用一个标志是错的。
   */
  const [busy, setBusy] = useState(false);
  /** 正在发送一次触摸输入。只用于防止输入请求堆积。 */
  const [inputBusy, setInputBusy] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  /** 用 ref 存轮询开关，避免把它放进 effect 依赖导致重启定时器。 */
  const polling = useRef(true);
  /** 正在进行的指针手势（未抬起时为非空）。 */
  const gestureRef = useRef<{ x: number; y: number; t: number } | null>(null);
  /**
   * 拖动轨迹的 SVG 元素（直接改属性，不走 React）。
   *
   * `pointermove` 每次手指移动都会触发（一秒几十次），而 React 的
   * setState → 重渲染 → 重绘链路在这个频率下会明显掉帧——**而轨迹只是
   * 一个装饰**，不值得为它让整块画面参与重渲染。所以直接写 DOM 属性。
   *
   * 这是本项目里少见的「绕过 React」，理由写在这里：性能可测、影响可隔离
   * （只动一个 `<line>` 的两个坐标）。
   */
  const dragLineRef = useRef<SVGLineElement | null>(null);
  /** 是否有进行中的手势（只用于容器 class 切换，粒度粗、触发少）。 */
  const [dragging, setDragging] = useState(false);
  /** 手势结束后短暂保留的标记（点击的反馈）。 */
  const [marker, setMarker] = useState<{ x: number; y: number } | null>(null);
  /**
   * 标记的清除定时器。
   *
   * 必须持有并清理：连续点击会叠出多个定时器，**先前的那个会把新标记
   * 提前清掉**，表现为「快速点几下时标记一闪就没」。
   */
  const markerTimer = useRef<number | null>(null);
  /** 取帧是否在途——避免输入后的补帧与轮询叠加。 */
  const grabbing = useRef(false);

  // 默认选中第一个可用设备；没有设备时不自动启动（启动是重操作，要用户点）
  useEffect(() => {
    if (serial || !status) return;
    const ready = status.android.devices.find((d) => d.state === 'device');
    if (ready) setSerial(ready.serial);
  }, [status, serial]);

  /**
   * AVD 下拉框的默认值。
   *
   * **必须回填到 state**：`<select>` 的 value 写了 `avd || avds[0]` 兜底，
   * 界面看着有选中项，但 `startAvd` 读的是 `avd`——它一直是空的，
   * 于是点「启动」**静默无反应**（不报错、不启动、什么也不发生）。
   * 只有用户手动改过一次下拉框才会填上，这正是「只有一个 AVD 时点启动没反应」
   * 的原因。这里把界面显示的值与 state 对齐。
   */
  useEffect(() => {
    if (avd || !status) return;
    const first = status.android.avds[0];
    if (first) setAvd(first);
  }, [status, avd]);

  /**
   * 取一帧。
   *
   * `force` 用于「手上没有帧」的场景（首次选中设备、切换设备、重启）：
   * 服务端会跳过内容比对一定下发，否则可能因「与上一帧相同」而不给画面，
   * 而前端又没有帧，面板就空着。
   */
  const grab = useCallback(
    async (force = false) => {
      if (!serial) return;
      // 在途保护：输入后的补帧与 600ms 轮询可能撞在一起。
      // 不挡会让请求堆积（单帧实测 350ms，叠三个就明显滞后于操作）。
      if (grabbing.current) return;
      grabbing.current = true;
      try {
        const f = await invoke<SimulatorFrame>('simulator_frame', { serial, force });
        // **内容未变时跳过 setState**：这是卡顿的主要来源。
        // 一次 setFrame 会让整块画面重新解码（1080×2340 位图）+ 重绘，
        // 而画面静止时这份工作完全白做——它还会与用户的触摸操作抢主线程。
        //
        // 未变时**只更新尺寸**（坐标换算依赖它，且尺寸变化本身就是内容变化前的
        // 先行信号，例如旋转屏幕）；已有图像则原样保留。
        if (f.dataUrl === null) {
          setFrame((prev) => (prev ? { ...prev, width: f.width, height: f.height } : prev));
        } else {
          setFrame({ dataUrl: f.dataUrl, width: f.width, height: f.height });
        }
        setError(null);
      } catch (e) {
        // 取帧失败常见于设备正在启动/关闭。不清空最后一帧——
        // 清掉会让面板闪成空白，而保持上一帧更能说明「它刚才还在」。
        setError(extractErrorMessage(e));
      } finally {
        grabbing.current = false;
      }
    },
    [serial],
  );

  useEffect(() => {
    if (!serial) {
      setFrame(null);
      return;
    }
    polling.current = true;
    // 强制：刚选中设备时前端没有帧，不能依赖服务端的去重判断
    void grab(true);
    const t = setInterval(() => {
      // 页面不可见时跳过：省掉 1.3MB/s 的无效搬运
      if (polling.current && !document.hidden) void grab();
    }, POLL_MS);
    const onVis = () => {
      if (!document.hidden) void grab();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      polling.current = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [serial, grab]);

  /**
   * 把界面坐标换算成设备坐标并发出一次输入。
   *
   * 换算在显示尺寸与设备尺寸之间做等比映射，并**夹紧到设备范围**——
   * 手指滑到画面外时坐标会超出（见 map 的 clamp）。
   */
  const sendInput = useCallback(
    async (action: string, cx: number, cy: number, x2 = 0, y2 = 0, durationMs = 120) => {
      if (!serial || !frame || !imgRef.current) return;
      const r = imgRef.current.getBoundingClientRect();
      const map = (px: number, py: number, dispW: number, dispH: number, devW: number, devH: number) => {
        if (!Number.isFinite(px) || !Number.isFinite(py) || dispW <= 0 || dispH <= 0) return null;
        const x = Math.round((px / dispW) * devW);
        const y = Math.round((py / dispH) * devH);
        return [Math.max(0, Math.min(devW - 1, x)), Math.max(0, Math.min(devH - 1, y))];
      };
      const p1 = map(cx, cy, r.width, r.height, frame.width, frame.height);
      const p2 = map(x2, y2, r.width, r.height, frame.width, frame.height);
      if (!p1) return;
      setInputBusy(true);
      try {
        await invoke('simulator_input', {
          serial,
          action,
          x1: p1[0],
          y1: p1[1],
          x2: p2 ? p2[0] : 0,
          y2: p2 ? p2[1] : 0,
          durationMs,
        });
        setError(null);
        // **输入后立刻补一帧**，不等下一次 600ms 轮询。
        //
        // 这里**刻意不加 sleep**：`adb exec-out screencap` 自身约 350ms，
        // 覆盖了设备处理触摸所需的时间——即「取帧的耗时就是它需要的稳定期」。
        // 加固定等待只会让反馈更慢。
        void grab();
      } catch (e) {
        setError(extractErrorMessage(e));
      } finally {
        setInputBusy(false);
      }
    },
    [serial, frame, grab],
  );

  /** 硬件键（返回/主屏）：不经坐标换算，直接发。 */
  const sendKey = useCallback(
    (action: 'back' | 'home') => void sendInput(action, 0, 0),
    [sendInput],
  );

  /**
   * 手势结束：判定点击/滑动后发出，并留下落点标记。
   *
   * `suppressClickRef` 用于抑制浏览器在滑动后补派的那次 click——
   * 不抑制会让「滑一下」额外在落点触发一次点击，而用户完全没点。
   */
  const finishGesture = useCallback(
    (start: { x: number; y: number; t: number }, end: { x: number; y: number }) => {
      const g: Gesture = classifyGesture(start, end, performance.now() - start.t);
      // 点击用落点；滑动用起点→终点
      setMarker(g.kind === 'tap' ? { x: g.x, y: g.y } : { x: g.x2, y: g.y2 });
      if (markerTimer.current !== null) window.clearTimeout(markerTimer.current);
      markerTimer.current = window.setTimeout(() => {
        setMarker(null);
        markerTimer.current = null;
      }, MARKER_MS);

      if (g.kind === 'tap') {
        void sendInput('tap', g.x, g.y);
      } else {
        void sendInput('swipe', g.x1, g.y1, g.x2, g.y2, g.durationMs);
      }
    },
    [sendInput],
  );

  // 卸载时清掉标记定时器（否则会在已卸载的组件上 setState）
  useEffect(
    () => () => {
      if (markerTimer.current !== null) window.clearTimeout(markerTimer.current);
    },
    [],
  );

  const startAvd = useCallback(async () => {
    if (!avd) return;
    setBusy(true);
    setNotice(`已启动 ${avd}，正在等待设备就绪（冷启动通常 10–30 秒）…`);
    try {
      await invoke('simulator_start', { avd });

      // **等设备真的出现，而不是让用户自己点刷新**。
      //
      // 后端 `simulator_start` 是 spawn 后立即返回（模拟器是独立进程，
      // 可能在本应用关闭后继续运行），所以返回时设备还没注册到 adb。
      // 原先这里只打印一句「请稍候刷新」——用户的下一步必然是自己点
      // 刷新按钮，而「该刷新了」这件事本不该由人判断。
      //
      // 用**条件轮询 + 上限**：每 2 秒探测一次，最多 60 秒。
      // 不用固定等待：就绪时间取决于机器（快则 8 秒、慢则半分钟），
      // 定死会要么白等要么不够。
      const deadline = Date.now() + 60_000;
      let found = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const st = await invoke<SimulatorStatus>('simulator_probe');
          const ready = st.android.devices.find((d) => d.state === 'device');
          if (ready) {
            setSerial(ready.serial);
            setNotice(null);
            found = true;
            onRefreshStatus();
            break;
          }
        } catch {
          // 探测本身失败（adb 忙）不算致命，继续等
        }
      }
      if (!found) {
        // 超时如实说明，并保留手动入口（刷新按钮仍在）
        setNotice(`${avd} 在 60 秒内未就绪。设备可能启动失败，可点刷新重试。`);
        onRefreshStatus();
      }
    } catch (e) {
      setError(extractErrorMessage(e));
      setNotice(null);
    } finally {
      setBusy(false);
    }
  }, [avd, onRefreshStatus]);

  const stopDevice = useCallback(async () => {
    if (!serial) return;
    setBusy(true);
    try {
      await invoke('simulator_stop', { serial });
      setSerial('');
      setFrame(null);
      onRefreshStatus();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [serial, onRefreshStatus]);

  // ── 两侧都不可用：说清缺什么、怎么装 ──────────────────────────────────
  const androidOk = status?.android.available ?? false;
  const iosOk = status?.ios.available ?? false;
  if (status && !androidOk && !iosOk) {
    return (
      <div className="sim-empty">
        <Icon name="devices" size={22} />
        <p className="sim-empty-title">本机没有可用的模拟器</p>
        {status.android.reason && <p className="sim-empty-hint">{status.android.reason}</p>}
        {status.ios.reason && <p className="sim-empty-hint">{status.ios.reason}</p>}
        <button className="btn btn-mini" onClick={onRefreshStatus}>
          重新检测
        </button>
      </div>
    );
  }

  const ready = status?.android.devices.filter((d) => d.state === 'device') ?? [];

  return (
    <div className="sim-panel">
      {/* 顶部：设备选择与操作 */}
      <div className="sim-bar">
        <select
          className="sim-select"
          value={serial}
          onChange={(e) => setSerial(e.target.value)}
          disabled={busy}
        >
          <option value="">{ready.length ? '选择设备…' : '无运行中的模拟器'}</option>
          {ready.map((d) => (
            <option key={d.serial} value={d.serial}>
              {d.model ?? d.serial}
            </option>
          ))}
        </select>

        {/* 没有运行中的设备时，提供启动入口（列出已创建的 AVD） */}
        {ready.length === 0 && (status?.android.avds.length ?? 0) > 0 && (
          <>
            <select
              className="sim-select"
              value={avd || status?.android.avds[0]}
              onChange={(e) => setAvd(e.target.value)}
              disabled={busy}
            >
              {status!.android.avds.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <button className="btn btn-mini" onClick={() => void startAvd()} disabled={busy}>
              启动
            </button>
          </>
        )}

        {serial && (
          <>
            <button
              className="sim-icon-btn"
              title="返回键"
              disabled={busy}
              onClick={() => sendKey('back')}
            >
              <Icon name="arrow-left" size={13} />
            </button>
            <button
              className="sim-icon-btn"
              title="主屏键"
              disabled={busy}
              onClick={() => sendKey('home')}
            >
              <Icon name="dot" size={13} />
            </button>
            <button
              className="sim-icon-btn"
              title="关闭模拟器"
              disabled={busy}
              onClick={() => void stopDevice()}
            >
              <Icon name="stop" size={13} />
            </button>
          </>
        )}

        <button className="sim-icon-btn" title="重新检测" onClick={onRefreshStatus}>
          <Icon name="refresh" size={13} />
        </button>
      </div>

      {/* 画面：点击与滑动直接作用到设备。
          手势判定用**图片坐标**（要换算成设备坐标），
          落点标记用**容器坐标**（要定位到 DOM），两者分开算。 */}
      {frame ? (
        <div className={`sim-screen ${inputBusy ? 'is-busy' : ''} ${dragging ? 'is-dragging' : ''}`}>
          <img
            ref={imgRef}
            src={frame.dataUrl}
            alt="模拟器画面"
            draggable={false}
            onPointerDown={(e) => {
              const img = e.currentTarget.getBoundingClientRect();
              const x = e.clientX - img.left;
              const y = e.clientY - img.top;
              // 捕获指针：手指滑出图片范围后仍能收到 move/up，
              // 否则滑到边缘就断掉，长距离滑动做不出来
              e.currentTarget.setPointerCapture(e.pointerId);
              gestureRef.current = { x, y, t: performance.now() };
              setDragging(true);
            }}
            onPointerMove={(e) => {
              const start = gestureRef.current;
              const line = dragLineRef.current;
              if (!start || !line) return;
              const img = e.currentTarget.getBoundingClientRect();
              const box = e.currentTarget.parentElement!.getBoundingClientRect();
              // 直接改 SVG 属性：这条路一秒几十次，走 React 会掉帧
              line.setAttribute('x1', String(start.x + (img.left - box.left)));
              line.setAttribute('y1', String(start.y + (img.top - box.top)));
              line.setAttribute('x2', String(e.clientX - box.left));
              line.setAttribute('y2', String(e.clientY - box.top));
            }}
            onPointerUp={(e) => {
              const start = gestureRef.current;
              if (!start) return;
              gestureRef.current = null;
              setDragging(false);
              const img = e.currentTarget.getBoundingClientRect();
              finishGesture(start, { x: e.clientX - img.left, y: e.clientY - img.top });
            }}
            onPointerCancel={() => {
              // 系统取消（来电、手势被接管）：不发出任何输入——
              // 用户没完成这次操作，替他补一次点击是错的
              gestureRef.current = null;
              setDragging(false);
            }}
          />

          {/* 拖动中的轨迹线：给「我正在滑」一个即时反馈，
              不必等 350ms 后的补帧。
              坐标由 pointermove 直接写 DOM（见 dragLineRef 的说明）。 */}
          {dragging && (
            <svg className="sim-drag" aria-hidden="true">
              <line ref={dragLineRef} x1="0" y1="0" x2="0" y2="0" />
            </svg>
          )}

          {/* 落点标记：点击后立刻出现，说明「收到了」。
              没有它，用户只能靠画面变化判断点击是否生效，
              而点到无响应区域时根本无法区分是自己没点到还是设备没反应。 */}
          {marker && (
            <span className="sim-marker" style={{ left: marker.x, top: marker.y }} aria-hidden="true" />
          )}
        </div>
      ) : (
        <div className="sim-empty">
          <Icon name="devices" size={20} />
          <p className="sim-empty-title">
            {serial ? '正在获取画面…' : '选择一个运行中的模拟器'}
          </p>
          <p className="sim-empty-hint">
            {serial
              ? '首次取帧可能需要几秒。'
              : status?.android.avds.length
                ? `已创建 ${status.android.avds.length} 个模拟器，可直接启动。`
                : '尚未创建任何模拟器（可用 Android Studio 的 Device Manager 创建）。'}
          </p>
        </div>
      )}

      {notice && <p className="sim-notice">{notice}</p>}
      {error && <p className="sim-error">{error}</p>}

      {/* iOS 不可用时：在 Android 面板下方如实说明，而不是藏起来 */}
      {!iosOk && status?.ios.reason && (
        <p className="sim-note">iOS：{status.ios.reason}</p>
      )}
    </div>
  );
}
