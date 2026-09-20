//! 端到端契约测试：用真实 `codex app-server` 进程验证适配层。
//!
//! 与 `scripts/contract-test.mjs` 等价，断言集合刻意保持一致——两个实现互为交叉验证：
//! Node 版验证「协议本身长什么样」，Rust 版验证「适配层是否忠实承载协议」。
//!
//! **离线、零凭据**：用本地 mock provider 冒充模型，不访问外网、不需要 API key。
//! **不污染真实环境**：独立 `CODEX_HOME`，且断言 `initialize` 回传的 `codexHome` 与之一致。
//!
//! 若未 `npm install`（无 codex 二进制），测试自动跳过而不是失败——CI 里由
//! `npm ci` 保证存在，本地开发者可只跑纯逻辑单测。

use kcode_bridge::{
    approval_response, locate_binary, Incoming, JsonlTransport, SpawnConfig,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;

const EVENT_TIMEOUT: Duration = Duration::from_secs(25);
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(30);

/// 仓库根目录：从 crate 所在位置向上找到含 node_modules 的目录。
fn repo_root() -> PathBuf {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    while !dir.join("node_modules").is_dir() {
        if !dir.pop() {
            panic!("未能定位仓库根（未找到 node_modules），请先运行 npm install");
        }
    }
    dir
}

fn codex_binary() -> Option<PathBuf> {
    locate_binary(&repo_root()).ok()
}

/// 写入隔离 CODEX_HOME 的 config.toml，指向本地 mock provider。
fn write_isolated_config(home: &Path, port: u16) {
    let cfg = format!(
        r#"model_provider = "kcode-mock"
model = "kcode-mock-model"

[model_providers.kcode-mock]
name = "kcode-mock"
base_url = "http://127.0.0.1:{port}/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "contract-test-dummy"
"#
    );
    std::fs::write(home.join("config.toml"), cfg).expect("写入隔离 config.toml 失败");
}

/// 一个极简的 Responses API mock：返回一条需要提权的 exec_command 调用。
///
/// 第二次请求（工具结果已回填）返回普通文本，避免 Turn 无限循环。
struct MockProvider {
    port: u16,
    requests: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    handle: tokio::task::JoinHandle<()>,
}

impl MockProvider {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("绑定 mock 端口失败");
        let port = listener.local_addr().unwrap().port();
        let requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = std::sync::Arc::clone(&requests);

        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { break };

                // 读请求头 + body（简化处理：只读到 \r\n\r\n 与 Content-Length 覆盖的字节）
                let mut raw = Vec::new();
                let mut buf = [0u8; 8192];
                let mut header_end = None;
                loop {
                    match tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            raw.extend_from_slice(&buf[..n]);
                            if header_end.is_none() {
                                if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                                    header_end = Some(pos + 4);
                                }
                            }
                            if let Some(he) = header_end {
                                let head = String::from_utf8_lossy(&raw[..he]).to_lowercase();
                                let want = head
                                    .lines()
                                    .find_map(|l| l.strip_prefix("content-length:"))
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                                    .unwrap_or(0);
                                if raw.len() >= he + want {
                                    break;
                                }
                            }
                        }
                    }
                }

                let body_start = header_end.unwrap_or(0);
                let body = String::from_utf8_lossy(&raw[body_start.min(raw.len())..]).to_string();
                let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);

                let n = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let _ = n;

                let prior_calls = parsed
                    .get("input")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter(|i| i.get("type").and_then(Value::as_str) == Some("function_call"))
                            .count()
                    })
                    .unwrap_or(0);

                let output = if prior_calls >= 1 {
                    json!({
                        "type": "message", "id": "msg_mock_final", "role": "assistant",
                        "status": "completed",
                        "content": [{ "type": "output_text", "text": "kcode mock: done", "annotations": [] }]
                    })
                } else {
                    json!({
                        "type": "function_call", "id": "fc_mock_1", "call_id": "call_mock_1",
                        "name": "exec_command", "status": "completed",
                        "arguments": json!({
                            "cmd": "echo kcode-approval-probe",
                            "workdir": Value::Null,
                            "yield_time_ms": 3000,
                            "sandbox_permissions": "require_escalated",
                            "justification": "kcode contract test: verify approval round-trip"
                        }).to_string()
                    })
                };

                let mut in_progress = output.clone();
                if let Some(obj) = in_progress.as_object_mut() {
                    obj.insert("status".into(), json!("in_progress"));
                }

                let mut sse = String::new();
                let emit = |s: &mut String, ev: Value| {
                    s.push_str(&format!(
                        "event: {}\ndata: {}\n\n",
                        ev.get("type").and_then(Value::as_str).unwrap_or("message"),
                        ev
                    ));
                };
                let resp_id = "resp_mock_1";
                emit(&mut sse, json!({
                    "type": "response.created",
                    "response": { "id": resp_id, "status": "in_progress", "model": "kcode-mock-model", "output": [] }
                }));
                emit(&mut sse, json!({
                    "type": "response.output_item.added", "output_index": 0,
                    "item": in_progress
                }));
                emit(&mut sse, json!({
                    "type": "response.output_item.done", "output_index": 0, "item": output
                }));
                emit(&mut sse, json!({
                    "type": "response.completed",
                    "response": {
                        "id": resp_id, "status": "completed", "model": "kcode-mock-model",
                        "output": [output],
                        "usage": { "input_tokens": 1, "output_tokens": 1, "total_tokens": 2 }
                    }
                }));

                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    sse.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(sse.as_bytes()).await;
                let _ = sock.flush().await;
                let _ = sock.shutdown().await;
            }
        });

        Self { port, requests, handle }
    }
}

impl Drop for MockProvider {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// 测试夹具：隔离目录 + mock provider + 已握手的 transport。
struct Fixture {
    transport: JsonlTransport,
    /// 必须持有：TempDir 析构即删目录。cwd 是 app-server 的工作目录，
    /// 提前删除会让线程在运行中失去工作区。
    _cwd: tempfile::TempDir,
    /// 必须持有：CODEX_HOME 被 app-server 持续读写（会话、历史落库于此）。
    #[allow(dead_code)]
    codex_home: tempfile::TempDir,
    /// 必须持有：Drop 时中止 mock 服务。
    provider: MockProvider,
    /// 仅用于记录与诊断输出，不参与断言。
    #[allow(dead_code)]
    binary: PathBuf,
}

impl Fixture {
    async fn start() -> Option<Self> {
        let binary = codex_binary()?;
        let provider = MockProvider::start().await;

        let cwd = tempfile::tempdir().unwrap();
        let codex_home = tempfile::tempdir().unwrap();
        write_isolated_config(codex_home.path(), provider.port);

        let cfg = SpawnConfig::new(&binary, cwd.path(), codex_home.path());
        let mut transport = JsonlTransport::spawn(&cfg)
            .await
            .expect("启动 app-server 失败");

        transport
            .initialize("kcode-rust", "KCode Rust Bridge", "0.1.0", Some(cfg.codex_home.as_path()))
            .await
            .expect("握手失败");

        Some(Self { transport, _cwd: cwd, codex_home, provider, binary })
    }

    /// 提交一个 Turn 并等待审批请求；其余事件透传收集。
    async fn start_thread_and_turn(
        &mut self,
        collected: &mut Vec<Incoming>,
    ) -> (String, String, Incoming) {
        let started = self
            .transport
            .request(
                "thread/start",
                json!({
                    "cwd": self._cwd.path(),
                    "approvalPolicy": "on-request",
                    "sandbox": "workspace-write",
                    "model": "kcode-mock-model",
                }),
            )
            .await
            .expect("thread/start 失败");

        let thread_id = started["thread"]["id"]
            .as_str()
            .expect("thread/start 未返回 thread.id")
            .to_owned();

        let turn = self
            .transport
            .request(
                "turn/start",
                json!({
                    "threadId": thread_id,
                    "input": [{ "type": "text", "text": "run the probe command" }],
                }),
            )
            .await
            .expect("turn/start 失败");

        let turn_id = turn["turn"]["id"]
            .as_str()
            .expect("turn/start 未返回 turn.id")
            .to_owned();

        let approval = self
            .transport
            .next_matching(
                APPROVAL_TIMEOUT,
                Incoming::is_approval_request,
                |other| collected.push(other),
            )
            .await
            .expect("未在超时内收到审批请求");

        (thread_id, turn_id, approval)
    }
}

/// 完整的「握手 → 建线程 → 轮次 → 审批 → 应答 → 收尾」闭环。
#[tokio::test(flavor = "multi_thread")]
async fn full_approval_roundtrip() {
    let Some(mut fx) = Fixture::start().await else {
        eprintln!("跳过：未安装 codex 二进制（请运行 npm install）");
        return;
    };

    // ── 1. 建线程：sandbox 为字符串枚举 ─────────────────────────────────
    let started = fx
        .transport
        .request(
            "thread/start",
            json!({
                "cwd": fx._cwd.path(),
                "approvalPolicy": "on-request",
                "sandbox": "workspace-write",
                "model": "kcode-mock-model",
            }),
        )
        .await
        .expect("thread/start 失败");

    let thread_id = started["thread"]["id"].as_str().expect("缺少 thread.id").to_owned();
    assert!(thread_id.starts_with("01"), "thread id 形态异常: {thread_id}");
    assert_eq!(started["approvalPolicy"], "on-request");
    let cwd = started["cwd"].as_str().expect("缺少 cwd");
    assert!(cwd.starts_with('/'), "cwd 应为绝对路径: {cwd}");

    // ── 2. 提交轮次：sandboxPolicy 为对象形态 ──────────────────────────
    let turn = fx
        .transport
        .request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": "run the probe command" }],
            }),
        )
        .await
        .expect("turn/start 失败");
    let turn_id = turn["turn"]["id"].as_str().expect("缺少 turn.id").to_owned();

    // ── 3. 审批：服务端请求，必须原地回应 ───────────────────────────────
    let mut skipped = Vec::new();
    let approval = fx
        .transport
        .next_matching(APPROVAL_TIMEOUT, Incoming::is_approval_request, |o| skipped.push(o))
        .await
        .expect("未收到审批请求");

    let (req_id, method, params) = match &approval {
        Incoming::ServerRequest { id, method, params } => (id.clone(), method.clone(), params.clone()),
        other => panic!("审批应为 ServerRequest，实际: {other:?}"),
    };

    assert_eq!(method, "item/commandExecution/requestApproval", "审批方法名不符（不应使用 legacy 命名）");

    // v1.0 文档曾声称这些字段存在；实测必须齐备才算真正可追溯
    for key in ["threadId", "turnId", "itemId"] {
        assert!(
            params.get(key).and_then(Value::as_str).is_some(),
            "审批 params 缺少 `{key}`: {params}"
        );
    }
    assert_eq!(params["threadId"], thread_id.as_str());
    assert_eq!(params["turnId"], turn_id.as_str());
    assert!(
        params.get("startedAtMs").and_then(Value::as_i64).is_some(),
        "审批 params 缺少 startedAtMs"
    );

    // ── 4. 回应审批：直接回同一个 id，协议里没有 approval/resolve ────────
    fx.transport
        .respond(&req_id, approval_response(&method, "accept"))
        .await
        .expect("回应审批失败");

    // ── 5. 轮次收尾：状态只能从事件获得 ─────────────────────────────────
    let completed = fx
        .transport
        .next_matching(
            EVENT_TIMEOUT,
            |e| matches!(e, Incoming::Notification { method, .. } if method == "turn/completed"),
            |o| skipped.push(o),
        )
        .await
        .expect("未收到 turn/completed");

    let status = match &completed {
        Incoming::Notification { params, .. } => params["turn"]["status"].clone(),
        _ => unreachable!(),
    };
    assert_eq!(status, json!("completed"), "轮次未正常收尾: {status}");

    // 子进程仍应存活（我们只是回了一次审批）
    assert!(fx.transport.is_running(), "app-server 不应在测试中途退出");

    fx.transport.shutdown().await.expect("关闭失败");
}

/// mock provider 确实收到了模型流量——证明整条链路真的跑通了，
/// 而不是因为某种短路让测试「碰巧」通过。
#[tokio::test(flavor = "multi_thread")]
async fn model_traffic_reaches_mock_provider() {
    let Some(mut fx) = Fixture::start().await else { return };
    let mut skipped = Vec::new();
    let _ = fx.start_thread_and_turn(&mut skipped).await;
    assert!(
        fx.provider.requests.load(std::sync::atomic::Ordering::SeqCst) >= 1,
        "mock provider 未收到任何模型请求"
    );
    fx.transport.shutdown().await.ok();
}

/// `turn/interrupt` 需要 threadId + turnId，且对已结束的轮次返回 RPC 错误。
///
/// v1.0 文档要求它「幂等」；实测并非如此——它需要两个参数，且对不存在的轮次
/// 返回 `-32600`。正确做法是把该错误折叠进「已结束」终态，而不是当作故障。
#[tokio::test(flavor = "multi_thread")]
async fn interrupt_reports_error_for_finished_turn() {
    let Some(mut fx) = Fixture::start().await else { return };

    let started = fx
        .transport
        .request("thread/start", json!({ "cwd": fx._cwd.path() }))
        .await
        .expect("thread/start 失败");
    let thread_id = started["thread"]["id"].as_str().unwrap().to_owned();

    let err = fx
        .transport
        .request(
            "turn/interrupt",
            json!({ "threadId": thread_id, "turnId": "00000000-0000-0000-0000-000000000000" }),
        )
        .await
        .expect_err("对不存在的轮次应返回 RPC 错误");

    match err {
        kcode_bridge::BridgeError::Rpc { code, message } => {
            assert_eq!(code, -32600, "错误码不符: {code}");
            assert!(
                message.contains("no active turn"),
                "错误信息不符: {message}"
            );
        }
        other => panic!("应为 Rpc 错误，实际: {other:?}"),
    }

    fx.transport.shutdown().await.ok();
}

/// 隔离校验：若 `initialize` 回传的 codexHome 与预期不符，必须拒绝继续。
///
/// 这条断言保护的是安全属性：app-server 一旦读到用户全局配置，
/// 就可能继承比应用预期更宽松的沙箱与审批策略。
#[tokio::test(flavor = "multi_thread")]
async fn rejects_mismatched_codex_home() {
    let Some(binary) = codex_binary() else { return };
    let provider = MockProvider::start().await;

    let cwd = tempfile::tempdir().unwrap();
    let real_home = tempfile::tempdir().unwrap();
    write_isolated_config(real_home.path(), provider.port);

    // 故意传入一个与实际生效值不同的「预期目录」
    let decoy = tempfile::tempdir().unwrap();

    let cfg = SpawnConfig::new(&binary, cwd.path(), real_home.path());
    let mut transport = JsonlTransport::spawn(&cfg).await.expect("启动失败");

    let err = transport
        .initialize("kcode-rust", "KCode", "0.1.0", Some(decoy.path()))
        .await
        .expect_err("codexHome 不匹配时应当报错");

    assert!(
        err.to_string().contains("隔离失效"),
        "错误信息未点明隔离失效: {err}"
    );

    transport.shutdown().await.ok();
}

/// 以用户真实 `~/.codex` 作为 CODEX_HOME 必须被拒绝。
#[tokio::test(flavor = "multi_thread")]
async fn refuses_spawn_with_real_user_codex_home() {
    let Some(binary) = codex_binary() else { return };
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return };
    let real = home.join(".codex");
    if !real.is_dir() {
        return; // 该环境无真实 ~/.codex
    }

    let cwd = tempfile::tempdir().unwrap();
    let cfg = SpawnConfig::new(&binary, cwd.path(), &real);
    let err = JsonlTransport::spawn(&cfg).await.expect_err("应拒绝真实 ~/.codex");
    assert!(err.to_string().contains("拒绝以用户真实的"), "{err}");
}
