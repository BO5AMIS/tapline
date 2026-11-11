import { describe, expect, it } from "vitest";
import { agentKind, captionFor, personKind } from "../src/captions.js";

describe("action kinds (VIEWER-PROTOCOL 1.4)", () => {
  it("names an agent's step by its AGENT-TOOLS tool, not the app's method", () => {
    const pairs: Array<[string, string]> = [
      ["press", "tap"],
      ["longPress", "long_press"],
      ["type", "type_text"],
      ["scroll", "scroll"],
      ["swipe", "swipe"],
      ["toggle", "toggle"],
      ["back", "back"],
      ["openURL", "open_url"],
      ["waitFor", "wait_for"],
      ["command", "app_command"],
      ["reload", "reload"],
    ];
    for (const [method, kind] of pairs) expect(agentKind(method), method).toBe(kind);
    expect(agentKind("somethingNew")).toBe("somethingNew");
  });

  it("names a person's input by the viewer's input names", () => {
    expect(personKind({ type: "gesture", points: [[0, 0.5, 0.5]] }, "press")).toBe("tap");
    expect(personKind({ type: "gesture", points: [[0, 0.5, 0.5]] }, "longPress")).toBe("longPress");
    expect(personKind({ type: "gesture", points: [[0, 0.5, 0.5]] }, "swipe")).toBe("drag");
    expect(personKind({ type: "gesture", points: [[0, 0.5, 0.5]] }, "scroll")).toBe("scroll");
    expect(personKind({ type: "scroll", x: 0.5, y: 0.5, dx: 0, dy: 10 }, "scroll")).toBe("scroll");
    expect(personKind({ type: "text", text: "secret" }, "type")).toBe("text");
    expect(personKind({ type: "key", key: "enter" }, "type")).toBe("enter");
    expect(personKind({ type: "key", key: "backspace" }, "type")).toBe("backspace");
  });
});

describe("captions for the agent's steps", () => {
  it("says each step as a person would, from the table", () => {
    expect(captionFor("tap", "Sign up")).toBe('Tap "Sign up"');
    expect(captionFor("tap")).toBe("Tap");
    expect(captionFor("long_press", "Kyoto")).toBe('Press and hold "Kyoto"');
    expect(captionFor("type_text", "Email")).toBe('Type into "Email"');
    expect(captionFor("type_text")).toBe("Type");
    expect(captionFor("swipe", "Sheet")).toBe("Swipe");
    expect(captionFor("back")).toBe("Go back");
    expect(captionFor("reload")).toBe("Reload the app");
    expect(captionFor("some_new_tool")).toBe("some new tool");
  });

  it("names the scroll's direction when the step gave one", () => {
    expect(captionFor("scroll", "List", { direction: "down" })).toBe("Scroll down");
    expect(captionFor("scroll", "List", { direction: "sideways" })).toBe("Scroll");
    expect(captionFor("scroll")).toBe("Scroll");
  });

  it("says on or off for a switch when the step set a value", () => {
    expect(captionFor("toggle", "Remind me", { value: true })).toBe('Turn on "Remind me"');
    expect(captionFor("toggle", "Remind me", { value: false })).toBe('Turn off "Remind me"');
    expect(captionFor("toggle", "Remind me")).toBe('Switch "Remind me"');
  });

  it("puts app commands in plain words where it knows them", () => {
    expect(captionFor("app_command", "appearance", { name: "appearance", args: { scheme: "dark" } })).toBe("Switch to dark mode");
    expect(captionFor("app_command", "appearance", { name: "appearance", args: { scheme: "light" } })).toBe("Switch to light mode");
    expect(captionFor("app_command", "sampleTrips", { name: "sampleTrips" })).toBe('Run "sampleTrips"');
  });

  it("never carries typed text, a link's address, or the wait steps", () => {
    expect(captionFor("type_text", "Password", { text: "hunter2" })).toBe('Type into "Password"');
    expect(captionFor("open_url", undefined, { url: "myapp://tapline/pair?code=secret" })).toBe("Open link");
    expect(captionFor("wait_for", "Done")).toBeUndefined();
  });

  it("cuts an element's name after 24 characters with an ellipsis, and stays within 60", () => {
    // 24 characters ("A very long button name "), the trailing space dropped, then the ellipsis.
    expect(captionFor("tap", "A very long button name that goes on")).toBe('Tap "A very long button name…"');
    const long = captionFor("long_press", "x".repeat(100)) ?? "";
    expect(long).toBe(`Press and hold "${"x".repeat(24)}…"`);
    expect(long.length).toBeLessThanOrEqual(60);
  });
});
