#!/usr/bin/env node
/**
 * 诊断：app-server 在本机**实际公布**了哪个 shell 工具名。
 *
 * # 为什么需要这个探针
 *
 * 集成测试里 mock 模型返回的工具调用是 `exec_command`，在 macOS 上能跑通，
 * 但在 CI（Linux）上**命令 Item 完全没产生**——三层自诊断确认了这一点：
 *
 * ```
 * 实际 items：userMessage, agentMessage
 * 轮次状态：Completed
 * 领域事件：thread_started,thread_started,turn_started,item_started,
 *          item_completed,item_started,item_completed,turn_completed
 * ```
 *
 * 即：app-server 收到了那个 function_call，却**没有发出任何命令相关事件**。
 * 最可能的原因是工具名不被识别——codex 的 shell 工具有两个名字，取决于
 * 实验特性 `unified_exec` 是否启用：
 *
 * | `unified_exec` | 工具名 |
 * |---|---|
 * | 启用（默认） | `exec_command` |
 * | 关闭 | `shell` |
 *
 * `shell_tool` 与 `unified_exec` 都是 `stable`，但**默认值可能随平台变化**。
 * 这个探针把「本机公布哪个名字」变成可读输出，从而在 Linux 上验证该假设，
 * 而不是继续猜（见 docs/协议勘误与修正.md §3.27）。
 *
 * 附带报告几个与命令执行相关的前提：`zsh` 是否存在（`shell_zsh_fork` /
 * `unified_exec_zsh_fork` 两个特性与之相关）、PTY 是否可用。
 *
 * 全程隔离 CODEX_HOME，不触碰真实 ~/.codex。
 *
 * 用法：node scripts/probe-tools.mjs [codex 二进制路径]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { withLoopbackNoProxy } from './no-proxy-env.mjs';

const ARG = process.argv[2] ?? 'codex';
// 相对路径必须解析成绝对路径：spawn 的 cwd 未指定时继承本进程 cwd，
// 但显式传路径的场景（CI 里用 find 得到相对路径）仍需归一到绝对，
// 避免「同一脚本在不同 cwd 下行为不同」。裸命令名（'codex'）保持原样，
// 交给 PATH 解析。
const BIN = ARG.includes('/') ? (isAbsolute(ARG) ? ARG : resolve(process.cwd(), ARG)) : ARG;
if (BIN.includes('/') && !existsSync(BIN)) {
  console.error(`✗ 二进制不存在：${BIN}`);
  process.exit(2);
}
const home = mkdtempSync(join(tmpdir(), 'kcode-tools-home-'));

writeFileSync(
  join(home, 'config.toml'),
  `model_provider = "m"
model = "probe-model"

[model_providers.m]
name = "m"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "x"
`,
);

const child = spawn(BIN, ['app-server', '--stdio'], {
  env: withLoopbackNoProxy({ ...process.env, CODEX_HOME: home }),
  stdio: ['pipe', 'pipe', 'pipe'],
});

// 同 probe-exec：没有 error 监听者时 spawn 失败会抛未捕获异常，
// 输出成栈回溯而不匹配调用方的输出过滤，表现为「探针没有任何输出」。
child.on('error', (e) => {
  console.log(`✗ 无法启动 app-server：${e.message}（二进制：${BIN}）`);
  process.exit(0);
});

let buf = '';
let nextId = 0;
const pending = new Map();
let stderr = '';

child.stderr.on('data', (d) => {
  stderr += d.toString();
});

function call(method, params = {}) {
  const id = ++nextId;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => reject(new Error(`${method} 超时`)), 20000);
  });
}

child.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  }
});

function report(title) {
  console.log(`\n════ ${title} ════`);
}

try {
  await call('initialize', {
    clientInfo: { name: 'kcode-tools-probe', title: 'tools probe', version: '0.1.0' },
    capabilities: {
      experimental: true,
      // 显式声明支持哪些通知，避免因缺失而静默收不到
      optOutNotificationMethods: [],
    },
  });

  report(`环境（${process.platform}-${process.arch}）`);
  console.log(`codex 二进制   : ${BIN}`);
  console.log(`zsh            : ${existsSync('/bin/zsh') ? '/bin/zsh 存在' : '未找到（shell_zsh_fork 相关）'}`);
  console.log(`PTY /dev/ptmx  : ${existsSync('/dev/ptmx') ? '可用' : '不可用'}`);

  const feats = await call('experimentalFeature/list');
  const list = Array.isArray(feats) ? feats : (feats?.features ?? feats?.data ?? []);
  const pick = (n) => list.find((f) => f.name === n);

  report('与工具名相关的实验特性');
  for (const n of [
    'unified_exec',
    'unified_exec_tty',
    'shell_tool',
    'shell_zsh_fork',
    'unified_exec_zsh_fork',
    'apply_patch_freeform',
    'apply_patch_streaming_events',
  ]) {
    const f = pick(n);
    if (!f) {
      console.log(`  ${n.padEnd(28)} （不在列表中）`);
      continue;
    }
    console.log(
      `  ${n.padEnd(28)} stage=${String(f.stage).padEnd(16)} enabled=${f.enabled} default=${f.defaultEnabled}`,
    );
  }

  // 结论：本机公布哪个 shell 工具名
  const unified = pick('unified_exec');
  const toolName = unified?.enabled ? 'exec_command' : 'shell';
  report('结论');
  console.log(`本机 app-server 公布的 shell 工具名推测为：${toolName}`);
  console.log(
    unified?.enabled
      ? '（unified_exec 启用 → exec_command；集成测试的 mock 用的就是这个，应当能跑通）'
      : '（unified_exec 关闭 → shell；那么 mock 发 exec_command 会被静默丢弃，' +
        '表现为「轮次正常收尾但没有任何命令 Item」——正是 CI 上的症状）',
  );
} catch (e) {
  console.error(`\n✗ 探测失败：${e.message}`);
  if (stderr.trim()) console.error(`  app-server stderr：${stderr.trim().slice(0, 400)}`);
  process.exitCode = 1;
} finally {
  child.kill();
}
