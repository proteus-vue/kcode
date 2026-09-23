/**
 * 错误信息提取的静态检查：**禁止朴素模式**。
 *
 * # 这个检查在防什么（真实缺陷）
 *
 * Tauri 的 `invoke` 在命令返回 `Err` 时抛出的是**反序列化后的对象**
 * （我们的 `CommandError` 形如 `{ message: string }`），它不是 `Error` 实例。
 * 于是这两种看似稳妥的写法都会把真正的原因吞掉：
 *
 * | 写法 | 结果 |
 * |---|---|
 * | `e instanceof Error ? e.message : String(e)` | → `[object Object]` |
 * | `String(e)` | → `[object Object]` |
 *
 * 界面上只显示一句 `[object Object]`，用户既不知道出了什么事，也无从排查。
 *
 * # 为什么需要静态检查而不是靠自觉
 *
 * `extractErrorMessage` 早就写好了，它的文档注释里**明确写着「不能用 String(e)」**
 * —— 但实测仍有 6 个组件、13 处在用朴素写法（模拟器面板报错时界面显示
 * `[object Object]` 是用户实际看到的）。也就是说：**有一个正确的工具，
 * 不等于用了它**。这与本项目「修一处不等于修一类」的教训一致。
 *
 * 所以这个检查扫描全部源码，只允许唯一一处出现（helper 自身的兜底分支）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(__dirname, '..', '..', '..');

/** 递归收集 src 下的 ts/tsx（跳过测试文件与生成代码）。 */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'protocol') continue;
      sources(p, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 允许出现朴素模式的唯一位置。
 *
 * `useKcode.ts` 里的 `extractErrorMessage` 自身最后一行 `return String(e)` 是
 * **兜底**（前面已把所有可识别的形态处理完），保留它是正确的。
 */
const ALLOWED = new Set([join(root, 'src', 'stores', 'useKcode.ts')]);

describe('错误信息必须走 extractErrorMessage', () => {
  const files = sources(join(root, 'src'));

  it('扫描范围有效（否则检查形同虚设）', () => {
    expect(files.length, '应扫到源码文件').toBeGreaterThan(20);
    expect(
      files.some((f) => f.endsWith('SimulatorPanel.tsx')),
      '应包含组件文件',
    ).toBe(true);
  });

  it('没有 `instanceof Error ? x.message : String(x)` 这类朴素写法', () => {
    // 该模式在 e 为普通对象（Tauri 错误）时产出 [object Object]
    const pattern = /instanceof Error\s*\?\s*\w+\.message\s*:\s*String\(/;
    const bad: string[] = [];
    for (const f of files) {
      if (ALLOWED.has(f)) continue;
      const src = readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (pattern.test(line)) bad.push(`${relative(root, f)}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      bad,
      `应改用 extractErrorMessage（否则界面显示 [object Object]）：\n${bad.join('\n')}`,
    ).toEqual([]);
  });

  it('没有把错误对象直接 String() 的写法', () => {
    // 只查错误变量名，避免误伤 String(value)/String(n) 这类正常用法
    const pattern = /\bString\((e|err|error|ex|exn)\)/;
    const bad: string[] = [];
    for (const f of files) {
      if (ALLOWED.has(f)) continue;
      const src = readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        // 注释里提到这个模式是允许的（说明为何不能用）
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (pattern.test(line)) bad.push(`${relative(root, f)}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      bad,
      `应改用 extractErrorMessage（否则界面显示 [object Object]）：\n${bad.join('\n')}`,
    ).toEqual([]);
  });

  it('豁免位置确实存在那处兜底（避免豁免清单成为摆设）', () => {
    const allowed = [...ALLOWED][0];
    const src = readFileSync(allowed, 'utf8');
    expect(src, 'useKcode.ts 应仍是 extractErrorMessage 的实现处').toContain(
      'export function extractErrorMessage',
    );
    expect(src, '豁免位置应确实含 String(e) 兜底').toMatch(/return String\(e\)/);
  });
});
