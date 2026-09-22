#!/usr/bin/env node
/**
 * 探查：真实 app-server 的 `fileChange` Item 里到底有什么？
 *
 * 为什么需要这个：我对 `FileUpdateChange` 的理解来自 JSON Schema，而 schema 只
 * 说明**字段可能存在**，不说明**实际会填什么**。特别是：
 *
 *   - `diff` 是否真的有内容（还是常为 null/空串）？
 *   - `kind` 的实际形态是否是 `{type:"add"}` 这类 tagged enum？
 *   - 变更是在审批**之前**还是**之后**到达（决定 Proposed/Applied 的划分）？
 *
 * 用 mock 模型返回 apply_patch 调用，观察真实事件流。
 *
 * 用法：node scripts/probe-filechange.mjs [--decision accept|decline]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { withLoopbackNoProxy } from './no-proxy-env.mjs';

const BIN = process.argv[2];
const DECISION = process.argv[4] ?? 'accept';

const cwd = mkdtempSync(join(tmpdir(), 'kcode-fc-cwd-'));
const home = mkdtempSync(join(tmpdir(), 'kcode-fc-home-'));
mkdirSync(join(cwd, 'src'), { recursive: true });
writeFileSync(join(cwd, 'src', 'main.rs'), 'fn main() {\n    println!("old");\n}\n');

// mock 模型：先返回一次 apply_patch，第二次回文本收尾
const PATCH = '*** Begin Patch\n*** Update File: src/main.rs\n@@\n fn main() {\n-    println!("old");\n+    println!("new");\n }\n*** Add File: src/new.rs\n+pub fn added() {}\n*** End Patch';

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
      : { type: 'function_call', id: 'fc', call_id: 'call_patch', name: 'apply_patch',
          status: 'completed', arguments: JSON.stringify({ input: PATCH }) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const ev of [
      { type: 'response.created', response: { id: 'r', status: 'in_progress', model: 'm', output: [] } },
      { type: 'response.output_item.done', output_index: 0, item: output },
      { type: 'response.completed', response: { id: 'r', status: 'completed', model: 'm', output: [output],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    res.end();
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const port = mock.address().port;

writeFileSync(join(home, 'config.toml'), `model_provider = "m"
model = "kcode-mock-model"

[model_providers.m]
name = "m"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "x"
`);

const child = spawn(BIN, ['app-server', '--stdio'], {
  cwd, env: withLoopbackNoProxy({ ...process.env, CODEX_HOME: home }), stdio: ['pipe', 'pipe', 'pipe'],
});

const timeline = [];
let buf = '', id = 0;
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    timeline.push(m);
    if (m.id !== undefined && m.method !== undefined) {
      // 服务端请求（可能是文件变更审批）
      child.stdin.write(JSON.stringify({ id: m.id, result: { decision: DECISION } }) + '\n');
      timeline.push({ __note: `→ 已应答 ${m.method} = ${DECISION}` });
    }
    if (m.id !== undefined && m.method === undefined && pending.has(m.id)) {
      pending.get(m.id)(m); pending.delete(m.id);
    }
  }
});
const send = (method, params) => new Promise((r) => {
  const my = ++id; pending.set(my, r);
  child.stdin.write(JSON.stringify({ method, id: my, params }) + '\n');
  setTimeout(() => r({ timeout: true }), 25000);
});

await send('initialize', { clientInfo: { name: 'fc-probe', title: 'FC', version: '0.1.0' } });
child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
const st = await send('thread/start', { cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write', model: 'kcode-mock-model' });
await send('turn/start', { threadId: st.result?.thread?.id, input: [{ type: 'text', text: '改文件' }] });
await new Promise((r) => setTimeout(r, 8000));

console.log('\n════════ 事件时间线 ════════');
for (const m of timeline) {
  if (m.__note) { console.log(m.__note); continue; }
  if (m.method && m.id !== undefined) console.log(`◀◀ 服务端请求 ${m.method}`);
  else if (m.method) console.log(`◀ 通知 ${m.method}`);
}

console.log('\n════════ fileChange 相关载荷全文 ════════');
let found = 0;
for (const m of timeline) {
  if (m.__note) continue;
  if (m.method === 'item/started' || m.method === 'item/completed') {
    const it = m.params?.item;
    if (it?.type === 'fileChange') {
      found++;
      console.log(`\n─── ${m.method} ───`);
      console.log(JSON.stringify(it, null, 2));
    }
  }
  if (m.method === 'item/fileChange/patchUpdated') {
    found++;
    console.log(`\n─── ${m.method} ───`);
    console.log(JSON.stringify(m.params, null, 2).slice(0, 3000));
  }
  if (m.method === 'turn/diff/updated') {
    found++;
    console.log(`\n─── ${m.method} (diff 前 800 字) ───`);
    console.log(String(m.params.diff).slice(0, 800));
  }
  if (m.method && m.method.includes('requestApproval') && m.params?.changes) {
    found++;
    console.log(`\n─── ${m.method} 的 changes ───`);
    console.log(JSON.stringify(m.params.changes, null, 2).slice(0, 3000));
  }
}
if (!found) {
  console.log('（未观察到任何 fileChange 载荷）');
  console.log('注意：apply_patch 工具可能未在此模型/配置下启用。');
}

console.log('\n════════ 工作区文件状态 ════════');
import { readFileSync, existsSync } from 'node:fs';
for (const f of ['src/main.rs', 'src/new.rs']) {
  const p = join(cwd, f);
  console.log(`  ${f}: ${existsSync(p) ? JSON.stringify(readFileSync(p, 'utf8')) : '(不存在)'}`);
}

child.kill('SIGKILL');
mock.close();
process.exit(0);
