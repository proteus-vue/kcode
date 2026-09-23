/**
 * MCP / 动态工具调用的展示文案。
 *
 * # 为什么需要「可读化」
 *
 * 工具名是**协议原文**（`search_docs`、`create_issue`），而协议**不提供**
 * 人类可读的标题——我核对过 `mcpToolCall` 的 schema，字段只有
 * `server / tool / status / arguments / readOnlyHint / result / error /
 * durationMs`，没有 `tool_title`（那个字段在遥测事件里，不在 Item 上）。
 *
 * 所以「翻译成中文语义」做不到（任意工具名没有中文对应），但**能从形态上
 * 让它可读**：
 *
 * - 拆开下划线/驼峰：`search_docs` → `search docs`，比连字符串好扫读；
 * - 剥掉 `mcp__server__tool` 前缀里的冗余部分（server 名我们已经单独显示）；
 * - 用协议的 `readOnlyHint` 标出「只读」——用户批准前需要知道它不改东西。
 *
 * 纯函数 + 测试：这一层错了不会报错，只会让界面显示一串难读的标识符。
 */

/**
 * 把协议工具名变成可读形态。
 *
 * 不做「中文化」——任意工具名没有中文对应，硬译会编造语义。
 * 只做形态整理，保留原词的辨识度（便于用户拿去搜文档）。
 */
export function humanizeToolName(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '未命名工具';

  // `mcp__server__tool` 形态：前缀里的 server 名我们已单独显示，
  // 再重复一遍只会让这一行更长。只剥 `mcp__` 开头且有第二段分隔的那种。
  let s = trimmed;
  const prefixed = /^mcp__[^_]+__(.+)$/i.exec(s);
  if (prefixed && prefixed[1].trim() !== '') {
    s = prefixed[1];
  }

  return s
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 工具调用状态的文案。
 *
 * `completed` 返回空串：完成是默认状态，不标注——与整轮、与命令行的
 * 判断一致（每处都挂一个「已完成」等于给时间线加噪声）。
 */
export function toolCallStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'inProgress':
      return '正在执行';
    case 'failed':
      return '失败';
    case 'completed':
    case null:
    case undefined:
      return '';
    default:
      // 协议加了新状态：原样显示比假装它是完成更安全
      return status;
  }
}

/** 该工具是失败态吗（决定 chip 与是否有可展开内容）。 */
export function isToolCallFailed(status: string | null | undefined): boolean {
  return status === 'failed';
}

/** 该工具仍在运行吗（决定「正在执行」标签与扫光）。 */
export function isToolCallRunning(status: string | null | undefined): boolean {
  return status === 'inProgress';
}
