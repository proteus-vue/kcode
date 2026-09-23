/**
 * 审阅时的行内评论。
 *
 * # 模型看不到界面
 *
 * 评论最终是**一段发给 Agent 的文字**。所以每条都必须自包含：
 * 哪个文件、哪一行、那行原本是什么内容、以及这条评论是「只是说明」
 * 还是「请改掉」。少任何一项，模型就只能猜——而「猜错文件/猜错行」
 * 的表现是它改了一处看起来合理但完全无关的代码，用户只会以为模型很蠢。
 *
 * # 两种意图必须分开，不能合并
 *
 * - `context`：「这行是给上下文，不要动」——用户想解释、提问或备注；
 * - `change`：「这行要改」——用户明确要求修改。
 *
 * 合并成一种的后果很具体：用户标注了 5 行解释「为什么这么写」，
 * 模型把它当成修改清单，动手改了那 5 行。反之亦然。
 * 这里的纪律与 `attachmentSerialize` 一致：**这一层没有 UI 反馈能暴露
 * 字段缺失**，发出去就是发出去了，所以纯函数 + 测试。
 */

import type { DiffLine } from '../types/domain';

export type CommentIntent = 'context' | 'change';

export interface ReviewComment {
  /** 同一行只有一条评论，键由 path+side+line 决定（见 commentKey）。 */
  id: string;
  /** 仓库内相对路径（绝对路径对模型没有意义，且会泄漏本机目录结构）。 */
  path: string;
  /** 该行在对应侧文件里的行号。 */
  line: number;
  /**
   * 锚定在哪一侧：
   * - `new`：新增行/上下文行 → 新文件行号（模型改的是工作区里的文件）；
   * - `old`：被删除的行 → 旧文件行号（新文件里这一行已经不存在了）。
   */
  side: 'old' | 'new';
  intent: CommentIntent;
  text: string;
  /** 该行的代码内容，让模型能定位到具体是哪一行。 */
  anchor: string;
}

/**
 * 评论的唯一键。
 *
 * 同一行重复评论时**替换**而不是追加：两段针对同一行的评论会让模型
 * 猜测哪一句是最终意图（尤其当一句是「这里没问题」、另一句是「改成 x」
 * 时，它无从判断）。
 */
export function commentKey(path: string, side: 'old' | 'new', line: number): string {
  return `${path}:${side}:${line}`;
}

/** 取一行 diff 的锚点（行号 + 侧别）。没有行号的行（理论不该出现）返回 null。 */
export function anchorOf(line: DiffLine): { side: 'old' | 'new'; line: number } | null {
  // 新增行只存在于新文件，删除行只存在于旧文件，上下文行两侧都有——
  // 优先取新增侧：模型最终要改的是工作区里的那份文件。
  if (line.kind === 'added' && line.newLine !== null) {
    return { side: 'new', line: line.newLine };
  }
  if (line.kind === 'removed' && line.oldLine !== null) {
    return { side: 'old', line: line.oldLine };
  }
  if (line.newLine !== null) return { side: 'new', line: line.newLine };
  if (line.oldLine !== null) return { side: 'old', line: line.oldLine };
  return null;
}

/** 新建一条评论（id 由锚点决定）。 */
export function makeComment(input: {
  path: string;
  side: 'old' | 'new';
  line: number;
  intent: CommentIntent;
  text: string;
  anchor: string;
}): ReviewComment {
  return {
    ...input,
    id: commentKey(input.path, input.side, input.line),
  };
}

/** 加入或替换（同一行只保留最新一条）。 */
export function upsertComment(list: ReviewComment[], c: ReviewComment): ReviewComment[] {
  const i = list.findIndex((x) => x.id === c.id);
  if (i === -1) return [...list, c];
  const next = [...list];
  next[i] = c;
  return next;
}

export function removeComment(list: ReviewComment[], id: string): ReviewComment[] {
  return list.filter((c) => c.id !== id);
}

/** 删除某文件下的全部评论（文件被撤销、被移除后不该留下悬空评论）。 */
export function removeCommentsForPath(list: ReviewComment[], path: string): ReviewComment[] {
  return list.filter((c) => c.path !== path);
}

/** 某文件的评论数（文件行上显示角标，避免「评论藏在折叠区里」）。 */
export function countForPath(list: ReviewComment[], path: string): number {
  return list.filter((c) => c.path === path).length;
}

export function intentLabel(intent: CommentIntent): string {
  return intent === 'change' ? '要改' : '仅上下文';
}

/**
 * 序列化成发给模型的一段文字。
 *
 * 按文件分组、组内按行号排序：模型据此能一次看清「这个文件要改哪几行」，
 * 而不是在一堆散乱条目里自己拼。**空评论被过滤掉**——一条没有内容的
 * 评论是用户在编辑过程中的中间态，发出去只会让模型困惑。
 */
export function serializeComments(comments: ReviewComment[]): string {
  const useful = comments.filter((c) => c.text.trim() !== '');
  if (useful.length === 0) return '';

  const byPath = new Map<string, ReviewComment[]>();
  for (const c of useful) {
    const arr = byPath.get(c.path);
    if (arr) arr.push(c);
    else byPath.set(c.path, [c]);
  }

  const blocks: string[] = [];
  for (const [path, list] of byPath) {
    const sorted = [...list].sort((a, b) => a.line - b.line);
    const lines: string[] = [`【文件】${path}`];
    const changes = sorted.filter((c) => c.intent === 'change').length;
    lines.push(
      changes > 0
        ? `以下 ${sorted.length} 处标注中，${changes} 处要求修改，其余仅为说明（说明部分不要改动）。`
        : `以下 ${sorted.length} 处标注均为说明，**不要修改代码**。`,
    );
    for (const c of sorted) {
      lines.push(
        [
          `- 第 ${c.line} 行（${c.side === 'old' ? '改动前' : '改动后'}）：${intentLabel(c.intent)}`,
          c.anchor.trim() !== '' ? `  该行内容：${c.anchor}` : '',
          `  说明：${c.text.trim()}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    blocks.push(lines.join('\n'));
  }
  return blocks.join('\n\n');
}

/** 涉及的评论条数与文件数（用于输入区的附件芯片文案）。 */
export function summarize(comments: ReviewComment[]): { count: number; files: number } {
  const useful = comments.filter((c) => c.text.trim() !== '');
  return { count: useful.length, files: new Set(useful.map((c) => c.path)).size };
}
