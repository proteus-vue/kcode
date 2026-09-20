import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

/**
 * 说明：这里**没有** resize 监听。
 *
 * 曾经的版本在 resize 期间给 body 加 `is-resizing` 类来临时关闭模糊，
 * 想减少合成开销。但那会改变背景色与光斑透明度——**颜色突变本身就是
 * 可见的闪烁**，用户看到的「缩放时面板闪烁」有它一份。
 *
 * 模糊层已从 5-6 层降到 2 层，降级带来的收益不再值得这个视觉代价。
 * 保持零 resize 监听也让 React 完全不参与 resize 布局——
 * 布局由 CSS Grid 独立完成，没有中间层。
 */
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
