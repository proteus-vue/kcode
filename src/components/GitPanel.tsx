/**
 * Git 工具面板。对齐 Codex 右栏：
 *
 * ```
 * ┌─────────────────────────┐
 * │ Git 工具          ···   │
 * ├─────────────────────────┤
 * │ 更改              +1 −1 │
 * │ ⑂ main ▾                │
 * │ ⇅ 提交或推送             │
 * └─────────────────────────┘
 * ```
 *
 * # 数据来源
 *
 * 协议**不提供任何 git 能力**，这个面板是客户端自研的（`kcode-bridge/src/git.rs`
 * 调 git CLI）。Codex 桌面端同理——它的 Git 工具也是自己的实现。
 *
 * # 推送必须二次确认
 *
 * 提交是本地操作，推送是**网络操作**。项目的零静默外发约束要求：
 * 出站动作必须让用户看到目标。因此推送前弹确认框，明确显示
 * 「推送到 <remote>/<branch>」，而不是点一下就发出去。
 */
import { useState } from 'react';
import { extractErrorMessage } from '../stores/useKcode';
import type { GitStatus } from '../types/domain';
import { Icon } from './Icon';

export function GitPanel({
  git,
  remote,
  onRefresh,
  onCommit,
  onPush,
}: {
  git: GitStatus | null;
  /** 默认 remote 名，用于推送确认文案。 */
  remote: string | null;
  onRefresh: () => void;
  onCommit: (message: string) => Promise<void>;
  onPush: () => Promise<void>;
}) {
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmPush, setConfirmPush] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!git) {
    return (
      <div className="panel">
        <div className="panel-head">
          <Icon name="branch" size={13} />
          <span>Git 工具</span>
        </div>
        <p className="panel-empty">正在读取仓库状态…</p>
      </div>
    );
  }

  if (!git.isRepo) {
    return (
      <div className="panel">
        <div className="panel-head">
          <Icon name="branch" size={13} />
          <span>Git 工具</span>
        </div>
        <p className="panel-empty">当前工作区不是 Git 仓库</p>
      </div>
    );
  }

  const changed = git.staged + git.modified + git.untracked + git.conflicted;
  const canCommit = changed > 0 && message.trim().length > 0 && !busy;
  const canPush = git.ahead > 0 && !busy;

  const doCommit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCommit(message.trim());
      setMessage('');
      setComposing(false);
      onRefresh();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const doPush = async () => {
    setBusy(true);
    setError(null);
    setConfirmPush(false);
    try {
      await onPush();
      onRefresh();
    } catch (e) {
      setError(extractErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="branch" size={13} />
        <span>Git 工具</span>
        <button className="mini-btn" onClick={onRefresh} title="重新读取">
          刷新
        </button>
      </div>

      <div className="git-row static" title={git.root ?? ''}>
        <span className="git-label">更改</span>
        {changed > 0 && (
          <span className="git-stat">
            <span className="add">+{git.staged + git.modified}</span>
            {git.untracked > 0 && <span className="dim">{git.untracked}?</span>}
            {git.conflicted > 0 && <span className="del">{git.conflicted}!</span>}
          </span>
        )}
        {changed === 0 && <span className="dim">无</span>}
      </div>

      <div className="git-row static" title={git.root ?? ''}>
        <Icon name="branch" size={12} />
        <span className="git-branch">{git.branch ?? 'HEAD 分离'}</span>
        {(git.ahead > 0 || git.behind > 0) && (
          <span className="git-stat dim">
            ↑{git.ahead} ↓{git.behind}
          </span>
        )}
      </div>

      {/* 提交：需要信息才可用 */}
      {composing ? (
        <div className="git-commit-box">
          <textarea
            autoFocus
            value={message}
            placeholder="提交信息（必需）"
            rows={2}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) {
                e.preventDefault();
                void doCommit();
              }
              if (e.key === 'Escape') {
                setComposing(false);
                setMessage('');
              }
            }}
          />
          <div className="git-commit-actions">
            <button className="btn-mini" disabled={!canCommit} onClick={() => void doCommit()}>
              {busy ? '提交中…' : '提交全部'}
            </button>
            <button
              className="btn-mini btn-ghost"
              onClick={() => {
                setComposing(false);
                setMessage('');
              }}
            >
              取消
            </button>
          </div>
          <p className="git-hint">将暂存全部改动后提交。逐文件挑选请在「变更审阅」中进行。</p>
        </div>
      ) : (
        <button
          className="git-row"
          disabled={changed === 0 || busy}
          onClick={() => setComposing(true)}
          title={changed === 0 ? '没有可提交的改动' : '提交全部改动'}
        >
          <Icon name="check" size={12} />
          <span className="git-label">提交</span>
          {changed > 0 && <span className="git-stat dim">{changed} 项</span>}
        </button>
      )}

      {/* 推送：网络操作，必须确认目标 */}
      {confirmPush ? (
        <div className="git-commit-box">
          <p className="git-confirm">
            推送到 <strong>{remote ?? '未知 remote'}</strong> / {git.branch ?? 'HEAD'}？
          </p>
          <div className="git-commit-actions">
            <button className="btn-mini" disabled={busy} onClick={() => void doPush()}>
              {busy ? '推送中…' : '确认推送'}
            </button>
            <button className="btn-mini btn-ghost" onClick={() => setConfirmPush(false)}>
              取消
            </button>
          </div>
          <p className="git-hint">这是网络操作，会把本地提交发送到上述远程仓库。</p>
        </div>
      ) : (
        <button
          className="git-row"
          disabled={!canPush}
          onClick={() => setConfirmPush(true)}
          title={
            !remote
              ? '未配置 remote'
              : git.ahead === 0
                ? '没有待推送的提交'
                : `推送到 ${remote}`
          }
        >
          <Icon name="send" size={12} />
          <span className="git-label">推送</span>
          {git.ahead > 0 && <span className="git-stat dim">↑{git.ahead}</span>}
          {!remote && <span className="chip">无 remote</span>}
        </button>
      )}

      {error && <p className="git-error">{error}</p>}
    </div>
  );
}
