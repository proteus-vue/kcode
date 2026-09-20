/**
 * 内联 SVG 图标。
 *
 * 用 SVG 而非字符/emoji：在 Retina 上更锐利，可随文字颜色着色，
 * 且不受系统 emoji 字体差异影响（同一个字符在不同机器上外观不同）。
 */
type IconName =
  | 'plus'
  | 'search'
  | 'clock'
  | 'plugin'
  | 'folder'
  | 'terminal'
  | 'file'
  | 'edit'
  | 'check'
  | 'close'
  | 'chevron'
  | 'dot'
  | 'shield'
  | 'cpu'
  | 'layers'
  | 'bell'
  | 'branch'
  | 'pin'
  | 'folder-open'
  | 'send'
  | 'stop'
  | 'compass'
  | 'sparkle'
  | 'wrench'
  | 'expand'
  | 'collapse'
  | 'refresh'
  | 'devices'
  | 'more'
  | 'arrow-left'
  | 'arrow-right';

const PATHS: Record<IconName, string> = {
  plus: 'M8 3v10M3 8h10',
  search: 'M7 12a5 5 0 100-10 5 5 0 000 10zM11 11l3 3',
  clock: 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM8 4.5V8l2.5 1.5',
  plugin: 'M6 1.5v3M10 1.5v3M3.5 4.5h9v4a4.5 4.5 0 01-9 0v-4zM6.5 13v1.5M9.5 13v1.5',
  folder: 'M1.5 3.5h4l1.5 2h7.5v7h-13v-9z',
  terminal: 'M2 3l4 4-4 4M8 11h6',
  file: 'M3.5 1.5h6l3 3v10h-9v-13zM9.5 1.5v3h3',
  edit: 'M11.5 2.5l2 2-8 8-3 1 1-3 8-8z',
  check: 'M3 8.5l3.5 3.5L13 4.5',
  close: 'M4 4l8 8M12 4l-8 8',
  chevron: 'M6 4l4 4-4 4',
  dot: 'M8 5a3 3 0 100 6 3 3 0 000-6z',
  shield: 'M8 1.5l5.5 2v5c0 3-2.5 5-5.5 6-3-1-5.5-3-5.5-6v-5l5.5-2z',
  cpu: 'M5.5 5.5h5v5h-5zM2 6h2M2 10h2M12 6h2M12 10h2M6 2v2M10 2v2M6 12v2M10 12v2',
  layers: 'M8 2l6 3-6 3-6-3 6-3zM2 8l6 3 6-3M2 11l6 3 6-3',
  bell: 'M8 1.8a3.7 3.7 0 00-3.7 3.7c0 3-1.3 4-1.3 4h10s-1.3-1-1.3-4A3.7 3.7 0 008 1.8zM6.7 12a1.4 1.4 0 002.6 0',
  branch: 'M4.5 2.5a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6zM4.5 6.1v7.4M11.5 2.5a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6zM11.5 6.1v1.4c0 1.5-1.2 2.7-2.7 2.7H4.5',
  pin: 'M9.5 1.5l5 5-2 .5-2 2 .5 3-2-2-3.5 3.5L5 12l3.5-3.5-2-2 3-.5 2-2 .5-2z',
  'folder-open': 'M1.5 3.5h4l1.5 2h7.5v1.5H1.5v-3.5zM1.5 7h13l-1.5 6.5h-10L1.5 7z',
  send: 'M14 2L7 9M14 2l-4.5 12-2.5-5-5-2.5L14 2z',
  stop: 'M5 5h6v6H5z',
  compass: 'M8 1.8a6.2 6.2 0 100 12.4A6.2 6.2 0 008 1.8zM10.5 5.5l-1.6 3.4-3.4 1.6 1.6-3.4 3.4-1.6z',
  sparkle: 'M8 1.5l1.6 4.4 4.4 1.6-4.4 1.6L8 13.5l-1.6-4.4L2 7.5l4.4-1.6L8 1.5z',
  wrench: 'M10.2 1.8a4 4 0 00-3.6 5.7L1.8 12.3l1.9 1.9 4.8-4.8a4 4 0 005.7-3.6l-2.4 2.4-2.1-.6-.6-2.1 1.1-3.7z',
  // 展开：箭头指向外侧两个角（↗ ↙），箭头尖在外端。
  // 每个箭头 = 一条斜线 + 两条直角边构成的箭尖。
  expand:
    'M9 7l4.5-4.5M13.5 2.5h-3.3M13.5 2.5v3.3M7 9L2.5 13.5M2.5 13.5h3.3M2.5 13.5v-3.3',
  // 收起：斜线方向不变（仍是从中心指向外的两个角），但**箭尖画在内端**
  // ——箭头指向中心即表示「向里收」。上一版把箭尖画在外端，
  // 结果和 expand 长得一样（放大到 96px 才看出来）。
  collapse:
    'M9 7l4.5-4.5M9 7h3.3M9 7v-3.3M7 9L2.5 13.5M7 9H3.7M7 9v3.3',
  // 刷新：接近整圆的弧 + 箭头，与系统图标同构
  refresh: 'M13.5 8a5.5 5.5 0 11-1.9-4.2M13.5 1.8v3.4h-3.4',
  // 设备/尺寸：一台显示器 + 一台手机，表达「模拟视口」
  devices: 'M1.5 3.5h8v5h-8zM9.5 9.5v2h-8M11.5 6.5h3v6h-3z',
  // 更多操作：三个点
  more: 'M4 8a1 1 0 100-2 1 1 0 000 2zM8 8a1 1 0 100-2 1 1 0 000 2zM12 8a1 1 0 100-2 1 1 0 000 2z',
  'arrow-left': 'M12.5 8H3.5M7 4.5L3.5 8 7 11.5',
  'arrow-right': 'M3.5 8h9M9 4.5L12.5 8 9 11.5',
};

export type { IconName };

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
