/**
 * 侧栏线程列表。
 *
 * 排序依据是「待用户操作」而非最近活动时间：
 * 等待审批 > 运行中 > 状态未知 > 失败 > 已完成 > 已中断。
 */
import type { RootState } from '../stores/store';
import { sortedThreadIds, threadSortRank } from '../stores/store';

const RANK_LABEL: Record<number, string> = {
  0: '待审批',
  1: '运行中',
  2: '未知',
  3: '失败',
  4: '已完成',
  5: '已中断',
};

export function ThreadList({
  state,
  onSelect,
}: {
  state: RootState;
  onSelect: (threadId: string) => void;
}) {
  const ids = sortedThreadIds(state);

  return (
    <nav className="thread-list" aria-label="线程列表">
      <div className="panel-title">线程</div>
      {ids.length === 0 && <p className="empty">尚无线程</p>}
      <ul>
        {ids.map((id) => {
          const th = state.threads[id];
          const rank = threadSortRank(state, id);
          const pending = Object.keys(th.pendingApprovals).length;
          return (
            <li
              key={id}
              className={`thread-row ${state.activeThreadId === id ? 'is-active' : ''} ${pending > 0 ? 'has-pending' : ''}`}
              onClick={() => onSelect(id)}
            >
              <div className="thread-row-main">
                <span className="thread-id mono-small">{id.slice(0, 8)}</span>
                <span className={`thread-badge rank-${rank}`}>{RANK_LABEL[rank] ?? ''}</span>
              </div>
              {pending > 0 && (
                <div className="thread-pending">{pending} 项待审批</div>
              )}
              <div className="thread-cwd mono-small">{th.cwd}</div>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
