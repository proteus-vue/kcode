//! 变更集与 Diff。
//!
//! # 与协议的关系
//!
//! 协议在三个地方提供 diff 数据（实测 0.155.1）：
//!
//! | 来源 | 载荷 | 用途 |
//! |---|---|---|
//! | `fileChange` Item 的 `changes[]` | 每个文件 `{path, kind, diff}` | 逐文件审阅 |
//! | `turn/diff/updated` 通知 | 整个轮次的统一 diff 文本 | 总览、冲突判断 |
//! | `item/fileChange/patchUpdated` | `changes[]` 增量 | 流式过程中刷新 |
//!
//! `PatchChangeKind` 是 tagged enum：`add` / `delete` / `update{move_path}`。
//! **重命名通过 `update` + `move_path` 表达**，不是一个独立的 rename 类型。
//!
//! # 「已提议」与「已应用」必须分离
//!
//! 审批发生在**应用之前**：`item/fileChange/requestApproval` 请求的是「是否允许
//! 应用这组变更」。因此同一个文件在时间线上有两个语义不同的状态：
//!
//! - **已提议**：审批请求携带的 diff，尚未落盘
//! - **已应用**：`fileChange` Item 完成后回传的 diff，已写入工作区
//!
//! 二者混用会造成严重后果：用户拒绝后仍看到「已变更」，或把未落盘的改动
//! 当成已完成。本模块用 [`ChangeOrigin`] 显式区分。

use serde::{Deserialize, Serialize};

/// 单个文件的变更类型。
///
/// 与协议 `PatchChangeKind` 对应。重命名是 `Update` + `move_path`，不是独立类型。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum FileChangeKind {
    Add,
    Delete,
    /// 修改；`movePath` 非空时表示同时重命名到了该路径。
    #[serde(rename_all = "camelCase")]
    Update {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        move_path: Option<String>,
    },
}

impl FileChangeKind {
    pub fn from_protocol(v: &serde_json::Value) -> Self {
        match v.get("type").and_then(|t| t.as_str()) {
            Some("add") => FileChangeKind::Add,
            Some("delete") => FileChangeKind::Delete,
            _ => FileChangeKind::Update {
                move_path: v.get("movePath").and_then(|p| p.as_str()).map(str::to_owned),
            },
        }
    }

    /// 用于文件树分组与 UI 标签。
    pub fn label(&self) -> &'static str {
        match self {
            FileChangeKind::Add => "新增",
            FileChangeKind::Delete => "删除",
            FileChangeKind::Update { move_path: Some(_) } => "重命名",
            FileChangeKind::Update { move_path: None } => "修改",
        }
    }

    /// 是否影响既有内容（用于风险提示：删除比重命名更需谨慎）。
    pub fn is_destructive(&self) -> bool {
        matches!(self, FileChangeKind::Delete)
    }
}

/// 单个文件的变更记录。
///
/// # `diff` 字段的真实语义（实测，与 schema 暗示不同）
///
/// schema 只声明 `diff: string`，没有任何说明。实测（codex 0.155.1）表明
/// 它的内容**随 `kind` 变化**：
///
/// | kind | `diff` 内容 |
/// |---|---|
/// | `add` | **完整文件内容**，不是 diff |
/// | `delete` | **完整被删内容**，不是 diff |
/// | `update` | hunk 文本，**不含** `---`/`+++` 文件头 |
/// | `update` + `movePath` | hunk 文本 + 尾部 `\n\nMoved to: <路径>` |
///
/// 因此**不能**用同一个解析器处理所有情况——对 add/delete 套用 diff 解析器
/// 会得到 0 行增删（因为找不到 `@@` 头），这在审阅面板上表现为「文件变更了
/// 但显示 +0 -0」。
///
/// 需要标准 unified diff（含 `diff --git`、文件头）时，应使用
/// `turn/diff/updated` 通知的载荷。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChangeEntry {
    /// 变更路径。**实测为绝对路径**，显示前通常需要相对化。
    pub path: String,
    pub kind: FileChangeKind,
    /// 见上表的 kind-dependent 内容。
    pub diff: String,
}

impl FileChangeEntry {
    /// 增删行统计。**按 kind 分派**，因为 `diff` 的形态不统一。
    pub fn line_stats(&self) -> DiffStats {
        match &self.kind {
            // add：整体都是新增内容
            FileChangeKind::Add => DiffStats {
                added: count_content_lines(&self.diff),
                removed: 0,
            },
            // delete：整体都是被删内容
            FileChangeKind::Delete => DiffStats {
                added: 0,
                removed: count_content_lines(&self.diff),
            },
            // update：是 hunk 文本，走 diff 解析（重命名时需剥掉尾部标记）
            FileChangeKind::Update { .. } => {
                DiffStats::from_diff(&strip_move_trailer(&self.diff))
            }
        }
    }

    /// 重命名目标。协议把它放在 `kind.movePath`，同时**又在 diff 尾部重复一次**
    /// （实测）。以 `kind.movePath` 为准，尾部重复信息仅作剥除处理。
    pub fn moved_to(&self) -> Option<&str> {
        match &self.kind {
            FileChangeKind::Update { move_path } => move_path.as_deref(),
            _ => None,
        }
    }

    /// 用于展示的路径：绝对路径相对化成「相对工作区」的形式。
    ///
    /// 实测协议给的是绝对路径，直接显示会占满整行且泄露目录结构。
    pub fn display_path(&self, workspace: Option<&std::path::Path>) -> String {
        relativize(&self.path, workspace)
    }

    /// 供审阅面板渲染的解析结果（kind-aware）。
    pub fn parsed(&self) -> ParsedDiff {
        match &self.kind {
            FileChangeKind::Add => ParsedDiff::from_content(&self.diff, true),
            FileChangeKind::Delete => ParsedDiff::from_content(&self.diff, false),
            FileChangeKind::Update { .. } => {
                let mut d = parse_unified_diff(&strip_move_trailer(&self.diff));
                if let Some(to) = self.moved_to() {
                    d.moved_to = Some(to.to_owned());
                }
                d
            }
        }
    }
}

/// 增删行统计。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStats {
    pub added: usize,
    pub removed: usize,
}

impl DiffStats {
    pub fn from_diff(diff: &str) -> Self {
        let mut s = Self::default();
        let mut in_hunk = false;
        for line in diff.lines() {
            if line.starts_with("@@") {
                in_hunk = true;
                continue;
            }
            if !in_hunk {
                // 文件头（`diff --git`、`index`、`---`、`+++`）不计入统计
                continue;
            }
            // 新的文件头出现说明本文件 diff 结束（多文件 diff 拼接时的兜底）
            if line.starts_with("diff --git ") {
                in_hunk = false;
                continue;
            }
            if line.starts_with('+') {
                s.added += 1;
            } else if line.starts_with('-') {
                s.removed += 1;
            }
        }
        s
    }
}

/// 变更来源：区分「已提议」与「已应用」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeOrigin {
    /// 审批请求携带——**尚未落盘**。
    Proposed,
    /// Item 完成后回传——**已写入工作区**。
    Applied,
}

/// Diff 中的一行。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    /// 不含行首标记的正文。
    pub text: String,
    /// 旧文件行号（删除行与上下文行有值）。
    pub old_line: Option<u32>,
    /// 新文件行号（新增行与上下文行有值）。
    pub new_line: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
}

/// 一个 hunk（连续的变更块）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    pub lines: Vec<DiffLine>,
}

/// 解析后的文件 diff。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedDiff {
    /// 旧路径（`---` 行）；新增文件时可能是 `/dev/null`。
    pub old_path: Option<String>,
    /// 新路径（`+++` 行）。
    pub new_path: Option<String>,
    pub hunks: Vec<DiffHunk>,
    /// 重命名目标（协议在 `kind.movePath` 与 diff 尾部各给一次）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved_to: Option<String>,
    /// 解析中遇到的问题。**不静默丢弃**——UI 需据此提示用户。
    pub warnings: Vec<String>,
}

impl ParsedDiff {
    /// 把一个「纯内容」变更（add/delete）构造成可渲染结果。
    ///
    /// add/delete 的 `diff` 是完整文件内容而非 patch，用 diff 解析器处理会得到
    /// 空结果。这里直接按内容构造单侧全量变更行。
    pub fn from_content(content: &str, is_add: bool) -> Self {
        let lines: Vec<DiffLine> = content
            .lines()
            .enumerate()
            .map(|(i, text)| {
                let n = (i + 1) as u32;
                DiffLine {
                    kind: if is_add { DiffLineKind::Added } else { DiffLineKind::Removed },
                    text: text.to_owned(),
                    old_line: if is_add { None } else { Some(n) },
                    new_line: if is_add { Some(n) } else { None },
                }
            })
            .collect();
        let count = lines.len() as u32;
        let hunks = if lines.is_empty() {
            Vec::new()
        } else {
            vec![DiffHunk {
                header: if is_add {
                    format!("@@ -0,0 +1,{count} @@")
                } else {
                    format!("@@ -1,{count} +0,0 @@")
                },
                old_start: if is_add { 0 } else { 1 },
                old_count: if is_add { 0 } else { count },
                new_start: if is_add { 1 } else { 0 },
                new_count: if is_add { count } else { 0 },
                lines,
            }]
        };
        Self { old_path: None, new_path: None, hunks, moved_to: None, warnings: Vec::new() }
    }

    pub fn stats(&self) -> DiffStats {
        let mut s = DiffStats::default();
        for h in &self.hunks {
            for l in &h.lines {
                match l.kind {
                    DiffLineKind::Added => s.added += 1,
                    DiffLineKind::Removed => s.removed += 1,
                    DiffLineKind::Context => {}
                }
            }
        }
        s
    }

    pub fn is_empty(&self) -> bool {
        self.hunks.is_empty()
    }
}

/// 切分后单个文件的 diff 片段。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiffSlice {
    /// 文件路径（优先取新路径）。
    pub path: String,
    pub diff: ParsedDiff,
}

/// 把拼接的多文件 diff 按文件切分。
///
/// # 为什么需要它
///
/// [`parse_unified_diff`] 对拼接的多文件 diff 只保留**最后一个**路径，
/// 所有 hunk 合并进一个结果——拿它做逐文件面板会把多个文件的行混在一起。
///
/// `turn/diff/updated` 通知的载荷正是这种拼接形式（多个 `diff --git` 段落
/// 首尾相接），因此逐文件展示必须先用本函数切分。
///
/// 切分依据是 `diff --git ` 行；若载荷不含该行（某些实现只给 `---`/`+++`），
/// 则退化为「按 `--- ` 行的出现位置切分」，并给出提示。
pub fn split_multi_file_diff(diff: &str) -> Vec<(String, ParsedDiff)> {
    let mut segments: Vec<String> = Vec::new();
    let mut current: Option<String> = None;

    // 优先用 `diff --git ` 作为分段点（标准形态）。
    // 若整段都没有它，才退化为「按 `--- ` 分段」——但不能两个条件同时用，
    // 否则每个文件的 `--- a/x` 行都会另起一段（实测会切出 2 倍段数）。
    let has_git_header = diff.contains("diff --git ");
    let mut seen_body = false;

    for line in diff.lines() {
        let is_file_start = if has_git_header {
            line.starts_with("diff --git ")
        } else {
            // 退化模式：`--- ` 开头，且上一段已有内容（避免把文件头自身当段落起点）
            line.starts_with("--- ") && seen_body
        };
        if is_file_start {
            seen_body = false;
            if let Some(c) = current.take() {
                segments.push(c);
            }
            current = Some(String::new());
        }
        if let Some(c) = current.as_mut() {
            c.push_str(line);
            c.push('\n');
            // 只有 hunk 内容才算「有内容」，文件头不算
            if line.starts_with("@@") || line.starts_with('+') || line.starts_with('-') {
                seen_body = true;
            }
        }
    }
    if let Some(c) = current.take() {
        segments.push(c);
    }

    // 无任何分段标记时，整段作为一个文件
    if segments.is_empty() {
        segments.push(diff.to_owned());
    }

    let mut out = Vec::new();
    for seg in segments {
        let parsed = parse_unified_diff(&seg);
        // 路径优先取 `+++`（新路径），退回 `---`
        let path = parsed
            .new_path
            .clone()
            .or_else(|| parsed.old_path.clone())
            .unwrap_or_default();
        out.push((path, parsed));
    }
    out
}

/// 解析 unified diff 文本。
///
/// 容错优先：协议给出的 diff 可能包含多文件拼接、`\ No newline at end of file`
/// 之类的元行，或空 diff（如纯重命名）。解析器不应因此失败——
/// 但**必须把异常记录下来**（[`ParsedDiff::warnings`]），而不是静默吞掉。
pub fn parse_unified_diff(diff: &str) -> ParsedDiff {
    let mut old_path = None;
    let mut new_path = None;
    let mut hunks: Vec<DiffHunk> = Vec::new();
    let mut warnings = Vec::new();
    let mut current: Option<DiffHunk> = None;
    let mut old_no = 0u32;
    let mut new_no = 0u32;

    for line in diff.lines() {
        // 文件头
        if let Some(rest) = line.strip_prefix("--- ") {
            old_path = Some(clean_path(rest));
            continue;
        }
        if let Some(rest) = line.strip_prefix("+++ ") {
            new_path = Some(clean_path(rest));
            continue;
        }
        // 次要元信息，不影响 hunk
        if line.starts_with("diff --git ")
            || line.starts_with("index ")
            || line.starts_with("new file mode")
            || line.starts_with("deleted file mode")
            || line.starts_with("similarity index")
            || line.starts_with("rename from")
            || line.starts_with("rename to")
        {
            continue;
        }

        // hunk 头：@@ -old,count +new,count @@
        if line.starts_with("@@") {
            if let Some(h) = current.take() {
                hunks.push(h);
            }
            match parse_hunk_header(line) {
                Some((os, oc, ns, nc)) => {
                    old_no = os;
                    new_no = ns;
                    current = Some(DiffHunk {
                        header: line.to_owned(),
                        old_start: os,
                        old_count: oc,
                        new_start: ns,
                        new_count: nc,
                        lines: Vec::new(),
                    });
                }
                None => {
                    warnings.push(format!("无法解析的 hunk 头：{line}"));
                    current = None;
                }
            }
            continue;
        }

        let Some(hunk) = current.as_mut() else {
            // 不在 hunk 内且非已知元信息：记录但不中断
            if !line.trim().is_empty() && !line.starts_with('\\') {
                warnings.push(format!("hunk 之外的意外行：{}", truncate(line, 60)));
            }
            continue;
        };

        // 行内容
        if let Some(text) = line.strip_prefix('+') {
            hunk.lines.push(DiffLine {
                kind: DiffLineKind::Added,
                text: text.to_owned(),
                old_line: None,
                new_line: Some(new_no),
            });
            new_no += 1;
        } else if let Some(text) = line.strip_prefix('-') {
            hunk.lines.push(DiffLine {
                kind: DiffLineKind::Removed,
                text: text.to_owned(),
                old_line: Some(old_no),
                new_line: None,
            });
            old_no += 1;
        } else if let Some(text) = line.strip_prefix(' ') {
            hunk.lines.push(DiffLine {
                kind: DiffLineKind::Context,
                text: text.to_owned(),
                old_line: Some(old_no),
                new_line: Some(new_no),
            });
            old_no += 1;
            new_no += 1;
        } else if line.starts_with('\\') {
            // `\ No newline at end of file`：合法元信息，附着于上一行
            continue;
        } else {
            // 无 `+` / `-` / 空格前缀的行：**按上下文行处理**。
            //
            // 真实场景会遇到两类情况：
            //   1. 空上下文行——许多 diff 实现省略其行首空格
            //   2. 非空行同样丢失行首空格（实测中由上游或传输环节造成）
            //
            // 早先的实现把第 2 类记入 warnings 并**丢弃内容**，导致 diff 显示
            // 残缺。上下文行本就对渲染无害（标记为 Context 即可），
            // 丢掉它们反而让审阅者看不到变更周围的代码。
            if !line.trim().is_empty() {
                warnings.push(format!(
                    "hunk 内缺少前缀的行按上下文处理：{}",
                    truncate(line, 60)
                ));
            }
            hunk.lines.push(DiffLine {
                kind: DiffLineKind::Context,
                text: line.to_owned(),
                old_line: Some(old_no),
                new_line: Some(new_no),
            });
            old_no += 1;
            new_no += 1;
        }
    }

    if let Some(h) = current.take() {
        hunks.push(h);
    }

    ParsedDiff { old_path, new_path, hunks, moved_to: None, warnings }
}

/// `@@ -1,5 +1,7 @@ 可选上下文`
fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let inner = line.strip_prefix("@@")?;
    let end = inner.find("@@")?;
    let spec = inner[..end].trim();

    let mut parts = spec.split_whitespace();
    let old = parts.next()?.strip_prefix('-')?;
    let new = parts.next()?.strip_prefix('+')?;

    let parse = |s: &str| -> Option<(u32, u32)> {
        match s.split_once(',') {
            Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
            None => Some((s.parse().ok()?, 1)),
        }
    };
    let (os, oc) = parse(old)?;
    let (ns, nc) = parse(new)?;
    Some((os, oc, ns, nc))
}

/// 统计「纯内容」的行数。
///
/// 末尾换行不产生额外一行（`"a\n"` 是 1 行而非 2 行），与 `str::lines` 一致。
fn count_content_lines(content: &str) -> usize {
    content.lines().count()
}

/// 剥掉重命名变更在 diff 尾部的 `Moved to: <path>` 标记。
///
/// 实测形态：`"...@@ -1 +1 @@\n-a\n+b\n\n\nMoved to: /abs/path"`。
/// 该标记不是 diff 内容，参与解析会产生噪声警告并污染行数统计。
pub fn strip_move_trailer(diff: &str) -> String {
    match diff.find("\n\nMoved to: ") {
        Some(idx) => diff[..idx].to_owned(),
        None => diff.to_owned(),
    }
}

/// 把绝对路径相对化到工作区；无法相对化时原样返回。
pub fn relativize(path: &str, workspace: Option<&std::path::Path>) -> String {
    let Some(ws) = workspace else { return path.to_owned() };
    let p = std::path::Path::new(path);
    match p.strip_prefix(ws) {
        Ok(rel) => rel.display().to_string(),
        Err(_) => path.to_owned(),
    }
}

fn clean_path(p: &str) -> String {
    let p = p.trim();
    // `--- a/foo.rs` / `+++ b/foo.rs` → `foo.rs`
    let p = p.strip_prefix("a/").or_else(|| p.strip_prefix("b/")).unwrap_or(p);
    // 去掉可能的制表符后缀（git 会对含空格路径加 tab）
    p.split('\t').next().unwrap_or(p).to_owned()
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_owned();
    }
    format!("{}…", s.chars().take(n).collect::<String>())
}

// ─────────────────────────────────────────────────────────────────────────
// ChangeSet
// ─────────────────────────────────────────────────────────────────────────

/// 审阅状态机。
///
/// ```text
/// Proposed → UnderReview → AcceptedPartial | AcceptedAll | Rejected
/// ```
///
/// **注意 `Rejected` 是终态**：被拒绝的变更不会落盘，因此不会进入 `Applied`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
    /// 刚产生，尚未审阅（通常是审批弹窗出现时）。
    Proposed,
    /// 用户正在逐文件查看。
    UnderReview,
    /// 部分文件被接受。
    AcceptedPartial,
    /// 全部接受。
    AcceptedAll,
    /// 全部拒绝。
    Rejected,
}

impl ReviewState {
    /// 是否已有用户决策。
    pub fn is_decided(&self) -> bool {
        !matches!(self, ReviewState::Proposed | ReviewState::UnderReview)
    }
}

/// 单个文件在审阅中的处置。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileDecision {
    Pending,
    Accepted,
    Rejected,
}

impl FileDecision {
    /// 稳定字符串形式，用于事件日志持久化。
    ///
    /// 与 serde 的表示刻意分开：日志是长期存在的产物，
    /// 不应随 serde 属性调整而失效。
    pub fn as_str(self) -> &'static str {
        match self {
            FileDecision::Pending => "pending",
            FileDecision::Accepted => "accepted",
            FileDecision::Rejected => "rejected",
        }
    }

    /// 从稳定字符串解析。
    ///
    /// 不用 `from_str` 这个名字——它与 `std::str::FromStr` 同名但签名不同
    /// （返回 Option 而非 Result），容易误用。
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(FileDecision::Pending),
            "accepted" => Some(FileDecision::Accepted),
            "rejected" => Some(FileDecision::Rejected),
            _ => None,
        }
    }
}

/// 一条用户对文件的决策记录（用于事件日志持久化与重放）。
///
/// **为什么决策要落库**：接受/拒绝是用户对「要不要把这份改动算作已完成」
/// 的判断。只存在内存里的后果是刷新页面就丢，用户会以为自己的审阅结论
/// 从未被记录——而审阅恰恰是本产品的核心承诺之一。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDecisionRecord {
    pub turn_id: String,
    /// 变更文件路径（协议给的是绝对路径）。
    pub path: String,
    pub decision: FileDecision,
    pub decided_at_ms: i64,
}

/// 一个轮次产生的变更集合。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    pub turn_id: String,
    pub thread_id: String,
    pub files: Vec<FileChangeEntry>,
    pub origin: ChangeOrigin,
    pub review_state: ReviewState,
    /// 逐文件决策，与 `files` 同序。
    pub decisions: Vec<FileDecision>,
}

impl ChangeSet {
    pub fn new(thread_id: impl Into<String>, turn_id: impl Into<String>, origin: ChangeOrigin) -> Self {
        Self {
            turn_id: turn_id.into(),
            thread_id: thread_id.into(),
            files: Vec::new(),
            origin,
            review_state: ReviewState::Proposed,
            decisions: Vec::new(),
        }
    }

    /// 以最新数据替换文件列表（协议会多次推送更新，取最后一份）。
    pub fn upsert_files(&mut self, files: Vec<FileChangeEntry>) {
        let prev: Vec<FileDecision> = self.decisions.clone();
        self.decisions = files
            .iter()
            .map(|f| {
                // 保留已有决策：增量更新不应把用户已做的决定重置
                prev.iter()
                    .zip(self.files.iter())
                    .find(|(_, old)| old.path == f.path)
                    .map(|(d, _)| *d)
                    .unwrap_or(FileDecision::Pending)
            })
            .collect();
        self.files = files;
        self.recompute_state();
    }

    pub fn decide_file(&mut self, path: &str, decision: FileDecision) -> bool {
        let Some(idx) = self.files.iter().position(|f| f.path == path) else {
            return false;
        };
        if let Some(d) = self.decisions.get_mut(idx) {
            *d = decision;
        }
        self.recompute_state();
        true
    }

    pub fn decide_all(&mut self, decision: FileDecision) {
        // `fill` 而非手写循环：语义相同且更短，同时避开 clippy 1.98 的
        // `manual_slice_fill`（见 docs/协议勘误与修正.md §3.33）。
        self.decisions.fill(decision);
        self.recompute_state();
    }

    fn recompute_state(&mut self) {
        if self.files.is_empty() {
            self.review_state = ReviewState::Proposed;
            return;
        }
        let accepted = self.decisions.iter().filter(|d| **d == FileDecision::Accepted).count();
        let rejected = self.decisions.iter().filter(|d| **d == FileDecision::Rejected).count();
        let pending = self.decisions.iter().filter(|d| **d == FileDecision::Pending).count();

        self.review_state = if pending == self.files.len() {
            // 全部待决
            ReviewState::Proposed
        } else if pending > 0 {
            // 有决定但仍有未决
            ReviewState::UnderReview
        } else if accepted == self.files.len() {
            ReviewState::AcceptedAll
        } else if rejected == self.files.len() {
            ReviewState::Rejected
        } else {
            // 混合：部分接受部分拒绝
            ReviewState::AcceptedPartial
        };
    }

    pub fn total_stats(&self) -> DiffStats {
        self.files.iter().fold(DiffStats::default(), |acc, f| {
            let s = f.line_stats();
            DiffStats { added: acc.added + s.added, removed: acc.removed + s.removed }
        })
    }

    /// 被接受的文件（用于生成提交候选）。
    pub fn accepted_files(&self) -> Vec<&FileChangeEntry> {
        self.files
            .iter()
            .zip(self.decisions.iter())
            .filter(|(_, d)| **d == FileDecision::Accepted)
            .map(|(f, _)| f)
            .collect()
    }

    pub fn has_conflict_risk(&self) -> bool {
        // 同一路径在一次变更里出现多次，或含删除操作时提示冲突风险
        let mut seen = std::collections::HashSet::new();
        self.files.iter().any(|f| !seen.insert(&f.path)) || self.files.iter().any(|f| f.kind.is_destructive())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,4 +1,5 @@
 fn main() {
-    println!(\"old\");
+    println!(\"new\");
+    println!(\"extra\");
 }
";

    #[test]
    fn parses_basic_diff() {
        let d = parse_unified_diff(SAMPLE);
        assert_eq!(d.old_path.as_deref(), Some("src/main.rs"));
        assert_eq!(d.new_path.as_deref(), Some("src/main.rs"));
        assert_eq!(d.hunks.len(), 1);
        let h = &d.hunks[0];
        assert_eq!((h.old_start, h.old_count, h.new_start, h.new_count), (1, 4, 1, 5));
        assert!(d.warnings.is_empty(), "不应有警告: {:?}", d.warnings);
    }

    #[test]
    fn line_numbers_are_tracked_per_side() {
        let d = parse_unified_diff(SAMPLE);
        let lines = &d.hunks[0].lines;
        // fn main() { 是上下文行，两侧都有行号
        assert_eq!(lines[0].kind, DiffLineKind::Context);
        assert_eq!((lines[0].old_line, lines[0].new_line), (Some(1), Some(1)));
        // 删除行只有旧行号
        let removed = lines.iter().find(|l| l.kind == DiffLineKind::Removed).unwrap();
        assert!(removed.old_line.is_some() && removed.new_line.is_none());
        // 新增行只有新行号
        let added = lines.iter().find(|l| l.kind == DiffLineKind::Added).unwrap();
        assert!(added.old_line.is_none() && added.new_line.is_some());
    }

    #[test]
    fn stats_ignore_file_headers() {
        let d = parse_unified_diff(SAMPLE);
        let s = d.stats();
        // 2 新增、1 删除；`+++`/`---` 头不计入
        assert_eq!(s.added, 2, "新增行数错误: {s:?}");
        assert_eq!(s.removed, 1, "删除行数错误: {s:?}");
    }

    #[test]
    fn stats_from_raw_diff_matches_parsed() {
        // 两个入口（直接统计 / 解析后统计）必须一致
        let raw = DiffStats::from_diff(SAMPLE);
        let parsed = parse_unified_diff(SAMPLE).stats();
        assert_eq!(raw, parsed);
    }

    #[test]
    fn handles_multiple_hunks() {
        let diff = "\
--- a/f.txt
+++ b/f.txt
@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -10,3 +10,4 @@
 x
 y
+z
 w
";
        let d = parse_unified_diff(diff);
        assert_eq!(d.hunks.len(), 2);
        assert_eq!(d.hunks[1].old_start, 10);
        assert_eq!(d.hunks[1].lines.iter().filter(|l| l.kind == DiffLineKind::Added).count(), 1);
    }

    #[test]
    fn handles_no_newline_marker() {
        let diff = "\
--- a/f
+++ b/f
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
";
        let d = parse_unified_diff(diff);
        assert_eq!(d.hunks.len(), 1);
        assert!(d.warnings.is_empty(), "元行不应产生警告: {:?}", d.warnings);
        assert_eq!(d.stats(), DiffStats { added: 1, removed: 1 });
    }

    #[test]
    fn handles_add_file_diff() {
        let diff = "\
--- /dev/null
+++ b/new.rs
@@ -0,0 +1,2 @@
+line one
+line two
";
        let d = parse_unified_diff(diff);
        assert_eq!(d.old_path.as_deref(), Some("/dev/null"));
        assert_eq!(d.new_path.as_deref(), Some("new.rs"));
        assert_eq!(d.stats(), DiffStats { added: 2, removed: 0 });
    }

    #[test]
    fn handles_empty_diff_without_error() {
        // 纯重命名可能没有 hunk 内容
        let d = parse_unified_diff("");
        assert!(d.is_empty());
        assert!(d.warnings.is_empty());
        assert_eq!(d.stats(), DiffStats::default());
    }

    #[test]
    fn missing_line_prefix_is_tolerated_as_context() {
        // 真实上游可能丢失上下文行的前导空格（实测在传输/转义环节出现过）。
        // 早先实现会把这些行记入 warnings 并**丢弃内容**，导致 diff 显示残缺。
        // 现在按上下文行处理——内容保留，同时留下提示。
        let diff = "@@ -1,2 +1,3 @@\ndef add(a,b):\n    return a+b\n+def multiply(a,b):\n";
        let d = parse_unified_diff(diff);
        assert_eq!(d.hunks.len(), 1);
        let h = &d.hunks[0];
        // 两行无前缀行被保留为上下文
        assert_eq!(
            h.lines.iter().filter(|l| l.kind == DiffLineKind::Context).count(),
            2,
            "无前缀行应按上下文保留，实际: {:?}",
            h.lines
        );
        assert!(h.lines.iter().any(|l| l.text.contains("def add")), "内容丢失");
        // 新增行统计不受影响
        assert_eq!(d.stats().added, 1);
        // 但应提示用户格式异常
        assert!(!d.warnings.is_empty(), "应保留提示以便排查");
    }

    #[test]
    fn records_warnings_instead_of_dropping_unknown_lines() {
        // 异常内容应被记录，而不是静默丢弃
        let d = parse_unified_diff("@@ 这不是合法的 hunk 头 @@\n+line\n");
        assert!(!d.warnings.is_empty(), "非法 hunk 头应产生警告");
    }

    #[test]
    fn splits_multi_file_diff_into_separate_entries() {
        // 逐文件面板的前提：拼接的 diff 必须能切成独立条目，
        // 否则两个文件的行会混在一起。
        let diff = "\
diff --git a/one.txt b/one.txt
--- a/one.txt
+++ b/one.txt
@@ -1 +1 @@
-a
+A
diff --git a/two.txt b/two.txt
--- a/two.txt
+++ b/two.txt
@@ -1 +1 @@
-b
+B
";
        let parts = split_multi_file_diff(diff);
        assert_eq!(parts.len(), 2, "应切成 2 个文件，实际 {}", parts.len());
        assert_eq!(parts[0].0, "one.txt");
        assert_eq!(parts[1].0, "two.txt");
        // 每个条目的统计必须独立——这正是混在一起时会错的地方
        assert_eq!(parts[0].1.stats(), DiffStats { added: 1, removed: 1 });
        assert_eq!(parts[1].1.stats(), DiffStats { added: 1, removed: 1 });
        assert_eq!(parts[0].1.hunks.len(), 1, "每个文件只有自己的 hunk");
    }

    #[test]
    fn split_handles_single_file_and_empty() {
        let one = split_multi_file_diff(
            "diff --git a/x.rs b/x.rs\n--- a/x.rs\n+++ b/x.rs\n@@ -1 +1 @@\n-a\n+b\n",
        );
        assert_eq!(one.len(), 1);
        assert_eq!(one[0].0, "x.rs");

        let empty = split_multi_file_diff("");
        assert_eq!(empty.len(), 1, "空输入也应返回一项，避免调用方处理空数组");
        assert!(empty[0].1.is_empty());
    }

    #[test]
    fn split_covers_add_and_rename_segments() {
        // 新增文件与重命名在多文件 diff 里的形态
        let diff = "\
diff --git a/new.rs b/new.rs
new file mode 100644
--- /dev/null
+++ b/new.rs
@@ -0,0 +1,2 @@
+line1
+line2
diff --git a/old.rs b/renamed.rs
similarity index 90%
rename from old.rs
rename to renamed.rs
--- a/old.rs
+++ b/renamed.rs
@@ -1 +1 @@
-x
+y
";
        let parts = split_multi_file_diff(diff);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].0, "new.rs");
        assert_eq!(parts[0].1.stats(), DiffStats { added: 2, removed: 0 });
        assert_eq!(parts[1].0, "renamed.rs", "重命名应取新路径");
        assert_eq!(parts[1].1.stats(), DiffStats { added: 1, removed: 1 });
    }

    #[test]
    fn parses_multi_file_diff_sequentially() {
        // 拼接的多文件 diff：每个 hunk 独立解析，路径取最后一次 ---/+++
        let diff = "\
--- a/one.txt
+++ b/one.txt
@@ -1 +1 @@
-a
+A
--- a/two.txt
+++ b/two.txt
@@ -1 +1 @@
-b
+B
";
        let d = parse_unified_diff(diff);
        assert_eq!(d.hunks.len(), 2);
        assert_eq!(d.stats(), DiffStats { added: 2, removed: 2 });
    }

    #[test]
    fn hunk_header_without_count() {
        // `@@ -1 +1 @@` 形式：省略计数表示 1 行
        let d = parse_unified_diff("@@ -5 +7 @@\n-x\n+y\n");
        assert_eq!(d.hunks.len(), 1);
        assert_eq!((d.hunks[0].old_start, d.hunks[0].old_count), (5, 1));
        assert_eq!((d.hunks[0].new_start, d.hunks[0].new_count), (7, 1));
    }

    #[test]
    fn context_lines_with_leading_space_are_preserved() {
        let d = parse_unified_diff("@@ -1,2 +1,2 @@\n keep\n-old\n+new\n");
        assert_eq!(d.hunks[0].lines[0].text, "keep");
    }

    // ── FileChangeKind ──────────────────────────────────────────────────

    // ── `diff` 字段的实测语义（回归防护）────────────────────────────────
    //
    // 以下用例的内容**逐字取自真实 app-server 0.155.1 的报文**。
    // 它们守护的是一个用 schema 看不出来、只能实测得知的事实：
    // `diff` 字段的形态随 kind 变化。

    /// 实测载荷：`add` 的 diff 是完整文件内容。
    const REAL_ADD_DIFF: &str = "brand new\nsecond line\n";

    /// 实测载荷：`delete` 的 diff 是完整被删内容。
    const REAL_DELETE_DIFF: &str = "delete me\n";

    /// 实测载荷：`update` 的 diff 是 hunk 文本，无 `---`/`+++` 文件头。
    const REAL_UPDATE_DIFF: &str =
        "@@ -1,3 +1,3 @@\n line one\n-line two\n+LINE TWO CHANGED\n line three\n";

    /// 实测载荷：重命名 = update + movePath，且 diff 尾部重复 `Moved to:`。
    const REAL_RENAME_DIFF: &str =
        "@@ -1 +1 @@\n-to be renamed\n+renamed content\n\n\nMoved to: /tmp/ws/renamed.txt";

    fn real_entry(kind: FileChangeKind, diff: &str) -> FileChangeEntry {
        FileChangeEntry {
            path: "/tmp/ws/f.txt".into(),
            kind,
            diff: diff.into(),
        }
    }

    #[test]
    fn add_content_is_counted_as_added_lines() {
        // 若用 diff 解析器处理 add 内容（无 @@ 头），会得到 0 行——
        // 审阅面板将显示「+0 -0」，用户看不出改了什么。
        let e = real_entry(FileChangeKind::Add, REAL_ADD_DIFF);
        let s = e.line_stats();
        assert_eq!(s.added, 2, "add 内容的全部行应计为新增: {s:?}");
        assert_eq!(s.removed, 0);
    }

    #[test]
    fn delete_content_is_counted_as_removed_lines() {
        let e = real_entry(FileChangeKind::Delete, REAL_DELETE_DIFF);
        let s = e.line_stats();
        assert_eq!(s.added, 0);
        assert_eq!(s.removed, 1, "delete 内容的全部行应计为删除: {s:?}");
    }

    #[test]
    fn update_hunks_are_parsed_normally() {
        let e = real_entry(FileChangeKind::Update { move_path: None }, REAL_UPDATE_DIFF);
        let s = e.line_stats();
        assert_eq!(s.added, 1, "update: {s:?}");
        assert_eq!(s.removed, 1, "update: {s:?}");
    }

    #[test]
    fn rename_trailer_does_not_pollute_stats() {
        // 尾部 `Moved to:` 不是 diff 内容；若参与解析会产生警告并可能污染统计
        let e = real_entry(
            FileChangeKind::Update { move_path: Some("/tmp/ws/renamed.txt".into()) },
            REAL_RENAME_DIFF,
        );
        let s = e.line_stats();
        assert_eq!(s, DiffStats { added: 1, removed: 1 });

        let parsed = e.parsed();
        assert!(parsed.warnings.is_empty(), "重命名尾部标记不应产生警告: {:?}", parsed.warnings);
        assert_eq!(parsed.moved_to.as_deref(), Some("/tmp/ws/renamed.txt"));
        assert_eq!(e.moved_to(), Some("/tmp/ws/renamed.txt"));
    }

    #[test]
    fn add_and_delete_parse_into_renderable_hunks() {
        // add/delete 必须也能产出可渲染内容，而不是空 hunk
        let add = real_entry(FileChangeKind::Add, REAL_ADD_DIFF).parsed();
        assert!(!add.is_empty(), "add 内容应生成可渲染的 hunk");
        assert_eq!(add.stats().added, 2);
        assert!(add.hunks[0].lines.iter().all(|l| l.kind == DiffLineKind::Added));

        let del = real_entry(FileChangeKind::Delete, REAL_DELETE_DIFF).parsed();
        assert!(!del.is_empty());
        assert_eq!(del.stats().removed, 1);
        assert!(del.hunks[0].lines.iter().all(|l| l.kind == DiffLineKind::Removed));
    }

    #[test]
    fn empty_add_produces_no_hunks_but_no_error() {
        let e = real_entry(FileChangeKind::Add, "");
        assert_eq!(e.line_stats(), DiffStats::default());
        assert!(e.parsed().is_empty());
    }

    #[test]
    fn absolute_paths_are_relativized_for_display() {
        // 实测：协议给的是绝对路径，直接显示会占满整行
        let e = FileChangeEntry {
            path: "/home/me/proj/src/main.rs".into(),
            kind: FileChangeKind::Update { move_path: None },
            diff: String::new(),
        };
        assert_eq!(
            e.display_path(Some(std::path::Path::new("/home/me/proj"))),
            "src/main.rs"
        );
        // 无法相对化时保持原样，不丢信息
        assert_eq!(
            e.display_path(Some(std::path::Path::new("/other"))),
            "/home/me/proj/src/main.rs"
        );
        assert_eq!(e.display_path(None), "/home/me/proj/src/main.rs");
    }

    #[test]
    fn strip_move_trailer_only_affects_renames() {
        assert_eq!(strip_move_trailer(REAL_UPDATE_DIFF), REAL_UPDATE_DIFF);
        assert!(!strip_move_trailer(REAL_RENAME_DIFF).contains("Moved to"));
        // 普通 diff 中若出现该字样但不是尾部标记，不应被误删
        let tweaked = "@@ -1 +1 @@\n-a\n+b\n\n";
        assert_eq!(strip_move_trailer(tweaked), tweaked);
    }

    #[test]
    fn change_kind_maps_from_protocol() {
        use serde_json::json;
        assert_eq!(FileChangeKind::from_protocol(&json!({"type":"add"})), FileChangeKind::Add);
        assert_eq!(FileChangeKind::from_protocol(&json!({"type":"delete"})), FileChangeKind::Delete);
        assert_eq!(
            FileChangeKind::from_protocol(&json!({"type":"update"})),
            FileChangeKind::Update { move_path: None }
        );
        // 重命名是 update + movePath，不是独立类型
        assert_eq!(
            FileChangeKind::from_protocol(&json!({"type":"update","movePath":"new/path.rs"})),
            FileChangeKind::Update { move_path: Some("new/path.rs".into()) }
        );
    }

    #[test]
    fn rename_is_labeled_distinctly_from_update() {
        let renamed = FileChangeKind::Update { move_path: Some("b.rs".into()) };
        let modified = FileChangeKind::Update { move_path: None };
        assert_eq!(renamed.label(), "重命名");
        assert_eq!(modified.label(), "修改");
        assert_ne!(renamed, modified, "重命名与普通修改必须可区分");
    }

    #[test]
    fn delete_is_marked_destructive() {
        assert!(FileChangeKind::Delete.is_destructive());
        assert!(!FileChangeKind::Add.is_destructive());
        assert!(!FileChangeKind::Update { move_path: None }.is_destructive());
    }

    // ── ChangeSet ───────────────────────────────────────────────────────

    fn entry(path: &str, diff: &str) -> FileChangeEntry {
        FileChangeEntry {
            path: path.into(),
            kind: FileChangeKind::Update { move_path: None },
            diff: diff.into(),
        }
    }

    #[test]
    fn new_changeset_starts_proposed() {
        let cs = ChangeSet::new("th", "tu", ChangeOrigin::Proposed);
        assert_eq!(cs.review_state, ReviewState::Proposed);
        assert!(!cs.review_state.is_decided());
    }

    #[test]
    fn review_state_transitions() {
        let mut cs = ChangeSet::new("th", "tu", ChangeOrigin::Applied);
        cs.upsert_files(vec![entry("a", SAMPLE), entry("b", "")]);
        assert_eq!(cs.review_state, ReviewState::Proposed);

        cs.decide_file("a", FileDecision::Accepted);
        assert_eq!(cs.review_state, ReviewState::UnderReview, "部分决策后应进入审阅中");

        cs.decide_file("b", FileDecision::Accepted);
        assert_eq!(cs.review_state, ReviewState::AcceptedAll);

        cs.decide_file("a", FileDecision::Rejected);
        assert_eq!(cs.review_state, ReviewState::AcceptedPartial);

        cs.decide_all(FileDecision::Rejected);
        assert_eq!(cs.review_state, ReviewState::Rejected);
        assert!(cs.review_state.is_decided());
    }

    #[test]
    fn incremental_update_preserves_user_decisions() {
        // 协议会多次推送 changes；已做的决策不能被重置
        let mut cs = ChangeSet::new("th", "tu", ChangeOrigin::Applied);
        cs.upsert_files(vec![entry("a", SAMPLE), entry("b", "")]);
        cs.decide_file("a", FileDecision::Accepted);

        cs.upsert_files(vec![entry("a", SAMPLE), entry("b", ""), entry("c", "")]);
        let a_idx = cs.files.iter().position(|f| f.path == "a").unwrap();
        assert_eq!(
            cs.decisions[a_idx],
            FileDecision::Accepted,
            "增量更新把用户已做的决策重置了"
        );
        // 新文件为待决
        let c_idx = cs.files.iter().position(|f| f.path == "c").unwrap();
        assert_eq!(cs.decisions[c_idx], FileDecision::Pending);
    }

    #[test]
    fn deciding_unknown_path_returns_false() {
        let mut cs = ChangeSet::new("th", "tu", ChangeOrigin::Applied);
        cs.upsert_files(vec![entry("a", "")]);
        assert!(!cs.decide_file("nope", FileDecision::Accepted));
    }

    #[test]
    fn accepted_files_filters_correctly() {
        let mut cs = ChangeSet::new("th", "tu", ChangeOrigin::Applied);
        cs.upsert_files(vec![entry("a", ""), entry("b", ""), entry("c", "")]);
        cs.decide_file("a", FileDecision::Accepted);
        cs.decide_file("b", FileDecision::Rejected);
        cs.decide_file("c", FileDecision::Accepted);
        let accepted: Vec<&str> = cs.accepted_files().iter().map(|f| f.path.as_str()).collect();
        assert_eq!(accepted, vec!["a", "c"]);
    }

    #[test]
    fn total_stats_sums_all_files() {
        let mut cs = ChangeSet::new("th", "tu", ChangeOrigin::Applied);
        cs.upsert_files(vec![entry("a", SAMPLE), entry("b", SAMPLE)]);
        assert_eq!(cs.total_stats(), DiffStats { added: 4, removed: 2 });
    }

    #[test]
    fn flags_conflict_risk_for_deletes() {
        let mut cs = ChangeSet::new("th", "tu", ChangeOrigin::Applied);
        cs.upsert_files(vec![FileChangeEntry {
            path: "gone.rs".into(),
            kind: FileChangeKind::Delete,
            diff: String::new(),
        }]);
        assert!(cs.has_conflict_risk(), "含删除操作应提示冲突风险");
    }

    #[test]
    fn proposed_and_applied_are_distinguishable() {
        // 「已提议」与「已应用」必须可区分——否则用户拒绝后仍会看到「已变更」
        let proposed = ChangeSet::new("th", "tu", ChangeOrigin::Proposed);
        let applied = ChangeSet::new("th", "tu", ChangeOrigin::Applied);
        assert_ne!(proposed.origin, applied.origin);
        let pj = serde_json::to_value(&proposed).unwrap();
        let aj = serde_json::to_value(&applied).unwrap();
        assert_eq!(pj["origin"], "proposed");
        assert_eq!(aj["origin"], "applied");
    }
}
