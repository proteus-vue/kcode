#!/usr/bin/env node
/**
 * 诊断脚本：dump 一轮 accept 审批下的**全部原始协议报文与时间线**。
 *
 * 用于回答：为什么 item/completed 的 commandExecution 有时带 exitCode、有时是 null？
 * 这是排查「投影丢失信息」类问题的通用手段——先看原始流，不要猜。
 *
 * 用法： node scripts/dump-turn.mjs [--decision accept]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = process.argv[2];
const DECISION = process.argv[3] ?? 'accept';
const COMMAND = process.argv[4] ?? 'echo hello-dump';

const cwd = mkdtempSync(join(tmpdir(), 'kcode-dump-cwd-'));
const home = mkdtempSync(join(tmpdir(), 'kcode-dump-home-'));

// ── 启动 mock provider（返回一次提权命令调用）──────────────────────
const { createServer } = await import('node:http');
let mockPort;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch {}
    const prior = (parsed.input ?? []).filter((i) => i.type === 'function_call').length;
    const output = prior >= 1
      ? { type: 'message', id: 'm', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'done', annotations: [] }] }
      : { type: 'function_call', id: 'fc', call_id: 'call_mock_1', name: 'exec_command',
          status: 'completed',
          arguments: JSON.stringify({
            cmd: COMMAND, workdir: null, yield_time_ms: 3000,
            sandbox_permissions: 'require_escalated', justification: 'dump probe',
          }) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const ev of [
      { type: 'response.created', response: { id: 'r', status: 'in_progress', model: 'm', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item: output },
      { type: 'response.completed', response: { id: 'r', status: 'completed', model: 'm', output: [output],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) {
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    }
    res.end();
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
mockPort = mock.address().port;

writeFileSync(join(home, 'config.toml'), `model_provider = "m"
model = "kcode-mock-model"

[model_providers.m]
name = "m"
base_url = "http://127.0.0.1:${mockPort}/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "x"
`);

// ── 启动 app-server 并记录全部报文 ────────────────────────────────
const child = spawn(BIN, ['app-server', '--stdio'], {
  cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
});

const t0 = Date.now();
const timeline = [];
const stamp = () => `+${String(Date.now() - t0).padStart(6)}ms`;
let buf = '';
let id = 0;
const pending = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    timeline.push({ at: stamp(), msg: m });
    if (m.id !== undefined && m.method === undefined && pending.has(m.id)) {
      pending.get(m.id).resolve(m); pending.delete(m.id);
    }
    if (m.id !== undefined && m.method !== undefined) {
      // 服务端请求（审批）：按决策应答
      const decision = m.method.includes('permissions')
        ? { permissions: {}, scope: 'turn' }
        : { decision: DECISION };
      child.stdin.write(JSON.stringify({ id: m.id, result: decision }) + '\n');
      timeline.push({ at: stamp(), note: `→ 已应答 ${m.method} decision=${DECISION}` });
    }
  }
});

function send(method, params) {
  const myId = ++id;
  return new Promise((resolve) => {
    pending.set(myId, { resolve });
    child.stdin.write(JSON.stringify({ method, id: myId, params }) + '\n');
    setTimeout(() => { if (pending.delete(myId)) resolve({ timeout: true }); }, 20000);
  });
}

await send('initialize', {
  clientInfo: { name: 'dump', title: 'Dump', version: '0.1.0' },
  capabilities: { experimentalApi: true },
});
child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');

const st = await send('thread/start', {
  cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write', model: 'kcode-mock-model',
});
const threadId = st.result.thread.id;
const tu = await send('turn/start', {
  threadId, input: [{ type: 'text', text: 'run' }],
});

// 等 turn/completed
await new Promise((resolve) => {
  const check = () => {
    if (timeline.some((e) => e.msg?.method === 'turn/completed')) resolve();
    else setTimeout(check, 100);
  };
  check();
  setTimeout(resolve, 25000);
});

// turn/completed 之后再观察 3 秒，看是否有迟到的事件
const beforeCount = timeline.length;
await new Promise((r) => setTimeout(r, 3000));
const lateEvents = timeline.slice(beforeCount).filter((e) => e.msg?.method);

console.log('\n════════ 完整时间线 ════════');
for (const e of timeline) {
  if (e.note) { console.log(`${e.at}  ${e.note}`); continue; }
  const m = e.msg;
  if (m.method && m.id === undefined) {
    console.log(`${e.at}  ◀ 通知 ${m.method}${summarize(m)}`);
  } else if (m.method && m.id !== undefined) {
    console.log(`${e.at}  ◀◀ 服务端请求 ${m.method} (id=${m.id})`);
  } else if (m.error) {
    console.log(`${e.at}  ✗ 错误响应 id=${m.id} ${JSON.stringify(m.error)}`);
  } else {
    console.log(`${e.at}  ✓ 响应 id=${m.id}`);
  }
}

function summarize(m) {
  if (m.method === 'item/started' || m.method === 'item/completed') {
    const it = m.params.item;
    if (it.type === 'commandExecution') {
      return `  [commandExecution id=${it.id} status=${it.status} exitCode=${it.exitCode} output=${JSON.stringify(it.aggregatedOutput)?.slice(0, 40)}]`;
    }
    return `  [${it.type}]`;
  }
  if (m.method === 'turn/completed') return `  status=${m.params.turn.status}`;
  if (m.method === 'item/commandExecution/outputDelta') {
    return `  ${JSON.stringify(m.params.delta ?? m.params).slice(0, 80)}`;
  }
  if (m.method === 'serverRequest/resolved') return `  requestId=${m.params.requestId}`;
  return '';
}

console.log('\n════════ turn/completed 之后的迟到事件 ════════');
if (lateEvents.length === 0) console.log('（无）');
for (const e of lateEvents) console.log(`${e.at}  ${e.msg.method}`);

console.log('\n════════ commandExecution item 的完整载荷 ════════');
for (const e of timeline) {
  const m = e.msg;
  if (m?.method === 'item/started' || m?.method === 'item/completed') {
    const it = m.params.item;
    if (it.type === 'commandExecution') {
      console.log(`\n-- ${m.method} --`);
      console.log(JSON.stringify(it, null, 2));
    }
  }
}

child.kill('SIGTERM');
mock.close();
process.exit(0);
