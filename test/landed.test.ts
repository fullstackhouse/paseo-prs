import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { landedIn } from "../server/github";

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
const commit = (file: string, text: string, message: string) => {
  writeFileSync(join(dir, file), text);
  git("add", file);
  git("commit", "-q", "-m", message);
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prs-landed-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  commit("a.txt", "a\n", "base");
  git("checkout", "-q", "-b", "feat");
  commit("b.txt", "b\n", "feat: one");
  commit("c.txt", "c\n", "feat: two");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("landedIn", () => {
  it("is false while the base lacks the branch's changes", async () => {
    expect(await landedIn(dir, "main")).toBe(false);
  });

  it("is true once the branch was squash-merged", async () => {
    git("checkout", "-q", "main");
    git("merge", "-q", "--squash", "feat");
    git("commit", "-q", "-m", "feat (#1)");
    commit("d.txt", "d\n", "later work on main");
    git("checkout", "-q", "feat");
    expect(await landedIn(dir, "main")).toBe(true);
  });

  it("is true for a squash the base has since changed again", async () => {
    git("checkout", "-q", "main");
    git("merge", "-q", "--squash", "feat");
    git("commit", "-q", "-m", "feat (#1)");
    commit("b.txt", "b, revised\n", "rework b on main");
    git("checkout", "-q", "feat");
    expect(await landedIn(dir, "main")).toBe(true);
  });

  it("is false when only part of the branch landed", async () => {
    git("checkout", "-q", "main");
    commit("b.txt", "b\n", "feat: one, shipped alone");
    git("checkout", "-q", "feat");
    expect(await landedIn(dir, "main")).toBe(false);
  });

  it("is false when merging would conflict", async () => {
    git("checkout", "-q", "main");
    commit("b.txt", "other\n", "conflicting b");
    git("checkout", "-q", "feat");
    expect(await landedIn(dir, "main")).toBe(false);
  });
});
