/**
 * 自绘下拉选择器。
 *
 * # 为什么不用原生 `<select>`
 *
 * 原生 `<select>` 的展开面板由**操作系统**绘制——macOS 上是浅色圆角面板 +
 * 蓝色高亮条，与整套深色玻璃语言完全不搭。CSS 只能改到收起态的触发按钮，
 * 展开后的那一层碰不到（`<option>` 几乎不可样式化）。
 *
 * 输入区底行有两个这样的选择器（模型、推理强度），一眼就能看出「这不是
 * 同一个应用的东西」。
 *
 * # 浮层为什么 portal 到 body
 *
 * 与 PermissionPicker 同因：`.ctx-chips` 为了「芯片不换行」设了
 * `overflow: hidden`，而这里的选择器在输入区**底部**，浮层要向上弹出——
 * 留在原地会被容器裁掉，表现为「点了没反应」。这类问题在 DOM 和样式里
 * 都看不出来，只有真去点才发现。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { moveIndex } from './composerHistory';
import { Icon } from './Icon';

export interface MenuItem {
  /** 取值。空串用于「跟随配置」这类特殊项。 */
  value: string;
  /** 触发按钮与列表里的主文案。 */
  label: string;
  /** 列表里的次要说明（可省略）。 */
  hint?: string;
  /** 该项有风险语义时高亮（如完全访问权限）。 */
  danger?: boolean;
}

export function MenuSelect({
  items,
  value,
  onChange,
  disabled,
  title,
  /** 触发按钮上显示的前缀说明（如「模型」），省略则只显示当前值。 */
  prefix,
  /** 无障碍标签。 */
  ariaLabel,
}: {
  items: MenuItem[];
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  title?: string;
  prefix?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number } | null>(null);
  /** 键盘高亮项下标。打开时定位到当前值。 */
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const current = items.find((i) => i.value === value) ?? items[0];

  const measure = useCallback(() => {
    const el = rootRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: r.left,
      bottom: window.innerHeight - r.top + 8,
      width: Math.max(r.width, 180),
    });
  }, []);

  const close = useCallback(() => setOpen(false), []);

  const openMenu = useCallback(() => {
    measure();
    const i = items.findIndex((x) => x.value === value);
    setActive(i >= 0 ? i : 0);
    setOpen(true);
  }, [items, value, measure]);

  const pick = useCallback(
    (v: string) => {
      onChange(v);
      setOpen(false);
    },
    [onChange],
  );

  // 点击外部 / Esc / 滚动或缩放后关闭（位置会失效，关掉比飘走更可预期）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (rootRef.current?.contains(t) || t.closest?.('.menu-select-menu')) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  return (
    <div className="menu-select" ref={rootRef}>
      <button
        className="menu-select-trigger"
        onClick={() => (open ? close() : openMenu())}
        disabled={disabled}
        title={title ?? current?.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        {prefix && <span className="menu-select-prefix">{prefix}</span>}
        <span className={`menu-select-label ${current?.danger ? 'is-danger' : ''}`}>
          {current?.label ?? '—'}
        </span>
        <span className="menu-select-caret">
          <Icon name="chevron" size={10} />
        </span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            className="menu-select-menu"
            role="listbox"
            style={{ left: pos.left, bottom: pos.bottom, minWidth: pos.width }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => moveIndex(i, items.length, 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => moveIndex(i, items.length, -1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                const it = items[active];
                if (it) pick(it.value);
              }
            }}
            tabIndex={-1}
            ref={(el) => el?.focus()}
          >
            {items.map((it, i) => (
              <button
                key={it.value || '__default__'}
                role="option"
                aria-selected={it.value === value}
                className={`menu-select-item ${i === active ? 'is-active' : ''} ${
                  it.danger ? 'is-danger' : ''
                }`}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(it.value)}
              >
                <span className="menu-select-body">
                  <span className="menu-select-item-label">{it.label}</span>
                  {it.hint && <span className="menu-select-hint">{it.hint}</span>}
                </span>
                {it.value === value && (
                  <span className="menu-select-check">
                    <Icon name="check" size={12} />
                  </span>
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
