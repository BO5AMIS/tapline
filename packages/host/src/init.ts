import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** `tapline init`: sets up the app side of Tapline in a React Native or Expo app, in one go. */

export const ENV_NAME = "EXPO_PUBLIC_TAPLINE_ENABLED";
export const PACKAGES = ["react-native-tapline", "expo-secure-store", "react-native-view-shot"] as const;

const REGISTER_LINE = "import 'react-native-tapline/register';";
const START_IMPORT = "import { startTapline } from 'react-native-tapline';";
const START_CALL = `startTapline({ enabled: process.env.${ENV_NAME} === '1' });`;
const METRO_REQUIRE = "const { withTapline } = require('react-native-tapline/metro');";
const METRO_FILE = "module.exports = withTapline(getDefaultConfig(__dirname));";
const NATIVE_INTENT = `import { isTaplineLink } from 'react-native-tapline';

export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  return isTaplineLink(path) ? null : path;
}
`;

/** The few file operations init needs, with paths relative to the project. Tests can swap it. */
export interface FileAccess {
  isFile(path: string): boolean;
  isDir(path: string): boolean;
  read(path: string): string;
  write(path: string, content: string): void;
}

export function diskAccess(root: string): FileAccess {
  const full = (path: string): string => join(root, path);
  return {
    isFile: (path) => existsSync(full(path)) && statSync(full(path)).isFile(),
    isDir: (path) => existsSync(full(path)) && statSync(full(path)).isDirectory(),
    read: (path) => readFileSync(full(path), "utf8"),
    write: (path, content) => {
      mkdirSync(dirname(full(path)), { recursive: true });
      writeFileSync(full(path), content);
    },
  };
}

export type StepAction = "create" | "edit" | "skip" | "advice" | "warn";

export interface InitStep {
  file: string;
  action: StepAction;
  /** For create and edit: what is in it (shown in brackets). For the others: the whole message. */
  detail: string;
  /** For create and edit: the whole new content of the file. */
  content?: string;
}

export interface InstallPlan {
  command: string;
  args: string[];
  packages: string[];
}

export interface InitPlan {
  steps: InitStep[];
  install: InstallPlan | undefined;
}

export class InitRefusal extends Error {}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function dependencyNames(pkg: Json): Set<string> {
  const names = new Set<string>();
  for (const key of ["dependencies", "devDependencies"]) {
    const group = asObject(pkg[key]);
    if (group !== undefined) for (const name of Object.keys(group)) names.add(name);
  }
  return names;
}

function eolOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** The offset just after the leading comments (and a shebang) of a source file: where new top lines go. */
function afterLeadingComments(text: string): number {
  let i = 0;
  let end = 0;
  for (;;) {
    while (i < text.length && /\s/.test(text[i] ?? "")) i++;
    if (text.startsWith("#!", i) || text.startsWith("//", i)) {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl + 1;
      end = i;
    } else if (text.startsWith("/*", i)) {
      const close = text.indexOf("*/", i + 2);
      if (close === -1) return end;
      const nl = text.indexOf("\n", close);
      i = nl === -1 ? text.length : nl + 1;
      end = i;
    } else {
      return end;
    }
  }
}

function insertAtTop(text: string, lines: string[]): string {
  const eol = eolOf(text);
  const at = afterLeadingComments(text);
  const before = text.slice(0, at);
  const needsBreak = before.length > 0 && !before.endsWith("\n") ? eol : "";
  return `${before}${needsBreak}${lines.join(eol)}${eol}${eol}${text.slice(at)}`;
}

/** True when `expression` has a semicolon outside brackets, strings and comments (more than one statement). */
function hasTopLevelSemicolon(expression: string): boolean {
  let depth = 0;
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i] ?? "";
    const next = expression[i + 1] ?? "";
    if (c === "/" && next === "/") {
      const nl = expression.indexOf("\n", i);
      if (nl === -1) return false;
      i = nl;
    } else if (c === "/" && next === "*") {
      const close = expression.indexOf("*/", i + 2);
      if (close === -1) return false;
      i = close + 1;
    } else if (c === "'" || c === '"' || c === "`") {
      i++;
      while (i < expression.length && expression[i] !== c) {
        if (expression[i] === "\\") i++;
        i++;
      }
    } else if ("([{".includes(c)) {
      depth++;
    } else if (")]}".includes(c)) {
      depth--;
    } else if (c === ";" && depth === 0) {
      return true;
    }
  }
  return false;
}

// --- the pieces -------------------------------------------------------------------------------------------

interface Context {
  files: FileAccess;
  pkg: Json;
  pkgText: string;
  deps: Set<string>;
  isExpo: boolean;
  isRouter: boolean;
}

const SOURCE_EXTENSIONS = ["", ".js", ".ts", ".tsx", ".jsx"];

function findFile(files: FileAccess, base: string): string | undefined {
  return SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`).find((path) => files.isFile(path));
}

function entrySteps(ctx: Context): InitStep[] {
  const { files } = ctx;
  const main = typeof ctx.pkg.main === "string" ? ctx.pkg.main : undefined;
  const wanted = [REGISTER_LINE, START_IMPORT, START_CALL];

  const missingLines = (text: string): string[] => {
    const lines: string[] = [];
    if (!text.includes("react-native-tapline/register")) lines.push(REGISTER_LINE);
    if (!text.includes("startTapline")) lines.push(START_IMPORT, START_CALL);
    return lines;
  };

  const steps: InitStep[] = [];
  let entryFile: string | undefined;
  let mainEdit = false;

  if (main === "expo-router/entry") {
    if (files.isFile("index.js")) {
      // An index.js that isn't Expo Router's entry is the app's own file for something else: leave main alone.
      if (!/expo-router\/entry/.test(files.read("index.js"))) {
        return [
          {
            file: "index.js",
            action: "advice",
            detail: `index.js exists but doesn't load expo-router/entry, so "main" stays as it is. Make an entry file that starts with the three Tapline lines (docs/setup.md, step 3), then import 'expo-router/entry', and set "main" to it.`,
          },
        ];
      }
      entryFile = "index.js";
      mainEdit = true;
    } else {
      const content = `${wanted.join("\n")}\nimport 'expo-router/entry';\n`;
      steps.push({ file: "index.js", action: "create", detail: "register, startTapline, then expo-router/entry", content });
      steps.push(mainStep(ctx, "expo-router/entry"));
      return steps;
    }
  } else if (main !== undefined) {
    // Only a file inside the project: never node_modules, never a path that climbs out of it.
    if (main.includes("node_modules") || main.split(/[\\/]/).includes("..") || main.startsWith("/") || !/^\.?\/?[\w@./-]+$/.test(main)) {
      return [
        {
          file: "package.json",
          action: "advice",
          detail: `"main" is ${main}, which Tapline can't edit. Make your own index.js that starts with the three Tapline lines (docs/setup.md, step 3) and set "main" to it.`,
        },
      ];
    }
    entryFile = findFile(files, main.replace(/^\.\//, ""));
    if (entryFile === undefined) {
      return [{ file: main, action: "advice", detail: `the entry file named in package.json ("${main}") wasn't found. Add the three Tapline lines at the top of your entry file.` }];
    }
  } else {
    entryFile = ["index.js", "index.ts", "index.tsx", "index.jsx"].find((path) => files.isFile(path));
    if (entryFile === undefined) {
      return [{ file: "package.json", action: "advice", detail: 'there is no "main" and no index file. Add the three Tapline lines at the top of your entry file.' }];
    }
  }

  const text = files.read(entryFile);
  const lines = missingLines(text);
  if (lines.length === 0) {
    steps.push({ file: entryFile, action: "skip", detail: "already starts Tapline" });
  } else {
    const detail =
      lines.length === wanted.length ? "added the register and startTapline lines at the top" : "added the missing Tapline lines at the top";
    steps.push({ file: entryFile, action: "edit", detail, content: insertAtTop(text, lines) });
  }
  if (mainEdit) steps.push(mainStep(ctx, "expo-router/entry"));
  return steps;
}

// --- language and region stubs ----------------------------------------------------------------------------

const LOCALE_IMPORT = "import './tapline-locale';";
const REGISTER_PATTERN = /^[ \t]*import\s+['"]react-native-tapline\/register['"];?[ \t]*\r?\n/m;

interface LocaleLibraries {
  i18next: boolean;
  expoLocalization: boolean;
}

/** The app's own localisation libraries init knows how to write working `language` and `region` commands for. */
function localeLibraries(ctx: Context): LocaleLibraries {
  return {
    i18next: ctx.deps.has("i18next") || ctx.deps.has("react-i18next"),
    expoLocalization: ctx.deps.has("expo-localization"),
  };
}

function localeStub(ts: boolean, libs: LocaleLibraries): string {
  const store = ts ? ": { language: string | undefined; region: string | undefined }" : "";
  const lines: string[] = [
    "// Tapline's standard app_command names `language` and `region` (tapline init wrote this file; edit freely).",
    "// They are only registered while Tapline is on, so a production build has none.",
    "import { registerLanguageCommand, registerRegionCommand } from 'react-native-tapline';",
  ];
  if (libs.i18next) lines.push("import i18n from 'i18next';");
  lines.push(
    "",
    `/** What an agent asked for with ${libs.i18next ? "`region`" : "`language` and `region`"}: read it where your app formats dates, numbers and prices. */`,
    `export const taplineLocale${store} = { language: undefined, region: undefined };`,
    "",
    `if (process.env.${ENV_NAME} === '1') {`,
  );
  if (libs.i18next) {
    lines.push("  registerLanguageCommand(async (language) => {", "    await i18n.changeLanguage(language);", "  });");
  } else {
    lines.push(
      "  // expo-localization reads the phone's setting and cannot change it: read taplineLocale.language first, e.g.",
      "  //   taplineLocale.language ?? getLocales()[0]?.languageCode",
      "  registerLanguageCommand((language) => {",
      "    taplineLocale.language = language;",
      "  });",
    );
  }
  lines.push("  registerRegionCommand((region) => {", "    taplineLocale.region = region;", "  });", "}", "");
  return lines.join("\n");
}

/**
 * When the app has i18next / react-i18next or expo-localization: a small file next to the entry file with working
 * `language` and `region` commands, imported right after the register line. Edits only a file it can edit safely.
 * `entry` is the entry file's step list; the import goes into its step.
 */
function localeSteps(ctx: Context, entry: InitStep[]): InitStep[] {
  const libs = localeLibraries(ctx);
  if (!libs.i18next && !libs.expoLocalization) return [];
  const index = entry.findIndex((step) => step.file !== "package.json" && (step.action === "create" || step.action === "edit" || step.action === "skip"));
  const target = index === -1 ? undefined : entry[index];
  const byHand = (why: string): InitStep[] => [
    {
      file: target?.file ?? "package.json",
      action: "advice",
      detail: `${why}. To let an agent switch language and region, call registerLanguageCommand and registerRegionCommand (from 'react-native-tapline') where your app starts${libs.i18next ? "; the language one calls i18n.changeLanguage(language)" : ""}`,
    },
  ];
  if (target === undefined) return byHand("the entry file can't be edited");

  const dir = target.file.includes("/") ? target.file.slice(0, target.file.lastIndexOf("/") + 1) : "";
  const existing = findFile(ctx.files, `${dir}tapline-locale`);
  const base = target.content ?? ctx.files.read(target.file);
  const steps: InitStep[] = [];
  if (existing !== undefined) {
    steps.push({ file: existing, action: "skip", detail: "already there" });
  } else {
    const ts = ctx.files.isFile("tsconfig.json");
    const names = [libs.i18next ? "i18next" : "", libs.expoLocalization ? "expo-localization" : ""].filter((n) => n !== "").join(" and ");
    steps.push({
      file: `${dir}tapline-locale.${ts ? "ts" : "js"}`,
      action: "create",
      detail: `language and region commands for ${names}`,
      content: localeStub(ts, libs),
    });
  }
  if (base.includes("tapline-locale")) return steps;
  const match = REGISTER_PATTERN.exec(base);
  if (match === null) return [...steps, ...byHand(`couldn't find the register line in ${target.file}`)];
  const at = match.index + match[0].length;
  const content = `${base.slice(0, at)}${LOCALE_IMPORT}${eolOf(base)}${base.slice(at)}`;
  // The entry's own step carries the import; a file that was left alone becomes an edit.
  entry[index] =
    target.action === "skip"
      ? { file: target.file, action: "edit", detail: "imported the language and region commands", content }
      : { ...target, detail: `${target.detail}, and the language and region commands`, content };
  return steps;
}

function mainStep(ctx: Context, from: string): InitStep {
  const pattern = new RegExp(`("main"\\s*:\\s*)"${from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"`);
  if (!pattern.test(ctx.pkgText)) {
    return { file: "package.json", action: "advice", detail: 'set "main" to "index.js"' };
  }
  return { file: "package.json", action: "edit", detail: 'main → index.js', content: ctx.pkgText.replace(pattern, '$1"index.js"') };
}

function metroSteps(ctx: Context): InitStep[] {
  const { files } = ctx;
  const existing = ["metro.config.js", "metro.config.cjs"].find((path) => files.isFile(path));
  if (existing === undefined) {
    if (!ctx.isExpo) {
      return [
        {
          file: "metro.config.js",
          action: "advice",
          detail:
            "this is bare React Native, so add the helper yourself: wrap your config, module.exports = withTapline(mergeConfig(getDefaultConfig(__dirname), config)), with const { withTapline } = require('react-native-tapline/metro');",
        },
      ];
    }
    const name = ctx.pkg.type === "module" ? "metro.config.cjs" : "metro.config.js";
    const content = `const { getDefaultConfig } = require('expo/metro-config');\n${METRO_REQUIRE}\n\n${METRO_FILE}\n`;
    return [{ file: name, action: "create", detail: "the withTapline helper", content }];
  }

  const text = files.read(existing);
  if (text.includes("withTapline")) return [{ file: existing, action: "skip", detail: "already has withTapline" }];

  const advice = (): InitStep[] => [
    {
      file: existing,
      action: "advice",
      detail: `add ${METRO_REQUIRE} and wrap what you export: module.exports = withTapline(<your config>);`,
    },
  ];
  const assignments = text.match(/module\.exports\s*=/g) ?? [];
  if (assignments.length !== 1 || /\bexport\s+default\b/.test(text)) return advice();
  const match = /module\.exports\s*=\s*/.exec(text);
  if (match === null) return advice();
  const expression = text.slice(match.index + match[0].length).trim().replace(/;\s*$/, "").trim();
  if (expression.length === 0 || hasTopLevelSemicolon(expression)) return advice();

  const eol = eolOf(text);
  const wrapped = `${text.slice(0, match.index)}module.exports = withTapline(${expression});${eol}`;
  return [{ file: existing, action: "edit", detail: "required the helper and wrapped the exported config in withTapline", content: insertAtTop(wrapped, [METRO_REQUIRE]) }];
}

function routesDir(files: FileAccess): string {
  if (files.isDir("app")) return "app";
  if (files.isDir("src/app")) return "src/app";
  return "app";
}

function nativeIntentSteps(ctx: Context): InitStep[] {
  if (!ctx.isRouter) return [];
  const dir = routesDir(ctx.files);
  const existing = ["ts", "tsx", "js", "jsx"].map((ext) => `${dir}/+native-intent.${ext}`).find((path) => ctx.files.isFile(path));
  if (existing === undefined) {
    return [{ file: `${dir}/+native-intent.ts`, action: "create", detail: "lets pairing links through", content: NATIVE_INTENT }];
  }
  if (ctx.files.read(existing).includes("isTaplineLink")) return [{ file: existing, action: "skip", detail: "already lets pairing links through" }];
  return [
    {
      file: existing,
      action: "advice",
      detail: "add import { isTaplineLink } from 'react-native-tapline'; and return null from redirectSystemPath when isTaplineLink(path) is true, before your own code",
    },
  ];
}

function envSteps(ctx: Context): InitStep[] {
  const { files } = ctx;
  const line = `${ENV_NAME}=1`;
  const steps: InitStep[] = [];
  if (!files.isFile(".env.local")) {
    steps.push({ file: ".env.local", action: "create", detail: `${line}, for local Metro`, content: `${line}\n` });
  } else {
    const text = files.read(".env.local");
    const found = new RegExp(`^\\s*${ENV_NAME}\\s*=\\s*(.*?)\\s*$`, "m").exec(text);
    if (found === null) {
      const eol = eolOf(text);
      const lead = text.length === 0 || text.endsWith("\n") ? "" : eol;
      steps.push({ file: ".env.local", action: "edit", detail: `added ${line}`, content: `${text}${lead}${line}${eol}` });
    } else if ((found[1] ?? "").replace(/^["']|["']$/g, "") === "1") {
      steps.push({ file: ".env.local", action: "skip", detail: `already has ${line}` });
    } else {
      steps.push({ file: ".env.local", action: "advice", detail: `${ENV_NAME} is set to something other than 1. Change it to 1 to test with Tapline` });
    }
  }
  const ignore = files.isFile(".gitignore") ? files.read(".gitignore") : "";
  const ignored = ignore.split(/\r?\n/).some((raw) => {
    const entry = raw.trim().replace(/^\//, "");
    return [".env.local", ".env*.local", ".env*", "*.local", ".env.*"].includes(entry);
  });
  if (!ignored) {
    steps.push({ file: ".gitignore", action: "advice", detail: "doesn't list .env.local. Add the line .env.local so it isn't committed" });
  }
  return steps;
}

function easSteps(ctx: Context): InitStep[] {
  const { files } = ctx;
  if (!files.isFile("eas.json")) return [];
  let build: Json | undefined;
  try {
    build = asObject(asObject(JSON.parse(files.read("eas.json")))?.build);
  } catch {
    return [{ file: "eas.json", action: "advice", detail: "couldn't be read as JSON, so its profiles weren't checked" }];
  }
  if (build === undefined) return [{ file: "eas.json", action: "skip", detail: "has no build profiles" }];
  const on: string[] = [];
  const off: string[] = [];
  for (const [name, value] of Object.entries(build)) {
    const profile = asObject(value);
    if (profile === undefined) continue;
    const setting = asObject(profile.env)?.[ENV_NAME];
    if (setting === undefined) off.push(name);
    else on.push(`${name} (${String(setting)})`);
  }
  const steps: InitStep[] = [];
  const production = asObject(build.production);
  const prodValue = asObject(production?.env)?.[ENV_NAME];
  if (prodValue !== undefined && String(prodValue) === "1") {
    steps.push({
      file: "eas.json",
      action: "warn",
      detail: `the production profile turns Tapline on - remove ${ENV_NAME} there`,
    });
  }
  if (on.length === 0) {
    steps.push({ file: "eas.json", action: "advice", detail: `no profile sets ${ENV_NAME}. Set it to "1" in env in the profiles you test with (development, testflight), never in production` });
  } else {
    steps.push({ file: "eas.json", action: "skip", detail: `profiles that set ${ENV_NAME}: ${on.join(", ")}${off.length > 0 ? `; not set in: ${off.join(", ")}` : ""}` });
  }
  return steps;
}

function installPlan(ctx: Context): InstallPlan | undefined {
  const packages = PACKAGES.filter((name) => !ctx.deps.has(name));
  if (packages.length === 0) return undefined;
  return ctx.isExpo
    ? { command: "npx", args: ["expo", "install", ...packages], packages }
    : { command: "npm", args: ["install", ...packages], packages };
}

/** Works out what init would do, without changing anything. Throws InitRefusal when this isn't an app. */
export function planInit(files: FileAccess): InitPlan {
  if (!files.isFile("package.json")) {
    throw new InitRefusal("There is no package.json here. Run this in your React Native or Expo app's folder, or pass --project <folder>.");
  }
  const pkgText = files.read("package.json");
  let pkg: Json | undefined;
  try {
    pkg = asObject(JSON.parse(pkgText));
  } catch {
    pkg = undefined;
  }
  if (pkg === undefined) throw new InitRefusal("package.json can't be read as JSON. Fix it and run this again.");
  const deps = dependencyNames(pkg);
  if (!deps.has("react-native") && !deps.has("expo")) {
    throw new InitRefusal("This doesn't look like a React Native or Expo app: package.json lists neither react-native nor expo.");
  }
  const isExpo = deps.has("expo");
  const isRouter = pkg.main === "expo-router/entry" || deps.has("expo-router");
  const ctx: Context = { files, pkg, pkgText, deps, isExpo, isRouter };
  const entry = entrySteps(ctx);
  const locale = localeSteps(ctx, entry);
  return {
    steps: [...entry, ...locale, ...metroSteps(ctx), ...nativeIntentSteps(ctx), ...envSteps(ctx), ...easSteps(ctx)],
    install: installPlan(ctx),
  };
}

/** Writes the files of a plan. Returns the files it wrote. */
export function applyInit(plan: InitPlan, files: FileAccess): string[] {
  const written: string[] = [];
  for (const step of plan.steps) {
    if ((step.action === "create" || step.action === "edit") && step.content !== undefined) {
      files.write(step.file, step.content);
      written.push(step.file);
    }
  }
  return written;
}

export type InstallRunner = (command: string, args: string[], cwd: string) => number;

export const runInstallCommand: InstallRunner = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error !== undefined) throw result.error;
  return result.status ?? 1;
};

export interface InitOptions {
  project?: string;
  dryRun?: boolean;
  /** False for --no-install. */
  install?: boolean;
}

export interface InitDeps {
  /** Runs the package install (tests pass a fake, so npm never runs). */
  runInstall?: InstallRunner;
  /** File access (tests); defaults to the project folder on disk. */
  files?: FileAccess;
  /** Prints a line as soon as it is known (so install output comes after the file lines). */
  print?: (line: string) => void;
}

export interface InitResult {
  exitCode: 0 | 1 | 2;
  lines: string[];
  changed: boolean;
}

const ICONS: Record<StepAction, string> = { create: "✓", edit: "✓", skip: "•", advice: "!", warn: "!" };

export function formatStep(step: InitStep, dryRun: boolean): string {
  const icon = ICONS[step.action];
  const bracket = step.detail.length > 0 ? ` (${step.detail})` : "";
  switch (step.action) {
    case "create":
      return `${icon} ${step.file}: ${dryRun ? "would create" : "created"}${bracket}`;
    case "edit":
      return `${icon} ${step.file}: ${dryRun ? "would edit" : "edited"}${bracket}`;
    case "warn":
      return `${icon} WARNING ${step.file}: ${step.detail}`;
    default:
      return `${icon} ${step.file}: ${step.detail}`;
  }
}

const NEXT_STEPS = [
  "",
  "Next steps:",
  "New native packages: make a new development build (eas build --profile development), then ask your agent to call pair. A development build loaded from this computer asks to connect by itself; tap Connect.",
];

/** The whole command. Exit 0 on success, 1 when this isn't an app, 2 on an unexpected error. */
export function runInit(options: InitOptions = {}, deps: InitDeps = {}): InitResult {
  const dir = resolve(options.project ?? ".");
  const dryRun = options.dryRun === true;
  const lines: string[] = [];
  const emit = (line: string): void => {
    lines.push(line);
    deps.print?.(line);
  };
  try {
    if (!(existsSync(dir) && statSync(dir).isDirectory())) {
      throw new InitRefusal(`${dir} is not a folder. Pass your app's folder to --project.`);
    }
    const files = deps.files ?? diskAccess(dir);
    const plan = planInit(files);
    if (dryRun) emit("Dry run: nothing will be changed.");
    for (const step of plan.steps) emit(formatStep(step, dryRun));

    let changed = plan.steps.some((s) => s.action === "create" || s.action === "edit");
    if (!dryRun) applyInit(plan, files);

    if (plan.install !== undefined) {
      const text = [plan.install.command, ...plan.install.args].join(" ");
      if (dryRun) {
        emit(`• packages: would run ${text}`);
        changed = true;
      } else if (options.install === false) {
        emit(`! packages: not installed. Run this yourself: ${text}`);
        changed = true;
      } else {
        emit(`• packages: running ${text}`);
        const status = (deps.runInstall ?? runInstallCommand)(plan.install.command, plan.install.args, dir);
        if (status !== 0) {
          emit(`! packages: the install failed (exit ${status}). The file changes above are done. Run this yourself: ${text}`);
          return { exitCode: 2, lines, changed: true };
        }
        emit(`✓ packages: installed ${plan.install.packages.join(", ")}`);
        changed = true;
      }
    } else {
      emit("• packages: already installed");
    }

    if (changed) for (const line of NEXT_STEPS) emit(line);
    else emit("\nNothing to change. Tapline is already set up here.");
    return { exitCode: 0, lines, changed };
  } catch (error) {
    if (error instanceof InitRefusal) {
      emit(error.message);
      return { exitCode: 1, lines, changed: false };
    }
    emit(`tapline init stopped: ${error instanceof Error ? error.message : String(error)}`);
    return { exitCode: 2, lines, changed: false };
  }
}
