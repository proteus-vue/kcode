/**
 * 对话导航条（minimap）的数据层。
 *
 * # 为什么把数据层单独拆出来
 *
 * 这个功能的性能风险几乎全在「数据怎么来」上：会话变长后卡顿，通常不是
 * 动画本身，而是**每条都去 DOM 里量位置、或在渲染期遍历所有 item**。
 * 因此这里定下三条硬约束，并用测试钉住：
 *
 * 1. **只读 `turnOrder` 与 `turns`，不碰 `items`**。tick 的长度用
 *    `turn.itemIds.length` 表示——这是 O(1) 的读取；若改成统计每个 item
 *    的文本长度，复杂度就从 O(轮次) 变成 O(全部条目)，长会话下每次重渲染
 *    都要走一遍。测试用「items 为空」的状态证明它确实不依赖 item。
 * 2. **节点数封顶**。轮次超过 `MAX_TICKS` 时按桶聚合。上百个 tick 每个
 *    不到 1px 的间距既点不准也看不出来，却要为每个付一次 DOM 与合成成本。
 * 3. **预览按需算**。`turnPreview` 只对当前悬停的那一条调用，不在列表
 *    构建阶段批量计算。
 *
 * 位置与动画都不在这里：tick 的排布交给 CSS flex（浏览器负责，无需测量），
 * 悬停时只对**那一个**元素读一次 rect 来定位预览卡片。渲染期不读布局，
 * 这是不触发强制重排的关键。
 */
import type { RootState } from '../stores/store';
import { turnDisplayStatus } from '../stores/store';

/** tick 数量上限。超出则聚合——见上文第 2 条。 */
export const MAX_TICKS = 150;

/** 少于此数不显示导航条：一两条轮次本身就是一屏，导航条只是噪音。 */
export const MIN_TICKS = 2;

/** tick 的最小/最大视觉长度（px）。有下限才点得中，有上限才不喧宾夺主。 */
const MIN_LEN = 9;
const MAX_LEN = 26;

/** 需要用户注意的等级，数字越小越优先（聚合时取桶内最优）。 */
const ATTENTION_RANK = { fail: 0, awaiting: 1, running: 2, unknown: 3 } as const;
export type Attention = keyof typeof ATTENTION_RANK;

export interface TurnTick {
  /** React key 与 DOM 标识（聚合时取桶内首个轮次 id）。 */
  key: string;
  /** 点击时滚动到的轮次（聚合时取桶内第一个）。 */
  turnId: string;
  /** 该 tick 覆盖的轮次数（聚合时 > 1）。 */
  count: number;
  /** 视觉长度（px）。 */
  len: number;
  /** 需要用户注意的等级；null 表示正常。 */
  attention: Attention | null;
}

/** 显示状态 → 注意等级。 */
function attentionOf(display: string): Attention | null {
  if (display === 'failed') return 'fail';
  if (display === 'awaiting_approval') return 'awaiting';
  if (display === 'running') return 'running';
  if (display === 'unknown') return 'unknown';
  return null;
}

/**
 * 构建导航条的 tick 列表。
 *
 * 复杂度 O(轮次数)；状态派生复用 `turnDisplayStatus`（唯一真相源），
 * 不在这里重写一份——两份派生逻辑迟早会分叉。
 */
export function buildTicks(
  state: RootState,
  threadId: string,
  max: number = MAX_TICKS,
): TurnTick[] {
  const th = state.threads[threadId];
  if (!th) return [];
  const order = th.turnOrder;
  if (order.length < MIN_TICKS) return [];

  // 每轮只读 itemIds.length（O(1)），不遍历 item 内容
  const raw = order.map((turnId) => ({
    turnId,
    steps: th.turns[turnId]?.itemIds.length ?? 0,
    attention: attentionOf(turnDisplayStatus(state, threadId, turnId)),
  }));

  const maxSteps = raw.reduce((m, r) => Math.max(m, r.steps), 0);
  const lenOf = (steps: number) => {
    const ratio = maxSteps > 0 ? Math.min(1, steps / maxSteps) : 0;
    return Math.round(MIN_LEN + ratio * (MAX_LEN - MIN_LEN));
  };

  if (raw.length <= max) {
    return raw.map((r) => ({
      key: r.turnId,
      turnId: r.turnId,
      count: 1,
      len: lenOf(r.steps),
      attention: r.attention,
    }));
  }

  // 聚合：均匀分桶，保持时间顺序
  const size = Math.ceil(raw.length / max);
  const ticks: TurnTick[] = [];
  for (let i = 0; i < raw.length; i += size) {
    const bucket = raw.slice(i, i + size);
    const steps = bucket.reduce((s, r) => s + r.steps, 0);
    const best = bucket.reduce<Attention | null>((acc, r) => {
      if (!r.attention) return acc;
      if (!acc) return r.attention;
      return ATTENTION_RANK[r.attention] < ATTENTION_RANK[acc] ? r.attention : acc;
    }, null);
    ticks.push({
      key: bucket[0].turnId,
      turnId: bucket[0].turnId,
      count: bucket.length,
      // 聚合桶按总量算长度，否则长会话下所有桶都贴着最小值、差异消失
      len: lenOf(steps),
      attention: best,
    });
  }
  return ticks;
}

export interface TurnPreview {
  /** 卡片标题：该轮第一条用户消息（截断）。 */
  title: string;
  /** 正文摘要：助手回复或命令（截断）。 */
  body: string;
  /** 该轮用到的工具标签（去重保序、最多 3 个）。 */
  tools: string[];
}

const TITLE_MAX = 42;
const BODY_MAX = 120;
const TOOLS_MAX = 3;

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 工具种类 → 卡片上的短标签（与参照的 `edit`/`write`/`bash` 形态一致）。 */
const TOOL_LABEL: Record<string, string> = {
  commandExecution: 'bash',
  fileChange: 'write',
  toolCall: 'tool',
  webSearch: 'search',
  plan: 'plan',
  other: 'tool',
};

/**
 * 为**单条**轮次生成预览。按需调用——见文件头第 3 条。
 *
 * 会遍历该轮的 item（O(该轮条目数)），但只在一次悬停时跑一次。
 */
export function turnPreview(
  state: RootState,
  threadId: string,
  turnId: string,
): TurnPreview | null {
  const th = state.threads[threadId];
  const turn = th?.turns[turnId];
  if (!th || !turn) return null;

  const items = turn.itemIds.map((id) => th.items[id]).filter(Boolean);
  const firstUser = items.find((i) => i.body.kind === 'userMessage');
  const firstAgent = items.find((i) => i.body.kind === 'agentMessage');
  const firstCmd = items.find((i) => i.body.kind === 'commandExecution');

  const title =
    firstUser && firstUser.body.kind === 'userMessage'
      ? clip(firstUser.body.text, TITLE_MAX) || '（空消息）'
      : '（无用户消息）';

  let body = '';
  if (firstAgent && firstAgent.body.kind === 'agentMessage') {
    body = clip(firstAgent.body.text, BODY_MAX);
  } else if (firstCmd && firstCmd.body.kind === 'commandExecution') {
    body = clip(firstCmd.body.command, BODY_MAX);
  }

  // 工具标签：去重保序。超出不显示「+N」——卡片宽度有限，
  // 而 3 个已足够判断这一步在做什么。
  const seen = new Set<string>();
  const tools: string[] = [];
  for (const it of items) {
    if (it.body.kind === 'userMessage' || it.body.kind === 'agentMessage') continue;
    const label = TOOL_LABEL[it.body.kind] ?? it.body.kind;
    if (seen.has(label)) continue;
    seen.add(label);
    tools.push(label);
    if (tools.length >= TOOLS_MAX) break;
  }

  return { title, body, tools };
}
