/**
 * 进程面板：当前轮次的进度与步骤清单。
 *
 * 成熟客户端的右侧面板让用户随时回答「Agent 现在做到哪一步了」——
 * 这对长任务尤其重要：没有它，用户只能盯着流式文字猜进度。
 */
import type { RootState } from '../stores/store';
import { isDeclined, turnDisplayStatus } from '../stores/store';
import { CollapsiblePanel } from './CollapsiblePanel';
import { Icon } from './Icon';

export const STATUS_LABEL: Record<string, string> = {
  running: '进行中',
  awaiting_approval: '等待审批',
  completed: '已完成',
  interrupted: '已中断',
  failed: '失败',
  unknown: '状态未知',
};

/** 从 Item 提取一行步骤描述。 */
export function stepLabel(body: { kind: string; [k: string]: unknown }): string {
  switch (body.kind) {
    case 'commandExecution': {
      const cmd = String(body.command ?? '');
      return cmd.replace(/\s*\n\s*/g, ' ').slice(0, 70);
    }
    case 'fileChange': {
      const changes = (body.changes ?? []) as { path: string }[];
      return changes.map((c) => c.path.split('/').pop()).join('、') || '文件变更';
    }
    case 'toolCall':
      return `${body.server ?? ''}${body.server ? ' / ' : ''}${body.tool ?? ''}`;
    case 'webSearch':
      return String(body.query ?? '');
    case 'agentMessage':
      return String(body.text ?? '').replace(/\s+/g, ' ').slice(0, 70);
    case 'plan':
      return '计划';
    default:
      return body.kind;
  }
}

export function stepIcon(kind: string) {
  switch (kind) {
    case 'commandExecution':
      return <Icon name="terminal" size={12} />;
    case 'fileChange':
      return <Icon name="edit" size={12} />;
    case 'toolCall':
      return <Icon name="layers" size={12} />;
    case 'webSearch':
      return <Icon name="search" size={12} />;
    default:
      return <Icon name="dot" size={12} />;
  }
}

export function ProcessPanel({
  state,
  threadId,
  onOpenFile,
}: {
  state: RootState;
  threadId: string;
  /** 点击步骤里的文件时在右栏打开详情。 */
  onOpenFile?: (path: string) => void;
}) {
  const thread = state.threads[threadId];
  if (!thread) return null;

  // 取最近一个轮次作为「当前进程」
  const turnId = thread.turnOrder[thread.turnOrder.length - 1];
  const turn = turnId ? thread.turns[turnId] : undefined;
  if (!turnId || !turn) {
    return (
      <CollapsiblePanel
        title="状态"
        icon={<Icon name="cpu" size={13} />}
        summary="尚无执行记录"
      >
        <p className="panel-empty">尚无执行记录</p>
      </CollapsiblePanel>
    );
  }

  const display = turnDisplayStatus(state, threadId, turnId);
  const items = turn.itemIds.map((id) => thread.items[id]).filter(Boolean);
  // 只统计「动作类」步骤，消息不计入
  const steps = items.filter((i) =>
    ['commandExecution', 'fileChange', 'toolCall', 'webSearch'].includes(i.body.kind),
  );
  const done = steps.filter((s) => {
    const b = s.body as { status?: string };
    return b.status === 'completed' || b.status === 'failed' || b.status === 'declined';
  }).length;
  const declinedCount = steps.filter((s) => isDeclined(s)).length;
  const pct = steps.length > 0 ? Math.round((done / steps.length) * 100) : 0;

  // 折叠后胶囊上的读数：最后一步的描述。用户据此判断「有没有新动静」，
  // 而不必展开面板——这正是折叠态存在的意义。
  const lastStep = steps[steps.length - 1];
  const summary = lastStep
    ? stepLabel(lastStep.body as never)
    : display === 'completed'
      ? '本轮已完成'
      : '等待中';

  return (
    <CollapsiblePanel
      title="状态"
      icon={<Icon name="cpu" size={13} />}
      status={
        <span className={`panel-status status-${display}`}>{STATUS_LABEL[display] ?? display}</span>
      }
      count={
        <span className="panel-count">
          {done}/{steps.length}
        </span>
      }
      summary={summary}
    >

      <div className="progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`progress-fill ${display === 'awaiting_approval' ? 'waiting' : ''}`} style={{ width: `${pct}%` }} />
      </div>

      {declinedCount > 0 && (
        <p className="panel-note">
          其中 {declinedCount} 项被你拒绝，未执行。
        </p>
      )}

      <div className="panel-section-title">已完成 {done} 项</div>
      <ol className="step-list">
        {steps.map((s) => {
          const b = s.body as { status?: string };
          const st = b.status ?? 'inProgress';
          return (
            <li key={s.id} className={`step step-${st}`}>
              <span className="step-icon">{stepIcon(s.body.kind)}</span>
              <span className="step-text">{stepLabel(s.body as never)}</span>
              {/* 文件变更步骤直接给出可点的文件——用户看到「改了哪个文件」
                  之后的第一反应就是点开看内容，不该逼他去别处找入口。 */}
              {onOpenFile &&
                s.body.kind === 'fileChange' &&
                ((s.body as { changes?: { path: string }[] }).changes ?? []).map((c) => (
                  <button
                    key={c.path}
                    className="step-file"
                    title={`在右栏查看 ${c.path}`}
                    onClick={() => onOpenFile(c.path)}
                  >
                    {c.path.split('/').pop()}
                  </button>
                ))}
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

      {steps.length === 0 && <p className="panel-empty">本轮尚无工具调用</p>}
    </CollapsiblePanel>
  );
}
