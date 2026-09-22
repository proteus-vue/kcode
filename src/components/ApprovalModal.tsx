/**
 * 审批弹窗——安全模型的核心界面。
 *
 * # 五个必答问题（方案 3.4 节）
 *
 * 做什么 / 为什么 / 在哪里 / 影响多大 / 如何决策。缺任何一项，
 * 用户都只能凭感觉点「允许」，审批就退化成形式。
 *
 * # 两个必须做对的地方
 *
 * 1. **`decline` 与 `cancel` 是两个按钮，文案必须不同。** 实测确认两者都
 *    阻止命令执行，但 `cancel` 会中断整个 Turn。若共用一个「拒绝」，
 *    用户无法预知自己的选择会不会终止整个任务。
 * 2. **风险分级必须展示来源。** 协议不提供风险字段，等级是客户端推断的；
 *    若只显示「高风险」而不给理由，用户无法判断该不该信这个判断。
 *
 * # AP-07 作用域
 *
 * 协议决策只有 accept / acceptForSession / decline / cancel。
 * 「仅本次 / 本会话」是作用域选择器：once→accept，session→acceptForSession。
 * turn/project 是领域层预留粒度，协议未暴露独立字段，UI 不提供假选项。
 */

import { useState } from 'react';
import type { Approval, ApprovalDecision, ApprovalScope } from '../types/domain';
import { decisionForScope, decisionLabel, describeSignal, isBlockingRisk } from '../stores/store';

interface Props {
  approval: Approval;
  onDecide: (requestId: string, decision: ApprovalDecision, scope?: string) => void;
}

const TIER_CLASS: Record<string, string> = {
  low: 'tier-low',
  moderate: 'tier-moderate',
  high: 'tier-high',
  critical: 'tier-critical',
};

const TIER_LABEL: Record<string, string> = {
  low: '低风险',
  moderate: '中风险',
  high: '高风险',
  critical: '严重风险',
};

/** 简单的敏感值掩码。审批视图默认脱敏（方案 6.1 第 8 条）。 */
export function redact(text: string): string {
  return text
    // 环境变量赋值：KEY=value → KEY=***
    .replace(/\b([A-Z][A-Z0-9_]{2,})=(\S+)/g, '$1=***')
    // 常见 token / key 形态
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, 'sk-***')
    .replace(/\b(ghp_[A-Za-z0-9]{10,})/g, 'ghp_***')
    .replace(/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.?[A-Za-z0-9_-]*)/g, 'jwt_***')
    // Authorization 头
    .replace(/(Authorization:\s*)(\S+)/gi, '$1***')
    // 私钥块
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '-----PRIVATE KEY (已隐藏)-----');
}

export function ApprovalModal({ approval, onDecide }: Props) {
  const blocking = isBlockingRisk(approval.risk.tier);
  const [scope, setScope] = useState<ApprovalScope>('once');

  return (
    <div className="approval-backdrop" role="dialog" aria-modal="true" aria-label="需要审批">
      <div className={`approval-modal ${blocking ? 'is-blocking' : ''}`}>
        <header className="approval-header">
          <span className={`risk-badge ${TIER_CLASS[approval.risk.tier] ?? ''}`}>
            {TIER_LABEL[approval.risk.tier] ?? approval.risk.tier}
          </span>
          <h2>需要你的批准</h2>
        </header>

        {/* 做什么 */}
        <section className="approval-section">
          <h3>做什么</h3>
          <pre className="approval-command">{redact(approval.summary)}</pre>
        </section>

        {/* 为什么 */}
        {approval.reason && (
          <section className="approval-section">
            <h3>为什么</h3>
            <p className="approval-reason">{redact(approval.reason)}</p>
            <p className="approval-note">
              原因由 Agent 自述，<strong>不作为风险判断的依据</strong>。
            </p>
          </section>
        )}

        {/* 在哪里：工作目录 + thread/turn/item 调用链（AP-08 可追溯） */}
        <section className="approval-section">
          <h3>在哪里</h3>
          <dl className="approval-paths">
            {approval.cwd && (
              <>
                <dt>工作目录</dt>
                <dd>{approval.cwd}</dd>
              </>
            )}
            <dt>线程 / 轮次 / 条目</dt>
            <dd className="mono-small">
              {approval.threadId} / {approval.turnId} / {approval.itemId}
            </dd>
            {approval.method && (
              <>
                <dt>协议方法</dt>
                <dd className="mono-small">{approval.method}</dd>
              </>
            )}
          </dl>
        </section>

        {/* 影响多大 */}
        <section className="approval-section">
          <h3>影响多大</h3>
          {approval.risk.signals.length > 0 ? (
            <ul className="risk-signals">
              {approval.risk.signals.map((s, i) => (
                <li key={i}>{describeSignal(s)}</li>
              ))}
            </ul>
          ) : (
            <p className="approval-note">未识别出具体风险信号。</p>
          )}
          <p className="approval-note">
            风险等级由客户端推断（协议不提供该字段），仅用于提示与排序，
            <strong>不构成放行依据</strong>。真正的边界来自沙箱与可写根配置。
          </p>
        </section>

        {/* 如何决策：作用域 + 允许 / 拒绝 / 拒绝并停止 */}
        <footer className="approval-actions">
          <div className="approval-scope" role="radiogroup" aria-label="允许范围">
            <button
              role="radio"
              aria-checked={scope === 'once'}
              className={`scope-btn ${scope === 'once' ? 'is-active' : ''}`}
              onClick={() => setScope('once')}
              title="只放行这一次（协议 accept）"
            >
              仅本次
            </button>
            <button
              role="radio"
              aria-checked={scope === 'session'}
              className={`scope-btn ${scope === 'session' ? 'is-active' : ''}`}
              onClick={() => setScope('session')}
              title="本会话内同类请求不再询问（协议 acceptForSession）"
            >
              本会话
            </button>
          </div>

          <button
            className="btn btn-primary"
            onClick={() => onDecide(approval.requestId, decisionForScope(scope), scope)}
          >
            {decisionLabel(decisionForScope(scope))}
          </button>

          {/* decline 与 cancel 必须分开：后者会中断整个 Turn */}
          <button
            className="btn btn-ghost"
            onClick={() => onDecide(approval.requestId, 'decline')}
            title="拒绝本次操作，Agent 将继续执行轮次的其余部分"
          >
            {decisionLabel('decline')}
          </button>

          <button
            className="btn btn-danger"
            onClick={() => onDecide(approval.requestId, 'cancel')}
            title="拒绝本次操作，并立即中断整个轮次"
          >
            {decisionLabel('cancel')}
          </button>
        </footer>

        <p className="approval-hint">
          「{decisionLabel('decline')}」与「{decisionLabel('cancel')}」都不会执行该操作；
          区别是后者会一并停止当前轮次。
        </p>
      </div>
    </div>
  );
}
