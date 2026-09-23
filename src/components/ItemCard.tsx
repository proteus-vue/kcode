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
import type { Item, ItemBody } from '../types/domain';
import { Icon } from './Icon';
import { Markdown } from './Markdown';
import { ToolRow } from './ToolRow';
import {
  activityLabel,
  agentRollup,
  agentStatusLabel,
  callStatusLabel,
  shortId,
  statusTone,
  toolLabel,
} from './collabAgent';

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
      // 推理内容不渲染。
      //
      // # 为什么删掉（这曾经是一个可展开的「推理过程」区块）
      //
      // 实测参照客户端（Codex.app）：整个 asar 里 `reasoning` **只出现在
      // 模型配置**（`reasoning_effort` 等），没有任何展示推理内容的文案、
      // 组件或类名——它完全不展示推理。
      //
      // 理由也成立：推理是**每轮一条**的，与工具调用交替出现，展开后
      // 时间线长度翻倍；而它的信息价值远低于工具调用（用户要判断
      // 「它做了什么、对不对」，看的是命令与 diff，不是它的内心独白）。
      //
      // 注意上游仍会推送推理增量（`item/reasoning/textDelta`），
      // reducer 里已按 channel 过滤，不会从「未归位内容」那条渲染路径漏出来。
      return null;

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
      // 子代理活动。**不显示协议类型名**——用户要看的是「派了谁、在干什么、
      // 什么状态」，而不是 `collabAgentToolCall` 这个枚举值。
      // 两个形状不同的 item 都在这里渲染（见下方 CollabAgentRow）。
      return <CollabAgentRow body={item.body} />;
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
 * 子代理活动行：紧凑单行 + 点击展开。
 *
 * 与 `ToolRow` 同一套视觉语言（图标 + 类型 + 摘要 + 折叠箭头，常态弱化），
 * 因为它在时间线里扮演的角色相同——**过程性动作**，不该与正文争焦点。
 * 差异只在展开内容：这里展开的是「各代理的状态表」，不是命令输出。
 */
function CollabAgentRow({ body }: { body: Extract<ItemBody, { kind: 'collabAgent' }> }) {
  const [open, setOpen] = useState(false);

  const isCall = body.source === 'collabAgentToolCall';
  const tone = statusTone(isCall ? body.status : body.activityKind);

  // 摘要：两种来源各自成句。宁可短，也不堆字段——
  // 细节点开就有，单行塞满反而看不清发生了什么。
  const summary = isCall
    ? [
        agentRollup(body.agents) || (body.receiverThreadIds.length > 0
          ? `${body.receiverThreadIds.length} 个代理`
          : ''),
      ]
        .filter(Boolean)
        .join(' · ')
    : `${activityLabel(body.activityKind)}${
        body.agentPath ? ` · ${body.agentPath.split('/').filter(Boolean).pop() ?? ''}` : ''
      }`;

  const status = isCall ? callStatusLabel(body.status) : '';
  const hasDetail =
    body.agents.length > 0 || Boolean(body.prompt) || body.receiverThreadIds.length > 0;

  return (
    <div className={`tool-row collab-row tone-${tone}`}>
      <button
        className="tool-row-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={!hasDetail}
        title={hasDetail ? '展开查看详情' : undefined}
      >
        <span className="tool-icon">
          <Icon name="devices" />
        </span>
        <span className="tool-kind">{isCall ? toolLabel(body.tool) : '子代理'}</span>
        <span className="tool-summary">{summary}</span>
        <span className="tool-meta">
          {status && <span className={`chip chip-${tone}`}>{status}</span>}
          {!isCall && body.agentThreadId && (
            <span className="dim mono">{shortId(body.agentThreadId)}</span>
          )}
        </span>
        {/* 无详情时不给箭头：点了没反应的箭头比没有箭头更糟 */}
        {hasDetail && (
          <span className={`tool-chevron ${open ? 'open' : ''}`}>
            <Icon name="chevron" size={12} />
          </span>
        )}
      </button>

      {open && hasDetail && (
        <div className="tool-body collab-body">
          {body.prompt && (
            <>
              <p className="collab-label">任务</p>
              <pre className="tool-output">{body.prompt}</pre>
            </>
          )}

          {body.agents.length > 0 && (
            <>
              <p className="collab-label">代理状态</p>
              <ul className="collab-agents">
                {body.agents.map((a) => (
                  <li key={a.threadId} className={`collab-agent tone-${statusTone(a.status)}`}>
                    <span className="collab-dot" />
                    <span className="collab-agent-id mono" title={a.threadId}>
                      {shortId(a.threadId)}
                    </span>
                    <span className="collab-agent-status">{agentStatusLabel(a.status)}</span>
                    {/* 协议给的说明文本可为空——空就不占位 */}
                    {a.message && <span className="collab-agent-msg">{a.message}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}

          {body.receiverThreadIds.length > 0 && body.agents.length === 0 && (
            <>
              <p className="collab-label">涉及代理</p>
              <ul className="collab-agents">
                {body.receiverThreadIds.map((id) => (
                  <li key={id} className="collab-agent tone-idle">
                    <span className="collab-dot" />
                    <span className="collab-agent-id mono" title={id}>
                      {shortId(id)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
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
