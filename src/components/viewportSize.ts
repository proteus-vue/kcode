/**
 * 模拟视口的尺寸策略。
 *
 * # 为什么需要它
 *
 * 右栏宽度约 460px，而桌面版网页普遍按 ≥1000px 布局。直接塞进去
 * 必然横向溢出——表现为滚动条 + 内容被裁（实测百度就是如此）。
 *
 * 解法与浏览器开发者工具的「设备模拟」相同：让页面以为自己有
 * `W×H` 的视口，再整体缩放显示。这样页面按宽视口排版，
 * 呈现上仍填满面板。
 *
 * # 「适应窗口」为什么是默认
 *
 * 固定的 1280×720 在宽面板里会留出大片空白（参照截图里那两条黑边
 * 就是这个原因）。「适应窗口」按面板实际宽高比反推一个 CSS 尺寸，
 * 既拿到桌面版布局、又不浪费空间。
 */

/** 预设尺寸（CSS 像素）。取常见设备与窗口尺寸。 */
export const SIZE_PRESETS = [
  { label: '1280 × 720', width: 1280, height: 720 },
  { label: '1440 × 900', width: 1440, height: 900 },
  { label: '1920 × 1080', width: 1920, height: 1080 },
  { label: 'iPhone 15', width: 393, height: 852 },
  { label: 'iPad mini', width: 744, height: 1133 },
] as const;

export interface Viewport {
  /** 页面按这个 CSS 尺寸布局。 */
  cssWidth: number;
  cssHeight: number;
  /** 渲染结果的缩放系数（1 = 不缩放）。 */
  scale: number;
  /** 缩放后占用的实际像素尺寸（用于居中）。 */
  pixelWidth: number;
  pixelHeight: number;
}

/**
 * 「适应窗口」：给一个**横向的桌面视口**，缩放到填满可用区域。
 *
 * # 为什么不用面板自身的宽高比
 *
 * 第一版按面板宽高比反推，右栏是窄高的，于是算出 1024×1646 这种
 * 极端竖向视口。百度按它排版后中间出现大片空白——桌面版网页的
 * 布局假设视口是横向的（1280×720 那种），给一个超高视口反而
 * 让首屏元素被拉到分隔很远。
 *
 * 所以这里改为：**宽度取桌面下限，高度按 16:9 跟随宽度**，
 * 然后整体缩放填满可用区域。内容占比与真实桌面浏览器一致。
 */
export function fitViewport(slotW: number, slotH: number, minWidth = 1280): Viewport {
  // 宽度不低于桌面下限：低于约 1024 时网页会退回移动版布局，
  // 而这不是用户打开「浏览器」场景想要的东西。
  const cssWidth = Math.max(minWidth, Math.round(slotW));
  // 16:9 —— 桌面浏览器的常规比例。不跟随面板高度，理由见上。
  const cssHeight = Math.round((cssWidth * 9) / 16);
  const scale = Math.min(slotW / cssWidth, slotH / cssHeight, 1);
  return {
    cssWidth,
    cssHeight,
    scale,
    pixelWidth: cssWidth * scale,
    pixelHeight: cssHeight * scale,
  };
}

/**
 * 「填满面板」：CSS 尺寸取**面板自身**的宽高，不缩放。
 *
 * # 它与「适应窗口」解决的不是同一件事
 *
 * - 适应窗口：给一个 1280×720 的桌面视口，网页呈现桌面版布局，
 *   代价是缩放后只占面板中间一条（16:9 放进窄高的面板必然如此）。
 * - 填满面板：视口就是面板大小，不缩放、不留白、不缩放字体。
 *   网页按窄视口排版——响应式站点会呈现移动版，固定宽度站点仍会
 *   横向滚动。
 *
 * 两者都有明确的适用场景，所以都提供，默认给「适应窗口」
 * （桌面版布局更接近用户打开浏览器的预期）。
 */
export function fillViewport(slotW: number, slotH: number): Viewport {
  const w = Math.max(1, Math.round(slotW));
  const h = Math.max(1, Math.round(slotH));
  return { cssWidth: w, cssHeight: h, scale: 1, pixelWidth: w, pixelHeight: h };
}

/** 固定尺寸：CSS 尺寸即给定值，缩放系数按可用空间算。 */
export function fixedViewport(
  cssWidth: number,
  cssHeight: number,
  slotW: number,
  slotH: number,
): Viewport {
  // 只缩不放（上限 1）：把小尺寸放大到模糊没有意义，
  // 而上限不设 1 时 iPhone 预设会被拉伸成满屏。
  const scale = Math.min(slotW / cssWidth, slotH / cssHeight, 1);
  return {
    cssWidth,
    cssHeight,
    scale,
    pixelWidth: cssWidth * scale,
    pixelHeight: cssHeight * scale,
  };
}
