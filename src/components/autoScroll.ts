/**
 * 消息流的自动滚动规则。
 *
 * # 为什么不能只做「永远滚到底部」
 *
 * 用户在 Agent 输出过程中向上翻看某段代码时，如果每来一个 token 就把
 * 视图拽回底部，他根本没法读——这是成熟客户端与简陋客户端最容易被感知的
 * 差异之一。正确行为是：
 *
 * - 用户**贴着底部**时：新内容到达自动跟随；
 * - 用户**主动上滑**后：停止跟随，并给出「回到底部」入口；
 * - 用户滚回底部：恢复跟随。
 *
 * 判据用「距底部多少像素」而不是「是否精确等于底部」：不同缩放下
 * 小数像素会让精确比较失效，用户会看到按钮时有时无地闪。
 */

/** 距底部多少像素以内算「贴着底部」。 */
export const BOTTOM_THRESHOLD_PX = 48;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * 当前是否贴着底部。
 *
 * 内容不足一屏时（scrollHeight <= clientHeight）恒为 true——
 * 此时没有可滚动空间，不该出现「回到底部」按钮。
 */
export function isAtBottom(m: ScrollMetrics, threshold = BOTTOM_THRESHOLD_PX): boolean {
  const distance = m.scrollHeight - m.scrollTop - m.clientHeight;
  // 加一点余量容忍小数像素
  return distance <= threshold;
}

/**
 * 是否应该在新内容到达时跟随滚动。
 *
 * 已经贴底 → 跟随；用户上滑过 → 不跟随。
 * 这一个函数就是「别抢用户的滚动条」的全部规则。
 */
export function shouldAutoScroll(m: ScrollMetrics, threshold = BOTTOM_THRESHOLD_PX): boolean {
  return isAtBottom(m, threshold);
}

/**
 * 「回到底部」按钮的显示条件。
 *
 * 与 `shouldAutoScroll` 是同一判据的两种用途，但**刻意分开命名**：
 * 一个是「要不要动滚动条」，一个是「要不要显示控件」。将来若调整
 * 按钮的敏感度（例如更迟钝一些，避免闪），不会连带改坏滚动行为。
 */
export function showScrollToBottom(m: ScrollMetrics, threshold = BOTTOM_THRESHOLD_PX): boolean {
  // 内容不足一屏 → 没有滚动空间 → 不显示
  if (m.scrollHeight <= m.clientHeight) return false;
  return !isAtBottom(m, threshold);
}
