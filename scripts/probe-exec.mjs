#!/usr/bin/env node
/**
 * 诊断：与集成测试**同构**地跑一次真实命令，看 app-server 是否产生
 * `commandExecution` Item。
 *
 * # 为什么需要它（而不是只看沙箱前提）
 *
 * `scripts/probe-tools.mjs` 与沙箱前提检查都是**间接证据**。真正要回答的问题是
 * 「命令到底跑没跑」，而唯一可靠的判据是**在同一条链路上复现一次**：
 * 起 app-server → 建线程（workspace-write）→ 让 mock 模型发一个
 * `exec_command` 函数调用 → 观察收到的通知里有没有 `item/*commandExecution*`。
 *
 * 与集成测试的差别仅在于不依赖 cargo 测试框架，因此可以在 CI 的独立步骤里
 * 跑，且输出可以直接进注解面板（匿名可读）。
 *
 * # 已知的观察点
 *
 * 本地（macOS）实测，命令执行时 `item/started` 的 `item.command` 形如：
 *
 * ```
 * /bin/zsh -lc 'echo kcode-plain-probe'
 * ```
 *
 * 即 codex 用 **zsh** 执行命令。若目标环境没有 zsh，命令无法执行——而
 * app-server **不会因此报错**，表现为「轮次正常收尾、没有任何命令 Item」。
 * 本脚本把 zsh 是否存在、命令是否产生 Item 一并打出来，让这条因果关系
 * 在一次运行里可被证实或排除。
 *
 * 用法：node scripts/probe-exec.mjs <codex 二进制路径>
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';

const ARG = process.argv[2];
if (!ARG) {
  console.error('用法：node scripts/probe-exec.mjs <codex 二进制路径>');
  process.exit(2);
}

// **必须解析成绝对路径**：下面 spawn 时 `cwd` 是临时目录，相对路径会以
// 那个目录为基准解析，于是 spawn 报 ENOENT。本脚本第一次在 CI 上跑就栽在
// 这里——而且因为没挂 error 处理器，崩溃的栈回溯不匹配调用方的输出过滤，
// 最终表现是「探针完全没有输出」，白跑一轮（见下方 spawn 的 error 处理）。
const BIN = isAbsolute(ARG) ? ARG : resolve(process.cwd(), ARG);
if (!existsSync(BIN)) {
  console.error(`✗ 二进制不存在：${BIN}`);
  process.exit(2);
}

const home = mkdtempSync(join(tmpdir(), 'kcode-exec-home-'));
const cwd = mkdtempSync(join(tmpdir(), 'kcode-exec-cwd-'));

// 最小 mock provider：回一条 exec_command 函数调用。
// 与 crates/kcode-app/tests/acceptance.rs 的 exec_command() 保持同一形状，
// 这样探针观察到的行为与失败用例**同构**。
const mock = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    let hasFunctionCall = false;
    try {
      const parsed = JSON.parse(body);
      const input = parsed.input ?? [];
      hasFunctionCall = input.some((i) => i.type === 'function_call');
    } catch {
      /* 首轮请求体可能非 JSON，忽略 */
    }

    const items = hasFunctionCall
      ? // 第二轮：模型看到函数结果，收尾
        [{ type: 'message', id: 'm2', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }]
      : [
          {
            type: 'function_call',
            id: 'fc',
            call_id: 'call_mock_1',
            name: 'exec_command',
            status: 'completed',
            arguments: JSON.stringify({ cmd: 'echo kcode-exec-probe', workdir: null, yield_time_ms: 3000 }),
          },
        ];

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
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Length': Buffer.byteLength(sse), Connection: 'close' });
    res.end(sse);
  });
});

await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const port = mock.address().port;

// LOGIN_SHELL 环境变量：用于对照实验（验证 codex 是否跟随登录 shell）。
// 例如 `LOGIN_SHELL=/bin/bash node scripts/probe-exec.mjs <bin>`。
const LOGIN_SHELL = process.env.LOGIN_SHELL;

writeFileSync(
  join(home, 'config.toml'),
  `model_provider = "m"
model = "kcode-mock-model"
${LOGIN_SHELL ? `login_shell = "${LOGIN_SHELL}"\n` : ''}

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

// **必须挂 error 处理器**：spawn 失败（二进制不存在、无执行权限、架构不符）
// 会以 'error' 事件抛出；没有监听者时 Node 直接以未捕获异常退出，输出是
// 一段栈回溯——它在调用方的输出过滤里不匹配任何模式，于是「探针没有任何
// 输出」。本脚本第一次在 CI 上跑正是如此：诊断工具自己静默失败，
// 恰好复刻了它要诊断的那类缺陷。这里把它变成一行可读结论。
child.on('error', (e) => {
  console.log(`❌ 无法启动 app-server：${e.message}`);
  console.log(`   二进制：${BIN}`);
  console.log('   含义：探针自身没跑起来，不是被测对象的问题——先修探针。');
  mock.close();
  process.exit(0);
});

let buf = '';
let nextId = 0;
const pending = new Map();
const methods = [];
const commandItems = [];
let stderr = '';
child.stderr.on('data', (d) => {
  stderr += d.toString();
});

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
      methods.push(m.method);
      const item = m.params?.item;
      if (item?.type === 'commandExecution') {
        commandItems.push(item);
      }
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
  say(`环境：${process.platform}-${process.arch}`);
  say(`zsh：${existsSync('/bin/zsh') ? '/bin/zsh 存在' : '/bin/zsh 不存在'}`);
  say(`shell_zsh 命令可用：${existsSync('/bin/zsh') ? '是' : '否——codex 用 zsh 执行命令，这可能正是根因'}`);

  await call('initialize', { clientInfo: { name: 'kcode-exec-probe', title: 'exec probe', version: '0.1.0' }, capabilities: { experimental: true } });
  const t = await call('thread/start', {
    cwd,
    model: 'kcode-mock-model',
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
  });
  const tid = t.thread?.id ?? t.thread?.threadId;
  await call('turn/start', { threadId: tid, input: [{ type: 'text', text: '跑个命令' }] });

  // 等命令执行与收尾（与集成测试同量级）
  await new Promise((r) => setTimeout(r, 10_000));

  const uniq = [...new Set(methods)];
  say(`收到方法（去重）：${uniq.join(', ')}`);

  if (commandItems.length > 0) {
    const it = commandItems[commandItems.length - 1];
    say(`✅ 产生 commandExecution Item：status=${it.status} command=${String(it.command).slice(0, 80)}`);
    say(`   exitCode=${it.exitCode ?? '(无)'} aggregatedOutput=${it.aggregatedOutput ? `${String(it.aggregatedOutput).length}B` : '(无)'}`);
  } else {
    say('❌ **没有产生任何 commandExecution Item** —— 与集成测试失败现象一致');
    const cmdRelated = uniq.filter((m) => /command|exec/i.test(m));
    say(`   与命令相关的通知：${cmdRelated.join(', ') || '（一个都没有）'}`);
    say('   含义：app-server 收到了 exec_command 函数调用，但没有执行它。');
    say('   下一步看本步骤前面的「沙箱前提」里 zsh 是否存在。');
  }
  if (stderr.trim()) {
    say(`app-server stderr（尾部）：${stderr.trim().split('\n').slice(-5).join(' | ').slice(0, 400)}`);
  }
} catch (e) {
  say(`✗ 探测失败：${e.message}`);
  if (stderr.trim()) say(`  stderr：${stderr.trim().slice(0, 400)}`);
} finally {
  child.kill();
  mock.close();
  process.exit(0);
}
