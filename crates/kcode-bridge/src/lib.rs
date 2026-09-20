//! # codex-bridge
//!
//! `codex app-server` 的 JSON-RPC 适配层（方案中的 L1）。
//!
//! 刻意**不依赖 Tauri**：适配层的职责是吸收官方协议的版本漂移，把它和宿主层
//! 解耦既符合分层设计，也让测试不必拉起整个桌面壳。
//!
//! ## 用法
//!
//! ```no_run
//! use kcode_bridge::{JsonlTransport, SpawnConfig};
//!
//! # async fn demo() -> kcode_bridge::Result<()> {
//! let cfg = SpawnConfig::new("/path/to/codex", "/path/to/workspace", "/path/to/isolated-home");
//! let mut transport = JsonlTransport::spawn(&cfg).await?;
//! transport.initialize("kcode", "KCode", "0.1.0", Some(cfg.codex_home.as_path())).await?;
//!
//! // 建线程：sandbox 用字符串枚举
//! let started = transport.request("thread/start", serde_json::json!({
//!     "cwd": cfg.cwd,
//!     "approvalPolicy": "on-request",
//!     "sandbox": "workspace-write",
//! })).await?;
//!
//! // 提交轮次：sandboxPolicy 用对象形态，与上面不同
//! let turn = transport.request("turn/start", serde_json::json!({
//!     "threadId": started["thread"]["id"],
//!     "input": [{ "type": "text", "text": "修复 CI" }],
//! })).await?;
//!
//! // 事件循环：服务端请求必须回应，否则 Turn 永久挂起
//! while let Some(event) = transport.next_inbound(std::time::Duration::from_secs(30)).await {
//!     if let kcode_bridge::Incoming::ServerRequest { id, method, .. } = &event {
//!         if event.is_approval_request() {
//!             let _ = method;
//!             transport.respond(id, serde_json::json!({ "decision": "accept" })).await?;
//!         }
//!     }
//! }
//! # Ok(())
//! # }
//! ```

pub mod binary;
pub mod git;
pub mod error;
pub mod jsonl;
pub mod process;
pub mod transport;

pub use binary::{locate_binary, locate_binary_in, sha256_file, LockRecord, SECURITY_BASELINE};
pub use error::{BridgeError, Result};
pub use git::GitStatus;
pub use jsonl::{Incoming, JsonlError, LineFramer, RequestId, RpcErrorPayload};
pub use process::{is_user_default_codex_home, SpawnConfig};
pub use transport::{
    InboundReceiver, InitializeOutcome, JsonlTransport, RecvOutcome, DEFAULT_REQUEST_TIMEOUT,
};

/// 审批方法 → 响应体形态。
///
/// 三类审批方法用**不同**的响应结构，混用会导致决策被忽略、Turn 挂起：
///
/// - `item/commandExecution/requestApproval` → `{ "decision": ... }`
/// - `item/fileChange/requestApproval` → `{ "decision": ... }`
/// - `item/permissions/requestApproval` → `{ "permissions": {...}, "scope": ... }`
///
/// legacy 的 `execCommandApproval` / `applyPatchApproval` 同样返回 `{ "decision": ... }`，
/// 但决策值取自 v1 的 `ReviewDecision`。
pub fn approval_response(method: &str, decision: &str) -> serde_json::Value {
    match method {
        "item/permissions/requestApproval" => serde_json::json!({
            "permissions": {},
            "scope": "turn",
        }),
        // 命令与文件变更审批：{decision}；legacy 方法同形
        _ => serde_json::json!({ "decision": decision }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn approval_response_shape_differs_by_method() {
        assert_eq!(
            approval_response("item/commandExecution/requestApproval", "accept"),
            json!({ "decision": "accept" })
        );
        assert_eq!(
            approval_response("item/fileChange/requestApproval", "decline"),
            json!({ "decision": "decline" })
        );
        // 权限审批不接收 decision，而是回填授权后的权限集与作用域
        assert_eq!(
            approval_response("item/permissions/requestApproval", "accept"),
            json!({ "permissions": {}, "scope": "turn" })
        );
    }
}
