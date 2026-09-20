/**
 * 权限档位切换器。
 *
 * 形态对齐 Codex：底栏左侧一个按钮显示当前档位，点开是一个浮层，
 * 列出三档并各自说明「什么情况下会请求批准」。
 *
 * 三个设计决定：
 *
 * 1. **三档而不是两个独立下拉**。协议里 `sandbox` 与 `approvalPolicy`
 *    是两个参数，但同时暴露给用户会产生无法预判的组合（例如
 *    「完全访问 + 总是审批」）。Codex 也只给三档。
 * 2. **危险档位用警示色且单独间隔**。它与前两档不是同一类东西——
 *    前两档是「在哪需要批准」，它是「不再需要批准」。放同一组里
 *    沿用手感会让人误以为是同一性质的选项。
 * 3. **不显示协议原始 id**（`:workspace` 这类）。用户不该看到冒号前缀。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import type { PermissionMode } from '../types/domain';

interface ModeInfo {
  mode: PermissionMode;
  label: string;
  hint: string;
  /** 会导致不可逆后果的档位：用警示色，并在切换时二次确认。 */
  danger?: boolean;
}

/**
 * 三档的文案。
 *
 * 措辞刻意不用「安全」「不安全」这类判断，而是陈述**会发生什么**——
 * 用户需要据此预判 Agent 的行为，而不是接受一个我们替他下的结论。
 */
const MODES: ModeInfo[] = [
  {
    mode: 'readOnly',
    label: '只读',
    hint: '读取文件不受限；任何修改与联网都需要批准',
  },
  {
    mode: 'workspaceWrite',
    label: '工作区可写',
    hint: '工作区内可自由修改；越界写入与联网需要批准',
  },
  {
    mode: 'fullAccess',
    label: '完全访问权限',
    hint: '不受限制地访问互联网和你电脑上的任何文件',
    danger: true,
  },
];

export function PermissionPicker({
  current,
  disabled,
  onSelect,
}: {
  current: PermissionMode | null;
  disabled?: boolean;
  onSelect: (mode: PermissionMode) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<PermissionMode | null>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  /**
   * 打开时按触发按钮的位置算出浮层坐标。
   *
   * **浮层通过 portal 挂到 body，不留在原地**。原因：它所在的
   * `.ctx-chips` 为了「芯片不换行」设了 `overflow: hidden`，
   * 而浮层是向上弹出的（顶部高于容器顶边）——留在原地会被整个裁掉，
   * 表现为「点了没反应」（实测：命中测试落在 textarea 上）。
   * 这类问题在 DOM 和样式里都看不出来，只有真去点才发现。
   */
  const measure = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: r.left, bottom: window.innerHeight - r.top + 8 });
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setConfirming(null);
  }, []);

  // 点击外部关闭。同时监听 Esc——浮层遮住了正文，用户会本能地按 Esc。
  useEffect(() => {
    if (!open) return;
    // portal 出去后，rootRef 里已不含浮层，因此用类名判断
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (rootRef.current?.contains(t) || t.closest?.('.perm-menu, .perm-confirm')) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    // 滚动或缩放后位置会失效，直接关闭比浮层飘走更可预期
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  const active = MODES.find((m) => m.mode === current) ?? null;
  const pendingInfo = MODES.find((m) => m.mode === confirming) ?? null;

  return (
    <div className="perm-picker" ref={rootRef}>
      <button
        className={`perm-trigger ${active?.danger ? 'is-danger' : ''}`}
        onClick={() => {
          if (!open) measure();
          setOpen((v) => !v);
        }}
        disabled={disabled}
        title="沙箱与审批策略"
        aria-expanded={open}
      >
        {/* 图标固定用盾牌，危险与否交给颜色表达。
            曾用 ✕ 表示危险档位——但 ✕ 的通用含义是「关闭/取消」，
            放在这里会被读成「点一下就关掉这个功能」。 */}
        <Icon name="shield" size={11} />
        <span className="perm-trigger-label">{active?.label ?? '读取中…'}</span>
        <span className="perm-caret">⌄</span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            className="perm-layer"
            style={{ left: pos.left, bottom: pos.bottom }}
            role="menu"
          >
            {/* 确认阶段隐藏菜单。两者叠在一起时，菜单里的选项看起来仍可点，
                而此刻用户应当先回答这一个问题。 */}
            <div className="perm-menu" hidden={pendingInfo !== null}>
              <div className="perm-menu-head">
                <span>应如何批准 KCode 的操作？</span>
              </div>

              {MODES.map((m) => {
                const isActive = m.mode === current;
                return (
                  <button
                    key={m.mode}
                    role="menuitemradio"
                    aria-checked={isActive}
                    className={`perm-item ${m.danger ? 'is-danger' : ''} ${isActive ? 'is-active' : ''}`}
                    onClick={() => {
                      // 危险档位先确认再提交。其余档位直接生效——
                      // 给每个选项都加确认会让确认变成无脑点击。
                      if (m.danger && !isActive) {
                        setConfirming(m.mode);
                        return;
                      }
                      close();
                      if (!isActive) onSelect(m.mode);
                    }}
                  >
                    <span className="perm-item-body">
                      <span className="perm-item-label">{m.label}</span>
                      <span className="perm-item-hint">{m.hint}</span>
                    </span>
                    {isActive && <span className="perm-check">✓</span>}
                  </button>
                );
              })}
            </div>

            {pendingInfo && (
              <div className="perm-confirm" role="alertdialog">
                <div className="perm-confirm-title">
                  <Icon name="shield" size={13} />
                  <span>切到「{pendingInfo.label}」？</span>
                </div>
                <p className="perm-confirm-body">
                  Agent 将不再请求批准即可访问互联网与你电脑上的任何文件。
                  这项改动会写入配置，对之后新建的对话生效。
                </p>
                <div className="perm-confirm-actions">
                  <button className="btn" onClick={() => setConfirming(null)}>
                    取消
                  </button>
                  <button
                    className="btn btn-danger"
                    onClick={() => {
                      close();
                      onSelect(pendingInfo.mode);
                    }}
                  >
                    确认切换
                  </button>
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
