import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInit, type InstallRunner } from "../src/init.js";

const temps: string[] = [];

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "tapline-init-"));
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

function fakeInstall(): { run: InstallRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: (command, args) => {
      calls.push([command, ...args].join(" "));
      return 0;
    },
  };
}

const routerPackage = JSON.stringify(
  { name: "demo", main: "expo-router/entry", dependencies: { expo: "~54.0.0", "expo-router": "~6.0.0", "react-native": "0.81.0" } },
  null,
  2,
);

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("tapline init", () => {
  it("(a) sets up a fresh Expo Router app", () => {
    const dir = project({ "package.json": routerPackage, "app/_layout.tsx": "export default function L() { return null; }\n", ".gitignore": ".env*.local\n" });
    const install = fakeInstall();
    const result = runInit({ project: dir }, { runInstall: install.run });
    expect(result.exitCode).toBe(0);
    expect(install.calls).toEqual(["npx expo install react-native-tapline expo-secure-store react-native-view-shot"]);
    expect(readFileSync(join(dir, "index.js"), "utf8")).toBe(
      "import 'react-native-tapline/register';\n" +
        "import { startTapline } from 'react-native-tapline';\n" +
        "startTapline({ enabled: process.env.EXPO_PUBLIC_TAPLINE_ENABLED === '1' });\n" +
        "import 'expo-router/entry';\n",
    );
    expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).main).toBe("index.js");
    expect(readFileSync(join(dir, "metro.config.js"), "utf8")).toContain("module.exports = withTapline(getDefaultConfig(__dirname));");
    expect(readFileSync(join(dir, "app/+native-intent.ts"), "utf8")).toContain("isTaplineLink(path) ? null : path");
    expect(readFileSync(join(dir, ".env.local"), "utf8")).toBe("EXPO_PUBLIC_TAPLINE_ENABLED=1\n");
    const text = result.lines.join("\n");
    expect(text).toContain("✓ index.js: created (register, startTapline, then expo-router/entry)");
    expect(text).toContain("package.json: edited (main → index.js)");
    expect(text).toContain("eas build --profile development");
    expect(text).not.toContain(".gitignore");
  });

  it("(b) puts the lines at the top of an existing entry file and makes no native intent", () => {
    const dir = project({
      "package.json": JSON.stringify({ main: "index.ts", dependencies: { expo: "~54.0.0", "react-native": "0.81.0", "@react-navigation/native": "7" } }),
      "index.ts": "// entry\nimport { registerRootComponent } from 'expo';\nimport App from './App';\n\nregisterRootComponent(App);\n",
      ".env": "API=1\n",
    });
    const result = runInit({ project: dir, install: false }, { runInstall: fakeInstall().run });
    expect(result.exitCode).toBe(0);
    const index = readFileSync(join(dir, "index.ts"), "utf8");
    expect(index.startsWith("// entry\nimport 'react-native-tapline/register';\nimport { startTapline } from 'react-native-tapline';\nstartTapline(")).toBe(true);
    expect(index).toContain("registerRootComponent(App);");
    expect(existsSync(join(dir, "metro.config.js"))).toBe(true);
    expect(existsSync(join(dir, "app"))).toBe(false);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("API=1\n");
    expect(result.lines.join("\n")).toContain("not installed. Run this yourself: npx expo install");
  });

  it("(c) running twice changes nothing the second time", () => {
    const dir = project({ "package.json": routerPackage, "app/_layout.tsx": "", ".gitignore": ".env.local\n" });
    runInit({ project: dir }, { runInstall: fakeInstall().run });
    // The fake install adds no packages, so add them as npm would.
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    pkg.dependencies = { ...pkg.dependencies, "react-native-tapline": "1.0.0", "expo-secure-store": "1", "react-native-view-shot": "1" };
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
    const before = snapshot(dir);
    const install = fakeInstall();
    const second = runInit({ project: dir }, { runInstall: install.run });
    expect(second.exitCode).toBe(0);
    expect(second.changed).toBe(false);
    expect(install.calls).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
    expect(second.lines.join("\n")).toContain("Nothing to change");
  });

  it("(d) wraps a simple metro config and only advises on a complex one", () => {
    const base = { "package.json": routerPackage, "app/_layout.tsx": "" };
    const simple = project({ ...base, "metro.config.js": "const { getDefaultConfig } = require('expo/metro-config');\n\nmodule.exports = getDefaultConfig(__dirname);\n" });
    runInit({ project: simple, install: false });
    const wrapped = readFileSync(join(simple, "metro.config.js"), "utf8");
    expect(wrapped).toContain("const { withTapline } = require('react-native-tapline/metro');");
    expect(wrapped).toContain("module.exports = withTapline(getDefaultConfig(__dirname));");

    const original = "const config = getDefaultConfig(__dirname);\nconfig.resolver.x = 1;\nmodule.exports = config;\nconsole.log('done');\n";
    const complex = project({ ...base, "metro.config.js": original });
    const result = runInit({ project: complex, install: false });
    expect(readFileSync(join(complex, "metro.config.js"), "utf8")).toBe(original);
    expect(result.lines.join("\n")).toContain("! metro.config.js: add const { withTapline }");
  });

  it("(e) warns when the production profile turns Tapline on", () => {
    const eas = {
      build: {
        development: { env: { EXPO_PUBLIC_TAPLINE_ENABLED: "1" } },
        production: { env: { EXPO_PUBLIC_TAPLINE_ENABLED: "1" } },
      },
    };
    const dir = project({ "package.json": routerPackage, "app/_layout.tsx": "", "eas.json": JSON.stringify(eas) });
    const result = runInit({ project: dir, install: false });
    const text = result.lines.join("\n");
    expect(text).toContain("! WARNING eas.json: the production profile turns Tapline on - remove EXPO_PUBLIC_TAPLINE_ENABLED there");
    expect(text).toContain("development (1)");
    expect(JSON.parse(readFileSync(join(dir, "eas.json"), "utf8"))).toEqual(eas);
  });

  it("(f) a dry run writes nothing and installs nothing", () => {
    const dir = project({ "package.json": routerPackage, "app/_layout.tsx": "" });
    const before = snapshot(dir);
    const install = fakeInstall();
    const result = runInit({ project: dir, dryRun: true }, { runInstall: install.run });
    expect(result.exitCode).toBe(0);
    expect(snapshot(dir)).toEqual(before);
    expect(install.calls).toEqual([]);
    const text = result.lines.join("\n");
    expect(text).toContain("would create (register, startTapline, then expo-router/entry)");
    expect(text).toContain("would run npx expo install");
  });

  it("(g) refuses a folder that is not a React Native app", () => {
    const none = runInit({ project: project({ "readme.md": "hi" }) });
    expect(none.exitCode).toBe(1);
    expect(none.lines.join("\n")).toContain("no package.json");
    const web = runInit({ project: project({ "package.json": JSON.stringify({ dependencies: { react: "19" } }) }) });
    expect(web.exitCode).toBe(1);
    expect(web.lines.join("\n")).toContain("neither react-native nor expo");
  });

  it("uses npm install and leaves metro to the user in a bare React Native app", () => {
    const dir = project({
      "package.json": JSON.stringify({ dependencies: { "react-native": "0.81.0" } }),
      "index.js": "import { AppRegistry } from 'react-native';\nAppRegistry.registerComponent('x', () => null);\n",
    });
    const install = fakeInstall();
    const result = runInit({ project: dir }, { runInstall: install.run });
    expect(install.calls).toEqual(["npm install react-native-tapline expo-secure-store react-native-view-shot"]);
    expect(existsSync(join(dir, "metro.config.js"))).toBe(false);
    expect(result.lines.join("\n")).toContain("! metro.config.js: this is bare React Native");
  });

  it("reports a failed install with exit 2", () => {
    const dir = project({ "package.json": routerPackage, "app/_layout.tsx": "" });
    const result = runInit({ project: dir }, { runInstall: () => 1 });
    expect(result.exitCode).toBe(2);
    expect(result.lines.join("\n")).toContain("the install failed");
  });

  it("advises when .env.local is not ignored and appends to an existing one", () => {
    const dir = project({ "package.json": routerPackage, "app/_layout.tsx": "", ".env.local": "A=1" });
    const result = runInit({ project: dir, install: false });
    expect(readFileSync(join(dir, ".env.local"), "utf8")).toBe("A=1\nEXPO_PUBLIC_TAPLINE_ENABLED=1\n");
    expect(result.lines.join("\n")).toContain("! .gitignore: doesn't list .env.local");
  });
});
