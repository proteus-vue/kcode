#!/usr/bin/env node
/**
 * 契约测试：工作台场景依赖的协议能力（文件 / 终端）。
 *
 * 断言的都是**实测语义**，不是 schema 形状。最关键的一条：
 * `command/exec` 必须显式开启流式（`tty` 或 `streamStdoutStderr`），
 * 否则只返回一次性缓冲输出——终端场景会全程一片空白。
 * 这条不看实测根本发现不了（schema 里那些标志都是「可选」）。
 *
 * 离线、零凭据、隔离 CODEX_HOME。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = process.argv[2] ?? 'codex';
const home = mkdtempSync(join(tmpdir(), 'kcode-wb-home-'));
const cwd = mkdtempSync(join(tmpdir(), 'kcode-wb-cwd-'));
mkdirSync(join(cwd, 'sub'));
writeFileSync(join(cwd, 'a.txt'), 'hello');
writeFileSync(
  join(home, 'config.toml'),
  `model_provider = "m"
model = "x"

[model_providers.m]
name = "m"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
`,
);

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
};

/** 起一个 app-server，deltas 收集 command/exec/outputDelta 的文本。 */
function startServer() {
  const child = spawn(BIN, ['app-server', '--stdio'], {
    cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = { buf: '', id: 0, pending: new Map(), deltas: [] };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    state.buf += c;
    let i;
    while ((i = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, i);
      state.buf = state.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && m.method === undefined && state.pending.has(m.id)) {
        state.pending.get(m.id)(m); state.pending.delete(m.id);
      }
      if (m.method && m.id !== undefined) {
        child.stdin.write(JSON.stringify({ id: m.id, result: { decision: 'decline' } }) + '\n');
      }
      if (m.method === 'command/exec/outputDelta') {
        state.deltas.push(Buffer.from(m.params.deltaBase64 ?? '', 'base64').toString('utf8'));
      }
    }
  });
  state.send = (method, params) => {
    const myId = ++state.id;
    return new Promise((r) => {
      state.pending.set(myId, r);
      child.stdin.write(JSON.stringify({ method, id: myId, params }) + '\n');
      setTimeout(() => { if (state.pending.delete(myId)) r({ _t: 1 }); }, 25000);
    });
  };
  state.child = child;
  return state;
}

console.log('工作台契约测试（离线，隔离 CODEX_HOME）\n');

try {
  const s = startServer();
  await s.send('initialize', {
    clientInfo: { name: 'wb', title: 'W', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  s.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');

  // ── 文件场景 ──────────────────────────────────────────────────
  console.log('1. fs/readDirectory（文件场景）');
  const d = await s.send('fs/readDirectory', { path: cwd });
  const entries = d.result?.entries ?? [];
  ok('返回直接子项', entries.length === 2, `${entries.length} 项`);
  ok('能区分目录与文件',
    entries.some((e) => e.fileName === 'sub' && e.isDirectory) &&
    entries.some((e) => e.fileName === 'a.txt' && e.isFile));
  ok('只给文件名不给路径（相对路径要客户端拼）',
    entries.every((e) => !e.fileName.includes('/')));

  const bad = await s.send('fs/readDirectory', { path: join(cwd, 'nope') });
  ok('读不存在的目录时报错', bad.error !== undefined, JSON.stringify(bad.error?.code));

  // ── 终端场景：默认（无流式标志）────────────────────────────────
  console.log('\n2. command/exec 不传流式标志');
  s.deltas.length = 0;
  const plain = await s.send('command/exec', {
    command: ['/bin/sh', '-lc', 'echo one; echo two'],
    cwd, processId: 'p-plain',
  });
  ok('仍能拿到结果（缓冲模式）', plain.result?.exitCode === 0);
  // 这条是关键：不传标志时**没有**增量通知
  ok('不产生 outputDelta（证实流式需要显式开启）', s.deltas.length === 0,
    `实际 ${s.deltas.length} 条增量`);

  // ── 终端场景：开流式 ──────────────────────────────────────────
  console.log('\n3. command/exec 开启流式（streamStdoutStderr）');
  s.deltas.length = 0;
  const streamed = await s.send('command/exec', {
    command: ['/bin/sh', '-lc', 'echo alpha; echo beta'],
    cwd, processId: 'p-stream', streamStdoutStderr: true,
  });
  ok('产生 outputDelta', s.deltas.length > 0, `${s.deltas.length} 条`);
  const joined = s.deltas.join('');
  ok('增量内容正确', joined.includes('alpha') && joined.includes('beta'), JSON.stringify(joined.slice(0, 60)));
  ok('流式后最终响应不再重复输出（避免界面重复显示）',
    (streamed.result?.stdout ?? '') === '', JSON.stringify(streamed.result?.stdout));

  // ── 终端场景：TTY ─────────────────────────────────────────────
  console.log('\n4. command/exec 开启 tty');
  s.deltas.length = 0;
  const tty = await s.send('command/exec', {
    command: ['/bin/sh', '-lc', 'echo tty-ok'],
    cwd, processId: 'p-tty', tty: true, size: { rows: 24, cols: 80 },
  });
  ok('tty 模式产生增量', s.deltas.length > 0, `${s.deltas.length} 条`);
  ok('tty 模式正常退出', tty.result?.exitCode === 0, `exitCode=${tty.result?.exitCode}`);

  // ── 空 argv 必须被拒 ──────────────────────────────────────────
  console.log('\n5. 边界');
  const empty = await s.send('command/exec', { command: [], cwd, processId: 'p-empty' });
  ok('空 argv 被拒绝（协议层也拒，但客户端应先挡）', empty.error !== undefined);

  s.child.kill('SIGKILL');
} catch (e) {
  fail++;
  console.log(`  ✗ 异常：${e?.stack ?? e}`);
}

console.log(`\n${'='.repeat(56)}`);
console.log(`结果: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
