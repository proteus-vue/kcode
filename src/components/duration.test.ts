/**
 * 时长格式化的测试。
 *
 * 重点在**进位与量级**：这类错误不会抛异常，只会让界面上的数字看起来
 * 「有点怪」（`60 秒` 而不是 `1 分`、`3900s` 而不是 `65 分`），
 * 而没人会为一个"有点怪"的数字去查代码。
 */
import { describe, expect, it } from 'vitest';
import { formatDuration } from './duration';

describe('formatDuration', () => {
  it('未提供或非法时返回空串（调用方据此不显示）', () => {
    expect(formatDuration(null)).toBe('');
    expect(formatDuration(undefined)).toBe('');
    expect(formatDuration(-1)).toBe('');
    expect(formatDuration(Number.NaN)).toBe('');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('不足 1 秒显示毫秒', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(1)).toBe('1ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('秒级显示为 Ns（截图里的「已处理 6s」）', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(6000)).toBe('6s');
    expect(formatDuration(59_000)).toBe('59s');
    // 小数秒取整——「6.4s」的精度对用户没有意义
    expect(formatDuration(6400)).toBe('6s');
    expect(formatDuration(1200)).toBe('1s');
  });

  it('分级显示为「N 分 MM 秒」，秒补零', () => {
    expect(formatDuration(60_000)).toBe('1 分');
    expect(formatDuration(65_000)).toBe('1 分 05 秒');
    expect(formatDuration(200_000)).toBe('3 分 20 秒');
    // 截图里的「已工作 13 分 20 秒」
    expect(formatDuration(13 * 60_000 + 20_000)).toBe('13 分 20 秒');
  });

  it('秒的进位正确：59.6 秒不该显示成「60 秒」', () => {
    // 59900ms → 59.9s → 四舍五入 60 秒 → 必须进位为 1 分
    expect(formatDuration(59_900)).toBe('1 分');
    // 119500ms → 1 分 59.5 秒 → 60 秒 → 进位为 2 分
    expect(formatDuration(119_500)).toBe('2 分');
  });

  it('整分不显示多余的「00 秒」', () => {
    expect(formatDuration(120_000)).toBe('2 分');
    expect(formatDuration(59 * 60_000)).toBe('59 分');
  });

  it('小时级显示为「N 小时 M 分」', () => {
    expect(formatDuration(3_600_000)).toBe('1 小时');
    expect(formatDuration(3_600_000 + 12 * 60_000)).toBe('1 小时 12 分');
    expect(formatDuration(2 * 3_600_000)).toBe('2 小时');
  });

  it('分的进位正确：59.6 分不该显示成「60 分」', () => {
    // 59 分 59.6 秒 → 秒舍入到 60 → 分钟进位到 60 → 小时进位
    // 这是两级连续进位，最容易漏（只处理第一级会得到「60 分」）
    expect(formatDuration(3_600_000 + 59.6 * 60_000)).toBe('2 小时');
    // 59 分 59.0 秒不进位，如实显示
    expect(formatDuration(3_599_000)).toBe('59 分 59 秒');
  });

  it('量级边界处不出现「60s」「60 分」这类需要用户换算的读数', () => {
    // 秒级测试里 59_900ms 会舍入到 60 秒——必须进位为「1 分」而不是「60s」
    const nearMinute = formatDuration(59_900);
    expect(nearMinute).not.toContain('60s');
    expect(nearMinute).toBe('1 分');

    // 刚过一分钟、秒部分为 0 → 只显示分钟，不画蛇添足补「00 秒」
    expect(formatDuration(60_001)).toBe('1 分');
    // 带秒时秒位补零（两位，便于纵向对齐扫读）
    expect(formatDuration(61_000)).toBe('1 分 01 秒');
    expect(formatDuration(3_600_001)).toBe('1 小时');
  });
});
