/**
 * 对话导航条数据层的测试。
 *
 * 这个功能的性能风险全在数据层（见 turnMinimap.ts 头部的三条约束），
 * 所以测试的重点也在那里：
 *
 * 1. **不依赖 items**——用一个 items 为空、但 turns/itemIds 齐备的状态，
 *    仍应产出正确的 tick。这直接证明它没有遍历全部条目。
 * 2. **节点数封顶**——5000 轮必须产出 ≤ MAX_TICKS 个 tick。
 * 3. **聚合不丢注意状态**——桶里有一条失败，整桶就该显红，
 *    否则用户从导航条完全看不出「这里出过问题」。
 */
import { describe, expect, it } from 'vitest';
import { MAX_TICKS, MIN_TICKS, buildTicks, turnPreview } from './turns';
import { initialState, newThreadState, reduce, reduceAll, type RootState } from '../stores/store';
import type { AppEvent, Item } from '../types/domain';

/** 造一个线程：`turns` 每条带 n 个 itemIds，但**不建 items**。 */
function stateWithTurns(counts: number[], statuses: ('inProgress' | 'completed' | 'failed')[] = []) {
  // 直接构造状态，**不经过 reduceAll**：后者要按事件逐条归约，
  // 5000 轮要跑 3.4 秒（实测），那是测试自身的开销，会掩盖被测函数的耗时。
  // 这里要测的是 buildTicks 的复杂度，输入状态怎么来与它无关。
  const turnOrder = counts.map((_, i) => `t${i}`);
  const turns: Record<string, { id: string; status: string; itemIds: string[] }> = {};
  counts.forEach((n, i) => {
    turns[`t${i}`] = {
      id: `t${i}`,
      status: statuses[i] ?? 'completed',
      itemIds: Array.from({ length: n }, (_, k) => `i${i}-${k}`),
    };
  });
  const base = initialState();
  // 用 newThreadState 而不是展开 base.threads['th']（后者不存在，会得到
  // undefined 的 items）。它也是 ThreadState 的唯一构造点。
  return {
    ...base,
    threads: {
      th: { ...newThreadState('th', '/w'), turnOrder, turns: turns as never },
    },
    threadOrder: ['th'],
    activeThreadId: 'th',
  } as unknown as RootState;
}

describe('buildTicks', () => {
  it('轮次过少时不显示（一两条本身就是一屏）', () => {
    expect(buildTicks(stateWithTurns([3]), 'th')).toEqual([]);
    expect(MIN_TICKS).toBe(2);
  });

  it('每个轮次一个 tick，长度随步骤数变化', () => {
    const s = stateWithTurns([1, 10, 5]);
    const ticks = buildTicks(s, 'th');
    expect(ticks).toHaveLength(3);
    // 步骤最多的那条最长；最少的贴着下限
    expect(ticks[1].len).toBeGreaterThan(ticks[2].len);
    expect(ticks[2].len).toBeGreaterThan(ticks[0].len);
    expect(ticks[0].count).toBe(1);
    expect(ticks[0].turnId).toBe('t0');
  });

  it('**不读 items**：items 全空也能正确构建（性能约束 1）', () => {
    const s = stateWithTurns([2, 8]);
    // 断言前置条件：确实没有 item 对象
    expect(Object.keys(s.threads['th'].items)).toHaveLength(0);
    const ticks = buildTicks(s, 'th');
    expect(ticks).toHaveLength(2);
    // 长度仍按 itemIds.length 反映出来 → 证明只在读计数
    expect(ticks[1].len).toBeGreaterThan(ticks[0].len);
  });

  it('未知线程返回空（不抛错）', () => {
    expect(buildTicks(initialState(), 'nope')).toEqual([]);
  });

  it('**节点数封顶**：5000 轮也只产出 ≤ MAX_TICKS 个 tick（性能约束 2）', () => {
    const counts = Array.from({ length: 5000 }, (_, i) => (i % 7) + 1);
    const s = stateWithTurns(counts);
    const ticks = buildTicks(s, 'th');
    expect(ticks.length).toBeLessThanOrEqual(MAX_TICKS);
    expect(ticks.length).toBeGreaterThan(0);
    // 覆盖全部轮次，不能漏掉尾部
    const covered = ticks.reduce((n, t) => n + t.count, 0);
    expect(covered).toBe(5000);
    // 顺序保持：首个 tick 指向第一轮
    expect(ticks[0].turnId).toBe('t0');
  });

  it('聚合时桶内取最需要注意的状态（失败优先于运行中）', () => {
    // 300 轮，第 150 轮失败——它在某个桶里，整桶该显红
    const counts = Array.from({ length: 300 }, () => 2);
    const statuses = Array.from({ length: 300 }, (_, i) =>
      i === 150 ? ('failed' as const) : ('completed' as const),
    );
    const s = stateWithTurns(counts, statuses);
    const ticks = buildTicks(s, 'th');
    expect(ticks.some((t) => t.attention === 'fail'), '失败必须出现在导航条上').toBe(true);
  });

  it('待审批优先于运行中（用户需要立刻看到哪一轮在等他）', () => {
    // 用真实事件序列构造：turnStarted 后状态是 inProgress，
    // 待决审批才能派生出 awaiting_approval。
    // （注意不能借 stateWithTurns——它会把状态改写成 completed，
    //  那样即使有审批也不会显示为等待中，测出来是假阴性。）
    let s = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th', turnId: 't0' },
      { type: 'turnStarted', threadId: 'th', turnId: 't1' },
    ]);
    // 给第二轮一个待决审批
    s = reduce(s, {
      type: 'approvalRequired',
      approval: {
        requestId: 'n:1',
        method: 'item/commandExecution/requestApproval',
        threadId: 'th',
        turnId: 't1',
        itemId: 'i1-0',
        startedAtMs: 1,
        summary: 'rm -rf /',
        cwd: null,
        reason: null,
        risk: { tier: 'high', signals: [] },
        decision: null,
        scope: null,
      },
    });
    const ticks = buildTicks(s, 'th');
    expect(ticks[1].attention).toBe('awaiting');
  });

  it('正常轮次的 attention 为 null（不给导航条加噪音）', () => {
    const ticks = buildTicks(stateWithTurns([2, 3]), 'th');
    expect(ticks.every((t) => t.attention === null)).toBe(true);
  });

  it('全部轮次步骤数为 0 时不除零（长度为下限）', () => {
    const ticks = buildTicks(stateWithTurns([0, 0, 0]), 'th');
    expect(ticks).toHaveLength(3);
    expect(ticks.every((t) => Number.isFinite(t.len) && t.len > 0)).toBe(true);
  });
});

describe('turnPreview（按需计算）', () => {
  const mkItem = (id: string, turnId: string, body: Item['body']): Item => ({
    id,
    turnId,
    createdAtMs: 1,
    body,
  });

  function withItems(events: AppEvent[]): RootState {
    return reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th', cwd: '/w' },
      ...events,
    ]);
  }

  it('标题取该轮第一条用户消息，正文取助手回复', () => {
    const s = withItems([
      { type: 'turnStarted', threadId: 'th', turnId: 't0' },
      {
        type: 'itemUpserted',
        threadId: 'th',
        turnId: 't0',
        completed: true,
        item: mkItem('a', 't0', { kind: 'userMessage', text: '  帮我看一下   这个报错 ' }),
      },
      {
        type: 'itemUpserted',
        threadId: 'th',
        turnId: 't0',
        completed: true,
        item: mkItem('b', 't0', { kind: 'agentMessage', text: '这是空指针，第 42 行需要判空' }),
      },
    ]);
    const p = turnPreview(s, 'th', 't0');
    expect(p!.title).toBe('帮我看一下 这个报错'); // 空白已折叠
    expect(p!.body).toBe('这是空指针，第 42 行需要判空');
  });

  it('超长文本被截断（卡片不能撑破布局）', () => {
    const s = withItems([
      { type: 'turnStarted', threadId: 'th', turnId: 't0' },
      {
        type: 'itemUpserted',
        threadId: 'th',
        turnId: 't0',
        completed: true,
        item: mkItem('a', 't0', { kind: 'userMessage', text: 'x'.repeat(500) }),
      },
    ]);
    const p = turnPreview(s, 'th', 't0');
    expect(p!.title.length).toBeLessThan(60);
    expect(p!.title.endsWith('…')).toBe(true);
  });

  it('没有助手回复时回退到命令摘要（卡片不留空）', () => {
    const s = withItems([
      { type: 'turnStarted', threadId: 'th', turnId: 't0' },
      {
        type: 'itemUpserted',
        threadId: 'th',
        turnId: 't0',
        completed: true,
        item: mkItem('a', 't0', { kind: 'userMessage', text: '跑一下测试' }),
      },
      {
        type: 'itemUpserted',
        threadId: 'th',
        turnId: 't0',
        completed: true,
        item: mkItem('b', 't0', {
          kind: 'commandExecution',
          command: 'npm test',
          cwd: null,
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: null,
          durationMs: 10,
        }),
      },
    ]);
    expect(turnPreview(s, 'th', 't0')!.body).toBe('npm test');
  });

  it('工具标签去重保序、最多 3 个', () => {
    const cmd = (id: string) =>
      mkItem(id, 't0', {
        kind: 'commandExecution',
        command: 'ls',
        cwd: null,
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: null,
        durationMs: 1,
      });
    const s = withItems([
      { type: 'turnStarted', threadId: 'th', turnId: 't0' },
      {
        type: 'itemUpserted',
        threadId: 'th',
        turnId: 't0',
        completed: true,
        item: mkItem('u', 't0', { kind: 'userMessage', text: '做三件事' }),
      },
      { type: 'itemUpserted', threadId: 'th', turnId: 't0', completed: true, item: cmd('c1') },
      { type: 'itemUpserted', threadId: 'th', turnId: 't0', completed: true, item: cmd('c2') },
      {
        type: 'itemUpserted',
        threadId: 'th',
        turnId: 't0',
        completed: true,
        item: mkItem('f', 't0', { kind: 'fileChange', status: 'completed', changes: [] }),
      },
      {
        type: 'itemUpserted',
        threadId: 'th',
        turnId: 't0',
        completed: true,
        item: mkItem('w', 't0', { kind: 'webSearch', query: 'x' }),
      },
    ]);
    const p = turnPreview(s, 'th', 't0');
    expect(p!.tools).toEqual(['bash', 'write', 'search']);
  });

  it('用户与助手消息不作为工具标签', () => {
    const s = withItems([
      { type: 'turnStarted', threadId: 'th', turnId: 't0' },
      {
        type: 'itemUpserted',
        threadId: 'th',
        turnId: 't0',
        completed: true,
        item: mkItem('u', 't0', { kind: 'userMessage', text: 'hi' }),
      },
      {
        type: 'itemUpserted',
        threadId: 'th',
        turnId: 't0',
        completed: true,
        item: mkItem('a', 't0', { kind: 'agentMessage', text: 'hello' }),
      },
    ]);
    expect(turnPreview(s, 'th', 't0')!.tools).toEqual([]);
  });

  it('不存在的轮次返回 null（不抛错）', () => {
    expect(turnPreview(initialState(), 'th', 't0')).toBeNull();
  });
});

describe('性能护栏（用大状态证明复杂度可控）', () => {
  it('5000 轮的 tick 构建远快于逐条归约（无 O(n²)）', () => {
    const counts = Array.from({ length: 5000 }, (_, i) => (i % 5) + 1);
    const s = stateWithTurns(counts);
    // 计时**只覆盖 buildTicks**。曾经把状态构造一起计进去，
    // 结果测出 3.4 秒——那是 reduceAll 的开销（实测 2.6ms vs 3380ms），
    // 与被测函数无关，纯属测错对象。
    const t0 = performance.now();
    const ticks = buildTicks(s, 'th');
    const ms = performance.now() - t0;
    // 实测约 3ms。阈值取 50ms：留足 CI 波动空间，同时能抓住 O(n²)——那会到秒级。
    expect(ms, `5000 轮耗时 ${ms.toFixed(1)}ms，疑似 O(n²)`).toBeLessThan(50);
    expect(ticks.length).toBeLessThanOrEqual(MAX_TICKS);
  });
});
