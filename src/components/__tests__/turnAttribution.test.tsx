/**
 * 多轮对话渲染的归属测试。
 *
 * # 这个测试在防什么（实测过的错乱）
 *
 * 用户报告：连测几轮对话，每开始新一轮，**上面已完成的对话内容也跟着更新**，
 * 且旧轮次显示成「运行中」。
 *
 * 根因不在状态派生（reducer 的轮次状态是对的），而在 `TurnView` 渲染
 * 「尚未产生 Item 的流式内容」时的归属判断：它只排除**当前轮次**的
 * itemIds，于是新轮次的流式文本会出现在**每一个**历史轮次下面。
 *
 * 这类问题只能在「多轮 + 流式同时存在」的组合下暴露，单轮测试永远发现不了；
 * 而 jsdom 不做样式计算，纯 vdom 断言又看不到「谁渲染了谁」。
 * 因此这里挂载真实的 TurnView，直接断言 DOM 里各轮的流式内容归属。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TurnView } from '../TurnView';
import { initialState, reduceAll, type RootState } from '../../stores/store';
import type { AppEvent } from '../../types/domain';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

const delta = (turnId: string, itemId: string, text: string): AppEvent => ({
  type: 'textDelta',
  threadId: 'th',
  itemId,
  turnId,
  channel: 'agentMessage',
  delta: text,
});

/** 造一个「两轮：第一轮已完成，第二轮正在流式」的状态。 */
function twoTurns(): RootState {
  return reduceAll(initialState(), [
    { type: 'threadStarted', threadId: 'th', cwd: '/w' },
    // 第一轮：完整跑完
    { type: 'turnStarted', threadId: 'th', turnId: 't1' },
    {
      type: 'itemUpserted',
      threadId: 'th',
      turnId: 't1',
      completed: true,
      item: { id: 'a1', turnId: 't1', createdAtMs: 1, body: { kind: 'agentMessage', text: '第一轮的回复' } },
    },
    { type: 'turnCompleted', threadId: 'th', turnId: 't1', status: 'completed' },
    // 第二轮：只有流式增量，尚未归位成 Item
    { type: 'turnStarted', threadId: 'th', turnId: 't2' },
    delta('t2', 'b1', '第二轮正在生成的内容'),
  ]);
}

function renderTurn(state: RootState, turnId: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<TurnView state={state} threadId="th" turnId={turnId} />);
  });
  return host;
}

describe('多轮渲染：流式内容只属于它自己那一轮', () => {
  it('旧的已完成轮次不显示新轮次的流式内容（核心）', () => {
    const state = twoTurns();
    const el = renderTurn(state, 't1');
    const text = el.textContent ?? '';
    expect(text, 't1 应显示自己的回复').toContain('第一轮的回复');
    expect(
      text,
      't1 不该出现 t2 的流式内容 —— 这正是「已完成的对话跟着新对话一起变」',
    ).not.toContain('第二轮正在生成的内容');
  });

  it('新轮次显示自己的流式内容', () => {
    const state = twoTurns();
    const el = renderTurn(state, 't2');
    expect(el.textContent ?? '').toContain('第二轮正在生成的内容');
  });

  it('已完成轮次不显示「运行中」徽标', () => {
    const state = twoTurns();
    const el = renderTurn(state, 't1');
    expect(el.textContent ?? '').toContain('已完成');
    expect(el.textContent ?? '', 't1 不该显示运行中').not.toContain('运行中');
  });

  it('多个历史轮次并存时，每轮只显示自己的内容', () => {
    const state = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th', turnId: 't1' },
      {
        type: 'itemUpserted', threadId: 'th', turnId: 't1', completed: true,
        item: { id: 'a1', turnId: 't1', createdAtMs: 1, body: { kind: 'agentMessage', text: '第一个问题的回答' } },
      },
      { type: 'turnCompleted', threadId: 'th', turnId: 't1', status: 'completed' },
      { type: 'turnStarted', threadId: 'th', turnId: 't2' },
      {
        type: 'itemUpserted', threadId: 'th', turnId: 't2', completed: true,
        item: { id: 'a2', turnId: 't2', createdAtMs: 2, body: { kind: 'agentMessage', text: '第二个问题的回答' } },
      },
      { type: 'turnCompleted', threadId: 'th', turnId: 't2', status: 'completed' },
      { type: 'turnStarted', threadId: 'th', turnId: 't3' },
      delta('t3', 'c1', '第三个正在生成'),
    ]);

    const t1 = renderTurn(state, 't1').textContent ?? '';
    expect(t1).toContain('第一个问题的回答');
    expect(t1, 't1 混入了 t2').not.toContain('第二个问题的回答');
    expect(t1, 't1 混入了 t3 的流式内容').not.toContain('第三个正在生成');

    act(() => root!.unmount());
    host!.remove();
    root = null;
    host = null;

    const t2 = renderTurn(state, 't2').textContent ?? '';
    expect(t2).toContain('第二个问题的回答');
    expect(t2, 't2 混入了 t3 的流式内容').not.toContain('第三个正在生成');
  });
});
