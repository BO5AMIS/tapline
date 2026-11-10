import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { checkUnchanged, expectNoState, expectState, isTimeoutAnswer, PRESENT_WAIT_S } from "../src/lab.js";
import type { CallResult } from "../src/mcp.js";
import { R1_STEPS, R3_CHECKS, R4_GRID } from "../src/reliability/checks.js";
import { dismissShare, popoverDismissPoint, runR1, type Env } from "../src/reliability/driver.js";

describe("closing a popover share sheet (iOS 26)", () => {
  const region = 'e1 other "dismiss popup" id=PopoverDismissRegion @0,0 430x932 [tap]';
  const sheet = "e2 other id=ActivityListView @9,510 412x414";

  it("taps inside the dismiss region, halfway between the top bars and the sheet", () => {
    expect(popoverDismissPoint(`App: Lab\n${region}\n${sheet}`)).toEqual({ x: 215, y: 310 });
  });

  it("without the sheet's frame, aims above the middle of the screen", () => {
    expect(popoverDismissPoint(`App: Lab\n${region}`)).toEqual({ x: 215, y: 288 });
  });

  it("does nothing when there is no dismiss region, or no room above the sheet", () => {
    expect(popoverDismissPoint(`App: Lab\n${sheet}`)).toBeNull();
    expect(popoverDismissPoint(`App: Lab\n${region}\ne2 other id=ActivityListView @9,120 412x800`)).toBeNull();
  });

  const envOf = (lab: FakeLab): Env => ({
    tool: guardApp(lab.tool(), LAB_APP),
    hasAlert: true,
    sleep: () => Promise.resolve(),
    skipNotes: new Set(),
  });

  it("closes the popover with one tap outside the sheet, judged by a look, and never sends back", async () => {
    const lab = new FakeLab({ alertTool: true, popoverShare: true });
    lab.shareOpen = true;
    lab.scroll = 900; // lab-state is off screen: the verdict can't come from it
    expect(await dismissShare(envOf(lab))).toBe(true);
    expect(lab.shareOpen).toBe(false);
    expect(lab.calls).not.toContain("back");
    expect(lab.calls).not.toContain("alert");
    expect(lab.offLab).toBe(false);
  });

  it("touches nothing when the sheet is already gone", async () => {
    const lab = new FakeLab({ alertTool: true, popoverShare: true });
    expect(await dismissShare(envOf(lab))).toBe(true);
    expect(lab.calls.filter((n) => n !== "look" && n !== "wait_for")).toEqual([]);
  });

  it("keeps the older sheet's way (alert dismiss) and stops short of back once it closed", async () => {
    const lab = new FakeLab({ alertTool: true });
    lab.shareOpen = true;
    expect(await dismissShare(envOf(lab))).toBe(true);
    expect(lab.calls).toContain("alert");
    expect(lab.calls).not.toContain("back");
  });

  it("reads lab-state on screen: no misses when steps far down the lab push it off the top", async () => {
    const lab = new FakeLab({ alertTool: true, popoverShare: true, stateScrolls: true });
    const rows = await runReliability(guardApp(lab.tool(), LAB_APP), { runs: 1, link: "good", idleMs: 30 });
    const r1 = rows.find((r) => r.id === "R1");
    expect(r1 && "misses" in r1 ? r1.misses : -1).toBe(0);
    const r3 = rows.find((r) => r.id === "R3");
    expect(r3?.notes ?? "").not.toContain("state lacks");
    expect(lab.offLab).toBe(false);
  }, 60_000);

  it("the whole suite with the iOS 26 share popover stays on the lab", async () => {
    const lab = new FakeLab({ alertTool: true, popoverShare: true });
    const rows = await runReliability(guardApp(lab.tool(), LAB_APP), { runs: 1, link: "good", idleMs: 30 });
    expect(lab.offLab).toBe(false);
    expect(rows.find((r) => r.id === "R3")?.notes ?? "").not.toContain("could not be dismissed");
  }, 60_000);
});
import {
  bringIntoView,
  elementRect,
  fieldParts,
  firstLine,
  parseStateFields,
  hasAlertTool,
  isOnScreen,
  parseError,
  startsWithReason,
  toolHas,
  withBusyRetry,
} from "../src/reliability/helpers.js";
import { checkRow, runReliability } from "../src/reliability/suite.js";
import { resolvePoint } from "../src/reliability/viewerInput.js";
import { allPass, buildScorecard, formatTable, type CheckRow, type ResultRow } from "../src/scorecard.js";
import { selectSuites } from "../src/suites.js";
import { guardApp } from "../src/guard.js";
import { FakeLab, H, LAB_APP, W, type FakeOptions } from "./fakeLab.js";

const TOKEN = "REL-TOKEN-9";

function rowOf(rows: ResultRow[], id: string): CheckRow {
  const r = rows.find((x) => x.id === id);
  if (!r || !("checks" in r)) throw new Error(`no check row ${id}`);
  return r;
}

/* ---------- a local viewer: /stream open, /ws gestures change the fake lab ---------- */

interface Viewer {
  server: Server;
  wss: WebSocketServer;
}

async function startViewer(lab: FakeLab, ignoreGestures = false): Promise<Viewer> {
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    if (req.url !== "/stream" || req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "multipart/x-mixed-replace; boundary=frame" });
    res.flushHeaders();
  });
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== "/ws" || req.headers.authorization !== `Bearer ${TOKEN}`) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on("message", (raw) => {
        const msg: unknown = JSON.parse(raw.toString());
        if (ignoreGestures || typeof msg !== "object" || msg === null) return;
        const m = msg as { type?: string; points?: unknown };
        if (m.type !== "gesture" || !Array.isArray(m.points)) return;
        const p: unknown = m.points[0];
        if (Array.isArray(p) && typeof p[1] === "number" && typeof p[2] === "number") {
          lab.personTap(p[1], p[2]);
        }
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  lab.options.viewerLink = `Viewer: http://127.0.0.1:${port}/viewer?token=${TOKEN}`;
  return { server, wss };
}

let viewer: Viewer | undefined;
afterEach(async () => {
  if (!viewer) return;
  for (const c of viewer.wss.clients) c.terminate();
  viewer.server.closeAllConnections();
  await new Promise<void>((r) => viewer?.server.close(() => r()));
  viewer = undefined;
});

async function runWith(options: FakeOptions, runs = 2): Promise<{ rows: ResultRow[]; lab: FakeLab }> {
  const lab = new FakeLab(options);
  viewer = await startViewer(lab);
  // Through the app guard, as the runner does.
  const rows = await runReliability(guardApp(lab.tool(), LAB_APP), { runs, link: "good", idleMs: 60 });
  return { rows, lab };
}

/* ---------- pure helpers ---------- */

describe("answers", () => {
  it("parses Error <code>: <message>", () => {
    expect(parseError("Error not_actionable: covered by the sheet\nmore")).toEqual({
      code: "not_actionable",
      message: "covered by the sheet",
    });
    expect(parseError("Tapped e3.")).toBeNull();
    expect(parseError("Error ambiguous: 2 match")?.code).toBe("ambiguous");
  });
  it("matches the reason at the start of the message", () => {
    expect(startsWithReason("disabled: no handler", ["disabled"])).toBe(true);
    expect(startsWithReason("off screen, scroll", ["off_screen"])).toBe(true);
    expect(startsWithReason("the element is disabled", ["disabled"])).toBe(false);
    expect(startsWithReason("under_tab_bar", ["covered", "under_tab_bar"])).toBe(true);
  });
  it("redacts the token in the first line", () => {
    expect(firstLine("Error x: open http://h/viewer?token=ABC now\nsecond", "ABC")).not.toContain("ABC");
    expect(firstLine("")).toBe("(empty answer)");
  });
  it("reads an element's box and whether it is on screen", () => {
    const text = [
      "Screen 440x956 pt @3x · 2 elements",
      'e1 button "A" id=lab-a @10,20 100x40 [tap]',
      'e2 button "B" id=lab-b @10,990 100x40 [tap]',
    ].join("\n");
    expect(elementRect(text, "lab-a")).toEqual({ x: 10, y: 20, w: 100, h: 40 });
    expect(elementRect(text, "lab")).toBeNull();
    expect(isOnScreen(text, "lab-a")).toBe(true);
    expect(isOnScreen(text, "lab-b")).toBe(false);
    expect(isOnScreen(text, "lab-c")).toBe(false);
  });
});

describe("state helpers", () => {
  it("expectState and expectNoState are opposites on a fake", async () => {
    const lab = new FakeLab();
    const tool = lab.tool();
    expect(await expectState(tool, "pressed=-", 0.5)).toBe(true);
    expect(await expectNoState(tool, "pressed=-")).toBe(false);
    expect(await expectState(tool, "pressed=save", 0.5)).toBe(false);
    expect(await expectNoState(tool, "pressed=save")).toBe(true);
  });
  it("a non-timeout error does not prove absence", async () => {
    const tool = { call: (): Promise<CallResult> => Promise.resolve({ text: "Error paused: viewer", images: 0, isError: true, ms: 1 }) };
    expect(await expectNoState(tool, "x")).toBe(false);
    expect(isTimeoutAnswer("Error timeout: nope", true)).toBe(true);
    expect(isTimeoutAnswer("Error paused: x", true)).toBe(false);
  });
  it("checkUnchanged gives a value that should still be there time for one slow read, and keeps the short window for one that must not appear", async () => {
    const asked: Array<{ text: string; timeout: number }> = [];
    const tool = {
      call: (_name: string, args: Record<string, unknown>): Promise<CallResult> => {
        asked.push({ text: String(args.text), timeout: Number(args.timeout) });
        const present = args.text === "pressed=-";
        return Promise.resolve(present ? { text: "Done after 0.9 s.", images: 0, isError: false, ms: 900 } : { text: "Error timeout: Waited 0.5 s", images: 0, isError: true, ms: 500 });
      },
    };
    expect(await checkUnchanged(tool, ["pressed=-"], ["pressed=save"])).toEqual([]);
    expect(asked).toEqual([
      { text: "pressed=-", timeout: PRESENT_WAIT_S },
      { text: "pressed=save", timeout: 0.5 },
    ]);
    expect(PRESENT_WAIT_S).toBeGreaterThanOrEqual(1.5);
  });

  it("an answer that says it isn't known is asked once more, and proves nothing either way", async () => {
    const unknown = { text: "Error timeout: The phone didn't answer within 2 s, so it isn't known whether text \"x\" is on screen; look, then wait again.", images: 0, isError: true, ms: 2000 };
    let calls = 0;
    const flaky = { call: (): Promise<CallResult> => Promise.resolve(++calls === 1 ? unknown : { text: "Done after 0.1 s.", images: 0, isError: false, ms: 100 }) };
    expect(await expectState(flaky, "x", 2)).toBe(true);
    expect(calls).toBe(2);
    const dead = { call: (): Promise<CallResult> => Promise.resolve(unknown) };
    expect(await expectState(dead, "x", 2)).toBe(false);
    expect(await expectNoState(dead, "x")).toBe(false);
  });

  it("checkUnchanged reports what is wrong", async () => {
    const lab = new FakeLab();
    const tool = lab.tool();
    expect(await checkUnchanged(tool, ["pressed=-"], ["pressed=save"])).toEqual([]);
    lab.pressed = "save";
    expect(await checkUnchanged(tool, ["pressed=-"], ["pressed=save"])).toEqual(["pressed=- is gone", "pressed=save appeared"]);
  });
});

describe("state baseline", () => {
  it("reads the visible fields, leaving out a field cut at the end", () => {
    const full = 'Screen 440x956 pt @3x · 1 elements\ne1 text "pressed=save taps=2 sheet=closed" id=lab-state @0,0 10x10';
    expect(parseStateFields(full)).toEqual({ pressed: "save", taps: "2", sheet: "closed" });
    const cut = 'e1 text "pressed=edge-br taps=1 ty…" id=lab-state @0,0 10x10';
    expect(parseStateFields(cut)).toEqual({ pressed: "edge-br", taps: "1" });
    const cutV15 = 'e1 text "pressed=edge-br taps=1 ty…(+57)" id=lab-state @0,0 10x10';
    expect(parseStateFields(cutV15)).toEqual({ pressed: "edge-br", taps: "1" });
    expect(parseStateFields("no state here")).toEqual({});
  });
  it("falls back to lab-sheet-state while the sheet hides lab-state", () => {
    const lab = new FakeLab();
    lab.sheet = true;
    lab.pressed = "sheet-button";
    const look = lab.call("look", {}).text;
    expect(look).not.toContain("id=lab-state");
    expect(parseStateFields(look)).toMatchObject({ pressed: "sheet-button", sheet: "open" });
    expect(fieldParts({ a: "1", b: "x" })).toEqual(["a=1", "b=x"]);
  });
});

describe("bringIntoView", () => {
  it("scrolls down to an element below the fold", async () => {
    const lab = new FakeLab();
    expect(await bringIntoView(lab.tool(), "lab-row-3")).toBe(true);
    expect(lab.scroll).toBeGreaterThan(0);
  });
  it("scrolls back to the start for an element above", async () => {
    const lab = new FakeLab();
    lab.scroll = 1500;
    expect(await bringIntoView(lab.tool(), "lab-save")).toBe(true);
    expect(lab.scroll).toBe(0);
  });
  it("does not scroll when the element is already on screen", async () => {
    const lab = new FakeLab();
    expect(await bringIntoView(lab.tool(), "lab-save")).toBe(true);
    expect(lab.calls.filter((c) => c === "scroll")).toHaveLength(0);
  });
  it("gives up after 8 scrolls", async () => {
    const lab = new FakeLab();
    expect(await bringIntoView(lab.tool(), "lab-nope")).toBe(false);
    expect(lab.calls.filter((c) => c === "scroll")).toHaveLength(9); // to start + 8 down
  });
});

describe("alert capability and busy retry", () => {
  it("detects `alert` in the tool list", async () => {
    expect(await hasAlertTool(new FakeLab({ alertTool: true }).tool())).toBe(true);
    expect(await hasAlertTool(new FakeLab({ alertTool: false }).tool())).toBe(false);
    expect(await hasAlertTool(new FakeLab({ noListTools: true, alertTool: true }).tool())).toBe(false);
    expect(await toolHas(new FakeLab().tool(), "tap")).toBe(true);
    const broken = { call: (): Promise<CallResult> => Promise.reject(new Error("x")), listTools: (): Promise<string[]> => Promise.reject(new Error("no")) };
    expect(await hasAlertTool(broken)).toBe(false);
  });
  it("retries once after a busy answer, and only once", async () => {
    const answers = ["Error busy: a person is using the app", "Done."];
    let n = 0;
    const slept: number[] = [];
    const base = {
      call: (): Promise<CallResult> => {
        const text = answers[Math.min(n++, answers.length - 1)] ?? "";
        return Promise.resolve({ text, images: 0, isError: text.startsWith("Error"), ms: 1 });
      },
    };
    const tool = withBusyRetry(base, 3500, (ms) => {
      slept.push(ms);
      return Promise.resolve();
    });
    expect((await tool.call("tap", {})).text).toBe("Done.");
    expect(slept).toEqual([3500]);
    n = 0;
    answers[1] = "Error busy: again";
    expect((await tool.call("tap", {})).text).toBe("Error busy: again");
  });
});

describe("check tables", () => {
  it("cover the lab as specified", () => {
    expect(R1_STEPS).toHaveLength(16);
    expect(R3_CHECKS.filter((c) => c.needsAlert)).toHaveLength(2);
    expect(R3_CHECKS).toHaveLength(7);
    expect(R4_GRID).toHaveLength(7);
  });
  it("resolves viewer points from a look", () => {
    const text = [
      `Screen ${W}x${H} pt @3x · 3 elements`,
      'e1 button id=lab-save @80,200 130x40 [tap]',
      'e2 button id=lab-dup-1 @80,300 280x40 [tap]',
    ].join("\n");
    expect(resolvePoint(text, { kind: "center", id: "lab-save" })).toEqual({ x: 145, y: 220 });
    expect(resolvePoint(text, { kind: "gap", above: "lab-save", below: "lab-dup-1", xOf: "lab-save" })).toEqual({ x: 145, y: 270 });
    expect(resolvePoint(text, { kind: "center", id: "lab-x" })).toBeNull();
  });
  it("builds rows with notes for misses", () => {
    const row = checkRow(
      "R3",
      [
        { run: 1, outcome: { id: "R3", name: "a", ok: true } },
        { run: 2, outcome: { id: "R3", name: "b", ok: false, note: "acted" } },
        { run: 1, outcome: { id: "R1", name: "c", ok: false } },
      ],
      ["extra"],
    );
    expect(row).toEqual({ id: "R3", checks: 2, misses: 1, pass: false, notes: "run 2: b -> acted; extra" });
  });
  it("the reliability suite is registered", () => {
    expect(selectSuites("reliability").map((s) => s.name)).toEqual(["reliability"]);
  });
});

/* ---------- against the fake lab ---------- */

describe("R1 and R2 on the fake lab", () => {
  it("every action lands on its target", async () => {
    const lab = new FakeLab({ alertTool: false });
    const out = await runR1({ tool: lab.tool(), hasAlert: false, sleep: () => Promise.resolve(), skipNotes: new Set() });
    expect(out.filter((o) => !o.ok)).toEqual([]);
    expect(out).toHaveLength(32);
    expect(lab.state()).toContain("alert=ok");
    expect(lab.state()).toContain("typed2=xyz");
  });
});

describe("the whole suite on the fake lab", () => {
  it("passes every check with an alert tool", async () => {
    const { rows, lab } = await runWith({ alertTool: true });
    expect(rowOf(rows, "R1")).toMatchObject({ checks: 32, misses: 0, pass: true });
    expect(rowOf(rows, "R2")).toMatchObject({ checks: 32, misses: 0, pass: true });
    expect(rowOf(rows, "R3")).toMatchObject({ checks: 14, misses: 0, pass: true });
    expect(rowOf(rows, "R4")).toMatchObject({ checks: 14, misses: 0, pass: true });
    expect(rowOf(rows, "R5")).toMatchObject({ checks: 2, misses: 0, pass: true });
    for (const id of ["R6", "R7", "R8"]) expect(rowOf(rows, id)).toMatchObject({ checks: 0, pass: null });
    expect(rowOf(rows, "R3").notes).toBeUndefined();
    expect(lab.state()).toContain("pressed=-"); // reset at the end
    const card = buildScorecard({ tool: "t", version: "1", phone: "p", ios: "26", link: "good" }, rows);
    expect(allPass(card)).toBe(true);
    expect(formatTable(card)).toContain("n/a");
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  }, 60_000);

  it("skips the OS-drawn checks without an alert tool and says so", async () => {
    const { rows } = await runWith({ alertTool: false });
    const r3 = rowOf(rows, "R3");
    expect(r3).toMatchObject({ checks: 10, misses: 0, pass: true });
    expect(r3.notes).toContain("skipped: the tool can't dismiss OS-drawn UI");
    expect(rowOf(rows, "R1").pass).toBe(true);
  }, 60_000);

  it("turns a false success on lab-covered into an R3 miss", async () => {
    const { rows } = await runWith({ alertTool: true, bugs: { falseSuccessCovered: true } }, 1);
    const r3 = rowOf(rows, "R3");
    expect(r3.pass).toBe(false);
    expect(r3.misses).toBe(1);
    expect(r3.notes).toContain("tap lab-covered");
    expect(r3.notes).toContain("acted instead of refusing");
    expect(rowOf(rows, "R1").pass).toBe(true);
  }, 60_000);

  it("turns not_found behind the sheet into an R3 miss with the v1.4 note", async () => {
    const { rows } = await runWith({ alertTool: true, bugs: { notFoundBehindSheet: true } }, 1);
    const r3 = rowOf(rows, "R3");
    expect(r3.pass).toBe(false);
    expect(r3.misses).toBe(1);
    expect(r3.notes).toContain("tap lab-save behind the sheet");
    expect(r3.notes).toContain("not_found instead of not_actionable (AGENT-TOOLS v1.4)");
  }, 60_000);

  it("behind OS-drawn UI, judges the state after the cover is closed (the cover hides lab-state)", async () => {
    const { rows } = await runWith({ alertTool: true, bugs: { pressesBehindCover: true } }, 1);
    const r3 = rowOf(rows, "R3");
    expect(r3.pass).toBe(false);
    expect(r3.notes).toContain("tap lab-save behind the share sheet");
    expect(r3.notes).toContain("pressed=save appeared once the cover was closed");
  }, 60_000);

  it("fails R4 when the viewer's taps land nowhere", async () => {
    const lab = new FakeLab({ alertTool: true });
    viewer = await startViewer(lab, true);
    const rows = await runReliability(lab.tool(), { runs: 1, link: "good", idleMs: 30 });
    const r4 = rowOf(rows, "R4");
    expect(r4.pass).toBe(false);
    expect(r4.misses).toBe(4); // save, edge-tl, edge-br, sheet-button never pressed
    expect(r4.notes).toContain("did not show within 3 s");
    expect(rowOf(rows, "R3").pass).toBe(true);
  }, 60_000);

  it("a real miss does not cascade into the next unchanged check", async () => {
    const { rows } = await runWith({ alertTool: true, bugs: { barLetsTouchThrough: true } }, 1);
    const r4 = rowOf(rows, "R4");
    expect(r4.misses).toBe(1);
    expect(r4.notes).toContain("lab-under-header");
    expect(r4.notes).not.toContain("empty space");
    expect(rowOf(rows, "R3").pass).toBe(true);
  }, 60_000);

  it("still passes when look cuts the state text", async () => {
    const { rows } = await runWith({ alertTool: true, truncateStateAt: 40 }, 1);
    expect(rowOf(rows, "R3")).toMatchObject({ misses: 0, pass: true });
    expect(rowOf(rows, "R4")).toMatchObject({ misses: 0, pass: true });
    expect(rowOf(rows, "R5")).toMatchObject({ misses: 0, pass: true });
  }, 60_000);

  describe("R6, drops end clearly", () => {
    const times = { freezeMs: 60, recoverMs: 30, callLimitMs: 40, afterLimitMs: 1000 };
    const r6Run = async (
      kind?: "in-app" | "real-touch" | "hangs" | "silent-success",
    ): Promise<{ rows: ResultRow[]; lab: FakeLab }> => {
      const lab = new FakeLab({ alertTool: true, ...(kind ? { freeze: { ms: times.freezeMs, kind } } : {}) });
      viewer = await startViewer(lab);
      const rows = await runReliability(guardApp(lab.tool(), LAB_APP), { runs: 1, link: "good", idleMs: 30, ...times });
      return { rows, lab };
    };

    it("passes for a tool that works in the app (the tap answers not_answering)", async () => {
      const { rows, lab } = await r6Run("in-app");
      expect(rowOf(rows, "R6")).toMatchObject({ checks: 1, misses: 0, pass: true });
      expect(rowOf(rows, "R7").pass).toBeNull();
      expect(lab.froze).toBe(0); // reset afterwards
      for (const id of ["R1", "R2", "R3", "R4", "R5"]) expect(rowOf(rows, id)).toMatchObject({ misses: 0, pass: true });
    }, 60_000);

    it("passes for a tool with real touches (the tap succeeds, looks answer not_answering)", async () => {
      const { rows } = await r6Run("real-touch");
      expect(rowOf(rows, "R6")).toMatchObject({ checks: 1, misses: 0, pass: true });
    }, 60_000);

    it("misses when a look hangs until the freeze is over", async () => {
      const { rows } = await r6Run("hangs");
      const r6 = rowOf(rows, "R6");
      expect(r6).toMatchObject({ checks: 1, misses: 1, pass: false });
      expect(r6.notes).toMatch(/look during the freeze took [\d.]+ s \(limit 0\.04 s\)/);
    }, 60_000);

    it("misses when the tap is claimed but nothing froze", async () => {
      const { rows } = await r6Run("silent-success");
      const r6 = rowOf(rows, "R6");
      expect(r6).toMatchObject({ checks: 1, misses: 1, pass: false });
      expect(r6.notes).toContain("state lacks froze=1 (the freeze didn't happen, so nothing was tested)");
    }, 60_000);

    it("stays not measured without the fixture, and says so on the R6 row", async () => {
      const { rows } = await r6Run();
      expect(rowOf(rows, "R6")).toMatchObject({ checks: 0, misses: 0, pass: null });
      expect(rowOf(rows, "R6").notes).toContain("R6: the lab has no lab-freeze fixture");
      expect(rowOf(rows, "R3").notes ?? "").not.toContain("R6:");
    }, 60_000);
  });

  it("reports a miss when there is no viewer", async () => {
    const lab = new FakeLab({ alertTool: true });
    const rows = await runReliability(lab.tool(), { runs: 1, link: "good", idleMs: 30 });
    expect(rowOf(rows, "R4")).toMatchObject({ checks: 1, misses: 1, pass: false });
  }, 60_000);
});
