//! JSONL 传输层：管理 app-server 子进程，承载三类报文的双向收发。
//!
//! # 报文分流（本模块最重要的不变量）
//!
//! 入站报文有三类，必须分开处理：
//!
//! - **响应**（有 `id` 无 `method`）→ 唤醒对应的待决请求
//! - **服务端请求**（有 `id` 有 `method`）→ 交给上层，**必须回应**
//! - **通知**（无 `id` 有 `method`）→ 投影为领域事件
//!
//! 把服务端请求误当通知，Turn 会永久挂起在等待审批的状态——且不会有任何报错。
//!
//! # 与请求无关的边界
//!
//! **请求的响应只表示「方法已被接受」，不代表轮次完成。** `turn/start` 会立即
//! 返回 `turn.id`，而状态推进只能从事件流获得。任何持续性状态都必须来自事件。

use crate::error::{BridgeError, Result};
use crate::jsonl::{classify, Incoming, LineFramer, RequestId, RpcErrorPayload};
use crate::process::SpawnConfig;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

/// 单次请求的默认超时。审批类等待不在此列——那是事件驱动，不是请求等待。
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

const STDERR_TAIL_LIMIT: usize = 8 * 1024;
const READ_CHUNK: usize = 64 * 1024;

type PendingMap = HashMap<String, oneshot::Sender<std::result::Result<Value, RpcErrorPayload>>>;
type SharedPending = Arc<Mutex<PendingMap>>;

/// `initialize` 的结果（实测字段；**不存在** `serverInfo` / `capabilities`）。
#[derive(Debug, Clone)]
pub struct InitializeOutcome {
    pub user_agent: String,
    /// 服务端实际使用的 CODEX_HOME。必须与预期值一致，否则策略隔离失效。
    pub codex_home: String,
    pub platform_family: String,
    pub platform_os: String,
}

pub struct JsonlTransport {
    child: Child,
    stdin: ChildStdin,
    next_id: AtomicU64,
    pending: SharedPending,
    // Option：take_inbound 后为 None（读侧已交给调用方）
    inbound: Option<mpsc::UnboundedReceiver<Incoming>>,
    stderr_tail: Arc<Mutex<String>>,
}

// `Child` 与 `ChildStdin` 不实现 Debug，但调用方（尤其是 `expect_err`）需要它。
impl std::fmt::Debug for JsonlTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JsonlTransport")
            .field("pid", &self.child.id())
            .field("next_id", &self.next_id.load(Ordering::Relaxed))
            .finish_non_exhaustive()
    }
}

impl JsonlTransport {
    /// 启动 `codex app-server --stdio` 并接管其 stdio。
    pub async fn spawn(cfg: &SpawnConfig) -> Result<Self> {
        cfg.validate()?;

        let mut cmd = Command::new(&cfg.binary);
        cmd.arg("app-server")
            .arg("--stdio")
            .current_dir(&cfg.cwd)
            // 用独立 CODEX_HOME 隔离配置与历史，绝不触碰用户真实 ~/.codex
            .env("CODEX_HOME", &cfg.codex_home)
            .envs(cfg.extra_env.iter())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            // 兜底：即使上层忘记 shutdown，进程也不会泄漏
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(BridgeError::Io)?;
        let stdin = child.stdin.take().ok_or(BridgeError::Closed { code: None })?;
        let stdout = child.stdout.take().ok_or(BridgeError::Closed { code: None })?;
        let stderr = child.stderr.take();

        let pending: SharedPending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, inbound) = mpsc::unbounded_channel();

        // ── stdout 读取任务：拆包 → 分类 → 路由 ──────────────────────────
        let pending_reader = Arc::clone(&pending);
        tokio::spawn(async move {
            let mut framer = LineFramer::new(LineFramer::DEFAULT_MAX_LINE);
            let mut reader = stdout;
            let mut buf = vec![0u8; READ_CHUNK];

            loop {
                match reader.read(&mut buf).await {
                    Ok(0) | Err(_) => break, // EOF 或读错误：子进程已不可用
                    Ok(n) => match framer.push(&buf[..n]) {
                        Ok(lines) => {
                            for line in lines {
                                route_line(&line, &pending_reader, &tx).await;
                            }
                        }
                        Err(_) => break, // 拆包失败（超长行）：放弃该连接
                    },
                }
            }

            // 连接结束：丢弃全部待决发送端，等待者会立刻收到 Closed 而不是挂到超时
            pending_reader.lock().await.clear();
        });

        // ── stderr 读取任务：保留尾部若干字节用于诊断 ─────────────────────
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        if let Some(mut err) = stderr {
            let tail = Arc::clone(&stderr_tail);
            tokio::spawn(async move {
                let mut buf = vec![0u8; READ_CHUNK];
                loop {
                    match err.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut guard = tail.lock().await;
                            guard.push_str(&String::from_utf8_lossy(&buf[..n]));
                            if guard.len() > STDERR_TAIL_LIMIT {
                                let cut = guard.len() - STDERR_TAIL_LIMIT;
                                // 按字符边界截断，避免切断 UTF-8 序列
                                let cut = (cut..guard.len())
                                    .find(|&i| guard.is_char_boundary(i))
                                    .unwrap_or(guard.len());
                                *guard = guard[cut..].to_owned();
                            }
                        }
                    }
                }
            });
        }

        Ok(Self {
            child,
            stdin,
            next_id: AtomicU64::new(0),
            pending,
            inbound: Some(inbound),
            stderr_tail,
        })
    }

    /// 完成握手：`initialize` 请求 + `initialized` 通知。
    ///
    /// 校验 `codexHome` 与预期一致——这是「app-server 是否在使用我们指定的策略配置」
    /// 的唯一可验证证据。不一致说明隔离失效，必须拒绝继续。
    pub async fn initialize(
        &mut self,
        client_name: &str,
        client_title: &str,
        client_version: &str,
        expected_codex_home: Option<&std::path::Path>,
    ) -> Result<InitializeOutcome> {
        let result = self
            .request(
                "initialize",
                json!({
                    "clientInfo": {
                        "name": client_name,
                        "title": client_title,
                        "version": client_version,
                    },
                    // 能力协商在**请求侧**：experimentalApi 主动申请实验 API 字段。
                    "capabilities": { "experimentalApi": true }
                }),
            )
            .await?;

        let outcome = InitializeOutcome {
            user_agent: str_field(&result, "userAgent")?,
            codex_home: str_field(&result, "codexHome")?,
            platform_family: str_field(&result, "platformFamily")?,
            platform_os: str_field(&result, "platformOs")?,
        };

        if let Some(expected) = expected_codex_home {
            let expected = expected
                .canonicalize()
                .unwrap_or_else(|_| expected.to_path_buf());
            let actual = std::path::Path::new(&outcome.codex_home)
                .canonicalize()
                .unwrap_or_else(|_| std::path::PathBuf::from(&outcome.codex_home));
            if actual != expected {
                return Err(BridgeError::InvalidConfig(format!(
                    "app-server 使用了非预期的 CODEX_HOME，隔离失效\n  预期: {}\n  实际: {}",
                    expected.display(),
                    actual.display()
                )));
            }
        }

        // 每个连接只允许一次 initialize；随后必须发 initialized 通知。
        // 注意该通知**没有 params 字段**。
        self.notify("initialized").await?;
        Ok(outcome)
    }

    /// 发送请求并等待响应。
    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.request_with_timeout(method, params, DEFAULT_REQUEST_TIMEOUT)
            .await
    }

    pub async fn request_with_timeout(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        let id = RequestId::Num(self.next_id.fetch_add(1, Ordering::SeqCst));
        let key = id.key();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(key.clone(), tx);

        self.write_line(&json!({ "method": method, "id": id, "params": params }))
            .await?;

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(payload))) => Err(BridgeError::Rpc {
                code: payload.code,
                message: payload.message,
            }),
            // 发送端被丢弃 = 子进程退出或连接关闭
            Ok(Err(_)) => Err(BridgeError::Closed { code: None }),
            Err(_) => {
                self.pending.lock().await.remove(&key);
                Err(BridgeError::Timeout {
                    method: method.to_owned(),
                    timeout,
                })
            }
        }
    }

    /// 发送请求并登记待决，但**不等待响应**：返回一个只负责等结果的 future。
    ///
    /// 用于长耗时请求。`command/exec` 的响应在命令退出时才返回，
    /// 用 [`request`] 会把调用方（owner 循环）卡住整条命令的时长——
    /// 期间审批应答与事件分发全部停摆。
    ///
    /// **请求在本方法内就写出去了**（不是放进 future 里），所以调用方
    /// 拿到 future 时请求已经在路上；否则 future 未被立即轮询时请求
    /// 根本没发出去，而调用方以为已经开始了。
    pub async fn request_detached(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<impl std::future::Future<Output = Result<Value>>> {
        let id = RequestId::Num(self.next_id.fetch_add(1, Ordering::SeqCst));
        let key = id.key();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(key, tx);

        self.write_line(&json!({ "method": method, "id": id, "params": params }))
            .await?;

        // 长命令不设超时：命令跑多久是用户的事，由用户主动终止
        // （command/exec/terminate），而不是被客户端掐断。
        Ok(async move {
            match rx.await {
                Ok(Ok(value)) => Ok(value),
                Ok(Err(payload)) => Err(BridgeError::Rpc {
                    code: payload.code,
                    message: payload.message,
                }),
                Err(_) => Err(BridgeError::Closed { code: None }),
            }
        })
    }

    /// 发送通知（无 id，不需要响应）。
    pub async fn notify(&mut self, method: &str) -> Result<()> {
        self.write_line(&json!({ "method": method })).await
    }

    /// 回应**服务端发起的请求**。
    ///
    /// 协议里没有 `approval/resolve` 之类的方法：审批就是一个普通的 JSON-RPC 请求，
    /// 客户端直接回应同一个 `id` 即可。
    pub async fn respond(&mut self, id: &RequestId, result: Value) -> Result<()> {
        self.write_line(&json!({ "id": id, "result": result })).await
    }

    /// 把入站事件接收端从 transport 中取出。
    ///
    /// 拆出读侧后，调用方可以在同一个 `select!` 里同时等待事件与发送请求：
    ///
    /// ```ignore
    /// let mut inbound = transport.take_inbound().expect("读侧未被取出");
    /// loop {
    ///     tokio::select! {
    ///         cmd = cmd_rx.recv() => { /* 用 &mut transport 发请求 */ }
    ///         ev  = inbound.recv()  => { /* 处理事件 */ }
    ///     }
    /// }
    /// ```
    ///
    /// 两个 future 借用的是不同对象，因此不会冲突。若坚持用
    /// [`Self::next_inbound`]，`select!` 会同时借用同一 transport 的可变引用而无法编译。
    ///
    /// 只能成功调用一次；重复调用返回 `None`。
    pub fn take_inbound(&mut self) -> Option<InboundReceiver> {
        self.inbound.take().map(|rx| InboundReceiver { rx })
    }

    /// 读取下一条事件（借用 `&mut self`），超时返回 `None`。
    ///
    /// 通道无界：命令输出 delta 可能在 UI 卡顿时堆积。上层必须持续消费，
    /// 断线重连时以 `thread/read` 重建视图而不是依赖积压队列。
    ///
    /// 注意：本方法借用 `&mut self`，与 [`Self::request`] 互斥。若要在同一个
    /// `select!` 里同时等待事件与处理命令，请改用 [`Self::take_inbound`]。
    /// 读侧已被取走时返回 `None`。
    pub async fn next_inbound(&mut self, timeout: Duration) -> Option<Incoming> {
        let rx = self.inbound.as_mut()?;
        tokio::time::timeout(timeout, rx.recv()).await.ok().flatten()
    }

    /// 等待满足条件的事件。
    ///
    /// 不匹配的事件通过 `on_skip` 交给调用方，**不会被静默丢弃**——丢弃一个
    /// 服务端请求会让对应的 Turn 永久挂起。
    pub async fn next_matching<F, G>(
        &mut self,
        timeout: Duration,
        mut pred: F,
        mut on_skip: G,
    ) -> Option<Incoming>
    where
        F: FnMut(&Incoming) -> bool,
        G: FnMut(Incoming),
    {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                return None;
            }
            match self.next_inbound(left).await {
                Some(item) if pred(&item) => return Some(item),
                Some(other) => on_skip(other),
                None => return None,
            }
        }
    }

    /// 子进程 stderr 的尾部内容，用于诊断启动失败。
    pub async fn stderr_tail(&self) -> String {
        self.stderr_tail.lock().await.clone()
    }

    /// 子进程当前是否仍在运行。
    pub fn is_running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// 子进程 PID。
    ///
    /// 崩溃恢复验收需要模拟子进程被强杀（`kill -9`）——那是一切清理逻辑
    /// 都来不及跑的最坏情况，也是唯一能验证「历史是否真的持久化」的方式。
    pub fn pid(&self) -> Option<u32> {
        self.child.id()
    }

    /// 优雅终止：先 SIGTERM，超时后强杀。
    pub async fn shutdown(mut self) -> Result<()> {
        let _ = self.child.start_kill();
        match tokio::time::timeout(Duration::from_secs(5), self.child.wait()).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(BridgeError::Io(e)),
            Err(_) => {
                let _ = self.child.kill().await;
                Ok(())
            }
        }
    }

    async fn write_line(&mut self, msg: &Value) -> Result<()> {
        let mut line = serde_json::to_vec(msg)?;
        line.push(b'\n');
        self.stdin.write_all(&line).await?;
        self.stdin.flush().await?;
        Ok(())
    }
}

/// 事件读取端。从 [`JsonlTransport::take_inbound`] 获得。
///
/// 与 transport 分离，使得「等待事件」与「发送请求」可以并发进行。
pub struct InboundReceiver {
    rx: mpsc::UnboundedReceiver<Incoming>,
}

/// 一次事件接收的结果。
#[derive(Debug)]
pub enum RecvOutcome {
    Message(Incoming),
    Timeout,
    /// 通道已关闭——**意味着 app-server 子进程已退出**。
    /// 上层必须据此把活动轮次标记为 unknown，而不是当作正常结束。
    Closed,
}

impl InboundReceiver {
    /// 阻塞等待下一条事件；通道关闭返回 `None`。
    pub async fn recv(&mut self) -> Option<Incoming> {
        self.rx.recv().await
    }

    /// 带超时的接收，明确区分「超时」与「通道关闭」。
    pub async fn recv_timeout(&mut self, timeout: Duration) -> RecvOutcome {
        match tokio::time::timeout(timeout, self.rx.recv()).await {
            Ok(Some(msg)) => RecvOutcome::Message(msg),
            Ok(None) => RecvOutcome::Closed,
            Err(_) => RecvOutcome::Timeout,
        }
    }
}

/// 把一行报文路由到待决请求或事件通道。
async fn route_line(line: &str, pending: &SharedPending, tx: &mpsc::UnboundedSender<Incoming>) {
    match classify(line) {
        Ok(Incoming::Response { id, result }) => {
            if let Some(sender) = pending.lock().await.remove(&id.key()) {
                let _ = sender.send(result);
            }
            // 找不到对应待决请求的响应：可能是超时后才到达的迟到响应，丢弃即可
        }
        Ok(other) => {
            let _ = tx.send(other);
        }
        Err(_) => {
            // 无法分类的报文：不阻断连接。真实场景中多为上游新增字段或调试输出。
        }
    }
}

fn str_field(v: &Value, key: &str) -> Result<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| BridgeError::Protocol(format!("响应缺少字符串字段 `{key}`，实际: {v}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn str_field_reports_missing_key() {
        let v = json!({ "userAgent": "x" });
        assert!(str_field(&v, "codexHome").is_err());
        assert_eq!(str_field(&v, "userAgent").unwrap(), "x");
    }
}
