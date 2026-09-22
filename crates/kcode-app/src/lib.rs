//! # kcode-app
//!
//! 应用服务层：编排 [`kcode_bridge`]（L1 适配）与 [`kcode_domain`]（L2 领域），
//! 向前端暴露稳定的领域 API 与事件流。
//!
//! **不依赖 Tauri**——因此可用真实 app-server 完整测试，无需拉起桌面壳。
//! Tauri 宿主层只做一层极薄的命令转发（见 `src-tauri`）。
//!
//! ## 边界
//!
//! UI 只消费 [`service::AppEvent`]，不接触任何官方 wire type。
//! 协议字段变化只影响本层投影实现。

pub mod service;

pub use service::{
    is_declined, load_thread_snapshot, replay_items, request_id_from_key, request_id_key,
    should_mark_unknown, summarize_threads, AgentService, AppEvent, DirEntry, ExecStarted,
    ModelOption, PermissionMode,
    PermissionProfile, ServiceConfig, SettingsSnapshot,
    PluginInfo, SkillInfo, TextChannel, ThreadInfo, ThreadSnapshot, ThreadSummary,
    FileMatch,
    ThreadTokenUsage, TokenUsageBreakdown, TurnSnapshot,
};
