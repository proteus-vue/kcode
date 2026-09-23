/**
 * 一个轮次的时间线。
 *
 * 展示状态由 store 派生：`awaiting_approval` 不是协议状态，
 * 而是「进行中 + 存在待决审批」推导出来的。
 */
import { useState } from 'react';
import type { RootState } from '../stores/store';
import type { Item } from '../types/domain';
import {
  fileStats,
  findThreadIdOf,
  isStreaming,
  streamedTextOf,
  turnDisplayStatus,
} from '../stores/store';
import { Icon } from './Icon';
import { ItemCard } from './ItemCard';
import { Markdown } from './Markdown';
import { ToolGroupRow } from './ToolGroupRow';
import { groupTimeline } from './toolGrouping';
import { formatDuration } from './duration';

/** 流式缓冲的轻量渲染：内容尚在变化，用 Markdown 但标记为流式中。 */
function MarkdownLite({ text }: { text: string }) {
  return <Markdown>{text}</Markdown>;
}

/**
 * 非正常终态的文案。
 *
 * **`completed` 刻意不在表里**：它是默认状态，每轮都挂一个「已完成」
 * 等于给时间线加了一层无信息量的标签（与工具行弱化是同一个判断）。
 * 只有需要用户注意的终态才留标记。
 */
const OUTCOME_LABEL: Record<string, string> = {
  interrupted: '已中断',
  failed: '失败',
  unknown: '结果未知',
};

export function TurnView({
  state,
  threadId,
  turnId,
  onOpenFile,
}: {
  state: RootState;
  threadId: string;
  turnId: string;
  /** 点击文件路径时在右栏打开详情。 */
  onOpenFile?: (path: string) => void;
}) {
  const thread = state.threads[threadId];
  const turn = thread?.turns[turnId];
  if (!turn) return null;

  const display = turnDisplayStatus(state, threadId, turnId);
  const items = turn.itemIds.map((id) => thread.items[id]).filter(Boolean);

  /** 本轮是否有工具行正在跑（决定 activity 指示是否重复）。 */
  const hasRunningTool = items.some((it) => {
    const b = it.body;
    if (b.kind === 'commandExecution') return b.status === 'inProgress';
    if (b.kind === 'collabAgent') {
      return b.status === 'inProgress' || b.agents.some((a) => a.status === 'running');
    }
    return false;
  });

  /** 已结束的轮次才显示耗时（进行中时协议还没给出这个值）。 */
  const isFinished = display !== 'running' && display !== 'awaiting_approval';

  return (
    <div
      className={`turn ${display === 'awaiting_approval' ? 'is-awaiting' : ''}`}
      // 导航条据此定位与跳转。用属性而非 ref：导航条只需要极少数几个
      // 元素的位置（点击时算一次），不值得为每个轮次维护一个 ref。
      data-turn-id={turnId}
    >
      <div className="turn-items">
        {/* 连续同类工具调用聚合折叠：一轮里常连做十几个小动作，
            逐个占一行会把时间线撑满，模型结论被推到很下面。
            分组规则见 toolGrouping.ts 的头部说明。 */}
        {groupTimeline(items).map((unit) =>
          unit.type === 'group' ? (
            <ToolGroupRow
              key={`g-${unit.members[0].item.id}`}
              group={unit}
              onOpenFile={onOpenFile}
            />
          ) : (
            <ItemCard
              onOpenFile={onOpenFile}
              key={unit.item.id}
              item={unit.item}
              streamedText={streamedTextOf(state, unit.item)}
              streaming={isStreaming(state, unit.item)}
            />
          ),
        )}
        {/* 尚未产生 Item 但已有流式内容时，仍需显示——否则开头几秒是空白的。
            **必须同时排除属于其他轮次的内容**：只判 `!turn.itemIds.includes(id)`
            的话，新轮次的流式内容会出现在**每一个**历史轮次下面——
            用户看到已完成的对话跟着下面的新对话一起更新，
            而且旧轮次看起来也在「运行中」。这是真实出现过的错乱。 */}
        {(() => {
          const tid = findThreadIdOf(state, threadId);
          if (!tid) return null;
          const th = state.threads[tid];
          if (!th) return null;
          // 全线程已归位的 item：出现在任意轮次里都算已归位
          const placed = new Set<string>();
          for (const t of th.turnOrder) {
            for (const id of th.turns[t]?.itemIds ?? []) placed.add(id);
          }
          // 归属用 streamTurn 精确判断（协议增量里带了 turnId）。
          // 只判 `!placed.has(id)` 不够——那样新轮次的流式内容会出现在
          // 每一个历史轮次下面。
          const pending = Object.entries(th.streamBuffer).filter(
            ([id]) => !placed.has(id) && th.streamTurn[id] === turnId,
          );
          if (pending.length === 0) return null;
          return pending.map(([id, text]) => (
            <div key={id} className="bubble agent is-streaming">
              <div className="bubble-inner">
                <MarkdownLite text={text} />
              </div>
            </div>
          ));
        })()}

        {/* 状态标记放在**内容之后**。
            此前它在内容之前（turn-head），于是「运行中」出现在用户消息
            上方——读起来像在描述那条消息，而它描述的其实是「内容还在生成」，
            语义上属于内容的尾部。参照客户端也是尾部转圈。 */}

        {/* 进行中：一个转圈 + 极简文案。
            **有工具行在跑时不重复显示**——工具行自身已经写着「正在执行」
            并带扫光，这里再加一行「正在处理」是同一件事说两遍，
            而它用的是最弱的色（--t4），用户既看不见也没信息量。
            只有"没有任何工具行在跑"时它才是唯一的活动指示（模型正在生成文字），
            此时必须显示——否则界面看起来像卡住了。
            `awaiting_approval` 例外：那是在等人，与工具有没有在跑无关。 */}
        {(display === 'running' || display === 'awaiting_approval') &&
          (display === 'awaiting_approval' || !hasRunningTool) && (
            <div className={`turn-progress ${display === 'awaiting_approval' ? 'is-awaiting' : ''}`}>
              <span className="spinner" />
              <span>{display === 'awaiting_approval' ? '等待你批准' : '正在处理'}</span>
            </div>
          )}

        {/* 轮次收尾：整轮耗时 + 可展开的工作详情。
            耗时来自协议的 `Turn.durationMs`（后端原样带出，不在前端计时）。
            协议未提供时不显示——**不编一个数字出来**。 */}
        {isFinished && turn.durationMs !== null && (
          <TurnFooter durationMs={turn.durationMs} items={items} onOpenFile={onOpenFile} />
        )}

        {/* 非正常终态：必须留可见标记，不静默。
            completed 不在此列——它是默认状态，无需标注。 */}
        {OUTCOME_LABEL[display] && (
          <>
            <div className={`turn-outcome is-${display}`}>
              {OUTCOME_LABEL[display]}
            </div>
            {display === 'unknown' && (
              <p className="unknown-note">
                Agent 进程已退出，无法确定该轮次的真实结果。请核对工作区状态后再继续——
                不要假定它成功或失败。
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * 轮次收尾行：`已处理 6s  ⌄`。
 *
 * 默认只显示时长，点开才是这一轮做了什么（各类动作计数 + 文件变更）。
 * 这样做的理由与工具行一致：**时长是扫一眼的信息，明细是按需的信息**。
 * 直接把几十行工具调用铺在这里等于把时间线再加长一倍。
 */
function TurnFooter({
  durationMs,
  items,
  onOpenFile,
}: {
  durationMs: number;
  items: Item[];
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const detail = turnDetail(items);
  const hasDetail = detail.stats.length > 0 || detail.files.length > 0;

  return (
    <div className="turn-footer">
      <button
        className="turn-footer-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!hasDetail}
        title={hasDetail ? '展开查看本轮工作详情' : undefined}
      >
        <Icon name="clock" size={11} />
        <span className="turn-footer-time">已处理 {formatDuration(durationMs)}</span>
        {hasDetail && (
          <span className={`turn-footer-chevron ${open ? 'open' : ''}`}>
            <Icon name="chevron" size={10} />
          </span>
        )}
      </button>

      {open && hasDetail && (
        <div className="turn-detail">
          {detail.stats.length > 0 && (
            <ul className="turn-detail-stats">
              {detail.stats.map((s) => (
                <li key={s.label}>
                  <span className="turn-detail-num">{s.count}</span>
                  <span className="turn-detail-label">{s.label}</span>
                </li>
              ))}
            </ul>
          )}
          {detail.files.length > 0 && (
            <ul className="turn-detail-files">
              {detail.files.map((f) => (
                <li key={f.path}>
                  {onOpenFile ? (
                    <button
                      className="turn-detail-file"
                      onClick={() => onOpenFile(f.path)}
                      title={f.path}
                    >
                      <Icon name="file" size={10} />
                      <span className="mono">{f.path.split('/').pop()}</span>
                      {f.added > 0 && <span className="add">+{f.added}</span>}
                      {f.removed > 0 && <span className="del">−{f.removed}</span>}
                    </button>
                  ) : (
                    <span className="turn-detail-file">
                      <Icon name="file" size={10} />
                      <span className="mono">{f.path.split('/').pop()}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** 本轮工作明细的纯函数计算（可测：计数错了不会报错，只会显示错数字）。 */
export function turnDetail(items: Item[]): {
  stats: { label: string; count: number }[];
  files: { path: string; added: number; removed: number }[];
} {
  let commands = 0;
  let reads = 0;
  let searches = 0;
  let agents = 0;
  const files = new Map<string, { path: string; added: number; removed: number }>();

  for (const it of items) {
    const b = it.body;
    switch (b.kind) {
      case 'commandExecution':
        // 被拒绝的命令不计入"执行了 N 条"——它并没有执行
        if (b.status !== 'declined') commands += 1;
        break;
      case 'imageView':
        reads += 1;
        break;
      case 'webSearch':
        searches += 1;
        break;
      case 'collabAgent':
        if (b.source === 'collabAgentToolCall' && b.tool === 'spawnAgent') {
          agents += Math.max(1, b.receiverThreadIds.length);
        }
        break;
      case 'fileChange':
        for (const c of b.changes) {
          const prev = files.get(c.path);
          const st = fileStats(c);
          files.set(c.path, {
            path: c.path,
            added: (prev?.added ?? 0) + st.added,
            removed: (prev?.removed ?? 0) + st.removed,
          });
        }
        break;
      default:
        break;
    }
  }

  const stats = [
    { label: '条命令', count: commands },
    { label: '个文件读取', count: reads },
    { label: '次搜索', count: searches },
    { label: '个子代理', count: agents },
  ].filter((s) => s.count > 0);

  return { stats, files: [...files.values()] };
}
