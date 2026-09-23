/**
 * 模拟器面板的接线测试（组件级）。
 *
 * 纯函数测试只证明「判定对了」，不证明**判定结果真的发出去了**。
 * 这一层要守的是一整条链：pointer 事件 → 坐标换算 → invoke。
 * 上一轮核查发现的问题正是「后端支持 swipe、前端从未调用」——
 * 那种缺口只有组件级测试能拦住。
 *
 * 四平台改版后另加两类必守的契约：
 *
 * 1. **调用参数带平台**：invoke 传的是 `{platform, id}`，而 `id` 必须是
 *    `runtimeId`（Android 上是 adb serial，不是 AVD 名）。传错会在后端
 *    得到一个与根因无关的报错。
 * 2. **能力位决定交互**：`canInput: false` 的平台（iOS）**不接管指针**——
 *    画面上拖动不能发出任何输入。这条防的是「以后有人为了方便把
 *    只读判断去掉」，那会让 iOS 用户拖了半天却什么都没发生。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SimulatorPanel } from '../SimulatorPanel';
import type {
  DeviceEntry,
  PlatformStatus,
  SimulatorFrame,
  SimulatorStatus,
} from '../../types/domain';

// ── 桩掉 Tauri 的 invoke ──────────────────────────────────────────────
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let frameCalls = 0;
/** 下一次 simulator_frame 的返回值。测试可改写以模拟「内容未变」。 */
let nextFrame: SimulatorFrame = { dataUrl: 'data:image/png;base64,AAAA', width: 1000, height: 2000 };
/** simulator_probe 的返回值（启动等待设备时用）。 */
let probeResult: SimulatorStatus | null = null;
let probeCalls = 0;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    if (cmd === 'simulator_frame') {
      frameCalls += 1;
      // **必须返回一个新对象**：真实 IPC 每次都是新反序列化的对象，
      // 而返回同一个引用会让 React 因 `Object.is` 相等而跳过更新——
      // 那样就掩盖了「轮询随每帧重启」这类依赖链缺陷
      // （实测：用同一个引用时，注入该缺陷的回归测试依然通过）。
      return { ...nextFrame };
    }
    if (cmd === 'simulator_probe') {
      probeCalls += 1;
      return probeResult;
    }
    return undefined;
  },
}));

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** 构造一台 Android 设备条目（型号 + 系统 + 分辨率为这次改版的重点）。 */
function androidDevice(over: Partial<DeviceEntry> = {}): DeviceEntry {
  return {
    id: 'Pixel_7',
    name: 'Pixel 7',
    os: 'Android 14',
    resolution: '1080×2400',
    running: true,
    state: 'device',
    detail: 'arm64-v8a · 420dpi · google_apis',
    runtimeId: 'emulator-5554',
    ...over,
  };
}

/** 构造一个不可用平台（缺工具链时后端返回的形状）。 */
function off(reason: string): PlatformStatus {
  return {
    available: false,
    reason,
    tool: null,
    devices: [],
    canLaunch: false,
    canInput: false,
    inputHint: null,
  };
}

/** 一个可用的 Android 平台（有一台运行中的设备）。 */
function onAndroid(devices: DeviceEntry[] = [androidDevice()]): PlatformStatus {
  return {
    available: true,
    reason: null,
    tool: '/sdk/emulator + /sdk/adb',
    devices,
    canLaunch: true,
    canInput: true,
    inputHint: null,
  };
}

/**
 * iOS 可用的形状：**能启动、能取画面、不能触摸**。
 *
 * 这正是真实工具链的能力边界（simctl 有截图没有触摸命令），
 * 也是只读交互测试的夹具。
 */
const iosAvailable: PlatformStatus = {
  available: true,
  reason: null,
  tool: 'xcrun simctl',
  devices: [
    {
      id: 'AAAA-BBBB',
      name: 'iPhone 15 Pro',
      os: 'iOS 17.0',
      resolution: null,
      running: true,
      state: 'Booted',
      detail: 'iPhone-15-Pro',
      runtimeId: 'AAAA-BBBB',
    },
  ],
  canLaunch: true,
  canInput: false,
  inputHint: 'iOS 模拟器画面为只读：simctl 不提供触摸注入',
};

const status: SimulatorStatus = {
  android: onAndroid(),
  ios: { available: false, reason: '未安装完整 Xcode' , tool: null, devices: [], canLaunch: false, canInput: false, inputHint: null },
  harmony: off('未找到 hdc（鸿蒙设备连接器）'),
  miniprogram: off('未找到微信开发者工具'),
};

beforeEach(() => {
  calls.length = 0;
  frameCalls = 0;
  probeCalls = 0;
  nextFrame = { dataUrl: 'data:image/png;base64,AAAA', width: 1000, height: 2000 };
  probeResult = null;
  /**
   * 假定时器 + `shouldAdvanceTime`：真实时间照常流动（`await sleep` 能推进），
   * 但定时器的回调也在 act 之外的时机被触发时会记在受控队列里。
   *
   * 不用假定时器的话，组件的 600ms 轮询与 2s「等就绪」循环会在断言间隙
   * 触发 setState，每次测试产出几十条 act 警告——**噪音足以淹没真正的失败**。
   */
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(async () => {
  vi.useRealTimers();
  // **卸载必须在 act 内**：组件里有 600ms 轮询与「等设备就绪」的 2s 循环，
  // 不卸载的话它们的 setState 会落在 act 之外（每次测试几十条 act 警告，
  // 足以淹没真正的失败信息）。卸载触发清理函数 → 停掉定时器。
  if (root) {
    await act(async () => {
      root!.unmount();
      // 再等一拍，把「已经在途」的 invoke promise 消化掉
      await Promise.resolve();
    });
  }
  if (host) host.remove();
  root = null;
  host = null;
});

/** 挂载并等首帧到达（没有 frame 时组件不渲染画面，手势无从触发）。 */
async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<SimulatorPanel status={status} onRefreshStatus={() => {}} />);
  });
  // 让首帧的 invoke 落地，并把补帧的异步链一并消化掉
  // （不消化会让 setState 落在 act 之外，React 会打警告）
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return host;
}

const img = () => host!.querySelector('.sim-screen img') as HTMLImageElement;

/**
 * 按**精确文本**找按钮。
 *
 * 不用 `includes`：设备行上「启动」按钮与状态标签「未启动」相邻，而
 * `textContent` 包含整个子树——`includes('启动')` 会先命中设备行按钮
 * （它的文本里含「未启动」），点下去只切换选中态，测试表现成
 * 「启动按钮点了没反应」。精确匹配是这里唯一可靠的判据。
 */
function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...host!.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined;
}

/**
 * 让图片有一个确定的矩形。
 *
 * jsdom 不做布局，`getBoundingClientRect` 恒为 0——而坐标换算依赖它
 * （dispW/dispH 为 0 时直接 return）。所以这里显式给一个尺寸，
 * 让「显示 500×1000 → 设备 1000×2000」这层映射可断言。
 */
function stubRect(el: Element, left = 0, top = 0, width = 500, height = 1000) {
  el.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
}

/**
 * 派发一个指针事件。
 *
 * jsdom **没有实现 `PointerEvent`**，所以用 `MouseEvent` 构造再补上
 * 指针特有的字段（`pointerId`）。React 的合成事件按 `pointerdown` 等
 * 事件名匹配，字段齐了就能正常触发——这是 jsdom 环境下测指针交互的
 * 常规做法，不是绕过测试。
 */
async function pointer(type: string, x: number, y: number) {
  const el = img();
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  // setPointerCapture 在 jsdom 里不存在，补一个空实现
  (el as unknown as { setPointerCapture?: (id: number) => void }).setPointerCapture = () => {};
  await act(async () => {
    el.dispatchEvent(e);
    // **事件处理器里的异步链要在同一个 act 里消化**：
    // pointerup → finishGesture → sendInput → invoke → 补帧 setState，
    // 这条链跨了多个微任务。不消化就会产生 act 警告
    // （每次测试十几条，足够淹没真正的失败）。
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** 消化补帧带来的异步 setState（避免 act 警告淹没真失败）。 */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** 取最近一次 simulator_input 调用。 */
const lastInput = () => [...calls].reverse().find((c) => c.cmd === 'simulator_input');

describe('点击', () => {
  it('按下抬起（几乎不动）发 tap，坐标按显示→设备比例换算', async () => {
    await mount();
    stubRect(img());
    // 显示 500×1000，设备 1000×2000 → 比例 2。点 (100,200) → (200,400)
    await pointer('pointerdown', 100, 200);
    await pointer('pointerup', 100, 200);

    const call = lastInput();
    expect(call, '应发出 simulator_input').toBeDefined();
    // id 必须是 runtimeId（adb serial），不是 AVD 名——见文件头的说明
    expect(call!.args).toMatchObject({
      action: 'tap',
      x1: 200,
      y1: 400,
      platform: 'android',
      id: 'emulator-5554',
    });
  });

  it('微抖动仍发 tap（阈值内的位移不该变成滑动）', async () => {
    await mount();
    stubRect(img());
    await pointer('pointerdown', 100, 200);
    await pointer('pointerup', 103, 202);
    expect(lastInput()!.args.action).toBe('tap');
  });
});

describe('滑动', () => {
  it('按下移动抬起发 swipe，带起点与终点', async () => {
    await mount();
    stubRect(img());
    await pointer('pointerdown', 100, 200);
    await pointer('pointermove', 200, 400);
    await pointer('pointerup', 250, 500);

    const call = lastInput();
    expect(call!.args.action, '拖动必须走 swipe 而不是 tap').toBe('swipe');
    // 起点 (100,200)→(200,400)；终点 (250,500)→(500,1000)
    expect(call!.args).toMatchObject({ action: 'swipe', x1: 200, y1: 400, x2: 500, y2: 1000 });
    // 时长必须是数字（adb 收到 NaN 会报参数错误，看起来像设备故障）
    expect(Number.isFinite(call!.args.durationMs)).toBe(true);
  });

  it('没有 pointermove 也能滑动（按下→直接抬起，位移足够大）', async () => {
    await mount();
    stubRect(img());
    await pointer('pointerdown', 10, 10);
    await pointer('pointerup', 300, 600);
    expect(lastInput()!.args.action).toBe('swipe');
  });

  it('pointercancel 不发出任何输入（用户没完成这次操作）', async () => {
    await mount();
    stubRect(img());
    await pointer('pointerdown', 100, 200);
    await pointer('pointermove', 200, 300);
    await pointer('pointercancel', 200, 300);
    expect(lastInput(), '被系统取消的手势不该补发输入').toBeUndefined();
    // 取消后再抬起也不该触发（手势已作废）
    await pointer('pointerup', 200, 300);
    expect(lastInput()).toBeUndefined();
  });
});

describe('坐标夹紧', () => {
  it('滑出画面外的坐标被夹到设备范围内', async () => {
    await mount();
    stubRect(img());
    await pointer('pointerdown', 100, 200);
    // 拖到图片右下方之外：clientX 远超 500 的宽度
    await pointer('pointerup', 900, 1500);
    await settle();
    const call = lastInput()!;
    expect(call.args.x2, '不应超出设备宽度').toBeLessThanOrEqual(999);
    expect(call.args.y2, '不应超出设备高度').toBeLessThanOrEqual(1999);
  });
});

describe('输入后立刻补帧', () => {
  it('每次输入后都追加一次取帧（不等 600ms 轮询）', async () => {
    await mount();
    stubRect(img());
    const before = frameCalls;
    await pointer('pointerdown', 100, 200);
    await pointer('pointerup', 100, 200);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(frameCalls, '输入后应立即补一帧，否则反馈要等下一次轮询').toBeGreaterThan(before);
  });
});

describe('内容未变时跳过重绘（卡顿的主要来源）', () => {
  it('dataUrl 为 null 时不替换图像（但尺寸仍更新）', async () => {
    nextFrame = { dataUrl: 'data:image/png;base64,FIRST', width: 1080, height: 2340 };
    await mount();
    stubRect(img());
    const firstSrc = img().getAttribute('src');
    expect(firstSrc).toContain('FIRST');

    // 下一帧：内容未变（服务端去重生效），尺寸变成新的（例如旋转）
    nextFrame = { dataUrl: null, width: 2340, height: 1080 };
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700)); // 跨过一次轮询
    });
    expect(img().getAttribute('src'), '未变时不该换 src（换 src 会触发解码 + 重绘）').toBe(firstSrc);
    const call = [...calls].reverse().find((c) => c.cmd === 'simulator_frame');
    expect(call!.args.force, '轮询不该强制取帧').toBe(false);
  });

  it('首次取帧强制（否则服务端可能判「未变」而前端没有帧）', async () => {
    nextFrame = { dataUrl: 'data:image/png;base64,X', width: 100, height: 200 };
    await mount();
    const first = calls.find((c) => c.cmd === 'simulator_frame');
    expect(first!.args.force, '首次必须强制取帧').toBe(true);
  });
});

describe('轮询节奏（依赖链错了会变成「帧一到就再取一帧」）', () => {
  it('两秒内取帧次数符合 600ms 间隔，而不是每帧都取', async () => {
    // 回归测试：`grab` 曾依赖 `frame` 状态 → 轮询 effect 依赖 `grab`
    // → **每收到一帧就重建定时器**，退化成「帧一到立刻再取一帧」，
    // 间隔从 600ms 掉到取帧耗时（约 350ms），持续满载。
    // 这类缺陷不报错，只表现为「模拟器很卡」——所以用计数钉住。
    //
    // 已验证这条测试**确实能抓到**那个缺陷：注入 `[platform, runtimeId, frame]`
    // 依赖后本条失败（表现为超时——失去 600ms 节流后，取帧的微任务链
    // 持续占住事件循环，连定时器都排不进去）。注意配合 invoke 桩
    // **返回新对象**：返回同一引用会让 React 跳过更新，测试会假通过。
    await mount();
    const before = frameCalls;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2000));
    });
    const during = frameCalls - before;
    // 2000ms / 600ms ≈ 3 次。放宽容差到 2–6：定时器有调度抖动，
    // 但「每帧立刻再取」会是 5–6 次以上且随时间线性增长。
    expect(during, `两秒内取帧 ${during} 次，间隔已偏离 600ms`).toBeLessThanOrEqual(6);
  });
});

describe('启动后自动等设备就绪', () => {
  it('启动后轮询探测，设备出现时自动选中并取帧', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 初始：有 AVD（未启动），没有任何运行中的设备
    probeResult = {
      android: onAndroid([androidDevice({ running: false, state: 'stopped', runtimeId: null })]),
      ios: off('缺 Xcode'),
      harmony: off('缺 hdc'),
      miniprogram: off('缺开发者工具'),
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    /**
     * 受控包装：模拟 App 的行为——`onRefreshStatus` 会重新探测并把新状态
     * 传下来。组件本身不持有 status（那是 App 的），所以测试必须补上这一步，
     * 否则「自动探测」的效果传不回组件。
     */
    function Harness() {
      const [st, setSt] = useState(probeResult);
      return (
        <SimulatorPanel
          status={st}
          onRefreshStatus={() => {
            probeCalls += 1;
            setSt(probeResult);
          }}
        />
      );
    }

    await act(async () => {
      root!.render(<Harness />);
    });

    // 点设备行上的「启动」
    const startBtn = buttonByText('启动');
    expect(startBtn, '未运行时设备行上应有启动按钮').toBeDefined();
    await act(async () => {
      startBtn!.click();
    });
    // 启动调用的参数要带平台与设备 id
    const startCall = calls.find((c) => c.cmd === 'simulator_start');
    expect(startCall!.args).toMatchObject({ platform: 'android', id: 'Pixel_7' });

    // 等设备出现（模拟器冷启动）
    probeResult = {
      android: onAndroid(),
      ios: off('缺 Xcode'),
      harmony: off('缺 hdc'),
      miniprogram: off('缺开发者工具'),
    };
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2200)); // 跨过一次 2s 轮询
    });

    expect(probeCalls, '应自动探测设备，不需要用户手动刷新').toBeGreaterThan(0);
    // 设备就绪后应当开始取帧（面板有画面）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(host.querySelector('.sim-screen img'), '就绪后应出现画面').not.toBeNull();
    // 取帧用的是 runtimeId（serial），不是 AVD 名
    const frameCall = [...calls].reverse().find((c) => c.cmd === 'simulator_frame');
    expect(frameCall!.args).toMatchObject({ platform: 'android', id: 'emulator-5554' });
    expect(host.querySelector('.sim-error'), '就绪后不该留下错误').toBeNull();
  });
});

describe('多平台：设备清单区分型号与系统', () => {
  it('设备行同时给出型号、系统版本与分辨率', async () => {
    await mount();
    const name = host!.querySelector('.sim-device-name');
    expect(name?.textContent).toBe('Pixel 7');
    expect(host!.querySelector('.sim-device-os')?.textContent, '系统版本是「要看哪个」的依据').toBe('Android 14');
    expect(host!.querySelector('.sim-device-res')?.textContent).toBe('1080×2400');
    // 第二行的细节（abi/dpi）
    expect(host!.querySelector('.sim-device-detail')?.textContent).toContain('arm64-v8a');
    // 完整标识放进 title：右栏放不下，但排查时要在 hover 拿得到。
    // 第一版把它当独立一列渲染，结果 400px 宽下型号被挤成
    // 「Medium Phone API Tirami…」（实测截图发现）。
    const main = host!.querySelector('.sim-device-main')!;
    expect(main.getAttribute('title')).toContain('Pixel_7');
    expect(main.getAttribute('title')).toContain('emulator-5554');
  });

  it('四个平台都列出（不可用的也列出，点开能看到原因）', async () => {
    await mount();
    // 取 label 元素而不是按钮本身：按钮里还有计数徽标，
    // textContent 会是 "Android1" 这种拼接结果
    const labels = [...host!.querySelectorAll('.sim-tab-label')].map((e) => e.textContent);
    expect(labels).toEqual(['Android', 'iOS', '鸿蒙', '小程序']);
    // 有运行中设备的平台带计数
    expect(host!.querySelector('.sim-tab-count')?.textContent).toBe('1');
    // 点不可用的平台 → 显示原因（含可执行的下一步）
    const iosTab = [...host!.querySelectorAll('.sim-tab')].find((t) =>
      t.textContent?.includes('iOS'),
    ) as HTMLButtonElement;
    await act(async () => {
      iosTab.click();
    });
    expect(host!.querySelector('.sim-empty-title')?.textContent).toContain('iOS');
    expect(host!.querySelector('.sim-empty-hint')?.textContent, '不可用必须说清缺什么').toContain('Xcode');
  });

  it('只有 canLaunch 的平台才画「启动」按钮', async () => {
    // 鸿蒙：工具链在、但无法从本应用启动（启动器在 DevEco 里）
    const harmonyStatus: SimulatorStatus = {
      android: onAndroid(),
      ios: off('缺 Xcode'),
      harmony: {
        available: true,
        reason: null,
        tool: '/hdc',
        devices: [
          {
            id: '7001', name: '鸿蒙设备 7001…', os: 'HarmonyOS', resolution: null,
            running: true, state: 'connected', detail: null, runtimeId: '7001',
          },
        ],
        canLaunch: false,
        canInput: false,
        inputHint: '鸿蒙的触摸注入尚未在真机上验证',
      },
      miniprogram: off('缺开发者工具'),
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<SimulatorPanel status={harmonyStatus} onRefreshStatus={() => {}} />);
    });
    // 切到鸿蒙
    const harmonyTab = [...host.querySelectorAll('.sim-tab')].find((t) =>
      t.textContent?.includes('鸿蒙'),
    ) as HTMLButtonElement;
    await act(async () => {
      harmonyTab.click();
    });
    expect(host.querySelector('.sim-device-name')?.textContent).toContain('鸿蒙设备');
    expect(
      [...host.querySelectorAll('button')].filter((b) => b.textContent?.trim() === '启动'),
      '不能启动的平台不该画启动按钮（点了只会报错）',
    ).toHaveLength(0);
  });
});

describe('只读平台：不给触摸交互', () => {
  it('iOS 画面拖动不发任何输入，且说明为什么点不动', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<SimulatorPanel status={{ ...status, ios: iosAvailable }} onRefreshStatus={() => {}} />);
    });
    // **必须显式切到 iOS**：Android 也有运行中设备，而默认平台选的是
    // 顺序上第一个有运行中设备的（android）。不切的话断言的是 Android 画面。
    const iosTab = [...host.querySelectorAll('.sim-tab')].find((t) =>
      t.textContent?.includes('iOS'),
    ) as HTMLButtonElement;
    await act(async () => {
      iosTab.click();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector('.sim-screen img'), 'iOS 可用时应出画面').not.toBeNull();
    expect(img().getAttribute('alt'), '画面应标明是哪台设备').toContain('iPhone 15 Pro');
    // 只读提示必须存在：不写用户会以为是自己点错了
    expect(host.querySelector('.sim-readonly-hint')?.textContent).toContain('只读');

    stubRect(img());
    await pointer('pointerdown', 100, 200);
    await pointer('pointermove', 200, 400);
    await pointer('pointerup', 250, 500);
    expect(lastInput(), 'iOS 不支持触摸，任何手势都不该发出输入').toBeUndefined();
    // 也不该出现落点标记（那会让人以为点击生效了）
    expect(host.querySelector('.sim-marker')).toBeNull();
  });
});

describe('落点标记', () => {
  it('点击后出现标记（给出「收到了」的即时确认）', async () => {
    await mount();
    stubRect(img());
    expect(host!.querySelector('.sim-marker')).toBeNull();
    await pointer('pointerdown', 100, 200);
    await pointer('pointerup', 100, 200);
    expect(host!.querySelector('.sim-marker'), '点击后应有落点标记').not.toBeNull();
  });

  it('拖动中显示轨迹线，抬手后消失', async () => {
    await mount();
    stubRect(img());
    await pointer('pointerdown', 100, 200);
    await pointer('pointermove', 200, 300);
    expect(host!.querySelector('.sim-drag'), '拖动中应有轨迹').not.toBeNull();
    await pointer('pointerup', 200, 300);
    expect(host!.querySelector('.sim-drag'), '抬手后轨迹应消失').toBeNull();
  });
});
