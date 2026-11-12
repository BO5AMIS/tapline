import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import jpeg from "jpeg-js";
import { gifInfo } from "../src/journeygif.js";
import { Journey, type JourneyState } from "../src/journey.js";
import { JourneyRecorder, MAX_FINDINGS, SEVERITY_RULES, buildFindings, countFindings, findingsLine, reportFolderName, scrubFolder, screenSignature, type SeenFinding, type FrameSource } from "../src/journeyreport.js";
import { HOME, rig, shot, textOf, type Rig } from "./journeyhelpers.js";

// AGENT-TOOLS 1.12 §17.5: the frames a journey keeps and the report written at stop.

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});
const make = async (options: Parameters<typeof rig>[0] = {}): Promise<Rig> => {
  const r = await rig(options);
  rigs.push(r);
  return r;
};

const UX_ISSUE = {
  kind: "contrast",
  element: HOME[1],
  problem: "text contrast is 2.1:1; 4.5:1 is the least that reads well",
  basis: "measured",
};
const uxAnswer = (issues: unknown[] = [UX_ISSUE]) => ({ ok: true as const, result: { issues, checked: ["contrast", "naming"], actions: [{ label: "Settings", id: "open-settings" }] } });

const folderOf = (answer: string): string => /Report: (.+)$/m.exec(answer)?.[1] ?? "";
const start = (r: Rig, extra: Record<string, unknown> = {}) => r.tools.journey({ start: true, goal: "change the settings", persona: "a first-timer", ...extra });

/** Home, then Settings, a miss, back home. */
async function walk(r: Rig): Promise<void> {
  r.advance(1000);
  await r.tools.tap({ target: { text: "Settings" } });
  r.advance(2000);
  await r.tools.look({ screenshot: false });
  await r.tools.tap({ target: { text: "Missing" } });
  r.advance(300);
  await r.tools.back({});
}

describe("frames during a journey", () => {
  it("keeps a small frame after each counted step that changed the screen, in the report's folder, never in the answer", async () => {
    const r = await make();
    await start(r);
    const answers = [await r.tools.tap({ target: { text: "Settings" } })];
    answers.push(await r.tools.look({ screenshot: false })); // the list did not change: no new frame
    answers.push(await r.tools.tap({ target: { text: "Missing" } })); // an error: the screen is what it was
    answers.push(await r.tools.back({}));
    answers.push(await r.tools.look({ screenshot: false }));
    expect(answers.every((answer) => answer.content.every((block) => block.type === "text"))).toBe(true);
    const stopped = await r.tools.journey({ stop: true, reached: true });
    const said = textOf(stopped);
    const folder = folderOf(said);
    expect(folder.startsWith(join(r.dir, "journeys"))).toBe(true);
    expect(readdirSync(join(folder, "frames")).sort()).toEqual(["001.jpg", "002.jpg", "003.jpg"]);
    // a small picture: the app was asked for 360 px
    const asked = r.app.requests.filter((q) => q.method === "screenshot").map((q) => (q.params as { maxWidth?: number }).maxWidth);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((w) => w === 360)).toBe(true);
    // only the stop answer carries pictures: its two key pictures
    expect(stopped.content.filter((block) => block.type === "image")).toHaveLength(2);
  });

  it("keeps a frame while the screen animates even if the list is the same", async () => {
    const r = await make({
      onRequest: (req) => (req.method === "press" ? { ok: true, result: { element: HOME[2], settledMs: 2000, settleCapMs: 2000 } } : undefined),
    });
    await start(r);
    await r.tools.tap({ target: { text: "Add egg" } });
    await r.tools.tap({ target: { text: "Add egg" } });
    const folder = folderOf(textOf(await r.tools.journey({ stop: true, reached: true })));
    expect(readdirSync(join(folder, "frames"))).toHaveLength(3); // the start, and a frame for each animating tap
  });

  it("keeps a frame for a touch even when the screen did not change, and none for a look", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tapline-recorder-"));
    try {
      const source: FrameSource = {
        where: () => "front",
        peek: async () => ({ signature: "same", screen: { w: 360, h: 780 }, route: ["home"] }),
        shot: async () => ({ mime: "image/jpeg", data: shot([40, 90, 200], 36, 78) }),
      };
      const rec = new JourneyRecorder(join(dir, "report"), source, () => 0);
      await rec.frame(0, 1, undefined, false);
      await rec.frame(1, 1, undefined, false); // a look at the same screen: nothing new
      await rec.frame(2, 1, { point: { x: 10, y: 20 } }, false); // a touch that changed nothing: kept, with where it landed
      expect(rec.frames.map((f) => f.step)).toEqual([0, 2]);
      expect(rec.frames[1]?.tap).toEqual({ x: 10 / 360, y: 20 / 780 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the screen signature ignores refs and tells a different screen apart", () => {
    const a = screenSignature(HOME, ["home"], 0);
    expect(screenSignature(HOME.map((e) => ({ ...e, ref: "x" })), ["home"], 0)).toBe(a);
    expect(screenSignature(HOME, ["settings"], 0)).not.toBe(a);
    expect(screenSignature(HOME.slice(1), ["home"], 0)).not.toBe(a);
  });

  it("keeps no frame while the app is in the background, and says so", async () => {
    const r = await make();
    await start(r);
    await r.tools.tap({ target: { text: "Settings" } });
    r.app.send({ type: "event", event: "appState", data: { state: "background" } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    await r.tools.look({ screenshot: false }); // answers in_background
    const said = textOf(await r.tools.journey({ stop: true, reached: false }));
    expect(said).toMatch(/Note: 1 frame was not kept because the app was in the background\./);
    expect(readdirSync(join(folderOf(said), "frames"))).toHaveLength(2);
  });
});

describe("the report folder", () => {
  it("is named by date and goal, and holds the report, frames, GIF and key pictures", async () => {
    const r = await make();
    await start(r);
    await walk(r);
    const said = textOf(await r.tools.journey({ stop: true, reached: true, why: "the settings opened" }));
    const folder = folderOf(said);
    expect(folder.endsWith("2026-11-12-1530-change-the-settings")).toBe(true);
    expect(reportFolderName("Log breakfast by scanning its barcode!", new Date(2026, 10, 3, 9, 5).getTime())).toBe("2026-11-03-0905-log-breakfast-by-scanning-its-barcode");
    expect(readdirSync(folder).sort()).toEqual(["findings", "frames", "journey.gif", "key-1.jpg", "key-2.jpg", "report.html", "report.md"]);
    const gif = gifInfo(readFileSync(join(folder, "journey.gif")));
    expect(gif.width).toBe(360);
    expect(gif.frames).toBeGreaterThanOrEqual(3);
    expect(statSync(join(folder, "journey.gif")).size).toBeLessThan(3 * 1024 * 1024);
  });

  it("report.md holds the goal, persona, conditions, result, numbers, path, findings, and the severity rules in its footer", async () => {
    const r = await make();
    await start(r, { conditions: { network: "3g" } });
    await walk(r);
    const folder = folderOf(textOf(await r.tools.journey({ stop: true, reached: false, why: "ran out of road" })));
    const md = readFileSync(join(folder, "report.md"), "utf8");
    expect(md).toContain("# Journey report: change the settings");
    expect(md).toContain("- Persona: a first-timer");
    expect(md).toContain("- Conditions: network 3g");
    expect(md).toContain("- Result: Not reached: ran out of road");
    expect(md).toMatch(/\| Taps \| 1 \|/);
    expect(md).toMatch(/\| Wrong turns \| 1 \|/);
    expect(md).toContain("## The path");
    expect(md).toMatch(/### screen 1 \(home\)\n\n!\[screen 1 \(home\)\]\(frames\/001\.jpg\)/);
    expect(md).toMatch(/### screen 2 \(settings\)/);
    expect(md).toContain("## Findings");
    expect(md).toContain("[high] goal_not_reached");
    expect(md).toContain("[medium] error");
    expect(md).toContain("[medium] wrong_turn");
    for (const rule of SEVERITY_RULES) expect(md).toContain(rule);
    expect(md.indexOf("How severity is chosen")).toBeGreaterThan(md.indexOf("## Findings"));
  });

  it("report.html is self-contained and every picture it names is in the folder, relative", async () => {
    const r = await make({ onRequest: (req) => (req.method === "uxCheck" ? uxAnswer() : undefined) });
    await start(r);
    await r.tools.uxCheck({});
    await walk(r);
    const folder = folderOf(textOf(await r.tools.journey({ stop: true, reached: false })));
    const html = readFileSync(join(folder, "report.html"), "utf8");
    const sources = [...html.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(sources.length).toBeGreaterThanOrEqual(4);
    for (const src of sources) {
      expect(src.startsWith("/") || /^[a-z]+:/.test(src)).toBe(false);
      expect(existsSync(join(folder, src))).toBe(true);
    }
    expect(html).toContain("<style>");
    expect(html).not.toMatch(/<link |<script /);
    expect(html).toContain("How severity is chosen");
  });

  it("escapes what the agent wrote in the html", async () => {
    const r = await make();
    await r.tools.journey({ start: true, goal: "open <b>x</b> & \"y\"" });
    const folder = folderOf(textOf(await r.tools.journey({ stop: true, reached: true })));
    const html = readFileSync(join(folder, "report.html"), "utf8");
    expect(html).toContain("open &lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;");
    expect(html).not.toContain("<b>x</b>");
  });

  it("escapes what the app wrote in a finding title in report.md, so it cannot add an image or link", async () => {
    const r = await make({ onRequest: (req) => (req.method === "uxCheck" ? uxAnswer([{ ...UX_ISSUE, problem: "![pwn](https://evil.example/x.png) [click](https://evil.example) <b>hi</b>" }]) : undefined) });
    await start(r);
    await r.tools.uxCheck({});
    const folder = folderOf(textOf(await r.tools.journey({ stop: true, reached: false })));
    const md = readFileSync(join(folder, "report.md"), "utf8");
    expect(md).not.toContain("![pwn]");
    expect(md).not.toContain("[click](");
    expect(md).not.toContain("<b>");
    expect(md).toContain("\\!\\[pwn\\]");
  });

  it("replaces the report's own folder path in report.md and report.html, so an export does not publish it", async () => {
    const r = await make();
    await start(r);
    const where = join(r.dir, "journeys", "2026-11-12-1530-change-the-settings");
    await r.tools.tap({ target: { text: where } });
    const folder = folderOf(textOf(await r.tools.journey({ stop: true, reached: false })));
    expect(folder).toBe(where);
    for (const file of ["report.md", "report.html"]) {
      const text = readFileSync(join(folder, file), "utf8");
      expect(text).toMatch(/&lt;report&gt;|<report>/);
      expect(text.toLowerCase()).not.toContain(where.toLowerCase());
    }
  });

  it("scrubFolder takes the folder out in both slash styles", () => {
    const folder = String.raw`C:\Users\Sam\.tapline\journeys\2026-goal`;
    const doubled = folder.replace(/\\/g, "\\\\");
    const text = String.raw`a ${folder}\frames\001.jpg b C:/Users/Sam/.tapline/journeys/2026-goal/x c ${doubled} d`;
    const out = scrubFolder(text, folder);
    expect(out).not.toMatch(/Sam/);
    expect(out.match(/<report>/g)).toHaveLength(3);
  });

  it("names shortcuts used, a skipped photo picker, and eyes: agent", async () => {
    const r = await make();
    await start(r, { allow: ["open_url"] });
    await r.tools.openUrl({ url: "app://settings" });
    r.tools.mediaState.recordPickerSkipped("com.example.demo", 2);
    await r.tools.journey({ eyes: "agent" });
    const folder = folderOf(textOf(await r.tools.journey({ stop: true, reached: true })));
    const md = readFileSync(join(folder, "report.md"), "utf8");
    expect(md).toContain('Shortcuts used (a person doesn\'t have these): open_url "app://settings".');
    expect(md).toContain("picker skipped");
    expect(md).toContain("Photo picker skipped once (2 pictures");
    expect(md).toContain("Eyes: agent.");
  });

  it("puts an unused photo picker stub back at the stop (1.5 review, finding 5)", async () => {
    const r = await rig({ capabilities: ["tree", "press", "screenshot", "media"] });
    rigs.push(r);
    await r.tools.journey({ start: true, goal: "add a photo", persona: "a first-timer" });
    await r.tools.journey({ stop: true, reached: false });
    expect(r.app.requests.filter((q) => q.method === "media").map((q) => q.params)).toEqual([{ op: "disarm" }]);
  });

  it("a second journey in the same minute with the same goal gets its own folder", async () => {
    const r = await make();
    await start(r);
    const one = folderOf(textOf(await r.tools.journey({ stop: true, reached: true })));
    await start(r);
    const two = folderOf(textOf(await r.tools.journey({ stop: true, reached: true })));
    expect(two).toBe(`${one}-2`);
  });
});

describe("the stop answer", () => {
  it("is the summary, the findings line with the folder, then at most two small key pictures", async () => {
    const r = await make({ onRequest: (req) => (req.method === "uxCheck" ? uxAnswer() : undefined) });
    await start(r);
    await r.tools.uxCheck({});
    await walk(r);
    r.advance(112_000);
    const answer = await r.tools.journey({ stop: true, reached: true });
    const lines = textOf(answer).split("\n");
    expect(lines[0]).toMatch(/^Journey "change the settings" as a first-timer: reached in 1 tap, 1 min \d+ s \(\d+ s waiting\), 1 wrong turn, \d+ hesitations?\.$/);
    expect(lines[1]).toMatch(/^Findings: (\d+ (high|medium|low)(, )?)+\. Report: .*change-the-settings$/);
    const images = answer.content.filter((block) => block.type === "image");
    expect(images.length).toBe(2);
    for (const block of answer.content) {
      if (block.type !== "image") continue;
      expect(block.mimeType).toBe("image/jpeg");
      const decoded = jpeg.decode(Buffer.from(block.data, "base64"), { useTArray: true });
      expect(decoded.width).toBeLessThanOrEqual(360);
      expect(Buffer.from(block.data, "base64").length).toBeLessThan(60_000);
    }
  });

  it("with --screenshots file names the pictures instead of sending them", async () => {
    const r = await make({ tools: { screenshots: "file" } });
    await start(r);
    await walk(r);
    const answer = await r.tools.journey({ stop: true, reached: true });
    expect(answer.content.every((block) => block.type === "text")).toBe(true);
    expect(textOf(answer)).toMatch(/\nPictures: .*key-1\.jpg/);
  });

  it("without a report folder it is the summary alone", async () => {
    const r = await make({ tools: { journeysDir: undefined } });
    await start(r);
    const answer = await r.tools.journey({ stop: true, reached: true });
    expect(textOf(answer).split("\n")).toHaveLength(1);
    expect(answer.content).toHaveLength(1);
  });

  it("never fails: a report that cannot be written is a Note, the summary stays", async () => {
    const r = await make();
    await start(r);
    await walk(r);
    const journeys = join(r.dir, "journeys");
    const [folder] = readdirSync(journeys);
    mkdirSync(join(journeys, folder ?? "", "report.md"));
    const answer = await r.tools.journey({ stop: true, reached: true });
    expect(answer.isError).not.toBe(true);
    const lines = textOf(answer).split("\n");
    expect(lines[0]).toMatch(/^Journey "change the settings"/);
    expect(textOf(answer)).toMatch(/Note: the report could not be written: /);
    expect(r.tools.currentJourney()).toBeUndefined();
  });

  it("never fails when the report folder cannot be made at start either", async () => {
    const aFile = join(tmpdir(), `tapline-afile-${process.pid}`);
    writeFileSync(aFile, "x");
    try {
      const broken = await make({ tools: { journeysDir: join(aFile, "journeys") } });
      expect(textOf(await start(broken))).toMatch(/Note: no report will be written: /);
      const stopped = textOf(await broken.tools.journey({ stop: true, reached: true }));
      expect(stopped).toMatch(/^Journey "change the settings"/);
      expect(stopped.split("\n")).toHaveLength(1);
    } finally {
      rmSync(aFile, { force: true });
    }
  });
});

describe("ux_check during a journey", () => {
  it("records its findings with a marked-up picture (a red box at the element's frame) and hands later checks the earlier screens' actions", async () => {
    const r = await make({ onRequest: (req) => (req.method === "uxCheck" ? uxAnswer() : undefined) });
    await start(r);
    await r.tools.uxCheck({});
    await r.tools.tap({ target: { text: "Settings" } });
    await r.tools.uxCheck({});
    const calls = r.app.requests.filter((q) => q.method === "uxCheck");
    expect((calls[0]?.params as { earlier?: unknown[] }).earlier ?? []).toEqual([]);
    expect((calls[1]?.params as { earlier?: unknown[] }).earlier).toEqual([{ label: "Settings", id: "open-settings" }]);
    const folder = folderOf(textOf(await r.tools.journey({ stop: true, reached: true })));
    const md = readFileSync(join(folder, "report.md"), "utf8");
    expect(md).toContain("[low] contrast");
    expect(md).toContain("text contrast is 2.1:1");
    const shots = readdirSync(join(folder, "findings")).filter((f) => f.startsWith("ux-"));
    expect(shots.length).toBe(2);
    // the box: the element's frame (24,120 354x48 of 402x874) over a 360x780 picture, drawn in red
    const pic = jpeg.decode(readFileSync(join(folder, "findings", shots[0] ?? "")), { useTArray: true });
    const at = (x: number, y: number): number[] => Array.from(pic.data.subarray((y * pic.width + x) * 4, (y * pic.width + x) * 4 + 3));
    const top = at(180, Math.round((120 / 874) * 780) + 1);
    expect(top[0]).toBeGreaterThan(180);
    expect(top[1]).toBeLessThan(90);
    const away = at(180, 30);
    expect(away[0]).toBeLessThan(120);
  });

  it("lists a finding once however often the screen is checked", async () => {
    const r = await make({ onRequest: (req) => (req.method === "uxCheck" ? uxAnswer() : undefined) });
    await start(r);
    await r.tools.uxCheck({});
    await r.tools.uxCheck({});
    const folder = folderOf(textOf(await r.tools.journey({ stop: true, reached: true })));
    expect([...readFileSync(join(folder, "report.md"), "utf8").matchAll(/\[low\] contrast/g)]).toHaveLength(1);
  });

  it("the naming memory is cleared at the start and at the stop", async () => {
    const r = await make();
    const stale = { earlier: () => [{ label: "Old" }] };
    r.tools.uxJourney = stale;
    await start(r);
    expect(r.tools.uxJourney).not.toBe(stale);
    expect(r.tools.uxJourney).not.toBeNull();
    await r.tools.journey({ stop: true, reached: true });
    expect(r.tools.uxJourney).toBeNull();
  });

  it("notes only the journey's own app: another app's screens are neither remembered nor used", async () => {
    const r = await make({ onRequest: (req) => (req.method === "uxCheck" ? uxAnswer() : undefined) });
    await start(r);
    const hook = r.tools.uxJourney;
    expect(hook?.earlier()).toEqual([]);
    // another app takes over: the hook neither feeds naming nor records
    const { FakeApp } = await import("./helpers.js");
    const other = (await FakeApp.connect(r.host.boundPort() ?? 0, { app: { name: "Other", id: "com.example.other" }, capabilities: ["tree", "uxCheck"] }, () => uxAnswer())).app;
    r.apps.push(other);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.host.current()?.app.id).toBe("com.example.other");
    expect(hook?.earlier()).toBeNull();
    hook?.seen?.("Other", [{ label: "X" }], [{ kind: "contrast", problem: "p", basis: "measured" }]);
    const folder = folderOf(textOf(await r.tools.journey({ stop: true, reached: true })));
    expect(readFileSync(join(folder, "report.md"), "utf8")).not.toContain("[low] contrast");
  });
});

describe("findings and their severity", () => {
  const state = (patch: Partial<JourneyState> = {}): JourneyState => {
    const journey = new Journey({ goal: "g" }, () => 0);
    journey.finish(true, undefined);
    return { ...journey.state, ...patch };
  };
  const step = (n: number, tool: string, flags: Array<"wrong_turn" | "dead_end" | "error" | "crash">, extra: Record<string, unknown> = {}) =>
    ({ n, tool, ok: flags.length === 0, said: "said", at: 0, ms: 0, screen: 1, flags, ...extra }) as JourneyState["steps"][number];
  const seen = (kind: string): SeenFinding => ({ kind, problem: `${kind} problem`, basis: "measured", screen: 1, title: "Home" });

  it("a goal not reached, a crash, a failed stress moment and a missing way forward are high", () => {
    const f = buildFindings(
      state({
        reached: false,
        why: "stuck",
        steps: [step(1, "tap", ["crash"])],
        stress: [{ kind: "background", said: "Stress: background; it didn't survive: text \"2 eggs\" is not on screen any more.", survived: false, afterStep: 1, at: 0 }],
      }),
      [seen("dead_end"), seen("way_back")],
      undefined,
    );
    expect(f.map((x) => x.severity)).toEqual(["high", "high", "high", "high", "high"]);
    expect(f.map((x) => x.kind)).toEqual(["goal_not_reached", "stress", "crash", "dead_end", "way_back"]);
  });

  it("a touch a user could not make, an error, a wrong turn, too many taps and ux problems that mislead are medium", () => {
    const f = buildFindings(
      state({ tapsToGoal: 7, steps: [step(1, "tap", ["dead_end"]), step(2, "tap", ["error"]), step(3, "back", ["wrong_turn"])] }),
      [seen("main_action"), seen("icon_only"), seen("cut_off_text"), seen("choices")],
      4,
    );
    expect(f.every((x) => x.severity === "medium")).toBe(true);
    expect(f.map((x) => x.kind).sort()).toEqual(["choices", "cut_off_text", "dead_end_touch", "error", "icon_only", "main_action", "max_taps_to_goal", "wrong_turn"]);
    expect(f.find((x) => x.kind === "max_taps_to_goal")?.basis).toBe("house rule: max_taps_to_goal 4");
  });

  it("polish is low, and so is an unknown kind; hesitation counts from two", () => {
    const base = state({});
    base.measures = { ...base.measures, hesitations: 2 };
    const f = buildFindings(base, [seen("contrast"), seen("target_size"), seen("thumb_reach"), seen("naming"), seen("something_new")], undefined);
    expect(f.every((x) => x.severity === "low")).toBe(true);
    expect(f.map((x) => x.kind)).toContain("hesitation");
    expect(buildFindings(state({}), [], undefined)).toEqual([]);
  });

  it("is within the tap limit means no finding, and sorts high before medium before low", () => {
    const f = buildFindings(state({ tapsToGoal: 3, steps: [step(1, "back", ["wrong_turn"])] }), [seen("contrast"), seen("dead_end")], 3);
    expect(f.map((x) => x.severity)).toEqual(["high", "medium", "low"]);
    expect(countFindings(f)).toEqual({ high: 1, medium: 1, low: 1 });
    expect(findingsLine({ high: 2, medium: 3, low: 1 })).toBe("Findings: 2 high, 3 medium, 1 low.");
    expect(findingsLine({ high: 0, medium: 0, low: 0 })).toBe("Findings: none.");
  });

  it("a house rule max_taps_to_goal is checked at stop", async () => {
    const r = await make({ tools: { uxRules: { text: ["core features within 2 taps"], wayBack: false, maxTapsToGoal: 1 } } });
    await start(r);
    await r.tools.tap({ target: { text: "Settings" } });
    await r.tools.back({});
    await r.tools.tap({ target: { text: "Settings" } });
    const folder = folderOf(textOf(await r.tools.journey({ stop: true, reached: true })));
    const md = readFileSync(join(folder, "report.md"), "utf8");
    expect(md).toContain("[medium] max_taps_to_goal");
    expect(md).toContain("The goal took 2 taps; the house rule allows 1.");
    expect(md).toContain("max_taps_to_goal: 1");
    expect(md).toContain("core features within 2 taps (judged by the agent)");
  });

  it("lists the worst 100, says how many more there were, and still stops", async () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ ...UX_ISSUE, kind: i < 10 ? "dead_end" : "contrast", problem: `problem ${i}` }));
    const r = await make({ onRequest: (req) => (req.method === "uxCheck" ? uxAnswer(many) : undefined) });
    await start(r);
    await r.tools.uxCheck({});
    const answer = await r.tools.journey({ stop: true, reached: true });
    expect(answer.isError).not.toBe(true);
    expect(textOf(answer).split("\n")[1]).toMatch(/^Findings: 10 high, 120 low\. Report: /);
    const md = readFileSync(join(folderOf(textOf(answer)), "report.md"), "utf8");
    expect(MAX_FINDINGS).toBe(100);
    expect(md).toContain("Showing the worst 100; 30 more findings are not listed.");
    expect([...md.matchAll(/^### \d+\. \[/gm)]).toHaveLength(100);
  });
});
