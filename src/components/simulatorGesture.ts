/**
 * 模拟器的指针手势识别。
 *
 * # 为什么单独成模块
 *
 * 「按下并移动」既可能是**点击**（手指按住时不可避免会抖几像素），也可能是
 * **滑动**（滚动列表、手势返回、拖动）。判错的后果是直接可见的：
 *
 * - 把点击判成滑动 → 列表被意外滚动，用户以为自己点错了；
 * - 把滑动判成点击 → 拖不动，用户以为模拟器卡了。
 *
 * 而这类错误**不会有任何报错**，只会让人觉得「模拟器不好用」。所以判定
 * 逻辑抽成纯函数，用测试把边界钉住。
 *
 * # 只用 pointer 事件，不挂 click
 *
 * 挂 click 会多出一个必须抑制的东西：手指滑动抬起后浏览器仍会补派一次
 * `click`，不抑制就会「滑完又点了一下」。既然 pointer 事件已经覆盖了
 * 点击与滑动两种情形，就不引入第二种事件源——少一个源就少一类需要
 * 对齐的时序问题。
 *
 * # 读数的单位是「显示像素」
 *
 * 阈值按 CSS 像素算，因为用户的手指是在**屏幕上**移动的。设备分辨率再高，
 * 手指的抖动幅度也不会变——换算到设备坐标反而会让阈值随分辨率漂移
 * （1080p 上 6px 的分量，在 4K 设备上变成 12px，判定标准就变了）。
 */

/** 手指按住时的容差：位移在此以内算点击。 */
export const TAP_SLOP_PX = 6;

/**
 * 滑动时长允许的范围（毫秒）。
 *
 * 由**用户实际拖动耗时**决定，而不是固定值——固定值会让快滑与慢拖
 * 产生同样的动画速度，手感立刻不对。夹紧是为了避开两端：
 * 过短（< 50ms）在设备上表现为瞬移，过长（> 1s）会让「滚动」变成
 * 「慢慢拖」，都不像真实触摸。
 */
export const MIN_SWIPE_MS = 50;
export const MAX_SWIPE_MS = 1000;

/** 一次指针交互的判定结果。 */
export type Gesture =
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs: number };

/**
 * 判定指针从 `start` 到 `end` 是一次点击还是滑动。
 *
 * 返回的是**显示坐标**下的手势描述；转成设备坐标由调用方做
 * （那一步已有独立实现与测试，见 SimulatorPanel 的 map）。
 *
 * `elapsedMs` 取用户实际按住的时长。点击不看时长（长按也是点击——
 * 设备端的长按菜单由此触发，不该被我们判成滑动）。
 */
export function classifyGesture(
  start: { x: number; y: number },
  end: { x: number; y: number },
  elapsedMs: number,
): Gesture {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.hypot(dx, dy);

  if (dist <= TAP_SLOP_PX) {
    return { kind: 'tap', x: end.x, y: end.y };
  }

  return {
    kind: 'swipe',
    x1: start.x,
    y1: start.y,
    x2: end.x,
    y2: end.y,
    durationMs: clampDuration(elapsedMs),
  };
}

/** 把实际拖动耗时夹到可用区间。 */
export function clampDuration(ms: number): number {
  // NaN 与负数回落到下限（它们是"没有有效读数"，取最短的合理值）；
  // +Infinity 走正常夹紧路径 → 落到上限。两者语义不同，不能合并成
  // 一个 `!isFinite` 判断——测试抓出过这个：Infinity 被误判成下限，
  // 结果"无限长的拖动"变成了最快的一滑。
  if (Number.isNaN(ms) || ms <= 0) return MIN_SWIPE_MS;
  return Math.max(MIN_SWIPE_MS, Math.min(MAX_SWIPE_MS, Math.round(ms)));
}
