/**
 * 行内评论的纯函数测试。
 *
 * 重点不在「能排序」，而在**发出去的那段文字是否自包含且意图明确**：
 * 这一层的错误没有任何 UI 反馈能暴露——模型只会照着错的指令去改代码，
 * 用户看到的是「它改了我没让它改的地方」。
 */
import { describe, expect, it } from 'vitest';
import type { DiffLine } from '../../types/domain';
import {
  anchorOf,
  commentKey,
  countForPath,
  intentLabel,
  makeComment,
  removeComment,
  removeCommentsForPath,
  serializeComments,
  summarize,
  upsertComment,
  type ReviewComment,
} from '../reviewComments';

const c = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: 'a.ts:new:3',
  path: 'a.ts',
  line: 3,
  side: 'new',
  intent: 'change',
  text: '这里应该加空值检查',
  anchor: 'const x = obj.value',
  ...over,
});

describe('锚点', () => {
  it('新增行锚到新文件行号', () => {
    const l: DiffLine = { kind: 'added', text: 'a', oldLine: null, newLine: 7 };
    expect(anchorOf(l)).toEqual({ side: 'new', line: 7 });
  });

  it('删除行锚到旧文件行号', () => {
    // 被删除的行在新文件里已经不存在，锚到新文件会让模型找不到它
    const l: DiffLine = { kind: 'removed', text: 'a', oldLine: 12, newLine: null };
    expect(anchorOf(l)).toEqual({ side: 'old', line: 12 });
  });

  it('上下文行优先取新文件行号', () => {
    const l: DiffLine = { kind: 'context', text: 'a', oldLine: 5, newLine: 9 };
    expect(anchorOf(l)).toEqual({ side: 'new', line: 9 });
  });

  it('两侧都无行号时返回 null（不编一个行号出来）', () => {
    const l: DiffLine = { kind: 'context', text: 'a', oldLine: null, newLine: null };
    expect(anchorOf(l)).toBeNull();
  });
});

describe('增删改', () => {
  it('同一行重复评论是替换而非追加', () => {
    const first = makeComment({
      path: 'a.ts',
      side: 'new',
      line: 3,
      intent: 'change',
      text: '改成 x',
      anchor: 'const a = 1',
    });
    const second = makeComment({
      path: 'a.ts',
      side: 'new',
      line: 3,
      intent: 'context',
      text: '这行没问题',
      anchor: 'const a = 1',
    });
    let list = upsertComment([], first);
    list = upsertComment(list, second);
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('这行没问题');
    expect(list[0].intent).toBe('context');
  });

  it('不同侧的同号行是两条（旧文件第 3 行与新文件第 3 行不是同一处）', () => {
    const a = makeComment({ path: 'a.ts', side: 'old', line: 3, intent: 'change', text: 'x', anchor: '' });
    const b = makeComment({ path: 'a.ts', side: 'new', line: 3, intent: 'change', text: 'y', anchor: '' });
    expect(a.id).not.toBe(b.id);
    expect(upsertComment([a], b)).toHaveLength(2);
  });

  it('按 id 删除', () => {
    const list = [c({ id: 'x' }), c({ id: 'y' })];
    expect(removeComment(list, 'x').map((v) => v.id)).toEqual(['y']);
  });

  it('按路径清空（文件被撤销后不留悬空评论）', () => {
    const list = [c({ path: 'a.ts' }), c({ path: 'b.ts', id: 'b' })];
    expect(removeCommentsForPath(list, 'a.ts').map((v) => v.path)).toEqual(['b.ts']);
    expect(countForPath(list, 'a.ts')).toBe(1);
  });

  it('键包含路径与侧别', () => {
    expect(commentKey('src/a.ts', 'new', 4)).toBe('src/a.ts:new:4');
  });
});

describe('序列化：意图必须写清', () => {
  it('只有说明时明确要求不要改代码', () => {
    const out = serializeComments([c({ intent: 'context', text: '解释一下' })]);
    // 少这一句的后果很具体：模型把 5 条解释当成修改清单，全改了
    expect(out).toContain('不要修改代码');
    expect(out).toContain('仅上下文');
  });

  it('混合时说明「哪些要改、哪些只是说明」', () => {
    const out = serializeComments([
      c({ id: '1', line: 3, intent: 'change', text: '加空值检查' }),
      c({ id: '2', line: 5, intent: 'context', text: '这里是有意为之' }),
    ]);
    expect(out).toContain('2 处标注中，1 处要求修改');
    expect(out).toContain('其余仅为说明');
  });

  it('每条都带文件、行号、侧别、原文与说明', () => {
    const out = serializeComments([c()]);
    expect(out).toContain('【文件】a.ts');
    expect(out).toContain('第 3 行（改动后）');
    expect(out).toContain('该行内容：const x = obj.value');
    expect(out).toContain('说明：这里应该加空值检查');
  });

  it('删除行的侧别写作「改动前」', () => {
    const out = serializeComments([c({ side: 'old', line: 2 })]);
    expect(out).toContain('第 2 行（改动前）');
  });

  it('空评论被过滤：中间态不该发给模型', () => {
    const out = serializeComments([c({ id: '1', text: '   ' }), c({ id: '2', text: '有内容' })]);
    expect(out).toContain('有内容');
    expect(out).toContain('1 处标注');
  });

  it('全是空评论时返回空串（调用方据此不发送）', () => {
    expect(serializeComments([c({ text: '  ' })])).toBe('');
    expect(serializeComments([])).toBe('');
  });

  it('按文件分组、组内按行号升序', () => {
    const out = serializeComments([
      c({ id: 'b1', path: 'b.ts', line: 1, text: 'B' }),
      c({ id: 'a2', path: 'a.ts', line: 20, text: 'A2' }),
      c({ id: 'a1', path: 'a.ts', line: 4, text: 'A1' }),
    ]);
    // 同一文件的条目必须连续且有序，否则模型要自己拼「这个文件改哪几行」
    expect(out.indexOf('【文件】b.ts')).toBeLessThan(out.indexOf('【文件】a.ts'));
    expect(out.indexOf('A1')).toBeLessThan(out.indexOf('A2'));
  });

  it('锚点为空时不写「该行内容：」空标签', () => {
    const out = serializeComments([c({ anchor: '  ' })]);
    expect(out).not.toContain('该行内容：\n');
  });
});

describe('摘要', () => {
  it('统计条数与涉及文件数', () => {
    const list = [
      c({ id: '1', path: 'a.ts' }),
      c({ id: '2', path: 'a.ts' }),
      c({ id: '3', path: 'b.ts' }),
      c({ id: '4', path: 'c.ts', text: '   ' }),
    ];
    expect(summarize(list)).toEqual({ count: 3, files: 2 });
  });
});

describe('意图文案', () => {
  it('两种意图的文案必须不同', () => {
    expect(intentLabel('change')).not.toBe(intentLabel('context'));
  });
});
