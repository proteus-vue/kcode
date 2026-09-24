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
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withLoopbackNoProxy } from './no-proxy-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const BIN = process.argv[2] ?? 'codex';
// 命令的工作目录可以是临时目录（它只是沙箱的可写目标）。
const cwd = mkdtempSync(join(tmpdir(), 'kcode-wb-cwd-'));

// ⚠️ **CODEX_HOME 不要放在临时目录下**（Linux 上踩过，2026-09-24）。
//
// Linux 上带沙箱的 `command/exec`（含 `tty: true`）需要一个
// `codex-linux-sandbox` 助手（execve wrapper）。它**不在包的 codex-path 里**
// （CI 的报错显示该目录已被搜过、无可用候选），而是由 codex 在**运行时创建**
// 到 CODEX_HOME 并加进 PATH——即告警里说的 "PATH aliases"。
// 而 codex 明确拒绝在临时目录下创建可执行助手：/tmp 全局可写，在那里放一个
// 待执行的二进制是典型的提权/符号链接攻击面。CI 上的原始告警：
//
//   WARNING: proceeding, even though we could not create PATH aliases:
//     Refusing to create helper binaries under temporary dir "/tmp"
//     (codex_home: AbsolutePathBuf("/tmp/kcode-wb-home-XXXX"))
//
// 后果不是「降级」而是**整个请求失败**：
//
//   failed to spawn command: Unable to spawn codex-linux-sandbox because:
//   No viable candidates found in PATH ".../codex-path:.../node_modules/.bin:..."
//
// 症状的迷惑性在于**同一脚本里不带 tty 的流式调用是正常的**（第 2、3 节都过），
// 只有 tty 挂——所以看起来像「PTY 有问题」，实际是「沙箱助手没地方生成」。
// 对照实验（dangerFullAccess 沙箱）一次就把这两者分开了：它 7ms 返回、增量正常。
//
// 本脚本原先用 tmpdir() 建 CODEX_HOME，于是 Linux CI 上稳定失败、macOS 上
// 永远通过（macOS 用 /usr/bin/sandbox-exec，不需要这个助手）。
//
// **产品不受影响**：应用用的是 `app_data_dir()`（Linux 上即
// `~/.local/share/<bundle-id>/kcode-home`），不在临时目录——所以这是
// **测试环境的保真度问题**：测试用了一个与生产不同的位置，而那个位置
// 恰好触发上游的安全拒绝。修它同时也让测试更接近生产形态。
// 见 docs/协议勘误与修正.md §3.34。
//
// 故放在仓库的 .tmp/ 下（已 gitignore）：既隔离，又不是临时目录。
const homeBase = join(ROOT, '.tmp');
mkdirSync(homeBase, { recursive: true });
const home = mkdtempSync(join(homeBase, 'kcode-wb-home-'));

const cleanup = () => rmSync(home, { recursive: true, force: true });

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
  // stderr 必须收集：PTY 一类的失败原因常只出现在这里。此前它被完全忽略，
  // 于是 CI 上「tty 产生 0 条增量」时手里没有任何线索（见勘误 §3.34）。
  const state = { buf: '', id: 0, pending: new Map(), deltas: [], stderr: '' };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { state.stderr += c; });
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
  const ttyStart = Date.now();
  const tty = await s.send('command/exec', {
    command: ['/bin/sh', '-lc', 'echo tty-ok'],
    cwd, processId: 'p-tty', tty: true, size: { rows: 24, cols: 80 },
  });
  const ttyMs = Date.now() - ttyStart;
  ok('tty 模式产生增量', s.deltas.length > 0, `${s.deltas.length} 条`);
  ok('tty 模式正常退出', tty.result?.exitCode === 0, `exitCode=${tty.result?.exitCode}`);

  // ── tty 失败时的诊断（仅失败时输出，正常路径不受影响）──────────
  //
  // 2026-09-24：CI（Linux）上这两条断言失败——0 条增量、exitCode undefined。
  // 已定位：**沙箱助手 `codex-linux-sandbox` 无法创建**，因为它只肯创建到
  // CODEX_HOME，而当时 CODEX_HOME 在 /tmp 下（codex 拒绝在临时目录放
  // 可执行助手）。修法是把 CODEX_HOME 移出临时目录（见文件头部说明）。
  //
  // 这段诊断保留下来：它一轮就能把「沙箱限制」与「PTY 本身的问题」分开，
  // 而下次若有别的环境踩到同类问题，靠的就是这几行。
  if (s.deltas.length === 0) {
    console.log('  ── tty 失败诊断（自动触发）──');
    console.log(`  CODEX_HOME: ${home}`);
    console.log(`  耗时: ${ttyMs}ms`);
    console.log(`  完整响应: ${JSON.stringify(tty).slice(0, 700)}`);
    const errTail = s.stderr.split('\n').filter((l) => l.trim()).slice(-6).join('\n');
    console.log(`  app-server stderr 尾部: ${errTail || '（空）'}`);
    console.log(`  环境: platform=${process.platform} arch=${process.arch}`);

    // 助手本身在不在？这一条直接分开「助手缺失」与「其它原因」两类。
    // 非 Linux 平台本就不需要它（macOS 用 /usr/bin/sandbox-exec）。
    if (process.platform === 'linux') {
      const vendorRoot = join(ROOT, 'node_modules', '@openai', `codex-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`, 'vendor');
      const candidates = [
        join(vendorRoot, 'x86_64-unknown-linux-musl', 'codex-path', 'codex-linux-sandbox'),
        join(vendorRoot, 'aarch64-unknown-linux-musl', 'codex-path', 'codex-linux-sandbox'),
        join(ROOT, 'node_modules', '.bin', 'codex-linux-sandbox'),
        join(home, 'codex-linux-sandbox'),
      ];
      for (const c of candidates) {
        console.log(`  助手候选 ${c}: ${existsSync(c) ? '存在 ✓' : '缺失'}`);
      }
    }

    s.deltas.length = 0;
    const openStart = Date.now();
    const ttyOpen = await s.send('command/exec', {
      command: ['/bin/sh', '-lc', 'echo tty-open'],
      cwd, processId: 'p-tty-open', tty: true, size: { rows: 24, cols: 80 },
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
    console.log(`  对照（dangerFullAccess 沙箱）: 增量 ${s.deltas.length} 条，`
      + `exitCode=${ttyOpen.result?.exitCode}，耗时 ${Date.now() - openStart}ms`);
    console.log('  ── 诊断结束 ──');
  }

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
// CODEX_HOME 现在建在仓库里（不在临时目录，见文件头说明），所以必须显式清理，
// 否则每跑一次就留下一个含助手二进制与状态文件的目录。
cleanup();
process.exit(fail === 0 ? 0 : 1);
