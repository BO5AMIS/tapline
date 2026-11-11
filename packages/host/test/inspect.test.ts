import { describe, expect, it } from "vitest";
import { formatInspect, projectRoot, shownPath, sourceLine, type FileAccess } from "../src/inspect.js";

// `inspect`: from the screen to the code. The host shows the path relative to the app's project and the
// source line when the file is on this computer.

const SEP = process.platform === "win32" ? "\\" : "/";
const p = (...parts: string[]): string => (process.platform === "win32" ? "C:\\" : "/") + parts.join(SEP);

function fakeFiles(files: Record<string, string>): FileAccess {
  return { exists: (path) => path in files, read: (path) => files[path] ?? "" };
}

const APP = p("dev", "trip-demo");
const SCREEN = p("dev", "trip-demo", "src", "screens", "SignUpScreen.tsx");
const files = fakeFiles({
  [p("dev", "trip-demo", "package.json")]: "{}",
  [p("dev", "trip-demo", "node_modules", "react-native", "package.json")]: "{}",
  [SCREEN]: ["tabBarButtonTestID: 'tab-trips',", ...Array.from({ length: 117 }, () => ""), '        <Button label="Create account" testID="signup-submit" onPress={submit} />'].join("\n"),
});

describe("inspect", () => {
  it("finds the app's project from the nearest package.json outside node_modules", () => {
    expect(projectRoot(SCREEN, files)).toBe(APP);
    expect(shownPath(SCREEN, files)).toBe("src/screens/SignUpScreen.tsx");
  });

  it("never shows an absolute path, even without a project", () => {
    const loose = p("Users", "someone", "elsewhere", "a", "b.tsx");
    expect(shownPath(loose, fakeFiles({}))).toBe("elsewhere/a/b.tsx");
  });

  it("reads the line when the file is on this computer", () => {
    expect(sourceLine(SCREEN, 119, files)).toBe('<Button label="Create account" testID="signup-submit" onPress={submit} />');
    expect(sourceLine(p("nowhere.tsx"), 1, files)).toBeNull();
  });

  it("answers with the element, its components, where it was written and its props", () => {
    const text = formatInspect(
      {
        element: { ref: "e12", type: "Pressable", role: "button", testID: "signup-submit", label: null, text: "Create account", value: null, frame: { x: 24, y: 610, width: 382, height: 54 }, actions: ["press"], disabled: false, selected: false, checked: null },
        source: {
          components: ["SignUpScreen", "Button"],
          location: { file: SCREEN, line: 119, column: 9, component: "SignUpScreen" },
          props: { label: '"Create account"', testID: '"signup-submit"', onPress: "submit()" },
        },
      },
      files,
    );
    expect(text).toBe(
      [
        'e12 button "Create account" id=signup-submit @24,610 382x54',
        "Components: SignUpScreen \u203a Button",
        "Written at: src/screens/SignUpScreen.tsx:119 (in SignUpScreen)",
        '  119 | <Button label="Create account" testID="signup-submit" onPress={submit} />',
        'Props: label="Create account", testID="signup-submit", onPress=submit()',
      ].join("\n"),
    );
  });

  it("says when a library drew the element and the line is the app code around it", () => {
    const text = formatInspect(
      {
        element: { ref: "e24", text: "My trips", role: "button", testID: "tab-trips" },
        source: { components: ["Tabs"], location: { file: SCREEN, line: 119, column: 1, component: "Tabs", direct: false }, props: {} },
      },
      files,
    );
    expect(text).toContain("Drawn by a library, inside: src/screens/SignUpScreen.tsx:119 (in Tabs)");
    // the id literal the app wrote in that file (here only on line 1, as 'tab-trips')
    expect(text).toContain("Its id is set at: src/screens/SignUpScreen.tsx:1");
  });

  it("says plainly when the location is unknown", () => {
    const text = formatInspect(
      { element: { ref: "e1", text: "Hi", role: "text" }, source: { components: [], location: null, props: {} } },
      files,
    );
    expect(text).toContain("Written at: unknown");
  });
});

describe("inspect inside a shared component", () => {
  it("also names where the screen uses it, with that line", async () => {
    const { formatInspect } = await import("../src/inspect.js");
    const files = {
      exists: (path: string) => path.endsWith(".tsx") || path.split("\\").join("/") === "/proj/package.json",
      read: (path: string) =>
        path.endsWith("ui.tsx")
          ? Array.from({ length: 50 }, (_, i) => (i === 42 ? "<Pressable testID={`lab-${name}`} onPress={onPress}>" : "")).join("\n")
          : Array.from({ length: 120 }, (_, i) => (i === 111 ? '<LabButton name="save" title="Save" />' : "")).join("\n"),
    };
    const text = formatInspect(
      {
        element: { ref: "e7", role: "button", text: "Save", testID: "lab-save", frame: { x: 16, y: 329, width: 193, height: 48 } },
        source: {
          components: ["LabScreen", "LabButton"],
          location: { file: "/proj/app/ui.tsx", line: 43, column: 7, component: "LabButton", direct: true },
          usedAt: { file: "/proj/app/lab.tsx", line: 112, column: 9, component: "LabScreen" },
          props: {},
        },
      },
      files,
    );
    expect(text).toContain("Written at: app/ui.tsx:43 (in LabButton)");
    expect(text).toContain('Used at: app/lab.tsx:112 (in LabScreen)\n  112 | <LabButton name="save" title="Save" />');
  });
});
