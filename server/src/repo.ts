import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

export interface LinkKey {
  kind: "repo" | "dir" | "url" | "ticket";
  value: string;
}

function git(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/**
 * Keys identifying the location `cwd`. Inside a git repo: the git common dir
 * (shared by all worktrees) plus the origin remote URL (survives moves).
 * Outside git: the resolved directory.
 */
export function locationKeys(cwd: string): LinkKey[] {
  let dir = cwd;
  try {
    dir = realpathSync(cwd);
  } catch {}
  const common = git(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common) return [{ kind: "dir", value: dir }];
  const keys: LinkKey[] = [{ kind: "repo", value: common }];
  const remote = git(dir, ["remote", "get-url", "origin"]);
  if (remote) keys.push({ kind: "repo", value: remote });
  return keys;
}

/** Commits on the current branch not yet on its upstream, or null outside git / without an upstream. */
export function unpushedCount(cwd: string): number | null {
  const n = git(cwd, ["rev-list", "--count", "@{upstream}..HEAD"]);
  return n === null ? null : Number(n);
}

/** Short SHA for a HEAD-relative revision (HEAD, HEAD~2, HEAD^), or null if it doesn't resolve. */
export function shortSha(cwd: string, rev: string): string | null {
  return git(cwd, ["rev-parse", "--short", "--verify", "--end-of-options", `${rev}^{commit}`]);
}

/** Commit time of HEAD in ms, or null outside git / on an unborn branch. */
export function headTime(cwd: string): number | null {
  const t = git(cwd, ["log", "-1", "--format=%cI"]);
  return t === null ? null : Date.parse(t);
}
