/**
 * Markdown 渲染。
 *
 * 之前模型回复以纯文本 `white-space: pre-wrap` 显示——代码块、列表、表格
 * 全部塌成一片文字，这是与成熟客户端最直观的差距之一。
 *
 * # 安全
 *
 * `react-markdown` 默认**不渲染原始 HTML**（无 `rehype-raw`），
 * 因此模型输出里的 `<script>` 之类不会被当作 HTML 执行。
 * 这一点必须保持——模型的输出是**不可信内容**，它可能被仓库里的
 * 文件内容、网页抓取结果等注入。
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 代码块：区分行内与块级，块级加滚动
          code({ className, children, ...props }) {
            const isBlock = /language-/.test(className ?? '') || String(children).includes('\n');
            if (!isBlock) {
              return (
                <code className="inline-code" {...props}>
                  {children}
                </code>
              );
            }
            const lang = /language-(\w+)/.exec(className ?? '')?.[1];
            return (
              <pre className="md-code-block" data-lang={lang}>
                <code>{children}</code>
              </pre>
            );
          },
          // 外链不应在应用内导航
          a({ href, children }) {
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
          // 表格在窄栏里需要横向滚动
          table({ children }) {
            return (
              <div className="md-table-wrap">
                <table>{children}</table>
              </div>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
