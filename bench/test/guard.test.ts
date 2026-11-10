import { describe, expect, it } from "vitest";
import {
  appOf,
  checkBeforeViewerTap,
  guardApp,
  isSystemUi,
  labAppOf,
  learnLabApp,
  LeftLabError,
} from "../src/guard.js";
import type { CallResult, ToolSession } from "../src/mcp.js";
import { runReliability } from "../src/reliability/suite.js";
import { runSpeed } from "../src/speed.js";
import { FakeLab, LAB_APP, OTHER_APP } from "./fakeLab.js";

const TOUCHES = new Set(["tap", "long_press", "toggle", "type_text", "scroll", "alert", "back"]);

function scripted(answers: (name: string, args: Record<string, unknown>) => string): ToolSession & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    call(name, args): Promise<CallResult> {
      calls.push(name);
      const text = answers(name, args);
      return Promise.resolve({ text, images: 0, isError: text.startsWith("Error"), ms: 1 });
    },
  };
}

describe("app guard", () => {
  it("reads the App: line", () => {
    expect(appOf(`Screen 440x956 pt @3x · 3 elements\nApp: ${LAB_APP}\ne1 button`)).toBe(LAB_APP);
    expect(appOf("Tapped e3.")).toBeNull();
  });

  it("learns the lab app and refuses a look without App:", async () => {
    expect(await learnLabApp(scripted(() => `Screen 1x1 pt\nApp: ${LAB_APP}`))).toBe(LAB_APP);
    await expect(learnLabApp(scripted(() => "Screen 1x1 pt"))).rejects.toThrow(/no App: line/);
  });

  it("sends a lab-id touch straight through, and looks first for any other touch", async () => {
    const t = scripted(() => `Screen 1x1 pt\nApp: ${LAB_APP}`);
    const g = guardApp(t, LAB_APP);
    await g.call("tap", { target: { id: "lab-save" } });
    expect(t.calls).toEqual(["tap"]);
    await g.call("tap", { target: { text: "OK" } });
    await g.call("alert", { action: "dismiss" });
    expect(t.calls).toEqual(["tap", "look", "tap", "look", "alert"]);
    expect(labAppOf(g)).toBe(LAB_APP);
    expect(labAppOf(t)).toBeUndefined();
  });

  it("stops when an answer names another app, and no touch gets through afterwards", async () => {
    const t = scripted((name) => (name === "look" ? `Screen 1x1 pt\nApp: ${OTHER_APP}` : "Done."));
    const g = guardApp(t, LAB_APP);
    await expect(g.call("look", {})).rejects.toBeInstanceOf(LeftLabError);
    await expect(g.call("tap", { target: { id: "lab-reset" } })).rejects.toBeInstanceOf(LeftLabError);
    expect(t.calls).toEqual(["look"]);
    // Reading still works (open_url is how a person or agent gets back).
    await expect(g.call("open_url", { url: "x://lab" })).resolves.toMatchObject({ text: "Done." });
  });

  it("never names the other app in its message", async () => {
    const t = scripted(() => `Screen 1x1 pt\nApp: ${OTHER_APP}`);
    const e: unknown = await guardApp(t, LAB_APP).call("look", {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LeftLabError);
    expect(String(e)).not.toContain("Other");
  });

  it("confirms the app after a refused touch", async () => {
    const t = scripted((name) =>
      name === "tap" ? "Error not_found: no lab-save" : `Screen 1x1 pt\nApp: ${OTHER_APP}`,
    );
    await expect(guardApp(t, LAB_APP).call("tap", { target: { id: "lab-save" } })).rejects.toBeInstanceOf(
      LeftLabError,
    );
    expect(t.calls).toEqual(["tap", "look"]);
  });

  it("stops on in_background", async () => {
    const t = scripted(() => "Error in_background: the app is in the background");
    await expect(guardApp(t, LAB_APP).call("look", {})).rejects.toBeInstanceOf(LeftLabError);
  });

  describe("iOS's own UI over the lab (a banner)", () => {
    const HOME = "Home screen (com.apple.springboard)";
    const noSleep = (): Promise<void> => Promise.resolve();

    it("knows iOS's own UI by the Home screen's bundle id", () => {
      expect(isSystemUi(HOME)).toBe(true);
      expect(isSystemUi(LAB_APP)).toBe(false);
      expect(isSystemUi("Springboard Fan Club (com.example.springboard)")).toBe(false);
    });

    it("looks until the lab is back, touches nothing meanwhile, and marks the answer", async () => {
      let banner = 3; // the next three answers show the banner
      const t = scripted((name) => {
        const app = banner > 0 ? HOME : LAB_APP;
        if (banner > 0) banner--;
        return name === "look" ? `Screen 1x1 pt\nApp: ${app}` : `Scrolled.\nApp: ${app}`;
      });
      const g = guardApp(t, LAB_APP, { sleep: noSleep });
      const r = await g.call("scroll", { target: { id: "lab-scroll" } });
      expect(r.interrupted).toBeDefined();
      expect(r.text).toContain("Scrolled.");
      expect(t.calls).toEqual(["scroll", "look", "look", "look"]); // two looks still on the banner, then the lab
      const next = await g.call("tap", { target: { id: "lab-taps" } });
      expect(next.interrupted).toBeUndefined();
    });

    it("gives a fresh look in place of one that named iOS's UI", async () => {
      let banner = 1;
      const t = scripted(() => `Screen 1x1 pt\nApp: ${banner-- > 0 ? HOME : LAB_APP}\ne1 button id=lab-taps`);
      const r = await guardApp(t, LAB_APP, { sleep: noSleep }).call("look", {});
      expect(appOf(r.text)).toBe(LAB_APP);
      expect(r.interrupted).toBeDefined();
    });

    it("stops after waitMs, naming the step, and touches nothing more", async () => {
      const t = scripted(() => `Screen 1x1 pt\nApp: ${HOME}`);
      const g = guardApp(t, LAB_APP, { sleep: noSleep, waitMs: 2000, pollMs: 500 });
      g.setStep("S1.scroll[7]");
      const e: unknown = await g.call("look", {}).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LeftLabError);
      expect(String(e)).toContain("at S1.scroll[7], the answer to look");
      expect(String(e)).toContain("stayed in front for 2 s");
      expect(t.calls).toEqual(["look", "look", "look", "look", "look"]);
      await expect(g.call("tap", { target: { id: "lab-taps" } })).rejects.toBeInstanceOf(LeftLabError);
    });

    it("stops at once when another app follows iOS's UI", async () => {
      let n = 0;
      const t = scripted(() => `Screen 1x1 pt\nApp: ${n++ === 0 ? HOME : OTHER_APP}`);
      const e: unknown = await guardApp(t, LAB_APP, { sleep: noSleep }).call("look", {}).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LeftLabError);
      expect(String(e)).toContain("then a look named another app");
      expect(String(e)).not.toContain("Other");
    });

    it("waits before a blind touch too, and sends it once the lab is back", async () => {
      let banner = 1;
      const t = scripted((name) =>
        name === "look" ? `Screen 1x1 pt\nApp: ${banner-- > 0 ? HOME : LAB_APP}` : "Tapped.",
      );
      const r = await guardApp(t, LAB_APP, { sleep: noSleep }).call("tap", { target: { text: "OK" } });
      expect(t.calls).toEqual(["look", "look", "tap"]);
      expect(r.interrupted).toBeUndefined(); // the touch itself ran on the lab
    });

    it("the speed suite leaves out a sample whose answer named iOS's UI", async () => {
      const lab = new FakeLab({ alertTool: true });
      const inner = lab.tool();
      let scrolls = 0;
      const tool: ToolSession = {
        ...inner,
        async call(name, args) {
          const r = await inner.call(name, args);
          // The third of S1.scroll's samples (the lab's resets scroll with `to` instead of `amount`).
          if (name === "scroll" && args.amount === 0.5 && ++scrolls === 3) return { ...r, text: `${r.text}\nApp: ${HOME}` };
          return r;
        },
      };
      const rows = await runSpeed(guardApp(tool, LAB_APP, { sleep: noSleep }), {
        samples: 4,
        link: "good",
        pauseMs: 0,
        sleep: noSleep,
      });
      const scroll = rows.find((r) => r.id === "S1.scroll");
      expect(scroll?.samples).toBe(3);
      expect(scroll?.notes).toContain("1 sample(s) left out: iOS's own UI was in front");
    });
  });

  it("names the step in its stop message", async () => {
    const t = scripted(() => `Screen 1x1 pt\nApp: ${OTHER_APP}`);
    const g = guardApp(t, LAB_APP);
    g.setStep('run 2 R3 "Covered refused"');
    const e: unknown = await g.call("look", {}).catch((x: unknown) => x);
    expect(String(e)).toContain('at run 2 R3 "Covered refused", the answer to look names another app');
  });

  it("checks the look before a viewer tap", () => {
    expect(() => checkBeforeViewerTap(LAB_APP, `App: ${LAB_APP}`)).not.toThrow();
    expect(() => checkBeforeViewerTap(LAB_APP, `App: ${OTHER_APP}`)).toThrow(LeftLabError);
    expect(() => checkBeforeViewerTap(LAB_APP, "Screen 1x1 pt")).toThrow(/no App: line/);
    expect(() => checkBeforeViewerTap(undefined, "Screen 1x1 pt")).not.toThrow();
  });
});

describe("the suite with the guard", () => {
  it("never taps behind a share sheet the tool doesn't see", async () => {
    const lab = new FakeLab({ alertTool: true, bugs: { shareTouchThrough: true } });
    const rows = await runReliability(guardApp(lab.tool(), LAB_APP), { runs: 1, link: "good", idleMs: 30 });
    const r3 = rows.find((r) => r.id === "R3");
    expect(r3).toMatchObject({ misses: 1, pass: false });
    expect(r3 && "notes" in r3 ? r3.notes : "").toContain("the runner sent no tap");
    expect(lab.foreground).toBe(LAB_APP);
  }, 60_000);

  it("stops the run, and touches nothing more, once the phone is in another app", async () => {
    const lab = new FakeLab({ alertTool: true });
    const inner = lab.tool();
    let flippedAt = -1;
    const tool: ToolSession = {
      ...inner,
      async call(name, args) {
        const r = await inner.call(name, args);
        if (name === "tap" && flippedAt < 0 && lab.taps === 1) {
          lab.foreground = OTHER_APP;
          flippedAt = lab.calls.length;
        }
        return r;
      },
    };
    await expect(
      runReliability(guardApp(tool, LAB_APP), { runs: 1, link: "good", idleMs: 30 }),
    ).rejects.toBeInstanceOf(LeftLabError);
    expect(flippedAt).toBeGreaterThan(0);
    const after = lab.calls.slice(flippedAt);
    expect(after.filter((n) => TOUCHES.has(n))).toEqual([]);
  }, 60_000);
});
