/**
 * 顶部导航条双击 → 缩放窗口。
 *
 * # 为什么只有左栏顶部能双击缩放
 *
 * 窗口是 `titleBarStyle: Overlay`（标题栏透明），原生 drag region 只有
 * `.window-drag-strip` 一小块（左上角 470×32）。**macOS 把原生 drag
 * region 的双击当标题栏双击处理**——系统直接缩放窗口。所以「双击左上角
 * 能缩放」不是我们实现的，是系统对那一小块的默认行为。
 *
 * 三个栏的导航条（`.sb-head` / `.main-head` / `.workbench-bar`）都不在
 * 那块 strip 下：主区与左栏的内容从 `--titlebar`（40px）处开始，右栏的
 * 标签条更是显式声明了 `no-drag`（否则原生拖拽层会吞掉标签的点击）。
 * 于是双击它们毫无反应——与左上角行为不一致。
 *
 * 修法：给三个导航条挂同一个 dblclick handler，调 Tauri 的
 * `toggleMaximize()`，让行为与系统标题栏双击对齐。
 * 需要 capability `core:window:allow-toggle-maximize`（缺失时 invoke
 * 被静默拒绝，`scripts/verify-tauri-capabilities.sh` 会校验）。
 *
 * # 交互控件上的双击不缩放
 *
 * 惯例（macOS 标题栏绿钮、Safari 标签条）是「控件上的双击归控件，
 * 空白处的双击才缩放」：双击搜索按钮应当是「开→关」，不该顺带缩放窗口。
 * 因此判定排除 button / 链接 / 输入类元素及其内部的目标。
 *
 * 注意 `.sb-brand` 曾是**无任何 click 行为**的 `<button>`——无行为的
 * button 对辅助技术是误导（聚焦后按回车无响应），已改为 `<div>`：
 * 它语义上是「窗口标题」，双击缩放正是用户对它的预期。
 */

/** handler 需要的最小事件形状：React.MouseEvent 结构上满足它。 */
export interface TitlebarDoubleClickLike {
  target: EventTarget | null;
  preventDefault: () => void;
}

/**
 * 双击目标是否落在可交互控件上。
 *
 * 是 → 归控件自己处理，不缩放；否（导航条空白、标题文字）→ 应当缩放。
 * 判定用 `closest` 而非 target 自身：双击按钮里的图标/文字时 target 是
 * 内层 span，只看 target 会漏判、把缩放叠到按钮的两次点击上。
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return (
    target.closest(
      'button, a, input, select, textarea, summary, [role="button"], [contenteditable="true"]',
    ) !== null
  );
}

/**
 * 导航条 dblclick：非交互目标上双击 → 切换窗口最大化。
 *
 * `preventDefault` 阻掉双击选词——缩放窗口的同时把标题文字选中一片，
 * 看起来像出了错。
 */
export function onTitlebarDoubleClick(e: TitlebarDoubleClickLike): void {
  if (isInteractiveTarget(e.target)) return;
  e.preventDefault();
  void getCurrentWindowZoom().catch((err: unknown) => {
    // 权限缺失时 invoke 会 reject。不吞掉：静默失败正是
    // verify-tauri-capabilities.sh 要防的那类缺陷，控制台要留痕。
    console.error('切换窗口最大化失败', err);
  });
}

/** 与 Tauri 窗口 API 的接缝，抽出来便于测试注入。 */
function getCurrentWindowZoom(): Promise<void> {
  // 延迟 import：让纯函数测试不必经过 Tauri 运行时
  return import('@tauri-apps/api/window').then((m) => m.getCurrentWindow().toggleMaximize());
}
