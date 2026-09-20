/**
 * 前端领域类型。
 *
 * # 与 Rust 侧的契约
 *
 * 这些类型对应 `crates/kcode-domain` 与 `crates/kcode-app` 的线上格式，
 * 全部为 **camelCase**。该契约由 Rust 侧的
 * `crates/kcode-app/tests/wire_contract.rs` 逐类型断言守护——
 * 那边改动若破坏命名，CI 会失败。
 *
 * 之所以要专门守护：Rust 用 snake_case、TS 用 camelCase，这个差异
 * **不产生任何编译错误**，只会让这里读到 `undefined`。本项目已在三处
 * 踩过该问题（ItemBody 变体、AppEvent 变体、嵌套结构体）。
 *
 * 官方协议类型（`src/types/protocol/`，由 generate-ts 生成）**不在这里使用**：
 * 前端只消费领域类型，协议字段变化由 Rust 适配层吸收。
 */

// ── 协议状态（与协议一一对应）────────────────────────────────────────────

/** 协议 `TurnStatus`，实测仅 4 值。 */
export type TurnStatus = 'inProgress' | 'completed' | 'interrupted' | 'failed';

/** Item 生命周期状态。`declined` 表示用户拒绝、操作**未执行**。 */
export type ItemStatus = 'inProgress' | 'completed' | 'failed' | 'declined';

/** UI 展示状态：由事件流派生，**不是协议字段**。 */
export type TurnDisplayStatus =
  | 'running'
  | 'awaiting_approval'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'unknown';

// ── 风险分级（客户端自研，协议不提供）──────────────────────────────────

export type RiskTier = 'low' | 'moderate' | 'high' | 'critical';

export type RiskSignal =
  | { pathOutsideWorkspace: { path: string } }
  | { parentTraversal: Record<string, never> }
  | { credentialAccess: { target: string } }
  | { privilegeEscalation: { program: string } }
  | { destructiveDelete: Record<string, never> }
  | { diskOperation: Record<string, never> }
  | { permissionWidening: Record<string, never> }
  | { networkEgress: { evidence: string } }
  | { dependencyInstall: { manager: string } }
  | { gitForceOperation: Record<string, never> }
  | { escalationRequested: Record<string, never> }
  | { writeRootRequested: { root: string } }
  | { networkApprovalRequested: Record<string, never> }
  | { unparsedCommand: Record<string, never> };

export interface RiskAssessment {
  tier: RiskTier;
  signals: RiskSignal[];
}

// ── Item ────────────────────────────────────────────────────────────────

/** 变更类型。重命名由 `update` + `movePath` 表达，不是独立类型。 */
export type FileChangeKind =
  | { type: 'add' }
  | { type: 'delete' }
  | { type: 'update'; movePath?: string | null };

/**
 * 单个文件的变更。
 *
 * `diff` 的内容**随 kind 变化**（实测）：
 * - `add`：完整文件内容，不是 diff
 * - `delete`：完整被删内容，不是 diff
 * - `update`：hunk 文本，不含文件头
 * - `update`+`movePath`：hunk 文本 + 尾部 `Moved to: <路径>`
 *
 * 因此渲染时必须按 kind 分派，不能统一当 diff 解析。
 */
export interface FileChangeEntry {
  /** 实测为绝对路径，显示前需相对化。 */
  path: string;
  kind: FileChangeKind;
  diff: string;
}

export interface DiffStats {
  added: number;
  removed: number;
}

export type DiffLineKind = 'context' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  oldPath: string | null;
  newPath: string | null;
  hunks: DiffHunk[];
  movedTo?: string | null;
  /** 解析中的问题。UI 应展示而非忽略。 */
  warnings: string[];
}

export type TextChannel = 'agentMessage' | 'reasoning' | 'reasoningSummary' | 'plan';

/** 切分后单个文件的 diff 片段。 */
export interface FileDiffSlice {
  path: string;
  diff: ParsedDiff;
}

export type ChangeOrigin = 'proposed' | 'applied';

export type ReviewState =
  | 'proposed'
  | 'underReview'
  | 'acceptedPartial'
  | 'acceptedAll'
  | 'rejected';

export type FileDecision = 'pending' | 'accepted' | 'rejected';

export interface ChangeSet {
  turnId: string;
  threadId: string;
  files: FileChangeEntry[];
  origin: ChangeOrigin;
  reviewState: ReviewState;
  decisions: FileDecision[];
}

export type ItemBody =
  | { kind: 'userMessage'; text: string }
  | { kind: 'agentMessage'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'plan'; text: string }
  | {
      kind: 'commandExecution';
      command: string;
      cwd: string | null;
      status: ItemStatus;
      exitCode: number | null;
      aggregatedOutput: string | null;
      durationMs: number | null;
    }
  | { kind: 'fileChange'; status: ItemStatus; changes: FileChangeEntry[] }
  | {
      kind: 'toolCall';
      server: string | null;
      tool: string;
      argsSummary: string | null;
      resultSummary: string | null;
    }
  | { kind: 'webSearch'; query: string }
  | { kind: 'imageView'; path: string }
  | { kind: 'contextCompaction' }
  | { kind: 'collabAgent'; description: string }
  | { kind: 'other'; protocolType: string };

export interface Item {
  id: string;
  turnId: string;
  createdAtMs: number;
  body: ItemBody;
}

// ── 审批 ────────────────────────────────────────────────────────────────

/**
 * 协议决策值（6 个）。
 *
 * `decline` 与 `cancel` **都阻止执行**，区别仅在 `cancel` 会中断整个 Turn。
 * 实测确认：两者下命令均完全不执行（连沙箱内降级执行都不会发生），
 * 且 Item 状态为 `declined`。
 */
export type ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'acceptWithExecpolicyAmendment'
  | 'applyNetworkPolicyAmendment'
  | 'decline'
  | 'cancel';

export type ApprovalScope = 'once' | 'turn' | 'session' | 'project';

export interface Approval {
  /** 协议层请求 id 的字符串键；原样回传才能正确应答。 */
  requestId: string;
  /** 协议方法名，决定响应体形态。 */
  method: string;
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  summary: string;
  cwd: string | null;
  reason: string | null;
  risk: RiskAssessment;
  decision: ApprovalDecision | null;
  scope: ApprovalScope | null;
}

// ── 领域事件（后端 → 前端）─────────────────────────────────────────────

export type AppEvent =
  | { type: 'threadStarted'; threadId: string; cwd: string }
  | { type: 'turnStarted'; threadId: string; turnId: string }
  | { type: 'itemUpserted'; threadId: string; turnId: string; item: Item; completed: boolean }
  | { type: 'approvalRequired'; approval: Approval }
  | { type: 'approvalResolved'; requestId: string; threadId: string }
  | { type: 'turnCompleted'; threadId: string; turnId: string; status: TurnStatus }
  | { type: 'outputDelta'; threadId: string; itemId: string; delta: string }
  | {
      type: 'textDelta';
      threadId: string;
      itemId: string;
      turnId: string;
      channel: TextChannel;
      delta: string;
    }
  | { type: 'changeSetUpdated'; threadId: string; turnId: string; changeSet: ChangeSet }
  | { type: 'changeSetReplaced'; threadId: string; turnId: string; changeSet: ChangeSet }
  | {
      type: 'turnDiffUpdated';
      threadId: string;
      turnId: string;
      parsed: ParsedDiff;
      /** 按文件切分后的结果——整轮 diff 是多段拼接，直接解析会串行。 */
      perFile: FileDiffSlice[];
    }
  | { type: 'error'; message: string }
  | { type: 'processExited'; code: number | null }
  /** 终端输出增量。text 已在后端解码（协议用 base64 传）。 */
  | { type: 'terminalDelta'; processId: string; text: string; capReached: boolean }
  | { type: 'terminalExited'; processId: string; exitCode: number | null };

/** 从事件日志重建的线程概要（启动时填充侧栏）。 */
export interface ThreadSummary {
  threadId: string;
  cwd: string;
  createdAtMs: number;
  lastEventMs: number;
  itemCount: number;
  turnCount: number;
  /** 存在无完成记录的轮次（崩溃残留）——UI 应提示结果未知。 */
  hasUnfinishedTurn: boolean;
}

export interface TurnSnapshot {
  turnId: string;
  status: TurnStatus;
}

/** 从事件日志重建的完整线程快照。 */
export interface ThreadSnapshot {
  threadId: string;
  cwd: string;
  turns: TurnSnapshot[];
  items: Item[];
  /** 各轮次的变更集（含已持久化的用户决策）。 */
  changeSets: ChangeSet[];
  /** 重建中的问题（如历史载荷无法解析）——**不应静默忽略**。 */
  warnings: string[];
}

/** 可选模型（由后端从 provider 查询，非前端硬编码）。 */
export interface ModelOption {
  id: string;
  displayName: string;
  isDefault: boolean;
  reasoningEfforts: string[];
  defaultEffort: string | null;
}

/** 技能（来自 skills/list）。 */
export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  /** `user` 或 `repo`。 */
  scope: string;
  enabled: boolean;
}

/** 插件（来自 plugin/list）。 */
export interface PluginInfo {
  id: string;
  name: string;
  marketplace: string;
  installed: boolean;
  enabled: boolean;
  description: string | null;
}

export interface ThreadInfo {
  threadId: string;
  cwd: string;
  model: string | null;
  sandbox: unknown;
  approvalPolicy: unknown;
}

export interface EnvironmentInfo {
  workspace: string;
  codexHome: string;
  binaryPath: string;
  appData: string;
}

/** 工作区的 git 状态（协议不提供，客户端自研）。 */
export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  root: string | null;
  staged: number;
  modified: number;
  untracked: number;
  ahead: number;
  behind: number;
  conflicted: number;
}

export function isDirtyGit(s: GitStatus | null): boolean {
  if (!s?.isRepo) return false;
  return s.staged + s.modified + s.untracked + s.conflicted > 0;
}

export function changedCountGit(s: GitStatus | null): number {
  if (!s?.isRepo) return 0;
  return s.staged + s.modified + s.untracked + s.conflicted;
}

/**
 * 权限档位。与后端 PermissionMode 一一对应。
 *
 * 协议里 `sandbox` 与 `approvalPolicy` 是两个独立参数，但只有特定组合
 * 才有实际意义，所以界面上绑成一档——与 Codex 的三档下拉一致。
 */
export type PermissionMode = 'readOnly' | 'workspaceWrite' | 'fullAccess';

/** 一个可选的权限档位（来自 permissionProfile/list）。 */
export interface PermissionProfile {
  id: string;
  name: string;
  description: string | null;
  /** 当前 requirements 是否允许选中。false 时必须置灰。 */
  allowed: boolean;
  mode: PermissionMode | null;
}

/** 设置快照。 */
export interface SettingsSnapshot {
  mode: PermissionMode;
  model: string | null;
  modelProvider: string | null;
  providers: string[];
  profiles: PermissionProfile[];
  configPath: string | null;
}

/** 文件详情（由后端 read_file_detail 返回）。 */
export interface FileDetail {
  /** 工作区相对路径。 */
  path: string;
  absolutePath: string;
  size: number;
  /** 二进制文件不返回文本内容。 */
  binary: boolean;
  /** 文本内容；二进制或超限时为 null。 */
  text: string | null;
  /** 图片的 data URL；非图片或超限时为 null。 */
  imageDataUrl: string | null;
  /** 未加载内容时的原因说明。 */
  truncated: string | null;
}

/** 右栏内容视图的类型。 */
export type RightContent =
  | { kind: 'browser'; url: string; label: string }
  | { kind: 'file'; path: string; label: string };

/**
 * 输入框的附件。
 *
 * 网页元素是第一个（也是目前唯一）类型：它需要比「一段文字」更丰富的
 * 呈现——用户要能看出自己选的是哪个元素、来自哪个页面，并且在发送前
 * 能移除它。直接往输入框塞文字做不到这些（实测过：用户看到一大段
 * 选择器文本，既不知道它从哪来，也没法单独删掉）。
 */
export interface WebElementAttachment {
  kind: 'webElement';
  selector: string;
  tag: string;
  text: string;
  width: number;
  height: number;
  url: string;
  title: string;
  color?: string;
  font?: string;
}
