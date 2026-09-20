/**
 * 视口尺寸策略的测试。
 *
 * 这些数字直接决定「网页能不能正常排版、有没有滚动条、有没有黑边」，
 * 而错的时候不会报错——只会显示成一团。所以逐条钉住。
 */
import { describe, expect, it } from 'vitest';
import { fillViewport, fitViewport, fixedViewport, SIZE_PRESETS } from './viewportSize';

describe('fitViewport（适应窗口）', () => {
  it('CSS 宽度不低于下限——低于它页面会退回移动版布局', () => {
    // 右栏实际只有 ~460px；若 CSS 宽度跟着面板走，拿到的是手机版页面
    const v = fitViewport(460, 700);
    expect(v.cssWidth).toBeGreaterThanOrEqual(1024);
  });

  it('用桌面比例（16:9）而不是面板自身的窄高比', () => {
    // 实测教训：按面板宽高比反推会得到 1024×1646 这类极端竖向视口，
    // 桌面版网页按它排版后首屏元素被拉得很散、中间大片空白。
    const v = fitViewport(460, 700);
    expect(v.cssHeight / v.cssWidth).toBeCloseTo(9 / 16, 3);
  });

  it('缩放后不超过可用空间', () => {
    for (const [w, h] of [[460, 700], [800, 600], [300, 1200]] as const) {
      const v = fitViewport(w, h);
      expect(v.pixelWidth).toBeLessThanOrEqual(w + 0.5);
      expect(v.pixelHeight).toBeLessThanOrEqual(h + 0.5);
    }
  });

  it('不放大（scale 上限 1）', () => {
    const v = fitViewport(2000, 1200);
    expect(v.scale).toBeLessThanOrEqual(1);
  });

  it('面板极窄时缩放系数很小但仍是正数', () => {
    const v = fitViewport(200, 400);
    expect(v.scale).toBeGreaterThan(0);
    expect(v.scale).toBeLessThan(0.3);
  });
});

describe('fixedViewport（固定尺寸）', () => {
  it('CSS 尺寸保持给定值', () => {
    const v = fixedViewport(1280, 720, 460, 700);
    expect(v.cssWidth).toBe(1280);
    expect(v.cssHeight).toBe(720);
  });

  it('按可用空间缩小', () => {
    const v = fixedViewport(1280, 720, 460, 700);
    expect(v.scale).toBeLessThan(1);
    expect(v.pixelWidth).toBeLessThanOrEqual(460.5);
  });

  it('小尺寸不放大（避免模糊与拉伸）', () => {
    // iPhone 预设放进大面板时不该被拉到满屏
    const v = fixedViewport(393, 852, 1200, 900);
    expect(v.scale).toBe(1);
    expect(v.pixelWidth).toBe(393);
  });
});

describe('预设清单', () => {
  it('都是正数尺寸', () => {
    for (const p of SIZE_PRESETS) {
      expect(p.width).toBeGreaterThan(0);
      expect(p.height).toBeGreaterThan(0);
    }
  });

  it('同时包含桌面与移动尺寸（覆盖两种排版）', () => {
    expect(SIZE_PRESETS.some((p) => p.width >= 1280)).toBe(true);
    expect(SIZE_PRESETS.some((p) => p.width < 800)).toBe(true);
  });
});

describe('fillViewport（填满面板）', () => {
  it('视口即面板尺寸，不缩放', () => {
    const v = fillViewport(436, 736);
    expect(v).toEqual({
      cssWidth: 436,
      cssHeight: 736,
      scale: 1,
      pixelWidth: 436,
      pixelHeight: 736,
    });
  });

  it('尺寸为 0 时不会算出非法值（面板折叠期间会经过 0）', () => {
    const v = fillViewport(0, 0);
    expect(v.cssWidth).toBeGreaterThanOrEqual(1);
    expect(v.cssHeight).toBeGreaterThanOrEqual(1);
  });

  it('像素尺寸恒等于可用空间（这就是「不留白」的含义）', () => {
    for (const [w, h] of [[300, 900], [800, 600]] as const) {
      const v = fillViewport(w, h);
      expect(v.pixelWidth).toBe(w);
      expect(v.pixelHeight).toBe(h);
    }
  });
});
