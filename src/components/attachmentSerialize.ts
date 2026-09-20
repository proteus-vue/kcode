/**
 * 把网页元素附件序列化成发给 Agent 的文本。
 *
 * **模型看不到界面**：它只收到这段文本。所以选择器、内容、尺寸、来源
 * 都要写进去，否则模型无法定位用户指的是页面上的哪一块。
 *
 * 单独成模块是为了可测：这一层没有 UI 反馈能暴露字段缺失——发出去
 * 就是发出去了，用户只会觉得「模型答得不对」。
 */
import type { WebElementAttachment } from '../types/domain';

/** 单个元素 → 一段自包含描述。 */
function one(e: WebElementAttachment): string {
  return [
    `【网页元素】${e.title || e.url}`,
    `选择器：${e.selector}`,
    // 空内容不写：留着「内容：」后面什么都没有会让模型以为内容就是空的
    e.text ? `内容：${e.text}` : '',
    `尺寸：${e.width}×${e.height}`,
    `来源：${e.url}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function serializeWebElements(els: WebElementAttachment[]): string {
  return els.map(one).join('\n\n');
}
