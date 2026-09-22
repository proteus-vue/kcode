/**
 * `@` 引用查询词的解析测试。
 *
 * 这段判定的目的：**只在真正处于「引用输入」状态时才弹文件搜索**。
 * 判错的代价不对称——
 *
 * - 该弹没弹：用户以为引用功能坏了；
 * - 不该弹却弹了：用户在写邮箱地址（`user@example.com`）时
 *   突然跳出一个文件列表，输入被打断，而且很难理解为什么。
 *
 * 因此这里逐条钉住「不该触发」的情形。
 */
import { describe, expect, it } from 'vitest';
import { atQueryAt } from '../Composer';

describe('atQueryAt', () => {
  it('行首 @ 触发，查询词为其后内容', () => {
    expect(atQueryAt('@', 1)).toBe('');
    expect(atQueryAt('@src', 4)).toBe('src');
    expect(atQueryAt('@src/main.ts', 12)).toBe('src/main.ts');
  });

  it('空白后的 @ 触发（句中引用是常见用法）', () => {
    expect(atQueryAt('看一下 @comp', 9)).toBe('comp');
    expect(atQueryAt('看一下\n@comp', 9)).toBe('comp');
  });

  it('邮箱地址不触发（@ 前是字母）', () => {
    expect(atQueryAt('user@example.com', 16)).toBeNull();
  });

  it('没有 @ 不触发', () => {
    expect(atQueryAt('普通文本', 4)).toBeNull();
  });

  it('查询词里出现空白即不再触发（用户已经在写别的了）', () => {
    expect(atQueryAt('@src 然后', 8)).toBeNull();
    expect(atQueryAt('@src\n下一行', 10)).toBeNull();
  });

  it('只看光标之前的内容（光标后的 @ 不算）', () => {
    // 光标在位置 3（"abc" 之后），后面的 @src 与当前输入无关
    expect(atQueryAt('abc@src', 3)).toBeNull();
  });

  it('多个 @ 时取最靠近光标的一个', () => {
    expect(atQueryAt('@first 然后 @sec', 14)).toBe('sec');
  });

  it('光标在 @ 紧前面时不触发（还没输入查询词）', () => {
    expect(atQueryAt('abc @', 4)).toBeNull();
  });
});
