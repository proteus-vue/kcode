//! 工作区内的文件读取。
//!
//! # 为什么单独成模块
//!
//! 这是**安全边界**：右栏的用途是「看会话里提到的那个文件」，
//! 不是通用文件浏览器。放开任意路径等于给前端一个任意文件读取面，
//! 而前端展示的内容最终可能来自模型输出。
//!
//! 边界逻辑单独成函数是为了能直接测：路径校验的错误（比如忘记
//! canonicalize）不会报错，只会安静地放行 `../../etc/passwd`。

use std::path::{Path, PathBuf};

/// 解析并校验一个待读取的路径，确保它位于工作区内。
///
/// `requested` 为绝对路径时直接用它，相对路径按工作区拼接。
///
/// **必须先 canonicalize 再比较前缀**：
/// - 不规范化的话，`工作区/../../etc/passwd` 字面上以工作区开头；
/// - 符号链接（工作区内的链接指向外部）也只有在解析后才暴露。
///
/// 返回规范化后的绝对路径与工作区相对路径。
pub fn resolve_in_workspace(workspace: &Path, requested: &str) -> Result<(PathBuf, String), String> {
    let req = Path::new(requested);
    let candidate = if req.is_absolute() {
        req.to_path_buf()
    } else {
        workspace.join(req)
    };

    let resolved = candidate
        .canonicalize()
        .map_err(|e| format!("无法解析路径 {requested}: {e}"))?;
    let ws = workspace
        .canonicalize()
        .map_err(|e| format!("工作区无法解析: {e}"))?;

    if !resolved.starts_with(&ws) {
        return Err(format!("拒绝读取工作区外的文件：{requested}"));
    }

    let rel = resolved
        .strip_prefix(&ws)
        .unwrap_or(&resolved)
        .to_string_lossy()
        .into_owned();
    Ok((resolved, rel))
}

/// 解析一个**可能尚不存在**的工作区内路径。
///
/// 用途与 `resolve_in_workspace` 不同：审阅面板里的文件有两种「不在磁盘上」
/// 的合法情况——本轮变更还没写入工作区（`proposed`），或它刚被 Agent 删掉。
/// 这两种情况下 `resolve_in_workspace` 会在 canonicalize 处直接失败，
/// 报出一句和用户操作无关的「No such file or directory」。
///
/// 做法：文件本身存在时按常规解析；不存在时**规范化其父目录**再拼上文件名。
/// 父目录必须真实存在且位于工作区内——所以 `../..`、指向外部的符号链接
/// 依旧被挡住，安全性不降级。
///
/// 返回的是**仓库内相对路径**（供 git 使用），以及规范化后的绝对路径。
pub fn resolve_in_workspace_allow_missing(
    workspace: &Path,
    requested: &str,
) -> Result<(PathBuf, String), String> {
    if requested.trim().is_empty() {
        return Err("路径不能为空".to_owned());
    }
    let req = Path::new(requested);
    let candidate = if req.is_absolute() {
        req.to_path_buf()
    } else {
        workspace.join(req)
    };

    let ws = workspace
        .canonicalize()
        .map_err(|e| format!("工作区无法解析: {e}"))?;

    // 文件已存在：与 resolve_in_workspace 一致（顺带解掉符号链接）
    let resolved = match candidate.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            let file_name = candidate
                .file_name()
                .ok_or_else(|| format!("路径不合法：{requested}"))?;
            let parent = candidate
                .parent()
                .ok_or_else(|| format!("路径不合法：{requested}"))?;
            let parent = parent
                .canonicalize()
                .map_err(|_| format!("路径不存在：{requested}"))?;
            parent.join(file_name)
        }
    };

    if !resolved.starts_with(&ws) {
        return Err(format!("拒绝访问工作区外的路径：{requested}"));
    }

    let rel = resolved
        .strip_prefix(&ws)
        .map_err(|_| format!("路径不位于工作区内：{requested}"))?
        .to_string_lossy()
        .into_owned();
    // 空相对路径 = 指向工作区根。它不是「一个文件」，
    // 放过去会让 git 拿到仓库根、让编辑器打开整个目录。
    if rel.is_empty() {
        return Err(format!("路径指向目录而非文件：{requested}"));
    }
    Ok((resolved, rel))
}

/// 按扩展名判定图片 MIME。只认这几种，不做内容嗅探——
/// 嗅探要读文件头，而这里的目标只是决定怎么展示。
pub fn image_mime(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => Some("image/png"),
        Some("jpg") | Some("jpeg") => Some("image/jpeg"),
        Some("gif") => Some("image/gif"),
        Some("webp") => Some("image/webp"),
        Some("svg") => Some("image/svg+xml"),
        Some("bmp") => Some("image/bmp"),
        Some("ico") => Some("image/x-icon"),
        _ => None,
    }
}

/// 读出来的内容形态。决定右栏怎么呈现。
#[derive(Debug, PartialEq)]
pub enum Loaded {
    /// 文本内容。
    Text(String),
    /// 图片的 data URL。
    Image(String),
    /// 二进制且非图片，不带内容。
    Binary,
    /// 超过上限，未加载内容（附说明）。
    TooLarge(String),
}

/// 文本上限：512 KB。
pub const MAX_TEXT_BYTES: u64 = 512 * 1024;
/// 图片上限：8 MB。
pub const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

/// 按已校验的路径加载内容。
///
/// 与 `resolve_in_workspace` 分开：这里假定调用方已经做过边界校验，
/// 因此可以单独测试「怎么呈现」这件事，不必每次都建临时工作区。
///
/// 二进制判定用「能否按 UTF-8 解码」而不是「是否含 NUL」：
/// 后者要额外读一遍内容，而对本次的用途（决定展示为文本还是二进制）
/// 而言，能不能解码已经是准确的判据。
pub fn load_content(resolved: &Path, size: u64) -> Result<Loaded, String> {
    if let Some(mime) = image_mime(resolved) {
        if size > MAX_IMAGE_BYTES {
            return Ok(Loaded::TooLarge(format!(
                "图片 {:.1} MB，超过 {} MB 上限，未加载",
                size as f64 / 1_048_576.0,
                MAX_IMAGE_BYTES / 1_048_576
            )));
        }
        let bytes = std::fs::read(resolved).map_err(|e| format!("读取图片失败: {e}"))?;
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(Loaded::Image(format!("data:{mime};base64,{b64}")));
    }

    if size > MAX_TEXT_BYTES {
        return Ok(Loaded::TooLarge(format!(
            "文件 {:.1} KB，超过 {} KB 上限，未加载内容",
            size as f64 / 1024.0,
            MAX_TEXT_BYTES / 1024
        )));
    }

    let bytes = std::fs::read(resolved).map_err(|e| format!("读取文件失败: {e}"))?;
    match String::from_utf8(bytes) {
        Ok(text) => Ok(Loaded::Text(text)),
        Err(_) => Ok(Loaded::Binary),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 建一个临时工作区，返回 (工作区路径, 清理器)。
    ///
    /// **每个调用必须拿到独立目录**。早先只用进程 id 做区分，于是同一
    /// 进程内的测试共用一份 fixture，而 Rust 默认并行跑测试——
    /// 一个测试正在写 `src/app.ts`，另一个正在读它，结果是随机失败
    /// （表现为 `loads_text_file` 偶尔读不到预期内容）。
    /// 这类「大多数时候通过」的测试比失败更糟：它训练人忽略红灯。
    fn workspace() -> (PathBuf, PathBuf) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        let n = SEQ.fetch_add(1, Ordering::SeqCst);
        let base = std::env::temp_dir().join(format!("kcode-fa-{}-{}", std::process::id(), n));
        // 清掉可能残留的同名目录（进程号会被复用）
        let _ = fs::remove_dir_all(&base);
        let ws = base.join("ws");
        let outside = base.join("outside");
        fs::create_dir_all(ws.join("src")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(ws.join("src/app.ts"), "const a = 1;").unwrap();
        fs::write(outside.join("secret.txt"), "SECRET").unwrap();
        (ws, base)
    }

    #[test]
    fn allows_file_inside_workspace() {
        let (ws, _base) = workspace();
        let (resolved, rel) = resolve_in_workspace(&ws, "src/app.ts").unwrap();
        assert!(resolved.starts_with(ws.canonicalize().unwrap()));
        assert_eq!(rel, "src/app.ts");
    }

    // ── allow_missing：审阅面板要看「还没写盘 / 已被删除」的文件 ──────

    #[test]
    fn allow_missing_resolves_existing_file() {
        let (ws, _base) = workspace();
        let (resolved, rel) = resolve_in_workspace_allow_missing(&ws, "src/app.ts").unwrap();
        assert_eq!(rel, "src/app.ts");
        assert!(resolved.is_file());
    }

    #[test]
    fn allow_missing_resolves_absent_file() {
        let (ws, _base) = workspace();
        // 本轮变更还没落盘：文件不存在，但路径合法，必须能解析出来
        let (resolved, rel) =
            resolve_in_workspace_allow_missing(&ws, "src/not-yet-written.ts").unwrap();
        assert_eq!(rel, "src/not-yet-written.ts");
        assert!(!resolved.exists(), "不应凭空造出文件");
        assert!(resolved.starts_with(ws.canonicalize().unwrap()));
    }

    #[test]
    fn allow_missing_still_rejects_escape() {
        let (ws, base) = workspace();
        // **关键**：放宽「文件必须存在」不能顺带放宽边界——
        // 这些路径的目标文件都不存在，正是最容易漏掉的攻击面。
        let outside = base.join("outside/deleted.txt");
        for bad in [
            outside.to_str().unwrap(),
            ws.join("src/../../outside/deleted.txt").to_str().unwrap(),
            "../../etc/passwd-not-here",
            "src/../../../../etc/nothing",
        ] {
            let err = resolve_in_workspace_allow_missing(&ws, bad).unwrap_err();
            assert!(
                err.contains("工作区外") || err.contains("不存在") || err.contains("不合法"),
                "{bad} 应被拒绝，实际：{err}"
            );
        }
    }

    #[test]
    fn allow_missing_rejects_symlink_escape() {
        let (ws, base) = workspace();
        let link = ws.join("src/link-missing.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(base.join("outside/secret.txt"), &link).unwrap();
        let err = resolve_in_workspace_allow_missing(&ws, "src/link-missing.txt").unwrap_err();
        assert!(err.contains("工作区外"), "符号链接逃逸仍须拒绝：{err}");
    }

    #[test]
    fn allow_missing_rejects_empty_and_root() {
        let (ws, _base) = workspace();
        assert!(resolve_in_workspace_allow_missing(&ws, "  ").is_err());
        // 工作区根本身不是可撤销/可打开的文件
        assert!(resolve_in_workspace_allow_missing(&ws, ".").is_err());
    }

    #[test]
    fn allows_absolute_path_inside_workspace() {
        let (ws, _base) = workspace();
        let abs = ws.join("src/app.ts");
        let (_, rel) = resolve_in_workspace(&ws, abs.to_str().unwrap()).unwrap();
        assert_eq!(rel, "src/app.ts");
    }

    #[test]
    fn rejects_parent_traversal() {
        let (ws, _base) = workspace();
        // 字面上以工作区开头，只有 canonicalize 之后才看得出是外部文件
        let attack = ws.join("src/../../outside/secret.txt");
        let err = resolve_in_workspace(&ws, attack.to_str().unwrap()).unwrap_err();
        assert!(err.contains("工作区外"), "实际错误：{err}");
    }

    #[test]
    fn rejects_relative_traversal() {
        let (ws, _base) = workspace();
        let err = resolve_in_workspace(&ws, "../../etc/passwd").unwrap_err();
        // 目标是解析失败或越界，二者都算拒绝——关键是不能读到内容
        assert!(err.contains("工作区外") || err.contains("无法解析"), "实际错误：{err}");
    }

    #[test]
    fn rejects_absolute_path_outside_workspace() {
        let (ws, _base) = workspace();
        let err = resolve_in_workspace(&ws, "/etc/passwd").unwrap_err();
        assert!(err.contains("工作区外"), "实际错误：{err}");
    }

    #[test]
    fn rejects_symlink_escaping_workspace() {
        let (ws, base) = workspace();
        let link = ws.join("src/link.txt");
        #[cfg(unix)]
        std::os::unix::fs::symlink(base.join("outside/secret.txt"), &link).unwrap();
        // 链接在工作区内，但指向外部——必须拒绝
        let err = resolve_in_workspace(&ws, "src/link.txt").unwrap_err();
        assert!(err.contains("工作区外"), "实际错误：{err}");
    }

    #[test]
    fn rejects_nonexistent_file() {
        let (ws, _base) = workspace();
        let err = resolve_in_workspace(&ws, "src/nope.ts").unwrap_err();
        assert!(err.contains("无法解析"), "实际错误：{err}");
    }

    #[test]
    fn reads_a_real_file_from_this_repo() {
        // 用仓库自身的文件验证成功路径——纯临时目录测试可能掩盖
        // 「工作区路径本身含符号链接」这类真实情况
        // （macOS 上 /tmp 就是指向 /private/tmp 的链接）。
        let repo = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        let (resolved, rel) = resolve_in_workspace(&repo, "Cargo.toml").unwrap();
        assert!(resolved.exists());
        assert_eq!(rel, "Cargo.toml");
        let content = fs::read_to_string(&resolved).unwrap();
        assert!(content.contains("[workspace]"), "读到的不是仓库根 Cargo.toml");
    }

    #[test]
    fn workspace_path_through_symlink_still_works() {
        // macOS 的 /tmp -> /private/tmp：工作区若以 /tmp 形式给出，
        // canonicalize 之后会变成 /private/tmp，两侧都必须能对上，
        // 否则正常文件也会被拒。
        let (ws, base) = workspace();
        let via_link = ws.clone();
        let (resolved, _rel) = resolve_in_workspace(&via_link, "src/app.ts").unwrap();
        assert!(resolved.ends_with("src/app.ts"));
        let _ = base;
    }

    #[test]
    fn loads_text_file() {
        let (ws, _base) = workspace();
        let (resolved, _) = resolve_in_workspace(&ws, "src/app.ts").unwrap();
        let size = fs::metadata(&resolved).unwrap().len();
        match load_content(&resolved, size).unwrap() {
            Loaded::Text(t) => assert!(t.contains("const a = 1")),
            other => panic!("期望 Text，实际 {other:?}"),
        }
    }

    #[test]
    fn loads_image_as_data_url() {
        let (ws, _base) = workspace();
        // 1x1 PNG
        let png: &[u8] = &[
            0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,
            0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x06,0x00,0x00,0x00,0x1F,0x15,0xC4,
            0x89,0x00,0x00,0x00,0x0A,0x49,0x44,0x41,0x54,0x78,0x9C,0x63,0x00,0x01,0x00,0x00,
            0x05,0x00,0x01,0x0D,0x0A,0x2D,0xB4,0x00,0x00,0x00,0x00,0x49,0x45,0x4E,0x44,0xAE,
            0x42,0x60,0x82,
        ];
        let img = ws.join("src/dot.png");
        fs::write(&img, png).unwrap();
        let (resolved, _) = resolve_in_workspace(&ws, "src/dot.png").unwrap();
        let size = fs::metadata(&resolved).unwrap().len();
        match load_content(&resolved, size).unwrap() {
            Loaded::Image(url) => {
                assert!(url.starts_with("data:image/png;base64,"), "实际 {url}");
            }
            other => panic!("期望 Image，实际 {other:?}"),
        }
    }

    #[test]
    fn binary_file_is_not_shown_as_text() {
        let (ws, _base) = workspace();
        // 含非法 UTF-8 字节的文件
        fs::write(ws.join("src/blob.bin"), [0xFF, 0xFE, 0x00, 0x01, 0x80]).unwrap();
        let (resolved, _) = resolve_in_workspace(&ws, "src/blob.bin").unwrap();
        let size = fs::metadata(&resolved).unwrap().len();
        assert_eq!(load_content(&resolved, size).unwrap(), Loaded::Binary);
    }

    #[test]
    fn oversize_text_is_not_silently_truncated() {
        let (ws, _base) = workspace();
        let (resolved, _) = resolve_in_workspace(&ws, "src/app.ts").unwrap();
        // 声明一个超过上限的尺寸
        match load_content(&resolved, MAX_TEXT_BYTES + 1).unwrap() {
            Loaded::TooLarge(msg) => assert!(msg.contains("上限"), "实际 {msg}"),
            other => panic!("期望 TooLarge，实际 {other:?}"),
        }
    }

    #[test]
    fn oversize_image_is_not_loaded() {
        let (ws, _base) = workspace();
        let img = ws.join("src/big.png");
        fs::write(&img, b"fake").unwrap();
        let (resolved, _) = resolve_in_workspace(&ws, "src/big.png").unwrap();
        match load_content(&resolved, MAX_IMAGE_BYTES + 1).unwrap() {
            Loaded::TooLarge(msg) => assert!(msg.contains("MB"), "实际 {msg}"),
            other => panic!("期望 TooLarge，实际 {other:?}"),
        }
    }

    #[test]
    fn detects_image_extensions_case_insensitively() {
        assert_eq!(image_mime(Path::new("a.PNG")), Some("image/png"));
        assert_eq!(image_mime(Path::new("a.Jpeg")), Some("image/jpeg"));
        assert_eq!(image_mime(Path::new("a.webp")), Some("image/webp"));
        assert_eq!(image_mime(Path::new("a.txt")), None);
        assert_eq!(image_mime(Path::new("noext")), None);
        // 伪装成图片的可执行文件不应被当图片（这里只看扩展名，
        // 但至少不会把 .sh 认成图片）
        assert_eq!(image_mime(Path::new("evil.sh")), None);
    }
}
