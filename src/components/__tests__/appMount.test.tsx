/**
 * 整树挂载冒烟测试：**黑屏的最终防线**。
 *
 * # 为什么需要它
 *
 * 2026-09-22 真机反馈「启动 dev 黑屏」：`ThreadRow` 引用了父作用域的
 * `renames`，Vite dev 不跑类型检查，渲染即 `ReferenceError` → React
 * 卸载整棵树 → 黑屏。当时 174 个前端测试全绿，因为它们都只测纯函数与
 * 局部组件，**没有任何一个真正挂载过 App**。
 *
 * 本测试挂载真实 `<App />`（`inTauri()` 在 jsdom 下为 false，所有 IPC
 * 调用自动短路），只要渲染路径上有任何一处抛错，这里就会失败——
 * 而不是等到用户打开应用才发现。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from '../../App';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

describe('App 整树挂载（黑屏回归守卫）', () => {
  it('挂载后渲染出三栏骨架，且控制台无渲染错误', () => {
    const errors: unknown[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      act(() => {
        root!.render(<App />);
      });
    } finally {
      console.error = origError;
    }

    // 三栏骨架必须都在——任一栏缺失说明渲染路径中断
    expect(host!.querySelector('.sidebar'), '左栏未渲染').not.toBeNull();
    expect(host!.querySelector('.composer, main'), '中栏未渲染').not.toBeNull();
    // 欢迎态（无线程时的初始界面）应出现，而不是空白
    expect((host!.textContent ?? '').length).toBeGreaterThan(0);
    expect(errors, `渲染过程中产生了 React 错误：${JSON.stringify(errors)}`).toHaveLength(0);
  });

  it('渲染不抛异常（抛错即黑屏）', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    expect(() => {
      act(() => {
        root!.render(<App />);
      });
    }).not.toThrow();
  });
});
