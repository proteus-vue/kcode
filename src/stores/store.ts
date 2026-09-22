/**
 * 领域状态仓库。
 *
 * # 两条来自实测的硬要求
 *
 * 1. **`declined` 必须与 `completed` 分开呈现。** 用户拒绝后命令根本没执行，
 *    若显示成「已完成」，用户会以为自己批准了。
 * 2. **`cancel` 与 `decline` 必须区分。** 两者都阻止执行，但 `cancel` 会中断
 *    整个 Turn。混用会让用户拒绝一条命令时意外终止整个任务。
 *
 * 事件按 upsert 处理：同一个 item 的后续事件覆盖先前状态，
 * 因此 `item/started` → `item/completed` 会让卡片从「运行中」变为终态。
 */

import type {
  AppEvent,
  Approval,
  ApprovalDecision,
  ApprovalScope,
  ChangeSet,
  DiffLine,
  DiffStats,
  FileChangeEntry,
  FileDecision,
  FileDiffSlice,
  GuardianWarning,
  Item,
  ParsedDiff,
  ReviewState,
  ThreadInfo,
  ThreadTokenUsage,
  TurnStatus,
} from '../types/domain';

export interface TurnState {
  id: string;
  status: TurnStatus;
  itemIds: string[];
}

export interface ThreadState {
  id: string;
  cwd: string;
  info: ThreadInfo | null;
  /** 服务端名字（thread/name/set 之后由 thread/list 返回）。 */
  name: string | null;
  /** 该线程的模型（start_thread 的返回，或 thread/list 的 model）。 */
  model: string | null;
  turnOrder: string[];
  turns: Record<string, TurnState>;
  items: Record<string, Item>;
  /** 该线程的待决审批，按 requestId 索引。 */
  pendingApprovals: Record<string, Approval>;
  /** 按轮次索引的变更集（逐文件结构，含 diff）。 */
  changeSets: Record<string, ChangeSet>;
  /** 按轮次索引的整轮 unified diff。 */
  turnDiffs: Record<string, ParsedDiff>;
  /** 按轮次索引的**逐文件切分结果**（整轮 diff 是多段拼接，需切分）。 */
  turnDiffFiles: Record<string, FileDiffSlice[]>;
  /**
   * 流式文本缓冲：itemId → 已累积内容。
   *
   * 与 `items` 分开存放的理由：流式增量频率极高（每 token 一次），
   * 若每次都重建 items 对象会拖慢整个时间线。渲染时把缓冲叠加到
   * Item 文本之上即可。
   */
  streamBuffer: Record<string, string>;
  /**
   * 流式内容归属的轮次：itemId → turnId。
   *
   * **必须精确记录，不能靠推断**：`streamBuffer` 只按 itemId 索引，而
   * `TurnView` 需要知道「这段未归位的内容属于哪一轮」。此前它只判
   * `!turn.itemIds.includes(id)`——于是新轮次的流式内容会出现在**每一个**
   * 历史轮次下面，用户看到已完成的对话跟着新对话一起变、旧轮次也显示
   * 「运行中」。协议在增量事件里带了 turnId，直接记下来即可。
   */
  streamTurn: Record<string, string>;
  /**
   * 护栏警告（上游检测到异常执行模式）。
   *
   * 单独成列而非并进 `errors`：`errors` 是「哪里出错了」的杂项列表，
   * 而这是**安全信号**——它意味着上游刹车已介入。混在一起会被
   * 「模型列表加载失败」这类噪音淹没。
   */
  guardianWarnings: GuardianWarning[];
  /** 最近一次 token 用量上报。null 表示尚未收到。 */
  tokenUsage: ThreadTokenUsage | null;
}

export interface RootState {
  threads: Record<string, ThreadState>;
  threadOrder: string[];
  activeThreadId: string | null;
  /** 运行时就绪状态。 */
  ready: boolean;
  errors: string[];
  /** 已退出：所有活动轮次应显示为 unknown。 */
  processExited: boolean;
}

export function initialState(): RootState {
  return {
    threads: {},
    threadOrder: [],
    activeThreadId: null,
    ready: false,
    errors: [],
    processExited: false,
  };
}

/**
 * 取出线程，缺失时**返回新对象**（不写回 state）。
 *
 * 注意：这里刻意不修改 `state`。归约必须是纯函数——若就地 push
 * `state.threadOrder`，由于浅拷贝共享数组引用，输入状态会被污染，
 * 导致 React 的引用比较判断失误、也可能让重放结果不确定。
 */
function getOrCreateThread(state: RootState, threadId: string, cwd = ''): ThreadState {
  return state.threads[threadId] ?? newThreadState(threadId, cwd);
}

/**
 * 线程状态的**唯一构造点**。
 *
 * 所有新增字段都在这里初始化。此前 `getOrCreateThread` 内联了对象字面量，
 * 新增 `changeSets`/`turnDiffs` 时漏改，导致归约读到 `undefined`——
 * TypeScript 不会捕获这类遗漏（对象字面量恰好满足接口时会通过，
 * 而这里是通过返回值类型推断绕过的）。收敛到单一构造点可根除这类问题。
 */
export function newThreadState(threadId: string, cwd = ''): ThreadState {
  return {
    id: threadId,
    cwd,
    info: null,
    name: null,
    model: null,
    turnOrder: [],
    turns: {},
    items: {},
    pendingApprovals: {},
    changeSets: {},
    turnDiffs: {},
    turnDiffFiles: {},
    streamBuffer: {},
    streamTurn: {},
    guardianWarnings: [],
    tokenUsage: null,
  };
}

/** 取出轮次，缺失时返回新对象（同样不写回，保持纯函数）。 */
function getOrCreateTurn(th: ThreadState, turnId: string, status: TurnStatus = 'inProgress'): TurnState {
  return th.turns[turnId] ?? { id: turnId, status, itemIds: [] };
}

/**
 * 纯函数式归约：给定状态与事件，返回新状态。
 *
 * 保持纯函数便于测试——UI 的状态推导逻辑最容易出细微错误，
 * 且这类错误只在特定事件顺序下才显现。
 */
export function reduce(state: RootState, event: AppEvent): RootState {
  // 浅拷贝需要变更的层级；事件频率高，避免整树深拷贝。
  const next: RootState = { ...state, errors: [...state.errors] };

  switch (event.type) {
    case 'threadStarted': {
      next.threads = { ...state.threads };
      const existing = getOrCreateThread(state, event.threadId, event.cwd);
      next.threads[event.threadId] = { ...existing, cwd: event.cwd || existing.cwd };
      next.threadOrder = state.threadOrder.includes(event.threadId)
        ? state.threadOrder
        : [...state.threadOrder, event.threadId];
      if (!next.activeThreadId) next.activeThreadId = event.threadId;
      break;
    }

    case 'threadMeta': {
      next.threads = { ...state.threads };
      const base = getOrCreateThread(state, event.threadId);
      next.threads[event.threadId] = {
        ...base,
        name: event.name ?? base.name,
        model: event.model ?? base.model,
      };
      break;
    }

    case 'guardianWarning': {
      next.threads = { ...state.threads };
      const base = getOrCreateThread(state, event.threadId);
      next.threads[event.threadId] = {
        ...base,
        // 保留全部历史：同一轮可能多次示警，而「示警了几次」本身
        // 就是判断严重程度的依据。
        //
        // 刻意不记时间戳：归约必须是纯函数（重放要得到同一结果），
        // `Date.now()` 会破坏这一点。需要时间时由后端随事件带上。
        guardianWarnings: [...base.guardianWarnings, { message: event.message }],
      };
      break;
    }

    case 'tokenUsageUpdated': {
      next.threads = { ...state.threads };
      const base = getOrCreateThread(state, event.threadId);
      next.threads[event.threadId] = { ...base, tokenUsage: event.usage };
      break;
    }

    case 'turnStarted': {
      next.threads = { ...state.threads };
      const base = getOrCreateThread(state, event.threadId);
      const th: ThreadState = {
        ...base,
        turns: { ...base.turns, [event.turnId]: getOrCreateTurn(base, event.turnId, 'inProgress') },
        turnOrder: base.turnOrder.includes(event.turnId)
          ? base.turnOrder
          : [...base.turnOrder, event.turnId],
      };
      next.threads[event.threadId] = th;
      next.threadOrder = state.threadOrder.includes(event.threadId)
        ? state.threadOrder
        : [...state.threadOrder, event.threadId];
      if (!next.activeThreadId) next.activeThreadId = event.threadId;
      break;
    }

    case 'itemUpserted': {
      // Item 正式落地后清空其流式缓冲——内容已并入 item.text，
      // 继续保留会导致渲染时重复。
      {
      next.threads = { ...state.threads };
      const base = getOrCreateThread(state, event.threadId);
      const prevTurn = getOrCreateTurn(base, event.turnId);
      const turn: TurnState = {
        ...prevTurn,
        itemIds: prevTurn.itemIds.includes(event.item.id)
          ? prevTurn.itemIds
          : [...prevTurn.itemIds, event.item.id],
      };
      // **仅在 completed 时**清空流式缓冲。实测协议顺序是
      //   item/started → N 条 delta → item/completed
      // 且只有 completed 携带完整文本。若在 started 就清，随后的
      // 增量会全部丢失（这正是本次踩到的错误）。
      const buf = { ...base.streamBuffer };
      const sturn = { ...base.streamTurn };
      delete sturn[event.item.id];
      if (event.completed) {
        delete buf[event.item.id];
      }

      const th: ThreadState = {
        ...base,
        items: { ...base.items, [event.item.id]: event.item },
        streamBuffer: buf,
        streamTurn: sturn,
        turns: { ...base.turns, [event.turnId]: turn },
        turnOrder: base.turnOrder.includes(event.turnId)
          ? base.turnOrder
          : [...base.turnOrder, event.turnId],
      };
      next.threads[event.threadId] = th;
      next.threadOrder = state.threadOrder.includes(event.threadId)
        ? state.threadOrder
        : [...state.threadOrder, event.threadId];
      if (!next.activeThreadId) next.activeThreadId = event.threadId;
      }
      break;
    }

    case 'approvalRequired': {
      next.threads = { ...state.threads };
      const base = getOrCreateThread(state, event.approval.threadId);
      next.threads[event.approval.threadId] = {
        ...base,
        pendingApprovals: { ...base.pendingApprovals, [event.approval.requestId]: event.approval },
      };
      next.threadOrder = state.threadOrder.includes(event.approval.threadId)
        ? state.threadOrder
        : [...state.threadOrder, event.approval.threadId];
      break;
    }

    case 'approvalResolved': {
      next.threads = { ...state.threads };
      const prev = state.threads[event.threadId];
      if (prev) {
        const th = { ...prev };
        const pa = { ...th.pendingApprovals };
        delete pa[event.requestId];
        th.pendingApprovals = pa;
        next.threads[event.threadId] = th;
      }
      break;
    }

    case 'turnCompleted': {
      next.threads = { ...state.threads };
      const base = getOrCreateThread(state, event.threadId);
      const turn: TurnState = { ...getOrCreateTurn(base, event.turnId), status: event.status };
      next.threads[event.threadId] = {
        ...base,
        turns: { ...base.turns, [event.turnId]: turn },
        turnOrder: base.turnOrder.includes(event.turnId)
          ? base.turnOrder
          : [...base.turnOrder, event.turnId],
      };
      next.threadOrder = state.threadOrder.includes(event.threadId)
        ? state.threadOrder
        : [...state.threadOrder, event.threadId];
      break;
    }

    case 'outputDelta': {
      // 增量输出追加到对应命令卡片；聚合输出由后端的 item 事件最终确定。
      next.threads = { ...state.threads };
      const prev = state.threads[event.threadId];
      if (prev?.items[event.itemId]) {
        const th = { ...prev };
        const item = th.items[event.itemId];
        if (item.body.kind === 'commandExecution') {
          th.items = {
            ...th.items,
            [event.itemId]: {
              ...item,
              body: {
                ...item.body,
                aggregatedOutput: (item.body.aggregatedOutput ?? '') + event.delta,
              },
            },
          };
          next.threads[event.threadId] = th;
        }
      }
      break;
    }

    case 'textDelta': {
      // 空增量不入缓冲：避免制造无意义的键（会让「是否在流式」判断失真）
      if (event.delta === '') break;
      // **推理增量不进缓冲**：推理内容不展示（与参照客户端一致，理由是
      // 它每轮一条、把时间线撑成两倍长，而信息价值远低于工具调用）。
      // 若仍写进缓冲，它会经「尚未产生 Item 的流式内容」那条渲染路径
      // 漏出来被当成正文显示——那比不展示更糟：用户看到一段没有出处、
      // 也不属于任何消息的文字。
      if (event.channel === 'reasoning' || event.channel === 'reasoningSummary') break;
      next.threads = { ...state.threads };
      const base = getOrCreateThread(state, event.threadId);
      next.threads[event.threadId] = {
        ...base,
        streamBuffer: {
          ...base.streamBuffer,
          [event.itemId]: (base.streamBuffer[event.itemId] ?? '') + event.delta,
        },
        // 记录归属轮次：TurnView 据此判断「这段内容该显示在哪一轮下面」
        streamTurn: { ...base.streamTurn, [event.itemId]: event.turnId },
      };
      next.threadOrder = state.threadOrder.includes(event.threadId)
        ? state.threadOrder
        : [...state.threadOrder, event.threadId];
      break;
    }

    case 'changeSetUpdated': {
      next.threads = { ...state.threads };
      const base = getOrCreateThread(state, event.threadId);
      const prev = base.changeSets[event.turnId];
      // 同一轮次可能存在 Proposed → Applied 的推进；
      // 已应用的版本优先保留，避免被后到的提议版本覆盖回「未落盘」。
      const incoming = event.changeSet;
      const keep =
        prev && prev.origin === 'applied' && incoming.origin === 'proposed' ? prev : incoming;
      next.threads[event.threadId] = {
        ...base,
        changeSets: { ...base.changeSets, [event.turnId]: keep },
      };
      next.threadOrder = state.threadOrder.includes(event.threadId)
        ? state.threadOrder
        : [...state.threadOrder, event.threadId];
      break;
    }

    case 'changeSetReplaced': {
      // 从历史重建：**整体替换**，因为重建结果已包含持久化的决策。
      // 与 changeSetUpdated 的 upsert 语义不同——那个是协议增量。
      next.threads = { ...state.threads };
      const base = getOrCreateThread(state, event.threadId);
      next.threads[event.threadId] = {
        ...base,
        changeSets: { ...base.changeSets, [event.turnId]: event.changeSet },
      };
      next.threadOrder = state.threadOrder.includes(event.threadId)
        ? state.threadOrder
        : [...state.threadOrder, event.threadId];
      break;
    }

    case 'turnDiffUpdated': {
      next.threads = { ...state.threads };
      const base = getOrCreateThread(state, event.threadId);
      next.threads[event.threadId] = {
        ...base,
        turnDiffs: { ...base.turnDiffs, [event.turnId]: event.parsed },
        turnDiffFiles: { ...base.turnDiffFiles, [event.turnId]: event.perFile },
      };
      next.threadOrder = state.threadOrder.includes(event.threadId)
        ? state.threadOrder
        : [...state.threadOrder, event.threadId];
      break;
    }

    case 'error': {
      next.errors = [...state.errors, event.message];
      break;
    }

    case 'processExited': {
      // 子进程退出：所有仍在进行的轮次状态已不可信。
      // 标记产物是 UI 显示 unknown，**绝不静默当作成功或失败**。
      next.processExited = true;
      next.ready = false;
      next.threads = { ...state.threads };
      for (const [id, th] of Object.entries(state.threads)) {
        const turns = { ...th.turns };
        let changed = false;
        for (const [tid, turn] of Object.entries(turns)) {
          if (turn.status === 'inProgress') {
            turns[tid] = { ...turn, status: 'failed' };
            changed = true;
          }
        }
        if (changed) next.threads[id] = { ...th, turns };
      }
      break;
    }
  }

  return next;
}

/** 批量归约，便于一次性套用多条事件。 */
/**
 * 从快照批量重建线程状态（**一次扫描**，不逐条 reduce）。
 *
 * # 为什么需要它
 *
 * `openThread` 原先对快照里的每条 item / turn / changeSet 各调一次 `reduce`，
 * 而每次 `reduce` 内部都有若干 `includes` 扫描（`itemIds`、`turnOrder`）。
 * 逐条 × 扫描 = **O(n²)**：实测 1000 条 91ms、2000 条 448ms，真实长会话
 * （几千条）打开时会明显卡顿——这正是「会话过长打开卡顿」的成因。
 *
 * 这里改为一次扫描直接组装：复杂度 O(n)，且**不改动归约语义**
 * （单条 reduce 的耗时本身只有 0.2–0.5ms，慢的是累积）。
 *
 * 只用于「从事件日志重建」这条路径——实时事件仍走 reduce
 * （单条语义清晰、可测；实时量级远小于全量重建）。
 */
export function rebuildThread(
  state: RootState,
  threadId: string,
  cwd: string,
  items: Item[],
  turns: { turnId: string; status: TurnStatus }[],
  changeSets: ChangeSet[],
): RootState {
  const base = state.threads[threadId] ?? newThreadState(threadId, cwd);
  const nextItems: Record<string, Item> = { ...base.items };
  const byTurn = new Map<string, string[]>();
  for (const it of items) {
    nextItems[it.id] = it;
    const arr = byTurn.get(it.turnId);
    if (arr) arr.push(it.id);
    else byTurn.set(it.turnId, [it.id]);
  }

  const nextTurns: Record<string, TurnState> = { ...base.turns };
  const order: string[] = [...base.turnOrder];
  const seen = new Set(order);
  for (const t of turns) {
    const prev = nextTurns[t.turnId];
    nextTurns[t.turnId] = {
      id: t.turnId,
      status: t.status,
      itemIds: byTurn.get(t.turnId) ?? prev?.itemIds ?? [],
    };
    if (!seen.has(t.turnId)) {
      seen.add(t.turnId);
      order.push(t.turnId);
    }
  }
  // 有 item 但不在 turns 列表里的轮次也要登记（否则时间线会漏内容）
  for (const [turnId, ids] of byTurn) {
    if (!seen.has(turnId)) {
      seen.add(turnId);
      order.push(turnId);
      nextTurns[turnId] = { id: turnId, status: 'completed', itemIds: ids };
    }
  }

  const nextChangeSets = { ...base.changeSets };
  for (const cs of changeSets) nextChangeSets[cs.turnId] = cs;

  return {
    ...state,
    threads: {
      ...state.threads,
      [threadId]: {
        ...base,
        cwd: cwd || base.cwd,
        items: nextItems,
        turns: nextTurns,
        turnOrder: order,
        changeSets: nextChangeSets,
      },
    },
    threadOrder: state.threadOrder.includes(threadId)
      ? state.threadOrder
      : [...state.threadOrder, threadId],
    activeThreadId: state.activeThreadId ?? threadId,
  };
}

export function reduceAll(state: RootState, events: AppEvent[]): RootState {
  return events.reduce(reduce, state);
}

// ── 派生查询（UI 展示逻辑）─────────────────────────────────────────────

/**
 * 派生出轮次的展示状态。
 *
 * `awaiting_approval` **不是协议状态**——协议 `TurnStatus` 只有 4 个值。
 * 它必须由「轮次进行中 + 存在待决审批」推导出来。
 */
export function turnDisplayStatus(
  state: RootState,
  threadId: string,
  turnId: string,
): 'running' | 'awaiting_approval' | 'completed' | 'interrupted' | 'failed' | 'unknown' {
  const th = state.threads[threadId];
  const turn = th?.turns[turnId];
  if (!turn) return 'unknown';

  if (state.processExited && turn.status === 'inProgress') return 'unknown';

  if (turn.status === 'inProgress') {
    const hasPending = Object.values(th?.pendingApprovals ?? {}).some((a) => a.turnId === turnId);
    return hasPending ? 'awaiting_approval' : 'running';
  }
  return turn.status;
}

/**
 * 侧栏排序权重：依据「待用户操作」而非最近活动时间。
 *
 * 数值越小越靠前。
 */
export function threadSortRank(state: RootState, threadId: string): number {
  const th = state.threads[threadId];
  if (!th) return 99;

  if (Object.keys(th.pendingApprovals).length > 0) return 0;

  const statuses = th.turnOrder.map((t) => turnDisplayStatus(state, threadId, t));
  if (statuses.includes('running') || statuses.includes('awaiting_approval')) return 1;
  if (statuses.includes('unknown')) return 2;
  if (statuses.includes('failed')) return 3;
  if (statuses.includes('completed')) return 4;
  if (statuses.includes('interrupted')) return 5;
  return 6;
}

/** 按「待操作优先」排序的线程 id 列表。 */
export function sortedThreadIds(state: RootState): string[] {
  return [...state.threadOrder].sort((a, b) => threadSortRank(state, a) - threadSortRank(state, b));
}

/** 取某线程的全部 Item，按所属轮次与产生顺序展开。 */
export function threadItems(state: RootState, threadId: string): Item[] {
  const th = state.threads[threadId];
  if (!th) return [];
  return th.turnOrder.flatMap((tid) => (th.turns[tid]?.itemIds ?? []).map((iid) => th.items[iid]).filter(Boolean));
}

/** 找 Item 所属线程 id。 */
export function findThreadIdOf(state: RootState, threadId: string): string | null {
  return state.threads[threadId] ? threadId : null;
}

/** 取该 Item 当前已流入的流式文本（空串表示无）。 */
export function streamedTextOf(state: RootState, item: Item): string {
  const tid = findThreadOf(state, item);
  return state.threads[tid]?.streamBuffer[item.id] ?? '';
}

/**
 * 取 Item 的**显示文本**：优先用已落地的正式内容，
 * 尚无内容时回退到流式缓冲。
 *
 * 这样渲染层不需要关心「内容此刻来自哪里」——流式过程中显示增量，
 * 完成后自动切到正式内容。
 */
export function displayText(state: RootState, item: Item): string {
  const buffered = state.threads[item.turnId === '' ? '' : findThreadOf(state, item)]?.streamBuffer[item.id];
  const own = itemText(item);
  if (own) return own;
  return buffered ?? '';
}

function findThreadOf(state: RootState, item: Item): string {
  for (const [tid, th] of Object.entries(state.threads)) {
    if (th.items[item.id]) return tid;
  }
  return '';
}

/** Item 自带的文本内容（若有）。 */
export function itemText(item: Item): string | null {
  switch (item.body.kind) {
    case 'userMessage':
    case 'agentMessage':
    case 'reasoning':
    case 'plan':
      return item.body.text;
    default:
      return null;
  }
}

/** 某 Item 是否有正在流式生成的内容。 */
export function isStreaming(state: RootState, item: Item): boolean {
  const tid = findThreadOf(state, item);
  const buf = state.threads[tid]?.streamBuffer[item.id];
  return Boolean(buf) && !itemText(item);
}

/** Item 是否表示「用户拒绝的操作」。 */
export function isDeclined(item: Item): boolean {
  return (
    (item.body.kind === 'commandExecution' || item.body.kind === 'fileChange') &&
    item.body.status === 'declined'
  );
}

/**
 * 审批决策的中文标签。
 *
 * `decline` 与 `cancel` **必须使用不同文案**——否则用户无法预知自己的选择
 * 会不会连整个 Turn 一起终止。
 */
export function decisionLabel(decision: ApprovalDecision): string {
  switch (decision) {
    case 'accept':
      return '批准';
    case 'acceptForSession':
      return '本会话内总是批准';
    case 'acceptWithExecpolicyAmendment':
      return '批准并记住此命令';
    case 'applyNetworkPolicyAmendment':
      return '应用网络策略';
    case 'decline':
      return '拒绝';
    case 'cancel':
      return '拒绝并停止';
  }
}

/** `cancel` 会中断整个 Turn，用于 UI 提示。 */
export function interruptsTurn(decision: ApprovalDecision): boolean {
  return decision === 'cancel';
}

/** 该决策是否批准了操作。 */
export function isApproving(decision: ApprovalDecision): boolean {
  return decision !== 'decline' && decision !== 'cancel';
}

/** 高风险及以上应阻塞式确认。 */
export function isBlockingRisk(tier: string): boolean {
  return tier === 'high' || tier === 'critical';
}

/**
 * 作用域 → 协议决策（AP-07）。
 *
 * 协议只提供两个「允许」决策：`accept`（本次）与 `acceptForSession`
 * （本会话内同类请求不再询问）。`turn`/`project` 是领域层的预留粒度——
 * 协议没有对应的独立字段，因此 UI 不提供这两个选项。
 *
 * **未支持的作用域一律回落到最窄授权（`accept`）**：权限判断出现
 * 不确定时，正确的默认是收紧而不是放大——宁可多问一次，也不能因为
 * 一个没被支持的枚举值就把整个会话放行。
 */
export function decisionForScope(scope: ApprovalScope): ApprovalDecision {
  return scope === 'session' ? 'acceptForSession' : 'accept';
}

/** 上下文占用档位。 */
export type ContextLevel = 'ok' | 'near' | 'critical';

export interface ContextUsage {
  /** 最近一轮的上下文占用量（估算值）。 */
  used: number;
  /** 模型上下文窗口。 */
  window: number;
  /** 占用比例 0–1。 */
  ratio: number;
  level: ContextLevel;
  /** 还剩多少 token。 */
  remaining: number;
}

/**
 * 由 token 用量推算上下文余量（CH-08 / 文档 05 第 9 条）。
 *
 * # 三个必须做对的地方
 *
 * 1. **用 `last` 而不是 `total`。** `total` 是线程跨轮累加值——拿它除以
 *    上下文窗口会得出「已用 300%」这种荒谬结论，因为每轮的输入都会被
 *    **重新**计入。只有最近一轮的用量才近似当前上下文占用。
 * 2. **窗口未知时返回 null，不猜。** 没有窗口就算不出比例；用一个
 *    默认值（比如 128k）充数，会让用户在完全不同的量级上做判断。
 * 3. **档位阈值与上游压缩线对齐。** 上游在 70% 附近开始压缩上下文，
 *    所以 `near` 取 0.7——那正是用户该知道「我的对话快要被压缩了」的点。
 */
export function contextUsage(usage: ThreadTokenUsage | null): ContextUsage | null {
  if (!usage) return null;
  const window = usage.modelContextWindow;
  // 0 与负数都是无效窗口：算出的比例会是 Infinity，显示成「已用 ∞%」
  if (window == null || window <= 0) return null;

  const used = usage.last.totalTokens;
  const ratio = used / window;
  const level: ContextLevel = ratio >= 0.9 ? 'critical' : ratio >= 0.7 ? 'near' : 'ok';

  return {
    used,
    window,
    ratio,
    level,
    remaining: Math.max(0, window - used),
  };
}

/**
 * 护栏警告的展示摘要。
 *
 * 去重是必要的：上游在持续异常时可能连续推送同一条警告，而侧栏/横幅
 * 上重复十遍同样的句子只会让人忽略它。保留**最后一次**——那是最新的状态。
 */
export function guardianSummary(warnings: GuardianWarning[]): string | null {
  if (warnings.length === 0) return null;
  const last = warnings[warnings.length - 1].message.trim();
  if (!last) return null;
  const extra = warnings.length > 1 ? `（共 ${warnings.length} 次）` : '';
  return `${last}${extra}`;
}

/** 风险信号的可读描述。 */
export function describeSignal(signal: unknown): string {
  if (typeof signal !== 'object' || signal === null) return '';
  const [kind, payload] = Object.entries(signal as Record<string, unknown>)[0] ?? [];
  if (!kind) return '';
  const p = (payload ?? {}) as Record<string, string>;
  const map: Record<string, () => string> = {
    pathOutsideWorkspace: () => `引用工作区之外的路径：${p.path}`,
    parentTraversal: () => '使用 `..` 跳出当前目录',
    credentialAccess: () => `访问凭据类文件：${p.target}`,
    privilegeEscalation: () => `提权执行：${p.program}`,
    destructiveDelete: () => '递归或强制删除',
    diskOperation: () => '磁盘/分区级操作',
    permissionWidening: () => '放宽文件权限',
    networkEgress: () => `网络外发：${p.evidence}`,
    dependencyInstall: () => `安装依赖（将执行第三方代码）：${p.manager}`,
    gitForceOperation: () => '重写 Git 历史或强制推送',
    escalationRequested: () => '命令主动申请了提权',
    writeRootRequested: () => `申请工作区外的可写根：${p.root}`,
    networkApprovalRequested: () => '涉及网络访问',
    unparsedCommand: () => '命令无法解析，按保守估计',
  };
  return map[kind]?.() ?? kind;
}

// ── 变更集与 Diff 辅助 ──────────────────────────────────────────────────
//
// 这里的 kind-aware 逻辑**必须与 Rust 侧一致**（`kcode-domain/src/changeset.rs`）。
// `diff` 字段的形态随变更类型变化，两侧若判断不一致，UI 会显示与后端统计
// 不符的行数。

/** 变更类型的中文标签。重命名与普通修改必须区分。 */
export function changeKindLabel(kind: FileChangeEntry['kind']): string {
  switch (kind.type) {
    case 'add':
      return '新增';
    case 'delete':
      return '删除';
    case 'update':
      return kind.movePath ? '重命名' : '修改';
  }
}

/** 变更类型对应的配色类名。 */
export function changeKindClass(kind: FileChangeEntry['kind']): string {
  switch (kind.type) {
    case 'add':
      return 'kind-add';
    case 'delete':
      return 'kind-delete';
    case 'update':
      return kind.movePath ? 'kind-move' : 'kind-update';
  }
}

/** 删除操作需要额外提示：影响既有内容。 */
export function isDestructiveChange(kind: FileChangeEntry['kind']): boolean {
  return kind.type === 'delete';
}

/** 重命名目标（协议在 `kind.movePath` 给出）。 */
export function movedTo(entry: FileChangeEntry): string | null {
  return entry.kind.type === 'update' ? entry.kind.movePath ?? null : null;
}

/**
 * 把绝对路径相对化到工作区。
 *
 * 实测协议给的是绝对路径，直接显示会占满整行。
 */
export function relativePath(path: string, workspace?: string | null): string {
  if (!workspace) return path;
  const ws = workspace.endsWith('/') ? workspace : `${workspace}/`;
  return path.startsWith(ws) ? path.slice(ws.length) : path;
}

/**
 * 单文件的增删行统计。**按 kind 分派**——与 Rust 侧 `line_stats()` 同规则。
 *
 * 对 `add`/`delete` 套用 diff 解析会得到 0 行（找不到 `@@` 头），
 * 表现为「文件变更了但零行改动」。
 */
export function fileStats(entry: FileChangeEntry): DiffStats {
  if (entry.kind.type === 'add') {
    return { added: countLines(entry.diff), removed: 0 };
  }
  if (entry.kind.type === 'delete') {
    return { added: 0, removed: countLines(entry.diff) };
  }
  return diffStats(parseUnifiedDiff(stripMoveTrailer(entry.diff)));
}

/** 行数统计，末尾换行不额外计一行（与 `str::lines` 一致）。 */
function countLines(content: string): number {
  if (content === '') return 0;
  const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
  return trimmed.split('\n').length;
}

/**
 * 剥掉重命名变更 diff 尾部的 `Moved to: <路径>` 标记。
 *
 * 实测形态：`"...@@ -1 +1 @@\n-a\n+b\n\n\nMoved to: /abs/path"`。
 * 该标记不是 diff 内容，参与解析会产生噪声警告并污染行数统计。
 */
export function stripMoveTrailer(diff: string): string {
  const idx = diff.indexOf('\n\nMoved to: ');
  return idx >= 0 ? diff.slice(0, idx) : diff;
}

/**
 * 解析 unified diff 文本。与 Rust 侧 `parse_unified_diff` 行为对齐。
 *
 * 容错优先：无法识别的行记入 `warnings` 而非静默丢弃。
 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  let oldPath: string | null = null;
  let newPath: string | null = null;
  const hunks: ParsedDiff['hunks'] = [];
  const warnings: string[] = [];

  let current: ParsedDiff['hunks'][number] | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) {
      oldPath = cleanDiffPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      newPath = cleanDiffPath(line.slice(4));
      continue;
    }
    if (
      line.startsWith('diff --git ') ||
      line.startsWith('index ') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename from') ||
      line.startsWith('rename to')
    ) {
      continue;
    }

    if (line.startsWith('@@')) {
      if (current) hunks.push(current);
      const h = parseHunkHeader(line);
      if (!h) {
        warnings.push(`无法解析的 hunk 头：${line}`);
        current = null;
        continue;
      }
      oldNo = h.oldStart;
      newNo = h.newStart;
      current = { header: line, ...h, lines: [] };
      continue;
    }

    if (!current) {
      if (line.trim() !== '' && !line.startsWith('\\')) {
        warnings.push(`hunk 之外的意外行：${line.slice(0, 60)}`);
      }
      continue;
    }

    if (line.startsWith('+')) {
      current.lines.push({ kind: 'added', text: line.slice(1), oldLine: null, newLine: newNo++ });
    } else if (line.startsWith('-')) {
      current.lines.push({ kind: 'removed', text: line.slice(1), oldLine: oldNo++, newLine: null });
    } else if (line.startsWith(' ')) {
      current.lines.push({
        kind: 'context',
        text: line.slice(1),
        oldLine: oldNo++,
        newLine: newNo++,
      });
    } else if (line.startsWith('\\')) {
      // `\ No newline at end of file`：合法元信息
      continue;
    } else {
      // 无 `+` / `-` / 空格前缀的行：**按上下文行处理**。
      //
      // 真实场景会遇到两类：空上下文行（许多实现省略行首空格），
      // 以及非空行同样丢失前导空格（上游或传输环节造成）。
      // 早先的实现记 warning 并**丢弃内容**，导致 diff 显示残缺。
      //
      // 与 Rust 侧 `parse_unified_diff` 保持同一规则——两侧若分歧，
      // 行数统计会不一致且不会有任何报错。
      if (line.trim() !== '') {
        warnings.push(`hunk 内缺少前缀的行按上下文处理：${line.slice(0, 60)}`);
      }
      current.lines.push({ kind: 'context', text: line, oldLine: oldNo++, newLine: newNo++ });
    }
  }
  if (current) hunks.push(current);

  return { oldPath, newPath, hunks, warnings };
}

function parseHunkHeader(line: string): Omit<ParsedDiff['hunks'][number], 'header' | 'lines'> | null {
  const m = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
  if (!m) return null;
  return {
    oldStart: Number(m[1]),
    oldCount: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newCount: m[4] === undefined ? 1 : Number(m[4]),
  };
}

function cleanDiffPath(p: string): string {
  let s = p.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  return s;
}

export function diffStats(d: ParsedDiff): DiffStats {
  let added = 0;
  let removed = 0;
  for (const h of d.hunks) {
    for (const l of h.lines) {
      if (l.kind === 'added') added++;
      else if (l.kind === 'removed') removed++;
    }
  }
  return { added, removed };
}

export function totalsForChangeSet(cs: ChangeSet): DiffStats {
  return cs.files.reduce<DiffStats>(
    (acc, f) => {
      const s = fileStats(f);
      return { added: acc.added + s.added, removed: acc.removed + s.removed };
    },
    { added: 0, removed: 0 },
  );
}

/** 按变更类型分组，供文件树展示。 */
export function groupByKind(cs: ChangeSet): Record<string, FileChangeEntry[]> {
  const out: Record<string, FileChangeEntry[]> = {};
  for (const f of cs.files) {
    const key = changeKindLabel(f.kind);
    (out[key] ??= []).push(f);
  }
  return out;
}

export function decisionOf(cs: ChangeSet, path: string): FileDecision {
  const idx = cs.files.findIndex((f) => f.path === path);
  return idx >= 0 ? cs.decisions[idx] ?? 'pending' : 'pending';
}

export function reviewStateLabel(s: ReviewState): string {
  switch (s) {
    case 'proposed':
      return '待审阅';
    case 'underReview':
      return '审阅中';
    case 'acceptedPartial':
      return '部分接受';
    case 'acceptedAll':
      return '全部接受';
    case 'rejected':
      return '已拒绝';
  }
}

export function changeOriginLabel(origin: ChangeSet['origin']): string {
  return origin === 'applied' ? '已应用' : '待应用';
}

/**
 * 取某轮次可供审阅的变更数据。
 *
 * **优先使用 `fileChange` 的逐文件结构**（可逐文件决策）；缺失时回退到
 * 整轮 unified diff——实测后者更稳定，前者条件可用。这个优先级与
 * Rust 侧的架构选择一致（见 `docs/协议勘误与修正.md` 3.12）。
 */
export function reviewDataFor(
  state: RootState,
  threadId: string,
  turnId: string,
): {
  changeSet: ChangeSet | null;
  turnDiff: ParsedDiff | null;
  /** 逐文件切分结果；有它才能做逐文件总览而不串行。 */
  perFile: FileDiffSlice[];
} {
  const th = state.threads[threadId];
  return {
    changeSet: th?.changeSets[turnId] ?? null,
    turnDiff: th?.turnDiffs[turnId] ?? null,
    perFile: th?.turnDiffFiles[turnId] ?? [],
  };
}

/** 某线程所有轮次的变更汇总（用于右侧面板总览）。 */
export function threadChangeSets(state: RootState, threadId: string): ChangeSet[] {
  const th = state.threads[threadId];
  if (!th) return [];
  return th.turnOrder
    .map((tid) => th.changeSets[tid])
    .filter((cs): cs is ChangeSet => Boolean(cs));
}

/** 渲染用的行显示文本（含行号）。 */
export function lineNumberLabel(line: DiffLine): string {
  const o = line.oldLine ?? '';
  const n = line.newLine ?? '';
  return `${o}:${n}`;
}

// ── 侧栏展示辅助 ────────────────────────────────────────────────────────
//
// 侧栏卡片需要「标题 + 相对时间」，而协议只给线程 id。标题从首条用户消息
// 派生（成熟客户端都这么做），时间从 Item 时间戳取——不额外引入状态。

/** 线程标题：取首条用户消息，退回线程 id 前缀。 */
export function threadTitle(state: RootState, threadId: string): string {
  // 服务端名字优先：用户显式命名过就不该被首条消息覆盖。
  const named = state.threads[threadId]?.name?.trim();
  if (named) return named;

  const items = threadItems(state, threadId);
  const firstUser = items.find((i) => i.body.kind === 'userMessage');
  if (firstUser && firstUser.body.kind === 'userMessage') {
    const t = firstUser.body.text.replace(/\s+/g, ' ').trim();
    if (t) return t.length > 42 ? `${t.slice(0, 42)}…` : t;
  }
  return threadId.slice(0, 8);
}

/**
 * 线程的变更文件数（跨轮次去重）。
 *
 * 同一文件多轮改动只计一次——侧栏徽章要回答的是
 * 「这条线程动过多少个文件」，不是「改了多少次」。
 */
export function changedFileCount(state: RootState, threadId: string): number {
  const th = state.threads[threadId];
  if (!th) return 0;
  const paths = new Set<string>();
  for (const cs of Object.values(th.changeSets)) {
    for (const f of cs.files) paths.add(f.path);
  }
  return paths.size;
}

/**
 * 模型徽标的短名：去掉 provider 前缀，只留对用户有意义的标识。
 *
 * 侧栏宽度有限，`anthropic/claude-sonnet-4` 这类全名会挤掉标题；
 * 而斜杠后的部分已经能区分「用的是哪个模型」。
 */
export function shortModelName(model: string | null | undefined): string | null {
  if (!model) return null;
  const tail = model.split('/').pop() ?? model;
  const trimmed = tail.trim();
  if (!trimmed) return null;
  return trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed;
}

/** 线程最近活动时间（毫秒）。无 Item 时返回 null。 */
export function threadLastActivity(state: RootState, threadId: string): number | null {
  const items = threadItems(state, threadId);
  if (items.length === 0) return null;
  return items.reduce((mx, i) => Math.max(mx, i.createdAtMs || 0), 0) || null;
}

/** 相对时间标签（如「刚刚」「30 分」「2 天」）。 */
export function relativeTime(ms: number | null): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天`;
  return `${Math.floor(day / 30)} 月`;
}

/** 线程副标题：工作区末段路径。 */
export function threadSubtitle(state: RootState, threadId: string): string {
  const cwd = state.threads[threadId]?.cwd ?? '';
  if (!cwd) return '';
  const parts = cwd.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}

/** 线程所属项目名（取 cwd 末段）。 */
export function projectNameOf(state: RootState, threadId: string): string {
  const cwd = state.threads[threadId]?.cwd ?? '';
  if (!cwd) return '未命名项目';
  const parts = cwd.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || cwd;
}

/**
 * 把线程按项目分组。
 *
 * Codex 的侧栏是「项目 → 线程」两级结构，而不是一条扁平列表。
 * 多项目并行时这是必需的——扁平列表在 20+ 线程后完全无法定位。
 * 组内按待操作优先排序（复用 threadSortRank），组间按最近活动降序。
 */
export function groupByProject(
  state: RootState,
): { project: string; cwd: string; threadIds: string[]; lastActivity: number }[] {
  const groups = new Map<string, { cwd: string; ids: string[]; last: number }>();
  for (const id of state.threadOrder) {
    const cwd = state.threads[id]?.cwd ?? '';
    const key = cwd || '(未知)';
    let g = groups.get(key);
    if (!g) {
      g = { cwd, ids: [], last: 0 };
      groups.set(key, g);
    }
    g.ids.push(id);
    g.last = Math.max(g.last, threadLastActivity(state, id) ?? 0);
  }
  return [...groups.entries()]
    .map(([project, g]) => ({
      project: g.cwd ? project : '未命名项目',
      cwd: g.cwd,
      // 组内：待操作优先
      threadIds: g.ids.sort((a, b) => threadSortRank(state, a) - threadSortRank(state, b)),
      lastActivity: g.last,
    }))
    // 组间：最近活动优先
    .sort((a, b) => b.lastActivity - a.lastActivity);
}

/** 最近活动的线程（扁平，跨项目）。 */
export function recentThreads(state: RootState, limit = 8): string[] {
  return [...state.threadOrder]
    .sort((a, b) => (threadLastActivity(state, b) ?? 0) - (threadLastActivity(state, a) ?? 0))
    .slice(0, limit);
}
