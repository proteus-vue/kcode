/**
 * 领域状态归约的测试。
 *
 * 重点覆盖三条来自**实测**的行为要求：
 *
 * 1. `declined` 必须与 `completed` 可区分（否则用户拒绝后看到「已完成」）
 * 2. `cancel` 与 `decline` 文案与语义不同（否则用户无法预知 Turn 会不会被终止）
 * 3. `awaiting_approval` 是派生状态，不是协议状态
 */

import { describe, expect, it } from 'vitest';
import {
  decisionLabel,
  describeSignal,
  initialState,
  interruptsTurn,
  isApproving,
  isBlockingRisk,
  isDeclined,
  reduce,
  reduceAll,
  sortedThreadIds,
  threadItems,
  turnDisplayStatus,
} from './store';
import type { AppEvent, Approval, Item } from '../types/domain';

function makeApproval(over: Partial<Approval> = {}): Approval {
  return {
    requestId: 'n:0',
    method: 'item/commandExecution/requestApproval',
    threadId: 'th1',
    turnId: 'tu1',
    itemId: 'i1',
    startedAtMs: 1000,
    summary: 'cat .env',
    cwd: '/work/repo',
    reason: '读取配置',
    risk: { tier: 'high', signals: [{ credentialAccess: { target: '.env' } }] },
    decision: null,
    scope: null,
    ...over,
  };
}

function commandItem(status: Item['body'] extends { status: infer S } ? S : never, id = 'i1'): Item {
  return {
    id,
    turnId: 'tu1',
    createdAtMs: 1,
    body: {
      kind: 'commandExecution',
      command: 'echo hi',
      cwd: '/work/repo',
      status,
      exitCode: status === 'completed' ? 0 : null,
      aggregatedOutput: null,
      durationMs: null,
    },
  };
}

describe('item 状态归约', () => {
  it('declined 与 completed 必须可区分', () => {
    const declined = commandItem('declined' as never);
    const completed = commandItem('completed' as never);
    expect(isDeclined(declined)).toBe(true);
    expect(isDeclined(completed)).toBe(false);
  });

  it('item/completed 事件覆盖同 id 的先前状态（upsert）', () => {
    const events: AppEvent[] = [
      {
        type: 'itemUpserted',
        threadId: 'th1',
        turnId: 'tu1',
        item: { ...commandItem('inProgress' as never), body: { kind: 'commandExecution', command: 'echo hi', cwd: null, status: 'inProgress', exitCode: null, aggregatedOutput: null, durationMs: null } },
        completed: false,
      },
      { type: 'itemUpserted', threadId: 'th1', turnId: 'tu1', item: commandItem('completed' as never), completed: true },
    ];
    const state = reduceAll(initialState(), events);
    const items = threadItems(state, 'th1');
    expect(items).toHaveLength(1);
    expect(items[0].body.kind).toBe('commandExecution');
    if (items[0].body.kind === 'commandExecution') {
      expect(items[0].body.status).toBe('completed');
      expect(items[0].body.exitCode).toBe(0);
    }
  });

  it('拒绝后的 item 状态为 declined 且无退出码', () => {
    const state = reduce(
      initialState(),
      { type: 'itemUpserted', threadId: 'th1', turnId: 'tu1', item: commandItem('declined' as never), completed: true },
    );
    const item = threadItems(state, 'th1')[0];
    expect(isDeclined(item)).toBe(true);
    if (item.body.kind === 'commandExecution') {
      expect(item.body.exitCode).toBeNull();
    }
  });
});

describe('审批决策语义', () => {
  it('decline 与 cancel 的文案必须不同', () => {
    expect(decisionLabel('decline')).toBe('拒绝');
    expect(decisionLabel('cancel')).toBe('拒绝并停止');
    expect(decisionLabel('decline')).not.toBe(decisionLabel('cancel'));
  });

  it('只有 cancel 会中断 Turn', () => {
    expect(interruptsTurn('cancel')).toBe(true);
    expect(interruptsTurn('decline')).toBe(false);
    expect(interruptsTurn('accept')).toBe(false);
  });

  it('decline 与 cancel 都不算批准', () => {
    expect(isApproving('decline')).toBe(false);
    expect(isApproving('cancel')).toBe(false);
    expect(isApproving('accept')).toBe(true);
    expect(isApproving('acceptForSession')).toBe(true);
  });

  it('高风险及以上需阻塞确认', () => {
    expect(isBlockingRisk('low')).toBe(false);
    expect(isBlockingRisk('moderate')).toBe(false);
    expect(isBlockingRisk('high')).toBe(true);
    expect(isBlockingRisk('critical')).toBe(true);
  });

  it('风险信号可渲染为可读文案', () => {
    expect(describeSignal({ credentialAccess: { target: '.env' } })).toContain('.env');
    expect(describeSignal({ privilegeEscalation: { program: 'sudo' } })).toContain('sudo');
    expect(describeSignal({ destructiveDelete: {} })).toContain('删除');
  });
});

describe('轮次展示状态派生', () => {
  it('进行中且无待决审批 → running', () => {
    let state = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th1', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th1', turnId: 'tu1' },
    ]);
    expect(turnDisplayStatus(state, 'th1', 'tu1')).toBe('running');

    state = reduce(state, { type: 'approvalRequired', approval: makeApproval() });
    expect(turnDisplayStatus(state, 'th1', 'tu1')).toBe('awaiting_approval');
  });

  it('审批被解决后回到 running', () => {
    const state = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th1', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th1', turnId: 'tu1' },
      { type: 'approvalRequired', approval: makeApproval() },
      { type: 'approvalResolved', requestId: 'n:0', threadId: 'th1' },
    ]);
    expect(turnDisplayStatus(state, 'th1', 'tu1')).toBe('running');
  });

  it('协议终态直接映射', () => {
    const state = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th1', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th1', turnId: 'tu1' },
      { type: 'turnCompleted', threadId: 'th1', turnId: 'tu1', status: 'completed' },
    ]);
    expect(turnDisplayStatus(state, 'th1', 'tu1')).toBe('completed');
  });

  it('子进程退出后活动轮次显示 unknown 而非成功', () => {
    const state = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th1', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th1', turnId: 'tu1' },
      { type: 'processExited', code: 1 },
    ]);
    // 关键：绝不显示为 completed
    expect(turnDisplayStatus(state, 'th1', 'tu1')).not.toBe('completed');
    expect(state.processExited).toBe(true);
    expect(state.ready).toBe(false);
  });
});

describe('侧栏排序', () => {
  it('待审批的线程排在最前，即使另一个更新', () => {
    let state = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'a', cwd: '/a' },
      { type: 'turnStarted', threadId: 'a', turnId: 'a-t' },
      { type: 'threadStarted', threadId: 'b', cwd: '/b' },
      { type: 'turnStarted', threadId: 'b', turnId: 'b-t' },
      { type: 'turnCompleted', threadId: 'b', turnId: 'b-t', status: 'completed' },
    ]);
    // 此时 a 在运行、b 已完成 → a 靠前
    expect(sortedThreadIds(state)[0]).toBe('a');

    // 给 b 一个待决审批 → b 必须跃到最前
    state = reduce(state, {
      type: 'approvalRequired',
      approval: makeApproval({ threadId: 'b', turnId: 'b-t' }),
    });
    expect(sortedThreadIds(state)[0]).toBe('b');
  });

  it('失败优先于已完成', () => {
    const state = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'ok', cwd: '/ok' },
      { type: 'turnStarted', threadId: 'ok', turnId: 'ok-t' },
      { type: 'turnCompleted', threadId: 'ok', turnId: 'ok-t', status: 'completed' },
      { type: 'threadStarted', threadId: 'bad', cwd: '/bad' },
      { type: 'turnStarted', threadId: 'bad', turnId: 'bad-t' },
      { type: 'turnCompleted', threadId: 'bad', turnId: 'bad-t', status: 'failed' },
    ]);
    expect(sortedThreadIds(state)[0]).toBe('bad');
  });
});

describe('错误与输出增量', () => {
  it('错误被记录而不是吞掉', () => {
    const state = reduce(initialState(), { type: 'error', message: '连接中断' });
    expect(state.errors).toContain('连接中断');
  });

  it('输出增量追加到命令卡片', () => {
    const state = reduceAll(initialState(), [
      { type: 'itemUpserted', threadId: 'th1', turnId: 'tu1', item: commandItem('inProgress' as never), completed: false },
      { type: 'outputDelta', threadId: 'th1', itemId: 'i1', delta: 'line1\n' },
      { type: 'outputDelta', threadId: 'th1', itemId: 'i1', delta: 'line2\n' },
    ]);
    const item = threadItems(state, 'th1')[0];
    if (item.body.kind === 'commandExecution') {
      expect(item.body.aggregatedOutput).toBe('line1\nline2\n');
    }
  });

  it('归约是纯函数：不修改输入状态', () => {
    const before = initialState();
    const snapshot = JSON.stringify(before);
    reduce(before, { type: 'threadStarted', threadId: 'th1', cwd: '/w' });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('ThreadState 构造完整性', () => {
  /**
   * 守住「新增字段忘记在构造点初始化」这类缺陷。
   *
   * 这个错误在本项目出现过三次（changeSets/turnDiffs、streamBuffer、
   * turnDiffFiles），每次都靠运行时读到 undefined 才暴露——
   * TypeScript 不会捕获，因为构造点是通过返回值类型推断绕过的。
   *
   * 做法：用 reduce 造出线程后，断言**所有字段都存在且类型正确**。
   * 新增字段时若忘记加到构造点，这里会立刻失败。
   */
  it('归约产出的线程对象字段完整', () => {
    const state = reduce(initialState(), { type: 'threadStarted', threadId: 'th', cwd: '/w' });
    const th = state.threads['th'];
    expect(th).toBeDefined();

    // 记录类字段必须是对象（漏初始化时是 undefined）
    for (const key of [
      'turns',
      'items',
      'pendingApprovals',
      'changeSets',
      'turnDiffs',
      'turnDiffFiles',
      'streamBuffer',
    ] as const) {
      expect(th[key], `ThreadState.${key} 未在构造点初始化`).toBeDefined();
      expect(typeof th[key]).toBe('object');
    }
    // 数组类字段
    expect(Array.isArray(th.turnOrder)).toBe(true);
    // 可空字段允许 null，但不能是 undefined
    expect(th.info).toBeNull();
  });

  it('字段集合与接口声明一致（防止新增字段漏改构造点）', () => {
    const state = reduce(initialState(), { type: 'threadStarted', threadId: 'th', cwd: '/w' });
    const th = state.threads['th'];
    // 这些是 ThreadState 的全部键；新增时必须同步更新此处
    expect(Object.keys(th).sort()).toEqual(
      [
        'changeSets',
        'cwd',
        'id',
        'info',
        'items',
        'pendingApprovals',
        'streamBuffer',
        'turnDiffFiles',
        'turnDiffs',
        'turnOrder',
        'turns',
      ].sort(),
    );
  });
});
