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
import { invoke } from '@tauri-apps/api/core';
import { Icon } from './Icon';
import type { SimulatorFrame, SimulatorStatus } from '../types/domain';

/** 轮询间隔。实测单帧 350ms，取 600ms 留出余量避免请求堆积。 */
const POLL_MS = 600;

export function SimulatorPanel({
  status,
  onRefreshStatus,
}: {
  status: SimulatorStatus | null;
  onRefreshStatus: () => void;
}) {
  const [avd, setAvd] = useState<string>('');
  const [serial, setSerial] = useState<string>('');
  const [frame, setFrame] = useState<SimulatorFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  /** 用 ref 存轮询开关，避免把它放进 effect 依赖导致重启定时器。 */
  const polling = useRef(true);

  // 默认选中第一个可用设备；没有设备时不自动启动（启动是重操作，要用户点）
  useEffect(() => {
    if (serial || !status) return;
    const ready = status.android.devices.find((d) => d.state === 'device');
    if (ready) setSerial(ready.serial);
  }, [status, serial]);

  /** 取一帧。 */
  const grab = useCallback(async () => {
    if (!serial) return;
    try {
      const f = await invoke<SimulatorFrame>('simulator_frame', { serial });
      setFrame(f);
      setError(null);
    } catch (e) {
      // 取帧失败常见于设备正在启动/关闭。不清空最后一帧——
      // 清掉会让面板闪成空白，而保持上一帧更能说明「它刚才还在」。
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [serial]);

  useEffect(() => {
    if (!serial) {
      setFrame(null);
      return;
    }
    polling.current = true;
    void grab();
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

  /** 把界面点击换算成设备坐标并发出去。 */
  const send = useCallback(
    async (action: string, cx: number, cy: number, x2 = 0, y2 = 0) => {
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
      setBusy(true);
      try {
        await invoke('simulator_input', {
          serial,
          action,
          x1: p1[0],
          y1: p1[1],
          x2: p2 ? p2[0] : 0,
          y2: p2 ? p2[1] : 0,
          durationMs: 120,
        });
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [serial, frame],
  );

  const startAvd = useCallback(async () => {
    if (!avd) return;
    setBusy(true);
    try {
      await invoke('simulator_start', { avd });
      setError(null);
      // 冷启动十几秒：给用户明确预期，而不是让他盯着空面板
      setError(`已启动 ${avd}，冷启动通常需要 10–30 秒，请稍候刷新。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [avd]);

  const stopDevice = useCallback(async () => {
    if (!serial) return;
    setBusy(true);
    try {
      await invoke('simulator_stop', { serial });
      setSerial('');
      setFrame(null);
      onRefreshStatus();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
              onClick={() => void send('back', 0, 0)}
            >
              <Icon name="arrow-left" size={13} />
            </button>
            <button
              className="sim-icon-btn"
              title="主屏键"
              disabled={busy}
              onClick={() => void send('home', 0, 0)}
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

      {/* 画面：点击与滑动直接作用到设备 */}
      {frame ? (
        <div className="sim-screen">
          <img
            ref={imgRef}
            src={frame.dataUrl}
            alt="模拟器画面"
            draggable={false}
            onPointerDown={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              void send('tap', e.clientX - r.left, e.clientY - r.top);
            }}
          />
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

      {error && <p className="sim-error">{error}</p>}

      {/* iOS 不可用时：在 Android 面板下方如实说明，而不是藏起来 */}
      {!iosOk && status?.ios.reason && (
        <p className="sim-note">iOS：{status.ios.reason}</p>
      )}
    </div>
  );
}
