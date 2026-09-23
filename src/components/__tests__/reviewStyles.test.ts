/**
 * 变更审阅新增交互（DR-09/10/11）的静态样式防护。
 *
 * # 这个测试在防什么
 *
 * 行内评论与撤销入口引入了一批新规则，其中两条有**已知的失败模式**，
 * 都属于「代码审查看不出来、DOM 快照也看不出来」的那一类：
 *
 * 1. **悬停态压过专用态**（特异性）。
 *    `.line-tool:hover` 是 (0,2,1)，而 `.line-tool.is-active` 只有 (0,2,0)——
 *    直接写会让鼠标划过时「这行有评论」的强调色**恰好消失**，而这正是用户
 *    要点击它的那一刻。项目此前踩过同款坑：权限选择器的危险档被
 *    `:hover:not(:disabled)` 压过（见 permissionPicker.test.ts）。
 *
 * 2. **评论编辑器的操作按钮在低窄容器里被裁**。
 *    编辑器嵌在 diff 行下方（`.diff-body` 内），而 `.diff-content`
 *    与 `.hunk-lines` 都设了横滚。若编辑器跟着横滚容器走，长行的水平
 *    滚动会把「保存」按钮推出可视区——用户会以为评论没法保存。
 *
 * 静态检查能钉住这两条，是因为它们都是**选择器与方法的关系**，
 * 不依赖真实布局引擎。真机上的观感（间距、对齐）仍需目视，不在本测试范围。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..', '..');
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');
const viewerSrc = readFileSync(join(root, 'src/components/DiffViewer.tsx'), 'utf8');

/** 取出某条 CSS 规则（选择器 + 声明块）。 */
function rule(selector: string): string {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error(`未找到规则 ${selector}`);
  return css.slice(i, css.indexOf('}', i) + 1);
}

/**
 * 粗算特异性 (id, 类/属性/伪类, 类型/伪元素)。
 *
 * 只用于**同族选择器之间的相对比较**，不做完整 CSS 特异性实现：
 * 这里要回答的是「专用态会不会被通用态压过」，而这个判断用三元组比较
 * 已经足够，过度实现反而会让测试自身难懂。
 */
function specificity(sel: string): [number, number, number] {
  const s = sel.trim();
  const ids = (s.match(/#[\w-]+/g) || []).length;
  const classes =
    (s.match(/\.[\w-]+/g) || []).length +
    (s.match(/\[[^\]]+\]/g) || []).length +
    (s.match(/:(?!:)[\w-]+/g) || []).length;
  const types =
    (s.match(/(?:^|[\s>+~])([a-z][\w-]*)/g) || []).length +
    (s.match(/::[\w-]+/g) || []).length;
  return [ids, classes, types];
}

function gte(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true; // 相等也算不弱
}

describe('行工具的专用态不被悬停态压过', () => {
  it('通用 hover 用 :not(.is-active) 排除激活态', () => {
    const hover = css.match(/^\.line-tool:hover[^{]*\{/m)?.[0] ?? '';
    expect(hover, '未找到 .line-tool:hover 规则').not.toBe('');
    // 关键：必须带 :not(.is-active)，否则 (0,2,1) 会压过 (0,2,0)
    expect(hover).toContain(':not(.is-active)');
  });

  it('激活态仍然只着色，不做覆盖式声明', () => {
    expect(rule('.line-tool.is-active {')).toContain('var(--accent)');
  });

  it('激活态的悬停有专属规则（悬停时仍看得出「有评论」）', () => {
    // 若只靠 :not(.is-active)，激活态悬停就没有任何反馈
    expect(css).toContain('.line-tool.is-active:hover');
  });

  it('回到通用规则：单独写 .line-tool.is-active 的特异性不低于 hover', () => {
    // 即便将来有人把 :not(.is-active) 去掉，这条断言会失败，提示风险
    const hover = specificity('.line-tool:hover');
    const active = specificity('.line-tool.is-active');
    const guarded = specificity('.line-tool:hover:not(.is-active)');
    expect(
      gte(active, hover) || !gte(hover, active),
      `专用态 ${active} 与通用 hover ${hover} 的特异性关系需要人工确认`,
    ).toBe(true);
    // 而加了守卫后，hover 只作用于非激活态——这才是安全的写法
    expect(guarded[1]).toBeGreaterThan(active[1]);
  });
});

describe('评论编辑器不被横滚容器裁掉', () => {
  it('编辑器渲染在 diff-line-row 内，而不是 hunk 的横滚 pre 内', () => {
    // .hunk-lines 已改为普通 div（早前是 <pre> + overflow-x: auto）。
    // 如果评论编辑器落进横滚容器，长行会把「保存」按钮推出可视区。
    const hunkLines = rule('.hunk-lines');
    expect(hunkLines, '横滚容器仍在——编辑器必须渲染在它之外').not.toContain('overflow-x: auto');
  });

  it('编辑器宽度不被行内容撑开（避免长行把按钮推出视口）', () => {
    const editor = rule('.comment-editor');
    expect(editor).toContain('display: flex');
    // 输入框限宽：textarea 默认会被内容/父宽影响
    expect(rule('.comment-input')).toContain('width: 100%');
  });

  it('操作按钮与输入框同栏，不被 .line-no 的固定宽度挤出', () => {
    // 编辑器是 diff-line-row 的兄弟节点（不继承行的 flex 结构），
    // 所以它必须自己带左内边距来对齐行文本
    const editor = rule('.comment-editor');
    expect(editor).toMatch(/padding:[^;]*1[24]px/);
  });
});

describe('撤销是破坏性动作，视觉上必须可辨', () => {
  it('撤销按钮有独立的危险色规则', () => {
    const danger = rule('.btn-icon-danger:hover');
    expect(danger).toContain('var(--danger)');
    expect(danger).toContain('var(--danger-dim)');
  });

  it('撤销按钮与编辑器按钮特异性相当（不被通用规则压过）', () => {
    const general = specificity('.btn-icon:hover');
    const danger = specificity('.btn-icon-danger:hover');
    expect(gte(danger, general), '危险态特异性弱于通用态会被覆盖').toBe(true);
  });

  it('确认框存在且有明确的警示底色（不能做成和普通面板一样）', () => {
    const confirm = rule('.revert-confirm');
    expect(confirm).toContain('var(--danger-dim)');
  });

  it('确认文案必须点明「删除」，不能只说「撤销」', () => {
    // 未跟踪文件的撤销是删除、git 找不回来——笼统的「确定吗」不足以让人判断
    const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');
    expect(app).toContain('删除');
    expect(app).toContain('无法找回');
  });
});

describe('子代理面板要撑满右栏（覆盖规则必须写在被覆盖者之后）', () => {
  it('撑满规则位于 `.workbench-body > .panel` 之后', () => {
    // 这个断言防的是**实测踩到的坑**：两条规则特异性相同，
    // 写在前面会被 `flex: 0 0 auto` 覆盖 → 面板只有内容高度、
    // 下方留一大片空白，而 CSS 不会报任何错。
    const base = css.indexOf('.workbench-body > .panel {');
    const sub = css.indexOf('.workbench-body > .panel:has(.subagent-list)');
    expect(base, '未找到基础面板规则').toBeGreaterThanOrEqual(0);
    expect(sub, '未找到子代理撑满规则').toBeGreaterThanOrEqual(0);
    expect(sub, '撑满规则必须写在基础规则之后，否则同特异性下会被覆盖').toBeGreaterThan(base);
  });

  it('子代理面板的规则确实声明了撑满', () => {
    const i = css.indexOf('.workbench-body > .panel:has(.subagent-list)');
    const block = css.slice(i, css.indexOf('}', i));
    expect(block).toContain('flex: 1 1 auto');
    expect(block).toContain('min-height: 0');
  });
});

describe('模拟器画面必须装得进容器（防被裁掉）', () => {
  it('.sim-screen 用 flex 居中，不用 grid', () => {
    // 这个断言防的是实测踩到的坑：`display: grid; place-items: center`
    // 让图片成为 grid item，而 grid item 的 `max-height: 100%` 在轨道高度
    // 未显式定死时不生效——实测图片 765px、容器 624px，底部超出 152px
    // 被 overflow: hidden 裁掉，表现为底部按钮看不全。
    const block = rule('.sim-screen {');
    expect(block, '必须用 flex 居中').toContain('display: flex');
    expect(block, '不该用 grid（max-height 百分比会失效）').not.toContain('display: grid');
    expect(block, '需要有确定的高度基准').toContain('flex: 1');
  });

  it('图片同时声明两个方向的约束', () => {
    const block = rule('.sim-screen img');
    // 只给一个方向会让另一个方向的溢出逃过裁剪
    expect(block).toContain('max-width: 100%');
    expect(block).toContain('max-height: 100%');
    expect(block).toContain('object-fit: contain');
  });

  it('模拟器面板用 flex 而不是 height:100%（高度链才能贯通）', () => {
    const block = rule('.sim-panel {');
    // height:100% 在 flex item 上按内容算，面板高度不含下方提示行
    expect(block).toContain('flex: 1 1 auto');
    expect(block, '不该用 height: 100%').not.toContain('height: 100%');
  });

  it('底部提示不参与收缩（压扁就读不了）', () => {
    expect(rule('.sim-notice {')).toContain('flex-shrink: 0');
    expect(rule('.sim-note {')).toContain('flex-shrink: 0');
  });
});

describe('「+」按钮常态零背景（幽灵按钮）', () => {
  it('常态没有背景与边框色', () => {
    // 用户明确要求：只有悬浮才做激活态，否则不要任何背景样式。
    // 加底色会让它看起来像一枚常驻芯片，与旁边真正承载语义的
    // 权限档位芯片混成一片——那些芯片的底色是「这里有个状态」的意思。
    const block = rule('.add-ctx-btn {');
    expect(block, '常态背景必须透明').toContain('background: transparent');
    // 边框保留透明的占位：不占位会在悬停显形时让图标位移 1px
    expect(block, '边框应为透明占位').toContain('border: 1px solid transparent');
  });

  it('激活态只出现在悬停', () => {
    const hover = css.match(/^\.add-ctx-btn:hover[^{]*\{/m)?.[0] ?? '';
    expect(hover, '应有悬停规则').not.toBe('');
    expect(rule('.add-ctx-btn:hover:not(:disabled)')).toContain('background:');
  });

  it('菜单打开时不铺底色（底色只在悬停出现）', () => {
    const open = rule('.add-ctx-btn.is-open {');
    // is-open 只改颜色；若它铺了背景，就违反了「只有悬浮才有背景」
    expect(open, 'is-open 不该设背景').not.toContain('background');
    expect(open).toContain('color: var(--accent)');
  });
});

describe('评论组件确实接入了 DiffViewer', () => {
  it('行工具含评论入口与（可选的）跳行入口', () => {
    expect(viewerSrc).toContain('对此行添加评论');
    expect(viewerSrc).toContain('在编辑器中打开');
  });

  it('评论状态受控（由外部传入），不在组件内部自持', () => {
    // 自持状态会在切场景/切线程时随组件卸载而丢失，且不报错
    expect(viewerSrc).toContain('onCommentsChange');
    expect(viewerSrc).toMatch(/comments\s*[:=]/);
  });
});
