/**
 * 侧栏渲染测试。
 *
 * # 为什么必须有这个文件
 *
 * 2026-09-22 真机反馈「启动 dev 黑屏」。根因不在后端也不在 Vite：
 * `ThreadRow` 里引用了父组件作用域的 `renames`（TS2304），
 * Vite dev 只转译不做类型检查，于是渲染到线程行时抛 `ReferenceError`，
 * React 卸载整棵树 → 白/黑屏。
 *
 * 这类缺陷的共性是：**tsc 能抓，但 dev 流程不跑 tsc**；而当时没有任何
 * 测试真正挂载 Sidebar，所以 174 个前端测试全绿也没拦住它。
 * 本文件用真实的 state 挂载整条侧栏渲染路径，把「组件能否渲染」钉住。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Sidebar } from '../Sidebar';
import { initialState, reduce, reduceAll, type RootState } from '../../stores/store';
import type { AppEvent } from '../../types/domain';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(state: RootState) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <Sidebar
        state={state}
        onSelect={() => {}}
        onNewChat={() => {}}
        onExportAudit={() => {}}
        projectName="kcode"
        env={null}
      />,
    );
  });
}

function renderState(events: AppEvent[]): RootState {
  return reduceAll(initialState(), events);
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

describe('侧栏整体渲染（黑屏回归守卫）', () => {
  it('无线程时渲染空态且不抛错', () => {
    mount(initialState());
    expect(host!.textContent).toContain('还没有对话');
  });

  it('有线程时渲染出线程行（此前此处 ReferenceError 导致整树崩溃）', () => {
    const state = renderState([
      { type: 'threadStarted', threadId: 'th-1', cwd: '/work/kcode' },
      {
        type: 'itemUpserted',
        threadId: 'th-1',
        turnId: 'tu-1',
        completed: true,
        item: {
          id: 'i-1',
          turnId: 'tu-1',
          createdAtMs: 1,
          body: { kind: 'userMessage', text: '修一下黑屏' },
        },
      },
    ]);
    mount(state);
    expect(host!.textContent).toContain('修一下黑屏');
    // 行内「⋯」操作入口存在（IA-05）
    expect(host!.querySelector('.thread-menu-btn')).not.toBeNull();
  });

  it('模型徽标渲染短名（IA-04）', () => {
    const state = reduce(renderState([{ type: 'threadStarted', threadId: 'th-1', cwd: '/w' }]), {
      type: 'threadMeta',
      threadId: 'th-1',
      model: 'anthropic/claude-sonnet-4',
    });
    mount(state);
    const badge = host!.querySelector('.sb-model');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('claude-sonnet-4');
  });

  it('无 model 时不渲染空徽标（不占位）', () => {
    mount(renderState([{ type: 'threadStarted', threadId: 'th-1', cwd: '/w' }]));
    expect(host!.querySelector('.sb-model')).toBeNull();
  });

  it('变更文件数徽标与去重后的数字一致（IA-04）', () => {
    const state = reduceAll(renderState([{ type: 'threadStarted', threadId: 'th-1', cwd: '/w' }]), [
      {
        type: 'changeSetReplaced',
        threadId: 'th-1',
        turnId: 'tu-1',
        changeSet: {
          threadId: 'th-1',
          turnId: 'tu-1',
          origin: 'proposed',
          reviewState: 'proposed',
          decisions: ['pending', 'pending'],
          files: [
            { path: '/w/a.ts', kind: { type: 'update' }, diff: '' },
            { path: '/w/b.ts', kind: { type: 'update' }, diff: '' },
          ],
        },
      },
      // 第二轮又改 a.ts —— 徽章应仍显示 2
      {
        type: 'changeSetReplaced',
        threadId: 'th-1',
        turnId: 'tu-2',
        changeSet: {
          threadId: 'th-1',
          turnId: 'tu-2',
          origin: 'proposed',
          reviewState: 'proposed',
          decisions: ['pending'],
          files: [{ path: '/w/a.ts', kind: { type: 'update' }, diff: '' }],
        },
      },
    ]);
    mount(state);
    const badge = host!.querySelector('.sb-chg');
    expect(badge).not.toBeNull();
    expect(badge!.textContent).toBe('Δ2');
  });

  it('点击线程行触发 onSelect', () => {
    const onSelect = vi.fn();
    const state = renderState([{ type: 'threadStarted', threadId: 'th-1', cwd: '/w' }]);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <Sidebar
          state={state}
          onSelect={onSelect}
          onNewChat={() => {}}
          onExportAudit={() => {}}
          projectName="kcode"
          env={null}
        />,
      );
    });
    const row = host.querySelector('.sb-thread') as HTMLButtonElement;
    act(() => {
      row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('th-1');
  });
});
