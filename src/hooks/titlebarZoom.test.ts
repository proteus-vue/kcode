/**
 * 顶部导航条双击缩放的判定。
 *
 * 核心断言是**双击落在交互控件上时不缩放**：这是与系统标题栏对齐的
 * 惯例（双击标题栏绿钮是全屏按钮自己的行为），也是最容易回归的点——
 * 若判定只看 target 不看祖先，双击按钮里的图标（target 是内层 span）
 * 就会把缩放叠到按钮的两次点击上。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isInteractiveTarget, onColumnBandDoubleClick, onTitlebarDoubleClick } from './titlebarZoom';

/** 造一个带层级的真实 DOM 片段：容器 > 目标元素。 */
function dom(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe('isInteractiveTarget', () => {
  it('导航条空白处（header 自身或普通 span）→ 非交互，应缩放', () => {
    const host = dom('<header><span class="title">标题</span></header>');
    expect(isInteractiveTarget(host.querySelector('header'))).toBe(false);
    expect(isInteractiveTarget(host.querySelector('.title'))).toBe(false);
  });

  it('button 自身 → 交互，不缩放', () => {
    const host = dom('<button class="icon-btn">x</button>');
    expect(isInteractiveTarget(host.querySelector('button'))).toBe(true);
  });

  it('button **内部**的 span → 仍判为交互（closest 向上找，不只看 target）', () => {
    // 这是最关键的一条：双击按钮里的图标/文字时 target 是内层元素。
    // 只看 target 自身会漏判，把缩放叠到按钮的两次点击上。
    const host = dom('<button class="wb-tab-main"><span class="icon">⚙</span></button>');
    expect(isInteractiveTarget(host.querySelector('.icon'))).toBe(true);
  });

  it('链接 / 输入框 / 可编辑区 → 交互，不缩放', () => {
    const host = dom(
      '<a href="#">l</a><input><textarea></textarea><div contenteditable="true">e</div>',
    );
    for (const el of host.children) {
      expect(isInteractiveTarget(el), String(el.tagName)).toBe(true);
    }
  });

  it('role=button 的非 button 元素 → 交互', () => {
    const host = dom('<div role="button">按</div>');
    expect(isInteractiveTarget(host.firstElementChild)).toBe(true);
  });

  it('null / 非 Element（文本节点）→ 非交互', () => {
    expect(isInteractiveTarget(null)).toBe(false);
    expect(isInteractiveTarget(document.createTextNode('t'))).toBe(false);
  });
});

describe('双击 handler 的触发边界', () => {
  afterEach(() => vi.restoreAllMocks());

  // jsdom 里没有 Tauri internals：handler 真的走到缩放调用时会被 catch
  // 接住并打 console.error('切换窗口最大化失败')。反过来，没打 = 没触发。
  // 用它区分「触发了但环境缺 Tauri」与「根本没触发」。
  const spy = () => vi.spyOn(console, 'error').mockImplementation(() => {});

  const bandEvent = (over: Partial<ColumnBandEvent> = {}) => {
    const el = document.createElement('div');
    return {
      target: el,
      currentTarget: el,
      clientY: 16,
      preventDefault: vi.fn(),
      ...over,
    } as unknown as ColumnBandEvent;
  };
  type ColumnBandEvent = Parameters<typeof onColumnBandDoubleClick>[0];

  it('容器自身 + 顶部带内 → 触发缩放', async () => {
    const s = spy();
    const e = bandEvent();
    onColumnBandDoubleClick(e);
    expect(e.preventDefault).toHaveBeenCalled();
    // 走到了异步调用链才会产生的报错（jsdom 无 Tauri）。
    // 动态 import 落定不止一个微任务，用 waitFor 等它。
    await vi.waitFor(
      () => {
        expect(s).toHaveBeenCalledWith('切换窗口最大化失败', expect.anything());
      },
      { timeout: 1000 },
    );
  });

  it('target 是子元素（head 冒泡上来）→ 不触发，交给 head 的 handler', () => {
    const s = spy();
    const parent = document.createElement('div');
    const child = document.createElement('span');
    onColumnBandDoubleClick(bandEvent({ target: child, currentTarget: parent }));
    expect(s).not.toHaveBeenCalled();
  });

  it('在顶部带下方（正文空白）→ 不触发', () => {
    const s = spy();
    onColumnBandDoubleClick(bandEvent({ clientY: 88 }));
    expect(s).not.toHaveBeenCalled();
  });

  it('head handler：交互控件上不触发', () => {
    const s = spy();
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    onTitlebarDoubleClick({
      target: btn,
      preventDefault: vi.fn(),
    });
    expect(s).not.toHaveBeenCalled();
    btn.remove();
  });
});
