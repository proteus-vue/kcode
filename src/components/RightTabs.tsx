/**
 * 右栏的标签容器：进程状态 与 内容视图（内置浏览器 / 文件详情）。
 *
 * # 为什么用标签而不是把内容塞进面板列表
 *
 * 右栏承担两类互斥的用途：
 *
 * 1. **状态** —— 进度、审批、变更，纵向排列，随时扫一眼；
 * 2. **内容** —— 网页、图片、文件，需要尽可能大的连续空间。
 *
 * 混在一条纵向流里，内容视图会与状态面板争高度：浏览器被压到 200px
 * 就没法用了。标签让两者各占满整个右栏高度。
 *
 * # 内容视图是原生子 webview，不是 DOM
 *
 * 内置浏览器由 Rust 侧创建为**原生子视图**，永远绘制在 DOM 之上，
 * 不参与 CSS 布局。所以这里只负责给出一个矩形（`contentSlotRef`），
 * 由上层把它换算成坐标同步给原生视图。这个 `<div>` 本身是空的，
 * 它的作用就是量出那块位置。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export type RightTab = 'panel' | 'content';

export function RightTabs({
  tab,
  onTab,
  contentLabel,
  contentIcon,
  hasContent,
  onCloseContent,
  contentSlotRef,
  children,
  content,
}: {
  tab: RightTab;
  onTab: (t: RightTab) => void;
  /** 内容标签的文字，例如「浏览器」或文件名。 */
  contentLabel: string;
  contentIcon: IconName;
  hasContent: boolean;
  onCloseContent: () => void;
  /** 挂到内容槽位上，用于量取原生视图应占的矩形。 */
  contentSlotRef: (el: HTMLDivElement | null) => void;
  children: ReactNode;
  content: ReactNode;
}) {
  return (
    <div className="right-tabs">
      <div className="right-tabbar" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'panel'}
          className={`right-tab ${tab === 'panel' ? 'is-active' : ''}`}
          onClick={() => onTab('panel')}
        >
          <Icon name="layers" size={12} />
          <span>面板</span>
        </button>

        {hasContent && (
          <button
            role="tab"
            aria-selected={tab === 'content'}
            className={`right-tab ${tab === 'content' ? 'is-active' : ''}`}
            onClick={() => onTab('content')}
            title={contentLabel}
          >
            <Icon name={contentIcon} size={12} />
            <span className="right-tab-label">{contentLabel}</span>
          </button>
        )}

        {hasContent && tab === 'content' && (
          <button
            className="right-tab-close"
            onClick={onCloseContent}
            title="关闭"
            aria-label="关闭内容视图"
          >
            <Icon name="close" size={11} />
          </button>
        )}
      </div>

      <div className="right-tabbody">
        {/* 状态面板始终挂载，只是隐藏——切回来时滚动位置与折叠状态都保留 */}
        <div className="right-pane" hidden={tab !== 'panel'}>
          {children}
        </div>
        <div className="right-pane" hidden={tab !== 'content'}>
          {/* 原生子视图占位的矩形。这里不渲染网页本身。 */}
          <div className="native-slot" ref={contentSlotRef} />
          {content}
        </div>
      </div>
    </div>
  );
}

/**
 * 量取某个元素的矩形，并在其尺寸/位置变化时回调。
 *
 * 原生子视图不参与 CSS 布局，必须由前端在**每次布局变化**后主动同步；
 * 否则面板一折叠，浏览器还浮在原处——这类问题在 DOM 里看不出来。
 *
 * 用 ResizeObserver 而非 window.resize：面板折叠、标签切换、分栏拖拽
 * 都不会触发 window.resize，但都会让这个矩形变化。
 *
 * 元素存进 state 而不是 ref：callback ref 赋值不会触发重渲染，
 * 若用 ref，effect 可能在元素挂载前就跑完（拿不到任何元素，
 * 表现为原生视图从不出现）。
 */
export function useSlotRect(
  onRect: (r: { x: number; y: number; width: number; height: number }) => void,
  enabled: boolean,
) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const cbRef = useRef(onRect);
  cbRef.current = onRect;

  useEffect(() => {
    if (!el || !enabled) return;

    const push = () => {
      const r = el.getBoundingClientRect();
      cbRef.current({ x: r.left, y: r.top, width: r.width, height: r.height });
    };

    push();
    const ro = new ResizeObserver(push);
    ro.observe(el);
    // 位置变化（不改变尺寸）由滚动与折叠动画驱动，一并跟随。
    // 折叠动画期间尺寸每帧都变，ResizeObserver 会捕获到这些中间态——
    // 原生视图因此跟着收缩，而不是突然跳到位。
    window.addEventListener('scroll', push, true);
    window.addEventListener('resize', push);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', push, true);
      window.removeEventListener('resize', push);
    };
  }, [el, enabled]);

  return setEl;
}
