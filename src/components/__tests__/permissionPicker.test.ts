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

/**
 * 输入框与对话正文必须共用同一条阅读栏宽。
 *
 * # 这个测试在防什么
 *
 * 实测对齐前的偏差：正文被 `max-width: 82ch` 约束并居中（571–697px），
 * 而输入框撑满整个中栏（1366px）——宽窗口下左边缘差 6px、右边缘差 15px，
 * 视线从正文移到输入框要横向跳一大段。
 *
 * 对齐需要**三个数值同时正确**，任何一个被单独改动都会重新错位：
 * 1. 同一个栏宽变量（--read-width）；
 * 2. 同一个水平内边距基准（.main-body 的 22px）；
 * 3. 输入区额外让出滚动条宽度（.main-body 设了 scrollbar-gutter: stable，
 *    它的居中基准比可视宽度窄一个滚动条）。
 *
 * 这三条在浏览器里只表现为「差几像素」，肉眼很难归因，所以静态钉住。
 */
describe('输入框与对话正文的栏宽对齐', () => {
  const root2 = join(__dirname, '..', '..', '..');
  const css2 = readFileSync(join(root2, 'src/styles.css'), 'utf8');
  const composerSrc = readFileSync(join(root2, 'src/components/Composer.tsx'), 'utf8');

  /**
   * 取某条规则的声明块。
   *
   * **必须先剥掉注释**：选择器文本（如 `::-webkit-scrollbar`、`.main-body`）
   * 会出现在解释它的注释里，直接 indexOf 会命中注释而不是规则，
   * 拿到一段错误的文本——这是本文件踩过的坑（断言因此假失败）。
   */
  function body(sel: string): string {
    const stripped = css2.replace(/\/\*[\s\S]*?\*\//g, '');
    // 选择器后必须紧跟 ` {`：否则 `.main-body` 会命中 `.main-body-wrap`
    // （前缀碰撞），拿到的是另一条规则的内容。
    const m = new RegExp(
      sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{',
    ).exec(stripped);
    if (!m) throw new Error(`未找到规则 ${sel}`);
    const start = m.index + m[0].length;
    return stripped.slice(start, stripped.indexOf('}', start));
  }

  it('栏宽只有一个来源（--read-width），正文与输入区都引用它', () => {
    expect(css2).toContain('--read-width:');
    expect(body('.turn'), '.turn 应用变量而非硬编码').toContain('max-width: var(--read-width)');
    expect(body('.composer-inner'), '输入区必须用同一条栏宽').toContain(
      'max-width: var(--read-width)',
    );
    // 不允许任何一处再写死 ch 值
    const hardcoded = [...css2.matchAll(/max-width:\s*\d+ch/g)];
    expect(hardcoded.map((m) => m[0]), '栏宽不应有硬编码 ch 值').toHaveLength(0);
  });

  it('输入区水平内边距与正文容器同基准（22px）并让出滚动条宽度', () => {
    const mb = body('.main-body');
    // .main-body 的 padding 形如 `calc(var(--head-h) + 16px) 22px 8px`
    // ——顶部是动态值，因此只能断言「水平两值为 22px」，不能要求 padding 后紧跟数值。
    expect(mb, '.main-body 的水平内边距应为 22px').toMatch(/22px\s+22px|22px\s+8px/);

    const c = body('.composer');
    // 左内边距必须是 22px（与正文同基准）——取 padding 简写的最后一个长度值
    const shorthand = c.match(/padding:\s*([^;]+);/)?.[1] ?? '';
    const parts = shorthand.trim().split(/\s+(?![^(]*\))/);
    expect(parts[parts.length - 1], '输入区左内边距应为 22px').toBe('22px');
    // 右内边距必须多出滚动条宽度，且引用变量而非写死数值
    expect(c, '输入区右内边距应让出滚动条宽度').toContain('calc(22px + var(--scrollbar-w))');
  });

  it('滚动条宽度同源：变量与 ::-webkit-scrollbar 引用同一个值', () => {
    expect(css2).toContain('--scrollbar-w:');
    expect(body('::-webkit-scrollbar'), '真实滚动条宽度必须用同一个变量').toContain(
      'var(--scrollbar-w)',
    );
  });

  it('输入区内容被居中（否则栏宽约束只会靠左）', () => {
    expect(body('.composer-inner')).toMatch(/margin:\s*0 auto/);
  });

  it('输入框默认高度不小于两行（此前 26px 单行显得像细条）', () => {
    const ta = body('.composer-box textarea');
    const m = ta.match(/min-height:\s*(\d+)px/);
    expect(m, '未找到 min-height').not.toBeNull();
    // 行高 1.6 × 15px ≈ 24px，两行约 48px；取 46 作为下限
    expect(Number(m![1]), '默认高度过低，输入框会显得像细条').toBeGreaterThanOrEqual(46);
  });

  it('分支不在输入区渲染（它属于工具栏的 Git 段）', () => {
    // 规格 03 §3.2 把「当前目录/分支」划给 Toolbar；StatusDock 的 Git 段
    // 已专门显示分支并带提交/推送入口，两处都显示是冗余。
    expect(composerSrc, '输入区不应再渲染分支芯片').not.toContain('当前分支');
    expect(composerSrc, '不应保留只给分支用的变量').not.toMatch(/const branch\s*=/);
  });
});
