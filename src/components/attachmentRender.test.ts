/**
 * 附件序列化的测试。
 *
 * 这是「界面上的卡片 → 发给模型的自包含文本」那一步。模型看不到界面，
 * 只收到这段文本，所以选择器/内容/尺寸/来源任何一项缺失都会让它无法
 * 定位用户指的是什么。而这一层没有 UI 反馈能暴露缺失——发送出去就是
 * 发出去了。
 */
import { describe, expect, it } from 'vitest';
import { serializeWebElements } from './attachmentSerialize';
import type { WebElementAttachment } from '../types/domain';

const el = (over: Partial<WebElementAttachment> = {}): WebElementAttachment => ({
  kind: 'webElement',
  selector: '#root > div > main',
  tag: 'div',
  text: '你想让我们在 KCode 中构建什么?',
  width: 452,
  height: 249,
  url: 'https://example.com/page',
  title: '示例页',
  ...over,
});

describe('serializeWebElements', () => {
  it('包含模型定位所需的全部字段', () => {
    const out = serializeWebElements([el()]);
    expect(out).toContain('示例页');           // 页面标识
    expect(out).toContain('#root > div > main'); // 选择器
    expect(out).toContain('452×249');           // 尺寸
    expect(out).toContain('https://example.com/page'); // 来源
    expect(out).toContain('你想让我们在 KCode 中构建什么?'); // 内容
  });

  it('多个元素之间用空行分隔', () => {
    const out = serializeWebElements([el({ selector: '#a' }), el({ selector: '#b' })]);
    expect(out).toContain('#a');
    expect(out).toContain('#b');
    expect(out.split('\n\n').length).toBeGreaterThan(1);
  });

  it('没有文本内容时不写空的「内容：」行', () => {
    const out = serializeWebElements([el({ text: '' })]);
    expect(out).not.toContain('内容：\n');
    expect(out).not.toMatch(/内容：$/m);
  });

  it('没有标题时退回 URL 作为页面标识', () => {
    const out = serializeWebElements([el({ title: '' })]);
    expect(out).toContain('https://example.com/page');
  });

  it('空列表返回空串（调用方据此跳过拼接）', () => {
    expect(serializeWebElements([])).toBe('');
  });
});
