/**
 * 工作台：右栏的场景容器。
 *
 * 一次只显示一个场景，通过顶部的场景标签切换。取代此前「卡片纵向堆叠」
 * 的做法——堆叠时 diff 要高度、网页要面积、终端要行数，三者互相挤压，
 * 谁都不可用。
 *
 * # 标签栏为什么不只是切换
 *
 * 参照（ZCode / Codex）的标签支持**关闭**与**右键菜单**（关闭其他、
 * 关闭全部）。缺了它们，用户打开几个场景后无法收敛——标签只会越积越
 * 多，最后满栏都是不再需要的东西。关闭是标签栏的必备能力，不是附加项。
 *
 * # 「关闭此标签」在这里有两种语义，必须区分
 *
 * - 关闭**当前**场景：回到无场景状态（工作台空着）。
 * - 关闭**其他**场景：保留当前，把其余的收掉。
 *
 * 而「关闭全部」同样是回到无场景。所以三个动作都落到「把 scene 设为
 * null」或「保持不变」上，不需要维护一个真正的标签列表——因为同时
 * 只显示一个场景，标签栏列出的是**所有可用场景**而非「已打开」的。
 *
 * 这也是为什么「关闭其他」在只有一个场景可见时表现为无操作：
 * 没有别的场景需要关。
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { availableScenes, type SceneAvailability, type WorkbenchScene } from './scenes';
import { onTitlebarDoubleClick } from '../hooks/titlebarZoom';

export function Workbench({
  open,
  active,
  availability,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
  following,
  onResumeFollow,
  working,
  children,
}: {
  /** 已打开的场景（顺序即标签顺序）。 */
  open: WorkbenchScene[];
  /** 当前激活的场景。 */
  active: WorkbenchScene | null;
  availability: SceneAvailability;
  /** 打开（或切到）一个场景。 */
  onActivate: (s: WorkbenchScene) => void;
  /** 关闭指定标签。 */
  onClose: (s: WorkbenchScene) => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
  /**
   * 是否处于「自动跟随」态（右栏跟着 Agent 的工作内容走）。
   *
   * 不传时不渲染指示器——那是「这个入口不存在」，而不是「跟随已关闭」。
   */
  following?: boolean;
  onResumeFollow?: () => void;
  /** 哪个场景正在「工作」（用于标签上的活动点）。 */
  working?: WorkbenchScene | null;
  children: React.ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  /** 「…」标签操作菜单。 */
  const [moreMenu, setMoreMenu] = useState(false);
  const usable = availableScenes(availability);
  // 「+」菜单只列**尚未打开**的场景：已打开的正在标签栏上，重复列出
  // 会让用户以为点它会开出第二个同样的标签。
  const closable = usable.filter((s) => !open.includes(s.id));

  // ESC 关掉右键菜单：它是覆盖层，用户会本能地按 Esc
  useEffect(() => {
    if (!ctxMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctxMenu]);

  // 一个场景都不可用：整个工作台不渲染，而不是留一个空壳
  if (usable.length === 0) return null;

  // 没有打开任何标签：显示居中的引导，而不是把菜单浮在顶部。
  // 浮在顶部时它会和标签栏、右上角的折叠开关抢同一块位置（实测重叠）。
  // 居中之后既避开了那些控件，也更像一个「空态」而不是「弹窗」。
  if (open.length === 0) {
    return <EmptyTabs usable={usable} onPick={onActivate} />;
  }

  // 「关闭其他」在其他场景存在时才有意义。只有当前一个时禁用——
  // 点了没反应比置灰更让人困惑。
  // 必须看**打开的标签数**，不是「可用场景数」。
  // 后者恒为 5（所有场景都可用），于是只剩一个标签时「关闭其他」
  // 仍然可点，点了没有任何反应。
  const hasOthers = open.length > 1;

  return (
    <div className="workbench">
      <TabBar
        tabs={open
          .map((id) => usable.find((s) => s.id === id))
          .filter((s): s is (typeof usable)[number] => Boolean(s))
          .map((s) => ({
            id: s.id,
            label: s.label,
            icon: s.icon,
            active: s.id === active,
          }))}
        onPick={(id) => onActivate(id)}
        onCloseTab={onClose}
        onContext={(x, y) => setCtxMenu({ x, y })}
        working={working ?? null}
        trailing={
          <>
          {/* 跟随指示/开关。两态共用一个按钮：
              - 跟随中：低调显示「跟随」，点击可关闭（用户想固定住当前视图）
              - 已关闭：显式可点，点击恢复并立刻跳到最该看的地方
              没有它，「自动切换为什么停了」会是个无从察觉的状态。 */}
          {following !== undefined && onResumeFollow && (
            <button
              className={`wb-follow ${following ? 'is-on' : ''}`}
              onClick={onResumeFollow}
              title={
                following
                  ? '右栏正跟随 Agent 的工作内容自动切换'
                  : '已停止跟随（你手动选过场景）。点击恢复跟随'
              }
              aria-label={following ? '跟随中' : '恢复跟随'}
              aria-pressed={following}
            >
              <Icon name="sparkle" size={11} />
              <span>{following ? '跟随' : '已停止跟随'}</span>
            </button>
          )}
          {/* 「…」菜单：右键菜单在所有环境都能用，但不**可见**——
              用户不知道有这功能。这个按钮是它的可靠入口。 */}
          <div className="wb-menu-wrap">
            <button
              className="wb-add"
              onClick={() => setMoreMenu((v) => !v)}
              title="标签操作"
              aria-label="标签操作"
            >
              <Icon name="more" size={12} />
            </button>
            {moreMenu && (
              <>
                {/* 独立类：它的层级必须低于自己的菜单（z-index 61），
                    共用 .ctx-backdrop（70）会盖住菜单、吃掉点击 */}
                <div className="ctx-backdrop-sub" onClick={() => setMoreMenu(false)} />
                <div className="ctx-menu ctx-menu-right" role="menu">
                  <button
                    className="ctx-item"
                    onClick={() => {
                      setMoreMenu(false);
                      if (active) onClose(active);
                    }}
                  >
                    关闭当前标签
                  </button>
                  <button
                    className="ctx-item"
                    disabled={!hasOthers}
                    title={hasOthers ? '' : '没有其他标签'}
                    onClick={() => {
                      setMoreMenu(false);
                      onCloseOthers();
                    }}
                  >
                    关闭其他标签
                  </button>
                  <button
                    className="ctx-item"
                    onClick={() => {
                      setMoreMenu(false);
                      onCloseAll();
                    }}
                  >
                    关闭所有标签
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="wb-menu-wrap">
            <button
              className="wb-add"
              onClick={() => setMenuOpen((v) => !v)}
              title="打开场景"
              aria-label="打开场景"
            >
              <Icon name="plus" size={12} />
            </button>
            <SceneMenu
              open={menuOpen}
              usable={closable}
              onDismiss={() => setMenuOpen(false)}
              onPick={(s) => {
                setMenuOpen(false);
                onActivate(s);
              }}
            />
          </div>
          </>
        }
      />

      <div className="workbench-body">{children}</div>

      {ctxMenu && (
        <>
          <div className="ctx-backdrop" onClick={() => setCtxMenu(null)} />
          <div
            className="ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            role="menu"
          >
            <button
              className="ctx-item"
              onClick={() => {
                setCtxMenu(null);
                if (active) onClose(active);
              }}
            >
              关闭标签
            </button>
            <button
              className="ctx-item"
              disabled={!hasOthers}
              onClick={() => {
                setCtxMenu(null);
                onCloseOthers();
              }}
            >
              关闭其他标签
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                setCtxMenu(null);
                onCloseAll();
              }}
            >
              关闭所有标签
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** 标签栏：每个标签带关闭按钮，右键出菜单。 */
function TabBar({
  tabs,
  onPick,
  onCloseTab,
  onContext,
  working,
  trailing,
}: {
  tabs: { id: WorkbenchScene; label: string; icon: string; active: boolean }[];
  onPick: (id: WorkbenchScene) => void;
  onCloseTab: (id: WorkbenchScene) => void;
  onContext: (x: number, y: number) => void;
  working?: WorkbenchScene | null;
  trailing?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  return (
    <div className="workbench-bar" ref={ref} onDoubleClick={onTitlebarDoubleClick}>
      {/* 标签在可滚动容器里，操作按钮留在容器外。
          全放在同一个 nowrap 容器里时，标签一多就把「…」与「+」
          推出可视区（实测：按钮被滚出右边界，用户点不到）。 */}
      <div className="wb-tabs-scroll">
      {tabs.map((t) => (
        <span
          key={t.id}
          className={`wb-tab ${t.active ? 'is-active' : ''}`}
          onContextMenu={(e) => {
            // 阻止系统菜单：这里要用应用自己的标签菜单
            e.preventDefault();
            onContext(e.clientX, e.clientY);
          }}
          // 右键按下也拦一次：macOS 的 WKWebView 在部分情况下
          // 由 Cocoa 层先弹出原生菜单（Reload / Inspect Element），
          // 那时 DOM 的 contextmenu 处理已经来不及。这里在更早的
          // 阶段阻止默认行为，把控制权留给应用菜单。
          onMouseDown={(e) => {
            if (e.button === 2) {
              e.preventDefault();
              onContext(e.clientX, e.clientY);
            }
          }}
        >
          <button className="wb-tab-main" onClick={() => onPick(t.id)} title={t.label}>
            <Icon name={t.icon as never} size={12} />
            <span className="wb-tab-label">{t.label}</span>
            {/* 该场景正在工作（例如子代理仍在跑）：一个呼吸点。
                放在标签上而不是只放在面板里——面板可能没被打开，
                而「另一条工作线在推进」是用户需要随时知道的。 */}
            {working === t.id && <span className="wb-tab-working" title="正在运行" />}
          </button>
          {/* 关闭按钮：与「切换」分开，避免一次点击同时触发两件事 */}
          <button
            className="wb-tab-close"
            aria-label={`关闭${t.label}`}
            title="关闭"
            onClick={() => onCloseTab(t.id)}
          >
            <Icon name="close" size={9} />
          </button>
        </span>
      ))}
      </div>
      {trailing && <div className="wb-bar-actions">{trailing}</div>}
    </div>
  );
}

/** 「+」菜单：列出全部可用场景及其快捷键。 */
function SceneMenu({
  open,
  usable,
  onPick,
  onDismiss,
}: {
  open: boolean;
  usable: ReturnType<typeof availableScenes>;
  onPick: (s: WorkbenchScene) => void;
  /** 点菜单外部或按 Esc 时调用。不传则只有再点一次按钮才能关。 */
  onDismiss?: () => void;
}) {
  if (!open) return null;
  return (
    <>
      {/* 透明遮罩：点空白关闭。
          没有它时用户只能再点一次「+」——而点空白没反应会让人觉得
          「菜单卡住了」。 */}
      {onDismiss && <div className="wb-menu-backdrop" onClick={onDismiss} />}
      <div className="wb-menu" role="menu">
        {usable.map((s) => (
          <button key={s.id} className="wb-menu-item" role="menuitem" onClick={() => onPick(s.id)}>
            <Icon name={s.icon} size={13} />
            <span className="wb-menu-label">{s.label}</span>
            <span className="wb-menu-key">{s.shortcut}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * 空标签态的引导。
 *
 * 三个设计点：
 * - **居中**而不是贴顶：贴顶时会与标签栏、右上角的折叠开关挤在同一块
 *   区域（实测重叠）。居中后互不干扰，也符合「空态」的语义。
 * - **竖排大行**而不是小菜单项：此时用户没有别的可点，这是唯一入口，
 *   应当做得足够大、好点。菜单式的小行适合「从已有内容里挑一个」，
 *   不适合「这里什么都没有，请先建一个」。
 * - **显示快捷键**：用户下次可以跳过这一步直接用快捷键。
 */
function EmptyTabs({
  usable,
  onPick,
}: {
  usable: ReturnType<typeof availableScenes>;
  onPick: (s: WorkbenchScene) => void;
}) {
  return (
    <div className="wb-empty">
      <h2 className="wb-empty-title">打开标签页</h2>
      <p className="wb-empty-hint">选择要在侧边面板中打开的标签</p>
      <div className="wb-empty-list">
        {usable.map((s) => (
          <button key={s.id} className="wb-empty-item" onClick={() => onPick(s.id)}>
            <Icon name={s.icon} size={16} />
            <span className="wb-empty-label">{s.label}</span>
            <span className="wb-empty-key">{s.shortcut}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
