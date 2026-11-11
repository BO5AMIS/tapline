import { describe, expect, it } from "vitest";
import { junitXml, readScript, refStep, scriptSteps, toToolStep } from "../src/script.js";

// AGENT-TOOLS 1.8 §9.4: the shared script format, from Tapline's recorded calls.

describe("scripts", () => {
  it("turns the app's methods into tool steps, with id for testID", () => {
    expect(toToolStep({ method: "press", params: { target: { testID: "save", index: 1 } } })).toEqual({ tool: "tap", target: { id: "save", index: 1 } });
    expect(toToolStep({ method: "type", params: { target: { label: "Email" }, text: "a", replace: true, submit: false } })).toEqual({
      tool: "type_text",
      target: { label: "Email" },
      text: "a",
      replace: true,
      submit: false,
    });
    expect(toToolStep({ method: "waitFor", params: { testID: "done" } })).toEqual({ tool: "wait_for", id: "done" });
    expect(toToolStep({ method: "sleep", params: { seconds: 1 } })).toEqual({ tool: "wait", seconds: 1 });
    expect(toToolStep({ method: "command", params: { name: "resetApp" } })).toEqual({ tool: "app_command", name: "resetApp" });
    expect(toToolStep({ method: "tree", params: {} })).toBeNull();
  });

  it("folds a wait_for after an action into that step's expect, but not after a wait or another wait_for", () => {
    const steps = scriptSteps([
      { method: "press", params: { target: { testID: "save" } } },
      { method: "waitFor", params: { text: "Saved", timeout: 5 } },
      { method: "sleep", params: { seconds: 1 } },
      { method: "waitFor", params: { testID: "spinner", gone: true } },
      { method: "waitFor", params: { text: "Done", network_idle: true } },
    ]);
    expect(steps).toEqual([
      { tool: "tap", target: { id: "save" }, expect: { text: "Saved", timeout: 5 } },
      { tool: "wait", seconds: 1 },
      { tool: "wait_for", id: "spinner", gone: true },
      { tool: "wait_for", text: "Done", network_idle: true },
    ]);
  });

  it("reads the shared format and Tapline's format from before 1.1; anything else is null", () => {
    const shared = readScript(JSON.stringify({ format: "agent-tools-script", version: 1, name: "s", steps: [{ tool: "tap", target: { id: "a" } }] }));
    expect(shared?.steps).toEqual([{ tool: "tap", target: { id: "a" } }]);
    const legacy = readScript(
      JSON.stringify({ version: 1, name: "old", app: { name: "Demo", id: "com.demo" }, recordedAt: "x", steps: [{ method: "press", params: { target: { testID: "a" } } }] }),
    );
    expect(legacy).toMatchObject({ format: "agent-tools-script", name: "old", app: "com.demo", fresh: true, steps: [{ tool: "tap", target: { id: "a" } }] });
    expect(readScript("{}")).toBeNull();
    expect(readScript("not json")).toBeNull();
  });

  it("finds a ref step, which a script can't keep", () => {
    expect(refStep([{ tool: "tap", target: { id: "a" } }, { tool: "tap", target: { ref: "e3" } }])).toBe(1);
    expect(refStep([{ tool: "back" }])).toBeNull();
  });

  it("writes JUnit XML: one test case per script, the stop message as the failure, escaped", () => {
    const xml = junitXml([
      { name: "signup.json", seconds: 3.2, failure: null },
      { name: "checkout <b>", seconds: 1, failure: 'Error expect_failed: Ran 1 of 2 steps; stopped at step 2 (tap "Pay"): text "Paid" didn\'t appear within 2 s' },
    ]);
    expect(xml).toContain('<testsuites tests="2" failures="1" time="4.200">');
    expect(xml).toContain('<testcase classname="tapline" name="signup.json" time="3.200"/>');
    expect(xml).toContain('name="checkout &lt;b&gt;"');
    expect(xml).toContain('<failure message="Error expect_failed: Ran 1 of 2 steps; stopped at step 2 (tap &quot;Pay&quot;)');
  });
});
