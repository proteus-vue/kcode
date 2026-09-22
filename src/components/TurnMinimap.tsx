/**
 * 对话导航条（minimap）与悬停预览。
 *
 * # 性能设计（这是本组件最需要说清的部分）
 *
 * 目标场景是**很长的会话**，因此每一处都按「不引入 O(全部条目) 的工作」来做：
 *
 * 1. **tick 数据来自 state，不测 DOM**。渲染期一个 rect 都不读——
 *    读布局会触发强制重排，几十次就是可感的卡顿。见 `turnMinimap.ts`。
 * 2. **悬停时只读一次 rect**，且只对**被悬停的那一个** tick 读，
 *    用来定位预览卡片。鼠标在 tick 之间移动时才会重算。
 * 3. **动画只用 transform**（`scaleX`），不用 `width`：前者走合成层，
 *    不触发布局与重绘；后者每一帧都要重排。这是「丝滑」的关键。
 * 4. **不挂滚动监听做 scroll-spy**。那需要按滚动位置反查当前轮次，
 *    要么遍历轮次元素、要么维护观察器集合——两者都会随会话变长而变重。
 *    宁可不做这个指示，也不让它成为长会话的负担。
 * 5. **滚动到轮次用 offsetTop 一次计算**，不逐帧计算。
 */
import { useCallback, useRef, useState } from 'react';
import { Icon } from './Icon';
import { buildTicks, turnPreview, type TurnPreview } from './turns';
import type { RootState } from '../stores/store';

export function TurnMinimap({
  state,
  threadId,
  /** 滚动容器（用于「点击跳转」与判断是否需要显示）。 */
  scrollRef,
}: {
  state: RootState;
  threadId: string;
  scrollRef: React.RefObject<HTMLElement | null>;
}) {
  const ticks = buildTicks(state, threadId);
  const [hover, setHover] = useState<{ tick: number; y: number } | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  /**
   * 点击跳转。
   *
   * 用 `offsetTop` 一次算出目标位置，而不是 `scrollIntoView`：
   * 后者会把目标滚到容器顶边，而顶栏是浮动的（absolute），
   * 目标会被压在顶栏下面看不见。
   */
  const goTo = useCallback(
    (turnId: string) => {
      const container = scrollRef.current;
      if (!container) return;
      const el = container.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
      if (!el) return;
      // 让出浮动顶栏的高度（46px）+ 一点余量
      container.scrollTo({ top: Math.max(0, el.offsetTop - 58), behavior: 'smooth' });
    },
    [scrollRef],
  );

  const onEnter = useCallback(
    (i: number, e: React.MouseEvent<HTMLButtonElement>) => {
      // **只读这一个元素的 rect**（不是全部 tick）。这是渲染期之外唯一的测量。
      const r = e.currentTarget.getBoundingClientRect();
      setHover({ tick: i, y: r.top + r.height / 2 });
    },
    [],
  );

  if (ticks.length === 0) return null;

  const hovered = hover ? ticks[hover.tick] : null;
  const preview: TurnPreview | null = hovered
    ? turnPreview(state, threadId, hovered.turnId)
    : null;

  return (
    <div className="turnmap" ref={listRef} onMouseLeave={() => setHover(null)}>
      {ticks.map((t, i) => (
        <button
          key={t.key}
          className={`turnmap-tick ${t.attention ? `is-${t.attention}` : ''} ${
            hover?.tick === i ? 'is-hover' : ''
          }`}
          // 长度用 scaleX 表达（而非 width）：动画走合成层，不触发布局。
          // --r 是相对最长 tick 的比例，hover 时放大到 1。
          style={{ ['--r' as string]: `${(t.len / 26).toFixed(3)}` }}
          onMouseEnter={(e) => onEnter(i, e)}
          onFocus={(e) => onEnter(i, e as unknown as React.MouseEvent<HTMLButtonElement>)}
          onClick={() => goTo(t.turnId)}
          title={`第 ${i + 1} 段${t.count > 1 ? `（${t.count} 轮）` : ''}`}
          aria-label={`跳转到第 ${i + 1} 段对话`}
        >
          <span className="turnmap-bar" />
        </button>
      ))}

      {hovered && preview && (
        // 预览卡片：坐标来自那一次 rect 读取。pointer-events: none，
        // 否则鼠标移向卡片时会离开 tick、卡片闪掉。
        <div className="turnmap-card" style={{ top: hover!.y }} role="tooltip">
          <div className="turnmap-card-head">
            {hovered.count > 1 && <span className="turnmap-card-badge">{hovered.count} 轮</span>}
            <span className="turnmap-card-title">{preview.title}</span>
          </div>
          {preview.body && <p className="turnmap-card-body">{preview.body}</p>}
          {preview.tools.length > 0 && (
            <div className="turnmap-card-tools">
              {preview.tools.map((t) => (
                <span key={t} className="turnmap-tool">
                  <Icon name={toolIcon(t)} size={11} />
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 工具标签 → 图标。与标签名一一对应（见 turnMinimap 的 TOOL_LABEL）。 */
function toolIcon(label: string): 'terminal' | 'edit' | 'layers' | 'search' | 'file' {
  switch (label) {
    case 'bash':
      return 'terminal';
    case 'write':
      return 'edit';
    case 'search':
      return 'search';
    case 'plan':
      return 'file';
    default:
      return 'layers';
  }
}
