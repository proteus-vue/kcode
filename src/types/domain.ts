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
  | {
      kind: 'userMessage';
      text: string;
      /**
       * 该消息携带的本地图片路径。
       *
       * 服务端会把本地图片原样回显在 userMessage 的 content 里，
       * 保留它才能让时间线显示「这条消息带了哪几张图」——
       * 只取 text 的话界面显示为纯文字，而图片其实已发出且模型看到了。
       */
      images?: string[];
    }
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
      /**
       * 调用状态：`inProgress` / `completed` / `failed`。
       *
       * 必须保留：失败时 `resultSummary` 为 null，不取状态的话一次失败的
       * 调用在界面上与「还在跑」完全一样，而且没有可展开的内容。
       */
      status: string | null;
      /** 失败原因（协议 `error.message`）。 */
      error: string | null;
      /** 协议给的只读提示（MCP 的 `readOnlyHint`）。 */
      readOnly: boolean | null;
      /** 调用耗时（毫秒）。 */
      durationMs: number | null;
    }
  | { kind: 'webSearch'; query: string }
  | { kind: 'imageView'; path: string }
  | { kind: 'contextCompaction' }
  /**
   * 协作 / 子 Agent 活动。
   *
   * 协议有两个形状不同的 item 归到这里，字段各自独立：
   * - `collabAgentToolCall`：`tool` / `status` / `receiverThreadIds` / `agents` / `prompt`
   * - `subAgentActivity`：`activityKind` / `agentThreadId` / `agentPath`
   *
   * 早先这里只有一个 `description` 且填的是协议类型名，界面显示成
   * 「协作：collabAgentToolCall」——术语泄漏 + 信息全丢，已修正。
   */
  | {
      kind: 'collabAgent';
      /** 协议原始类型（兜底展示与排查用，不直接呈现给用户）。 */
      source: string;
      tool?: string | null;
      status?: string | null;
      receiverThreadIds: string[];
      agents: AgentState[];
      prompt?: string | null;
      activityKind?: string | null;
      agentThreadId?: string | null;
      agentPath?: string | null;
    }
  | { kind: 'other'; protocolType: string };

/** 一个子代理的当前状态（协议 `agentsStates` 表的一项）。 */
export interface AgentState {
  threadId: string;
  /** `pendingInit` / `running` / `completed` / `errored` / `shutdown` / `notFound`。 */
  status: string;
  message: string | null;
}

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
  /** 线程元数据（服务端 thread/list 的 name/model，或 start 的 model）。 */
  | { type: 'threadMeta'; threadId: string; name?: string | null; model?: string | null }
  | { type: 'turnStarted'; threadId: string; turnId: string }
  | { type: 'itemUpserted'; threadId: string; turnId: string; item: Item; completed: boolean }
  | { type: 'approvalRequired'; approval: Approval }
  | { type: 'approvalResolved'; requestId: string; threadId: string }
  | {
      type: 'turnCompleted';
      threadId: string;
      turnId: string;
      status: TurnStatus;
      /**
       * 该轮耗时（毫秒），协议 `Turn.durationMs` 原样带出。
       * null = 协议未提供（此时**不显示**，不用本地计时凑一个）。
       */
      durationMs?: number | null;
    }
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
  | { type: 'terminalExited'; processId: string; exitCode: number | null }
  /** 护栏警告（协议 guardianWarning）——上游检测到异常执行模式。 */
  | { type: 'guardianWarning'; threadId: string; message: string }
  /** 线程 token 用量更新（协议 thread/tokenUsage/updated）。 */
  | { type: 'tokenUsageUpdated'; threadId: string; turnId: string; usage: ThreadTokenUsage };

/** 单次计量的 token 明细（协议 TokenUsageBreakdown）。 */
export interface TokenUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

/**
 * 线程级 token 用量（协议 ThreadTokenUsage）。
 *
 * `last` 是最近一轮的用量，**上下文占用按它估算**：`total` 是跨轮累加值，
 * 拿它跟上下文窗口比会得出「已用 300%」这种错误结论。
 */
export interface ThreadTokenUsage {
  last: TokenUsageBreakdown;
  total: TokenUsageBreakdown;
  /** 模型上下文窗口大小。null 表示协议未提供，此时无法计算余量。 */
  modelContextWindow: number | null;
}

/** 一次护栏警告。 */
export interface GuardianWarning {
  message: string;
}

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
  /** 服务端给出的首条消息摘要（thread/list 的 preview）。 */
  preview?: string | null;
  /** 用户或系统给线程起的名字（thread/name/set 之后由服务端返回）。 */
  name?: string | null;
  /** 该线程使用的模型。 */
  model?: string | null;
}

export interface TurnSnapshot {
  turnId: string;
  status: TurnStatus;
  /** 该轮耗时（毫秒）。null = 协议未提供。 */
  durationMs?: number | null;
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
  | { kind: 'file'; path: string; label: string }
  /**
   * 一条线程的会话内容（用于在右栏查看子代理）。
   *
   * 与 `file` / `browser` 并列而不是塞进场景里：它同样需要**整块右栏高度**
   * 来读时间线，而且要在标签上显示标题、可关闭——与内容视图的语义一致。
   */
  | { kind: 'thread'; threadId: string; label: string };

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

/**
 * 模糊文件搜索命中的一条结果（协议 `fuzzyFileSearch`）。
 *
 * 用于输入框的 `@` 引用：模型看不到工作区，用户必须能把具体文件指给它。
 */
export interface FileMatch {
  path: string;
  /** 文件名（不含目录），列表主行显示它。 */
  fileName: string;
  /** `'file'` 或 `'directory'`。 */
  matchType: string;
  score: number;
  /** 命中字符在文件名中的下标（可选高亮）。 */
  indices: number[];
}

/**
 * 粘贴的图片附件。
 *
 * 与 `WebElementAttachment`（网页元素）分开：两者的生命周期与投递方式
 * 完全不同——网页元素被序列化成**文本**发出去，图片则是以协议
 * `localImage` 的形式、用**路径**随轮次提交。
 */
export interface ImageAttachment {
  kind: 'image';
  /** 落盘后的绝对路径——协议 `localImage` 需要它。 */
  path: string;
  /** 原始文件名，仅用于展示。 */
  name: string;
  /** data URL，用于缩略图预览（CSP 允许 data:）。 */
  preview: string;
  /** 字节数，用于展示与上限校验。 */
  size: number;
}

/** 输入区可携带的附件。 */
export type ComposerAttachment = WebElementAttachment | ImageAttachment;

/** 模拟器/设备所属平台。 */
export type SimulatorPlatform = 'android' | 'ios' | 'harmony' | 'miniprogram';

/** 一台可展示的模拟器/设备（四平台共用）。 */
export interface DeviceEntry {
  /**
   * 平台内的**身份**标识。
   *
   * Android 是 AVD 名（`Pixel_4a_API_30`）——用户启动时用的就是它；
   * iOS 是 UDID；鸿蒙是 connect key。
   */
  id: string;
  /** 展示名（型号，如 `Pixel 4a API 30` / `iPhone 15 Pro`）。 */
  name: string;
  /** 系统名与版本（`Android 13` / `iOS 17.0`）。取不到为 null——后端不编造。 */
  os: string | null;
  /** 分辨率（`1080×2340`）。 */
  resolution: string | null;
  /** 是否正在运行（可截图/可输入）。 */
  running: boolean;
  /** 原始状态串（`device` / `offline` / `Booted` / `stopped` …）。 */
  state: string;
  /** 附加细节（abi · dpi · 镜像 tag）。 */
  detail: string | null;
  /**
   * **取画面 / 发输入 / 关闭**用的句柄（未运行时为 null）。
   *
   * 与 `id` 分开是必要的：Android 上 `id` 是 AVD 名，而这个字段是
   * adb serial（`emulator-5554`）——两者没有可推导的关系，端口每次启动都可能变。
   * 把 AVD 名当 serial 传给 adb 会得到一个与根因无关的报错。
   */
  runtimeId: string | null;
}

/** 一个平台的能力与设备清单。 */
export interface PlatformStatus {
  /** 工具链是否齐备（齐备才能列设备）。 */
  available: boolean;
  /** 不可用/部分可用时的原因与**可执行的下一步**。 */
  reason: string | null;
  /** 探测到的工具路径（排查「为什么找不到我的模拟器」时有用）。 */
  tool: string | null;
  devices: DeviceEntry[];
  /** 能否从本应用**启动**设备（鸿蒙为 false：无独立启动器）。 */
  canLaunch: boolean;
  /** 能否发送触摸输入（iOS 为 false：simctl 没有触摸命令）。 */
  canInput: boolean;
  /** `canInput` 为 false 时的原因（iOS 是平台限制，鸿蒙是我们未验证）。 */
  inputHint: string | null;
  /**
   * 输入形态。
   *
   * - `none`：不能输入（iOS / 鸿蒙）；
   * - `coordinate`：按坐标——可点画面任意位置、可滑动（Android）；
   * - `element`：**只能点元素**，不能按坐标（小程序：自动化接口不返回元素位置）。
   *
   * 界面据此决定画可点画面还是元素列表。用一个布尔量表达会把小程序
   * 显示成「可点画面」，而用户点了不会有任何反应——那看起来像功能坏了，
   * 实际是平台能力形态不同。
   */
  inputMode: 'none' | 'coordinate' | 'element';
}

/** 小程序当前页的一个可点元素。 */
export interface MpElement {
  id: string;
  /** 标签名（`view` / `button` 等）。 */
  tag: string;
  /**
   * 元素上的文字（`innerText`）。
   *
   * **这是热区标签的来源**：截图里用户看到的字就是它
   * （「表单与指令」「配置演示」），拿它当提示文本，热区才看得懂。
   */
  text: string;
  /** 元素位置与尺寸（**CSS px**，与 viewport 同一坐标系）。 */
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 小程序视口信息（元素坐标 → 截图比例 的换算依据）。 */
export interface MpViewport {
  /** 页面视口宽（CSS px）。 */
  width: number;
  /** **屏幕**高（CSS px），不是视口高——截图覆盖整屏，含状态栏。 */
  screenHeight: number;
  pixelRatio: number;
}

/** 四平台的整体状态。**四个平台都要显示**，不可用也要列出（附原因）。 */
export interface SimulatorStatus {
  android: PlatformStatus;
  ios: PlatformStatus;
  harmony: PlatformStatus;
  miniprogram: PlatformStatus;
}

/**
 * 开发者工具路径的**自定义设置**（兜底）。
 *
 * # 为什么需要它
 *
 * 自动发现只能覆盖常见位置与常见命名。实测两类漏网都不是罕见用法：
 * 把工具装在外置卷（`/Volumes/...`）、以及改过名的 `.app`
 * （同一台机器上微信开发者工具有 `wechatwebdevtools.app` 与
 * `微信开发者工具（NWJS）.app` 两种目录名）。
 *
 * 界面在「找不到工具」与「工具可用」两种状态下都提供入口：
 * 后者是为了在装了**多份**时指定用哪一份。
 */
export interface ToolOverrides {
  /** Android SDK **根目录**（其下应有 platform-tools/、emulator/）。 */
  androidSdk: string | null;
  /** **Xcode.app 本身**（不是 Contents/Developer——那个由后端推导）。 */
  xcode: string | null;
  /** HarmonyOS SDK 目录（其下应有 openharmony/<版本>/toolchains/hdc）。 */
  harmonySdk: string | null;
  /** 微信开发者工具 `.app`。 */
  miniprogram: string | null;
}

/** 一帧画面及其设备尺寸（用于坐标换算）。 */
export interface SimulatorFrame {
  /**
   * data URL。**null 表示内容与上一帧逐字节相同**。
   *
   * 服务端比对 PNG 字节，未变时只回尺寸——前端据此**跳过 setState**，
   * 省掉一次 780KB 传输 + 250 万像素解码 + 重绘。模拟器画面大多数时候
   * 是静止的，不去重会让轮询与用户的触摸操作抢主线程，表现为卡顿。
   */
  dataUrl: string | null;
  width: number;
  height: number;
  /**
   * **设备画面在帧里的位置**（归一化 0..1：x, y, 宽, 高）。
   *
   * `null` = 整帧就是设备画面（逐帧截图路径）。
   * 非 null 时帧是**整个窗口**（含标题栏与模拟器外壳），设备屏幕只占其中
   * 一块——绘制与点击换算都必须先裁到这块，否则点击会整体偏移。
   *
   * 实测样例：窗口帧 988×2108 里，设备画面是 x 0、y 0.0508、宽 1.0、
   * 高 0.9492（顶部 5% 是标题栏）。
   */
  deviceRect: [number, number, number, number] | null;
  /**
   * **设备像素尺寸** `[宽, 高]`。与 `width`/`height`（帧尺寸）不同。
   *
   * 走常驻窗口流时帧是**整个窗口**截图，设备只是其中一块；点击坐标必须按
   * 设备尺寸算——否则前端按帧尺寸乘、后端按设备尺寸除，尺度不一致会让
   * 点击偏出很远（实测纵向偏 23.5%）。`null` = 帧尺寸即设备尺寸。
   */
  deviceSize: [number, number] | null;
}
