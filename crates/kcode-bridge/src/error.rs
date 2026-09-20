//! 适配层错误类型。

use std::time::Duration;

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON 编解码失败: {0}")]
    Json(#[from] serde_json::Error),

    /// 服务端明确返回的 JSON-RPC 错误。
    ///
    /// 注意 `-32600 "no active turn to interrupt"` 属于**正常业务结果**，
    /// 表示目标轮次已结束——调用方应把它折叠进「已结束」终态，而不是当作故障。
    #[error("RPC 错误 {code}: {message}")]
    Rpc { code: i64, message: String },

    #[error("请求 {method} 在 {timeout:?} 内未收到响应")]
    Timeout { method: String, timeout: Duration },

    /// 子进程已退出，或 stdout 管道关闭。所有待决请求都会以此错误收敛。
    #[error("app-server 连接已关闭 (退出码 {code:?})")]
    Closed { code: Option<i32> },

    #[error("启动配置无效: {0}")]
    InvalidConfig(String),

    #[error("协议报文无法分类: {0}")]
    Protocol(String),
}

pub type Result<T, E = BridgeError> = std::result::Result<T, E>;
