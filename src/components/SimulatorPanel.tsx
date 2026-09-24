/**
 * 模拟器面板：四个平台的设备清单 + 实时画面 + 触摸输入。
 *
 * # 为什么要有平台层
 *
 * 四个平台的工具链完全不同（adb / simctl / hdc / 微信开发者工具），**能从
 * 命令行做到的事也不同**：
 *
 * | 平台 | 启动 | 取画面 | 触摸输入 |
 * |---|---|---|---|
 * | Android | ✅ `emulator -avd` | ✅ `adb screencap` | ✅ `adb shell input` |
 * | iOS | ✅ `simctl boot` | ✅ `simctl io` | ❌ **simctl 没有触摸命令** |
 * | 鸿蒙 | ❌ 启动器在 DevEco 里 | 🟡 待验证 | 🟡 待验证 |
 * | 小程序 | ❌ 由开发者工具管理 | ❌ 未接入 | ❌ 未接入 |
 *
 * 这些差异不是配置项而是工具链的既成事实，所以界面按
 * `canLaunch` / `canInput` 两个能力位渲染：**不能做的事不画按钮**
 * （项目约定：不给空入口）。iOS 的画面区因此是可看不可点的，
 * 并把原因写在画面下方——而不是画一层点了没反应的触摸板。
 *
 * # 型号与系统为什么要分开显示
 *
 * 只列 AVD 目录名（`Medium_Phone_API_TiramisuPrivacySandbox`）等于让用户
 * 自己解析「这是哪台机器、跑什么系统」。而多平台并存时这更必要：
 * 同一个 App 要验的是「这个系统版本上的表现」，系统版本是首要信息，
 * 型号是次要信息。两者都在设备条目上，一眼可见。
 *
 * # 性能：只在可见时取帧
 *
 * 1080×2340 的 PNG 约 580KB，base64 后约 780KB。按 600ms 轮询约 1.3MB/s，
 * 只在面板可见时才取——不可见时取帧是纯浪费，而且会拖慢其它 IPC。
 * 服务端另做逐字节去重（内容未变时只回尺寸），前端据此跳过 setState。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { extractErrorMessage } from '../stores/useKcode';
import { invoke } from '@tauri-apps/api/core';
import { Icon } from './Icon';
import type {
  DeviceEntry,
  PlatformStatus,
  SimulatorFrame,
  SimulatorPlatform,
  SimulatorStatus,
  ToolOverrides,
  MpElement,
} from '../types/domain';
import { classifyGesture, type Gesture } from './simulatorGesture';

/** 轮询间隔。实测单帧 350ms，取 600ms 留出余量避免请求堆积。 */
const POLL_MS = 600;

/** 落点标记的显示时长——够看清、又不至于停留到干扰下一次操作。 */
const MARKER_MS = 420;

/** 平台顺序：列表顺序固定，用户切换回来时位置不变（不按可用性重排）。 */
const PLATFORMS: { key: SimulatorPlatform; label: string }[] = [
  { key: 'android', label: 'Android' },
  { key: 'ios', label: 'iOS' },
  { key: 'harmony', label: '鸿蒙' },
  { key: 'miniprogram', label: '小程序' },
];

/**
 * 设备状态的中文说明。
 *
 * 为什么不能只显示一个红点：`offline` 与「没启动」的处置方式完全不同
 * （前者是设备连着但连不通，重启 adb 或等设备响应；后者是去启动它）。
 * 一个红点会让用户以为两种情况一样。
 */
function stateLabel(state: string, running: boolean): string {
  if (running) return '运行中';
  switch (state) {
    case 'stopped':
      return '未启动';
    case 'Shutdown':
      return '已关机';
    case 'offline':
      return '离线';
    case 'unauthorized':
      return '未授权';
    case 'Booting':
      return '启动中';
    default:
      return state;
  }
}

/**
 * 每个平台对应的「要填什么」。
 *
 * 文案必须说清**填哪一层目录**——这是自定义路径最容易错的地方：
 * Xcode 要填 `.app` 本身（用户看到的那个），Android 要填 SDK 根目录
 * （不是 platform-tools），这些都不是能猜出来的。
 */
const PATH_FIELDS: {
  key: keyof ToolOverrides;
  platform: SimulatorPlatform;
  label: string;
  placeholder: string;
  hint: string;
}[] = [
  {
    key: 'androidSdk',
    platform: 'android',
    label: 'Android SDK 目录',
    placeholder: '/Volumes/你的卷/android-sdk',
    hint: '填 SDK 根目录，其下应有 platform-tools/ 与 emulator/',
  },
  {
    key: 'xcode',
    platform: 'ios',
    label: 'Xcode.app',
    placeholder: '/Volumes/你的卷/applications/Xcode.app',
    hint: '填 .app 本身（不是 Contents/Developer）',
  },
  {
    key: 'harmonySdk',
    platform: 'harmony',
    label: 'HarmonyOS SDK 目录',
    placeholder: '/Volumes/你的卷/Huawei/Sdk',
    hint: '其下应有 openharmony/<版本>/toolchains/hdc',
  },
  {
    key: 'miniprogram',
    platform: 'miniprogram',
    label: '微信开发者工具',
    placeholder: '/Volumes/你的卷/applications/wechatwebdevtools.app',
    hint: '填 .app 本身；改名过的也能填',
  },
];

/**
 * 输入说明。
 *
 * # 为什么默认只显示一行
 *
 * iOS 的告知有 3 行（约 50px）——放在正常流里会实打实地挤占画面高度，
 * 而画面是用户点开这个面板的目的。但完全藏起来又违背「用户有权知道
 * 触摸走的是私有接口」。
 *
 * 折中：**首行常显**（它包含最关键的「私有接口」），细节按需展开。
 * 首行是这句话的主干，不是省略号式的断章取义。
 */
function InputHint({ text, disclosure }: { text: string; disclosure: boolean }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  const head = lines[0];
  const rest = lines.slice(1);
  const hasMore = rest.length > 0;

  if (!hasMore) {
    return (
      <p className={`sim-input-hint ${disclosure ? 'is-disclosure' : ''}`}>{text}</p>
    );
  }
  return (
    <div className={`sim-input-hint ${disclosure ? 'is-disclosure' : ''}`}>
      <button
        className="sim-input-hint-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="sim-input-hint-text">{head}</span>
        <span className={`sim-input-hint-caret ${open ? 'is-open' : ''}`}>
          <Icon name="chevron" size={10} />
        </span>
      </button>
      {open && (
        <div className="sim-input-hint-body">
          {rest.map((l, i) => (
            <p key={i}>{l}</p>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 「自定义工具路径」面板。
 *
 * # 为什么做成折叠面板而不是独立设置页
 *
 * 需要它的人**正是在这个面板里发现工具找不到的**（或发现检测到的是另一份）。
 * 放到别处等于让用户在两个界面间来回：先被告知「没找到」，再自己去找设置页，
 * 再回来点重新检测。
 *
 * # 为什么是输入框而不是文件选择器
 *
 * 本仓库未引入 Tauri 的 dialog 插件（那是新的运行时依赖与权限声明）。
 * 输入框 + 自动检测到的路径作为占位提示，对开发者而言足够——
 * 而这些工具的路径本来就是要从 Finder 复制过来的。
 */
function ToolPathsEditor({
  overrides,
  onSaved,
}: {
  overrides: ToolOverrides;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ToolOverrides>(overrides);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 外部（重新探测后）拿到新值时要同步进来：否则用户看到的是旧值，
  // 而保存会把它写回去——等于悄悄回退。
  useEffect(() => {
    setDraft(overrides);
  }, [overrides]);

  const configured = PATH_FIELDS.filter((f) => (draft[f.key] ?? '') !== '').length;

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await invoke<ToolOverrides>('simulator_save_tool_paths', { overrides: draft });
      setSaved(true);
      // 立刻重新探测：用户能当场看到结果对不对，而不必重启验证。
      onSaved();
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }, [draft, onSaved]);

  const clearAll = useCallback(() => {
    setDraft({ androidSdk: null, xcode: null, harmonySdk: null, miniprogram: null });
  }, []);

  return (
    <div className="sim-paths">
      <button className="sim-paths-toggle" onClick={() => setOpen((v) => !v)}>
        <Icon name="folder" size={12} />
        <span>自定义工具路径</span>
        {configured > 0 && <span className="sim-paths-count">已设 {configured}</span>}
        <span className={`sim-paths-caret ${open ? 'is-open' : ''}`}>
          <Icon name="chevron" size={11} />
        </span>
      </button>

      {open && (
        <div className="sim-paths-body">
          <p className="sim-paths-intro">
            工具装在非默认位置（外置盘、改名）时在这里指定。留空表示自动检测。
          </p>
          {PATH_FIELDS.map((f) => (
            <label key={f.key} className="sim-paths-field">
              <span className="sim-paths-label">
                {f.label}
                {overrides[f.key] && <em className="sim-paths-set">已自定义</em>}
              </span>
              <input
                type="text"
                spellCheck={false}
                value={draft[f.key] ?? ''}
                placeholder={f.placeholder}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, [f.key]: e.target.value || null }))
                }
              />
              <span className="sim-paths-hint">{f.hint}</span>
            </label>
          ))}
          {error && <p className="sim-paths-error">{error}</p>}
          <div className="sim-paths-actions">
            <button className="sim-paths-save" onClick={() => void save()} disabled={saving}>
              {saving ? '保存中…' : saved ? '已保存并重新检测' : '保存并重新检测'}
            </button>
            <button className="sim-paths-clear" onClick={clearAll} disabled={saving || !configured}>
              全部清空
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SimulatorPanel({
  status,
  onRefreshStatus,
}: {
  status: SimulatorStatus | null;
  onRefreshStatus: () => void;
}) {
  /** 自定义工具路径（兜底设置）。null = 还没读到。 */
  const [overrides, setOverrides] = useState<ToolOverrides | null>(null);
  /** 当前查看的平台。默认第一个可用的（全部不可用时仍是 android，界面会说明）。 */
  const [platform, setPlatform] = useState<SimulatorPlatform | null>(null);
  /** 当前选中的设备 id（不是 runtimeId——见 DeviceEntry 的说明）。 */
  const [deviceId, setDeviceId] = useState<string>('');
  const [frame, setFrame] = useState<SimulatorFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  /** 当前按下/拖动的落点（用于显示标记）。null = 无手势。 */
  const [dragging, setDragging] = useState(false);
  /** 手势结束后短暂保留的标记（点击的反馈）。 */
  const [marker, setMarker] = useState<{ x: number; y: number } | null>(null);
  /** 取帧是否在途——避免输入后的补帧与轮询叠加。 */
  const grabbing = useRef(false);
  /**
   * 手上是否已经有一帧。
   *
   * # 为什么用 ref 而不是读 `frame` 状态
   *
   * `force` 的语义是「我没有帧，必须给我图像」。若在 `grab` 里读 `frame`
   * 状态，`grab` 就依赖 `frame` → 轮询 effect 依赖 `grab` → **每收到一帧就
   * 重建定时器**，于是变成「帧一到就立刻再取一帧」：轮询间隔从 600ms 退化成
   * 「取帧耗时」（实测 350ms），持续满载。这正是帧去重要避免的那种忙等。
   * 用 ref 记录「有没有帧」，依赖链就断开了。
   */
  const hasFrame = useRef(false);
  /** 标记定时器（卸载与重触发时要清）。 */
  const markerTimer = useRef<number | null>(null);
  /** 拖动轨迹线（直接写 DOM 属性，见 onPointerMove）。 */
  const dragLineRef = useRef<SVGLineElement | null>(null);

  /** 当前平台的状态（未选平台时为 null）。 */
  const plat: PlatformStatus | null = platform && status ? status[platform] : null;

  /** 读一次自定义工具路径设置（面板打开时）。 */
  useEffect(() => {
    let cancelled = false;
    void invoke<ToolOverrides>('simulator_read_tool_paths')
      .then((v) => {
        if (!cancelled) setOverrides(v);
      })
      .catch(() => {
        // 读不到就当作「没设过」：设置读取失败不该让整个面板不可用。
        if (!cancelled) {
          setOverrides({ androidSdk: null, xcode: null, harmonySdk: null, miniprogram: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 选定初始平台：优先第一个「有运行中设备」的，其次第一个可用的。
   *
   * **优先有运行中设备的平台**：用户点开这个面板想看的是画面，
   * 而一个可用但没有任何运行中设备的平台只能显示一份设备清单。
   */
  useEffect(() => {
    if (platform || !status) return;
    const withRunning = PLATFORMS.find((p) =>
      status[p.key].devices.some((d) => d.running),
    );
    const firstUsable = PLATFORMS.find((p) => status[p.key].available);
    setPlatform((withRunning ?? firstUsable ?? PLATFORMS[0]).key);
  }, [status, platform]);

  // 换平台时收起设备列表：展开态是「我要在这堆里挑一台」的临时意图，
  // 而换平台后设备集合完全不同，保持展开只会挤掉画面。
  useEffect(() => {
    setDevicesExpanded(false);
  }, [platform]);

  /** 选定初始设备：运行中的优先（那是能出画面的那台）。 */
  useEffect(() => {
    if (!plat) return;
    if (plat.devices.some((d) => d.id === deviceId)) return;
    const target = plat.devices.find((d) => d.running) ?? plat.devices[0];
    setDeviceId(target?.id ?? '');
    // 换平台/换设备后手上那帧作废：留着会显示上一台设备的画面，
    // 而用户会以为「新设备就是这个样子」。同时清掉 hasFrame，
    // 让新设备的第一帧走 force（否则服务端可能判「未变」而不下发）。
    setFrame(null);
    hasFrame.current = false;
    setError(null);
  }, [plat, deviceId]);

  /** 当前选中的设备条目。 */
  const device: DeviceEntry | null =
    plat?.devices.find((d) => d.id === deviceId) ?? null;

  /** 取画面/输入用的句柄（未运行或平台不支持时为 null）。 */
  const runtimeId = device?.runtimeId ?? null;

  /** 取一帧。 */
  const grab = useCallback(async () => {
    if (!platform || !runtimeId) return;
    // 在途保护：输入后的补帧与 600ms 轮询可能撞在一起。
    // 不挡会让请求堆积（单帧实测 350ms，叠三个就明显滞后于操作）。
    if (grabbing.current) return;
    grabbing.current = true;
    try {
      // force 的语义是「手上没有帧时必须拿到图像」：首帧、以及服务端可能
      // 记得旧内容时（切换设备回来）都要传 true。读 ref 而不是 frame 状态，
      // 否则依赖链会让轮询随每帧重启（见 hasFrame 的说明）。
      const f = await invoke<SimulatorFrame>('simulator_frame', {
        platform,
        id: runtimeId,
        force: !hasFrame.current,
      });
      if (!f.dataUrl) {
        // 内容与上一帧相同 → **跳过 setState**：省掉一次 780KB 传输 +
        // 250 万像素解码 + 重绘（触摸时的主要卡顿源）。
        // 但仍要更新尺寸：旋转屏幕后尺寸会变，而画面内容可能恰好相同。
        if (hasFrame.current) setFrame((prev) => (prev ? { ...prev, width: f.width, height: f.height } : f));
        else {
          // 万一服务端在 force 下也没给图像（不该发生），至少记下尺寸，
          // 否则画面区会一直停在「正在获取画面…」
          setFrame(f);
        }
      } else {
        setFrame(f);
      }
      hasFrame.current = true;
      setError(null);
    } catch (e) {
      // 取帧失败常见于设备正在启动/关闭。不清空最后一帧——
      // 清掉会让面板闪成空白，而保持上一帧更能说明「它刚才还在」。
      setError(extractErrorMessage(e));
    } finally {
      grabbing.current = false;
    }
  }, [platform, runtimeId]);

  useEffect(() => {
    if (!platform || !runtimeId) {
      setFrame(null);
      hasFrame.current = false;
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
  }, [platform, runtimeId, grab]);

  /**
   * 把界面坐标换算成设备坐标并发出一次输入。
   *
   * 换算在显示尺寸与设备尺寸之间做等比映射，并**夹紧到设备范围**——
   * 手指滑到画面外时坐标会超出。
   */
  const sendInput = useCallback(
    async (action: string, cx: number, cy: number, x2 = 0, y2 = 0, durationMs = 120) => {
      if (!platform || !runtimeId || !frame || !imgRef.current) return;
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
          platform,
          id: runtimeId,
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
    [platform, runtimeId, frame, grab],
  );

  /** 硬件键（返回/主屏）：不经坐标换算，直接发。 */
  const sendKey = useCallback(
    (action: 'back' | 'home') => void sendInput(action, 0, 0),
    [sendInput],
  );

  /**
   * 手势结束：判定点击/滑动后发出，并留下落点标记。
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

  const startDevice = useCallback(
    async (id: string) => {
      if (!platform) return;
      setBusy(true);
      setError(null);
      try {
        await invoke('simulator_start', { platform, id });
        // 冷启动十几秒，给用户明确预期
        onRefreshStatus();

        // **等设备真的出现，而不是让用户自己点刷新**。
        //
        // 后端 `simulator_start` 是 spawn 后立即返回（模拟器是独立进程，
        // 可能在本应用关闭后继续运行），所以返回时设备还没注册到 adb。
        // 原先这里只打印一句「请稍候刷新」——用户的下一步必然是自己点
        // 刷新按钮，而「该刷新了」这件事本不该由人判断。
        //
        // 用**条件轮询 + 上限**：每 2 秒探测一次，最多 90 秒。
        // 不用固定等待：就绪时间取决于机器（快则 8 秒、慢则半分钟），
        // 定死会要么白等要么不够。
        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2000));
          try {
            const st = await invoke<SimulatorStatus>('simulator_probe');
            const p = st[platform];
            const ready = p.devices.find((d) => d.id === id && d.running);
            if (ready) {
              onRefreshStatus();
              setDeviceId(ready.id);
              return;
            }
          } catch {
            // 探测本身失败（设备端忙）不算致命，继续等
          }
        }
        setError(`${id} 在 90 秒内未就绪。设备可能启动失败，可点刷新重试。`);
        onRefreshStatus();
      } catch (e) {
        setError(extractErrorMessage(e));
      } finally {
        setBusy(false);
      }
    },
    [platform, onRefreshStatus],
  );

  const stopDevice = useCallback(async () => {
    if (!platform || !device) return;
    setBusy(true);
    try {
      await invoke('simulator_stop', { platform, id: device.id });
      setFrame(null);
      onRefreshStatus();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [platform, device, onRefreshStatus]);

  // 画面是否接管指针：**只在坐标模式**下才是。
  // 元素模式（小程序）点画面没有意义——自动化接口不返回元素位置，
  // 我们无法把一次点击映射到某个元素上。接管了只会让用户白点。
  // 用 device?.running 而不是下面才定义的 running 局部量（声明顺序所限）。
  const deviceRunning = device?.running ?? false;
  const interactive = plat?.inputMode === 'coordinate' && deviceRunning && !!frame;
  /** 元素模式（小程序）：画面只读，输入走下方的元素列表。 */
  const elementMode = plat?.inputMode === 'element' && deviceRunning;

  /**
   * 设备列表是否展开。
   *
   * # 为什么需要它
   *
   * 默认收起到两行：多数平台只有一两台设备，展开八行会把画面挤没；
   * 而 iOS 上本机就有 60 台——全展开等于把画面完全遮住（用户点开这个面板
   * 是来看画面的，不是来看清单的）。
   *
   * 收起时不隐藏**当前选中的那台**：它一定可见，否则用户不知道自己
   * 在看哪个设备。见下面的 visibleDevices。
   */
  const [devicesExpanded, setDevicesExpanded] = useState(false);

  /** 小程序当前页的可点元素（元素模式下才加载）。 */
  const [mpElements, setMpElements] = useState<MpElement[]>([]);
  const [mpRoute, setMpRoute] = useState<string>('');
  const [mpLoading, setMpLoading] = useState(false);

  /** 拉取小程序的元素列表。 */
  const loadMpElements = useCallback(async () => {
    if (!platform) return;
    setMpLoading(true);
    try {
      const r = await invoke<{ route: string; elements: MpElement[] }>(
        'simulator_miniprogram_elements',
      );
      setMpRoute(r.route);
      setMpElements(r.elements);
      setError(null);
    } catch (e) {
      setError(extractErrorMessage(e));
      setMpElements([]);
    } finally {
      setMpLoading(false);
    }
  }, [platform]);

  /** 点一个元素，然后刷新列表与画面（页面可能跳转）。 */
  const tapMpElement = useCallback(
    async (id: string) => {
      setInputBusy(true);
      try {
        await invoke('simulator_miniprogram_tap', { elementId: id });
        // 点击可能触发跳转/状态变化 → 等一下再同时刷画面与元素
        await new Promise((r) => setTimeout(r, 300));
        await loadMpElements();
      } catch (e) {
        setError(extractErrorMessage(e));
      } finally {
        setInputBusy(false);
      }
    },
    [loadMpElements],
  );

  // 进入元素模式时加载一次；离开时清空（避免把上一个平台的数据留着）
  useEffect(() => {
    if (elementMode) void loadMpElements();
    else {
      setMpElements([]);
      setMpRoute('');
    }
  }, [elementMode, loadMpElements]);

  /** 启动小程序的自动化服务（显式动作，见后端命令说明）。 */
  const startMpAutomation = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke('simulator_miniprogram_start');
      // 启动后立刻重检：用户要当场看到「现在可用了」
      const fresh = await invoke<SimulatorStatus>('simulator_probe');
      // 把新状态交给上层（它对平台选择、设备列表都生效）
      onRefreshStatus();
      if (!fresh.miniprogram.available) {
        setError(fresh.miniprogram.reason ?? '自动化服务仍未就绪');
      }
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [onRefreshStatus]);

  /**
   * 收起时要显示哪些设备。
   *
   * 规则：**当前选中的那台一定在内**——收起时把它藏起来，用户就不知道自己
   * 在看哪个设备了。其余按原顺序补齐到前 N 台。
   *
   * 这里的"前 N 台"用行数而不是像素：设备行高固定（两行文本），
   * 而按像素算需要读 DOM（会在渲染前拿不到值）。
   */
  const COLLAPSED_ROWS = 2;
  const visibleDevices = useMemo(() => {
    const all = plat?.devices ?? [];
    if (devicesExpanded || all.length <= COLLAPSED_ROWS) return all;
    const head = all.slice(0, COLLAPSED_ROWS);
    if (head.some((d) => d.id === deviceId)) return head;
    const current = all.find((d) => d.id === deviceId);
    // 当前设备不在前几台：用它替换最后一个，而不是追加（保持行数稳定）
    return current ? [...head.slice(0, COLLAPSED_ROWS - 1), current] : head;
  }, [plat, devicesExpanded, deviceId]);

  /** 各平台的运行中设备数，用于标签上的计数。 */
  const counts = useMemo(() => {
    const out = {} as Record<SimulatorPlatform, number>;
    for (const p of PLATFORMS) {
      out[p.key] = status?.[p.key].devices.filter((d) => d.running).length ?? 0;
    }
    return out;
  }, [status]);

  if (!status) {
    return (
      <div className="sim-empty">
        <Icon name="devices" size={22} />
        <p className="sim-empty-title">正在检测本机模拟器…</p>
      </div>
    );
  }

  const running = device?.running ?? false;
  // 画面是否可交互：平台支持触摸 + 设备在跑 + 手上有帧
  return (
    <div className="sim-panel">
      {/* ── 平台选择 ────────────────────────────────────────────────
          四个平台**全部列出**（含不可用的）：用户需要知道本机装了哪几个、
          缺哪个。隐藏不可用的平台只会让人以为我们不支持那个平台。 */}
      <div className="sim-tabs" role="tablist" aria-label="模拟器平台">
        {PLATFORMS.map(({ key, label }) => {
          const p = status[key];
          const active = key === platform;
          return (
            <button
              key={key}
              role="tab"
              aria-selected={active}
              className={`sim-tab ${active ? 'is-active' : ''} ${p.available ? '' : 'is-off'}`}
              onClick={() => setPlatform(key)}
              title={p.available ? undefined : (p.reason ?? '不可用')}
            >
              <span className={`sim-dot ${p.available ? 'is-on' : ''}`} aria-hidden="true" />
              <span className="sim-tab-label">{label}</span>
              {/* 有运行中设备时给计数：一眼看出哪个平台「正在跑东西」 */}
              {counts[key] > 0 && <span className="sim-tab-count">{counts[key]}</span>}
            </button>
          );
        })}
        <button className="sim-icon-btn sim-refresh" title="重新检测" onClick={onRefreshStatus}>
          <Icon name="refresh" size={13} />
        </button>
      </div>

      {/* ── 自定义工具路径（兜底）──
          放在平台内容之前：它正是为「找不到工具」与「检测到的是另一份」
          两种情况准备的，而这两种情况都发生在看内容之前。 */}
      {overrides && (
        <ToolPathsEditor
          overrides={overrides}
          onSaved={() => {
            void invoke<ToolOverrides>('simulator_read_tool_paths')
              .then(setOverrides)
              .catch(() => {});
            onRefreshStatus();
          }}
        />
      )}

      {/* ── 平台不可用：说清缺什么、怎么装 ─────────────────────────── */}
      {!plat?.available && (
        <div className="sim-empty">
          <Icon name="devices" size={20} />
          <p className="sim-empty-title">
            {PLATFORMS.find((p) => p.key === platform)?.label} 不可用
          </p>
          {plat?.reason && <p className="sim-empty-hint">{plat.reason}</p>}
          {plat?.tool && <p className="sim-empty-tool">工具：{plat.tool}</p>}
          {/* 小程序：工具在、但自动化没起来 → 给一个**可点的下一步**。
              只写「请执行某命令」等于让用户离开界面去终端。 */}
          {platform === 'miniprogram' && plat?.tool && (
            <button
              className="sim-empty-action"
              disabled={busy}
              onClick={() => void startMpAutomation()}
            >
              {busy ? '正在启动…' : '启动自动化'}
            </button>
          )}
        </div>
      )}

      {plat?.available && (
        <>
          {/* ── 设备列表：型号 + 系统 + 分辨率 ─────────────────────
              设备多时可折叠：iOS 本机就有 60 台，全展开会把画面完全遮住。
              收起时**当前选中的那台一定可见**（见 visibleDevices）。 */}
          <div className="sim-devices">
            {plat.devices.length === 0 && (
              <p className="sim-devices-empty">
                {plat.canLaunch
                  ? '尚未创建任何模拟器（可用 Android Studio 的 Device Manager 创建）。'
                  : '当前没有连接的设备。'}
                {plat.tool && <span className="sim-tool-hint">工具：{plat.tool}</span>}
              </p>
            )}
            {plat.devices.length > COLLAPSED_ROWS && (
              <button
                className="sim-devices-toggle"
                onClick={() => setDevicesExpanded((v) => !v)}
                aria-expanded={devicesExpanded}
              >
                <Icon name="chevron" size={11} />
                <span>
                  {devicesExpanded
                    ? '收起设备列表'
                    : `展开全部 ${plat.devices.length} 台设备`}
                </span>
                {!devicesExpanded && (
                  <span className="sim-devices-count">
                    已显示 {visibleDevices.length}/{plat.devices.length}
                  </span>
                )}
              </button>
            )}
            {visibleDevices.map((d) => (
              <div
                key={d.id}
                className={`sim-device ${d.id === deviceId ? 'is-active' : ''} ${
                  d.running ? 'is-running' : ''
                }`}
              >
                <button
                  className="sim-device-main"
                  onClick={() => setDeviceId(d.id)}
                  // 完整标识放进 title：400px 宽的右栏里放不下，但排查
                  // 「启动的到底是哪个」时需要能对上命令行（`emulator -avd X`）。
                  title={`${d.id}${d.runtimeId ? ` · ${d.runtimeId}` : ''}`}
                >
                  {/* 第一行只放**型号 + 状态**：型号是用户挑设备的依据，
                      曾被系统版本与按钮一起挤到只剩「Medium Phone API Tirami…」。
                      系统版本挪到第二行行首，两行都读得全。 */}
                  <span className="sim-device-row">
                    <span className="sim-device-name">{d.name}</span>
                    <span className={`sim-state ${d.running ? 'is-running' : ''}`}>
                      {stateLabel(d.state, d.running)}
                    </span>
                  </span>
                  {/* 第二行：系统版本 → 分辨率 → 细节（细节最先被截断，它最次要） */}
                  <span className="sim-device-row sim-device-sub">
                    {d.os && <span className="sim-device-os">{d.os}</span>}
                    {d.resolution && <span className="sim-device-res">{d.resolution}</span>}
                    {d.detail && <span className="sim-device-detail">{d.detail}</span>}
                  </span>
                </button>

                {/* 操作按钮：能启动才给「启动」，能关才给「关闭」。
                    不可启动的平台（鸿蒙/小程序）一个按钮都不画——
                    画一个点了会报错的按钮比没有更糟。 */}
                {!d.running && plat.canLaunch && (
                  <button
                    className="btn btn-mini sim-device-act"
                    disabled={busy}
                    onClick={() => void startDevice(d.id)}
                  >
                    启动
                  </button>
                )}
                {d.running && plat.canLaunch && d.id === deviceId && (
                  <button
                    className="sim-icon-btn"
                    title="关闭设备"
                    disabled={busy}
                    onClick={() => void stopDevice()}
                  >
                    <Icon name="stop" size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* ── 画面区 ─────────────────────────────────────────────
              点击与滑动直接作用到设备。手势判定用**图片坐标**（要换算成
              设备坐标），落点标记用**容器坐标**（要定位到 DOM），两者分开算。 */}
          {frame ? (
            <div
              className={`sim-screen ${inputBusy ? 'is-busy' : ''} ${
                dragging ? 'is-dragging' : ''
              } ${interactive ? '' : 'is-readonly'}`}
            >
              <img
                ref={imgRef}
                src={frame.dataUrl ?? undefined}
                alt={`${device?.name ?? '模拟器'}的画面`}
                draggable={false}
                onPointerDown={(e) => {
                  // 只读模式下不接管指针：没有输入能力时让事件照常冒泡，
                  // 用户仍能选中/拖动图片而不产生「点了没反应」的错觉
                  if (!interactive) return;
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

              {/* 只读提示：贴在画面底部，说明**为什么**点不动。
                  不写这句的话用户会以为是自己点错了位置。 */}
              {/* ── 元素列表（仅元素模式：小程序）─────────────────────
                  为什么不是可点画面：自动化接口**不返回元素坐标**
                  （Page.getElements 只给 elementId 与 tagName），
                  所以我们无法把一次画面点击映射到某个元素上。
                  给一个点了没反应的画面，比明说「请点下面的元素」更糟。 */}
              {elementMode && (
                <div className="sim-elements">
                  <div className="sim-elements-head">
                    <span className="sim-elements-title">
                      页面元素{mpRoute ? ` · ${mpRoute}` : ''}
                    </span>
                    <button
                      className="sim-icon-btn"
                      title="刷新元素列表"
                      disabled={mpLoading}
                      onClick={() => void loadMpElements()}
                    >
                      <Icon name="refresh" size={12} />
                    </button>
                  </div>
                  {mpLoading && mpElements.length === 0 && (
                    <p className="sim-elements-empty">正在读取页面元素…</p>
                  )}
                  {!mpLoading && mpElements.length === 0 && (
                    <p className="sim-elements-empty">
                      当前页没有可点元素（或页面尚未渲染完成）。
                    </p>
                  )}
                  <div className="sim-elements-list">
                    {mpElements.map((el) => (
                      <button
                        key={el.id}
                        className="sim-element"
                        disabled={inputBusy}
                        onClick={() => void tapMpElement(el.id)}
                        title={`elementId=${el.id}`}
                      >
                        <span className="sim-element-tag">{el.tag}</span>
                        <span className="sim-element-id">#{el.id}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

            </div>
          ) : (
            <div className="sim-empty">
              <Icon name="devices" size={20} />
              <p className="sim-empty-title">
                {!device
                  ? '选择一台设备'
                  : !device.running
                    ? `${device.name} 未运行`
                    : '正在获取画面…'}
              </p>
              <p className="sim-empty-hint">
                {!device
                  ? '设备列表为空。'
                  : !device.running
                    ? plat.canLaunch
                      ? '点设备行上的「启动」按钮开机（冷启动通常 10–30 秒）。'
                      : '该平台的设备需要在其自带工具里启动（本应用无法代劳）。'
                    : '首次取帧可能需要几秒。'}
              </p>
            </div>
          )}

          {/* ── 输入说明 ────────────────────────────────────────────
              放在画面**下方**，不叠在画面上。
              原先它是 `position: absolute; bottom` 的浮层——只有一行、且仅在
              只读时出现时无所谓；iOS 接上触摸后它变成三行且常显，于是**盖住了
              画面的下沿**，而那正是可点击区域（用户看不到那部分内容）。
              说明文字不该侵占操作区。 */}
          {plat.inputHint && (
            <InputHint text={plat.inputHint} disclosure={interactive} />
          )}

          {/* ── 硬件键：只有能输入才有意义 ────────────────────────── */}
          {running && plat.canInput && (
            <div className="sim-bar">
              <button
                className="sim-icon-btn"
                title="返回键"
                disabled={busy || inputBusy}
                onClick={() => sendKey('back')}
              >
                <Icon name="arrow-left" size={13} />
              </button>
              <button
                className="sim-icon-btn"
                title="主屏键"
                disabled={busy || inputBusy}
                onClick={() => sendKey('home')}
              >
                <Icon name="dot" size={13} />
              </button>
              <span className="sim-bar-hint">
                在画面上点击或拖动即可操作设备
              </span>
            </div>
          )}
        </>
      )}

      {error && <p className="sim-error">{error}</p>}
    </div>
  );
}
