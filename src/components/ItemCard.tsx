/**
 * Item 渲染。
 *
 * 分工：**过程性动作**（命令、文件变更、工具调用）交给 ToolRow 做紧凑单行；
 * 本组件只负责**对话内容**（用户消息、回复、推理、计划）。
 *
 * 这个分工来自实际观感：把所有 Item 都渲染成厚卡片会把时间线撑得很长，
 * 反而看不清「Agent 到底做了什么」。
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Item } from '../types/domain';
import { Icon } from './Icon';
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
          <div className="bubble-inner">
            {item.body.text}
            {/* 该消息携带的图片。服务端会把 localImage 原样回显在
                userMessage.content 里，因此这里能还原「当时发了哪几张」——
                不显示的话，用户看到自己那条是纯文字，而图片其实已发出
                且模型确实看到了。 */}
            {(item.body.images ?? []).length > 0 && (
              <div className="msg-images">
                {(item.body.images ?? []).map((path) => (
                  <MessageImage key={path} path={path} />
                ))}
              </div>
            )}
          </div>
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
            <span className="thinking-toggle">
              <Icon name="chevron" size={11} />
            </span>
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

/**
 * 消息里的一张图片。
 *
 * 图片字节只在附件目录里，通过 `read_attachment_image` 取回 data URL
 * （**不是**按任意路径读：那个接口只认附件目录）。
 * 加载完成前先占位，避免长消息在图片到达时跳动。
 */
function MessageImage({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(false);

  useEffect(() => {
    let alive = true;
    void invoke<string>('read_attachment_image', { path })
      .then((d) => {
        if (alive) setSrc(d);
      })
      .catch(() => {
        // 附件可能已被清理（attachments 目录是应用数据，用户可清）。
        // 不静默：显示成「图片已不可用」而不是留一个空白占位。
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [path]);

  if (failed) {
    return (
      <span className="msg-image is-missing" title={path}>
        图片已不可用
      </span>
    );
  }
  if (!src) return <span className="msg-image is-loading" />;

  return (
    <>
      <button
        className="msg-image"
        onClick={() => setZoom(true)}
        title="点击放大"
        aria-label="放大查看图片"
      >
        <img src={src} alt="" />
      </button>
      {zoom && (
        // 全屏查看：贴长截图或小字截图时，缩略图看不清，必须能放大
        <div
          className="img-zoom"
          role="dialog"
          aria-modal="true"
          aria-label="图片查看"
          onClick={() => setZoom(false)}
        >
          <img src={src} alt="" />
          <p className="img-zoom-hint">点击任意处关闭</p>
        </div>
      )}
    </>
  );
}
