/**
 * 左侧栏。结构对齐 Codex 桌面端：
 *
 * ```
 * ┌──────────────────────────┐
 * │ KCode ▾        🔍  🔔    │  品牌 + 搜索/通知
 * │ ✎ 新对话                  │  主导航（图标 + 文字）
 * │ ⑂ Pull Request           │
 * │ ⏰ 已安排                 │
 * │ ⊞ 插件                   │
 * │ ─────────────────────    │
 * │ 项目                      │  按项目分组，可展开
 * │  ▾ proteus               │
 * │     • 线程 A             │
 * │ ─────────────────────    │
 * │ 最近                      │  扁平列表，跨项目
 * │  • 线程 C                 │
 * └──────────────────────────┘
 * ```
 *
 * # 为什么是「项目 + 最近」两段而非一条扁平列表
 *
 * 扁平列表在 20+ 线程后无法定位——用户记得「那个在 proteus 里的任务」，
 * 但记不住标题。分组让「找项目 → 找线程」成为两级检索；
 * 「最近」段覆盖「刚做过什么」这个高频问题，不必先想是哪个项目。
 */
import { useMemo, useState } from 'react';
import type { RootState } from '../stores/store';
import {
  changedFileCount,
  groupByProject,
  recentThreads,
  relativeTime,
  shortModelName,
  threadLastActivity,
  threadSortRank,
  threadTitle,
} from '../stores/store';
import { Icon } from './Icon';
import { ThreadMenu } from './ThreadMenu';
import { onColumnBandDoubleClick, onTitlebarDoubleClick } from '../hooks/titlebarZoom';

export function Sidebar({
  state,
  onSelect,
  onNewChat,
  onExportAudit,
  projectName,
  env,
}: {
  state: RootState;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onExportAudit: () => void;
  /** 当前工作区名，同时用作空态与「新对话」的语境。 */
  projectName: string;
  env: { workspace: string; codexHome: string } | null;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showAllRecent, setShowAllRecent] = useState(false);
  const [searching, setSearching] = useState(false);
  const [filter, setFilter] = useState('');
  const [pinnedIds, setPinnedIds] = useState<Record<string, boolean>>({});
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [archived, setArchived] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);

  const groups = useMemo(() => groupByProject(state), [state]);
  const recent = useMemo(() => recentThreads(state, showAllRecent ? 50 : 6), [state, showAllRecent]);

  const q = filter.trim().toLowerCase();
  const match = (id: string) => {
    if (!q) return true;
    return (
      threadTitle(state, id).toLowerCase().includes(q) ||
      (state.threads[id]?.cwd ?? '').toLowerCase().includes(q)
    );
  };

  return (
    <aside className="sidebar" onDoubleClick={onColumnBandDoubleClick}>
      {/* 导航条双击缩放窗口（与系统标题栏双击对齐）。品牌头刻意用 div
          而非 button：它没有任何 click 行为，无行为的 button 会误导
          辅助技术；div 同时让它被判定为「非交互目标」，双击即缩放。 */}
      <header className="sb-head" onDoubleClick={onTitlebarDoubleClick}>
        <div className="sb-brand" title={env?.workspace ?? ''}>
          <span className="brand-mark">K</span>
          <span className="brand-name">{projectName}</span>
          <span className="sb-caret"><Icon name="chevron" size={11} /></span>
        </div>
        <div className="sb-head-actions">
          <button
            className={`icon-btn ${searching ? 'on' : ''}`}
            title="搜索对话"
            onClick={() => {
              setSearching((v) => !v);
              if (searching) setFilter('');
            }}
          >
            <Icon name="search" size={14} />
          </button>
          <button className="icon-btn" title="通知（尚未实现）" disabled>
            <Icon name="bell" size={14} />
          </button>
        </div>
      </header>

      <nav className="sb-nav">
        <button className="nav-item accent" onClick={onNewChat}>
          <Icon name="new-chat" size={14} />
          <span>新对话</span>
        </button>
        <button className="nav-item" disabled title="尚未实现">
          <Icon name="branch" size={14} />
          <span>Pull Request</span>
        </button>
        <button className="nav-item" disabled title="尚未实现">
          <Icon name="clock" size={14} />
          <span>已安排</span>
        </button>
        <button className="nav-item" disabled title="尚未实现">
          <Icon name="plugin" size={14} />
          <span>插件</span>
        </button>
      </nav>

      {searching && (
        <div className="sb-search">
          <Icon name="search" size={12} />
          <input
            autoFocus
            value={filter}
            placeholder="搜索对话与项目"
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}

      <div className="sb-scroll">
        {/* ── 项目 ─────────────────────────────────────────────────── */}
        <div className="sb-section">
          <div className="sb-section-title">
            <span>项目</span>
            {groups.length > 0 && <span className="sb-count">{groups.length}</span>}
          </div>
          {groups.length === 0 && <p className="sb-empty">还没有对话</p>}

          {groups.map((g) => {
            const visible = g.threadIds.filter(match);
            if (q && visible.length === 0) return null;
            const isOpen = !collapsed[g.project];
            return (
              <div key={g.project} className="sb-project">
                <button
                  className="sb-project-head"
                  onClick={() => setCollapsed((c) => ({ ...c, [g.project]: isOpen }))}
                  title={g.cwd}
                >
                  <span className={`sb-caret ${isOpen ? 'open' : ''}`}>
                    <Icon name="chevron" size={11} />
                  </span>
                  <span className="sb-project-name">{g.project}</span>
                  <span className="sb-count">{g.threadIds.length}</span>
                </button>
                {isOpen &&
                  visible.map((id) => (
                    <ThreadRow
                      menu={
                        <ThreadMenu
                          threadId={id}
                          title={renames[id] ?? threadTitle(state, id)}
                          pinned={!!pinnedIds[id]}
                          onPinned={(i, v) => setPinnedIds((m) => ({ ...m, [i]: v }))}
                          onRenamed={(i, n) => setRenames((m) => ({ ...m, [i]: n }))}
                          onArchived={(i) =>
                            setArchived((prev) => {
                              const n = new Set(prev);
                              n.add(i);
                              return n;
                            })
                          }
                          onError={setErr}
                        />
                      }
                      rename={renames[id]}
                      hidden={archived.has(id)}
                      key={id}
                      state={state}
                      id={id}
                      indented
                      active={state.activeThreadId === id}
                      onSelect={onSelect}
                    />
                  ))}
              </div>
            );
          })}
        </div>

        {/* ── 最近 ─────────────────────────────────────────────────── */}
        {recent.length > 0 && (
          <div className="sb-section">
            <div className="sb-section-title">
              <span>最近</span>
            </div>
            {recent.filter(match).map((id) => (
              <ThreadRow
                menu={
                  <ThreadMenu
                    threadId={id}
                    title={renames[id] ?? threadTitle(state, id)}
                    pinned={!!pinnedIds[id]}
                    onPinned={(i, v) => setPinnedIds((m) => ({ ...m, [i]: v }))}
                    onRenamed={(i, n) => setRenames((m) => ({ ...m, [i]: n }))}
                    onArchived={(i) =>
                      setArchived((prev) => {
                        const n = new Set(prev);
                        n.add(i);
                        return n;
                      })
                    }
                    onError={setErr}
                  />
                }
                rename={renames[id]}
                hidden={archived.has(id)}
                key={id}
                state={state}
                id={id}
                active={state.activeThreadId === id}
                onSelect={onSelect}
              />
            ))}
            {!showAllRecent && state.threadOrder.length > recent.length && (
              <button className="sb-more" onClick={() => setShowAllRecent(true)}>
                展开显示
              </button>
            )}
          </div>
        )}
      </div>

      <footer className="sb-foot">
        {env && (
          <details className="sb-env">
            <summary title={env.workspace}>运行环境</summary>
            <dl>
              <dt>工作区</dt>
              <dd>{env.workspace}</dd>
              <dt>CODEX_HOME</dt>
              <dd>{env.codexHome}</dd>
            </dl>
          </details>
        )}
        <button className="nav-item subtle" onClick={onExportAudit}>
          <Icon name="shield" size={14} />
          <span>导出审计日志</span>
        </button>
      </footer>
      {err && <div className="sb-thread-err">{err}</div>}
    </aside>
  );
}

/** 单个线程行。项目组内缩进，最近列表不缩进。 */
function ThreadRow({
  state,
  id,
  indented,
  active,
  onSelect,
  menu,
  rename,
  hidden,
}: {
  state: RootState;
  id: string;
  indented?: boolean;
  active: boolean;
  onSelect: (id: string) => void;
  menu?: React.ReactNode;
  /** 本地临时重命名（服务端 thread/name/set 成功后写入）。 */
  rename?: string;
  /** 已归档：从列表中移除（服务端 thread/archive 成功后置位）。 */
  hidden?: boolean;
}) {
  if (hidden) return null;

  const rank = threadSortRank(state, id);
  const pending = Object.keys(state.threads[id]?.pendingApprovals ?? {}).length;
  const time = relativeTime(threadLastActivity(state, id));
  const changed = changedFileCount(state, id);
  const model = shortModelName(state.threads[id]?.model ?? null);
  const label = rename ?? threadTitle(state, id);

  return (
    <div className="sb-thread-wrap">
      <button
        className={`sb-thread ${indented ? 'indented' : ''} ${active ? 'is-active' : ''}`}
        onClick={() => onSelect(id)}
        title={label}
      >
        <span className="sb-thread-title">{label}</span>
        <span className="sb-thread-meta">
          {pending > 0 && <span className="dot dot-warn" title={`${pending} 项待审批`} />}
          {pending === 0 && rank === 1 && <span className="dot dot-run" title="运行中" />}
          {pending === 0 && rank === 3 && <span className="dot dot-fail" title="失败" />}
          {model && (
            <span className="sb-model" title={`模型：${state.threads[id]?.model}`}>
              {model}
            </span>
          )}
          {changed > 0 && (
            <span className="sb-chg" title={`${changed} 个文件有变更`}>
              Δ{changed}
            </span>
          )}
          {time && <span className="sb-time">{time}</span>}
        </span>
      </button>
      {menu}
    </div>
  );
}
