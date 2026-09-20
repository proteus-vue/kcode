/**
 * Item 渲染。
 *
 * 分工：**过程性动作**（命令、文件变更、工具调用）交给 ToolRow 做紧凑单行；
 * 本组件只负责**对话内容**（用户消息、回复、推理、计划）。
 *
 * 这个分工来自实际观感：把所有 Item 都渲染成厚卡片会把时间线撑得很长，
 * 反而看不清「Agent 到底做了什么」。
 */
import type { Item } from '../types/domain';
import { Markdown } from './Markdown';
import { ToolRow } from './ToolRow';

export function ItemCard({
  item,
  streamedText,
  streaming,
  onOpenFile,
}: {
  item: Item;
  /** 正在流入的增量内容（尚未并入 item 正式字段）。 */
  streamedText?: string;
  streaming?: boolean;
  /** 点击文件路径时在右栏打开详情。 */
  onOpenFile?: (path: string) => void;
}) {
  const text =
    streamedText && streamedText.length > 0
      ? streamedText
      : (item.body as { text?: string }).text ?? '';

  switch (item.body.kind) {
    case 'userMessage':
      return (
        <div className="bubble user">
          <div className="bubble-inner">{item.body.text}</div>
        </div>
      );

    case 'agentMessage':
      return (
        <div className={`bubble agent ${streaming ? 'is-streaming' : ''}`}>
          <div className="bubble-inner">
            <Markdown>{text}</Markdown>
            {streaming && <span className="stream-cursor" aria-label="生成中" />}
          </div>
        </div>
      );

    case 'reasoning':
      return (
        <details className="thinking" open={streaming}>
          <summary>
            <span className="thinking-label">推理过程{streaming ? ' · 生成中' : ''}</span>
            <span className="thinking-toggle" />
          </summary>
          <div className="thinking-body">
            <Markdown>{text}</Markdown>
          </div>
        </details>
      );

    case 'plan':
      return (
        <div className={`plan-block ${streaming ? 'is-streaming' : ''}`}>
          <div className="plan-head">执行计划</div>
          <Markdown>{text}</Markdown>
        </div>
      );

    case 'contextCompaction':
      return <div className="divider-row">上下文已压缩</div>;

    case 'collabAgent':
      return <div className="divider-row">协作：{item.body.description}</div>;

    // 过程性动作交给 ToolRow
    case 'commandExecution':
    case 'fileChange':
    case 'toolCall':
    case 'webSearch':
    case 'imageView':
      return <ToolRow item={item} onOpenFile={onOpenFile} />;

    case 'other':
      // 协议新增了未识别的类型：显式呈现而非丢弃，否则时间线会「少东西」而无从察觉
      return (
        <div className="divider-row">
          未识别的条目类型：<code>{item.body.protocolType}</code>
        </div>
      );
  }
}
