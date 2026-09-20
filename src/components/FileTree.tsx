/**
 * 文件树场景。
 *
 * 用协议的 `fs/readDirectory` 而不是自己读目录：这样看到的是
 * app-server 视角下的文件系统（同一沙箱策略、同一路径解析），
 * 与 Agent 看到的一致。自己读会得到一个「权限不同」的视图，
 * 用户据此判断「Agent 能不能读到这个文件」就会出错。
 *
 * 懒加载：只在展开某个目录时才读它。一次性递归会把大仓库拖垮。
 */
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Icon } from './Icon';
import { extractErrorMessage } from '../stores/useKcode';

interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/** 一个已展开的目录及其子项。 */
interface Loaded {
  entries: DirEntry[];
  error: string | null;
}

/** 目录排序：目录在前、然后按名称。与访达一致，用户不必重新适应。 */
function sortEntries(es: DirEntry[]): DirEntry[] {
  return [...es].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function FileTree({
  root,
  selected,
  onSelect,
}: {
  /** 工作区绝对路径。 */
  root: string;
  /** 当前选中的文件路径（用于高亮）。 */
  selected: string | null;
  onSelect: (absPath: string) => void;
}) {
  // path → 该目录的子项。展开过的目录留在这里，折叠再展开不重读。
  const [cache, setCache] = useState<Record<string, Loaded>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ [root]: true });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (path: string) => {
    try {
      const entries = await invoke<DirEntry[]>('read_directory', { path });
      setCache((prev) => ({ ...prev, [path]: { entries: sortEntries(entries), error: null } }));
    } catch (e) {
      // 读不到的目录（权限、已删除）在该节点上显示原因，
      // 而不是整棵树报错——一个坏目录不该让整个面板不可用。
      setCache((prev) => ({
        ...prev,
        [path]: { entries: [], error: extractErrorMessage(e) },
      }));
    }
  }, []);

  useEffect(() => {
    if (!root) {
      setError('没有工作区路径');
      return;
    }
    void load(root);
  }, [root, load]);

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = { ...prev, [path]: !prev[path] };
      if (next[path] && !cache[path]) void load(path);
      return next;
    });
  };

  if (error) return <p className="file-tree-error">{error}</p>;

  const render = (path: string, depth: number): React.ReactNode => {
    const node = cache[path];
    if (!node) return <p className="tree-loading">正在读取…</p>;
    if (node.error) {
      return (
        <p className="tree-error" style={{ paddingLeft: 10 + depth * 12 }}>
          {node.error}
        </p>
      );
    }
    return node.entries.map((e) => {
      const child = `${path}/${e.name}`;
      const isOpen = expanded[child] ?? false;
      return (
        <div key={child}>
          <button
            className={`tree-row ${selected === child ? 'is-selected' : ''}`}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => (e.isDirectory ? toggle(child) : onSelect(child))}
            title={child}
          >
            {e.isDirectory ? (
              <span className={`tree-caret ${isOpen ? 'open' : ''}`}>
                <Icon name="chevron" size={10} />
              </span>
            ) : (
              <span className="tree-caret" />
            )}
            <Icon name={e.isDirectory ? 'folder' : 'file'} size={11} />
            <span className="tree-name">{e.name}</span>
          </button>
          {e.isDirectory && isOpen && render(child, depth + 1)}
        </div>
      );
    });
  };

  return <div className="file-tree">{render(root, 0)}</div>;
}
