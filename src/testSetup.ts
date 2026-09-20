/**
 * 测试环境准备。
 *
 * React 19 需要显式声明「当前处于 act 环境」，否则用 `act` 包裹的
 * 渲染每次都会打印警告——噪音会淹没真正的失败信息。
 */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
