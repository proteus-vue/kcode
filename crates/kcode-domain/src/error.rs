//! 领域层错误。

#[derive(Debug, thiserror::Error)]
pub enum DomainError {
    #[error("数据库错误: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("序列化失败: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("协议报文无法投影为领域状态: {0}")]
    Projection(String),

    #[error("领域对象不存在: {0}")]
    NotFound(String),
}

pub type Result<T, E = DomainError> = std::result::Result<T, E>;
