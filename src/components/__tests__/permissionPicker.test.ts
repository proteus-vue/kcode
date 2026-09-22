/**
 * 浮层裁剪的结构性防护。
 *
 * # 这个测试在防什么
 *
 * `.ctx-chips` 为了「芯片不换行」设了 `overflow: hidden`，而权限浮层
 * 是向上弹出的（顶部高于容器顶边）——留在原地会被整个裁掉。
 * 症状是**「点了没反应」**：DOM 存在、样式正确、React 状态也对，
 * 但命中测试落在后面的 textarea 上。
 *
 * 这类问题在代码审查、单元测试、DOM 快照里全都看不出来，
 * 只有真去点才发现（本项目实测过一次）。所以这里用静态检查钉住：
 * 浮层必须走 portal，且不能有任何祖先设了 overflow 裁剪。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// __dirname 已是 src/components/__tests__，回到仓库根需要三层
const root = join(__dirname, '..', '..', '..');
const pickerSrc = readFileSync(join(root, 'src/components/PermissionPicker.tsx'), 'utf8');
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');

/** 取出某条 CSS 规则的声明块。 */
function ruleBody(selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error(`未找到规则 ${selector}`);
  return css.slice(i, css.indexOf('}', i));
}

describe('权限浮层不被祖先裁剪', () => {
  it('浮层通过 portal 挂到 body，而不是留在原地', () => {
    expect(pickerSrc).toContain('createPortal');
    expect(pickerSrc).toMatch(/createPortal\([\s\S]*?document\.body[\s\S]*?\)/);
  });

  it('浮层容器用 fixed 定位（相对视口，不受祖先滚动影响）', () => {
    expect(ruleBody('.perm-layer')).toContain('position: fixed');
  });

  it('触发器所在的芯片容器必须设 overflow: hidden —— 这正是不留在原地的原因', () => {
    // 如果哪天这里不再裁剪，浮层本可以留在原地；
    // 但在此之前，portal 是必需的。这条断言记录了这个耦合。
    expect(ruleBody('.ctx-chips')).toContain('overflow: hidden');
  });

  it('浮层不能是 .ctx-chips 的后代（源码层面检查层叠关系）', () => {
    // 浮层 JSX 出现在 createPortal 之后，而不是直接嵌在 .perm-picker 里
    const pickerIdx = pickerSrc.indexOf('className="perm-picker"');
    const portalIdx = pickerSrc.indexOf('createPortal');
    expect(pickerIdx).toBeGreaterThan(-1);
    expect(portalIdx).toBeGreaterThan(-1);
    // portal 的内容里才有 .perm-menu，且它在 createPortal 之后
    const menuIdx = pickerSrc.indexOf('className="perm-menu"');
    expect(menuIdx).toBeGreaterThan(portalIdx);
  });
});

/**
 * 危险档位的悬浮态不得被通用 hover 压掉。
 *
 * # 这个测试在防什么
 *
 * `.perm-trigger:hover:not(:disabled)` 的特异性是 (0,3,0)——`:not()` 会把它
 * 括号里的选择器计入，`:disabled` 白送一级。而 `.perm-trigger.is-danger`
 * 只有 (0,2,0)。于是鼠标悬浮在「完全访问」上时：背景/文字/边框被换成常规
 * 灰色，但 `.perm-trigger.is-danger .icon`（(0,3,0)，靠顺序胜出）仍是黄色
 * ——出现「灰底 + 白字 + 黄图标」的混色态。真机截图确认过。
 *
 * 这类问题在 DOM 测试里完全看不出来（jsdom 不做样式计算），
 * 只有真机悬停才暴露。因此这里做**特异性静态检查**：任何 `.X.is-danger`
 * 的 hover 规则，其特异性必须不低于同元素的通用 `:hover` 规则。
 */
describe('危险态悬浮不被通用 hover 覆盖（特异性检查）', () => {
  /** 粗略但可靠地数特异性：id(#)、类/属性/伪类(. : [)、元素。 */
  function specificity(selector: string): [number, number, number] {
    const s = selector.trim();
    const ids = (s.match(/#[\w-]+/g) ?? []).length;
    // 伪元素（::before）不计入类级
    const classes = (s.match(/\.[\w-]+/g) ?? []).length + (s.match(/\[[^\]]+\]/g) ?? []).length;
    // `:not(X)` 计入 X 的特异性；这里把 :not(...) 内的选择器内容也数进去
    const notInner = [...s.matchAll(/:not\(([^)]*)\)/g)].map((m) => m[1]).join(' ');
    const pseudoClasses =
      (s.match(/:(?!:)[\w-]+/g) ?? []).length + (notInner.match(/\.[\w-]+/g) ?? []).length;
    const elements = (s.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
    return [ids, classes + pseudoClasses, elements];
  }

  function compare(a: [number, number, number], b: [number, number, number]): number {
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }

  /** 收集所有匹配某模式的规则（选择器 + 声明块起始位置）。 */
  function rulesMatching(re: RegExp): { selector: string; index: number }[] {
    const out: { selector: string; index: number }[] = [];
    // 选择器必须限制在**单行内**：`[^{]` 允许换行，会连同选择器上方的
    // 注释块一起吞进来（注释里没有 `{`），导致匹配失败。
    const lineRe = /^([^\n{][^\n{]*)\{/gm;
    let m: RegExpExecArray | null;
    while ((m = lineRe.exec(css))) {
      const sel = m[1].trim();
      if (re.test(sel)) out.push({ selector: sel, index: m.index });
    }
    return out;
  }

  it('危险触发按钮的 hover 特异性不低于通用 hover', () => {
    const generic = rulesMatching(/^\.perm-trigger:hover/);
    const danger = rulesMatching(/^\.perm-trigger\.is-danger:hover/);

    expect(generic.length, '未找到通用 hover 规则').toBeGreaterThan(0);
    expect(
      danger.length,
      '缺少危险态专用 hover 规则 —— 悬浮时会被通用 hover 换成灰色，与黄色图标混色',
    ).toBeGreaterThan(0);

    const g = specificity(generic[0].selector);
    const d = specificity(danger[0].selector);
    // 危险态必须 ≥ 通用态，且**顺序在后**（源码里更靠后）
    expect(compare(d, g), `危险态 ${d} 必须不低于通用态 ${g}`).toBeGreaterThanOrEqual(0);
    expect(danger[0].index, '危险态 hover 规则应写在通用 hover 之后').toBeGreaterThan(
      generic[0].index,
    );
  });

  it('危险态 hover 仍使用警示色（不是普通灰）', () => {
    const danger = rulesMatching(/^\.perm-trigger\.is-danger:hover/);
    const body = css.slice(danger[0].index, css.indexOf('}', danger[0].index));
    expect(body, '危险态 hover 应保留 warn 色').toContain('var(--warn)');
    expect(body).not.toContain('rgba(255, 255, 255');
  });
});
