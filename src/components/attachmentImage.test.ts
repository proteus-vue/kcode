/**
 * 图片附件校验的测试。
 *
 * 两条规则都只在特定输入下出错，且症状会误导用户：
 * ±1 字节的边界、以及被当成图片的非图片文件。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_IMAGE_BYTES,
  extensionOf,
  formatSize,
  imageFilesFrom,
  validateImage,
} from './attachmentImage';

describe('validateImage', () => {
  it('支持的图片类型通过', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']) {
      expect(validateImage({ type, size: 1024 }), type).toBeNull();
    }
  });

  it('非图片类型被拒，且说明收到的是什么', () => {
    const r = validateImage({ type: 'application/pdf', size: 1024, name: 'a.pdf' });
    expect(r).not.toBeNull();
    expect(r!.message).toContain('a.pdf');
    // 用户常以为自己复制的是图片，错误里必须点明实际类型
    expect(r!.message).toContain('application/pdf');
  });

  it('空类型被拒（剪贴板可能不给 type）', () => {
    const r = validateImage({ type: '', size: 1024 });
    expect(r).not.toBeNull();
    expect(r!.message).toContain('未知类型');
  });

  it('恰好等于上限时通过（边界）', () => {
    expect(validateImage({ type: 'image/png', size: MAX_IMAGE_BYTES })).toBeNull();
  });

  it('超出 1 字节即被拒，并给出可读体积', () => {
    const r = validateImage({ type: 'image/png', size: MAX_IMAGE_BYTES + 1 });
    expect(r).not.toBeNull();
    expect(r!.message).toContain('20.0MB');
  });

  it('零字节图片通过（可能是占位文件，交给上游判断）', () => {
    expect(validateImage({ type: 'image/png', size: 0 })).toBeNull();
  });
});

describe('imageFilesFrom', () => {
  const img = (name: string, size = 100) => ({ type: 'image/png', size, name });

  it('全部合法时按原顺序保留', () => {
    const { accepted, rejected } = imageFilesFrom([img('a.png'), img('b.png'), img('c.png')]);
    expect(accepted.map((f) => f.name)).toEqual(['a.png', 'b.png', 'c.png']);
    expect(rejected).toHaveLength(0);
  });

  it('混合时保序地只收图片（顺序即「第一步、第二步」的语义）', () => {
    const { accepted, rejected } = imageFilesFrom([
      img('1.png'),
      { type: 'application/zip', size: 10, name: 'x.zip' },
      img('2.png'),
    ]);
    expect(accepted.map((f) => f.name)).toEqual(['1.png', '2.png']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].message).toContain('x.zip');
  });

  it('空列表返回空结果（不抛错）', () => {
    expect(imageFilesFrom([])).toEqual({ accepted: [], rejected: [] });
  });

  it('每个被拒文件都有一条原因（不静默丢弃）', () => {
    const { accepted, rejected } = imageFilesFrom([
      { type: 'text/plain', size: 1, name: 'a.txt' },
      { type: 'application/zip', size: 1, name: 'b.zip' },
    ]);
    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(2);
  });
});

describe('formatSize', () => {
  it('按量级选单位', () => {
    expect(formatSize(500)).toBe('500 B');
    expect(formatSize(2048)).toBe('2 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});

describe('extensionOf', () => {
  it('优先用文件名后缀', () => {
    expect(extensionOf('shot.PNG', 'image/png')).toBe('png');
  });

  it('无后缀时从 mime 推断，并把 jpeg 规范成 jpg', () => {
    expect(extensionOf('clipboard', 'image/jpeg')).toBe('jpg');
    expect(extensionOf('clipboard', 'image/webp')).toBe('webp');
  });

  it('都没有时回退 png（不产生空扩展名）', () => {
    expect(extensionOf('clipboard', '')).toBe('png');
  });

  it('异常长的「后缀」不当扩展名（可能是文件名里带点）', () => {
    expect(extensionOf('a.verylongextension', 'image/png')).toBe('png');
  });
});
