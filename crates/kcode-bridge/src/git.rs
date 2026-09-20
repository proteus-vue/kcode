//! Git 状态查询。
//!
//! # 为什么必须自研
//!
//! 协议**不提供任何 git 能力**——`thread/*`、`turn/*`、`config/*` 里没有
//! 一个 git 方法。Codex 桌面端的 Git 工具面板（分支、更改统计、提交/推送）
//! 全部是客户端自己实现的，本项目同理。
//!
//! # 为什么调 CLI 而非 libgit2
//!
//! worktree、rebase、submodule、`.gitignore` 的边界行为上，CLI 与用户手动
//! 执行完全一致；而 libgit2 有自己的一套理解，容易出现「面板显示的和
//! 命令行跑出来的不一样」——那种不一致极难排查，也会让用户不信任面板。

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

/// 工作区的 git 状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// 是否为 git 仓库。false 时其余字段无意义。
    pub is_repo: bool,
    /// 当前分支名。HEAD 分离（detached）时为 None。
    pub branch: Option<String>,
    /// 仓库根目录（可能位于工作区的父级）。
    pub root: Option<String>,
    /// 已暂存的条目数。
    pub staged: usize,
    /// 已修改未暂存的条目数。
    pub modified: usize,
    /// 未跟踪文件数。
    pub untracked: usize,
    /// 领先上游的提交数。
    pub ahead: usize,
    /// 落后上游的提交数。
    pub behind: usize,
    /// 是否存在冲突（未合并路径）。
    pub conflicted: usize,
}

impl GitStatus {
    pub fn not_a_repo() -> Self {
        Self {
            is_repo: false,
            branch: None,
            root: None,
            staged: 0,
            modified: 0,
            untracked: 0,
            ahead: 0,
            behind: 0,
            conflicted: 0,
        }
    }

    /// 是否有未提交改动。UI 用它决定是否显示「提交」入口。
    pub fn is_dirty(&self) -> bool {
        self.staged + self.modified + self.untracked + self.conflicted > 0
    }

    /// 改动总数（不含 ahead/behind）。
    pub fn changed_count(&self) -> usize {
        self.staged + self.modified + self.untracked + self.conflicted
    }
}

/// 查询工作区的 git 状态。
///
/// 用 `git status --porcelain=v2 --branch` 一次拿到分支、领先/落后与逐文件状态——
/// 比多次调用 `rev-parse` / `status` / `rev-list` 更快，也不会出现
/// 「两次调用之间状态变了」的撕裂。
pub fn status(workspace: &Path) -> GitStatus {
    let Some(out) = run_git(workspace, &["status", "--porcelain=v2", "--branch", "--untracked-files=normal"]) else {
        return GitStatus::not_a_repo();
    };

    let mut s = GitStatus {
        is_repo: true,
        branch: None,
        root: None,
        staged: 0,
        modified: 0,
        untracked: 0,
        ahead: 0,
        behind: 0,
        conflicted: 0,
    };

    for line in out.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            // `(detached)` 表示 HEAD 分离，不作为分支名展示
            if rest != "(detached)" {
                s.branch = Some(rest.to_owned());
            }
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            // 形如 `+2 -3`
            for tok in rest.split_whitespace() {
                if let Some(n) = tok.strip_prefix('+') {
                    s.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = tok.strip_prefix('-') {
                    s.behind = n.parse().unwrap_or(0);
                }
            }
        } else if line.starts_with("1 ") || line.starts_with("2 ") {
            // 普通变更 / 重命名：XY 是暂存与工作区的两位状态码
            let xy = line.split_whitespace().nth(1).unwrap_or("..");
            let mut chars = xy.chars();
            let x = chars.next().unwrap_or('.');
            let y = chars.next().unwrap_or('.');
            if x != '.' {
                s.staged += 1;
            }
            if y != '.' {
                s.modified += 1;
            }
        } else if line.starts_with("u ") {
            // 未合并（冲突）
            s.conflicted += 1;
        } else if line.starts_with("? ") {
            s.untracked += 1;
        }
    }

    s.root = run_git(workspace, &["rev-parse", "--show-toplevel"]).map(|v| v.trim().to_owned());
    s
}

/// 暂存全部改动并提交。
///
/// # 为什么只做「全部暂存」
///
/// Codex 的「提交或推送」是一键流程，不做逐文件挑选——挑选留给 Diff 审阅
/// 面板（用户在那里已经决定接受哪些改动）。两处都做选择会造成
/// 「我以为在审阅面板拒绝了它，但它还是被提交了」。
///
/// # 安全性
///
/// 提交是**本地操作**，不产生网络流量。但它是可撤销性较差的一步
/// （虽然有 reflog），因此要求调用方必须显式提供提交信息。
pub fn commit_all(workspace: &Path, message: &str) -> Result<String, String> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err("提交信息不能为空".to_owned());
    }
    run_git_checked(workspace, &["add", "-A"])?;
    let out = run_git_checked(workspace, &["commit", "-m", msg])?;
    Ok(out)
}

/// 推送到当前分支的上游。
///
/// 首次推送（无上游）时自动建立跟踪关系（`-u origin <branch>`），
/// 这与用户手敲 `git push` 后 git 的提示行为一致。
///
/// **这是网络操作**：目标必须是用户自己配置的 remote。调用方应在 UI 上
/// 显式展示将推送到哪个 remote——项目禁止任何静默外发。
pub fn push(workspace: &Path) -> Result<String, String> {
    let branch = run_git_checked(workspace, &["rev-parse", "--abbrev-ref", "HEAD"])?
        .trim()
        .to_owned();
    if branch.is_empty() || branch == "HEAD" {
        return Err("当前处于 HEAD 分离状态，无法推送".to_owned());
    }

    // 已配置上游 → 直接 push；否则建立跟踪
    let has_upstream = run_git(workspace, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        .is_some();
    if has_upstream {
        run_git_checked(workspace, &["push"])
    } else {
        let remote = default_remote(workspace).ok_or_else(|| {
            "未找到 remote，请先用 git remote add 配置远程仓库".to_owned()
        })?;
        run_git_checked(workspace, &["push", "-u", &remote, &branch])
    }
}

/// 推送到哪个 remote（UI 需要展示给用户）。
pub fn default_remote(workspace: &Path) -> Option<String> {
    let remotes = run_git(workspace, &["remote"])?;
    let list: Vec<&str> = remotes.lines().filter(|l| !l.trim().is_empty()).collect();
    let first = |name: &str| list.iter().find(|r| **r == name).map(|s| (*s).to_owned());
    // 优先 origin，与 git 的惯例一致
    first("origin").or_else(|| list.first().map(|s| (*s).to_owned()))
}

/// 执行 git 命令，失败时返回 stderr 内容（比「失败」两个字有用得多——
/// 用户需要看到 `nothing to commit` 还是 `no upstream branch`）。
fn run_git_checked(workspace: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(workspace)
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| format!("无法执行 git：{e}"))?;

    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let msg = err.trim();
    Err(if msg.is_empty() {
        format!("git {} 失败", args.join(" "))
    } else {
        msg.to_owned()
    })
}

/// 执行 git 命令，成功返回 stdout。任何失败（非仓库、无 git）返回 None。
fn run_git(workspace: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(workspace)
        // 关掉分页与颜色，避免把控制字符读进来
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn init_repo(dir: &Path) {
        let run = |args: &[&str]| {
            Command::new("git")
                .args(args)
                .current_dir(dir)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .expect("git 调用失败");
        };
        run(&["init", "-q"]);
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        run(&["add", "-A"]);
        run(&["commit", "-qm", "init"]);
    }

    #[test]
    fn non_repo_reports_cleanly() {
        let dir = tempfile::tempdir().unwrap();
        let s = status(dir.path());
        assert!(!s.is_repo, "非仓库应标记 is_repo=false");
        assert!(!s.is_dirty());
        assert_eq!(s.changed_count(), 0);
    }

    #[test]
    fn clean_repo_has_branch_and_no_changes() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let s = status(dir.path());
        assert!(s.is_repo);
        assert!(s.branch.is_some(), "应有分支名");
        assert!(!s.is_dirty(), "刚提交完应是干净的");
        assert!(s.root.is_some(), "应能取到仓库根");
    }

    #[test]
    fn detects_untracked_and_modified() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        // 新增未跟踪文件
        std::fs::write(dir.path().join("new.txt"), b"n").unwrap();
        let s1 = status(dir.path());
        assert_eq!(s1.untracked, 1, "应统计未跟踪文件: {s1:?}");
        assert!(s1.is_dirty());

        // 修改已跟踪文件并暂存
        std::fs::write(dir.path().join("a.txt"), b"y").unwrap();
        let s2 = status(dir.path());
        assert_eq!(s2.modified, 1, "应统计已修改未暂存: {s2:?}");

        Command::new("git")
            .args(["add", "a.txt"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        let s3 = status(dir.path());
        assert_eq!(s3.staged, 1, "暂存后应计入 staged: {s3:?}");
    }

    #[test]
    fn detached_head_has_no_branch() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        // 取当前提交 hash 并 checkout，制造 detached HEAD
        let hash = run_git(dir.path(), &["rev-parse", "HEAD"]).unwrap();
        Command::new("git")
            .args(["checkout", "-q", hash.trim()])
            .current_dir(dir.path())
            .output()
            .unwrap();
        let s = status(dir.path());
        assert!(s.is_repo);
        assert!(s.branch.is_none(), "detached HEAD 不应有分支名: {s:?}");
    }

    #[test]
    fn commit_all_requires_message() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        assert!(commit_all(dir.path(), "   ").is_err(), "空提交信息应被拒绝");
    }

    #[test]
    fn commit_all_creates_commit() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        std::fs::write(dir.path().join("b.txt"), b"new").unwrap();
        // 提交前是脏的
        assert!(status(dir.path()).is_dirty());
        commit_all(dir.path(), "feat: 加个文件").expect("提交应成功");
        // 提交后干净
        let s = status(dir.path());
        assert!(!s.is_dirty(), "提交后应干净: {s:?}");
    }

    #[test]
    fn commit_all_reports_nothing_to_commit() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        // 没有改动时提交应报错，且错误信息应来自 git（可读）
        let err = commit_all(dir.path(), "空提交").unwrap_err();
        assert!(
            err.contains("nothing to commit") || err.contains("无文件要提交") || !err.is_empty(),
            "应给出可读的原因: {err}"
        );
    }

    #[test]
    fn detects_default_remote() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        // 无 remote
        assert!(default_remote(dir.path()).is_none(), "未配置 remote 时应返回 None");

        // 加两个 remote，应优先 origin
        for name in ["upstream", "origin"] {
            Command::new("git")
                .args(["remote", "add", name, "https://example.invalid/x.git"])
                .current_dir(dir.path())
                .output()
                .unwrap();
        }
        assert_eq!(default_remote(dir.path()).as_deref(), Some("origin"));
    }

    #[test]
    fn push_without_remote_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let err = push(dir.path()).unwrap_err();
        assert!(err.contains("remote"), "无 remote 时应提示配置: {err}");
    }

    #[test]
    fn changed_count_sums_all_categories() {
        let s = GitStatus {
            is_repo: true,
            branch: Some("main".into()),
            root: None,
            staged: 2,
            modified: 3,
            untracked: 4,
            ahead: 0,
            behind: 0,
            conflicted: 1,
        };
        assert_eq!(s.changed_count(), 10);
        assert!(s.is_dirty());
    }
}
