/**
 * 子代理汇总的纯函数测试。
 *
 * 关键在**状态归并的时序**：同一个代理会在多条 item 里出现（spawn 一次、
 * 之后 wait / send_input 各一次，每次的 `agentsStates` 都可能更新它），
 * 归并时若让先出现的状态赢，界面会显示一个**已经完成的代理还在「运行中」**——
 * 这类错误不会报错，只会让人误判「任务还没结束」。
 */
import { describe, expect, it } from 'vitest';
import { collectSubagents } from './SubagentPanel';
import type { Item, ItemBody } from '../types/domain';

let seq = 0;
const mk = (body: ItemBody, turnId = 't1'): Item => ({
  id: `i${++seq}`,
  turnId,
  createdAtMs: 0,
  body,
});

const spawn = (over: Partial<Extract<ItemBody, { kind: 'collabAgent' }>> = {}): ItemBody => ({
  kind: 'collabAgent',
  source: 'collabAgentToolCall',
  tool: 'spawnAgent',
  status: 'inProgress',
  receiverThreadIds: ['th-sub-1'],
  agents: [{ threadId: 'th-sub-1', status: 'running', message: null }],
  prompt: '调研协议',
  activityKind: null,
  agentThreadId: null,
  agentPath: null,
  ...over,
});

describe('collectSubagents', () => {
  it('从 spawnAgent 收集代理、任务与状态', () => {
    const out = collectSubagents([mk(spawn())]);
    expect(out).toHaveLength(1);
    expect(out[0].threadId).toBe('th-sub-1');
    expect(out[0].status).toBe('running');
    expect(out[0].task).toBe('调研协议');
    expect(out[0].spawnedAtTurnId).toBe('t1');
  });

  it('后续 item 的状态覆盖先前的（完成的代理不该还显示运行中）', () => {
    const out = collectSubagents([
      mk(spawn()),
      // 之后一次 wait 调用带回最新状态：已完成
      mk(
        spawn({
          tool: 'wait',
          status: 'completed',
          agents: [{ threadId: 'th-sub-1', status: 'completed', message: '已找到 3 处' }],
        }),
      ),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].status, '后出现的状态必须赢').toBe('completed');
    expect(out[0].message).toBe('已找到 3 处');
    // 任务来自 spawn 那次，不该被后续调用覆盖
    expect(out[0].task).toBe('调研协议');
  });

  it('多个代理各自成条', () => {
    const out = collectSubagents([
      mk(
        spawn({
          receiverThreadIds: ['a', 'b'],
          agents: [
            { threadId: 'a', status: 'running', message: null },
            { threadId: 'b', status: 'completed', message: null },
          ],
        }),
      ),
    ]);
    expect(out.map((e) => e.threadId)).toEqual(['a', 'b']);
    expect(out.map((e) => e.status)).toEqual(['running', 'completed']);
  });

  it('只有 receiverThreadIds、还没有状态表时，按 running 占位', () => {
    const out = collectSubagents([
      mk(spawn({ agents: [], receiverThreadIds: ['x'] })),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('running');
  });

  it('subAgentActivity 用 kind 兜底映射到同一套状态取值', () => {
    const out = collectSubagents([
      mk({
        kind: 'collabAgent',
        source: 'subAgentActivity',
        receiverThreadIds: [],
        agents: [],
        activityKind: 'completed',
        agentThreadId: 'th-sub-9',
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].threadId).toBe('th-sub-9');
    expect(out[0].status, 'completed 应映射到与 agentsStates 同一套取值').toBe('completed');
  });

  it('已有 agentsStates 信息时不被 subAgentActivity 覆盖', () => {
    const out = collectSubagents([
      mk(spawn()), // th-sub-1 running，来自权威状态表
      mk({
        kind: 'collabAgent',
        source: 'subAgentActivity',
        receiverThreadIds: [],
        agents: [],
        activityKind: 'completed',
        agentThreadId: 'th-sub-1',
      }),
    ]);
    expect(out[0].status, '活动事件是弱信号，不该盖过状态表').toBe('running');
  });

  it('非协作 item 被忽略，不产出假代理', () => {
    const out = collectSubagents([
      mk({ kind: 'agentMessage', text: 'hi' }),
      mk({
        kind: 'commandExecution',
        command: 'ls',
        cwd: null,
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: null,
        durationMs: null,
      }),
    ]);
    expect(out).toEqual([]);
  });

  it('空输入返回空数组', () => {
    expect(collectSubagents([])).toEqual([]);
  });
});
