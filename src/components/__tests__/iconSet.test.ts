/**
 * 图标集规范测试。
 *
 * `Icon.tsx` 头部写了一套网格规范（16×16、内容区 1.75–14.25、描边继承、
 * 圆色不得硬编码）。**规范不测就会漂**——下一个图标随手写个
 * `strokeWidth="2"` 或 `stroke="#fff"`，整套的视觉重量立刻散掉，
 * 而这不会有任何报错。这里把可机检的几条钉住。
 *
 * 不测的部分（无法机检，只能靠人眼）：形状是否读得懂、箭头指向对不对。
 * `expand`/`collapse` 曾经长得一模一样就属于此类，测试发现不了。
 */
import { describe, expect, it } from 'vitest';
import { Icon, type IconName } from '../Icon';

/** 全部图标名（与 Icon.tsx 的 IconName 联合类型一一对应）。 */
const ALL: IconName[] = [
  'plus',
  'search',
  'clock',
  'plugin',
  'folder',
  'terminal',
  'file',
  'edit',
  'check',
  'close',
  'chevron',
  'dot',
  'shield',
  'cpu',
  'layers',
  'bell',
  'branch',
  'pin',
  'send',
  'stop',
  'compass',
  'sparkle',
  'wrench',
  'expand',
  'collapse',
  'refresh',
  'devices',
  'more',
  'arrow-left',
  'arrow-right',
];

/** 一个图标的形状元素（不含最外层 svg）。 */
interface Shape {
  tag: string;
  attrs: Record<string, unknown>;
}

function childrenOf(node: unknown, out: Shape[] = []): Shape[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) childrenOf(n, out);
    return out;
  }
  const n = node as { type?: unknown; props?: Record<string, unknown> };
  if (!n.props) return out;
  if (typeof n.type === 'string') {
    const { children, ...attrs } = n.props;
    out.push({ tag: n.type, attrs });
    childrenOf(children, out);
  } else {
    // Fragment
    childrenOf(n.props.children, out);
  }
  return out;
}

/** 取出图标内部的所有形状元素（跳过最外层 <svg>）。 */
function shapes(name: IconName): Shape[] {
  const el = Icon({ name }) as unknown as { props: Record<string, unknown> };
  return childrenOf(el.props.children);
}

function svgProps(name: IconName): Record<string, unknown> {
  return (Icon({ name }) as unknown as { props: Record<string, unknown> }).props;
}

describe('图标集规范', () => {
  it('每个图标都有形状（无漏定义的空图标）', () => {
    for (const name of ALL) {
      expect(shapes(name).length, `图标 ${name} 没有任何形状元素`).toBeGreaterThan(0);
    }
  });

  it('描边宽度一律继承，图标内不得覆盖', () => {
    for (const name of ALL) {
      for (const s of shapes(name)) {
        expect(
          s.attrs.strokeWidth ?? s.attrs['stroke-width'],
          `图标 ${name} 的 <${s.tag}> 覆盖了描边宽度 —— 会破坏整套的统一描边`,
        ).toBeUndefined();
      }
    }
  });

  it('颜色只用 currentColor，形状内不得硬编码色值', () => {
    for (const name of ALL) {
      for (const s of shapes(name)) {
        for (const [k, v] of Object.entries(s.attrs)) {
          if (!/colou?r$/i.test(k)) continue;
          // currentColor 与 none 是仅有的合法值
          expect(
            v,
            `图标 ${name} 的 <${s.tag}> 上 ${k} 硬编码了色值 ${String(v)} —— 图标将无法随文字颜色变化`,
          ).toMatch(/^(currentColor|none)$/);
        }
      }
    }
  });

  it('实心填充只用于点类图标（more / dot）', () => {
    // 其余图标靠描边成形，一旦出现 fill 会被填成一坨
    const solidOk = new Set<IconName>(['more', 'dot']);
    for (const name of ALL) {
      if (solidOk.has(name)) continue;
      for (const s of shapes(name)) {
        const fill = s.attrs.fill;
        expect(
          fill === undefined || fill === 'none',
          `图标 ${name} 的 <${s.tag}> 含 fill=${String(fill)} —— 非点类图标会被填实`,
        ).toBe(true);
      }
    }
  });

  it('点类图标的填充色为 currentColor（能随状态变色）', () => {
    for (const name of ['more', 'dot'] as IconName[]) {
      const filled = shapes(name).filter((s) => s.attrs.fill === 'currentColor');
      expect(filled.length, `图标 ${name} 应有实心形状`).toBeGreaterThan(0);
    }
  });

  it('圆类主轮廓半径落在规范区间（5.7–5.9），并排时视觉大小一致', () => {
    // clock 与 compass 会并排出现在状态浮层里，半径不一致会一眼看出大小不一
    for (const name of ['clock', 'compass'] as IconName[]) {
      const radii = shapes(name)
        .map((s) => Number(s.attrs.r))
        .filter((r) => Number.isFinite(r) && r > 5);
      expect(radii.length, `图标 ${name} 未找到主圆`).toBeGreaterThan(0);
      const main = Math.max(...radii);
      expect(main, `图标 ${name} 主圆半径 ${main} 小于规范下界`).toBeGreaterThanOrEqual(5.7);
      expect(main, `图标 ${name} 主圆半径 ${main} 超出规范上界`).toBeLessThanOrEqual(5.9);
    }
  });

  it('viewBox 恒为 16×16 —— 尺寸随 size 缩放的前提', () => {
    for (const name of ALL) {
      expect(svgProps(name).viewBox, `图标 ${name} viewBox 不符`).toBe('0 0 16 16');
    }
  });

  it('默认尺寸 14，可被覆盖', () => {
    expect(svgProps('plus').width).toBe(14);
    const big = Icon({ name: 'plus', size: 20 }) as unknown as { props: Record<string, unknown> };
    expect(big.props.width).toBe(20);
    expect(big.props.height).toBe(20);
  });

  /**
   * 矩形几何可机检（属性是绝对值，无歧义）；**路径数据不检查**——
   * SVG 允许省略小数点前的 0（`.44` 表示 0.44）以及把弧的 flag 与坐标
   * 连写（`011.5-1.5`），用正则抽数字会把这些读成 44、115 之类的越界值，
   * 全是假报警。路径是否越界只能靠渲染后目视。
   */
  it('矩形的四边都落在网格内（不贴边、不超界）', () => {
    let checked = 0;
    for (const name of ALL) {
      for (const s of shapes(name)) {
        const { x, y, width, height } = s.attrs;
        if (x === undefined || width === undefined) continue;
        checked++;
        const x0 = Number(x);
        const y0 = Number(y);
        const w = Number(width);
        const h = Number(height);
        expect(x0, `图标 ${name} 矩形左边贴边或越界`).toBeGreaterThanOrEqual(1);
        expect(y0, `图标 ${name} 矩形上边贴边或越界`).toBeGreaterThanOrEqual(1);
        expect(x0 + w, `图标 ${name} 矩形右边超界`).toBeLessThanOrEqual(15);
        expect(y0 + h, `图标 ${name} 矩形下边超界`).toBeLessThanOrEqual(15);
      }
    }
    expect(checked, '没有任何矩形被检查到 —— 断言形同虚设').toBeGreaterThan(0);
  });
});
