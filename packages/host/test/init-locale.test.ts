import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit, type InstallRunner } from "../src/init.js";

const temps: string[] = [];

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tapline-init-locale-"));
  temps.push(dir);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

function snapshot(dir: string, base = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base === "" ? entry.name : `${base}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, snapshot(dir, rel));
    else out[rel] = readFileSync(join(dir, rel), "utf8");
  }
  return out;
}

const install: InstallRunner = () => 0;

const pkgWith = (extra: Record<string, string>): string =>
  JSON.stringify({ name: "demo", main: "index.js", dependencies: { expo: "~54.0.0", "react-native": "0.81.0", ...extra } }, null, 2);

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("tapline init: language and region commands", () => {
  it("writes working i18next stubs next to the entry file and imports them after the register line", () => {
    const dir = project({ "package.json": pkgWith({ i18next: "^25.0.0", "react-i18next": "^16.0.0" }), "index.js": "import './App';\n", "tsconfig.json": "{}\n" });
    const result = runInit({ project: dir }, { runInstall: install });
    expect(result.exitCode).toBe(0);
    const stub = readFileSync(join(dir, "tapline-locale.ts"), "utf8");
    expect(stub).toContain("import i18n from 'i18next';");
    expect(stub).toContain("await i18n.changeLanguage(language);");
    expect(stub).toContain("registerRegionCommand");
    expect(stub).toContain("process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1'");
    const entry = readFileSync(join(dir, "index.js"), "utf8");
    expect(entry.split("\n").slice(0, 2)).toEqual(["import 'react-native-tapline/register';", "import './tapline-locale';"]);
    expect(result.lines.join("\n")).toContain("tapline-locale.ts: created (language and region commands for i18next)");
  });

  it("writes an expo-localization stub that keeps the choice in a store, as plain JavaScript without tsconfig", () => {
    const dir = project({ "package.json": pkgWith({ "expo-localization": "~17.0.0" }), "index.js": "import './App';\n" });
    runInit({ project: dir }, { runInstall: install });
    const stub = readFileSync(join(dir, "tapline-locale.js"), "utf8");
    expect(stub).not.toContain("i18next");
    expect(stub).toContain("taplineLocale.language = language;");
    expect(stub).not.toContain(": {");
  });

  it("for an Expo Router app the new index.js imports the stub", () => {
    const dir = project({
      "package.json": JSON.stringify({ name: "demo", main: "expo-router/entry", dependencies: { expo: "~54.0.0", "expo-router": "~6.0.0", "react-native": "0.81.0", i18next: "^25.0.0" } }),
      "app/_layout.tsx": "export default function L() { return null; }\n",
    });
    runInit({ project: dir }, { runInstall: install });
    expect(readFileSync(join(dir, "index.js"), "utf8")).toContain("import './tapline-locale';");
    expect(existsSync(join(dir, "tapline-locale.js"))).toBe(true);
  });

  it("a dry run shows the stub and writes nothing", () => {
    const dir = project({ "package.json": pkgWith({ i18next: "^25.0.0" }), "index.js": "import './App';\n" });
    const before = snapshot(dir);
    const result = runInit({ project: dir, dryRun: true }, { runInstall: install });
    expect(result.lines.join("\n")).toContain("tapline-locale.js: would create (language and region commands for i18next)");
    expect(snapshot(dir)).toEqual(before);
  });

  it("does nothing about languages when neither library is present", () => {
    const dir = project({ "package.json": pkgWith({}), "index.js": "import './App';\n" });
    const result = runInit({ project: dir }, { runInstall: install });
    expect(existsSync(join(dir, "tapline-locale.js"))).toBe(false);
    expect(existsSync(join(dir, "tapline-locale.ts"))).toBe(false);
    expect(readFileSync(join(dir, "index.js"), "utf8")).not.toContain("tapline-locale");
    expect(result.lines.join("\n")).not.toContain("language");
  });

  it("runs again without changing anything", () => {
    const dir = project({ "package.json": pkgWith({ i18next: "^25.0.0" }), "index.js": "import './App';\n" });
    runInit({ project: dir }, { runInstall: install });
    const after = snapshot(dir);
    runInit({ project: dir }, { runInstall: install });
    expect(snapshot(dir)).toEqual(after);
  });

  it("prints what to add by hand when the entry file has no register line it can follow", () => {
    const dir = project({
      "package.json": pkgWith({ i18next: "^25.0.0" }),
      "index.js": "import 'react-native-tapline/register'; // first\nimport './App';\n",
    });
    const result = runInit({ project: dir }, { runInstall: install });
    expect(result.lines.join("\n")).toContain("registerLanguageCommand");
    expect(readFileSync(join(dir, "index.js"), "utf8")).not.toContain("tapline-locale");
  });
});
