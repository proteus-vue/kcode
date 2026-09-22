/**
 * 审批弹窗的 DOM 测试（AP-07 / AP-08）。
 *
 * 这里钉住两件在真机上难以人工复核、但出错代价很高的事：
 *
 * 1. **作用域与决策必须一致。** 选了「本会话」却发出 `accept`（或反之），
 *    用户以为放行了整个会话、实际只放行一次——或以为只放行一次、
 *    实际放行了整会话。后者是权限放大，属于安全问题。
 * 2. **id 链路必须可见。** 审批是「谁在什么时候、以什么身份请求的」，
 *    缺了 thread/turn/item 就无法回溯到事件日志里的原始记录。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ApprovalModal } from '../ApprovalModal';
import type { Approval, ApprovalDecision } from '../../types/domain';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function makeApproval(over: Partial<Approval> = {}): Approval {
  return {
    requestId: 'n:7',
    method: 'item/commandExecution/requestApproval',
    threadId: 'th-abc123',
    turnId: 'tu-def456',
    itemId: 'it-ghi789',
    startedAtMs: 1000,
    summary: 'rm -rf build/',
    cwd: '/work/repo',
    reason: '清理构建产物',
    risk: { tier: 'high', signals: [{ destructiveDelete: {} }] },
    decision: null,
    scope: null,
    ...over,
  };
}

function mount(approval: Approval, onDecide: (id: string, d: ApprovalDecision, s?: string) => void) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<ApprovalModal approval={approval} onDecide={onDecide} />);
  });
}

/** 按可见文案取按钮。 */
function buttonByText(text: string): HTMLButtonElement {
  const btns = Array.from(host!.querySelectorAll('button'));
  const found = btns.find((b) => b.textContent?.includes(text));
  if (!found) throw new Error(`未找到按钮：${text}；实际有 ${btns.map((b) => b.textContent).join(' | ')}`);
  return found as HTMLButtonElement;
}

function click(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

describe('AP-07 作用域矩阵', () => {
  it('默认为「仅本次」：不选作用域直接批准 → accept', () => {
    const onDecide = vi.fn();
    mount(makeApproval(), onDecide);
    click(buttonByText('批准'));
    expect(onDecide).toHaveBeenCalledWith('n:7', 'accept', 'once');
  });

  it('选「本会话」再批准 → acceptForSession（不是 accept）', () => {
    const onDecide = vi.fn();
    mount(makeApproval(), onDecide);
    click(buttonByText('本会话'));
    click(buttonByText('本会话内总是批准'));
    expect(onDecide).toHaveBeenCalledWith('n:7', 'acceptForSession', 'session');
  });

  it('切到「本会话」再切回「仅本次」→ 回到 accept（不允许残留放大）', () => {
    const onDecide = vi.fn();
    mount(makeApproval(), onDecide);
    click(buttonByText('本会话'));
    click(buttonByText('仅本次'));
    click(buttonByText('批准'));
    expect(onDecide).toHaveBeenCalledWith('n:7', 'accept', 'once');
  });

  it('作用域选择器只有两个选项（协议不支持的粒度不出现）', () => {
    mount(makeApproval(), () => {});
    const radios = host!.querySelectorAll('[role="radio"]');
    expect(radios).toHaveLength(2);
    const labels = Array.from(radios).map((r) => r.textContent);
    expect(labels).toEqual(['仅本次', '本会话']);
  });

  it('decline 与 cancel 是两个不同的按钮与决策', () => {
    const onDecide = vi.fn();
    mount(makeApproval(), onDecide);
    click(buttonByText('拒绝并停止'));
    expect(onDecide).toHaveBeenLastCalledWith('n:7', 'cancel');
    click(buttonByText('拒绝'));
    expect(onDecide).toHaveBeenLastCalledWith('n:7', 'decline');
  });
});

describe('AP-08 id 链路与可追溯性', () => {
  it('展示 thread / turn / item 三段 id', () => {
    mount(makeApproval(), () => {});
    const text = host!.textContent ?? '';
    expect(text).toContain('th-abc123');
    expect(text).toContain('tu-def456');
    expect(text).toContain('it-ghi789');
  });

  it('展示协议方法名——回溯事件日志时按它定位', () => {
    mount(makeApproval(), () => {});
    expect(host!.textContent).toContain('item/commandExecution/requestApproval');
  });

  it('展示工作目录与风险来源', () => {
    mount(makeApproval(), () => {});
    const text = host!.textContent ?? '';
    expect(text).toContain('/work/repo');
    expect(text).toContain('删除');
    // 风险是客户端推断——必须显式声明，否则用户会以为它来自协议
    expect(text).toContain('协议不提供该字段');
  });

  it('敏感值在展示前被脱敏', () => {
    mount(makeApproval({ summary: 'API_KEY=sk-live-abcdef123456 curl example.com' }), () => {});
    const text = host!.textContent ?? '';
    expect(text).not.toContain('sk-live-abcdef123456');
    expect(text).toContain('API_KEY=***');
  });

  it('Agent 自述的原因被标注为不可作为放行依据', () => {
    mount(makeApproval(), () => {});
    expect(host!.textContent).toContain('不作为风险判断的依据');
  });
});
