/**
 * 仿真画面的**样式防护**。
 *
 * # 这个测试在防什么
 *
 * 用户拖动模拟器画面时，画面上出现一片蓝色遮罩。根因不是我们的叠加层，
 * 而是浏览器的**选中图片**默认行为：WebKit 会给被选中的图片整体铺一层
 * 高亮（活动窗口 + 蓝色强调色 = 整片蓝）。
 *
 * 实测证据（WKWebView，与 Tauri 同引擎）：
 *   · 未选中        → 图片区均值 (142,128,169)，色偏 B-R 27
 *   · 选中整页      → 图片区均值 (134,164,220)，色偏 B-R **86**
 *   · 加 user-select:none 后再选中 → 回到 (142,128,169)
 * 用户截图那块遮罩的色偏是 **81**，与 86 同一现象。
 *
 * # 为什么用静态检查而不是渲染测试
 *
 * 「拖动时选区高亮会不会出现」取决于 WebKit 的选词行为与窗口激活状态，
 * jsdom 里根本没有布局与选词引擎，写不出可信的渲染断言。但这一条修法的
 * 本质是**两个 CSS 声明的存在性**，静态检查能可靠钉住，而且失败信息能
 * 直接说明后果——这正是这个仓库既有的 reviewStyles.test.ts 的思路。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');
const rawCss = readFileSync(join(root, 'src/styles.css'), 'utf8');

/**
 * 剥掉注释后的 CSS。
 *
 * **必须剥**：取规则的朴素写法是「从选择器起找第一个 `}`」，
 * 而注释里合法地可以出现 `}`——本项目就有一条注释写着 `draggable={false}`，
 * 于是规则被从中间截断，断言拿到的是一段残缺文本（我第一版就这么失败的：
 * 断言「找不到 -webkit-user-drag」，而它其实在文件里）。
 * 注释里的花括号不影响 CSS 解析，但会影响这种文本层面的提取。
 */
const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');

/** 取出 CSS 里包含某选择器的整条规则（选择器 + 声明块）。 */
function ruleFor(selectorFragment: string): string {
  const i = css.indexOf(selectorFragment);
  if (i < 0) throw new Error(`未找到规则 ${selectorFragment}`);
  const open = css.indexOf('{', i);
  return css.slice(i, css.indexOf('}', open) + 1);
}

describe('仿真画面：拖动不能被浏览器当成选词', () => {
  it('画面图层禁用了选中（否则拖动会触发蓝色选区高亮）', () => {
    const rule = ruleFor('.sim-screen > *:not(.sim-elements)');
    expect(rule, '画面图层必须不可选中').toContain('user-select: none');
    // -webkit- 前缀不能省：Tauri 在 macOS 上跑的是 WKWebView
    expect(rule, 'WKWebView 需要 -webkit- 前缀').toContain('-webkit-user-select: none');
  });

  it('元素清单**保持可选**（那是要复制的文字，不能被一起禁掉）', () => {
    // 正向断言：例外确实写在选择器里
    expect(css).toContain('.sim-screen > *:not(.sim-elements)');
    // 反向断言：不能有一条「禁掉整个 .sim-screen 子树」的规则——
    // 那样连元素清单也选不中了，而用户需要复制里面的元素名
    const blanket = /\.sim-screen\s+[\w*]+\s*\{[^}]*user-select:\s*none/;
    expect(
      blanket.test(css),
      '不应存在把整个 .sim-screen 子树禁选的规则（会把元素清单也禁掉）',
    ).toBe(false);
  });

  it('画面图片禁用了原生拖拽（原生拖影同样像一块遮罩）', () => {
    const rule = ruleFor('.sim-screen img');
    expect(rule, '应禁用原生图片拖拽').toContain('-webkit-user-drag: none');
  });
});
