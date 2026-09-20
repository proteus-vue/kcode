//! 事件日志（SQLite WAL）——事件溯源的持久层。
//!
//! # 为什么保留原始报文
//!
//! 每条记录同时存**解析后的领域事件**与**原始 JSON**。协议是实验性的，
//! 解析逻辑必然随版本变化；保留 raw_json 使得升级后能把历史重新投影成
//! 新模型，而不是丢失或篡改既有数据。
//!
//! # 关键边界
//!
//! 日志是**只追加**的。恢复时按 `seq` 顺序重放，不依赖任何可变的「当前状态」
//! 快照——快照可以后加，但它不能是唯一真相来源，否则一次写坏就永久损坏。

use crate::error::Result;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

/// 一条持久化事件。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventRecord {
    /// 单调递增序号，重放顺序的唯一依据。
    pub seq: u64,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub ts_ms: i64,
    /// 领域事件种类。
    pub kind: String,
    /// 解析后的领域载荷。
    pub payload: serde_json::Value,
    /// 原始协议报文（或等价文本）。协议变更时用于重新投影。
    pub raw_json: String,
}

/// 只追加的事件日志。
pub struct EventLog {
    conn: Connection,
}

impl EventLog {
    /// 打开（或创建）日志文件，启用 WAL 与外键。
    pub fn open(path: &std::path::Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    /// 内存日志，用于测试。
    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self> {
        // WAL 提升并发读性能；NORMAL 同步在有 WAL 时可安全降低 fsync 频率。
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS events (
                seq        INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id  TEXT,
                turn_id    TEXT,
                item_id    TEXT,
                ts_ms      INTEGER NOT NULL,
                kind       TEXT NOT NULL,
                payload    TEXT NOT NULL,
                raw_json   TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id, seq);
            CREATE INDEX IF NOT EXISTS idx_events_turn   ON events(turn_id, seq);

            -- 审计日志与事件日志分开：审计需可独立导出与按周期清理，
            -- 且绝不与协议报文混在一起（协议字段随时变，审计格式要稳定）。
            CREATE TABLE IF NOT EXISTS audit (
                seq        INTEGER PRIMARY KEY AUTOINCREMENT,
                ts_ms      INTEGER NOT NULL,
                thread_id  TEXT,
                turn_id    TEXT,
                item_id    TEXT,
                request_id TEXT,
                kind       TEXT NOT NULL,
                risk_tier  TEXT,
                decision   TEXT,
                actor      TEXT NOT NULL,
                scope      TEXT,
                summary    TEXT NOT NULL,
                cwd        TEXT,
                model      TEXT,
                exit_code  INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts_ms);
            "#,
        )?;
        Ok(Self { conn })
    }

    /// 追加一条事件，返回分配的序号。
    pub fn append(&self, record: &EventRecord) -> Result<u64> {
        self.conn.execute(
            "INSERT INTO events (thread_id, turn_id, item_id, ts_ms, kind, payload, raw_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                record.thread_id,
                record.turn_id,
                record.item_id,
                record.ts_ms,
                record.kind,
                serde_json::to_string(&record.payload)?,
                record.raw_json,
            ],
        )?;
        Ok(self.conn.last_insert_rowid() as u64)
    }

    /// 读取某个线程的全部事件，按 seq 升序。
    pub fn events_for_thread(&self, thread_id: &str) -> Result<Vec<EventRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT seq, thread_id, turn_id, item_id, ts_ms, kind, payload, raw_json
             FROM events WHERE thread_id = ?1 ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map(params![thread_id], Self::row_to_record)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 读取全部事件（重放用），按 seq 升序。
    pub fn all_events(&self) -> Result<Vec<EventRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT seq, thread_id, turn_id, item_id, ts_ms, kind, payload, raw_json
             FROM events ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map([], Self::row_to_record)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn event_count(&self) -> Result<u64> {
        let n: i64 = self.conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
        Ok(n as u64)
    }

    fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<EventRecord> {
        let payload: String = row.get(6)?;
        Ok(EventRecord {
            seq: row.get::<_, i64>(0)? as u64,
            thread_id: row.get(1)?,
            turn_id: row.get(2)?,
            item_id: row.get(3)?,
            ts_ms: row.get(4)?,
            kind: row.get(5)?,
            payload: serde_json::from_str(&payload).unwrap_or(serde_json::Value::Null),
            raw_json: row.get(7)?,
        })
    }

    // ── 审计 ────────────────────────────────────────────────────────────

    /// 写入一条审计记录。
    ///
    /// **自动批准也必须走这里**——审计的价值在于「谁、基于什么、放行了什么」，
    /// 自动决策同样需要留痕，否则事后无法回答「为什么这条命令被允许了」。
    pub fn append_audit(&self, entry: &AuditEntry) -> Result<u64> {
        self.conn.execute(
            "INSERT INTO audit (ts_ms, thread_id, turn_id, item_id, request_id, kind,
                                risk_tier, decision, actor, scope, summary, cwd, model, exit_code)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                entry.ts_ms,
                entry.thread_id,
                entry.turn_id,
                entry.item_id,
                entry.request_id,
                entry.kind,
                entry.risk_tier,
                entry.decision,
                entry.actor,
                entry.scope,
                entry.summary,
                entry.cwd,
                entry.model,
                entry.exit_code,
            ],
        )?;
        Ok(self.conn.last_insert_rowid() as u64)
    }

    pub fn audit_entries(&self) -> Result<Vec<AuditEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT seq, ts_ms, thread_id, turn_id, item_id, request_id, kind,
                    risk_tier, decision, actor, scope, summary, cwd, model, exit_code
             FROM audit ORDER BY seq ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(AuditEntry {
                seq: row.get::<_, i64>(0)? as u64,
                ts_ms: row.get(1)?,
                thread_id: row.get(2)?,
                turn_id: row.get(3)?,
                item_id: row.get(4)?,
                request_id: row.get(5)?,
                kind: row.get(6)?,
                risk_tier: row.get(7)?,
                decision: row.get(8)?,
                actor: row.get(9)?,
                scope: row.get(10)?,
                summary: row.get(11)?,
                cwd: row.get(12)?,
                model: row.get(13)?,
                exit_code: row.get(14)?,
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 导出审计日志为 JSON（方案 6.1 第 10 条：用户必须能自己回答
    /// 「这个工具对我的代码做了什么」）。
    pub fn export_audit_json(&self) -> Result<String> {
        Ok(serde_json::to_string_pretty(&self.audit_entries()?)?)
    }

    /// 清空审计日志（用户权利：可清空）。
    pub fn clear_audit(&self) -> Result<usize> {
        Ok(self.conn.execute("DELETE FROM audit", [])?)
    }

    /// 按保留周期清理审计日志，返回删除条数。
    pub fn prune_audit_before(&self, cutoff_ms: i64) -> Result<usize> {
        Ok(self
            .conn
            .execute("DELETE FROM audit WHERE ts_ms < ?1", params![cutoff_ms])?)
    }
}

/// 审计条目。字段对应方案 6.5 节的最小集合。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AuditEntry {
    pub seq: u64,
    pub ts_ms: i64,
    pub thread_id: Option<String>,
    pub turn_id: Option<String>,
    pub item_id: Option<String>,
    pub request_id: Option<String>,
    /// `command_approval` / `file_change_approval` / `permission_approval` / `command_executed` 等。
    pub kind: String,
    pub risk_tier: Option<String>,
    pub decision: Option<String>,
    /// `user` 或 `auto`。**自动决策必须标明**，否则无法审计自动放行。
    pub actor: String,
    pub scope: Option<String>,
    /// 命令或变更摘要。**写入前必须已脱敏。**
    pub summary: String,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub exit_code: Option<i64>,
}

impl AuditEntry {
    pub fn new(kind: impl Into<String>, actor: impl Into<String>, summary: impl Into<String>, ts_ms: i64) -> Self {
        Self {
            seq: 0,
            ts_ms,
            thread_id: None,
            turn_id: None,
            item_id: None,
            request_id: None,
            kind: kind.into(),
            risk_tier: None,
            decision: None,
            actor: actor.into(),
            scope: None,
            summary: summary.into(),
            cwd: None,
            model: None,
            exit_code: None,
        }
    }

    pub fn with_risk(mut self, tier: &str) -> Self {
        self.risk_tier = Some(tier.to_owned());
        self
    }

    pub fn with_decision(mut self, decision: &str) -> Self {
        self.decision = Some(decision.to_owned());
        self
    }

    pub fn with_scope(mut self, scope: &str) -> Self {
        self.scope = Some(scope.to_owned());
        self
    }

    pub fn with_thread(mut self, thread_id: &str, turn_id: Option<&str>, item_id: Option<&str>) -> Self {
        self.thread_id = Some(thread_id.to_owned());
        self.turn_id = turn_id.map(str::to_owned);
        self.item_id = item_id.map(str::to_owned);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(thread: &str, kind: &str) -> EventRecord {
        EventRecord {
            seq: 0,
            thread_id: Some(thread.into()),
            turn_id: Some("t1".into()),
            item_id: None,
            ts_ms: 1_700_000_000_000,
            kind: kind.into(),
            payload: serde_json::json!({ "hello": "world" }),
            raw_json: r#"{"method":"item/started"}"#.into(),
        }
    }

    #[test]
    fn append_assigns_monotonic_seq() {
        let log = EventLog::in_memory().unwrap();
        let a = log.append(&rec("th1", "thread_started")).unwrap();
        let b = log.append(&rec("th1", "turn_started")).unwrap();
        let c = log.append(&rec("th2", "thread_started")).unwrap();
        assert!(a < b && b < c, "序号必须单调递增: {a} {b} {c}");
    }

    #[test]
    fn events_are_scoped_by_thread_and_ordered() {
        let log = EventLog::in_memory().unwrap();
        log.append(&rec("th1", "e1")).unwrap();
        log.append(&rec("th2", "e2")).unwrap();
        log.append(&rec("th1", "e3")).unwrap();

        let th1 = log.events_for_thread("th1").unwrap();
        assert_eq!(th1.len(), 2);
        assert_eq!(th1[0].kind, "e1");
        assert_eq!(th1[1].kind, "e3");
    }

    #[test]
    fn raw_json_is_preserved_for_reprojection() {
        // 协议变更后要能用原始报文重新投影，所以 raw_json 必须原样保存
        let log = EventLog::in_memory().unwrap();
        log.append(&rec("th1", "x")).unwrap();
        let got = log.events_for_thread("th1").unwrap();
        assert_eq!(got[0].raw_json, r#"{"method":"item/started"}"#);
        assert_eq!(got[0].payload["hello"], "world");
    }

    #[test]
    fn audit_is_append_only_and_exportable() {
        let log = EventLog::in_memory().unwrap();
        log.append_audit(
            &AuditEntry::new("command_approval", "user", "echo hi", 1000)
                .with_risk("low")
                .with_decision("accept")
                .with_scope("once"),
        )
        .unwrap();
        log.append_audit(&AuditEntry::new("command_executed", "auto", "echo hi", 1001)).unwrap();

        let entries = log.audit_entries().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].decision.as_deref(), Some("accept"));
        // 自动决策必须留痕，否则无法审计自动放行
        assert_eq!(entries[1].actor, "auto");

        let json = log.export_audit_json().unwrap();
        assert!(json.contains("command_approval"));
        assert!(json.contains("\"actor\": \"auto\""));
    }

    #[test]
    fn audit_can_be_cleared_and_pruned() {
        let log = EventLog::in_memory().unwrap();
        for i in 0..5 {
            log.append_audit(&AuditEntry::new("k", "user", "s", 1000 + i)).unwrap();
        }
        assert_eq!(log.prune_audit_before(1003).unwrap(), 3);
        assert_eq!(log.audit_entries().unwrap().len(), 2);

        assert_eq!(log.clear_audit().unwrap(), 2);
        assert!(log.audit_entries().unwrap().is_empty());
    }

    #[test]
    fn reopening_persists_events() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.db");
        {
            let log = EventLog::open(&path).unwrap();
            log.append(&rec("th1", "e1")).unwrap();
            log.append(&rec("th1", "e2")).unwrap();
        }
        let log = EventLog::open(&path).unwrap();
        assert_eq!(log.event_count().unwrap(), 2);
        assert_eq!(log.events_for_thread("th1").unwrap().len(), 2);
    }
}
