//! JSONL 拆包与入站报文分类。
//!
//! 协议在 stdio 上使用换行分隔的 JSON，且**线路上省略 `"jsonrpc"` 字段**——
//! 解析器不得强制要求该字段存在。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

/// JSON-RPC 请求标识。
///
/// 我们发出的 id 是递增整数，但服务端回传的 id 形态不受我们控制，
/// 因此两种形态都要能承载，且回显服务端请求 id 时必须保持原样。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Num(u64),
    Str(String),
}

impl RequestId {
    /// 用作 pending map 的键。数值与字符串加前缀区分，避免 `"1"` 与 `1` 相撞。
    pub fn key(&self) -> String {
        match self {
            RequestId::Num(n) => format!("n:{n}"),
            RequestId::Str(s) => format!("s:{s}"),
        }
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RequestId::Num(n) => write!(f, "{n}"),
            RequestId::Str(s) => f.write_str(s),
        }
    }
}

/// 服务端错误载荷。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RpcErrorPayload {
    pub code: i64,
    pub message: String,
}

/// 一条入站报文。
///
/// **三类报文必须分流处理，混用会导致审批静默挂起：**
///
/// | 形态 | 类别 | 处置 |
/// |---|---|---|
/// | 有 `id`、无 `method` | 响应 | 按 id 唤醒待决请求 |
/// | 有 `id`、有 `method` | **服务端请求**（审批走这里） | 交给 UI，必须回应 |
/// | 无 `id`、有 `method` | 通知 | 投影为领域事件 |
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    Response {
        id: RequestId,
        result: std::result::Result<Value, RpcErrorPayload>,
    },
    ServerRequest {
        id: RequestId,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
}

impl Incoming {
    pub fn method(&self) -> Option<&str> {
        match self {
            Incoming::Response { .. } => None,
            Incoming::ServerRequest { method, .. } | Incoming::Notification { method, .. } => {
                Some(method)
            }
        }
    }

    /// 是否为「等待客户端决策」的服务端请求。
    pub fn is_server_request(&self) -> bool {
        matches!(self, Incoming::ServerRequest { .. })
    }

    /// 是否为审批类服务端请求（`item/*/requestApproval`）。
    ///
    /// 注意 legacy 的 `execCommandApproval` / `applyPatchApproval` 也属于审批请求，
    /// 但它们在 0.155.1 中已标记 DEPRECATED，仅用于经 legacy API 启动的 Turn。
    /// 这里一并识别，是为了在兼容场景下仍能正确回应而不是挂起。
    pub fn is_approval_request(&self) -> bool {
        match self {
            Incoming::ServerRequest { method, .. } => {
                method.ends_with("/requestApproval")
                    || method == "execCommandApproval"
                    || method == "applyPatchApproval"
            }
            _ => false,
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum JsonlError {
    #[error("报文不是 JSON 对象")]
    NotAnObject,
    #[error("报文既无有效 id 也无 method，无法分类")]
    Unclassifiable,
    #[error("JSON 解析失败: {0}")]
    Parse(String),
    #[error("单行报文超过 {limit} 字节上限")]
    LineTooLong { limit: usize },
}

/// 把一行原始文本分类为 `Incoming`。
pub fn classify(raw: &str) -> std::result::Result<Incoming, JsonlError> {
    let v: Value = serde_json::from_str(raw).map_err(|e| JsonlError::Parse(e.to_string()))?;
    let obj = v.as_object().ok_or(JsonlError::NotAnObject)?;

    let method = obj.get("method").and_then(Value::as_str).map(str::to_owned);
    // `"id": null` 视为「无 id」：JSON-RPC 用 null id 表示无法关联的应答，对我们没有意义。
    let id = obj.get("id").filter(|v| !v.is_null()).and_then(parse_id);
    let params = || obj.get("params").cloned().unwrap_or(Value::Null);

    match (method, id) {
        (Some(method), Some(id)) => Ok(Incoming::ServerRequest { id, method, params: params() }),
        (Some(method), None) => Ok(Incoming::Notification { method, params: params() }),
        (None, Some(id)) => {
            let result = match obj.get("error") {
                Some(err) => Err(RpcErrorPayload {
                    code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                    message: err
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                }),
                None => Ok(obj.get("result").cloned().unwrap_or(Value::Null)),
            };
            Ok(Incoming::Response { id, result })
        }
        (None, None) => Err(JsonlError::Unclassifiable),
    }
}

fn parse_id(v: &Value) -> Option<RequestId> {
    if let Some(n) = v.as_u64() {
        Some(RequestId::Num(n))
    } else {
        v.as_str().map(|s| RequestId::Str(s.to_owned()))
    }
}

/// 按换行边界把字节流切成完整报文行。
///
/// 可以直接按字节找 `\n` 而不需要 JSON 解析状态：JSON 字符串内部的换行
/// 会被转义为 `\n` 两个字符，因此真实换行只可能出现在报文边界。
#[derive(Debug)]
pub struct LineFramer {
    buf: Vec<u8>,
    max_line: usize,
}

impl LineFramer {
    /// 单行上限。超限说明上游行为异常，宁可报错也不要无界吃内存。
    pub const DEFAULT_MAX_LINE: usize = 32 * 1024 * 1024;

    pub fn new(max_line: usize) -> Self {
        Self { buf: Vec::new(), max_line }
    }

    /// 追加一段字节，返回其中所有已经完整的行（不含换行符）。
    pub fn push(&mut self, chunk: &[u8]) -> std::result::Result<Vec<String>, JsonlError> {
        self.buf.extend_from_slice(chunk);

        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=pos).collect();
            line.pop(); // 去掉 \n
            if line.last() == Some(&b'\r') {
                line.pop(); // 兼容 CRLF
            }
            if line.is_empty() {
                continue; // 空行跳过
            }
            out.push(String::from_utf8_lossy(&line).into_owned());
        }

        if self.buf.len() > self.max_line {
            return Err(JsonlError::LineTooLong { limit: self.max_line });
        }
        Ok(out)
    }

    /// 缓冲区中尚未成行的残留字节数（正常应为 0；非 0 说明报文被截断）。
    pub fn pending_bytes(&self) -> usize {
        self.buf.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ── 拆包 ────────────────────────────────────────────────────────────

    #[test]
    fn frames_message_split_across_chunks() {
        let mut f = LineFramer::new(1024);
        assert!(f.push(br#"{"method":"a""#).unwrap().is_empty());
        assert!(f.push(br#","id":1}"#).unwrap().is_empty());
        let lines = f.push(b"\n").unwrap();
        assert_eq!(lines, vec![r#"{"method":"a","id":1}"#]);
        assert_eq!(f.pending_bytes(), 0);
    }

    #[test]
    fn frames_multiple_complete_lines() {
        let mut f = LineFramer::new(1024);
        let lines = f.push(b"{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n").unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[2], r#"{"c":3}"#);
    }

    #[test]
    fn handles_crlf_and_blank_lines() {
        let mut f = LineFramer::new(1024);
        let lines = f.push(b"{\"a\":1}\r\n\r\n{\"b\":2}\r\n").unwrap();
        assert_eq!(lines, vec![r#"{"a":1}"#, r#"{"b":2}"#]);
    }

    #[test]
    fn rejects_oversized_line() {
        let mut f = LineFramer::new(32);
        let err = f.push(&[b'x'; 64]).unwrap_err();
        assert!(matches!(err, JsonlError::LineTooLong { .. }));
    }

    // ── 分类 ────────────────────────────────────────────────────────────

    #[test]
    fn notification_when_no_id() {
        let got = classify(r#"{"method":"item/started","params":{"threadId":"t1"}}"#).unwrap();
        match got {
            Incoming::Notification { method, params } => {
                assert_eq!(method, "item/started");
                assert_eq!(params["threadId"], "t1");
            }
            other => panic!("应为通知，实际 {other:?}"),
        }
    }

    #[test]
    fn server_request_when_id_and_method() {
        let got = classify(
            r#"{"method":"item/commandExecution/requestApproval","id":0,"params":{"itemId":"i1"}}"#,
        )
        .unwrap();
        assert!(got.is_server_request());
        assert!(got.is_approval_request());
        match got {
            Incoming::ServerRequest { id, method, .. } => {
                assert_eq!(id, RequestId::Num(0));
                assert_eq!(method, "item/commandExecution/requestApproval");
            }
            other => panic!("应为服务端请求，实际 {other:?}"),
        }
    }

    #[test]
    fn response_when_id_only() {
        let got = classify(r#"{"id":1,"result":{"thread":{"id":"thr_1"}}}"#).unwrap();
        match got {
            Incoming::Response { id, result } => {
                assert_eq!(id, RequestId::Num(1));
                assert_eq!(result.unwrap()["thread"]["id"], "thr_1");
            }
            other => panic!("应为响应，实际 {other:?}"),
        }
    }

    #[test]
    fn parses_error_response() {
        let got = classify(r#"{"id":3,"error":{"code":-32600,"message":"no active turn"}}"#).unwrap();
        match got {
            Incoming::Response { result: Err(e), .. } => {
                assert_eq!(e.code, -32600);
                assert_eq!(e.message, "no active turn");
            }
            other => panic!("应为错误响应，实际 {other:?}"),
        }
    }

    #[test]
    fn string_and_numeric_ids_do_not_collide() {
        assert_ne!(RequestId::Num(1).key(), RequestId::Str("1".into()).key());
        let got = classify(r#"{"id":"srv-1","result":{}}"#).unwrap();
        match got {
            Incoming::Response { id, .. } => assert_eq!(id, RequestId::Str("srv-1".into())),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn initialized_notification_without_params() {
        // 实测：app-server 的 `initialized` 通知就是 {"method":"initialized"}，没有 params。
        let got = classify(r#"{"method":"initialized"}"#).unwrap();
        match got {
            Incoming::Notification { method, params } => {
                assert_eq!(method, "initialized");
                assert_eq!(params, Value::Null);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn null_id_treated_as_notification() {
        let got = classify(r#"{"method":"turn/started","id":null,"params":{}}"#).unwrap();
        assert!(matches!(got, Incoming::Notification { .. }));
    }

    #[test]
    fn detects_legacy_approval_methods() {
        for m in ["execCommandApproval", "applyPatchApproval"] {
            let raw = json!({"method": m, "id": 7, "params": {}}).to_string();
            assert!(classify(&raw).unwrap().is_approval_request(), "{m} 未被识别");
        }
    }

    #[test]
    fn unclassifiable_message_is_error() {
        assert_eq!(classify(r#"{"foo":"bar"}"#).unwrap_err(), JsonlError::Unclassifiable);
        assert_eq!(classify("[]").unwrap_err(), JsonlError::NotAnObject);
        assert!(matches!(
            classify("not json").unwrap_err(),
            JsonlError::Parse(_)
        ));
    }
}
