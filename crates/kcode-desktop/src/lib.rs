//! KCode 桌面宿主（Tauri 2 薄壳）。
//!
//! # 这一层刻意很薄
//!
//! 全部业务编排都在 [`kcode_app::AgentService`] 里，且那一层不依赖 Tauri，
//! 因此可以用真实 app-server 完整测试。本层只做两件事：
//!
//! 1. **命令转发**：把前端的 `invoke` 转成 service 调用；
//! 2. **事件转发**：把 `AppEvent` 推到 WebView。
//!
//! 这里**不应出现任何业务逻辑**——一旦出现，就等于把逻辑挪出了可测试范围。

pub mod browser;
pub mod fileaccess;
pub mod simulator;

use kcode_app::{AgentService, AppEvent, ServiceConfig};
use kcode_bridge::SpawnConfig;
use kcode_domain::ApprovalDecision;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Emitter, Manager, State};

/// 应用运行时状态。`AgentService` 可克隆（内部是 channel 发送端）。
pub struct AppState {
    pub service: tokio::sync::RwLock<Option<AgentService>>,
    pub paths: KcodePaths,
    /// 右侧栏内嵌浏览器的子 webview 句柄。
    pub browser: browser::BrowserState,
}

/// 应用的目录布局。
///
/// **`codex_home` 必须是隔离目录**——绝不能用用户真实的 `~/.codex`，
/// 否则会继承其个人全局策略并污染真实历史。`SpawnConfig::validate` 会拒绝这种情况。
#[derive(Debug, Clone)]
pub struct KcodePaths {
    /// 应用自有状态目录（事件日志、配置）。
    pub app_data: PathBuf,
    /// 隔离的 CODEX_HOME。
    pub codex_home: PathBuf,
    /// 当前工作区。
    pub workspace: PathBuf,
    /// 锁定的 codex 二进制。
    pub binary: PathBuf,
}

impl KcodePaths {
    /// 解析目录布局。
    ///
    /// `resource_dir` 是 app 的资源目录（打包后 `KCode.app/Contents/Resources`），
    /// `repo_root` 用于开发期在 `node_modules` 里定位 codex 二进制。
    /// 前者优先——打包版没有 `node_modules`。
    ///
    /// 工作区必须**已存在**：静默创建一个空目录会让打错路径的用户以为
    /// 打开的是自己的项目，而后在错误的目录里执行 Agent 操作。
    pub fn resolve(
        app_data: PathBuf,
        workspace: PathBuf,
        repo_root: &std::path::Path,
        resource_dir: Option<&std::path::Path>,
    ) -> Result<Self, String> {
        if !workspace.is_dir() {
            return Err(format!(
                "工作区不存在或不是目录: {}\n                 用法: kcode-desktop [工作区路径]（省略则使用当前目录）",
                workspace.display()
            ));
        }
        // 目录名用 kcode：这是**我们的**目录，不是上游的。
        // 里面对应的 config.toml 仍是 CODEX_HOME 的配置格式（环境变量名不可改）。
        let codex_home = app_data.join("kcode-home");

        // 一次性迁移：早期版本用的是 codex-home。
        // 不做迁移的话，升级后用户会突然发现模型配置与历史全没了——
        // 而目录改名本身只是个命名调整，不该产生这种后果。
        let legacy = app_data.join("codex-home");
        if legacy.is_dir() && !codex_home.exists() {
            if let Err(e) = std::fs::rename(&legacy, &codex_home) {
                eprintln!("[kcode] 旧目录迁移失败（将新建空目录）: {e}");
            }
        }

        std::fs::create_dir_all(&codex_home)
            .map_err(|e| format!("创建 CODEX_HOME 失败: {e}"))?;

        // 写入隔离配置。**这里收紧了一个默认过宽的沙箱设置**：
        //
        // codex 的 `workspace-write` 默认把临时目录也纳入可写集合
        // （`exclude_tmpdir_env_var` 与 `exclude_slash_tmp` 默认均为 false）。
        // 实测确认：默认配置下 Agent 能**不经审批**写入 `$TMPDIR` 及其同级目录——
        // 而 UI 完全不提示这一点，用户以为「工作区可写」等价于「只动项目」。
        //
        // 关闭后：区外写入一律回到审批路径（实测已确认），工作区内写入不受影响。
        let cfg = codex_home.join("config.toml");
        let contents = "\n\n# --- KCode 安全收紧 ---\n\
# 默认情况下 workspace-write 会把临时目录也算作可写，\n\
# 使得 Agent 能不经审批写入 $TMPDIR。这里显式关闭。\n\
[sandbox_workspace_write]\n\
exclude_tmpdir_env_var = true\n\
exclude_slash_tmp = true\n";
        if !cfg.exists() {
            std::fs::write(
                &cfg,
                format!("# KCode 隔离配置。模型与凭据由应用管理。{contents}"),
            )
            .map_err(|e| format!("写入隔离 config.toml 失败: {e}"))?;
        } else {
            // 已存在则确保收紧项在位（用户可能手工改过）
            let cur = std::fs::read_to_string(&cfg).unwrap_or_default();
            if !cur.contains("exclude_tmpdir_env_var") {
                std::fs::write(&cfg, format!("{cur}{contents}"))
                    .map_err(|e| format!("更新隔离 config.toml 失败: {e}"))?;
            }
        }

        // 优先用 app 资源目录里的二进制（打包版），回退到 node_modules（开发期）。
        let binary = kcode_bridge::locate_binary_in(resource_dir, repo_root)
            .map_err(|e| e.to_string())?;
        Ok(Self { app_data, codex_home, workspace, binary })
    }
}

/// 前端收到的错误载荷。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    pub message: String,
}

impl From<String> for CommandError {
    fn from(message: String) -> Self {
        Self { message }
    }
}

// ── Tauri commands ─────────────────────────────────────────────────────────
// 命名与参数均对应方案文档 5.8 节的契约。

/// 启动 agent 运行时。前端启动时调用一次。
#[tauri::command]
async fn start_runtime(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let mut guard = state.service.write().await;
    if guard.is_some() {
        return Ok(()); // 已启动，幂等
    }

    let paths = state.paths.clone();
    let cfg = ServiceConfig {
        spawn: SpawnConfig::new(&paths.binary, &paths.workspace, &paths.codex_home),
        client_name: "kcode".into(),
        client_title: "KCode".into(),
        client_version: env!("CARGO_PKG_VERSION").into(),
    };

    let service = AgentService::start(cfg).await.map_err(CommandError::from)?;

    // 把领域事件桥接到 WebView。前端只看到 AppEvent，不接触协议报文。
    let mut rx = service.subscribe();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    if handle.emit("kcode:event", &ev).is_err() {
                        break; // 窗口已关闭
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    // 事件积压：不能让 UI 在不知情的情况下丢事件——它需要重新拉取状态。
                    let _ = handle.emit(
                        "kcode:event",
                        &AppEvent::Error {
                            message: format!("事件积压，已丢弃 {n} 条；请重新加载线程状态"),
                        },
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    *guard = Some(service);
    Ok(())
}

/// 就绪状态查询。
#[tauri::command]
async fn runtime_ready(state: State<'_, AppState>) -> Result<bool, CommandError> {
    Ok(state.service.read().await.is_some())
}

#[tauri::command]
async fn start_thread(
    state: State<'_, AppState>,
    cwd: String,
    model: Option<String>,
    sandbox: String,
    approval_policy: serde_json::Value,
) -> Result<kcode_app::ThreadInfo, CommandError> {
    let svc = require_service(&state).await?;
    svc.start_thread(cwd, model, sandbox, approval_policy)
        .await
        .map_err(CommandError::from)
}

/// 列出目录直接子项（工作台「文件」场景）。
#[tauri::command]
async fn read_directory(
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<kcode_app::DirEntry>, CommandError> {
    let svc = require_service(&state).await?;
    svc.read_directory(path).await.map_err(CommandError::from)
}

/// 启动终端命令（工作台「终端」场景）。
#[tauri::command]
async fn exec_start(
    state: State<'_, AppState>,
    process_id: String,
    command: Vec<String>,
    cwd: Option<String>,
) -> Result<kcode_app::ExecStarted, CommandError> {
    let svc = require_service(&state).await?;
    svc.exec_start(process_id, command, cwd)
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn exec_write(
    state: State<'_, AppState>,
    process_id: String,
    data: String,
) -> Result<(), CommandError> {
    let svc = require_service(&state).await?;
    svc.exec_write(process_id, data).await.map_err(CommandError::from)
}

#[tauri::command]
async fn exec_terminate(
    state: State<'_, AppState>,
    process_id: String,
) -> Result<(), CommandError> {
    let svc = require_service(&state).await?;
    svc.exec_terminate(process_id).await.map_err(CommandError::from)
}

/// 在右侧栏打开内嵌浏览器。
#[tauri::command]
async fn open_browser(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), CommandError> {
    // 经 AppHandle 取 Window：`add_child` 定义在 Window 上，
    // 而 WebviewWindow 内部的 window 字段是 crate 私有的。
    let window = app
        .get_window("main")
        .ok_or_else(|| CommandError::from("找不到主窗口".to_owned()))?;
    browser::open_browser(&window, &state.browser, "kcode-panel-browser", &url, x, y, width, height)
        .map_err(CommandError::from)
}

/// 浏览器后退 / 前进 / 刷新 / 缩放 / 地址查询 / 元素选择。
#[tauri::command]
async fn browser_back(state: State<'_, AppState>) -> Result<(), CommandError> {
    browser::go_back(&state.browser, "kcode-panel-browser").map_err(CommandError::from)
}

#[tauri::command]
async fn browser_forward(state: State<'_, AppState>) -> Result<(), CommandError> {
    browser::go_forward(&state.browser, "kcode-panel-browser").map_err(CommandError::from)
}

#[tauri::command]
async fn browser_reload(state: State<'_, AppState>) -> Result<(), CommandError> {
    browser::reload(&state.browser, "kcode-panel-browser").map_err(CommandError::from)
}

#[tauri::command]
async fn browser_set_zoom(
    state: State<'_, AppState>,
    factor: f64,
) -> Result<(), CommandError> {
    browser::set_zoom(&state.browser, "kcode-panel-browser", factor).map_err(CommandError::from)
}

#[tauri::command]
async fn browser_current_url(state: State<'_, AppState>) -> Result<String, CommandError> {
    browser::current_url(&state.browser, "kcode-panel-browser").map_err(CommandError::from)
}

/// 进入「选择元素」模式。token 由前端生成，用于标识本次选择。
#[tauri::command]
async fn browser_begin_pick(
    state: State<'_, AppState>,
    token: String,
) -> Result<(), CommandError> {
    browser::begin_pick(&state.browser, "kcode-panel-browser", &token)
        .map_err(CommandError::from)
}

/// 取回一次选择结果（JSON 字符串），没有则返回 null。
#[tauri::command]
async fn browser_take_pick(state: State<'_, AppState>) -> Result<Option<String>, CommandError> {
    browser::take_pick(&state.browser, "kcode-panel-browser").map_err(CommandError::from)
}

/// 模拟视口：让页面按给定的 CSS 尺寸布局，再整体缩放到目标矩形。
///
/// 桌面版网页有最小宽度，窄面板里必然横向溢出。这个命令让页面
/// 「以为」自己有 cssW 宽，从而正常排版，然后缩放显示。
#[tauri::command]
async fn browser_emulate_viewport(
    state: State<'_, AppState>,
    x: f64,
    y: f64,
    css_width: f64,
    css_height: f64,
    scale: f64,
) -> Result<(), CommandError> {
    browser::emulate_viewport(
        &state.browser,
        "kcode-panel-browser",
        x,
        y,
        css_width,
        css_height,
        scale,
    )
    .map_err(CommandError::from)
}

/// 同步内嵌浏览器的位置与尺寸。
///
/// 前端在**任何影响右栏布局的变化**后都必须调用：面板折叠、分栏拖拽、
/// 窗口缩放。子 webview 是原生视图，不参与 CSS 布局，不同步就会浮在
/// 错误的位置上（DOM 里看不出来）。
#[tauri::command]
async fn sync_browser_bounds(
    state: State<'_, AppState>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), CommandError> {
    browser::sync_bounds(&state.browser, "kcode-panel-browser", x, y, width, height)
        .map_err(CommandError::from)
}

/// 隐藏内嵌浏览器（不销毁，页面状态保留）。
#[tauri::command]
async fn hide_browser(state: State<'_, AppState>) -> Result<(), CommandError> {
    browser::hide_browser(&state.browser, "kcode-panel-browser").map_err(CommandError::from)
}

/// 销毁内嵌浏览器。
#[tauri::command]
async fn close_browser(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let window = app
        .get_window("main")
        .ok_or_else(|| CommandError::from("找不到主窗口".to_owned()))?;
    browser::close_browser(&window, &state.browser, "kcode-panel-browser")
        .map_err(CommandError::from)
}

/// 文件/图片详情的载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileDetail {
    /// 工作区相对路径（用于展示）。
    path: String,
    /// 绝对路径（用于「在访达中显示」这类操作）。
    absolute_path: String,
    /// 字节数。
    size: u64,
    /// 是否为二进制（二进制不返回文本内容）。
    binary: bool,
    /// 文本内容（仅当是文本且未超限）。
    text: Option<String>,
    /// 图片的 data URL（仅当是图片且未超限）。
    image_data_url: Option<String>,
    /// 截断说明（内容过大时告知用户，而不是静默截断）。
    truncated: Option<String>,
}

/// 读取文件详情，供右栏展示。
///
/// **路径必须位于工作区内**。右栏的用途是「看会话里提到的那个文件」，
/// 而不是通用文件浏览器；放开任意路径等于给前端一个任意文件读取面，
/// 而前端的内容最终可能来自模型输出。
#[tauri::command]
async fn read_file_detail(
    state: State<'_, AppState>,
    path: String,
) -> Result<FileDetail, CommandError> {
    // 边界校验见 fileaccess：必须 canonicalize 后再比较前缀，
    // 否则 `../..` 与符号链接都能绕过去。那里有对应的测试。
    let (resolved, rel) = fileaccess::resolve_in_workspace(&state.paths.workspace, &path)
        .map_err(CommandError::from)?;

    let meta = std::fs::metadata(&resolved)
        .map_err(|e| CommandError::from(format!("读取文件信息失败: {e}")))?;
    if !meta.is_file() {
        return Err(CommandError::from(format!("不是文件：{path}")));
    }
    let size = meta.len();

    // 内容形态（文本 / 图片 / 二进制 / 超限）的判定在 fileaccess 里，
    // 那里有对应测试。这里只负责组装返回值。
    let loaded = fileaccess::load_content(&resolved, size).map_err(CommandError::from)?;
    let (text, image_data_url, truncated, binary) = match loaded {
        fileaccess::Loaded::Text(t) => (Some(t), None, None, false),
        fileaccess::Loaded::Image(url) => (None, Some(url), None, true),
        fileaccess::Loaded::Binary => (None, None, None, true),
        fileaccess::Loaded::TooLarge(msg) => (None, None, Some(msg), true),
    };

    Ok(FileDetail {
        path: rel,
        absolute_path: resolved.to_string_lossy().into_owned(),
        size,
        binary,
        text,
        image_data_url,
        truncated,
    })
}

#[tauri::command]
async fn read_settings(
    state: State<'_, AppState>,
) -> Result<kcode_app::SettingsSnapshot, CommandError> {
    let svc = require_service(&state).await?;
    svc.read_settings().await.map_err(CommandError::from)
}

/// 切换权限档位。写入 config.toml，因此对**新线程**生效；
/// 已在运行的线程保持启动时的策略（协议层 thread/start 的覆盖不写回配置）。
#[tauri::command]
async fn set_permission_mode(
    state: State<'_, AppState>,
    mode: kcode_app::PermissionMode,
) -> Result<(), CommandError> {
    let svc = require_service(&state).await?;
    svc.set_permission_mode(mode).await.map_err(CommandError::from)
}

#[tauri::command]
async fn send_turn(
    state: State<'_, AppState>,
    thread_id: String,
    text: String,
    // 可选的逐轮模型与推理强度覆盖（来自 Composer 的选择器）。
    // 注意：tauri::command 的参数上不能写文档注释。
    model: Option<String>,
    effort: Option<String>,
    // 随轮次附加的本地图片绝对路径（协议 localImage）。
    // 前端拖入的文件已有路径；粘贴的图片先经 save_attachment 落盘再传路径。
    images: Option<Vec<String>>,
) -> Result<String, CommandError> {
    let svc = require_service(&state).await?;
    svc.send_turn_full(thread_id, text, model, effort, images.unwrap_or_default())
        .await
        .map_err(CommandError::from)
}

#[tauri::command]
async fn steer(
    state: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
    text: String,
) -> Result<(), CommandError> {
    let svc = require_service(&state).await?;
    svc.steer(thread_id, turn_id, text).await.map_err(CommandError::from)
}

#[tauri::command]
async fn interrupt(
    state: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
) -> Result<(), CommandError> {
    let svc = require_service(&state).await?;
    svc.interrupt(thread_id, turn_id).await.map_err(CommandError::from)
}

/// 回应用户审批决策。
///
/// `decision` 取协议枚举值（`accept` / `acceptForSession` / `decline` / `cancel` …）。
/// **`decline` 与 `cancel` 语义不同**：前者拒绝本次操作，后者还会中断整个 Turn。
#[tauri::command]
async fn resolve_approval(
    state: State<'_, AppState>,
    request_id: String,
    decision: String,
    scope: Option<String>,
) -> Result<(), CommandError> {
    let svc = require_service(&state).await?;
    let decision = ApprovalDecision::from_protocol(&decision)
        .ok_or_else(|| CommandError::from(format!("未知的决策值: {decision}")))?;
    let scope = scope.as_deref().map(|s| match s {
        "turn" => kcode_domain::ApprovalScope::Turn,
        "session" => kcode_domain::ApprovalScope::Session,
        "project" => kcode_domain::ApprovalScope::Project,
        _ => kcode_domain::ApprovalScope::Once,
    });
    svc.resolve_approval(request_id, decision, scope)
        .await
        .map_err(CommandError::from)
}

/// 查询工作区的 git 状态（分支、更改统计、领先/落后）。
///
/// 协议不提供 git 能力，这一层是自研的。面板与输入区的上下文芯片
/// 都依赖它。
#[tauri::command]
async fn git_status(state: State<'_, AppState>) -> Result<kcode_bridge::GitStatus, CommandError> {
    let workspace = state.paths.workspace.clone();
    // git 调用是阻塞的（起子进程），放到阻塞线程池避免占住 async 运行时
    let status = tauri::async_runtime::spawn_blocking(move || kcode_bridge::git::status(&workspace))
        .await
        .map_err(|e| CommandError::from(format!("git 查询失败: {e}")))?;
    Ok(status)
}

/// 提交全部改动。
///
/// 本地操作，不产生网络流量。要求显式提供提交信息——不做「自动生成信息」
/// 这类便利，因为它让用户在没看清改动的情况下就产生了提交。
#[tauri::command]
async fn git_commit(
    state: State<'_, AppState>,
    message: String,
) -> Result<String, CommandError> {
    let workspace = state.paths.workspace.clone();
    tauri::async_runtime::spawn_blocking(move || kcode_bridge::git::commit_all(&workspace, &message))
        .await
        .map_err(|e| CommandError::from(format!("提交失败: {e}")))?
        .map_err(CommandError::from)
}

/// 推送到当前分支的上游。
///
/// **网络操作。** 目标必须是用户配置的 remote——UI 必须先展示目标再让用户确认，
/// 这是项目的零静默外发约束在 git 上的体现。
#[tauri::command]
async fn git_push(state: State<'_, AppState>) -> Result<String, CommandError> {
    let workspace = state.paths.workspace.clone();
    tauri::async_runtime::spawn_blocking(move || kcode_bridge::git::push(&workspace))
        .await
        .map_err(|e| CommandError::from(format!("推送失败: {e}")))?
        .map_err(CommandError::from)
}

/// 查询默认 remote（UI 展示推送目标用）。
#[tauri::command]
async fn git_remote(state: State<'_, AppState>) -> Result<Option<String>, CommandError> {
    let workspace = state.paths.workspace.clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        kcode_bridge::git::default_remote(&workspace)
    })
    .await
    .unwrap_or(None))
}

/// 撤销单个文件的未提交改动。
///
/// **破坏性操作**：未跟踪文件（Agent 新建的）会被删除，git 找不回来。
/// 因此 UI 必须先确认；本命令只负责执行，不做二次询问。
///
/// 为什么不用协议的 `thread/revert`：实测其 schema 明确写着只替换
/// **会话历史**、不动本地文件（"Clients are responsible for reverting
/// these changes"）。见 `kcode_bridge::git::revert_file` 的说明。
#[tauri::command]
async fn revert_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<kcode_bridge::FileRevert, CommandError> {
    let workspace = state.paths.workspace.clone();
    // 路径先过工作区边界校验（与读文件同一道防线），再交给 git。
    // git 那边还会再挡一次绝对路径与 `..`——两层都要：这一层挡的是
    // 「访问到工作区外」，那一层挡的是「git 自己解析到工作区外」。
    let (_, rel) = fileaccess::resolve_in_workspace_allow_missing(&workspace, &path)
        .map_err(CommandError::from)?;
    tauri::async_runtime::spawn_blocking(move || kcode_bridge::git::revert_file(&workspace, &rel))
        .await
        .map_err(|e| CommandError::from(format!("撤销失败: {e}")))?
        .map_err(CommandError::from)
}

/// 探测本机可用的外部编辑器。
///
/// UI 用它决定「打开方式」按钮写什么、能不能承诺跳到行——
/// 探测结果与用户预期不符时（本机装了多个编辑器）必须能看见。
#[tauri::command]
async fn editor_info() -> Result<kcode_bridge::EditorInfo, CommandError> {
    Ok(kcode_bridge::editor::info())
}

/// 在外部编辑器里打开文件，可选跳到指定行。
///
/// 文件不存在时报错而不是静默失败：审阅面板里的路径可能尚未落盘
/// （`proposed` 变更），用户需要知道「现在还没有这个文件」。
#[tauri::command]
async fn open_in_editor(
    state: State<'_, AppState>,
    path: String,
    line: Option<u32>,
) -> Result<String, CommandError> {
    let workspace = state.paths.workspace.clone();
    let (resolved, _) = fileaccess::resolve_in_workspace_allow_missing(&workspace, &path)
        .map_err(CommandError::from)?;
    tauri::async_runtime::spawn_blocking(move || kcode_bridge::editor::open(&resolved, line))
        .await
        .map_err(|e| CommandError::from(format!("打开编辑器失败: {e}")))?
        .map_err(CommandError::from)
}

/// 枚举历史线程。
///
/// **前端启动时必须调用它**，否则重启后侧栏会是空的——进程内状态会丢，
/// 事件日志不会。「可恢复」这一主张在 UI 上能否成立，取决于这个调用。
#[tauri::command]
async fn list_threads(state: State<'_, AppState>) -> Result<Vec<kcode_app::ThreadSummary>, CommandError> {
    let svc = require_service(&state).await?;
    svc.list_threads().await.map_err(CommandError::from)
}

/// 重建单个线程的时间线与轮次状态。
#[tauri::command]
async fn load_thread(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<kcode_app::ThreadSnapshot, CommandError> {
    let svc = require_service(&state).await?;
    svc.load_thread(thread_id).await.map_err(CommandError::from)
}

/// 搜索/列出线程（服务端 `thread/list`，支持 searchTerm）。
#[tauri::command]
async fn list_threads_remote(
    state: State<'_, AppState>,
    search_term: Option<String>,
) -> Result<Vec<kcode_app::ThreadSummary>, CommandError> {
    let svc = require_service(&state).await?;
    svc.list_threads_remote(search_term)
        .await
        .map_err(CommandError::from)
}

/// 重命名线程（协议 `thread/name/set`）。
#[tauri::command]
async fn thread_name_set(
    state: State<'_, AppState>,
    thread_id: String,
    name: String,
) -> Result<(), CommandError> {
    let svc = require_service(&state).await?;
    svc.set_thread_name(thread_id, name).await.map_err(CommandError::from)
}

/// 归档 / 取消归档线程（协议 `thread/archive`、`thread/unarchive`）。
#[tauri::command]
async fn thread_archive(
    state: State<'_, AppState>,
    thread_id: String,
    archived: bool,
) -> Result<(), CommandError> {
    let svc = require_service(&state).await?;
    svc.archive_thread(thread_id, archived).await.map_err(CommandError::from)
}

/// 模糊搜索工作区文件，供输入框 `@` 引用。
#[tauri::command]
async fn fuzzy_search_files(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<kcode_app::FileMatch>, CommandError> {
    let svc = require_service(&state).await?;
    let cwd = state.paths.workspace.display().to_string();
    svc.fuzzy_search_files(cwd, query).await.map_err(CommandError::from)
}

/// 请求压缩线程上下文（协议 `thread/compact/start`）。
#[tauri::command]
async fn compact_thread(
    state: State<'_, AppState>,
    thread_id: String,
) -> Result<(), CommandError> {
    let svc = require_service(&state).await?;
    svc.compact_thread(thread_id).await.map_err(CommandError::from)
}

/// 一个已接受的图片附件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedAttachment {
    /// 落盘后的绝对路径——交给协议 `localImage` 用。
    path: String,
    /// 文件名（展示用）。
    name: String,
    /// 字节数。
    size: u64,
    /// data URL，供输入区缩略图与时间线预览。
    ///
    /// **随附件一起返回，而不是让前端事后按路径来读**：那样会多出一个
    /// 「按任意路径读文件」的接口，而这里只需要把刚收到的字节编码回去。
    preview_data_url: String,
}

/// 附件目录。所有附件都落在这里——**唯一的图片读取根**。
fn attachments_dir(app_data: &std::path::Path) -> std::path::PathBuf {
    app_data.join("attachments")
}

/// 生成附件文件名：扩展名走白名单，主名由我们生成。
///
/// 不能直接用调用方给的文件名——它可能含 `/` 或 `..`，拼进路径即穿越。
fn attachment_path(dir: &std::path::Path, ext_hint: &str) -> std::path::PathBuf {
    let ext = if ext_hint.len() <= 8 && ext_hint.chars().all(|c| c.is_ascii_alphanumeric()) {
        ext_hint.to_ascii_lowercase()
    } else {
        "png".to_owned()
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0);
    dir.join(format!("attachment-{stamp}.{ext}"))
}

/// 把字节写成附件并组装返回值（粘贴与拖入共用）。
fn store_attachment(
    app_data: &std::path::Path,
    bytes: &[u8],
    ext_hint: &str,
    name: &str,
) -> Result<SavedAttachment, CommandError> {
    // 单条上限 20MB：模型侧对图片本就有分辨率上限，更大的图既送不进去
    // 也会把报文撑爆。提前挡住并给出可读原因，比让上游报错更好排查。
    const MAX: usize = 20 * 1024 * 1024;
    if bytes.len() > MAX {
        return Err(CommandError::from(format!(
            "图片过大（{:.1}MB，上限 20MB）",
            bytes.len() as f64 / 1024.0 / 1024.0
        )));
    }

    let dir = attachments_dir(app_data);
    std::fs::create_dir_all(&dir)
        .map_err(|e| CommandError::from(format!("创建附件目录失败：{e}")))?;
    let path = attachment_path(&dir, ext_hint);
    std::fs::write(&path, bytes)
        .map_err(|e| CommandError::from(format!("写入附件失败：{e}")))?;

    let mime = crate::fileaccess::image_mime(&path).unwrap_or("image/png");
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);

    Ok(SavedAttachment {
        path: path.display().to_string(),
        name: name.to_owned(),
        size: bytes.len() as u64,
        preview_data_url: format!("data:{mime};base64,{b64}"),
    })
}

/// 探测本机模拟器可用性（Android / iOS）。
#[tauri::command]
async fn simulator_probe() -> Result<simulator::SimulatorStatus, CommandError> {
    Ok(simulator::probe().await)
}

/// 启动一个 Android 模拟器。
#[tauri::command]
async fn simulator_start(avd: String) -> Result<(), CommandError> {
    simulator::start(&avd).await.map_err(CommandError::from)
}

/// 关闭一个运行中的模拟器。
#[tauri::command]
async fn simulator_stop(serial: String) -> Result<(), CommandError> {
    simulator::stop(&serial).await.map_err(CommandError::from)
}

/// 取一帧模拟器画面（data URL + 设备尺寸）。
#[tauri::command]
async fn simulator_frame(serial: String) -> Result<SimulatorFrame, CommandError> {
    let (data_url, width, height) = simulator::frame(&serial).await.map_err(CommandError::from)?;
    Ok(SimulatorFrame { data_url, width, height })
}

/// 一帧画面及其设备尺寸（前端据此换算点击坐标）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SimulatorFrame {
    data_url: String,
    width: u32,
    height: u32,
}

/// 向模拟器发送输入（tap / swipe / back / home），坐标为设备坐标。
#[tauri::command]
async fn simulator_input(
    serial: String,
    action: String,
    x1: Option<i64>,
    y1: Option<i64>,
    x2: Option<i64>,
    y2: Option<i64>,
    duration_ms: Option<u64>,
) -> Result<(), CommandError> {
    let (x1, y1, x2, y2) = (x1.unwrap_or(0), y1.unwrap_or(0), x2.unwrap_or(0), y2.unwrap_or(0));
    simulator::input(&serial, &action, x1, y1, x2, y2, duration_ms.unwrap_or(120))
        .await
        .map_err(CommandError::from)
}

/// 保存**粘贴**的图片附件（剪贴板只有字节，没有路径）。
///
/// 协议的图片输入只有 `localImage`（本地路径）与 `image`（URL）两种，
/// **没有内嵌 base64 的形式**，因此必须先写到磁盘。
#[tauri::command]
async fn save_attachment(
    state: State<'_, AppState>,
    file_name: String,
    data_base64: String,
) -> Result<SavedAttachment, CommandError> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|e| CommandError::from(format!("附件数据不是合法 base64：{e}")))?;
    // 先取出扩展名与展示名（两者都是 String），再交出 file_name，
    // 否则借用与移动会冲突。
    let ext = std::path::Path::new(&file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_owned();
    let name = if file_name.is_empty() {
        "粘贴的图片".to_owned()
    } else {
        file_name
    };
    store_attachment(&state.paths.app_data, &bytes, &ext, &name)
}

/// 接纳**拖入**的图片文件：校验后复制进附件目录。
///
/// # 为什么要复制，而不是直接用原路径
///
/// 原路径可能在任何地方（桌面、下载、外接盘）。若直接引用它：
///
/// 1. 时间线要显示预览就得提供一个「按任意路径读文件」的接口——
///    那是一个静默的任意文件读取面（前端能读到 `~/Pictures` 里的任何东西）；
/// 2. 用户移动或删除源文件后，这条消息的图片就永久失效了。
///
/// 复制进 `attachments/` 后，读图接口只需认这一个目录，且附件不再依赖源文件。
/// 代价只是一份副本。
#[tauri::command]
async fn attach_local_image(
    state: State<'_, AppState>,
    path: String,
) -> Result<SavedAttachment, CommandError> {
    let src = std::path::Path::new(&path);
    let mime = crate::fileaccess::image_mime(src)
        .ok_or_else(|| CommandError::from(format!("不是支持的图片格式：{path}")))?;
    let meta = std::fs::metadata(src)
        .map_err(|e| CommandError::from(format!("读取文件失败：{e}")))?;
    if !meta.is_file() {
        return Err(CommandError::from(format!("不是文件：{path}")));
    }
    let bytes = std::fs::read(src).map_err(|e| CommandError::from(format!("读取失败：{e}")))?;
    let _ = mime;
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("png");
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("图片")
        .to_owned();
    store_attachment(&state.paths.app_data, &bytes, ext, &name)
}

/// 读取附件图片的 data URL（时间线预览用）。
///
/// **只接受附件目录内的路径**：这是渲染历史消息所必需的读取，而历史里的
/// 路径本来就是我们落盘时写下的。收紧到单一目录，避免它变成通用的
/// 「按路径读文件」接口。
#[tauri::command]
async fn read_attachment_image(
    state: State<'_, AppState>,
    path: String,
) -> Result<String, CommandError> {
    let dir = attachments_dir(&state.paths.app_data);
    let p = std::path::Path::new(&path);
    // 必须直接位于附件目录下（不允许子路径穿越）
    if p.parent() != Some(dir.as_path()) {
        return Err(CommandError::from("该路径不在附件目录内，拒绝读取".to_owned()));
    }
    let mime = crate::fileaccess::image_mime(p)
        .ok_or_else(|| CommandError::from("不是支持的图片格式".to_owned()))?;
    let bytes = std::fs::read(p).map_err(|e| CommandError::from(format!("读取失败：{e}")))?;
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

/// 列出当前工作区可见的技能。
#[tauri::command]
async fn list_skills(state: State<'_, AppState>) -> Result<Vec<kcode_app::SkillInfo>, CommandError> {
    let svc = require_service(&state).await?;
    let cwd = state.paths.workspace.display().to_string();
    svc.list_skills(cwd).await.map_err(CommandError::from)
}

/// 列出插件市场与已安装插件。
#[tauri::command]
async fn list_plugins(state: State<'_, AppState>) -> Result<Vec<kcode_app::PluginInfo>, CommandError> {
    let svc = require_service(&state).await?;
    svc.list_plugins().await.map_err(CommandError::from)
}

/// 记录用户对某个变更文件的接受/拒绝决策。
///
/// 持久化到事件日志——刷新或重启后审阅结论仍在。
#[tauri::command]
async fn decide_file(
    state: State<'_, AppState>,
    thread_id: String,
    turn_id: String,
    path: String,
    decision: String,
) -> Result<(), CommandError> {
    let svc = require_service(&state).await?;
    let decision = kcode_domain::FileDecision::parse(&decision)
        .ok_or_else(|| CommandError::from(format!("未知的决策值: {decision}")))?;
    svc.decide_file(thread_id, turn_id, path, decision)
        .await
        .map_err(CommandError::from)
}

/// 列出当前 provider 可用的模型（由 app-server 回答，非硬编码）。
#[tauri::command]
async fn list_models(state: State<'_, AppState>) -> Result<Vec<kcode_app::ModelOption>, CommandError> {
    let svc = require_service(&state).await?;
    svc.list_models().await.map_err(CommandError::from)
}

/// 导出审计日志（方案 6.1 第 10 条：用户必须能自己回答问题）。
#[tauri::command]
async fn export_audit(state: State<'_, AppState>) -> Result<String, CommandError> {
    let svc = require_service(&state).await?;
    svc.export_audit().await.map_err(CommandError::from)
}

/// 暴露运行环境信息，供 UI 显示（沙箱状态、隔离目录等）。
#[tauri::command]
async fn environment_info(state: State<'_, AppState>) -> Result<serde_json::Value, CommandError> {
    let p = &state.paths;
    Ok(serde_json::json!({
        "workspace": p.workspace.display().to_string(),
        // codexHome 这个名字保留：它就是该目录的语义（CODEX_HOME 的值）。
        // 但字段名避免直接叫 codexBinary —— 这是我们的 API，
        // 换成与实现无关的 binaryPath，将来换内核也不用改契约。
        "codexHome": p.codex_home.display().to_string(),
        "binaryPath": p.binary.display().to_string(),
        "appData": p.app_data.display().to_string(),
    }))
}

async fn require_service(state: &State<'_, AppState>) -> Result<AgentService, CommandError> {
    state
        .service
        .read()
        .await
        .clone()
        .ok_or_else(|| CommandError::from("运行时尚未启动，请先调用 start_runtime".to_owned()))
}

/// 在 GUI 环境下展示致命错误。
///
/// 优先用系统对话框（macOS 的 osascript / Linux 的 zenity），
/// 都不可用时退回 stderr。目的是让用户看到**一句人话**，
/// 而不是 Rust 的 panic backtrace。
fn show_fatal_dialog(message: &str) {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display dialog {} with title \"KCode 启动失败\" buttons {{\"好\"}} default button 1 with icon stop",
            applescript_quote(message)
        );
        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .status();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("zenity")
            .args(["--error", "--title=KCode 启动失败", "--text", message])
            .status();
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = message;
    }
}

/// 把字符串转义为 AppleScript 字面量。
fn applescript_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// 构建并运行 Tauri 应用。
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let app_data = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("解析应用目录失败: {e}"))?;
            std::fs::create_dir_all(&app_data)?;

            // 工作区：启动参数指定，默认当前目录。
            let workspace = std::env::args()
                .nth(1)
                .map(PathBuf::from)
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

            // 开发期从仓库根定位 codex 二进制（npm 安装位置）。
            let repo_root = std::env::var("KCODE_REPO_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(|_| workspace.clone());

            // 启动失败要给**可读提示**，而不是 panic 堆栈。
            //
            // Tauri 的 setup 里 `?` 会导致 panic，用户看到的是一屏 backtrace。
            // 工作区路径写错是很常见的操作失误，理应得到一句人话。
            // 打包后 resources/ 里有暂存的 codex 二进制；开发期该目录不存在，
            // 会回退到 node_modules。
            let resource_dir = app.path().resource_dir().ok();
            let paths = match KcodePaths::resolve(app_data, workspace, &repo_root, resource_dir.as_deref()) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("\n[kcode] 启动失败：{e}\n");
                    // 用对话框而非 panic：用户在 GUI 里看不到 stderr
                    show_fatal_dialog(&e);
                    std::process::exit(2);
                }
            };

            // 设置窗口背景色。
            //
            // 必须用运行时 API：`tauri.conf.json` 里**没有** backgroundColor
            // 字段（我最初写在配置里，被静默忽略了，白屏依旧）。
            // 窗口默认背景是系统色（浅色系统上即纯白），
            // 在 WebView 完成首次绘制前会一直显示它。
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_background_color(Some(tauri::window::Color(6, 7, 10, 255)));
            }

            app.manage(AppState {
                service: tokio::sync::RwLock::new(None),
                paths,
                browser: browser::BrowserState::default(),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_runtime,
            runtime_ready,
            start_thread,
            send_turn,
            steer,
            interrupt,
            resolve_approval,
            thread_name_set,
            thread_archive,
            list_threads,
            load_thread,
            list_models,
            read_settings,
            open_browser,
            read_directory,
            exec_start,
            exec_write,
            exec_terminate,
            sync_browser_bounds,
            browser_back,
            browser_forward,
            browser_reload,
            browser_set_zoom,
            browser_current_url,
            browser_emulate_viewport,
            browser_begin_pick,
            browser_take_pick,
            hide_browser,
            close_browser,
            read_file_detail,
            set_permission_mode,
            decide_file,
            list_threads_remote,
            list_skills,
            save_attachment,
            attach_local_image,
            read_attachment_image,
            simulator_probe,
            simulator_start,
            simulator_stop,
            simulator_frame,
            simulator_input,
            fuzzy_search_files,
            compact_thread,
            list_plugins,
            export_audit,
            environment_info,
            git_status,
            git_commit,
            git_push,
            git_remote,
            revert_file,
            editor_info,
            open_in_editor,
        ])
        .run(tauri::generate_context!())
        .expect("启动 KCode 失败");
}

/// 供测试引用的共享状态构造。
pub fn shared_state(paths: KcodePaths) -> Arc<AppState> {
    Arc::new(AppState {
        browser: browser::BrowserState::default(),
        service: tokio::sync::RwLock::new(None),
        paths,
    })
}
