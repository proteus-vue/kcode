/**
 * 终端场景。
 *
 * 走协议的 `command/exec` + `outputDelta`（**不是**自己 fork 进程）：
 * 这样命令跑在 app-server 的进程树与沙箱策略下，与 Agent 执行命令的
 * 环境一致。自己 fork 会得到一个「权限比 Agent 大」的终端——
 * 用户在这里能做的事比 Agent 多，会产生误导。
 *
 * 必须 `tty: true`：实测不传该标志时 command/exec 只返回一次性缓冲
 * 输出，全程没有 outputDelta，长命令期间界面一片空白。
 */
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Icon } from './Icon';
import { extractErrorMessage } from '../stores/useKcode';
import type { AppEvent } from '../types/domain';

interface Line {
  kind: 'input' | 'output' | 'notice';
  text: string;
}

export function TerminalPanel({
  cwd,
  events,
}: {
  cwd: string | null;
  /** 事件订阅：终端输出经它与 app-server 的事件通道一起送达。 */
  events: { subscribe: (fn: (e: AppEvent) => void) => () => void };
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pidRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 订阅终端增量。用 ref 存当前进程号：事件回调里要判断这条输出
  // 是否属于当前进程，而回调只在挂载时注册一次。
  useEffect(() => {
    return events.subscribe((e) => {
      if (e.type === 'terminalDelta' && e.processId === pidRef.current) {
        setLines((prev) => {
          // 单条 delta 可能含多行；按行拆开便于逐行渲染
          const parts = e.text.split('\n');
          const next = [...prev];
          parts.forEach((p, i) => {
            // 最后一段若不是以换行结尾，说明这条 delta 被截断，
            // 追加到上一行而不是新起一行（否则「进度条」类输出会碎成多行）
            if (i === parts.length - 1 && p !== '') {
              const last = next[next.length - 1];
              if (last && last.kind === 'output' && !last.text.endsWith('\n')) {
                next[next.length - 1] = { ...last, text: last.text + p };
              } else {
                next.push({ kind: 'output', text: p });
              }
            } else if (p !== '' || i < parts.length - 1) {
              next.push({ kind: 'output', text: p + (i < parts.length - 1 ? '\n' : '') });
            }
          });
          if (e.capReached) {
            next.push({ kind: 'notice', text: '（输出超过上限，后续内容已截断）' });
          }
          return next;
        });
      }
      if (e.type === 'terminalExited' && e.processId === pidRef.current) {
        setRunning(false);
        setLines((prev) => [
          ...prev,
          { kind: 'notice', text: `进程已退出${e.exitCode === null ? '' : `（退出码 ${e.exitCode}）`}` },
        ]);
        pidRef.current = null;
      }
    });
  }, [events]);

  // 新输出到达时贴底。用 scrollTop 而不是 scrollIntoView：
  // 后者会把整个页面也滚一下。
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const run = async () => {
    const cmd = input.trim();
    if (!cmd || running) return;
    setError(null);
    setInput('');
    setLines((prev) => [...prev, { kind: 'input', text: `$ ${cmd}` }]);

    // 用 sh -lc 而不是自己切词：切词规则（引号、转义、管道）实现对了
    // 也不如 shell 本身对。这里的目标是「像个终端」。
    const processId = `term-${Date.now()}`;
    pidRef.current = processId;
    setRunning(true);
    try {
      await invoke('exec_start', {
        processId,
        command: ['/bin/sh', '-lc', cmd],
        cwd,
      });
    } catch (e) {
      setRunning(false);
      pidRef.current = null;
      setError(extractErrorMessage(e));
    }
  };

  const terminate = async () => {
    const pid = pidRef.current;
    if (!pid) return;
    try {
      await invoke('exec_terminate', { processId: pid });
    } catch (e) {
      setError(extractErrorMessage(e));
    }
  };

  return (
    <div className="terminal">
      <div className="terminal-out" ref={scrollRef}>
        {lines.length === 0 && (
          <p className="terminal-hint">
            终端在 app-server 的沙箱策略下运行，与 Agent 执行命令的环境一致。
          </p>
        )}
        {lines.map((l, i) => (
          <div key={i} className={`term-line term-${l.kind}`}>
            {l.text}
          </div>
        ))}
        {running && <div className="term-line term-running">运行中…</div>}
      </div>

      {error && <p className="terminal-error">{error}</p>}

      <div className="terminal-input">
        <span className="term-prompt">$</span>
        <input
          value={input}
          placeholder="输入命令，回车执行"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void run();
            }
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={running}
        />
        {running ? (
          <button className="mini-btn" onClick={() => void terminate()} title="终止进程">
            <Icon name="stop" size={11} />
          </button>
        ) : (
          <button className="mini-btn" onClick={() => void run()} disabled={!input.trim()}>
            运行
          </button>
        )}
      </div>
    </div>
  );
}
