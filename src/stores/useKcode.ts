/**
 * 连接后端与应用状态的 React 绑定。
 *
 * 前端**只消费领域事件**（`AppEvent`），不接触协议报文。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  AppEvent,
  ApprovalDecision,
  EnvironmentInfo,
  ThreadInfo,
  GitStatus,
  ModelOption,
  PermissionMode,
  PluginInfo,
  SettingsSnapshot,
  SkillInfo,
  RightContent,
  ThreadSnapshot,
  WebElementAttachment,
  ThreadSummary,
} from '../types/domain';
import { initialState, reduce, type RootState } from './store';
import type { ChangeSet, FileDecision, ReviewState } from '../types/domain';

/**
 * 本地应用一条文件决策，重算审阅状态。
 *
 * **必须与 Rust 侧 `ChangeSet::recompute_state` 保持同一规则**——
 * 两侧算出的状态若不一致，UI 会显示与后端不同的结论且不会有任何报错。
 * 因此这里逐条对应，并有两侧各自的测试守护。
 */
function applyDecisionLocally(
  cs: ChangeSet,
  path: string,
  decision: 'accepted' | 'rejected',
): ChangeSet {
  const idx = cs.files.findIndex((f) => f.path === path);
  if (idx < 0) return cs;
  const decisions: FileDecision[] = [...cs.decisions];
  decisions[idx] = decision;
  const total = cs.files.length;
  const accepted = decisions.filter((d) => d === 'accepted').length;
  const rejected = decisions.filter((d) => d === 'rejected').length;
  const pending = decisions.filter((d) => d === 'pending').length;

  let reviewState: ReviewState;
  if (pending === total) reviewState = 'proposed';
  else if (pending > 0) reviewState = 'underReview';
  else if (accepted === total) reviewState = 'acceptedAll';
  else if (rejected === total) reviewState = 'rejected';
  else reviewState = 'acceptedPartial';

  return { ...cs, decisions, reviewState };
}

/** 判断是否运行在 Tauri 环境中（浏览器里跑单测时为 false）。 */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * 从各种形态的抛出值中提取可读信息。
 *
 * **不能用 `String(e)`**：Tauri 的 `invoke` 在命令返回 `Err` 时抛出的是
 * 反序列化后的对象（我们的 `CommandError` 形如 `{ message: string }`），
 * 直接字符串化会得到 `[object Object]`——用户看到的是一句无意义的占位符，
 * 真正的失败原因完全丢失。
 */
export function extractErrorMessage(e: unknown): string {
  if (e == null) return '未知错误';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (typeof e === 'object') {
    const o = e as Record<string, unknown>;
    // Tauri 命令错误的标准形态
    if (typeof o.message === 'string') return o.message;
    // 嵌套的 error 字段（部分 Tauri 版本）
    if (typeof o.error === 'string') return o.error;
    if (o.error && typeof o.error === 'object') {
      const inner = (o.error as Record<string, unknown>).message;
      if (typeof inner === 'string') return inner;
    }
    // 兜底：尝试序列化，失败则退回类型名
    try {
      const json = JSON.stringify(o);
      if (json && json !== '{}') return json;
    } catch {
      /* 循环引用等，忽略 */
    }
    return Object.prototype.toString.call(e);
  }
  return String(e);
}

export interface KcodeApi {
  state: RootState;
  models: ModelOption[];
  /** 线程搜索关键词；空串表示不过滤。 */
  searchTerm: string;
  setSearchTerm: (t: string) => void;
  git: GitStatus | null;
  gitRemote: string | null;
  refreshGit: () => Promise<void>;
  commitAll: (message: string) => Promise<void>;
  pushBranch: () => Promise<void>;
  skills: SkillInfo[];
  plugins: PluginInfo[];
  loadSkills: () => Promise<void>;
  loadPlugins: () => Promise<void>;
  selectedModel: string | null;
  selectedEffort: string | null;
  setModel: (id: string | null) => void;
  setEffort: (e: string | null) => void;
  env: EnvironmentInfo | null;
  activeThreadId: string | null;
  selectThread: (id: string) => void;
  startRuntime: () => Promise<void>;
  createThread: () => Promise<void>;
  refreshThreads: () => Promise<string[]>;
  openThread: (threadId: string) => Promise<void>;
  sendTurn: (text: string) => Promise<void>;
  decide: (requestId: string, decision: ApprovalDecision, scope?: string) => Promise<void>;
  interrupt: (turnId: string) => Promise<void>;
  exportAudit: () => Promise<string>;
  decideFile: (turnId: string, path: string, decision: 'accepted' | 'rejected') => Promise<void>;
  /** 当前设置。null = 尚未读取。 */
  settings: SettingsSnapshot | null;
  /** 切换权限档位；写入 config.toml，对新线程生效。 */
  setPermissionMode: (mode: PermissionMode) => Promise<void>;
  /** 重新读取设置。 */
  reloadSettings: () => Promise<void>;
  /** 订阅连接级事件（终端输出）。返回取消订阅函数。 */
  subscribe: (fn: (e: AppEvent) => void) => () => void;
  /** 把选中的网页元素作为附件加入输入框。 */
  appendComposer: (el: WebElementAttachment) => void;
  /** 待加入的附件；Composer 消费后调用 clearPendingInput。 */
  pendingInput: WebElementAttachment | null;
  clearPendingInput: () => void;
  /** 右栏当前展示的内容视图；null 表示只看状态面板。 */
  rightContent: RightContent | null;
  openInRight: (c: RightContent | null) => void;
  /** 把一条错误推给用户可见的提示区（与内部失败同一通道）。 */
  reportError: (message: string) => void;
}

export function useKcode(): KcodeApi {
  const [state, setState] = useState<RootState>(initialState);
  const [env, setEnv] = useState<EnvironmentInfo | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  /** 设置快照。null = 尚未读取（界面据此显示占位而不是猜一个默认值）。 */
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [rightContent, setRightContent] = useState<RightContent | null>(null);
  /**
   * 待追加到输入框的文本。
   *
   * 走一个单向的「待办」而不是让工作台直接操作 Composer：
   * Composer 的文本是它自己的 state，外部改不了；而把文本提升到
   * 全局又会让它每次按键都触发整棵树重渲染。
   */
  const [pendingInput, setPendingInput] = useState<WebElementAttachment | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedEffort, setSelectedEffort] = useState<string | null>(null);
  /** 事件回调里要用最新的 refreshGit，用 ref 避免重建订阅。 */
  const refreshGitRef = useRef<(() => Promise<void>) | null>(null);
  /** 同上：启动流程里要用最新的 reloadSettings，避免把它加进 effect 依赖。 */
  const reloadSettingsRef = useRef<(() => Promise<void>) | null>(null);
  /** 终端等「连接级」事件的订阅者。见事件订阅处的说明。 */
  const listenersRef = useRef<Set<(e: AppEvent) => void>>(new Set());
  const [git, setGit] = useState<GitStatus | null>(null);
  const [gitRemote, setGitRemote] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  // 用 ref 持有 openThread，避免 startRuntime 与 openThread 的相互依赖
  const openThreadRef = useRef<((id: string) => Promise<void>) | null>(null);
  const activeRef = useRef<string | null>(null);

  // 事件订阅：领域事件按 upsert 归约进状态。
  useEffect(() => {
    if (!inTauri()) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;

    listen<AppEvent>('kcode:event', (ev) => {
      const payload = ev.payload;
      // 终端事件不进 reducer：它们没有 threadId，是连接级而非线程级状态。
      // 塞进 reducer 会被线程切换/重放清掉，终端内容就凭空消失了。
      if (payload.type === 'terminalDelta' || payload.type === 'terminalExited') {
        for (const fn of listenersRef.current) fn(payload);
        return;
      }
      setState((prev) => reduce(prev, payload));
      // 轮次结束时刷新 git 状态：Agent 可能改了文件或建了提交，
      // 面板上的「更改 +N −M」必须跟着变。
      if (payload.type === 'turnCompleted') {
        void refreshGitRef.current?.();
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const startRuntime = useCallback(async () => {
    if (!inTauri()) return;
    try {
      await invoke('start_runtime');
      const info = await invoke<EnvironmentInfo>('environment_info');
      setEnv(info);
      setState((prev) => ({ ...prev, ready: true }));

      // **加载历史线程**：进程内状态在重启后消失，事件日志不会。
      // 不调用这一步，重启应用后侧栏会是空的——「可恢复」就只停留在
      // 后端能力上，用户完全看不到。
      //
      // 注意这里还要**自动打开最近一个线程**：只填侧栏而不加载内容，
      // 用户看到的是「侧栏有任务、主区空白」的状态，仍然需要手动点一下
      // 才能看到历史。这与「重启后能看到之前的工作」的预期不符。
      await refreshGit();
      // 读取设置：权限档位与 provider 是提交前必须可见的前提
      await reloadSettingsRef.current?.();
      const ids = await refreshThreads();
      // 自动打开最近活动的线程，让用户重启后直接看到上次的工作内容
      if (ids.length > 0) {
        await openThreadRef.current?.(ids[0]);
      }

      // 加载模型目录。
      //
      // **不要据此自动选一个默认模型。** `model/list` 返回的是 app-server
      // 内置的 OpenAI 目录（gpt-6-astra 等），它**与当前配置的 provider 无关**：
      // 配了 DeepSeek 时，这里的 `isDefault` 仍然是 gpt-6-astra，把它作为
      // model 覆盖传给 turn/start 会被 provider 直接拒绝——
      //
      //   The supported API model names are deepseek-flash, deepseek-v4-pro,
      //   but you passed gpt-6-astra.
      //
      // 结果是**每一轮都失败**，而错误信息指向模型名，看起来像用户的配置问题。
      // 所以默认必须是「不覆盖」：让 app-server 用 config.toml 里的 model。
      // 用户主动从下拉里选一个，才发送覆盖。
      try {
        setModels(await invoke<ModelOption[]>('list_models'));
      } catch (e) {
        // 模型列表失败不阻塞使用——仍可用后端默认模型
        setState((prev) => ({
          ...prev,
          errors: [...prev.errors, `模型列表加载失败：${extractErrorMessage(e)}`],
        }));
      }
    } catch (e) {
      setState((prev) => ({ ...prev, errors: [...prev.errors, extractErrorMessage(e)] }));
    }
  }, []);

  const createThread = useCallback(async () => {
    if (!inTauri()) return;
    try {
      const info = await invoke<ThreadInfo>('start_thread', {
        cwd: env?.workspace ?? '',
        model: null,
        // 默认工作区可写 + 边界外需审批；不使用 danger-full-access
        sandbox: 'workspace-write',
        approvalPolicy: 'on-request',
      });
      activeRef.current = info.threadId;
      // 后端已广播 ThreadStarted，但这里也直接写入本地状态作为兜底：
      // 若事件订阅尚未建立（启动竞态），用户仍能立刻看到新线程。
      // 覆盖式写入是安全的——reduce 对同一线程是幂等的。
      setState((prev) => {
        const next = reduce(prev, {
          type: 'threadStarted',
          threadId: info.threadId,
          cwd: info.cwd,
        });
        return { ...next, activeThreadId: info.threadId };
      });
    } catch (e) {
      setState((prev) => ({ ...prev, errors: [...prev.errors, extractErrorMessage(e)] }));
    }
  }, [env?.workspace]);

  /**
   * 按关键词搜索线程。
   *
   * 走服务端 `thread/list` 的 `searchTerm`——它能搜到本机其它入口
   * （CLI、IDE 扩展）创建的线程，只搜本地事件日志达不到。
   */
  const searchThreads = useCallback(async (term: string) => {
    setSearchTerm(term);
    if (!inTauri()) return;
    try {
      const list = await invoke<ThreadSummary[]>('list_threads_remote', {
        searchTerm: term.trim() || null,
      });
      setState((prev) => {
        let next = prev;
        for (const t of list) {
          next = reduce(next, { type: 'threadStarted', threadId: t.threadId, cwd: t.cwd });
        }
        return next;
      });
    } catch (e) {
      setState((prev) => ({ ...prev, errors: [...prev.errors, extractErrorMessage(e)] }));
    }
  }, []);

  /**
   * 查询 git 状态。
   *
   * 轮次结束时也需要刷新——Agent 可能改了文件或建了提交，
   * 面板上的「更改 +N −M」必须跟着变。
   */
  const refreshGit = useCallback(async () => {
    if (!inTauri()) return;
    try {
      setGit(await invoke<GitStatus>('git_status'));
      // remote 也一并读取——推送按钮需要展示目标
      setGitRemote(await invoke<string | null>('git_remote'));
    } catch (e) {
      setState((prev) => ({ ...prev, errors: [...prev.errors, extractErrorMessage(e)] }));
    }
  }, []);

  /**
   * 提交全部改动。
   *
   * 错误**向上抛**而不是塞进全局错误列表——提交失败的原因
   * （`nothing to commit`、`user.email 未配置`）是操作性的，
   * 应当显示在 Git 面板内、紧邻按钮的位置。
   */
  const commitAll = useCallback(async (message: string) => {
    if (!inTauri()) return;
    try {
      await invoke('git_commit', { message });
      await refreshGit();
    } catch (e) {
      throw new Error(extractErrorMessage(e));
    }
  }, [refreshGit]);

  /** 推送当前分支。网络操作，调用方必须先让用户确认目标。 */
  const pushBranch = useCallback(async () => {
    if (!inTauri()) return;
    try {
      await invoke('git_push');
      await refreshGit();
    } catch (e) {
      throw new Error(extractErrorMessage(e));
    }
  }, [refreshGit]);

  /** 加载当前工作区可见的技能。 */
  const loadSkills = useCallback(async () => {
    if (!inTauri()) return;
    try {
      setSkills(await invoke<SkillInfo[]>('list_skills'));
    } catch (e) {
      setState((prev) => ({ ...prev, errors: [...prev.errors, extractErrorMessage(e)] }));
    }
  }, []);

  /** 加载插件市场与已安装插件。 */
  const loadPlugins = useCallback(async () => {
    if (!inTauri()) return;
    try {
      setPlugins(await invoke<PluginInfo[]>('list_plugins'));
    } catch (e) {
      setState((prev) => ({ ...prev, errors: [...prev.errors, extractErrorMessage(e)] }));
    }
  }, []);


  /**
   * 从事件日志刷新线程列表（启动时与需要时调用）。
   *
   * 返回按最近活动排序的线程 id 列表，供调用方决定接着打开哪个。
   */
  const refreshThreads = useCallback(async (): Promise<string[]> => {
    if (!inTauri()) return [];
    try {
      const list = await invoke<ThreadSummary[]>('list_threads');
      setState((prev) => {
        let next = prev;
        for (const t of list) {
          next = reduce(next, { type: 'threadStarted', threadId: t.threadId, cwd: t.cwd });
        }
        // 崩溃残留的轮次需要提示用户「结果未知」
        const warnings = list
          .filter((t) => t.hasUnfinishedTurn)
          .map((t) => `线程 ${t.threadId.slice(0, 8)} 存在未完成的轮次，结果未知`);
        return { ...next, errors: [...next.errors, ...warnings] };
      });
      return list.map((t) => t.threadId);
    } catch (e) {
      setState((prev) => ({ ...prev, errors: [...prev.errors, extractErrorMessage(e)] }));
      return [];
    }
  }, []);

  /**
   * 打开线程：从事件日志重建其时间线。
   *
   * 重建是幂等的，因此每次打开都调用是安全的——这保证了「刷新页面」
   * 或「切换线程再切回来」不会丢内容。
   */
  const openThread = useCallback(async (threadId: string) => {
    activeRef.current = threadId;
    setState((prev) => ({ ...prev, activeThreadId: threadId }));
    if (!inTauri()) return;
    try {
      const snap = await invoke<ThreadSnapshot>('load_thread', { threadId });
      setState((prev) => {
        let next = reduce(prev, { type: 'threadStarted', threadId: snap.threadId, cwd: snap.cwd });
        for (const item of snap.items) {
          // 从日志重建的 Item 均已是落盘终态，因此标记 completed
          next = reduce(next, {
            type: 'itemUpserted',
            threadId: snap.threadId,
            turnId: item.turnId,
            item,
            completed: true,
          });
        }
        for (const t of snap.turns) {
          next = reduce(next, {
            type: 'turnCompleted',
            threadId: snap.threadId,
            turnId: t.turnId,
            status: t.status,
          });
        }
        // 变更集（含已持久化的审阅决策）——不重建的话，
        // 重启后 Diff 面板空白，用户以为自己的审阅结论丢了
        for (const cs of snap.changeSets) {
          next = reduce(next, {
            type: 'changeSetReplaced',
            threadId: snap.threadId,
            turnId: cs.turnId,
            changeSet: cs,
          });
        }
        const warnings = snap.warnings.map((w) => `线程 ${snap.threadId.slice(0, 8)}: ${w}`);
        return { ...next, errors: [...next.errors, ...warnings] };
      });
    } catch (e) {
      setState((prev) => ({ ...prev, errors: [...prev.errors, extractErrorMessage(e)] }));
    }
  }, []);

  openThreadRef.current = openThread;

  const sendTurn = useCallback(async (text: string) => {
    const threadId = activeRef.current;
    if (!inTauri() || !threadId) return;
    try {
      await invoke<string>('send_turn', {
        threadId,
        text,
        model: selectedModel,
        effort: selectedEffort,
      });
    } catch (e) {
      setState((prev) => ({ ...prev, errors: [...prev.errors, extractErrorMessage(e)] }));
    }
  }, [selectedModel, selectedEffort]);

  const decide = useCallback(
    async (requestId: string, decision: ApprovalDecision, scope?: string) => {
      if (!inTauri()) return;
      try {
        await invoke('resolve_approval', { requestId, decision, scope });
      } catch (e) {
        setState((prev) => ({ ...prev, errors: [...prev.errors, extractErrorMessage(e)] }));
      }
    },
    [],
  );

  const interrupt = useCallback(async (turnId: string) => {
    const threadId = activeRef.current;
    if (!inTauri() || !threadId) return;
    try {
      await invoke('interrupt', { threadId, turnId });
    } catch (e) {
      setState((prev) => ({ ...prev, errors: [...prev.errors, extractErrorMessage(e)] }));
    }
  }, []);

  /**
   * 记录文件级审阅决策。
   *
   * **同时写后端与本地状态**：后端负责持久化（刷新后仍在），
   * 本地立即更新避免等待往返造成点击迟滞感。
   */
  const decideFile = useCallback(
    async (turnId: string, path: string, decision: 'accepted' | 'rejected') => {
      const threadId = activeRef.current;
      if (!threadId) return;
      // 先更新本地：交互要即时
      setState((prev) => {
        const th = prev.threads[threadId];
        const cs = th?.changeSets[turnId];
        if (!cs) return prev;
        return reduce(prev, {
          type: 'changeSetReplaced',
          threadId,
          turnId,
          changeSet: applyDecisionLocally(cs, path, decision),
        });
      });
      if (!inTauri()) return;
      try {
        await invoke('decide_file', { threadId, turnId, path, decision });
      } catch (e) {
        setState((prev) => ({ ...prev, errors: [...prev.errors, extractErrorMessage(e)] }));
      }
    },
    [],
  );

  const exportAudit = useCallback(async () => {
    if (!inTauri()) return '';
    return invoke<string>('export_audit');
  }, []);

  const selectThread = useCallback((id: string) => {
    activeRef.current = id;
    setState((prev) => ({ ...prev, activeThreadId: id }));
  }, []);

  // 保持 activeRef 与状态同步（activeThreadId 可能由事件设置）
  useEffect(() => {
    if (state.activeThreadId && !activeRef.current) {
      activeRef.current = state.activeThreadId;
    }
  }, [state.activeThreadId]);

  /** 读取设置。失败不抛出——设置读不到不应让整个界面进入错误态。 */
  const reloadSettings = useCallback(async () => {
    if (!inTauri()) return;
    try {
      setSettings(await invoke<SettingsSnapshot>('read_settings'));
    } catch (e) {
      setState((prev) => ({
        ...prev,
        errors: [...prev.errors, `读取设置失败：${extractErrorMessage(e)}`],
      }));
    }
  }, []);

  /**
   * 切换权限档位。
   *
   * 后端会写入 config.toml，**对新线程生效**——已在运行的线程保持
   * 启动时的策略（协议层 thread/start 的覆盖不写回配置）。
   * 写成功后重新读取，让界面显示的是落盘后的真实值而不是乐观假设。
   */
  const setPermissionMode = useCallback(async (mode: PermissionMode) => {
    if (!inTauri()) return;
    try {
      await invoke('set_permission_mode', { mode });
      await reloadSettings();
    } catch (e) {
      setState((prev) => ({
        ...prev,
        errors: [...prev.errors, `切换权限档位失败：${extractErrorMessage(e)}`],
      }));
    }
  }, [reloadSettings]);

  useEffect(() => {
    reloadSettingsRef.current = reloadSettings;
  }, [reloadSettings]);

  const activeThreadId = useMemo(
    () => state.activeThreadId ?? null,
    [state.activeThreadId],
  );

  return {
    state,
    env,
    git,
    gitRemote,
    refreshGit,
    commitAll,
    pushBranch,
    models,
    searchTerm,
    setSearchTerm: (t: string) => void searchThreads(t),
    skills,
    plugins,
    loadSkills,
    loadPlugins,
    selectedModel,
    selectedEffort,
    setModel: setSelectedModel,
    setEffort: setSelectedEffort,
    activeThreadId,
    selectThread,
    startRuntime,
    createThread,
    refreshThreads,
    openThread,
    sendTurn,
    decide,
    interrupt,
    exportAudit,
    decideFile,
    settings,
    setPermissionMode,
    reloadSettings,
    rightContent,
    openInRight: setRightContent,
    appendComposer: useCallback((el: WebElementAttachment) => setPendingInput(el), []),
    pendingInput,
    clearPendingInput: useCallback(() => setPendingInput(null), []),
    subscribe: useCallback((fn: (e: AppEvent) => void) => {
      listenersRef.current.add(fn);
      return () => {
        listenersRef.current.delete(fn);
      };
    }, []),
    reportError: useCallback((message: string) => {
      setState((prev) => ({ ...prev, errors: [...prev.errors, message] }));
    }, []),
  };
}
