/**
 * 输入历史回溯的测试。
 *
 * 钉住两处静默错误：
 *
 * 1. **草稿必须能还回来。** 用户打了一半、按 ↑ 翻历史、再按 ↓ 回到草稿，
 *    若实现里忘了存草稿，那半句话就永久消失了——没有任何报错。
 * 2. **边界不越界。** 到顶继续按 ↑、在最新一条按 ↓，都必须停住或回到草稿，
 *    不能读出 `undefined`（会显示成空输入框，像内容被吞了）。
 */
import { describe, expect, it } from 'vitest';
import {
  HISTORY_LIMIT,
  INITIAL_CURSOR,
  historyNext,
  historyPrev,
  moveIndex,
  pushHistory,
} from './composerHistory';

describe('pushHistory', () => {
  it('追加新条目', () => {
    expect(pushHistory([], 'a')).toEqual(['a']);
    expect(pushHistory(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('连续重复不重复记录（重试同一指令时不该多占一格）', () => {
    expect(pushHistory(['a', 'a'], 'a')).toEqual(['a', 'a']);
    expect(pushHistory(['a'], 'a')).toEqual(['a']);
  });

  it('非连续重复仍然记录（中间夹了别的指令）', () => {
    expect(pushHistory(['a', 'b'], 'a')).toEqual(['a', 'b', 'a']);
  });

  it('空白输入不记录', () => {
    expect(pushHistory(['a'], '   ')).toEqual(['a']);
    expect(pushHistory(['a'], '')).toEqual(['a']);
  });

  it('记录前去掉首尾空白（回溯出来的是干净指令）', () => {
    expect(pushHistory([], '  ls -la  ')).toEqual(['ls -la']);
  });

  it('超出上限丢最旧的', () => {
    const many = Array.from({ length: HISTORY_LIMIT }, (_, i) => `c${i}`);
    const next = pushHistory(many, 'newest');
    expect(next).toHaveLength(HISTORY_LIMIT);
    expect(next[next.length - 1]).toBe('newest');
    expect(next[0]).toBe('c1'); // c0 被挤出
  });

  it('不改动传入的数组（纯函数）', () => {
    const before = ['a'];
    pushHistory(before, 'b');
    expect(before).toEqual(['a']);
  });
});

describe('historyPrev（↑）', () => {
  it('空历史时不动，也不污染草稿', () => {
    const r = historyPrev([], INITIAL_CURSOR, 'draft');
    expect(r.text).toBe('draft');
    expect(r.cursor).toEqual(INITIAL_CURSOR);
  });

  it('首次按下取最新一条，并记住草稿', () => {
    const r = historyPrev(['one', 'two'], INITIAL_CURSOR, '我的草稿');
    expect(r.text).toBe('two');
    expect(r.cursor.index).toBe(1);
    expect(r.cursor.draft).toBe('我的草稿');
  });

  it('继续按往更早走', () => {
    let s = historyPrev(['one', 'two'], INITIAL_CURSOR, '');
    s = historyPrev(['one', 'two'], s.cursor, s.text);
    expect(s.text).toBe('one');
    expect(s.cursor.index).toBe(0);
  });

  it('已到最旧一条时停住（不回绕）', () => {
    let s = historyPrev(['one', 'two'], INITIAL_CURSOR, '');
    s = historyPrev(['one', 'two'], s.cursor, s.text);
    const again = historyPrev(['one', 'two'], s.cursor, s.text);
    expect(again.text).toBe('one');
    expect(again.cursor.index).toBe(0);
  });

  it('已在历史里时不会把历史项误存成草稿', () => {
    let s = historyPrev(['one', 'two'], INITIAL_CURSOR, '原始草稿');
    s = historyPrev(['one', 'two'], s.cursor, s.text);
    expect(s.cursor.draft).toBe('原始草稿');
  });
});

describe('historyNext（↓）', () => {
  it('在草稿上按 ↓ 无事发生', () => {
    const r = historyNext(['one'], INITIAL_CURSOR);
    expect(r.text).toBe('');
    expect(r.cursor).toEqual(INITIAL_CURSOR);
  });

  it('往更近走', () => {
    // 先退到最旧
    let s = historyPrev(['one', 'two'], INITIAL_CURSOR, '');
    s = historyPrev(['one', 'two'], s.cursor, s.text);
    expect(s.text).toBe('one');
    const n = historyNext(['one', 'two'], s.cursor);
    expect(n.text).toBe('two');
  });

  it('越过最新一条回到草稿（核心：草稿不能丢）', () => {
    let s = historyPrev(['one', 'two'], INITIAL_CURSOR, '我打了一半的话');
    expect(s.text).toBe('two');
    const n = historyNext(['one', 'two'], s.cursor);
    expect(n.text).toBe('我打了一半的话');
    expect(n.cursor.index).toBeNull();
  });

  it('完整往返：草稿 → 历史 → 草稿', () => {
    const history = ['a', 'b', 'c'];
    const draft = '半句话';
    let s = historyPrev(history, INITIAL_CURSOR, draft); // c
    s = historyPrev(history, s.cursor, s.text); // b
    s = historyPrev(history, s.cursor, s.text); // a
    expect(s.text).toBe('a');
    s = historyNext(history, s.cursor); // b
    s = historyNext(history, s.cursor); // c
    s = historyNext(history, s.cursor); // 草稿
    expect(s.text).toBe(draft);
    expect(s.cursor.index).toBeNull();
  });

  it('空历史下 ↓ 不读出 undefined', () => {
    const r = historyNext([], { index: 0, draft: 'x' });
    expect(r.text).toBe('x');
  });
});

describe('moveIndex（菜单上下键，允许回绕）', () => {
  it('向下越界回到开头', () => {
    expect(moveIndex(2, 3, 1)).toBe(0);
  });
  it('向上越界回到末尾', () => {
    expect(moveIndex(0, 3, -1)).toBe(2);
  });
  it('空列表恒为 0（不产生 NaN）', () => {
    expect(moveIndex(0, 0, 1)).toBe(0);
    expect(moveIndex(5, 0, -1)).toBe(0);
  });
});
