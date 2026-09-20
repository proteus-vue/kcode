//! 敏感信息脱敏。
//!
//! # 为什么必须在写入前脱敏
//!
//! `SECURITY.md` 承诺「审计日志不含明文凭据」。审计记录的是**命令原文**，
//! 而命令里经常出现密钥：`curl -H "Authorization: Bearer sk-..."`、
//! `export AWS_SECRET_ACCESS_KEY=...`、`.env` 内容被读取等。
//!
//! 若原样落库，一次误操作就把凭据永久写进了本地日志——而审计日志
//! 恰恰是被设计成「可导出、可分享给他人排查」的产物。
//!
//! # 设计原则
//!
//! - **宁可过度掩码**：把非敏感内容遮掉只损失可读性；漏掉一个真密钥就是泄露。
//! - **保留结构**：`KEY=***` 比整行打码更有用，用户仍能看出命令在做什么。
//! - **不可逆**：不做「点击显示」——需要明文时用户可查看原始 Item 事件，
//!   但审计与导出物永不含明文。

use serde::{Deserialize, Serialize};

/// 需要整段替换的敏感模式（正则不便表达的部分用前缀匹配）。
const TOKEN_PREFIXES: &[(&str, &str)] = &[
    ("sk-", "sk-***"),
    ("ghp_", "ghp_***"),
    ("gho_", "gho_***"),
    ("ghs_", "ghs_***"),
    ("github_pat_", "github_pat_***"),
    ("xoxb-", "xoxb-***"),
    ("xoxp-", "xoxp-***"),
    ("AKIA", "AKIA***"),
    ("ASIA", "ASIA***"),
    ("AIza", "AIza***"),
    ("glpat-", "glpat-***"),
    ("npm_", "npm_***"),
];

/// 环境变量名中包含这些片段时，其值一律掩码。
const SENSITIVE_KEY_MARKERS: &[&str] = &[
    "TOKEN", "SECRET", "PASSWORD", "PASSWD", "APIKEY", "API_KEY",
    "ACCESS_KEY", "PRIVATE_KEY", "CREDENTIAL", "AUTH", "SESSION",
    "BEARER", "COOKIE", "_KEY", "PWD",
];

/// 命令文本中的敏感旗标：其紧随参数应被掩码。
const SENSITIVE_FLAGS: &[&str] = &[
    "--password", "-p", "--token", "--api-key", "--apikey",
    "--secret", "--auth", "--authorization", "-H", "--header",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Redaction {
    pub text: String,
    /// 被掩码的处数。用于审计中标注「此处有 N 处被脱敏」。
    pub masked_count: usize,
}

impl Redaction {
    pub fn is_clean(&self) -> bool {
        self.masked_count == 0
    }
}

/// 判断某个 key 名是否敏感。
pub fn is_sensitive_key(key: &str) -> bool {
    let upper = key.to_uppercase();
    SENSITIVE_KEY_MARKERS.iter().any(|m| upper.contains(m))
}

/// 对一段文本做脱敏。
pub fn redact(text: &str) -> Redaction {
    let mut out = text.to_owned();
    let mut count = 0usize;

    // 1. 私钥块：整段替换（跨行，先处理）
    if out.contains("-----BEGIN") && out.contains("PRIVATE KEY-----") {
        let mut result = String::new();
        let mut in_key = false;
        for line in out.lines() {
            if line.contains("-----BEGIN") && line.contains("PRIVATE KEY-----") {
                in_key = true;
                result.push_str("-----私钥已隐藏-----\n");
                count += 1;
                continue;
            }
            if line.contains("-----END") && line.contains("PRIVATE KEY-----") {
                in_key = false;
                continue;
            }
            if !in_key {
                result.push_str(line);
                result.push('\n');
            }
        }
        out = result.trim_end().to_owned();
    }

    // 2. `KEY=value` 形态：仅当 KEY 名敏感时掩码值
    out = mask_assignments(&out, &mut count);

    // 3. 已知 token 前缀
    for (prefix, replacement) in TOKEN_PREFIXES {
        out = mask_prefixed_token(&out, prefix, replacement, &mut count);
    }

    // 4. JWT 形态（三段 base64url）
    out = mask_jwt(&out, &mut count);

    // 5. 敏感旗标后的参数
    for flag in SENSITIVE_FLAGS {
        out = mask_after_flag(&out, flag, &mut count);
    }

    Redaction { text: out, masked_count: count }
}

/// `KEY=value`：KEY 名敏感时掩码值。
fn mask_assignments(input: &str, count: &mut usize) -> String {
    let mut out = String::with_capacity(input.len());
    for (i, token) in input.split_inclusive(char::is_whitespace).enumerate() {
        let _ = i;
        let trimmed = token.trim_end();
        let trailing: String = token[trimmed.len()..].to_owned();

        if let Some((key, _value)) = trimmed.split_once('=') {
            // 跳过形如 `--flag=value` 的键名前缀
            let bare_key = key.trim_start_matches('-');
            if !bare_key.is_empty()
                && is_sensitive_key(bare_key)
                && !bare_key.contains('/')
                && bare_key.len() <= 64
            {
                out.push_str(key);
                out.push_str("=***");
                out.push_str(&trailing);
                *count += 1;
                continue;
            }
        }
        out.push_str(token);
    }
    out
}

/// 已知前缀 token：`sk-xxx` → `sk-***`。
fn mask_prefixed_token(input: &str, prefix: &str, replacement: &str, count: &mut usize) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(pos) = rest.find(prefix) {
        // 前缀边界：前一个字符不是字母数字（避免匹配到单词中间）
        let boundary_ok = pos == 0
            || !rest[..pos]
                .chars()
                .last()
                .map(|c| c.is_alphanumeric())
                .unwrap_or(false);
        out.push_str(&rest[..pos]);
        if !boundary_ok {
            out.push_str(prefix);
            rest = &rest[pos + prefix.len()..];
            continue;
        }
        out.push_str(replacement);
        // 跳过 token 本体
        let after = &rest[pos + prefix.len()..];
        let end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .unwrap_or(after.len());
        rest = &after[end..];
        *count += 1;
    }
    out.push_str(rest);
    out
}

/// JWT：`eyJ...` 三段。
fn mask_jwt(input: &str, count: &mut usize) -> String {
    let mut out = String::with_capacity(input.len());
    for token in input.split_inclusive(char::is_whitespace) {
        let trimmed = token.trim_end();
        let trailing = &token[trimmed.len()..];
        if trimmed.starts_with("eyJ") && trimmed.matches('.').count() >= 2 {
            out.push_str("jwt_***");
            out.push_str(trailing);
            *count += 1;
        } else {
            out.push_str(token);
        }
    }
    out
}

/// 敏感旗标后的参数：`--password hunter2` → `--password ***`。
fn mask_after_flag(input: &str, flag: &str, count: &mut usize) -> String {
    let tokens: Vec<&str> = input.split_whitespace().collect();
    let mut out: Vec<String> = Vec::with_capacity(tokens.len());
    let mut skip_next = false;

    for token in tokens {
        if skip_next {
            out.push("***".to_owned());
            *count += 1;
            skip_next = false;
            continue;
        }
        // `-p=value` / `--password=value` 形态
        if let Some((k, v)) = token.split_once('=') {
            if k.eq_ignore_ascii_case(flag) && !v.is_empty() {
                out.push(format!("{k}=***"));
                *count += 1;
                continue;
            }
        }
        if token.eq_ignore_ascii_case(flag) {
            out.push(token.to_owned());
            skip_next = true;
            continue;
        }
        out.push(token.to_owned());
    }

    if skip_next {
        // 旗标在末尾，无值可掩码，不算命中
    }
    out.join(" ")
}

/// 判断文本中是否仍可能含敏感值（用于测试与自检）。
pub fn may_contain_secret(text: &str) -> bool {
    let r = redact(text);
    !r.is_clean()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_env_style_secrets() {
        let r = redact("export OPENAI_API_KEY=sk-abcdef123456 && npm test");
        assert!(r.masked_count >= 1, "未掩码: {}", r.text);
        assert!(!r.text.contains("sk-abcdef123456"), "密钥仍存在: {}", r.text);
        assert!(r.text.contains("OPENAI_API_KEY=***"), "结构应保留: {}", r.text);
        // 非敏感部分不受影响
        assert!(r.text.contains("npm test"));
    }

    #[test]
    fn masks_various_token_prefixes() {
        for (input, leaked) in [
            ("curl -H 'Authorization: Bearer ghp_1234567890abcdef'", "ghp_1234567890abcdef"),
            ("git clone https://xoxb-1234567890-secret@github.com/a/b", "xoxb-1234567890-secret"),
            ("aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"),
            ("npm publish --token npm_abcdefghijklmnop", "npm_abcdefghijklmnop"),
        ] {
            let r = redact(input);
            assert!(!r.text.contains(leaked), "`{input}` 未掩码：{}", r.text);
        }
    }

    #[test]
    fn masks_jwt() {
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        let r = redact(&format!("curl -H 'auth: {jwt}' https://api.example.com"));
        assert!(!r.text.contains(jwt), "JWT 未掩码: {}", r.text);
        assert!(r.text.contains("jwt_***"));
    }

    #[test]
    fn masks_private_key_block() {
        let text = "cat <<EOF > key.pem\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nverysecret\n-----END RSA PRIVATE KEY-----\nEOF";
        let r = redact(text);
        assert!(!r.text.contains("MIIEowIBAAKCAQEA"), "私钥内容未隐藏: {}", r.text);
        assert!(!r.text.contains("verysecret"));
        assert!(r.text.contains("私钥已隐藏"));
    }

    #[test]
    fn masks_flag_arguments() {
        let r = redact("mysql -u root --password hunter2 -h db");
        assert!(!r.text.contains("hunter2"), "密码未掩码: {}", r.text);
        assert!(r.text.contains("--password ***"));

        let r2 = redact("mysql --password=hunter2 -h db");
        assert!(!r2.text.contains("hunter2"), "`=` 形态未掩码: {}", r2.text);
    }

    #[test]
    fn preserves_non_sensitive_content() {
        // 普通命令不应被改动——过度掩码会损害审计可用性
        for cmd in [
            "npm test",
            "cargo build --release",
            "git commit -m 'fix login bug'",
            "echo hello world",
            "ls -la src/",
        ] {
            let r = redact(cmd);
            assert_eq!(r.text, cmd, "普通命令被误改: {}", r.text);
            assert_eq!(r.masked_count, 0, "普通命令被误报: {}", r.text);
        }
    }

    #[test]
    fn does_not_mask_lookalike_words() {
        // TOKEN 作为词的一部分但不构成敏感键名时不该触发
        let r = redact("echo 'tokenizer ready'");
        assert_eq!(r.masked_count, 0, "误报: {}", r.text);
    }

    #[test]
    fn redaction_is_idempotent() {
        let once = redact("export API_KEY=sk-abc123456 && ls");
        let twice = redact(&once.text);
        assert_eq!(once.text, twice.text, "二次脱敏不应继续改动");
    }

    #[test]
    fn sensitive_key_detection() {
        for k in ["OPENAI_API_KEY", "AWS_SECRET_ACCESS_KEY", "DB_PASSWORD", "GITHUB_TOKEN", "MY_PWD"] {
            assert!(is_sensitive_key(k), "`{k}` 应判为敏感");
        }
        for k in ["PATH", "HOME", "LANG", "NODE_ENV", "USER"] {
            assert!(!is_sensitive_key(k), "`{k}` 不该判为敏感");
        }
    }

    #[test]
    fn detects_remaining_secrets() {
        assert!(may_contain_secret("export TOKEN=sk-abcdef123456"));
        assert!(!may_contain_secret("npm run build"));
    }
}
