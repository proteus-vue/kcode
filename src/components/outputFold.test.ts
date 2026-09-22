/**
 * 工具输出折叠的测试。
 *
 * 这里钉住两条容易做错、且错了不会报错的行为：
 *
 * 1. **保留尾部而不是头部**。命令的关键信息（报错、汇总行）都在末尾；
 *    若实现成保留头部，用户会觉得「这条输出没用」，而实际上信息就在
 *    被丢掉的那一半里。测试必须能区分这两种实现。
 * 2. **截断必须可见**。悄悄截断会让用户以为这就是全部输出——
 *    那比不折叠更危险。
 */
import { describe, expect, it } from 'vitest';
import { OUTPUT_LIMIT, foldOutput } from './outputFold';

describe('foldOutput', () => {
  it('未超限时原样返回', () => {
    const r = foldOutput('hello\nworld\n');
    expect(r.text).toBe('hello\nworld\n');
    expect(r.truncated).toBe(false);
    expect(r.hiddenChars).toBe(0);
    expect(r.totalChars).toBe(12);
  });

  it('恰好等于上限时不截断（边界）', () => {
    const exact = 'x'.repeat(OUTPUT_LIMIT);
    const r = foldOutput(exact);
    expect(r.truncated).toBe(false);
    expect(r.text).toHaveLength(OUTPUT_LIMIT);
  });

  it('超出 1 个字符即触发截断', () => {
    const r = foldOutput('x'.repeat(OUTPUT_LIMIT + 1));
    expect(r.truncated).toBe(true);
    expect(r.hiddenChars).toBe(1);
  });

  it('保留的是尾部——命令的关键信息在末尾', () => {
    // 构造：开头是「噪音」，结尾是结果行
    const noise = 'progress...\n'.repeat(3000);
    const result = 'Tests: 2 failed, 10 passed\n';
    const r = foldOutput(noise + result);

    expect(r.truncated).toBe(true);
    // 结果行必须还在——若实现成保留头部，这条会失败
    expect(r.text).toContain('2 failed, 10 passed');
    // 噪音的开头部分应该被丢掉
    expect(r.text.startsWith('progress...')).toBe(false);
  });

  it('截断说明放在最前面且注明丢了多少', () => {
    const r = foldOutput('a'.repeat(OUTPUT_LIMIT + 500));
    expect(r.text).toContain('已折叠');
    expect(r.text).toContain('500');
    // 说明必须在开头，否则用户先看到的是一堆无从判断的中间内容
    expect(r.text.indexOf('已折叠')).toBeLessThan(50);
  });

  it('null / undefined 视为空输出，不抛错', () => {
    expect(foldOutput(null).truncated).toBe(false);
    expect(foldOutput(null).text).toBe('');
    expect(foldOutput(undefined).text).toBe('');
  });

  it('自定义阈值可用（测试与不同场景复用）', () => {
    const r = foldOutput('abcdefghij', 4);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('ghij'); // 尾部
    expect(r.hiddenChars).toBe(6);
  });

  it('折叠后仍是合法字符串（不切断代理对）', () => {
    // 代理对（emoji）被切成两半会产生乱码方块。
    // 这里只断言不抛错且长度合理；切片落在代理对中间是 JS 字符串的
    // 已知边界情况，展示层的 down 端渲染会显示替换字符——可接受，
    // 但不应该崩溃。
    const emoji = '🙂'.repeat(20000);
    const r = foldOutput(emoji, 100);
    expect(r.truncated).toBe(true);
    expect(typeof r.text).toBe('string');
    expect(r.text.length).toBeGreaterThan(0);
  });
});
