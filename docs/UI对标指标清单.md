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
| CH-02 | 推理可折叠 | 细节可展开 | thinking details | ✅ | — |
| CH-03 | 工具/命令紧凑单行可展开 | 成熟客户端 | ToolRow | ✅ | — |
| CH-04 | declined≠completed 视觉 | 实测语义 | chip 未执行 | ✅ | — |
| CH-05 | Turn 状态齐全 | 状态机 | TurnView | ✅ | — |
| CH-06 | unknown 不静默当成功 | 恢复 | unknown-note | ✅ | — |
| CH-07 | 流式增量+光标 | delta | streamBuffer | ✅ | — |
| CH-08 | Turn 耗时/token/成本 | 执行反馈 | **上下文余量已落地**：`thread/tokenUsage/updated` → `contextUsage()` 纯函数 → StatusDock 条形+百分比（仅 ≥70% 时出现，对齐上游压缩线）；仍缺单轮耗时与成本 | 🟡 | P1 |
| CH-09 | 中途停止/追加 | 可介入 | Stop 有 | 🟡 | — |
| CH-10 | 路径点击→右栏详情 | 跳转 | onOpenFile | ✅ | — |

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
| DR-09 | 行内评论（仅上下文 vs 要改） | 点击行 | **无** | ❌ | P1 |
| DR-10 | 外部编辑器/跳到行 | 审阅 | **无** | ❌ | P1 |
| DR-11 | 撤销单文件变更 | 回退 | **无** | ❌ | P1 |
| DR-12 | 状态机文案完整 | 可见 | 部分 | 🟡 | P2 |

## 5. Composer / 扩展 / 设置

| ID | 指标 | 参照 | KCode | 状态 | 优先级 |
|---|---|---|---|---|---|
| CS-01 | 底行上下文芯片 | 前提可见 | chips | ✅ | — |
| CS-02 | 模型后端查询 | 非硬编码 | models | ✅ | — |
| CS-03 | effort 与模型并列 | 深度 | EFFORT_LABEL | ✅ | — |
| CS-04 | 运行中停止 | 可中断 | onStop | ✅ | — |
| CS-05 | 附件结构化发给模型 | 上下文 | serialize+测试 | ✅ | — |
| CS-06 | Slash `/review` `/commit`… | 命令映射 | **无** | ❌ | P1 |
| CS-07 | AGENTS.md 预览 | 扩展层 | **无** | ❌ | P1 |
| CS-08 | Skills user/repo 分组 | skills/list | Library | ✅ | — |
| CS-09 | 插件列表 | plugin/list | Library | ✅ | — |
| CS-10 | 设置=实际生效+路径 | 可排查 | Settings | ✅ | — |
| CS-11 | 无死开关 | 纪律 | 已遵循 | ✅ | — |
| CS-12 | MCP 列表 | 扩展层 | 无 | ❌ | P2 |

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

## 7. 反馈与微交互

| ID | 指标 | 参照 | KCode | 状态 | 优先级 |
|---|---|---|---|---|---|
| FB-01 | 状态色语义统一 | 一致 | status-chip | ✅ | — |
| FB-02 | 空态无占位噪音 | 降噪 | dock 条件 | ✅ | — |
| FB-03 | SVG 非 emoji | 跨平台 | Icon | ✅ | — |
| FB-04 | 快捷键真实注册 | 可按可用 | 仅文案 | ❌ | P1 |
| FB-05 | 长任务可停且状态不丢 | 中断 | Stop+溯源 | 🟡 | — |
| FB-06 | 错误可读文案 | 不吞错 | extractError | ✅ | — |
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

---

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
4. DR-09/10/11 行内评论、外部编辑器、撤销  
5. CS-06+FB-04 命令面板+快捷键注册  
6. CH-08 Turn 耗时/token  
7. IA-06 新建任务三档（Cloud 可占位）  

**批次 3（P1/P2）**  
8. CS-07 AGENTS.md 预览  
9. CS-12/AP-09/AP-10 Phase2  
10. IA-13/FB-08 多项目与全局角标  

## 验收约定

- 每项：改组件 + 测试（优先纯函数，仿 dockVisibility/scenes）  
- 协议先查 `docs/protocol-facts.md`，不编方法名  
- 完成后本表状态改 ✅ 并写组件路径  

## 参照

| 对象 | 路径 |
|---|---|
| Codex 桌面 | `/Volumes/data1/work/office-applications/Codex.app` |
| ZCode 桌面 | `/Volumes/data1/work/office-applications/ZCode.app` |
| 范式研究 | `docs/archive/codex_paradigm_research.md` |
| 落地方案 | `docs/KCode落地方案.md` §3、§7 |
| 当前 UI | `src/components/*`、`src/styles.css` |
