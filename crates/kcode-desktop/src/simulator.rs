//! 移动端模拟器展示（Android / iOS）。
//!
//! # 为什么单独成模块
//!
//! 这个能力完全依赖**本机安装了什么工具**，而工具的存在与否、以及命令
//! 输出的解析都不能靠猜：解析错一行的代价是「界面显示有 2 个模拟器但一个
//! 都起不来」，而用户无从判断是没装还是坏了。
//!
//! 因此这里遵守两条：
//!
//! 1. **解析逻辑是纯函数**（`parse_avds` / `parse_adb_devices` / `pick_device`），
//!    用真实命令输出做测试。它们决定了「界面显示什么」，最容易静默出错。
//! 2. **工具缺失要如实说明缺什么、怎么装**，而不是显示一个空的模拟器列表。
//!    参照客户端在未装 Xcode 时给的就是这种明确提示（实测本机即如此）。
//!
//! # 实测（本机 macOS 26.5）
//!
//! - iOS：**不可用**。只有 CommandLineTools，没有完整 Xcode，`simctl` 不存在。
//! - Android：可用。2 个 AVD（`Pixel_4a_API_30`、`Medium_Phone_API_TiramisuPrivacySandbox`），
//!   `adb exec-out screencap -p` 输出 1080×2340 PNG，单帧约 350ms。
//!
//! 帧的传输成本是这里最需要留意的：1080×2340 的 PNG 约 580KB，base64 后约
//! 780KB。因此前端**只在面板可见时轮询**，且间隔不短于 600ms——不可见时不取帧，
//! 避免为一个看不见的面板持续搬运数据。

use std::path::{Path, PathBuf};

/// 一个 adb 可见的设备。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbDevice {
    pub serial: String,
    /// `device` / `offline` / `unauthorized` …（adb 原样给出）
    pub state: String,
    /// `model:Pixel_4a` 之类的附加信息（`adb devices -l` 才有）。
    pub model: Option<String>,
}

/// iOS 侧的状态。不可用时必须带上原因与安装指引。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IosStatus {
    pub available: bool,
    /// 不可用时的原因（面向用户，含可执行的下一步）。
    pub reason: Option<String>,
}

/// Android 侧的状态。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AndroidStatus {
    /// 是否找到了 emulator 与 adb。
    pub available: bool,
    pub reason: Option<String>,
    /// 已创建的 AVD 名（`emulator -list-avds`）。
    pub avds: Vec<String>,
    /// 当前运行中的设备（`adb devices`）。
    pub devices: Vec<AdbDevice>,
}

/// 模拟器整体状态（供前端决定显示什么）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulatorStatus {
    pub ios: IosStatus,
    pub android: AndroidStatus,
}

// ── 纯解析函数（带测试）────────────────────────────────────────────────

/// 解析 `emulator -list-avds` 的输出。
///
/// 实际输出形如：
/// ```text
/// Pixel_4a_API_30
/// Medium_Phone_API_TiramisuPrivacySandbox
/// ```
/// 该命令把 INFO 日志写到 stderr，**stdout 只有名字**——但保险起见仍要
/// 过滤掉带 `INFO`/`WARNING` 的行：不同版本曾把日志混进 stdout。
/// 空行也要去掉，否则界面会出现一个点不动的空条目。
pub fn parse_avds(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| !l.starts_with("INFO") && !l.starts_with("WARNING") && !l.starts_with("ERROR"))
        .map(str::to_owned)
        .collect()
}

/// 解析 `adb devices -l` 的输出。
///
/// 实际输出形如：
/// ```text
/// List of devices attached
/// emulator-5554          device product:sdk_gphone_x86 model:sdk_gphone_x86 device:generic_x86 transport_id:1
/// 192.168.1.9:5555       offline
/// ```
/// 第一行是表头（`List of devices attached`），必须跳过——否则界面上会多出
/// 一个叫 "List" 的假设备。
pub fn parse_adb_devices(stdout: &str) -> Vec<AdbDevice> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| !l.starts_with("List of devices"))
        .filter(|l| !l.starts_with('*')) // `* daemon started successfully *` 这类
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let serial = parts.next()?.to_owned();
            let state = parts.next()?.to_owned();
            // 其余是 key:value 附加信息，取 model
            let model = parts
                .filter_map(|kv| kv.split_once(':'))
                .find(|(k, _)| *k == "model")
                .map(|(_, v)| v.to_owned());
            Some(AdbDevice { serial, state, model })
        })
        .collect()
}

/// 从设备列表里挑一个可用于截图/输入的设备。
///
/// **只接受 `state == "device"`**：`offline` / `unauthorized` 的设备上执行
/// screencap 会卡住直到超时，而界面上它「看起来是连着的」——
/// 宁可不选，也不要让用户点了之后等一个不会来的结果。
/// 多个可用时取第一个（`adb devices` 的顺序稳定）。
pub fn pick_device(devices: &[AdbDevice]) -> Option<&AdbDevice> {
    devices.iter().find(|d| d.state == "device")
}

/// 判断 iOS 模拟器是否可用。
///
/// 只有装了**完整 Xcode** 才有 `simctl`（仅 CommandLineTools 时没有——
/// 本机实测即如此）。不可用时返回原因与安装指引，而不是静默给空列表。
///
/// `developer_dir` 是 `xcode-select -p` 的输出；`simctl_found` 表示
/// 能否解析到 `simctl` 可执行文件。
pub fn ios_status(developer_dir: &str, simctl_found: bool) -> IosStatus {
    if simctl_found {
        return IosStatus { available: true, reason: None };
    }
    let hint = if developer_dir.contains("CommandLineTools") {
        "当前只有 CommandLineTools，没有完整的 Xcode（模拟器随 Xcode 提供）"
    } else if developer_dir.trim().is_empty() {
        "未检测到 Xcode 开发者目录"
    } else {
        "已安装的开发者目录里没有 simctl"
    };
    IosStatus {
        available: false,
        reason: Some(format!(
            "{hint}。安装完整 Xcode 后执行 `sudo xcode-select -s /Applications/Xcode.app` 即可启用。"
        )),
    }
}

/// 把界面坐标换算成设备坐标。
///
/// 前端显示的图片是等比缩放过的（1080×2340 塞不进右栏），点击必须换算回
/// 设备坐标，否则点在完全错误的位置。
///
/// **无效输入返回 `None`，而不是夹到 0 或边界**：`NaN` / `Infinity` /
/// 零尺寸意味着上游测量出了问题，此时把一个点击打到 (0,0) 或右下角都是
/// **真实发生的错误动作**——用户会看到自己在界面左上角莫名点了一下，
/// 而真实原因是某处算出了 NaN。宁可拒绝执行。
///
/// 合法输入则**取整 + 夹取到 `[0, w-1]`**：
/// - 取整：`adb input` 只接受整数；
/// - 夹取：图片右/下边缘的点击可能算出等于宽度的值，越界坐标会被 adb 拒绝，
///   表现为「点边缘没反应」。
pub fn to_device_coords(
    px: f64,
    py: f64,
    disp_w: f64,
    disp_h: f64,
    dev_w: u32,
    dev_h: u32,
) -> Option<(u32, u32)> {
    if !px.is_finite() || !py.is_finite() {
        return None;
    }
    if disp_w <= 0.0 || disp_h <= 0.0 || dev_w == 0 || dev_h == 0 {
        return None;
    }
    let x = (px / disp_w * dev_w as f64).round();
    let y = (py / disp_h * dev_h as f64).round();
    let clamp = |v: f64, max: u32| -> u32 {
        v.max(0.0).min((max.saturating_sub(1)) as f64) as u32
    };
    Some((clamp(x, dev_w), clamp(y, dev_h)))
}

/// 在候选路径里找一个存在**且可执行**的文件。
///
/// 分成纯函数是为了能测「都没找到」与「找到但不是可执行」两种情形——
/// 后者在 macOS 上很常见（存在但没执行位），只判 `exists()` 会漏。
pub fn first_executable<S: AsRef<Path>>(candidates: &[S], is_exec: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates
        .iter()
        .map(|c| c.as_ref().to_path_buf())
        .find(|p| is_exec(p))
}

// ── 命令层（实际执行外部工具）──────────────────────────────────────────

use std::process::Stdio;
use tokio::process::Command;

/// 单条命令的超时上限。
///
/// **必须有**：`adb` 在设备 offline 时不会失败，而是**一直阻塞**
/// （等设备回来）。没有超时的话界面会永远转圈，而用户不知道在等什么。
/// 3 秒对本地 adb 足够（实测 `screencap` 单帧 350ms）。
const CMD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// 启动模拟器允许更长：冷启动要十几秒，但命令本身立刻返回（我们不等待启动完成）。
const LAUNCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(p)
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// 定位 Android SDK 目录。
///
/// 顺序：环境变量 → macOS 默认位置 → `~/Android/Sdk`。
/// 不猜更多路径：猜错的后果是「找到一半」（比如只有 emulator 没有 adb），
/// 那比明确报告未安装更难排查。
fn android_sdk() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = vec![];
    for var in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Ok(v) = std::env::var(var) {
            if !v.trim().is_empty() {
                cands.push(PathBuf::from(v));
            }
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        cands.push(home.join("Library/Android/sdk"));
        cands.push(home.join("Android/Sdk"));
    }
    cands.into_iter().find(|p| p.join("platform-tools").join("adb").exists())
}

fn adb_path() -> Option<PathBuf> {
    if let Some(sdk) = android_sdk() {
        let p = sdk.join("platform-tools").join("adb");
        if is_executable(&p) {
            return Some(p);
        }
    }
    first_executable(&["/opt/homebrew/bin/adb", "/usr/local/bin/adb"], is_executable)
}

fn emulator_path() -> Option<PathBuf> {
    let sdk = android_sdk()?;
    let p = sdk.join("emulator").join("emulator");
    if is_executable(&p) {
        Some(p)
    } else {
        None
    }
}

/// 跑一条命令并收集 stdout（超时即杀，**不等待**）。
async fn run_stdout(program: &Path, args: &[&str], timeout: std::time::Duration) -> Result<String, String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let fut = cmd.output();
    match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(out)) if out.status.success() => {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        }
        Ok(Ok(out)) => {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(format!("{} 退出码 {:?}：{}", program.display(), out.status.code(), err.trim()))
        }
        Ok(Err(e)) => Err(format!("执行 {} 失败：{e}", program.display())),
        Err(_) => Err(format!(
            "{} 超过 {} 秒未返回（设备可能无响应）",
            program.display(),
            timeout.as_secs()
        )),
    }
}

/// 探测本机模拟器可用性。
pub async fn probe() -> SimulatorStatus {
    // iOS：只有完整 Xcode 才有 simctl
    let dev_dir = run_stdout(Path::new("/usr/bin/xcode-select"), &["-p"], CMD_TIMEOUT)
        .await
        .unwrap_or_default();
    let simctl_found = std::process::Command::new("/usr/bin/xcrun")
        .args(["--find", "simctl"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    let ios = ios_status(dev_dir.trim(), simctl_found);

    // Android
    let (emulator, adb) = (emulator_path(), adb_path());
    let mut android = AndroidStatus {
        available: emulator.is_some() && adb.is_some(),
        reason: None,
        avds: vec![],
        devices: vec![],
    };
    match (&emulator, &adb) {
        (Some(emu), Some(adb_bin)) => {
            if let Ok(out) = run_stdout(emu, &["-list-avds"], CMD_TIMEOUT).await {
                android.avds = parse_avds(&out);
            }
            if let Ok(out) = run_stdout(adb_bin, &["devices", "-l"], CMD_TIMEOUT).await {
                android.devices = parse_adb_devices(&out);
            }
        }
        _ => {
            let missing = match (emulator.is_some(), adb.is_some()) {
                (false, false) => "未找到 Android SDK 的 emulator 与 adb",
                (false, true) => "未找到 emulator（Android SDK 的 emulator 组件未安装）",
                _ => "未找到 adb（Android SDK 的 platform-tools 未安装）",
            };
            android.reason = Some(format!(
                "{missing}。安装 Android Studio 或在 SDK Manager 中补齐 platform-tools 与 emulator 后即可使用。"
            ));
        }
    }

    SimulatorStatus { ios, android }
}

/// 启动一个 AVD（**不等待启动完成**：冷启动十几秒，界面应立刻拿到反馈）。
pub async fn start(avd: &str) -> Result<(), String> {
    let emu = emulator_path().ok_or("未找到 Android emulator")?;
    // 拒绝未在列表里的名字：避免把任意字符串传给命令行
    let known = run_stdout(&emu, &["-list-avds"], CMD_TIMEOUT).await?;
    if !parse_avds(&known).iter().any(|a| a == avd) {
        return Err(format!("没有名为 {avd} 的模拟器"));
    }
    // spawn 而不等待：模拟器是独立进程，用户可能希望它在本应用关闭后仍在
    std::process::Command::new(&emu)
        .args(["-avd", avd, "-no-snapshot-save", "-no-boot-anim"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动模拟器失败：{e}"))?;
    let _ = LAUNCH_TIMEOUT; // 保留常量以便将来需要等待就绪时使用
    Ok(())
}

/// 关闭一个运行中的模拟器。
pub async fn stop(serial: &str) -> Result<(), String> {
    let adb = adb_path().ok_or("未找到 adb")?;
    run_stdout(&adb, &["-s", serial, "emu", "kill"], CMD_TIMEOUT).await.map(|_| ())
}

/// 一帧画面的抓取结果。
#[derive(Debug, Clone)]
pub struct Captured {
    /// data URL。`None` 表示**内容与上一帧逐字节相同**，前端无需更新。
    pub data_url: Option<String>,
    pub width: u32,
    pub height: u32,
}

/// 上一帧的 PNG 字节（按 serial）。用于跳过内容未变的帧。
///
/// # 为什么必须去重
///
/// 1080×2340 的 PNG 约 580KB，base64 后 780KB。前端每收到一帧都要
/// **解码 250 万像素并重绘**——这是整个面板里最贵的操作。而模拟器画面
/// 大多数时候是静止的（用户在读、在思考），此时 adb 仍会逐字节返回
/// 同一份 PNG。不比对就是每 600ms 白做一次「传 780KB + 解码 + 重绘」，
/// 表现为触摸操作时的卡顿：轮询与用户的交互在抢主线程。
///
/// 比对用**逐字节相等**而不是哈希：哈希碰撞会让画面永久冻结，
/// 而那种缺陷不报错、只表现为「卡住了」——580KB 内存换确定性，值得。
fn frame_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// 取一帧画面，返回 data URL 与设备尺寸。
///
/// 尺寸一并返回：前端据它把点击坐标换算回设备空间（见 `to_device_coords`）。
///
/// `force` 为 true 时**不走去重**，一定返回图像。前端在「手上没有帧」时
/// 必须传 true（首次选中设备、切换设备回来、停止后重启）——否则服务端
/// 认为「这帧没变」而前端却没有帧，面板会空着。
pub async fn frame(serial: &str, force: bool) -> Result<Captured, String> {
    let adb = adb_path().ok_or("未找到 adb")?;
    let mut cmd = Command::new(&adb);
    cmd.args(["-s", serial, "exec-out", "screencap", "-p"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let out = match tokio::time::timeout(CMD_TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) if o.status.success() => o,
        Ok(Ok(o)) => return Err(format!("截图失败：{}", String::from_utf8_lossy(&o.stderr).trim())),
        Ok(Err(e)) => return Err(format!("截图失败：{e}")),
        Err(_) => return Err("截图超时（设备可能无响应）".to_owned()),
    };
    let png = out.stdout;
    if png.is_empty() {
        return Err("截图返回空数据".to_owned());
    }
    // PNG 头里带尺寸（IHDR 从第 16 字节起，宽高各 4 字节大端）。
    // 不用图像库：只为读两个整数引入依赖不划算。
    let (w, h) = png_dimensions(&png).unwrap_or((0, 0));

    // 内容未变 → 只回尺寸，前端跳过整条「setState → 解码 → 重绘」链路
    if is_unchanged(serial, &png, force) {
        return Ok(Captured { data_url: None, width: w, height: h });
    }

    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(Captured { data_url: Some(format!("data:image/png;base64,{b64}")), width: w, height: h })
}

/// 判断这一帧是否与上次下发的相同，并顺手更新缓存。
///
/// 抽成独立函数是为了**能直接测**：这条判定错了不会报错，只会表现为
/// 「画面卡住不动」或「面板空白」——正是最需要测试覆盖的那类逻辑。
/// 副作用（更新缓存）与判定写在同一个函数里，避免调用方漏掉更新。
fn is_unchanged(serial: &str, png: &[u8], force: bool) -> bool {
    let mut cache = frame_cache().lock().unwrap_or_else(|e| e.into_inner());
    let same = !force && cache.get(serial).is_some_and(|last| last == png);
    if !same {
        cache.insert(serial.to_owned(), png.to_vec());
    }
    same
}

/// 忘掉某台设备的帧缓存。
///
/// 设备关闭时必须调用：否则下次启动同一台设备时，若首帧恰好与关掉前
/// 最后一帧相同（例如都是同一个桌面），会被判为「未变」而不下发画面。
pub fn forget_frame(serial: &str) {
    let mut cache = frame_cache().lock().unwrap_or_else(|e| e.into_inner());
    cache.remove(serial);
}

/// 从 PNG 字节里读宽高（IHDR 固定位置）。
///
/// 不是合法 PNG 时返回 None——调用方据此仍可显示画面，只是点击换算不可用
/// （总比把整帧丢掉好）。
pub fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    // 8 字节签名 + 4 字节长度 + "IHDR" + 4 字节宽 + 4 字节高
    if bytes.len() < 24 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((w, h))
}

/// 向设备发送一次输入。
///
/// `action` 取 `tap` / `swipe`；坐标已由调用方换算为**设备坐标**。
pub async fn input(
    serial: &str,
    action: &str,
    x1: i64,
    y1: i64,
    x2: i64,
    y2: i64,
    duration_ms: u64,
) -> Result<(), String> {
    let adb = adb_path().ok_or("未找到 adb")?;
    // **必须经 `shell` 转发**：`adb -s X input tap ...` 会被 adb 当成自己的
    // 子命令而报 `unknown command input`（真机测试抓到的）。
    // 截图用 `exec-out` 没问题，因为那是 adb 自己的子命令。
    // `input` 是**设备上的**命令，属于 `shell` 那一类。
    let args: Vec<String> = match action {
        "tap" => vec!["shell".into(), "input".into(), "tap".into(), x1.to_string(), y1.to_string()],
        "swipe" => vec![
            "shell".into(),
            "input".into(),
            "swipe".into(),
            x1.to_string(),
            y1.to_string(),
            x2.to_string(),
            y2.to_string(),
            duration_ms.to_string(),
        ],
        // 返回键：界面上的「返回」按钮（模拟器的硬件返回）
        "back" => vec!["shell".into(), "input".into(), "keyevent".into(), "4".into()],
        "home" => vec!["shell".into(), "input".into(), "keyevent".into(), "3".into()],
        other => return Err(format!("不支持的输入类型：{other}")),
    };
    let mut full: Vec<&str> = vec!["-s", serial];
    full.extend(args.iter().map(String::as_str));
    run_stdout(&adb, &full, CMD_TIMEOUT).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn avds_parsed_one_per_line() {
        let out = "Pixel_4a_API_30\nMedium_Phone_API_TiramisuPrivacySandbox\n";
        assert_eq!(
            parse_avds(out),
            vec!["Pixel_4a_API_30", "Medium_Phone_API_TiramisuPrivacySandbox"]
        );
    }

    #[test]
    fn avds_skip_log_lines_blank_and_crlf() {
        // 不同版本的 emulator 可能把日志混进 stdout；CRLF 也要能处理
        let out = "INFO | Storing crashdata\r\n\r\nPixel_4a_API_30\r\nWARNING | something\r\n";
        assert_eq!(parse_avds(out), vec!["Pixel_4a_API_30"]);
    }

    #[test]
    fn avds_empty_output_gives_empty_list() {
        assert!(parse_avds("").is_empty());
        assert!(parse_avds("INFO | no avds found\n").is_empty());
    }

    #[test]
    fn adb_devices_skips_header_line() {
        // 「List of devices attached」不是设备，漏过滤会让界面多一个假条目
        let out = "List of devices attached\nemulator-5554\tdevice\n";
        let d = parse_adb_devices(out);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].serial, "emulator-5554");
        assert_eq!(d[0].state, "device");
    }

    #[test]
    fn adb_devices_extracts_model_and_keeps_offline() {
        let out = "List of devices attached\n\
                   emulator-5554          device product:sdk_gphone_x86 model:Pixel_4a device:generic transport_id:1\n\
                   192.168.1.9:5555       offline\n\
                   * daemon started successfully *\n";
        let d = parse_adb_devices(out);
        assert_eq!(d.len(), 2, "daemon 提示行不该被当成设备: {d:?}");
        assert_eq!(d[0].model.as_deref(), Some("Pixel_4a"));
        assert_eq!(d[1].state, "offline");
    }

    #[test]
    fn pick_device_requires_state_device() {
        // offline / unauthorized 上执行 screencap 会卡到超时：必须跳过
        let offline = AdbDevice { serial: "a".into(), state: "offline".into(), model: None };
        assert!(pick_device(std::slice::from_ref(&offline)).is_none());

        let ok = AdbDevice { serial: "b".into(), state: "device".into(), model: None };
        assert_eq!(pick_device(&[offline, ok.clone()]).map(|d| d.serial.clone()), Some("b".into()));
    }

    #[test]
    fn pick_device_handles_empty() {
        assert!(pick_device(&[]).is_none());
    }

    #[test]
    fn ios_unavailable_explains_commandline_tools_case() {
        // 本机实测情形：只有 CommandLineTools
        let s = ios_status("/Library/Developer/CommandLineTools", false);
        assert!(!s.available);
        let reason = s.reason.unwrap();
        assert!(reason.contains("CommandLineTools"), "应说明当前只有命令行工具: {reason}");
        // 必须给出可执行的下一步，而不是只说「不可用」
        assert!(reason.contains("xcode-select -s"), "应给出安装指引: {reason}");
    }

    #[test]
    fn ios_available_when_simctl_found() {
        let s = ios_status("/Applications/Xcode.app/Contents/Developer", true);
        assert!(s.available);
        assert!(s.reason.is_none());
    }

    #[test]
    fn coords_map_and_clamp_to_device_space() {
        // 显示 540x1170（设备的一半），点正中 → 设备正中
        assert_eq!(to_device_coords(270.0, 585.0, 540.0, 1170.0, 1080, 2340), Some((540, 1170)));
        // 点右下角：取整后可能等于宽高，必须夹到 w-1/h-1（越界坐标 adb 会拒绝）
        assert_eq!(to_device_coords(540.0, 1170.0, 540.0, 1170.0, 1080, 2340), Some((1079, 2339)));
        // 负值夹到 0
        assert_eq!(to_device_coords(-10.0, -10.0, 540.0, 1170.0, 1080, 2340), Some((0, 0)));
    }

    #[test]
    fn coords_invalid_input_is_refused_not_silently_zeroed() {
        // NaN / 无穷 / 零尺寸都返回 None：把点击打到 (0,0) 是真实发生的错误动作，
        // 而根因（某处算出 NaN）会因此被掩盖。
        assert_eq!(to_device_coords(f64::NAN, 5.0, 100.0, 100.0, 100, 100), None);
        assert_eq!(to_device_coords(5.0, f64::NAN, 100.0, 100.0, 100, 100), None);
        assert_eq!(to_device_coords(f64::INFINITY, 5.0, 100.0, 100.0, 100, 100), None);
        assert_eq!(to_device_coords(1.0, 1.0, 0.0, 100.0, 1080, 2340), None);
        assert_eq!(to_device_coords(1.0, 1.0, 100.0, 100.0, 0, 0), None);
    }

    /// 帧去重的核心契约：同样的字节只下发一次，除非显式要求强制。
    ///
    /// 这几条都是**静默**失败：判错了不会有报错，只会表现为
    /// 「画面卡住不动」或「面板空白」——所以用测试把边界钉住。
    #[test]
    fn frame_cache_dedupes_identical_bytes() {
        let serial = "test-dedupe-ser";
        forget_frame(serial);

        // 第一次：无缓存 → 必须下发
        assert!(!is_unchanged(serial, b"PNG-A", false), "首次应下发");

        // 同样的字节：不下发
        assert!(is_unchanged(serial, b"PNG-A", false), "相同内容应跳过");

        // 内容变了：下发
        assert!(!is_unchanged(serial, b"PNG-B", false), "内容变化应下发");

        // force：即使相同也下发（前端手上没有帧时必须能拿到）
        assert!(!is_unchanged(serial, b"PNG-B", true), "force 应无视去重");

        forget_frame(serial);
        // 忘记之后：同字节也重新下发
        assert!(!is_unchanged(serial, b"PNG-B", false), "forget 后应重新下发");
    }

    /// 不同设备各自缓存，互不影响（否则切换设备会显示上一台的判断结果）。
    #[test]
    fn frame_cache_is_per_serial() {
        forget_frame("dedupe-a");
        forget_frame("dedupe-b");
        assert!(!is_unchanged("dedupe-a", b"X", false));
        // b 从未见过 X，不该因为它与 a 的缓存相同而被判为未变
        assert!(!is_unchanged("dedupe-b", b"X", false), "不同设备应各自判断");
        assert!(is_unchanged("dedupe-a", b"X", false));
        forget_frame("dedupe-a");
        forget_frame("dedupe-b");
    }

    #[test]
    fn png_dimensions_reads_ihdr() {
        // 构造一个最小的 PNG 头（签名 + IHDR 长度/类型 + 宽高）
        let mut b = Vec::new();
        b.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        b.extend_from_slice(&13u32.to_be_bytes()); // IHDR 数据长度
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&1080u32.to_be_bytes());
        b.extend_from_slice(&2340u32.to_be_bytes());
        assert_eq!(png_dimensions(&b), Some((1080, 2340)));
    }

    #[test]
    fn png_dimensions_rejects_non_png() {
        // 不是 PNG 时返回 None，而不是读出错的值：前端据此仍显示画面，
        // 只是点击换算不可用（比把整帧丢掉好，但绝不能算出错的尺寸）
        assert_eq!(png_dimensions(b"not a png at all........"), None);
        assert_eq!(png_dimensions(&[]), None);
        assert_eq!(png_dimensions(&[0u8; 30]), None);
        // 签名对但块类型不对
        let mut b = Vec::new();
        b.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        b.extend_from_slice(&13u32.to_be_bytes());
        b.extend_from_slice(b"XXXX");
        b.extend_from_slice(&[0u8; 8]);
        assert_eq!(png_dimensions(&b), None);
    }

    #[test]
    fn first_executable_skips_missing_and_non_executable() {
        let cands = ["/nope/a", "/exists/notexec", "/exists/exec"];
        let found = first_executable(&cands, |p| p.to_str() == Some("/exists/exec"));
        assert_eq!(found, Some(PathBuf::from("/exists/exec")));
        // 都不满足时返回 None（调用方据此给「未安装」提示，而不是崩）
        assert!(first_executable(&cands, |_| false).is_none());
    }
}

#[cfg(test)]
mod live_tests {
    //! 对**真实工具链**的验证（本机有 AVD 时才跑）。
    //!
    //! 纯函数测试能保证解析正确，但保证不了「命令真的能跑通」——
    //! 参数拼错、路径找错都不会被单元测试发现，只会让界面上一片空白。
    //! 因此这里直接调用真实的 emulator/adb。
    //!
    //! # 为什么不用 `#[ignore]`
    //!
    //! 本机（开发环境）有 Android SDK 与 AVD，这是**产品的目标环境**之一。
    //! 用 ignore 会让它永远不被执行；而条件跳过（探测不到工具就返回）
    //! 既能在目标环境真验证，也不会在 CI 上假失败。

    use super::*;

    #[tokio::test]
    async fn probe_reports_ios_unavailable_without_full_xcode() {
        let st = probe().await;
        // 本机只有 CommandLineTools → iOS 不可用，且必须给出安装指引
        if !st.ios.available {
            let reason = st.ios.reason.as_deref().unwrap_or("");
            assert!(
                reason.contains("xcode") || reason.contains("Xcode"),
                "不可用时应说明与 Xcode 有关: {reason}"
            );
        }
    }

    #[tokio::test]
    async fn probe_lists_real_avds_when_sdk_present() {
        let st = probe().await;
        if !st.android.available {
            eprintln!("跳过：本机未安装 Android SDK（{}）", st.android.reason.unwrap_or_default());
            return;
        }
        // 本机实测有 2 个 AVD；不写死数量（别人的机器可能不同），
        // 但要断言「解析确实拿到了东西」——否则 probe 可能静默返回空。
        assert!(
            !st.android.avds.is_empty(),
            "Android 可用却一个 AVD 都没解析出来 —— 可能是解析或路径问题"
        );
    }

    #[tokio::test]
    async fn frame_from_running_device_is_real_png_with_expected_size() {
        let st = probe().await;
        if !st.android.available {
            eprintln!("跳过：未安装 Android SDK");
            return;
        }
        let Some(dev) = pick_device(&st.android.devices).cloned() else {
            eprintln!("跳过：当前没有运行中的模拟器（可先 `emulator -avd <name>` 启动）");
            return;
        };

        // 先清缓存：这台设备可能刚被别的测试取过帧
        forget_frame(&dev.serial);
        let cap = frame(&dev.serial, false).await.expect("取帧失败");
        let data_url = cap.data_url.expect("首次取帧必须带图像");
        let (w, h) = (cap.width, cap.height);
        assert!(data_url.starts_with("data:image/png;base64,"), "应为 PNG data URL");
        // 尺寸必须解析出来：前端靠它把点击换算回设备坐标
        assert!(w > 0 && h > 0, "未能从 PNG 头解析尺寸（w={w} h={h}）");
        assert!(w >= 320 && h >= 320, "尺寸不像手机屏幕：{w}x{h}");

        // **真机验证去重**：立刻再取一帧。模拟器画面在 350ms 内几乎不可能变化，
        // 所以应被判为「未变」而只回尺寸——这正是省掉 780KB 传输与解码的依据。
        let again = frame(&dev.serial, false).await.expect("二次取帧失败");
        assert!(
            again.data_url.is_none(),
            "画面未变时应跳过图像下发（若这里失败，说明去重没生效或设备画面在跳动）"
        );
        assert_eq!(again.width, w, "跳过图像时仍须返回尺寸");

        // force 必须能拿到图像：前端手上没有帧时靠它
        let forced = frame(&dev.serial, true).await.expect("强制取帧失败");
        assert!(forced.data_url.is_some(), "force=true 时必须返回图像");
        forget_frame(&dev.serial);

        // 顺带验证一次输入：点屏幕正中（不应报错）
        input(&dev.serial, "tap", (w / 2) as i64, (h / 2) as i64, 0, 0, 120)
            .await
            .expect("发送点击失败");
    }
}
