//! 用外部编辑器打开文件（可选跳到指定行）。
//!
//! # 为什么需要它
//!
//! 右栏的「变更审阅」看的是 diff。看完 diff 想改代码时，用户只能自己去
//! 文件树里找那个文件、再手动滚到那一行——这一步跳转是审阅流程的出口，
//! 缺了它审阅就只是「看」。参照客户端同样提供「在编辑器中打开」。
//!
//! # 为什么不能只调 `open`
//!
//! `open -t <file>` 只会用**系统默认**文本编辑器打开，且无法跳行。
//! 而用户的代码编辑器几乎总是 VS Code / Cursor / Zed 这类支持
//! `--goto <file>:<line>` 的工具。所以这里有顺序地探测：
//!
//! 1. 环境变量 `KCODE_EDITOR`（显式覆盖，最优先，用户说了算）；
//! 2. PATH 上的 `code` / `cursor` / `zed` / `subl`；
//! 3. macOS 的 app bundle 内的 CLI（GUI 启动时 PATH 常常拿不到 `code`，
//!    这条是实测出来的：终端里 `code` 存在，但从 Finder 启动的 app
//!    继承的是 launchd 的最小 PATH）；
//! 4. 兜底用系统默认编辑器（`open -t` / `xdg-open`），此时不支持跳行。
//!
//! # 为什么探测与命令拼装是纯函数
//!
//! 「探测」在真实机器上不可控（装什么编辑器因人而异），而**拼错参数
//! 恰恰是静默失败**：编辑器起来了、文件没打开，用户只会以为自己点错了。
//! 把「选哪个」与「怎么拼参数」抽成纯函数后，测试可以覆盖每种编辑器的
//! 参数形状——与本项目处置 `fuzzyFileSearch` 的 snake_case 问题同一思路。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

/// 精选出的编辑器（探测结果）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    /// 展示给用户的名称（「VS Code」「系统默认」…）。
    pub label: String,
    pub program: String,
    style: LineStyle,
}

/// 给 UI 的探测结果：按钮上要写清「会用谁打开」「能不能跳行」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorInfo {
    pub label: String,
    /// 是否支持跳到指定行。不支持时 UI 不该承诺能跳。
    pub supports_line: bool,
    /// 是否来自 `$KCODE_EDITOR`（UI 可据此提示「这是你指定的」）。
    pub from_env: bool,
}

/// 一条可直接执行的启动命令。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorLaunch {
    pub label: String,
    pub program: String,
    pub args: Vec<String>,
}

/// 编辑器支持的行号参数形状。
///
/// 分两类：`--goto file:line`（VS Code 系）与 `file:line`（Zed / Sublime）。
/// 混用不会报错——编辑器会把它当成一个不存在的文件路径——
/// 所以这里是显式枚举而不是字符串拼接。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineStyle {
    /// `code --goto <path>:<line>`
    GotoFlag,
    /// `zed <path>:<line>`
    PathSuffix,
    /// 不支持跳行（系统默认编辑器）。
    None,
}

/// 候选编辑器。顺序即优先级。
struct Candidate {
    label: &'static str,
    program: &'static str,
    line_style: LineStyle,
}

const CANDIDATES: &[Candidate] = &[
    Candidate { label: "VS Code", program: "code", line_style: LineStyle::GotoFlag },
    Candidate { label: "Cursor", program: "cursor", line_style: LineStyle::GotoFlag },
    Candidate { label: "Zed", program: "zed", line_style: LineStyle::PathSuffix },
    Candidate { label: "Sublime Text", program: "subl", line_style: LineStyle::PathSuffix },
];

/// macOS 上 app bundle 内的 CLI 绝对路径（PATH 里没有 `code` 时的回退）。
#[cfg(target_os = "macos")]
const BUNDLE_PATHS: &[(&str, &str, LineStyle)] = &[
    (
        "VS Code",
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
        LineStyle::GotoFlag,
    ),
    (
        "Cursor",
        "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
        LineStyle::GotoFlag,
    ),
];

#[cfg(not(target_os = "macos"))]
const BUNDLE_PATHS: &[(&str, &str, LineStyle)] = &[];

/// 在 PATH 里找可执行文件（`which` 的最小实现）。
///
/// 抽成独立函数只为了可测：真实 PATH 上有什么无法断言，
/// 而「找不到编辑器」与「找错了」的表象一样（点了没反应）。
fn which_in(path_env: &str, name: &str) -> Option<PathBuf> {
    for dir in path_env.split(':') {
        if dir.is_empty() {
            continue;
        }
        let p = Path::new(dir).join(name);
        if p.is_file() && is_executable(&p) {
            return Some(p);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(_p: &Path) -> bool {
    true
}

/// 拼出启动命令。
///
/// 单独成函数是为了测参数形状——它是这一层唯一会「静默出错」的地方。
fn build_launch(
    label: &str,
    program: &str,
    style: LineStyle,
    path: &str,
    line: Option<u32>,
) -> EditorLaunch {
    let mut args: Vec<String> = Vec::new();
    match (style, line) {
        (LineStyle::GotoFlag, Some(n)) => {
            args.push("--goto".to_owned());
            args.push(format!("{path}:{n}"));
        }
        (LineStyle::PathSuffix, Some(n)) => args.push(format!("{path}:{n}")),
        // 系统默认编辑器 / 未指定行：只给路径。
        _ => {
            // `open` 少了 `-t` 就不是「用默认文本编辑器打开文件」，
            // 而是可能去打开文件夹或某个应用。
            if program == "open" {
                args.push("-t".to_owned());
            }
            args.push(path.to_owned());
        }
    }
    EditorLaunch {
        label: label.to_owned(),
        program: program.to_owned(),
        args,
    }
}

/// 从候选里挑第一个可用的。
///
/// `available` / `bundle_available` 由调用方注入（真实环境用 which 与
/// 文件存在性，测试用假实现）——探测结果决定行为，不能只靠真机试。
///
/// `override_program` 是 `$KCODE_EDITOR`：用户显式指定的编辑器**不做**
/// 「是否认识」的判断——他可能用别的编辑器、或要带自己的参数。
/// 那种情况下按「路径:行」的通用后缀形式拼参数（多数编辑器接受它，
/// 即使不认识也只会忽略这个后缀）。
pub fn pick(
    override_program: Option<&str>,
    available: impl Fn(&str) -> Option<PathBuf>,
    bundle_available: impl Fn(&str) -> bool,
) -> Choice {
    if let Some(custom) = override_program.map(str::trim).filter(|s| !s.is_empty()) {
        return Choice {
            label: "KCODE_EDITOR".to_owned(),
            program: custom.to_owned(),
            style: LineStyle::PathSuffix,
        };
    }

    for c in CANDIDATES {
        if available(c.program).is_some() {
            return Choice {
                label: c.label.to_owned(),
                program: c.program.to_owned(),
                style: c.line_style,
            };
        }
    }
    for (label, path, style) in BUNDLE_PATHS {
        if bundle_available(path) {
            return Choice {
                label: (*label).to_owned(),
                program: (*path).to_owned(),
                style: *style,
            };
        }
    }
    // 兜底：系统默认。仍然打开文件，只是跳不了行——
    // 这一点由 supports_line=false 如实告诉 UI，而不是假装支持。
    Choice {
        label: "系统默认".to_owned(),
        program: if cfg!(target_os = "macos") { "open" } else { "xdg-open" }.to_owned(),
        style: LineStyle::None,
    }
}

/// 探测本机可用的编辑器。
pub fn detect() -> Choice {
    let path_env = std::env::var("PATH").unwrap_or_default();
    let override_program = std::env::var("KCODE_EDITOR").ok();
    pick(
        override_program.as_deref(),
        |name| which_in(&path_env, name),
        |p| Path::new(p).exists(),
    )
}

/// 探测结果 → UI 展示信息。
pub fn info() -> EditorInfo {
    let c = detect();
    EditorInfo {
        from_env: c.label == "KCODE_EDITOR",
        supports_line: !matches!(c.style, LineStyle::None),
        label: c.label,
    }
}

/// 用外部编辑器打开文件。
///
/// 返回实际使用的编辑器名称，UI 展示它——用户需要知道「点下去开在哪」，
/// 尤其当探测结果与他预期不同（本机装了多个编辑器）时。
pub fn open(path: &Path, line: Option<u32>) -> Result<String, String> {
    if !path.exists() {
        return Err(format!("文件不存在：{}", path.display()));
    }
    let choice = detect();
    let path_str = path.to_string_lossy().into_owned();
    // 不承诺做不到的事：系统默认编辑器收到 `路径:行` 会当成文件名，
    // 于是「打开失败」看起来像文件被删了。宁可不跳行。
    let line = match choice.style {
        LineStyle::None => None,
        _ => line,
    };
    let launch = build_launch(&choice.label, &choice.program, choice.style, &path_str, line);

    // 不等待、不接管输出：编辑器是用户的会话，管道会让 GUI 程序
    // 阻塞在写日志上（`code --goto` 实测会）。三个流都接到 null。
    Command::new(&launch.program)
        .args(&launch.args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("启动 {} 失败：{e}", launch.label))?;

    Ok(launch.label)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_path(_: &str) -> Option<PathBuf> {
        None
    }

    #[test]
    fn goto_flag_shape_is_exact() {
        let l = build_launch("VS Code", "code", LineStyle::GotoFlag, "/w/a.ts", Some(42));
        assert_eq!(l.args, vec!["--goto", "/w/a.ts:42"]);
    }

    #[test]
    fn path_suffix_shape_is_exact() {
        let l = build_launch("Zed", "zed", LineStyle::PathSuffix, "/w/a.ts", Some(7));
        assert_eq!(l.args, vec!["/w/a.ts:7"]);
    }

    #[test]
    fn open_fallback_uses_text_flag() {
        // `open` 少了 `-t` 就不是「用编辑器打开这个文件」了
        let l = build_launch("系统默认", "open", LineStyle::None, "/w/a.ts", Some(9));
        assert_eq!(l.args, vec!["-t", "/w/a.ts"]);
    }

    #[test]
    fn no_line_means_plain_path() {
        let l = build_launch("VS Code", "code", LineStyle::GotoFlag, "/w/a.ts", None);
        assert_eq!(l.args, vec!["/w/a.ts"], "没有行号时不该出现 --goto");
    }

    #[test]
    fn pick_prefers_first_available() {
        let c = pick(
            None,
            |name| (name == "cursor").then(|| PathBuf::from("/usr/bin/cursor")),
            |_| false,
        );
        assert_eq!(c.label, "Cursor");
        assert_eq!(c.program, "cursor");
        assert_eq!(c.style, LineStyle::GotoFlag);
    }

    #[test]
    fn pick_uses_bundle_when_path_lacks_cli() {
        let c = pick(None, no_path, |p| p.contains("Visual Studio Code"));
        assert_eq!(c.label, "VS Code");
        assert!(c.program.contains("Visual Studio Code.app"), "应走 app bundle 里的 CLI");
        assert_eq!(c.style, LineStyle::GotoFlag, "bundle 路径同样支持跳行");
    }

    #[test]
    fn pick_falls_back_to_system_default() {
        let c = pick(None, no_path, |_| false);
        assert_eq!(c.label, "系统默认");
        assert_eq!(c.style, LineStyle::None);
        assert!(!info_of(&c).supports_line);
    }

    fn info_of(c: &Choice) -> EditorInfo {
        EditorInfo {
            label: c.label.clone(),
            supports_line: !matches!(c.style, LineStyle::None),
            from_env: c.label == "KCODE_EDITOR",
        }
    }

    #[test]
    fn env_override_wins() {
        let c = pick(
            Some("  myedit  "),
            |name| (name == "code").then(|| PathBuf::from("/usr/bin/code")),
            |_| true,
        );
        assert_eq!(c.program, "myedit", "KCODE_EDITOR 应压过自动探测");
        assert_eq!(c.label, "KCODE_EDITOR");
        assert!(info_of(&c).from_env);
    }

    #[test]
    fn blank_env_override_is_ignored() {
        let c = pick(Some("   "), |name| (name == "code").then(|| PathBuf::from("x")), |_| false);
        assert_eq!(c.program, "code", "空白覆盖值应被忽略而不是当成命令名");
    }

    #[test]
    fn which_in_finds_only_executables() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("myeditor");
        std::fs::write(&good, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&good, std::fs::Permissions::from_mode(0o755)).unwrap();
        // 同名但不可执行：`which` 语义下不算找到
        let dir2 = tempfile::tempdir().unwrap();
        std::fs::write(dir2.path().join("myeditor"), b"x").unwrap();

        let env = format!("{}:{}", dir2.path().display(), dir.path().display());
        let found = which_in(&env, "myeditor").expect("应在第二个目录里找到可执行的");
        assert_eq!(found, good);

        // 空 PATH 段（`::`）不该被当成当前目录
        assert!(which_in("::", "myeditor").is_none());
    }

    #[test]
    fn open_missing_file_errors() {
        let err = open(Path::new("/definitely/not/here.txt"), None).unwrap_err();
        assert!(err.contains("不存在"), "应明确说明文件不存在: {err}");
    }

    /// 真实拉起一个「编辑器」，验证 探测 → 拼参数 → spawn 的完整链路。
    ///
    /// 三段各自都有单测，但接起来仍会断——例如把探测结果与启动参数
    /// 分成两个结构时，很容易把空路径拼进去（那样编辑器会打开一个
    /// 不存在的文件，而命令本身成功返回，属于静默失败）。
    /// 所以这里用一个可执行的假编辑器，把它收到的参数写到文件里再断言。
    #[test]
    fn open_launches_editor_with_path_and_line() {
        use std::os::unix::fs::PermissionsExt;
        use std::time::Duration;

        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-editor.sh");
        let out = dir.path().join("args.txt");
        std::fs::write(
            &script,
            format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"{}\"\n", out.display()),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let target = dir.path().join("a.ts");
        std::fs::write(&target, "const a = 1;").unwrap();

        // 通过 KCODE_EDITOR 注入。测试内改环境变量：本文件里只有这个
        // 测试会读它（其余都直接调用 pick 并显式传参），而 open() 在
        // 文件不存在时提前返回，不会走到探测。
        let prev = std::env::var("KCODE_EDITOR").ok();
        std::env::set_var("KCODE_EDITOR", &script);
        let result = open(&target, Some(12));
        match prev {
            Some(v) => std::env::set_var("KCODE_EDITOR", v),
            None => std::env::remove_var("KCODE_EDITOR"),
        }
        let label = result.expect("应成功启动配置的编辑器");
        assert_eq!(label, "KCODE_EDITOR");

        // 子进程是 spawn 出去的，不等待；条件轮询等它写完（有上限，不盲等）
        let mut args = String::new();
        for _ in 0..100 {
            if let Ok(s) = std::fs::read_to_string(&out) {
                if !s.trim().is_empty() {
                    args = s;
                    break;
                }
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!args.trim().is_empty(), "假编辑器没有被拉起来");
        assert!(
            args.contains("a.ts:12"),
            "KCODE_EDITOR 走「路径:行」形式，实际参数：{args:?}"
        );
        assert!(
            args.contains(target.to_str().unwrap()),
            "必须传绝对路径（编辑器的工作目录与 app 不同），实际：{args:?}"
        );
    }
}
