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

/// 撤销单个文件的未提交改动。
///
/// # 为什么不能用协议的 `thread/revert`
///
/// 实测锁定的 schema 里写得很明确：`thread/revert`（以及已废弃的
/// `thread/rollback`）**只改会话历史，不还原本地文件**——
/// rollback 的参数说明原文是 "Clients are responsible for reverting
/// these changes"。所以「撤销某文件的改动」必须由客户端自己做，
/// 与 Git 面板的其它能力同源（见本模块头部说明）。
///
/// # 语义按文件在 git 中的实际状态分派
///
/// | 状态 | 动作 |
/// |---|---|
/// | 已暂存（含暂存后又改） | 先 `restore --staged` 撤出暂存，再恢复工作区 |
/// | 已跟踪、仅工作区有改动 | `restore` 恢复自索引 |
/// | 未跟踪（Agent 新建的文件） | 删除文件——「撤销新建」只能是删掉它 |
///
/// 未跟踪文件走删除是**有破坏性**的一步，且 git 无法找回。因此调用方
/// 必须先让用户确认；返回值里也带上实际动作，UI 据此如实告知做了什么。
pub fn revert_file(workspace: &Path, rel_path: &str) -> Result<FileRevert, String> {
    let path = check_rel_path(rel_path)?;

    let out = run_git_literal(workspace, &["status", "--porcelain=v2", "--untracked-files=all", "--", &path])
        .ok_or_else(|| format!("无法读取 {path} 的 git 状态（该路径可能不在仓库内）"))?;

    let mut staged = false;
    let mut worktree = false;
    let mut untracked = false;
    for line in out.lines() {
        if line.starts_with("? ") {
            untracked = true;
        } else if line.starts_with("1 ") || line.starts_with("2 ") || line.starts_with("u ") {
            // `u`（未合并冲突）也走同一条恢复路径：恢复自索引是用户
            // 明确要求「回到这个文件的上一次状态」时最接近的语义。
            let xy = line.split_whitespace().nth(1).unwrap_or("..");
            let mut chars = xy.chars();
            staged |= chars.next().is_some_and(|c| c != '.');
            worktree |= chars.next().is_some_and(|c| c != '.');
        }
    }

    if !staged && !worktree && !untracked {
        // 三种「没得撤」必须分开说，否则用户不知道下一步该做什么：
        // 已跟踪且干净（已经是最新）、不在跟踪范围（git 管不到它）、
        // 根本不存在（路径打错了）。
        //
        // 不能只看 `status` 是否为空来区分前两者——**干净文件在 porcelain
        // 里同样不出现**，只看它就会把「已经是最新」误报成「被忽略」。
        // 所以另查一次 `ls-files` 判断是否被跟踪。
        let tracked = run_git_literal(workspace, &["ls-files", "--", &path])
            .is_some_and(|out| !out.trim().is_empty());
        if tracked {
            return Err(format!("{path} 与上一次提交一致，没有可撤销的改动"));
        }
        if !workspace.join(&path).exists() {
            return Err(format!("{path} 不存在"));
        }
        return Err(format!(
            "{path} 不在 git 的跟踪范围内（可能被 .gitignore 忽略），无法撤销"
        ));
    }

    if staged {
        run_git_checked_literal(workspace, &["restore", "--staged", "--", &path])?;
    }

    if untracked {
        // 未跟踪文件在磁盘上：撤销 = 删除。先确认它确实是文件，
        // 目录传进来（`a/b` 这种路径拼错）不该被递归删掉。
        let abs = workspace.join(&path);
        let meta = std::fs::symlink_metadata(&abs)
            .map_err(|e| format!("无法读取 {path}：{e}"))?;
        if meta.is_dir() {
            return Err(format!("{path} 是目录，撤销只支持单个文件"));
        }
        std::fs::remove_file(&abs).map_err(|e| format!("删除 {path} 失败：{e}"))?;
        return Ok(FileRevert {
            path,
            action: RevertAction::Deleted,
            unstaged: staged,
        });
    }

    run_git_checked_literal(workspace, &["restore", "--", &path])?;
    Ok(FileRevert {
        path,
        action: RevertAction::Restored,
        unstaged: staged,
    })
}

/// 撤销动作的结果。UI 直接展示，避免「点了撤销但不知道它做了什么」。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRevert {
    pub path: String,
    pub action: RevertAction,
    /// 撤销前是否是暂存状态（先撤出了暂存区）。
    pub unstaged: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RevertAction {
    /// 已跟踪文件恢复到上一次提交的内容。
    Restored,
    /// 未跟踪文件被删除。
    Deleted,
}

/// 校验前端传来的仓库内相对路径。
///
/// 两道防线，缺一不可：
/// - **拒绝绝对路径与 `..`**：否则 `git restore -- /etc/passwd` 这类参数
///   会把仓库外的路径交给 git（`--` 只挡选项注入，不挡路径越界）；
/// - **字面路径**：git 的 pathspec 支持 `:(glob)` 等魔法前缀，含 `*` 的
///   路径会被展开成多个文件。所有命令都带 `GIT_LITERAL_PATHSPECS=1`
///   把这个开关关掉（见 `run_git_literal`）。
fn check_rel_path(rel_path: &str) -> Result<String, String> {
    let p = Path::new(rel_path);
    if rel_path.trim().is_empty() {
        return Err("路径不能为空".to_owned());
    }
    if p.is_absolute() {
        return Err(format!("撤销只接受仓库内相对路径：{rel_path}"));
    }
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                return Err(format!("路径不得包含 ..：{rel_path}"));
            }
            std::path::Component::Normal(_) | std::path::Component::CurDir => {}
            _ => return Err(format!("路径不合法：{rel_path}")),
        }
    }
    // 规范化掉 `./` 前缀：git 对 `./a` 与 `a` 的匹配结果一致，
    // 但返回值用于展示与后续比较，统一成一种写法。
    let cleaned: Vec<String> = p
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    if cleaned.is_empty() {
        return Err("路径不能指向仓库根".to_owned());
    }
    Ok(cleaned.join("/"))
}

/// 构造 git 调用：关掉分页与交互提示（避免把控制字符读进来、
/// 也避免在无人看守的子进程里等一个永远不会有的输入）。
///
/// `literal` 打开 `GIT_LITERAL_PATHSPECS`——撤销路径必须按字面解析，
/// 见 `check_rel_path`。
fn git_command(workspace: &Path, literal: bool) -> Command {
    let mut cmd = Command::new("git");
    cmd.current_dir(workspace)
        .env("GIT_PAGER", "cat")
        .env("GIT_TERMINAL_PROMPT", "0");
    if literal {
        cmd.env("GIT_LITERAL_PATHSPECS", "1");
    }
    cmd
}

/// 执行 git 命令并保证按字面路径解析 pathspec。
fn run_git_literal(workspace: &Path, args: &[&str]) -> Option<String> {
    let out = git_command(workspace, true).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

fn run_git_checked_literal(workspace: &Path, args: &[&str]) -> Result<String, String> {
    git_output(git_command(workspace, true).args(args).output(), args)
}

/// 执行 git 命令，失败时返回 stderr 内容（比「失败」两个字有用得多——
/// 用户需要看到 `nothing to commit` 还是 `no upstream branch`）。
fn run_git_checked(workspace: &Path, args: &[&str]) -> Result<String, String> {
    git_output(git_command(workspace, false).args(args).output(), args)
}

fn git_output(
    out: std::io::Result<std::process::Output>,
    args: &[&str],
) -> Result<String, String> {
    let out = out.map_err(|e| format!("无法执行 git：{e}"))?;
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
    let out = git_command(workspace, false).args(args).output().ok()?;
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

    /// 跑一条 git 命令，必须成功。
    ///
    /// 带作者环境变量：CI 与全新机器上没有全局 `user.name`，
    /// 裸 `git commit` 会直接失败——那会让测试因为环境而不是代码变红。
    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .expect("git 调用失败");
        assert!(
            out.status.success(),
            "git {args:?} 失败：{}",
            String::from_utf8_lossy(&out.stderr)
        );
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

    // ── revert_file ──────────────────────────────────────────────────
    //
    // 这一组的重点不在「能撤销」，而在**撤销的分支是否按文件真实状态走**：
    // 未跟踪文件被删掉、已跟踪文件被恢复、被忽略的文件被拒绝——
    // 三者走错任何一个都会造成数据丢失或「点了没反应」。

    fn write(dir: &Path, name: &str, content: &str) {
        std::fs::write(dir.join(name), content).unwrap();
    }

    fn read(dir: &Path, name: &str) -> String {
        std::fs::read_to_string(dir.join(name)).unwrap()
    }

    #[test]
    fn revert_restores_tracked_file() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        write(dir.path(), "a.txt", "改过的内容");
        let r = revert_file(dir.path(), "a.txt").expect("应撤销成功");
        assert_eq!(r.action, RevertAction::Restored);
        assert!(!r.unstaged, "未暂存的改动不该报告撤出了暂存区");
        assert_eq!(read(dir.path(), "a.txt"), "x", "应恢复成提交时的内容");
        assert!(!status(dir.path()).is_dirty(), "撤销后工作区应干净");
    }

    #[test]
    fn revert_deletes_untracked_file() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        write(dir.path(), "new.txt", "agent 新建的文件");
        let r = revert_file(dir.path(), "new.txt").expect("应撤销成功");
        assert_eq!(r.action, RevertAction::Deleted, "未跟踪文件的撤销只能是删除");
        assert!(!dir.path().join("new.txt").exists(), "文件应已被删除");
    }

    #[test]
    fn revert_unstages_then_restores() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        write(dir.path(), "a.txt", "暂存后又改了一遍");
        git(dir.path(), &["add", "a.txt"]);
        write(dir.path(), "a.txt", "工作区再改一遍");

        let r = revert_file(dir.path(), "a.txt").expect("应撤销成功");
        assert_eq!(r.action, RevertAction::Restored);
        assert!(r.unstaged, "撤销前是暂存状态，应报告撤出了暂存区");
        assert_eq!(read(dir.path(), "a.txt"), "x");
        let s = status(dir.path());
        assert!(!s.is_dirty(), "暂存与工作区都应回到干净状态: {s:?}");
    }

    #[test]
    fn revert_rejects_ignored_file() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        write(dir.path(), ".gitignore", "build/\n");
        git(dir.path(), &["add", ".gitignore"]);
        git(dir.path(), &["commit", "-qm", "ignore"]);
        std::fs::create_dir(dir.path().join("build")).unwrap();
        write(dir.path(), "build/out.js", "产物");

        let err = revert_file(dir.path(), "build/out.js").unwrap_err();
        // 必须如实说明「git 管不到它」，而不是含糊地说「无需撤销」——
        // 后者会让用户以为文件已经回到原状，而它其实还在。
        assert!(err.contains("跟踪范围"), "应说明不在跟踪范围: {err}");
        assert!(dir.path().join("build/out.js").exists(), "不应删除被忽略的文件");
    }

    #[test]
    fn revert_reports_unchanged_file() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let err = revert_file(dir.path(), "a.txt").unwrap_err();
        assert!(err.contains("没有可撤销"), "应说明没有改动: {err}");
    }

    #[test]
    fn revert_rejects_paths_outside_repo() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        // 绝对路径与 `..` 都必须挡在 git 之前：`--` 只防选项注入，
        // 不防路径越界，而 `git restore -- /etc/passwd` 是真的能跑的。
        for bad in ["/etc/passwd", "../outside.txt", "a/../../b.txt", "", "  "] {
            let err = revert_file(dir.path(), bad).unwrap_err();
            assert!(!err.is_empty(), "{bad:?} 应被拒绝");
        }
    }

    #[test]
    fn revert_treats_glob_path_literally() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        // 文件名本身含 `*`：不开 GIT_LITERAL_PATHSPECS 时 git 会把它当通配符，
        // 可能匹配到别的文件（这里是 a.txt）而不是这个字面文件。
        write(dir.path(), "we*rd.txt", "字面文件名");
        write(dir.path(), "a.txt", "另一个改动");
        let r = revert_file(dir.path(), "we*rd.txt").expect("应撤销成功");
        assert_eq!(r.path, "we*rd.txt");
        assert!(!dir.path().join("we*rd.txt").exists(), "含 * 的文件应被精确删除");
        assert_eq!(read(dir.path(), "a.txt"), "另一个改动", "不该动到被通配符匹配的文件");
    }

    #[test]
    fn revert_normalizes_dot_prefix() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        write(dir.path(), "a.txt", "改了");
        let r = revert_file(dir.path(), "./a.txt").expect("应撤销成功");
        assert_eq!(r.path, "a.txt", "`./` 前缀应被规范掉: {r:?}");
        assert_eq!(read(dir.path(), "a.txt"), "x");
    }
}
