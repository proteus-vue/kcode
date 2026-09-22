/**
 * Diff 审阅面板。
 *
 * # 数据来源的优先级
 *
 * 协议有两个 diff 通道，可用性不同（实测）：
 *
 * | 通道 | 可用性 | 本面板的用途 |
 * |---|---|---|
 * | `fileChange` 的逐文件结构 | 条件性 | **首选**：可逐文件决策 |
 * | `turn/diff/updated` 整轮 diff | 稳定 | 回退：只读总览 |
 *
 * 反过来会导致面板在常见路径下空白。
 *
 * # 三个必须按 kind 分派的地方
 *
 * `diff` 字段的内容随变更类型变化（`add`/`delete` 是完整内容，`update` 是
 * 不含文件头的 hunk），因此行数统计与渲染都不能统一处理——
 * 否则新增/删除文件会显示成「+0 -0」。
 */

import { useMemo, useState } from 'react';
import { Icon } from './Icon';
import type { ChangeSet, FileChangeEntry, ParsedDiff } from '../types/domain';
import {
  changeKindClass,
  changeKindLabel,
  changeOriginLabel,
  decisionOf,
  diffStats,
  fileStats,
  groupByKind,
  isDestructiveChange,
  movedTo,
  relativePath,
  reviewStateLabel,
  totalsForChangeSet,
} from '../stores/store';
import { parseUnifiedDiff as parseForRender, stripMoveTrailer } from '../stores/store';

interface Props {
  changeSet: ChangeSet | null;
  turnDiff: ParsedDiff | null;
  workspace?: string | null;
  onDecideFile?: (path: string, decision: 'accepted' | 'rejected') => void;
  onDecideAll?: (decision: 'accepted' | 'rejected') => void;
  /** 点击文件路径时在右栏打开详情。 */
  onOpenFile?: (path: string) => void;
}

export function DiffViewer({
  changeSet,
  turnDiff,
  workspace,
  onDecideFile,
  onDecideAll,
  onOpenFile,
}: Props) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [splitMode, setSplitMode] = useState(false);

  const totals = useMemo(
    () => (changeSet ? totalsForChangeSet(changeSet) : { added: 0, removed: 0 }),
    [changeSet],
  );

  // 回退：只有整轮 diff 时给只读视图
  if (!changeSet || changeSet.files.length === 0) {
    return <TurnDiffFallback turnDiff={turnDiff} />;
  }

  const groups = groupByKind(changeSet);

  return (
    <div className="diff-viewer">
      <header className="diff-header">
        <span className={`origin-badge origin-${changeSet.origin}`}>
          {changeOriginLabel(changeSet.origin)}
        </span>
        <span className={`review-badge review-${changeSet.reviewState}`}>
          {reviewStateLabel(changeSet.reviewState)}
        </span>
        <span className="diff-totals">
          <span className="stat-added">+{totals.added}</span>
          <span className="stat-removed">−{totals.removed}</span>
        </span>
        <span className="meta">{changeSet.files.length} 个文件</span>
        <button className="btn btn-mini" onClick={() => setSplitMode((v) => !v)}>
          {splitMode ? '统一视图' : '并排视图'}
        </button>
      </header>

      {changeSet.origin === 'proposed' && (
        <p className="diff-note">
          这些变更**尚未写入工作区**，正在等待你的审批。
        </p>
      )}

      {onDecideAll && (
        <div className="diff-bulk">
          <button className="btn btn-mini" onClick={() => onDecideAll('accepted')}>
            全部接受
          </button>
          <button className="btn btn-mini btn-ghost" onClick={() => onDecideAll('rejected')}>
            全部拒绝
          </button>
        </div>
      )}

      {Object.entries(groups).map(([label, files]) => (
        <section key={label} className="diff-group">
          <div className="diff-group-title">
            {label} <span className="meta">({files.length})</span>
          </div>
          {files.map((f) => (
            <FileRow
              key={f.path}
              entry={f}
              workspace={workspace}
              decision={decisionOf(changeSet, f.path)}
              expanded={expanded[f.path] ?? false}
              onToggle={() => setExpanded((e) => ({ ...e, [f.path]: !e[f.path] }))}
              onDecide={onDecideFile}
              splitMode={splitMode}
              onOpenFile={onOpenFile}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function FileRow({
  entry,
  workspace,
  decision,
  expanded,
  onToggle,
  onDecide,
  splitMode,
  onOpenFile,
}: {
  entry: FileChangeEntry;
  workspace?: string | null;
  decision: 'pending' | 'accepted' | 'rejected';
  expanded: boolean;
  onToggle: () => void;
  onDecide?: (path: string, decision: 'accepted' | 'rejected') => void;
  splitMode: boolean;
  onOpenFile?: (path: string) => void;
}) {
  const stats = fileStats(entry);
  const to = movedTo(entry);
  const display = relativePath(entry.path, workspace);

  return (
    <div className={`diff-file decision-${decision}`}>
      <div className="diff-file-head" onClick={onToggle}>
        {/* caret 用 chevron 图标而非 `▾`/`▸` 字符：字符是实心三角，
            与文件树、工具行的 chevron 不同构；且两个字符是两套字形，
            切换时形状会跳变——图标用同一个 glyph 靠旋转表达开合。 */}
        <span className={`file-toggle ${expanded ? 'open' : ''}`}>
          <Icon name="chevron" size={10} />
        </span>
        <span className={`change-kind ${changeKindClass(entry.kind)}`}>
          {changeKindLabel(entry.kind)}
        </span>
        {onOpenFile ? (
          <button
            className="file-path is-clickable"
            title={`在右栏查看 ${entry.path}`}
            onClick={(e) => {
              // 阻止冒泡：整个 head 有点击折叠行为
              e.stopPropagation();
              // 必须传 entry.path（真实路径）。display 是缩短过的展示串，
              // 带省略号，后端无法解析。
              onOpenFile(entry.path);
            }}
          >
            {display}
          </button>
        ) : (
          <span className="file-path" title={entry.path}>
            {display}
          </span>
        )}
        {to && (
          <span className="file-moved" title={to}>
            → {relativePath(to, workspace)}
          </span>
        )}
        {isDestructiveChange(entry.kind) && (
          <span className="danger-chip" title="删除操作，影响既有内容">
            删除
          </span>
        )}
        <span className="file-stats">
          {stats.added > 0 && <span className="stat-added">+{stats.added}</span>}
          {stats.removed > 0 && <span className="stat-removed">−{stats.removed}</span>}
          {stats.added === 0 && stats.removed === 0 && (
            // 零行改动通常是重命名或空文件——显式说明，避免看起来像 bug
            <span className="stat-empty">{entry.kind.type === 'update' && to ? '仅重命名' : '无行变更'}</span>
          )}
        </span>
        {onDecide && (
          <span className="file-actions" onClick={(e) => e.stopPropagation()}>
            {decision === 'accepted' ? (
              <span className="decision-chip accepted">已接受</span>
            ) : decision === 'rejected' ? (
              <span className="decision-chip rejected">已拒绝</span>
            ) : (
              <>
                <button className="btn btn-mini" onClick={() => onDecide(entry.path, 'accepted')}>
                  接受
                </button>
                <button className="btn btn-mini btn-ghost" onClick={() => onDecide(entry.path, 'rejected')}>
                  拒绝
                </button>
              </>
            )}
          </span>
        )}
      </div>

      {expanded && (
        <div className="diff-body">
          {/* 按 kind 分派渲染——不能统一当 diff 解析 */}
          {entry.kind.type === 'add' && (
            <pre className="diff-content full-add">{prefixLines(entry.diff, '+', stats.added)}</pre>
          )}
          {entry.kind.type === 'delete' && (
            <pre className="diff-content full-del">{prefixLines(entry.diff, '-', stats.removed)}</pre>
          )}
          {entry.kind.type === 'update' && (
            <HunkView diff={entry.diff} splitMode={splitMode} />
          )}
        </div>
      )}
    </div>
  );
}

/** hunk 文本渲染（update 类型）。 */
function HunkView({ diff, splitMode }: { diff: string; splitMode: boolean }) {
  const parsed = useMemo(() => {
    // 重命名的 diff 尾部带 `Moved to:` 标记，不是 diff 内容；
    // 不剥掉会产生噪声警告并污染行号。
    return parseForRender(stripMoveTrailer(diff));
  }, [diff]);

  if (parsed.hunks.length === 0) {
    return <p className="diff-empty">（无 hunk 内容）</p>;
  }

  return (
    <div className="hunks">
      {parsed.warnings.length > 0 && (
        <p className="diff-warning">解析提示：{parsed.warnings.join('；')}</p>
      )}
      {parsed.hunks.map((h, i) => (
        <div key={i} className="hunk">
          <div className="hunk-header">{h.header}</div>
          {splitMode ? (
            <SplitHunk lines={h.lines} />
          ) : (
            <pre className="hunk-lines">
              {h.lines.map((l, j) => (
                <div key={j} className={`diff-line line-${l.kind}`}>
                  <span className="line-no">{l.oldLine ?? ''}</span>
                  <span className="line-no">{l.newLine ?? ''}</span>
                  <span className="line-sign">
                    {l.kind === 'added' ? '+' : l.kind === 'removed' ? '-' : ' '}
                  </span>
                  <span className="line-text">{l.text}</span>
                </div>
              ))}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

function SplitHunk({ lines }: { lines: ParsedDiff['hunks'][number]['lines'] }) {
  // 简单并排：删除行在左、新增行在右，上下文行两侧都显示
  const rows: { left?: typeof lines[number]; right?: typeof lines[number] }[] = [];
  for (const l of lines) {
    if (l.kind === 'removed') rows.push({ left: l });
    else if (l.kind === 'added') {
      const last = rows[rows.length - 1];
      if (last && last.left && !last.right) last.right = l;
      else rows.push({ right: l });
    } else rows.push({ left: l, right: l });
  }
  return (
    <div className="split-hunk">
      {rows.map((r, i) => (
        <div key={i} className="split-row">
          <div className={`split-cell ${r.left ? `line-${r.left.kind}` : 'line-empty'}`}>
            {r.left && (
              <>
                <span className="line-no">{r.left.oldLine ?? ''}</span>
                <span className="line-text">{r.left.text}</span>
              </>
            )}
          </div>
          <div className={`split-cell ${r.right ? `line-${r.right.kind}` : 'line-empty'}`}>
            {r.right && (
              <>
                <span className="line-no">{r.right.newLine ?? ''}</span>
                <span className="line-text">{r.right.text}</span>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 只读回退视图：仅有整轮 diff 时使用。 */
function TurnDiffFallback({ turnDiff }: { turnDiff: ParsedDiff | null }) {
  if (!turnDiff || turnDiff.hunks.length === 0) {
    return <p className="empty">本轮暂无变更。</p>;
  }
  const stats = diffStats(turnDiff);
  return (
    <div className="diff-viewer">
      <header className="diff-header">
        <span className="origin-badge origin-fallback">整轮 diff（只读）</span>
        <span className="diff-totals">
          <span className="stat-added">+{stats.added}</span>
          <span className="stat-removed">−{stats.removed}</span>
        </span>
      </header>
      <p className="diff-note">
        逐文件结构未提供，此处显示整轮统一 diff。路径：
        {turnDiff.newPath ?? turnDiff.oldPath ?? '(未知)'}
      </p>
      {turnDiff.warnings.length > 0 && (
        <p className="diff-warning">解析提示：{turnDiff.warnings.join('；')}</p>
      )}
      <pre className="hunk-lines">
        {turnDiff.hunks.flatMap((h) =>
          h.lines.map((l, j) => (
            <div key={`${h.header}-${j}`} className={`diff-line line-${l.kind}`}>
              <span className="line-no">{l.oldLine ?? ''}</span>
              <span className="line-no">{l.newLine ?? ''}</span>
              <span className="line-sign">
                {l.kind === 'added' ? '+' : l.kind === 'removed' ? '-' : ' '}
              </span>
              <span className="line-text">{l.text}</span>
            </div>
          )),
        )}
      </pre>
    </div>
  );
}

/** 给纯内容（add/delete）加行首标记。 */
function prefixLines(content: string, sign: string, _count: number): string {
  if (content === '') return '(空文件)';
  return content
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => `${sign} ${l}`)
    .join('\n');
}

