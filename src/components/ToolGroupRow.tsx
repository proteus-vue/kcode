/**
 * 连续工具调用的聚合行（默认折叠）。
 *
 * # 与 ToolRow 的关系
 *
 * 复用同一套视觉语言（图标 / 类型 / 摘要 / 折叠箭头，常态弱化），
 * 因为它在时间线里的角色和单条工具行相同——**过程性动作**，不是正文。
 * 差别只在内容：这里一层是"组"，展开后才是组内的单条（仍用 ToolRow 渲染，
 * 保证展开前后的每一行样式一致）。
 *
 * # 为什么默认折叠
 *
 * 聚合的意义就是"默认不占地方"。默认展开等于没聚合，只是多加了一层标题。
 * 参照客户端也是收起的（「已读取 1 个文件 · 已搜索 2 次 ⌄」）。
 */
import { useState } from 'react';
import { Icon } from './Icon';
import { ToolRow } from './ToolRow';
import { groupSummary, type GroupKind, type ToolGroup } from './toolGrouping';

/** 类别 → 图标。 */
const GROUP_ICON: Record<GroupKind, 'file' | 'search' | 'terminal' | 'layers' | 'devices'> = {
  read: 'file',
  search: 'search',
  command: 'terminal',
  tool: 'layers',
  agent: 'devices',
};

export function ToolGroupRow({
  group,
  onOpenFile,
}: {
  group: ToolGroup;
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);

  // 组内若有仍在跑的项，行上加一层"活动"提示——否则折叠状态下
  // 用户看不出"这里的动作还没做完"。
  const running = group.members.some((m) => {
    const b = m.item.body;
    if (b.kind === 'commandExecution') return b.status === 'inProgress';
    if (b.kind === 'toolCall') return false;
    if (b.kind === 'collabAgent') {
      return b.status === 'inProgress' || b.agents.some((a) => a.status === 'running');
    }
    return false;
  });

  return (
    <div className={`tool-group ${running ? 'is-running' : ''}`}>
      <button className="tool-row-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="tool-icon">
          <Icon name={GROUP_ICON[group.kind]} />
        </span>
        {/* 运行中时摘要走扫光（与单条工具行同一套"活着"的表达），
            并让开合的箭头保持可见——用户需要知道这里能点开。 */}
        <span className="tool-summary">{groupSummary(group)}</span>
        <span className={`tool-chevron ${open ? 'open' : ''}`}>
          <Icon name="chevron" size={12} />
        </span>
      </button>

      {open && (
        <div className="tool-group-body">
          {group.members.map((m) => (
            <ToolRow key={m.item.id} item={m.item} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </div>
  );
}
