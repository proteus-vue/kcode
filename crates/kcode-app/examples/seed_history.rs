//! 为 GUI 演示播种真实历史：跑两轮真实对话，写入事件日志。
//!
//! 用途：GUI 交互自动化在 macOS WebView 上不可靠（合成按键进不去），
//! 因此改为「先造历史、再启动应用」——应用启动时会从事件日志加载，
//! UI 直接呈现填充状态，无需任何点击。
//!
//! 用法：cargo run -p kcode-app --example seed_history -- <工作区> <CODEX_HOME>

use kcode_bridge::SpawnConfig;
use kcode_app::{AgentService, AppEvent, ServiceConfig};
use std::time::Duration;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let cwd = args.next().ok_or("需要工作区路径")?;
    let home = args.next().ok_or("需要 CODEX_HOME 路径")?;

    // CARGO_MANIFEST_DIR 指向 crate 目录，需要向上找到仓库根（含 node_modules）
    let mut root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    while !root.join("node_modules").is_dir() {
        if !root.pop() {
            return Err("未找到仓库根（缺少 node_modules，请先 npm install）".into());
        }
    }
    let binary = kcode_bridge::locate_binary(&root)?;

    let svc = AgentService::start(ServiceConfig {
        spawn: SpawnConfig::new(&binary, &cwd, &home),
        client_name: "kcode-seed".into(),
        client_title: "Seed".into(),
        client_version: "0.1.0".into(),
    })
    .await
    .map_err(|e| format!("启动失败: {e}"))?;

    let mut events = svc.subscribe();
    let info = svc
        .start_thread(&cwd, Some("deepseek-v4-pro".into()), "workspace-write", serde_json::json!("on-request"))
        .await
        .map_err(|e| format!("建线程失败: {e}"))?;
    eprintln!("线程: {}", info.thread_id);

    let prompts = [
        "读取 calc.py，然后用 Markdown 说明它的功能并给出一个使用示例（含代码块）",
        "在 calc.py 中新增一个 multiply 函数，保持与现有代码相同的风格",
    ];

    for (i, p) in prompts.iter().enumerate() {
        eprintln!("── 第 {} 轮 ──", i + 1);
        let turn_id = match svc.send_turn(&info.thread_id, *p).await {
            Ok(t) => t,
            Err(e) => { eprintln!("提交失败: {e}"); break; }
        };
        // 消费事件直到**该轮**结束。
        //
        // 注意：不能在其他轮次的 TurnCompleted 上退出（早先的实现会误判），
        // 也不能因通道偶发 lag 就 break——那会丢掉后续事件。
        let deadline = tokio::time::Instant::now() + Duration::from_secs(240);
        let mut item_count = 0usize;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            if left.is_zero() {
                eprintln!("  (超时)");
                break;
            }
            match tokio::time::timeout(left, events.recv()).await {
                Ok(Ok(AppEvent::ApprovalRequired { approval })) => {
                    eprintln!("  审批: {} [{}]", approval.summary, approval.risk.tier.label_zh());
                    let _ = svc
                        .resolve_approval(
                            approval.request_key(),
                            kcode_domain::ApprovalDecision::Accept,
                            None,
                        )
                        .await;
                }
                Ok(Ok(AppEvent::ItemUpserted { .. })) => {
                    item_count += 1;
                }
                Ok(Ok(AppEvent::TurnCompleted { turn_id: t, status, .. })) if t == turn_id => {
                    eprintln!("  完成: {status:?}（{item_count} 个 Item 事件）");
                    break;
                }
                Ok(Ok(_)) => {}
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                    // 事件积压不是终止条件：继续消费后续事件
                    eprintln!("  (积压 {n} 条，继续)");
                }
                Ok(Err(_)) => break,
                Err(_) => {
                    eprintln!("  (超时)");
                    break;
                }
            }
        }
    }

    // 等日志刷盘
    tokio::time::sleep(Duration::from_millis(500)).await;
    svc.shutdown();
    tokio::time::sleep(Duration::from_millis(500)).await;
    eprintln!("播种完成");
    Ok(())
}
