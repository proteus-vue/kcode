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
  | 'chat';

export interface SceneMeta {
  id: WorkbenchScene;
  label: string;
  icon: 'edit' | 'terminal' | 'compass' | 'folder' | 'plus';
  /** 快捷键提示（仅展示，不注册——注册了却与系统键冲突更糟）。 */
  shortcut: string;
}

export const SCENES: SceneMeta[] = [
  { id: 'review', label: '审查', icon: 'edit', shortcut: '⌘⇧G' },
  { id: 'terminal', label: '终端', icon: 'terminal', shortcut: '⌘`' },
  { id: 'browser', label: '浏览器', icon: 'compass', shortcut: '⌘T' },
  { id: 'files', label: '文件', icon: 'folder', shortcut: '⌘P' },
  { id: 'chat', label: '侧边聊天', icon: 'plus', shortcut: '⌘⇧S' },
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
  chat: boolean;
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
