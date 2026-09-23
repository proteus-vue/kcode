/**
 * 右栏的子代理面板。
 *
 * # 它解决什么
 *
 * Agent 派生子代理后，主时间线上只有一行摘要。用户想知道「子代理到底在干什么、
 * 干到哪了」时，需要的是一条**完整的时间线**——与主线程同构的那种。
 *
 * # 两个必须处理好的失败态（不是可选的健壮性）
 *
 * 子代理线程由服务端持有，它会：
 * - **还没产出内容**（刚 spawn，第一个 turn 尚未落地）；
 * - **已被回收**（`agentsStates` 里就有 `shutdown` / `notFound` 两种状态，
 *   对应线程已经读不到）。
 *
 * 参照客户端为此专门做了 `subagents.panel.response.loading` 与
 * `.response.unavailable` 两个文案（实测其 asar），说明这是**必然遇到的
 * 常态**而不是异常。所以这里同样分三态：加载中 / 读不到（说明原因）/
 * 读到但没有内容。**任何一种都不留白屏**——空白让人以为界面坏了。
 */
import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Icon } from './Icon';
import { ItemCard } from './ItemCard';
import { formatDuration } from './duration';
import { agentStatusLabel, shortId, statusTone } from './collabAgent';
import type { Item, ThreadSnapshot } from '../types/domain';

/** 子代理列表里的一个条目（从主线程的协作 item 汇总而来）。 */
export interface SubagentEntry {
  threadId: string;
  /** 状态：优先取 agentsStates 里的实时状态，其次由活动事件推断。 */
  status: string;
  /** 协议给的说明文本（可为空）。 */
  message: string | null;
  /** 委派给它的任务（来自 spawnAgent 的 prompt）。 */
  task: string | null;
  /** 派生于哪个 turn（用于「回到那一轮」的定位）。 */
  spawnedAtTurnId: string | null;
}

type DetailState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; snapshot: ThreadSnapshot }
  | { kind: 'error'; message: string };

export function SubagentPanel({
  entries,
  onOpenFile,
}: {
  entries: SubagentEntry[];
  onOpenFile?: (path: string) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailState>({ kind: 'idle' });

  const load = useCallback(async (threadId: string) => {
    setDetail({ kind: 'loading' });
    try {
      const snap = await invoke<ThreadSnapshot>('read_remote_thread', { threadId });
      setDetail({ kind: 'ok', snapshot: snap });
    } catch (e) {
      // 读不到是**预期内的常态**（线程可能已被回收），如实说明而不是报错弹窗
      const msg = e instanceof Error ? e.message : String(e);
      setDetail({ kind: 'error', message: msg });
    }
  }, []);

  // 选中的代理消失时（列表变了）回到列表态，避免看着一个不存在的会话
  useEffect(() => {
    if (selected && !entries.some((e) => e.threadId === selected)) {
      setSelected(null);
      setDetail({ kind: 'idle' });
    }
  }, [entries, selected]);

  if (entries.length === 0) {
    return (
      <div className="panel">
        <div className="panel-head">
          <Icon name="cpu" size={13} />
          <span>子代理</span>
        </div>
        <p className="panel-empty">当前任务没有派生子代理。</p>
      </div>
    );
  }

  // ── 详情态：看一条子代理会话 ──────────────────────────────────────
  if (selected) {
    const entry = entries.find((e) => e.threadId === selected);
    return (
      <div className="panel subagent-detail">
        <div className="panel-head">
          <button className="mini-btn" onClick={() => setSelected(null)} title="返回子代理列表">
            返回
          </button>
          <Icon name="cpu" size={13} />
          <span className="subagent-detail-id mono" title={selected}>
            {shortId(selected)}
          </span>
          {entry && (
            <span className={`chip chip-${statusTone(entry.status)}`}>
              {agentStatusLabel(entry.status)}
            </span>
          )}
        </div>

        {entry?.task && (
          <div className="subagent-task">
            <p className="collab-label">委派的任务</p>
            <p className="subagent-task-text">{entry.task}</p>
          </div>
        )}

        {detail.kind === 'loading' && <p className="panel-empty">正在读取子代理会话…</p>}

        {detail.kind === 'error' && (
          <div className="subagent-unavailable">
            <p className="subagent-unavailable-title">这条子代理会话读不到</p>
            {/* 说清两种可能：等一会儿再试，或它已经被回收。
                不给「重试」按钮——会话被回收时重试永远不会成功，
                那会变成用户反复点一个没用的按钮。 */}
            <p className="subagent-unavailable-hint">
              子代理的会话由服务端持有。若它仍在运行，稍后重试即可；
              若已结束并被回收，则无法再读回。
            </p>
            <p className="subagent-unavailable-detail mono">{detail.message}</p>
            <button className="mini-btn" onClick={() => void load(selected)}>
              再试一次
            </button>
          </div>
        )}

        {detail.kind === 'ok' && (
          <SubagentTimeline snapshot={detail.snapshot} onOpenFile={onOpenFile} />
        )}
      </div>
    );
  }

  // ── 列表态 ────────────────────────────────────────────────────────
  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="cpu" size={13} />
        <span>子代理</span>
        <span className="panel-status">{entries.length}</span>
      </div>
      <ul className="subagent-list">
        {entries.map((e) => (
          <li key={e.threadId}>
            <button
              className={`subagent-item tone-${statusTone(e.status)}`}
              onClick={() => {
                setSelected(e.threadId);
                void load(e.threadId);
              }}
              title={e.threadId}
            >
              <span className="collab-dot" />
              <span className="subagent-item-id mono">{shortId(e.threadId)}</span>
              <span className="subagent-item-status">{agentStatusLabel(e.status)}</span>
              {e.task && <span className="subagent-item-task">{e.task}</span>}
            </button>
          </li>
        ))}
      </ul>
      <p className="subagent-note">点击查看该子代理的完整会话。</p>
    </div>
  );
}

/** 子代理会话的时间线（与主线程同构）。 */
function SubagentTimeline({
  snapshot,
  onOpenFile,
}: {
  snapshot: ThreadSnapshot;
  onOpenFile?: (path: string) => void;
}) {
  if (snapshot.items.length === 0) {
    // 有线程但没内容：这是「刚 spawn、还没干活」的常态，不是错误
    return (
      <p className="panel-empty">
        这条子代理会话还没有内容——它可能刚刚启动。
      </p>
    );
  }

  return (
    <div className="subagent-timeline">
      {snapshot.turns.map((t) => {
        const items = snapshot.items.filter((i) => i.turnId === t.turnId);
        if (items.length === 0) return null;
        return (
          <div key={t.turnId} className="subagent-turn">
            {items.map((i) => (
              <ItemCard key={i.id} item={i} onOpenFile={onOpenFile} />
            ))}
            {t.durationMs !== null && (
              <p className="subagent-turn-time">
                <Icon name="clock" size={10} />
                已处理 {formatDuration(t.durationMs)}
              </p>
            )}
            {t.status === 'failed' && (
              <p className="subagent-turn-failed">该轮失败</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 从主线程的 items 汇总出子代理列表。
 *
 * 纯函数：**同一个代理可能在多条 item 里出现**（spawn 一次、之后 wait /
 * send_input 各一次，每次的 `agentsStates` 都可能更新它的状态），
 * 所以必须按 threadId 归并、并让**后出现的状态覆盖先前**——否则界面会
 * 显示一个已经完成代理还在「运行中」。
 */
export function collectSubagents(items: Item[]): SubagentEntry[] {
  const byId = new Map<string, SubagentEntry>();

  for (const it of items) {
    const b = it.body;
    if (b.kind !== 'collabAgent') continue;

    // spawnAgent 的 prompt 是委派给新代理的任务
    const isSpawn = b.source === 'collabAgentToolCall' && b.tool === 'spawnAgent';

    // 1) 从 agentsStates 表拿状态（最权威：服务端维护的实时状态）
    for (const a of b.agents) {
      const prev = byId.get(a.threadId);
      byId.set(a.threadId, {
        threadId: a.threadId,
        // 后出现的覆盖先前的（fail / 完成状态会后来居上）
        status: a.status,
        message: a.message ?? prev?.message ?? null,
        task: prev?.task ?? (isSpawn ? (b.prompt ?? null) : null),
        spawnedAtTurnId: prev?.spawnedAtTurnId ?? (isSpawn ? it.turnId : null),
      });
    }

    // 2) 只给了 receiverThreadIds 的分支（早期帧可能还没带 agentsStates）
    if (isSpawn) {
      for (const id of b.receiverThreadIds) {
        if (byId.has(id)) continue;
        byId.set(id, {
          threadId: id,
          status: 'running',
          message: null,
          task: b.prompt ?? null,
          spawnedAtTurnId: it.turnId,
        });
      }
    }

    // 3) subAgentActivity 只有活动类型，没有状态枚举；仅在完全没有
    //    其它信息时用它的 kind 兜底（kind: started/interacted/...）
    if (b.source === 'subAgentActivity' && b.agentThreadId) {
      const prev = byId.get(b.agentThreadId);
      if (!prev) {
        byId.set(b.agentThreadId, {
          threadId: b.agentThreadId,
          status: activityToStatus(b.activityKind),
          message: null,
          task: null,
          spawnedAtTurnId: it.turnId,
        });
      }
    }
  }

  return [...byId.values()];
}

/** `subAgentActivity.kind` → 与 `agentsStates.status` 同一套取值。 */
function activityToStatus(kind: string | null | undefined): string {
  switch (kind) {
    case 'started':
      return 'running';
    case 'completed':
      return 'completed';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'running';
  }
}

/** 子代理项里是否还有在跑的（决定场景是否显示为「进行中」）。 */
export function anySubagentRunning(entries: SubagentEntry[]): boolean {
  return entries.some((e) => e.status === 'running' || e.status === 'pendingInit');
}
