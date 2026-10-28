import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { prUrl, type PrRef } from "../shared/prs";

export function dataDir(): string {
  const dir = process.env.PASEO_PRS_DIR ?? join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "prs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface LinksFile {
  workspaces: Record<string, PrRef[]>;
}

/** PRs linked to each workspace, in one JSON file. Single writer (the plugin process), written atomically. */
export class LinkStore {
  private readonly path: string;
  private file: LinksFile;

  constructor(dir: string) {
    this.path = join(dir, "links.json");
    this.file = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : { workspaces: {} };
  }

  list(workspaceId: string): PrRef[] {
    return this.file.workspaces[workspaceId] ?? [];
  }

  /** Returns the refs that were not linked yet. */
  link(workspaceId: string, refs: readonly PrRef[]): PrRef[] {
    const current = this.list(workspaceId);
    const known = new Set(current.map(key));
    const added = refs.filter((ref) => !known.has(key(ref)) && known.add(key(ref)));
    if (added.length) this.write(workspaceId, [...current, ...added]);
    return added;
  }

  /** Returns the refs that were linked. */
  unlink(workspaceId: string, refs: readonly PrRef[]): PrRef[] {
    const drop = new Set(refs.map(key));
    const current = this.list(workspaceId);
    const removed = current.filter((ref) => drop.has(key(ref)));
    if (removed.length) this.write(workspaceId, current.filter((ref) => !drop.has(key(ref))));
    return removed;
  }

  private write(workspaceId: string, refs: PrRef[]): void {
    const workspaces = { ...this.file.workspaces, [workspaceId]: refs };
    if (!refs.length) delete workspaces[workspaceId];
    const next = { workspaces };
    writeFileSync(`${this.path}.tmp`, JSON.stringify(next, null, 2));
    renameSync(`${this.path}.tmp`, this.path);
    this.file = next;
  }
}

// GitHub owner and repo names are case-insensitive.
const key = (ref: PrRef) => prUrl(ref).toLowerCase();
