/**
 * 状态浮层里各段的显示条件。
 *
 * 单独成模块是为了可测：这些条件决定「用户会不会看到一张空卡片」，
 * 而空卡片正是这次要消除的东西。混在组件里就只能靠人眼在特定
 * 数据组合下试出来。
 */

export interface DockInputs {
  /** 是否有活动线程。 */
  hasThread: boolean;
  /** 仓库状态（null = 尚未读到）。 */
  git: {
    isRepo: boolean;
    staged: number;
    modified: number;
    untracked: number;
    conflicted: number;
    ahead: number;
  } | null;
  /** 本轮的工具调用步骤数。 */
  stepCount: number;
}

export interface DockSections {
  git: boolean;
  steps: boolean;
  env: boolean;
  /** 三段都不显示时整个浮层不渲染。 */
  any: boolean;
}

/** 有未提交改动。 */
export function changedCount(git: DockInputs['git']): number {
  if (!git) return 0;
  return git.staged + git.modified + git.untracked + git.conflicted;
}

export function dockSections({ hasThread, git, stepCount }: DockInputs): DockSections {
  const changed = changedCount(git);

  // Git 段：仓库里有「需要处理的事」才出现——
  // 未提交的改动，或有待推送的本地提交。
  // 干净仓库不显示：用户在这里无事可做。
  const showGit = Boolean(git?.isRepo) && (changed > 0 || (git?.ahead ?? 0) > 0);

  // 进程段：本轮有工具调用。纯对话轮次没有步骤可列。
  const showSteps = stepCount > 0;

  // 环境段：有线程才有指代对象（描述的是「这个任务在哪跑」）。
  const showEnv = hasThread;

  return {
    git: showGit,
    steps: showSteps,
    env: showEnv,
    any: showGit || showSteps || showEnv,
  };
}
