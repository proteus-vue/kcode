/**
 * 浮层分段显示条件的测试。
 *
 * 这里钉住的是「什么时候**不**显示」——因为空卡片/占位行正是要消除的
 * 东西，而它只在特定的数据组合下出现（干净仓库、空轮次），
 * 靠手点很难覆盖全。
 */
import { describe, expect, it } from 'vitest';
import { changedCount, dockSections } from './dockVisibility';

const cleanGit = {
  isRepo: true,
  staged: 0,
  modified: 0,
  untracked: 0,
  conflicted: 0,
  ahead: 0,
};

describe('dockSections 的分段条件', () => {
  it('干净仓库 + 无步骤 + 无线程 → 整段都不显示', () => {
    const r = dockSections({ hasThread: false, git: cleanGit, stepCount: 0 });
    expect(r).toEqual({ git: false, steps: false, context: false, env: false, any: false });
  });

  it('干净的 git 仓库不显示 Git 段', () => {
    const r = dockSections({ hasThread: true, git: cleanGit, stepCount: 0 });
    expect(r.git).toBe(false);
    expect(r.env).toBe(true);
  });

  it('有未提交改动 → 显示 Git 段', () => {
    for (const g of [
      { ...cleanGit, modified: 1 },
      { ...cleanGit, staged: 2 },
      { ...cleanGit, untracked: 1 },
      { ...cleanGit, conflicted: 1 },
    ]) {
      expect(dockSections({ hasThread: false, git: g, stepCount: 0 }).git).toBe(true);
    }
  });

  it('仓库干净但有待推送的提交 → 仍显示 Git 段', () => {
    // 这条容易漏：ahead > 0 时用户有事可做（推送），不能因为
    // 「没有本地改动」就把整段藏起来
    const r = dockSections({ hasThread: false, git: { ...cleanGit, ahead: 3 }, stepCount: 0 });
    expect(r.git).toBe(true);
  });

  it('不是 git 仓库 → 不显示 Git 段（哪怕 ahead 有值）', () => {
    const r = dockSections({
      hasThread: false,
      git: { ...cleanGit, isRepo: false, ahead: 2, modified: 1 },
      stepCount: 0,
    });
    expect(r.git).toBe(false);
  });

  it('git 为 null（尚未读到）→ 不显示 Git 段', () => {
    expect(dockSections({ hasThread: false, git: null, stepCount: 0 }).git).toBe(false);
  });

  it('有步骤 → 显示进程段', () => {
    const r = dockSections({ hasThread: true, git: cleanGit, stepCount: 4 });
    expect(r.steps).toBe(true);
  });

  it('空轮次（0 步骤）→ 不显示进程段', () => {
    const r = dockSections({ hasThread: true, git: cleanGit, stepCount: 0 });
    expect(r.steps).toBe(false);
  });

  it('无线程 → 不显示环境段', () => {
    expect(dockSections({ hasThread: false, git: cleanGit, stepCount: 3 }).env).toBe(false);
  });

  it('any 只在至少一段显示时为真', () => {
    expect(dockSections({ hasThread: false, git: cleanGit, stepCount: 0 }).any).toBe(false);
    expect(dockSections({ hasThread: true, git: cleanGit, stepCount: 0 }).any).toBe(true);
    expect(
      dockSections({ hasThread: false, git: { ...cleanGit, modified: 1 }, stepCount: 0 }).any,
    ).toBe(true);
  });

  describe('上下文余量段', () => {
    it('充裕时不显示——刚开的会话显示「已用 3%」是纯噪音', () => {
      const r = dockSections({ hasThread: true, git: cleanGit, stepCount: 0, contextRatio: 0.03 });
      expect(r.context).toBe(false);
    });

    it('阈值边界：69% 不显示、70% 显示（对齐上游压缩线）', () => {
      expect(
        dockSections({ hasThread: true, git: cleanGit, stepCount: 0, contextRatio: 0.699 })
          .context,
      ).toBe(false);
      expect(
        dockSections({ hasThread: true, git: cleanGit, stepCount: 0, contextRatio: 0.7 }).context,
      ).toBe(true);
    });

    it('窗口未知（null）时不显示——算不出比例就不该猜', () => {
      const r = dockSections({ hasThread: true, git: cleanGit, stepCount: 0, contextRatio: null });
      expect(r.context).toBe(false);
    });

    it('未传该字段时不影响其他段（向后兼容）', () => {
      const r = dockSections({ hasThread: true, git: cleanGit, stepCount: 2 });
      expect(r.context).toBe(false);
      expect(r.steps).toBe(true);
      expect(r.any).toBe(true);
    });

    it('仅上下文段可显示时，浮层整体仍要渲染', () => {
      const r = dockSections({ hasThread: false, git: cleanGit, stepCount: 0, contextRatio: 0.95 });
      expect(r.context).toBe(true);
      expect(r.any).toBe(true);
    });
  });
});

describe('changedCount', () => {
  it('汇总四类改动', () => {
    expect(changedCount({ ...cleanGit, staged: 1, modified: 2, untracked: 3, conflicted: 4 })).toBe(10);
  });
  it('null 视为 0', () => {
    expect(changedCount(null)).toBe(0);
  });
});
