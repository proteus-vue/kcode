#!/usr/bin/env node
/**
 * 从已冻结的 schema 中提取协议事实清单，输出 docs/protocol-facts.md。
 *
 * 这份文件是「文档 vs 真实协议」的唯一对账依据；修改方案文档中的协议细节时，
 * 应先看这里，而不是依赖记忆或二手资料。
 *
 * 用法：node scripts/protocol-facts.mjs
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SCHEMAS = join(ROOT, 'schemas');

if (!existsSync(SCHEMAS)) {
  console.error('未找到 schemas/，请先运行: bash scripts/gen-schema.sh');
  process.exit(2);
}

const version = JSON.parse(readFileSync(join(SCHEMAS, 'GENERATED_FROM.json'), 'utf8')).codexVersion;

function load(name) {
  return JSON.parse(readFileSync(join(SCHEMAS, name), 'utf8'));
}

/** 从 oneOf/anyOf 变体里抽出 method 常量。 */
function methods(name) {
  const d = load(name);
  const vs = d.oneOf || d.anyOf || [];
  const out = [];
  for (const v of vs) {
    const m = v?.properties?.method;
    const c = m?.const ?? (Array.isArray(m?.enum) ? m.enum[0] : undefined);
    if (c) out.push(c);
  }
  return out.sort();
}

/** 解析 definitions 中某个类型的结构。 */
function def(bundle, name) {
  const d = load(bundle);
  return (d.definitions || {})[name];
}

function propsOf(schema) {
  if (!schema) return null;
  return schema.properties || null;
}

function fmtProps(p, required = []) {
  if (!p) return '（未找到）';
  return Object.entries(p)
    .map(([k, v]) => {
      let t = v.type;
      if (Array.isArray(t)) t = t.join('|');
      if (!t) t = v.$ref ? v.$ref.split('/').pop()
        : v.anyOf ? 'anyOf'
        : v.oneOf ? 'oneOf'
        : v.allOf ? 'allOf' : '?';
      const star = required.includes(k) ? '*' : '';
      return `${star}${k}: ${t}`;
    })
    .join(', ');
}

const clientMethods = methods('ClientRequest.json');
const serverNotifs = methods('ServerNotification.json');
const serverReqs = methods('ServerRequest.json');

const v2 = 'codex_app_server_protocol.v2.schemas.json';

/** 从独立 schema 文件读取顶层属性（这些类型不在 v2 bundle 的 definitions 里）。 */
function standaloneProps(file) {
  const d = load(file);
  const ref = d.$ref || (d.allOf || [{}])[0]?.$ref;
  const defs = d.definitions || {};
  if (ref) {
    const t = defs[ref.split('/').pop()] || {};
    return { properties: t.properties || {}, required: t.required || [] };
  }
  return { properties: d.properties || {}, required: d.required || [] };
}

// 审批相关的关键类型（各自在独立文件中）
const approvalTypes = {
  'CommandExecutionRequestApprovalParams': standaloneProps('CommandExecutionRequestApprovalParams.json'),
  'FileChangeRequestApprovalParams': standaloneProps('FileChangeRequestApprovalParams.json'),
  'PermissionsRequestApprovalParams': standaloneProps('PermissionsRequestApprovalParams.json'),
};

const clientReq = load('ClientRequest.json').definitions || {};

const lines = [];
const w = (s = '') => lines.push(s);

w(`# app-server 协议事实清单`);
w();
w(`> 由 \`scripts/protocol-facts.mjs\` 从 \`schemas/\` 自动生成，**请勿手工编辑**。`);
w(`> 生成来源：codex CLI **${version}**。`);
w(`> 用途：本文件是方案文档中一切协议细节的对账依据。文档与本文冲突时，以本文为准。`);
w();
w(`## 规模`);
w();
w(`| 类别 | 数量 |`);
w(`|---|---|`);
w(`| 客户端 → 服务端方法（ClientRequest） | ${clientMethods.length} |`);
w(`| 服务端 → 客户端通知（ServerNotification） | ${serverNotifs.length} |`);
w(`| 服务端 → 客户端请求（ServerRequest） | ${serverReqs.length} |`);
w();

w(`## 服务端主动请求（${serverReqs.length}）`);
w();
w(`审批走这一类别。注意：\`applyPatchApproval\` 与 \`execCommandApproval\` 是 **legacy**（源码标注 DEPRECATED，仅用于经 legacy API 启动的 Turn）；现行主路径是 \`item/*/requestApproval\`。`);
w();
for (const m of serverReqs) w(`- \`${m}\``);
w();

w(`## 审批类型字段`);
w();
for (const [name, schema] of Object.entries(approvalTypes)) {
  w(`### ${name}`);
  w();
  if (!schema) { w('（未找到）'); w(); continue; }
  w('```');
  w(fmtProps(schema.properties, schema.required || []));
  w('```');
  w();
  const respFile = name.replace('Params', 'Response') + '.json';
  if (existsSync(join(SCHEMAS, respFile))) {
    const resp = standaloneProps(respFile);
    w(`响应 \`${name.replace('Params', 'Response')}\`：`);
    w();
    w('```');
    w(fmtProps(resp.properties, resp.required || []));
    w('```');
    w();
  }
}

// 决策枚举
w(`## 审批决策枚举`);
w();
for (const [respFile, enumName] of [
  ['CommandExecutionRequestApprovalResponse.json', 'CommandExecutionApprovalDecision'],
  ['FileChangeRequestApprovalResponse.json', 'FileChangeApprovalDecision'],
]) {
  const d = load(respFile);
  const e = d.definitions?.[enumName];
  w(`### ${enumName}`);
  w();
  if (!e) { w('（未找到）'); w(); continue; }
  for (const v of e.oneOf || []) {
    if (v.enum) {
      w(`- \`"${v.enum[0]}"\` — ${v.description || ''}`);
    } else if (v.properties) {
      const k = Object.keys(v.properties)[0];
      w(`- \`{ "${k}": {...} }\` — ${v.description || ''}`);
    }
  }
  w();
}

w(`## 关键参数与响应结构`);
w();
const focus = ['InitializeParams', 'InitializeCapabilities', 'ThreadStartParams', 'TurnStartParams', 'TurnInterruptParams', 'ThreadForkParams'];
for (const n of focus) {
  const s = clientReq[n];
  w(`### ${n}`);
  w();
  if (!s) { w('（未找到）'); w(); continue; }
  w('```');
  w(fmtProps(s.properties, s.required || []));
  w('```');
  w();
}

w(`### 关键枚举`);
w();
for (const n of ['SandboxMode', 'AskForApproval', 'ApprovalsReviewer']) {
  const s = clientReq[n];
  // oneOf 的分支有两种形态：纯枚举分支（union 字符串字面量）和对象分支
  // （如 AskForApproval 的 granular）。此前对枚举分支只取 enum[0]，
  // 把 ["untrusted","on-request","never"] 截成了 ["untrusted","granular"]——
  // 少列两个合法取值，读文档的人会以为只能传 untrusted。
  const describe = () => {
    if (s?.enum) return s.enum;
    if (!s?.oneOf) return '严格 string（模型自述，无固定枚举）';
    return s.oneOf.map((x) =>
      x.enum ? x.enum.join(' | ') : `{${Object.keys(x.properties || {}).join(', ')}}`,
    );
  };
  w(`- **${n}**：\`${JSON.stringify(describe())}\``);
}
w();

w(`### Item 状态枚举（UI 必须处理 \`declined\`）`);
w();
for (const n of ['CommandExecutionStatus', 'PatchApplyStatus', 'TurnStatus']) {
  const s = def(v2, n);
  w(`- **${n}**：\`${JSON.stringify(s?.enum ?? '（未找到）')}\``);
}
w();

w(`### 设置项的实测语义（\`scripts/probe-settings.mjs\`）`);
w();
w(`以下行为**无法从 schema 读出**，全部来自对真实 app-server 的探测：`);
w();
w(`- **config.toml 非法时 \`config/read\` 会整体失败**，返回 \`-32603\``);
w(`  （\`invalid configuration: ...\`），而不是返回部分配置或 null 字段。`);
w(`  客户端**必须把这个错误报给用户**：静默当成「没有配置」会让界面显示`);
w(`  一套并不生效的默认值，用户据此做的判断全都是错的。`);
w(`  （这条曾经被误判为「传 cwd 会返回空 config」——当时的探针配置里有一个`);
w(`  已废弃的 \`wire_api = "chat"\`，真正的原因是配置非法。\`cwd\` 参数本身无此问题。）`);
w(`- **\`config/value/write\` 会先校验整份配置再落盘**。配置里任何一处非法（例如已废弃的`);
w(`  \`wire_api = "chat"\`，现在只接受 \`responses\`）都会让写入整体失败，报`);
w(`  \`configValidationError\`，且**文件保持不变**。写入是原子的，不会写一半。`);
w(`- **\`config/value/write\` 能创建未类型化的表项**。例如 \`keyPath: "model_providers.gamma"\``);
w(`  配 \`mergeStrategy: "upsert"\` 可新增一个 provider 段落（实测成功）。`);
w(`- **\`permissionProfile/list\` 返回的是沙箱档位**，id 形如 \`":read-only"\`、\`":workspace"\`、`);
w(`  \`":danger-full-access"\`——带冒号前缀。\`allowed\` 表示当前生效的 requirements 是否允许选中。`);
w(`  它与 \`SandboxMode\`（\`read-only\` / \`workspace-write\` / \`danger-full-access\`）是**两套命名**，`);
w(`  名字不同但语义对应：\`":workspace"\` ≈ \`workspace-write\`。做 UI 时不要直接把 id 当 SandboxMode 用。`);
w(`- **\`thread/start\` 的 \`approvalPolicy\` / \`sandbox\` / \`modelProvider\` 只作用于该线程**，`);
w(`  不写回配置文件（实测：以 \`approvalPolicy: "never"\` 建线程后重读 config，`);
w(`  \`approval_policy\` 仍为 \`null\`，\`model_provider\` 仍是原值）。`);
w(`  所以「对当前会话生效」与「永久生效」是两条路径：前者走 thread/turn 参数，`);
w(`  后者必须走 \`config/value/write\`。`);
w();
w(`### 响应结构（v1 命名空间，注意这些类型不在 ClientRequest 的 definitions 里）`);
w();
for (const n of ['ThreadStartResponse', 'TurnStartResponse', 'ThreadResumeResponse']) {
  const s = def(v2, n);
  w(`- **${n}**：\`${fmtProps(s?.properties, s?.required || [])}\``);
}
w();

// ── 以下为实测补充，schema 读不出来 ───────────────────────────────────
//
// **必须写在生成器里**，不能只改 docs/protocol-facts.md：CI 会重跑本脚本
// 并比对生成结果，只改产物的话下一次生成就把这些段整段删掉（这个坑真的
// 踩过一次——四个章节被生成器静默删除，CI 判为「文档与 schema 不一致」）。

w(`### ⚠️ \`fuzzyFileSearch\` 用 snake_case（与其余方法不同）`);
w();
w(`实测报文（codex ${version}；由 \`crates/kcode-app/tests/e2e.rs\` 的`);
w(`\`fuzzy_search_returns_matches_in_files_key\` 复现）：`);
w();
w('```json');
w(`{"files":[{"file_name":"probe.txt","indices":[12,13],`);
w(`           "match_type":"file","path":"probe.txt","root":"/tmp/xxx","score":200}]}`);
w('```');
w();
w(`- **命中列表在 \`files\` 键下**（不是 \`data\`，也不是数组直出）。`);
w(`- **字段是 snake_case**：\`file_name\` / \`match_type\`。协议里绝大多数方法是`);
w(`  camelCase，这里不是——读成 \`fileName\` 不报错，只会让文件名**静默变成空串**。`);
w(`- 该方法的响应**没有**独立 definitions 条目（\`ClientRequest.oneOf\` 只给了请求侧），`);
w(`  冻结 schema 里只有一个会话式通知 \`FuzzyFileSearchSessionUpdatedNotification\``);
w(`  （带 \`sessionId\`）。因此形态**只能实测**，推不出来。`);
w(`- 参数：\`{"query": string, "roots": [string]}\`，两者皆必填。`);
w();
w(`### ⚠️ 图片输入的形态：只有路径/URL，没有内嵌字节`);
w();
w(`\`turn/start\` 的 \`input\` 数组元素（\`UserInput\`）实测有 7 种：`);
w();
w(`| type | 载荷 | 用途 |`);
w(`|---|---|---|`);
w(`| \`text\` | \`text\`, \`text_elements[]\` | 正文 |`);
w(`| \`image\` | \`url\`, \`detail\` | 网络图片 |`);
w(`| \`localImage\` | \`path\`, \`detail\` | **本地图片（我们用的）** |`);
w(`| \`audio\` / \`localAudio\` | \`url\` / \`path\` | 音频 |`);
w(`| \`skill\` | \`name\`, \`path\` | 技能引用 |`);
w(`| \`mention\` | \`name\`, \`path\` | 文件引用 |`);
w();
w(`**关键**：图片**没有内嵌 base64 的形式**。因此：`);
w();
w(`- 拖入的文件（Tauri 拖放事件直接给出绝对路径）→ 直接传路径，不必落盘；`);
w(`- 剪贴板粘贴的图片（只有字节、没有路径）→ **必须先写到磁盘**再传路径`);
w(`  （实现见 \`crates/kcode-desktop\` 的 \`save_attachment\`，目录固定在自己`);
w(`  app_data 下，不接受调用方指定，避免路径注入面）。`);
w();
w(`由 \`crates/kcode-app/tests/e2e.rs::turn_accepts_local_image_attachment\``);
w(`对真 app-server 验证：形状不对时该轮根本起不来，所以「轮次能完成」就是`);
w(`形状正确的证据。`);
w();
w(`### ⚠️ \`thread/revert\` 只改会话历史，**不还原本地文件**`);
w();
w(`名字的直觉是「还原代码」，实际不是。锁定版本的 schema 自己写明：`);
w();
w('```');
w(`ThreadRevertParams.beforeTurnId:`);
w(`  "Turn excluded from the replacement history, together with every later turn."`);
w(`  "This only changes persisted conversation history. It does not revert local file changes."`);
w('```');
w();
w(`已废弃的 \`thread/rollback\` 说得更直白：\`"...Clients are responsible for`);
w(`reverting these changes."\``);
w();
w(`**所以逐文件撤销必须客户端自己做**（我们走 git：\`kcode-bridge/src/git.rs::revert_file\`，`);
w(`已暂存先撤出暂存区、已跟踪恢复自索引、未跟踪则删除）。若照方法名直接调用，`);
w(`用户点「撤销」会拿到**成功响应而文件一字未变**——接口成功、状态未变的`);
w(`静默缺陷。详见 \`docs/协议勘误与修正.md\` §3.24。`);
w();
w(`### \`thread/compact/start\` 参数形状`);
w();
w(`\`{"threadId": string}\`，仅此一项。服务端接受后压缩结果经 \`thread/compacted\``);
w(`通知回传（该通知已被协议标记 deprecated，改由 \`contextCompaction\` item 承载`);
w(`——我们两条路径都接）。`);
w();

w(`## 客户端方法全集（${clientMethods.length}）`);
w();
for (const m of clientMethods) w(`- \`${m}\``);
w();

w(`## 服务端通知全集（${serverNotifs.length}）`);
w();
for (const m of serverNotifs) w(`- \`${m}\``);
w();

// 非协议能力（本机工具链）。同样必须留在生成器里，理由见上方说明。
w(`## 模拟器（非协议能力，本机工具链）`);
w();
w(`模拟器展示不经过 codex 协议，直接调用本机工具。实测（macOS 26.5，本机）：`);
w();
w(`| 平台 | 工具 | 状态 |`);
w(`|---|---|---|`);
w(`| Android | \`$ANDROID_HOME/emulator/emulator\` + \`platform-tools/adb\` | **可用**：2 个 AVD；\`adb -s <serial> exec-out screencap -p\` 输出 1080×2340 PNG，单帧约 350ms |`);
w(`| iOS | \`xcrun simctl\` | **不可用**：只有 CommandLineTools，没有完整 Xcode（\`simctl\` 不存在） |`);
w();
w(`### 两条踩到的命令细节`);
w();
w(`1. **输入必须经 \`shell\` 转发**：\`adb -s X input tap 100 200\` 会被 adb 当成自己的`);
w(`   子命令，报 \`adb: unknown command input\`。正确形式是`);
w(`   \`adb -s X shell input tap 100 200\`。截图用 \`exec-out\` 没问题（那是 adb 自己的子命令）。`);
w(`   这个错误在纯单元测试里发现不了，由真机测试抓到。`);
w(`2. **\`adb devices\` 第一行是表头**（\`List of devices attached\`），必须跳过，`);
w(`   否则界面会多出一个叫 "List" 的假设备。`);
w(`3. \`offline\` / \`unauthorized\` 的设备上执行 \`screencap\` 会**一直阻塞**而不是失败，`);
w(`   所以：只选 \`state == "device"\` 的设备，且所有命令都设 3 秒超时。`);
w();

writeFileSync(join(ROOT, 'docs', 'protocol-facts.md'), lines.join('\n') + '\n');
console.log(`✓ 已生成 docs/protocol-facts.md（codex ${version}）`);
console.log(`  客户端方法 ${clientMethods.length} / 服务端通知 ${serverNotifs.length} / 服务端请求 ${serverReqs.length}`);
