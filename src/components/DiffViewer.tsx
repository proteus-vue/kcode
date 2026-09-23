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
import type { ChangeSet, DiffLine, FileChangeEntry, ParsedDiff } from '../types/domain';
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
import {
  anchorOf,
  commentKey,
  countForPath,
  intentLabel,
  makeComment,
  removeComment,
  upsertComment,
  type CommentIntent,
  type ReviewComment,
} from './reviewComments';

interface Props {
  changeSet: ChangeSet | null;
  turnDiff: ParsedDiff | null;
  workspace?: string | null;
  onDecideFile?: (path: string, decision: 'accepted' | 'rejected') => void;
  onDecideAll?: (decision: 'accepted' | 'rejected') => void;
  /** 点击文件路径时在右栏打开详情。 */
  onOpenFile?: (path: string) => void;
  /** 用外部编辑器打开（可选跳到行）。不传则不显示入口。 */
  onOpenInEditor?: (path: string, line?: number) => void;
  /** 撤销该文件的未提交改动。不传则不显示入口。 */
  onRevertFile?: (path: string) => void;
  /** 行内评论的当前集合（受控）。 */
  comments?: ReviewComment[];
  onCommentsChange?: (next: ReviewComment[]) => void;
}

export function DiffViewer({
  changeSet,
  turnDiff,
  workspace,
  onDecideFile,
  onDecideAll,
  onOpenFile,
  onOpenInEditor,
  onRevertFile,
  comments = [],
  onCommentsChange,
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
              onOpenInEditor={onOpenInEditor}
              onRevertFile={onRevertFile}
              comments={comments}
              onCommentsChange={onCommentsChange}
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
  onOpenInEditor,
  onRevertFile,
  comments,
  onCommentsChange,
}: {
  entry: FileChangeEntry;
  workspace?: string | null;
  decision: 'pending' | 'accepted' | 'rejected';
  expanded: boolean;
  onToggle: () => void;
  onDecide?: (path: string, decision: 'accepted' | 'rejected') => void;
  splitMode: boolean;
  onOpenFile?: (path: string) => void;
  onOpenInEditor?: (path: string, line?: number) => void;
  onRevertFile?: (path: string) => void;
  comments: ReviewComment[];
  onCommentsChange?: (next: ReviewComment[]) => void;
}) {
  const stats = fileStats(entry);
  const to = movedTo(entry);
  const display = relativePath(entry.path, workspace);
  const commentCount = countForPath(comments, entry.path);
  const canComment = Boolean(onCommentsChange);

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
        {commentCount > 0 && (
          <span className="comment-chip" title={`${commentCount} 条行内评论`}>
            <Icon name="chat" size={10} />
            {commentCount}
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
        {/* 编辑与撤销放在决策按钮**之前**：这两个是「去动这个文件」，
            与「接受/拒绝这份变更」是不同层面的动作。混在一起点击时
            容易误触（尤其撤销是破坏性的）。 */}
        <span className="file-actions" onClick={(e) => e.stopPropagation()}>
          {onOpenInEditor && (
            <button
              className="btn-icon"
              title={`用编辑器打开 ${entry.path}`}
              aria-label="用编辑器打开"
              onClick={() => onOpenInEditor(entry.path)}
            >
              <Icon name="edit" size={11} />
            </button>
          )}
          {onRevertFile && (
            <button
              className="btn-icon btn-icon-danger"
              title={`撤销 ${entry.path} 的改动`}
              aria-label="撤销此文件的改动"
              onClick={() => onRevertFile(entry.path)}
            >
              <Icon name="undo" size={11} />
            </button>
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
            <HunkView
              diff={entry.diff}
              splitMode={splitMode}
              path={entry.path}
              canComment={canComment}
              comments={comments}
              onCommentsChange={onCommentsChange}
              onOpenInEditor={onOpenInEditor}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** hunk 文本渲染（update 类型）。 */
function HunkView({
  diff,
  splitMode,
  path,
  canComment,
  comments,
  onCommentsChange,
  onOpenInEditor,
}: {
  diff: string;
  splitMode: boolean;
  path: string;
  canComment: boolean;
  comments: ReviewComment[];
  onCommentsChange?: (next: ReviewComment[]) => void;
  onOpenInEditor?: (path: string, line?: number) => void;
}) {
  const parsed = useMemo(() => {
    // 重命名的 diff 尾部带 `Moved to:` 标记，不是 diff 内容；
    // 不剥掉会产生噪声警告并污染行号。
    return parseForRender(stripMoveTrailer(diff));
  }, [diff]);

  /** 正在编辑评论的行键。同一时刻只开一个编辑器——多开会让「发给模型的
      文字」在视觉上与行的对应关系变模糊。 */
  const [editing, setEditing] = useState<string | null>(null);

  if (parsed.hunks.length === 0) {
    return <p className="diff-empty">（无 hunk 内容）</p>;
  }

  const findComment = (key: string) => comments.find((c) => c.id === key);

  const commit = (line: DiffLine, intent: CommentIntent, text: string) => {
    if (!onCommentsChange) return;
    const a = anchorOf(line);
    if (!a) return;
    if (text.trim() === '') {
      // 清空内容 = 删除这条评论，而不是留一条空的（它会被序列化层过滤掉，
      // 但界面上仍显示角标会让人以为还有内容）
      onCommentsChange(removeComment(comments, commentKey(path, a.side, a.line)));
      setEditing(null);
      return;
    }
    onCommentsChange(
      upsertComment(
        comments,
        makeComment({
          path,
          side: a.side,
          line: a.line,
          intent,
          text,
          anchor: line.text,
        }),
      ),
    );
    setEditing(null);
  };

  return (
    <div className="hunks">
      {parsed.warnings.length > 0 && (
        <p className="diff-warning">解析提示：{parsed.warnings.join('；')}</p>
      )}
      {parsed.hunks.map((h, i) => (
        <div key={i} className="hunk">
          <div className="hunk-header">{h.header}</div>
          {splitMode ? (
            <SplitHunk
              lines={h.lines}
              path={path}
              canComment={canComment}
              comments={comments}
              onCommentsChange={onCommentsChange}
              onOpenInEditor={onOpenInEditor}
            />
          ) : (
            <div className="hunk-lines">
              {h.lines.map((l, j) => (
                <div key={j} className="diff-line-row">
                  <div className={`diff-line line-${l.kind}`}>
                    <span className="line-no">{l.oldLine ?? ''}</span>
                    <span className="line-no">{l.newLine ?? ''}</span>
                    <span className="line-sign">
                      {l.kind === 'added' ? '+' : l.kind === 'removed' ? '-' : ' '}
                    </span>
                    <span className="line-text">{l.text}</span>
                    {/* 行交互：评论与跳行。都放在行尾，避免遮挡代码首字符 */}
                    <span className="line-tools">
                      {onOpenInEditor && l.newLine !== null && (
                        <button
                          className="line-tool"
                          title={`在编辑器中打开第 ${l.newLine} 行`}
                          aria-label="在编辑器中打开此行"
                          onClick={() => onOpenInEditor(path, l.newLine ?? undefined)}
                        >
                          <Icon name="edit" size={10} />
                        </button>
                      )}
                      {canComment && (
                        <button
                          className={`line-tool ${findComment(keyOf(l, path)) ? 'is-active' : ''}`}
                          title="对此行添加评论"
                          aria-label="对此行添加评论"
                          onClick={() => {
                            const k = keyOf(l, path);
                            setEditing(editing === k ? null : k);
                          }}
                        >
                          <Icon name="chat" size={10} />
                        </button>
                      )}
                    </span>
                  </div>
                  {canComment && findComment(keyOf(l, path)) && (
                    <InlineComment
                      comment={findComment(keyOf(l, path))!}
                      editing={editing === keyOf(l, path)}
                      onEdit={() => setEditing(keyOf(l, path))}
                      onCancel={() => setEditing(null)}
                      onCommit={(intent, text) => commit(l, intent, text)}
                    />
                  )}
                  {canComment && editing === keyOf(l, path) && !findComment(keyOf(l, path)) && (
                    <CommentEditor
                      initial=""
                      initialIntent="change"
                      onCancel={() => setEditing(null)}
                      onCommit={(intent, text) => commit(l, intent, text)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** 行的评论键（同一行只有一条评论）。 */
function keyOf(l: DiffLine, path: string): string {
  const a = anchorOf(l);
  return a ? commentKey(path, a.side, a.line) : '';
}

/**
 * 已有评论的展示（只读态）。
 *
 * 点击进入编辑而不是直接可改：折叠区里的输入框会随滚动跑掉焦点，
 * 而评论文本是用户敲了半天的东西，误触清空代价很高。
 */
function InlineComment({
  comment,
  editing,
  onEdit,
  onCancel,
  onCommit,
}: {
  comment: ReviewComment;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onCommit: (intent: CommentIntent, text: string) => void;
}) {
  if (editing) {
    return (
      <CommentEditor
        initial={comment.text}
        initialIntent={comment.intent}
        onCancel={onCancel}
        onCommit={onCommit}
      />
    );
  }
  return (
    <div className={`inline-comment intent-${comment.intent}`}>
      <span className={`intent-badge ${comment.intent}`}>{intentLabel(comment.intent)}</span>
      <button className="inline-comment-text" onClick={onEdit} title="点击编辑">
        {comment.text}
      </button>
      <button
        className="inline-comment-del"
        title="删除这条评论"
        aria-label="删除评论"
        onClick={() => onCommit(comment.intent, '')}
      >
        <Icon name="close" size={10} />
      </button>
    </div>
  );
}

/**
 * 评论编辑器。
 *
 * 意图（仅上下文 / 要改）用两个互斥按钮而不是下拉：这是**必须选对**的
 * 一项，选错的后果是模型改了不该改的代码。两个可见的单选按钮比藏在
 * 下拉里的选项更不容易漏选（默认值为「要改」，与用户点评论的初衷一致）。
 */
function CommentEditor({
  initial,
  initialIntent,
  onCancel,
  onCommit,
}: {
  initial: string;
  initialIntent: CommentIntent;
  onCancel: () => void;
  onCommit: (intent: CommentIntent, text: string) => void;
}) {
  const [text, setText] = useState(initial);
  const [intent, setIntent] = useState<CommentIntent>(initialIntent);

  return (
    <div className="comment-editor">
      <div className="intent-switch" role="radiogroup" aria-label="评论意图">
        <button
          role="radio"
          aria-checked={intent === 'change'}
          className={`intent-opt ${intent === 'change' ? 'is-on' : ''}`}
          onClick={() => setIntent('change')}
          title="要求模型修改这一行"
        >
          要改
        </button>
        <button
          role="radio"
          aria-checked={intent === 'context'}
          className={`intent-opt ${intent === 'context' ? 'is-on' : ''}`}
          onClick={() => setIntent('context')}
          title="只是说明这一行，请模型不要改动"
        >
          仅上下文
        </button>
      </div>
      <textarea
        autoFocus
        rows={2}
        className="comment-input"
        value={text}
        placeholder={intent === 'change' ? '要改成什么？' : '补充说明（不会改动代码）'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter 提交，Esc 取消。普通 Enter 留给换行——
          // 评论常常是多行的（贴一段期望的代码）。
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onCommit(intent, text);
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="comment-actions">
        <button className="btn btn-mini" onClick={() => onCommit(intent, text)}>
          {text.trim() === '' ? '删除' : '保存'}
        </button>
        <button className="btn btn-mini btn-ghost" onClick={onCancel}>
          取消
        </button>
        <span className="comment-hint">⌘↩ 保存</span>
      </div>
    </div>
  );
}

function SplitHunk({
  lines,
  path,
  canComment,
  comments,
  onCommentsChange,
  onOpenInEditor,
}: {
  lines: ParsedDiff['hunks'][number]['lines'];
  path: string;
  canComment: boolean;
  comments: ReviewComment[];
  onCommentsChange?: (next: ReviewComment[]) => void;
  onOpenInEditor?: (path: string, line?: number) => void;
}) {
  /** 并排视图里的评论编辑器：键与统一视图一致，避免切换视图后评论对不上。 */
  const [editing, setEditing] = useState<string | null>(null);
  const findComment = (key: string) => comments.find((c) => c.id === key);

  const commit = (line: DiffLine, intent: CommentIntent, text: string) => {
    if (!onCommentsChange) return;
    const a = anchorOf(line);
    if (!a) return;
    if (text.trim() === '') {
      onCommentsChange(removeComment(comments, commentKey(path, a.side, a.line)));
      setEditing(null);
      return;
    }
    onCommentsChange(
      upsertComment(
        comments,
        makeComment({ path, side: a.side, line: a.line, intent, text, anchor: line.text }),
      ),
    );
    setEditing(null);
  };

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
      {rows.map((r, i) => {
        // 评论只挂在「有行号的那一侧」：并排时上下文行两侧同一个对象，
        // 挂两次会产生两条内容相同的评论。
        const anchorLine = r.right ?? r.left;
        const key = anchorLine ? keyOf(anchorLine, path) : '';
        const existing = key ? findComment(key) : undefined;
        return (
          <div key={i} className="split-row-wrap">
            <div className="split-row">
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
                {canComment && anchorLine && (
                  <span className="line-tools">
                    {onOpenInEditor && anchorLine.newLine !== null && (
                      <button
                        className="line-tool"
                        title={`在编辑器中打开第 ${anchorLine.newLine} 行`}
                        aria-label="在编辑器中打开此行"
                        onClick={() => onOpenInEditor(path, anchorLine.newLine ?? undefined)}
                      >
                        <Icon name="edit" size={10} />
                      </button>
                    )}
                    <button
                      className={`line-tool ${existing ? 'is-active' : ''}`}
                      title="对此行添加评论"
                      aria-label="对此行添加评论"
                      onClick={() => setEditing(editing === key ? null : key)}
                    >
                      <Icon name="chat" size={10} />
                    </button>
                  </span>
                )}
              </div>
            </div>
            {canComment && existing && (
              <InlineComment
                comment={existing}
                editing={editing === key}
                onEdit={() => setEditing(key)}
                onCancel={() => setEditing(null)}
                onCommit={(intent, text) => commit(anchorLine!, intent, text)}
              />
            )}
            {canComment && anchorLine && editing === key && !existing && (
              <CommentEditor
                initial=""
                initialIntent="change"
                onCancel={() => setEditing(null)}
                onCommit={(intent, text) => commit(anchorLine!, intent, text)}
              />
            )}
          </div>
        );
      })}
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

