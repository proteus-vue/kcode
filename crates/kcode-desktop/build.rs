use std::{fs, path::Path};

fn main() {
    ensure_resource_dir();
    tauri_build::build()
}

/// 保证 `binaries/` 存在（内容由 `scripts/stage-codex-binary.sh` 填）。
///
/// # 为什么必须在这里做
///
/// `tauri.conf.json` 的 `bundle.resources` 声明了 `"binaries/"`，而 tauri 的
/// build script **在编译期就校验该路径存在**，缺失时直接失败：
///
/// ```text
/// error: failed to run custom build command for `kcode-desktop`
///   Caused by:
///     resource path `binaries` doesn't exist
/// ```
///
/// 而这个目录**是刻意不入库的**（225MB 的平台二进制，见 .gitignore），
/// 所以任何全新 clone 都编译不过这个 crate——包括 CI 上的 `cargo test
/// -p kcode-desktop`，也包括新贡献者按 README 跑 `cargo test --workspace`。
///
/// 症状的迷惑性在于：**本机开发时它一直存在**（此前跑过一次打包就会留下），
/// 于是「本地全绿、CI 常红」，而错误信息只说「资源路径不存在」，
/// 很容易被读成「环境缺东西」而不是「有一处必填目录没被创建」。
/// 本项目为此连续多轮把失败归因到资源/超时，直到剥掉 ANSI 颜色码后才看见
/// 真正的错误行（见 docs/协议勘误与修正.md §3.32）。
///
/// # 为什么创建空目录是安全的
///
/// 打包路径不受影响，且**有两道现成的防线**（不是靠这里的推断兜着）：
///
/// 1. `tauri.conf.json` 的 `beforeBuildCommand` 先跑 stage 脚本，它找不到
///    平台二进制时**退出码 2 并明确报错**（`✗ 未找到 codex 二进制`），
///    `&&` 链断裂使构建中止；
/// 2. 即便产物还是产生了，`scripts/verify-bundle.sh` 会静态检查
///    `Contents/Resources/binaries/codex` 是否存在，缺失即报错并提示
///    「检查 stage-codex-binary.sh 是否在构建前执行」。
///
/// 也就是说这里补的是**编译前提**，不是把缺失静默吞掉——真正的缺失仍然
/// 响亮地失败，且失败在专门为此写的那道检查上。
///
/// 同理，测试也不依赖真实二进制：`binary.rs` 与 `editor.rs` 的相关用例
/// 一律用临时目录自造文件，从不读这个目录。
fn ensure_resource_dir() {
    // 与 tauri.conf.json 的 bundle.resources 保持同一路径（相对于 crate 根）。
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    if dir.is_dir() {
        return;
    }
    if fs::create_dir_all(&dir).is_ok() {
        println!(
            "cargo:warning=已创建空目录 {}（打包前请跑 scripts/stage-codex-binary.sh 填入二进制）",
            dir.display()
        );
    }
}
