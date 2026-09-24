# KCode ↔ Codex / ZCode 桌面端 UI 对标指标清单

> 基准（2026-09-20）：`docs/archive/codex_paradigm_research.md`、`KCode落地方案.md` §3；本机 `Codex.app` / `ZCode.app`；当前实现 `src/components/*`。
> 状态：✅ 已对齐 · 🟡 部分 · ❌ 缺口 · ⏸ 协议未就绪

## 1. 信息架构与布局

| ID | 指标 | 参照 | KCode | 状态 | 优先级 |
|---|---|---|---|---|---|
| IA-01 | 三栏：左导航 / 中对话 / 右审阅 | Codex command center | Sidebar+Main+Inspector，可折叠拖拽；**中栏顶栏浮动沉浸**（见 VS-11） | ✅ | — |
| IA-02 | 左栏「项目分组+最近」 | Project→Thread | Sidebar 分组+recent | ✅ | — |
| IA-03 | 线程排序=待用户操作优先 | 等待审批>运行中>… | threadSortRank | ✅ | — |
| IA-04 | Thread 行：标题/仓库/worktree/模型/变更数/状态 | 方案 §2.2 | 标题+相对时间+状态+待审批+**变更文件数Δ**+**模型徽标**（Sidebar ThreadRow；纯函数 changedFileCount/shortModelName，ThreadState.name/model + threadMeta 事件）；worktree 标签无数据源（worktree 创建本身未实现，见 IA-06） | 🟡 | P0 |
| IA-05 | Thread：命名/置顶/归档/fork 菜单 | thread/* | **重命名/置顶/归档已落地**：`ThreadMenu.tsx`（行内「⋯」）+ `thread_name_set`/`thread_archive` 命令 → `thread/name/set`/`thread/archive`；e2e 对真 app-server 验证「改名可回读」「归档后列表隐藏、取消归档恢复」。仍缺 fork 与归档列表 UI | 🟡 | P0 |
| IA-06 | 新建任务三档 Current tree / Worktree / Cloud | Worktree 边界 | 无创建面板 | ❌ | P1 |
| IA-07 | 右栏标签关闭/关闭其他/全部 | Codex 右栏 | Workbench+测试 | ✅ | — |
| IA-08 | 场景无内容不出现 | 防空入口 | scenes+测试 | ✅ | — |
| IA-09 | 状态浮层空则不渲染 | 降噪 | dockVisibility+测试 | ✅ | — |
| IA-10 | 折叠胶囊保留进度+最后一步 | 扫一眼 | CollapsiblePanel | ✅ | — |
| IA-11 | 欢迎四建议卡 | Codex 欢迎 | Welcome | ✅ | — |
| IA-12 | 双击导航/标题缩放 | 系统行为 | titlebarZoom | ✅ | — |
| IA-13 | 项目切换+信任态 | 安全边界 | 仅当前 workspace | 🟡 | P2 |
| IA-14 | 命令面板 | 快捷入口 | 无；shortcut 仅文案 | ❌ | P1 |

## 2. 对话时间线

| ID | 指标 | 参照 | KCode | 状态 | 优先级 |
|---|---|---|---|---|---|
| CH-01 | 气泡+Markdown（禁 raw HTML） | 标准 | ItemCard+Markdown | ✅ | — |
| CH-02 | ~~推理可折叠~~ → **不展示推理** | 参照客户端不展示 | **已移除**：实测 Codex.app 的 asar 里 `reasoning` 只出现在模型配置（`reasoning_effort`），无任何推理内容 UI；理由成立——推理每轮一条、与工具调用交替，展开让时间线翻倍而信息价值低于命令与 diff。reducer 按 channel 过滤其流式增量（防漏成正文），孤儿样式已删 | ✅ | — |
| CH-03 | 工具/命令紧凑单行可展开 | 成熟客户端 | ToolRow；**连续同类动作聚合折叠**（`toolGrouping.ts`）：`已搜索 3 次搜索 ⌄` 一行收起，展开后仍是同一套 ToolRow。只有「同类且连续」才聚合（中间夹别的类型即断开），单条不成组；**失败/被拒绝的命令一律不聚合**——它们是需要注意的异常，收进摘要等于藏起来。**展开后按「参数 / 结果」分区 + 每块可复制**（`OutputBlock`）：复制是必备的——用户的下一个动作常是「把报错搜一下」或「把结果贴进 issue」，没有按钮只能手工划选，而终端输出里混着换行与制表符很容易多一个少一个字符。**MCP 工具的 `arguments` 此前从未渲染**（领域层解析了、TS 类型也定了，但只有结果被显示）——数据在而用户看不到，已修。**参数与结果的截断从投影期移到显示层**：原先在 Rust 投影时 `truncate(…, 200)`，展开也看不全；现完整保留、只在显示时按 30k 折叠（保留尾部，与命令输出同一条规则），并把 JSON 格式化成缩进形式（压成一行既难读也难复制）。8 项组件测试 | ✅ | — |
| CH-04 | declined≠completed 视觉 | 实测语义 | chip 未执行 | ✅ | — |
| CH-05 | Turn 状态齐全 | 状态机 | TurnView | ✅ | — |
| CH-06 | unknown 不静默当成功 | 恢复 | unknown-note | ✅ | — |
| CH-07 | 流式增量+光标 | delta | streamBuffer | ✅ | — |
| CH-08 | Turn 耗时/token/成本 | 执行反馈 | **上下文余量已落地**：`thread/tokenUsage/updated` → `contextUsage()` → StatusDock 条形+百分比（仅 ≥70% 时出现，对齐上游压缩线）。**单轮耗时已落地**：协议 `Turn.durationMs` → `TurnCompleted.durationMs` → `TurnState.durationMs` → 轮次收尾 `已处理 13 分 20 秒 ⌄`，展开是本轮工作详情（各类动作计数 + 变更文件）。**耗时不由前端计时**（那会把网络与排队算进工作时长），协议未提供时不显示。重启后仍可见：事件日志的 `turn_completed` 载荷里带 durationMs，`TurnSnapshot` 一并重建。仍缺成本 | 🟡 | P1 |
| CH-09 | 中途停止/追加 | 可介入 | Stop 有 | 🟡 | — |
| CH-10 | 路径点击→右栏详情 | 跳转 | onOpenFile | ✅ | — |
| CH-11 | 子代理（协作）活动可见 | 协议 `collabAgentToolCall` / `subAgentActivity` | **已落地**：此前只存协议类型名，界面显示「协作：collabAgentToolCall」（术语泄漏 + 信息全丢）。现解析 `tool` / `status` / `receiverThreadIds` / `agentsStates` / `prompt` 与 `kind` / `agentThreadId` / `agentPath`，渲染成紧凑单行（`派生子代理  2 个代理 · 1 运行中 · 1 已完成`）+ 展开看各代理状态表与任务说明；协议取值全部映射为中文（`spawnAgent`→派生子代理 等），未识别取值原样返回不编造。实测 `multi_agent` 特性为 stable 且默认启用 | ✅ | — |

## 3. 审批与权限

| ID | 指标 | 参照 | KCode | 状态 | 优先级 |
|---|---|---|---|---|---|
| AP-01 | 审批五问 | §3.4 | ApprovalModal | ✅ | — |
| AP-02 | decline 与拒绝并停止分按钮 | cancel 断 Turn | 分按钮 | ✅ | — |
| AP-03 | 风险分级+信号来源 | classifier | risk-badge | ✅ | — |
| AP-11 | 上游护栏信号可见（方案 05 章硬约束） | guardianWarning | **已落地**：`guardianWarning` → `GuardianWarning` 事件 → ThreadState.guardianWarnings → StatusDock 置顶横幅（强制展开，含计数）；单测覆盖累积/摘要/独立于 errors | ✅ | P0 |
| AP-04 | 敏感值脱敏 | 红线 | redact() | ✅ | — |
| AP-05 | 三档权限+危险二次确认 | Picker | PermissionPicker | ✅ | — |
| AP-06 | 底栏权限/模型/effort 常驻 | 提交前可见 | Composer | ✅ | — |
| AP-07 | 作用域 once/profile/always | Granular 基础 | **已落地**：仅本次/本会话选择器 → accept/acceptForSession（`decisionForScope` 纯函数，未支持粒度一律回落最窄授权）；turn/project 协议未暴露故不出现。测试 `__tests__/approvalModal.test.tsx` | ✅ | P1 |
| AP-08 | 展示 thread/turn/item 链路 | 可追溯 | **已落地**：thread/turn/item + 协议方法名（ApprovalModal）；测试覆盖 id 链路与脱敏 | ✅ | P1 |
| AP-09 | Granular 五分类开关 | 官方 | 无 | ❌ | P2 |
| AP-10 | auto_review 状态机 | 官方 | 无 | ❌ | P2 |

## 4. Diff / Review / Git

| ID | 指标 | 参照 | KCode | 状态 | 优先级 |
|---|---|---|---|---|---|
| DR-01 | 双通道 diff（fileChange 优先） | 实测 | DiffViewer | ✅ | — |
| DR-02 | 按 kind 分组+统计 | 分组 | groupByKind | ✅ | — |
| DR-03 | 逐文件/全部接受拒绝 | 闭环 | decideFile/All | ✅ | — |
| DR-04 | split/unified | 双视图 | splitMode | ✅ | — |
| DR-05 | 审阅决策持久化 | 重启仍在 | 事件日志 | ✅ | — |
| DR-06 | 路径→文件详情 | 跳转 | onOpenFile | ✅ | — |
| DR-07 | Git：更改/分支/提交或推送 | Git 工具 | GitPanel+Dock | ✅ | — |
| DR-08 | 推送二次确认 | 零静默 | confirmPush | ✅ | — |
| DR-09 | 行内评论（仅上下文 vs 要改） | 点击行 | **已落地**：行尾评论按钮（悬停出现、有评论的行常亮）→ 编辑器含**意图二选一**（要改 / 仅上下文）；`reviewComments.ts` 纯函数把评论序列化成自包含文本（文件+行号+侧别+该行原文+意图），经输入框发给模型。**两种意图不合并**的理由在模块头：合并会让「5 行说明」被当成「5 处要改」。行号锚定按 diff 侧别分派（删除行锚旧文件、新增/上下文行锚新文件）。19 项纯函数测试 + 10 项组件交互测试 | ✅ | P1 |
| DR-10 | 外部编辑器/跳到行 | 审阅 | **已落地**：`editor.rs` 按 `$KCODE_EDITOR` → PATH 上的 `code`/`cursor`/`zed`/`subl` → macOS app bundle 内 CLI → 系统默认的顺序探测（GUI 启动时 PATH 常缺 `code`，这条是实测加上的）。参数形状按编辑器分派：`--goto file:line`（VS Code 系）与 `file:line`（Zed/Sublime）；系统默认兜底只能用 `open -t`，**不支持跳行且如实标记**（不承诺做不到的事）。行号参数从被点击的 diff 行取，不在界面上让用户手输 | ✅ | P1 |
| DR-11 | 撤销单文件变更 | 回退 | **已落地**：`git.rs::revert_file` 按文件在 git 中的真实状态分派——已暂存先 `restore --staged`、已跟踪 `restore`、未跟踪（Agent 新建）则**删除**。撤销前必须确认（删除不可找回，确认文案写清两种后果）。**不能用协议的 `thread/revert`**：实测其 schema 明确写着只改会话历史、不动本地文件（见 `protocol-facts.md` 与勘误 §3.24）。路径两道守卫（工作区边界 + 拒绝绝对路径/`..`），并开 `GIT_LITERAL_PATHSPECS` 防 pathspec 通配注入 | ✅ | P1 |
| DR-12 | 状态机文案完整 | 可见 | 部分 | 🟡 | P2 |

## 5. Composer / 扩展 / 设置

| ID | 指标 | 参照 | KCode | 状态 | 优先级 |
|---|---|---|---|---|---|
| CS-01 | 底行上下文芯片 | 前提可见 | chips | ✅ | — |
| CS-01b | 输入框：多行自适应 + ↑ 历史回溯 | 规格 04 §4.5 | **已落地**：`composerHistory.ts`（纯函数，20 项测试含草稿往返/边界）；方向键**只在光标处于首/末行时接管**，不抢多行文本导航 | ✅ | P1 |
| CS-01c | 输入框视觉：图标化发送/停止 + 自绘下拉 | — | **已落地**：发送键由字符 `↑` 改为 `arrow-up` 图标、停止键由 CSS 方块改为 `stop` 图标；模型/强度由原生 `<select>`（macOS 浅色系统面板）改为自绘 `MenuSelect`（portal + 键盘导航）；`menu-select.test` 与 composer DOM 测试覆盖 | ✅ | P1 |
| CS-02 | 模型后端查询 | 非硬编码 | models | ✅ | — |
| CS-03 | effort 与模型并列 | 深度 | EFFORT_LABEL | ✅ | — |
| CS-04 | 运行中停止 | 可中断 | onStop | ✅ | — |
| CS-05 | 附件结构化发给模型 | 上下文 | 网页元素走 `serializeWebElements`（文本）；**图片走协议 `localImage`（路径）** | ✅ | — |
| CS-05b | 图片附件：拖入 / 粘贴 | 规格 04 §4.5 | **已落地**：拖放（Tauri 直接给绝对路径，不落盘）与粘贴（剪贴板只有字节，经 `save_attachment` 落盘）双通道；类型白名单 + 20MB 上限 + 缩略图预览 + 拒绝原因 `role=alert`。`attachmentImage.ts` 15 项纯函数测试（边界 ±1 字节、非图片类型、保序）；e2e 对真 app-server 验证 `localImage` 形状 | ✅ | P1 |
| CS-06 | Slash `/review` `/commit`… | 命令映射 | **`/compact` 已落地**（`thread/compact/start`，e2e 对真 app-server 验证参数形状）；未知命令按普通文本发送（不做假命令，见 CS-11） | 🟡 | P1 |
| CS-07 | AGENTS.md 预览 | 扩展层 | **无** | ❌ | P1 |
| CS-06b | `@` 引用工作区文件 | 规格 04 §4.5 | **已落地**：`fuzzyFileSearch` → `searchFiles` → 输入框 `@` 候选（防抖 120ms、键盘导航、Esc 只关列表）；`atQueryAt` 纯函数 8 项测试**专防邮箱地址误触发**；协议细节见 `protocol-facts.md`（该方法用 snake_case，与其余方法不同） | ✅ | P1 |
| CS-08 | Skills user/repo 分组 | skills/list | Library | ✅ | — |
| CS-09 | 插件列表 | plugin/list | Library | ✅ | — |
| CS-10 | 设置=实际生效+路径 | 可排查 | Settings | ✅ | — |
| CS-11 | 无死开关 | 纪律 | 已遵循 | ✅ | — |
| CS-12 | MCP 列表 | 扩展层 | **无列表 UI**（`mcpServerStatus/list` 已可用，实测本机返回 0 个 server——未配 MCP）。**关于「内置能力」（自动核验页面样式 / 自动调 CDP）的实测结论见下方「内置工具面的实测」一节** | 🟡 | P2 |

## 6. 右栏场景

| ID | 指标 | 参照 | KCode | 状态 | 优先级 |
|---|---|---|---|---|---|
| SC-01 | 终端 command/exec+tty | 同环境 | Terminal | ✅ | — |
| SC-02 | 地址栏回读真实 URL | 一致 | Browser | ✅ | — |
| SC-03 | 本地 http / 公网 https 补全 | 防空白页 | urlScheme+测试 | ✅ | — |
| SC-04 | 视口适应窗口+预设 | 窄栏可用 | viewportSize+测试 | ✅ | — |
| SC-05 | 选网页元素→附件（远程页无 IPC） | 安全 | onPick | ✅ | — |
| SC-06 | 文件树协议 fs/readDirectory 懒加载 | 同沙箱 | FileTree | ✅ | — |
| SC-07 | 文件详情失败可重读 | 可靠 | attempt | ✅ | — |
| SC-08 | 进程步骤+状态标签 | 进度 | ProcessPanel | ✅ | — |
| SC-09 | 右栏随工作内容自动联动 | command center 定位 | **已落地**：`hooks/sceneFollow.ts` 定义信号优先级（子代理 > 变更审阅 > 浏览器）与跟随状态机；**用户手动点任何场景标签即退出跟随**（抢画面比不联动更烦人），点「跟随」可恢复并立刻跳到最该看的地方；换线程自动恢复跟随。13 项纯函数测试覆盖「什么时候不切」的四条理由。指示器常驻标签栏，避免「自动切换为什么停了」成为无从察觉的状态 | ✅ | P1 |
| SC-10 | 子代理会话可在右栏查看 | 参照 `subagents.panel` | **已落地**：新增「子代理」场景（有子代理时才可进），列出各代理的状态与委派任务，点进去看该代理的**完整会话时间线**（协议 `thread/read`，与主线程共用同一套渲染）。三态如实区分：加载中 / 读不到（说明原因，不给假的重试承诺）/ 读到但无内容。有代理在跑时标签带活动点 | ✅ | P1 |
| SC-09 | 多平台模拟器展示 | MiMo 侧栏「模拟器」 | **已落地（四平台）+ 工具路径自动发现与手动兜底**（§3.35）：平台标签（Android / iOS / 鸿蒙 / 小程序，**不可用的也列出**并附原因与安装指引）+ 设备列表（**型号 · 系统版本 · 分辨率 · abi/dpi**，按状态区分「运行中/未启动/离线/未授权」）+ 实时画面。Android **全链路已验证**（`emulator -avd` 启动、`adb screencap` 单帧 350ms、`input tap/swipe` 触控、返回/主屏）；iOS 用 `simctl` 启动与截图（**无触摸命令**，画面只读并在界面写明原因）；鸿蒙识别 `hdc` 与连接设备，取画面/触摸**未在真机验证**（如实标注）；小程序走开发者工具自动化（**截图 + 元素点击**；实测无坐标输入，故给元素列表而非可点画面）。**能力位驱动界面**：`canLaunch`/`canInput` 为 false 时**不画按钮**（不给空入口）。**触控回传**：`pointerdown/move/up` → `simulatorGesture` 判定点击/滑动（阈值 6px、时长夹紧 50–1000ms）→ `adb shell input`；输入后立即补帧，点击有落点标记、拖动有轨迹线。**工具路径**：查找顺序「手动指定 → 环境变量/系统选中 → 约定位置 → 应用目录扫描（含外置卷）」；装在外置盘/改过名时可在面板内「自定义工具路径」直接指定，保存即生效并自动重检；iOS 以注入 `DEVELOPER_DIR` 使用**解析出的那份 Xcode**（不改系统 `xcode-select`）。后端 59 项 + 前端 21 项测试 | ✅ | P2 |

## 7. 反馈与微交互

| ID | 指标 | 参照 | KCode | 状态 | 优先级 |
|---|---|---|---|---|---|
| FB-01 | 状态色语义统一 | 一致 | status-chip | ✅ | — |
| FB-02 | 空态无占位噪音 | 降噪 | dock 条件 | ✅ | — |
| FB-03 | SVG 非 emoji | 跨平台 | Icon | ✅ | — |
| FB-04 | 快捷键真实注册 | 可按可用 | 仅文案 | ❌ | P1 |
| FB-05 | 长任务可停且状态不丢 | 中断 | Stop+溯源 | 🟡 | — |
| FB-06 | 错误可读文案 | 不吞错 | `extractErrorMessage`（Tauri 的 `invoke` 抛的是**反序列化对象**，不是 Error 实例——朴素写法会显示 `[object Object]`，实测踩过）。**静态检查覆盖全仓**：禁止 `instanceof Error ? x.message : String(x)` 与 `String(err)` 两种朴素模式，只允许 helper 自身的兜底分支；守卫用注入真实模式验证过会报错。9 项 helper 测试（逐种抛出形态） | ✅ | — |
| FB-07 | WKWebView 右键有兜底 | 真机 | DOM 测试 | ✅ | — |
| FB-08 | 待审批全局角标 | 指挥台 | 仅侧栏 | 🟡 | P2 |

## 8. 视觉基线（来自 `docs/codex-style-agent-desktop-spec/08` 第 33–39 条）

> 这一节整段取自解包实测的三家客户端（Codex / MiMo / ZCode）的推荐基线值。
> 标注「偏离」的项是我们刻意保留的差异，理由写在备注里。

| ID | 检查项 | 基线值 | KCode | 状态 |
|---|---|---|---|---|
| VS-01 | 暗色底不是纯黑 | `#0a0a0a`–`#181818` | `#0a0c11`（深空蓝黑） | ✅ |
| VS-02 | 对话正文 > UI 正文 | 16px vs 14px | 15px vs 13.5px（按我们的 UI 基数等比，非照搬绝对值） | ✅ |
| VS-03 | 全局只有一处高饱和强调色 | — | `--accent` 一处；ok/warn/danger/violet 为语义色（非装饰） | ✅ |
| VS-04 | 代码区沿用既有配色约定 | VS Code Dark+ | 未自创，用 token 变量 | ✅ |
| VS-05 | 圆角由单一 scale 变量控制 | `--corner-radius-scale` | `--corner-scale` 已生效：`--r-xs/sm/md/lg/xl` 全部乘该变量；43 处小控件裸值 + 等值中大值已令牌化。保留 999px（胶囊）与 2px（发丝线）不缩放——语义上必须固定 | ✅ |
| VS-06 | 侧栏可折叠，宽 256 / 62px | 256 / 62 | `minmax(240px,340px)` 可拖拽；折叠到 0 而非 62px 图标栏（偏离，见备注） | 🟡 |
| VS-07 | Markdown 已净化，无 XSS | — | 未启用 `rehype-raw`，原始 HTML 不渲染 | ✅ |
| VS-08 | 工具输出超阈值折叠 | 30KB | `foldOutput()` 30k 字符，**保留尾部**（关键信息在末尾） | ✅ |
| VS-09 | 自动滚动不抢用户滚动条 | — | `autoScroll.ts` + `useAutoScroll`，上滑即停并出「回到底部」 | ✅ |
| VS-10 | 工具调用卡片默认折叠 | — | ToolRow 默认折叠 | ✅ |
| VS-11 | 内容沉浸到顶部导航之下 | Codex toolbar 在 y=0，内容从其下穿过 | 中栏顶栏改**浮动**（absolute + 底部渐隐 + backdrop 模糊），`.main` 不再让出 40px 标题栏带；顶部留白做在滚动容器内边距上（随内容滚走，内容才能穿过） | ✅ |
| VS-12 | 自建图标集（非拼凑） | 三家均为自有图标 | `Icon.tsx` 35 枚（原 30 + `new-chat`/`chat`/`diff`/`panel-left`/`panel-right`）：16×16 网格 + 统一描边 + JSX 片段（`rect rx`/`circle r` 保证圆角）；规范由 `__tests__/iconSet.test.ts` 9 项守卫；每个图标均渲染成图目视核验（修正 `edit` 曾像匕首、`wrench` 曾像放大镜/棒棒糖、面板开关曾经的裸 chevron 旋转） | ✅ |

**VS-06 偏离理由**：折叠到 0 是我们当前的行为，实测可用（顶栏有显式开关按钮
与 ⌘B 快捷键，不会出现「关了就打不开」）。但确实不如 62px 图标栏——折叠后
侧栏内容整体消失，切换任务必须先展开。实现图标栏需要一套「项目/线程的图标
化表示」，属于独立设计工作量，列为待办而非缺陷。

**接手线索**：宽度由 CSS 变量 `--col-left`（`minmax(240px, var(--col-left-w, 340px))`）
驱动，折叠态在 `.app.left-collapsed` 里把它收到 `minmax(0px, 0px)`。改图标栏只需把
该值改为 62px 并让 `.sidebar` 内部按折叠态切换布局（品牌标记保留、导航项只留图标、
项目/线程折叠为单列点阵），不需要动 JS 逻辑。

---

## 本次会话总结（2026-09-22）

一天内完成批次 1 全部 + 视觉基线与若干新能力。**每项都是做完即测试、即提交推送**，
所以本文件之外的进度不需要额外交接——`git log` 就是逐项记录。

### 修复的真缺陷（都是查证出来的根因，不是表面修补）

| 缺陷 | 根因 | 留下的防线 |
|---|---|---|
| dev 启动黑屏 | `ThreadRow` 引用父作用域 `renames`；Vite 只转译不检查类型 → 渲染即抛错、React 整树卸载 | 侧栏渲染测试 + `App` 整树挂载测试 |
| **长会话打开卡顿（O(n²)）** | `openThread` 逐条 `reduce`，而每次内部都有 `includes` 扫描。实测 6000 条 **4703ms** | `rebuildThread` 一次扫描（**1.3ms，3738×**）+ 等价性断言 |
| 已完成对话跟着新对话更新 | `TurnView` 只排除当前轮次的 itemIds → 新轮次流式内容出现在每个历史轮次下 | `streamTurn` 精确归属 + 组件级多轮渲染测试 |
| 预览卡片落点错位 | `position: fixed` 被祖先 `transform` 劫持（top 350→645） | 定位约束静态检查（容器不得有 transform） |
| 权限危险档悬浮混色 | `:hover:not(:disabled)` 特异性 (0,3,0) 压过 `.is-danger` (0,2,0) | 特异性静态检查 |
| 输入框与正文错位 | 栏宽/内边距/滚动条三处数值不一致（差 6/15px） | 三值同源检查（共用 `--read-width` / `--gutter-left`） |
| `fuzzyFileSearch` 文件名空 | 该方法用 **snake_case**（`file_name`），与协议其余方法不同 | 真机形态探针（e2e） |
| `adb input` 报 unknown command | `input` 是设备命令，必须经 `shell` 转发 | 真实工具链 live 测试 |

### 新增能力

- **护栏信号接入**（此前被静默丢弃）：`guardianWarning` → 置顶横幅（安全信号不可被收起）；`tokenUsage` → 上下文余量（≥70% 才出现，对齐上游压缩线）；`compacted` → 落库。
- **对话导航条**：每轮一根横条，悬停预览、点击跳转。性能上五道闸（不测 DOM、只用 transform、节点封顶 150、不做 scroll-spy、只读 state）。
- **输入区重做**：发送/停止改图标、自绘下拉（替换系统原生 select）、↑ 历史回溯、`@` 引用工作区文件、`/compact`。
- **图片附件**：拖入 + 粘贴（协议 `localImage`，剪贴板需先落盘）；时间线消息内的图片预览与全屏查看。
- **模拟器场景（四平台）**：按平台标签分组，设备条目给出**型号与系统版本**（这是多平台并存时「要看哪个」的依据）；Android 走 adb 全链路（启动/画面/触控），iOS 走 simctl（画面可看、无触摸）、鸿蒙识别 hdc、小程序如实说明未接入。设备身份与句柄分开（`id` 是 AVD 名用于启动，`runtimeId` 是 adb serial 用于取帧——两者无可推导关系）。
- **图标集 35 枚**全部重绘（16×16 网格 + 统一规范），并逐个渲染成图目视核验。

### 刻意的不做（有依据，非遗漏）

- **不展示推理内容**：实测参照客户端（Codex.app 的 asar）完全不展示，`reasoning` 只出现在模型配置。理由与回退方案见下节「与外部规格的偏离」。
- **不做 scroll-spy**（导航条不指示「当前在第几轮」）：那要么遍历轮次元素、要么维护观察器集合，都会随会话变长而变重。
- **worktree 标签**未做：无数据源（worktree 创建本身未实现），如实标注而非编造字段。

### 仍未做（按优先级）

1. **VS-06 侧栏折叠 62px 图标栏**（需一套项目/线程的图标化表示）
2. **真正的「侧边聊天」**（右栏内独立的输入区 + 时间线 + 第二条线程）：现「库」场景只放技能/插件/设置，侧边聊天尚未实现（见上方改名记录）
2. **批次 2 剩余**：CS-06+FB-04 命令面板与快捷键注册、IA-06 新建任务三档
3. **批次 3**：CS-07 AGENTS.md 预览、CS-12/AP-09/AP-10 Phase2、IA-13/FB-08 多项目与全局角标
4. **图片附件未覆盖**：粘贴/拖入之外，截图工具直接对接（如系统截图后自动进附件）
5. **模拟器未覆盖**：iOS 取画面与鸿蒙全链路（本机分别缺完整 Xcode 与鸿蒙设备，代码已就位但**未验证**）、小程序的**滑动与多指**（自动化接口 `Page.touchstart` 未实现，非本应用遗漏）、页面数据读取（`Page.data` 未实现）、iOS 触摸（需 WebDriverAgent）、滑动**惯性**、多指手势、音频

> DR-09/10/11 已于 2026-09-23 落地（见第 4 节），故从本清单移除。
>
> **场景改名记录**：`chat`「侧边聊天」→ `library`「库」。它渲染的一直是
> 技能/插件/设置，而 `scenes.ts` 早先的注释还写着「同一 app-server 的另一条
> 线程」——菜单承诺了一个不存在的能力（真正的侧边聊天需要在右栏里再放一套
> 输入区与时间线，是独立工作量）。改名反映实际内容，该项列入下方「仍未做」。

## 本次会话总结（2026-09-23）

批次 2 的第一项：**变更审阅的出口能力**——行内评论（DR-09）、
外部编辑器与跳行（DR-10）、撤销单文件变更（DR-11）。

### 一个必须记账的协议发现

落地方案 §3 写着「撤销变更可使用 `thread/revert`」，**这个假设是错的**。
锁定版本的 schema 原文：`thread/revert` 只替换**会话历史**，
"This only changes persisted conversation history. It does not revert local file changes."；
已废弃的 `thread/rollback` 更直白——"Clients are responsible for reverting these changes."

后果如果没查：用户点「撤销」会拿到成功响应、文件一字未变（接口成功、
状态未变，最难排查的一类）。因此撤销改由 git 层实现，并已记入
`docs/protocol-facts.md` 与勘误 §3.24，避免下次有人再从方法名推断语义。

### 顺带修掉的一个既存缺陷

`docs/protocol-facts.md` 里有 4 个章节（`fuzzyFileSearch` 的 snake_case、
图片输入形态、`thread/compact/start`、模拟器工具链）**只存在于产物里，
不在生成器里**——重跑 `node scripts/protocol-facts.mjs` 会把它们整段删掉，
而 CI 正是用「生成后 diff 是否为空」判定，等于那几刀提交后 CI 应判红。
已把这些章节移入 `scripts/protocol-facts.mjs`，并留了一行注释说明**为什么
补事实必须改生成器而不能只手改产物**（这个坑真的踩过一次）。

### 关键设计取舍

- **两种评论意图不合并**：合并会让用户标注的「5 行说明」被模型当成「5 处要改」。
  序列化时按文件分组、组内按行号排序，并在每份文件块开头写清「几处要改、
  其余仅为说明」。
- **评论状态提升到 `App`**：留在 `DiffViewer` 里时，切场景或切线程会卸载组件、
  评论全丢——而丢了不报错，只会让用户白写一遍。
- **撤销的确认文案写清两种后果**：未跟踪文件是删除、不可找回，笼统的
  「确定吗」不足以让人做判断。
- **编辑器不支持跳行时不假装支持**：兜底的系统默认编辑器收到 `路径:行`
  会当成文件名，于是「打开失败」看起来像文件被删了。

### 验证方式

- Rust：`kcode-bridge` 63 项（含撤销的 8 种状态分派与路径守卫 **7 项**、
  编辑器参数形状 12 项，其中一个测试**真的拉起一个假编辑器**验证
  「探测 → 拼参数 → spawn」整条链路，避免三段各自正确但接起来出错）。
- 前端：`reviewComments` 19 项纯函数 + `diffComments` 10 项组件交互
  （覆盖意图选择、清空即删除、Esc/⌘↩、并排视图共用同一套锚点）+ `composer`
  的 `pendingText` 通道 3 项（**追加而非覆盖**，否则会悄悄删掉用户已写的内容）。

## 本次会话总结（2026-09-23 续）

按「对话区是否有参照客户端那种详细工具展示」的核查结论，四项里**三项落地、一项刻意不做**。

### 落地

| 能力 | 关键实现 | 为什么这样做 |
|---|---|---|
| **整轮耗时 + 工作详情** | 协议 `Turn.durationMs` → 事件 → `TurnState` → 收尾行 `已处理 13 分 20 秒 ⌄`；展开是本轮动作计数与变更文件 | **不由前端计时**：本地从 turnStarted 起算会把网络往返与排队算成「工作时长」。协议未提供时不显示——不编数字。重启后仍在（`TurnSnapshot` 从事件日志重建该字段） |
| **子代理活动** | 解析 `tool`/`status`/`receiverThreadIds`/`agentsStates`/`prompt`，按来源分派渲染；协议取值全部映射中文 | 此前只存协议类型名，界面显示「协作：collabAgentToolCall」——既是术语泄漏，又把「谁在干、什么状态」全丢了。实测 `multi_agent` 默认启用，这些信息本来就有 |
| **连续动作聚合折叠** | `toolGrouping.ts`：同类且连续才合组，单条不成组，失败/拒绝一律不聚合 | 一轮常连做十几个小动作，逐个占一行会淹没模型结论；而把异常收进摘要等于藏起来 |
| **工具行「在右栏查看」** | `imageView` 的路径改为可点（此前是不可点文本）+ 显式入口按钮 | 会话里「当时看了哪张图」正是事后最想确认的东西 |

### 刻意不做：自动抢右栏场景

Agent 起了终端/browser 就自动切右栏——**不做**。理由：那会打断用户正在看的 diff，而切场景的代价由用户承担（要再切回来）。参照客户端也多是「提示可查看」而非强切。改为在工具行给显式入口，主动权留给用户。

### 顺带修掉的四处

- **活动指示重复**：工具行已写「正在执行」（`--t1` + 600 字重 + 扫光，很醒目），下面又跟一行 `--t4` 的「正在处理」——同一件事说两遍，而后者几乎看不见。改为仅在「没有任何工具行在跑」时显示（那时它是唯一活动指示，配合闪烁光标）。
- **两个死类名**：流式回退块用的 `.item-card` / `.agent-message` 在样式表里 0 条规则。改用真实存在的 `.bubble.agent`，顺带消除回复开始与落地之间的一次 10px 间距跳变。
- **轮间距未令牌化**：26px 是 `.turn` 里的裸值 → `--turn-gap`（与圆角/栏宽同一套做法）。
- **时长格式化的进位缺陷**：测试抓出 `59_900ms` 会显示成「60s」（该进位为 1 分）。修了秒→分与分→小时两级连续进位。

### 验证方式

纯函数测试钉住「不会报错但会显示错」的地方：`duration` 9 项（含两处进位边界）、`toolGrouping` 21 项（分组规则、文案映射逐个取值）、`turnExtras` 11 项组件行为（耗时展示/展开、活动指示不重复、子代理文案不含协议术语、聚合默认折叠、失败命令不折叠）。Rust 侧 3 项新增（两个协作 item 形状各自解析 + 缺字段不编造）。

参照客户端比对仍有实据：Codex.app 的 `Turn` 自带 `durationMs`，其时间线也是「折叠摘要 + 展开明细」的结构。


## 落地顺序

**批次 1（P0）** ✅ 已完成（2026-09-22）  
1. IA-04 Thread 行：变更数 Δ + 模型徽标（worktree 标签无数据源，见 IA-06）  
2. IA-05 Thread 重命名/置顶/归档菜单（fork 待做）  
3. AP-07/AP-08 审批作用域矩阵 + id 链路  

> 批次 1 同时修掉一个真机缺陷：`ThreadRow` 引用父作用域 `renames`
> 导致 dev 启动黑屏（Vite 不跑类型检查，React 整树卸载）。
> 已补两道防线：`__tests__/sidebar.test.tsx`（侧栏渲染）与
> `__tests__/appMount.test.tsx`（整树挂载，捕获渲染期异常）。

**批次 2（P1）**  
4. ~~DR-09/10/11 行内评论、外部编辑器、撤销~~ ✅ 已完成（2026-09-23）  
5. CS-06+FB-04 命令面板+快捷键注册  
6. ~~CH-08 Turn 耗时/token~~ → **上下文余量已落地**（见 CH-08 行）；单轮耗时与成本待做  
7. IA-06 新建任务三档（Cloud 可占位）  

**批次 3（P1/P2）**  
8. CS-07 AGENTS.md 预览  
9. CS-12/AP-09/AP-10 Phase2  
10. IA-13/FB-08 多项目与全局角标  

## 验收约定

- 每项：改组件 + 测试（优先纯函数，仿 dockVisibility/scenes）  
- 协议先查 `docs/protocol-facts.md`，不编方法名  
- 完成后本表状态改 ✅ 并写组件路径  

## 与外部规格的偏离

以下条目我们**刻意不按** `codex-style-agent-desktop-spec` 实现，理由与实测依据在此登记：

| 规格条目 | 规格说法 | 我们的做法 | 依据 |
|---|---|---|---|
| 04 §4.5「思考过程」 | 可折叠的推理区（若有），默认折叠 | **完全不展示推理** | 该规格是对「三家解包结果的通用建议」，但实测 Codex.app 自身并不展示：其 asar 里 `reasoning` 仅出现在模型配置（`reasoning_effort`），无任何推理内容 UI。且推理每轮一条、与工具调用交替，展开让时间线长度翻倍，而判断「它做了什么、对不对」看的是命令与 diff |

> 偏离不等于更好：若将来有用户反馈「想知道模型怎么想的」，可加回为默认折叠、
> 且只在用户主动展开时请求（而非默认渲染几十条）。当前选择的理由是
> **信息密度**——时间线要能让用户扫出「哪一步在跑、哪一步失败了」。

## 内置工具面的实测（2026-09-23）

> 起因：「ZCode / Codex 有好多内置能力让对话自动调用（自动核验页面样式、自动调 CDP），我们有吗？」
> 这个问题的答案**不能靠读 codex 的二进制字符串推断**，我实测了三次，结论如下。

### 实测方法

在**真实 app-server 进程内**捕获模型收到的 `tools` 数组——这是唯一权威来源
（`debug prompt-input` 是另一条代码路径，两者结论不同，见下）。

### 结论：本机环境下，模型可见的工具只有 9 个

```
exec_command, write_stdin, request_user_input, view_image,
multi_agent_v1, get_goal, create_goal, update_goal, web_search
```

**没有 `browser_use`、没有 `computer_use`、没有 CDP 相关工具。**

### 为什么没有（关键）

codex 二进制里确实有这些能力（`browser_use` / `browser_use_full_cdp_access` /
`computer_use` / `in_app_browser` 在 `experimentalFeature/list` 里全是
**stable + enabled + default**）。但它们的注入走的是 `hosted_model_tool_specs`
这条路径——**「hosted tools」由服务端配置决定，不是本地开关**。

本机实际用的是 **第三方 custom provider**（`requires_openai_auth = false`
带 `base_url` 指向本地中转）。这类 provider 下 hosted tools 不注入，
所以模型看不到它们。

**这与我们客户端无关**：那 9 个工具是 app-server 直接给模型的，
每次调用都以 `commandExecution` / `collabAgentToolCall` / `webSearch` 等
Item 回到时间线，而那些**我们已经渲染好了**。所以：

- **要做**的只有「把回来的 Item 显示清楚」——本次完成的参数/结果分区与复制即属此类；
- **不该做**的（也做不到）是「自己实现浏览器核验 / CDP」——那是 provider 侧的能力，
  我们既无法注入工具，也没有必要重造。

### 一处需要留意的差异

`debug prompt-input` 给出的清单里 `browser` 出现、`computer_use` 不出现，
而 app-server 内捕获的清单两者都不出现。**两条路径的清单不一致**，
所以判断「模型实际能用什么」必须用 app-server 内捕获，不能拿 `debug`
子命令的输出去推断。

### 若想启用这些能力

换用官方 OpenAI provider（`requires_openai_auth = true` + 官方端点）后
hosted tools 才会注入。这是一条**环境要求**而非代码改动，已如实记在此处，
免得下次有人以为是我们漏接了。

## 参照

| 对象 | 路径 |
|---|---|
| Codex 桌面 | `/Volumes/data1/work/office-applications/Codex.app` |
| ZCode 桌面 | `/Volumes/data1/work/office-applications/ZCode.app` |
| 范式研究 | `docs/archive/codex_paradigm_research.md` |
| 落地方案 | `docs/KCode落地方案.md` §3、§7 |
| 当前 UI | `src/components/*`、`src/styles.css` |
