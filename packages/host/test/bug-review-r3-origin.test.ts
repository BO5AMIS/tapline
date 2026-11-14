import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writablePath } from "../src/bugreport.js";
import type { Finding } from "../src/findings.js";
import type { SessionInfo, TaplineHost } from "../src/server.js";
import { APP } from "./drive-helpers.js";
import { flushExploreMaps } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";
import { repairRig, textOf } from "./repair-helpers.js";

// PR 14 CodeRabbit (R3): a bug from a failure whose early steps can't be written down starts where its first kept step starts.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** The two private parts the case needs: the finding of a failed `expect`, and the slot the last failure is kept in. */
interface Inner {
  expectFailedFinding(session: SessionInfo, steps: Array<Record<string, unknown>>, brk: { index: number; code: string; message: string }): Finding | null;
  lastFailure: Finding | null;
}

describe("R3-origin: path_from when steps were dropped", () => {
  it("writablePath says how many steps it dropped", () => {
    const steps = [{ tool: "tap", target: { id: "a" } }, { tool: "tap" }, { tool: "back" }];
    expect(writablePath(steps)).toMatchObject({ cut: true, dropped: 2 });
    expect(writablePath([{ tool: "back" }])).toMatchObject({ cut: false, dropped: 0 });
  });

  it("starts at the first kept step's origin place, not at the stale one", async () => {
    const bugsDir = mkdtempSync(join(tmpdir(), "tapline-r3o-bugs-"));
    dirs.push(bugsDir);
    const r = await repairRig(hosts, apps, dirs, { tools: { bugsDir } });
    const session = r.s.host.current();
    if (session === undefined) throw new Error("no session");
    const inner = r.s.tools as unknown as Inner;
    const found = inner.expectFailedFinding(
      session,
      [
        { tool: "tap", target: { id: "open-settings" }, place: "home" },
        // a touch by point can't be written down for a person, so the steps up to here are dropped
        { tool: "tap", target: { x: 30, y: 170 }, place: "settings" },
        { tool: "back", expect: { id: "no-such-element" }, place: "settings_again" },
      ],
      { index: 2, code: "expect_failed", message: "the expectation failed" },
    );
    expect(found?.path_from).toBe("home");
    inner.lastFailure = found;
    const made = textOf(await r.s.tools.bugReport({ from: "failure", verify: false }));
    const id = /bug_[0-9a-f]{16}(?:_\d+)?/.exec(made)?.[0] as string;
    const stored = JSON.parse(readFileSync(join(bugsDir, APP.id, id, "finding.json"), "utf8")) as { path: unknown[]; path_from: string | null };
    expect(stored.path).toHaveLength(1);
    expect(stored.path_from).toBe("settings_again");
    expect((JSON.parse(readFileSync(join(bugsDir, APP.id, id, "repro.json"), "utf8")) as { start?: string }).start).toBe("settings_again");
  });

  it("is null when the first kept step has no recorded place", async () => {
    const bugsDir = mkdtempSync(join(tmpdir(), "tapline-r3o-bugs-"));
    dirs.push(bugsDir);
    const r = await repairRig(hosts, apps, dirs, { tools: { bugsDir } });
    const session = r.s.host.current();
    if (session === undefined) throw new Error("no session");
    const inner = r.s.tools as unknown as Inner;
    inner.lastFailure = inner.expectFailedFinding(
      session,
      [
        { tool: "tap", target: { id: "open-settings" }, place: "home" },
        { tool: "tap", target: { x: 30, y: 170 } },
        { tool: "back", expect: { id: "no-such-element" } },
      ],
      { index: 2, code: "expect_failed", message: "the expectation failed" },
    );
    const made = textOf(await r.s.tools.bugReport({ from: "failure", verify: false }));
    const id = /bug_[0-9a-f]{16}(?:_\d+)?/.exec(made)?.[0] as string;
    const stored = JSON.parse(readFileSync(join(bugsDir, APP.id, id, "finding.json"), "utf8")) as { path_from: string | null };
    expect(stored.path_from).toBeNull();
  });
});
