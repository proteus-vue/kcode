# KCode

本地优先、可审计、可恢复的 AI 编程 Agent 桌面控制台。

基于 **Tauri 2** + OpenAI 开源 **`codex app-server`** 协议（Apache-2.0），不自研 Agent loop。

> **核心主张**：不是功能比谁多，而是**你能验证我在做什么**——
> 开源客户端、零静默上传、可导出审计、本地优先，且协议行为由 CI 持续验证。
>
> *（「由 CI 持续验证」这句曾是过度承诺：CI 有 18 次推送因 workflow 文件无效
> 而一次都没执行过。2026-09-23 修复后才第一次名副其实，当前状态见下方。）*

---

## 当前状态

**Phase 0（协议验证）与 Phase 1（最小可恢复闭环）的骨架已完成**，全部由本仓库脚本与测试自动执行：

| 层 | 内容 | 状态 |
|---|---|---|
| — | CLI 版本锁定 + 哈希校验（安全基线 0.39.0） | ✅ 0.155.1 |
| — | 协议 schema + TS 绑定冻结、漂移检测 | ✅ 313 + 721 文件 |
| — | 端到端协议契约（Node，3 个脚本） | ✅ |
| **L1** | 适配层 `codex-bridge`：JSONL 拆包、三类报文分流、审批应答 | ✅ |
| **L2** | 领域层 `kcode-domain`：模型、风险分级、事件溯源、审计 | ✅ |
| **L0** | 编排层 `kcode-app`：actor 服务、领域事件、崩溃恢复 | ✅ |
| — | 变更集与 Diff：两通道解析、kind-aware 统计、审阅状态机 | ✅ |
| — | 验收测试：崩溃恢复、审批语义、长输出、并发隔离 | ✅ |
| **L0** | 宿主层 `kcode-desktop`：Tauri 2 薄壳 + commands/events | ✅ 编译通过 |
| **L3** | React 前端：**液态玻璃三栏 UI**、审批弹窗、Diff 审阅、流式输出、Markdown、模型选择 | ✅ |

<!-- test-stats:begin -->
合计 **284 项 Rust 测试 + 463 项前端测试 + 56 项协议契约断言**——
数字由 `scripts/test-stats.mjs` 实际运行统计，明细见 [`docs/test-stats.md`](docs/test-stats.md)。
<!-- test-stats:end -->

测试数字不在本文件里手工维护：`scripts/test-stats.mjs` 会真的跑一遍全部测试再统计，
CI 比对其结果与本文、`docs/test-stats.md` 是否一致（与协议事实清单同一套做法）。

**Phase 1 验收报告**见 [`docs/Phase1验收报告.md`](docs/Phase1验收报告.md)——
含已验证项、**未执行项（如实记录）**，以及一处与预期不符的安全发现。

尚未做的：真实模型验收（需凭据，见下方脚本）、worktree 创建与分支状态、
`thread/resume`·`thread/fork` 生命周期（`thread/archive` 与重命名已落地），
以及 Phase 2 的 granular approvals、`auto_review`、MCP、命令面板与快捷键注册。
实施计划见 [`docs/KCode落地方案.md`](docs/KCode落地方案.md)；
UI 对标的逐项状态见 [`docs/UI对标指标清单.md`](docs/UI对标指标清单.md)。

> **CI 状态（2026-09-23 起如实记录）**：CI 因一处 `if:` 表达式失效，
> **从项目第一次提交起从未真正执行**（18 次推送全部空跑，详见
> [`docs/协议勘误与修正.md`](docs/协议勘误与修正.md) §3.25）。
> 修复后首次真跑，并逐步排掉沿途暴露的问题（跨平台哈希、测试环境依赖等）。
>
> 当前：**`verify` 与 `web` 全绿**（协议漂移、协议事实清单、codex 哈希、
> 端到端契约、前端单测、类型检查、构建）；`rust` 的**单元测试通过**，
> 仍有 4 个集成测试在 Linux 上失败（§3.27 / §3.28）。
> 已用对照实验排除的原因：沙箱前提、shell 工具名、zsh 缺失。
> **本机（macOS）全部测试通过**——这是平台差异，不是本地可复现的问题；
> 下一步的判据是 `scripts/probe-exec.mjs` 在 CI 上的输出（与失败用例同构）。

---

## 快速开始

```bash
npm install                  # 安装锁定依赖（含 codex 平台二进制）
npm test                     # 版本校验 + 协议契约 + 前端单测
cargo test --workspace       # Rust 全量测试
npm run tauri dev            # 启动桌面应用
```

**全程离线、零凭据**：契约测试用本地 mock provider 冒充模型，不访问外网、不需要 API key、不污染你真实的 `~/.codex`（通过 `CODEX_HOME` 隔离，并校验 `initialize` 回传的 `codexHome`）。

预期输出：三个契约脚本各自 `N/N 通过`，Rust 与前端全绿——具体数字见
[`docs/test-stats.md`](docs/test-stats.md)（自动生成）。

---

## 架构

L1 适配层（`crates/codex-bridge`）**刻意不依赖 Tauri**：它的职责是吸收官方协议的版本漂移，与宿主层解耦既符合分层设计，也让测试不必拉起整个桌面壳。

```
L3  展示层   React 18 + TypeScript        ← src/（已实现）
L2  领域层   Thread/Turn/Item/Approval     ← crates/kcode-domain（已实现）
L0  编排层   AgentService（actor）         ← crates/kcode-app（已实现）
L1  适配层   ProtocolAdapter + JsonlTransport ← crates/codex-bridge（已实现）
L0  宿主层   Tauri 2 窗口/进程/文件系统/keychain ← crates/kcode-desktop（已实现）
```

每层的关键设计：

- **JSONL 拆包**：按换行边界切分，容忍任意分块与 CRLF，超长行报错而非无界吃内存
- **三类报文分流**：响应 / 服务端请求 / 通知——混用会导致审批静默挂起
- **审批应答**：直接回应服务端请求的 `id`（协议中不存在 `approval/resolve`）
- **`CODEX_HOME` 隔离**：拒绝以用户真实 `~/.codex` 启动，并校验握手回传值
- **风险分级**：协议不提供风险字段，`RiskClassifier` 为自研；**只影响展示与排序**
- **actor 编排**：读侧与写侧分离，命令与事件可并发（共享锁会死锁）
- **事件溯源**：SQLite WAL，保留原始报文以便协议变更后重新投影
- **崩溃恢复**：进程退出时活动轮次标记为 unknown，**绝不静默当作成功**
- **`declined` 一等状态**：用户拒绝的 Item 与 `completed` 严格区分
- **流式输出**：正文/推理/计划三类增量实时渲染（实测 126 条增量/轮）
- **Markdown 渲染**：不启用 raw HTML——模型输出是不可信内容
- **模型与推理强度选择**：列表由后端向 provider 查询，非硬编码
- **视觉：液态玻璃**。三层半透明面板 + 背景模糊 + 内发光边缘；
  工具类动作走紧凑单行（一屏可见十几步），对话内容才用气泡
- **审阅决策持久化**：逐文件接受/拒绝写入事件日志，重启后仍在
- **线程搜索**：走服务端 `thread/list` 的 `searchTerm`，能搜到本机其它
  入口（CLI、IDE）创建的线程
- **技能与插件列表**：`skills/list` / `plugin/list`
- **Git 工具**：分支、更改统计、领先/落后、提交、推送（协议无此能力，自研）
- **Diff 双通道**：审阅面板以 `turn/diff/updated`（标准 unified diff）为主数据源，
  `fileChange` 的逐文件结构为补充；后者条件可用且 `diff` 字段形态随变更类型变化

## 两个由实测驱动的 UI 行为

这两个细节来自对真实 app-server 的行为探测（见 [`docs/协议勘误与修正.md`](docs/协议勘误与修正.md)），不是设计推测：

1. **审批弹窗的「拒绝」与「拒绝并停止」是分开的两个按钮。** 实测确认 `decline` 与 `cancel` 都阻止命令执行，但 `cancel` 还会中断整个 Turn。若共用一个「拒绝」，用户无法预知自己的选择会不会终止整个任务。
2. **`declined` 必须与 `completed` 呈现不同。** 实测确认 `decline` 下命令**完全不执行**（连沙箱内降级执行都不会发生）。若显示成「已完成」，用户会以为自己批准了。

---


## 打包发布

```bash
npm run tauri build
```

产物：
- `target/release/bundle/macos/KCode.app`（约 233 MB）
- `target/release/bundle/dmg/KCode_0.1.0_aarch64.dmg`（约 96 MB）

体积主要来自 codex 二进制（219 MB）——它被**打进 app**，而不是首次运行时
下载。理由与项目的零静默外发原则一致：不在用户不知情时联网取可执行文件。

构建流程会自动执行 `scripts/stage-codex-binary.sh`，把当前平台的
codex 与 rg 暂存到 `crates/kcode-desktop/binaries/`，再由
`bundle.resources` 打进包内。应用启动时**优先查包内资源目录**，
开发期才回退到 `node_modules`。

打包后用 `bash scripts/verify-bundle.sh` 校验：脱离仓库（cwd=/tmp、
不设 `KCODE_REPO_ROOT`）启动，确认进程存活且 app-server 用的是包内二进制。
这个检查不能省——**所有单元测试都跑在仓库里，检测不到「发布版缺二进制」**。

## 命名约定

项目里同时存在 `kcode` 与 `codex` 两种前缀，边界如下：

| 前缀 | 含义 | 能否改 |
|---|---|---|
| `kcode-*` | **我们自己的**东西 | 随时可改 |
| `codex-*` / `CODEX_HOME` | **上游契约** | 改了就会坏 |

具体地：

- 可改（已改）：crate 名 `kcode-bridge`、应用数据目录 `kcode-home`、API 字段 `binaryPath`
- 不可改：`CODEX_HOME` 环境变量（上游 CLI 读取的名字）、`codexHome` 协议字段
  （`initialize` 响应）、`codex app-server --stdio`（上游可执行文件与子命令）、
  `@openai/codex*` 依赖包名、`codex_app_server_protocol.*` 生成的 schema 文件名

判断标准很简单：**这个字符串会不会被上游程序读取或写入**。会，就必须保持原样。

> 目录从 `codex-home` 改名为 `kcode-home` 时加了自动迁移，
> 升级后不会丢失既有配置与历史。

## 这个仓库为什么长这样

`codex app-server` 被官方标记为 `[experimental]`，字段会变。本项目的协议核对已经**实证了这一点**：从文档声称的 0.39.0 基线到当前 0.155.1，v1 审批方法整体 deprecated、v2 Item 体系上线、握手响应字段完全不同。

因此本仓库把「协议事实」当作需要持续维护的工程资产，而不是一次性查证：

```
codex API 生成物  →  schemas/ + src/types/protocol/   （冻结，入 diff）
                          ↓
                   scripts/protocol-facts.mjs
                          ↓
                   docs/protocol-facts.md             （人工阅读的对账基准）
                          ↓
                   方案文档 / 实现代码 引用它
```

**规则：协议细节以 `docs/protocol-facts.md` 为准，不以本文档或方案文档为准。**

---

## 仓库结构

```
kcode/
├─ docs/
│  ├─ KCode落地方案.md        实现规格书（修正版）
│  ├─ protocol-facts.md       协议事实清单（自动生成，对账基准）
│  ├─ test-stats.md           测试统计（自动生成，数字的单一来源）
│  ├─ 协议勘误与修正.md        勘误记录与依据
│  └─ archive/               v1.0 原始调研材料（溯源用）
├─ crates/
│  ├─ codex-bridge/            L1 适配层（不依赖 Tauri）
│  │  ├─ src/{jsonl,transport,process,binary}.rs
│  │  └─ tests/{contract,approval_semantics}.rs
│  ├─ kcode-domain/            L2 领域层
│  │  ├─ src/{model,risk,project,log}.rs
│  │  └─ tests/integration.rs
│  ├─ kcode-app/               L0 编排层（actor，不依赖 Tauri）
│  │  ├─ src/service.rs
│  │  └─ tests/{e2e,wire_contract}.rs
│  └─ kcode-desktop/           L0 宿主层（Tauri 2 薄壳）
├─ src/                        L3 前端
│  ├─ components/             ApprovalModal / DiffViewer / ItemCard / TurnView / ThreadList / Composer
│  ├─ stores/                 store.ts（纯函数归约）+ useKcode.ts（后端绑定）
│  └─ types/domain.ts         领域类型（camelCase，与 Rust 契约对齐）
├─ scripts/
│  ├─ verify-codex-version.sh  CLI 版本 + SHA256 + 安全基线
│  ├─ gen-schema.sh            schema 生成 / 漂移检测
│  ├─ protocol-facts.mjs       生成协议事实清单
│  ├─ contract-*.mjs           端到端契约测试（Node 参考实现，三套）
│  ├─ mock-provider.mjs        本地 mock model provider
│  ├─ no-proxy-env.mjs         让本地 provider 不被系统代理截走（见勘误 §3.21）
│  └─ test-stats.mjs           测试数量统计 / 漂移检查
├─ schemas/                  冻结的协议 schema
├─ src/types/protocol/       generate-ts 冻结产物
├─ codex.lock.json           CLI 版本 + 哈希锁定
├─ SECURITY.md               采集边界与隐私开关语义
└─ .github/workflows/        CI：协议漂移 + 契约测试 + Rust 测试
```

---

## 可用的脚本

| 命令 | 作用 |
|---|---|
| `npm run verify:codex` | 校验 CLI 版本 ≥ 安全下限，且 SHA256 与锁定记录一致 |
| `npm run gen:schema` | 重新生成 schema 与 TS 绑定 |
| `npm run check:drift` | 检测协议是否相对冻结版本发生漂移（CI 用） |
| `npm run contract` | 端到端契约测试（需 codex 二进制） |
| `npm test` | 版本校验 + 三个契约脚本 + 前端单测 |
| `npm run stats` | **重新统计测试数量**并更新 `docs/test-stats.md` 与本文（会真的跑一遍全部测试） |
| `npm run check:stats` | 比对测试数字是否漂移（CI 用） |
| `bash scripts/verify-no-egress.sh` | **出站连接实时抓取**（验证零静默外发） |
| `bash scripts/verify-tauri-capabilities.sh` | 校验 Tauri 权限声明（缺失会导致 IPC 静默失效） |
| `bash scripts/verify-sandbox-boundary.sh` | **沙箱边界验收**（需模型凭据；验证临时目录写入面已关闭） |
| `bash scripts/verify-bundle.sh` | **打包产物可独立运行**（脱离仓库启动） |
| `npm run tauri build` | 打包 `.app` + `.dmg` |
| `bash scripts/acceptance-real-model.sh` | 真实模型验收（需凭据；无凭据时退出码 3） |

### 建立/更新版本锁定

```bash
bash scripts/verify-codex-version.sh --record
```

升级 CLI 后必须重新执行，并在 PR 中说明理由。

---

## 契约测试覆盖了什么

一次运行验证完整链路：

```
initialize 握手（对象形态 + codexHome 校验）
  → thread/start（sandbox 字符串形态 + approvalPolicy）
  → turn/start（sandboxPolicy 对象形态）
  → mock provider 返回提权命令调用
  → 服务端发起 item/commandExecution/requestApproval  ← 关键：审批是「请求」不是「通知」
  → 校验 params 含 threadId / turnId / itemId / startedAtMs
  → 客户端按 JSON-RPC 原样回应 {decision: "accept"}   ← 不存在 approval/resolve 方法
  → turn/completed 收尾
```

这套断言同时是 Rust 侧单测的用例来源。

---

## 安全

见 [`SECURITY.md`](SECURITY.md)。要点：

- **零静默外发**：除你显式配置的 provider / MCP / git remote 外无任何出站连接。
- **无工作区快照上传**：架构级禁止，不是设置项。
- **凭据只进 OS keychain**；审计日志写入前脱敏。
- **每个隐私开关都有可验证语义**，关闭后行为必须真正停止。
- **默认关闭临时目录写入面**：`workspace-write` 默认把 `$TMPDIR` 也纳入可写集合
  且不弹审批，已在隔离配置中显式关闭（`exclude_tmpdir_env_var`）。
- **一处上游出站已如实披露**：codex CLI 自身会发起一次模型元数据拉取
  （无条件触发、无法关闭；目标地址由本机 DNS 决定，实测未建立、无数据传输）。
  这不由 KCode 引入，已在 `SECURITY.md` 专节说明，验收脚本**逐条归属**并单独计数——
  详见 [`docs/协议勘误与修正.md`](docs/协议勘误与修正.md) §3.22。

---

## 许可

待定。Agent 内核 `openai/codex` 采用 Apache-2.0；本项目作为其客户端独立发布。
