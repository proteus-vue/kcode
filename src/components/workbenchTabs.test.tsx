/**
 * 工作台标签交互的 DOM 测试。
 *
 * 真机上右键会被 WKWebView 的**原生**菜单抢占（Reload / Inspect Element），
 * 而我的坐标点击又反复打偏。所以这里用真实事件把行为钉住——
 * 它也是防回归的唯一可靠手段。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Workbench } from './Workbench';
import type { SceneAvailability, WorkbenchScene } from './scenes';

const all: SceneAvailability = {
  review: true,
  terminal: true,
  browser: true,
  files: true,
  chat: true,
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(
  open: WorkbenchScene[] = ['review', 'terminal'],
  active: WorkbenchScene = 'review',
  over: Partial<SceneAvailability> = {},
) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const onActivate = vi.fn();
  const onClose = vi.fn();
  const onCloseOthers = vi.fn();
  const onCloseAll = vi.fn();
  act(() => {
    root!.render(
      <Workbench
        open={open}
        active={active}
        availability={{ ...all, ...over }}
        onActivate={onActivate}
        onClose={onClose}
        onCloseOthers={onCloseOthers}
        onCloseAll={onCloseAll}
      >
        <div>content</div>
      </Workbench>,
    );
  });
  return { onActivate, onClose, onCloseOthers, onCloseAll };
}

const click = (el: Element | null) => {
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('工作台标签栏', () => {
  it('只渲染**已打开**的标签，而不是全部可用场景', () => {
    // 这是核心修正：早前渲染的是所有可用场景，关闭无从下手。
    mount(['review', 'terminal']);
    expect(document.querySelectorAll('.wb-tab').length).toBe(2);
    const labels = [...document.querySelectorAll('.wb-tab-label')].map((e) => e.textContent);
    expect(labels).toEqual(['审查', '终端']);
  });

  it('点标签切换场景', () => {
    const { onActivate } = mount(['review', 'terminal']);
    const tabs = document.querySelectorAll('.wb-tab');
    click(tabs[1].querySelector('.wb-tab-main'));
    expect(onActivate).toHaveBeenCalledWith('terminal');
  });

  it('每个标签都有独立的关闭按钮（不是嵌套在切换按钮里）', () => {
    mount();
    const tab = document.querySelector('.wb-tab')!;
    expect(tab.tagName).toBe('SPAN');
    // 两个并列按钮，且互不嵌套
    const btns = tab.querySelectorAll('button');
    expect(btns.length).toBe(2);
    btns.forEach((b) => expect(b.querySelector('button')).toBeNull());
  });

  it('点关闭按钮**带上该标签的 id**，且不触发切换', () => {
    // 早前 onClose 不带参数，App 只能「关闭当前场景」——
    // 于是关闭任意标签都关掉同一个，用户看到的是跳转而非关闭。
    const { onActivate, onClose } = mount(['review', 'terminal']);
    click(document.querySelectorAll('.wb-tab-close')[1]);
    expect(onClose).toHaveBeenCalledWith('terminal');
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('右键标签弹出菜单（含三个操作）', () => {
    mount();
    act(() => {
      document
        .querySelector('.wb-tab')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 40 }));
    });
    const menu = document.querySelector('.ctx-menu');
    expect(menu).not.toBeNull();
    const items = [...menu!.querySelectorAll('.ctx-item')].map((b) => b.textContent);
    expect(items).toEqual(['关闭标签', '关闭其他标签', '关闭所有标签']);
  });

  it('有多个打开的标签时「关闭其他」可用', () => {
    mount(['review', 'terminal']);
    act(() => {
      document.querySelector('.wb-tab')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const items = document.querySelectorAll('.ctx-menu:not(.ctx-menu-right) .ctx-item');
    expect(items.length).toBe(3);
    expect((items[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it('只有一个打开的标签时「关闭其他」禁用', () => {
    // 拆成独立测试：重挂载到同一个 host 再断言会读到上一轮的节点，
    // 那种写法本身比被测逻辑更易出错。
    mount(['terminal'], 'terminal');
    act(() => {
      document.querySelector('.wb-tab')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    const items = document.querySelectorAll('.ctx-menu:not(.ctx-menu-right) .ctx-item');
    expect(items.length).toBe(3);
    expect((items[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it('「关闭其他」调用 onCloseOthers（不是 onClose）', () => {
    const { onClose, onCloseOthers } = mount(['review', 'terminal']);
    act(() => {
      document.querySelector('.wb-tab')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    click(document.querySelectorAll('.ctx-menu:not(.ctx-menu-right) .ctx-item')[1]);
    expect(onCloseOthers).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('「关闭所有」调用 onCloseAll', () => {
    const { onCloseAll } = mount(['review', 'terminal']);
    act(() => {
      document.querySelector('.wb-tab')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    click(document.querySelectorAll('.ctx-menu:not(.ctx-menu-right) .ctx-item')[2]);
    expect(onCloseAll).toHaveBeenCalled();
  });

  it('「…」菜单是右键菜单的可见入口（右键在部分环境被系统菜单抢占）', () => {
    mount();
    // 标签栏右侧的操作区
    const actions = document.querySelector('.wb-bar-actions');
    expect(actions).not.toBeNull();
    const btns = actions!.querySelectorAll('button');
    expect(btns.length).toBe(2); // …  与  +
    click(btns[0]);
    const items = [...document.querySelectorAll('.ctx-menu-right .ctx-item')].map(
      (b) => b.textContent,
    );
    expect(items).toEqual(['关闭当前标签', '关闭其他标签', '关闭所有标签']);
  });

  it('ESC 关闭右键菜单', () => {
    mount();
    act(() => {
      document
        .querySelector('.wb-tab')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    });
    expect(document.querySelector('.ctx-menu')).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(document.querySelector('.ctx-menu')).toBeNull();
  });
});
