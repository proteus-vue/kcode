/**
 * 模拟器手势判定的测试。
 *
 * 判错的后果是直接可见的，而且**不会有任何报错**：
 * - 把点击判成滑动 → 列表被意外滚动，用户以为自己点错了；
 * - 把滑动判成点击 → 拖不动，用户以为模拟器卡了。
 *
 * 所以边界逐个钉住。
 */
import { describe, expect, it } from 'vitest';
import {
  classifyGesture,
  clampDuration,
  EDGE_BOTTOM_MAX_Y,
  EDGE_LEFT_MAX_X,
  edgeFlag,
  inferEdgeGesture,
  MAX_SWIPE_MS,
  MIN_SWIPE_MS,
  TAP_SLOP_PX,
} from './simulatorGesture';

const at = (x: number, y: number) => ({ x, y });

describe('点击 vs 滑动', () => {
  it('完全不动是点击', () => {
    expect(classifyGesture(at(100, 200), at(100, 200), 80)).toEqual({ kind: 'tap', x: 100, y: 200 });
  });

  it('手指的微小抖动仍算点击（这是阈值存在的全部理由）', () => {
    // 手指按住时不可避免会抖几像素；判成滑动会让「点一下」变成「轻微滚动」
    expect(classifyGesture(at(100, 200), at(103, 202), 90).kind).toBe('tap');
    // 斜向位移按欧氏距离算：3-4-5 直角三角形恰好 5px
    expect(classifyGesture(at(100, 200), at(103, 204), 90).kind).toBe('tap');
  });

  it('超过阈值即滑动', () => {
    expect(classifyGesture(at(100, 200), at(100 + TAP_SLOP_PX + 1, 200), 120).kind).toBe('swipe');
  });

  it('滑动保留起点与终点（两者都要，方向由它们决定）', () => {
    const g = classifyGesture(at(100, 200), at(300, 500), 160);
    expect(g).toEqual({
      kind: 'swipe',
      x1: 100,
      y1: 200,
      x2: 300,
      y2: 500,
      durationMs: 160,
    });
  });

  it('长按仍是点击（设备端的长按菜单靠它触发）', () => {
    // 时长不参与判定：判成滑动会让长按菜单永远出不来
    expect(classifyGesture(at(50, 60), at(50, 60), 2500).kind).toBe('tap');
  });

  it('点击取落点（终点），而不是起点', () => {
    const g = classifyGesture(at(10, 20), at(12, 21), 70);
    expect(g).toEqual({ kind: 'tap', x: 12, y: 21 });
  });

  it('任意方向都算滑动（上下左右）', () => {
    for (const end of [at(200, 100), at(0, 100), at(100, 300), at(100, 0)]) {
      expect(classifyGesture(at(100, 100), end, 150).kind, `${end} 应为滑动`).toBe('swipe');
    }
  });
});

describe('滑动时长夹紧', () => {
  it('过短抬到下限（避免设备上表现为瞬移）', () => {
    expect(clampDuration(1)).toBe(MIN_SWIPE_MS);
    expect(clampDuration(0)).toBe(MIN_SWIPE_MS);
  });

  it('过长压到上限（避免「滚动」变成「慢慢拖」）', () => {
    expect(clampDuration(5000)).toBe(MAX_SWIPE_MS);
  });

  it('正常范围原样保留（快滑与慢拖要有区别，否则手感不对）', () => {
    expect(clampDuration(160)).toBe(160);
    expect(clampDuration(MIN_SWIPE_MS)).toBe(MIN_SWIPE_MS);
    expect(clampDuration(MAX_SWIPE_MS)).toBe(MAX_SWIPE_MS);
  });

  it('非法输入回落到下限，而不是产出 NaN 传给 adb', () => {
    // adb 收到 "NaN" 会报参数错误，而那看起来像设备问题
    expect(clampDuration(Number.NaN)).toBe(MIN_SWIPE_MS);
    expect(clampDuration(Number.POSITIVE_INFINITY)).toBe(MAX_SWIPE_MS);
    expect(clampDuration(-5)).toBe(MIN_SWIPE_MS);
  });

  it('滑动时使用夹紧后的时长', () => {
    const g = classifyGesture(at(0, 0), at(100, 100), 99999);
    expect(g.kind === 'swipe' && g.durationMs).toBe(MAX_SWIPE_MS);
  });
});

/**
 * 系统边缘手势的推断。
 *
 * # 为什么这个判定的边界特别要紧
 *
 * 边缘标记会**覆盖落点判定**（实测：标了底边缘后，从 y=0.90 起滑也能回主屏）。
 * 也就是说标记是一次下注，标错的代价是那一整片区域的正常拖动全部失效——
 * 用户会以为「列表滑不动 / 卡了」，而不会有任何报错。
 *
 * 所以这里既钉住「该标的必须标」（不标就完全没有手势），
 * 也钉住「不该标的绝不能标」（标错方向就是纯粹的功能损失）。
 */
describe('边缘手势推断', () => {
  it('从底边缘向上滑 → 回主屏', () => {
    expect(inferEdgeGesture(0.5, 0.995, 0.5, 0.4)).toBe('bottom');
    expect(inferEdgeGesture(0.5, 0.99, 0.5, 0.3)).toBe('bottom');
  });

  it('从左边缘向右滑 → 返回', () => {
    expect(inferEdgeGesture(0.005, 0.5, 0.8, 0.5)).toBe('left');
  });

  it('不在边缘区内的一律不标（普通拖动不能被抢走）', () => {
    // 画面中部上滑是滚动列表，绝不能标成回主屏
    expect(inferEdgeGesture(0.5, 0.6, 0.5, 0.3)).toBe('none');
    // 画面中部右滑是横向滚动/翻页
    expect(inferEdgeGesture(0.3, 0.5, 0.7, 0.5)).toBe('none');
    // 刚过阈值之外
    expect(inferEdgeGesture(0.5, EDGE_BOTTOM_MAX_Y - 0.01, 0.5, 0.3)).toBe('none');
    expect(inferEdgeGesture(EDGE_LEFT_MAX_X + 0.01, 0.5, 0.8, 0.5)).toBe('none');
  });

  it('方向不对就不标（落点在边缘但方向不符）', () => {
    // 在底边缘**向下**滑（拉出控制中心那类）不是回主屏
    expect(inferEdgeGesture(0.5, 0.99, 0.5, 1.0)).toBe('none');
    // 在底边缘横向滑（指示条区域的横向拖动）不是回主屏
    expect(inferEdgeGesture(0.2, 0.99, 0.8, 0.99)).toBe('none');
    // 在左边缘向上/下滑（边缘滚动）不是返回
    expect(inferEdgeGesture(0.005, 0.3, 0.005, 0.7)).toBe('none');
    // 左边缘向左滑（滑出屏幕）不是返回
    expect(inferEdgeGesture(0.03, 0.5, 0.001, 0.5)).toBe('none');
  });

  it('阈值边界本身算边缘（含端点）', () => {
    expect(inferEdgeGesture(0.5, EDGE_BOTTOM_MAX_Y, 0.5, 0.4)).toBe('bottom');
    expect(inferEdgeGesture(EDGE_LEFT_MAX_X, 0.5, 0.8, 0.5)).toBe('left');
  });

  it('斜向拖动以主方向定归属（不能两者都算）', () => {
    // 从底边起、向右上斜着滑：纵向分量更大 → 回主屏
    expect(inferEdgeGesture(0.5, 0.99, 0.7, 0.5)).toBe('bottom');
    // 从左边缘起、向右下斜着滑：横向分量更大 → 返回
    expect(inferEdgeGesture(0.01, 0.3, 0.6, 0.5)).toBe('left');
  });

  it('标记值必须与注入层的 IndigoHIDEdge 常量一致', () => {
    // helper 里 edgeLeft=1 / edgeBottom=3，写错就是「手势静默失效」
    expect(edgeFlag('none')).toBe(0);
    expect(edgeFlag('left')).toBe(1);
    expect(edgeFlag('bottom')).toBe(3);
  });
});
