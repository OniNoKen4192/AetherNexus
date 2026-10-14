// The only module allowed to run git. Every command goes through refuse(),
// including the ones this class issues itself.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { normalizePath } from "../validate/match.js";

export class GitRefusal extends Error {
  constructor(public readonly args: string[], reason: string) {
    super(`git refusal: ${reason} (${args.join(" ")})`);
  }
}
export type GitLog = (entry: { args: string[]; cwd: string; ms: number; ok: boolean; stderr?: string }) => void;

const OWNED_BRANCH = /^(nexus|system)\//;
const EXCLUDE_LINE = ".nexus/worktrees/";
// Subcommands that write to a working tree.
const TREE_WRITERS = /^(checkout|switch|reset|stash|rebase|commit|merge|clean)$/;
// Inherited variables that would point git at some other repository, index or object store than the cwd's.
const REDIRECT_ENV = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CEILING_DIRECTORIES"]);

// `git status --porcelain -z` record stream -> every path named (renames/copies
// contribute both sides; the original path is its own NUL-terminated field).
function statusPathsZ(out: string): string[] {
  const tokens = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry) continue;
    paths.push(normalizePath(entry.slice(3)));
    if (/[RC]/.test(entry.slice(0, 2)) && tokens[i + 1]) paths.push(normalizePath(tokens[++i]!));
  }
  return paths;
}

// `git diff --name-status -z` record stream: status NUL path NUL, plus a second
// path field for R/C records.
function diffPathsZ(out: string): string[] {
  const tokens = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i++];
    if (!status) continue;
    const first = tokens[i++];
    if (first) paths.push(normalizePath(first));
    if (/^[RC]/.test(status)) {
      const second = tokens[i++];
      if (second) paths.push(normalizePath(second));
    }
  }
  return paths;
}

// First positional argument, skipping flags and the values of flags that take one.
function firstPositional(args: string[], valueFlags: string[] = []): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valueFlags.includes(a)) { i++; continue; }
    if (!a.startsWith("-")) return a;
  }
  return undefined;
}

/**
 * Resolve symlinks and Windows 8.3 short names (realpathSync.native expands them; plain realpathSync does not) so paths
 * compare equal to what git prints. A not-yet-existing path is resolved via its deepest existing ancestor.
 */
export function realPath(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  for (let cur = abs; ; ) {
    try { return path.join(fs.realpathSync.native(cur), ...rest); } catch {}
    try { return path.join(fs.realpathSync(cur), ...rest); } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) return abs;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}

export class Git {
  private readonly wtRoot: string;
  private readonly ceiling: string;
  public readonly repoRoot: string;
  constructor(repoRoot: string, private opts: { log?: GitLog } = {}) {
    this.repoRoot = realPath(path.resolve(repoRoot));
    this.wtRoot = this.canon(path.join(this.repoRoot, ".nexus", "worktrees"));
    this.ceiling = path.join(this.repoRoot, ".nexus", "worktrees");
  }
  /**
   * The child env: process.env minus every repo-redirecting GIT_* variable (case-insensitive, for Windows), plus a
   * discovery ceiling at .nexus/worktrees so a plain directory there can never resolve to the human's repository.
   * The ceiling stops git from walking up INTO .nexus/worktrees; a registered worktree is found at its own .git file,
   * and commands run at the repo root itself are unaffected.
   */
  static childEnv(ceiling: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(base)) if (!REDIRECT_ENV.has(k.toUpperCase())) env[k] = v;
    env["GIT_CEILING_DIRECTORIES"] = ceiling;
    return env;
  }
  /** Install (or clear, with null) the command log hook. */
  setLog(log: GitLog | null): void { this.opts = log ? { log } : {}; }
  canon(p: string): string {
    const abs = normalizePath(realPath(path.resolve(this.repoRoot, p))).replace(/\/+$/, "");
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  }
  // The human's tree is the repo root and everything under it except the nexus worktrees.
  private isMainTree(cwd: string): boolean {
    const c = this.canon(cwd), root = this.canon(this.repoRoot);
    return (c === root || c.startsWith(root + "/")) && !this.underWorktrees(cwd);
  }
  private underWorktrees(p: string): boolean { return this.canon(p).startsWith(this.wtRoot + "/"); }

  private refuse(args: string[], cwd: string): void {
    // Skip leading global `-c key=value` pairs to find the real subcommand.
    let i = 0;
    while (args[i] === "-c") i += 2;
    const cmd = args[i];
    if (cmd === undefined || cmd.startsWith("-")) throw new GitRefusal(args, "global git options (-C, --git-dir, --no-pager, ...) are not allowed");
    const rest = args.slice(i + 1);
    if (cmd === "push") throw new GitRefusal(args, "nothing is ever pushed");
    if (TREE_WRITERS.test(cmd ?? "") && this.isMainTree(cwd)) {
      throw new GitRefusal(args, "the human's working tree is never written to");
    }
    // Judge the repository git will resolve to, not the path string: under .nexus/worktrees a tree- or index-writer
    // runs only inside a registered worktree (a leftover plain directory there is not one).
    if ((TREE_WRITERS.test(cmd ?? "") || cmd === "add") && this.underWorktrees(cwd) && !this.registeredWorktreeOf(cwd)) {
      throw new GitRefusal(args, `${cwd} is not a registered nexus worktree`);
    }
    if (cmd === "branch" && rest.some((a) => a === "--delete" || /^-[a-zA-Z]*[dD]/.test(a))) {
      const names = rest.filter((a) => !a.startsWith("-"));
      if (names.length === 0 || !names.every((n) => OWNED_BRANCH.test(n))) throw new GitRefusal(args, "only nexus/* and system/* branches may be deleted");
    }
    if (cmd === "worktree" && rest[0] === "remove") {
      const dir = firstPositional(rest.slice(1));
      if (!dir || !this.underWorktrees(path.resolve(cwd, dir))) throw new GitRefusal(args, "only worktrees under .nexus/worktrees may be removed");
    }
    if (cmd === "worktree" && rest[0] === "add") {
      const dir = firstPositional(rest.slice(1), ["-b", "-B", "--reason"]);
      if (!dir || !this.underWorktrees(path.resolve(cwd, dir))) throw new GitRefusal(args, "worktrees are created only under .nexus/worktrees");
    }
  }

  /** The registered worktree that contains `p` (itself or an ancestor under .nexus/worktrees), if any. */
  private registeredWorktreeOf(p: string): string | undefined {
    const list = new Set(this.worktreeList());
    for (let c = this.canon(p); c.startsWith(this.wtRoot + "/"); c = c.slice(0, c.lastIndexOf("/"))) {
      if (list.has(c)) return c;
    }
    return undefined;
  }

  runRaw(args: string[], o: { cwd?: string } = {}): string {
    const cwd = o.cwd ?? this.repoRoot;
    this.refuse(args, cwd);
    const t0 = performance.now();
    try {
      const out = execFileSync("git", ["-c", "core.quotepath=false", "-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: Git.childEnv(this.ceiling) });
      this.opts.log?.({ args, cwd, ms: performance.now() - t0, ok: true });
      return out;
    } catch (err) {
      const e = err as { stderr?: string; message: string };
      this.opts.log?.({ args, cwd, ms: performance.now() - t0, ok: false, ...(e.stderr ? { stderr: e.stderr } : {}) });
      throw new Error(`git ${args.join(" ")} failed: ${(e.stderr || e.message).trim()}`);
    }
  }
  run(args: string[], o: { cwd?: string } = {}): string { return this.runRaw(args, o).trimEnd(); }

  revParse(ref: string, cwd?: string): string { return this.run(["rev-parse", "--verify", `${ref}^{commit}`], cwd === undefined ? {} : { cwd }); }
  headSha(cwd?: string): string { return this.revParse("HEAD", cwd); }
  branchExists(name: string): boolean { return this.run(["branch", "--list", name]) !== ""; }
  createBranch(name: string, fromSha: string): void { this.run(["branch", name, fromSha]); }
  deleteBranch(name: string, o: { force?: boolean } = {}): boolean {
    if (!OWNED_BRANCH.test(name)) throw new GitRefusal(["branch", "-D", name], "only nexus/* and system/* branches may be deleted");
    try { this.run(["branch", o.force ? "-D" : "-d", name]); return true; } catch { return false; }
  }
  isAncestor(sha: string, ref: string): boolean {
    try { this.run(["merge-base", "--is-ancestor", sha, ref]); return true; } catch { return false; }
  }
  worktreeList(): string[] {
    return this.run(["worktree", "list", "--porcelain"]).split(/\r?\n/)
      .filter((l) => l.startsWith("worktree ")).map((l) => this.canon(l.slice("worktree ".length)));
  }

  private ensureExcluded(): void {
    const excl = path.join(this.repoRoot, ".git", "info", "exclude");
    let text = "";
    try { text = fs.readFileSync(excl, "utf8"); } catch {}
    if (!text.split(/\r?\n/).includes(EXCLUDE_LINE)) {
      fs.mkdirSync(path.dirname(excl), { recursive: true });
      fs.writeFileSync(excl, text + (text === "" || text.endsWith("\n") ? "" : "\n") + EXCLUDE_LINE + "\n");
    }
  }
  // An empty, unregistered directory at a worktree path is a leftover shell
  // (Windows `git worktree remove` leaves the folder behind). Delete it.
  private clearEmptyShell(dir: string): boolean {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return false; }
    if (entries.length || this.worktreeList().includes(this.canon(dir))) return false;
    fs.rmdirSync(dir);
    return true;
  }

  worktreeAdd(dir: string, branch: string, fromSha: string): void {
    if (!this.underWorktrees(dir)) throw new GitRefusal(["worktree", "add", dir], "worktrees are created only under .nexus/worktrees");
    this.clearEmptyShell(dir);
    if (this.worktreeList().includes(this.canon(dir))) {
      if (fs.existsSync(dir)) return; // check-before-act: already there
      this.run(["worktree", "prune"]); // registered but the checkout is gone: re-create it below
    }
    if (fs.existsSync(dir)) throw new Error(`worktree path exists but is not registered: ${dir}`);
    this.ensureExcluded();
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (this.branchExists(branch)) this.run(["worktree", "add", dir, branch]);
    else this.run(["worktree", "add", dir, "-b", branch, fromSha]);
  }
  worktreeRemove(dir: string, o: { force?: boolean } = {}): void {
    if (!this.underWorktrees(dir)) throw new GitRefusal(["worktree", "remove", dir], "only worktrees under .nexus/worktrees may be removed");
    const registered = this.worktreeList().includes(this.canon(dir));
    if (registered && fs.existsSync(dir)) this.run(["worktree", "remove", ...(o.force ? ["--force"] : []), dir]);
    else if (registered) this.run(["worktree", "prune"]);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); // Windows leaves the folder
  }

  statusPaths(cwd: string): string[] {
    return statusPathsZ(this.runRaw(["status", "--porcelain", "-z", "--untracked-files=all"], { cwd }));
  }
  diffPaths(cwd: string, range: string | null, o: { cached?: boolean } = {}): string[] {
    return diffPathsZ(this.runRaw(["diff", "--name-status", "-z", ...(o.cached ? ["--cached"] : []), ...(range ? [range] : [])], { cwd }));
  }
  untrackedPaths(cwd: string): string[] {
    return this.runRaw(["ls-files", "--others", "--exclude-standard", "-z"], { cwd }).split("\0").filter(Boolean).map(normalizePath);
  }
  commitAll(cwd: string, message: string, author: { name: string; email: string }): string | null {
    this.run(["add", "-A"], { cwd });
    if (this.run(["status", "--porcelain"], { cwd }) === "") return null;
    this.run(["-c", `user.name=${author.name}`, "-c", `user.email=${author.email}`, "commit", "-q", "-m", message], { cwd });
    return this.headSha(cwd);
  }
  mergeNoFF(cwd: string, branch: string, message: string): { ok: true; sha: string } | { ok: false; conflict: true; files: string[] } {
    try { this.run(["merge", "--no-ff", "-m", message, branch], { cwd }); return { ok: true, sha: this.headSha(cwd) }; }
    catch (err) {
      let inProgress = true;
      try { this.run(["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd }); } catch { inProgress = false; }
      if (!inProgress) throw err; // not a conflict (unknown branch, dirty tree, ...): surface the real error
      const files = this.run(["diff", "--name-only", "--diff-filter=U"], { cwd }).split(/\r?\n/).filter(Boolean).map(normalizePath);
      this.run(["merge", "--abort"], { cwd });
      return { ok: false, conflict: true, files };
    }
  }
}
