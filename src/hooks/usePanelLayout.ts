/**
 * 面板布局状态：左右侧栏的展开/折叠。
 *
 * 三个约束决定了这里的实现方式：
 *
 * 1. **宽度不足时的折叠不写回偏好**。折叠状态持久化在 localStorage，
 *    但窗口过窄时的强制收起不能覆盖用户意愿——宽度恢复后应回到
 *    用户原本的选择，而不是被一次窄窗永久改掉。
 * 2. **用 ResizeObserver 观察容器宽度**，而不是 window.resize + 节流：
 *    后者在窗口拖拽时滞后一帧，表现为折叠切换慢半拍。
 * 3. **窄窗判定用容器宽度而非视口宽度**。侧栏是否放得下取决于
 *    中间栏还剩多少可读空间，与窗口绝对宽度不是一回事。
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

/** 各栏最小可用宽度（px）。与 styles.css 的 grid 轨道下限一致。 */
const LEFT_MIN = 240;
const RIGHT_MIN = 320;
/** 各栏最大宽度。左栏是导航，右栏是工作台；再宽就挤压正文了。 */
const LEFT_MAX = 520;
const RIGHT_MAX = 760;
/** 默认宽度（首次打开、没有存过偏好时）。 */
const LEFT_DEFAULT = 340;
const RIGHT_DEFAULT = 460;
/** 中间栏低于此宽度就不再挤压：正文太窄时阅读体验比多一个面板更差。 */
const CENTER_MIN = 520;
/**
 * 除三栏之外占掉的固定宽度：.app 左右各 12px 内边距 + 两条 12px 的 gap。
 * 与 clientWidth 搭配使用（clientWidth 含内边距，不含边框与滚动条）。
 */
const CHROME = 12 * 4;

const KEY_LEFT = 'kcode.panel.left.collapsed';
const KEY_RIGHT = 'kcode.panel.right.collapsed';
const KEY_LEFT_W = 'kcode.panel.left.width';
const KEY_RIGHT_W = 'kcode.panel.right.width';

/**
 * 折叠状态的持久化。
 *
 * 预置了 `kcode.panel.*.collapsed` 而没有 `kcode.panel.left` 这类键——
 * 后者会被误认为是宽度值。读写都包 try：隐私模式下 localStorage
 * 访问会抛异常，此时退化为「本次会话有效」，不应让整个应用挂掉。
 */
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}
function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* 存不下就算了，不影响本次会话 */
  }
}

/** 读一个数值偏好；非法或缺省时用兜底值。 */
function readNum(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const n = Number(raw);
    // 校验范围：手改过 localStorage 或旧版本的越界值不该让布局崩掉
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  } catch {
    return fallback;
  }
}

function writeNum(key: string, value: number) {
  try {
    localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* 同上 */
  }
}

/**
 * 宽度不足时，谁必须让位。
 *
 * 规则（优先级 中间栏 > 右栏 > 左栏）：
 *
 * - 右栏承载「当前动作」——审批、变更审阅。它没了任务会卡住。
 * - 左栏是导航，没了用户仍能靠中间栏干活。
 * - 中间栏是主体，永远保留 CENTER_MIN，正文太窄比少一个面板更糟。
 *
 * 关键细节：**用户已折叠的面板不占宽度**。否则会出现反直觉的结果——
 * 用户为了腾出空间手动收起左栏，右栏却仍然按「左栏存在」来判断，
 * 于是照样被强制收起，用户的操作等于白做。这里按实际需要预留：
 * 用户想显示的面板才计入所需宽度。
 *
 * @param avail 三栏可用的总宽度（已扣除内边距与 gap）
 * @param wantLeft  用户是否主动折叠了左栏
 * @param wantRight 用户是否主动折叠了右栏
 */
export function computeForcedCollapse(
  avail: number,
  wantLeft: boolean,
  wantRight: boolean,
): { left: boolean; right: boolean } {
  // 只有「用户想显示」的面板才需要预留最小宽度
  const needLeft = wantLeft ? 0 : LEFT_MIN;
  const needRight = wantRight ? 0 : RIGHT_MIN;

  // 第一轮：先看右栏（高优先级）能否留下
  const right = CENTER_MIN + needLeft + needRight > avail;
  // 第二轮：右栏让位后，再问左栏能否留下
  const left = CENTER_MIN + needLeft > avail;

  return { left, right };
}

export interface PanelLayout {
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  /** 当前是否因窗口过窄而被迫折叠（用于区分「用户折叠」与「放不下」）。 */
  forcedLeft: boolean;
  forcedRight: boolean;
  /**
   * 是否应播放列宽过渡。
   *
   * 只在**用户主动切换**时为 true，窗口缩放引起的自动折叠为 false。
   * 原因：过渡写在 grid-template-columns 上，而窗口 resize 同样会改变
   * 该属性的取值；若过渡跟着 resize 跑，布局会以 220ms 的时延追着窗口
   * 边缘，正是此前用户报告的「缩放过程有空白」的成因。用户点击时
   * 没有这个风险，才需要动画。
   */
  animateCols: boolean;
  toggleLeft: () => void;
  toggleRight: () => void;
  /** 绑到 .app 容器上，用它的实际宽度做可用性判定。 */
  containerRef: (el: HTMLDivElement | null) => void;
  /** 左右栏当前宽度（px），由 CSS 变量消费。 */
  leftWidth: number;
  rightWidth: number;
  /**
   * 开始拖拽某一侧的分隔条。
   *
   * 拖拽期间禁用列宽过渡：过渡是给「点击折叠」用的动画，
   * 拖拽时它会让指针与边缘脱节（滞后 220ms），手感很糟。
   */
  startDrag: (side: 'left' | 'right', e: React.PointerEvent) => void;
  /** 是否正在拖拽（用于给分隔条加高亮）。 */
  dragging: 'left' | 'right' | null;
}

/** 列宽过渡时长（与 styles.css 中的 transition 保持一致）。 */
const ANIM_MS = 240;

export function usePanelLayout(): PanelLayout {
  const [wantLeft, setWantLeft] = useState(() => readFlag(KEY_LEFT));
  const [wantRight, setWantRight] = useState(() => readFlag(KEY_RIGHT));
  const [animateCols, setAnimateCols] = useState(false);
  const [width, setWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  );
  /** 左右栏宽度。存 localStorage，重启后保持用户调过的宽度。 */
  const [leftWidth, setLeftWidth] = useState(() =>
    readNum(KEY_LEFT_W, LEFT_DEFAULT, LEFT_MIN, LEFT_MAX),
  );
  const [rightWidth, setRightWidth] = useState(() =>
    readNum(KEY_RIGHT_W, RIGHT_DEFAULT, RIGHT_MIN, RIGHT_MAX),
  );
  const [dragging, setDragging] = useState<'left' | 'right' | null>(null);
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const animTimer = useRef<number | null>(null);

  /** 打开一个短窗口，期间允许列宽过渡；窗口结束后立刻关掉。 */
  const pulseAnim = useCallback(() => {
    setAnimateCols(true);
    if (animTimer.current !== null) window.clearTimeout(animTimer.current);
    animTimer.current = window.setTimeout(() => {
      setAnimateCols(false);
      animTimer.current = null;
    }, ANIM_MS);
  }, []);

  useEffect(
    () => () => {
      if (animTimer.current !== null) window.clearTimeout(animTimer.current);
    },
    [],
  );

  const containerRef = useCallback((el: HTMLDivElement | null) => {
    nodeRef.current = el;
    if (el) setWidth(el.clientWidth);
  }, []);

  useEffect(() => {
    const el = nodeRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    // 读 clientWidth 而不是 entry.contentRect.width：
    // contentRect 是 content-box，不含 .app 左右各 12px 的内边距，
    // 而下面的 CHROME 已经把内边距算进去了——两者混用会把内边距
    // 重复扣两次，所有阈值整体偏移 24px（实测三栏提前在 1150px 收起）。
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const avail = width - CHROME;
  const forced = computeForcedCollapse(avail, wantLeft, wantRight);
  const forcedLeft = forced.left;
  const forcedRight = forced.right;

  const toggleLeft = useCallback(() => {
    pulseAnim();
    setWantLeft((v) => {
      writeFlag(KEY_LEFT, !v);
      return !v;
    });
  }, [pulseAnim]);
  const toggleRight = useCallback(() => {
    pulseAnim();
    setWantRight((v) => {
      writeFlag(KEY_RIGHT, !v);
      return !v;
    });
  }, [pulseAnim]);

  /**
   * 拖拽调整栏宽。
   *
   * 用 pointer 事件而不是 mouse：pointer 自带捕获（setPointerCapture），
   * 指针移出元素甚至移出窗口后事件仍会送到这里——鼠标事件要自己监听
   * window 并处理丢失焦点，容易漏。
   *
   * 右栏宽度按「指针到窗口右边界的距离」算，而不是累加位移：
   * 累加会因每次的取整与边界钳制产生漂移，拖久了就与指针脱节。
   */
  const startDrag = useCallback(
    (side: 'left' | 'right', e: ReactPointerEvent) => {
      e.preventDefault();
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      setDragging(side);

      // 用闭包里的变量记住本次拖拽的最新值。
      // 不能在 onUp 里用 setState 的 updater 去落盘：那是在 render 期间
      // 执行副作用（React 可能在 StrictMode 下调用两次 updater），
      // 而且 updater 里的值可能在最后一次 pointermove 之后才刷新，
      // 落盘的就不是用户最后看到的位置。
      let last: number | null = null;

      const onMove = (ev: PointerEvent) => {
        if (side === 'left') {
          // 左栏：从窗口左边缘算起（.app 无左内边距）
          last = Math.min(LEFT_MAX, Math.max(LEFT_MIN, ev.clientX));
          setLeftWidth(last);
        } else {
          // 右栏：按「指针到窗口右边界的距离」算，而不是累加位移。
          // 累加会因每次的取整与边界钳制产生漂移，拖久了与指针脱节。
          last = Math.min(RIGHT_MAX, Math.max(RIGHT_MIN, window.innerWidth - ev.clientX));
          setRightWidth(last);
        }
      };

      const finish = () => {
        setDragging(null);
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', finish);
        el.removeEventListener('pointercancel', finish);
        // 落盘放在松手时：move 每秒几十次，同步写 localStorage 会拖慢拖拽
        if (last !== null) writeNum(side === 'left' ? KEY_LEFT_W : KEY_RIGHT_W, last);
      };
      const onUp = finish;
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onUp);
    },
    [],
  );

  return {
    leftWidth,
    rightWidth,
    startDrag,
    dragging,
    leftCollapsed: wantLeft || forcedLeft,
    rightCollapsed: wantRight || forcedRight,
    forcedLeft,
    forcedRight,
    animateCols,
    toggleLeft,
    toggleRight,
    containerRef,
  };
}
