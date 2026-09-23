/**
 * 子代理（协作）活动的展示。
 *
 * # 为什么单独成模块
 *
 * 协议有两个形状不同的 item 归到「协作」：
 *
 * | 协议类型 | 含义 | 关键字段 |
 * |---|---|---|
 * | `collabAgentToolCall` | 主 Agent 调用协作工具 | `tool` / `status` / `agentsStates` |
 * | `subAgentActivity` | 某个子代理的生命周期事件 | `kind` / `agentThreadId` |
 *
 * 两者的字段**完全不同**，所以从"要不要展开"到"显示什么"都按来源分派。
 *
 * # 这一层唯一会犯的错是「把内部术语漏给用户」
 *
 * 实测过一次：早先这里直接显示协议类型名，界面上出现
 * 「协作：collabAgentToolCall」。而 `spawnAgent` / `agentsStates` / `errored`
 * 这些同样是协议词汇——用户看不懂，也不想看。
 *
 * 因此映射是纯函数（`toolLabel` / `agentStatusLabel` / `activityLabel`）：
 * 这一层没有 UI 反馈能暴露映射缺失（漏了只会显示英文原词，看起来"也挺正常"），
 * 所以用测试把每个取值的文案钉住。
 */

/** 协作工具的文案。未识别的取值原样返回——不编一个中文名。 */
export function toolLabel(tool: string | null | undefined): string {
  switch (tool) {
    case 'spawnAgent':
      return '派生子代理';
    case 'sendInput':
      return '发送输入';
    case 'resumeAgent':
      return '恢复代理';
    case 'wait':
      return '等待代理';
    case 'closeAgent':
      return '关闭代理';
    case 'sendMessage':
      return '发送消息';
    case 'followupTask':
      return '追加任务';
    case 'interruptAgent':
      return '中断代理';
    case 'listAgents':
      return '列出代理';
    case null:
    case undefined:
      return '协作';
    default:
      return tool;
  }
}

/** 子代理状态的文案。协议给的取值见 AgentState.status。 */
export function agentStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'pendingInit':
      return '待启动';
    case 'running':
      return '运行中';
    case 'interrupted':
      return '已中断';
    case 'completed':
      return '已完成';
    case 'errored':
      return '出错';
    case 'shutdown':
      return '已关闭';
    case 'notFound':
      return '未找到';
    case null:
    case undefined:
      return '未知';
    default:
      return status;
  }
}

/** 协作调用本身的状态文案（与子代理状态是两套枚举，不能混用）。 */
export function callStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'inProgress':
      return '进行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'interrupted':
      return '已中断';
    case null:
    case undefined:
      return '';
    default:
      return status;
  }
}

/** 子代理生命周期事件的文案（subAgentActivity.kind）。 */
export function activityLabel(kind: string | null | undefined): string {
  switch (kind) {
    case 'started':
      return '已启动';
    case 'interacted':
      return '有交互';
    case 'interrupted':
      return '已中断';
    case 'completed':
      return '已完成';
    case null:
    case undefined:
      return '活动';
    default:
      return kind;
  }
}

/** 状态 → 视觉档位（决定用哪个语义色）。 */
export function statusTone(
  status: string | null | undefined,
): 'running' | 'ok' | 'warn' | 'danger' | 'idle' {
  switch (status) {
    case 'running':
    case 'inProgress':
      return 'running';
    case 'completed':
      return 'ok';
    case 'interrupted':
    case 'shutdown':
    case 'pendingInit':
      return 'warn';
    case 'errored':
    case 'notFound':
    case 'failed':
      return 'danger';
    default:
      return 'idle';
  }
}

/** 线程 id 的短形式——协议给的是 UUID，全量显示会占满一行。 */
export function shortId(id: string): string {
  const trimmed = id.trim();
  if (trimmed.length <= 8) return trimmed;
  return trimmed.slice(0, 8);
}

/** 一行摘要：把 agents 列表压成「3 个代理 · 1 运行中 · 1 已完成」。 */
export function agentRollup(agents: { status: string }[]): string {
  if (agents.length === 0) return '';
  const counts = new Map<string, number>();
  for (const a of agents) {
    counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  }
  // 运行中/出错这类"需要注意"的状态排在前面，其余按数量降序——
  // 用户扫一眼最想知道的是「还有几个在跑」
  const priority = (s: string) => (s === 'running' ? 0 : s === 'errored' ? 1 : 2);
  const parts = [...counts.entries()]
    .sort((a, b) => priority(a[0]) - priority(b[0]) || b[1] - a[1])
    .map(([s, n]) => `${n} ${agentStatusLabel(s)}`);
  return `${agents.length} 个代理 · ${parts.join(' · ')}`;
}
