import { describe, expect, it } from "vitest";
import { ACTIVE_WINDOW_MS, isActive } from "../shared/prs";

describe("isActive", () => {
  const now = 10 * ACTIVE_WINDOW_MS;

  it("counts a running agent's workspace as looked at", () => {
    expect(isActive({ running: true, activeAt: 0 }, now)).toBe(true);
  });

  it("counts a workspace whose agent worked recently, and not one idle for longer", () => {
    expect(isActive({ running: false, activeAt: now - ACTIVE_WINDOW_MS + 1 }, now)).toBe(true);
    expect(isActive({ running: false, activeAt: now - ACTIVE_WINDOW_MS }, now)).toBe(false);
    expect(isActive({ running: false, activeAt: 0 }, now)).toBe(false);
  });
});
