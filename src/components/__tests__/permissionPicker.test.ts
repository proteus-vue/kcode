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
