/**
 * 右栏工作台的**自动跟随**：让右栏跟着 Agent 的工作内容走。
 *
 * # 为什么需要这个模块
 *
 * 右栏最大的价值不是「用户手动打开一个面板」，而是**随着 Agent 的工作自动
 * 呈现它此刻在动的东西**——改了文件就显示 diff、派了子代理就显示子代理、
 * 开了网页就显示浏览器。否则用户得自己盯着时间线判断「现在该看哪一栏」。
 *
 * # 但它必须让路给用户（这是本模块的全部难点）
 *
 * 自动切换有两种失败方式，都很烦人：
 * 1. **抢**：用户正盯着某个 diff，Agent 一动就把面板换掉；
 * 2. **黏**：用户明确选了「文件」，Agent 一动又被切走。
 *
 * 所以规则是「**跟随，但一经手动选择就立刻让位**」：
 *
 * - 默认处于跟随态；
 * - 用户手动点过任何场景标签 → 退出跟随（不再自动切）；
 * - 手动选择只影响「跟随开关」，不锁定内容——再次点「跟随」即可恢复。
 *
 * 不引入「局部锁定」（例如只锁定某一类信号）是刻意的：那会让用户
 * 需要维护一个「我锁了什么」的心智模型，而收益很小。
 *
 * # 信号优先级
 *
 * 同一时刻可能有多个信号（既改了文件又派了子代理）。按「用户更需要先看到
 * 哪个」排序：**子代理 > 变更审阅 > 浏览器**。子代理排最前是因为它是
 * 「有别的 agent 在并行干活」这类最容易失去掌控感的事；文件变更在时间线
 * 里本来就有一行摘要，不切也能看见。
 */

import type { WorkbenchScene } from '../components/scenes';

/** 一次「Agent 做了某事」的信号。 */
export interface FollowSignal {
  /** 本轮是否出现了新的子代理活动。 */
  subagentActive: boolean;
  /** 当前轮次是否有变更集（文件被改动）。 */
  hasChanges: boolean;
  /** Agent 是否打开了浏览器视图。 */
  browserOpened: boolean;
}

export const NO_SIGNAL: FollowSignal = {
  subagentActive: false,
  hasChanges: false,
  browserOpened: false,
};

/**
 * 按信号决定应跟随到哪个场景。
 *
 * 返回 null 表示「没有值得切换的信号」——这时**保持当前场景不动**，
 * 而不是回退到默认场景：回退会让「用户看着文件树，Agent 停了一会儿」
 * 变成面板自己跳走。
 */
export function followedScene(signal: FollowSignal): WorkbenchScene | null {
  if (signal.subagentActive) return 'subagents';
  if (signal.hasChanges) return 'review';
  if (signal.browserOpened) return 'browser';
  return null;
}

/**
 * 跟随态下的下一次场景决策。
 *
 * @param following      是否处于跟随态（用户没手动选过）
 * @param current        当前生效的场景
 * @param signal         本轮的 Agent 活动信号
 * @param available      场景是否可用（不可用的场景不切过去——那会得到一个空面板）
 * @returns 要切换到的场景；null 表示不动
 *
 * 四条不切换的理由都写在这里，而不是散在调用点：
 * 1. 不在跟随态（用户手动选过）；
 * 2. 没有信号；
 * 3. 目标就是当前场景（防止无意义的 setState 与重渲染）；
 * 4. 目标场景当前不可用。
 */
export function nextFollowedScene(
  following: boolean,
  current: WorkbenchScene | null,
  signal: FollowSignal,
  available: (s: WorkbenchScene) => boolean,
): WorkbenchScene | null {
  if (!following) return null;
  const target = followedScene(signal);
  if (target === null) return null;
  if (target === current) return null;
  if (!available(target)) return null;
  return target;
}

/**
 * 跟随态的状态机（纯函数部分）：只有用户手动选择会退出跟随。
 *
 * 单独抽出来是为了明确一件事：**打开新场景（包括程序化的）不算手动选择**。
 * 早先把它和「用户点标签」混为一谈，会让每次自动切换都把自己关掉。
 */
export type FollowAction =
  | { type: 'userPicked'; scene: WorkbenchScene }
  | { type: 'userEnabledFollow' }
  | { type: 'threadChanged' };

export function reduceFollowing(following: boolean, action: FollowAction): boolean {
  switch (action.type) {
    case 'userPicked':
      return false;
    case 'userEnabledFollow':
      return true;
    case 'threadChanged':
      // 换线程时恢复跟随：新线程是新的工作上下文，用户在旧线程的
      // 手动选择不该继续约束新线程。
      return true;
    default:
      return following;
  }
}
