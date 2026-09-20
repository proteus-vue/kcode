#!/usr/bin/env bash
# 真实模型验收（需要凭据）。
#
# 与 `cargo test` 的区别：那些测试用 mock provider 验证**协议链路**是否正确；
# 本脚本用真实模型验证**产品行为**是否可用——原型协议测试无法覆盖的部分：
#
#   - 真实模型的推理内容与工具调用序列
#   - 多轮上下文的真实连续性
#   - 真实文件编辑（apply_patch）的完整审批与落盘
#   - 长任务的规划与执行
#
# 前置条件（任一即可）：
#   1. 已 `codex login` 登录 ChatGPT 账号
#   2. 设置了 OPENAI_API_KEY
#   3. 配置了兼容 provider（base_url + key）
#
# 用法：
#   bash scripts/acceptance-real-model.sh [工作区路径]
#
# 未检测到凭据时脚本退出码为 3，并打印如何配置——不会伪造通过。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="${1:-$(mktemp -d)}"
KEEP="${KEEP:-0}"

echo "════════ 真实模型验收 ════════"
echo "工作区: $WORKSPACE"
echo

# ── 凭据检测 ─────────────────────────────────────────────────────────────
CRED=""
if [[ -f "$HOME/.codex/auth.json" ]]; then
  CRED="ChatGPT 登录（~/.codex/auth.json）"
elif [[ -n "${OPENAI_API_KEY:-}" ]]; then
  CRED="OPENAI_API_KEY 环境变量"
elif [[ -n "${KCODE_MODEL_BASE_URL:-}" ]]; then
  CRED="自定义 provider（KCODE_MODEL_BASE_URL）"
fi

if [[ -z "$CRED" ]]; then
  cat >&2 <<'EOF'
✗ 未检测到任何模型凭据。

本脚本需要真实模型访问。三种配置方式任选其一：

  1) ChatGPT 登录：
       codex login

  2) API key：
       export OPENAI_API_KEY=sk-...

  3) 兼容 provider（自建网关 / 第三方）：
       export KCODE_MODEL_BASE_URL=https://your-gateway/v1
       export KCODE_MODEL_API_KEY=...
       export KCODE_MODEL_NAME=your-model

配置后重新运行：bash scripts/acceptance-real-model.sh

注意：**协议链路**的正确性不需要真实模型即可完整验证——
      运行 `cargo test --workspace` 或 `npm run contract` 即可（离线、零凭据）。
EOF
  exit 3
fi

echo "凭据来源: $CRED"
echo

# ── 组装隔离 CODEX_HOME ──────────────────────────────────────────────────
TMPHOME="$(mktemp -d)"
cleanup() {
  [[ "$KEEP" == "1" ]] && { echo; echo "保留临时目录: $TMPHOME"; return; }
  rm -rf "$TMPHOME"
}
trap cleanup EXIT

if [[ -n "${KCODE_MODEL_BASE_URL:-}" ]]; then
  cat > "$TMPHOME/config.toml" <<EOF
model_provider = "acceptance"
model = "${KCODE_MODEL_NAME:-gpt-5.2}"

[model_providers.acceptance]
name = "acceptance"
base_url = "${KCODE_MODEL_BASE_URL}"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "${KCODE_MODEL_API_KEY:-}"
EOF
else
  # 复用用户既有登录：复制凭据到隔离目录，避免污染其真实配置与历史
  cp "$HOME/.codex/auth.json" "$TMPHOME/auth.json" 2>/dev/null || {
    [[ -n "${OPENAI_API_KEY:-}" ]] || { echo "✗ 无法读取凭据" >&2; exit 3; }
  }
  printf 'model = "%s"\n' "${KCODE_MODEL_NAME:-gpt-5.2}" > "$TMPHOME/config.toml"
  [[ -n "${OPENAI_API_KEY:-}" ]] && echo "OPENAI_API_KEY 由环境变量注入（不写入磁盘）"
fi

mkdir -p "$WORKSPACE"
cd "$WORKSPACE" || exit 2

# 准备一个可被编辑的最小仓库，让文件变更链路真正走通
if [[ ! -d .git ]]; then
  git init -q .
  printf 'def add(a, b):\n    return a + b\n' > calc.py
  printf '# 示例项目\n' > README.md
  git add -A && git -c user.email=a@b -c user.name=acceptance commit -qm "初始提交"
  echo "已在 $WORKSPACE 初始化示例仓库"
fi
echo

# ── 驱动脚本 ─────────────────────────────────────────────────────────────
cat > "$TMPHOME/drive.mjs" <<'DRIVER'
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [bin, home, cwd] = process.argv.slice(2);
const approvals = [];
const items = [];
/** 已完成的轮次 id。waitTurn 依据它判断，避免无谓等待。 */
const completedTurns = new Set();

const child = spawn(bin, ['app-server', '--stdio'], {
  cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
});
let id = 0, buf = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }

    if (m.id !== undefined && m.method !== undefined) {
      // 打印审批内容（脱敏前原文，仅本地显示）后批准
      approvals.push({ method: m.method, params: m.params });
      child.stdin.write(JSON.stringify({ id: m.id, result: { decision: 'accept' } }) + '\n');
      continue;
    }
    if (m.method === 'item/started' || m.method === 'item/completed') {
      const it = m.params.item;
      items.push({ phase: m.method, type: it.type, item: it });
      if (m.method === 'item/started') {
        if (it.type === 'commandExecution') process.stdout.write(`  $ ${String(it.command).slice(0, 120)}\n`);
        else if (it.type === 'fileChange') process.stdout.write(`  ✎ 文件变更\n`);
        else if (it.type === 'agentMessage') process.stdout.write(`  ✎ 回复…\n`);
      }
      if (m.method === 'item/completed' && it.type === 'fileChange') {
        // 实测：changes 是**数组**，每项含 { path, kind, diff }，
        // 不是 { path: {...} } 的映射。早先按对象键取会得到 0 个文件。
        const arr = Array.isArray(it.changes) ? it.changes : [];
        const lines = arr.map((c) => {
          const kind = c.kind?.type ?? '?';
          const move = c.kind?.move_path ? ` → ${c.kind.move_path}` : '';
          const n = (c.diff ?? '').split('\n').filter((l) => l.startsWith('+')).length;
          const d = (c.diff ?? '').split('\n').filter((l) => l.startsWith('-')).length;
          return `${kind} ${String(c.path).split('/').pop()}${move} (+${n} -${d})`;
        });
        process.stdout.write(`  ✓ 文件变更 ${arr.length} 个: ${lines.join(', ') || '(无)'}\n`);
      }
    }
    if (m.method === 'warning') process.stdout.write(`  ⚠ ${String(m.params.message).slice(0, 150)}\n`);
    if (m.method === 'turn/completed') {
      const tid = m.params.turn?.id;
      if (tid) completedTurns.add(tid);
      process.stdout.write(`  ■ 轮次结束 status=${m.params.turn.status}\n`);
    }
    if (m.id !== undefined && m.method === undefined && pending.has(m.id)) {
      pending.get(m.id)(m); pending.delete(m.id);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (d) => process.stderr.write(d));

const send = (method, params, ms = 180000) => new Promise((r) => {
  const my = ++id; pending.set(my, r);
  child.stdin.write(JSON.stringify({ method, id: my, params }) + '\n');
  setTimeout(() => r({ timeout: true }), ms);
});

// 轮次完成标记：由通知处理逻辑写入，waitTurn 据此判断。
// 早先版本在此引用了一个从未被填充的数组，导致每个场景都会干等到超时——
// 这正是「测试通过」与「测试有效」的区别。
let lastCompletedTurn = null;
let completedCount = 0;

const waitTurn = (turnId, ms = 300000) => new Promise((resolve) => {
  const deadline = Date.now() + ms;
  const check = () => {
    if (completedTurns.has(turnId)) return resolve(true);
    if (Date.now() > deadline) return resolve(false);
    setTimeout(check, 200);
  };
  check();
});

await send('initialize', {
  clientInfo: { name: 'kcode-acceptance', title: 'KCode Acceptance', version: '0.1.0' },
});
child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');

console.log('▶ 建线程');
const st = await send('thread/start', {
  cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write',
});
const threadId = st.result?.thread?.id;
if (!threadId) { console.error('建线程失败:', JSON.stringify(st).slice(0, 400)); process.exit(2); }
console.log(`  thread=${threadId} model=${st.result?.model} sandbox=${JSON.stringify(st.result?.sandbox)}`);

const scenarios = [
  { name: '读取与解释代码', prompt: '读取 calc.py 并说明它的功能，一句话即可。' },
  { name: '文件修改', prompt: '在 calc.py 中新增一个 multiply 函数，保持现有风格。' },
  { name: '验证与测试', prompt: '为 calc.py 中的函数编写一个简单的测试文件并运行它。' },
];

let completed = 0;
for (const sc of scenarios) {
  console.log(`\n▶ ${sc.name}`);
  const t0 = Date.now();
  const t = await send('turn/start', {
    threadId, input: [{ type: 'text', text: sc.prompt }],
  });
  if (t.timeout || !t.result?.turn?.id) {
    console.log('  ✗ 提交失败:', JSON.stringify(t).slice(0, 200));
    continue;
  }
  const ok = await waitTurn(t.result.turn.id);
  console.log(`  ${ok ? '✓' : '✗'} 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (ok) completed++;
  // 每轮之间的审批统计
  await new Promise((r) => setTimeout(r, 500));
}

console.log(`\n完成场景: ${completed}/${scenarios.length}`);
console.log(`审批请求: ${approvals.length} 次`);
for (const a of approvals) {
  console.log(`  - ${a.method}`);
}
const fileChanges = items.filter((i) => i.type === 'fileChange' && i.phase === 'item/completed');
console.log(`文件变更 Item: ${fileChanges.length} 个`);

writeFileSync(`${cwd}/.kcode-acceptance.json`, JSON.stringify({
  completed, total: scenarios.length,
  approvals: approvals.map((a) => a.method),
  fileChangeCount: fileChanges.length,
  itemTypes: [...new Set(items.map((i) => i.type))],
}, null, 2));

child.kill('SIGTERM');
process.exit(completed === scenarios.length ? 0 : 1);
DRIVER

echo "▶ 运行真实模型场景（最长 5 分钟/场景）"
node "$TMPHOME/drive.mjs" "$(node -e "
  const p=require('path');
  const root='$ROOT';
  const cands=[
    'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
    'node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex',
    'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex',
    'node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex',
  ];
  const fs=require('fs');
  console.log(p.join(root, cands.find(c=>fs.existsSync(p.join(root,c)))||cands[0]));
")" "$TMPHOME" "$WORKSPACE"
RC=$?

echo
echo "════════ 结果 ════════"
if [[ -f "$WORKSPACE/.kcode-acceptance.json" ]]; then
  cat "$WORKSPACE/.kcode-acceptance.json"
  echo
fi

if [[ "$RC" == "0" ]]; then
  echo "✓ 真实模型验收通过"
  echo
  echo "建议人工复核："
  echo "  1. git diff 是否只含预期的改动"
  echo "  2. 审计导出是否记录了两处决策（bash scripts/verify-no-egress.sh 亦可复跑）"
else
  echo "✗ 真实模型验收未全部通过（退出码 $RC）" >&2
  echo "  部分失败常见原因：模型不支持该工具、网络不通、配额不足。" >&2
  echo "  请查看上方逐场景输出。" >&2
fi
exit $RC
