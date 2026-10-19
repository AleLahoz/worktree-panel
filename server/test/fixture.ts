import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskService } from "../src/services/TaskService.js";
import { TaskStore } from "../src/services/TaskStore.js";

export const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

export interface Fixture {
  root: string;
  repo: string;
  origin: string;
  dataDir: string;
  store: TaskStore;
  service: TaskService;
  cleanup: () => Promise<void>;
}

/**
 * Repo con origen bare, `main` y `develop` (con un commit más que main),
 * `release/x` y una rama solo remota `feature/remote-only`.
 */
export function createFixture(): Fixture {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wtp-test-")));
  const origin = path.join(root, "origin.git");
  const repo = path.join(root, "repo");
  const dataDir = path.join(root, "data");
  mkdirSync(repo);
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "Test");
  git(repo, "remote", "add", "origin", origin);

  const commit = (file: string, msg: string) => {
    writeFileSync(path.join(repo, file), msg);
    git(repo, "add", ".");
    git(repo, "commit", "-m", msg);
  };
  commit("a.txt", "init");
  git(repo, "switch", "-c", "develop");
  commit("b.txt", "develop work");
  git(repo, "switch", "-c", "release/x", "main");
  commit("r.txt", "release work");
  git(repo, "switch", "-c", "feature/remote-only", "develop");
  commit("ro.txt", "remote only work");
  git(repo, "push", "origin", "main", "develop", "release/x", "feature/remote-only");
  git(repo, "switch", "main");
  git(repo, "branch", "-D", "feature/remote-only"); // queda solo en origin
  git(repo, "fetch", "--prune", "origin");

  const store = new TaskStore(dataDir);
  return { root, repo, origin, dataDir, store, service: new TaskService(store), cleanup: () => rm(root, { recursive: true, force: true }) };
}
