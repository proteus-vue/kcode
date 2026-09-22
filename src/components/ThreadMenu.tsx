/**
 * 线程行操作菜单：重命名 / 置顶 / 归档。
 *
 * 协议有 `thread/name/set` 与 `thread/archive`（docs/protocol-facts.md），
 * 置顶是本地 UI 状态（协议无对应原语）。
 *
 * 用行内「⋯」而非右键：WKWebView 会抢占右键弹系统菜单（见 Workbench 注释）。
 */
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface ThreadMenuProps {
  threadId: string;
  title: string;
  pinned: boolean;
  onPinned: (id: string, pinned: boolean) => void;
  onRenamed: (id: string, name: string) => void;
  onArchived: (id: string) => void;
  onError: (msg: string) => void;
}

export function ThreadMenu({
  threadId,
  title,
  pinned,
  onPinned,
  onRenamed,
  onArchived,
  onError,
}: ThreadMenuProps) {
  const [open, setOpen] = useState(false);

  const act = async (fn: () => Promise<void>) => {
    setOpen(false);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="thread-menu-wrap">
      <button
        className="thread-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title="线程操作"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        ⋯
      </button>
      {open && (
        <div className="thread-menu" role="menu" onClick={(e) => e.stopPropagation()}>
          <button
            role="menuitem"
            onClick={() =>
              act(async () => {
                const name = window.prompt('重命名线程', title);
                if (name == null) return;
                const trimmed = name.trim();
                if (!trimmed) return;
                await invoke('thread_name_set', { threadId, name: trimmed });
                onRenamed(threadId, trimmed);
              })
            }
          >
            重命名
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onPinned(threadId, !pinned);
            }}
          >
            {pinned ? '取消置顶' : '置顶'}
          </button>
          <button
            role="menuitem"
            className="danger"
            onClick={() =>
              act(async () => {
                if (!window.confirm('归档该线程？可在归档列表恢复。')) return;
                await invoke('thread_archive', { threadId, archived: true });
                onArchived(threadId);
              })
            }
          >
            归档
          </button>
        </div>
      )}
    </div>
  );
}
