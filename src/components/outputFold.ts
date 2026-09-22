/**
 * 长输出的折叠阈值。
 *
 * # 为什么必须有
 *
 * 一次 `cat` 大文件、一次 `npm install`、一次失败的测试套件，都能产出
 * 几百 KB 文本。全部塞进 DOM 的后果有两层：
 *
 * 1. **渲染卡顿**——几万个文本节点让整个时间线滚动变得粘滞；
 * 2. **更隐蔽的一层**：一屏塞满原始输出后，用户反而找不到「这一步到底
 *    做了什么、结果如何」，工具行也就失去了「紧凑」的意义。
 *
 * 采用**字符数**而非字节数作为判据：输出里的中文与日志行长度差异极大，
 * 而真正影响渲染的是字符数。
 */

/** 单条工具输出的展示上限（字符）。超过则折叠。 */
export const OUTPUT_LIMIT = 30_000;

export interface FoldedOutput {
  /** 实际展示的文本。 */
  text: string;
  /** 是否发生了截断。 */
  truncated: boolean;
  /** 被折叠掉的字符数（未截断时为 0）。 */
  hiddenChars: number;
  /** 原始总长度。 */
  totalChars: number;
}

/**
 * 按上限折叠输出。
 *
 * # 从**尾部**保留而不是头部
 *
 * 命令输出的关键信息几乎总在末尾：报错的堆栈、测试的汇总行
 * （`2 failed, 10 passed`）、构建结果。若保留头部，用户看到的是
 * 一堆无关的进度日志，还得展开才能知道结果。
 *
 * 因此这里是「掐头保尾」：丢掉前面的部分，保留最后 `OUTPUT_LIMIT` 个字符，
 * 并在开头明确告知丢了多少。
 */
export function foldOutput(text: string | null | undefined, limit = OUTPUT_LIMIT): FoldedOutput {
  const raw = text ?? '';
  const total = raw.length;

  if (total <= limit) {
    return { text: raw, truncated: false, hiddenChars: 0, totalChars: total };
  }

  const kept = raw.slice(total - limit);
  const hidden = total - limit;
  // 补一行说明放在最前面：用户必须知道「上面还有内容被省略了」，
  // 否则他会以为这就是完整输出。
  const notice = `⋯ 前 ${hidden.toLocaleString()} 个字符已折叠（共 ${total.toLocaleString()}）\n`;
  return { text: notice + kept, truncated: true, hiddenChars: hidden, totalChars: total };
}
