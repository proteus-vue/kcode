/**
 * 新增对话区能力的行为测试（组件级）。
 *
 * 覆盖三处，共同点是**坏了不会报错、只会静默退化**：
 *
 * 1. 轮次收尾的「已处理 Xs」+ 展开详情——点不开就只是少了个功能，
 *    不会有任何错误；而耗时数字错了更没人会发现。
 * 2. 子代理行——早先显示的是协议类型名（`collabAgentToolCall`），
 *    这类"术语泄漏"不会有测试失败，只能靠断言文案钉住。
 * 3. 聚合折叠——默认必须折叠（默认展开等于没聚合）。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TurnView } from '../TurnView';
import { reduceAll, initialState } from '../../stores/store';
import type { AppEvent, Item } from '../../types/domain';
import type { RootState as StoreRootState } from '../../stores/store';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

const item = (id: string, turnId: string, body: Item['body']): Item => ({
  id,
  turnId,
  createdAtMs: 1,
  body,
});

function render(state: StoreRootState, turnId = 't1'): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(<TurnView state={state} threadId="th" turnId={turnId} />);
  });
  return host;
}

const click = (el: Element | null) =>
  act(() => {
    (el as HTMLElement).click();
  });

describe('轮次收尾：耗时与工作详情', () => {
  const stateWithDuration = (durationMs: number | null): StoreRootState =>
    reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th', turnId: 't1' },
      {
        type: 'itemUpserted',
        threadId: 'th',
        turnId: 't1',
        completed: true,
        item: item('a1', 't1', { kind: 'agentMessage', text: '做完了' }),
      },
      {
        type: 'itemUpserted',
        threadId: 'th',
        turnId: 't1',
        completed: true,
        item: item('c1', 't1', {
          kind: 'commandExecution',
          command: 'ls',
          cwd: null,
          status: 'completed',
          exitCode: 0,
          aggregatedOutput: null,
          durationMs: 5,
        }),
      },
      { type: 'turnCompleted', threadId: 'th', turnId: 't1', status: 'completed', durationMs },
    ]);

  it('已结束的轮次显示整轮耗时（协议给的值）', () => {
    const el = render(stateWithDuration(13 * 60_000 + 20_000));
    expect(el.querySelector('.turn-footer-time')?.textContent).toBe('已处理 13 分 20 秒');
  });

  it('协议未提供耗时时不显示收尾行（不编数字）', () => {
    const el = render(stateWithDuration(null));
    expect(el.querySelector('.turn-footer')).toBeNull();
  });

  it('进行中的轮次不显示耗时（协议那时还没给出）', () => {
    const st = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th', turnId: 't1' },
    ]);
    const el = render(st);
    expect(el.querySelector('.turn-footer')).toBeNull();
  });

  it('默认只看时长，展开才给出工作详情', () => {
    const el = render(stateWithDuration(6500));
    // 默认收起：详情不在 DOM 里
    expect(el.querySelector('.turn-detail')).toBeNull();

    click(el.querySelector('.turn-footer-head'));
    const detail = el.querySelector('.turn-detail');
    expect(detail).not.toBeNull();
    // 1 条命令应计入统计
    const stats = detail!.textContent ?? '';
    expect(stats).toContain('条命令');
  });
});

describe('活动指示不重复', () => {
  const running = (): StoreRootState =>
    reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th', turnId: 't1' },
      {
        type: 'itemUpserted',
        threadId: 'th',
        turnId: 't1',
        completed: false,
        item: item('c1', 't1', {
          kind: 'commandExecution',
          command: 'npx vitest run',
          cwd: null,
          status: 'inProgress',
          exitCode: null,
          aggregatedOutput: null,
          durationMs: null,
        }),
      },
    ]);

  it('有工具行在跑时不再显示「正在处理」（同一件事说两遍）', () => {
    const el = render(running());
    // 工具行自己已写「正在执行」
    expect(el.textContent).toContain('正在执行');
    expect(el.querySelector('.turn-progress')).toBeNull();
  });

  it('没有工具行在跑时（模型正在生成）仍显示转圈——否则界面像卡住了', () => {
    const st = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th', turnId: 't1' },
    ]);
    const el = render(st);
    expect(el.querySelector('.turn-progress .spinner')).not.toBeNull();
  });
});

describe('子代理展示', () => {
  const withAgent = (): StoreRootState =>
    reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th', turnId: 't1' },
      {
        type: 'itemUpserted',
        threadId: 'th',
        turnId: 't1',
        completed: true,
        item: item('g1', 't1', {
          kind: 'collabAgent',
          source: 'collabAgentToolCall',
          tool: 'spawnAgent',
          status: 'inProgress',
          receiverThreadIds: ['01a0ccad-3788-7041-a0be-20eba3156850'],
          agents: [
            { threadId: '01a0ccad-3788-7041-a0be-20eba3156850', status: 'running', message: null },
          ],
          prompt: '调研这个协议',
        }),
      },
    ]);

  it('显示中文工具名与代理汇总，而不是协议类型名', () => {
    const el = render(withAgent());
    const text = el.textContent ?? '';
    expect(text).toContain('派生子代理');
    expect(text).toContain('1 个代理');
    expect(text).toContain('运行中');
    // 这两处是本次修的缺陷：协议内部术语不该出现在界面上
    expect(text).not.toContain('collabAgentToolCall');
    expect(text).not.toContain('协作：');
  });

  it('展开后列出各代理的状态与任务说明', () => {
    const el = render(withAgent());
    expect(el.querySelector('.collab-agents')).toBeNull();
    click(el.querySelector('.tool-row-head'));
    const body = el.querySelector('.collab-body');
    expect(body).not.toBeNull();
    const text = body!.textContent ?? '';
    expect(text).toContain('调研这个协议');
    expect(text).toContain('运行中');
    // 代理 id 截短显示（UUID 全长会占满一行）
    expect(text).toContain('01a0ccad');
  });
});

describe('连续工具调用聚合', () => {
  const manySearches = (): StoreRootState =>
    reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th', turnId: 't1' },
      ...['协议漂移', 'bwrap', 'landlock'].map(
        (q, i): AppEvent => ({
          type: 'itemUpserted',
          threadId: 'th',
          turnId: 't1',
          completed: true,
          item: item(`s${i}`, 't1', { kind: 'webSearch', query: q }),
        }),
      ),
    ]);

  it('连续同类动作折叠成一行摘要', () => {
    const el = render(manySearches());
    expect(el.textContent).toContain('已搜索 3 次搜索');
    // 默认折叠：组内单条不渲染
    expect(el.querySelector('.tool-group-body')).toBeNull();
    // 三条搜索不应各自成一行
    expect(el.querySelectorAll('.tool-row').length).toBe(0);
  });

  it('展开后逐条显示（复用同一套工具行样式）', () => {
    const el = render(manySearches());
    click(el.querySelector('.tool-group .tool-row-head'));
    expect(el.querySelector('.tool-group-body')).not.toBeNull();
    expect(el.querySelectorAll('.tool-group-body .tool-row').length).toBe(3);
  });

  it('失败的命令不被折叠（异常必须单独可见）', () => {
    const st = reduceAll(initialState(), [
      { type: 'threadStarted', threadId: 'th', cwd: '/w' },
      { type: 'turnStarted', threadId: 'th', turnId: 't1' },
      {
        type: 'itemUpserted',
        threadId: 'th',
        turnId: 't1',
        completed: true,
        item: item('f1', 't1', {
          kind: 'commandExecution',
          command: 'npm run build',
          cwd: null,
          status: 'failed',
          exitCode: 1,
          aggregatedOutput: 'boom',
          durationMs: 100,
        }),
      },
    ]);
    const el = render(st);
    expect(el.querySelector('.tool-group')).toBeNull();
    expect(el.textContent).toContain('退出 1');
  });
});
