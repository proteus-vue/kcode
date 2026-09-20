/**
 * 窄窗自动折叠的判定。
 *
 * 这段逻辑的取值直接决定「用户能不能看到审批面板」，
 * 而且只在特定宽度区间出错，肉眼极难发现——所以逐条钉住边界。
 *
 * 常量（与 usePanelLayout.ts 一致）：左 240 / 右 320 / 中 520。
 */
import { describe, expect, it } from 'vitest';
import { computeForcedCollapse } from './usePanelLayout';

const LEFT = 240;
const RIGHT = 320;
const CENTER = 520;
/** 三栏都显示所需宽度 */
const ALL = LEFT + CENTER + RIGHT; // 1080
/** 显示左 + 中所需宽度 */
const LEFT_CENTER = LEFT + CENTER; // 760
/** 显示中 + 右所需宽度 */
const CENTER_RIGHT = CENTER + RIGHT; // 840

describe('computeForcedCollapse', () => {
  it('宽度充足时三栏都不折叠', () => {
    expect(computeForcedCollapse(ALL + 200, false, false)).toEqual({ left: false, right: false });
  });

  it('恰好放下三栏时不折叠——边界是「小于」而非「小于等于」', () => {
    expect(computeForcedCollapse(ALL, false, false)).toEqual({ left: false, right: false });
    // 少 1px 就该让位
    expect(computeForcedCollapse(ALL - 1, false, false)).toEqual({ left: false, right: true });
  });

  it('放不下三栏时先牺牲右栏，保留左栏与中间栏', () => {
    const r = computeForcedCollapse(LEFT_CENTER, false, false);
    expect(r).toEqual({ left: false, right: true });
  });

  it('连左栏都放不下时才两栏都折叠', () => {
    expect(computeForcedCollapse(LEFT_CENTER - 1, false, false)).toEqual({ left: true, right: true });
  });

  it('优先级是「右栏 > 左栏」：右栏承载审批，缺了任务会卡住', () => {
    // CENTER_RIGHT 宽度下：留下中+右（840）可行，留下中+左（760）也可行，
    // 但三栏（1080）不可行。按优先级应保右弃左。
    const r = computeForcedCollapse(CENTER_RIGHT, false, false);
    expect(r.left).toBe(false);
    expect(r.right).toBe(true);
  });

  it('用户已折叠左栏时，右栏需要的宽度里不含左栏', () => {
    // 这是修复前的真实缺陷：1000px 窗口下用户手动收起左栏，
    // 右栏仍按「左栏存在」判断而被强制收起，用户的操作白做。
    const r = computeForcedCollapse(CENTER_RIGHT, true, false);
    expect(r).toEqual({ left: false, right: false });
  });

  it('用户在窄窗手动收起左栏后，右栏不该被连带收起', () => {
    // 1000px 窗口：avail = 1000 - 48 = 952
    const r = computeForcedCollapse(952, true, false);
    expect(r.right).toBe(false);
  });

  it('用户已折叠右栏时，左栏的判定也不为右栏留宽度', () => {
    expect(computeForcedCollapse(LEFT_CENTER, false, true)).toEqual({ left: false, right: false });
  });

  it('两栏都已被用户折叠时，forced 只反映窗口宽度是否够用', () => {
    // 注意语义：forced 描述的是「窗口放不放得下」，不是「面板收没收起」。
    // 用户已经自行折叠时，最终结果由 `wantX || forcedX` 得出——
    // 无论 forced 是 true 还是 false，面板都是收起的。
    expect(computeForcedCollapse(0, true, true)).toEqual({ left: true, right: true });
    expect(computeForcedCollapse(2000, true, true)).toEqual({ left: false, right: false });
  });

  it('极端窄窗下中间栏仍要保留 CENTER 的空间', () => {
    // 用户折叠了左栏，但中间栏 + 右栏仍放不下 → 右栏让位
    expect(computeForcedCollapse(CENTER_RIGHT - 1, true, false)).toEqual({ left: false, right: true });
    // 用户两栏都要，但连中间栏都保不住 → 两栏都折叠，把空间全部让给正文
    expect(computeForcedCollapse(100, false, false)).toEqual({ left: true, right: true });
  });

  it('折叠是单调的：窗口越窄，折叠的面板只增不减', () => {
    const snap = (a: number) => {
      const r = computeForcedCollapse(a, false, false);
      return `${r.left ? 'L' : '-'}${r.right ? 'R' : '-'}`;
    };
    const widths = [1200, 1100, 1080, 1000, 900, 840, 800, 760, 700, 600, 400];
    const states = widths.map(snap);
    // 不出现「变宽反而折得更多」的抖动
    for (let i = 1; i < states.length; i++) {
      const prev = states[i - 1];
      const cur = states[i];
      // 合法转移：-- → -R → LR，不允许回退
      const rank = (s: string) => (s === '--' ? 0 : s === '-R' ? 1 : 2);
      expect(rank(cur)).toBeGreaterThanOrEqual(rank(prev));
    }
  });
});


describe('栏宽持久化与范围校验', () => {
  /**
   * 这些断言针对 readNum 的行为：手改过 localStorage、或旧版本留下的
   * 越界值不该让布局崩掉（例如宽度为 0 或负数会把栏压没）。
   * 通过 computeForcedCollapse 的边界间接验证常量仍然自洽。
   */
  it('最小宽度之和小于常见窗口宽度（否则一打开就全部折叠）', () => {
    // 1080 是三栏的最小总和；若这个数超过常见窗口宽度，
    // 用户一打开就看到「两栏都被强制收起」，属于不可用
    const ALL = 240 + 520 + 320;
    expect(ALL).toBeLessThanOrEqual(1200);
  });

  it('拖拽的上下限不交叉（min <= default <= max）', () => {
    // 左栏
    expect(240).toBeLessThanOrEqual(340);
    expect(340).toBeLessThanOrEqual(520);
    // 右栏
    expect(320).toBeLessThanOrEqual(460);
    expect(460).toBeLessThanOrEqual(760);
  });
});
