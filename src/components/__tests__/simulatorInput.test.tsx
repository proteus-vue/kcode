/**
 * 模拟器面板的手势接线测试（组件级）。
 *
 * 纯函数测试只证明「判定对了」，不证明**判定结果真的发出去了**。
 * 这一层要守的是一整条链：pointer 事件 → 坐标换算 → invoke。
 * 上一轮核查发现的问题正是「后端支持 swipe、前端从未调用」——
 * 那种缺口只有组件级测试能拦住。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SimulatorPanel } from '../SimulatorPanel';
import type { SimulatorFrame, SimulatorStatus } from '../../types/domain';

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
      return nextFrame;
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

const status: SimulatorStatus = {
  android: {
    available: true,
    reason: null,
    avds: ['Pixel_7'],
    devices: [{ serial: 'emulator-5554', state: 'device', model: 'Pixel 7' }],
  },
  ios: { available: false, reason: '未安装完整 Xcode' },
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
    expect(call!.args).toMatchObject({ action: 'tap', x1: 200, y1: 400, serial: 'emulator-5554' });
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

describe('启动后自动等设备就绪', () => {
  it('启动后轮询探测，设备出现时自动选中并停止提示', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // 初始：有 AVD、无运行设备
    probeResult = {
      android: {
        available: true,
        reason: null,
        avds: ['Pixel_7'],
        devices: [],
      },
      ios: { available: false, reason: '缺 Xcode' },
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

    // 点「启动」
    const startBtn = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('启动'));
    expect(startBtn, '应有启动按钮').toBeDefined();
    await act(async () => {
      startBtn!.click();
    });

    // 等设备出现（模拟器冷启动）
    probeResult = {
      android: {
        available: true,
        reason: null,
        avds: ['Pixel_7'],
        devices: [{ serial: 'emulator-5554', state: 'device', model: 'Pixel 7' }],
      },
      ios: { available: false, reason: '缺 Xcode' },
    };
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2200)); // 跨过一次 2s 轮询
    });

    expect(probeCalls, '应自动探测设备，不需要用户手动刷新').toBeGreaterThan(0);
    // 设备选中后应当开始取帧（面板有画面）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    // 设备就绪后 AVD 选择器被设备选择器替换，所以要在所有下拉里找含该 serial 的那个。
    // （原先只取第一个 .sim-select，读到的是 AVD 选择器，断言必失败——那是测试的问题。）
    const selects = [...host.querySelectorAll('.sim-select')] as HTMLSelectElement[];
    const deviceSelect = selects.find((el) =>
      [...el.options].some((o) => o.value === 'emulator-5554'),
    );
    expect(deviceSelect, '应出现设备选择器').toBeDefined();
    expect(deviceSelect!.value, '设备就绪后应自动选中它').toBe('emulator-5554');
    expect(host.querySelector('.sim-notice'), '就绪后提示应消失').toBeNull();
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
