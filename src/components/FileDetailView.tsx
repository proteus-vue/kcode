/**
 * 文件 / 图片详情视图。
 *
 * 用途：会话里点一个文件路径或图片，在右栏直接看内容，
 * 不必离开对话去开编辑器。
 *
 * 两种内容分开渲染：图片走 `<img src=data:…>`（由 Rust 侧读成 data URL），
 * 文本走 `<pre>`。**不改用 iframe 加载 file://**：那等于给视图开一个
 * 任意本地文件读取面，而这里的内容路径可能来自模型输出。
 */
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Icon } from './Icon';
import { extractErrorMessage } from '../stores/useKcode';
import type { FileDetail } from '../types/domain';

/** 人类可读的字节数。 */
function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function FileDetailView({ path }: { path: string }) {
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * 重试计数器。
   *
   * 必须有：读取失败后（例如文件当时还不存在），用户修好文件回来
   * 只能看到旧的错误——effect 依赖 path，同一个路径不会重跑，
   * 于是没有任何办法刷新。实测踩过：文件建好之后面板仍显示
   * 「No such file or directory」。
   */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);

    invoke<FileDetail>('read_file_detail', { path })
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        // 读取失败必须显示出来。静默留白会让用户以为文件是空的。
        if (!cancelled) setError(extractErrorMessage(e));
      });

    return () => {
      cancelled = true;
    };
  }, [path, attempt]);

  if (error) {
    return (
      <div className="file-detail">
        <div className="file-detail-head">
          <Icon name="file" size={12} />
          <span className="file-detail-path" title={path}>
            {path}
          </span>
        </div>
        <p className="file-detail-error">{error}</p>
        {/* 提供重试：文件可能是刚创建的，或刚被 Agent 写入 */}
        <button className="mini-btn" onClick={() => setAttempt((n) => n + 1)}>
          重新读取
        </button>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="file-detail">
        <p className="panel-empty">正在读取…</p>
      </div>
    );
  }

  return (
    <div className="file-detail">
      <div className="file-detail-head">
        <Icon name="file" size={12} />
        <span className="file-detail-path" title={detail.absolutePath}>
          {detail.path}
        </span>
        <span className="file-detail-size">{humanSize(detail.size)}</span>
      </div>

      {detail.truncated && <p className="file-detail-note">{detail.truncated}</p>}

      {detail.imageDataUrl ? (
        <div className="file-detail-image">
          <img src={detail.imageDataUrl} alt={detail.path} />
        </div>
      ) : detail.text !== null ? (
        <pre className="file-detail-text">{detail.text}</pre>
      ) : (
        /* 二进制且非图片，或超出上限：如实说明，而不是显示乱码 */
        <p className="file-detail-note">
          这是二进制文件{detail.truncated ? '' : '，无法以文本显示'}。
        </p>
      )}
    </div>
  );
}
