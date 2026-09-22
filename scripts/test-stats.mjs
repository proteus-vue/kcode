#!/usr/bin/env node
/**
 * 测试统计：把「测试数量」从人工维护改成自动生成 + CI 比对。
 *
 * # 为什么需要
 *
 * README 与验收报告里的「198 项 Rust 测试」「60 项前端测试」是手写的数字，
 * 代码一改就过期，而**这个项目的主张恰恰是「你能验证我在做什么」**——
 * 一个对不上的数字会直接削弱它。协议事实清单（`docs/protocol-facts.md`）
 * 已经用「自动生成 + CI 漂移检查」解决了同类问题，这里照同一套做法办。
 *
 * # 数字从哪来
 *
 * 全部来自**真实执行**，而不是源码扫描（后者会与实跑数量不一致）：
 *   - Rust   : 逐个 crate `cargo test -p <crate>`，汇总 `test result:` 行
 *   - 前端   : `vitest run --reporter=json` 的统计
 *   - 协议契约: 三个 contract 脚本的「结果: N/N 通过」
 *
 * 任一环节有失败就退出码 2 且**不写文件**——统计文件本身就是一份
 * 「这些数字都跑通过」的声明，不能在不成立时生成。
 *
 * # 用法
 *
 *   node scripts/test-stats.mjs           # 重新统计并写入 docs/test-stats.md 与 README 区间
 *   node scripts/test-stats.mjs --check   # 只比对（CI 用），有漂移则退出码 1
 *
 * 退出码：0 一致/已更新；1 存在漂移；2 有测试失败或环境缺失。
 *
 * 注意：本脚本会真的跑一遍全部测试（含三个契约脚本，需要 codex 二进制）。
 * CI 里放在 **rust job**，因为那是唯一同时具备 cargo、node 与 codex 二进制的地方。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const STATS_DOC = join(ROOT, 'docs/test-stats.md');
const README = join(ROOT, 'README.md');
const BEGIN = '<!-- test-stats:begin -->';
const END = '<!-- test-stats:end -->';

const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } });
const CHECK = values.check;

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(2); };

// ── 定位 cargo（GUI/沙箱环境常不在 PATH 里）───────────────────────────────
function locateCargo() {
  const candidates = ['cargo', join(process.env.HOME ?? '', '.cargo', 'bin', 'cargo')];
  for (const c of candidates) {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return c;
  }
  return null;
}

// ── Rust：按 package 跑测试，从 `test result:` 行汇总 ────────────────────
//
// 逐个 package 跑（而不是 `--workspace`）是为了能说清「哪个 crate 有多少项」——
// workspace 的输出只给产物路径（kcode_app-db5377762cb7376e），没法归属。
const RUST_PACKAGES = ['kcode-bridge', 'kcode-domain', 'kcode-app', 'kcode-desktop'];

/** `unittests src/lib.rs` → `src/lib.rs（单元测试）`；集成测试保持原路径。 */
function prettifyTarget(raw) {
  const unit = raw.match(/^unittests\s+(.+)$/);
  return unit ? `${unit[1]}（单元测试）` : raw;
}

function rustStats(cargo) {
  const suites = [];
  for (const pkg of RUST_PACKAGES) {
    console.log(`· 运行 cargo test -p ${pkg} …`);
    const r = spawnSync(cargo, ['test', '-p', pkg], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error) fail(`cargo test -p ${pkg} 无法执行：${r.error.message}`);

    // cargo 把 `Running …` 打到 stderr、测试进程把 `test result:` 打到 stdout，
    // 两条流各自有序且一一对应，因此按**位置**配对，而不是拼接后顺序解析
    // （拼接会把所有结果行排到目标行之前，导致认不出是哪个测试目标）。
    const targets = `${r.stderr ?? ''}`
      .split('\n')
      .map((l) => l.match(/^\s+(Running|Doc-tests)\s+(.+?)(?:\s+\(|$)/))
      .filter(Boolean)
      .map((m) => (m[1] === 'Doc-tests' ? '文档测试' : prettifyTarget(m[2])));
    const results = `${r.stdout ?? ''}`
      .split('\n')
      .map((l) => l.match(/^test result:\s*(\w+)\.\s*(\d+) passed;\s*(\d+) failed;\s*(\d+) ignored/))
      .filter(Boolean);

    results.forEach((result, i) => {
      suites.push({
        package: pkg,
        name: targets[i] ?? '(未匹配到测试目标)',
        passed: Number(result[2]),
        failed: Number(result[3]),
        ignored: Number(result[4]),
      });
    });
    if (results.length === 0) {
      const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n').filter((l) => l.trim()).slice(-8).join('\n');
      fail(`${pkg} 未产出任何测试结果（多半是编译失败）：\n${tail}`);
    }
  }
  const sum = (k) => suites.reduce((a, s) => a + s[k], 0);
  return { suites, passed: sum('passed'), failed: sum('failed'), ignored: sum('ignored') };
}

// ── 前端：vitest 的 JSON 报告 ─────────────────────────────────────────────
function webStats() {
  console.log('· 运行 vitest run …');
  const bin = join(ROOT, 'node_modules', '.bin', 'vitest');
  if (!existsSync(bin)) fail('未找到 node_modules/.bin/vitest，请先 npm install');
  const dir = mkdtempSync(join(tmpdir(), 'kcode-stats-'));
  const out = join(dir, 'vitest.json');
  try {
    const r = spawnSync(bin, ['run', '--reporter=json', `--outputFile=${out}`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error) fail(`vitest 无法执行：${r.error.message}`);
    if (!existsSync(out)) fail('vitest 未生成 JSON 报告');
    const report = JSON.parse(readFileSync(out, 'utf8'));
    return {
      files: report.testResults?.length ?? 0,
      total: report.numTotalTests ?? 0,
      passed: report.numPassedTests ?? 0,
      failed: report.numFailedTests ?? 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 协议契约：三个端到端脚本 ─────────────────────────────────────────────
const CONTRACTS = [
  { file: 'contract-test.mjs', label: '协议链路：握手 → 建线程 → 审批往返 → 收尾' },
  { file: 'contract-settings.mjs', label: '设置与配置：读写、覆盖作用域、隔离' },
  { file: 'contract-workbench.mjs', label: '工作台：命令执行、tty、边界' },
];

function contractStats() {
  const out = [];
  // 这些脚本按 PATH 找 `codex`（`npm run` 会自动加上 node_modules/.bin，直接 node 不会）
  const binDir = join(ROOT, 'node_modules', '.bin');
  const env = { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` };
  for (const c of CONTRACTS) {
    console.log(`· 运行 ${c.file} …`);
    const r = spawnSync(process.execPath, [join(HERE, c.file)], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env,
    });
    if (r.error) fail(`${c.file} 无法执行：${r.error.message}`);
    const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    const m = text.match(/结果:\s*(\d+)\/(\d+)\s*通过/);
    if (!m) fail(`${c.file} 未输出可解析的结果行（退出码 ${r.status}）`);
    out.push({ ...c, passed: Number(m[1]), total: Number(m[2]), status: r.status });
  }
  return out;
}

// ── 组装文本 ─────────────────────────────────────────────────────────────
function codexVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'codex.lock.json'), 'utf8')).version ?? '未知';
  } catch {
    return '未知';
  }
}

function renderDoc(rust, web, contracts) {
  const contractTotal = contracts.reduce((a, c) => a + c.total, 0);
  const rows = rust.suites
    .filter((s) => s.passed + s.failed + s.ignored > 0)
    .map((s) => `| \`${s.package}\` | ${s.name} | ${s.passed} | ${s.failed} | ${s.ignored} |`)
    .join('\n');
  const perPackage = RUST_PACKAGES
    .map((p) => {
      const total = rust.suites.filter((s) => s.package === p).reduce((a, s) => a + s.passed, 0);
      return `${p} ${total}`;
    })
    .join(' / ');
  return `# 测试统计

> 由 \`scripts/test-stats.mjs\` 自动生成，**请勿手工编辑**。
> 生成依据：当前工作区 + 锁定的 codex CLI **${codexVersion()}**。
> 本文件的含义是「这些数字都实际跑通过」——任一环节失败时脚本不会生成文件。
> 比对漂移：\`node scripts/test-stats.mjs --check\`（CI 已接入）。

## 汇总

| 类别 | 数量 | 失败 | 状态 |
|---|---|---|---|
| Rust（\`cargo test -p <crate>\`，四个 crate） | ${rust.passed} | ${rust.failed} | ${rust.failed === 0 ? '✅ 全部通过' : '❌ 有失败'} |
| 前端（\`vitest run\`） | ${web.passed} | ${web.failed} | ${web.failed === 0 ? '✅ 全部通过' : '❌ 有失败'} |
| 协议契约（真实 codex 二进制端到端） | ${contractTotal} | ${contracts.filter((c) => c.status !== 0).length} | ${contracts.every((c) => c.status === 0) ? '✅ 全部通过' : '❌ 有失败'} |

Rust 按 crate 分布：${perPackage}。
前端覆盖 ${web.files} 个测试文件；Rust 另有 ${rust.ignored} 项被显式忽略（\`#[ignore]\` 或文档测试，不计入通过数）。

## Rust 明细

| crate | 测试目标 | 通过 | 失败 | 忽略 |
|---|---|---|---|---|
${rows}

## 协议契约明细

| 脚本 | 覆盖 | 断言 | 结果 |
|---|---|---|---|
${contracts.map((c) => `| \`${c.file}\` | ${c.label} | ${c.total} | ${c.passed}/${c.total} ${c.status === 0 ? '通过' : '失败'} |`).join('\n')}

## 复现

\`\`\`bash
node scripts/test-stats.mjs          # 重新统计（会真的跑一遍全部测试）
cargo test --workspace               # 仅 Rust
npx vitest run                       # 仅前端
npm test                             # 版本校验 + 三个契约脚本 + 前端
\`\`\`
`;
}

function renderReadmeRegion(rust, web, contracts) {
  const contractTotal = contracts.reduce((a, c) => a + c.total, 0);
  return `${BEGIN}
合计 **${rust.passed} 项 Rust 测试 + ${web.passed} 项前端测试 + ${contractTotal} 项协议契约断言**——
数字由 \`scripts/test-stats.mjs\` 实际运行统计，明细见 [\`docs/test-stats.md\`](docs/test-stats.md)。
${END}`;
}

function replaceRegion(text, replacement, label) {
  const from = text.indexOf(BEGIN);
  const to = text.indexOf(END);
  if (from < 0 || to < 0) fail(`${label} 缺少 ${BEGIN} / ${END} 标记`);
  if (to < from) fail(`${label} 的标记顺序颠倒`);
  return text.slice(0, from) + replacement + text.slice(to + END.length);
}

// ── 主流程 ───────────────────────────────────────────────────────────────
const cargo = locateCargo();
if (!cargo) fail('未找到 cargo（PATH 与 ~/.cargo/bin 都没有）');

const rust = rustStats(cargo);
const web = webStats();
const contracts = contractStats();

if (rust.failed > 0 || web.failed > 0 || contracts.some((c) => c.status !== 0)) {
  console.error('\n✗ 存在失败的测试，不生成统计（数字必须都是跑通的）');
  if (rust.failed > 0) console.error(`  Rust 失败 ${rust.failed} 项`);
  if (web.failed > 0) console.error(`  前端失败 ${web.failed} 项`);
  for (const c of contracts) if (c.status !== 0) console.error(`  ${c.file} 退出码 ${c.status}`);
  process.exit(2);
}

const doc = renderDoc(rust, web, contracts);
const readmeRegion = renderReadmeRegion(rust, web, contracts);
const readme = readFileSync(README, 'utf8');
const nextReadme = replaceRegion(readme, readmeRegion, 'README.md');
const currentDoc = existsSync(STATS_DOC) ? readFileSync(STATS_DOC, 'utf8') : null;

const docDrift = currentDoc !== doc;
const readmeDrift = nextReadme !== readme;

console.log(
  `\n统计：Rust ${rust.passed}（失败 ${rust.failed}，忽略 ${rust.ignored}）｜` +
  `前端 ${web.passed}（${web.files} 文件）｜契约 ${contracts.reduce((a, c) => a + c.total, 0)}`,
);

if (CHECK) {
  if (!docDrift && !readmeDrift) {
    console.log('✓ 测试数字与文件一致');
    process.exit(0);
  }
  console.error('✗ 测试数字与文件不一致：');
  if (docDrift) console.error(`  docs/test-stats.md ${currentDoc === null ? '不存在' : '内容过期'}`);
  if (readmeDrift) console.error('  README.md 的统计区间过期');
  console.error('  运行 `node scripts/test-stats.mjs` 更新后提交');
  process.exit(1);
}

writeFileSync(STATS_DOC, doc);
writeFileSync(README, nextReadme);
console.log(`✓ 已更新 docs/test-stats.md${readmeDrift ? ' 与 README.md' : ''}`);
