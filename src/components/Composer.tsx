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
import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { PermissionPicker } from './PermissionPicker';
import { serializeWebElements } from './attachmentSerialize';
import type {
  GitStatus,
  ModelOption,
  PermissionMode,
  WebElementAttachment,
} from '../types/domain';

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
}: {
  disabled: boolean;
  onSubmit: (text: string) => void;
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
}) {
  const [text, setText] = useState('');
  /** 已附加的引用材料。发送时随正文一起提交。 */
  const [attachments, setAttachments] = useState<WebElementAttachment[]>([]);
  /** 展开预览的附件（看完整内容）。 */
  const [preview, setPreview] = useState<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

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

  const submit = () => {
    const t = text.trim();
    // 只有附件、没有正文时也应可发送：用户可能就只想说「看这个元素」
    if ((!t && attachments.length === 0) || disabled || running) return;
    // 序列化在 attachmentSerialize 里（带测试）：模型看不到界面，
    // 只收到这段文本，字段缺一个它就定位不到用户指的是什么
    const attached = serializeWebElements(attachments);
    onSubmit(attached ? (t ? `${t}\n\n${attached}` : attached) : t);
    setText('');
    setAttachments([]);
    setPreview(null);
  };

  const current = models.find((m) => m.id === selectedModel);
  const efforts = current?.reasoningEfforts ?? [];
  const branch = git?.isRepo ? git.branch ?? 'HEAD 分离' : null;

  return (
    <div className="composer">
      <div className={`composer-box ${running ? 'is-running' : ''}`}>
        {/* 附件区：在文本域之上。放在上面而不是下面，是因为它属于
            「这次要发送的内容」，视线应当先看到内容再看到操作。 */}
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((a, i) => (
              // **不能用 <button> 套 <button>**（含 role="button" 的 span）：
              // 嵌套交互元素是非法 HTML，真实浏览器的行为不可预期
              // （点击内层可能触发外层、也可能都不触发，各引擎不一）。
              // 改成一个容器 + 两个并列按钮：展开与移除各司其职。
              <span key={`${a.selector}-${i}`} className="attach-chip">
                <button
                  className={`attach-open ${preview === i ? 'is-open' : ''}`}
                  onClick={() => setPreview(preview === i ? null : i)}
                  title={a.selector}
                >
                  <Icon name="compass" size={11} />
                  <span className="attach-label">
                    {attachments.length > 1 ? `网页元素 ${i + 1}` : '1 个网页元素'}
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
            ))}
          </div>
        )}

        {/* 预览卡片：与参照一致，显示标签、内容摘要与来源。
            点一下才展开，避免长文本一直占着输入区。 */}
        {preview !== null && attachments[preview] && (
          <div className="attach-preview">
            <div className="attach-preview-head">
              <span className="attach-tag">{attachments[preview].tag}</span>
              <span className="attach-size">
                {attachments[preview].width}×{attachments[preview].height}
              </span>
              {attachments[preview].color && (
                <span className="attach-color">
                  <span
                    className="attach-swatch"
                    style={{ background: attachments[preview].color }}
                  />
                  {attachments[preview].color}
                </span>
              )}
            </div>
            {attachments[preview].text && (
              <p className="attach-text">{attachments[preview].text}</p>
            )}
            <p className="attach-src" title={attachments[preview].url}>
              {attachments[preview].selector}
            </p>
          </div>
        )}

        <textarea
          ref={taRef}
          value={text}
          placeholder={
            disabled ? '请先新建对话…' : running ? '任务进行中，可继续输入以追加指令' : '随心输入'
          }
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
        />

        <div className="composer-bar">
          {/* 左：上下文。项目与分支说明「任务会在哪里运行」，
              权限档位说明「它会怎么运行」——都是提交前必须确认的前提，
              所以常驻在此，不藏进设置页。 */}
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
            {branch && (
              <span className="ctx-chip" title={git?.isRepo ? '当前分支' : '非 git 仓库'}>
                <Icon name="branch" size={11} />
                {branch}
              </span>
            )}
            {git?.isRepo && git.ahead + git.behind > 0 && (
              <span className="ctx-chip mono" title={`领先 ${git.ahead} / 落后 ${git.behind}`}>
                ↑{git.ahead} ↓{git.behind}
              </span>
            )}
          </div>

          {/* 右：模型 + 发送 */}
          <div className="composer-right">
            <label className="model-picker" title="模型">
              <select
                value={selectedModel ?? ''}
                onChange={(e) => onSelectModel(e.target.value)}
                disabled={disabled}
              >
                {/* 「跟随配置」是默认项，且它必须**显示实际模型名**——
                    只写「默认」的话用户无法知道真正会跑什么。 */}
                <option value="">{configuredModel ?? '默认模型'}（配置）</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName}
                  </option>
                ))}
              </select>
            </label>

            {efforts.length > 0 && (
              <label className="effort-picker" title="推理强度">
                <select
                  value={selectedEffort ?? ''}
                  onChange={(e) => onSelectEffort(e.target.value || null)}
                  disabled={disabled}
                >
                  {efforts.map((e) => (
                    <option key={e} value={e}>
                      {EFFORT_LABEL[e] ?? e}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {running && onStop ? (
              <button className="send-btn stop" onClick={onStop} title="停止">
                <span className="stop-glyph" />
              </button>
            ) : (
              <button
                className="send-btn"
                disabled={disabled || (!text.trim() && attachments.length === 0)}
                onClick={submit}
                title="发送（Enter）"
              >
                ↑
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
