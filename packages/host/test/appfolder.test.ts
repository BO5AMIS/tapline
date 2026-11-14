import { describe, expect, it } from "vitest";
import { appFolderName } from "../src/appfolder.js";
import { appFolderName as fromBugStore } from "../src/bugstore.js";

// The folder an app's bugs and explore runs live in, locally and on an export's qa-reports branch (AGENT-TOOLS 1.16.2 §29.7).

describe("appFolderName", () => {
  it("keeps an id that is already a safe folder name, so folders made by 1.8.5 still match", () => {
    for (const id of ["com.example.wayfare", "com.example.Wayfare-2", "demo_app", "a"]) expect(appFolderName(id)).toBe(id);
  });

  it("gives two different ids two different folders, also when cleaning them would make them equal", () => {
    const pairs: Array<[string, string]> = [
      ["com.example/a", "com.example_a"],
      ["com.example a", "com.example_a"],
      ["com.example/a", "com.example a"],
      ["com.app.", "com.app"],
      [".hidden", "_hidden"],
      ["", "unknown"],
    ];
    for (const [a, b] of pairs) expect(appFolderName(a)).not.toBe(appFolderName(b));
  });

  it("makes a name that is one plain path segment for any id", () => {
    for (const id of ["..", ".", "", "a/../../b", "a\\b", "con", "NUL.app", "com1.example", "x".repeat(300), "com.app.", "com.app ", "é.app"]) {
      const name = appFolderName(id);
      expect(name).toMatch(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/);
      expect(name).not.toMatch(/[. ]$/);
      expect(name.length).toBeLessThanOrEqual(100);
      expect(/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name)).toBe(false);
    }
  });

  it("an unsafe id's name starts with _ and never equals a kept id", () => {
    expect(appFolderName("com.example/a")).toMatch(/^_/);
    expect(appFolderName("_x")).toMatch(/^_x-[0-9a-f]{16}$/);
  });

  it("is the same function the bug store uses", () => {
    expect(fromBugStore("com.example/a")).toBe(appFolderName("com.example/a"));
  });
});
