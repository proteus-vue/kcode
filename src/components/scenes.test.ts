/**
 * 工作台场景可用性的测试。
 *
 * 钉住的是「什么时候场景**不**出现在菜单里」——空入口是这次要消除的
 * 东西，而它只在特定组合下出现（无 diff、无工作区），靠手点很难覆盖全。
 */
import { describe, expect, it } from 'vitest';
import {
  availableScenes,
  closeOthers,
  closeScene,
  openScene,
  resolveScene,
  SCENES,
  type SceneAvailability,
} from './scenes';

const none: SceneAvailability = {
  review: false,
  terminal: false,
  browser: false,
  files: false,
  chat: false, simulator: false,
};
const all: SceneAvailability = {
  review: true,
  terminal: true,
  browser: true,
  files: true,
  chat: true, simulator: true,
};

describe('工作台场景清单', () => {
  it('包含参照里的六个场景（模拟器为参照之外的自有能力）', () => {
    // 前五个对齐参照（Codex 右栏的「+」菜单）；模拟器取自 MiMo，
    // 是我们用后端探测的工具链真做出来的能力，不是装饰性条目。
    expect(SCENES.map((s) => s.label)).toEqual([
      '审查',
      '终端',
      '浏览器',
      '文件',
      '侧边聊天',
      '模拟器',
    ]);
  });

  it('每个场景都有图标', () => {
    for (const s of SCENES) {
      expect(s.icon, `${s.label} 缺图标`).toBeTruthy();
    }
  });

  it('除模拟器外都有快捷键提示（模拟器未注册快捷键，不该编一个）', () => {
    for (const s of SCENES) {
      if (s.id === 'simulator') {
        // 没有注册的快捷键就不要写提示——写了会让人按了没反应
        expect(s.shortcut, '模拟器没有快捷键，不该编一个').toBe('');
        continue;
      }
      expect(s.shortcut, `${s.label} 缺快捷键提示`).toBeTruthy();
    }
  });
});

describe('availableScenes', () => {
  it('不可用的场景不进菜单', () => {
    expect(availableScenes(none)).toEqual([]);
    const only = availableScenes({ ...none, browser: true });
    expect(only.map((s) => s.id)).toEqual(['browser']);
  });

  it('保持清单顺序，而不是可用性对象的键顺序', () => {
    const r = availableScenes({ ...none, files: true, review: true });
    expect(r.map((s) => s.id)).toEqual(['review', 'files']);
  });

  it('全部可用时返回全部', () => {
    expect(availableScenes(all).length).toBe(SCENES.length);
  });
});

describe('resolveScene', () => {
  it('全部不可用时返回 null（工作台不渲染空壳）', () => {
    expect(resolveScene(null, none)).toBeNull();
    expect(resolveScene('review', none)).toBeNull();
  });

  it('当前场景仍可用时保持不变', () => {
    expect(resolveScene('terminal', all)).toBe('terminal');
  });

  it('当前场景失效时回退到第一个可用场景', () => {
    // 例如切换线程后没有 diff 了，「审查」失效
    const a: SceneAvailability = { ...all, review: false };
    expect(resolveScene('review', a)).toBe('terminal');
  });

  it('未选场景时给第一个可用的', () => {
    expect(resolveScene(null, { ...none, files: true })).toBe('files');
  });

  it('回退顺序与菜单顺序一致', () => {
    expect(resolveScene(null, all)).toBe('review');
  });
});

describe('标签打开列表的操作', () => {
  /**
   * 这一组钉住的是用户报告的那个缺陷：「点关闭回到了最初的终端页」。
   * 根因是标签被实现成「所有可用场景」+ 一个活动值——没有列表可减，
   * 只能把活动值置空，而置空又回退到第一个可用场景。
   */
  it('打开：已打开的场景不重复添加', () => {
    expect(openScene(['review'], 'review')).toEqual(['review']);
    expect(openScene(['review'], 'terminal')).toEqual(['review', 'terminal']);
  });

  it('关闭非活动标签：活动项不变', () => {
    const r = closeScene(['review', 'terminal', 'files'], 'files', 'review');
    expect(r.list).toEqual(['review', 'terminal']);
    expect(r.active).toBe('review');
  });

  it('关闭活动标签：激活其**右邻**', () => {
    // 这是关键：关闭不能变成「跳到第一个场景」
    const r = closeScene(['review', 'terminal', 'files'], 'terminal', 'terminal');
    expect(r.list).toEqual(['review', 'files']);
    expect(r.active).toBe('files');
  });

  it('关闭最右的活动标签：激活左邻', () => {
    const r = closeScene(['review', 'terminal'], 'terminal', 'terminal');
    expect(r.active).toBe('review');
  });

  it('关闭最后一个标签：回到无标签状态（而不是回退到别的场景）', () => {
    const r = closeScene(['terminal'], 'terminal', 'terminal');
    expect(r.list).toEqual([]);
    expect(r.active).toBeNull();
  });

  it('关闭不存在的标签不出错', () => {
    const r = closeScene(['review'], 'files', 'review');
    expect(r.list).toEqual(['review']);
    expect(r.active).toBe('review');
  });

  it('关闭其他：只留当前激活的那个', () => {
    expect(closeOthers(['review', 'terminal', 'files'], 'terminal')).toEqual(['terminal']);
  });

  it('关闭其他：激活项不在列表里时清空', () => {
    expect(closeOthers(['review'], null)).toEqual([]);
  });
});
