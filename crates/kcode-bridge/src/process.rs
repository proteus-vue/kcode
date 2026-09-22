//! 子进程生命周期与启动配置。

use crate::error::{BridgeError, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// 回环地址不该交给代理——它们只可能在本机内部解决。
///
/// 实测（macOS + 系统代理）：codex 的 HTTP 客户端**使用系统代理，但不读系统代理
/// 设置里的例外列表**。于是发往本地 provider 的请求会被交给代理并返回
/// `502 Bad Gateway`，本地模型（mock / Ollama / LM Studio 等）完全收不到流量。
/// 表现是「协议契约测试莫名失败」，而 mock provider 的请求计数为 0。
///
/// 详见 `docs/协议勘误与修正.md` §3.21。
pub const LOOPBACK_HOSTS: [&str; 3] = ["127.0.0.1", "localhost", "::1"];

/// 把回环地址并入一份既有的 `NO_PROXY` 值（逗号分隔）。
///
/// 保留用户已有条目、去重、幂等。只影响「本机 → 本机」的流量，
/// 不会让任何真实出站绕开代理。
pub fn merge_loopback_no_proxy(existing: Option<&str>) -> String {
    let mut entries: Vec<String> = Vec::new();
    for raw in existing.unwrap_or("").split(',') {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !entries.iter().any(|e| e.eq_ignore_ascii_case(trimmed)) {
            entries.push(trimmed.to_owned());
        }
    }
    for host in LOOPBACK_HOSTS {
        if !entries.iter().any(|e| e.eq_ignore_ascii_case(host)) {
            entries.push(host.to_owned());
        }
    }
    entries.join(",")
}

/// 启动 `codex app-server` 所需的全部参数。
///
/// **`codex_home` 是安全属性，不只是路径配置**：它决定 app-server 读取哪一份
/// `config.toml`。指向独立目录可保证 Agent 不会继承用户全局配置中的宽松策略。
/// 启动后必须校验 `initialize` 回传的 `codexHome` 等于这里的值（见 [`crate::transport::JsonlTransport::initialize`]）。
#[derive(Debug, Clone)]
pub struct SpawnConfig {
    /// 锁定的 codex 二进制绝对路径。
    pub binary: PathBuf,
    /// 子进程工作目录（项目工作区或其 worktree）。
    pub cwd: PathBuf,
    /// 隔离的 CODEX_HOME。绝不能是用户真实的 `~/.codex`。
    pub codex_home: PathBuf,
    /// 追加的环境变量（模型 provider 凭据等）。不会继承到日志。
    pub extra_env: HashMap<String, String>,
}

impl SpawnConfig {
    pub fn new(binary: impl Into<PathBuf>, cwd: impl Into<PathBuf>, codex_home: impl Into<PathBuf>) -> Self {
        Self {
            binary: binary.into(),
            cwd: cwd.into(),
            codex_home: codex_home.into(),
            extra_env: HashMap::new(),
        }
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.extra_env.insert(key.into(), value.into());
        self
    }

    /// 传给子进程的追加环境：`extra_env` + 回环绕行代理。
    ///
    /// 大小写两份都设置：不同 HTTP 客户端读的键不同（reqwest 两者都认）。
    /// 注意 **显式设置会覆盖继承值**，所以父进程既有的 `NO_PROXY` 必须先读出来
    /// 再合并——否则「为了修本地 provider」反而会把用户原有的代理例外抹掉。
    pub fn child_env(&self) -> Vec<(String, String)> {
        let mut env = self.extra_env.clone();
        let inherited = env
            .get("NO_PROXY")
            .or_else(|| env.get("no_proxy"))
            .cloned()
            .or_else(|| std::env::var("NO_PROXY").ok())
            .or_else(|| std::env::var("no_proxy").ok());
        let merged = merge_loopback_no_proxy(inherited.as_deref());
        env.insert("NO_PROXY".to_owned(), merged.clone());
        env.insert("no_proxy".to_owned(), merged);
        // HashMap 迭代顺序不稳定，排序后返回让日志与测试可复现
        let mut pairs: Vec<(String, String)> = env.into_iter().collect();
        pairs.sort();
        pairs
    }

    /// 启动前的静态校验。尽早失败，避免子进程起来后才暴露路径问题。
    pub fn validate(&self) -> Result<()> {
        if !self.binary.is_file() {
            return Err(BridgeError::InvalidConfig(format!(
                "codex 二进制不存在: {}（请先运行 npm install）",
                self.binary.display()
            )));
        }
        if !self.cwd.is_dir() {
            return Err(BridgeError::InvalidConfig(format!(
                "工作目录不存在: {}",
                self.cwd.display()
            )));
        }
        if !self.codex_home.is_dir() {
            return Err(BridgeError::InvalidConfig(format!(
                "CODEX_HOME 不存在: {}（需预先创建并写入 config.toml）",
                self.codex_home.display()
            )));
        }
        if is_user_default_codex_home(&self.codex_home) {
            return Err(BridgeError::InvalidConfig(
                "拒绝以用户真实的 ~/.codex 作为 CODEX_HOME：会继承个人全局策略并污染真实历史。\
                 请为应用或测试指定独立目录。"
                    .to_owned(),
            ));
        }
        Ok(())
    }
}

/// 判断给定路径是否指向用户默认的 Codex 状态目录。
pub fn is_user_default_codex_home(path: &Path) -> bool {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return false;
    };
    let default = home.join(".codex");
    // 用 canonicalize 比较，规避符号链接与 `/private/var` 之类的别名差异。
    match (path.canonicalize(), default.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => path == default,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_missing_binary() {
        let dir = tempdir().unwrap();
        let cfg = SpawnConfig::new(dir.path().join("nope"), dir.path(), dir.path());
        let err = cfg.validate().unwrap_err();
        assert!(err.to_string().contains("二进制不存在"), "{err}");
    }

    #[test]
    fn rejects_missing_cwd() {
        let dir = tempdir().unwrap();
        let bin = dir.path().join("codex");
        std::fs::write(&bin, b"x").unwrap();
        let cfg = SpawnConfig::new(&bin, dir.path().join("gone"), dir.path());
        assert!(cfg.validate().unwrap_err().to_string().contains("工作目录不存在"));
    }

    #[test]
    fn rejects_real_user_codex_home() {
        let dir = tempdir().unwrap();
        let bin = dir.path().join("codex");
        std::fs::write(&bin, b"x").unwrap();

        let Some(home) = std::env::var_os("HOME") else { return };
        let real = PathBuf::from(home).join(".codex");
        if !real.is_dir() {
            return; // 该环境没有真实 ~/.codex，跳过
        }
        let cfg = SpawnConfig::new(&bin, dir.path(), &real);
        let err = cfg.validate().unwrap_err().to_string();
        assert!(err.contains("拒绝以用户真实的"), "{err}");
    }

    #[test]
    fn no_proxy_keeps_user_entries_and_appends_loopback() {
        let merged = merge_loopback_no_proxy(Some("proxy.internal,10.0.0.0/8"));
        assert!(merged.starts_with("proxy.internal,10.0.0.0/8"), "{merged}");
        for host in LOOPBACK_HOSTS {
            assert!(merged.contains(host), "{host} 未并入: {merged}");
        }
    }

    #[test]
    fn no_proxy_merge_is_idempotent() {
        let once = merge_loopback_no_proxy(Some("example.com"));
        let twice = merge_loopback_no_proxy(Some(&once));
        assert_eq!(once, twice, "重复合并不应产生重复条目");
    }

    #[test]
    fn no_proxy_merge_tolerates_spaces_and_empty_entries() {
        let merged = merge_loopback_no_proxy(Some(" a.com , ,,b.com,"));
        assert!(merged.starts_with("a.com,b.com"), "{merged}");
        assert!(!merged.contains(",,"), "空条目应被丢弃: {merged}");
    }

    #[test]
    fn no_proxy_merge_from_nothing_yields_loopback_only() {
        assert_eq!(merge_loopback_no_proxy(None), "127.0.0.1,localhost,::1");
    }

    /// Windows 与部分客户端按不区分大小写比较主机名，重复条目要按此去重
    #[test]
    fn no_proxy_dedupes_case_insensitively() {
        let merged = merge_loopback_no_proxy(Some("LOCALHOST,127.0.0.1"));
        assert_eq!(merged.matches("localhost").count() + merged.matches("LOCALHOST").count(), 1,
            "localhost 出现多次: {merged}");
        assert_eq!(merged.matches("127.0.0.1").count(), 1, "{merged}");
    }

    #[test]
    fn child_env_sets_both_cases_and_keeps_extra_env() {
        let dir = tempdir().unwrap();
        let cfg = SpawnConfig::new(dir.path().join("codex"), dir.path(), dir.path())
            .with_env("OPENAI_API_KEY", "k");
        let env: std::collections::HashMap<_, _> = cfg.child_env().into_iter().collect();
        assert_eq!(env.get("OPENAI_API_KEY").map(String::as_str), Some("k"));
        for key in ["NO_PROXY", "no_proxy"] {
            let value = env.get(key).unwrap_or_else(|| panic!("{key} 缺失"));
            assert!(value.contains("127.0.0.1"), "{key}={value}");
        }
        assert_eq!(env.get("NO_PROXY"), env.get("no_proxy"), "两份取值应一致");
    }

    #[test]
    fn accepts_isolated_home() {
        let dir = tempdir().unwrap();
        let bin = dir.path().join("codex");
        std::fs::write(&bin, b"x").unwrap();
        SpawnConfig::new(bin, dir.path(), dir.path()).validate().unwrap();
    }
}
