/**
 * 状态浮层的护栏显示测试。
 *
 * 归约层已经在 store.test.ts 里钉住了（警告累积、摘要文案），
 * 但「警告真的显示出来了、且在浮层收起时也不被藏住」属于渲染接线，
 * 只能靠挂载验证。这条正是本次要修的核心缺陷——信号到了后端、
 * 归约也存住了，但用户看不到。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StatusDock } from '../StatusDock';
import { initialState, reduce, type RootState } from '../../stores/store';
import type { AppEvent, ThreadTokenUsage } from '../../types/domain';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(state: RootState, threadId: string | null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <StatusDock
        state={state}
        threadId={threadId}
        projectName="kcode"
        git={null}
        gitRemote={null}
        onRefreshGit={() => {}}
        onCommit={async () => {}}
        onPush={async () => {}}
        permissionMode="workspaceWrite"
        model="m"
        provider="p"
      />,
    );
  });
}

const usage = (totalTokens: number, window = 1000): ThreadTokenUsage => ({
  last: {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
  },
  total: {
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
  },
  modelContextWindow: window,
});

function build(events: AppEvent[]): RootState {
  let s = reduce(initialState(), { type: 'threadStarted', threadId: 'th', cwd: '/w' });
  for (const e of events) s = reduce(s, e);
  return s;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

describe('护栏警告的可见性', () => {
  it('有警告时渲染横幅，并带上警告原文', () => {
    const state = build([
      { type: 'guardianWarning', threadId: 'th', message: '检测到重复的工具调用' },
    ]);
    mount(state, 'th');
    const text = host!.textContent ?? '';
    expect(text).toContain('执行异常提醒');
    expect(text).toContain('检测到重复的工具调用');
  });

  it('无警告时不渲染横幅', () => {
    mount(build([]), 'th');
    expect(host!.querySelector('.guardian-banner')).toBeNull();
  });

  it('警告存在时强制展开——不能被收进胶囊里藏起来', () => {
    const state = build([
      { type: 'guardianWarning', threadId: 'th', message: '循环检测已介入' },
    ]);
    mount(state, 'th');
    // 关键点：这里没有轮次在跑（默认收起），但警告仍必须可见
    expect(host!.querySelector('.status-dock.is-collapsed')).toBeNull();
    expect(host!.querySelector('.guardian-banner')).not.toBeNull();
  });

  it('横幅是 alert 角色（辅助技术需即时播报）', () => {
    const state = build([{ type: 'guardianWarning', threadId: 'th', message: '异常' }]);
    mount(state, 'th');
    const banner = host!.querySelector('.guardian-banner');
    expect(banner?.getAttribute('role')).toBe('alert');
  });

  it('多次警告时显示次数，避免用户以为只发生了一次', () => {
    const state = build([
      { type: 'guardianWarning', threadId: 'th', message: '重复调用' },
      { type: 'guardianWarning', threadId: 'th', message: '仍然重复' },
      { type: 'guardianWarning', threadId: 'th', message: '仍然重复' },
    ]);
    mount(state, 'th');
    expect(host!.textContent).toContain('共 3 次');
  });
});

describe('上下文余量的显示阈值', () => {
  it('充裕时不显示上下文段', () => {
    const state = build([{ type: 'tokenUsageUpdated', threadId: 'th', turnId: 't', usage: usage(100) }]);
    mount(state, 'th');
    expect(host!.textContent).not.toContain('上下文');
  });

  it('接近上限时，胶囊上就有百分比（收起状态也能看到）', () => {
    const state = build([{ type: 'tokenUsageUpdated', threadId: 'th', turnId: 't', usage: usage(750) }]);
    mount(state, 'th');
    // 空闲时浮层默认收起，但接近上限这个事实不该被藏起来
    expect(host!.querySelector('.status-dock.is-collapsed')).not.toBeNull();
    expect(host!.textContent).toContain('75%');
  });

  it('展开后显示剩余量与提示文案', () => {
    const state = build([{ type: 'tokenUsageUpdated', threadId: 'th', turnId: 't', usage: usage(750) }]);
    mount(state, 'th');
    // 点胶囊展开
    const capsule = host!.querySelector('.capsule-expand') as HTMLButtonElement;
    act(() => {
      capsule.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const text = host!.textContent ?? '';
    expect(text).toContain('75%');
    expect(text).toContain('250'); // 剩余 1000-750
    expect(text).toContain('压缩'); // 说明「再聊下去会被压缩」
  });

  it('窗口未知时不显示（算不出比例就不猜）', () => {
    const state = build([
      {
        type: 'tokenUsageUpdated',
        threadId: 'th',
        turnId: 't',
        usage: { ...usage(750), modelContextWindow: null },
      },
    ]);
    mount(state, 'th');
    expect(host!.textContent).not.toContain('%');
  });
});
