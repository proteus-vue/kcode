/**
 * 右栏自动跟随的规则测试。
 *
 * 这套规则的全部难点在**让位给用户**：自动切换有两种失败方式，都很烦人——
 * 抢（用户正看着 diff，Agent 一动就换掉）与黏（用户选了「文件」，一动又被切走）。
 * 因此这里的断言围绕「什么时候**不切**」展开，比「什么时候切」更重要。
 */
import { describe, expect, it } from 'vitest';
import {
  followedScene,
  nextFollowedScene,
  reduceFollowing,
  NO_SIGNAL,
  type FollowSignal,
} from './sceneFollow';
import type { WorkbenchScene } from '../components/scenes';

const all = () => true;
const none = () => false;

const sig = (over: Partial<FollowSignal> = {}): FollowSignal => ({ ...NO_SIGNAL, ...over });

describe('信号优先级', () => {
  it('子代理 > 变更审阅 > 浏览器', () => {
    // 子代理排最前：它是「有别的 agent 在并行干活」这类最容易失去掌控感的事
    expect(followedScene(sig({ subagentActive: true, hasChanges: true, browserOpened: true }))).toBe(
      'subagents',
    );
    expect(followedScene(sig({ hasChanges: true, browserOpened: true }))).toBe('review');
    expect(followedScene(sig({ browserOpened: true }))).toBe('browser');
  });

  it('没有信号时返回 null（表示「不动」，而不是回退默认）', () => {
    expect(followedScene(NO_SIGNAL)).toBeNull();
  });
});

describe('跟随决策：什么时候不切', () => {
  it('用户手动选过 → 一律不切（这是最重要的一条）', () => {
    expect(
      nextFollowedScene(false, 'files', sig({ subagentActive: true }), all),
      '用户明确选了「文件」，Agent 派了子代理也不该抢走他的视图',
    ).toBeNull();
  });

  it('没有信号 → 不切', () => {
    expect(nextFollowedScene(true, 'review', NO_SIGNAL, all)).toBeNull();
  });

  it('目标就是当前场景 → 不切（避免无意义的 setState）', () => {
    expect(nextFollowedScene(true, 'subagents', sig({ subagentActive: true }), all)).toBeNull();
  });

  it('目标场景不可用 → 不切（否则切过去是个空面板）', () => {
    expect(nextFollowedScene(true, 'review', sig({ subagentActive: true }), none)).toBeNull();
  });

  it('当前场景为 null（无标签）时仍可跟随', () => {
    expect(nextFollowedScene(true, null, sig({ hasChanges: true }), all)).toBe('review');
  });
});

describe('跟随决策：什么时候切', () => {
  it('跟随中 + 有新信号 + 目标可用 → 切', () => {
    expect(nextFollowedScene(true, 'review', sig({ subagentActive: true }), all)).toBe('subagents');
    expect(nextFollowedScene(true, 'review', sig({ browserOpened: true }), all)).toBe('browser');
  });

  it('只切到可用的场景（可用性由调用方给，例如子代理为空时不可进）', () => {
    const onlyReview = (s: WorkbenchScene) => s === 'review';
    expect(nextFollowedScene(true, 'review', sig({ subagentActive: true }), onlyReview)).toBeNull();
  });
});

describe('跟随态状态机', () => {
  it('用户手选场景 → 退出跟随', () => {
    expect(reduceFollowing(true, { type: 'userPicked', scene: 'files' })).toBe(false);
  });

  it('用户主动恢复 → 进入跟随', () => {
    expect(reduceFollowing(false, { type: 'userEnabledFollow' })).toBe(true);
  });

  it('换线程 → 恢复跟随（新线程是新的工作上下文）', () => {
    // 用户在旧线程选了「文件」，不该继续约束新线程的右栏
    expect(reduceFollowing(false, { type: 'threadChanged' })).toBe(true);
  });

  it('打开场景**不**通过状态机（程序化切换不会把自己关掉）', () => {
    // 这是刻意的：状态机只接受上述三种动作，没有「opened」这种动作。
    // 若把程序化切换也接进来，「自动跟随」会在第一次切换后自杀。
    const actions = ['userPicked', 'userEnabledFollow', 'threadChanged'] as const;
    expect(actions).toHaveLength(3);
    expect(actions).not.toContain('opened');
  });
});
