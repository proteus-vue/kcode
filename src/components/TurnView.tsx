/**
 * 一个轮次的时间线。
 *
 * 展示状态由 store 派生：`awaiting_approval` 不是协议状态，
 * 而是「进行中 + 存在待决审批」推导出来的。
 */
import type { RootState } from '../stores/store';
import { findThreadIdOf, isStreaming, streamedTextOf, turnDisplayStatus } from '../stores/store';
import { ItemCard } from './ItemCard';
import { Markdown } from './Markdown';

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

  return (
    <div
      className={`turn ${display === 'awaiting_approval' ? 'is-awaiting' : ''}`}
      // 导航条据此定位与跳转。用属性而非 ref：导航条只需要极少数几个
      // 元素的位置（点击时算一次），不值得为每个轮次维护一个 ref。
      data-turn-id={turnId}
    >
      <div className="turn-items">
        {items.map((item) => (
          <ItemCard
            onOpenFile={onOpenFile}
            key={item.id}
            item={item}
            streamedText={streamedTextOf(state, item)}
            streaming={isStreaming(state, item)}
          />
        ))}
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
            <div key={id} className="item-card agent-message is-streaming">
              <MarkdownLite text={text} />
            </div>
          ));
        })()}

        {/* 状态标记放在**内容之后**。
            此前它在内容之前（turn-head），于是「运行中」出现在用户消息
            上方——读起来像在描述那条消息，而它描述的其实是「内容还在生成」，
            语义上属于内容的尾部。参照客户端也是尾部转圈。 */}

        {/* 进行中：一个转圈 + 极简文案。这是唯一的「活着」的指示。 */}
        {(display === 'running' || display === 'awaiting_approval') && (
          <div className={`turn-progress ${display === 'awaiting_approval' ? 'is-awaiting' : ''}`}>
            <span className="spinner" />
            <span>{display === 'awaiting_approval' ? '等待你批准' : '正在处理'}</span>
          </div>
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
