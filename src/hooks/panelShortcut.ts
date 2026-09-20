/**
 * 面板折叠快捷键的判定。
 *
 * 单独抽成纯函数是为了可测：这段逻辑有一个只在真机出现、浏览器与合成
 * 事件都掩盖的缺陷（见下），留在组件里就只能靠人眼在 macOS 上试。
 */

/** 快捷键命中的目标面板。 */
export type PanelTarget = 'left' | 'right';

/**
 * ⌘B → 左栏，⌘⌥B → 右栏。不匹配时返回 null。
 *
 * **必须用 `e.code` 而不是 `e.key`。** macOS 上按住 Option 会改变键入的
 * 字符，真机按 ⌘⌥B 时 `e.key` 是 "∫"（U+222B），而不是 "b"：
 *
 * - 用 `e.key === 'b'` 判断 → 右栏快捷键完全失效（左栏正常，因为 ⌘B 不含
 *   Option，不触发字符改写）。实测在 KCode 窗口里按 ⌘⌥B 毫无反应。
 * - Playwright 的 `press('Meta+Alt+b')` **不会**复现：它按字面量构造事件，
 *   `key` 仍是 "b"，所以自动化测试全绿而真机失效。
 *
 * `e.code` 是物理键位，不受修饰键影响，因此是唯一可靠依据。
 * 同时检查 `key` 作为后备：极少数环境（部分虚拟键盘、部分自动化工具链）
 * 不填 `code`，此时退回字面 key 判断，总比完全不响应好。
 */
export function matchPanelShortcut(e: {
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  key?: string;
  code?: string;
}): PanelTarget | null {
  // primary 修饰键：macOS 用 ⌘，Windows/Linux 用 Ctrl
  const primary = e.metaKey || e.ctrlKey;
  if (!primary) return null;
  // 带 Shift 的组合让开：⌘⇧B 另有含义（在部分环境是「隐藏侧栏」），
  // 我们不去抢，避免和系统/其他应用的习惯冲突。
  if (e.shiftKey) return null;

  const isB = e.code === 'KeyB' || (!e.code && (e.key ?? '').toLowerCase() === 'b');
  if (!isB) return null;

  return e.altKey ? 'right' : 'left';
}
