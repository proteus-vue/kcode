/**
 * 流式文本归约测试。
 *
 * 流式是「体感差距」最大的一环：不处理时回复以整块形式在末尾出现，
 * 用户看不到生成过程。而流式逻辑有自己的陷阱——
 * 缓冲与实际内容重复渲染、Item 落地后缓冲未清理等。
 */
import { describe, expect, it } from 'vitest';
import {
  initialState,
  isStreaming,
  itemText,
  reduce,
  streamedTextOf,
  threadItems,
} from './store';
import type { AppEvent, Item } from '../types/domain';

function agentItem(id: string, text = ''): Item {
  return { id, turnId: 'tu', createdAtMs: 0, body: { kind: 'agentMessage', text } };
}

const delta = (itemId: string, text: string): AppEvent => ({
  type: 'textDelta',
  threadId: 'th',
  itemId,
  turnId: 'tu',
  channel: 'agentMessage',
  delta: text,
});

describe('流式文本', () => {
  it('增量按到达顺序累积', () => {
    const state = [delta('i1', '你'), delta('i1', '好'), delta('i1', '！')].reduce(
      (s, e) => reduce(s, e),
      initialState(),
    );
    expect(state.threads['th'].streamBuffer['i1']).toBe('你好！');
  });

  it('不同 item 的缓冲互不干扰', () => {
    const state = [delta('a', 'AAA'), delta('b', 'BBB'), delta('a', 'aa')].reduce(
      (s, e) => reduce(s, e),
      initialState(),
    );
    expect(state.threads['th'].streamBuffer['a']).toBe('AAAaa');
    expect(state.threads['th'].streamBuffer['b']).toBe('BBB');
  });

  it('item 落地后清空缓冲，避免重复渲染', () => {
    // 这是最容易出的 bug：缓冲与正式内容都显示 → 文字出现两遍
    let state = reduce(initialState(), delta('i1', '流式内容'));
    state = reduce(state, {
      type: 'itemUpserted',
      threadId: 'th',
      turnId: 'tu',
      item: agentItem('i1', '最终内容'),
      completed: true,
    });

    const item = threadItems(state, 'th')[0];
    expect(itemText(item)).toBe('最终内容');
    expect(
      state.threads['th'].streamBuffer['i1'],
      'Item 落地后缓冲必须清空，否则渲染会重复',
    ).toBeUndefined();
    expect(streamedTextOf(state, item)).toBe('');
  });

  it('生成中时 isStreaming 为真，完成后为假（真实时序）', () => {
    let state = reduce(initialState(), delta('i1', '部分'));
    state = reduce(state, {
      type: 'itemUpserted',
      threadId: 'th',
      turnId: 'tu',
      item: agentItem('i1'), // started：尚无正式文本
      completed: false,
    });
    const item = threadItems(state, 'th')[0];
    expect(isStreaming(state, item)).toBe(true);

    state = reduce(state, {
      type: 'itemUpserted',
      threadId: 'th',
      turnId: 'tu',
      item: agentItem('i1', '完成'),
      completed: true,
    });
    expect(isStreaming(state, threadItems(state, 'th')[0])).toBe(false);
  });

  it('started 之后的增量不能被丢弃（真实时序回归）', () => {
    // 实测顺序：item/started → 多条 delta → item/completed。
    // 若在 started 就清缓冲，后续增量会全部丢失——这是实际踩过的错误。
    let state = reduce(initialState(), {
      type: 'itemUpserted',
      threadId: 'th',
      turnId: 'tu',
      item: agentItem('i1'),
      completed: false,
    });
    state = [delta('i1', '第一段'), delta('i1', '第二段')].reduce((s, e) => reduce(s, e), state);
    expect(state.threads['th'].streamBuffer['i1']).toBe('第一段第二段');

    // completed 才清空
    state = reduce(state, {
      type: 'itemUpserted',
      threadId: 'th',
      turnId: 'tu',
      item: agentItem('i1', '第一段第二段'),
      completed: true,
    });
    expect(state.threads['th'].streamBuffer['i1']).toBeUndefined();
  });

  it('空增量不产生条目', () => {
    const state = reduce(initialState(), delta('i1', ''));
    expect(state.threads['th']?.streamBuffer['i1']).toBeUndefined();
  });

  it('流式增量不修改输入状态（纯函数）', () => {
    const before = initialState();
    const snapshot = JSON.stringify(before);
    reduce(before, delta('i1', 'x'));
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
