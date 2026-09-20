#!/usr/bin/env node
/**
 * 诊断：设置项相关的协议能力实测。
 *
 * 回答四个问题（schema 只描述形状，不描述语义）：
 *
 * 1. `config/read` 返回什么？`model_providers` 这类未类型化的表能否读到？
 * 2. `permissionProfile/list` 到底列的是什么？与沙箱模式是什么关系？
 * 3. `config/value/write` 能否改 `model_provider`？写进哪个文件？
 * 4. `thread/start` 的 `approvalPolicy` / `sandbox` / `modelProvider`
 *    覆盖是「仅本线程」还是会持久化？
 *
 * 全程在隔离的 CODEX_HOME 下运行，绝不触碰真实 ~/.codex。
 *
 * 用法：node scripts/probe-settings.mjs [codex 二进制路径]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = process.argv[2] ?? 'codex';

const cwd = mkdtempSync(join(tmpdir(), 'kcode-set-cwd-'));
const home = mkdtempSync(join(tmpdir(), 'kcode-set-home-'));

// 两个 provider，用来验证切换与「当前值」的读取
writeFileSync(
  join(home, 'config.toml'),
  `model_provider = "alpha"
model = "model-alpha"

[model_providers.alpha]
name = "Alpha"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "tok-alpha"

[model_providers.beta]
name = "Beta"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "tok-beta"
`,
);

const child = spawn(BIN, ['app-server', '--stdio'], {
  cwd,
  env: { ...process.env, CODEX_HOME: home },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
let id = 0;
const pending = new Map();
let stderr = '';

child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => (stderr += c));

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id !== undefined && m.method === undefined && pending.has(m.id)) {
      pending.get(m.id).resolve(m);
      pending.delete(m.id);
    }
    // 服务端请求一律拒绝，探针不执行任何真实操作
    if (m.id !== undefined && m.method !== undefined) {
      child.stdin.write(JSON.stringify({ id: m.id, result: { decision: 'decline' } }) + '\n');
    }
  }
});

function send(method, params) {
  const myId = ++id;
  return new Promise((resolve) => {
    pending.set(myId, { resolve });
    child.stdin.write(JSON.stringify({ method, id: myId, params }) + '\n');
    setTimeout(() => {
      if (pending.delete(myId)) resolve({ timeout: true });
    }, 15000);
  });
}

const out = (label, v) => {
  console.log(`\n──── ${label} ────`);
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
};

try {
  await send('initialize', {
    clientInfo: { name: 'probe-settings', title: 'Probe', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');

  // ── 1. config/read ──────────────────────────────────────────────
  const crNoCwd = await send('config/read', {});
  out('config/read（不带 cwd）→ config', crNoCwd.result?.config ?? crNoCwd);
  const cr = await send('config/read', { cwd, includeLayers: true });
  const cfg = cr.result?.config ?? {};
  out('config/read → config', cfg);
  if (cr.result?.layers) {
    out(
      'config/read → layers（来源与覆盖顺序）',
      cr.result.layers.map((l) => ({ name: l.name, version: l.version, keys: Object.keys(l.config ?? l) })),
    );
  }
  out('config/read → origins 摘要', (() => {
    const o = cr.result?.origins ?? {};
    const map = {};
    for (const [k, v] of Object.entries(o)) map[k] = v?.name ?? v;
    return map;
  })());

  // ── 2. permissionProfile/list ──────────────────────────────────
  const pp = await send('permissionProfile/list', { cwd });
  out('permissionProfile/list', pp.result ?? pp);

  // ── 3. model/list ──────────────────────────────────────────────
  const ml = await send('model/list', {});
  const models = ml.result?.data ?? [];
  out('model/list（截取前 3 条）', models.slice(0, 3));
  out(
    'model/list 字段名',
    models[0] ? Object.keys(models[0]) : '(空)',
  );

  // ── 4. config/value/write 能否改 model_provider ───────────────
  const before = readFileSync(join(home, 'config.toml'), 'utf8');
  const cw = await send('config/value/write', {
    keyPath: 'model_provider',
    mergeStrategy: 'replace',
    value: 'beta',
  });
  out('config/value/write(model_provider=beta)', cw.result ?? cw);
  const after = readFileSync(join(home, 'config.toml'), 'utf8');
  out('写后 config.toml', after);
  console.log('\n变化:', before === after ? '文件未变（可能写到了别处）' : '文件已修改');
  if (before !== after) {
    const b = before.split('\n'),
      a = after.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) console.log(`  L${i + 1}: ${JSON.stringify(b[i])} → ${JSON.stringify(a[i])}`);
    }
  }

  // 验证写入是否生效（重新读）
  const cr2 = await send('config/read', { cwd });
  out('重读 model_provider / model', {
    model_provider: cr2.result?.config?.model_provider,
    model: cr2.result?.config?.model,
  });

  // ── 5. 试试写未类型化的表（model_providers 下新增一个 provider）
  const cw2 = await send('config/value/write', {
    keyPath: 'model_providers.gamma',
    mergeStrategy: 'upsert',
    value: { name: 'Gamma', base_url: 'http://127.0.0.1:9/v1', wire_api: 'responses', requires_openai_auth: false },
  });
  out('config/value/write(model_providers.gamma, upsert)', cw2.result ?? cw2);
  out('写后 config.toml', readFileSync(join(home, 'config.toml'), 'utf8'));

  // ── 6. thread/start 的覆盖是否持久 ─────────────────────────────
  const st = await send('thread/start', {
    cwd,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    modelProvider: 'alpha',
  });
  out('thread/start(approvalPolicy=never, sandbox=read-only)', {
    ok: !st.timeout && !st.error,
    error: st.error ?? null,
    threadId: st.result?.thread?.id ?? null,
  });
  const cr3 = await send('config/read', { cwd });
  out('thread/start 之后 config 里的值（判断是否持久化）', {
    approval_policy: cr3.result?.config?.approval_policy,
    sandbox_mode: cr3.result?.config?.sandbox_mode,
    model_provider: cr3.result?.config?.model_provider,
  });

  out('CODEX_HOME 内容', readdirSync(home));
} catch (e) {
  out('探针异常', String(e?.stack ?? e));
} finally {
  child.kill('SIGKILL');
  if (stderr.trim()) out('app-server stderr 尾部', stderr.split('\n').slice(-12).join('\n'));
}
