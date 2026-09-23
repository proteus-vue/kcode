/**
 * 输入区。对齐 Codex 的形态：
 *
 * ```
 * ┌──────────────────────────────────────────────┐
 * │ 随心输入                                      │
 * │                                              │
 * │  +  帮我批准          GLM-5.3-FLASH 高    ↑  │
 * └──────────────────────────────────────────────┘
 * ```
 *
 * 底行左侧是**上下文芯片**（项目 · 本地 · 分支），右侧是模型/推理强度。
 * 这些信息必须常驻可见——用户在提交前需要知道任务将在哪个目录、
 * 哪个分支、以什么权限运行。放进设置页会让这些前提变得不可见。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { MenuSelect, type MenuItem } from './MenuSelect';
import { PermissionPicker } from './PermissionPicker';
import { serializeWebElements } from './attachmentSerialize';
import {
  INITIAL_CURSOR,
  historyNext,
  historyPrev,
  moveIndex,
  pushHistory,
  type HistoryCursor,
} from './composerHistory';
import {
  extensionOf,
  formatSize,
  imageFilesFrom,
} from './attachmentImage';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { inTauri } from '../stores/useKcode';
/** 后端 save_attachment / attach_local_image 的返回。 */
interface SavedAttachment {
  path: string;
  name: string;
  size: number;
  previewDataUrl: string;
}

import type {
  ComposerAttachment,
  FileMatch,
  GitStatus,
  ImageAttachment,
  ModelOption,
  PermissionMode,
  WebElementAttachment,
} from '../types/domain';

/**
 * 从光标位置往前找 `@` 开头的查询词。
 *
 * 只认「行首或空白之后的 @」：`user@example.com` 这种不该触发文件搜索。
 * 返回 `null` 表示当前不在引用输入状态。
 */
export function atQueryAt(text: string, cursor: number): string | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  // @ 前必须是行首或空白
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const q = before.slice(at + 1);
  // 查询词内不允许空白或换行——出现即说明用户已经在写别的了
  if (/[\s\n]/.test(q)) return null;
  return q;
}

const EFFORT_LABEL: Record<string, string> = {
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
};

export function Composer({
  disabled,
  onSubmit,
  onStop,
  running,
  models,
  selectedModel,
  selectedEffort,
  onSelectModel,
  onSelectEffort,
  projectName,
  git,
  permissionMode,
  onSelectPermission,
  configuredModel,
  pendingInput,
  onConsumePending,
  pendingText,
  onConsumePendingText,
  onSearchFiles,
  onCompact,
}: {
  disabled: boolean;
  /** 提交一轮。`images` 是随轮次上传的本地图片绝对路径（协议 `localImage`）。 */
  onSubmit: (text: string, images?: string[]) => void;
  onStop?: () => void;
  running?: boolean;
  models: ModelOption[];
  selectedModel: string | null;
  selectedEffort: string | null;
  onSelectModel: (id: string) => void;
  onSelectEffort: (e: string | null) => void;
  /** 上下文芯片内容：项目名与 git 状态。 */
  projectName: string;
  git: GitStatus | null;
  /** 当前权限档位与切换回调。 */
  permissionMode: PermissionMode | null;
  onSelectPermission: (mode: PermissionMode) => void;
  /**
   * config.toml 里配置的模型。
   *
   * 未选择覆盖时用它可以如实显示「实际会跑哪个模型」。
   * `model/list` 返回的目录与当前 provider 无关，不能拿它当默认值——
   * 否则界面显示 gpt-6-astra、请求被 DeepSeek 拒绝，而错误信息
   * 看起来像用户配错了模型名。
   */
  configuredModel: string | null;
  /** 外部（选择网页元素）要加入输入框的附件。 */
  pendingInput: WebElementAttachment | null;
  /** 消费完通知外部清空，避免重复追加。 */
  onConsumePending: () => void;
  /**
   * 外部要追加到输入框的文本（行内评论的序列化结果）。
   *
   * 与 `pendingInput` 相同的一次性「待办」模式：Composer 的文本是它
   * 自己的 state，外部改不了；而这个通道让审阅面板能把评论推进来。
   */
  pendingText?: string | null;
  onConsumePendingText?: () => void;
  /** `@` 引用：按查询词模糊搜索工作区文件。 */
  onSearchFiles?: (query: string) => Promise<FileMatch[]>;
  /** `/compact`：请求压缩当前线程上下文。 */
  onCompact?: () => void;
}) {
  const [text, setText] = useState('');
  /** 已附加的引用材料。发送时随正文一起提交。 */
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  /** 展开预览的附件（看完整内容）。 */
  const [preview, setPreview] = useState<number | null>(null);
  /** 附件被拒的原因（类型不对/过大）。不静默丢弃。 */
  const [attachError, setAttachError] = useState<string | null>(null);
  /** 正在处理拖入的图片（读文件 + 落盘需要时间，期间给可见反馈）。 */
  const [dropping, setDropping] = useState(false);
  /** 拖入过程中已识别到的图片（仅用于展示「拖的是哪几张」）。 */
  const [dragPreview, setDragPreview] = useState<{ name: string; path: string }[]>([]);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  /** 已提交输入的历史（↑ 回溯，规格 04 §4.5）。 */
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState<HistoryCursor>(INITIAL_CURSOR);
  /** `@` 引用：当前候选文件与高亮项。 */
  const [fileMatches, setFileMatches] = useState<FileMatch[]>([]);
  const [fileActive, setFileActive] = useState(0);
  /** 当前 `@` 查询词在文本中的起始下标；null 表示不在引用状态。 */
  const [atStart, setAtStart] = useState<number | null>(null);

  /**
   * 高度自适应内容。
   *
   * 先归零再读 scrollHeight：不归零的话高度只会单调增长——删掉几行后
   * scrollHeight 仍是被撑开后的值，输入框永远收不回去。
   * 上限由 CSS 的 max-height 兜底，超出后转为内部滚动。
   */
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);

  /**
   * 消费外部加入的附件（「选择网页元素加入对话」）。
   *
   * 附件与正文分开：正文是用户打的话，附件是引用材料。混在一起时
   * 用户改自己写的话很容易误删到引用内容，也没法单独移除附件。
   */
  useEffect(() => {
    if (!pendingInput) return;
    setAttachments((prev) => [...prev, pendingInput]);
    onConsumePending();
  }, [pendingInput, onConsumePending]);

  /**
   * 消费外部推来的文本（行内评论）。
   *
   * 追加而不是覆盖：用户可能已经打了一半的话，评论是补充材料。
   * 追加后把光标移到末尾并聚焦——用户的下一步通常是补一句「按这个改」，
   * 光标停在中间会让他先按一次 End。
   */
  useEffect(() => {
    if (!pendingText) return;
    setText((prev) => (prev.trim() === '' ? pendingText : `${prev}\n\n${pendingText}`));
    onConsumePendingText?.();
    // 等 React 把这批更新刷进 DOM 之后再定光标，否则拿到的是旧值长度
    requestAnimationFrame(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }, [pendingText, onConsumePendingText]);

  /**
   * `@` 引用：文本或光标变化时重算查询词并拉取候选。
   *
   * 需要防抖：每次按键都发一次搜索会把服务端打满，而用户打字期间
   * 只有最后一次的结果有意义。120ms 是「感觉不出延迟」与「明显少发请求」
   * 之间的常见取值。
   */
  useEffect(() => {
    if (!onSearchFiles) return;
    const el = taRef.current;
    const pos = el?.selectionStart ?? text.length;
    const q = atQueryAt(text, pos);
    if (q === null) {
      setAtStart(null);
      setFileMatches([]);
      return;
    }
    // 记下 @ 的下标，选中后据此替换掉「@查询词」这一段
    setAtStart(pos - q.length - 1);
    let cancelled = false;
    const timer = setTimeout(() => {
      void onSearchFiles(q).then((ms) => {
        // 竞态守卫：慢请求返回时用户可能已经改了输入
        if (!cancelled) {
          setFileMatches(ms);
          setFileActive(0);
        }
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, onSearchFiles]);

  /** 选中一个候选：把「@查询词」替换成文件路径引用。 */
  const pickFile = (m: FileMatch) => {
    if (atStart === null) return;
    const el = taRef.current;
    const caret = el?.selectionStart ?? text.length;
    // 引用写成 `@路径`：模型能直接读到，用户也能看懂指向哪里
    const inserted = `@${m.path} `;
    const next = text.slice(0, atStart) + inserted + text.slice(caret);
    setText(next);
    setFileMatches([]);
    setAtStart(null);
    // 光标落到插入内容之后
    const pos = atStart + inserted.length;
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(pos, pos);
    });
  };

  /**
   * 斜杠命令（规格 04 §4.5）。
   *
   * 只实现协议真正支持的：`/compact` 对应 `thread/compact/start`。
   * 不去做「看起来能用但改了本地状态」的假命令——那类命令比没有更糟。
   */
  const runSlashCommand = (raw: string): boolean => {
    const cmd = raw.trim();
    if (!cmd.startsWith('/')) return false;
    if (cmd === '/compact' && onCompact) {
      onCompact();
      setText('');
      return true;
    }
    return false;
  };

  const submit = () => {
    const t = text.trim();
    // 只有附件、没有正文时也应可发送：用户可能就只想说「看这个元素」
    if ((!t && attachments.length === 0) || disabled || running) return;
    // 两类附件走不同通道：
    // - 网页元素 → 序列化成**文本**追加在正文后（模型只能读文字）；
    // - 图片 → 以协议 `localImage` 的形式、用**路径**随轮次提交（见 onSubmit 第二参）。
    const webEls = attachments.filter((a): a is WebElementAttachment => a.kind === 'webElement');
    const images = attachments.filter((a): a is ImageAttachment => a.kind === 'image');
    const attached = serializeWebElements(webEls);
    const full = attached ? (t ? `${t}\n\n${attached}` : attached) : t;
    onSubmit(full, images.map((im) => im.path));
    // 历史记「用户实际打的话」而不是拼上附件后的全文：
    // 回溯出来再发一次时不该把上次的引用材料又带一遍。
    setHistory((h) => pushHistory(h, t));
    setCursor(INITIAL_CURSOR);
    setText('');
    setAttachments([]);
    setPreview(null);
    setAttachError(null);
  };

  /**
   * 加入一批图片附件。
   *
   * 拖放与粘贴共用：两者拿到的东西不同（拖放直接给绝对路径，
   * 粘贴只有字节），但校验与入列的逻辑完全一致。
   */
  const addImages = (items: ImageAttachment[]) => {
    if (items.length === 0) return;
    setAttachments((prev) => [...prev, ...items]);
    setAttachError(null);
  };

  /** 读一个 File 为 data URL（缩略图预览用）。 */
  const readAsDataUrl = (f: File) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('读取文件失败'));
      r.readAsDataURL(f);
    });

  /**
   * 处理粘贴：从剪贴板取图片并落盘。
   *
   * 剪贴板给的是字节、没有路径，而协议只认路径（`localImage`），
   * 因此必须先写到磁盘——走 `save_attachment` 命令，目录由后端固定，
   * 前端不能指定，避免「传什么写什么」的路径注入面。
   */
  const handlePaste = async (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return; // 纯文本粘贴：走默认行为
    e.preventDefault();

    const { accepted, rejected } = imageFilesFrom(files);
    if (rejected.length > 0) setAttachError(rejected.map((r) => r.message).join('；'));

    // 非 Tauri 环境（浏览器里跑 vite dev）没有 invoke：
    // 不提前拦会抛出「Cannot read properties of undefined」这种
    // 与用户操作毫无关系的错误。
    if (!inTauri()) {
      if (accepted.length > 0) setAttachError('图片附件需要桌面端，浏览器预览不支持');
      return;
    }

    const out: ImageAttachment[] = [];
    for (const f of accepted) {
      try {
        const preview = await readAsDataUrl(f);
        const dataBase64 = preview.slice(preview.indexOf(',') + 1);
        const saved = await invoke<SavedAttachment>('save_attachment', {
          fileName: f.name || `pasted.${extensionOf(f.name, f.type)}`,
          dataBase64,
        });
        out.push({
          kind: 'image',
          path: saved.path,
          name: saved.name,
          // 用后端回传的 data URL（与落盘字节完全一致），
          // 而不是前端那份——两者本应相同，但以落盘内容为准更可靠。
          preview: saved.previewDataUrl,
          size: saved.size,
        });
      } catch (err) {
        setAttachError(err instanceof Error ? err.message : String(err));
      }
    }
    addImages(out);
  };

  /**
   * 处理从系统拖入的文件。
   *
   * **拖放的文件本来就有绝对路径**（Tauri 在拖放事件里直接给出），
   * 所以不经过落盘，直接把路径交给 `localImage` —— 少一次读写，
   * 也不会在 app_data 里留下一份副本。
   */
  useEffect(() => {
    if (!inTauri()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];

    // 拖入过程中给出可见反馈：此时文件还没进来，没有反馈用户会以为
    // 「拖了没反应」而反复拖。over/leave 由 Tauri 成对发出。
    const onEnter = (ev: { payload?: { paths?: string[] } }) => {
      setDropping(true);
      // 拖入过程中就显示**真实缩略图**：Tauri 的 enter 事件已带 paths，
      // 因此可以在用户松手之前让他确认「拖的是这几张」。
      // 用 DataURL 缩略图预览，不落盘（落盘发生在 drop）。
      const imgs = (ev.payload?.paths ?? []).filter((p) =>
        /\.(png|jpe?g|gif|webp|bmp)$/i.test(p),
      );
      if (imgs.length > 0) setDragPreview(imgs.map((p) => ({ name: p.split('/').pop() ?? p, path: p })));
    };
    const onOver = () => setDropping(true);
    const onLeave = () => {
      setDropping(false);
      setDragPreview([]);
    };
    void listen<{ paths: string[] }>('tauri://drag-enter', onEnter).then((fn) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    });

    void listen('tauri://drag-over', onOver).then((fn) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    });
    void listen('tauri://drag-leave', onLeave).then((fn) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    });
    void listen<{ paths: string[] }>('tauri://drag-drop', (ev) => {
      setDropping(false);
      setDragPreview([]);
      const paths = ev.payload?.paths ?? [];
      const isImg = (p: string) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(p);
      const imgs = paths.filter(isImg);
      const others = paths.filter((p) => !isImg(p));
      if (others.length > 0) {
        setAttachError(
          `只能附加图片，已忽略：${others.map((p) => p.split('/').pop()).join('、')}`,
        );
      }
      if (imgs.length === 0) return;
      // 交给后端复制进附件目录：这样时间线预览只需认那一个目录，
      // 也避免用户之后移动/删除源文件导致图片永久失效。
      void (async () => {
        const out: ImageAttachment[] = [];
        for (const p of imgs) {
          try {
            const saved = await invoke<SavedAttachment>('attach_local_image', { path: p });
            out.push({
              kind: 'image',
              path: saved.path,
              name: saved.name,
              preview: saved.previewDataUrl,
              size: saved.size,
            });
          } catch (err) {
            setAttachError(err instanceof Error ? err.message : String(err));
          }
        }
        addImages(out);
      })();
    }).then((fn) => {
      if (disposed) fn();
      else unlisteners.push(fn);
    });

    return () => {
      disposed = true;
      for (const fn of unlisteners) fn();
    };
  }, []);

  const current = models.find((m) => m.id === selectedModel);
  const efforts = current?.reasoningEfforts ?? [];

  /**
   * 下拉项在每次渲染时重建（列表很短，无需缓存）。
   *
   * 模型列表首项是「跟随配置」：它必须**显示实际模型名**——
   * 只写「默认」的话用户无法知道真正会跑什么，而那正是
   * 「界面描述与行为不一致」最容易出问题的地方。
   */
  const modelItems: MenuItem[] = useMemo(
    () => [
      {
        value: '',
        label: configuredModel ?? '默认模型',
        hint: '跟随 config.toml',
      },
      ...models.map((m) => ({ value: m.id, label: m.displayName })),
    ],
    [models, configuredModel],
  );

  const effortItems: MenuItem[] = useMemo(
    () => efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] ?? e })),
    [efforts],
  );

  return (
    <div className="composer">
      {/* 内容约束到与对话正文同一条阅读栏宽（--read-width）并对齐居中。
          此前输入框撑满整个中栏，宽窗口下与正文左右边缘都差一大截，
          视线从正文移到输入框要横向跳一段。 */}
      <div className="composer-inner">
      {/* `@` 引用候选：贴在输入框上方。向上弹出是刻意的——
          输入框在窗口底部，向下没有空间。 */}
      {fileMatches.length > 0 && atStart !== null && (
        <div className="at-menu" role="listbox" aria-label="引用文件">
          <div className="at-menu-head">
            <Icon name="search" size={11} />
            <span>引用工作区文件</span>
          </div>
          {fileMatches.map((m, i) => (
            <button
              key={m.path}
              role="option"
              aria-selected={i === fileActive}
              className={`at-item ${i === fileActive ? 'is-active' : ''}`}
              onMouseEnter={() => setFileActive(i)}
              onMouseDown={(e) => {
                // mousedown 选中：click 会先让 textarea 失焦，
                // 而失焦会触发 blur 上的清理逻辑把候选清掉。
                e.preventDefault();
                pickFile(m);
              }}
            >
              <Icon name={m.matchType === 'directory' ? 'folder' : 'file'} size={12} />
              <span className="at-name">{m.fileName}</span>
              <span className="at-path" title={m.path}>
                {m.path}
              </span>
            </button>
          ))}
        </div>
      )}
      {/* 拖入时的全屏提示。
          # 为什么做全屏、以及我们和参照的不同
          参照客户端也是全屏，但它们只给一句话。Tauri 的 `drag-enter`
          事件**已经带了文件路径**，因此我们能在用户松手之前就显示
          「拖的是哪几张」——图片用小预览、非图片直接标红说明会被忽略。
          这样松手前就能发现问题，而不必等附加完再看。 */}
      {dropping && (
        <div className="drop-overlay" role="status" aria-live="polite">
          <div className="drop-card">
            <div className="drop-icon">
              <Icon name="image" size={22} />
            </div>
            <p className="drop-title">松手即可附加</p>
            {dragPreview.length > 0 ? (
              <>
                <ul className="drop-list">
                  {dragPreview.map((d) => (
                    <li key={d.path}>
                      <Icon name="image" size={12} />
                      <span className="drop-name">{d.name}</span>
                    </li>
                  ))}
                </ul>
                <p className="drop-note">
                  将复制到 KCode 的附件目录，原文不会改动
                </p>
              </>
            ) : (
              <p className="drop-note">把这个文件拖到窗口任意位置即可</p>
            )}
          </div>
        </div>
      )}
      <div className={`composer-box ${running ? 'is-running' : ''}`}>
        {/* 附件区：在文本域之上。放在上面而不是下面，是因为它属于
            「这次要发送的内容」，视线应当先看到内容再看到操作。 */}
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((a, i) => {
              // **不能用 <button> 套 <button>**（含 role="button" 的 span）：
              // 嵌套交互元素是非法 HTML，真实浏览器的行为不可预期
              // （点击内层可能触发外层、也可能都不触发，各引擎不一）。
              // 改成一个容器 + 两个并列按钮：展开与移除各司其职。
              //
              // 图片附件额外显示缩略图：只看文件名无法确认「是不是这张」，
              // 而贴错图是常见操作，用户需要在发送前一眼核对。
              const isImg = a.kind === 'image';
              return (
                <span key={isImg ? a.path : `${a.selector}-${i}`} className="attach-chip">
                  {isImg && a.preview && (
                    <img className="attach-thumb" src={a.preview} alt="" />
                  )}
                  <button
                    className={`attach-open ${preview === i ? 'is-open' : ''}`}
                    onClick={() => setPreview(preview === i ? null : i)}
                    title={isImg ? a.path : a.selector}
                  >
                    <Icon name={isImg ? 'image' : 'compass'} size={11} />
                    <span className="attach-label">
                      {isImg
                        ? a.name
                        : attachments.length > 1
                          ? `网页元素 ${i + 1}`
                          : '1 个网页元素'}
                    </span>
                  </button>
                  <button
                    className="attach-remove"
                    aria-label="移除附件"
                    title="移除"
                    onClick={() => {
                      setAttachments((prev) => prev.filter((_, j) => j !== i));
                      setPreview(null);
                    }}
                  >
                    <Icon name="close" size={10} />
                  </button>
                </span>
              );
            })}
          </div>
        )}

        {/* 附件被拒的原因：不静默丢弃——用户以为贴上了才是最坏的 */}
        {attachError && (
          <p className="attach-error" role="alert">
            {attachError}
          </p>
        )}

        {/* 预览卡片：与参照一致，显示标签、内容摘要与来源。
            点一下才展开，避免长文本一直占着输入区。
            图片附件走单独分支：它的信息是「哪一张、多大」，没有选择器与正文。 */}
        {preview !== null && attachments[preview] && (
          attachments[preview].kind === 'image' ? (
            <div className="attach-preview">
              <div className="attach-preview-head">
                <span className="attach-tag">图片</span>
                <span className="attach-size">
                  {attachments[preview].size > 0 ? formatSize(attachments[preview].size) : '外部文件'}
                </span>
              </div>
              {(attachments[preview] as ImageAttachment).preview && (
                <img
                  className="attach-preview-img"
                  src={(attachments[preview] as ImageAttachment).preview}
                  alt={attachments[preview].name}
                />
              )}
              <p className="attach-src" title={(attachments[preview] as ImageAttachment).path}>
                {(attachments[preview] as ImageAttachment).path}
              </p>
            </div>
          ) : (
          <div className="attach-preview">
            <div className="attach-preview-head">
              <span className="attach-tag">{(attachments[preview] as WebElementAttachment).tag}</span>
              <span className="attach-size">
                {(attachments[preview] as WebElementAttachment).width}×
                {(attachments[preview] as WebElementAttachment).height}
              </span>
              {(attachments[preview] as WebElementAttachment).color && (
                <span className="attach-color">
                  <span
                    className="attach-swatch"
                    style={{ background: (attachments[preview] as WebElementAttachment).color }}
                  />
                  {(attachments[preview] as WebElementAttachment).color}
                </span>
              )}
            </div>
            {(attachments[preview] as WebElementAttachment).text && (
              <p className="attach-text">{(attachments[preview] as WebElementAttachment).text}</p>
            )}
            <p className="attach-src" title={(attachments[preview] as WebElementAttachment).url}>
              {(attachments[preview] as WebElementAttachment).selector}
            </p>
          </div>
          )
        )}

        <textarea
          ref={taRef}
          value={text}
          placeholder={
            disabled
              ? '请先新建对话…'
              : running
                ? '任务进行中，可继续输入以追加指令'
                : '随心输入，可粘贴或拖入图片'
          }
          disabled={disabled}
          onPaste={(e) => void handlePaste(e)}
          onChange={(e) => {
            setText(e.target.value);
            // 一旦手动编辑就退出历史回溯：否则用户改完历史项再按 ↑，
            // 会从改前的下标继续走，光标位置与内容对不上。
            setCursor(INITIAL_CURSOR);
          }}
          onKeyDown={(e) => {
            // `@` 候选列表的键盘导航优先于其他绑定：此时 ↑↓/Enter
            // 的语义是「在候选里选」，不是「翻历史」或「发送」。
            if (fileMatches.length > 0 && atStart !== null) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setFileActive((i) => moveIndex(i, fileMatches.length, 1));
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setFileActive((i) => moveIndex(i, fileMatches.length, -1));
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                const m = fileMatches[fileActive];
                if (m) pickFile(m);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                // 只关候选列表，不关整个输入——用户通常想继续打字
                setFileMatches([]);
                setAtStart(null);
                return;
              }
            }

            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              // 斜杠命令先于普通提交：`/compact` 是命令而不是要发给模型的话
              if (runSlashCommand(text)) return;
              submit();
              return;
            }
            // ↑ / ↓ 回溯历史，但**只在光标处于首/末行时**接管：
            // 多行输入里光标在中间时，方向键属于文本导航，
            // 抢占它会让用户无法在已输入内容中上下移动。
            if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.metaKey) {
              const el = taRef.current;
              // 光标之前没有换行 = 在第一行 → 才把 ↑ 解释为「翻历史」
              if (!el || el.value.slice(0, el.selectionStart).includes('\n')) return;
              if (history.length === 0 && cursor.index === null) return;
              e.preventDefault();
              const r = historyPrev(history, cursor, text);
              setCursor(r.cursor);
              setText(r.text);
              return;
            }
            if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !e.metaKey) {
              const el = taRef.current;
              // 光标之后没有换行 = 在最后一行
              if (!el || el.value.slice(el.selectionStart).includes('\n')) return;
              if (cursor.index === null) return;
              e.preventDefault();
              const r = historyNext(history, cursor);
              setCursor(r.cursor);
              setText(r.text);
            }
          }}
          rows={1}
        />

        <div className="composer-bar">
          {/* 左：上下文。项目说明「任务在哪运行」、权限档位说明「它会怎么运行」
              —— 都是提交前必须确认的前提，所以常驻在此，不藏进设置页。

              **分支不在这里**：它属于工具栏（规格 03 §3.2 把「当前目录/分支」
              划给 Toolbar），而我们的浮层（StatusDock）已有 Git 段专门管它，
              还带提交/推送入口。两处都显示同一个分支名是冗余。 */}
          <div className="ctx-chips">
            <span className="ctx-chip ctx-primary" title={git?.root ?? projectName}>
              <Icon name="folder" size={11} />
              {projectName}
            </span>
            <PermissionPicker
              current={permissionMode}
              disabled={disabled}
              onSelect={onSelectPermission}
            />
          </div>

          {/* 右：模型 + 发送 */}
          <div className="composer-right">
            <MenuSelect
              items={modelItems}
              value={selectedModel ?? ''}
              onChange={onSelectModel}
              disabled={disabled}
              title="模型"
              ariaLabel="模型"
            />

            {efforts.length > 0 && (
              <MenuSelect
                items={effortItems}
                value={selectedEffort ?? ''}
                onChange={(v) => onSelectEffort(v || null)}
                disabled={disabled}
                title="推理强度"
                ariaLabel="推理强度"
              />
            )}

            {running && onStop ? (
              <button className="send-btn stop" onClick={onStop} title="停止（Esc）">
                <Icon name="stop" size={13} />
              </button>
            ) : (
              <button
                className="send-btn"
                disabled={disabled || (!text.trim() && attachments.length === 0)}
                onClick={submit}
                title="发送（Enter）"
              >
                <Icon name="arrow-up" size={15} />
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
