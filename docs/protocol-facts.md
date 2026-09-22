# app-server 协议事实清单

> 由 `scripts/protocol-facts.mjs` 从 `schemas/` 自动生成，**请勿手工编辑**。
> 生成来源：codex CLI **0.155.1**。
> 用途：本文件是方案文档中一切协议细节的对账依据。文档与本文冲突时，以本文为准。

## 规模

| 类别 | 数量 |
|---|---|
| 客户端 → 服务端方法（ClientRequest） | 102 |
| 服务端 → 客户端通知（ServerNotification） | 82 |
| 服务端 → 客户端请求（ServerRequest） | 10 |

## 服务端主动请求（10）

审批走这一类别。注意：`applyPatchApproval` 与 `execCommandApproval` 是 **legacy**（源码标注 DEPRECATED，仅用于经 legacy API 启动的 Turn）；现行主路径是 `item/*/requestApproval`。

- `account/chatgptAuthTokens/refresh`
- `applyPatchApproval`
- `attestation/generate`
- `execCommandApproval`
- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/call`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`

## 审批类型字段

### CommandExecutionRequestApprovalParams

```
approvalId: string|null, command: string|null, commandActions: array|null, cwd: anyOf, environmentId: string|null, *itemId: string, kind: allOf, networkApprovalContext: anyOf, proposedExecpolicyAmendment: array|null, proposedNetworkPolicyAmendments: array|null, reason: string|null, *startedAtMs: integer, *threadId: string, *turnId: string
```

响应 `CommandExecutionRequestApprovalResponse`：

```
*decision: CommandExecutionApprovalDecision
```

### FileChangeRequestApprovalParams

```
grantRoot: string|null, *itemId: string, reason: string|null, *startedAtMs: integer, *threadId: string, *turnId: string
```

响应 `FileChangeRequestApprovalResponse`：

```
*decision: FileChangeApprovalDecision
```

### PermissionsRequestApprovalParams

```
*cwd: LegacyAppPathString, environmentId: string|null, *itemId: string, *permissions: RequestPermissionProfile, reason: string|null, *startedAtMs: integer, *threadId: string, *turnId: string
```

响应 `PermissionsRequestApprovalResponse`：

```
*permissions: GrantedPermissionProfile, scope: allOf, strictAutoReview: boolean|null
```

## 审批决策枚举

### CommandExecutionApprovalDecision

- `"accept"` — User approved the command.
- `"acceptForSession"` — User approved the command and future prompts in the same session-scoped approval cache should run without prompting.
- `{ "acceptWithExecpolicyAmendment": {...} }` — User approved the command, and wants to apply the proposed execpolicy amendment so future matching commands can run without prompting.
- `{ "applyNetworkPolicyAmendment": {...} }` — User chose a persistent network policy rule (allow/deny) for this host.
- `"decline"` — User denied the command. The agent will continue the turn.
- `"cancel"` — User denied the command. The turn will also be immediately interrupted.

### FileChangeApprovalDecision

- `"accept"` — User approved the file changes.
- `"acceptForSession"` — User approved the file changes and future changes to the same files should run without prompting.
- `"decline"` — User denied the file changes. The agent will continue the turn.
- `"cancel"` — User denied the file changes. The turn will also be immediately interrupted.

## 关键参数与响应结构

### InitializeParams

```
capabilities: anyOf, *clientInfo: ClientInfo
```

### InitializeCapabilities

```
experimentalApi: boolean, extensions: object|null, mcpServerOpenaiFormElicitation: boolean, optOutNotificationMethods: array|null, requestAttestation: boolean
```

### ThreadStartParams

```
approvalPolicy: anyOf, approvalsReviewer: anyOf, baseInstructions: string|null, config: object|null, cwd: string|null, developerInstructions: string|null, ephemeral: boolean|null, model: string|null, modelProvider: string|null, personality: anyOf, sandbox: anyOf, serviceName: string|null, serviceTier: string|null, sessionStartSource: anyOf, threadSource: anyOf
```

### TurnStartParams

```
approvalPolicy: anyOf, approvalsReviewer: anyOf, clientUserMessageId: string|null, cwd: string|null, effort: anyOf, *input: array, model: string|null, outputSchema: ?, personality: anyOf, sandboxPolicy: anyOf, serviceTier: string|null, serviceTierForTurn: string|null, summary: anyOf, *threadId: string, toolOutput: anyOf, turnTrigger: string|null
```

### TurnInterruptParams

```
*threadId: string, *turnId: string
```

### ThreadForkParams

```
approvalPolicy: anyOf, approvalsReviewer: anyOf, baseInstructions: string|null, config: object|null, cwd: string|null, developerInstructions: string|null, ephemeral: boolean, excludeTurns: boolean, lastTurnId: string|null, model: string|null, modelProvider: string|null, sandbox: anyOf, serviceTier: string|null, *threadId: string, threadSource: anyOf
```

### 关键枚举

- **SandboxMode**：`["read-only","workspace-write","danger-full-access"]`
- **AskForApproval**：`["untrusted | on-request | never","{granular}"]`
- **ApprovalsReviewer**：`["user","auto_review","guardian_subagent"]`

### Item 状态枚举（UI 必须处理 `declined`）

- **CommandExecutionStatus**：`["inProgress","completed","failed","declined"]`
- **PatchApplyStatus**：`["inProgress","completed","failed","declined"]`
- **TurnStatus**：`["completed","interrupted","failed","inProgress"]`

### 设置项的实测语义（`scripts/probe-settings.mjs`）

以下行为**无法从 schema 读出**，全部来自对真实 app-server 的探测：

- **config.toml 非法时 `config/read` 会整体失败**，返回 `-32603`
  （`invalid configuration: ...`），而不是返回部分配置或 null 字段。
  客户端**必须把这个错误报给用户**：静默当成「没有配置」会让界面显示
  一套并不生效的默认值，用户据此做的判断全都是错的。
  （这条曾经被误判为「传 cwd 会返回空 config」——当时的探针配置里有一个
  已废弃的 `wire_api = "chat"`，真正的原因是配置非法。`cwd` 参数本身无此问题。）
- **`config/value/write` 会先校验整份配置再落盘**。配置里任何一处非法（例如已废弃的
  `wire_api = "chat"`，现在只接受 `responses`）都会让写入整体失败，报
  `configValidationError`，且**文件保持不变**。写入是原子的，不会写一半。
- **`config/value/write` 能创建未类型化的表项**。例如 `keyPath: "model_providers.gamma"`
  配 `mergeStrategy: "upsert"` 可新增一个 provider 段落（实测成功）。
- **`permissionProfile/list` 返回的是沙箱档位**，id 形如 `":read-only"`、`":workspace"`、
  `":danger-full-access"`——带冒号前缀。`allowed` 表示当前生效的 requirements 是否允许选中。
  它与 `SandboxMode`（`read-only` / `workspace-write` / `danger-full-access`）是**两套命名**，
  名字不同但语义对应：`":workspace"` ≈ `workspace-write`。做 UI 时不要直接把 id 当 SandboxMode 用。
- **`thread/start` 的 `approvalPolicy` / `sandbox` / `modelProvider` 只作用于该线程**，
  不写回配置文件（实测：以 `approvalPolicy: "never"` 建线程后重读 config，
  `approval_policy` 仍为 `null`，`model_provider` 仍是原值）。
  所以「对当前会话生效」与「永久生效」是两条路径：前者走 thread/turn 参数，
  后者必须走 `config/value/write`。

### 响应结构（v1 命名空间，注意这些类型不在 ClientRequest 的 definitions 里）

- **ThreadStartResponse**：`*approvalPolicy: AskForApproval, *approvalsReviewer: allOf, *cwd: AbsolutePathBuf, instructionSources: array, *model: string, *modelProvider: string, reasoningEffort: anyOf, *sandbox: allOf, serviceTier: string|null, *thread: Thread`
- **TurnStartResponse**：`*turn: Turn`
- **ThreadResumeResponse**：`*approvalPolicy: AskForApproval, *approvalsReviewer: allOf, *cwd: AbsolutePathBuf, instructionSources: array, itemsBackwardsCursor: string|null, *model: string, *modelProvider: string, reasoningEffort: anyOf, *sandbox: allOf, serviceTier: string|null, *thread: Thread, turnsBackwardsCursor: string|null`

### ⚠️ `fuzzyFileSearch` 用 snake_case（与其余方法不同）

实测报文（codex 0.155.1；由 `crates/kcode-app/tests/e2e.rs` 的
`fuzzy_search_returns_matches_in_files_key` 复现）：

```json
{"files":[{"file_name":"probe.txt","indices":[12,13],
           "match_type":"file","path":"probe.txt","root":"/tmp/xxx","score":200}]}
```

- **命中列表在 `files` 键下**（不是 `data`，也不是数组直出）。
- **字段是 snake_case**：`file_name` / `match_type`。协议里绝大多数方法是
  camelCase，这里不是——读成 `fileName` 不报错，只会让文件名**静默变成空串**。
- 该方法的响应**没有**独立 definitions 条目（`ClientRequest.oneOf` 只给了请求侧），
  冻结 schema 里只有一个会话式通知 `FuzzyFileSearchSessionUpdatedNotification`
  （带 `sessionId`）。因此形态**只能实测**，推不出来。
- 参数：`{"query": string, "roots": [string]}`，两者皆必填。

### ⚠️ 图片输入的形态：只有路径/URL，没有内嵌字节

`turn/start` 的 `input` 数组元素（`UserInput`）实测有 7 种：

| type | 载荷 | 用途 |
|---|---|---|
| `text` | `text`, `text_elements[]` | 正文 |
| `image` | `url`, `detail` | 网络图片 |
| `localImage` | `path`, `detail` | **本地图片（我们用的）** |
| `audio` / `localAudio` | `url` / `path` | 音频 |
| `skill` | `name`, `path` | 技能引用 |
| `mention` | `name`, `path` | 文件引用 |

**关键**：图片**没有内嵌 base64 的形式**。因此：

- 拖入的文件（Tauri 拖放事件直接给出绝对路径）→ 直接传路径，不必落盘；
- 剪贴板粘贴的图片（只有字节、没有路径）→ **必须先写到磁盘**再传路径
  （实现见 `crates/kcode-desktop` 的 `save_attachment`，目录固定在自己
  app_data 下，不接受调用方指定，避免路径注入面）。

由 `crates/kcode-app/tests/e2e.rs::turn_accepts_local_image_attachment`
对真 app-server 验证：形状不对时该轮根本起不来，所以「轮次能完成」就是
形状正确的证据。

### `thread/compact/start` 参数形状

`{"threadId": string}`，仅此一项。服务端接受后压缩结果经 `thread/compacted`
通知回传（该通知已被协议标记 deprecated，改由 `contextCompaction` item 承载
——我们两条路径都接）。

## 客户端方法全集（102）

- `account/login/cancel`
- `account/login/start`
- `account/logout`
- `account/rateLimitResetCredit/consume`
- `account/rateLimits/read`
- `account/read`
- `account/sendAddCreditsNudgeEmail`
- `account/usage/read`
- `account/workspaceMessages/read`
- `app/installed`
- `app/list`
- `app/read`
- `command/exec`
- `command/exec/resize`
- `command/exec/terminate`
- `command/exec/write`
- `config/batchWrite`
- `config/mcpServer/reload`
- `config/read`
- `config/value/write`
- `configRequirements/read`
- `experimentalFeature/enablement/set`
- `experimentalFeature/list`
- `externalAgentConfig/detect`
- `externalAgentConfig/import`
- `externalAgentConfig/import/readHistories`
- `externalAgentConfig/import/recordHistory`
- `feedback/upload`
- `fs/copy`
- `fs/createDirectory`
- `fs/getMetadata`
- `fs/readDirectory`
- `fs/readFile`
- `fs/remove`
- `fs/unwatch`
- `fs/watch`
- `fs/writeFile`
- `fuzzyFileSearch`
- `hooks/list`
- `initialize`
- `marketplace/add`
- `marketplace/remove`
- `marketplace/upgrade`
- `mcpServer/oauth/login`
- `mcpServer/resource/read`
- `mcpServer/tool/call`
- `mcpServerStatus/list`
- `model/list`
- `modelProvider/capabilities/read`
- `permissionProfile/list`
- `plugin/install`
- `plugin/installed`
- `plugin/list`
- `plugin/read`
- `plugin/reconcile`
- `plugin/share/checkout`
- `plugin/share/delete`
- `plugin/share/list`
- `plugin/share/save`
- `plugin/share/updateTargets`
- `plugin/skill/read`
- `plugin/uninstall`
- `review/start`
- `skills/config/write`
- `skills/extraRoots/set`
- `skills/list`
- `thread/approveGuardianDeniedAction`
- `thread/archive`
- `thread/attachment/add`
- `thread/attachment/list`
- `thread/attachment/remove`
- `thread/compact/start`
- `thread/delete`
- `thread/fork`
- `thread/goal/clear`
- `thread/goal/get`
- `thread/goal/set`
- `thread/inject_items`
- `thread/items/list`
- `thread/list`
- `thread/loaded/list`
- `thread/metadata/update`
- `thread/name/set`
- `thread/read`
- `thread/resume`
- `thread/revert`
- `thread/rollback`
- `thread/section/move`
- `thread/shellCommand`
- `thread/start`
- `thread/turns/list`
- `thread/unarchive`
- `thread/unsubscribe`
- `threadSection/create`
- `threadSection/delete`
- `threadSection/list`
- `threadSection/update`
- `turn/interrupt`
- `turn/start`
- `turn/steer`
- `windowsSandbox/readiness`
- `windowsSandbox/setupStart`

## 服务端通知全集（82）

- `account/login/completed`
- `account/rateLimits/updated`
- `account/updated`
- `app/list/updated`
- `autoApprovalReview/strictReviewRequired`
- `command/exec/outputDelta`
- `configWarning`
- `deprecationNotice`
- `error`
- `externalAgentConfig/import/completed`
- `externalAgentConfig/import/progress`
- `fs/changed`
- `fuzzyFileSearch/sessionCompleted`
- `fuzzyFileSearch/sessionUpdated`
- `guardianWarning`
- `hook/completed`
- `hook/started`
- `item/agentMessage/delta`
- `item/autoApprovalReview/completed`
- `item/autoApprovalReview/started`
- `item/commandExecution/outputDelta`
- `item/commandExecution/terminalInteraction`
- `item/completed`
- `item/fileChange/outputDelta`
- `item/fileChange/patchUpdated`
- `item/mcpToolCall/progress`
- `item/plan/delta`
- `item/reasoning/summaryPartAdded`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/textDelta`
- `item/started`
- `mcpServer/event/stream/notification`
- `mcpServer/oauthLogin/completed`
- `mcpServer/startupStatus/updated`
- `model/rerouted`
- `model/safetyBuffering/updated`
- `model/verification`
- `modelProvider/authRecoveryCompleted`
- `modelProvider/authRecoveryStarted`
- `process/exited`
- `process/outputDelta`
- `project/changed`
- `remoteControl/status/changed`
- `serverRequest/resolved`
- `skills/changed`
- `thread/archived`
- `thread/attachment/updated`
- `thread/closed`
- `thread/compacted`
- `thread/deleted`
- `thread/environment/connected`
- `thread/environment/disconnected`
- `thread/goal/cleared`
- `thread/goal/updated`
- `thread/name/updated`
- `thread/project/updated`
- `thread/queue/changed`
- `thread/realtime/closed`
- `thread/realtime/error`
- `thread/realtime/item/completed`
- `thread/realtime/item/started`
- `thread/realtime/item/transcript/delta`
- `thread/realtime/itemAdded`
- `thread/realtime/outputAudio/delta`
- `thread/realtime/sdp`
- `thread/realtime/started`
- `thread/realtime/transcript/delta`
- `thread/realtime/transcript/done`
- `thread/reverted`
- `thread/settings/updated`
- `thread/started`
- `thread/status/changed`
- `thread/tokenUsage/updated`
- `thread/unarchived`
- `turn/completed`
- `turn/diff/updated`
- `turn/moderationMetadata`
- `turn/plan/updated`
- `turn/started`
- `warning`
- `windows/worldWritableWarning`
- `windowsSandbox/setupCompleted`

