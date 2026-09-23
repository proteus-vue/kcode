/**
 * 工具聚合与子代理映射的纯函数测试。
 *
 * 这两块错了都**不会报错**：
 * - 分组分错 → 时间线看起来「少了东西」或顺序不对，极难察觉；
 * - 映射漏了取值 → 界面上直接显示英文原词（`spawnAgent`），看起来"也挺正常"。
 *
 * 所以逐个取值钉住。
 */
import { describe, expect, it } from 'vitest';
import type { AgentState, Item, ItemBody } from '../types/domain';
import { groupKindOf, groupSummary, groupTimeline } from './toolGrouping';
import { activityLabel, agentRollup, agentStatusLabel, callStatusLabel, shortId, statusTone, toolLabel } from './collabAgent';

let seq = 0;
const mk = (body: ItemBody): Item => ({
  id: `i${++seq}`,
  turnId: 't1',
  createdAtMs: 0,
  body,
});

const cmd = (status: 'inProgress' | 'completed' | 'failed' | 'declined', command = 'ls') =>
  mk({ kind: 'commandExecution', command, cwd: null, status, exitCode: null, aggregatedOutput: null, durationMs: null });

const search = (q = 'foo') => mk({ kind: 'webSearch', query: q });
const read = (p = '/w/a.png') => mk({ kind: 'imageView', path: p });
const tool = (t = 'x') => mk({ kind: 'toolCall', server: null, tool: t, argsSummary: null, resultSummary: null, status: 'completed', error: null, readOnly: null, durationMs: null });
const file = () => mk({
  kind: 'fileChange',
  status: 'completed',
  changes: [{ path: '/w/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }],
});
const agent = (toolName = 'spawnAgent') =>
  mk({ kind: 'collabAgent', source: 'collabAgentToolCall', tool: toolName, status: 'inProgress', receiverThreadIds: [], agents: [], prompt: null });

describe('可聚合性判定', () => {
  it('成功/进行中的命令可聚合，失败与被拒绝的必须单独显示', () => {
    expect(groupKindOf(cmd('completed'))).toBe('command');
    expect(groupKindOf(cmd('inProgress'))).toBe('command');
    // 失败与被拒绝是用户需要立刻注意的异常，收进「已执行 N 条」里等于藏起来
    expect(groupKindOf(cmd('failed'))).toBeNull();
    expect(groupKindOf(cmd('declined'))).toBeNull();
  });

  it('fileChange 一律不聚合（它是审阅对象）', () => {
    expect(groupKindOf(file())).toBeNull();
  });

  it('读取/搜索/工具调用/子代理各自成类', () => {
    expect(groupKindOf(read())).toBe('read');
    expect(groupKindOf(search())).toBe('search');
    expect(groupKindOf(tool())).toBe('tool');
    expect(groupKindOf(agent())).toBe('agent');
  });
});

describe('分组', () => {
  it('同类且连续 → 合成一组', () => {
    const units = groupTimeline([search('a'), search('b'), search('c')]);
    expect(units).toHaveLength(1);
    expect(units[0].type).toBe('group');
    if (units[0].type === 'group') {
      expect(units[0].members.map((m) => (m.item.body as { query: string }).query)).toEqual(['a', 'b', 'c']);
    }
  });

  it('中间夹了别的类型就断开（不跨类硬凑）', () => {
    const units = groupTimeline([search('a'), search('b'), read(), search('c')]);
    // search(2) / read(1→single) / search(1→single)
    expect(units.map((u) => u.type)).toEqual(['group', 'single', 'single']);
  });

  it('单条不成组（不为 1 条多渲染一层）', () => {
    const units = groupTimeline([search('only')]);
    expect(units).toHaveLength(1);
    expect(units[0].type).toBe('single');
  });

  it('不可聚合项会打断连续性', () => {
    const units = groupTimeline([cmd('completed'), cmd('failed'), cmd('completed')]);
    // 两个 completed 被 failed 隔开 → 各自单独显示
    expect(units.map((u) => u.type)).toEqual(['single', 'single', 'single']);
  });

  it('保持原顺序，不重排', () => {
    // 两次搜索被 imageView 隔开 → 都不成组（单条不成组），顺序即发生顺序
    const units = groupTimeline([search('1'), read('/w/x.png'), search('2')]);
    const kinds = units.map((u) =>
      u.type === 'single' ? u.item.body.kind : `group:${u.kind}`,
    );
    expect(kinds).toEqual(['webSearch', 'imageView', 'webSearch']);

    // 同类相邻时才成组——顺序仍然保持
    const grouped = groupTimeline([search('1'), search('2'), read('/w/x.png')]);
    expect(grouped.map((u) => u.type)).toEqual(['group', 'single']);
  });

  it('空输入返回空数组', () => {
    expect(groupTimeline([])).toEqual([]);
  });
});

describe('组摘要文案', () => {
  const group = (kind: 'search' | 'read' | 'command', n: number) => {
    const items = Array.from({ length: n }, (_, i) =>
      kind === 'search' ? search(`q${i}`) : kind === 'read' ? read(`/w/f${i}.png`) : cmd('completed', `cmd${i}`),
    );
    const units = groupTimeline(items);
    // n=1 时按设计不成组，调用方需自备 >=2 条；这里只服务成组断言
    if (units[0].type !== 'group') throw new Error('应成组（数量需 >= 2）');
    return units[0];
  };

  it('数量与单位正确', () => {
    expect(groupSummary(group('search', 2))).toContain('已搜索 2 次搜索');
    expect(groupSummary(group('read', 2))).toContain('已读取 2 个文件');
    expect(groupSummary(group('command', 3))).toContain('已执行 3 条命令');
  });

  it('单条搜索带上查询词（省一次展开）', () => {
    const items = [search('协议漂移'), search('协议漂移')];
    const units = groupTimeline(items);
    if (units[0].type === 'group') {
      expect(groupSummary(units[0])).toContain('协议漂移');
    }
  });

  it('多条搜索不列查询词（摘要过长就失去"扫一眼"的意义）', () => {
    const s = groupSummary(group('search', 3));
    expect(s).not.toContain('q0');
  });
});

describe('协议取值 → 中文文案', () => {
  it('协作工具名全部有文案，不泄漏英文', () => {
    const tools = ['spawnAgent', 'sendInput', 'resumeAgent', 'wait', 'closeAgent', 'sendMessage', 'followupTask', 'interruptAgent', 'listAgents'];
    for (const t of tools) {
      const label = toolLabel(t);
      expect(label, `${t} 应有中文文案`).not.toBe(t);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  it('未识别的工具名原样返回（不编一个中文名）', () => {
    expect(toolLabel('brandNewTool')).toBe('brandNewTool');
  });

  it('子代理状态全部有文案', () => {
    for (const s of ['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound']) {
      expect(agentStatusLabel(s), `${s} 应有中文文案`).not.toBe(s);
    }
  });

  it('协作调用状态与子代理状态是两套枚举，各自映射', () => {
    expect(callStatusLabel('inProgress')).toBe('进行中');
    expect(agentStatusLabel('running')).toBe('运行中');
    // 空状态不显示（调用方据此不渲染 chip）
    expect(callStatusLabel(null)).toBe('');
  });

  it('子代理活动类型全部有文案', () => {
    for (const k of ['started', 'interacted', 'interrupted', 'completed']) {
      expect(activityLabel(k), `${k} 应有中文文案`).not.toBe(k);
    }
  });
});

describe('状态视觉档位', () => {
  it('运行中/完成/异常各归其档', () => {
    expect(statusTone('running')).toBe('running');
    expect(statusTone('inProgress')).toBe('running');
    expect(statusTone('completed')).toBe('ok');
    expect(statusTone('errored')).toBe('danger');
    expect(statusTone('failed')).toBe('danger');
    expect(statusTone('interrupted')).toBe('warn');
    expect(statusTone(null)).toBe('idle');
  });
});

describe('摘要辅助', () => {
  it('线程 id 截短但保留可辨识的前缀', () => {
    const id = '01a0ccad-3788-7041-a0be-20eba3156850';
    expect(shortId(id)).toBe('01a0ccad');
    expect(shortId('short')).toBe('short');
    expect(shortId('  spaced  ')).toBe('spaced');
  });

  it('代理汇总把"在跑的"排在前面', () => {
    const agents: AgentState[] = [
      { threadId: 'a', status: 'completed', message: null },
      { threadId: 'b', status: 'running', message: null },
      { threadId: 'c', status: 'running', message: null },
    ];
    const s = agentRollup(agents);
    expect(s).toContain('3 个代理');
    // 运行中的计数必须排第一——用户最想知道"还有几个在跑"
    expect(s.indexOf('运行中')).toBeLessThan(s.indexOf('已完成'));
  });

  it('没有代理时不产出"0 个代理"这种噪音', () => {
    expect(agentRollup([])).toBe('');
  });
});
