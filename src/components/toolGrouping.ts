/**
 * 连续工具调用的聚合折叠。
 *
 * # 为什么需要
 *
 * 一轮任务里 Agent 常连着做十几个小动作（读 3 个文件、搜 5 次、跑 2 条命令）。
 * 一个动作一行的话，时间线会被这些**同类且低信息量**的行撑满——用户要
 * 往下翻很久才能看到模型的结论。参照客户端的做法是把连续同类动作收成一行：
 *
 * ```
 * 已读取 1 个文件 · 已搜索 2 次        ⌄
 * ```
 *
 * # 聚合规则（只有这几条，刻意保守）
 *
 * 1. **只聚合"同类且连续"的项**：中间夹了别的类型（或一条助手消息）就断开，
 *    重新起一段。把跨轮、跨越模型回复的动作硬凑成一组会让用户无法判断
 *    "这几步是在回答哪个问题"。
 * 2. **单条不聚合**：1 条命令就显示 1 行——为了聚合而聚合会让
 *    「只有一条」的情况反而多一层缩进。
 * 3. **不可聚合的类型原样保留**：fileChange（变更需要审阅）、
 *    commandExecution 里的失败/拒绝项需要单独可见，见 `canGroup`。
 *
 * 纯函数在这里很重要：分组错了不会报错，只会让时间线看起来"少了东西"
 * 或"顺序不对"，而这在 UI 上极难察觉。
 */
import type { Item } from '../types/domain';

/** 可聚合的类别。 */
export type GroupKind = 'read' | 'search' | 'command' | 'tool' | 'agent';

/** 一个可聚合项。 */
export interface GroupMember {
  item: Item;
  kind: GroupKind;
}

export interface ToolGroup {
  type: 'group';
  kind: GroupKind;
  /** 组内项，保持原顺序。 */
  members: GroupMember[];
}

export interface ToolSingle {
  type: 'single';
  item: Item;
}

export type TimelineUnit = ToolGroup | ToolSingle;

/**
 * 该 item 是否可聚合，以及属于哪一类。
 *
 * 返回 null 表示"必须单独显示"。
 */
export function groupKindOf(item: Item): GroupKind | null {
  switch (item.body.kind) {
    case 'imageView':
      return 'read';
    case 'webSearch':
      return 'search';
    case 'toolCall':
      return 'tool';
    case 'collabAgent':
      return 'agent';
    case 'commandExecution':
      // 失败的、被拒绝的命令**各自单独可见**：它们是用户需要立刻注意的
      // 异常，收进「已执行 3 条命令」里等于把异常藏起来。
      if (item.body.status === 'failed' || item.body.status === 'declined') return null;
      return 'command';
    // fileChange 一律不聚合：变更本身是审阅对象，且行内要放
    // 「修改 a.ts +1 −1」这类需要逐条看的信息
    default:
      return null;
  }
}

/**
 * 把时间线的 item 序列切成「可聚合的组」与「单独项」。
 *
 * 判定顺序即为输出顺序——**不重排**：时间线的顺序就是发生顺序，
 * 重排会让"先搜索再读文件"变成"先读文件再搜索"，那是编造。
 */
export function groupTimeline(items: Item[]): TimelineUnit[] {
  const units: TimelineUnit[] = [];
  let current: ToolGroup | null = null;

  for (const item of items) {
    const kind = groupKindOf(item);

    if (kind === null) {
      current = null; // 断开：不可聚合项会打断连续性
      units.push({ type: 'single', item });
      continue;
    }

    // 同类且连续 → 并入当前组
    if (current && current.kind === kind) {
      current.members.push({ item, kind });
      continue;
    }

    current = { type: 'group', kind, members: [{ item, kind }] };
    units.push(current);
  }

  // 单条不成组：还原成单独项，避免为 1 条多渲染一层
  return units.map((u) =>
    u.type === 'group' && u.members.length === 1 ? { type: 'single', item: u.members[0].item } : u,
  );
}

/** 类别名（组标题用）。 */
export function groupLabel(kind: GroupKind): string {
  switch (kind) {
    case 'read':
      return '读取';
    case 'search':
      return '搜索';
    case 'command':
      return '执行';
    case 'tool':
      return '调用工具';
    case 'agent':
      return '子代理';
  }
}

/**
 * 组的摘要文案：`已读取 1 个文件 · 已搜索 2 次`。
 *
 * 组内按类别计数（同组内类别相同，所以这里其实是"N 次 + 命中项"）。
 * 命名刻意带"已"字：它描述的是**已经发生**的动作，不是待办。
 */
export function groupSummary(group: ToolGroup): string {
  const n = group.members.length;
  const unit: Record<GroupKind, string> = {
    read: '个文件',
    search: '次搜索',
    command: '条命令',
    tool: '次调用',
    agent: '个子代理',
  };

  // 搜索与命令带上"命中/执行了什么"的线索，读与工具则只报数量
  // ——后者的具体对象在展开项里一眼可见，摘要不必重复。
  const detail = (() => {
    if (group.kind === 'search') {
      const queries = group.members
        .map((m) => (m.item.body.kind === 'webSearch' ? m.item.body.query : ''))
        .filter(Boolean);
      if (queries.length === 0) return '';
      // **同一个查询词重复搜了多次时也要给出内容**：那是常见形态
      // （换个措辞再搜、或同一关键词搜多轮），此时去重后只剩一个词，
      // 用户最想知道"搜的是什么"，而不是"搜了几次"。
      const uniq = [...new Set(queries)];
      if (uniq.length === 1) return `（${truncate(uniq[0], 28)}）`;
      return '';
    }
    if (group.kind === 'command') {
      const first = group.members.find((m) => m.item.body.kind === 'commandExecution');
      if (first && first.item.body.kind === 'commandExecution') {
        return `（${truncate(first.item.body.command.replace(/\s+/g, ' '), 32)}${n > 1 ? ' …' : ''}）`;
      }
      return '';
    }
    if (group.kind === 'read') {
      const paths = group.members
        .map((m) => (m.item.body.kind === 'imageView' ? m.item.body.path.split('/').pop() : ''))
        .filter(Boolean);
      if (paths.length === 1) return `（${paths[0]}）`;
      return '';
    }
    return '';
  })();

  return `已${groupLabel(group.kind)} ${n} ${unit[group.kind]}${detail}`;
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
