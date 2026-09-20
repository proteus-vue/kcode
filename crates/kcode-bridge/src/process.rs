//! 子进程生命周期与启动配置。

use crate::error::{BridgeError, Result};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
    fn accepts_isolated_home() {
        let dir = tempdir().unwrap();
        let bin = dir.path().join("codex");
        std::fs::write(&bin, b"x").unwrap();
        SpawnConfig::new(bin, dir.path(), dir.path()).validate().unwrap();
    }
}
