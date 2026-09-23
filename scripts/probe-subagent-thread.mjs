#!/usr/bin/env node
/**
 * 诊断：子代理线程能否被读回来。
 *
 * # 为什么必须先验证再做 UI
 *
 * 「点击子代理 → 在右栏看它的会话」听起来直接，但有个前置假设没被验证过：
 * **子代理的线程对我们是否可读**。协议给了 `agentThreadId` / `receiverThreadIds`，
 * 也有 `thread/read`，但：
 *
 * - 它可能只在 app-server 进程内存在（不落盘、不可 `thread/read`）；
 * - 可能需要 `includeTurns` 之外的额外分页调用（`thread/turns/list` +
 *   `thread/items/list`，协议注释明说 full-history hydration 已弃用）；
 * - 可能读得到元数据但读不到 items。
 *
 * 不先验证，就会做出一个「有入口、点开是空白或报错」的功能——那比不做更糟。
 *
 * # 做法
 *
 * mock 模型返回一个 `spawn_agent` 函数调用（工具名实测来自二进制字符串），
 * 让 app-server 真的去派生子代理；然后对拿到的 agentThreadId 试
 * `thread/read`（分别带/不带 includeTurns），把结果如实打印。
 *
 * 用法：node scripts/probe-subagent-thread.mjs <codex 二进制路径>
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const ARG = process.argv[2];
if (!ARG) {
  console.error('用法：node scripts/probe-subagent-thread.mjs <codex 二进制路径>');
  process.exit(2);
}
const BIN = ARG.includes('/') ? (isAbsolute(ARG) ? ARG : resolve(process.cwd(), ARG)) : ARG;
if (BIN.includes('/') && !existsSync(BIN)) {
  console.error(`✗ 二进制不存在：${BIN}`);
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), 'kcode-sub-home-'));
const cwd = mkdtempSync(join(tmpdir(), 'kcode-sub-cwd-'));

// mock provider：首轮发一个 spawn_agent 调用；之后回普通文本收尾。
// 子代理也会打到这个 mock，所以它同样能"干活"并收尾。
let spawnIssued = false;
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let hasToolOutput = false;
    let alreadySpawned = false;
    try {
      const parsed = JSON.parse(body);
      const input = parsed.input ?? [];
      hasToolOutput = input.some((i) => i.type === 'function_call_output');
      // 子代理的请求里带着 spawn 任务的文本，用不着区分：只要没发过 spawn
      // 就发一次；发过之后一律回文本，保证能收尾
      alreadySpawned = input.some(
        (i) => i.type === 'function_call' && i.name === 'spawn_agent',
      );
    } catch {
      /* 首帧可能非 JSON */
    }

    const items = [];
    if (!spawnIssued && !alreadySpawned) {
      spawnIssued = true;
      items.push({
        type: 'function_call',
        id: 'fc_spawn',
        call_id: 'call_spawn_1',
        name: 'spawn_agent',
        status: 'completed',
        arguments: JSON.stringify({
          agent_type: 'default',
          message: '检查一下 docs 目录里有多少个文件',
        }),
      });
    } else {
      items.push({
        type: 'message',
        id: `m_${Math.random().toString(36).slice(2, 8)}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'done', annotations: [] }],
      });
    }

    let sse = '';
    for (const ev of [
      { type: 'response.created', response: { id: 'r', status: 'in_progress', model: 'm', output: [] } },
      ...items.map((it, i) => ({ type: 'response.output_item.done', output_index: i, item: it })),
      {
        type: 'response.completed',
        response: {
          id: 'r',
          status: 'completed',
          model: 'm',
          output: items,
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ]) {
      sse += `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Content-Length': Buffer.byteLength(sse),
      Connection: 'close',
    });
    res.end(sse);
  });
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const port = mock.address().port;

writeFileSync(
  join(home, 'config.toml'),
  `model_provider = "m"
model = "kcode-mock-model"

[model_providers.m]
name = "m"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "x"
`,
);

const child = spawn(BIN, ['app-server', '--stdio'], {
  cwd,
  env: { ...process.env, CODEX_HOME: home, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
let nextId = 0;
const pending = new Map();
const notifs = [];
let stderr = '';
child.stderr.on('data', (d) => (stderr += d.toString()));
child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id !== undefined && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    } else if (m.method) {
      notifs.push(m);
    }
  }
});

const call = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { res, rej });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => rej(new Error(`${method} 超时`)), 25000);
  });

const say = (s) => console.log(s);

try {
  await call('initialize', {
    clientInfo: { name: 'kcode-sub-probe', title: 'subagent probe', version: '0.1.0' },
    capabilities: { experimental: true },
  });
  const t = await call('thread/start', {
    cwd,
    model: 'kcode-mock-model',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
  });
  const mainId = t.thread.id;
  say(`主线程：${mainId}`);
  await call('turn/start', { threadId: mainId, input: [{ type: 'text', text: '派个子代理' }] });

  await new Promise((r) => setTimeout(r, 12_000));

  // 从通知里挖子代理线程 id
  const agentIds = new Set();
  for (const n of notifs) {
    const p = n.params ?? {};
    const item = p.item ?? {};
    if (item.type === 'collabAgentToolCall') {
      for (const id of item.receiverThreadIds ?? []) agentIds.add(id);
    }
    if (item.type === 'subAgentActivity' && item.agentThreadId) agentIds.add(item.agentThreadId);
  }
  say(`收到的协作相关通知方法：${
    [...new Set(notifs.map((n) => n.method))].filter((m) => /collab|subAgent|Agent/i.test(m)).join(', ') || '（无）'
  }`);
  say(`从通知里发现的子代理线程：${agentIds.size > 0 ? [...agentIds].join(', ') : '（无）'}`);

  // 服务端是否把它当作可列出的线程
  try {
    const list = await call('thread/list', { limit: 50 });
    const ids = (list.data ?? list.threads ?? []).map((x) => x.id ?? x.threadId);
    say(`thread/list 返回 ${ids.length} 条，其中含子代理：${
      ids.filter((id) => agentIds.has(id)).join(', ') || '否'
    }`);
  } catch (e) {
    say(`thread/list 失败：${e.message}`);
  }

  // 关键验证：子代理线程能否被 thread/read 读回
  for (const id of agentIds) {
    for (const includeTurns of [false, true]) {
      try {
        const r = await call('thread/read', { threadId: id, includeTurns });
        const th = r.thread ?? {};
        const itemCount = Array.isArray(th.turns)
          ? th.turns.reduce((n, t2) => n + (t2.items?.length ?? 0), 0)
          : null;
        say(`✅ thread/read(includeTurns=${includeTurns}) 成功：status=${th.status ?? '?'} turns=${
          Array.isArray(th.turns) ? th.turns.length : '未返回'
        } items=${itemCount ?? '未返回'}`);
      } catch (e) {
        say(`❌ thread/read(includeTurns=${includeTurns}) 失败：${e.message.slice(0, 160)}`);
      }
    }
    // 分页路径（协议注释推荐的替代）
    for (const [method, params] of [
      ['thread/turns/list', { threadId: id }],
      ['thread/items/list', { threadId: id }],
    ]) {
      try {
        const r = await call(method, params);
        const arr = r.data ?? r.turns ?? r.items ?? [];
        say(`✅ ${method} 成功：${Array.isArray(arr) ? `${arr.length} 条` : JSON.stringify(r).slice(0, 120)}`);
      } catch (e) {
        say(`❌ ${method} 失败：${e.message.slice(0, 160)}`);
      }
    }
  }
  if (stderr.trim()) {
    say(`app-server stderr 尾部：${stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`);
  }
} catch (e) {
  say(`✗ 探测失败：${e.message}`);
} finally {
  child.kill();
  mock.close();
  process.exit(0);
}
