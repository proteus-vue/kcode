/**
 * 自动滚动 hook 的 DOM 测试。
 *
 * 纯规则已在 `autoScroll.test.ts` 里钉住；这里补的是**接线**是否正确——
 * 钩子读的是真实 DOM 几何，而 jsdom 默认不做布局（scrollHeight 恒为 0），
 * 因此需要手动打桩。打桩的内容正是真机上会发生的两件事：
 *
 * 1. 内容增长 → 跟随状态下应把 scrollTop 推到 scrollHeight；
 * 2. 用户上滑 → 之后的增长**不得**再动滚动位置（这是最容易做错的一条）。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useAutoScroll } from './useAutoScroll';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** jsdom 不做布局：手动给元素装上可控的几何值。 */
function stubGeometry(el: HTMLElement, init: { scrollHeight: number; clientHeight: number }) {
  let scrollTop = 0;
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => init.scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => init.clientHeight,
  });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
      // 程序化滚动在真机上会触发 scroll 事件，这里如实模拟
      el.dispatchEvent(new Event('scroll'));
    },
  });
  return {
    setScrollHeight: (h: number) => {
      init.scrollHeight = h;
    },
    userScrollTo: (v: number) => {
      scrollTop = v;
      el.dispatchEvent(new Event('scroll'));
    },
    getScrollTop: () => scrollTop,
  };
}

interface Probe {
  scroll: ReturnType<typeof useAutoScroll<HTMLDivElement>>;
  dep: string;
}

let probe: Probe | null = null;

function ProbeComponent({ dep, onReady }: { dep: string; onReady?: () => void }) {
  const scroll = useAutoScroll<HTMLDivElement>(dep);
  probe = { scroll, dep };
  onReady?.();
  return (
    <div className="wrap">
      <div className="scroller" ref={scroll.ref as React.RefObject<HTMLDivElement>}>
        content
      </div>
      {scroll.showButton && <button className="back">回到底部</button>}
    </div>
  );
}

function mount(dep: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<ProbeComponent dep={dep} />);
  });
  const scroller = host.querySelector('.scroller') as HTMLElement;
  const geo = stubGeometry(scroller, { scrollHeight: 600, clientHeight: 200 });
  return { scroller, geo };
}

function render(dep: string) {
  act(() => {
    root!.render(<ProbeComponent dep={dep} />);
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (host) host.remove();
  root = null;
  host = null;
  probe = null;
});

describe('useAutoScroll 接线', () => {
  it('挂载时贴底 → 跟随状态为真', () => {
    mount('a');
    expect(probe!.scroll.following).toBe(true);
  });

  it('内容增长时跟随到底部', () => {
    const { geo } = mount('a');
    geo.setScrollHeight(900);
    render('b');
    expect(geo.getScrollTop()).toBe(900);
  });

  it('用户上滑后，新内容不再抢滚动位置（核心要求）', () => {
    const { geo } = mount('a');
    // 用户主动上滑（远离底部）
    act(() => geo.userScrollTo(50));
    expect(probe!.scroll.following).toBe(false);

    // 内容继续增长
    geo.setScrollHeight(1200);
    render('b');

    // 滚动位置必须仍是用户自己放的地方，而不是被拽到底部
    expect(geo.getScrollTop()).toBe(50);
  });

  it('上滑后出现「回到底部」按钮', () => {
    const { geo } = mount('a');
    act(() => geo.userScrollTo(50));
    expect(host!.querySelector('.back')).not.toBeNull();
  });

  it('内容不足一屏时不显示按钮（没有可滚空间）', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<ProbeComponent dep="a" />));
    const scroller = host.querySelector('.scroller') as HTMLElement;
    stubGeometry(scroller, { scrollHeight: 100, clientHeight: 400 });
    render('b');
    expect(host.querySelector('.back')).toBeNull();
  });

  it('点「回到底部」后恢复跟随', () => {
    const { geo } = mount('a');
    act(() => geo.userScrollTo(50));
    expect(probe!.scroll.following).toBe(false);

    act(() => probe!.scroll.scrollToBottom());

    expect(geo.getScrollTop()).toBe(600);
    expect(probe!.scroll.following).toBe(true);
  });
});
