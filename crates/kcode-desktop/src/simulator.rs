//! 移动端模拟器画面与输入（Android / iOS / 鸿蒙 / 小程序）。
//!
//! # 为什么单独成模块
//!
//! 这个能力完全依赖**本机安装了什么工具**，而工具的存在与否、以及命令
//! 输出的解析都不能靠猜：解析错一行的代价是「界面显示有 2 个模拟器但一个
//! 都起不来」，而用户无从判断是没装还是坏了。
//!
//! 因此这里遵守两条：
//!
//! 1. **解析逻辑是纯函数**（`parse_avds` / `parse_adb_devices` /
//!    `avd_info` / `parse_simctl_devices` / `parse_hdc_targets`），
//!    用真实命令输出做测试。它们决定了「界面显示什么」，最容易静默出错。
//! 2. **工具缺失要如实说明缺什么、怎么装**，而不是显示一个空的模拟器列表。
//!    参照客户端在未装 Xcode 时给的就是这种明确提示（实测本机即如此）。
//!
//! # 四个平台走的是四套工具链
//!
//! | 平台 | 探测 | 启动 | 取画面 | 触摸输入 |
//! |---|---|---|---|---|
//! | Android | `emulator -list-avds` + `adb devices` | `emulator -avd` | `adb exec-out screencap -p` | `adb shell input` |
//! | iOS | `xcrun simctl list devices --json` | `simctl boot` | `simctl io ... screenshot` | **无**（simctl 不提供触摸） |
//! | 鸿蒙 | `hdc list targets` | **无**（启动器在 DevEco 里） | `hdc shell snapshot_display` | `uinput`，未验证 |
//! | 小程序 | 微信开发者工具是否安装 | 无（由开发者工具管理） | 未接入 | 未接入 |
//!
//! 这些差异不是配置项而是**工具链的既成事实**，所以用
//! [`PlatformStatus::can_launch`] / [`PlatformStatus::can_input`] 两个能力位
//! 如实告诉界面「这个平台能做什么」——界面对不能做的事**不渲染按钮**
//! （项目约定：不给空入口）。
//!
//! # 实测（本机 macOS 26.5）
//!
//! - **Android：全链路已验证**。2 个 AVD（`Pixel_4a_API_30`、
//!   `Medium_Phone_API_TiramisuPrivacySandbox`），`adb exec-out screencap -p`
//!   输出 1080×2340 PNG，单帧约 350ms；`adb shell input tap/swipe` 生效。
//! - **iOS：不可用**。只有 CommandLineTools，没有完整 Xcode，`simctl` 不存在。
//!   探测与解析（`parse_simctl_devices`）有纯函数测试，但**取画面未在真机验证**。
//! - **鸿蒙：部分**。hdc 1.2.0a 已安装（`~/Library/Huawei/Sdk/openharmony/9/toolchains/hdc`），
//!   `list targets` 返回 `[Empty]`（无设备）。因此取画面与输入都**未在真机验证**，
//!   代码里逐处标注了这一点。
//! - **小程序：未安装**微信开发者工具。
//!
//! # 帧的传输成本
//!
//! 1080×2340 的 PNG 约 580KB，base64 后约 780KB。因此前端**只在面板可见时
//! 轮询**，且间隔不短于 600ms——不可见时不取帧，避免为一个看不见的面板
//! 持续搬运数据。服务端另做逐字节去重（见 `is_unchanged`）。
//!
//! # 未验证项（**改动这里前先读**）
//!
//! 下列代码路径基于工具自身的帮助文本或官方文档写成，但本机缺少对应环境，
//! **没有跑通过一次**。它们的共同点是失败时表现为「画面不出来」或
//! 「点了没反应」，而不是报错——所以注释里逐处标注，不要因为「看起来对」
//! 就当成已验证：
//!
//! 1. iOS 取画面（`simctl io ... screenshot`）—— 无完整 Xcode。
//! 2. 鸿蒙取画面（`snapshot_display`）与尺寸解析（JPEG，非 PNG）。
//! 3. 小程序的任何动作。
//!
//! 验证方法：接上对应设备后跑 `cargo test -p kcode-desktop -- --nocapture`，
//! `live_tests` 里的条件跳过会在探测到工具时自动执行。

use std::path::{Path, PathBuf};

/// 模拟器/设备所属平台。
///
/// **为什么要有这个枚举**：四个平台的工具链完全不同（adb / simctl / hdc /
/// 微信开发者工具），而它们对外提供的三个动作（探测、取画面、发输入）语义
/// 相同。用平台标识把「工具怎么调」收在这一层，上层的 `probe` / `frame` /
/// `input` 就只有一份分派逻辑——否则每个平台都要复制一遍坐标系换算、
/// 帧去重、超时处理，而这些正是最容易静默出错的地方。
///
/// 序列化用**原样字符串**（`android` / `ios` / `harmony` / `miniprogram`）
/// 而不是枚举序号：前端要拿它当参数回传，序号在增删平台时会错位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Android,
    Ios,
    Harmony,
    Miniprogram,
}

impl Platform {
    /// 从命令参数解析平台。**未知值必须报错**：静默当成 Android 会让
    /// iOS 的 UDID 被递给 adb，错误现场离根因很远。
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "android" => Ok(Self::Android),
            "ios" => Ok(Self::Ios),
            "harmony" => Ok(Self::Harmony),
            "miniprogram" => Ok(Self::Miniprogram),
            other => Err(format!("未知的平台：{other}（应为 android / ios / harmony / miniprogram）")),
        }
    }

    /// 平台的展示名（错误信息里用它，别让用户看到 `miniprogram` 这种内部名）。
    pub fn label(self) -> &'static str {
        match self {
            Self::Android => "Android",
            Self::Ios => "iOS",
            Self::Harmony => "鸿蒙",
            Self::Miniprogram => "小程序",
        }
    }
}

/// 一个模拟器/设备条目（四平台共用）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceEntry {
    /// 平台内唯一标识：Android 用 AVD 名、iOS 用 UDID、鸿蒙用 connect key。
    /// 启停与取帧都用它。
    pub id: String,
    /// 展示名（型号，如 `Pixel 4a` / `iPhone 15 Pro` / `Medium Phone`）。
    pub name: String,
    /// 系统名与版本（如 `Android 13` / `iOS 17.0` / `HarmonyOS`）。
    /// 取不到时为 None——**不编造**。
    pub os: Option<String>,
    /// 屏幕分辨率（如 `1080×2400`）。
    pub resolution: Option<String>,
    /// 是否正在运行（可截图/可输入）。
    pub running: bool,
    /// 原始状态串（`device` / `offline` / `unauthorized` / `Booted` / `Shutdown` …）。
    /// 保留它是为了在「不运行」时能说清**为什么**——离线与未启动的处置不同。
    pub state: String,
    /// 附加细节（abi / dpi / 镜像 tag 等），供展开查看。
    pub detail: Option<String>,
    /// **取画面 / 发输入 / 关闭**时用的标识（未运行时为 None）。
    ///
    /// # 为什么不能直接用 `id`
    ///
    /// Android 的 `id` 是 **AVD 名**（`Pixel_4a_API_30`，用户启动时用它：
    /// `emulator -avd <名字>`），而 `adb -s` 要的是 **serial**
    /// （`emulator-5554`）。两者**没有任何可推导的关系**——端口每次启动都可能变。
    ///
    /// 把 AVD 名当 serial 传给 adb 会得到一个和根因无关的报错
    /// （`device 'Pixel_4a_API_30' not found`），而真实原因是「这里该用 serial」。
    /// 开发时我自己就踩了这个：探测试图取帧时发现「没有运行中的设备」，
    /// 而设备其实好好跑着（详见 `resolve_android_serial`）。
    ///
    /// iOS 与鸿蒙没这个问题（UDID / connect key 既是身份也是句柄），
    /// 但字段统一存在，界面不必按平台分支。
    pub runtime_id: Option<String>,
}

/// 触摸输入的**形态**。
///
/// # 为什么必须区分，而不是一个 `can_input: bool`
///
/// 三个平台的输入能力**形态不同**，而界面的画法完全不同：
///
/// - Android：按坐标点/滑（`adb shell input tap x y`）→ 可点画面；
/// - 小程序：**只能按元素点**（`Element.tap` 需要 elementId，服务端不返回元素
///   位置）→ 元素列表，点画面没有意义；
/// - iOS / 鸿蒙：不能输入 → 只读。
///
/// 用布尔量表达会把小程序显示成「可点画面」，而用户点了不会有任何反应
/// ——在他看来说明「这个功能是坏的」。实际是**平台能力形态不同**。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InputMode {
    /// 不支持任何输入。
    None,
    /// 按坐标：可点画面任意位置、可滑动。
    Coordinate,
    /// 按元素：只能点列出的元素，不能按坐标。
    Element,
}

/// 一个平台的能力与设备清单。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformStatus {
    /// 工具链是否齐备（齐备才能列设备）。
    pub available: bool,
    /// 不可用 / 部分可用时的原因与**可执行的下一步**。
    pub reason: Option<String>,
    /// 探测到的工具路径（可用时给出，便于排查「为什么找不到我的模拟器」）。
    pub tool: Option<String>,
    pub devices: Vec<DeviceEntry>,
    /// 能否从本应用**启动**设备。
    ///
    /// 鸿蒙为 false：模拟器由 DevEco Studio 管理，没有独立的命令行启动器
    /// （实测本机 `~/Library/Huawei/Sdk` 下只有 hdc 与系统镜像，无 launcher）。
    /// 界面据此把「启动」按钮换成说明，而不是给一个点了报错的按钮。
    pub can_launch: bool,
    /// 能否发送触摸输入。
    ///
    /// iOS 为 false：`simctl` **没有触摸命令**（截图有、点击没有），
    /// 触点注入需要 WebDriverAgent/XCTest。界面据此隐藏触摸提示，
    /// 而不是让用户点了没反应。
    pub can_input: bool,
    /// `can_input` 为 false 时，**为什么**不能输入（面向用户）。
    ///
    /// 界面把它显示在画面区旁边。有这个字段的原因是两种「不能输入」对
    /// 用户的意义完全不同：iOS 是工具链缺能力（换工具才能解决），
    /// 鸿蒙是「我们还没验证」。混成一句「不支持触摸」等于把我们的待办
    /// 说成平台的限制。
    pub input_hint: Option<String>,
    /// 输入形态（见 [`InputMode`]）。界面据此决定画可点画面还是元素列表。
    pub input_mode: InputMode,
}

impl PlatformStatus {
    /// 不可用平台（没装工具链）。
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            available: false,
            reason: Some(reason.into()),
            tool: None,
            devices: Vec::new(),
            can_launch: false,
            can_input: false,
            input_hint: None,
            input_mode: InputMode::None,
        }
    }
}

/// 模拟器整体状态：四个平台**全部返回**。
///
/// # 为什么不可用的平台也要返回
///
/// 与右栏场景的「不给空入口」规则**不冲突**：那条针对的是「点开是空的面板」。
/// 而这里是能力清单——用户需要知道本机装了哪几个平台的工具链、缺什么、
/// 怎么装。隐藏不可用的平台只会让人以为我们不支持那个平台。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SimulatorStatus {
    pub android: PlatformStatus,
    pub ios: PlatformStatus,
    pub harmony: PlatformStatus,
    pub miniprogram: PlatformStatus,
}

// ── 纯解析函数（带测试）────────────────────────────────────────────────

/// 一个 adb 可见的设备（`adb devices -l` 的一行）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbDevice {
    pub serial: String,
    /// `device` / `offline` / `unauthorized` …（adb 原样给出）
    pub state: String,
    /// `model:Pixel_4a` 里的名字（`-l` 才有）。
    ///
    /// 注意它是**系统镜像自报的型号**，与 AVD 的 `hw.device.name` 常常不同：
    /// 本机 Pixel_4a_API_30 这个 AVD 实际加载的镜像自报 `sdk_gphone_arm64`。
    /// 因此模拟器条目的展示名以 AVD 配置为准（那是用户自己选的机型），
    /// 这个字段只用于**外接设备**（没有任何 AVD 配置可读时）。
    pub model: Option<String>,
}

/// 一次 adb 探测的结果：设备身份 + 补充信息。
///
/// 抽成结构体是为了让「合并 AVD 清单与 adb 现状」这段逻辑成为**纯函数**
/// （`build_android_entries`）：合并错了会表现为「同一个模拟器出现两行」
/// 或「明明在运行却显示未启动」，两种都不报错。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AdbObservation {
    pub serial: String,
    pub state: String,
    /// `adb devices -l` 自报的型号。
    pub model: Option<String>,
    /// `adb -s S emu avd name` 的结果（仅运行中的模拟器有）。
    /// 这是把 serial 映射回 AVD 名的**唯一可靠方式**——
    /// 按 `emulator-5554` 猜序号是错的（同一台 AVD 每次启动的端口会变）。
    pub avd_name: Option<String>,
    /// `adb shell getprop` 的原始输出（仅外接设备取，模拟器不需要）。
    pub getprop: Option<String>,
    /// `adb shell wm size` 的原始输出（仅外接设备取）。
    pub wm_size: Option<String>,
}

// ── Android：从 AVD 配置提取型号与系统 ────────────────────────────────

/// 从 AVD 的 `config.ini` 里读出一个可展示的设备条目。
///
/// **为什么要读 config.ini**：`emulator -list-avds` 只给一个目录名
/// （`Medium_Phone_API_TiramisuPrivacySandbox`），而用户要区分的是
/// 「什么型号、跑什么系统」。这两个信息都在配置里：
/// `hw.device.name` / `image.sysdir.1`。只显示目录名等于让用户自己解析。
///
/// 所有字段都可能缺失（手改过的配置、旧版 AVD），**缺就留空不编造**。
pub fn avd_info(id: &str, config_ini: &str) -> DeviceEntry {
    let get = |key: &str| -> Option<String> { ini_value(config_ini, key) };

    // 展示名三级回退：`avd.ini.displayname`（Android Studio 里显示的名字，
    // 如 `Pixel 4a API 30`）→ 机型档案 `hw.device.name` → AVD 目录名。
    // 只用目录名是最后手段：`Medium_Phone_API_TiramisuPrivacySandbox` 这种
    // 名字能看出是哪个，但看不出机型。
    let display = get("avd.ini.displayname");
    let profile = get("hw.device.name");
    let name = display
        .clone()
        .or_else(|| profile.clone())
        .unwrap_or_else(|| id.to_owned());

    let w = get("hw.lcd.width");
    let h = get("hw.lcd.height");
    let dpi = get("hw.lcd.density");
    let abi = get("abi.type");
    let tag = get("tag.id");
    // 镜像路径是判断系统版本的第一来源；`target` 是旧格式的回退
    let sysdir = get("image.sysdir.1").or_else(|| get("target"));

    let resolution = match (w, h) {
        (Some(w), Some(h)) => Some(format!("{w}×{h}")),
        _ => None,
    };
    let os = sysdir.as_deref().and_then(android_release);

    // 细节行：abi / dpi / 镜像 tag，以及**与展示名不同的**机型档案名。
    // 最后一项只在两者不一致时加：一致时再说一遍是冗余。
    let mut bits: Vec<String> = Vec::new();
    if let Some(a) = abi {
        bits.push(a);
    }
    if let Some(d) = dpi {
        bits.push(format!("{d}dpi"));
    }
    if let Some(t) = tag {
        bits.push(t);
    }
    if let (Some(p), Some(d)) = (&profile, &display) {
        if p != d {
            bits.push(p.clone());
        }
    }

    DeviceEntry {
        id: id.to_owned(),
        name,
        os,
        resolution,
        running: false, // 由 `build_android_entries` 按 adb 实际状态覆盖
        state: "stopped".to_owned(),
        detail: if bits.is_empty() { None } else { Some(bits.join(" · ")) },
        runtime_id: None, // 同上：运行中才有 serial
    }
}

/// 从 `.ini` 风格的文本里取一个键的值。
///
/// # 为什么不能只认 `key=value`
///
/// **实测本机两份 AVD 配置的写法不一致**：`Pixel_4a_API_30.avd/config.ini`
/// 全篇 47 行都是 `hw.device.name = pixel_4a`（等号两边带空格），
/// 而 `Medium_Phone_API_TiramisuPrivacySandbox.avd/config.ini` 是
/// `hw.device.name=medium_phone`（不带）。只认一种写法的话，另一种配出来的
/// 机型/系统/分辨率**全都读不出来**，而界面只会显示一个没有信息的条目——
/// 不报错，只是看起来「没解析到」。因此等号两侧的空白一律容忍。
///
/// 键名本身也可能带空格（`AvdId = X`），所以键与值都要 trim。
pub fn ini_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (k, v) = line.split_once('=')?;
        if k.trim() != key {
            return None;
        }
        let v = v.trim();
        // 空值（`fastboot.chosenSnapshotFile = `）等同缺失：返回空的字符串
        // 会让上层以为「读到了」而显示一个空标签。
        (!v.is_empty()).then(|| v.to_owned())
    })
}

/// 解析 `adb -s S emu avd name` 的输出。
///
/// 实测输出（本机 emulator-5554）：
/// ```text
/// Pixel_4a_API_30
/// OK
/// ```
/// `OK` 是状态行不是名字——不排除它会让 AVD 名变成 `Pixel_4a_API_30\nOK`，
/// 于是「运行中」的匹配永远失败（名字对不上），表现为**运行中的模拟器
/// 在界面上显示为未启动**。设备未运行时该命令返回 `KO` 或空。
pub fn parse_emu_avd_name(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && *l != "OK" && *l != "KO")
        .map(str::to_owned)
}

/// 把 `adb shell getprop` 的整份输出解析成键值对。
///
/// 实测格式（本机 Android 11，411 行；键与值各自带方括号）：
/// ```text
/// [ro.build.version.release]: [11]
/// [ro.product.model]: [sdk_gphone_arm64]
/// ```
/// 值是空时形如 `[ro.x]: []`——照样收下（调用方用 `filter` 判空）。
///
/// 用**整份 dump 一次取回**而不是逐个 `getprop <key>`：后者每读一个属性
/// 一次往返（实测本机每次约 30ms），三个属性就是三倍延迟，而
/// `adb shell getprop` 整份 dump 只要一次往返。
pub fn parse_getprop(stdout: &str) -> std::collections::HashMap<String, String> {
    stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let (k, rest) = line.strip_prefix('[')?.split_once("]:")?;
            let v = rest.trim().strip_prefix('[')?.strip_suffix(']')?;
            Some((k.to_owned(), v.trim().to_owned()))
        })
        .collect()
}

/// 解析 `adb shell wm size` 的输出。
///
/// 实测输出：
/// ```text
/// Physical size: 1080x2340
/// ```
/// 有的设备还会带一行 `Override size: 720x1280`（被改过分辨率）。
/// 有 Override 时**以它为准**：那才是当前实际生效的尺寸，
/// 而点击坐标换算必须用生效尺寸（用 Physical 会整体偏移）。
pub fn parse_wm_size(stdout: &str) -> Option<String> {
    let mut physical = None;
    let mut over = None;
    for line in stdout.lines() {
        let line = line.trim();
        let Some((label, dims)) = line.split_once(':') else { continue };
        let dims = dims.trim().replace('x', "×");
        let Some((w, h)) = dims.split_once('×') else { continue };
        if w.parse::<u32>().is_err() || h.parse::<u32>().is_err() {
            continue;
        }
        match label.trim() {
            "Physical size" => physical = Some(dims),
            "Override size" => over = Some(dims),
            _ => {}
        }
    }
    over.or(physical)
}

/// 从外接设备的实测信息拼出一个条目。
///
/// 「外接设备」指 `adb devices` 里**没有对应 AVD** 的那类：真机、
/// 或别的方式起来的模拟器。它们没有 config.ini 可读，型号与系统只能问设备本身。
///
/// 取不到就留空：**不拿 serial 或镜像名去凑一个型号**——用户会据此判断
/// 自己在看哪台设备，编一个比留空更糟。
pub fn adb_entry(
    o: &AdbObservation,
    getprop: Option<&std::collections::HashMap<String, String>>,
) -> DeviceEntry {
    // 实测属性优先于 `adb devices -l` 的 `model:`：前者是设备当前真实的
    // 系统属性，后者在部分机型上只是驱动侧填的名字（本机模拟器即不同）。
    let model = getprop
        .and_then(|p| p.get("ro.product.model"))
        .filter(|v| !v.is_empty())
        .or(o.model.as_ref())
        .cloned();
    let release = getprop
        .and_then(|p| p.get("ro.build.version.release"))
        .filter(|v| !v.is_empty());

    let os = release.map(|r| format!("Android {r}"));
    let mut bits = vec!["外接设备（非模拟器）".to_owned()];
    if let Some(abi) = getprop
        .and_then(|p| p.get("ro.product.cpu.abi"))
        .filter(|v| !v.is_empty())
    {
        bits.push(abi.clone());
    }

    DeviceEntry {
        id: o.serial.clone(),
        name: model.unwrap_or_else(|| o.serial.clone()),
        os,
        resolution: o.wm_size.as_deref().and_then(parse_wm_size),
        running: o.state == "device",
        state: o.state.clone(),
        detail: Some(bits.join(" · ")),
        // 外接设备没有「启动」这一步，它的 id 本身就是 serial（即句柄）
        runtime_id: Some(o.serial.clone()),
    }
}

/// 合并「AVD 清单」与「adb 现状」，得到界面要显示的条目列表。
///
/// # 顺序即优先级
///
/// 先列全部 AVD（未启动的也列——用户需要看到自己建了哪些、能启哪几个），
/// 再把**没有对应 AVD 的 adb 设备**追加在后面。顺序稳定，用户切换平台
/// 回来时列表不会重排。
///
/// # 为什么用 `avd_name` 而不是 serial 前缀匹配
///
/// 模拟器的 serial（`emulator-5554`）里的端口**每次启动都可能不同**，
/// 不能反推 AVD。唯一可靠的映射是 `adb -s S emu avd name` 的返回。
/// 若用「把 AVD 名当 serial 猜」，同一台设备会既显示为「运行中」
/// 又多出一行「未启动」——两个条目指着同一台设备。
pub fn build_android_entries(
    avds: &[DeviceEntry],
    obs: &[AdbObservation],
    getprops: &std::collections::HashMap<String, std::collections::HashMap<String, String>>,
) -> Vec<DeviceEntry> {
    let mut out: Vec<DeviceEntry> = Vec::new();

    for avd in avds {
        let mut e = avd.clone();
        if let Some(o) = obs.iter().find(|o| o.avd_name.as_deref() == Some(avd.id.as_str())) {
            e.running = o.state == "device";
            // 状态串原样带出：`offline` / `unauthorized` 与「没启动」的
            // 处置方式不同，界面要能区分（前者是设备连着但连不通）。
            e.state = o.state.clone();
            // 只有 adb 侧真的可用时才给句柄：`offline` 的设备拿 serial 去
            // 截图只会挂到超时，给了反而让界面以为能用。
            if e.running {
                e.runtime_id = Some(o.serial.clone());
            }
        }
        out.push(e);
    }

    for o in obs {
        let known = o
            .avd_name
            .as_deref()
            .is_some_and(|n| avds.iter().any(|a| a.id == n));
        if known {
            continue;
        }
        out.push(adb_entry(o, getprops.get(&o.serial)));
    }

    out
}


///
/// 输入形如：
/// - `system-images/android-TiramisuPrivacySandbox/google_apis_playstore/arm64-v8a/`
/// - `android-30`
/// - `android-UpsideDownCake`
///
/// 输出 `Some("Android 13")`。**认不出来时返回 None**——不猜一个版本号，
/// 那比留空更糟（用户会据此判断兼容性）。
pub fn android_release(sysdir_or_target: &str) -> Option<String> {
    // 先取 `android-<x>` 里的 x（sysdir 是多段路径，取包含 android- 的那段）
    let codename = sysdir_or_target
        .split(['/', '\\'])
        .find_map(|seg| seg.strip_prefix("android-"))
        .or_else(|| sysdir_or_target.strip_prefix("android-"))?
        .trim();
    if codename.is_empty() {
        return None;
    }

    // 纯数字是 API level
    if let Ok(api) = codename.parse::<u32>() {
        return api_to_release(api).map(|v| format!("Android {v}"));
    }

    // 字母代号：去掉后缀（`TiramisuPrivacySandbox` → `Tiramisu`）。
    // 后缀是变体标记（PrivacySandbox / GooglePlay 等），不影响版本。
    let base = ["PrivacySandbox", "GooglePlay", "GoogleApis", "Playstore"]
        .iter()
        .find_map(|suffix| codename.strip_suffix(suffix))
        .unwrap_or(codename);

    codename_to_release(base).map(|v| format!("Android {v}"))
}

/// API level → 版本号（只列有代表性的；查不到返回 None）。
fn api_to_release(api: u32) -> Option<&'static str> {
    Some(match api {
        29 => "10",
        30 => "11",
        31 => "12",
        32 => "12L",
        33 => "13",
        34 => "14",
        35 => "15",
        36 => "16",
        _ => return None,
    })
}

/// Android 版本代号 → 版本号。
fn codename_to_release(name: &str) -> Option<&'static str> {
    Some(match name {
        "Q" => "10",
        "R" => "11",
        "S" => "12",
        "Tiramisu" => "13",
        "UpsideDownCake" => "14",
        "VanillaIceCream" => "15",
        "Baklava" => "16",
        _ => return None,
    })
}

// ── iOS：解析 `simctl list devices --json` ─────────────────────────────

/// 解析 `xcrun simctl list devices --json` 的输出。
///
/// 形状（实测 schema，键是 runtime 标识）：
/// ```json
/// {"devices": {"com.apple.CoreSimulator.SimRuntime.iOS-17-0": [
///   {"name": "iPhone 15 Pro", "udid": "...", "state": "Booted",
///    "deviceTypeIdentifier": "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro"}
/// ]}}
/// ```
///
/// **runtime 键带版本号、设备状态在 `state`**——两者都要取，
/// 因为用户要区分「iPhone 15 Pro 跑 iOS 17.0」与「跑 18.0」。
pub fn parse_simctl_devices(json: &str) -> Vec<DeviceEntry> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(map) = v.get("devices").and_then(|d| d.as_object()) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (runtime, list) in map {
        let os = ios_release(runtime);
        let Some(arr) = list.as_array() else { continue };
        for d in arr {
            let Some(id) = d.get("udid").and_then(|x| x.as_str()) else { continue };
            let name = d.get("name").and_then(|x| x.as_str()).unwrap_or("未命名设备");
            let state = d.get("state").and_then(|x| x.as_str()).unwrap_or("Unknown");
            out.push(DeviceEntry {
                id: id.to_owned(),
                name: name.to_owned(),
                os: os.clone(),
                // simctl 不给分辨率：设备类型的屏幕尺寸要查表，而那张表会随
                // 新机型过期。**留空不编造**——宁可不显示，也不给一个会过时的数字。
                resolution: None,
                running: state == "Booted",
                state: state.to_owned(),
                detail: d
                    .get("deviceTypeIdentifier")
                    .and_then(|x| x.as_str())
                    .map(|s| s.trim_start_matches("com.apple.CoreSimulator.SimDeviceType.").to_owned()),
                // UDID 既是身份也是句柄：`simctl io <udid>` 用它
                runtime_id: Some(id.to_owned()),
            });
        }
    }
    out
}

/// 从 runtime 键推出 iOS 版本名。
///
/// 输入形如 `com.apple.CoreSimulator.SimRuntime.iOS-17-0`
/// → `Some("iOS 17.0")`。
pub fn ios_release(runtime: &str) -> Option<String> {
    let tail = runtime.rsplit('.').next()?;
    let after = tail.strip_prefix("iOS-")?;
    // `17-0` → `17.0`；也可能是 `17-4-1` 这种补丁版本
    let dotted = after.replace('-', ".");
    if dotted.chars().all(|c| c.is_ascii_digit() || c == '.') {
        Some(format!("iOS {dotted}"))
    } else {
        None
    }
}

// ── 鸿蒙：解析 `hdc list targets` ─────────────────────────────────────

/// 解析 `hdc list targets` 的输出。
///
/// 实测输出（本机 hdc 1.2.0a）：
/// ```text
/// [Empty]
/// ```
/// 或每行一个 connect key（设备连接标识）：
/// ```text
/// 7001005458323933328a01b3d5f54500
/// ```
///
/// `[Empty]` 是**字面量**而不是空输出——不识别它就会造出一个 id 为
/// `[Empty]` 的假设备（`parse_adb_devices` 那边踩过同款：adb 的表头行）。
pub fn parse_hdc_targets(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| !l.starts_with('[')) // `[Empty]`
        .map(str::to_owned)
        .collect()
}

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

/// 判断 iOS 侧是否可用，不可用时给出原因与安装指引。
///
/// 只有装了**完整 Xcode** 才有 `simctl`（仅 CommandLineTools 时没有——
/// 本机实测即如此）。不可用时返回原因与安装指引，而不是静默给空列表。
///
/// `developer_dir` 是 `xcode-select -p` 的输出；`simctl_found` 表示
/// 能否解析到 `simctl` 可执行文件。
///
/// 抽成纯函数是为了**能直接测**：本机没有完整 Xcode，真实分支永远走不到，
/// 而「不可用时提示什么」恰恰是大多数用户会看到的那条路径。
pub fn ios_status(developer_dir: &str, simctl_found: bool) -> PlatformStatus {
    if simctl_found {
        return PlatformStatus {
            available: true,
            reason: None,
            tool: Some("xcrun simctl".to_owned()),
            devices: Vec::new(),
            // simctl 能启动/关闭模拟器
            can_launch: true,
            // **simctl 没有任何触摸命令**——这不是漏实现，是工具链的能力缺口。
            // 要写触摸得引入 WebDriverAgent / idb 之类的额外常驻服务，
            // 那是另一个量级的工作，所以 iOS 侧的画面先做成只读。
            can_input: false,
            input_mode: InputMode::None,
            input_hint: Some(
                "iOS 模拟器画面为只读：simctl 不提供触摸注入，需额外部署 WebDriverAgent 才能点击"
                    .to_owned(),
            ),
        };
    }

    let hint = if developer_dir.contains("CommandLineTools") {
        "当前只有命令行工具（CommandLineTools），没有完整 Xcode，因此没有 simctl"
    } else if developer_dir.trim().is_empty() {
        "未检测到 Xcode 开发者目录"
    } else {
        "已安装的开发者目录里没有 simctl"
    };
    // ⚠️ 提示里**不写死路径**。曾经的文案是
    // `sudo xcode-select -s /Applications/Xcode.app`——而把 Xcode 装在外置卷
    // 或改过名的用户照做会失败（本机 `/Applications` 下就没有 Xcode）。
    // 改为说明两种解法，并指向本面板的自定义路径：那是唯一对任何安装位置
    // 都成立的做法。
    PlatformStatus::unavailable(format!(
        "{hint}。两种解法：① 装完整 Xcode 后执行 `sudo xcode-select -s <你的 Xcode.app>/Contents/Developer`；\
         ② 若 Xcode 已装在别处（外置卷、改名），在本面板的「自定义路径」里直接指定它——\
         那不会改动系统设置。"
    ))
}

/// 探测鸿蒙侧：工具是否装、有没有设备连着。
///
/// `hdc` 随 DevEco Studio / HarmonyOS SDK 安装，本机在
/// `~/Library/Huawei/Sdk/openharmony/<api>/toolchains/hdc`（实测 1.2.0a）。
///
/// # 两个能力位的依据
///
/// - `can_launch: false`：鸿蒙**没有独立的模拟器启动器**。本机 SDK 里有
///   `system-image/HarmonyOS-NEXT-DB1/phone_arm/`（镜像在），但启动它的
///   命令在 DevEco Studio 内部，命令行没有对应入口。因此这里不给「启动」
///   按钮，而不是给一个点了会失败的按钮。
/// - `can_input: false`：`uinput` 注入**未在真机验证**。宁可先只读——
///   渲染一个可点但实际不生效的画面，比明说「暂不支持」更糟。
pub fn harmony_status(hdc_found: bool, targets: &[String], tool: Option<&str>) -> PlatformStatus {
    if !hdc_found {
        return PlatformStatus::unavailable(
            "未找到 hdc（鸿蒙设备连接器）。安装 DevEco Studio 并配置 HarmonyOS SDK 后即可使用。",
        );
    }

    let devices = targets
        .iter()
        .map(|key| DeviceEntry {
            id: key.clone(),
            // connect key 是 32 位十六进制，直接显示没有任何可读性。
            // 型号要连上设备后用 `param get` 查——未验证，所以**不在这里编造**。
            name: format!("鸿蒙设备 {}", short_key(key)),
            os: Some("HarmonyOS".to_owned()),
            resolution: None,
            running: true,
            state: "connected".to_owned(),
            detail: None,
            // connect key 既是身份也是句柄（`hdc -t <key>`）
            runtime_id: Some(key.clone()),
        })
        .collect();

    PlatformStatus {
        available: true,
        reason: None,
        tool: tool.map(str::to_owned),
        devices,
        can_launch: false,
        can_input: false,
        input_mode: InputMode::None,
        input_hint: Some(
            "鸿蒙的触摸注入（uinput）尚未在真机上验证；当前画面为只读，验证通过后即可开启"
                .to_owned(),
        ),
    }
}

/// connect key 太长，列表里只显示首尾（够区分多台设备，又不撑破布局）。
pub fn short_key(key: &str) -> String {
    let n = key.chars().count();
    if n <= 12 {
        return key.to_owned();
    }
    let head: String = key.chars().take(8).collect();
    let tail: String = key.chars().skip(n - 4).collect();
    format!("{head}…{tail}")
}

/// 探测小程序侧。
///
/// 小程序的「模拟器」不是一个独立设备，而是微信开发者工具窗口里的一块
/// 渲染区。因此这里只报告两件事：工具是否安装、以及**为什么还不能取画面**。
///
/// 不做「假装有设备」的空列表：没装时给安装指引，装了但自动化未接入时
/// 也如实说明——两者对用户的下一步动作不同，糊成一句「不可用」等于让他
/// 自己去猜。
pub fn miniprogram_status(devtools_found: bool) -> PlatformStatus {
    miniprogram_status_with(devtools_found, None, ToolSource::Discovered)
}

/// 同上，但带上「工具在哪、怎么找到的」。
///
/// 分开是为了让测试仍能只传一个布尔（`miniprogram_status`），
/// 而探测路径额外把**路径与来源**交给界面——用户装了多份开发者工具、
/// 或装在非默认位置时，这是唯一能解释「它检测到的是哪一个」的线索。
pub fn miniprogram_status_with(
    devtools_found: bool,
    tool_at: Option<&Path>,
    source: ToolSource,
) -> PlatformStatus {
    if !devtools_found {
        return PlatformStatus::unavailable(
            "未找到微信开发者工具。小程序模拟器由它提供（不是独立设备）：\
             从 https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html \
             安装后即可在其中的「模拟器」区域预览；\
             若它装在非默认位置（外置卷、改名），可在本面板的「自定义路径」里直接指定。",
        );
    }
    let mut st = PlatformStatus::unavailable(
        "已安装微信开发者工具，但取画面尚未接入。小程序模拟器是开发者工具窗口内的\
         渲染区（不是独立进程），取画面需要在工具里开启「设置 → 安全设置 → 服务端口」\
         后由 CLI 建立自动化会话；这一步尚未实现。",
    );
    st.tool = tool_at.map(|p| {
        let shown = p.display().to_string();
        match source {
            ToolSource::Override => format!("{shown}（手动指定）"),
            _ => format!("{shown}（自动发现）"),
        }
    });
    st
}

/// 小程序状态的完整形态：工具 + 项目 + 自动化就绪度。
///
/// # 三态如实区分（这是本函数存在的理由）
///
/// 1. **没装工具** → 给下载指引；
/// 2. **装了工具、但自动化未就绪**（未启动或端口未开）→ 说明怎么启动；
/// 3. **就绪** → 可用，并给出当前项目路径。
///
/// 合成一句「不可用」会把三种截然不同的下一步动作糊在一起：
/// 第一种要装东西，第二种要开开关，第三种什么都不用做。
pub fn miniprogram_status_full(
    tool: &Path,
    source: ToolSource,
    project: Option<&Path>,
    ready: bool,
) -> PlatformStatus {
    let tool_label = match source {
        ToolSource::Override => format!("{}（手动指定）", tool.display()),
        _ => format!("{}（自动发现）", tool.display()),
    };

    if !ready {
        return PlatformStatus {
            available: false,
            reason: Some(
                "微信开发者工具已安装，但自动化服务未启动。本应用需要它来取画面与点击——\
                 因为小程序模拟器是开发者工具窗口内的一块渲染区，不是独立进程。\n\
                 启动方式：下面点「启动自动化」，或手动执行 \
                 `bash scripts/miniprogram-auto.sh`。"
                    .to_owned(),
            ),
            tool: Some(tool_label),
            devices: Vec::new(),
            can_launch: false,
            // **能做元素级点击**（实测：Element.tap 可用），但不能按坐标。
            can_input: true,
            input_mode: InputMode::Element,
            input_hint: Some(
                "小程序的输入是**元素级**：只能点下方列出的元素，不能点画面任意位置\
                 （自动化接口不返回元素坐标）。"
                    .to_owned(),
            ),
        };
    }

    // 就绪：把当前项目做成一个「设备」条目——它就是被模拟的那个小程序。
    let devices = project.map_or_else(Vec::new, |p| {
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| p.display().to_string());
        vec![DeviceEntry {
            id: p.display().to_string(),
            name,
            os: Some("小程序".to_owned()),
            resolution: None,
            running: true,
            state: "running".to_owned(),
            detail: Some(p.display().to_string()),
            runtime_id: Some(p.display().to_string()),
        }]
    });

    PlatformStatus {
        available: true,
        reason: project.is_none().then(|| {
            "自动化服务已就绪，但未能确定当前打开的项目。\
             可在「自定义工具路径 → 小程序项目」里直接指定项目目录。"
                .to_owned()
        }),
        tool: Some(tool_label),
        devices,
        // 启动/关闭由开发者工具管理，不给按钮（与鸿蒙同理）
        can_launch: false,
        can_input: true,
        input_mode: InputMode::Element,
        input_hint: Some(
            "小程序的输入是**元素级**：只能点下方列出的元素，不能点画面任意位置\
             （自动化接口不返回元素坐标）。"
                .to_owned(),
        ),
    }
}

/// 把界面坐标换算成设备坐标。/// 把界面坐标换算成设备坐标。
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

/// 当前生效的 override（进程级）。
///
/// # 为什么用全局而不是逐层传参
///
/// 这些路径被约 10 个函数用到（探测、启动、停止、取帧、触摸、截图），
/// 逐层传参要给每个签名都加一个参数、并改所有调用点——而它是**进程级的
/// 配置**（一个用户在设置里指定一次，全部生效），不存在「同一进程里
/// 两套不同 override」的真实需求。
///
/// 用 `Mutex` 而不是 `OnceLock`：用户改设置后要能立刻生效。
static OVERRIDES: std::sync::Mutex<Option<ToolOverrides>> = std::sync::Mutex::new(None);

/// 设置 override（由宿主层在读取设置文件、以及用户保存时调用）。
pub fn set_overrides(ov: ToolOverrides) {
    *OVERRIDES.lock().unwrap_or_else(|e| e.into_inner()) = Some(ov.normalized());
}

/// 当前 override（未设置时全为 `None`，即纯自动发现）。
fn overrides() -> ToolOverrides {
    OVERRIDES
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_default()
}

/// override 文件的路径（`<app_data>/tool-paths.json`）。
///
/// 放应用数据目录而不是 `CODEX_HOME`：这是**我们自己的**配置（与 codex 无关），
/// 混进 codex 的目录会让「哪些是上游状态、哪些是我们的」变模糊。
pub fn overrides_path(app_data: &Path) -> PathBuf {
    app_data.join("tool-paths.json")
}

/// 从磁盘读 override 并设为当前生效值。文件不存在或损坏时用空值。
///
/// **不因损坏而报错**：一份坏掉的配置文件不该让整个模拟器面板不可用——
/// 那会让用户连「哪里坏了」都看不到。退回自动发现，用户仍能用，
/// 而清空设置重新指定即可。
pub fn load_overrides(app_data: &Path) -> ToolOverrides {
    let p = overrides_path(app_data);
    let ov = std::fs::read_to_string(&p)
        .ok()
        .and_then(|t| serde_json::from_str::<ToolOverrides>(&t).ok())
        .unwrap_or_default()
        .normalized();
    set_overrides(ov.clone());
    ov
}

/// 保存 override 并立即生效。
///
/// 立即调 `set_overrides` 而不是等下次启动：用户点「保存」后通常会立刻点
/// 「重新检测」，那时必须已生效，否则他会以为保存失败。
pub fn save_overrides(app_data: &Path, ov: ToolOverrides) -> Result<ToolOverrides, String> {
    let ov = ov.normalized();
    let p = overrides_path(app_data);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let text = serde_json::to_string_pretty(&ov).map_err(|e| format!("序列化设置失败：{e}"))?;
    std::fs::write(&p, text).map_err(|e| format!("写入 {} 失败：{e}", p.display()))?;
    set_overrides(ov.clone());
    Ok(ov)
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

// ── 开发者工具路径：自动发现 + 手动兜底 ─────────────────────────────────

/// 开发者**手动指定**的工具路径（兜底）。
///
/// # 为什么必须有手动兜底
///
/// 自动发现只能覆盖「常见位置 + 常见命名」。实测踩到两类漏网，且都不是
/// 罕见用法：
///
/// 1. **装在外置卷**：本机 Xcode 在
///    `/Volumes/data1/applications/Xcode.app`、微信开发者工具在
///    `/Volumes/data1/applications/wechatwebdevtools.app`，
///    而固定的 `/Applications` 下一个都找不到。
/// 2. **改过名字**：同一台机器上微信开发者工具有两种目录名
///    （`wechatwebdevtools.app` 与 `微信开发者工具（NWJS）.app`）。
///
/// 任何自动搜索都会漏（命名约定会变、卷会挂载在不同的地方），
/// 所以最终必须能让人**直接指定**。发现失败时的提示会指向这里。
///
/// 存于 `app_data/tool-paths.json`，缺失即全为 `None`（不写默认值，
/// 这样「文件不存在」与「用户清空了某一项」可以区分）。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ToolOverrides {
    /// Android SDK 目录（其下应有 `platform-tools/adb`）。
    pub android_sdk: Option<String>,
    /// **Xcode.app 本身**（不是 `Contents/Developer` 那一层——由我们推导，
    /// 让用户填的东西与他在访达里看到的一致）。
    pub xcode: Option<String>,
    /// HarmonyOS SDK 目录（其下应有 `openharmony/<版本>/toolchains/hdc`）。
    pub harmony_sdk: Option<String>,
    /// 微信开发者工具 `.app`。
    pub miniprogram: Option<String>,
    /// **小程序项目目录**（其下应有 `project.config.json`）。
    ///
    /// 与工具路径分开：工具是「用哪个程序」，项目是「模拟哪个小程序」。
    /// 不指定时会尝试从开发者工具的日志里推断当前打开的项目——那条路
    /// 是便利而非保证（日志格式随版本可能变），所以必须能手动兜底。
    pub miniprogram_project: Option<String>,
}

impl ToolOverrides {
    /// 去掉空白项：界面清空输入框时传 `""`，语义应等同「未设置」。
    ///
    /// 不这么做的话，`Some("")` 会被当成一个有效路径去 join，得到相对路径
    /// ——表现为「明明清空了却还是找不到工具」，且不报错。
    pub fn normalized(mut self) -> Self {
        fn clean(v: Option<String>) -> Option<String> {
            v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
        }
        self.android_sdk = clean(self.android_sdk);
        self.xcode = clean(self.xcode);
        self.harmony_sdk = clean(self.harmony_sdk);
        self.miniprogram = clean(self.miniprogram);
        self.miniprogram_project = clean(self.miniprogram_project);
        self
    }

    /// 是否设了任何一项（界面据此显示「已自定义」标记）。
    pub fn any_set(&self) -> bool {
        self.android_sdk.is_some()
            || self.xcode.is_some()
            || self.harmony_sdk.is_some()
            || self.miniprogram.is_some()
            || self.miniprogram_project.is_some()
    }
}

/// 一个工具路径的**来源**，用于在界面上说清「为什么用的是这个」。
///
/// 三种来源的处置完全不同：手动指定错了要改设置；自动发现的可能不是
/// 用户想要的那一份（机器上装了两个 Xcode 时）；系统选中项的改动是
/// 全局的、不该被我们悄悄改。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolSource {
    /// 开发者手动指定（优先级最高）。
    Override,
    /// 环境变量（如 `ANDROID_HOME`、`HDC_HOME`）。
    Env,
    /// 约定位置或自动扫描发现。
    Discovered,
    /// 系统当前选中（仅 Xcode：`xcode-select -p`）。
    Selected,
}

/// 一条已解析的工具路径。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTool {
    pub path: String,
    pub source: ToolSource,
}

/// 名字是否像 Xcode。
///
/// 子串 `xcode` + 后缀 `.app`：覆盖 `Xcode.app` 与 `Xcode-beta.app`。
/// **不能**只判全等——beta 版与改名后的副本都会被漏掉。
pub fn matches_xcode_app(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with("xcode") && n.ends_with(".app")
}

/// 名字是否是微信开发者工具。
///
/// **必须容忍命名变体**：本机实测同时存在 `wechatwebdevtools.app` 与
/// `微信开发者工具（NWJS）.app` 两种目录名（后者带后缀括号）。
///
/// ⚠️ **不能放宽到「任何 *开发者工具」**：本机还装着支付宝的
/// `小程序开发者工具.app`（`com.ant.miniprogram`）与京东的
/// `jdvappdevtools.app`——它们名字里都带「开发者工具」，但都不是微信的。
/// 认错了会让用户以为检测到了自己的工具，实际调的是别家。
pub fn matches_miniprogram_app(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("wechatwebdevtools") || name.contains("微信开发者工具")
}

/// 目录名是否是一个「应用目录」（放 `.app` 的目录）。
///
/// 实测的三种写法都要认：`Applications`、`applications`（外置卷上常见
/// Linux 风格小写）、`office-applications`（自建目录）。
fn is_applications_dir(name: &str) -> bool {
    name.to_lowercase().contains("applications")
}

/// 列出目录下的子目录路径（不存在或不可读时给空表，不报错）。
fn subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect()
}

/// 可能存放 `.app` 的应用目录。
///
/// # 为什么要扫外置卷（实测需求）
///
/// 开发者的工具装在外置盘上（本机即如此），固定的 `/Applications` 找不到。
/// 扫描深度刻意限制：只在每个卷下找**名字带 `applications` 的目录**，
/// 最多两层。这样两种实测布局都能覆盖：
///
/// ```text
/// /Volumes/data1/applications/Xcode.app              ← 卷下第一层
/// /Volumes/data1/work/office-applications/Xcode.app   ← 卷下第二层
/// ```
///
/// 不遍历整盘：`/Volumes` 下可能有几十万个文件的大目录，而这里只需要
/// 知道「哪些目录里放应用」。实测本机 5 个卷耗时约 40ms。
fn app_roots() -> Vec<PathBuf> {
    // 标准位置优先：用户**没改过任何东西**时应该命中这里。
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }

    let mut extra: Vec<PathBuf> = Vec::new();
    for vol in subdirs(Path::new("/Volumes")) {
        // 跳过启动卷：它的 `/Applications` 就是上面第一项，
        // 而 `System/Applications` 里全是系统自带应用（不可能是开发工具）。
        // 不跳的代价是白读几百个目录项，且会把系统卷排到用户卷前面。
        let is_boot = std::fs::symlink_metadata(&vol)
            .map(|m| {
                use std::os::unix::fs::MetadataExt;
                // 启动卷在 macOS 上通常是 `/` 的同一设备
                let root_dev = std::fs::metadata("/").map(|r| r.dev()).unwrap_or(0);
                m.dev() == root_dev
            })
            .unwrap_or(false);
        if is_boot {
            continue;
        }
        // 卷根下直接叫 Applications 的
        for sub in subdirs(&vol) {
            let name = sub.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if is_applications_dir(&name) {
                extra.push(sub.clone());
            }
            // 再下一层（`<卷>/work/office-applications` 这类自建布局）
            for sub2 in subdirs(&sub) {
                let n2 = sub2.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                if is_applications_dir(&n2) {
                    extra.push(sub2);
                }
            }
        }
    }

    // **确定性**：`read_dir` 的顺序不保证稳定，而这里有多个候选时
    // 「选哪个」会直接影响结果——本机装了两份可用的 Xcode，实测两次运行
    // 就可能选到不同那份（版本也可能不同）。排序让它可复现。
    extra.sort();
    roots.append(&mut extra);

    roots.retain(|p| p.is_dir());
    roots.dedup();
    roots
}

/// 「应用目录」扫描结果的缓存。
///
/// # 为什么缓存
///
/// 扫描约 40ms（本机 5 个卷），而 iOS 取帧轮询是 **600ms 一次**——
/// 每帧都扫是不可接受的。缓存后只有在首次调用与用户点「重新检测」时扫描。
///
/// 用 `Mutex<Option<_>>` 而不是 `OnceLock`：需要能失效（新插了移动硬盘时
/// 用户会点重新检测，那时应该真的重扫）。
static APP_ROOTS: std::sync::Mutex<Option<Vec<PathBuf>>> = std::sync::Mutex::new(None);

fn app_roots_cached() -> Vec<PathBuf> {
    let mut guard = APP_ROOTS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(v) = guard.as_ref() {
        return v.clone();
    }
    let v = app_roots();
    *guard = Some(v.clone());
    v
}

/// 让下一次扫描重新读盘（用户点「重新检测」时调用）。
pub fn invalidate_app_roots() {
    *APP_ROOTS.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// 在应用目录里找**所有**名字匹配且通过校验的 `.app`（顺序稳定）。
///
/// 返回全部而不是第一个：装了多份同类工具时（本机就有两份 Xcode）
/// 「沉默地挑了其中一个」等于让用户面对一个无法解释的选择——界面上
/// 需要能看到还有别的候选，并用自定义路径指定想用哪一份。
pub fn find_apps(matches: impl Fn(&str) -> bool, verify: impl Fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for root in app_roots_cached() {
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        let mut found: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                p.is_dir() && matches(&name)
            })
            .collect();
        // 目录内的顺序不保证稳定，排序让结果可复现（同一台机器每次给同一个）
        found.sort();
        out.extend(found.into_iter().filter(|p| verify(p)));
    }
    out
}

/// 只取第一个候选（不需要告知「还有别的」时用）。
pub fn find_app(matches: impl Fn(&str) -> bool, verify: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    find_apps(matches, verify).into_iter().next()
}

/// 由 `Xcode.app` 推导开发者目录（`Contents/Developer`）。
///
/// 纯函数：界面让用户填的是他在访达里看到的那个 `.app`，
/// 而 `xcrun` 需要的是里层目录——这个转换只该有一处。
pub fn xcode_developer_dir(app: &Path) -> PathBuf {
    app.join("Contents").join("Developer")
}

/// `Xcode.app` 里是否真有可用的 simctl。
///
/// 只判 `.app` 存在是不够的：残包、仅有壳的副本、下载中断的安装都会
/// 「存在但不可用」，那时给出「已找到 Xcode」比找不到更误导。
fn xcode_is_usable(app: &Path) -> bool {
    xcode_developer_dir(app).join("usr").join("bin").join("simctl").is_file()
}

// ── 命令层（实际执行外部工具）──────────────────────────────────────────

use std::process::Stdio;
use tokio::process::Command;

/// 单条命令的超时上限。
///
/// **必须有**：`adb` 在设备 offline 时不会失败，而是**一直阻塞**
/// （等设备回来）。没有超时的话界面会永远转圈，而用户不知道在等什么。
/// 3 秒对本地 adb 足够（实测 `screencap` 单帧 350ms）。
///
/// ⚠️ **不适用于 `simctl`**——见 `SIMCTL_TIMEOUT`。
const CMD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

/// `xcrun simctl` 的超时上限：**必须比 3 秒宽松得多**。
///
/// # 为什么单独一个常量（实测数字）
///
/// `simctl` 首次调用要启动 CoreSimulatorService，冷启动实测：
///
/// | 情形 | 耗时 |
/// |---|---|
/// | 冷启动（服务未起） | **4.2 s** |
/// | 第二次 | 1.4 s |
/// | 其后 | 0.3 s |
///
/// 用 3 秒的 `CMD_TIMEOUT` 时，**冷启动那次必然超时**，而超时被吞成
/// 「没有设备」——界面表现为「iOS 可用但设备列表是空的」，看起来像检测
/// 逻辑坏了，实际只是阈值太紧。这个坑是把 iOS 工具链接通后才暴露的：
/// 在此之前 iOS 根本不可用，所以从没跑到这一步。
///
/// 取 30 秒：远大于冷启动的 4.2 秒（给更慢的机器与更多设备留余量），
/// 又远小于「永久阻塞」——真挂住时用户等半分钟拿到明确报错，好过一直转圈。
const SIMCTL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

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
/// 顺序：**手动指定** → 环境变量 → 约定位置（`~/Library/Android/sdk` 等）
/// → 外置卷里的 Android SDK 候选目录。
///
/// 最后一步是为「把 SDK 装在外置盘」准备的：只在前面都落空时才扫，
/// 因此常规机器上不会付这份成本。
fn android_sdk() -> Option<(PathBuf, ToolSource)> {
    let ov = overrides();
    let ok = |p: &Path| p.join("platform-tools").join("adb").exists();

    if let Some(p) = ov.android_sdk.as_ref().map(PathBuf::from) {
        // 手动指定的**不静默回退**：填错了要明确报出来（在 probe 里），
        // 否则用户会以为自己填的生效了、实际用的是别处那个。
        return Some((p, ToolSource::Override));
    }

    let mut env_cands: Vec<PathBuf> = vec![];
    for var in ["ANDROID_HOME", "ANDROID_SDK_ROOT"] {
        if let Ok(v) = std::env::var(var) {
            if !v.trim().is_empty() {
                env_cands.push(PathBuf::from(v));
            }
        }
    }
    if let Some(p) = env_cands.into_iter().find(|p| ok(p)) {
        return Some((p, ToolSource::Env));
    }

    let mut fixed: Vec<PathBuf> = vec![];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        fixed.push(home.join("Library/Android/sdk"));
        fixed.push(home.join("Android/Sdk"));
    }
    if let Some(p) = fixed.into_iter().find(|p| ok(p)) {
        return Some((p, ToolSource::Discovered));
    }

    // 外置卷：名字像 SDK 且确实含 platform-tools/adb 的目录
    let found = find_app(
        |name| {
            let n = name.to_lowercase();
            n.contains("android") && !n.ends_with(".app")
        },
        |p| ok(p),
    );
    found.map(|p| (p, ToolSource::Discovered))
}

/// adb 路径（找不到 SDK 时回退到 PATH 上的常见位置）。
fn adb_path() -> Option<PathBuf> {
    if let Some((sdk, _)) = android_sdk() {
        let p = sdk.join("platform-tools").join("adb");
        if is_executable(&p) {
            return Some(p);
        }
    }
    first_executable(&["/opt/homebrew/bin/adb", "/usr/local/bin/adb"], is_executable)
}

fn emulator_path() -> Option<PathBuf> {
    let (sdk, _) = android_sdk()?;
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
    cmd.args(args);
    run_command(cmd, timeout).await
}

/// 命令执行的实际实现（`run_stdout` 与 `run_xcrun` 共用）。
async fn run_command(mut cmd: Command, timeout: std::time::Duration) -> Result<String, String> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let shown = format!("{:?}", cmd.as_std().get_program());
    let fut = cmd.output();
    match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(out)) if out.status.success() => {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        }
        Ok(Ok(out)) => {
            let err = String::from_utf8_lossy(&out.stderr);
            Err(format!("{shown} 退出码 {:?}：{}", out.status.code(), err.trim()))
        }
        Ok(Err(e)) => Err(format!("执行 {shown} 失败：{e}")),
        Err(_) => Err(format!(
            "{shown} 超过 {} 秒未返回（设备可能无响应）",
            timeout.as_secs()
        )),
    }
}

/// 跑一条 `xcrun ...`，带上解析出的 `DEVELOPER_DIR`。
///
/// # 为什么注入环境变量而不是改 `xcode-select`
///
/// `xcode-select -s` 改的是**系统全局**状态，影响用户所有构建工具；
/// 而且一旦 Xcode 装在外置卷上、卷没挂载，其它工具会连带一起坏
/// （报错的现场与根因隔了一层，极难排查）。`DEVELOPER_DIR` 只作用于
/// **本进程启动的这个子进程**，这正是我们需要的边界。
///
/// `dev_dir` 为 `None` 时不给环境变量——那表示系统当前选中的那份本身可用。
async fn run_xcrun(
    dev_dir: Option<&Path>,
    args: &[&str],
    timeout: std::time::Duration,
) -> Result<String, String> {
    let mut cmd = Command::new("/usr/bin/xcrun");
    cmd.args(args);
    if let Some(d) = dev_dir {
        cmd.env("DEVELOPER_DIR", d);
    }
    run_command(cmd, timeout).await
}

/// iOS 工具链的解析结果。
struct IosToolchain {
    /// 要注入子进程的 `DEVELOPER_DIR`；`None` = 系统当前选中的那份即可用。
    developer_dir: Option<PathBuf>,
    /// 是否已确认 `simctl` 可用。
    simctl: bool,
    /// 当前开发者目录（给界面展示）。
    dev_dir_display: Option<String>,
    /// 这份工具链是怎么来的（给界面展示）。
    note: String,
}

/// 解析 iOS 工具链：手动指定 → 系统选中 → 自动发现。
///
/// # 为什么不缓存
///
/// 一次解析要跑 `xcode-select -p`（约 10ms）与一次应用目录扫描
/// （首次约 40ms，其后走缓存）。它只在 iOS 的探测/取帧路径上，取帧间隔
/// 600ms——10ms 是 1.7%，换来的是**改设置立刻生效**，且没有「缓存过期」
/// 这类只在换工具时才显形的问题。
async fn resolve_ios() -> IosToolchain {
    let ov = overrides();
    // ① 手动指定：最高优先级。**即使不可用也不回退**——填错了要明确报出来
    //    （静默换成另一份会让用户以为设置生效了，那是最难查的一类）。
    if let Some(p) = ov.xcode.as_deref() {
        let dir = xcode_developer_dir(Path::new(p));
        let ok = dir.join("usr").join("bin").join("simctl").is_file();
        return IosToolchain {
            developer_dir: Some(dir.clone()),
            simctl: ok,
            dev_dir_display: Some(dir.display().to_string()),
            note: if ok {
                format!("手动指定 {p}")
            } else {
                format!("手动指定的 Xcode 里没有 simctl：{p}")
            },
        };
    }

    // ② 系统当前选中的（`xcode-select -p`）。
    let selected = run_stdout(Path::new("/usr/bin/xcode-select"), &["-p"], CMD_TIMEOUT)
        .await
        .unwrap_or_default();
    let selected = selected.trim().to_owned();
    if !selected.is_empty() && Path::new(&selected).join("usr/bin/simctl").is_file() {
        return IosToolchain {
            developer_dir: None,
            simctl: true,
            dev_dir_display: Some(selected),
            note: "系统选中".to_owned(),
        };
    }

    // ③ 自动发现：只在系统那份不可用时才找。若为「已选中且可用」的情况
    //    去翻别的 Xcode，反而可能用上一份与用户系统设置不同的版本。
    let candidates = find_apps(matches_xcode_app, xcode_is_usable);
    if let Some(app) = candidates.first() {
        let dir = xcode_developer_dir(app);
        // 多个候选时把数量说出来：本机有两份 Xcode，静默选一个会让人
        // 在别的界面看到不一致的版本却找不到原因。自定义路径可指定。
        let note = if candidates.len() > 1 {
            format!("自动发现 {}（共 {} 份，可在自定义路径里指定）", app.display(), candidates.len())
        } else {
            format!("自动发现 {}", app.display())
        };
        return IosToolchain {
            developer_dir: Some(dir.clone()),
            simctl: true,
            dev_dir_display: Some(dir.display().to_string()),
            note,
        };
    }

    IosToolchain {
        developer_dir: None,
        simctl: false,
        dev_dir_display: if selected.is_empty() { None } else { Some(selected) },
        note: String::new(),
    }
}

/// 探测本机模拟器可用性。
pub async fn probe() -> SimulatorStatus {
    // 探测时让应用目录扫描重来一遍：用户点「重新检测」最可能的情形正是
    // **刚插上装了工具的移动硬盘**，或刚把工具拖到新位置。缓存只服务于
    // 取帧轮询（600ms 一次，每次重扫 40ms 会明显拖累）。
    invalidate_app_roots();
    SimulatorStatus {
        android: probe_android().await,
        ios: probe_ios().await,
        harmony: probe_harmony().await,
        miniprogram: probe_miniprogram().await,
    }
}

/// AVD 的配置文件名（`<avd>.avd/config.ini`）。
///
/// 位置是 Android 工具链的既定约定：`$ANDROID_AVD_HOME` 或 `~/.android/avd`。
/// 环境变量优先——CI 与自定义 SDK 安装会把 AVD 放在别处。
fn avd_home() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("ANDROID_AVD_HOME") {
        if !v.trim().is_empty() {
            return Some(PathBuf::from(v));
        }
    }
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".android").join("avd"))
}

/// 读一个 AVD 的 config.ini。读不到返回 None（条目仍然显示，只是信息少）。
///
/// 同步读文件而非 async：文件不到 2KB，且一次探测最多读几个——
/// 为此引入 async 文件 API 不值得。
fn read_avd_config(avd: &str) -> Option<String> {
    let p = avd_home()?.join(format!("{avd}.avd")).join("config.ini");
    std::fs::read_to_string(p).ok()
}

async fn probe_android() -> PlatformStatus {
    let ov = overrides();
    // 手动指定的路径填错时要明确报出来。静默回退会让用户以为设置生效了，
    // 而实际用的是别处那个 SDK——那是最难排查的一类（界面看着正常）。
    if let Some(p) = ov.android_sdk.as_deref() {
        let sdk = PathBuf::from(p);
        if !sdk.join("platform-tools").join("adb").exists() {
            return PlatformStatus::unavailable(format!(
                "指定的 Android SDK 目录里没有 platform-tools/adb：{p}\n\
                 请指向 SDK 根目录（其下应有 platform-tools/、emulator/），而不是 platform-tools 本身。"
            ));
        }
    }

    let (emulator, adb) = (emulator_path(), adb_path());
    let (Some(emu), Some(adb_bin)) = (emulator, adb) else {
        let missing = match (emulator_path().is_some(), adb_path().is_some()) {
            (false, false) => "未找到 Android SDK 的 emulator 与 adb",
            (false, true) => "未找到 emulator（Android SDK 的 emulator 组件未安装）",
            _ => "未找到 adb（Android SDK 的 platform-tools 未安装）",
        };
        return PlatformStatus::unavailable(format!(
            "{missing}。安装 Android Studio 或在 SDK Manager 中补齐 platform-tools 与 emulator 后即可使用；\
             若 SDK 装在非默认位置，可在本面板的「自定义路径」里直接指定。"
        ));
    };

    let avd_names = run_stdout(&emu, &["-list-avds"], CMD_TIMEOUT)
        .await
        .map(|o| parse_avds(&o))
        .unwrap_or_default();

    // AVD 条目：身份取 config.ini（用户自己选的机型，稳定不随启停变化）。
    let avds: Vec<DeviceEntry> = avd_names
        .iter()
        .map(|name| avd_info(name, &read_avd_config(name).unwrap_or_default()))
        .collect();

    let devices = run_stdout(&adb_bin, &["devices", "-l"], CMD_TIMEOUT)
        .await
        .map(|o| parse_adb_devices(&o))
        .unwrap_or_default();

    // 逐台补身份信息。
    //
    // 顺序而非并发：正常环境下这里最多一两台设备（本机实测 1 台），
    // 每个调用 20–30ms；为它引入并发原语（并要处理部分失败）不划算。
    // 但只在**设备可用**时才问：`offline` / `unauthorized` 的设备上
    // 这些命令会一直挂到超时，把整次探测拖慢三秒。
    let mut obs: Vec<AdbObservation> = Vec::new();
    let mut getprops = std::collections::HashMap::new();
    for d in &devices {
        let mut o = AdbObservation {
            serial: d.serial.clone(),
            state: d.state.clone(),
            model: d.model.clone(),
            ..Default::default()
        };
        if d.state == "device" {
            if d.serial.starts_with("emulator-") {
                o.avd_name = run_stdout(
                    &adb_bin,
                    &["-s", &d.serial, "emu", "avd", "name"],
                    CMD_TIMEOUT,
                )
                .await
                .ok()
                .and_then(|out| parse_emu_avd_name(&out));
            } else {
                // 外接设备（真机 / 第三方模拟器）：没有 config.ini，
                // 型号与系统只能问设备本身。
                if let Ok(out) =
                    run_stdout(&adb_bin, &["-s", &d.serial, "shell", "getprop"], CMD_TIMEOUT).await
                {
                    getprops.insert(d.serial.clone(), parse_getprop(&out));
                    o.getprop = Some(out);
                }
                o.wm_size = run_stdout(&adb_bin, &["-s", &d.serial, "shell", "wm", "size"], CMD_TIMEOUT)
                    .await
                    .ok();
            }
        }
        obs.push(o);
    }

    let android_src = android_sdk().map(|(_, s)| s);
    PlatformStatus {
        available: true,
        reason: None,
        tool: Some(match android_src {
            // 来源写进 tool：多份 SDK 并存时，这是唯一能看出
            // 「为什么用的是这一个」的线索（与 iOS 侧同一做法）。
            Some(ToolSource::Override) => format!("{} + {}（手动指定）", emu.display(), adb_bin.display()),
            _ => format!("{} + {}", emu.display(), adb_bin.display()),
        }),
        devices: build_android_entries(&avds, &obs, &getprops),
        can_launch: true,
        can_input: true,
        input_mode: InputMode::Coordinate,
        input_hint: None,
    }
}

async fn probe_ios() -> PlatformStatus {
    let ov = overrides();
    let tc = resolve_ios().await;
    let mut st = ios_status(tc.dev_dir_display.as_deref().unwrap_or(""), tc.simctl);
    if !tc.simctl {
        // 手动指定的路径失效时，指名道姓说清是哪个路径——否则用户会去
        // 折腾系统设置，而他真正要改的是自己刚填的那一项。
        if ov.xcode.is_some() {
            st.reason = Some(format!(
                "{}。可在本面板的「自定义路径」里改正，或清空它改用自动检测。",
                tc.note
            ));
        }
        return st;
    }

    // 把「用的是哪一份 Xcode」写进 tool：多份 Xcode 并存（或系统选中的是
    // CommandLineTools 而我们自动找到了外置卷上的 Xcode）时，这是唯一能
    // 解释「为什么它能用」的线索。
    st.tool = Some(if tc.note.is_empty() {
        "xcrun simctl".to_owned()
    } else {
        format!("xcrun simctl（{}）", tc.note)
    });

    // 设备清单。`--json` 而不是默认的表格输出：表格的列因 Xcode 版本而变，
    // 而 JSON 的键（udid/state/name）是稳定的。
    if let Ok(out) = run_xcrun(
        tc.developer_dir.as_deref(),
        &["simctl", "list", "devices", "--json"],
        SIMCTL_TIMEOUT,
    )
    .await
    {
        st.devices = parse_simctl_devices(&out);
    }
    st
}

/// 找 hdc 可执行文件（鸿蒙设备连接器）。
///
/// 顺序：**手动指定** → `HDC_HOME` → 约定位置 → 外置卷上的 HarmonyOS SDK。
///
/// 位置随 SDK 版本变化（`openharmony/<api>/toolchains/hdc`），因此
/// **枚举一层目录**找 `toolchains/hdc`，而不是写死某个 API 版本号——
/// 写死的话 SDK 一升级就找不到，而表现是「鸿蒙突然不可用」。
fn hdc_path() -> Option<PathBuf> {
    let ov = overrides();
    // 手动指定的 SDK 根目录：先按 `<根>/hdc/hdc`，再按
    // `<根>/openharmony/<版本>/toolchains/hdc` 找——用户填的可能是其中任一层。
    if let Some(root) = ov.harmony_sdk.as_deref() {
        let root = PathBuf::from(root);
        let mut cands = vec![root.join("hdc").join("hdc")];
        cands.extend(hdc_under_openharmony(&root));
        if let Some(p) = first_executable(&cands, is_executable) {
            return Some(p);
        }
        return None; // 指定了就**不静默回退**（与 Android / iOS 同一原则）
    }

    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(v) = std::env::var("HDC_HOME") {
        if !v.trim().is_empty() {
            cands.push(PathBuf::from(v).join("hdc"));
        }
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        roots.push(home.join("Library/Huawei/Sdk"));
        roots.push(home.join("Huawei/Sdk"));
    }
    for root in &roots {
        cands.push(root.join("hdc").join("hdc"));
        cands.extend(hdc_under_openharmony(root));
    }
    cands.push(PathBuf::from("/opt/homebrew/bin/hdc"));
    cands.push(PathBuf::from("/usr/local/bin/hdc"));

    if let Some(p) = first_executable(&cands, is_executable) {
        return Some(p);
    }

    // 外置卷：名字像鸿蒙 SDK 的目录（只在前面都落空时才扫）
    let found = find_app(
        |name| {
            let n = name.to_lowercase();
            n.contains("harmony") || n.contains("deveco")
        },
        |p| !hdc_under_openharmony(p).is_empty() || p.join("hdc").join("hdc").is_file(),
    )?;
    let mut extra = vec![found.join("hdc").join("hdc")];
    extra.extend(hdc_under_openharmony(&found));
    first_executable(&extra, is_executable)
}

/// `<root>/openharmony/<任意版本>/toolchains/hdc` 的全部候选。
///
/// 倒序：新版本 SDK 排前面（目录名如 `9` / `10`，字符串倒序对两位数以上
/// 不精确，但只是在「多个版本都装着」时挑一个，挑错也不影响可用性
/// ——两个版本都带同一个 hdc）。
fn hdc_under_openharmony(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root.join("openharmony")) else { return Vec::new() };
    let mut versions: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    versions.sort_by(|a, b| b.cmp(a));
    versions
        .into_iter()
        .map(|v| v.join("toolchains").join("hdc"))
        .collect()
}

async fn probe_harmony() -> PlatformStatus {
    let ov = overrides();
    // 指定了却找不到 → 明确报出来，不回退
    if let Some(p) = ov.harmony_sdk.as_deref() {
        if hdc_path().is_none() {
            return PlatformStatus::unavailable(format!(
                "指定的 HarmonyOS SDK 目录里没找到 hdc：{p}\n\
                 其下应有 openharmony/<版本>/toolchains/hdc，或直接是含 hdc/hdc 的目录。"
            ));
        }
    }

    let Some(hdc) = hdc_path() else {
        return harmony_status(false, &[], None);
    };
    let tool = hdc.display().to_string();
    // `list targets` 不带 `-v`：`-v` 会附加设备详情，但**输出格式随版本变化**
    // （实测本机 1.2.0a 在无设备时给 `[Empty]\thdc`），而我们只需要 connect key，
    // 型号等信息另有命令可取。少解析一种格式就少一处会静默出错的地方。
    let targets = match run_stdout(&hdc, &["list targets"], CMD_TIMEOUT).await {
        Ok(out) => parse_hdc_targets(&out),
        // 命令失败（版本差异、服务未起）时按「没有设备」处理，但**保留工具可用**：
        // `hdc` 存在就说明装了 SDK，这一点比「这次查询失败」更重要。
        Err(_) => Vec::new(),
    };
    harmony_status(true, &targets, Some(&tool))
}

/// 小程序的探测：看微信开发者工具是否安装（以及装在哪）。
///
/// 查找顺序：约定位置 → **应用目录扫描**（覆盖外置卷与改名，见
/// `matches_miniprogram_app`）→ 手动指定（在 `probe` 里优先于本函数）。
async fn probe_miniprogram() -> PlatformStatus {
    let ov = overrides();
    let (tool, source) = if let Some(p) = ov.miniprogram.as_deref() {
        let path = PathBuf::from(p);
        if !path.is_dir() {
            return PlatformStatus::unavailable(format!(
                "指定的微信开发者工具不存在：{p}\n请指向 .app 本身（例如 \
                 /Volumes/你的卷/applications/wechatwebdevtools.app）。"
            ));
        }
        (path, ToolSource::Override)
    } else {
        match discover_miniprogram_tool() {
            Some(p) => (p.clone(), ToolSource::Discovered),
            None => return miniprogram_status(false),
        }
    };

    // 项目目录：手动指定优先，否则从工具日志推断。
    // 取不到项目不报错——工具本身可用这件事要如实说，而「还没打开项目」
    // 是用户下一步能自己解决的状态，不是错误。
    let project = ov
        .miniprogram_project
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| p.join("project.config.json").is_file())
        .or_else(crate::miniprogram::discover_project);

    let ready = crate::miniprogram::is_ready().await;
    miniprogram_status_full(&tool, source, project.as_deref(), ready)
}

/// 自动发现微信开发者工具的 `.app`。
///
/// # 顺序：**正在运行的实例优先**，然后才是约定位置与扫描
///
/// 本机装了两份开发者工具（`applications/` 与 `work/office-applications/`），
/// 各自有独立的用户数据目录与端口。若按目录顺序挑，很可能挑到**没在运行**
/// 的那份——而接下来用它去连自动化端口、读它的数据目录，全都会失败，
/// 报错却指向「端口未监听」「项目未找到」，与真正的根因（挑错了副本）
/// 隔了一层。实测在 `scripts/miniprogram-auto.sh` 上先踩了一次。
fn discover_miniprogram_tool() -> Option<PathBuf> {
    if let Some(p) = running_miniprogram_app() {
        return Some(p);
    }
    let mut cands: Vec<PathBuf> = vec![
        PathBuf::from("/Applications/wechatwebdevtools.app"),
        PathBuf::from("/Applications/微信开发者工具.app"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        cands.push(home.join("Applications/wechatwebdevtools.app"));
        cands.push(home.join("Applications/微信开发者工具.app"));
    }
    if let Some(p) = cands.into_iter().find(|p| p.exists()) {
        return Some(p);
    }
    find_app(matches_miniprogram_app, |p| p.is_dir())
}

/// 找出**正在运行**的那份开发者工具 `.app`（靠进程命令行判断）。
///
/// 用 `ps` 而不是「读它写了哪个端口文件」：后者是缓存、会滞后
/// （实测工具重启后端口记录没更新）。进程命令行是事实。
fn running_miniprogram_app() -> Option<PathBuf> {
    let out = std::process::Command::new("/bin/ps")
        .args(["-axo", "command="])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        let Some(idx) = line.find("wechatwebdevtools.app/Contents/MacOS/") else { continue };
        let prefix = line[..idx].trim();
        // 命令行可能以空格分段，取最后一个以 / 开头的片段作为路径前缀
        let base = prefix.rsplit(' ').next().unwrap_or(prefix).trim();
        if !base.starts_with('/') {
            continue;
        }
        let app = PathBuf::from(format!("{base}wechatwebdevtools.app"));
        if app.is_dir() {
            return Some(app);
        }
    }
    None
}

/// 启动一个 AVD（**不等待启动完成**：冷启动十几秒，界面应立刻拿到反馈）。/// 启动一个 AVD（**不等待启动完成**：冷启动十几秒，界面应立刻拿到反馈）。
pub async fn start(platform: Platform, id: &str) -> Result<(), String> {
    match platform {
        Platform::Android => start_android(id).await,
        Platform::Ios => start_ios(id).await,
        Platform::Harmony => Err(format!(
            "{}没有可供本应用调用的启动入口。",
            platform.label()
        )),
        // 小程序的「启动」语义不同：设备（模拟器）由开发者工具管理，
        // 但**自动化服务**要单独拉起——那正是这里做的事。
        Platform::Miniprogram => ensure_miniprogram_automation().await,
    }
}

async fn start_android(avd: &str) -> Result<(), String> {
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

/// 启动一个 iOS 模拟器。
///
/// `simctl boot <udid>` 只「开机」，不打开 Simulator.app 窗口——
/// 但画面仍可截图（`simctl io` 直接读设备的帧缓冲），符合本面板的用法。
///
/// 用的是**解析出的那份 Xcode**（可能是手动指定或外置卷上自动发现的），
/// 而不是系统 `xcode-select` 选中的那一份——后者在只装了 CommandLineTools
/// 的机器上没有 simctl。
async fn start_ios(udid: &str) -> Result<(), String> {
    let tc = resolve_ios().await;
    if !tc.simctl {
        return Err("没有可用的 simctl（需要完整 Xcode）".to_owned());
    }
    let dev = tc.developer_dir.as_deref();
    // `simctl boot` 对已启动的设备会返回错误码 149（"Unable to boot device in
    // current state: Booted"）。那是无害的——用户点「启动」时它已经开着，
    // 报错反而让人以为失败了。因此先查状态，已启动就直接成功返回。
    let out = run_xcrun(
        dev,
        &["simctl", "list", "devices", "--json"],
        SIMCTL_TIMEOUT,
    )
    .await?;
    let already = parse_simctl_devices(&out)
        .iter()
        .any(|d| d.id == udid && d.running);
    if already {
        return Ok(());
    }
    run_xcrun(dev, &["simctl", "boot", udid], SIMCTL_TIMEOUT)
        .await
        .map(|_| ())
}

/// 关闭一个运行中的设备。
pub async fn stop(platform: Platform, id: &str) -> Result<(), String> {
    match platform {
        Platform::Android => {
            let serial = resolve_android_serial(id).await?;
            let adb = adb_path().ok_or("未找到 adb")?;
            run_stdout(&adb, &["-s", &serial, "emu", "kill"], CMD_TIMEOUT).await.map(|_| ())
        }
        Platform::Ios => {
            // 用解析出的那份 Xcode（可能是手动指定/外置卷上发现的）
            let tc = resolve_ios().await;
            if !tc.simctl {
                return Err("没有可用的 simctl（需要完整 Xcode）".to_owned());
            }
            run_xcrun(tc.developer_dir.as_deref(), &["simctl", "shutdown", id], SIMCTL_TIMEOUT)
                .await
                .map(|_| ())
        }
        Platform::Harmony | Platform::Miniprogram => Err(format!(
            "{}没有可供本应用调用的关闭入口（设备由 DevEco Studio / 开发者工具管理）。",
            platform.label()
        )),
    }
}

/// 截图（小程序）：走自动化 WebSocket。
async fn shot_miniprogram() -> Result<Vec<u8>, String> {
    let mut s = crate::miniprogram::Session::connect(crate::miniprogram::AUTO_PORT)
        .await
        .map_err(|e| {
            format!("{e}\n提示：小程序需要开发者工具开着目标项目，且自动化服务已启动。")
        })?;
    s.screenshot().await
}

/// 拉起小程序自动化服务（若尚未就绪）。
///
/// 需要两样东西：工具路径（自动发现或手动指定）与项目目录（手动指定或
/// 从工具日志推断）。任一缺失都给出**可执行的下一步**，而不是笼统失败。
pub async fn start_miniprogram_automation() -> Result<(), String> {
    ensure_miniprogram_automation().await
}

async fn ensure_miniprogram_automation() -> Result<(), String> {
    if crate::miniprogram::is_ready().await {
        return Ok(());
    }
    let ov = overrides();
    let tool = match ov.miniprogram.as_deref().map(PathBuf::from) {
        Some(p) if p.is_dir() => p,
        _ => discover_miniprogram_tool().ok_or(
            "未找到微信开发者工具。可在「自定义工具路径 → 微信开发者工具」里指定 .app 路径。",
        )?,
    };
    let project = ov
        .miniprogram_project
        .as_deref()
        .map(PathBuf::from)
        .filter(|p| p.join("project.config.json").is_file())
        .or_else(crate::miniprogram::discover_project)
        .ok_or(
            "未能确定小程序项目目录。请在开发者工具里打开目标项目，\
             或在「自定义工具路径 → 小程序项目」里指定（其下应有 project.config.json）。",
        )?;

    let cli = tool.join("Contents").join("MacOS").join("cli");
    if !cli.is_file() {
        return Err(format!(
            "开发者工具里没有 cli 命令：{}\n该路径可能不是完整的 .app。",
            cli.display()
        ));
    }
    crate::miniprogram::ensure_automation(&cli, &project).await
}

/// 列举小程序当前页的元素（供界面做成可点列表）。
pub async fn miniprogram_elements() -> Result<(String, Vec<crate::miniprogram::Element>), String> {
    let mut s = crate::miniprogram::Session::connect(crate::miniprogram::AUTO_PORT)
        .await
        .map_err(|e| format!("{e}\n提示：请先在面板上点「重新检测」以启动自动化服务。"))?;
    let (pid, route) = s.current_page().await?;
    // 只列这两类：view 是所有布局的容器（数量多、可点），button 是可点控件。
    // 不列 text/image 之类的纯展示元素——它们点了没有意义，只会让列表变长。
    let mut all = s.elements(&pid, "button").await.unwrap_or_default();
    all.extend(s.elements(&pid, "view").await.unwrap_or_default());
    Ok((route, all))
}

/// 点击小程序的某个元素。
pub async fn miniprogram_tap(element_id: &str) -> Result<(), String> {
    let mut s = crate::miniprogram::Session::connect(crate::miniprogram::AUTO_PORT)
        .await
        .map_err(|e| format!("{e}\n提示：请先在面板上点「重新检测」以启动自动化服务。"))?;
    let (pid, _) = s.current_page().await?;
    s.tap(&pid, element_id).await
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
pub async fn frame(platform: Platform, id: &str, force: bool) -> Result<Captured, String> {
    let bytes = match platform {
        Platform::Android => shot_android(id).await?,
        Platform::Ios => shot_ios(id).await?,
        Platform::Harmony => shot_harmony(id).await?,
        Platform::Miniprogram => shot_miniprogram().await?,
    };
    if bytes.is_empty() {
        return Err("截图返回空数据".to_owned());
    }

    // 尺寸从图像头里读：PNG 是 IHDR，JPEG 是 SOFn。两者都不能省——
    // 前端靠它把点击换算回设备坐标（见 `to_device_coords`）。
    let (w, h) = image_dimensions(&bytes).unwrap_or((0, 0));

    // 内容未变 → 只回尺寸，前端跳过整条「setState → 解码 → 重绘」链路。
    // 去重的键是 `platform:id`：不同平台的设备可能撞 id（理论上），
    // 而**同一个 id 在不同平台一定是两台不同的设备**。
    let key = format!("{}:{}", platform.label(), id);
    if is_unchanged(&key, &bytes, force) {
        return Ok(Captured { data_url: None, width: w, height: h });
    }

    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    // MIME 跟着**实际字节**走，不用平台推：浏览器按错误的 MIME 解码会
    // 直接不显示（不是显示错，是空白），而那个现象会被误判成「取帧坏了」。
    let mime = if bytes.starts_with(b"\x89PNG") { "image/png" } else { "image/jpeg" };
    Ok(Captured {
        data_url: Some(format!("data:{mime};base64,{b64}")),
        width: w,
        height: h,
    })
}

/// 把一个「设备标识」解析成 adb 能用的 serial。
///
/// 接受两种输入，正是因为两者在用户眼里都是「设备名字」：
/// - adb serial（`emulator-5554` / `192.168.1.9:5555`）→ 原样返回；
/// - AVD 名（`Pixel_4a_API_30`）→ 查当前运行中的模拟器，问出它的 serial。
///
/// # 为什么值得做这层解析
///
/// 直接把 AVD 名交给 `adb -s` 会得到 `device 'Pixel_4a_API_30' not found`——
/// 这句话的字面意思是「找不到这个名字的设备」，而用户看到的界面明明显示
/// 这台设备正在运行。**报错现场与根因差了整整一层抽象**（界面标识 vs
/// 传输层句柄），排查的人会先去怀疑「是不是设备没启动」。
///
/// 反过来说，如果在界面层就严格区分两个标识（`id` 用于启动、`runtimeId`
/// 用于取帧），那这层解析是多余的兜底；留着它的原因是：这两种标识在
/// 命令行里长得一样、含义不同，而**兜底的成本只有一次 `adb devices`**。
async fn resolve_android_serial(id: &str) -> Result<String, String> {
    let adb = adb_path().ok_or("未找到 adb")?;
    let out = run_stdout(&adb, &["devices", "-l"], CMD_TIMEOUT).await?;
    let devices = parse_adb_devices(&out);

    // 情况一：本来就是 serial
    if devices.iter().any(|d| d.serial == id) {
        return Ok(id.to_owned());
    }

    // 情况二：当成 AVD 名，逐个问运行中的模拟器
    for d in devices
        .iter()
        .filter(|d| d.serial.starts_with("emulator-") && d.state == "device")
    {
        if let Ok(out) = run_stdout(&adb, &["-s", &d.serial, "emu", "avd", "name"], CMD_TIMEOUT).await
        {
            if parse_emu_avd_name(&out).as_deref() == Some(id) {
                return Ok(d.serial.clone());
            }
        }
    }

    // 两种情况都排除后，**明确说是「没运行」**而不是「找不到」：
    // 这才是用户实际需要的信息（去把它启动起来）。
    Err(format!(
        "设备 {id} 当前不在运行：取画面与输入只对运行中的设备有效。先启动它（冷启动通常 10–30 秒）。"
    ))
}

/// Android 截图：`adb exec-out screencap -p`（**已验证**，本机 1080×2340 PNG）。
///
/// 用 `exec-out` 而不是 `shell screencap` + `pull` 两次往返：
/// `exec-out` 把二进制直接送回，不会像 `shell` 那样把 `\n` 转成 `\r\n`
/// 而损坏 PNG。
async fn shot_android(id: &str) -> Result<Vec<u8>, String> {
    let serial = resolve_android_serial(id).await?;
    let adb = adb_path().ok_or("未找到 adb")?;
    let mut cmd = Command::new(&adb);
    cmd.args(["-s", &serial, "exec-out", "screencap", "-p"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    match tokio::time::timeout(CMD_TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) if o.status.success() => Ok(o.stdout),
        Ok(Ok(o)) => Err(format!("截图失败：{}", String::from_utf8_lossy(&o.stderr).trim())),
        Ok(Err(e)) => Err(format!("截图失败：{e}")),
        Err(_) => Err("截图超时（设备可能无响应）".to_owned()),
    }
}

/// iOS 截图：`xcrun simctl io <udid> screenshot <文件>`。
///
/// # 为什么落盘再读，而不是直接读 stdout
///
/// `simctl io ... screenshot -` 在较新版本支持把 PNG 写到 stdout，但**旧版
/// 会把它当成文件名**而生成一个名叫 `-` 的文件。落盘的那个临时文件路径是
/// 各版本都支持的接口，因此选它（多一次本地读盘，代价可忽略）。
///
/// **未在真机验证**（本机无完整 Xcode，见模块文档「未验证项」）。
async fn shot_ios(udid: &str) -> Result<Vec<u8>, String> {
    let tc = resolve_ios().await;
    if !tc.simctl {
        return Err("没有可用的 simctl（需要完整 Xcode）".to_owned());
    }
    let tmp = temp_shot_path("ios", udid, "png");
    // 先删旧文件：`simctl` 在文件已存在时可能覆盖失败，而我们会读到上一次的
    // 旧画面——表现为「画面卡住不动」，且不报错。
    let _ = std::fs::remove_file(&tmp);

    let path = tmp.to_string_lossy().into_owned();
    let res = run_xcrun(
        tc.developer_dir.as_deref(),
        &["simctl", "io", udid, "screenshot", &path],
        SIMCTL_TIMEOUT,
    )
    .await;
    let bytes = std::fs::read(&tmp).ok();
    let _ = std::fs::remove_file(&tmp);
    match (res, bytes) {
        (Err(e), _) => Err(format!("iOS 截图失败：{e}")),
        (Ok(_), Some(b)) => Ok(b),
        // 命令成功却读不到文件（路径被改、权限）——如实说，别回一个空帧
        (Ok(_), None) => Err("iOS 截图命令成功但未生成文件".to_owned()),
    }
}

/// 鸿蒙截图：`hdc shell snapshot_display` 落盘 → `hdc file recv` 取回。
///
/// **未在真机验证**（本机 hdc 已装但 `list targets` 为空，见模块文档）。
/// 命令形式取自 hdc 自带帮助（`file recv [option] remote local`）。
async fn shot_harmony(id: &str) -> Result<Vec<u8>, String> {
    let hdc = hdc_path().ok_or("未找到 hdc")?;
    let remote = "/data/local/tmp/kcode_shot.jpeg";
    run_stdout(
        &hdc,
        &["-t", id, "shell", "snapshot_display", "-f", remote],
        CMD_TIMEOUT,
    )
    .await
    .map_err(|e| format!("鸿蒙截图失败：{e}"))?;

    let tmp = temp_shot_path("harmony", id, "jpeg");
    let _ = std::fs::remove_file(&tmp);
    let path = tmp.to_string_lossy().into_owned();
    let res = run_stdout(&hdc, &["-t", id, "file", "recv", remote, &path], CMD_TIMEOUT).await;
    let bytes = std::fs::read(&tmp).ok();
    let _ = std::fs::remove_file(&tmp);
    // 顺手删掉设备端的临时文件：留着会占设备的 /data 分区（每次截图一份）
    let _ = run_stdout(&hdc, &["-t", id, "shell", "rm", "-f", remote], CMD_TIMEOUT).await;

    match (res, bytes) {
        (Err(e), _) => Err(format!("从设备取回截图失败：{e}")),
        (Ok(_), Some(b)) => Ok(b),
        (Ok(_), None) => Err("截图已生成但未能取回".to_owned()),
    }
}

/// 截图落盘的临时路径。
///
/// 用**进程 id + 设备标识**拼名：多个设备（或本应用开了两个窗口）并发截图时
/// 共用同一个路径会互相覆盖，表现为画面在两个设备的画面之间跳。
/// 设备标识里的非字母数字字符要替换掉——它是 UDID/connect key，不能直接当文件名。
fn temp_shot_path(kind: &str, id: &str, ext: &str) -> PathBuf {
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let safe = if safe.len() > 40 { &safe[..40] } else { &safe };
    std::env::temp_dir().join(format!("kcode-{kind}-{}-{safe}.{ext}", std::process::id()))
}

/// 从图像字节里读宽高（PNG 或 JPEG）。
///
/// 两种格式都要认：Android/iOS 给 PNG，鸿蒙给 JPEG。**认不出返回 None**——
/// 调用方据此仍可显示画面，只是点击换算不可用（总比把整帧丢掉好）。
pub fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\x89PNG") {
        return png_dimensions(bytes);
    }
    if bytes.starts_with(&[0xFF, 0xD8]) {
        return jpeg_dimensions(bytes);
    }
    None
}

/// 从 JPEG 字节里读宽高（遍历段找 SOFn）。
///
/// JPEG 的结构是「标记 + 长度 + 数据」的段序列，尺寸在 SOF（Start Of Frame）
/// 段里。要跳过的是 SOI/APPn/DQT/DHT 这些前置段——**不能按固定偏移读**，
/// APP0（JFIF 头）的长度随 EXIF 缩略图变化，偏移量不固定。
///
/// SOF 有多个变体（C0–CF），其中 C4（DHT）、C8（JPG）、CC（DAC）**不是**
/// 帧头却落在同一区间——误判会把霍夫曼表的数据当成尺寸读出一个荒唐的值。
/// 那正是「点击位置全错」且不报错的典型成因，所以这里显式排除。
pub fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2; // 跳过 SOI
    while i + 3 < bytes.len() {
        if bytes[i] != 0xFF {
            // 段边界对不上：说明这不是我们认识的 JPEG（或数据损坏）。
            // 继续往后猜偏移只会读出错的值，不如直接放弃。
            return None;
        }
        let marker = bytes[i + 1];
        // 填充字节（0xFF 后面还是 0xFF）跳过
        if marker == 0xFF {
            i += 1;
            continue;
        }
        // 无长度字段的标记：SOI/EOI/RSTn/TEM
        if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if len < 2 {
            return None;
        }
        let is_sof = (0xC0..=0xCF).contains(&marker)
            && marker != 0xC4
            && marker != 0xC8
            && marker != 0xCC;
        if is_sof {
            // SOFn 段体：精度(1) + 高(2) + 宽(2) + 分量数(1)
            let body = bytes.get(i + 4..i + 4 + 5)?;
            let h = u16::from_be_bytes([body[1], body[2]]) as u32;
            let w = u16::from_be_bytes([body[3], body[4]]) as u32;
            return (w > 0 && h > 0).then_some((w, h));
        }
        i += 2 + len;
    }
    None
}

/// 判断这一帧是否与上次下发的相同，并顺手更新缓存。/// 判断这一帧是否与上次下发的相同，并顺手更新缓存。
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

/// 一次触摸手势的坐标与时长（**设备坐标**，已由调用方换算）。
///
/// 收成一个值而不是五个参数：`(x1,y1,x2,y2,duration)` 分开传时，
/// 调用处写出 `input(p, id, "swipe", x2, y2, x1, y1, ms)`（起终点写反）
/// 编译器**不会报错**，而表现是「滑动方向反了」——一个看起来像
/// 手势识别算法的 bug。打包成一个值后，字段名让这种错误在阅读时就暴露。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Touch {
    pub x1: i64,
    pub y1: i64,
    pub x2: i64,
    pub y2: i64,
    pub duration_ms: u64,
}

impl Touch {
    /// 点击：只有一个点，坐标用 (x1,y1)。
    pub fn tap(x: i64, y: i64) -> Self {
        Self { x1: x, y1: y, x2: 0, y2: 0, duration_ms: 0 }
    }

    /// 滑动：起点 → 终点 + 时长。
    pub fn swipe(x1: i64, y1: i64, x2: i64, y2: i64, duration_ms: u64) -> Self {
        Self { x1, y1, x2, y2, duration_ms }
    }

    /// 硬件键（返回/主屏）：不带坐标。
    pub fn key() -> Self {
        Self { x1: 0, y1: 0, x2: 0, y2: 0, duration_ms: 0 }
    }
}

/// 向设备发送一次输入。
///
/// `action` 取 `tap` / `swipe` / `back` / `home`；坐标已由调用方换算为
/// **设备坐标**（见 [`Touch`]）。
pub async fn input(platform: Platform, id: &str, action: &str, t: Touch) -> Result<(), String> {
    match platform {
        Platform::Android => input_android(id, action, t).await,
        Platform::Ios => Err(
            "iOS 模拟器不支持触摸注入：simctl 没有触摸命令（截图有、点击没有）。\
             要写触摸需额外部署 WebDriverAgent。"
                .to_owned(),
        ),
        Platform::Harmony => input_harmony(id, action, t).await,
        Platform::Miniprogram => {
            Err("小程序尚未接入触摸注入（需要开发者工具的服务端口自动化会话）".to_owned())
        }
    }
}

/// Android 输入：`adb shell input ...`（**已验证**，本机 tap/swipe 生效）。
async fn input_android(id: &str, action: &str, t: Touch) -> Result<(), String> {
    let serial = resolve_android_serial(id).await?;
    let adb = adb_path().ok_or("未找到 adb")?;
    // **必须经 `shell` 转发**：`adb -s X input tap ...` 会被 adb 当成自己的
    // 子命令而报 `unknown command input`（真机测试抓到的）。
    // 截图用 `exec-out` 没问题，因为那是 adb 自己的子命令；
    // `input` 是**设备上的**命令，属于 `shell` 那一类。
    let Touch { x1, y1, x2, y2, duration_ms, .. } = t;
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
    let mut argv = vec!["-s".to_owned(), serial.to_owned()];
    argv.extend(args);
    let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    run_stdout(&adb, &refs, CMD_TIMEOUT).await.map(|_| ())
}

/// 鸿蒙输入：`hdc shell uinput`。
///
/// # 未在真机验证
///
/// 命令形式取自 OpenHarmony 的 uinput 工具（`-T` 表示触摸屏设备，
/// `-c` 点击、`-m` 滑动）。**本机没有鸿蒙设备，这条路径一次都没跑过**，
/// 因此 [`PlatformStatus::can_input`] 对鸿蒙返回 false、界面不提供触摸——
/// 保留这段实现是为了「接上设备后验证通过即可一行开启」，
/// 而不是声称它已经能用。
///
/// 硬件键在鸿蒙上是 `uinput -K -d 1 -u 2`（返回）/ `-u 3`（主屏），
/// 同样未验证，因此与触摸一起关在同一个开关后面。
async fn input_harmony(id: &str, action: &str, t: Touch) -> Result<(), String> {
    let hdc = hdc_path().ok_or("未找到 hdc")?;
    let Touch { x1, y1, x2, y2, duration_ms, .. } = t;
    let args: Vec<String> = match action {
        "tap" => vec![
            "shell".into(),
            "uinput".into(),
            "-T".into(),
            "-c".into(),
            x1.to_string(),
            y1.to_string(),
        ],
        "swipe" => vec![
            "shell".into(),
            "uinput".into(),
            "-T".into(),
            "-m".into(),
            x1.to_string(),
            y1.to_string(),
            x2.to_string(),
            y2.to_string(),
            duration_ms.to_string(),
        ],
        "back" => vec!["shell".into(), "uinput".into(), "-K".into(), "-d".into(), "1".into(), "-u".into(), "2".into()],
        "home" => vec!["shell".into(), "uinput".into(), "-K".into(), "-d".into(), "1".into(), "-u".into(), "3".into()],
        other => return Err(format!("不支持的输入类型：{other}")),
    };
    let mut argv = vec!["-t".to_owned(), id.to_owned()];
    argv.extend(args);
    let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
    run_stdout(&hdc, &refs, CMD_TIMEOUT).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    // 只用到 tempdir；`tempfile` 是本 crate 的 dev-dependency，
    // 不在 lib 的正常依赖里（因此不会进入发布产物）。
    use tempfile::tempdir;

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

    // ── config.ini：本机实测的两种写法都必须能读 ──────────────────────

    /// `Pixel_4a_API_30.avd/config.ini` 的真实片段（等号两边带空格）。
    #[test]
    fn ini_value_handles_spaced_assignment() {
        let ini = "AvdId = Pixel_4a_API_30\n\
                   hw.device.name = pixel_4a\n\
                   hw.lcd.width = 1080\n\
                   hw.lcd.height = 2340\n";
        assert_eq!(ini_value(ini, "hw.device.name").as_deref(), Some("pixel_4a"));
        assert_eq!(ini_value(ini, "hw.lcd.width").as_deref(), Some("1080"));
    }

    /// `Medium_Phone_API_TiramisuPrivacySandbox.avd/config.ini` 的真实片段（不带空格）。
    ///
    /// **两份配置风格不同是本机实测的事实**。只认一种写法的话，另一种的
    /// 机型/系统/分辨率全都读不出来，而界面只会显示一个没有信息的条目。
    #[test]
    fn ini_value_handles_compact_assignment() {
        let ini = "abi.type=arm64-v8a\n\
                   hw.device.name=medium_phone\n\
                   hw.lcd.density=420\n";
        assert_eq!(ini_value(ini, "hw.device.name").as_deref(), Some("medium_phone"));
        assert_eq!(ini_value(ini, "hw.lcd.density").as_deref(), Some("420"));
    }

    #[test]
    fn ini_value_treats_empty_and_missing_as_none() {
        // 实测 `fastboot.chosenSnapshotFile = `（空值）：返回空串会让上层
        // 以为「读到了」而渲染一个空标签
        let ini = "fastboot.chosenSnapshotFile = \nhw.device.name = pixel_4a\n";
        assert_eq!(ini_value(ini, "fastboot.chosenSnapshotFile"), None);
        assert_eq!(ini_value(ini, "nonexistent.key"), None);
        // 值里含 `=`（如 URL 参数）时只切第一个等号
        assert_eq!(ini_value("k = a=b", "k").as_deref(), Some("a=b"));
    }

    /// 用两份**真实配置**验证 avd_info 的整体输出。
    #[test]
    fn avd_info_reads_real_pixel_config() {
        let ini = "AvdId = Pixel_4a_API_30\n\
                   abi.type = arm64-v8a\n\
                   hw.device.name = pixel_4a\n\
                   hw.lcd.density = 440\n\
                   hw.lcd.height = 2340\n\
                   hw.lcd.width = 1080\n\
                   image.sysdir.1 = system-images/android-30/google_apis/arm64-v8a/\n\
                   tag.id = google_apis\n";
        let e = avd_info("Pixel_4a_API_30", ini);
        assert_eq!(e.name, "pixel_4a", "无 displayname 时用机型档案名");
        assert_eq!(e.os.as_deref(), Some("Android 11"), "android-30 → Android 11");
        assert_eq!(e.resolution.as_deref(), Some("1080×2340"));
        assert!(!e.running, "avd_info 不知道运行状态，由合并逻辑覆盖");
        assert_eq!(e.runtime_id, None);
        let detail = e.detail.unwrap();
        assert!(detail.contains("arm64-v8a") && detail.contains("440dpi"), "{detail}");
    }

    #[test]
    fn avd_info_prefers_display_name_over_profile() {
        // 有 displayname 时用它：那是用户在 Android Studio 里看到的名字
        let ini = "avd.ini.displayname = Pixel 4a API 30\n\
                   hw.device.name = pixel_4a\n";
        assert_eq!(avd_info("X", ini).name, "Pixel 4a API 30");
        // 两者一致时不重复写进 detail（避免冗余）
        let same = "avd.ini.displayname = pixel_4a\nhw.device.name = pixel_4a\n";
        assert_eq!(avd_info("X", same).detail, None);
    }

    #[test]
    fn avd_info_falls_back_to_id_without_config() {
        // 配置读不到（文件缺失/手改坏）：仍要显示条目，用目录名兜底
        let e = avd_info("Some_AVD", "");
        assert_eq!(e.name, "Some_AVD");
        assert_eq!(e.os, None, "读不到系统版本时留空，不猜");
        assert_eq!(e.resolution, None);
        assert_eq!(e.detail, None);
    }

    // ── Android 版本号转换 ─────────────────────────────────────────────

    #[test]
    fn android_release_maps_codenames_and_api_levels() {
        // 实测本机两种镜像路径
        assert_eq!(
            android_release("system-images/android-TiramisuPrivacySandbox/google_apis_playstore/arm64-v8a/").as_deref(),
            Some("Android 13"),
            "代号要去掉 PrivacySandbox 后缀"
        );
        assert_eq!(
            android_release("system-images/android-30/google_apis/arm64-v8a/").as_deref(),
            Some("Android 11"),
            "纯数字是 API level"
        );
        // target 字段（旧格式）
        assert_eq!(android_release("android-UpsideDownCake").as_deref(), Some("Android 14"));
        assert_eq!(android_release("android-36").as_deref(), Some("Android 16"));
    }

    #[test]
    fn android_release_refuses_to_guess() {
        // 认不出来就留空：编一个版本号会让用户据此判断兼容性
        assert_eq!(android_release("android-ZebraCake"), None, "未收录的代号不猜");
        assert_eq!(android_release("android-99"), None, "未收录的 API level 不猜");
        assert_eq!(android_release(""), None);
        assert_eq!(android_release("some/other/path/"), None);
        // 反斜杠路径（Windows 上的 sysdir）也要能切
        assert_eq!(
            android_release("system-images\\android-33\\google_apis\\x86\\").as_deref(),
            Some("Android 13")
        );
    }

    // ── adb：把 serial 映射回 AVD 名 ───────────────────────────────────

    #[test]
    fn emu_avd_name_skips_ok_status_line() {
        // 实测：`adb -s emulator-5554 emu avd name` 输出名字 + `OK`
        assert_eq!(parse_emu_avd_name("Pixel_4a_API_30\nOK\n").as_deref(), Some("Pixel_4a_API_30"));
        // 设备未运行时返回 KO
        assert_eq!(parse_emu_avd_name("KO\n"), None);
        assert_eq!(parse_emu_avd_name(""), None);
        assert_eq!(parse_emu_avd_name("\n\n"), None);
    }

    #[test]
    fn getprop_parsed_from_full_dump() {
        // 实测格式：键与值各自带方括号
        let dump = "[ro.product.model]: [sdk_gphone_arm64]\n\
                    [ro.build.version.release]: [11]\n\
                    [ro.product.cpu.abi]: [arm64-v8a]\n\
                    [ro.some.empty]: []\n\
                    这不是一行属性\n";
        let p = parse_getprop(dump);
        assert_eq!(p.get("ro.product.model").map(String::as_str), Some("sdk_gphone_arm64"));
        assert_eq!(p.get("ro.build.version.release").map(String::as_str), Some("11"));
        // 空值与噪声行都不该造出假键
        assert!(!p.contains_key("这不是一行属性"));
        assert_eq!(p.get("ro.some.empty").map(String::as_str), Some(""));
    }

    #[test]
    fn wm_size_prefers_override() {
        assert_eq!(parse_wm_size("Physical size: 1080x2340\n").as_deref(), Some("1080×2340"));
        // 有 Override 时以它为准：那才是当前生效的尺寸，
        // 用 Physical 换算点击会整体偏移
        let both = "Physical size: 1080x2340\nOverride size: 720x1280\n";
        assert_eq!(parse_wm_size(both).as_deref(), Some("720×1280"));
        // 解析不出时返回 None，不编一个尺寸
        assert_eq!(parse_wm_size(""), None);
        assert_eq!(parse_wm_size("Physical size: unknown\n"), None);
    }

    // ── 合并：AVD 清单 + adb 现状 ──────────────────────────────────────

    /// **这次改版最容易静默出错的点**：serial 与 AVD 名之间没有可推导关系。
    ///
    /// 若合并逻辑按「serial 前缀猜 AVD 名」，运行中的模拟器会显示成未启动，
    /// 而且同时出现「运行中」与「未启动」两行指着同一台设备。
    #[test]
    fn merge_marks_running_avd_by_avd_name_not_serial() {
        let avds = vec![
            avd_info("Pixel_4a_API_30", "hw.device.name = pixel_4a\nhw.lcd.width = 1080\nhw.lcd.height = 2340\n"),
            avd_info("Other_AVD", ""),
        ];
        let obs = vec![AdbObservation {
            serial: "emulator-5554".to_owned(), // 端口与 AVD 名无关
            state: "device".to_owned(),
            model: Some("sdk_gphone_arm64".to_owned()),
            avd_name: Some("Pixel_4a_API_30".to_owned()),
            ..Default::default()
        }];
        let out = build_android_entries(&avds, &obs, &Default::default());

        assert_eq!(out.len(), 2, "只有一个 adb 设备，不该多出行: {out:?}");
        let running: Vec<&DeviceEntry> = out.iter().filter(|e| e.running).collect();
        assert_eq!(running.len(), 1);
        assert_eq!(running[0].id, "Pixel_4a_API_30");
        // 句柄必须是 serial（取帧要用它），而不是 AVD 名
        assert_eq!(running[0].runtime_id.as_deref(), Some("emulator-5554"));
        // 未启动的那台不能带句柄：拿了也没有设备可操作
        assert_eq!(out.iter().find(|e| e.id == "Other_AVD").unwrap().runtime_id, None);
    }

    /// 外接设备（真机）要单独出现在后面，且用实测属性命名。
    #[test]
    fn merge_appends_external_devices_with_live_props() {
        let avds = vec![avd_info("Pixel_4a_API_30", "")];
        let obs = vec![AdbObservation {
            serial: "192.168.1.9:5555".to_owned(),
            state: "device".to_owned(),
            model: Some("driver_side_name".to_owned()),
            wm_size: Some("Physical size: 1080x2400\n".to_owned()),
            ..Default::default()
        }];
        let mut props = std::collections::HashMap::new();
        props.insert(
            "192.168.1.9:5555".to_owned(),
            parse_getprop("[ro.product.model]: [My Real Phone]\n[ro.build.version.release]: [14]\n"),
        );
        let out = build_android_entries(&avds, &obs, &props);

        assert_eq!(out.len(), 2, "AVD 条目 + 外接设备条目");
        let ext = out.last().unwrap();
        assert_eq!(ext.name, "My Real Phone", "实测属性优先于 adb 自报的 model");
        assert_eq!(ext.os.as_deref(), Some("Android 14"));
        assert_eq!(ext.resolution.as_deref(), Some("1080×2400"));
        assert_eq!(ext.runtime_id.as_deref(), Some("192.168.1.9:5555"));
        assert!(ext.detail.as_deref().unwrap().contains("外接设备"));
    }

    /// adb 报告 offline 时不能给句柄：`-s` 拿它去截图会挂到超时，
    /// 而界面上它「看起来是连着的」。
    #[test]
    fn merge_withholds_handle_from_offline_device() {
        let avds = vec![avd_info("Pixel_4a_API_30", "")];
        let obs = vec![AdbObservation {
            serial: "emulator-5554".to_owned(),
            state: "offline".to_owned(),
            avd_name: Some("Pixel_4a_API_30".to_owned()),
            ..Default::default()
        }];
        let out = build_android_entries(&avds, &obs, &Default::default());
        assert_eq!(out.len(), 1);
        assert!(!out[0].running);
        assert_eq!(out[0].state, "offline", "状态串要带出来，让界面区分「离线」与「未启动」");
        assert_eq!(out[0].runtime_id, None, "offline 设备不能给句柄");
    }

    // ── iOS：simctl 的 JSON ────────────────────────────────────────────

    #[test]
    fn simctl_devices_parsed_with_runtime_version() {
        // 真实 shaped JSON（键是 runtime 标识）
        let json = r#"{"devices":{
          "com.apple.CoreSimulator.SimRuntime.iOS-17-0":[
            {"name":"iPhone 15 Pro","udid":"AAAA-BBBB","state":"Booted",
             "deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro"},
            {"name":"iPhone SE (3rd generation)","udid":"CCCC-DDDD","state":"Shutdown",
             "deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation"}
          ],
          "com.apple.CoreSimulator.SimRuntime.iOS-18-4":[
            {"name":"iPad Pro 11-inch (M4)","udid":"EEEE-FFFF","state":"Shutdown",
             "deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M4-8GB"}
          ]}}"#;
        let d = parse_simctl_devices(json);
        assert_eq!(d.len(), 3);
        let booted = d.iter().find(|x| x.running).unwrap();
        assert_eq!(booted.id, "AAAA-BBBB");
        assert_eq!(booted.name, "iPhone 15 Pro");
        assert_eq!(booted.os.as_deref(), Some("iOS 17.0"), "版本来自 runtime 键，不是设备名");
        assert_eq!(booted.runtime_id.as_deref(), Some("AAAA-BBBB"));
        assert_eq!(
            booted.detail.as_deref(),
            Some("iPhone-15-Pro"),
            "deviceTypeIdentifier 去掉前缀"
        );
        // simctl 不给分辨率：留空而不是编一个（机型表会随新机型过期）
        assert!(d.iter().all(|x| x.resolution.is_none()));
        // 补丁版本也要能解析（iOS-18-4-1 这种）
        assert_eq!(ios_release("com.apple.CoreSimulator.SimRuntime.iOS-18-4-1").as_deref(), Some("iOS 18.4.1"));
    }

    #[test]
    fn simctl_malformed_json_yields_empty_not_panic() {
        assert!(parse_simctl_devices("not json").is_empty());
        assert!(parse_simctl_devices("{}").is_empty());
        assert!(parse_simctl_devices(r#"{"devices":{}}"#).is_empty());
        // 缺 udid 的条目要跳过，不能造出一个没有句柄的条目
        let no_udid = r#"{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-0":[{"name":"X","state":"Booted"}]}}"#;
        assert!(parse_simctl_devices(no_udid).is_empty());
    }

    #[test]
    fn ios_release_rejects_unrelated_runtimes() {
        assert_eq!(ios_release("com.apple.CoreSimulator.SimRuntime.watchOS-10-0"), None);
        assert_eq!(ios_release("com.apple.CoreSimulator.SimRuntime.tvOS-17-0"), None);
        assert_eq!(ios_release(""), None);
    }

    // ── 鸿蒙 / 小程序 ─────────────────────────────────────────────────

    #[test]
    fn hdc_targets_skip_empty_marker() {
        // 实测本机 hdc 1.2.0a 无设备时的输出：`[Empty]`
        // 不识别它就会造出一个 id 叫 `[Empty]` 的假设备
        assert!(parse_hdc_targets("[Empty]\n").is_empty());
        assert!(parse_hdc_targets("[Empty]\thdc\n").is_empty());
        assert!(parse_hdc_targets("").is_empty());
        // 有设备时每行一个 connect key
        let out = parse_hdc_targets("7001005458323933328a01b3d5f54500\n\n");
        assert_eq!(out.len(), 1);
        assert_eq!(out[0], "7001005458323933328a01b3d5f54500");
    }

    #[test]
    fn short_key_keeps_both_ends_for_disambiguation() {
        // 32 位十六进制：留首尾，中间省略——两台设备的 key 通常前缀相似
        let k = "7001005458323933328a01b3d5f54500";
        let s = short_key(k);
        assert!(s.starts_with("70010054"), "{s}");
        assert!(s.ends_with("4500"), "{s}");
        assert!(s.len() < k.len());
        // 短 key 原样返回
        assert_eq!(short_key("abc"), "abc");
    }

    #[test]
    fn harmony_capability_bits_match_toolchain_reality() {
        // 装了 hdc 但没有设备：available=true（工具链在），设备列表为空
        let s = harmony_status(true, &[], Some("/opt/hdc"));
        assert!(s.available);
        assert!(s.devices.is_empty());
        // 没有独立启动器、触摸未验证 → 两个能力位都必须是 false
        assert!(!s.can_launch, "鸿蒙没有命令行启动入口");
        assert!(!s.can_input, "触摸注入未验证，不能声称支持");
        assert!(s.input_hint.is_some(), "不能输入时要说明是我们的待办而非平台限制");
        assert!(s.input_hint.as_deref().unwrap().contains("未"));

        // 有设备时条目要带句柄（connect key）
        let with = harmony_status(true, &["7001005458323933328a01b3d5f54500".to_owned()], None);
        assert_eq!(with.devices.len(), 1);
        assert_eq!(
            with.devices[0].runtime_id.as_deref(),
            Some("7001005458323933328a01b3d5f54500")
        );
        assert!(with.devices[0].running);

        // 没装 hdc：给出安装指引
        let missing = harmony_status(false, &[], None);
        assert!(!missing.available);
        assert!(missing.reason.unwrap().contains("DevEco"));
    }

    #[test]
    fn miniprogram_always_explains_next_step() {
        // 没装：安装指引
        let missing = miniprogram_status(false);
        assert!(!missing.available);
        let r = missing.reason.unwrap();
        assert!(r.contains("开发者工具") && r.contains("http"), "应给下载地址: {r}");

        // 装了但自动化未接入：**也要说清原因**，不能糊成「不可用」
        let found = miniprogram_status(true);
        assert!(!found.available, "尚未接入，不能报告为可用");
        let r = found.reason.unwrap();
        assert!(r.contains("服务端口"), "应说明为什么还不能取画面: {r}");
    }

    // ── 图像尺寸：PNG 与 JPEG ──────────────────────────────────────────

    /// 构造一个最小合法 PNG 头。
    fn png_header(w: u32, h: u32) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(b"\x89PNG\r\n\x1a\n");
        b.extend_from_slice(&13u32.to_be_bytes());
        b.extend_from_slice(b"IHDR");
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&[8, 6, 0, 0, 0]); // 位深/色型/压缩/滤波/隔行
        b
    }

    /// 构造一个带前置段的 JPEG（SOI + APP0 + SOF0）。
    fn jpeg_with_app0(w: u16, h: u16, app0_extra: usize) -> Vec<u8> {
        let mut b = vec![0xFF, 0xD8]; // SOI
        // APP0，长度随 app0_extra 变化——这正是「不能按固定偏移读」的原因
        let app0_len = (16 + app0_extra) as u16;
        b.extend_from_slice(&[0xFF, 0xE0]);
        b.extend_from_slice(&app0_len.to_be_bytes());
        b.extend(std::iter::repeat_n(0u8, app0_len as usize - 2));
        // SOF0：标记 + 长度(17) + 精度(8) + 高 + 宽 + 分量数(3) + ...
        b.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        b.extend_from_slice(&h.to_be_bytes());
        b.extend_from_slice(&w.to_be_bytes());
        b.extend_from_slice(&[0x03]);
        b.extend(std::iter::repeat_n(0u8, 9));
        b
    }

    #[test]
    fn jpeg_dimensions_reads_sofn_after_variable_prefix() {
        // 前置段长度不同、尺寸相同：结果必须一致
        assert_eq!(jpeg_dimensions(&jpeg_with_app0(1080, 2400, 0)), Some((1080, 2400)));
        assert_eq!(jpeg_dimensions(&jpeg_with_app0(1080, 2400, 500)), Some((1080, 2400)));
        assert_eq!(jpeg_dimensions(&jpeg_with_app0(320, 480, 12)), Some((320, 480)));
    }

    /// DHT(C4) / JPG(C8) / DAC(CC) 落在 SOF 的标记区间内但**不是帧头**。
    ///
    /// 误判会把霍夫曼表的数据当成宽高读出一个荒唐的值——不报错，
    /// 只表现为「点击位置全错」。
    #[test]
    fn jpeg_dimensions_does_not_mistake_dht_for_sofn() {
        let mut b = vec![0xFF, 0xD8];
        // 注意：JPEG 的段长**包含长度字段自身的 2 字节**，所以「声明 8」
        // 意味着后面跟 6 字节数据。这里必须按这个约定造数据——
        // （第一版我按「8 字节数据」写，段边界立刻就错位了，
        //  解析器返回 None，看起来像解析器的 bug，实际是测试数据不合规。）
        // DHT：C4，段体里放一些看起来像尺寸的字节
        b.extend_from_slice(&[0xFF, 0xC4, 0x00, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
        // JPG(C8) 同理：声明 6 → 4 字节数据
        b.extend_from_slice(&[0xFF, 0xC8, 0x00, 0x06, 0x00, 0x01, 0x02, 0x03]);
        // 真正的 SOF0 在后面
        b.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        b.extend_from_slice(&1080u16.to_be_bytes());
        b.extend_from_slice(&1920u16.to_be_bytes());
        b.extend_from_slice(&[0x03]);
        b.extend(std::iter::repeat_n(0u8, 9));
        assert_eq!(jpeg_dimensions(&b), Some((1920, 1080)), "应跳过 DHT/JPG 找到真正的 SOF");
    }

    /// 段长越界时返回 None，**不能读出垃圾值**。
    ///
    /// 这是真实 JPEG 可能出现的形态（传输截断、设备端写入未完成）：
    /// 若按越界的长度硬读，会从无关字节里凑出一个「尺寸」，
    /// 而前端会拿它做点击换算 → 点击位置全错且不报错。
    #[test]
    fn jpeg_dimensions_rejects_truncated_segment() {
        // 声明 8（即 6 字节数据），实际只给 5 字节 → 段边界对不上
        let mut b = vec![0xFF, 0xD8];
        b.extend_from_slice(&[0xFF, 0xE0, 0x00, 0x08, 0x00, 0x01, 0x02, 0x03, 0x04]);
        b.extend_from_slice(&[0xFF, 0xC0, 0x00, 0x11, 0x08]);
        b.extend_from_slice(&1080u16.to_be_bytes());
        b.extend_from_slice(&1920u16.to_be_bytes());
        b.extend_from_slice(&[0x03]);
        b.extend(std::iter::repeat_n(0u8, 9));
        assert_eq!(jpeg_dimensions(&b), None, "段边界错位时应放弃，而不是猜");
    }

    #[test]
    fn jpeg_dimensions_rejects_garbage() {
        assert_eq!(jpeg_dimensions(&[]), None);
        assert_eq!(jpeg_dimensions(&[0xFF, 0xD8]), None);
        // 段标记对不上：继续往后猜只会读出错的值
        assert_eq!(jpeg_dimensions(&[0xFF, 0xD8, 0x00, 0x00, 0x00, 0x00]), None);
    }

    #[test]
    fn image_dimensions_dispatches_by_magic_bytes() {
        assert_eq!(image_dimensions(&png_header(1080, 2340)), Some((1080, 2340)));
        assert_eq!(image_dimensions(&jpeg_with_app0(720, 1280, 4)), Some((720, 1280)));
        // 都不是：返回 None（调用方仍可显示画面，只是点击换算不可用）
        assert_eq!(image_dimensions(b"GIF89a....."), None);
        assert_eq!(image_dimensions(&[]), None);
    }

    /// 临时文件名必须把设备标识里的非字母数字字符换掉，且不同设备不撞名。
    #[test]
    fn temp_shot_path_is_safe_and_distinct() {
        let a = temp_shot_path("ios", "AAAA-BBBB-CCCC", "png");
        let b = temp_shot_path("ios", "AAAA-BBBB-DDDD", "png");
        assert_ne!(a, b, "不同设备不能共用临时文件（会互相覆盖 → 画面跳动）");
        let name = a.file_name().unwrap().to_string_lossy();
        assert!(!name.contains('-') || name.starts_with("kcode-ios-"), "{name}");
        // UUID 里的连字符不能原样进文件名
        assert!(!name.contains("BBBB-CCCC"), "UDID 里的连字符应被替换: {name}");
        // 超长标识要截断（connect key 32 位 + 其他平台可能更长）
        let long = temp_shot_path("harmony", &"7".repeat(200), "jpeg");
        assert!(long.file_name().unwrap().to_string_lossy().len() < 80);
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
        // 能力位：simctl 能启动、**不能**注入触摸
        assert!(s.can_launch);
        assert!(!s.can_input, "simctl 没有触摸命令，能力位必须如实为 false");
        assert!(s.input_hint.is_some(), "不能输入时要说明为什么");
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
    // ── 开发者工具路径：命名匹配的边界 ────────────────────────────────

    /// 名字匹配必须**放行改名变体**。
    ///
    /// 本机实测同时存在两种目录名（都指向微信开发者工具）——
    /// 只认其中一种就会漏掉另一种，而表现是「明明装了却检测不到」。
    #[test]
    fn miniprogram_name_matching_accepts_variants() {
        for ok in [
            "wechatwebdevtools.app",
            "微信开发者工具.app",
            // 实测：带后缀括号的改名（用户从 dmg 拖出来常变成这样）
            "微信开发者工具（NWJS）.app",
            "WechatWebDevTools.app", // 大小写
        ] {
            assert!(matches_miniprogram_app(ok), "应认出 {ok}");
        }
    }

    /// **不能**把别家的「开发者工具」认成微信的。
    ///
    /// 本机实测装着支付宝与京东的开发者工具，名字里都带「开发者工具」：
    ///   `小程序开发者工具.app`（com.ant.miniprogram）
    ///   `jdvappdevtools.app`（京东）
    /// 认错会让用户以为检测到了自己的工具，而实际调的是别家——
    /// 比「没检测到」更糟，因为它看起来是成功的。
    #[test]
    fn miniprogram_name_matching_rejects_other_vendors() {
        for bad in [
            "小程序开发者工具.app",
            "jdvappdevtools.app",
            "支付宝开发者工具.app",
            "Taro开发者工具.app",
        ] {
            assert!(!matches_miniprogram_app(bad), "不该把 {bad} 当成微信开发者工具");
        }
    }

    #[test]
    fn xcode_name_matching_covers_beta_and_case() {
        assert!(matches_xcode_app("Xcode.app"));
        assert!(matches_xcode_app("Xcode-beta.app"));
        assert!(matches_xcode_app("xcode.app"));
        // 不能只判「含 xcode」——否则 Xcode.app 的备份目录也会被当候选
        assert!(!matches_xcode_app("Xcode 14.2 Backups"));
        assert!(!matches_xcode_app("CommandLineTools"));
    }

    #[test]
    fn applications_dir_matching_accepts_real_layouts() {
        // 实测的三种写法
        assert!(is_applications_dir("Applications"));
        assert!(is_applications_dir("applications"));           // 外置卷上的小写
        assert!(is_applications_dir("office-applications"));    // 自建目录
        assert!(!is_applications_dir("work"));
        assert!(!is_applications_dir("备份"));
    }

    #[test]
    fn xcode_developer_dir_is_derived_not_guessed() {
        // 用户填的是访达里看到的 .app，我们要的是里层 —— 只该有一处转换
        let d = xcode_developer_dir(Path::new("/Volumes/data1/applications/Xcode.app"));
        assert_eq!(
            d,
            PathBuf::from("/Volumes/data1/applications/Xcode.app/Contents/Developer")
        );
    }

    // ── 手动指定（兜底）──────────────────────────────────────────────

    #[test]
    fn overrides_normalize_blank_to_none() {
        // 界面清空输入框会传 ""，语义应等同「未设置」——
        // 否则 Some("") 会被 join 成相对路径，且不报错
        let ov = ToolOverrides {
            android_sdk: Some("  ".to_owned()),
            xcode: Some(String::new()),
            harmony_sdk: Some("/x/sdk".to_owned()),
            miniprogram: None,
            miniprogram_project: None,
        }
        .normalized();
        assert!(ov.android_sdk.is_none(), "空白应归一为 None");
        assert!(ov.xcode.is_none(), "空串应归一为 None");
        assert_eq!(ov.harmony_sdk.as_deref(), Some("/x/sdk"));
        assert!(ov.any_set(), "有一项有效就应为 true");
    }

    #[test]
    fn overrides_any_set_is_false_when_all_blank() {
        let ov = ToolOverrides {
            android_sdk: Some(" ".to_owned()),
            xcode: None,
            harmony_sdk: None,
            miniprogram: None,
            miniprogram_project: None,
        }
        .normalized();
        assert!(!ov.any_set(), "全空时 any_set 必须为 false（界面据此不显示「已自定义」）");
    }

    /// override 的 JSON 契约：字段名是 camelCase（前端按这个读），
    /// 且**缺字段时不报错**（老版本写的文件要能被新版本读）。
    #[test]
    fn overrides_json_shape_is_stable_and_lenient() {
        let ov: ToolOverrides =
            serde_json::from_str(r#"{"androidSdk":"/a","xcode":"/X.app"}"#).unwrap();
        assert_eq!(ov.android_sdk.as_deref(), Some("/a"));
        assert_eq!(ov.xcode.as_deref(), Some("/X.app"));
        assert!(ov.harmony_sdk.is_none());

        // 空对象也合法（用户清空了全部设置）
        let empty: ToolOverrides = serde_json::from_str("{}").unwrap();
        assert!(!empty.any_set());

        // 序列化用 camelCase（前端读得到）
        let text = serde_json::to_string(&ov).unwrap();
        assert!(text.contains("androidSdk"), "应为 camelCase: {text}");
    }

    #[test]
    fn overrides_save_and_load_roundtrip() {
        let dir = tempdir().unwrap();
        let ov = ToolOverrides {
            android_sdk: Some("/opt/android-sdk".to_owned()),
            xcode: Some("/Volumes/data1/applications/Xcode.app".to_owned()),
            harmony_sdk: None,
            miniprogram: Some("/Volumes/data1/applications/wechatwebdevtools.app".to_owned()),
            miniprogram_project: None,
        };
        save_overrides(dir.path(), ov.clone()).unwrap();
        // 重新读出来应一致（且 current 已生效）
        let back = load_overrides(dir.path());
        assert_eq!(back.android_sdk, ov.android_sdk);
        assert_eq!(back.xcode, ov.xcode);
        assert_eq!(back.miniprogram, ov.miniprogram);
        assert_eq!(overrides().xcode, ov.xcode, "保存后应立刻生效，无需重启");
    }

    /// 配置文件损坏时**不能**让面板不可用：退回自动发现，用户仍能用。
    #[test]
    fn load_overrides_survives_corrupt_file() {
        let dir = tempdir().unwrap();
        std::fs::write(overrides_path(dir.path()), "{ 这不是 JSON").unwrap();
        let ov = load_overrides(dir.path());
        assert!(!ov.any_set(), "坏文件应退回空设置（纯自动发现），而不是报错");
    }

    #[test]
    fn load_overrides_missing_file_is_empty() {
        let dir = tempdir().unwrap();
        let ov = load_overrides(dir.path());
        assert!(!ov.any_set(), "文件不存在时全为 None");
        assert!(
            !overrides_path(dir.path()).exists(),
            "读取不该顺手创建文件（避免「装了什么都没配」也留下痕迹）"
        );
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

    /// 把真实探测结果打出来（`--ignored --nocapture` 时可见）。
    ///
    /// 用 `#[ignore]`：它只用于人工核验「界面实际会拿到什么」，
    /// 不做断言——断言的事交给下面的条件测试。
    #[tokio::test]
    #[ignore]
    async fn dump_probe_for_inspection() {
        let st = probe().await;
        println!("{}", serde_json::to_string_pretty(&st).unwrap());
    }

    #[tokio::test]
    async fn probe_reports_ios_unavailable_without_full_xcode() {
        let st = probe().await;
        // 本机只有 CommandLineTools → iOS 不可用，且必须给出安装指引
        if !st.ios.available {
            let reason = st.ios.reason.as_deref().unwrap_or("");
            assert!(reason.contains("Xcode") || reason.contains("xcode"), "{reason}");
            assert!(
                reason.contains("xcode") || reason.contains("Xcode"),
                "不可用时应说明与 Xcode 有关: {reason}"
            );
        }
    }

    /// 从真实探测结果里取一台运行中的 Android 设备：`(id, runtime_id)`。
    ///
    /// 注意两者**不是一回事**：`id` 是 AVD 名（`Pixel_4a_API_30`，用于启动），
    /// `runtime_id` 是 adb serial（`emulator-5554`，用于取帧/输入）。
    /// 这个辅助函数的第一版写的就是 `d.id.starts_with("emulator-")` ——
    /// 于是它永远找不到设备（AVD 名不带这个前缀），测试**静默跳过**，
    /// 表现为「全绿」而真机路径一次都没跑。静默跳过比失败更危险。
    fn running_android(st: &SimulatorStatus) -> Option<(String, String)> {
        st.android
            .devices
            .iter()
            .find(|d| d.running && d.runtime_id.is_some())
            .map(|d| (d.id.clone(), d.runtime_id.clone().unwrap()))
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
            !st.android.devices.is_empty(),
            "Android 可用却一个设备条目都没解析出来 —— 可能是解析或路径问题"
        );
        // 机型与系统必须解析出来：这是这次改版的**核心目的**（区分型号/系统）。
        // 只显示 AVD 目录名的话，用户分不清两台设备差在哪。
        let with_os = st.android.devices.iter().filter(|d| d.os.is_some()).count();
        assert!(
            with_os > 0,
            "所有条目都没解析出系统版本 —— config.ini 的解析可能失效了（注意它有两种写法：`k = v` 与 `k=v`）: {:?}",
            st.android.devices
        );
    }

    /// 真机验证：**运行中的**模拟器必须在界面上显示为运行中。
    ///
    /// 这条是这次改版最容易静默出错的点：serial（`emulator-5554`）与 AVD 名
    /// 之间没有可推导的关系，靠 `adb emu avd name` 查。查不到的结果是
    /// 「跑着的模拟器显示成未启动」，而用户会以为自己没启动成功。
    #[tokio::test]
    async fn running_emulator_is_marked_running() {
        let st = probe().await;
        if !st.android.available {
            eprintln!("跳过：未安装 Android SDK");
            return;
        }
        let running: Vec<_> = st.android.devices.iter().filter(|d| d.running).collect();
        if running.is_empty() {
            eprintln!("跳过：当前没有运行中的模拟器（可先 `emulator -avd <name>` 启动）");
            return;
        }
        for d in &running {
            assert!(
                d.state == "device",
                "运行中的设备状态应为 device，实际 {}: {d:?}",
                d.state
            );
        }
        // 运行中的模拟器不该同时出现在「未启动」的 AVD 条目里（那样会有两行）
        let ids: Vec<&str> = st.android.devices.iter().map(|d| d.id.as_str()).collect();
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(ids.len(), sorted.len(), "设备列表出现重复条目: {ids:?}");
    }

    #[tokio::test]
    async fn frame_from_running_device_is_real_image_with_expected_size() {
        let st = probe().await;
        if !st.android.available {
            eprintln!("跳过：未安装 Android SDK");
            return;
        }
        let Some((id, serial)) = running_android(&st) else {
            eprintln!("跳过：当前没有运行中的模拟器（可先 `emulator -avd <name>` 启动）");
            return;
        };
        // **取帧用 runtime_id，不用 id**：这两者在 Android 上是不同的东西。
        // 这条断言钉住的就是那个曾经让我误判「设备没运行」的坑。
        assert!(
            id != serial || id.starts_with("emulator-"),
            "Android 的 id 应是 AVD 名、runtime_id 应是 adb serial；两者相同只在外接设备上合法（id={id} serial={serial}）"
        );

        // 先清缓存：这台设备可能刚被别的测试取过帧
        forget_frame(&format!("Android:{serial}"));
        let cap = frame(Platform::Android, &serial, false).await.expect("取帧失败");
        let data_url = cap.data_url.expect("首次取帧必须带图像");
        let (w, h) = (cap.width, cap.height);
        // MIME 跟着实际字节走：Android 是 PNG
        assert!(data_url.starts_with("data:image/png;base64,"), "应为 PNG data URL");
        // 尺寸必须解析出来：前端靠它把点击换算回设备坐标
        assert!(w > 0 && h > 0, "未能从图像头解析尺寸（w={w} h={h}）");
        assert!(w >= 320 && h >= 320, "尺寸不像手机屏幕：{w}x{h}");

        // **真机验证去重**：立刻再取一帧。模拟器画面在 350ms 内几乎不可能变化，
        // 所以应被判为「未变」而只回尺寸——这正是省掉 780KB 传输与解码的依据。
        let again = frame(Platform::Android, &serial, false).await.expect("二次取帧失败");
        assert!(
            again.data_url.is_none(),
            "画面未变时应跳过图像下发（若这里失败，说明去重没生效或设备画面在跳动）"
        );
        assert_eq!(again.width, w, "跳过图像时仍须返回尺寸");

        // force 必须能拿到图像：前端手上没有帧时靠它
        let forced = frame(Platform::Android, &serial, true).await.expect("强制取帧失败");
        assert!(forced.data_url.is_some(), "force=true 时必须返回图像");
        forget_frame(&format!("Android:{serial}"));

        // 顺带验证一次输入：点屏幕正中（不应报错）
        input(
            Platform::Android,
            &serial,
            "tap",
            Touch::tap((w / 2) as i64, (h / 2) as i64),
        )
        .await
        .expect("发送点击失败");

        // 用 AVD 名（id）也必须能工作——`resolve_android_serial` 负责这件事。
        // 这是界面最可能的调用方式（列表项给的是 id）。
        let by_name = frame(Platform::Android, &id, true).await.expect("用 AVD 名取帧失败");
        assert!(by_name.data_url.is_some(), "传 AVD 名时应能解析出 serial 并取到帧");
        assert_eq!(by_name.width, w, "同一台设备，尺寸应一致");
        forget_frame(&format!("Android:{serial}"));
    }

    /// iOS 的能力位必须如实：**能启动、不能输入**。
    ///
    /// 这条不需要 Xcode 也能跑（平台不可用时 `available` 为 false，
    /// 但 `can_input` 仍应为 false）。它防的是「以后有人在 iOS 分支上
    /// 顺手把 can_input 打开」——那会让界面画出一个点了没反应的触摸层。
    #[tokio::test]
    async fn ios_never_claims_touch_support() {
        let st = probe().await;
        assert!(
            !st.ios.can_input,
            "iOS 侧永远不能声称支持触摸：simctl 没有触摸命令，需要 WebDriverAgent"
        );
    }

    /// 小程序的探测**必须给出原因与下一步**。
    ///
    /// # 这条断言随能力变化改写（2026-09-24）
    ///
    /// 原先断言的是「**永远不可用**」——那时取画面确实未接入。接入之后
    /// 它就开始失败，而失败信息是「不应报告为可用」——一条**过期的断言
    /// 在阻止正确的行为**。
    ///
    /// 改写成守住**不变的部分**：无论可用与否，都不能给空原因。
    /// 可用时要说清输入形态（元素级，不是坐标）；不可用时要说清怎么办。
    /// 那才是这个测试真正该守的东西。
    #[tokio::test]
    async fn miniprogram_always_explains_its_state() {
        let st = probe().await;
        if st.miniprogram.available {
            // 可用：必须说清输入是元素级——否则界面按坐标模式画，
            // 用户点画面不会有任何反应
            assert_eq!(
                st.miniprogram.input_mode,
                InputMode::Element,
                "小程序可用时输入形态必须是元素级（自动化接口不返回坐标）"
            );
            assert!(
                st.miniprogram.input_hint.is_some(),
                "必须说明输入是元素级而不是坐标"
            );
        } else {
            // 不可用：必须给原因与下一步（安装指引或启动自动化）
            let reason = st.miniprogram.reason.as_deref().unwrap_or("");
            assert!(!reason.is_empty(), "不可用必须带原因与下一步");
            assert!(
                reason.contains("开发者工具"),
                "原因里应点名微信开发者工具（用户据此知道要装/开什么）: {reason}"
            );
        }
    }


}

/// override 的端到端核验（需真实 Xcode，`--ignored` 手动跑）。
///
/// # ⚠️ 为什么是一个测试而不是几个
///
/// `OVERRIDES` 是**进程级**的（一个用户在设置里指定一次，全局生效），
/// 因此共享它的测试**不能并行**——Rust 测试默认并行，两个测试都改全局时
/// 会互相破坏对方的断言（实测踩到：一个把全局设成真实 Xcode 后，
/// 另一个「填错路径」的断言立刻失效）。
///
/// 处置：把相关场景收在**同一个测试里顺序执行**。不引入 serial_test
/// 之类的依赖来「让并行变成串行」——问题根源是这个全局量本身，
/// 而在生产里它是对的（单用户、单份配置）；只在测试里需要协调。
///
/// 这也是为什么下面的 `live_tests` 里那些调 `probe()` 的测试是安全的：
/// 它们不碰 override，而本模块的测试默认 `#[ignore]`（CI 不跑）。
#[cfg(test)]
mod e2e_override {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn override_round_trip_end_to_end() {
        let dir = tempfile::tempdir().unwrap();
        let real = "/Volumes/data1/applications/Xcode.app";

        // ① 指定一份真实存在的 Xcode → 应走「手动指定」且由 .app 推导出目录
        save_overrides(dir.path(), ToolOverrides {
            xcode: Some(real.to_owned()), ..Default::default()
        }).unwrap();
        let tc = resolve_ios().await;
        println!("[指定真实] note = {}", tc.note);
        assert!(tc.simctl, "本机这份 Xcode 应可用: {}", tc.note);
        assert!(tc.note.contains("手动指定"), "来源应标为手动指定: {}", tc.note);
        assert_eq!(
            tc.developer_dir.as_deref(),
            Some(xcode_developer_dir(Path::new(real)).as_path()),
            "DEVELOPER_DIR 应由指定的 .app 推导（不是用户填的原始串）"
        );

        // ② 指定一份**不存在**的路径 → 明确报出来，且**不回退**
        save_overrides(dir.path(), ToolOverrides {
            xcode: Some("/Volumes/nope/Xcode.app".to_owned()), ..Default::default()
        }).unwrap();
        let bad = resolve_ios().await;
        println!("[指定错误] note = {}", bad.note);
        assert!(!bad.simctl, "不存在的路径不应报告为可用");
        assert!(bad.note.contains("没有 simctl"), "应明确报出填错了: {}", bad.note);
        assert!(
            bad.developer_dir.is_some(),
            "指定了就走指定的那份（哪怕不可用）——静默回退会让用户以为设置生效了"
        );

        // ③ 清空 → 回到自动发现（本轮修的主功能：外置卷上的 Xcode 能被找到）
        save_overrides(dir.path(), ToolOverrides::default()).unwrap();
        let auto = resolve_ios().await;
        println!("[清空] note = {}", auto.note);
        assert!(!auto.note.contains("手动指定"), "清空后不应再是手动指定");
        assert!(auto.simctl, "清空后仍应自动发现 Xcode（这是本轮修的主功能）");
        assert!(
            auto.note.contains("自动发现"),
            "应说明是自动发现的: {}",
            auto.note
        );
    }

    /// 设置文件损坏时不影响使用（退回自动发现）。
    #[tokio::test]
    #[ignore]
    async fn corrupt_file_falls_back_to_auto() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(overrides_path(dir.path()), "{ 坏掉的 JSON").unwrap();
        let ov = load_overrides(dir.path());
        assert!(!ov.any_set());
        let tc = resolve_ios().await;
        println!("[损坏文件] note = {}", tc.note);
        assert!(tc.simctl, "坏文件不该让 iOS 不可用");
    }
}

#[cfg(test)]
mod status_shape_tests {
    //! `miniprogram_status_full` 三态的文案与能力位。
    //!
    //! 不依赖外部进程：直接调纯函数，覆盖「工具在但自动化没起」这条
    //! 用户最常遇到、也最容易写成一句「不可用」的路径。
    use super::*;

    #[test]
    fn not_ready_state_gives_actionable_next_step_and_element_mode() {
        let st = miniprogram_status_full(
            Path::new("/Applications/wechatwebdevtools.app"),
            ToolSource::Discovered,
            None,
            false,
        );
        assert!(!st.available);
        let reason = st.reason.as_deref().unwrap_or("");
        assert!(reason.contains("启动自动化"), "必须给出可点的下一步: {reason}");
        assert!(reason.contains("开发者工具"), "应说明原因与工具的关系: {reason}");
        // 关键：即使未就绪，能力位也要如实说明「将来是元素级输入」——
        // 否则界面无从知道该画元素列表还是只读画面
        assert!(st.can_input, "工具在时输入能力是可用的（只等自动化起来）");
        assert_eq!(st.input_mode, InputMode::Element, "小程序的输入永远是元素级");
    }

    #[test]
    fn ready_state_reports_project_as_device_with_element_mode() {
        let p = Path::new("/w/my-miniprogram");
        let st = miniprogram_status_full(
            Path::new("/Applications/wechatwebdevtools.app"),
            ToolSource::Discovered,
            Some(p),
            true,
        );
        assert!(st.available);
        assert_eq!(st.devices.len(), 1, "当前项目就是一个设备条目");
        assert_eq!(st.devices[0].id, "/w/my-miniprogram");
        assert_eq!(st.devices[0].name, "my-miniprogram", "展示名取目录名");
        assert!(st.devices[0].running);
        assert_eq!(st.input_mode, InputMode::Element);
        // 不给启动按钮：设备由开发者工具管理（与鸿蒙同理）
        assert!(!st.can_launch);
    }

    #[test]
    fn ready_without_project_explains_how_to_specify() {
        // 自动化起来了但项目推断不出 → 不是「不可用」，而是缺一条信息：
        // 必须说清怎么补上（自定义路径），而不是报一个空原因的失败
        let st = miniprogram_status_full(
            Path::new("/Applications/wechatwebdevtools.app"),
            ToolSource::Discovered,
            None,
            true,
        );
        assert!(st.available, "自动化就绪就算可用（只是还不知道是哪个项目）");
        let reason = st.reason.as_deref().unwrap_or("");
        assert!(reason.contains("项目"), "应说明缺的是项目: {reason}");
        assert!(reason.contains("自定义"), "应给出补上的入口: {reason}");
        assert!(st.devices.is_empty());
    }
}
