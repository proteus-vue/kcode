//! codex 二进制定位与完整性校验。
//!
//! app-server 是**外部进程依赖**，其版本与哈希必须显式锁定，否则「可复现构建」
//! 无从谈起。安全下限 `0.39.0` 对应 CVE-2025-59532：低于该版本会因沙箱路径配置
//! 缺陷，把模型生成的 `cwd` 当作可写根，突破工作区边界。

use crate::error::{BridgeError, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// 安全下限：CVE-2025-59532 / GHSA-w5fx-fh39-j5rw 的修复版本。
pub const SECURITY_BASELINE: &str = "0.39.0";

/// `codex.lock.json` 的内容。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockRecord {
    pub version: String,
    pub sha256: String,
    #[serde(default)]
    pub security_baseline: Option<String>,
}

impl LockRecord {
    pub fn load(path: &Path) -> Result<Self> {
        let raw = std::fs::read_to_string(path)?;
        Ok(serde_json::from_str(&raw)?)
    }

    /// 校验二进制相对本锁定记录是否完整、且不低于安全下限。
    ///
    /// 返回解析到的实际版本号。
    pub fn verify_binary(&self, binary: &Path) -> Result<String> {
        let actual = sha256_file(binary)?;
        if !actual.eq_ignore_ascii_case(&self.sha256) {
            return Err(BridgeError::InvalidConfig(format!(
                "codex 二进制哈希与锁定记录不一致\n  锁定: {}\n  实际: {actual}\n\
                 若为有意升级，请复核版本后运行: bash scripts/verify-codex-version.sh --record",
                self.sha256
            )));
        }
        let baseline = self.security_baseline.as_deref().unwrap_or(SECURITY_BASELINE);
        if !version_gte(&self.version, baseline) {
            return Err(BridgeError::InvalidConfig(format!(
                "codex {} 低于安全下限 {baseline}（CVE-2025-59532 未修复）",
                self.version
            )));
        }
        Ok(self.version.clone())
    }
}

/// 计算文件 SHA256。
pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher)?;
    Ok(hex::encode(hasher.finalize()))
}

/// 定位 codex 二进制。
///
/// # 查找顺序
///
/// 1. **应用资源目录**（`resource_dir/binaries/codex`）——打包后的正式路径。
///    由 `scripts/stage-codex-binary.sh` 暂存、Tauri `bundle.resources` 打进 app。
/// 2. **npm 的 node_modules**——开发期路径。
///
/// 为什么必须先查资源目录：打包成 .app 后 `node_modules` 不存在，
/// 只查后者会让发布版启动失败（早先只能靠 `KCODE_REPO_ROOT` 环境变量
/// 指向仓库才能跑，那不是可发布的形态）。
pub fn locate_binary_in(resource_dir: Option<&Path>, repo_root: &Path) -> Result<PathBuf> {
    if let Some(res) = resource_dir {
        let staged = res.join("binaries").join("codex");
        if staged.is_file() {
            return Ok(staged);
        }
    }
    locate_binary(repo_root)
}

/// 按 npm 平台子包的目录约定定位 codex 二进制（开发期路径）。
///
/// 与 `scripts/verify-codex-version.sh` 的候选列表保持一致——两处都改了才算升级适配。
pub fn locate_binary(repo_root: &Path) -> Result<PathBuf> {
    // (平台包名, vendor 三平台目录)
    const CANDIDATES: &[(&str, &str)] = &[
        ("@openai/codex-darwin-arm64", "aarch64-apple-darwin"),
        ("@openai/codex-darwin-x64", "x86_64-apple-darwin"),
        ("@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"),
        ("@openai/codex-linux-x64", "x86_64-unknown-linux-musl"),
        ("@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"),
        ("@openai/codex-win32-x64", "x86_64-pc-windows-msvc"),
    ];

    for (pkg, vendor) in CANDIDATES {
        let name = if cfg!(windows) { "codex.exe" } else { "codex" };
        let path = repo_root
            .join("node_modules")
            .join(pkg)
            .join("vendor")
            .join(vendor)
            .join("bin")
            .join(name);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(BridgeError::InvalidConfig(format!(
        "在 {} 下未找到 codex 二进制，请先运行 npm install",
        repo_root.display()
    )))
}

/// 点分版本号比较：`a >= b`。
///
/// 逐段数值比较，避免字典序陷阱（`"0.9.0" < "0.39.0"`）。
pub fn version_gte(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.split('-')
            .next()
            .unwrap_or(s)
            .split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (av, bv) = (parse(a), parse(b));
    for i in 0..av.len().max(bv.len()) {
        let x = av.get(i).copied().unwrap_or(0);
        let y = bv.get(i).copied().unwrap_or(0);
        if x != y {
            return x > y;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn version_comparison_is_numeric_not_lexicographic() {
        assert!(version_gte("0.39.0", "0.39.0"));
        assert!(version_gte("0.155.1", "0.39.0"));
        assert!(!version_gte("0.38.0", "0.39.0"));
        // 字典序会把 "0.9.0" 判为大于 "0.39.0"，数值比较不会
        assert!(!version_gte("0.9.0", "0.39.0"));
        assert!(version_gte("1.0.0", "0.39.0"));
        assert!(version_gte("0.39.1-beta.2", "0.39.0"));
    }

    #[test]
    fn detects_hash_mismatch() {
        let dir = tempdir().unwrap();
        let bin = dir.path().join("codex");
        std::fs::write(&bin, b"fake binary").unwrap();

        let lock = LockRecord {
            version: "0.155.1".into(),
            sha256: "0".repeat(64),
            security_baseline: Some(SECURITY_BASELINE.into()),
        };
        let err = lock.verify_binary(&bin).unwrap_err().to_string();
        assert!(err.contains("哈希与锁定记录不一致"), "{err}");
    }

    #[test]
    fn accepts_matching_hash() {
        let dir = tempdir().unwrap();
        let bin = dir.path().join("codex");
        std::fs::write(&bin, b"fake binary").unwrap();

        let lock = LockRecord {
            version: "0.155.1".into(),
            sha256: sha256_file(&bin).unwrap(),
            security_baseline: None,
        };
        assert_eq!(lock.verify_binary(&bin).unwrap(), "0.155.1");
    }

    #[test]
    fn rejects_version_below_security_baseline() {
        let dir = tempdir().unwrap();
        let bin = dir.path().join("codex");
        std::fs::write(&bin, b"old").unwrap();

        let lock = LockRecord {
            version: "0.38.0".into(),
            sha256: sha256_file(&bin).unwrap(),
            security_baseline: Some(SECURITY_BASELINE.into()),
        };
        let err = lock.verify_binary(&bin).unwrap_err().to_string();
        assert!(err.contains("低于安全下限"), "{err}");
        assert!(err.contains("CVE-2025-59532"), "{err}");
    }

    #[test]
    fn prefers_staged_binary_in_resource_dir() {
        // 打包版的路径优先：资源目录里有就直接用，
        // 即使 node_modules 不存在（发布环境）也能找到。
        let res = tempdir().unwrap();
        let staged_dir = res.path().join("binaries");
        std::fs::create_dir_all(&staged_dir).unwrap();
        let staged = staged_dir.join("codex");
        std::fs::write(&staged, b"staged").unwrap();

        let empty_repo = tempdir().unwrap();
        let got = locate_binary_in(Some(res.path()), empty_repo.path()).unwrap();
        assert_eq!(got, staged, "应优先使用资源目录里的暂存二进制");
    }

    #[test]
    fn falls_back_to_node_modules_when_no_staged_binary() {
        // 开发期：资源目录不存在时回退到 node_modules
        let res = tempdir().unwrap();          // 空资源目录
        let repo = tempdir().unwrap();
        let pkg = repo.path().join("node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin");
        std::fs::create_dir_all(&pkg).unwrap();
        let bin = pkg.join("codex");
        std::fs::write(&bin, b"dev").unwrap();

        let got = locate_binary_in(Some(res.path()), repo.path()).unwrap();
        assert_eq!(got, bin, "无暂存时应回退到 node_modules");
    }

    #[test]
    fn resource_dir_absent_still_works() {
        let repo = tempdir().unwrap();
        let pkg = repo.path().join("node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("codex"), b"dev").unwrap();
        assert!(locate_binary_in(None, repo.path()).is_ok());
    }

    #[test]
    fn locate_binary_reports_missing_install() {
        let dir = tempdir().unwrap();
        let err = locate_binary(dir.path()).unwrap_err().to_string();
        assert!(err.contains("未找到 codex 二进制"), "{err}");
    }
}
