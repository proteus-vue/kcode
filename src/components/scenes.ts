/**
 * 工作台场景定义。
 *
 * 右栏是**一个工作台**：一次只显示一个场景，而不是把卡片往下堆。
 * 卡片堆叠的问题很具体——审查的 diff 要高度、浏览器的网页要面积、
 * 终端要行数，三者放在同一条纵向流里互相挤压，谁都得不到可用空间。
 *
 * 场景清单与参照（Codex 右栏的「+」菜单）一致：
 * 审查 / 终端 / 浏览器 / 文件 / 侧边聊天。
 *
 * # 菜单里为什么没有「卡片堆」
 *
 * 每项都对应一个真实能力（协议或本地实现），不存在装饰性条目：
 * 审查→变更集、终端→command/exec、浏览器→子 webview、
 * 文件→fs/readDirectory、侧边聊天→同一 app-server 的另一条线程。
 */
export type WorkbenchScene =
  | 'review'
  | 'terminal'
  | 'browser'
  | 'files'
  | 'library'
  | 'subagents'
  | 'simulator';

export interface SceneMeta {
  id: WorkbenchScene;
  label: string;
  icon: 'diff' | 'terminal' | 'compass' | 'folder' | 'layers' | 'cpu' | 'devices';
  /** 快捷键提示（仅展示，不注册——注册了却与系统键冲突更糟）。 */
  shortcut: string;
}

export const SCENES: SceneMeta[] = [
  // 审查用「左右面板 + 增删号」而不是铅笔：铅笔与「编辑」撞义，
  // 而这个面板展示的正是逐文件增删。
  { id: 'review', label: '审查', icon: 'diff', shortcut: '⌘⇧G' },
  { id: 'terminal', label: '终端', icon: 'terminal', shortcut: '⌘`' },
  { id: 'browser', label: '浏览器', icon: 'compass', shortcut: '⌘T' },
  { id: 'files', label: '文件', icon: 'folder', shortcut: '⌘P' },
  // **这里此前叫「侧边聊天」，但它渲染的一直是技能/插件/设置**——
  // 菜单承诺了一个不存在的能力（scenes.ts 早先的注释还写着「同一 app-server
  // 的另一条线程」，而实现里没有第二条线程）。改名以反映实际内容：
  // 真正的侧边聊天需要右栏里再放一套输入区与时间线，是独立工作量，
  // 已如实记入对标清单的未做项，而不是继续挂一个名不副实的入口。
  { id: 'library', label: '库', icon: 'layers', shortcut: '⌘⇧S' },
  // 子代理：Agent 派生的并行工作单元。只在当前线程确实有子代理活动时
  // 才可进入（与其它场景一致：不给空入口）。
  { id: 'subagents', label: '子代理', icon: 'cpu', shortcut: '⌘⇧A' },
  // 模拟器：Android 走 adb（实时截图 + 输入），iOS 需要完整 Xcode。
  // 不可用时**不出现在菜单里**（与其它场景一致：不给空入口），
  // 可用性由后端探测——本机没装完整 Xcode 时 iOS 侧就不可用。
  { id: 'simulator', label: '模拟器', icon: 'devices', shortcut: '' },
];

/**
 * 哪些场景当前**可进入**。
 *
 * 与状态浮层的分段规则同源：没有内容的场景不出现在菜单里，
 * 而不是显示一个点开是空白的入口。用户点进一个空面板后唯一的
 * 收获是「知道这里没东西」——那不如一开始就别让他点。
 */
export interface SceneAvailability {
  review: boolean;
  terminal: boolean;
  browser: boolean;
  files: boolean;
  library: boolean;
  /**
   * 子代理是否可进入。
   *
   * 判据是**当前线程确实有子代理活动**，不是恒为 true——没有子代理时
   * 点开只有一句「暂无」，那属于空入口。
   */
  subagents: boolean;
  /**
   * 模拟器是否可用。
   *
   * 判据是**后端探测到的工具链是否齐全**（Android 需要 emulator + adb；
   * iOS 需要完整 Xcode 的 simctl），不是写死的 `true`——
   * 本机未装完整 Xcode，写死会让菜单出现一个点开只有报错的入口。
   */
  simulator: boolean;
}

export function availableScenes(a: SceneAvailability): SceneMeta[] {
  return SCENES.filter((s) => a[s.id]);
}

/** 过滤掉当前不可用的场景；若当前场景失效则回退到第一个可用场景。 */
export function resolveScene(
  current: WorkbenchScene | null,
  a: SceneAvailability,
): WorkbenchScene | null {
  const ok = availableScenes(a);
  if (ok.length === 0) return null;
  if (current && ok.some((s) => s.id === current)) return current;
  return ok[0].id;
}

/**
 * 打开标签列表的纯函数操作。
 *
 * # 为什么需要「打开列表」这个概念
 *
 * 早前把「标签」实现成「所有可用场景」的固定列表 + 一个活动值，
 * 于是**关闭无从下手**：没有列表可减，只能把活动值置空，而置空后
 * 又会回退到第一个可用场景——表现就是「点关闭跑回了终端页」，
 * 用户看到的是跳转而不是关闭。
 *
 * 标签必须有独立的打开集合。下面三个操作都是纯函数，便于测试。
 */

/** 打开一个场景（已打开则只切换）。 */
export function openScene(list: WorkbenchScene[], id: WorkbenchScene): WorkbenchScene[] {
  return list.includes(id) ? list : [...list, id];
}

/**
 * 关闭指定场景，并给出关闭后应当激活的场景。
 *
 * 关闭的是活动标签时激活它**右边**的；没有右边的就激活左边的；
 * 都没有则为 null（工作台回到空态）。
 */
export function closeScene(
  list: WorkbenchScene[],
  id: WorkbenchScene,
  active: WorkbenchScene | null,
): { list: WorkbenchScene[]; active: WorkbenchScene | null } {
  const idx = list.indexOf(id);
  const next = list.filter((s) => s !== id);
  if (active !== id) return { list: next, active };
  if (next.length === 0) return { list: next, active: null };
  // 原位置现在坐着右边那个；越界则取左邻
  return { list: next, active: next[Math.min(idx, next.length - 1)] };
}

/** 关闭除 keep 之外的全部。 */
export function closeOthers(
  list: WorkbenchScene[],
  keep: WorkbenchScene | null,
): WorkbenchScene[] {
  return keep && list.includes(keep) ? [keep] : [];
}
