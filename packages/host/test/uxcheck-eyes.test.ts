import { afterEach, describe, expect, it } from "vitest";
import { rig, textOf, type Rig } from "./journeyhelpers.js";

// 1.5 review, finding 2: in a journey's user's eyes (AGENT-TOOLS 1.12 §17.1) `ux_check` is a step of the journey, asks
// the app for what shows on the glass only, and its answer carries no id and no file and line.

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.cleanup();
});

const UX = {
  checked: ["choices", "main_action", "thumb_reach", "icon_only", "cut_off_text", "contrast", "target_size", "dead_end"],
  choices: 3,
  actions: [],
  issues: [
    {
      kind: "icon_only",
      element: { ref: "e4", role: "button", testID: "menu", frame: { x: 340, y: 60, width: 48, height: 48 } },
      problem: "icon-only button with no accessibility label",
      basis: "best practice: an icon-only button needs an accessibility label",
      at: { file: "/work/app/src/Header.tsx", line: 31, direct: true },
    },
  ],
};

describe("ux_check in a user's eyes", () => {
  it("asks for the glass, hides ids and lines, and is a step of the journey", async () => {
    const params: unknown[] = [];
    const r = await rig({
      onRequest: (req) => {
        if (req.method !== "uxCheck") return undefined;
        params.push(req.params);
        return { ok: true, result: UX };
      },
    });
    rigs.push(r);
    await r.tools.journey({ start: true, goal: "find the menu", persona: "a first-timer" });
    const answer = textOf(await r.tools.uxCheck({}));
    expect(params[0]).toMatchObject({ glass: true });
    expect(answer).not.toMatch(/id=menu|testID|Header\.tsx|^\s+at /m);
    expect(answer).toMatch(/1\. icon_only: e4 button/);
    expect(r.tools.currentJourney()?.state.steps.map((s) => s.tool)).toContain("ux_check");
  });

  it("outside a journey keeps ids and lines, and asks for no glass", async () => {
    const params: unknown[] = [];
    const r = await rig({
      onRequest: (req) => {
        if (req.method !== "uxCheck") return undefined;
        params.push(req.params);
        return { ok: true, result: UX };
      },
    });
    rigs.push(r);
    const answer = textOf(await r.tools.uxCheck({}));
    expect(params[0]).not.toHaveProperty("glass");
    expect(answer).toContain("id=menu");
    expect(answer).toMatch(/^\s+at .*Header\.tsx:31$/m);
  });
});
