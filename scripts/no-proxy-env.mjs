/**
 * 子进程环境：把回环地址并入 `NO_PROXY`。
 *
 * # 为什么需要这个
 *
 * 装了系统代理的机器上（macOS 的「网络 → 代理」，Clash/Surge 之类），
 * codex 的 HTTP 客户端**会使用系统代理，但不读系统代理设置里的例外列表**。
 * 于是发往本地 mock provider / 本地模型（Ollama、LM Studio）的请求被交给代理，
 * 代理回 `502 Bad Gateway`，而本地那端**一次请求都收不到**。
 *
 * 症状很有迷惑性：契约测试报「未收到服务端审批请求」「mock 收到 0 次请求」，
 * 看起来像协议实现出错，实际是流量根本没送到。见
 * `docs/协议勘误与修正.md` §3.21。
 *
 * # 边界
 *
 * 只影响「本机 → 本机」的流量，不会让任何真实出站绕开代理；
 * 用户既有的 `NO_PROXY` 条目原样保留（合并而非覆盖）。
 */

export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/** 把回环地址并入一份既有 `NO_PROXY` 值（逗号分隔）：保留原条目、去重、幂等。 */
export function mergeLoopbackNoProxy(existing) {
  const entries = [];
  for (const raw of String(existing ?? '').split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (!entries.some((e) => e.toLowerCase() === trimmed.toLowerCase())) entries.push(trimmed);
  }
  for (const host of LOOPBACK_HOSTS) {
    if (!entries.some((e) => e.toLowerCase() === host.toLowerCase())) entries.push(host);
  }
  return entries.join(',');
}

/**
 * 在既有环境之上补齐回环绕行代理。
 *
 * 大小写两份都设置：不同 HTTP 客户端读的键不同。
 */
export function withLoopbackNoProxy(env = process.env) {
  const merged = mergeLoopbackNoProxy(env.NO_PROXY ?? env.no_proxy);
  return { ...env, NO_PROXY: merged, no_proxy: merged };
}
