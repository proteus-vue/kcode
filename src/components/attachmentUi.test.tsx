/**
 * 附件交互的 DOM 测试。
 *
 * 环境变量让 React 认得出这是在测试里跑，否则每个 act 都会打警告、
 * 输出被噪音淹没。
 *
 * 真机上点击总是落到别处（我的坐标换算反复出错），所以这里直接把
 * Composer 挂到 jsdom 上、用真实事件驱动——这能确定地回答
 * 「点 chip 到底会不会展开预览」这个我用手点没验证成功的问题。
 *
 * 覆盖的都是**交互本身**：点开、再点收起、点 × 移除、只剩附件也能发送。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Composer } from './Composer';
import type { WebElementAttachment } from '../types/domain';

const el: WebElementAttachment = {
  kind: 'webElement',
  selector: '#root > div > main',
  tag: 'div',
  text: '你想让我们在 KCode 中构建什么?',
  width: 452,
  height: 249,
  url: 'https://example.com/p',
  title: '示例页',
  color: '#000000',
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(pending: WebElementAttachment | null = el) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const onSubmit = vi.fn();
  const onConsume = vi.fn();
  act(() => {
    root!.render(
      <Composer
        disabled={false}
        onSubmit={onSubmit}
        running={false}
        models={[]}
        selectedModel={null}
        selectedEffort={null}
        onSelectModel={() => {}}
        onSelectEffort={() => {}}
        permissionMode="workspaceWrite"
        onSelectPermission={() => {}}
        configuredModel="m"
        pendingInput={pending}
        onConsumePending={onConsume}
      />,
    );
  });
  return { onSubmit, onConsume };
}

const chip = () => document.querySelector('.attach-open') as HTMLElement | null;
const preview = () => document.querySelector('.attach-preview') as HTMLElement | null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('网页元素附件', () => {
  it('传入附件后渲染 chip，并通知外部已消费', () => {
    const { onConsume } = mount();
    expect(chip()).not.toBeNull();
    expect(document.querySelector('.attach-chip')!.textContent).toContain('1 个网页元素');
    expect(onConsume).toHaveBeenCalled();
  });

  it('默认不展开预览（避免长文本一直占着输入区）', () => {
    mount();
    expect(preview()).toBeNull();
  });

  it('点 chip 展开预览，显示标签/尺寸/颜色/内容/选择器', () => {
    mount();
    act(() => {
      chip()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const p = preview();
    expect(p).not.toBeNull();
    expect(p!.textContent).toContain('div');
    expect(p!.textContent).toContain('452×249');
    expect(p!.textContent).toContain('#000000');
    expect(p!.textContent).toContain('你想让我们在 KCode 中构建什么?');
    expect(p!.textContent).toContain('#root > div > main');
  });

  it('再点一次收起预览', () => {
    mount();
    const click = () =>
      act(() => {
        chip()!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
    click();
    expect(preview()).not.toBeNull();
    click();
    expect(preview()).toBeNull();
  });

  it('展开与移除是两个独立按钮（不是嵌套交互元素）', () => {
    mount();
    // 嵌套 <button> 是非法 HTML，真实浏览器行为不可预期。
    // 这条断言防止它被改回去。
    const chipBox = document.querySelector('.attach-chip')!;
    expect(chipBox.tagName).toBe('SPAN');
    const btns = chipBox.querySelectorAll('button');
    expect(btns.length).toBe(2);
    // 两个按钮必须并列，不能一个套一个
    btns.forEach((b) => expect(b.querySelector('button')).toBeNull());
  });

  it('点 × 移除附件，且不会同时展开预览', () => {
    mount();
    const remove = document.querySelector('.attach-remove') as HTMLElement;
    act(() => {
      remove.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(chip()).toBeNull();
    // 关键：× 的点击必须 stopPropagation，否则会连带触发外层的展开
    expect(preview()).toBeNull();
  });

  it('只有附件、没有正文时也能发送，并把完整信息交给 onSubmit', () => {
    const { onSubmit } = mount();
    const send = document.querySelector('.send-btn') as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    act(() => {
      send.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0][0] as string;
    // 模型看不到界面，全靠这段文本
    expect(payload).toContain('选择器：#root > div > main');
    expect(payload).toContain('尺寸：452×249');
    expect(payload).toContain('来源：https://example.com/p');
  });

  it('发送后清空附件', () => {
    mount();
    const send = document.querySelector('.send-btn') as HTMLButtonElement;
    act(() => {
      send.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(chip()).toBeNull();
  });
});
