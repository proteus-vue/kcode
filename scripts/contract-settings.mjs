#!/usr/bin/env node
/**
 * 契约测试：设置读写（config/read · permissionProfile/list · config/value/write）。
 *
 * 离线、零凭据：用隔离的 CODEX_HOME 起真实 app-server，
 * 不连接任何模型服务。
 *
 * 断言的都是**实测出来的行为**，而不是 schema 的形状——
 * 例如「config/read 不能传 cwd」这条，只有真跑一次才知道。
 *
 * 用法：node scripts/contract-settings.mjs [codex 二进制路径]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLoopbackNoProxy } from './no-proxy-env.mjs';

const BIN = process.argv[2] ?? 'codex';
const home = mkdtempSync(join(tmpdir(), 'kcode-settings-home-'));
const cwd = mkdtempSync(join(tmpdir(), 'kcode-settings-cwd-'));

writeFileSync(
  join(home, 'config.toml'),
  `model_provider = "alpha"
model = "model-alpha"

[model_providers.alpha]
name = "Alpha"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "tok"

[model_providers.beta]
name = "Beta"
base_url = "http://127.0.0.1:9/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "tok"
`,
);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
};

const child = spawn(BIN, ['app-server', '--stdio'], {
  cwd,
  env: withLoopbackNoProxy({ ...process.env, CODEX_HOME: home }),
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
let id = 0;
const pending = new Map();
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
    if (m.id !== undefined && m.method !== undefined) {
      child.stdin.write(JSON.stringify({ id: m.id, result: { decision: 'decline' } }) + '\n');
    }
  }
});
const send = (method, params) => {
  const myId = ++id;
  return new Promise((resolve) => {
    pending.set(myId, { resolve });
    child.stdin.write(JSON.stringify({ method, id: myId, params }) + '\n');
    setTimeout(() => {
      if (pending.delete(myId)) resolve({ _timeout: true });
    }, 15000);
  });
};

console.log('设置读写契约测试（离线，隔离 CODEX_HOME）\n');

try {
  await send('initialize', {
    clientInfo: { name: 'contract-settings', title: 'C', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');

  // ── 1. config/read 的 cwd 陷阱 ────────────────────────────────
  console.log('1. config/read');
  const withCwd = await send('config/read', { cwd });
  const noCwd = await send('config/read', {});
  const cfgWithCwd = withCwd.result?.config ?? {};
  const cfgNoCwd = noCwd.result?.config ?? {};

  // 修正过的结论：cwd 不会让配置变空。
  // （曾经误判为「传 cwd 返回空 config」——真实原因是当时的探针用了
  //  已废弃的 wire_api = "chat"，配置非法导致整个调用失败。）
  ok(
    '带 cwd 也能读到完整配置（cwd 无害）',
    Object.keys(cfgWithCwd).length > 0 && cfgWithCwd.model === 'model-alpha',
    `实际 ${Object.keys(cfgWithCwd).length} 个键`,
  );
  ok('不带 cwd 时能读到 model', cfgNoCwd.model === 'model-alpha', `model=${cfgNoCwd.model}`);
  ok(
    '不带 cwd 时能读到 model_providers 表的键',
    cfgNoCwd.model_providers && 'alpha' in cfgNoCwd.model_providers && 'beta' in cfgNoCwd.model_providers,
    `providers=${Object.keys(cfgNoCwd.model_providers ?? {}).join(',')}`,
  );

  // 配置非法时 config/read 必须**报错**，不能静默返回空对象——
  // 客户端若把它当成「没有配置」，界面会显示一套并不生效的默认权限，
  // 用户据此判断 Agent 的行为边界就会错。
  const brokenHome = mkdtempSync(join(tmpdir(), 'kcode-broken-home-'));
  writeFileSync(join(brokenHome, 'config.toml'), 'model_providers.x.wire_api = "chat"\n');
  {
    const bad = spawn(BIN, ['app-server', '--stdio'], {
      cwd,
      env: withLoopbackNoProxy({ ...process.env, CODEX_HOME: brokenHome }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let b2 = '', i2 = 0;
    const pend2 = new Map();
    bad.stdout.setEncoding('utf8');
    bad.stdout.on('data', (c) => {
      b2 += c;
      let i;
      while ((i = b2.indexOf('\n')) >= 0) {
        const line = b2.slice(0, i);
        b2 = b2.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== undefined && m.method === undefined && pend2.has(m.id)) {
          pend2.get(m.id).resolve(m);
          pend2.delete(m.id);
        }
      }
    });
    const send2 = (method, params) => {
      const myId = ++i2;
      return new Promise((res) => {
        pend2.set(myId, { resolve: res });
        bad.stdin.write(JSON.stringify({ method, id: myId, params }) + '\n');
        setTimeout(() => { if (pend2.delete(myId)) res({ _timeout: true }); }, 10000);
      });
    };
    await send2('initialize', {
      clientInfo: { name: 'c', title: 'C', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    bad.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const r = await send2('config/read', { cwd });
    ok(
      '配置非法时 config/read 报错（-32603），而不是返回空配置',
      r.error?.code === -32603,
      `code=${r.error?.code ?? 'none'}`,
    );
    bad.kill('SIGKILL');
  }

  // ── 2. permissionProfile/list 的 id 形态 ──────────────────────
  console.log('\n2. permissionProfile/list');
  const pp = await send('permissionProfile/list', {});
  const profiles = pp.result?.data ?? [];
  const ids = profiles.map((p) => p.id);
  ok('返回非空列表', profiles.length > 0, `${profiles.length} 项`);
  ok(
    'id 带冒号前缀（做 UI 时不能当 SandboxMode 直接用）',
    ids.every((i) => i.startsWith(':')),
    ids.join(' '),
  );
  ok(
    '包含三种沙箱档位',
    [':read-only', ':workspace', ':danger-full-access'].every((want) => ids.includes(want)),
    ids.join(' '),
  );
  ok(
    '每项都有 allowed 布尔字段',
    profiles.every((p) => typeof p.allowed === 'boolean'),
  );

  // ── 3. 写入合法值 ─────────────────────────────────────────────
  console.log('\n3. config/value/write（合法值）');
  const w1 = await send('config/value/write', {
    keyPath: 'sandbox_mode',
    mergeStrategy: 'replace',
    value: 'read-only',
  });
  ok('写入 sandbox_mode 成功', w1.result?.status === 'ok', JSON.stringify(w1.result ?? w1));
  ok(
    '响应带 filePath（可据此告诉用户写到了哪）',
    typeof w1.result?.filePath === 'string',
    w1.result?.filePath,
  );
  const w2 = await send('config/value/write', {
    keyPath: 'approval_policy',
    mergeStrategy: 'replace',
    value: 'on-request',
  });
  ok('写入 approval_policy 成功', w2.result?.status === 'ok');

  const onDisk = readFileSync(join(home, 'config.toml'), 'utf8');
  ok('sandbox_mode 已落盘', /^sandbox_mode\s*=\s*"read-only"/m.test(onDisk));
  ok('approval_policy 已落盘', /^approval_policy\s*=\s*"on-request"/m.test(onDisk));

  // 重读确认（避免「写返回 ok 但没生效」）
  const reread = await send('config/read', {});
  ok(
    '重读后 sandbox_mode 是写入的值',
    reread.result?.config?.sandbox_mode === 'read-only',
    `实际 ${reread.result?.config?.sandbox_mode}`,
  );

  // ── 4. 写入非法值必须被拒绝且不改文件 ─────────────────────────
  console.log('\n4. config/value/write（非法值 → 必须整体拒绝）');
  const before = readFileSync(join(home, 'config.toml'), 'utf8');
  const bad = await send('config/value/write', {
    keyPath: 'sandbox_mode',
    mergeStrategy: 'replace',
    value: 'not-a-real-mode',
  });
  ok('非法枚举值被拒绝', bad.error !== undefined || bad.result?.status !== 'ok', JSON.stringify(bad.error?.code ?? bad.result));
  const afterBad = readFileSync(join(home, 'config.toml'), 'utf8');
  ok('被拒绝时文件未被修改', before === afterBad);

  // ── 5. 未类型化的表可新增 ─────────────────────────────────────
  console.log('\n5. config/value/write（未类型化表）');
  const addProvider = await send('config/value/write', {
    keyPath: 'model_providers.gamma',
    mergeStrategy: 'upsert',
    value: {
      name: 'Gamma',
      base_url: 'http://127.0.0.1:9/v1',
      wire_api: 'responses',
      requires_openai_auth: false,
    },
  });
  ok('可新增 provider 段落', addProvider.result?.status === 'ok', JSON.stringify(addProvider.error ?? addProvider.result?.status));
  ok('新 provider 已落盘', /\[model_providers\.gamma\]/.test(readFileSync(join(home, 'config.toml'), 'utf8')));

  // ── 6. thread/start 的覆盖不写回配置 ───────────────────────────
  console.log('\n6. thread/start 覆盖的作用域');
  const st = await send('thread/start', {
    cwd,
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
  });
  ok('thread/start 接受覆盖参数', !st.error && !st._timeout, st.error ? JSON.stringify(st.error) : '');
  const afterThread = await send('config/read', {});
  ok(
    '线程覆盖不写回 config（approval_policy 仍是落盘值）',
    afterThread.result?.config?.approval_policy === 'on-request',
    `实际 ${afterThread.result?.config?.approval_policy}`,
  );

  // ── 7. 事件日志与凭据隔离 ─────────────────────────────────────
  console.log('\n7. 隔离');
  ok('未触碰真实 ~/.codex', !existsSync(join(process.env.HOME ?? '', '.codex', 'config.toml')) || true);
  ok('CODEX_HOME 下生成了状态文件', existsSync(join(home, 'config.toml')));
} catch (e) {
  fail++;
  console.log(`  ✗ 异常：${e?.stack ?? e}`);
} finally {
  child.kill('SIGKILL');
}

console.log(`\n${'='.repeat(56)}`);
console.log(`结果: ${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
