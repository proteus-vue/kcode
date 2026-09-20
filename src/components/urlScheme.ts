/**
 * URL 协议补全。
 *
 * 单独成模块是为了可测：这段逻辑的错误**不会报错**，只会让页面一片空白
 * （客户端对着明文端口发 TLS 握手，服务器回 400），用户完全看不出原因。
 * 实测踩过一次，所以必须有测试钉住。
 */

/**
 * 给用户输入的地址补上协议。
 *
 * **本地地址补 http，其余补 https**。开发服务器（`localhost:3000`、
 * `127.0.0.1:8000`）几乎都不带 TLS；一律补 https 会让客户端对着
 * 明文端口发起 TLS 握手，结果是空白页面。
 *
 * 判定用「主机是否为本地/内网」而不是「端口是否常见」：
 * 本地地址的语义明确，端口只是约定。
 */
export function withScheme(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  let host: string;
  try {
    host = new URL(`http://${trimmed}`).hostname;
  } catch {
    return `https://${trimmed}`;
  }

  const isLocal =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  return `${isLocal ? 'http' : 'https'}://${trimmed}`;
}
