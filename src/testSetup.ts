/**
 * 测试环境准备。
 *
 * React 19 需要显式声明「当前处于 act 环境」，否则用 `act` 包裹的
 * 渲染每次都会打印警告——噪音会淹没真正的失败信息。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * jsdom 不实现 `ResizeObserver`，而布局相关组件（面板测量、
 * 浏览器视口适配）依赖它。真身实现由 WKWebView 提供，
 * 这里补一个空壳，避免整树挂载测试因环境缺失而误报。
 */
if (!('ResizeObserver' in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ResizeObserverStub;
}

