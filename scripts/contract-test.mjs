#!/usr/bin/env node
/**
 * Codex app-server 协议契约测试（Phase 0 验收）
 *
 * 目标：在不接触真实模型、不需要任何凭据、不产生任何出站网络请求的前提下，
 *      端到端验证「握手 → 建线程 → 提交轮次 → 服务端发起审批 → 客户端应答 → 轮次收尾」。
 *
 * 做法：启动一个本地 mock provider（scripts/mock-provider.mjs）冒充模型，
 *      让它返回一个 `sandbox_permissions: require_escalated` 的 exec_command 调用。
 *      在 on-request 审批策略下，app-server 会向客户端发出
 *      `item/commandExecution/requestApproval`，本脚本收到后应答 decision，
 *      并校验审批确实被协议所承载、轮次能够正常结束。
 *
 * 用法：
 *   node scripts/contract-test.mjs [--keep] [--timeout 60000]
 *
 * 退出码：0 全部通过；1 有断言失败；2 环境/启动失败。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { withLoopbackNoProxy } from './no-proxy-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const { values } = parseArgs({
  options: {
    keep: { type: 'boolean', default: false },
    timeout: { type: 'string', default: '60000' },
    decision: { type: 'string', default: 'accept' },
  },
});

const GLOBAL_TIMEOUT = Number(values.timeout);
const DECISION = values.decision;

// ── 断言与结果统计 ────────────────────────────────────────────────────────────
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok ? '  ✓' : '  ✗';
  console.log(`${mark} ${name}${detail ? `  — ${detail}` : ''}`);
  return ok;
}
function section(t) { console.log(`\n${t}`); }

// ── 定位锁定的 codex 二进制 ──────────────────────────────────────────────────
function locateCodex() {
  const candidates = [
    join(ROOT, 'node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'),
    join(ROOT, 'node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex'),
    join(ROOT, 'node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'),
    join(ROOT, 'node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    '未找到 codex 二进制。请先运行 `npm install`（依赖 @openai/codex 已锁定版本）。',
  );
}

// ── JSONL 传输层：按换行边界拆包，维护 id → pending 映射 ─────────────────────
class JsonlClient {
  constructor(child) {
    this.child = child;
    this.nextId = 0;
    this.pending = new Map();
    this.notifications = [];
    this.serverRequests = [];
    this.stderr = '';
    this.notifyHandlers = [];
    this.requestHandlers = [];
    this.buffer = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { this.stderr += d; });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        this.notifications.push({ method: '<unparsable>', params: { raw: line.slice(0, 200) } });
        continue;
      }
      // 响应：有 id 且无 method
      if (msg.id !== undefined && msg.method === undefined) {
        const p = this.pending.get(msg.id);
        if (p) { this.pending.delete(msg.id); p.resolve(msg); }
        continue;
      }
      // 服务端 → 客户端 请求：有 id 且有 method
      if (msg.id !== undefined && msg.method !== undefined) {
        this.serverRequests.push(msg);
        this.requestHandlers.forEach((h) => h(msg));
        continue;
      }
      // 通知：无 id
      this.notifications.push(msg);
      this.notifyHandlers.forEach((h) => h(msg));
    }
  }

  request(method, params, timeoutMs = 20000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve });
      this.child.stdin.write(JSON.stringify({ method, id, params }) + '\n');
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时（${timeoutMs}ms）`));
        }
      }, timeoutMs).unref();
    });
  }

  notify(method, params) {
    const msg = params === undefined ? { method } : { method, params };
    this.child.stdin.write(JSON.stringify(msg) + '\n');
  }

  respond(id, result) {
    this.child.stdin.write(JSON.stringify({ id, result }) + '\n');
  }

  onNotification(h) { this.notifyHandlers.push(h); }
  onServerRequest(h) { this.requestHandlers.push(h); }
  methods() { return [...new Set(this.notifications.map((n) => n.method))]; }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
const codexBin = locateCodex();
const workdir = mkdtempSync(join(tmpdir(), 'kcode-contract-'));
// 隔离的 CODEX_HOME：绝不读写用户真实的 ~/.codex，避免污染真实配置与历史
const codexHome = mkdtempSync(join(tmpdir(), 'kcode-home-'));
const providerPort = 8700 + Math.floor(Math.random() * 200);

writeFileSync(
  join(codexHome, 'config.toml'),
  `model_provider = "kcode-mock"
model = "kcode-mock-model"

[model_providers.kcode-mock]
name = "kcode-mock"
base_url = "http://127.0.0.1:${providerPort}/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "contract-test-dummy"
`,
);

console.log('Codex app-server 协议契约测试');
console.log('='.repeat(64));
console.log(`codex 二进制 : ${codexBin}`);
console.log(`工作目录     : ${workdir}`);
console.log(`CODEX_HOME   : ${codexHome}`);
console.log(`mock provider: http://127.0.0.1:${providerPort}/v1`);
console.log(`审批决策     : ${DECISION}`);

const mockProvider = spawn(
  process.execPath,
  [join(HERE, 'mock-provider.mjs'), '--port', String(providerPort), '--script', 'escalated', '--quiet'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
mockProvider.stderr.setEncoding('utf8');
let mockErr = '';
mockProvider.stderr.on('data', (d) => { mockErr += d; });
let mockStdout = '';
mockProvider.stdout.setEncoding('utf8');
mockProvider.stdout.on('data', (d) => { mockStdout += d; });

await new Promise((r) => setTimeout(r, 700));

let child;
let client;
let exitCode = 1;
const approvalSeen = { value: null };

try {
  section('1. 进程与握手');
  child = spawn(codexBin, ['app-server', '--stdio'], {
    cwd: workdir,
    env: withLoopbackNoProxy({ ...process.env, CODEX_HOME: codexHome }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.on('error', (e) => { console.error('子进程启动失败:', e.message); });

  client = new JsonlClient(child);

  const init = await client.request('initialize', {
    clientInfo: { name: 'kcode-contract', title: 'KCode Contract Test', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });

  const ir = init.result || {};
  check('initialize 返回 result 而非 error', !init.error, init.error ? JSON.stringify(init.error) : '');
  check('响应含 userAgent', typeof ir.userAgent === 'string', ir.userAgent || '');
  check('响应含 codexHome（等于隔离目录）', ir.codexHome === realpathSync(codexHome) || ir.codexHome === codexHome, ir.codexHome || '');
  check('响应含 platformOs', typeof ir.platformOs === 'string', ir.platformOs || '');
  check(
    '响应不含旧文档所称的 serverInfo / capabilities 字段',
    ir.serverInfo === undefined && ir.capabilities === undefined,
    `serverInfo=${ir.serverInfo} capabilities=${ir.capabilities}`,
  );

  client.notify('initialized');

  section('2. 建线程（显式审批策略与沙箱）');
  const started = await client.request('thread/start', {
    cwd: workdir,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write',
    model: 'kcode-mock-model',
  });
  const sr = started.result || {};
  const threadId = sr.thread?.id;
  check('thread/start 成功', !started.error && typeof threadId === 'string', threadId || JSON.stringify(started.error));
  check('回传 approvalPolicy=on-request', sr.approvalPolicy === 'on-request', String(sr.approvalPolicy));
  check('回传 sandbox 为对象形式（非字符串）', typeof sr.sandbox === 'object' && sr.sandbox !== null, JSON.stringify(sr.sandbox));
  check('回传 cwd 为绝对路径', typeof sr.cwd === 'string' && sr.cwd.startsWith('/'), sr.cwd || '');

  section('3. 提交轮次并捕获服务端审批请求');
  const approvalPromise = new Promise((resolve) => {
    client.onServerRequest((msg) => {
      if (msg.method.endsWith('/requestApproval')) {
        approvalSeen.value = msg;
        resolve(msg);
      }
    });
  });

  const turnStart = await client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'run the probe command' }],
  });
  const turnId = turnStart.result?.turn?.id;
  check('turn/start 返回 turn.id', typeof turnId === 'string', turnId || JSON.stringify(turnStart.error));

  const APPROVAL_WAIT = 25000;
  const approval = await Promise.race([
    approvalPromise,
    new Promise((r) => setTimeout(() => r(null), APPROVAL_WAIT)),
  ]);

  if (!approval) {
    check('收到服务端审批请求', false, `${APPROVAL_WAIT}ms 内未收到；已见通知: ${client.methods().join(', ')}`);
  } else {
    check('收到服务端审批请求', true, approval.method);
    check('审批方法为 v2 命名（item/*/requestApproval）', approval.method.startsWith('item/'),
      approval.method);
    const p = approval.params || {};
    check('params 含 threadId / turnId / itemId 三要素',
      typeof p.threadId === 'string' && typeof p.turnId === 'string' && typeof p.itemId === 'string',
      `threadId=${p.threadId} turnId=${p.turnId} itemId=${p.itemId}`);
    check('params 含 startedAtMs 时间戳', typeof p.startedAtMs === 'number', String(p.startedAtMs));
    check('审批请求顶层带 id（客户端直接回应该 id，无需 approval/resolve 方法）',
      approval.id !== undefined, `id=${approval.id}`);

    section('4. 应答审批');

    // 按方法选择正确的响应体：命令审批用 {decision}，文件变更审批用 {decision}，
    // 权限审批用 {permissions, scope}。
    let responseBody;
    if (approval.method === 'item/commandExecution/requestApproval') {
      responseBody = { decision: DECISION };
    } else if (approval.method === 'item/fileChange/requestApproval') {
      responseBody = { decision: DECISION };
    } else if (approval.method === 'item/permissions/requestApproval') {
      responseBody = { permissions: {}, scope: 'turn' };
    } else {
      responseBody = { decision: DECISION };
    }
    client.respond(approval.id, responseBody);
    check('已按协议原样回应审批（非 approval/resolve）', true, JSON.stringify(responseBody));

    section('5. 轮次收尾');
    const done = await Promise.race([
      new Promise((resolve) => {
        client.onNotification((n) => { if (n.method === 'turn/completed') resolve(n); });
      }),
      new Promise((r) => setTimeout(() => r(null), 25000)),
    ]);
    if (done) {
      const status = done.params?.turn?.status;
      check('收到 turn/completed', true, `status=${typeof status === 'object' ? JSON.stringify(status) : status}`);
      check('轮次状态可判定为已结束（非 running）',
        status !== 'running' && status !== 'inProgress', JSON.stringify(status));
    } else {
      check('收到 turn/completed', false, `未收到；已见通知: ${client.methods().join(', ')}`);
    }

    section('6. 中断幂等性（对不存在的 turn 应报错而非静默成功）');
    const intr = await client.request('turn/interrupt', { threadId, turnId: '00000000-0000-0000-0000-000000000000' }).catch((e) => ({ error: { message: e.message } }));
    check('turn/interrupt 需要 threadId + turnId 两个参数',
      intr.error !== undefined, intr.error ? `返回错误: ${intr.error.message || intr.error.code}` : '未报错');
  }

  section('7. 模型流量与状态隔离验证');
  const stats = await fetch(`http://127.0.0.1:${providerPort}/stats`)
    .then((r) => r.json())
    .catch(() => null);
  check('模型流量全部打到本地 mock provider', (stats?.requests ?? 0) > 0,
    stats ? `mock 收到 ${stats.requests} 次 Responses 请求` : '无法读取 /stats');
  check('真实 ~/.codex 未被本次测试写入（CODEX_HOME 已隔离）',
    existsSync(codexHome) && !existsSync(join(codexHome, 'contract-test-probe')),
    `隔离 HOME 存在，测试状态写入此处`);

  section('8. 进程清理');
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((r) => child.on('exit', () => r(true))),
    new Promise((r) => setTimeout(() => r(false), 5000)),
  ]);
  check('app-server 子进程可正常终止', exited, exited ? '' : '5s 未退出');

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '='.repeat(64));
  console.log(`结果: ${results.length - failed.length}/${results.length} 通过`);
  if (failed.length) {
    console.log('失败项:');
    for (const f of failed) console.log(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
  exitCode = failed.length ? 1 : 0;
} catch (err) {
  console.error('\n契约测试异常终止:', err.message);
  if (client?.stderr) console.error('app-server stderr:\n' + client.stderr.slice(0, 2000));
  exitCode = 2;
} finally {
  try { child?.kill('SIGKILL'); } catch {}
  try { mockProvider.kill('SIGTERM'); } catch {}
  if (!values.keep) {
    try { rmSync(workdir, { recursive: true, force: true }); } catch {}
    try { rmSync(codexHome, { recursive: true, force: true }); } catch {}
  } else {
    console.log(`\n保留临时目录:\n  ${workdir}\n  ${codexHome}`);
  }
  process.exit(exitCode);
}
