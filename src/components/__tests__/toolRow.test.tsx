/**
 * 工具行的展示测试。
 *
 * # 守的是什么
 *
 * 两条都是**「数据拿到了但用户看不到」**的缺陷，不会报错、只会静默退化：
 *
 * 1. **MCP 工具的参数从未渲染**：领域层解析了 `argsSummary`、TS 类型也定了，
 *    但 ToolRow 的 toolCall 分支只渲染结果——全仓 grep 下来 argsSummary
 *    只有类型定义与一个测试 fixture，没有任何渲染点。
 * 2. **参数/结果在投影期被截到 200 字符**：展开也看不全，而那正是用户
 *    想看细节的时刻。命令输出那条通路不是这么做的（完整保留、显示时折叠）。
 *
 * 加上复制能力后，这里的断言覆盖「复制按钮存在且复制的是完整文本」。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToolRow } from '../ToolRow';
import type { Item } from '../../types/domain';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** 剪贴板桩：记录写入内容。 */
const written: string[] = [];

beforeEach(() => {
  written.length = 0;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (t: string) => void written.push(t) },
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

const mk = (body: Item['body']): Item => ({ id: 'i1', turnId: 't1', createdAtMs: 0, body });

function render(item: Item) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<ToolRow item={item} />);
  });
  return host;
}

const click = (el: Element | null | undefined) => {
  act(() => {
    (el as HTMLElement).click();
  });
};

describe('MCP 工具调用：参数与结果都要能看到', () => {
  const call = (over: Partial<Extract<Item['body'], { kind: 'toolCall' }>> = {}): Item =>
    mk({
      kind: 'toolCall',
      server: 'mcp',
      tool: 'search_docs',
      argsSummary: '{\n  "query": "沙箱前提"\n}',
      resultSummary: '{\n  "matches": 3\n}',
      ...over,
    });

  it('展开后「参数」与「结果」都渲染（此前参数从未显示）', () => {
    const el = render(call());
    // 默认折叠
    expect(el.querySelector('.tool-body')).toBeNull();

    click(el.querySelector('.tool-row-head'));
    const labels = [...el.querySelectorAll('.out-label')].map((e) => e.textContent);
    expect(labels, '参数必须渲染——此前只有结果').toContain('参数');
    expect(labels).toContain('结果');

    const text = el.querySelector('.tool-body')?.textContent ?? '';
    expect(text).toContain('沙箱前提');
    expect(text).toContain('matches');
  });

  it('只有参数、没有结果时也能展开（不能因缺一项就整块不显示）', () => {
    const el = render(call({ resultSummary: null }));
    click(el.querySelector('.tool-row-head'));
    expect(el.querySelector('.tool-body')?.textContent, '参数应显示').toContain('沙箱前提');
    expect([...el.querySelectorAll('.out-label')].map((e) => e.textContent)).toEqual(['参数']);
  });

  it('长内容完整渲染、只在显示层折叠（不是投影期截断）', () => {
    // 3000 字符 > 折叠阈值吗？不——阈值 30k，这里验证「不曾在 200 处被截」
    const long = 'x'.repeat(3000);
    const el = render(call({ argsSummary: long, resultSummary: null }));
    click(el.querySelector('.tool-row-head'));
    const shown = el.querySelector('.tool-output')?.textContent ?? '';
    expect(shown.length, '200 字符的投影期截断应已移除').toBe(3000);
  });

  it('超长内容在显示层折叠，并告知折叠了多少（保留尾部）', () => {
    // 阈值是 30k 字符（与命令输出同一条规则）——这里必须真的超过去
    const long = 'A'.repeat(31_000) + 'TAIL-END';
    const el = render(call({ resultSummary: long, argsSummary: null }));
    click(el.querySelector('.tool-row-head'));
    const block = el.querySelector('.out-block')!;
    expect(block.querySelector('.out-folded'), '应提示已折叠').not.toBeNull();
    expect(block.querySelector('.tool-output')?.textContent, '关键信息在尾部，必须保留').toContain(
      'TAIL-END',
    );
  });

  it('两项都没有时不显示展开箭头（点了没反应比不可点更糟）', () => {
    const el = render(call({ argsSummary: null, resultSummary: null }));
    expect((el.querySelector('.tool-row-head') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('复制按钮', () => {
  it('复制的是**完整原文**，不是折叠后显示的那段', async () => {
    const long = 'A'.repeat(31_000) + 'TAIL-END';
    const el = render(
      mk({
        kind: 'toolCall',
        server: null,
        tool: 'x',
        argsSummary: null,
        resultSummary: long,
      }),
    );
    click(el.querySelector('.tool-row-head'));
    click(el.querySelector('.out-copy'));
    // 等 clipboard 的 promise 落定
    await act(async () => {
      await Promise.resolve();
    });
    expect(written).toHaveLength(1);
    expect(written[0].length, '复制的应是完整内容').toBe(long.length);
    expect(written[0]).toContain('TAIL-END');
  });

  it('复制后按钮显示已复制（给出反馈，否则用户会反复点）', async () => {
    const el = render(
      mk({
        kind: 'toolCall',
        server: null,
        tool: 'x',
        argsSummary: '{}',
        resultSummary: null,
      }),
    );
    click(el.querySelector('.tool-row-head'));
    const btn = el.querySelector('.out-copy')!;
    expect(btn.textContent).toContain('复制');
    click(btn);
    await act(async () => {
      await Promise.resolve();
    });
    expect(btn.textContent, '应切换为已复制').toContain('已复制');
  });

  it('命令输出也能复制（用户常要把报错搜一下）', () => {
    const el = render(
      mk({
        kind: 'commandExecution',
        command: 'npm run build',
        cwd: null,
        status: 'failed',
        exitCode: 1,
        aggregatedOutput: 'error: Cannot find module "vite"\n',
        durationMs: 1200,
      }),
    );
    click(el.querySelector('.tool-row-head'));
    expect(el.querySelector('.out-copy'), '命令输出应有复制按钮').not.toBeNull();
    expect(el.querySelector('.out-label')?.textContent).toBe('输出');
  });
});
