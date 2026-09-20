/**
 * 紧凑工具行。
 *
 * # 为什么要单独做这个组件
 *
 * 成熟客户端（Codex / ZCode）时间线里最显眼的特征是：命令、文件读写这类
 * 「过程性动作」以**单行**呈现，而不是占一整个大卡片。一屏能看十几步操作，
 * 需要细节时再展开。
 *
 * 此前的实现把每个命令都渲染成带状态条 + 命令 + 输出的厚卡片，
 * 一次任务下来时间线被撑得很长，反而看不清「做了什么」。
 */
import { useState } from 'react';
import type { Item } from '../types/domain';
import { changeKindLabel, fileStats, isDeclined } from '../stores/store';
import { Icon } from './Icon';

export function ToolRow({
  item,
  onOpenFile,
}: {
  item: Item;
  /** 点击文件时在右栏打开详情。未传则文件不可点——不显示假的交互。 */
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (item.body.kind === 'commandExecution') {
    const b = item.body;
    const declined = isDeclined(item);
    const running = b.status === 'inProgress';
    // 首行摘要：把多行命令压成一行，避免撑破布局
    const oneLine = b.command.replace(/\s*\n\s*/g, ' ⏎ ').trim();

    return (
      <div className={`tool-row ${declined ? 'is-declined' : ''} ${running ? 'is-running' : ''}`}>
        <button className="tool-row-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className={`tool-icon ${declined ? 'declined' : ''}`}>
            <Icon name="terminal" />
          </span>
          <span className="tool-kind">终端</span>
          <span className="tool-summary mono">{oneLine}</span>
          <span className="tool-meta">
            {declined ? (
              <span className="chip chip-declined">未执行</span>
            ) : running ? (
              <span className="chip chip-running">运行中</span>
            ) : b.exitCode != null && b.exitCode !== 0 ? (
              <span className="chip chip-fail">退出 {b.exitCode}</span>
            ) : b.durationMs != null ? (
              <span className="dim">{b.durationMs}ms</span>
            ) : null}
          </span>
          <span className={`tool-chevron ${open ? 'open' : ''}`}>
            <Icon name="chevron" size={12} />
          </span>
        </button>

        {open && (
          <div className="tool-body">
            <pre className="tool-command">{b.command}</pre>
            {declined && (
              <p className="tool-note declined">
                该命令未被执行——你拒绝了它。轮次的其他部分仍会继续。
              </p>
            )}
            {b.aggregatedOutput && <pre className="tool-output">{b.aggregatedOutput}</pre>}
          </div>
        )}
      </div>
    );
  }

  if (item.body.kind === 'fileChange') {
    const declined = isDeclined(item);
    return (
      <div className={`tool-row ${declined ? 'is-declined' : ''}`}>
        <button className="tool-row-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className={`tool-icon ${declined ? 'declined' : ''}`}>
            <Icon name="edit" />
          </span>
          <span className="tool-kind">变更</span>
          <span className="tool-summary">
            {item.body.changes.map((c) => {
              const st = fileStats(c);
              const moved = c.kind.type === 'update' ? c.kind.movePath : null;
              const label = (
                <>
                  <span className="chip">{changeKindLabel(c.kind)}</span>
                  <span className="mono">{c.path.split('/').pop()}</span>
                  {moved && <span className="dim mono">→ {moved.split('/').pop()}</span>}
                  {st.added > 0 && <span className="add">+{st.added}</span>}
                  {st.removed > 0 && <span className="del">−{st.removed}</span>}
                </>
              );
              // 只有能打开时才用 button：否则点下去没反应，比不可点更糟
              return onOpenFile ? (
                <button
                  key={c.path}
                  className="file-chip is-clickable"
                  title={`在右栏查看 ${c.path}`}
                  onClick={(e) => {
                    // 阻止冒泡：chip 在 tool-row-head 按钮内部，
                    // 不拦住会同时把整行折叠掉
                    e.stopPropagation();
                    onOpenFile(c.path);
                  }}
                >
                  {label}
                </button>
              ) : (
                <span key={c.path} className="file-chip">
                  {label}
                </span>
              );
            })}
          </span>
          <span className="tool-meta">
            {declined && <span className="chip chip-declined">未应用</span>}
          </span>
          <span className={`tool-chevron ${open ? 'open' : ''}`}>
            <Icon name="chevron" size={12} />
          </span>
        </button>
        {open && changedFiles(item) && (
          <div className="tool-body">
            {declined && (
              <p className="tool-note declined">这些变更未被应用——你拒绝了它们。</p>
            )}
            <pre className="tool-output">{changedSummary(item)}</pre>
          </div>
        )}
      </div>
    );
  }

  if (item.body.kind === 'toolCall') {
    return (
      <div className="tool-row">
        <button className="tool-row-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <span className="tool-icon">
            <Icon name="layers" />
          </span>
          <span className="tool-kind">工具</span>
          <span className="tool-summary mono">
            {item.body.server ? `${item.body.server} / ` : ''}
            {item.body.tool}
          </span>
          <span className="tool-chevron">
            <Icon name="chevron" size={12} />
          </span>
        </button>
        {open && item.body.resultSummary && (
          <div className="tool-body">
            <pre className="tool-output">{item.body.resultSummary}</pre>
          </div>
        )}
      </div>
    );
  }

  if (item.body.kind === 'webSearch') {
    return (
      <div className="tool-row">
        <span className="tool-row-head static">
          <span className="tool-icon"><Icon name="search" /></span>
          <span className="tool-kind">搜索</span>
          <span className="tool-summary">{item.body.query}</span>
        </span>
      </div>
    );
  }

  if (item.body.kind === 'imageView') {
    return (
      <div className="tool-row">
        <span className="tool-row-head static">
          <span className="tool-icon"><Icon name="file" /></span>
          <span className="tool-kind">图片</span>
          <span className="tool-summary mono">{item.body.path}</span>
        </span>
      </div>
    );
  }

  return null;
}

function changedFiles(item: Item): boolean {
  return item.body.kind === 'fileChange' && item.body.changes.length > 0;
}

function changedSummary(item: Item): string {
  if (item.body.kind !== 'fileChange') return '';
  return item.body.changes
    .map((c) => {
      const moved = c.kind.type === 'update' ? c.kind.movePath : null;
      const head = `${changeKindLabel(c.kind)}  ${c.path}${moved ? ` → ${moved}` : ''}`;
      return `${head}\n${'─'.repeat(Math.min(head.length, 60))}\n${c.diff || '(无 diff 内容)'}`;
    })
    .join('\n\n');
}
