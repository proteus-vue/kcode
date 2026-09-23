/**
 * 右上角状态浮层。
 *
 * # 为什么浮在对话栏上而不是放进右栏
 *
 * 右栏是「内容」的地方（浏览器、文件详情、审批、diff）——纵向空间要
 * 尽量留给内容。而状态是**随时扫一眼**的信息：放到右栏就得在标签之间
 * 来回切，或者和内容争高度。浮在对话栏右上角同时满足两点：不占内容
 * 空间、始终可见；收起后只剩一行胶囊。
 *
 * # 各段只在真正有内容时出现
 *
 * 面板里堆着「更改 0」「尚无执行记录」这类占位行时，用户每次扫视都要
 * 先过滤掉它们——面板反而成了噪音源。所以：
 *
 * - **Git 工具**：有未提交改动或有待推送提交时才出现。仓库干净时
 *   没有需要在此处理的事。
 * - **进程**：本轮有工具调用步骤时才出现。
 * - **环境**：有活动线程时出现——它描述「这个任务在哪跑」，
 *   没有线程就没有指代对象。
 *
 * 三段都没有可展示内容时**整个浮层不渲染**，而不是显示一张空卡片。
 *
 * # 底部「智能体」常驻
 *
 * 它是结果的来源（模型与服务商），也是排查「为什么答得不对/这么慢」
 * 的第一手信息。没有它，用户无法区分「换了模型」和「同一模型变差了」。
 */
import { useState } from 'react';
import { extractErrorMessage } from '../stores/useKcode';
import { Icon } from './Icon';
import { STATUS_LABEL, stepIcon, stepLabel } from './ProcessPanel';
import { isDeclined, contextUsage, guardianSummary, turnDisplayStatus } from '../stores/store';
import { changedCount, dockSections } from './dockVisibility';
import type { RootState } from '../stores/store';
import type { GitStatus, PermissionMode } from '../types/domain';

/** 权限档位的中文名（与 PermissionPicker 保持一致）。 */
const MODE_LABEL: Record<PermissionMode, string> = {
  readOnly: '只读',
  workspaceWrite: '工作区可写',
  fullAccess: '完全访问权限',
};

/**
 * Git 段。
 *
 * 形态对齐参照：更改 / 分支 / 「提交或推送」一行。
 *
 * 把提交与推送合成一行入口是刻意的：分成两个并列按钮时，用户要先自己
 * 判断「我现在该提交还是推送」。而判断依据（有没有改动、有没有待推送
 * 提交）面板比用户清楚，所以入口只留一个，点开后再各自可用——
 * 有改动才显示提交框，有待推送才显示推送，不做成一排禁用按钮。
 */
function GitSection({
  git,
  remote,
  onRefresh,
  onCommit,
  onPush,
}: {
  git: GitStatus;
  remote: string | null;
  onRefresh: () => void;
  onCommit: (message: string) => Promise<void>;
  onPush: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmPush, setConfirmPush] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = git.staged + git.modified + git.untracked + git.conflicted;
  const canCommit = changed > 0 && message.trim().length > 0 && !busy;
  const canPush = git.ahead > 0 && !busy;

  const doCommit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onCommit(message.trim());
      setMessage('');
      setOpen(false);
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
    <div className="status-block">
      <div className="status-card-head">
        <Icon name="branch" size={13} />
        <span className="status-card-title">Git 工具</span>
        <button className="mini-btn status-card-refresh" onClick={onRefresh} title="重新读取">
          刷新
        </button>
      </div>

      <div className="git-row static" title={git.root ?? ''}>
        <span className="git-label">更改</span>
        <span className="git-stat">
          <span className="add">+{git.staged + git.modified}</span>
          {git.untracked > 0 && <span className="dim">{git.untracked}?</span>}
          {git.conflicted > 0 && <span className="del">{git.conflicted}!</span>}
        </span>
      </div>

      <div className="git-row static">
        <Icon name="branch" size={12} />
        <span className="git-branch">{git.branch ?? 'HEAD 分离'}</span>
        {(git.ahead > 0 || git.behind > 0) && (
          <span className="git-stat dim">
            ↑{git.ahead} ↓{git.behind}
          </span>
        )}
      </div>

      <button className="git-row" onClick={() => setOpen((v) => !v)} disabled={busy}>
        <Icon name="send" size={12} />
        <span className="git-label">提交或推送</span>
        {git.ahead > 0 && <span className="git-stat dim">↑{git.ahead}</span>}
      </button>

      {open && (
        <div className="git-commit-box">
          {changed > 0 && (
            <>
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
                    setOpen(false);
                    setMessage('');
                  }
                }}
              />
              <div className="git-commit-actions">
                <button className="btn-mini" disabled={!canCommit} onClick={() => void doCommit()}>
                  {busy ? '提交中…' : '提交全部'}
                </button>
              </div>
              <p className="git-hint">
                将暂存全部改动后提交。逐文件挑选请在「变更审阅」中进行。
              </p>
            </>
          )}

          {/* 推送是网络操作，必须确认目标 */}
          {confirmPush ? (
            <>
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
            </>
          ) : (
            <button className="git-row" disabled={!canPush} onClick={() => setConfirmPush(true)}>
              <Icon name="send" size={12} />
              <span className="git-label">推送</span>
              <span className="git-stat dim">
                {git.ahead > 0 ? `↑${git.ahead}` : remote ? '无待推送' : '无 remote'}
              </span>
            </button>
          )}

          {error && <p className="git-error">{error}</p>}
        </div>
      )}
    </div>
  );
}

export function StatusDock({
  state,
  threadId,
  projectName,
  git,
  gitRemote,
  onRefreshGit,
  onCommit,
  onPush,
  permissionMode,
  model,
  provider,
}: {
  state: RootState;
  threadId: string | null;
  projectName: string;
  git: GitStatus | null;
  gitRemote: string | null;
  onRefreshGit: () => void;
  onCommit: (message: string) => Promise<void>;
  onPush: () => Promise<void>;
  permissionMode: PermissionMode | null;
  /** 当前模型（来自 config 或用户选择）。 */
  model: string | null;
  provider: string | null;
}) {
  /**
   * 展开状态。
   *
   * `null` 表示「跟随自动判断」，不是「收起」——这个三态很关键：
   *
   * - 默认跟随：有轮次在跑就展开（那正是需要看进度的时候），
   *   空闲时收起（浮层遮住正文，没事时不该占着）。
   * - 用户点过之后，他的选择优先，不再被自动行为覆盖：
   *   否则跑任务时点「收起」会立刻弹回来，按钮看起来像坏了。
   */
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  const thread = threadId ? state.threads[threadId] : undefined;
  const turnId = thread?.turnOrder[thread.turnOrder.length - 1];
  const turn = turnId ? thread?.turns[turnId] : undefined;

  const display = thread && turnId ? turnDisplayStatus(state, thread.id, turnId) : null;
  const items = turn && thread ? turn.itemIds.map((id) => thread.items[id]).filter(Boolean) : [];
  // 只把「动作类」步骤算作进度：消息不是步骤
  const steps = items.filter((i) =>
    ['commandExecution', 'fileChange', 'toolCall', 'webSearch'].includes(i.body.kind),
  );
  const done = steps.filter((s) => {
    const b = s.body as { status?: string };
    return b.status === 'completed' || b.status === 'failed' || b.status === 'declined';
  }).length;
  const declinedCount = steps.filter((s) => isDeclined(s)).length;

  // 分段条件在 dockVisibility 里（带测试）。放在这里内联的话，
  // 「干净仓库不该显示 Git 段」这类规则只能靠特定数据组合手点验证。
  const usage = contextUsage(thread?.tokenUsage ?? null);
  const sections = dockSections({
    hasThread: Boolean(thread),
    git,
    stepCount: steps.length,
    contextRatio: usage?.ratio ?? null,
  });
  const { git: showGit, steps: showSteps, context: showContext, env: showEnv } = sections;
  const changed = changedCount(git);
  const guardian = guardianSummary(thread?.guardianWarnings ?? []);

  // 没有任何可展示内容 → 不渲染空卡片。
  // 例外：护栏警告本身就构成「可展示内容」——它可能在任何段都为空时到达。
  if (!sections.any && !guardian) return null;

  const lastStep = steps[steps.length - 1];
  const summary = lastStep ? stepLabel(lastStep.body as never) : '';
  const running = display === 'running' || display === 'awaiting_approval';
  // 护栏警告存在时强制展开：安全信号不能被收进胶囊里——
  // 用户收起了浮层却发生异常，那正是他最需要看到提示的时候。
  const expanded = guardian ? true : (userOpen ?? running);

  if (!expanded) {
    return (
      <div className="status-dock is-collapsed">
        {/* 整颗胶囊就是一个展开控件：图标表明动作，读数是内容。
            拆成「图标按钮 + 读数」两颗时，可点区域的语义反而更含糊。 */}
        <button
          className="capsule capsule-expand"
          onClick={() => setUserOpen(true)}
          title="展开状态"
        >
          <Icon name="expand" size={12} />
          {/* 读数优先给变化量：有未提交改动或有步骤推进时，
              那是最值得一眼看到的数字 */}
          {showGit && changed > 0 && <span className="capsule-count">+{changed}</span>}
          {showSteps && (
            <span className="capsule-count">
              {done}/{steps.length}
            </span>
          )}
          {showContext && usage && (
            <span className={`capsule-count is-${usage.level}`}>
              {Math.round(usage.ratio * 100)}%
            </span>
          )}
          <span className="capsule-summary">{summary || projectName}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="status-dock">
      <div className="status-card">
        {/* 收起控件固定在卡片右上角。
            原先放在底部通栏，问题是：它随卡片内容高度上下移动，
            用户抓不住位置；而且通栏大按钮的视觉重量远超它的作用——
            收起是个次要动作，不该占一行。 */}
        <button
          className="status-icon-btn"
          onClick={() => setUserOpen(false)}
          title="收起为胶囊"
          aria-label="收起为胶囊"
        >
          <Icon name="collapse" size={12} />
        </button>

        {/* 护栏警告：**置顶**渲染，不折叠进任何段。
            它是安全信号（上游刹车已介入），被随手的展开/收起藏起来
            就失去了意义；出现时必须在扫视的第一落点。 */}
        {guardian && (
          <div className="guardian-banner" role="alert">
            <Icon name="shield" size={13} />
            <div className="guardian-body">
              <span className="guardian-title">执行异常提醒</span>
              <span className="guardian-text">{guardian}</span>
              <span className="guardian-hint">
                这是上游 Agent 的循环检测提示，不是你的操作错误。可考虑停止当前轮次或换一种说法。
              </span>
            </div>
          </div>
        )}

        {showGit && git && (
          <GitSection
            git={git}
            remote={gitRemote}
            onRefresh={onRefreshGit}
            onCommit={onCommit}
            onPush={onPush}
          />
        )}

        {showSteps && (
          <div className="status-block">
            <div className="status-card-head">
              <Icon name="cpu" size={13} />
              <span className="status-card-title">进程</span>
              <span className="capsule-count">
                {done}/{steps.length}
              </span>
              {display && (
                <span className={`panel-status status-${display}`}>
                  {STATUS_LABEL[display] ?? display}
                </span>
              )}
            </div>

            <div className="status-card-body">
              <ol className="step-list">
                {steps.map((s) => {
                  const b = s.body as { status?: string };
                  const st = b.status ?? 'inProgress';
                  return (
                    <li key={s.id} className={`step step-${st}`}>
                      <span className="step-icon">{stepIcon(s.body.kind)}</span>
                      <span className="step-text">{stepLabel(s.body as never)}</span>
                      <span className="step-mark">
                        {st === 'declined' ? (
                          <span className="chip chip-declined">未执行</span>
                        ) : st === 'completed' ? (
                          <Icon name="check" size={12} />
                        ) : st === 'failed' ? (
                          <Icon name="close" size={12} />
                        ) : (
                          <span className="spinner" />
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>
              {declinedCount > 0 && (
                <p className="panel-note">其中 {declinedCount} 项被你拒绝，未执行。</p>
              )}
            </div>
          </div>
        )}

        {/* 上下文余量：只在接近上限时出现（阈值在 dockVisibility 里）。
            用一根细条表达比例——数字（如「78%」）需要心算才能判断
            严重程度，而长度是直接可读的。 */}
        {showContext && usage && (
          <div className="status-block">
            <div className="status-card-head">
              <Icon name="layers" size={13} />
              <span className="status-card-title">上下文</span>
              <span className={`context-pct is-${usage.level}`}>
                {Math.round(usage.ratio * 100)}%
              </span>
            </div>
            <div className="context-bar" title={`${usage.used} / ${usage.window} tokens`}>
              <span
                className={`context-fill is-${usage.level}`}
                style={{ width: `${Math.min(100, Math.round(usage.ratio * 100))}%` }}
              />
            </div>
            <p className="context-note">
              {usage.level === 'critical'
                ? '接近模型上限，建议开新会话或压缩上下文。'
                : '已用较多，再聊下去上游会自动压缩上下文。'}
              <span className="context-detail">
                {' '}
                剩约 {usage.remaining.toLocaleString()} / {usage.window.toLocaleString()}
              </span>
            </p>
          </div>
        )}

        {showEnv && (
          <div className="status-section">
            <dl className="status-kv">
              <dt>项目</dt>
              <dd title={git?.root ?? ''}>{projectName}</dd>
              {/* 分支在 Git 段已有，这里只有在 Git 段不显示时才补上——
                  同一信息在同一张卡片里出现两次是冗余 */}
              {!showGit && git?.isRepo && (
                <>
                  <dt>分支</dt>
                  <dd className="mono">{git.branch ?? 'HEAD 分离'}</dd>
                </>
              )}
              <dt>权限</dt>
              <dd className={permissionMode === 'fullAccess' ? 'is-danger' : ''}>
                {MODE_LABEL[permissionMode ?? 'workspaceWrite']}
              </dd>
            </dl>
          </div>
        )}

        {/* 来源：结果由谁产生（对应参照截图底部的「智能体」） */}
        <div className="status-card-foot">
          <span className="status-foot-label">智能体</span>
          <span className="status-foot-value mono">
            {model ?? '默认模型'}
            {provider && <span className="status-foot-provider"> · {provider}</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
