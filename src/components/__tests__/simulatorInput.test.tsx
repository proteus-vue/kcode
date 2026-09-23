/**
 * 模拟器面板的手势接线测试（组件级）。
 *
 * 纯函数测试只证明「判定对了」，不证明**判定结果真的发出去了**。
 * 这一层要守的是一整条链：pointer 事件 → 坐标换算 → invoke。
 * 上一轮核查发现的问题正是「后端支持 swipe、前端从未调用」——
 * 那种缺口只有组件级测试能拦住。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SimulatorPanel } from '../SimulatorPanel';
import type { SimulatorFrame, SimulatorStatus } from '../../types/domain';

// ── 桩掉 Tauri 的 invoke ──────────────────────────────────────────────
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
let frameCalls = 0;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    if (cmd === 'simulator_frame') {
      frameCalls += 1;
      return { dataUrl: 'data:image/png;base64,AAAA', width: 1000, height: 2000 } as SimulatorFrame;
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
  // 停掉组件的 600ms 轮询定时器：它会在测试结束后触发 setState，
  // 让 React 打印 act 警告——噪音会淹没真正的失败信息。
  // 这里改用假定时器并要求测试自己推进；本文件的断言都不依赖轮询。
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
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
function pointer(type: string, x: number, y: number) {
  const el = img();
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  // setPointerCapture 在 jsdom 里不存在，补一个空实现
  (el as unknown as { setPointerCapture?: (id: number) => void }).setPointerCapture = () => {};
  act(() => {
    el.dispatchEvent(e);
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
    pointer('pointerdown', 100, 200);
    pointer('pointerup', 100, 200);

    const call = lastInput();
    expect(call, '应发出 simulator_input').toBeDefined();
    expect(call!.args).toMatchObject({ action: 'tap', x1: 200, y1: 400, serial: 'emulator-5554' });
  });

  it('微抖动仍发 tap（阈值内的位移不该变成滑动）', async () => {
    await mount();
    stubRect(img());
    pointer('pointerdown', 100, 200);
    pointer('pointerup', 103, 202);
    expect(lastInput()!.args.action).toBe('tap');
  });
});

describe('滑动', () => {
  it('按下移动抬起发 swipe，带起点与终点', async () => {
    await mount();
    stubRect(img());
    pointer('pointerdown', 100, 200);
    pointer('pointermove', 200, 400);
    pointer('pointerup', 250, 500);

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
    pointer('pointerdown', 10, 10);
    pointer('pointerup', 300, 600);
    expect(lastInput()!.args.action).toBe('swipe');
  });

  it('pointercancel 不发出任何输入（用户没完成这次操作）', async () => {
    await mount();
    stubRect(img());
    pointer('pointerdown', 100, 200);
    pointer('pointermove', 200, 300);
    pointer('pointercancel', 200, 300);
    expect(lastInput(), '被系统取消的手势不该补发输入').toBeUndefined();
    // 取消后再抬起也不该触发（手势已作废）
    pointer('pointerup', 200, 300);
    expect(lastInput()).toBeUndefined();
  });
});

describe('坐标夹紧', () => {
  it('滑出画面外的坐标被夹到设备范围内', async () => {
    await mount();
    stubRect(img());
    pointer('pointerdown', 100, 200);
    // 拖到图片右下方之外：clientX 远超 500 的宽度
    pointer('pointerup', 900, 1500);
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
    pointer('pointerdown', 100, 200);
    pointer('pointerup', 100, 200);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(frameCalls, '输入后应立即补一帧，否则反馈要等下一次轮询').toBeGreaterThan(before);
  });
});

describe('落点标记', () => {
  it('点击后出现标记（给出「收到了」的即时确认）', async () => {
    await mount();
    stubRect(img());
    expect(host!.querySelector('.sim-marker')).toBeNull();
    pointer('pointerdown', 100, 200);
    pointer('pointerup', 100, 200);
    expect(host!.querySelector('.sim-marker'), '点击后应有落点标记').not.toBeNull();
  });

  it('拖动中显示轨迹线，抬手后消失', async () => {
    await mount();
    stubRect(img());
    pointer('pointerdown', 100, 200);
    pointer('pointermove', 200, 300);
    expect(host!.querySelector('.sim-drag'), '拖动中应有轨迹').not.toBeNull();
    pointer('pointerup', 200, 300);
    expect(host!.querySelector('.sim-drag'), '抬手后轨迹应消失').toBeNull();
  });
});
