/**
 * 图片附件的接收与校验。
 *
 * # 为什么单独成模块
 *
 * 这里有两条只靠 UI 试不出来的规则：
 *
 * 1. **类型白名单**。剪贴板里可能是任意文件（PDF、zip、可执行文件），
 *    而协议只接受图片（`localImage`）。不校验的话会走到服务端才报错，
 *    用户看到的是一句和「我明明复制的是图片」无关的错误。
 * 2. **大小上限**。超大图会撑爆 JSON-RPC 报文；而且它必然要经过
 *    base64 编码（体积 ×1.37），前端不挡就得等一次长传输才失败。
 *
 * 两者都是纯判断，测试比真机点更快也更全。
 */

/** 允许的图片类型。协议侧只认图片，其余一律挡在这里。 */
export const IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
] as const;

/** 单张上限（字节）。与后端 `save_attachment` 的 20MB 保持一致。 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export interface RejectReason {
  /** 面向用户的拒绝原因。 */
  message: string;
}

/**
 * 校验一个待加入的图片。
 *
 * 返回 `null` 表示通过。
 */
export function validateImage(file: { type: string; size: number; name?: string }): RejectReason | null {
  const name = file.name || '图片';
  if (!IMAGE_TYPES.includes(file.type as (typeof IMAGE_TYPES)[number])) {
    // 明确说出收到了什么类型：用户往往以为自己复制的是图片
    const got = file.type || '未知类型';
    return { message: `${name} 不是支持的图片格式（${got}）` };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return {
      message: `${name} 过大（${(file.size / 1024 / 1024).toFixed(1)}MB，上限 20MB）`,
    };
  }
  return null;
}

/**
 * 从拖放事件的数据里挑出图片文件。
 *
 * 拖入多个文件时**保留顺序**：用户按顺序拖几张图，往往就是想表达
 * 「这是第一步、那是第二步」，重排会改变语义。
 */
export function imageFilesFrom<T extends { type: string; size: number; name?: string }>(
  files: readonly T[],
): { accepted: T[]; rejected: RejectReason[] } {
  const accepted: T[] = [];
  const rejected: RejectReason[] = [];
  for (const f of files) {
    const bad = validateImage(f);
    if (bad) rejected.push(bad);
    else accepted.push(f);
  }
  return { accepted, rejected };
}

/** 人类可读的字节数。 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 从文件名或 data URL 推断扩展名（供后端落盘用）。 */
export function extensionOf(name: string, mime: string): string {
  const fromName = name.includes('.') ? name.split('.').pop() ?? '' : '';
  if (fromName && fromName.length <= 8) return fromName.toLowerCase();
  const fromMime = mime.startsWith('image/') ? mime.slice(6) : '';
  // jpeg 的规范扩展名是 jpg
  return fromMime === 'jpeg' ? 'jpg' : fromMime || 'png';
}
