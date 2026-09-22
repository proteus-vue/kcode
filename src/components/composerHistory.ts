/**
 * 输入历史回溯（规格 04 §4.5：多行自适应高度、历史记录（↑ 键回溯））。
 *
 * 行为对齐 shell 的 `↑ / ↓`：
 *
 * - `↑` 从**草稿**进入历史，停在最新一条；继续按往更早走，到顶后停住。
 * - `↓` 往更近走；越过最新一条时**回到用户原先的草稿**——这是关键，
 *   否则用户按了几下 ↑ 再按 ↓，自己刚打了一半的内容就永久丢了。
 *
 * 抽成纯函数是因为「下标越界」与「草稿恢复」这两处都只在特定按键序列下
 * 出错，且出错是静默的（填错文本、或草稿消失）。真机上按几十次才能撞见。
 */

/** 一次回溯会话的状态。 */
export interface HistoryCursor {
  /** 当前停在历史里的下标；`null` 表示「在草稿上」。 */
  index: number | null;
  /** 进入历史前的草稿，退出时原样还回。 */
  draft: string;
}

export const INITIAL_CURSOR: HistoryCursor = { index: null, draft: '' };

/** 历史上限。超出后丢最旧的——它属于很久以前的任务，参考价值最低。 */
export const HISTORY_LIMIT = 50;

/**
 * 记录一条已提交的输入。
 *
 * 连续重复不重复记录：连着发两条一样的指令（例如重试）时，
 * 历史里出现两条相同项毫无意义，还要多按一次 ↑ 才能越过。
 */
export function pushHistory(history: string[], text: string, limit = HISTORY_LIMIT): string[] {
  const t = text.trim();
  if (!t) return history;
  const last = history[history.length - 1];
  if (last === t) return history;
  const next = [...history, t];
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/**
 * `↑`：往更早的方向走一步。
 *
 * 从草稿进入历史时先把当前草稿存起来；已在历史里时 draft 保持不变
 * （否则会把历史项误存成草稿）。
 */
export function historyPrev(
  history: string[],
  cursor: HistoryCursor,
  currentDraft: string,
): { cursor: HistoryCursor; text: string } {
  if (history.length === 0) return { cursor, text: currentDraft };

  if (cursor.index === null) {
    // 首次进入历史：记下草稿，停在最新一条
    const i = history.length - 1;
    return { cursor: { index: i, draft: currentDraft }, text: history[i] };
  }

  // 已到顶：停住不动。回绕到末尾会让用户以为历史乱了。
  if (cursor.index === 0) return { cursor, text: history[0] };

  const i = cursor.index - 1;
  return { cursor: { ...cursor, index: i }, text: history[i] };
}

/** `↓`：往更近的方向走一步；越过最新一条则回到草稿。 */
export function historyNext(
  history: string[],
  cursor: HistoryCursor,
): { cursor: HistoryCursor; text: string } {
  // 本来就在草稿上：↓ 无事可做
  if (cursor.index === null) return { cursor, text: cursor.draft };
  // 已是最新一条：再往下就是草稿
  if (cursor.index >= history.length - 1) {
    return { cursor: INITIAL_CURSOR, text: cursor.draft };
  }
  const i = cursor.index + 1;
  return { cursor: { ...cursor, index: i }, text: history[i] };
}

/**
 * 回溯下标移动（通用，也用于弹层菜单的上下键导航）。
 *
 * 与历史回溯的区别：这里**允许回绕**（到顶后再按 ↑ 回到末尾）。
 * 菜单是有限选项列表，回绕符合用户预期；而历史列表回绕会让人以为乱序。
 */
export function moveIndex(current: number, count: number, delta: 1 | -1): number {
  if (count <= 0) return 0;
  return (current + delta + count) % count;
}
