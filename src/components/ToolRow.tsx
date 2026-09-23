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
import { foldOutput } from './outputFold';
import { humanizeToolName, isToolCallFailed, isToolCallRunning } from './mcpTool';
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
          {/* 运行中把类型标签换成状态词：那一行是唯一的焦点，
              「正在执行」比「终端」更能说明此刻发生了什么。 */}
          <span className="tool-kind">{running ? '正在执行' : '终端'}</span>
          <span className="tool-summary mono">{oneLine}</span>
          <span className="tool-meta">
            {/* 运行中不放 chip：左侧标签已写「正在执行」、文字上还有扫光，
                再加一个「运行中」徽标是三重复述（且它最抢眼，反而
                让焦点落在徽标而不是命令本身）。 */}
            {declined ? (
              <span className="chip chip-declined">未执行</span>
            ) : running ? null : b.exitCode != null && b.exitCode !== 0 ? (
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
            {/* 命令输出接上复制与折叠：用户的下一个动作常是
                「把报错搜一下」或「把结果贴进 issue」。 */}
            {b.aggregatedOutput && <OutputBlock label="输出" text={b.aggregatedOutput} />}
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
    const b = item.body;
    const running = isToolCallRunning(b.status);
    const failed = isToolCallFailed(b.status);
    // 失败也算「有详情」——错误信息本身就是用户要看的内容。
    // 漏掉这一条的后果：失败的调用不可展开、什么都看不到（这正是修之前的症状）。
    const hasDetail = Boolean(b.argsSummary) || Boolean(b.resultSummary) || Boolean(b.error);
    return (
      <div className={`tool-row ${running ? 'is-running' : ''}`}>
        <button
          className="tool-row-head"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          disabled={!hasDetail}
        >
          <span className="tool-icon">
            <Icon name="layers" />
          </span>
          {/* 与命令行同一套规则：运行中把类型标签换成状态词，
              那一行是唯一的焦点，「正在执行」比「工具」更能说明此刻发生了什么。 */}
          <span className="tool-kind">{running ? '正在执行' : '工具'}</span>
          <span className="tool-summary mono">
            {b.server ? `${humanizeToolName(b.server)} · ` : ''}
            {humanizeToolName(b.tool)}
          </span>
          <span className="tool-meta">
            {/* 只读标记：协议给的 `readOnlyHint`，用户在批准前需要知道
                这个工具不会改东西。为 false/未知时不显示——「未声明」不等于「会写」。 */}
            {b.readOnly === true && <span className="chip">只读</span>}
            {/* 失败必须可见：失败时没有结果，不给 chip 的话这一行
                与「还在跑」长得一样。 */}
            {failed ? (
              <span className="chip chip-fail">失败</span>
            ) : running ? null : b.durationMs != null ? (
              <span className="dim">{b.durationMs}ms</span>
            ) : null}
          </span>
          <span className={`tool-chevron ${open ? 'open' : ''}`}>
            <Icon name="chevron" size={12} />
          </span>
        </button>
        {open && hasDetail && (
          <div className="tool-body">
            {/* 分区标题不是装饰：参数与结果都是 JSON，混在一起时
                用户分不清哪一段是「我让它做的」、哪一段是「它返回的」。
                错误放最前——失败时它才是用户要找的东西。 */}
            {b.error && <OutputBlock label="错误" text={b.error} tone="danger" />}
            {b.argsSummary && <OutputBlock label="参数" text={b.argsSummary} />}
            {b.resultSummary && <OutputBlock label="结果" text={b.resultSummary} />}
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
    const path = item.body.path;
    return (
      <div className="tool-row">
        <div className="tool-row-head static">
          <span className="tool-icon"><Icon name="file" /></span>
          <span className="tool-kind">图片</span>
          {/* 路径可点：会话里"看了哪张图"正是事后最想确认的东西，
              而当时只显示了一行不可点的文字。
              **不做自动切右栏**——那会打断用户正在看的 diff。 */}
          {onOpenFile ? (
            <button
              className="tool-summary mono is-clickable"
              title={`在右栏查看 ${path}`}
              onClick={() => onOpenFile(path)}
            >
              {path}
            </button>
          ) : (
            <span className="tool-summary mono">{path}</span>
          )}
          {onOpenFile && (
            <span className="tool-meta">
              <button
                className="tool-open-right"
                title="在右栏查看"
                aria-label={`在右栏查看 ${path}`}
                onClick={() => onOpenFile(path)}
              >
                <Icon name="panel-right" size={11} />
              </button>
            </span>
          )}
        </div>
      </div>
    );
  }

  return null;
}

/**
 * 一块可复制、可折叠的输出。
 *
 * # 为什么复制是必备的
 *
 * 用户看到工具输出后的下一步动作，常常是「把它贴到别处」——搜报错、贴进
 * issue、在另一个终端里重跑那条命令。没有复制按钮，他只能手工划选，
 * 而终端输出里常混着换行与制表符，划选很容易多一个少一个字符。
 *
 * 参照客户端的工具结果右上角正是一个复制按钮。
 *
 * # 折叠在**显示层**而不是投影层
 *
 * 与命令输出同一套规则（30KB 阈值、保留尾部——关键信息在末尾）。
 * 早先 MCP 的参数/结果在投影时就被截到 200 字符，展开也看不全；
 * 现在完整存储、只在这里折叠。
 */
function OutputBlock({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  /** `danger` 用于错误块：标签着红色，与「参数/结果」区分开。 */
  tone?: 'danger';
}) {
  const [copied, setCopied] = useState(false);
  const folded = foldOutput(text);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      // 反馈 1.2 秒后复原：够看清，又不至于一直占着位置
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // 剪贴板不可用（权限被拒、非安全上下文）：静默失败会让用户以为复制成功了，
      // 所以这里什么也不做但保留按钮外观——真失败时用户可以手工划选。
    }
  };

  return (
    <div className="out-block">
      <div className="out-head">
        <span className={`out-label ${tone === 'danger' ? 'is-danger' : ''}`}>{label}</span>
        {folded.truncated && (
          <span className="out-folded">已折叠 {folded.hiddenChars.toLocaleString()} 字符</span>
        )}
        <button
          className={`out-copy ${copied ? 'is-done' : ''}`}
          onClick={copy}
          title={copied ? '已复制' : '复制'}
          aria-label={copied ? '已复制' : `复制${label}`}
        >
          <Icon name={copied ? 'check' : 'file'} size={11} />
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre className="tool-output">{folded.text}</pre>
    </div>
  );
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
