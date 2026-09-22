/**
 * 面板快捷键判定。
 *
 * 这里的核心断言是「⌘⌥B 在 macOS 上必须命中右栏」。这不是假想场景：
 * 真机上 Option 会把 e.key 从 "b" 改写成 "∫"，用 e.key 判断时该快捷键
 * 完全失效，而浏览器里的合成事件不会暴露——测试必须显式构造这个
 * 被改写的 key 才能覆盖。
 */
import { describe, expect, it } from 'vitest';
import { matchFocusComposerShortcut, matchPanelShortcut } from './panelShortcut';

/** 真机 ⌘⌥B 的事件形状：code 仍是 KeyB，key 被 Option 改写为 ∫。 */
const macOptionB = { metaKey: true, altKey: true, code: 'KeyB', key: '∫' };

describe('matchPanelShortcut', () => {
  it('⌘B 折叠左栏', () => {
    expect(matchPanelShortcut({ metaKey: true, code: 'KeyB', key: 'b' })).toBe('left');
  });

  it('⌘⌥B 折叠右栏——真机 key 被 Option 改写为 ∫ 时仍然命中', () => {
    expect(matchPanelShortcut(macOptionB)).toBe('right');
  });

  it('大写字母（CapsLock/Shift 状态）不影响判定', () => {
    // 不用 shiftKey，因为 shift 组合被显式让开；这里只验证 key 的大小写不敏感
    expect(matchPanelShortcut({ metaKey: true, code: 'KeyB', key: 'B' })).toBe('left');
  });

  it('Ctrl+B 在非 macOS 上同样生效', () => {
    expect(matchPanelShortcut({ ctrlKey: true, code: 'KeyB', key: 'b' })).toBe('left');
  });

  it('不按主修饰键不触发', () => {
    expect(matchPanelShortcut({ code: 'KeyB', key: 'b' })).toBeNull();
    expect(matchPanelShortcut({ altKey: true, code: 'KeyB', key: '∫' })).toBeNull();
  });

  it('⌘⇧B 让开，不抢系统习惯', () => {
    expect(matchPanelShortcut({ metaKey: true, shiftKey: true, code: 'KeyB', key: 'b' })).toBeNull();
  });

  it('其他字母键不触发', () => {
    expect(matchPanelShortcut({ metaKey: true, code: 'KeyN', key: 'n' })).toBeNull();
    expect(matchPanelShortcut({ metaKey: true, code: 'KeyK', key: 'k' })).toBeNull();
  });

  it('缺少 code 时回退到 key 判断', () => {
    // 少数虚拟键盘/自动化工具不填 code——退回字面 key 比完全不响应好
    expect(matchPanelShortcut({ metaKey: true, key: 'b' })).toBe('left');
    expect(matchPanelShortcut({ metaKey: true, altKey: true, key: 'b' })).toBe('right');
    // 但被 Option 改写过、又没有 code 时无法识别——这是已知边界
    expect(matchPanelShortcut({ metaKey: true, altKey: true, key: '∫' })).toBeNull();
  });
});

describe('⌘L 聚焦输入框', () => {
  it('⌘L 命中', () => {
    expect(matchFocusComposerShortcut({ metaKey: true, code: 'KeyL' })).toBe(true);
    expect(matchFocusComposerShortcut({ ctrlKey: true, code: 'KeyL' })).toBe(true);
  });

  it('大小写与 key 后备都能命中', () => {
    expect(matchFocusComposerShortcut({ metaKey: true, key: 'L' })).toBe(true);
    expect(matchFocusComposerShortcut({ metaKey: true, key: 'l' })).toBe(true);
  });

  it('无修饰键不命中（裸 L 是正常打字）', () => {
    expect(matchFocusComposerShortcut({ code: 'KeyL' })).toBe(false);
  });

  it('带 Shift / Alt 不命中（那些组合另有含义）', () => {
    expect(matchFocusComposerShortcut({ metaKey: true, shiftKey: true, code: 'KeyL' })).toBe(false);
    expect(matchFocusComposerShortcut({ metaKey: true, altKey: true, code: 'KeyL' })).toBe(false);
  });

  it('其他字母不命中', () => {
    expect(matchFocusComposerShortcut({ metaKey: true, code: 'KeyK' })).toBe(false);
  });
});
