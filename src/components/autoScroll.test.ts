/**
 * 自动滚动规则的测试。
 *
 * 这里钉住的是「不要抢用户的滚动条」——一个错了会让人无法阅读、
 * 但不会有任何报错的行为。判据用距底部像素数，因此边界值必须测：
 * 差 1px 就切换行为的话，用户会看到按钮闪。
 */
import { describe, expect, it } from 'vitest';
import { BOTTOM_THRESHOLD_PX, isAtBottom, showScrollToBottom, shouldAutoScroll } from './autoScroll';

/** 造一个可滚动视口：内容 1000px，视口 300px。 */
const scrollable = (scrollTop: number) => ({
  scrollTop,
  scrollHeight: 1000,
  clientHeight: 300, // 最大 scrollTop = 700
});

describe('isAtBottom', () => {
  it('精确贴底时为真', () => {
    expect(isAtBottom(scrollable(700))).toBe(true);
  });

  it('阈值内视为贴底（容忍小数像素与动态高度）', () => {
    expect(isAtBottom(scrollable(700 - BOTTOM_THRESHOLD_PX))).toBe(true);
    expect(isAtBottom(scrollable(700 - BOTTOM_THRESHOLD_PX + 1))).toBe(true);
  });

  it('超过阈值即视为已上滑', () => {
    expect(isAtBottom(scrollable(700 - BOTTOM_THRESHOLD_PX - 1))).toBe(false);
  });

  it('滚到顶部显然不是贴底', () => {
    expect(isAtBottom(scrollable(0))).toBe(false);
  });

  it('内容不足一屏时为真——没有可滚动空间', () => {
    const short = { scrollTop: 0, scrollHeight: 200, clientHeight: 300 };
    expect(isAtBottom(short)).toBe(true);
  });
});

describe('shouldAutoScroll（跟随规则）', () => {
  it('贴底 → 跟随新内容', () => {
    expect(shouldAutoScroll(scrollable(700))).toBe(true);
  });

  it('用户上滑后 → 不跟随（核心要求：不抢滚动条）', () => {
    expect(shouldAutoScroll(scrollable(100))).toBe(false);
  });

  it('用户滚回底部 → 恢复跟随', () => {
    expect(shouldAutoScroll(scrollable(100))).toBe(false);
    expect(shouldAutoScroll(scrollable(700))).toBe(true);
  });
});

describe('showScrollToBottom（按钮显示）', () => {
  it('内容不足一屏 → 不显示（无处可滚）', () => {
    expect(showScrollToBottom({ scrollTop: 0, scrollHeight: 200, clientHeight: 300 })).toBe(false);
  });

  it('上滑后 → 显示', () => {
    expect(showScrollToBottom(scrollable(100))).toBe(true);
  });

  it('贴底 → 不显示（已在底部，按钮无意义）', () => {
    expect(showScrollToBottom(scrollable(700))).toBe(false);
  });

  it('刚好超出阈值时显示，阈值内不显示——避免闪', () => {
    expect(showScrollToBottom(scrollable(700 - BOTTOM_THRESHOLD_PX))).toBe(false);
    expect(showScrollToBottom(scrollable(700 - BOTTOM_THRESHOLD_PX - 1))).toBe(true);
  });
});
