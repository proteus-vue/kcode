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
 * 栏容器（`.sidebar` / `.main` / `.inspector`）双击所需的事件形状：
 * 除 target 外还要 currentTarget（判定「点在容器自身的空白上」）与
 * clientY（判定落在顶部标题栏让位带内）。React.MouseEvent 结构上满足。
 */
export interface ColumnBandDoubleClickLike extends TitlebarDoubleClickLike {
  currentTarget: EventTarget | null;
  clientY: number;
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
 * 注意 `preventDefault` **拦不住双击选词**：选词是 mousedown 的默认行为，
 * 在 dblclick 派发之前就已经完成——这里的 preventDefault 只是顺手取消
 * dblclick 自身的默认动作。真正阻止选词靠导航条上的 `user-select: none`
 * （见 styles.css；真机实测双击标题文字会选中一片词，就是漏了它）。
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

/** 读 `--titlebar`（读不到回退 40）——与 styles.css 的让位带同源。 */
function titlebarBandHeight(): number {
  if (typeof document === 'undefined') return 40;
  const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar'));
  return Number.isFinite(v) && v > 0 ? v : 40;
}

/**
 * 栏容器顶部空白带（y < --titlebar 的标题栏让位区）dblclick → 缩放。
 *
 * # 为什么还需要这个
 *
 * 三个导航条本体（head，y≥40）已各自挂了 handler，但**head 上方那条
 * 0..40px 的让位带**没有：真机判别矩阵实测，双击中栏该带 x>470 处
 * 毫无反应（N1），而 x<470 处能缩放——因为 `.window-drag-strip` 宽 470px，
 * 左栏只占 340px，它往中栏底下伸了 130px，那截是**系统原生**双击缩放。
 * 用户看到的「只有偏左才能缩放」就是这条断层：左边原生、右边没人管。
 *
 * # 为什么不会与 head 的 handler 双触发
 *
 * 事件冒泡到容器时，`e.target` 是 head 内的元素而非容器自身——
 * `target !== currentTarget` 直接放行给 head 的 handler，容器 handler 跳过。
 * 反之点在空白带上时 target 就是容器自身，只有容器 handler 会处理。
 * 无需 stopPropagation，也不可能一次双击触发两次 toggle。
 *
 * `clientY < --titlebar` 进一步把范围限死在顶部让位带：容器下方的
 * 空白（内容没填满时）双击不该缩放，那已经是正文区域了。
 */
export function onColumnBandDoubleClick(e: ColumnBandDoubleClickLike): void {
  if (e.target !== e.currentTarget) return;
  if (e.clientY >= titlebarBandHeight()) return;
  onTitlebarDoubleClick(e);
}

/** 与 Tauri 窗口 API 的接缝，抽出来便于测试注入。 */
function getCurrentWindowZoom(): Promise<void> {
  // 延迟 import：让纯函数测试不必经过 Tauri 运行时
  return import('@tauri-apps/api/window').then((m) => m.getCurrentWindow().toggleMaximize());
}
