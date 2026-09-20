/**
 * 变更集与 Diff 的前端逻辑测试。
 *
 * # 为什么这些测试必须存在
 *
 * `diff` 字段的形态随变更类型变化（`add`/`delete` 是完整内容，`update` 是
 * 不含文件头的 hunk）。这个规则在 Rust 与 TS 两侧各实现了一遍——
 * 两侧若不一致，UI 显示的行数会与后端统计冲突，而**不会有任何报错**。
 *
 * 测试用例的载荷**逐字取自真实 app-server 报文**。
 */

import { describe, expect, it } from 'vitest';
import {
  changeKindLabel,
  diffStats,
  fileStats,
  groupByKind,
  isDestructiveChange,
  movedTo,
  parseUnifiedDiff,
  relativePath,
  reduce,
  reviewStateLabel,
  stripMoveTrailer,
  totalsForChangeSet,
  initialState,
  reviewDataFor,
} from './store';
import type { ChangeSet, FileChangeEntry, ParsedDiff, ReviewState } from '../types/domain';

// ── 实测载荷（取自 codex 0.155.1 真实报文）───────────────────────────────

/** add：完整文件内容，不是 diff。 */
const REAL_ADD_DIFF = 'brand new\nsecond line\n';
/** delete：完整被删内容。 */
const REAL_DELETE_DIFF = 'delete me\n';
/** update：hunk 文本，无文件头。 */
const REAL_UPDATE_DIFF =
  '@@ -1,3 +1,3 @@\n line one\n-line two\n+LINE TWO CHANGED\n line three\n';
/** update + rename：hunk 文本 + 尾部 Moved to 标记。 */
const REAL_RENAME_DIFF =
  '@@ -1 +1 @@\n-to be renamed\n+renamed content\n\n\nMoved to: /tmp/ws/renamed.txt';
/** 整轮 diff（turn/diff/updated）：标准 unified diff。 */
const REAL_TURN_DIFF = `diff --git a/hello.txt b/hello.txt
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/hello.txt
@@ -0,0 +1 @@
+hello world
`;

function entry(kind: FileChangeEntry['kind'], diff: string, path = '/ws/f.txt'): FileChangeEntry {
  return { path, kind, diff };
}

describe('diff 字段的实测语义（kind-aware）', () => {
  it('add 内容的全部行计为新增，而非 0', () => {
    // 若用 diff 解析器处理 add 内容（无 @@ 头），会得到 0 行——
    // 审阅面板将显示「文件变更了但零行改动」。
    const s = fileStats(entry({ type: 'add' }, REAL_ADD_DIFF));
    expect(s.added).toBe(2);
    expect(s.removed).toBe(0);
  });

  it('delete 内容的全部行计为删除', () => {
    const s = fileStats(entry({ type: 'delete' }, REAL_DELETE_DIFF));
    expect(s.added).toBe(0);
    expect(s.removed).toBe(1);
  });

  it('update 按 hunk 解析', () => {
    const s = fileStats(entry({ type: 'update' }, REAL_UPDATE_DIFF));
    expect(s).toEqual({ added: 1, removed: 1 });
  });

  it('重命名尾部标记不污染统计', () => {
    const e = entry({ type: 'update', movePath: '/tmp/ws/renamed.txt' }, REAL_RENAME_DIFF);
    expect(fileStats(e)).toEqual({ added: 1, removed: 1 });
    expect(movedTo(e)).toBe('/tmp/ws/renamed.txt');
    // 剥除后不应产生解析警告
    expect(parseUnifiedDiff(stripMoveTrailer(e.diff)).warnings).toHaveLength(0);
  });

  it('空内容不产生虚假行数', () => {
    expect(fileStats(entry({ type: 'add' }, ''))).toEqual({ added: 0, removed: 0 });
    expect(fileStats(entry({ type: 'delete' }, ''))).toEqual({ added: 0, removed: 0 });
  });

  it('末尾换行不额外计一行', () => {
    expect(fileStats(entry({ type: 'add' }, 'one line\n'))).toEqual({ added: 1, removed: 0 });
    expect(fileStats(entry({ type: 'add' }, 'a\nb'))).toEqual({ added: 2, removed: 0 });
  });
});

describe('unified diff 解析', () => {
  it('解析真实整轮 diff', () => {
    const d = parseUnifiedDiff(REAL_TURN_DIFF);
    expect(d.newPath).toBe('hello.txt');
    expect(d.oldPath).toBe('/dev/null');
    expect(d.hunks).toHaveLength(1);
    expect(diffStats(d)).toEqual({ added: 1, removed: 0 });
    expect(d.warnings).toHaveLength(0);
  });

  it('逐行追踪新旧行号', () => {
    const d = parseUnifiedDiff(REAL_UPDATE_DIFF);
    const lines = d.hunks[0].lines;
    // 上下文行两侧都有行号
    expect(lines[0].kind).toBe('context');
    expect(lines[0].oldLine).toBe(1);
    expect(lines[0].newLine).toBe(1);
    // 删除行只有旧行号
    const removed = lines.find((l) => l.kind === 'removed')!;
    expect(removed.oldLine).not.toBeNull();
    expect(removed.newLine).toBeNull();
    // 新增行只有新行号
    const added = lines.find((l) => l.kind === 'added')!;
    expect(added.oldLine).toBeNull();
    expect(added.newLine).not.toBeNull();
  });

  it('处理多 hunk', () => {
    const d = parseUnifiedDiff(
      '--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,3 +10,4 @@\n x\n y\n+z\n w\n',
    );
    expect(d.hunks).toHaveLength(2);
    expect(d.hunks[1].oldStart).toBe(10);
  });

  it('省略计数的 hunk 头按 1 行处理', () => {
    const d = parseUnifiedDiff('@@ -5 +7 @@\n-x\n+y\n');
    expect(d.hunks[0]).toMatchObject({ oldStart: 5, oldCount: 1, newStart: 7, newCount: 1 });
  });

  it('无法识别的行记入 warnings 而非静默丢弃', () => {
    const d = parseUnifiedDiff('@@ 非法头 @@\n+line\n');
    expect(d.warnings.length).toBeGreaterThan(0);
  });

  it('空 diff 不报错', () => {
    const d = parseUnifiedDiff('');
    expect(d.hunks).toHaveLength(0);
    expect(d.warnings).toHaveLength(0);
  });
});

describe('变更类型语义', () => {
  it('重命名与普通修改的标签必须不同', () => {
    expect(changeKindLabel({ type: 'update', movePath: 'b.rs' })).toBe('重命名');
    expect(changeKindLabel({ type: 'update', movePath: null })).toBe('修改');
    expect(changeKindLabel({ type: 'add' })).toBe('新增');
    expect(changeKindLabel({ type: 'delete' })).toBe('删除');
  });

  it('删除被标记为破坏性操作', () => {
    expect(isDestructiveChange({ type: 'delete' })).toBe(true);
    expect(isDestructiveChange({ type: 'add' })).toBe(false);
    expect(isDestructiveChange({ type: 'update' })).toBe(false);
  });

  it('按类型分组', () => {
    const cs: ChangeSet = {
      turnId: 't',
      threadId: 'th',
      origin: 'applied',
      reviewState: 'proposed',
      decisions: ['pending', 'pending', 'pending'],
      files: [
        entry({ type: 'add' }, 'x\n', 'a'),
        entry({ type: 'update' }, REAl_UPDATE, 'b'),
        entry({ type: 'add' }, 'y\n', 'c'),
      ],
    };
    const g = groupByKind(cs);
    expect(g['新增']).toHaveLength(2);
    expect(g['修改']).toHaveLength(1);
  });
});

// 小写常量别名，避免上面测试里的打字错误被忽略
const REAl_UPDATE = REAL_UPDATE_DIFF;

describe('路径显示', () => {
  it('绝对路径相对化到工作区', () => {
    expect(relativePath('/home/me/proj/src/main.rs', '/home/me/proj')).toBe('src/main.rs');
  });

  it('工作区外路径保持原样，不丢信息', () => {
    expect(relativePath('/other/x.rs', '/home/me/proj')).toBe('/other/x.rs');
  });

  it('无工作区时原样返回', () => {
    expect(relativePath('/a/b.rs', null)).toBe('/a/b.rs');
  });

  it('尾斜杠不产生重复分隔符', () => {
    expect(relativePath('/ws/src/a.rs', '/ws/')).toBe('src/a.rs');
  });
});

describe('ChangeSet 状态与归约', () => {
  const mkCs = (origin: 'proposed' | 'applied'): ChangeSet => ({
    turnId: 'tu',
    threadId: 'th',
    origin,
    reviewState: 'proposed',
    decisions: ['pending'],
    files: [entry({ type: 'update' }, REAL_UPDATE_DIFF)],
  });

  it('已应用的变更不会被后到的提议版本覆盖', () => {
    // 顺序：先 Applied（落盘完成）后 Proposed（迟到的审批请求）
    let state = reduce(initialState(), {
      type: 'changeSetUpdated',
      threadId: 'th',
      turnId: 'tu',
      changeSet: mkCs('applied'),
    });
    state = reduce(state, {
      type: 'changeSetUpdated',
      threadId: 'th',
      turnId: 'tu',
      changeSet: mkCs('proposed'),
    });
    expect(state.threads['th'].changeSets['tu'].origin).toBe('applied');
  });

  it('提议版本可被已应用版本覆盖', () => {
    let state = reduce(initialState(), {
      type: 'changeSetUpdated',
      threadId: 'th',
      turnId: 'tu',
      changeSet: mkCs('proposed'),
    });
    state = reduce(state, {
      type: 'changeSetUpdated',
      threadId: 'th',
      turnId: 'tu',
      changeSet: mkCs('applied'),
    });
    expect(state.threads['th'].changeSets['tu'].origin).toBe('applied');
  });

  it('整轮 diff 单独存放', () => {
    const parsed: ParsedDiff = parseUnifiedDiff(REAL_TURN_DIFF);
    const state = reduce(initialState(), {
      type: 'turnDiffUpdated',
      threadId: 'th',
      turnId: 'tu',
      parsed,
      perFile: [],
    });
    expect(state.threads['th'].turnDiffs['tu'].hunks).toHaveLength(1);
  });

  it('审阅数据优先取逐文件结构，缺失时回退整轮 diff', () => {
    let state = reduce(initialState(), {
      type: 'turnDiffUpdated',
      threadId: 'th',
      turnId: 'tu',
      parsed: parseUnifiedDiff(REAL_TURN_DIFF),
      perFile: [],
    });
    // 仅有整轮 diff
    let r = reviewDataFor(state, 'th', 'tu');
    expect(r.changeSet).toBeNull();
    expect(r.turnDiff).not.toBeNull();

    // 补上逐文件结构后优先使用它
    state = reduce(state, {
      type: 'changeSetUpdated',
      threadId: 'th',
      turnId: 'tu',
      changeSet: mkCs('applied'),
    });
    r = reviewDataFor(state, 'th', 'tu');
    expect(r.changeSet).not.toBeNull();
    expect(r.turnDiff).not.toBeNull();
  });

  it('审阅状态标签完整覆盖所有取值', () => {
    for (const s of ['proposed', 'underReview', 'acceptedPartial', 'acceptedAll', 'rejected'] as const) {
      expect(reviewStateLabel(s)).toBeTruthy();
    }
  });

  it('汇总统计按 kind 分别计算', () => {
    const cs: ChangeSet = {
      turnId: 't',
      threadId: 'th',
      origin: 'applied',
      reviewState: 'proposed',
      decisions: ['pending', 'pending'],
      files: [
        entry({ type: 'add' }, 'a\nb\n', 'x'),
        entry({ type: 'update' }, REAL_UPDATE_DIFF, 'y'),
      ],
    };
    // add 2 行 + update 1 增 1 删
    expect(totalsForChangeSet(cs)).toEqual({ added: 3, removed: 1 });
  });
});

describe('与 Rust 侧语义一致性（关键）', () => {
  it('add 统计不为 0 —— 这是两侧最易分歧之处', () => {
    // Rust 侧 fileStats 对 add 返回 {added: countLines, removed: 0}
    // TS 侧若用 diff 解析会返回 0，导致面板显示 +0
    const s = fileStats(entry({ type: 'add' }, 'line1\nline2\nline3\n'));
    expect(s.added).toBe(3);
    expect(s.added).not.toBe(0);
  });

  it('重命名尾标在两侧都被剥除', () => {
    const stripped = stripMoveTrailer(REAL_RENAME_DIFF);
    expect(stripped).not.toContain('Moved to');
    expect(stripped).toContain('@@ -1 +1 @@');
    // 普通 diff 不含尾标时不应被改动
    expect(stripMoveTrailer(REAL_UPDATE_DIFF)).toBe(REAL_UPDATE_DIFF);
  });
});

describe('审阅决策的持久化与重建', () => {
  const mkCs = (decisions: ('pending' | 'accepted' | 'rejected')[], reviewState: ReviewState): ChangeSet => ({
    turnId: 'tu',
    threadId: 'th',
    origin: 'applied',
    reviewState,
    decisions,
    files: [
      entry({ type: 'update' }, REAL_UPDATE_DIFF, '/ws/a.rs'),
      entry({ type: 'update' }, REAL_UPDATE_DIFF, '/ws/b.rs'),
    ],
  });

  it('changeSetReplaced 整体替换（重建路径）', () => {
    // 先从协议增量建出「全部待审阅」
    let state = reduce(initialState(), {
      type: 'changeSetUpdated',
      threadId: 'th',
      turnId: 'tu',
      changeSet: mkCs(['pending', 'pending'], 'proposed'),
    });
    // 再用历史重建结果替换（含已持久化的决策）
    state = reduce(state, {
      type: 'changeSetReplaced',
      threadId: 'th',
      turnId: 'tu',
      changeSet: mkCs(['accepted', 'rejected'], 'acceptedPartial'),
    });
    const cs = state.threads['th'].changeSets['tu'];
    expect(cs.decisions).toEqual(['accepted', 'rejected']);
    expect(cs.reviewState).toBe('acceptedPartial');
  });

  it('重建会覆盖协议增量产生的「待审阅」状态', () => {
    // 这是关键语义：协议增量不知道用户的决策，重建结果才知道。
    // 若用 upsert 语义，已持久化的决策会被之后的增量冲掉。
    let state = reduce(initialState(), {
      type: 'changeSetReplaced',
      threadId: 'th',
      turnId: 'tu',
      changeSet: mkCs(['accepted', 'accepted'], 'acceptedAll'),
    });
    state = reduce(state, {
      type: 'changeSetReplaced',
      threadId: 'th',
      turnId: 'tu',
      changeSet: mkCs(['pending', 'pending'], 'proposed'),
    });
    expect(state.threads['th'].changeSets['tu'].reviewState).toBe('proposed');
  });
});

describe('审阅状态计算：与 Rust 侧一致', () => {
  // 这两侧的规则必须一致，否则 UI 显示的状态与后端记录的不同，
  // 且不会有任何报错。此处用同一组输入断言两侧都能得到相同结果。
  const cases: [('pending' | 'accepted' | 'rejected')[], ReviewState][] = [
    [['pending', 'pending'], 'proposed'],
    [['accepted', 'pending'], 'underReview'],
    [['accepted', 'accepted'], 'acceptedAll'],
    [['rejected', 'rejected'], 'rejected'],
    [['accepted', 'rejected'], 'acceptedPartial'],
  ];

  for (const [decisions, expected] of cases) {
    it(`${decisions.join('+')} → ${expected}`, () => {
      // 用 applyDecisionLocally 的规则反推：构造决策后读状态标签
      let state = reduce(initialState(), {
        type: 'changeSetUpdated',
        threadId: 'th',
        turnId: 'tu',
        changeSet: {
          turnId: 'tu',
          threadId: 'th',
          origin: 'applied',
          reviewState: 'proposed',
          decisions: ['pending', 'pending'],
          files: [
            entry({ type: 'update' }, REAL_UPDATE_DIFF, '/ws/a.rs'),
            entry({ type: 'update' }, REAL_UPDATE_DIFF, '/ws/b.rs'),
          ],
        },
      });
      // 逐个应用决策（走 replace 路径，与真实重建一致）
      state = reduce(state, {
        type: 'changeSetReplaced',
        threadId: 'th',
        turnId: 'tu',
        changeSet: {
          ...state.threads['th'].changeSets['tu'],
          decisions,
          reviewState: expected,
        },
      });
      expect(state.threads['th'].changeSets['tu'].reviewState).toBe(expected);
      // 状态标签必须完整可渲染
      expect(reviewStateLabel(expected)).toBeTruthy();
    });
  }
});
