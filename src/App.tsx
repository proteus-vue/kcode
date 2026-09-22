/**
 * 三栏布局：任务栏 · 时间线 · 进程与审批。
 *
 * 视觉语言参考成熟客户端：半透明分层 + 背景模糊（液态玻璃），
 * 让「面板」有实体感而不是贴在背景上的色块。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ApprovalModal } from './components/ApprovalModal';
import { DiffViewer } from './components/DiffViewer';
import { Composer } from './components/Composer';
import { Sidebar } from './components/Sidebar';
import { PluginList, SkillList } from './components/LibraryPanel';
import { TurnView } from './components/TurnView';
import { Welcome } from './components/Welcome';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusDock } from './components/StatusDock';
import { useSlotRect } from './components/RightTabs';
import { BrowserPanel } from './components/BrowserPanel';
import { Workbench } from './components/Workbench';
import { TerminalPanel } from './components/TerminalPanel';
import { FileTree } from './components/FileTree';
import { fitViewport } from './components/viewportSize';
import {
  closeOthers,
  closeScene,
  openScene,
  type SceneAvailability,
  type WorkbenchScene,
} from './components/scenes';
import { useKcode, extractErrorMessage } from './stores/useKcode';
import { usePanelLayout } from './hooks/usePanelLayout';
import { useAutoScroll } from './hooks/useAutoScroll';
import { matchPanelShortcut, matchFocusComposerShortcut } from './hooks/panelShortcut';
import { onColumnBandDoubleClick, onTitlebarDoubleClick } from './hooks/titlebarZoom';
import { reviewDataFor, threadTitle } from './stores/store';
import { Icon } from './components/Icon';

/** 取 URL 的主机名用于标签文字；解析失败就退回原串。 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

/**
 * 权限档位的中文名与审批说明。
 *
 * 两半都必须从实际档位推导。此前审批那半是写死的「按需审批」——
 * 切到完全访问后它仍显示「按需审批」，而实际策略已是 never，
 * 界面对行为边界的描述是**错的**，比不显示更糟。
 */
const MODE_INFO: Record<string, { label: string; approval: string }> = {
  readOnly: { label: '只读', approval: '改动需批准' },
  workspaceWrite: { label: '工作区可写', approval: '按需审批' },
  fullAccess: { label: '完全访问权限', approval: '无需批准' },
};

export default function App() {
  const api = useKcode();
  const { state } = api;
  const [audit, setAudit] = useState<string | null>(null);
  /** 右侧面板的展示模式：审批/变更/技能/插件 共用一块区域，避免堆叠过长。 */
  const [panel, setPanel] = useState<'default' | 'skills' | 'plugins' | 'settings'>('default');
  const layout = usePanelLayout();
  /**
   * 已打开的工作台场景（顺序即标签顺序）与当前激活的那个。
   *
   * **必须是列表**：早前只用一个 `scene` 值表示「标签」，于是关闭
   * 无从下手——没有列表可减，只能置空，而置空后又会回退到第一个
   * 可用场景。表现就是「点关闭跑回了终端页」，用户看到的是跳转
   * 而不是关闭。
   *
   * 同时只显示一个场景：审查要高度、网页要面积、终端要行数，
   * 并行时互相挤压，谁都不可用。
   */
  const [openScenes, setOpenScenes] = useState<WorkbenchScene[]>(['review']);
  const [activeScene, setActiveScene] = useState<WorkbenchScene | null>('review');

  /**
   * 消息流的跟随滚动。
   *
   * 依赖信号用「轮次 + 该轮最后一条 Item + 流式缓冲长度」——任一变化
   * 都意味着有新内容需要跟随。只依赖轮次数量的话，一轮之内的大量
   * 流式增量不会触发判断，用户就看不到「自动滚动」。
   */
  const activeThread = state.activeThreadId ? state.threads[state.activeThreadId] : undefined;
  const lastTurnId = activeThread?.turnOrder[activeThread.turnOrder.length - 1];
  const lastTurn = lastTurnId ? activeThread?.turns[lastTurnId] : undefined;
  const lastItemId = lastTurn?.itemIds[lastTurn.itemIds.length - 1];
  const streamLen = lastItemId
    ? (activeThread?.streamBuffer[lastItemId]?.length ?? 0)
    : 0;
  const scrollSignal = `${state.activeThreadId ?? ''}:${activeThread?.turnOrder.length ?? 0}:${lastItemId ?? ''}:${streamLen}`;
  const scroll = useAutoScroll<HTMLDivElement>(scrollSignal);

  useEffect(() => {
    void api.startRuntime();
    // 仅在挂载时启动一次运行时
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 键盘快捷键：⌘B 切左栏、⌘⌥B 切右栏。
   *
   * 用 VS Code 的组合而不是自创——这两个键位在编辑器用户里已是肌肉记忆。
   * 输入框聚焦时也生效：⌘B 在 textarea 里没有原生含义
   * （macOS 的加粗只对富文本编辑器有效）。
   */
  /**
   * 内容视图的矩形 → 原生子 webview。
   *
   * 内置浏览器是**原生视图**，不参与 CSS 布局，永远绘制在 DOM 之上。
   * 因此每次矩形变化都必须同步位置：否则面板一折叠、标签一切换，
   * 浏览器还浮在原处（DOM 里完全看不出来）。
   *
   * 用 ResizeObserver 而非 window.resize：折叠、切标签、拖分栏都不会
   * 触发 window.resize，但都会改变这个矩形。
   */
  const content = api.rightContent;
  const syncBounds = useCallback(
    (r: { x: number; y: number; width: number; height: number }) => {
      // 尺寸无条件同步：它是「视口该怎么算」的输入，
      // 与是否可见无关（隐藏时也保留最后一次尺寸，展开后立即正确）。
      setSlotSize((prev) =>
        Math.abs(prev.width - r.width) < 0.5 && Math.abs(prev.height - r.height) < 0.5
          ? prev
          : { width: r.width, height: r.height },
      );
      if (!content || content.kind !== 'browser') return;
      // 只有「浏览器场景 + 右栏展开」时才让原生视图可见。
      // 其余情况一律传 0 尺寸隐藏它——原生视图不会随 DOM 消失。
      const shown = activeScene === 'browser' && !layout.rightCollapsed;
      void invoke('sync_browser_bounds', {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: shown ? Math.round(r.width) : 0,
        height: shown ? Math.round(r.height) : 0,
      }).catch(() => {
        /* 视图尚未创建时同步会被忽略——不是错误 */
      });
    },
    [content, activeScene, layout.rightCollapsed],
  );
  const contentRef = useRef<HTMLDivElement | null>(null);
  /**
   * 网页区域的可用尺寸。
   *
   * 模拟视口要靠它算：面板宽度决定页面按什么尺寸排版。
   * 侧栏折叠、窗口缩放都会改变它，所以放在 state 里而不是 ref——
   * 需要在变化时触发重新计算视口。
   */
  const [slotSize, setSlotSize] = useState({ width: 0, height: 0 });
  const setSlot = useSlotRect(syncBounds, Boolean(content));
  const slotRef = useCallback(
    (el: HTMLDivElement | null) => {
      contentRef.current = el;
      setSlot(el);
    },
    [setSlot],
  );

  /**
   * 打开内容视图。
   *
   * 浏览器走原生子视图（iframe 会被大多数站点的 X-Frame-Options 拒绝）；
   * 其余类型（文件、图片）直接在 DOM 里渲染。
   */
  useEffect(() => {
    if (!content) return;
    // 文件在「文件」场景里就地显示（树 + 详情），浏览器切到「浏览器」场景。
    // 顺带把它加入打开列表——否则「关掉浏览器标签后再打开一个网址」
    // 会发现标签不在列表里，工作台看起来没反应。
    activateScene(content.kind === 'browser' ? 'browser' : 'files');
    // 若右栏被折叠，自动展开——否则用户点了「在右栏打开」却什么都没发生
    if (layout.rightCollapsed) layout.toggleRight();

    if (content.kind === 'browser') {

      const r = contentRef.current?.getBoundingClientRect();
      // 初始尺寸按「适应窗口」的模拟视口算，与 BrowserPanel 的
      // onViewport 用同一套规则。若用 slot 的裸尺寸，页面会先按窄视口
      // 排一次版（闪一下移动端样式），再被 onViewport 纠正。
      const slotW = r?.width ?? 0;
      const slotH = r?.height ?? 0;
      const vp = slotW > 10 && slotH > 10 ? fitViewport(slotW, slotH) : null;
      void invoke('open_browser', {
        url: content.url,
        x: Math.round(r?.left ?? 0),
        y: Math.round(r?.top ?? 0),
        width: Math.round(vp ? vp.pixelWidth : slotW || 100),
        height: Math.round(vp ? vp.pixelHeight : slotH || 100),
      }).catch((e) => {
        api.reportError(`打开网址失败：${extractErrorMessage(e)}`);
      });
    }
    // slotRef 是稳定的 callback ref，不放进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);


  const { toggleLeft, toggleRight } = layout;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 判定逻辑见 panelShortcut.ts：那里解释了为什么必须看 e.code
      // （macOS 的 Option 会把 e.key 改写成 "∫"，导致右栏快捷键失效，
      // 而合成事件不会复现这一点）。
      const target = matchPanelShortcut(e);
      if (target) {
        e.preventDefault();
        if (target === 'right') toggleRight();
        else toggleLeft();
        return;
      }
      // ⌘L 聚焦输入框（规格 03 §3.4）。输入框不存在时不做任何事，
      // 更不 preventDefault——抢掉系统默认行为却无响应比不响应更糟。
      if (matchFocusComposerShortcut(e)) {
        const ta = document.querySelector<HTMLTextAreaElement>('.composer-box textarea');
        if (ta && !ta.disabled) {
          e.preventDefault();
          ta.focus();
          // 光标移到末尾：聚焦后直接续写，而不是回到开头
          const n = ta.value.length;
          ta.setSelectionRange(n, n);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleLeft, toggleRight]);

  const thread = api.activeThreadId ? state.threads[api.activeThreadId] : undefined;

  /** 当前工作区名——用于侧栏品牌区、欢迎语与输入区上下文芯片。 */
  const projectName = useMemo(() => {
    const ws = api.env?.workspace ?? '';
    if (!ws) return 'KCode';
    const parts = ws.replace(/\/+$/, '').split('/');
    return parts[parts.length - 1] || 'KCode';
  }, [api.env?.workspace]);

  const pending = useMemo(() => {
    const all = Object.values(thread?.pendingApprovals ?? {});
    return all[0] ?? null;
  }, [thread]);

  const latestTurnId = thread?.turnOrder[thread.turnOrder.length - 1];

  /**
   * 当前是否有轮次在跑。
   *
   * 用于输入区的「发送 ↔ 停止」切换。注意这与 `pending` 是两个信号：
   * 等待审批时轮次仍在进行（Agent 已挂起等待决策），此时应显示停止按钮
   * 而不是发送按钮——否则用户会以为任务已结束。
   */
  const running = useMemo(() => {
    if (!thread) return false;
    return thread.turnOrder.some((tid) => {
      const st = thread.turns[tid]?.status;
      return st === 'inProgress';
    });
  }, [thread]);

  const awaitingApproval = Boolean(pending);
  /** 顶栏权限芯片的两段文案，都来自实际配置而不是写死的默认值。 */
  const info = MODE_INFO[api.settings?.mode ?? 'workspaceWrite'] ?? MODE_INFO.workspaceWrite;
  const review = useMemo(
    () =>
      thread && latestTurnId
        ? reviewDataFor(state, thread.id, latestTurnId)
        : { changeSet: null, turnDiff: null },
    [state, thread, latestTurnId],
  );

  /**
   * 场景可用性。
   *
   * 没有内容的场景不进菜单——点开一个空面板，用户唯一的收获是
   * 「知道这里没东西」，不如一开始就别让他点。
   */
  const scenes: SceneAvailability = {
    // 审查：**始终可开**。
    // 早前要求「有变更集或 diff」才显示，理由是没内容的标签没意义。
    // 但那让用户的场景清单随线程状态变化——同一份界面在不同线程里
    // 少一项，看起来像功能缺失而不是「这里暂时没内容」。
    // 现在恒为 true，空态由面板内的说明承担（见下方「本轮没有文件改动」）。
    review: true,
    // 终端：任何工作区都能开（它是用户自己的命令，不依赖 Agent 活动）
    terminal: Boolean(api.env?.workspace),
    // 浏览器：始终可开，但需要用户输入地址
    browser: true,
    // 文件：有工作区路径
    files: Boolean(api.env?.workspace),
    // 侧边聊天：有线程上下文才有意义（技能/插件/设置都依赖已连接的运行时）
    chat: Boolean(api.env?.workspace),
  };

  /**
   * 打开列表按可用性过滤后的结果。
   *
   * 场景可能「不可用」了（例如切走线程后没有 diff）——那种标签必须
   * 撤掉，否则点开是空的。激活项随之回退到相邻的一个。
   */
  const openAvailable = openScenes.filter((id) => scenes[id]);
  const effectiveScene =
    activeScene && openAvailable.includes(activeScene)
      ? activeScene
      : (openAvailable[0] ?? null);

  /** 打开（或切到）一个场景。 */
  const activateScene = useCallback(
    (id: WorkbenchScene) => {
      setOpenScenes((prev) => openScene(prev, id));
      setActiveScene(id);
    },
    [],
  );

  /**
   * 关闭一个标签；关的是活动标签时激活其右邻（没有则左邻）。
   *
   * 用两个独立的状态更新而不是在 updater 里调另一个 setState：
   * updater 应当是纯函数（React 可能重复调用它），在里面触发副作用
   * 会让「关闭」这类操作被执行两次或落到错误的值上。
   */
  const closeSceneTab = useCallback(
    (id: WorkbenchScene) => {
      // 关掉浏览器标签要销毁原生子视图：它是原生视图，不随 DOM 消失
      if (id === 'browser') void invoke('close_browser').catch(() => {});
      const r = closeScene(openScenes, id, activeScene);
      setOpenScenes(r.list);
      setActiveScene(r.active);
    },
    [openScenes, activeScene],
  );

  const closeOtherTabs = useCallback(() => {
    const list = closeOthers(openScenes, activeScene);
    // 浏览器标签被关掉时销毁原生视图，否则它会一直浮在原位置
    if (!list.includes('browser')) void invoke('close_browser').catch(() => {});
    setOpenScenes(list);
    setActiveScene(list[0] ?? null);
  }, [openScenes, activeScene]);

  const closeAllTabs = useCallback(() => {
    void invoke('close_browser').catch(() => {});
    setOpenScenes([]);
    setActiveScene(null);
  }, []);

  return (
    <div
      ref={layout.containerRef}
      className={[
        'app',
        layout.leftCollapsed ? 'left-collapsed' : '',
        layout.rightCollapsed ? 'right-collapsed' : '',
        layout.animateCols ? 'cols-animating' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={
        {
          // 栏宽由拖拽决定，写成内联变量供 grid 消费。
          // 折叠时对应的 --col-* 会覆盖它们（见 styles.css）。
          '--col-left-w': `${layout.leftWidth}px`,
          '--col-right-w': `${layout.rightWidth}px`,
        } as React.CSSProperties
      }
    >
      {/* 窗口拖拽条。titleBarStyle: Overlay 下标题栏透明，窗口默认不可拖拽，
          必须显式提供拖拽区域，否则用户无法移动窗口。 */}
      <div className="window-drag-strip" data-tauri-drag-region aria-hidden="true" />

      {/* 面板开关。放在顶部空带里而非贴面板边缘：左栏宽度是 minmax 动态值，
          用 calc 推算边缘在窄窗下会把按钮漂到正文中间。 */}
      <div className="panel-toggles">
        <div className="toggle-group">
          <button
            className="toggle-btn toggle-left"
            aria-pressed={layout.leftCollapsed}
            onClick={layout.toggleLeft}
            title={layout.leftCollapsed ? '展开侧栏（⌘B）' : '折叠侧栏（⌘B）'}
          >
            <Icon name="panel-left" size={14} />
          </button>
        </div>
        <div className="toggle-group">
          <button
            className="toggle-btn toggle-right"
            aria-pressed={layout.rightCollapsed}
            onClick={layout.toggleRight}
            title={layout.rightCollapsed ? '展开面板（⌘⌥B）' : '折叠面板（⌘⌥B）'}
          >
            <Icon name="panel-right" size={14} />
          </button>
        </div>
      </div>

      {/* 环境光斑：给玻璃层提供可折射的内容，否则 backdrop-filter 看不出效果 */}
      <div className="ambient" aria-hidden="true">
        <span className="blob blob-1" />
        <span className="blob blob-2" />
        <span className="blob blob-3" />
      </div>

      <Sidebar
        state={state}
        onSelect={(id) => void api.openThread(id)}
        onNewChat={() => void api.createThread()}
        onExportAudit={() => void api.exportAudit().then(setAudit)}
        projectName={projectName}
        env={api.env ? { workspace: api.env.workspace, codexHome: api.env.codexHome } : null}
      />

      {/* 拖拽分隔条。放在 main 之前/之后而不是 grid 里：
          它们是绝对定位的覆盖层，不占轨道宽度，否则栏宽会因
          多出两列而全部偏移。 */}
      <div
        className={`col-resizer resizer-left ${layout.dragging === 'left' ? 'is-dragging' : ''}`}
        style={{ left: layout.leftCollapsed ? 0 : layout.leftWidth }}
        onPointerDown={(e) => layout.startDrag('left', e)}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整左栏宽度"
        title="拖动调整宽度"
      />

      {/* 容器上的 dblclick 只处理「顶部让位带的空白」（target 为容器自身
          且 y < --titlebar）——head 本体的双击冒泡上来时 target 是 head 内
          元素，被 self-target 守卫放行，不会二次 toggle。见 titlebarZoom.ts。 */}
      <main className="main" onDoubleClick={onColumnBandDoubleClick}>
        <header className="main-head" onDoubleClick={onTitlebarDoubleClick}>
          <div className="head-left">
            {thread ? (
              <>
                <span className="head-title">{threadTitle(state, thread.id)}</span>
                <span className="head-sub mono">{thread.cwd}</span>
              </>
            ) : (
              <span className="head-title dim">未选择任务</span>
            )}
          </div>
          <div className="head-right">
            {/* 顶栏的权限状态改为可点入口。
                它是常驻可见的，用户看到「工作区可写」想知道怎么改时，
                第一反应是点它——此前它是个死标签。 */}
            <button
              className={`mode-chip ${api.settings?.mode === 'fullAccess' ? 'is-danger' : ''}`}
              onClick={() => setPanel(panel === 'settings' ? 'default' : 'settings')}
              title="打开设置"
            >
              <Icon name="shield" size={12} />
              <span>{info.label}</span>
              <span className="dot-sep">·</span>
              <span>{info.approval}</span>
            </button>
          </div>
        </header>

        <div className="main-body-wrap">
          <div className="main-body" ref={scroll.ref as React.RefObject<HTMLDivElement>}>
            {/* 空态条件必须包含「线程存在但还没有轮次」。
                只判 !thread 时，新建对话（线程已建、turnOrder 为空）
                既不显示欢迎页、也没有任何轮次可渲染——用户看到一片空白
                （实测：点「新对话」后主区全空）。 */}
            {(!thread || thread.turnOrder.length === 0) && (
              <Welcome
                projectName={projectName}
                onPick={(prompt) => {
                  // 建议卡片直接建线程并提交——不是装饰性文案
                  void (async () => {
                    await api.createThread();
                    await api.sendTurn(prompt);
                  })();
                }}
              />
            )}
            {thread &&
              thread.turnOrder.map((turnId) => (
                <TurnView
                  key={turnId}
                  state={state}
                  threadId={thread.id}
                  turnId={turnId}
                  onOpenFile={(path) =>
                    api.openInRight({
                      kind: 'file',
                      path,
                      label: path.split('/').pop() ?? path,
                    })
                  }
                />
              ))}
          </div>

          {/* 「回到底部」只在用户上滑离开底部后出现。
              贴在流底部而非顶部：它替代的正是「滚到底」这个动作。 */}
          {scroll.showButton && (
            <button className="scroll-bottom" onClick={scroll.scrollToBottom} title="回到底部">
              <Icon name="chevron" size={13} />
              <span>回到底部</span>
            </button>
          )}
        </div>


        {/* 状态浮层：浮在对话栏右上角，可收成胶囊。
            放在 main 内而非右栏——它是「随时扫一眼」的信息，
            不该和内容争右栏的纵向空间。 */}
        <StatusDock
          state={state}
          threadId={thread?.id ?? null}
          projectName={projectName}
          git={api.git}
          gitRemote={api.gitRemote}
          onRefreshGit={() => void api.refreshGit()}
          onCommit={api.commitAll}
          onPush={api.pushBranch}
          permissionMode={api.settings?.mode ?? null}
          model={api.selectedModel ?? api.settings?.model ?? null}
          provider={api.settings?.modelProvider ?? null}
        />

        <Composer
          disabled={!thread}
          onSubmit={(t) => void api.sendTurn(t)}
          running={running || awaitingApproval}
          onStop={() => {
            if (latestTurnId) void api.interrupt(latestTurnId);
          }}
          models={api.models}
          selectedModel={api.selectedModel}
          selectedEffort={api.selectedEffort}
          onSelectModel={api.setModel}
          onSelectEffort={api.setEffort}
          projectName={projectName}
          git={api.git}
          permissionMode={api.settings?.mode ?? null}
          onSelectPermission={(m) => void api.setPermissionMode(m)}
          configuredModel={api.settings?.model ?? null}
          pendingInput={api.pendingInput}
          onConsumePending={api.clearPendingInput}
          onSearchFiles={api.searchFiles}
          onCompact={() => void api.compactThread()}
        />
      </main>

      <div
        className={`col-resizer resizer-right ${layout.dragging === 'right' ? 'is-dragging' : ''}`}
        style={{ right: layout.rightCollapsed ? 0 : layout.rightWidth }}
        onPointerDown={(e) => layout.startDrag('right', e)}
        role="separator"
        aria-orientation="vertical"
        aria-label="调整右栏宽度"
        title="拖动调整宽度"
      />

      <aside className="inspector" onDoubleClick={onColumnBandDoubleClick}>
        <Workbench
          open={openAvailable}
          active={effectiveScene}
          availability={scenes}
          onActivate={activateScene}
          onClose={closeSceneTab}
          onCloseOthers={closeOtherTabs}
          onCloseAll={closeAllTabs}
        >
          {effectiveScene === 'review' && (
            <>
              {(review.changeSet || review.turnDiff) ? (
                <div className="panel">
                  <div className="panel-head">
                    <Icon name="edit" size={13} />
                    <span>变更审阅</span>
                  </div>
                  <DiffViewer
                    changeSet={review.changeSet}
                    turnDiff={review.turnDiff}
                    workspace={api.env?.workspace}
                    onOpenFile={(path) =>
                      api.openInRight({
                        kind: 'file',
                        path,
                        label: path.split('/').pop() ?? path,
                      })
                    }
                    onDecideFile={(path, decision) =>
                      void api.decideFile(latestTurnId!, path, decision)
                    }
                    onDecideAll={(decision) => {
                      if (!review.changeSet || !latestTurnId) return;
                      for (const f of review.changeSet.files) {
                        void api.decideFile(latestTurnId!, f.path, decision);
                      }
                    }}
                  />
                </div>
              ) : (
                <p className="panel-empty">本轮没有文件改动。</p>
              )}

              {pending && (
                <div className="panel">
                  <div className="panel-head">
                    <Icon name="shield" size={13} />
                    <span>审批</span>
                    <span className="panel-status status-awaiting_approval">待处理</span>
                  </div>
                  <ApprovalModal
                    approval={pending}
                    onDecide={(id, d, sc) => void api.decide(id, d, sc)}
                  />
                </div>
              )}

              {state.errors.length > 0 && (
                <div className="panel">
                  <div className="panel-head">
                    <Icon name="close" size={13} />
                    <span>提示</span>
                  </div>
                  <ul className="notice-list">
                    {state.errors.slice(-6).map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {effectiveScene === 'terminal' && (
            <TerminalPanel
              cwd={api.env?.workspace ?? null}
              events={{ subscribe: api.subscribe }}
            />
          )}

          {effectiveScene === 'browser' && (
            <BrowserPanel
              url={content?.kind === 'browser' ? content.url : null}
              onNavigate={(next) => {
                // 已打开过就复用同一个子视图（保留登录态与滚动位置）
                api.openInRight({ kind: 'browser', url: next, label: hostOf(next) });
              }}
              onPick={(el) => {
                // 作为附件加入输入区（不是塞一段文本），
                // 用户能看出选了什么、也能单独移除
                api.appendComposer(el);
              }}
              slotRef={slotRef}
              slotSize={slotSize}
              onViewport={(v) => {
                // 位置由 slot 的实际矩形决定，不能写 0：
                // 原生子视图用的是窗口逻辑坐标，而 slot 在右栏里。
                const r = contentRef.current?.getBoundingClientRect();
                if (!r) return;
                // 居中：固定尺寸模式下模拟视口可能比可用区域窄，
                // 靠左会显得像渲染错位
                const x = r.left + Math.max(0, (r.width - v.pixelWidth) / 2);
                const y = r.top + Math.max(0, (r.height - v.pixelHeight) / 2);
                void invoke('browser_emulate_viewport', {
                  x: Math.round(x),
                  y: Math.round(y),
                  cssWidth: Math.round(v.cssWidth),
                  cssHeight: Math.round(v.cssHeight),
                  scale: v.scale,
                }).then(() => {
                  // 临时诊断
                  window.setTimeout(() => {
                    void invoke<string>('browser_diag_frame').then((f) =>
                      invoke<string | null>('browser_diag_metrics').then((m) =>
                        api.reportError(`视口 frame=${f} 页面=${m ?? '(等待)'}`),
                      ),
                    );
                  }, 700);
                }).catch(() => {
                  /* 视图尚未创建时忽略——创建时会用同样的参数初始化 */
                });
              }}
            />
          )}

          {effectiveScene === 'files' && api.env?.workspace && (
            <div className="panel">
              <div className="panel-head">
                <Icon name="folder" size={13} />
                <span>文件</span>
              </div>
              <FileTree
                root={api.env.workspace}
                selected={content?.kind === 'file' ? content.path : null}
                onSelect={(path) =>
                  api.openInRight({
                    kind: 'file',
                    path,
                    label: path.split('/').pop() ?? path,
                  })
                }
              />
            </div>
          )}

          {effectiveScene === 'chat' && (
            <>
              {panel === 'plugins' ? (
                <div className="panel">
                  <div className="panel-head">
                    <Icon name="plugin" size={13} />
                    <span>插件</span>
                    <button className="mini-btn" onClick={() => setPanel('default')}>
                      返回
                    </button>
                  </div>
                  <PluginList plugins={api.plugins} />
                </div>
              ) : (
                <div className="panel">
                  <div className="panel-head">
                    <Icon name="layers" size={13} />
                    <span>技能</span>
                    <button className="mini-btn" onClick={() => setPanel('plugins')}>
                      插件
                    </button>
                  </div>
                  <SkillList skills={api.skills} />
                </div>
              )}

              <SettingsPanel
                settings={api.settings}
                models={api.models}
                selectedModel={api.selectedModel}
                onSelectModel={api.setModel}
                onSelectMode={(m) => void api.setPermissionMode(m)}
                onReload={() => void api.reloadSettings()}
              />
            </>
          )}
        </Workbench>

        {audit && (
          <div className="panel">
            <div className="panel-head">
              <Icon name="shield" size={13} />
              <span>审计日志</span>
              <button className="mini-btn" onClick={() => setAudit(null)}>
                收起
              </button>
            </div>
            <pre className="audit-view">{audit}</pre>
          </div>
        )}
      </aside>
    </div>
  );
}
