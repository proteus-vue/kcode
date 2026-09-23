/**
 * 时长格式化。
 *
 * # 为什么单独成模块并需要测
 *
 * 中文的时长表述在不同量级下用词不同（秒 / 分 / 小时），而**换行与进位**
 * 是最容易出错的地方：`3900_000ms` 写成「65 分」不算错，但用户要在脑子里
 * 再做一次除法；`59_999ms` 四舍五入成「60 秒」也读得通，可 60 秒该进位成
 * 1 分。这类错误不会报错，只会让数字看起来"有点怪"。
 *
 * 展示的位置是轮次末尾（「已处理 6s」），所以这里统一输出**紧凑形式**：
 * - 不足 1 秒 → 毫秒（`850ms`）
 * - 不足 1 分 → 秒（`6s`）
 * - 不足 1 小时 → `3 分 05 秒`
 * - 以上 → `1 小时 12 分`
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** 把毫秒格式化成紧凑的中文时长。非法输入返回空串（调用方据此不显示）。 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  if (!Number.isFinite(ms) || ms < 0) return '';

  if (ms < SECOND) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < MINUTE) {
    // 秒级：保留一位小数会让「6.4s」显得精确但其实无所谓，直接取整更干净
    // （不足 1 秒的精度已在上面单独处理）。
    //
    // **取整后要防「60s」**：59.6s 会舍入成 60，而 60 秒应当读作「1 分」。
    // 这是测试抓出来的——量级边界上的取整不检查进位，就会产出
    // 「60s」这种虽然不算错、但用户要在脑子里换算的读数。
    const s = Math.round(ms / SECOND);
    return s === 60 ? '1 分' : `${s}s`;
  }
  if (ms < HOUR) {
    let m = Math.floor(ms / MINUTE);
    let s = Math.round((ms % MINUTE) / SECOND);
    // 进位：59.6 秒四舍五入成 60 秒时，要变成「+1 分 0 秒」而不是「60 秒」
    if (s === 60) {
      s = 0;
      m += 1;
    }
    // 分钟也进位后可能触碰小时边界（59 分 59.9 秒 → 60 分 → 1 小时）
    if (m === 60) return '1 小时';
    return s === 0 ? `${m} 分` : `${m} 分 ${String(s).padStart(2, '0')} 秒`;
  }
  let h = Math.floor(ms / HOUR);
  let m = Math.round((ms % HOUR) / MINUTE);
  if (m === 60) {
    m = 0;
    h += 1;
  }
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}
