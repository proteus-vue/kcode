/**
 * 错误信息提取的测试。
 *
 * # 为什么这个函数必须有测试
 *
 * 它是**所有错误提示的唯一出口**：用户看到的一切失败信息都经过它。
 * 它错了不会报错，只会让界面显示一句无意义的话（实测出现过 `[object Object]`），
 * 而真正的失败原因完全丢失——用户既不知道出了什么事，也无从排查。
 *
 * # 形状从哪来
 *
 * Tauri 的 `invoke` 在命令返回 `Err` 时抛出的是**反序列化后的值**，
 * 不是 `Error` 实例。我们的 `CommandError` 形如 `{ message: string }`，
 * 而不同 Tauri 版本/包装层还可能给出 `{ error: string }` 或
 * `{ error: { message } }`。这里逐个形状钉住。
 */
import { describe, expect, it } from 'vitest';
import { extractErrorMessage } from './useKcode';

describe('extractErrorMessage', () => {
  it('Tauri 命令错误的标准形态（用户实际踩到的那个）', () => {
    // 实测：模拟器命令失败时抛的就是这个，朴素写法会显示 [object Object]
    expect(extractErrorMessage({ message: '截图超时（设备可能无响应）' })).toBe(
      '截图超时（设备可能无响应）',
    );
  });

  it('它就是 Error 实例时取 message', () => {
    expect(extractErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('字符串原样返回', () => {
    expect(extractErrorMessage('直接抛字符串')).toBe('直接抛字符串');
  });

  it('嵌套的 error 字段（部分 Tauri 版本）', () => {
    expect(extractErrorMessage({ error: '内层原因' })).toBe('内层原因');
    expect(extractErrorMessage({ error: { message: '更深一层' } })).toBe('更深一层');
  });

  it('null / undefined 给一句人话，而不是 "null"', () => {
    for (const v of [null, undefined]) {
      const out = extractErrorMessage(v);
      expect(out, `${v} 应给出可读文本`).toBeTruthy();
      expect(out).not.toBe('null');
      expect(out).not.toBe('undefined');
    }
  });

  it('结构未知的对象退化为 JSON，而不是 [object Object]', () => {
    // 有字段就序列化出来——总比「有错误但看不出是什么」强
    const out = extractErrorMessage({ code: 42, detail: 'x' });
    expect(out).toContain('42');
    expect(out).not.toBe('[object Object]');
  });

  it('空对象退化为类型名（没有信息可给时如实说明）', () => {
    const out = extractErrorMessage({});
    expect(out).toBe('[object Object]');
  });

  it('数字/布尔等原始值也转成文本', () => {
    expect(extractErrorMessage(42)).toBe('42');
    expect(extractErrorMessage(false)).toBe('false');
  });

  it('循环引用不抛异常（序列化会失败，需兜底）', () => {
    const cyclic: Record<string, unknown> = { message: '有 message 就不走序列化' };
    cyclic.self = cyclic;
    expect(extractErrorMessage(cyclic)).toBe('有 message 就不走序列化');

    // 没有 message 且循环引用 → 序列化失败，仍要返回可读文本
    const c2: Record<string, unknown> = {};
    c2.self = c2;
    expect(() => extractErrorMessage(c2)).not.toThrow();
    expect(extractErrorMessage(c2)).toBeTruthy();
  });
});
