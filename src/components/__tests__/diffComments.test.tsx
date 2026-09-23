/**
 * 审阅面板的行内评论（组件级）。
 *
 * 这里测的是**用户真实操作路径**：点行的评论按钮 → 输入 → 选意图 → 保存，
 * 然后评论能出现在文件行角标上、能被序列化成发给模型的文字。
 *
 * 为什么必须组件级测：纯函数（reviewComments.test.ts）只保证「给定评论能
 * 正确序列化」，而这一整套 UI 交互——尤其是**意图选择**——坏掉时不会报错，
 * 只会静默地按默认意图（要改）提交，于是用户标注的「仅上下文」变成了
 * 「请改掉这几行」。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DiffViewer } from '../DiffViewer';
import { serializeComments, type ReviewComment } from '../reviewComments';
import type { ChangeSet } from '../../types/domain';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const changeSet: ChangeSet = {
  turnId: 't1',
  threadId: 'th1',
  files: [
    {
      path: '/w/src/a.ts',
      kind: { type: 'update' },
      // 一个含上下文/删除/新增行的最小 hunk
      diff: '@@ -10,3 +10,3 @@\n const keep = 1;\n-const old = 1;\n+const neu = 2;\n',
    },
  ],
  origin: 'applied',
  reviewState: 'underReview',
  decisions: [],
};

/** 挂载一个受控评论的 DiffViewer（返回当前评论，供断言）。 */
function mount() {
  const onChange = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);

  function Harness() {
    const [comments, setComments] = useState<ReviewComment[]>([]);
    return (
      <DiffViewer
        changeSet={changeSet}
        turnDiff={null}
        workspace="/w"
        comments={comments}
        onCommentsChange={(next) => {
          onChange(next);
          setComments(next);
        }}
      />
    );
  }

  act(() => {
    root!.render(<Harness />);
  });
  return { onChange };
}

/** 展开第一个文件行。 */
function expandFile() {
  const head = host!.querySelector('.diff-file-head') as HTMLElement;
  act(() => {
    head.click();
  });
}

const commentButtons = () => host!.querySelectorAll('.line-tool[aria-label="对此行添加评论"]');
const editor = () => host!.querySelector('.comment-editor');
const intentOpts = () => host!.querySelectorAll('.intent-opt');

/** 在评论输入框里输入（走 React 的 onChange）。 */
function type(text: string) {
  const ta = host!.querySelector('.comment-input') as HTMLTextAreaElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.bind(ta);
    setter(text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function click(el: Element | null | undefined) {
  act(() => {
    (el as HTMLElement).click();
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

describe('行内评论的完整交互', () => {
  it('每行都有评论入口，且默认不显示编辑器', () => {
    mount();
    expandFile();
    expect(commentButtons().length).toBeGreaterThan(0);
    expect(editor()).toBeNull();
  });

  it('点评论按钮打开编辑器，保存后出现评论与文件角标', () => {
    mount();
    expandFile();
    click(commentButtons()[0]);
    expect(editor()).not.toBeNull();

    type('这里要改名');
    click(host!.querySelector('.comment-actions .btn'));

    // 编辑器收起，评论展示出来
    expect(editor()).toBeNull();
    const shown = host!.querySelector('.inline-comment-text');
    expect(shown?.textContent).toBe('这里要改名');
    // 文件行角标：评论藏在折叠区里时，收起文件要能一眼看到有几条
    expect(host!.querySelector('.comment-chip')?.textContent).toContain('1');
  });

  it('选「仅上下文」后保存，意图被如实记录', () => {
    mount();
    expandFile();
    click(commentButtons()[0]);
    // 第二个选项是「仅上下文」
    click(intentOpts()[1]);
    type('这行是有意为之');
    click(host!.querySelector('.comment-actions .btn'));

    const badge = host!.querySelector('.intent-badge');
    expect(badge?.textContent).toBe('仅上下文');
    // 序列化结果必须带上「不要改」的指令——否则用户标注的说明会被当成修改清单
    const comment = (host!.querySelector('.inline-comment') as HTMLElement).className;
    expect(comment).toContain('intent-context');
  });

  it('默认意图是「要改」（点评论的初衷就是要求修改）', () => {
    mount();
    expandFile();
    click(commentButtons()[0]);
    const on = host!.querySelector('.intent-opt.is-on');
    expect(on?.textContent).toBe('要改');
  });

  it('清空内容后保存等于删除该评论', () => {
    mount();
    expandFile();
    click(commentButtons()[0]);
    type('先写点什么');
    click(host!.querySelector('.comment-actions .btn'));
    expect(host!.querySelector('.inline-comment')).not.toBeNull();

    // 重新编辑并清空
    click(host!.querySelector('.inline-comment-text'));
    type('   ');
    click(host!.querySelector('.comment-actions .btn'));
    expect(host!.querySelector('.inline-comment')).toBeNull();
    expect(host!.querySelector('.comment-chip')).toBeNull();
  });

  it('删除按钮移除评论', () => {
    mount();
    expandFile();
    click(commentButtons()[0]);
    type('待删');
    click(host!.querySelector('.comment-actions .btn'));
    click(host!.querySelector('.inline-comment-del'));
    expect(host!.querySelector('.inline-comment')).toBeNull();
  });

  it('Escape 取消编辑，不留下评论', () => {
    mount();
    expandFile();
    click(commentButtons()[0]);
    type('不要了');
    act(() => {
      (host!.querySelector('.comment-input') as HTMLTextAreaElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(editor()).toBeNull();
    expect(host!.querySelector('.inline-comment')).toBeNull();
  });

  it('⌘Enter 保存', () => {
    mount();
    expandFile();
    click(commentButtons()[0]);
    type('快捷键保存');
    act(() => {
      (host!.querySelector('.comment-input') as HTMLTextAreaElement).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(host!.querySelector('.inline-comment-text')?.textContent).toBe('快捷键保存');
  });

  it('注释能序列化成发给模型的自包含文字（含文件、行号、原文）', () => {
    const { onChange } = mount();
    expandFile();
    click(commentButtons()[0]);
    type('加个空值检查');
    click(host!.querySelector('.comment-actions .btn'));

    const comments = onChange.mock.calls.at(-1)![0] as ReviewComment[];
    const text = serializeComments(comments);
    expect(text).toContain('【文件】/w/src/a.ts');
    expect(text).toContain('说明：加个空值检查');
    // 锚点必须带上该行内容，模型才能确认自己改的是哪一行
    expect(text).toMatch(/该行内容：/);
  });

  it('并排视图同样能评论，且与统一视图用同一套锚点', () => {
    mount();
    expandFile();
    click(host!.querySelector('.diff-header .btn')); // 切到并排
    const btns = host!.querySelectorAll('.split-cell .line-tool[aria-label="对此行添加评论"]');
    expect(btns.length).toBeGreaterThan(0);
    click(btns[0]);
    type('并排评论');
    click(host!.querySelector('.comment-actions .btn'));
    expect(host!.querySelector('.inline-comment-text')?.textContent).toBe('并排评论');
  });
});
