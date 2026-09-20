/**
 * URL 协议补全的测试。
 *
 * 这里的错误**不会抛异常**，只会让内嵌浏览器显示一片空白——
 * 因为客户端对着明文端口发了 TLS 握手。实测踩过一次
 * （dev server 日志里全是 \x16\x03\x01 开头的握手字节），
 * 所以逐条钉住。
 */
import { describe, expect, it } from 'vitest';
import { withScheme } from './urlScheme';

describe('withScheme', () => {
  it('已有协议时原样返回', () => {
    expect(withScheme('https://example.com')).toBe('https://example.com');
    expect(withScheme('http://example.com')).toBe('http://example.com');
    expect(withScheme('HTTPS://Example.com')).toBe('HTTPS://Example.com');
  });

  it('本地地址补 http —— 开发服务器不带 TLS', () => {
    // 这是最容易踩的一条：一律补 https 会让本地服务完全打不开
    expect(withScheme('localhost:3000')).toBe('http://localhost:3000');
    expect(withScheme('127.0.0.1:8899')).toBe('http://127.0.0.1:8899');
    expect(withScheme('127.0.0.1:8901/probe')).toBe('http://127.0.0.1:8901/probe');
    expect(withScheme('localhost')).toBe('http://localhost');
    expect(withScheme('[::1]:8080')).toBe('http://[::1]:8080');
  });

  it('私有网段也补 http —— 内网服务同样基本不用 TLS', () => {
    expect(withScheme('192.168.1.10:8080')).toBe('http://192.168.1.10:8080');
    expect(withScheme('10.0.0.5')).toBe('http://10.0.0.5');
    expect(withScheme('172.16.0.1:9000')).toBe('http://172.16.0.1:9000');
    expect(withScheme('172.31.255.254')).toBe('http://172.31.255.254');
  });

  it('172.x 的边界：16..31 才算私有，15 与 32 不是', () => {
    expect(withScheme('172.15.0.1')).toBe('https://172.15.0.1');
    expect(withScheme('172.32.0.1')).toBe('https://172.32.0.1');
  });

  it('公网域名补 https', () => {
    expect(withScheme('example.com')).toBe('https://example.com');
    expect(withScheme('example.com/path?a=1')).toBe('https://example.com/path?a=1');
    expect(withScheme('api.github.com')).toBe('https://api.github.com');
  });

  it('前后空白被裁掉', () => {
    expect(withScheme('  example.com  ')).toBe('https://example.com');
    expect(withScheme('\tlocalhost:3000\n')).toBe('http://localhost:3000');
  });

  it('不误判前缀相似的域名', () => {
    // 这些看起来像但不该被当成本地地址
    expect(withScheme('localhost.evil.com')).toBe('https://localhost.evil.com');
    expect(withScheme('127.0.0.1.evil.com')).toBe('https://127.0.0.1.evil.com');
    expect(withScheme('my192.168.1.1.com')).toBe('https://my192.168.1.1.com');
  });

  it('子域 .localhost 视为本地', () => {
    expect(withScheme('app.localhost:5173')).toBe('http://app.localhost:5173');
  });
});
