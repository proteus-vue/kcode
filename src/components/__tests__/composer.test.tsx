/**
 * 输入区的 DOM 测试。
 *
 * 重做的两处交互只有在真实按键序列下才会出错，且都是静默的：
 *
 * 1. **历史回溯不能吞草稿**（打了一半、翻历史、回来发现没了）；
 * 2. **方向键不能被抢占**（多行输入时光标在中间，↑ 该移动光标而不是翻历史）。
 *
 * 另有一条视觉回归：发送/停止必须是 SVG 图标——此前发件键是**文字字符** `↑`、
 * 停止键是 CSS 画的方块，字重与线宽无法与其他图标对齐。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Composer } from '../Composer';
import type { GitStatus } from '../../types/domain';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const git: GitStatus = {
  isRepo: true,
  branch: 'main',
  root: '/work/kcode',
  staged: 0,
  modified: 0,
  untracked: 0,
  ahead: 0,
  behind: 0,
  conflicted: 0,
};

function mount(over: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSubmit = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <Composer
        disabled={false}
        onSubmit={onSubmit}
        models={[
          { id: 'm1', displayName: '模型一', isDefault: true, reasoningEfforts: ['low', 'high'], defaultEffort: 'low' },
        ]}
        selectedModel={null}
        selectedEffort={null}
        onSelectModel={() => {}}
        onSelectEffort={() => {}}
        projectName="kcode"
        git={git}
        permissionMode="workspaceWrite"
        onSelectPermission={() => {}}
        configuredModel="deepseek-flash"
        pendingInput={null}
        onConsumePending={() => {}}
        {...over}
      />,
    );
  });
  return { onSubmit };
}

const ta = () => host!.querySelector('textarea') as HTMLTextAreaElement;

/** 在 textarea 里输入文本（走 React 的 onChange）。 */
function type(value: string) {
  const el = ta();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

/** 派发按键。cursorAt 用于摆好选区，模拟光标位置。 */
function key(k: string, opts: { cursorAt?: number } = {}) {
  const el = ta();
  if (opts.cursorAt !== undefined) {
    el.setSelectionRange(opts.cursorAt, opts.cursorAt);
  }
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

describe('发送/停止用图标而非字符', () => {
  it('发送键渲染 SVG 图标，且不再含文字箭头', () => {
    mount();
    const btn = host!.querySelector('.send-btn') as HTMLElement;
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.textContent?.trim()).toBe('');
  });

  it('运行中切换为停止图标', () => {
    mount({ running: true, onStop: () => {} });
    const btn = host!.querySelector('.send-btn.stop') as HTMLElement;
    expect(btn).not.toBeNull();
    expect(btn.querySelector('svg')).not.toBeNull();
    // 旧的 CSS 方块实现已移除
    expect(host!.querySelector('.stop-glyph')).toBeNull();
  });
});

describe('自定义下拉（替代原生 select）', () => {
  it('不再使用原生 select 元素', () => {
    mount();
    expect(host!.querySelectorAll('select')).toHaveLength(0);
  });

  it('模型选择器显示配置里的实际模型名（而非「默认」）', () => {
    mount();
    expect(host!.textContent).toContain('deepseek-flash');
  });

  it('点击触发器展开浮层，浮层挂在 body 上（不被容器裁掉）', () => {
    mount();
    const trigger = host!.querySelector('.menu-select-trigger') as HTMLButtonElement;
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // portal 到 body，不在 host 内
    const menu = document.body.querySelector('.menu-select-menu');
    expect(menu).not.toBeNull();
    expect(host!.querySelector('.menu-select-menu')).toBeNull();
    // 含「跟随配置」项
    expect(menu!.textContent).toContain('跟随 config.toml');
    // 关闭：再点一次触发器（卸载由 afterEach 的 unmount 负责，
    // 手工 remove portal 节点会让 React 卸载时再次删它而报错）
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.body.querySelector('.menu-select-menu')).toBeNull();
  });

  it('选中项后浮层关闭并回调新值', () => {
    const onSelectModel = vi.fn();
    mount({ onSelectModel });
    const trigger = host!.querySelector('.menu-select-trigger') as HTMLButtonElement;
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const items = Array.from(document.body.querySelectorAll('.menu-select-item'));
    const target = items.find((i) => i.textContent?.includes('模型一')) as HTMLButtonElement;
    expect(target).toBeDefined();
    act(() => {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectModel).toHaveBeenCalledWith('m1');
    expect(document.body.querySelector('.menu-select-menu')).toBeNull();
  });
});

describe('↑ / ↓ 历史回溯', () => {
  it('提交后按 ↑ 取回上一条', () => {
    const { onSubmit } = mount();
    type('第一条指令');
    key('Enter');
    expect(onSubmit).toHaveBeenCalledWith('第一条指令');
    expect(ta().value).toBe('');

    key('ArrowUp', { cursorAt: 0 });
    expect(ta().value).toBe('第一条指令');
  });

  it('草稿在往返后必须还回来（核心：不能吞掉用户打了一半的内容）', () => {
    mount();
    type('旧指令');
    key('Enter');

    type('我打了一半的话');
    key('ArrowUp', { cursorAt: '我打了一半的话'.length });
    expect(ta().value).toBe('旧指令');

    key('ArrowDown', { cursorAt: 0 });
    expect(ta().value).toBe('我打了一半的话');
  });

  it('光标在中间行时 ↑ 不被抢占——多行输入里光标导航优先', () => {
    mount();
    type('第一行\n第二行');
    // 光标放在第二行中间（其前有换行）
    key('ArrowUp', { cursorAt: 5 });
    // 内容不变，说明没有触发历史回溯
    expect(ta().value).toBe('第一行\n第二行');
  });

  it('光标在第一行行首时 ↑ 才接管', () => {
    mount();
    type('第一条');
    key('Enter');
    type('新的草稿');
    key('ArrowUp', { cursorAt: 0 });
    expect(ta().value).toBe('第一条');
  });

  it('手动编辑后退出回溯（避免下标与内容错位）', () => {
    mount();
    type('历史的');
    key('Enter');
    type('草稿');
    key('ArrowUp', { cursorAt: '草稿'.length });
    expect(ta().value).toBe('历史的');
    // 编辑一下再按 ↓：此时已回到草稿态，↓ 不应有动作
    type('历史的改');
    key('ArrowDown', { cursorAt: 0 });
    expect(ta().value).toBe('历史的改');
  });

  it('无历史时 ↑ 不回绕、不报错', () => {
    mount();
    type('草稿');
    key('ArrowUp', { cursorAt: 2 });
    expect(ta().value).toBe('草稿');
  });
});

describe('@ 引用工作区文件', () => {
  const files = [
    { path: 'src/main.ts', fileName: 'main.ts', matchType: 'file', score: 100, indices: [] },
    { path: 'src/components', fileName: 'components', matchType: 'directory', score: 90, indices: [] },
  ];

  it('输入 @ 后弹出候选，选中项替换成路径引用', async () => {
    const onSearchFiles = vi.fn().mockResolvedValue(files);
    mount({ onSearchFiles });
    type('@ma');
    // 防抖 120ms
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    const menu = host!.querySelector('.at-menu');
    expect(menu).not.toBeNull();
    expect(menu!.textContent).toContain('main.ts');

    // 点第一项
    const item = host!.querySelector('.at-item') as HTMLButtonElement;
    act(() => {
      item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(ta().value).toBe('@src/main.ts ');
    expect(host!.querySelector('.at-menu')).toBeNull();
  });

  it('↑↓ 在候选间移动，Enter 选中（不发送）', async () => {
    const onSearchFiles = vi.fn().mockResolvedValue(files);
    const { onSubmit } = mount({ onSearchFiles });
    type('@');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(host!.querySelectorAll('.at-item')).toHaveLength(2);

    key('ArrowDown');
    // 第二项应为高亮
    const items = host!.querySelectorAll('.at-item');
    expect(items[1].className).toContain('is-active');

    key('Enter');
    expect(ta().value).toBe('@src/components ');
    // 关键：选中候选不该把内容发出去
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Esc 只关候选列表，不清空输入', async () => {
    const onSearchFiles = vi.fn().mockResolvedValue(files);
    mount({ onSearchFiles });
    type('@ma');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(host!.querySelector('.at-menu')).not.toBeNull();
    key('Escape');
    expect(host!.querySelector('.at-menu')).toBeNull();
    expect(ta().value).toBe('@ma');
  });

  it('邮箱地址不触发候选', async () => {
    const onSearchFiles = vi.fn().mockResolvedValue(files);
    mount({ onSearchFiles });
    type('user@example.com');
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    expect(host!.querySelector('.at-menu')).toBeNull();
    expect(onSearchFiles).not.toHaveBeenCalled();
  });
});

describe('斜杠命令', () => {
  it('/compact 触发压缩且不把命令发给模型', () => {
    const onCompact = vi.fn();
    const { onSubmit } = mount({ onCompact });
    type('/compact');
    key('Enter');
    expect(onCompact).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(ta().value).toBe('');
  });

  it('未知斜杠命令按普通文本发送（不做假命令）', () => {
    const { onSubmit } = mount({ onCompact: () => {} });
    type('/unknown');
    key('Enter');
    expect(onSubmit).toHaveBeenCalledWith('/unknown');
  });
});
