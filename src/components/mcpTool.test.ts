/**
 * 工具名可读化与状态文案的测试。
 *
 * 这一层错了不会报错，只会让时间线上显示一串难读的标识符
 * （`mcp__github__create_issue`）或漏掉「失败/正在执行」这类关键状态。
 */
import { describe, expect, it } from 'vitest';
import { humanizeToolName, isToolCallFailed, isToolCallRunning, toolCallStatusLabel } from './mcpTool';

describe('humanizeToolName', () => {
  it('下划线拆成空格（比连字符串好扫读）', () => {
    expect(humanizeToolName('search_docs')).toBe('search docs');
    expect(humanizeToolName('read_file')).toBe('read file');
    expect(humanizeToolName('a_b_c')).toBe('a b c');
  });

  it('驼峰拆开', () => {
    expect(humanizeToolName('createIssue')).toBe('create Issue');
    expect(humanizeToolName('listMcpResources')).toBe('list Mcp Resources');
  });

  it('剥掉 mcp__server__ 前缀（server 名已单独显示，重复只让行更长）', () => {
    // 实测形态：codex 把工具暴露为 `mcp__<server>` 命名空间，
    // 单个工具名在命名空间内；我们已单独渲染 server 名。
    expect(humanizeToolName('mcp__github__create_issue')).toBe('create issue');
    expect(humanizeToolName('mcp__filesystem__read_file')).toBe('read file');
  });

  it('只剥一层前缀，不误伤本来就叫 mcp 的工具', () => {
    // `mcp__x` 这种「前缀后没有第二段」的形态不该被剥成空
    expect(humanizeToolName('mcp__x')).toBe('mcp x');
    // 不含前缀的正常名字保持原样
    expect(humanizeToolName('always_fails')).toBe('always fails');
  });

  it('空 / 空白给中文兜底（会直接呈现在界面上）', () => {
    expect(humanizeToolName('')).toBe('未命名工具');
    expect(humanizeToolName('   ')).toBe('未命名工具');
  });

  it('中文名原样保留（不拆、不译）', () => {
    expect(humanizeToolName('查询文档')).toBe('查询文档');
  });

  it('不做「中文化」——任意工具名没有中文对应，硬译等于编造语义', () => {
    // 保留原词也便于用户拿去搜文档
    expect(humanizeToolName('get_weather')).toBe('get weather');
  });

  it('多个连续分隔符与多余空格被归一', () => {
    expect(humanizeToolName('a__b')).toBe('a b');
    expect(humanizeToolName('  spaced  ')).toBe('spaced');
  });
});

describe('状态文案', () => {
  it('进行中 / 失败有文案', () => {
    expect(toolCallStatusLabel('inProgress')).toBe('正在执行');
    expect(toolCallStatusLabel('failed')).toBe('失败');
  });

  it('完成态返回空串（完成是默认，标注等于给时间线加噪声）', () => {
    expect(toolCallStatusLabel('completed')).toBe('');
    expect(toolCallStatusLabel(null)).toBe('');
    expect(toolCallStatusLabel(undefined)).toBe('');
  });

  it('协议新增状态时原样显示（装成完成更危险）', () => {
    expect(toolCallStatusLabel('someNewState')).toBe('someNewState');
  });

  it('运行/失败的判定与文案同源', () => {
    expect(isToolCallRunning('inProgress')).toBe(true);
    expect(isToolCallRunning('completed')).toBe(false);
    expect(isToolCallFailed('failed')).toBe(true);
    expect(isToolCallFailed('inProgress')).toBe(false);
    // 未提供状态时既不算运行也不算失败（不猜）
    expect(isToolCallRunning(null)).toBe(false);
    expect(isToolCallFailed(null)).toBe(false);
  });
});
