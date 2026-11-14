import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { afterEach, describe, expect, it } from "vitest";
import type { TaplineHost } from "../src/server.js";
import { btn, flushExploreMaps } from "./explore-helpers.js";
import type { FakeApp } from "./helpers.js";
import { repairRig, textOf, type RepairRig, type RigOptions } from "./repair-helpers.js";

// PR 13 security review, Codex cycle 2 (R4): repair's verification replay.

const hosts: TaplineHost[] = [];
const apps: FakeApp[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await flushExploreMaps();
  for (const app of apps.splice(0)) app.ws.terminate();
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const rig = (options: RigOptions = {}): Promise<RepairRig> => repairRig(hosts, apps, dirs, options);

const RENAMED = [
  { tool: "tap", target: { id: "open-settings-btn" }, expect: { id: "notify-switch" } },
  { tool: "tap", target: { id: "open-language" }, expect: { id: "pick-english" } },
];

describe("R4 item 1: the verification replay keeps repair's floor on repaired and inserted steps", () => {
  it("a repaired control whose recipient turns into Delete before verification is not pressed, and nothing is written", async () => {
    const r = await rig({
      world: (w) => {
        // The trial of the new target presses open-settings once; from then on it lands on Delete.
        w.onPress = (id) => {
          if (id === "open-settings") w.recipient["open-settings"] = btn("open-settings", "Delete");
        };
      },
    });
    r.script("rename", RENAMED);
    const answer = textOf(await r.s.tools.replay({ name: "rename", repair: "apply" }));
    expect(r.s.world.pressed.filter((id) => id === "open-settings")).toHaveLength(1);
    expect(answer).toMatch(/nothing was written/);
    expect(r.files()).toEqual(["rename.json"]);
  });

  it("the steps the user wrote are still replayed as written (the floor is for repaired and inserted steps only)", async () => {
    const r = await rig({
      world: (w) => {
        w.onPress = (id) => {
          // The unrepaired second step lands on a word the floor knows; the user wrote that step, so verification presses it.
          if (id === "open-settings") w.recipient["open-language"] = btn("open-language", "Delete");
        };
      },
    });
    r.script("rename", RENAMED);
    const answer = textOf(await r.s.tools.replay({ name: "rename", repair: "apply" }));
    expect(answer).toContain("with 1 repair");
    expect(r.s.world.pressed.filter((id) => id === "open-language")).toHaveLength(2);
  });
});

/** A grey JPEG with dark squares: 300 by 600, as the fake app's screenshots are when `world.shot` is set. */
function picture(dark: boolean): Buffer {
  const width = 300;
  const height = 600;
  const data = Buffer.alloc(width * height * 4, 200);
  if (dark) {
    for (let y = 40; y < 260; y++) {
      for (let x = 40; x < 260; x++) {
        const i = (y * width + x) * 4;
        data[i] = 20;
        data[i + 1] = 20;
        data[i + 2] = 20;
      }
    }
  }
  return jpeg.encode({ data, width, height }, 90).data;
}

describe("R4 item 5: the repaired file is proven against the references it will use", () => {
  const withPictureStep = [
    { tool: "tap", target: { id: "open-settings-btn" }, expect: { id: "notify-switch", matches: "screen" } },
    { tool: "tap", target: { id: "open-language" }, expect: { id: "pick-english" } },
  ];

  it("a stale repaired.references sidecar is replaced by the original's folder, and the repaired file replays plain", async () => {
    const r = await rig({
      tools: { baselinesDir: mkdtempSync(join(tmpdir(), "tapline-r4-baselines-")) },
      world: (w) => {
        // The screen after step 1 is what the original reference shows.
        w.shot = picture(false).toString("base64");
      },
    });
    r.script("rename", withPictureStep);
    const original = join(r.scriptsDir, "rename.references");
    const stale = join(r.scriptsDir, "rename.repaired.references");
    mkdirSync(original);
    mkdirSync(stale);
    writeFileSync(join(original, "screen.jpg"), picture(false));
    writeFileSync(join(stale, "screen.jpg"), picture(true));
    writeFileSync(join(stale, "old-only.jpg"), "OLD");

    const answer = textOf(await r.s.tools.replay({ name: "rename", repair: "apply" }));
    expect(answer).toContain("with 1 repair");
    // The sidecar is a copy of the original's folder now, nothing of the old one stays.
    expect(readdirSync(stale).sort()).toEqual(["screen.jpg"]);
    expect(readFileSync(join(stale, "screen.jpg")).equals(readFileSync(join(original, "screen.jpg")))).toBe(true);
    expect(readdirSync(r.scriptsDir).filter((name) => name.includes("tmp") || name.includes("old"))).toEqual([]);
    // And the file the run wrote passes a plain replay.
    r.s.world.screen = "home";
    const plain = await r.s.tools.replay({ path: join(r.scriptsDir, "rename.repaired.json") });
    expect(plain.isError).not.toBe(true);
  });

  it("when the original has no pictures, a stale sidecar is removed", async () => {
    const r = await rig();
    r.script("rename", RENAMED);
    const stale = join(r.scriptsDir, "rename.repaired.references");
    mkdirSync(stale);
    writeFileSync(join(stale, "screen.jpg"), picture(true));
    const answer = textOf(await r.s.tools.replay({ name: "rename", repair: "apply" }));
    expect(answer).toContain("with 1 repair");
    expect(existsSync(stale)).toBe(false);
  });
});
