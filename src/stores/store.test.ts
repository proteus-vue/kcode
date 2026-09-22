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
  changedFileCount,
  contextUsage,
  decisionForScope,
  decisionLabel,
  describeSignal,
  guardianSummary,
  initialState,
  interruptsTurn,
  isApproving,
  isBlockingRisk,
  isDeclined,
  rebuildThread,
  reduce,
  reduceAll,
  shortModelName,
  sortedThreadIds,
  threadItems,
  threadTitle,
  turnDisplayStatus,
} from './store';
import type { AppEvent, Approval, ChangeSet, Item, ThreadTokenUsage } from '../types/domain';

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

describe('线程行徽标（IA-04）', () => {
  const mkChangeSet = (
    threadId: string,
    turnId: string,
    paths: string[],
  ): ChangeSet => ({
    threadId,
    turnId,
    origin: 'proposed',
    reviewState: 'proposed',
    decisions: paths.map(() => 'pending'),
    files: paths.map((path) => ({ path, kind: { type: 'update' }, diff: '' })),
  });

  it('变更文件数跨轮次去重', () => {
    const state = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th1', cwd: '/w' },
      {
        type: 'changeSetReplaced',
        threadId: 'th1',
        turnId: 'tu1',
        changeSet: mkChangeSet('th1', 'tu1', ['a.ts', 'b.ts']),
      },
      // 第二轮又改了 a.ts —— 去重后应是 3 个不同文件
      {
        type: 'changeSetReplaced',
        threadId: 'th1',
        turnId: 'tu2',
        changeSet: mkChangeSet('th1', 'tu2', ['a.ts', 'c.ts']),
      },
    ]);
    expect(changedFileCount(state, 'th1')).toBe(3);
    expect(changedFileCount(state, '不存在')).toBe(0);
  });

  it('模型短名去掉 provider 前缀并截断', () => {
    expect(shortModelName('anthropic/claude-sonnet-4')).toBe('claude-sonnet-4');
    expect(shortModelName('deepseek-flash')).toBe('deepseek-flash');
    expect(shortModelName(null)).toBeNull();
    expect(shortModelName('  ')).toBeNull();
    expect(shortModelName('provider/' + 'x'.repeat(40))).toBe('x'.repeat(20) + '…');
  });

  it('threadMeta 记住服务端名字与模型，且不覆盖已有值', () => {
    let state = reduce(initialState(), { type: 'threadStarted', threadId: 'th1', cwd: '/w' });
    state = reduce(state, { type: 'threadMeta', threadId: 'th1', name: '修黑屏', model: 'gpt-x' });
    expect(state.threads['th1'].name).toBe('修黑屏');
    expect(state.threads['th1'].model).toBe('gpt-x');

    // 后续只带 model 的事件不得清掉已有的 name
    state = reduce(state, { type: 'threadMeta', threadId: 'th1', model: 'gpt-y' });
    expect(state.threads['th1'].name).toBe('修黑屏');
    expect(state.threads['th1'].model).toBe('gpt-y');
  });

  it('用户命名优先于首条消息派生的标题', () => {
    let state = reduce(initialState(), { type: 'threadStarted', threadId: 'th1', cwd: '/w' });
    state = reduceAll(state, [
      {
        type: 'itemUpserted',
        threadId: 'th1',
        turnId: 'tu1',
        completed: true,
        item: {
          id: 'i1',
          turnId: 'tu1',
          createdAtMs: 1,
          body: { kind: 'userMessage', text: '这是一条很长的首条消息，用来验证标题派生逻辑' },
        },
      },
      { type: 'threadMeta', threadId: 'th1', name: '我的任务' },
    ]);
    expect(threadTitle(state, 'th1')).toBe('我的任务');
  });
});

describe('AP-07 作用域 → 决策映射', () => {
  it('session 映射到 acceptForSession，其余回落到最窄授权', () => {
    expect(decisionForScope('session')).toBe('acceptForSession');
    expect(decisionForScope('once')).toBe('accept');
  });

  it('协议未支持的粒度不得放大授权', () => {
    // turn / project 是领域预留值：协议没有对应决策，
    // 必须回落到 accept（多问一次），而不是放行整个会话。
    expect(decisionForScope('turn')).toBe('accept');
    expect(decisionForScope('project')).toBe('accept');
  });
});

describe('护栏信号（05 章硬约束 / CH-08）', () => {
  const usage = (over: Partial<ThreadTokenUsage> = {}): ThreadTokenUsage => ({
    last: {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 20,
      reasoningOutputTokens: 0,
      totalTokens: 120,
    },
    total: {
      inputTokens: 900,
      cachedInputTokens: 0,
      outputTokens: 300,
      reasoningOutputTokens: 0,
      totalTokens: 1200,
    },
    modelContextWindow: 1000,
    ...over,
  });

  it('上下文余量按最近一轮算，而不是累计值', () => {
    // total=1200 已超过 window=1000。若误用 total，比例会是 1.2（>100%）。
    const u = contextUsage(usage());
    expect(u).not.toBeNull();
    expect(u!.used).toBe(120);
    expect(u!.ratio).toBeCloseTo(0.12);
    expect(u!.remaining).toBe(880);
    expect(u!.level).toBe('ok');
  });

  it('窗口未知或无效时返回 null，不猜一个默认值', () => {
    expect(contextUsage(null)).toBeNull();
    expect(contextUsage(usage({ modelContextWindow: null }))).toBeNull();
    // 0 会让比例变成 Infinity，界面显示「已用 ∞%」
    expect(contextUsage(usage({ modelContextWindow: 0 }))).toBeNull();
    expect(contextUsage(usage({ modelContextWindow: -5 }))).toBeNull();
  });

  it('档位阈值与上游压缩线对齐（70% / 90%）', () => {
    const at = (used: number, window = 1000) =>
      contextUsage(
        usage({
          modelContextWindow: window,
          last: {
            inputTokens: used,
            cachedInputTokens: 0,
            outputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: used,
          },
        }))!.level;
    expect(at(699)).toBe('ok');
    expect(at(700)).toBe('near'); // 上游压缩线
    expect(at(899)).toBe('near');
    expect(at(900)).toBe('critical');
    expect(at(1000)).toBe('critical');
  });

  it('护栏警告累积而非覆盖，摘要取最后一条并标注次数', () => {
    let state = reduce(initialState(), { type: 'threadStarted', threadId: 'th', cwd: '/w' });
    state = reduce(state, { type: 'guardianWarning', threadId: 'th', message: '检测到重复调用' });
    state = reduce(state, { type: 'guardianWarning', threadId: 'th', message: '仍然重复' });
    const warnings = state.threads['th'].guardianWarnings;
    expect(warnings).toHaveLength(2);
    expect(warnings[1].message).toBe('仍然重复');
    expect(guardianSummary(warnings)).toBe('仍然重复（共 2 次）');
  });

  it('无警告时摘要为 null（不渲染空横幅）', () => {
    expect(guardianSummary([])).toBeNull();
  });

  it('空白警告不产生摘要（避免渲染出空框）', () => {
    expect(guardianSummary([{ message: '   ' }])).toBeNull();
  });

  it('归约不引入非确定性——警告事件重放结果相同', () => {
    // 归约是纯函数（重放要得到同一状态），因此不能在内部调 Date.now()。
    // 这条用同一输入跑两次并比较结果来钉住它。
    const events: AppEvent[] = [
      { type: 'threadStarted', threadId: 'th', cwd: '/w' },
      { type: 'guardianWarning', threadId: 'th', message: '重复调用' },
    ];
    expect(JSON.stringify(reduceAll(initialState(), events))).toBe(
      JSON.stringify(reduceAll(initialState(), events)),
    );
  });

  it('护栏警告独立于 errors 存放——不被杂项错误淹没', () => {
    let state = reduce(initialState(), { type: 'threadStarted', threadId: 'th', cwd: '/w' });
    state = reduce(state, { type: 'error', message: '模型列表加载失败' });
    state = reduce(state, { type: 'guardianWarning', threadId: 'th', message: '检测到异常' });
    expect(state.errors).toHaveLength(1);
    expect(state.threads['th'].guardianWarnings).toHaveLength(1);
  });

  it('tokenUsage 事件写入对应线程，不串到别的线程', () => {
    let state = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'a', cwd: '/a' },
      { type: 'threadStarted', threadId: 'b', cwd: '/b' },
    ]);
    state = reduce(state, { type: 'tokenUsageUpdated', threadId: 'a', turnId: 't', usage: usage() });
    expect(state.threads['a'].tokenUsage).not.toBeNull();
    expect(state.threads['b'].tokenUsage).toBeNull();
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
        'guardianWarnings',
        'id',
        'info',
        'items',
        'model',
        'name',
        'pendingApprovals',
        'streamBuffer',
        'streamTurn',
        'tokenUsage',
        'turnDiffFiles',
        'turnDiffs',
        'turnOrder',
        'turns',
      ].sort(),
    );
  });
});

describe('推理增量不进流式缓冲', () => {
  /**
   * 删掉推理展示后，最容易出的问题是：`streamBuffer` 不区分通道，
   * 推理增量会经「尚未产生 Item 的流式内容」那条渲染路径被当成正文显示
   * ——用户看到一段没有出处、也不属于任何消息的文字，比不展示更糟。
   */
  const delta = (channel: 'agentMessage' | 'reasoning' | 'reasoningSummary' | 'plan') => ({
    type: 'textDelta' as const,
    threadId: 'th',
    itemId: 'i1',
    turnId: 'tu1',
    channel,
    delta: 'x',
  });

  it('推理两个通道都被过滤掉', () => {
    let s = reduce(initialState(), { type: 'threadStarted', threadId: 'th', cwd: '/w' });
    s = reduce(s, delta('reasoning'));
    s = reduce(s, delta('reasoningSummary'));
    expect(s.threads['th'].streamBuffer).toEqual({});
  });

  it('正文与计划通道照常入缓冲（过滤不能误伤）', () => {
    let s = reduce(initialState(), { type: 'threadStarted', threadId: 'th', cwd: '/w' });
    s = reduce(s, delta('agentMessage'));
    s = reduce(s, delta('plan'));
    expect(s.threads['th'].streamBuffer['i1']).toBe('xx');
  });

  it('混合到达时只留下正文增量', () => {
    let s = reduce(initialState(), { type: 'threadStarted', threadId: 'th', cwd: '/w' });
    s = reduce(s, delta('reasoning'));
    s = reduce(s, delta('agentMessage'));
    s = reduce(s, delta('reasoningSummary'));
    s = reduce(s, { ...delta('agentMessage'), delta: 'y' });
    expect(s.threads['th'].streamBuffer['i1']).toBe('xy');
  });
});

describe('rebuildThread：长会话重建不得是 O(n²)', () => {
  /**
   * 从事件日志打开长会话的路径。
   *
   * 旧实现对每条 item / turn 各调一次 `reduce`，而每次 reduce 内部都有
   * `includes` 扫描 → O(n²)。实测 1000 条 104ms、3000 条 1066ms、
   * 6000 条 4703ms，用户感受就是「打开会话卡住」。
   * 改为一次扫描后 6000 条约 1.3ms。
   */
  const mk = (n: number): Item[] =>
    Array.from({ length: n }, (_, i) => ({
      id: `i${i}`,
      turnId: `t${i % 50}`,
      createdAtMs: i,
      body: { kind: 'agentMessage' as const, text: 'x' },
    }));

  it('6000 条在一次同步调用内完成（阈值抓 O(n²)，不是性能基准）', () => {
    const items = mk(6000);
    const turns = Array.from({ length: 50 }, (_, i) => ({
      turnId: `t${i}`,
      status: 'completed' as const,
    }));
    const t0 = performance.now();
    const s = rebuildThread(initialState(), 'th', '/w', items, turns, []);
    const ms = performance.now() - t0;
    // 实测 ~1.3ms。阈值 100ms：留足 CI 波动，同时能抓住 O(n²)（那会到秒级）。
    expect(ms, `6000 条耗时 ${ms.toFixed(0)}ms，疑似退回 O(n²)`).toBeLessThan(100);
    expect(Object.keys(s.threads['th'].items)).toHaveLength(6000);
  });

  it('重建结果与逐条 reduce 等价（语义不能变）', () => {
    const items = mk(30);
    const turns = Array.from({ length: 5 }, (_, i) => ({
      turnId: `t${i}`,
      status: 'completed' as const,
    }));
    let inc = reduce(initialState(), { type: 'threadStarted', threadId: 'th', cwd: '/w' });
    for (const it of items) {
      inc = reduce(inc, { type: 'itemUpserted', threadId: 'th', turnId: it.turnId, item: it, completed: true });
    }
    for (const t of turns) {
      inc = reduce(inc, { type: 'turnCompleted', threadId: 'th', turnId: t.turnId, status: t.status });
    }
    const batch = rebuildThread(initialState(), 'th', '/w', items, turns, []);

    expect(Object.keys(batch.threads['th'].items).sort()).toEqual(
      Object.keys(inc.threads['th'].items).sort(),
    );
    expect(batch.threads['th'].turnOrder).toEqual(inc.threads['th'].turnOrder);
    for (const t of turns) {
      expect(batch.threads['th'].turns[t.turnId].itemIds).toEqual(
        inc.threads['th'].turns[t.turnId].itemIds,
      );
    }
  });

  it('只有 item、没有 turn 条目时也登记轮次（时间线不能漏内容）', () => {
    const items: Item[] = [
      { id: 'x', turnId: 'orphan', createdAtMs: 1, body: { kind: 'agentMessage', text: 'y' } },
    ];
    const s = rebuildThread(initialState(), 'th', '/w', items, [], []);
    expect(s.threads['th'].turnOrder).toContain('orphan');
    expect(s.threads['th'].turns['orphan'].itemIds).toEqual(['x']);
  });

  it('空快照不破坏既有状态（幂等）', () => {
    const items = mk(3);
    const first = rebuildThread(initialState(), 'th', '/w', items, [{ turnId: 't0', status: 'completed' }], []);
    const again = rebuildThread(first, 'th', '/w', [], [], []);
    expect(Object.keys(again.threads['th'].items)).toHaveLength(3);
  });
});

describe('流式内容的轮次归属（历史轮次不得被新轮次污染）', () => {
  /**
   * 实测过的错乱：新对话一开始，**上面已完成的对话内容也跟着变**，
   * 且旧轮次显示成「运行中」。
   *
   * 根因：`TurnView` 渲染「尚未产生 Item 的流式内容」时只排除当前轮次的
   * itemIds——于是新轮次的流式文本会出现在**每一个**历史轮次下面。
   * 修法是精确记录归属（`streamTurn`：itemId → turnId），协议增量里本就带 turnId。
   */
  const delta = (turnId: string, itemId: string, text: string) => ({
    type: 'textDelta' as const,
    threadId: 'th',
    itemId,
    turnId,
    channel: 'agentMessage' as const,
    delta: text,
  });

  it('记录每个流式 item 归属的轮次', () => {
    let s = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th', turnId: 't1' },
      delta('t1', 'i1', '第一轮的内容'),
      { type: 'turnCompleted', threadId: 'th', turnId: 't1', status: 'completed' },
      { type: 'turnStarted', threadId: 'th', turnId: 't2' },
      delta('t2', 'i2', '第二轮的内容'),
    ]);
    const th = s.threads['th'];
    expect(th.streamTurn['i1']).toBe('t1');
    expect(th.streamTurn['i2']).toBe('t2');
  });

  it('**历史轮次拿不到新轮次的流式内容**（核心断言）', () => {
    let s = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th', turnId: 't1' },
      delta('t1', 'i1', '旧的'),
      { type: 'turnCompleted', threadId: 'th', turnId: 't1', status: 'completed' },
      { type: 'turnStarted', threadId: 'th', turnId: 't2' },
      delta('t2', 'i2', '新的'),
    ]);
    const th = s.threads['th'];
    // 模拟 TurnView 的归属过滤：t1 那一轮不该看到 i2
    const placedT1 = new Set(th.turns['t1'].itemIds);
    const t1Streaming = Object.keys(th.streamBuffer).filter(
      (id) => !placedT1.has(id) && th.streamTurn[id] === 't1',
    );
    expect(t1Streaming, 't1 轮不该持有 i2 的流式内容').not.toContain('i2');

    // 而 t2 应当拿到它
    const placedT2 = new Set(th.turns['t2'].itemIds);
    const t2Streaming = Object.keys(th.streamBuffer).filter(
      (id) => !placedT2.has(id) && th.streamTurn[id] === 't2',
    );
    expect(t2Streaming).toEqual(['i2']);
  });

  it('item 归位后清掉归属（不留过期映射）', () => {
    let s = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th', turnId: 't1' },
      delta('t1', 'i1', '流式中'),
    ]);
    expect(s.threads['th'].streamTurn['i1']).toBe('t1');
    s = reduce(s, {
      type: 'itemUpserted',
      threadId: 'th',
      turnId: 't1',
      completed: true,
      item: { id: 'i1', turnId: 't1', createdAtMs: 1, body: { kind: 'agentMessage', text: '完成' } },
    });
    expect(s.threads['th'].streamTurn['i1'], '归位后应清除归属').toBeUndefined();
  });
});
