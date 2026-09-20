/**
 * 可折叠面板：展开时是完整卡片，折叠后收成一行胶囊。
 *
 * # 为什么折叠态要显示最后一步，而不只是标题
 *
 * 右栏的意义是「不切换上下文就能看到状态」。折叠后若只剩一个标题，
 * 用户必须展开才知道有没有变化——那还不如不折叠。所以胶囊上带
 * 进度与最后一步的描述，扫一眼就够。
 *
 * # 为什么「展开状态」与内容分成两颗胶囊
 *
 * 前者是**动作**，后者是**读数**。合成一颗会让人不确定点下去是
 * 展开面板还是跳转到某一步；分开后动作与信息各自可预期。
 */
import { useState, type ReactNode } from 'react';
import { Icon } from './Icon';

export function CollapsiblePanel({
  title,
  icon,
  status,
  count,
  summary,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon: ReactNode;
  /** 右上角的状态标签，例如「进行中」。 */
  status?: ReactNode;
  /** 进度计数，例如「3/5」。 */
  count?: ReactNode;
  /** 折叠后胶囊上的读数：通常是最后一步或当前动作。 */
  summary?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (!open) {
    return (
      <div className="panel-capsules">
        <button
          className="capsule capsule-action"
          onClick={() => setOpen(true)}
          title={`展开${title}`}
        >
          {/* 箭头指向展开后内容的方向：向上 */}
          <span className="capsule-arrow">
            <Icon name="chevron" size={11} />
          </span>
          展开状态
        </button>
        {(summary || count) && (
          <button
            className="capsule capsule-readout"
            onClick={() => setOpen(true)}
            title={summary ?? title}
          >
            {count && <span className="capsule-count">{count}</span>}
            {summary && <span className="capsule-summary">{summary}</span>}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-head">
        {icon}
        <span>{title}</span>
        {status}
        {count}
        <button
          className="mini-btn panel-collapse"
          onClick={() => setOpen(false)}
          title={`收起${title}为胶囊`}
        >
          收起为胶囊
        </button>
      </div>
      {children}
    </div>
  );
}
