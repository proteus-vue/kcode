/**
 * 让容器跟随新内容滚动，但**不抢用户的滚动条**（见 `autoScroll.ts` 的规则）。
 *
 * # 为什么做成 hook 而不是内联在 App 里
 *
 * 需要在三个时机读到容器的实时几何：内容变化、用户滚动、窗口缩放。
 * 内联写会有两处容易错的细节：
 *
 * 1. **必须在 DOM 更新后测量**（`useLayoutEffect` 而非 `useEffect`），
 *    否则内容已增长而 scrollHeight 还是旧值，判断会滞后一帧——
 *    表现为「偶发不跟随」。
 * 2. **程序化滚动本身会触发 scroll 事件**，若在 scroll 回调里再次
 *    计算并覆盖用户意图，就会形成抖动。这里的做法是：scroll 事件只
 *    记录「用户在哪」，不主动滚动。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isAtBottom, showScrollToBottom } from '../components/autoScroll';

export interface AutoScrollHandle<T extends HTMLElement> {
  /** 挂到可滚动容器上。 */
  ref: React.RefObject<T | null>;
  /** 是否显示「回到底部」按钮。 */
  showButton: boolean;
  /** 滚回底部并恢复跟随。 */
  scrollToBottom: () => void;
  /** 用户是否贴着底部（跟随中）。 */
  following: boolean;
}

export function useAutoScroll<T extends HTMLElement>(
  /** 内容变化信号：它的变化触发「是否需要跟随」的判断。 */
  dep: unknown,
): AutoScrollHandle<T> {
  const ref = useRef<T | null>(null);
  const [following, setFollowing] = useState(true);
  const [showButton, setShowButton] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return null;
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }, []);

  // 用户滚动：只更新「是否跟随」的判断，不主动改变滚动位置
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const m = measure();
      if (!m) return;
      setFollowing(isAtBottom(m));
      setShowButton(showScrollToBottom(m));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [measure]);

  // 内容变化：跟随状态下贴到底部。layout 阶段做，避免闪烁一帧。
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const m = measure();
    if (!m) return;
    // 用当前状态决定是否跟随。这里刻意读 state 而非实时测量：
    // 新内容刚插入 DOM 时「距底部」必然变大，若据此判断会得出
    // 「用户已经上滑」的错误结论，从而永远停止跟随。
    if (following) {
      el.scrollTop = el.scrollHeight;
    }
    setShowButton(showScrollToBottom(measure() ?? m));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep, following]);

  const scrollToBottom = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setFollowing(true);
    setShowButton(false);
  }, []);

  return { ref, showButton, scrollToBottom, following };
}
