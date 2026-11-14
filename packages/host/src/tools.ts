import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toBuffer as qrPng } from "qrcode";
import { z } from "zod";
import { annotateScreenshot, type ShotImage } from "./annotate.js";
import type { ControlQueue, PhoneLease } from "./control.js";
import type { InputOutcome, OverlayRead, PersonInput, QualityPreset, Rect, ViewerAction } from "./viewer.js";
import { agentKind, captionFor, personKind, reasonOf } from "./captions.js";
import { clusterPercent, composeFilmstrip, diffImages, imageSize, type DiffBox, type DiffResult } from "./images.js";
import { briefLines, briefScreen } from "./brief.js";
import type { MapRoad } from "./mapfile.js";
import { LINK_NOT_SAVED, classifyMove, placeBefore, placeNameFromRoute, placeNow, placeSeen, type AppMap, type MapRegistry, type Place, type PlaceSource } from "./places.js";
import { NO_CHANGE_WATCH_MS, noChangeClause, noChangeNote, readPressFacts, saysNoVisibleChange, secondTapSentence, saysRequestsRunning, threwText, type NoChangeAction } from "./nochange.js";
import { alertNotes, alertSignature, changeParts, networkLine, describeElement, filterLogs, formatElement, formatLogAnswer, formatLogs, formatOffScreenAfterList, formatStatus, formatTree, logLevelOf, offScreenLine, roleOf } from "./format.js";
import { formatInspect, inspectResultSchema } from "./inspect.js";
import { AUDIT_TYPES, auditResultSchema, auditTitle, formatAudit } from "./audit.js";
import { NO_CRASH_TEXT, crashNote, disconnectNote, formatCrash } from "./crash.js";
import { ActionLog, loggedTarget, type ActionLogEntry } from "./actionlog.js";
import { readLogEntries, reportFor } from "./report.js";
import { ANIMATIONS_NOT_PAUSED_NOTE, ANIMATIONS_PAUSED_NOTE, afterPause, animationsOn, endAnimations, forgetAnimations, noteAnimations, withNormalAnimations } from "./animations.js";
import { mapArgsError, reflexSchema, reflexWords, runMap, type ReflexDo } from "./mapcmd.js";
import { MAX_REFLEX_FIRINGS, MAX_REFLEX_SKIPS, fireReflex, isReflexFailure, matchReflex, type ReflexVerdict } from "./reflexes.js";
import { driveArgsError, driveQuietly, planWay, startProblem, driveRoute, driveTo, guardOf, parseMoveResult, type DriveArgs, type DriveServices, type RouteServices, type TouchCall, type TouchOutcome } from "./drive.js";
import { mentionsVault, redactAll, redactContent, substituteAccount, type AccountsLoad, type TypedSource, type VaultUse } from "./accounts.js";
import {
  EYES,
  IDS_HIDDEN,
  Journey,
  DRIVE_ALLOWED,
  REFLEXES_ALLOWED,
  FAST_ANIMATIONS_ALLOWED,
  OPEN_URL,
  conditionsSchema,
  exportSchema,
  summaryLine,
  summaryNotes,
  stressSchema,
  survivesSchema,
  withoutIds,
  type ConditionRecord,
  type Conditions,
  type JourneyState,
  type Stress,
  type Survives,
} from "./journey.js";
import { JOURNEYS_KEPT, JourneyRecorder, findingsLine, freshFolder, pruneJourneys, screenSignature, writeReport, type FrameSource, type Touch } from "./journeyreport.js";
import { exportRefusal, exportReport, type Runner } from "./journeyexport.js";
import { randomBytes } from "node:crypto";
import { Confirmations, type OkVia } from "./confirm.js";
import { Dialogs, askDone, draftCaption, okCaption, plainText, type MomentOutcome } from "./elicit.js";
import type { AuditSink } from "./auditlog.js";
import { createOtpService, otpReference, type OtpFetch, type OtpService } from "./otpclient.js";
import { GrantBook, REACH_WORDS, elementNeverGrantable, grantCaption, grantNameBase, neverGrantable, reachesPeople, type GrantDecision, type GrantSpec } from "./grants.js";
import { DEFAULT_POLICY, UNREADABLE_LINK, asWords, elementKey, linkReadable, linkWords, listsFor, matchWord, type PolicyFile } from "./policy.js";
import { NO_UX_RULES, formatUxCheck, uxResultSchema, type UxJourneyHook, type UxRules } from "./uxcheck.js";
import { CONFIRM_ERROR, MediaState, mediaShape, runMedia } from "./media.js";
import { WIRE_TEXT_MAX, conditionsOf, holdsIn, waitParams } from "./conditions.js";
import { caseTwin, readScript, refStep, scriptSteps, sharedScriptSchema, type SharedScript } from "./script.js";
import { LOG_LINE_MAX, TYPED, cutText, firstLine, redactFinding, type Finding, type PathStep } from "./findings.js";
import { seenOf, type Seen } from "./seen.js";
import { type BugMade, BugGateError, BugStore, appFolderName, isBugId, type BugCheck, type BugCheckOptions } from "./bugstore.js";
import { CHECK_TOOLS, RUN_LIMIT_MS, VERIFY_DEFAULT, runCheck, stepsProblem, type CheckHost, type StepResult } from "./bugcheck.js";
import { bugTitle, cutDownLink, type BugFinding, type BugMeta } from "./bug.js";
import { exportBug, type BugExportTarget } from "./bugexport.js";
import { bugAnswer, makeBug, newestRun, observedFinding, readRunFinding, reproducedAnswer, shownPath, writablePath, type BugContext } from "./bugreport.js";

/** A bug just made, and whether its answer says why it wasn't checked. */
interface Built {
  made: BugMade;
  reasonShown: boolean;
}
const isBuilt = (value: Built | CallToolResult): value is Built => "made" in value && "reasonShown" in value && Array.isArray((value as { content?: unknown }).content) === false;
import { namedTarget } from "./signature.js";
import { EXPLORE_DEFAULTS, EXPLORE_LIMITS, EXPLORE_TOOL_VERSION, Explorer, crashFacts, errorLine, fixtureRef, isOutcome, type ExploreArgs, type ExploreFill, type ExploreHost, type ExploreMove, type ExploreOutcome, type MoveOutcome, type Since } from "./explore.js";
import { FLOOR_WORDS, exploreLists, protectedPlaceWord, screenTitles, exploreSettings, floorSubject, isListedSubmit, recipientVerdict, submitWord, type FloorHit, type FloorRules } from "./explorefloor.js";
import { analyse, parseBreak, runWithRepair, suggestionText, type RepairHost, type RepairRun } from "./repairrun.js";
import { repairMarkdown, repairPhrase, repairedScript, wireTarget } from "./repair.js";
import { answerLines, openRunFolder, writeExploreReport } from "./explorereport.js";
import { escapeParams, loadRoute, routePathOf, reachStart, routeRunner, routeScript, routeSlug, routeTyped, saveRoute, substituteSteps, variableProblem, type RouteContext } from "./routes.js";
import { badUnderKeys, checkUnder, formatPerfLines, perfFirstLine, perfResultSchema, type PerfMeasure, type PerfResult } from "./perf.js";
import {
  EXPECT_TIMEOUT_S,
  MAX_STEPS,
  RUN_TIMEOUT_MS,
  RUN_TOOLS,
  UNDER_KEYS,
  describeRunStep,
  expectFailure,
  ifSchema,
  parseError,
  skippedLine,
  stepNotes,
  stepSchema,
  type Expect,
  type RunTool,
  type Step,
} from "./run.js";
import { PAIR_CODE_TTL_MS, forgetLink, pairingLink } from "./pairing.js";
import {
  elementSchema,
  logEntrySchema,
  screenshotResultSchema,
  treeResultSchema,
  type LogEntry,
  type TreeElement,
  type TreeResult,
  type WireTarget,
} from "./protocol.js";
import { TaplineError, identityOf, type AppIdentity, type SessionInfo, type TaplineHost } from "./server.js";

// ---- input schemas ----------------------------------------------------------

export const targetSchema = z
  .object({
    ref: z.string().optional().describe('From your latest list, e.g. "e12"'),
    id: z.string().optional().describe("The testID, exact"),
    label: z.string().optional().describe("Accessibility label, exact"),
    text: z.string().optional().describe("Visible text: exact first, then part"),
    index: z.number().int().min(0).optional().describe("The Nth match of id, label or text (0-based)"),
    x: z.number().optional().describe("Points, with y"),
    y: z.number().optional().describe("Points, with x"),
  })
  .strict()
  .superRefine((value, ctx) => {
    const kinds = [
      value.ref !== undefined,
      value.id !== undefined,
      value.label !== undefined,
      value.text !== undefined,
      value.x !== undefined || value.y !== undefined,
    ].filter(Boolean).length;
    if (kinds !== 1) {
      ctx.addIssue({ code: "custom", message: "Give exactly one kind of target: {ref}, {id}, {label}, {text} or {x, y}." });
      return;
    }
    if ((value.x === undefined) !== (value.y === undefined)) {
      ctx.addIssue({ code: "custom", message: "A point target needs both x and y." });
    }
    if (value.index !== undefined && value.id === undefined && value.label === undefined && value.text === undefined) {
      ctx.addIssue({ code: "custom", message: "index works with id, label or text." });
    }
  });
export type Target = z.infer<typeof targetSchema>;

const rectSchema = z
  .object({
    x: z.number().describe("Points"),
    y: z.number().describe("Points"),
    width: z.number().positive().describe("Points"),
    height: z.number().positive().describe("Points"),
  })
  .strict();
const ignoreListSchema = z.array(z.union([rectSchema, targetSchema]));

const targetField = targetSchema.describe("Exactly one of ref, id, label, text or x and y");
const lookField = z
  .boolean()
  .optional()
  .describe("false: only the first line; the next answer's changes then cover this action too");

const screenshotField = z.boolean().optional().describe("Add a screenshot (default false)");

/** AGENT-TOOLS 1.13 §13.4. What it does is in the instructions' Answers list (TOOL-TEXT, core answers). */
const briefField = z.boolean().optional().describe("true: a short answer, as the instructions describe; false: the whole answer, also when the server runs with --brief");

/** A test account's name (AGENT-TOOLS 1.13 §18.6); in `run` it is the default for its steps. */
const accountField = z
  .string()
  .optional()
  .describe("A test account's name: the text is then `${account.username}` or `${account.password}` alone, typed by the tool (you never see the password). A password stays out of pictures only while its field is secure; a \"show password\" toggle shows it. The accounts file belongs outside the folders you may read");

const dryRunField = z
  .boolean()
  .optional()
  .describe("true: run every check and say what would happen; touch nothing");

/** `index` written beside `target` rather than in it: agents do that, and it means the same. */
const indexField = z.number().int().min(0).optional().describe("Same as target.index");

const forceField = z
  .boolean()
  .optional()
  .describe("Skip the reach checks (never disabled), only when you've decided a refusal is wrong");

export const toolShapes = {
  apps: {},
  open_app: { app: z.string().describe("The app's session id, app id or name, as apps lists them") },
  pair: {
    scheme: z
      .string()
      .optional()
      .describe(
        'The app\'s URL scheme ("scheme" in app.json or app.config), e.g. "myapp"; for an app running in Expo Go, the address Expo prints, e.g. "exp://192.168.1.20:8081"',
      ),
  },
  look: {
    screenshot: z.boolean().optional().describe("Include a screenshot (default true); false skips it"),
    width: z
      .number()
      .int()
      .min(160)
      .max(1320)
      .optional()
      .describe("Screenshot width in pixels, 160 to 1320 (default 600). Smaller costs fewer image tokens: 300 is enough to check a layout."),
    labels: z
      .boolean()
      .optional()
      .describe("Draw each actionable element's box and ref (e12) on the screenshot, so whoever views it can name elements by ref"),
  },
  check_layout: {},
  ux_check: {},
  audit: {
    types: z
      .array(z.enum(AUDIT_TYPES))
      .optional()
      .describe("Which checks to run (default all): contrast, hit_region, description, dynamic_type, clipped_text, trait, element_detection, overlap, duplicate_id"),
  },
  inspect: { target: targetField },
  tap: { target: targetField, index: indexField, force: forceField, dry_run: dryRunField, look: lookField, screenshot: screenshotField, brief: briefField },
  long_press: {
    target: targetField,
    index: indexField,
    seconds: z
      .number()
      .min(0.1)
      .max(10)
      .optional()
      .describe("How long to hold (default 1.0). Tapline calls the handler, so it doesn't wait"),
    force: forceField,
    dry_run: dryRunField,
    look: lookField,
    screenshot: screenshotField,
    brief: briefField,
  },
  type_text: {
    text: z.string().describe("Text to enter"),
    target: targetField.optional().describe("Input to type into; default: the focused input, else the only input on screen (else ambiguous; none at all is not_found)"),
    index: indexField,
    replace: z.boolean().optional().describe("Replace the current text (default true); false appends"),
    submit: z.boolean().optional().describe("Also submit (like pressing return) after typing (default false)"),
    account: accountField,
    as: z.string().optional().describe("While recording a route: save this text as the variable `${as}` (a name), which drive's `with` fills; the text typed now is not saved"),
    force: forceField,
    dry_run: dryRunField,
    look: lookField,
    screenshot: screenshotField,
    brief: briefField,
  },
  scroll: {
    direction: z.enum(["up", "down", "left", "right"]).optional().describe("Scroll direction (default down when no `to`)"),
    amount: z.number().min(0.1).max(1).optional().describe("How far: a share of the scroll area, 0.1 to 1 (default 0.8)"),
    to: z
      .enum(["start", "end", "target"])
      .optional()
      .describe('Instead of direction/amount: "start" or "end" jumps there; "target" scrolls until the `target` element is on screen, clear of the bars'),
    target: targetField
      .optional()
      .describe('Scroll view to scroll, or an element inside it; default: the largest one on screen. With to: "target", the element to bring onto the screen'),
    dry_run: dryRunField,
    look: lookField,
    screenshot: screenshotField,
    brief: briefField,
  },
  toggle: {
    target: targetField,
    index: indexField,
    value: z.boolean().optional().describe("Desired state; omit to flip"),
    force: forceField,
    dry_run: dryRunField,
    look: lookField,
    screenshot: screenshotField,
    brief: briefField,
  },
  open_url: {
    url: z.string().describe('URL or deep link to open, e.g. "myapp://settings"'),
    look: lookField,
    screenshot: screenshotField,
    brief: briefField,
  },
  back: { dry_run: dryRunField, look: lookField, screenshot: screenshotField, brief: briefField },
  swipe: {
    x0: z.number().describe("Where the finger starts, in points from the left"),
    y0: z.number().describe("Where the finger starts, in points from the top"),
    x1: z.number().describe("Where it lifts, in points from the left"),
    y1: z.number().describe("Where it lifts, in points from the top"),
    seconds: z.number().min(0.05).max(5).optional().describe("How long the drag takes (default 0.35)"),
    dry_run: dryRunField,
    look: lookField,
    screenshot: screenshotField,
    brief: briefField,
  },
  app_command: {
    name: z.string().optional().describe("The command to run; omit to list the app's commands and what they take"),
    args: z.record(z.string(), z.unknown()).optional().describe("Arguments, as the command's description says"),
    look: lookField,
    screenshot: screenshotField,
    brief: briefField,
  },
  compare_screen: {
    name: z.string().describe('A name for this screen\'s reference picture, e.g. "home" or "checkout-empty"'),
    update: z.boolean().optional().describe("Replace the saved reference with the screen as it is now"),
    width: z
      .number()
      .int()
      .min(160)
      .max(1320)
      .optional()
      .describe("Screenshot width in pixels, 160 to 1320 (default 600); keep it the same for a name"),
    threshold: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("The share of the screen, in percent, 0 to 100 (default 0.5), that may change and still match"),
    ignore: z
      .array(z.union([rectSchema, targetSchema]))
      .optional()
      .describe("Painted out on both pictures before comparing (a clock, an avatar): targets {id}, {label}, {text}, {ref}, or a rect {x, y, width, height} in points"),
  },
  filmstrip: {
    frames: z.number().int().min(2).max(9).optional().describe("How many frames (default 6)"),
    interval_ms: z.number().int().min(0).max(2000).optional().describe("Time between frames in ms (default 250)"),
    frame_width: z.number().int().min(100).max(400).optional().describe("Width of each frame in pixels (default 200)"),
    tap: targetField.optional().describe("Tap this first, then film what it sets off (an animation, a loading state)"),
  },
  viewer: {},
  record: {
    start: z.boolean().optional().describe("Start recording: every action that succeeds from now on becomes a step"),
    stop: z.boolean().optional().describe("Stop and save the script (to path, else to the scripts folder under name)"),
    name: z.string().optional().describe("The script's name: letters, digits, '.', '_' and '-'"),
    path: z.string().optional().describe("Where stop saves the script file (optional)"),
    route: z.string().optional().describe("Record a route for drive instead of a script: its name (letters, digits, '.', '_' and '-'). It starts from the place the app is at and is saved in the app's map folder"),
    action: z
      .enum(["start", "stop", "status", "discard"])
      .optional()
      .describe("Older form: start, stop, status or discard"),
  },
  replay: {
    name: z.string().optional().describe("A saved script's name; omit name and path to list saved scripts"),
    path: z.string().optional().describe("A script file to replay (the shared agent-tools-script format)"),
    repair: z
      .enum(["suggest", "apply"])
      .optional()
      .describe(
        "Self-repair (AGENT-TOOLS 1.15 §26). suggest: replay as usual and, at the first break that may be repaired, rank the candidates without touching any; writes nothing. apply: replay and repair as it goes (a real run); on a full pass it writes <script>.repaired.json and <script>.repair.md beside the original and never overwrites it. A person adopts a repaired script on the command line only.",
      ),
    look: lookField,
    screenshot: screenshotField,
  },
  wait_for: {
    text: z.string().optional().describe("Wait until this visible text is on screen (or gone)"),
    id: z.string().optional().describe("Wait until the element with this id is on screen (or gone)"),
    label: z.string().optional().describe("Wait until the element with this accessibility label is on screen (or gone)"),
    gone: z.boolean().optional().describe("Wait until it is gone instead, e.g. a spinner"),
    network_idle: z.boolean().optional().describe("Also (or only) wait until no network request is in flight"),
    timeout: z.number().min(0.5).max(30).optional().describe("Seconds to wait at most, 0.5 to 30 (default 10)"),
    look: lookField,
    screenshot: screenshotField,
    brief: briefField,
  },
  logs: {
    since: z.number().optional().describe("Only lines after this timestamp (epoch milliseconds)"),
    level: z.enum(["error", "warning", "info"]).optional().describe("That level and above (default info: everything)"),
    grep: z.string().optional().describe("Only lines containing this text (case-insensitive)"),
    limit: z.number().int().min(1).max(500).optional().describe("At most this many lines, the newest (1 to 500, default 100)"),
  },
  crash: {
    all: z.boolean().optional().describe("The last 5 crashes instead of only the newest"),
  },
  reload: { look: lookField },
  performance: {
    launch: z
      .boolean()
      .optional()
      .describe("true: reload the app's JavaScript and time it to the first settled screen (development builds only; not a cold start)"),
    seconds: z.number().min(0.5).max(30).optional().describe("Measure for this long, 0.5 to 30 seconds (default 3)"),
    tap: targetField.optional().describe("Tap this first, then measure what it sets off"),
  },
  wait: { seconds: z.number().min(0.1).max(30).describe("How long to wait, 0.1 to 30 seconds"), screenshot: screenshotField },
  media: mediaShape,
  session_report: {
    since: z.number().min(0).optional().describe("Epoch milliseconds: report only calls from then on (default: the start of this session)"),
  },
  map: {
    to: z.string().optional().describe("A place's name: the shortest known way to it, and whether each road is proven"),
    name: z.string().regex(/^[a-z0-9_]+$/).optional().describe("Names the current place: [a-z0-9_]"),
    link: z.string().optional().describe("The link that reaches a place, kept as given: a pattern (wayfare://trips/[id]), never a real id"),
    place: z.string().optional().describe("With link: the place (default the current one)"),
    reflex: reflexSchema.optional().describe("Adds a rule that runs one step when its moment comes: name, when (text, label or id), do (one step), max (1 to 3), at (a place)"),
    forget_reflex: z.string().optional().describe("Removes a reflex by name"),
    forget: z.string().optional().describe("Drops a place, with its roads, routes and reflexes"),
  },
  drive: {
    to: z.string().optional().describe("A place's name (map lists them)"),
    route: z.string().optional().describe("A saved route's name; exactly one of to or route"),
    with: z.record(z.string(), z.string()).optional().describe('Values for a link\'s params or a route\'s variables, like {"id": "42"}'),
    account: z.string().optional().describe("With route: a test account's name; the tool types its values, you never see the password"),
    then: z.array(stepSchema).optional().describe("run steps that go on after arriving, in the same call"),
    by: z.enum(["any", "taps", "link"]).optional().describe('"any" (default), "taps" (roads only, never a jump) or "link" (a jump only)'),
    look: lookField,
    brief: briefField,
    dry_run: dryRunField,
  },
  explore: {
    minutes: z.number().optional().describe("Time budget in minutes, 1 to 60 (default 10); time spent waiting for a person does not count"),
    steps: z.number().optional().describe("Budget of moves, 1 to 5000 (default 500): each touch, scroll, back and reset"),
    depth: z.number().optional().describe("How many places deep from the start it expands, 1 to 20 (default 8); a deeper place is saved, not expanded"),
    from: z.string().optional().describe("A place's name to start at; the tool drives there first (default: where the app is)"),
    focus: z.string().optional().describe("A place's name: it expands only places below it (default: the whole app)"),
    fill: z
      .union([z.enum(["none", "test-data"]), z.string().regex(/^fixture:[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/, 'fill is "none", "test-data" or "fixture:<name>.<field>"')])
      .optional()
      .describe("\"none\" (default) types nothing; \"test-data\" types only into fields the app marks as safe for tests; \"fixture:<name>.<field>\" does too, and gives a field marked only by its id the field of a vault fixture marked \"explore\": true"),
    continue: z.boolean().optional().describe("Go on after a crash, when the app can be opened again (default false: stop at the first crash)"),
    account: z.string().optional().describe("A vault account marked \"explore\": true in the vault file, for the way back after a reset"),
    guide: z.string().optional().describe("Reserved; only \"none\" is offered in this version"),
  },
  bug_report: {
    finding: z.string().optional().describe("A finding's id in the report of run (f3): makes a one-page bug report from it"),
    run: z.string().optional().describe("With finding: an explore report folder, or \"last\" (default): the newest explore report of this app"),
    from: z.enum(["now", "failure"]).optional().describe("\"failure\": the last failed replay or run of this session; \"now\": what you saw while driving, with note, built from the last touches of the action log"),
    note: z.string().optional().describe("With from \"now\": what is wrong, one line, at most 300 characters (required)"),
    expected: z.string().optional().describe("With from \"now\": what should have happened, one line, at most 300 characters"),
    verify: z.union([z.boolean(), z.number()]).optional().describe("How many reproduction runs from a fresh start, 1 to 10 (true: 3; a bug from a finding or a failed run is checked 3 times when you say nothing, false or 0: not at all). A step that needs a person stops the check; a `${typed}` value can only be given by a person at the command line"),
    reset: z.enum(["own", "app"]).optional().describe("With verify: \"own\" (default) reloads the app and keeps its data; \"app\" also runs the app's standard reset command, which clears its data"),
    account: z.string().optional().describe("With verify: a vault account marked \"explore\": true, for the way back after a reset"),
    bug: z.string().optional().describe("A bug id kept earlier (bug_7bc2e91c152d416e): shows it, or with with_picture adds its picture"),
    with_picture: z.boolean().optional().describe("true: a private picture may go into the bug's folder. Say so only when your user asked"),
    export: z
      .object({
        to: z.enum(["issue", "zip"]),
        repo: z.string().optional(),
        confirm: z.boolean().optional(),
        public: z.boolean().optional(),
        with_picture: z.boolean().optional(),
        path: z.string().optional(),
      })
      .optional()
      .describe("With bug: send it out of the bugs folder, to a GitHub issue ({to: \"issue\", repo, confirm: true, public?, with_picture?}: confirm only when your user asked) or a local zip ({to: \"zip\", with_picture?, path? (inside the bugs folder; default <bug id>.zip next to the bug)}); every file is checked again and each export is logged"),
  },
  journey: {
    start: z.boolean().optional().describe("Start a journey (needs goal); one journey at a time"),
    goal: z.string().min(1).max(300).optional().describe('What the user wants to do, e.g. "log breakfast by scanning its barcode"'),
    persona: z.string().max(500).optional().describe("Who is using the app: free text, or the name of an example persona"),
    conditions: conditionsSchema
      .optional()
      .describe("language, region, text_size, network: applied at the start, undone at the stop"),
    allow: z
      .array(z.string().min(1).max(60))
      .max(30)
      .optional()
      .describe('Shortcuts the journey may use: "open_url", the names of app commands, and "drive" (a drive may jump by link), "reflexes" and "fast_animations"'),
    eyes: z.enum(EYES).optional().describe('"user" (default): see the screen as a user does; "agent" turns that off for the rest of the journey'),
    stop: z.boolean().optional().describe("End the journey (needs reached)"),
    reached: z.boolean().optional().describe("With stop: whether the goal was reached"),
    why: z.string().max(1000).optional().describe("With stop: why, in a line"),
    export: exportSchema.optional().describe("With stop, only when your user asks: put the report in a GitHub PR or issue. Needs confirm: true; public: true for a public repository, fork: true for a PR from a fork"),
    stress: stressSchema.optional().describe("A real-world moment during the journey: network (with mode), double_tap (with target), relaunch (a reload in development builds), background or rotate (a person does them, then call again with done)"),
    survives: survivesSchema.optional().describe("With stress: what must still be there after, {text} or {goal_step}"),
    done: z.boolean().optional().describe("With stress: the person has done the moment you asked them to (background or rotate)"),
  },
  run: {
    steps: z
      .array(stepSchema)
      .min(1)
      .max(MAX_STEPS)
      .describe(
        'The steps, in order: each is a tool call as an object, {"tool": "tap", "target": {...}, "expect": {...}}. Tools: tap, long_press, type_text, scroll, toggle, back, swipe, open_url, wait, wait_for, app_command, compare_screen (checks, never saves), performance. expect (optional): one of text, id or label, with gone, value and timeout (seconds, default 2); or matches (a reference name, alone or with one of them) with threshold; on a performance step, under: limits such as {"launch_s": 2, "drops": 0, "fps_min": 50, "busy_ms": 200, "js_heap_mb": 80}.',
      ),
    trace: z.boolean().optional().describe("Also list each step that ran, one line each"),
    account: accountField,
    dry_run: z
      .boolean()
      .optional()
      .describe("Check every step's parameters and resolve step 1 (later steps depend on what it does), then touch nothing"),
    look: lookField,
    screenshot: screenshotField,
    brief: briefField,
  },
} as const;

type Shape<K extends keyof typeof toolShapes> = z.infer<z.ZodObject<(typeof toolShapes)[K]>>;

/** The arguments of one tool, as its schema describes them. */
export type ToolArgs<K extends keyof typeof toolShapes> = Shape<K>;

/**
 * The answer for a call that carries arguments the tool doesn't have (null when all are known). Zod strips unknown
 * keys silently, so `audit {labels: true}` would run and ignore `labels`; this says so instead. Every way in to a
 * tool (the MCP server, and through it the bench) goes through here; script steps are checked by `run` itself.
 */
export function unknownArgumentError(name: keyof typeof toolShapes, args: Record<string, unknown>): CallToolResult | null {
  const known = Object.keys(toolShapes[name]);
  const unknown = Object.keys(args).filter((key) => !known.includes(key));
  if (unknown.length === 0) return null;
  // AGENT-TOOLS 1.11 wording, shared with Tapwright: every unknown name in one sentence.
  const takes = known.length === 0 ? "it takes no arguments" : `it takes ${known.join(", ")}`;
  return fail(`Error bad_params: ${name} doesn't take ${unknown.join(", ")}; ${takes}.`);
}

// ---- compare_screen ---------------------------------------------------------

const DEFAULT_MATCH_THRESHOLD = 0.5;
const MAX_REGION_LINES = 8;

/** What `ignore` paints out: a target, or a rectangle in points. */
type IgnoreItem = Target | { x: number; y: number; width: number; height: number };

interface ReferenceOptions {
  /** The share of the screen, in percent, that may change and still match. */
  threshold: number;
  ignore: IgnoreItem[];
  width: number;
  /** Folders to look in for `<name>.jpg`, in order. */
  referencesDirs: string[];
}

type ReferenceCheck =
  | { kind: "missing"; shot: ShotImage }
  | { kind: "size"; message: string }
  | { kind: "error"; line: string }
  | { kind: "match"; percent: number; notes: string[]; threshold: number; names: string[] }
  | { kind: "differs"; percent: number; lines: string[]; reason: string; image: ShotImage; notes: string[] };

/** The first line of a match: today's, or with the clusters that changed under the threshold (1.13.1 item 2). */
function matchLine(name: string, check: { percent: number; threshold: number; names: string[] }): string {
  if (check.names.length === 0) return `Matches the reference "${name}": ${check.percent}% changed.`;
  return `Matches the reference "${name}" (${check.percent}% changed, under the ${check.threshold}% threshold): changed at ${check.names.join(", ")}`;
}

/** Changed clusters of this size or more are named under the threshold, in percent of the screen (1.13.1 item 2). */
const NAMED_CLUSTER_PERCENT = 0.1;

/** The smallest named elements under a box in points: a page-sized container overlaps every change. */
function elementsUnder(b: { x: number; y: number; width: number; height: number }, elements: TreeResult["elements"]): TreeResult["elements"] {
  return elements
    .filter((e) => e.frame && e.frame.x < b.x + b.width && e.frame.x + e.frame.width > b.x && e.frame.y < b.y + b.height && e.frame.y + e.frame.height > b.y)
    .filter((e) => (e.text ?? "") !== "" || (e.label ?? "") !== "" || (e.testID ?? "") !== "")
    .map((e) => ({ e, area: (e.frame?.width ?? 0) * (e.frame?.height ?? 0) }))
    .filter(({ area }) => area <= Math.max(b.width * b.height * 4, 2500))
    .sort((x, y) => x.area - y.area)
    .slice(0, 2)
    .map(({ e }) => e);
}

function describeIgnore(item: Target): string {
  if (item.id !== undefined) return `id=${item.id}`;
  if (item.label !== undefined) return `label ${JSON.stringify(item.label)}`;
  if (item.text !== undefined) return JSON.stringify(item.text);
  if (item.ref !== undefined) return item.ref;
  return `${String(item.x)},${String(item.y)}`;
}

/** The pixel rectangles to paint out for `ignore`, from a fresh element list; targets not on the screen give a note. */
/**
 * An element as a {label} target matches it: its accessibility label, else its text, as the app's SDK matches
 * (labelOf in the SDK). The ignore masks, recorded indexes and expectations use the same rule as the targets.
 */
function labelOfElement(e: { label?: string | null; text?: string | null }): string {
  return e.label ?? e.text ?? "";
}

function ignoreRects(
  ignore: IgnoreItem[],
  elements: TreeResult["elements"],
  scale: number,
  size: { width: number; height: number },
): { rects: DiffBox[]; notes: string[] } {
  const rects: DiffBox[] = [];
  const notes: string[] = [];
  const add = (x: number, y: number, width: number, height: number): void => {
    const x0 = Math.max(0, Math.floor(x * scale));
    const y0 = Math.max(0, Math.floor(y * scale));
    const x1 = Math.min(size.width, Math.ceil((x + width) * scale));
    const y1 = Math.min(size.height, Math.ceil((y + height) * scale));
    if (x1 > x0 && y1 > y0) rects.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
  };
  for (const item of ignore) {
    if ("width" in item) {
      add(item.x, item.y, item.width, item.height);
      continue;
    }
    let found: TreeResult["elements"] = [];
    if (item.ref !== undefined) found = elements.filter((e) => e.ref === item.ref);
    else if (item.id !== undefined) found = elements.filter((e) => e.testID === item.id);
    else if (item.label !== undefined) {
      const wanted = item.label.toLowerCase();
      found = elements.filter((e) => labelOfElement(e).toLowerCase() === wanted);
    } else if (item.text !== undefined) {
      const wanted = item.text.toLowerCase();
      found = elements.filter((e) => (e.text ?? "").toLowerCase() === wanted);
      if (found.length === 0) found = elements.filter((e) => wanted !== "" && (e.text ?? "").toLowerCase().includes(wanted));
    } else if (item.x !== undefined && item.y !== undefined) {
      const px = item.x;
      const py = item.y;
      found = elements
        .filter((e) => e.frame && px >= e.frame.x && px <= e.frame.x + e.frame.width && py >= e.frame.y && py <= e.frame.y + e.frame.height)
        .sort((a, b) => (a.frame?.width ?? 0) * (a.frame?.height ?? 0) - (b.frame?.width ?? 0) * (b.frame?.height ?? 0))
        .slice(0, 1);
    }
    found = found.filter((e) => e.frame !== undefined);
    if (item.index !== undefined) found = found.slice(item.index, item.index + 1);
    if (found.length === 0) notes.push(`ignore ${describeIgnore(item)} isn't on the screen; skipped.`);
    for (const e of found) if (e.frame) add(e.frame.x, e.frame.y, e.frame.width, e.frame.height);
  }
  return { rects, notes };
}

// ---- helpers ----------------------------------------------------------------

export interface ConnectInfo {
  /** Where apps reach this host, e.g. ws://100.64.0.1:7210/ */
  url: string;
  /** This computer's name, shown on the phone before it connects. */
  name: string;
}

export interface ToolsOptions {
  connect: ConnectInfo;
  /** The server's `--brief`: actions answer briefly unless a call says `brief: false` (AGENT-TOOLS 1.13 §13.4). `look` is never brief. */
  brief?: boolean;
  /**
   * Whether a phone has ever connected to this computer's host. When set, the first answer of the session says what
   * only a person can do (open the app, pair) if an app isn't connected: `Note: needs a person: …`, once.
   */
  pairedBefore?: () => boolean;
  /** Where the action log goes (AGENT-TOOLS 1.8 §12); none: no log. */
  logDir?: string;
  /** The agent's client id for the call log (the MCP client's name); read at each call, as it is known after initialize. */
  clientId?: () => string | undefined;
  /** The safety policy (AGENT-TOOLS 1.8 §11). Default: the built-in words; --no-policy passes empty lists. */
  policy?: PolicyFile;
  /** The policy file's grants (AGENT-TOOLS 1.14 §19): read again at every touch. None: no grants (the built-in policy has none). */
  grants?: GrantBook;
  /** The audit log (AGENT-TOOLS 1.14 §23): a person's OK or refusal is a line in it. It has no off switch; tests pass none. */
  audit?: AuditSink;
  /** The user's UX house rules (`--ux-rules FILE`, AGENT-TOOLS 1.12 §17.3). Default: none. */
  uxRules?: UxRules;
  /** The test accounts (`--accounts FILE`, AGENT-TOOLS 1.13 §18.6): loaded, or refused with the reason. Default: none. */
  accounts?: AccountsLoad;
  /**
   * One-time codes (`${otp.<app>}`, AGENT-TOOLS 1.14 §20.4): how a code is asked of Tapwright's daemon, and the codes' redaction. Share
   * `codes.redact` with the host's own redaction so a code is scrubbed from the app's answers too. Default: the real daemon.
   */
  otp?: OtpService;
  /** The apps' maps (AGENT-TOOLS 1.13 §18.9): places, roads and links grow as the agent drives. Default: none (no `Place:` line). */
  maps?: MapRegistry;
  /** Where a person's OK is asked for and given (the live viewer listens). Default: a fresh one. */
  confirmations?: Confirmations;
  /** False when nobody can answer a request (--viewer off). Default true. */
  canConfirm?: boolean;
  /** The host's dialog for a person's OK (AGENT-TOOLS 1.13 §11.3). Default: none, as when the client can't show one. */
  dialogs?: Dialogs;
  /** How long a needs-a-person moment waits for a person (AGENT-TOOLS 1.13 §11.5). Default 120 000 ms; tests set it low. */
  personWaitMs?: number;
  /** How often a moment checks whether it has cleared. Default 500 ms. */
  personPollMs?: number;
  /** After a person says Done, how long the app gets to show it (it connects within about 2 s). Default 4000 ms. */
  personDoneGraceMs?: number;
  /** Part of every OK's key: `mcp` for the agent's own MCP server (the default), `api` for thin calls, so the two never share an OK. */
  confirmScope?: string;
  /**
   * Where `pair` writes the development offer for the Metro helper (`~/.tapline/offers`), so a phone that can
   * only reach Metro (a firewall in the way of 7210-7219) still finds it. None: only the host's own endpoint.
   */
  offerDir?: string;
  /** Where `pair` also saves the QR code as a PNG (so the user can open it). */
  pairImagePath?: string;
  /** How long that PNG is kept. Default: the code's 10 minutes. */
  pairImageLifetimeMs?: number;
  /** How long `reload` waits for the app to come back. Default 20 000 ms. */
  reloadWaitMs?: number;
  /** Extra delay after a reload before looking. Default 1500 ms. */
  reloadSettleMs?: number;
  /** compare_screen waits for two pictures in a row to agree: the gap between them and the cap (ms; tests set them low). */
  stillGapMs?: number;
  stillCapMs?: number;
  /**
   * How `look` delivers screenshots: "inline" puts the image in the tool result; "file" saves it
   * and returns only its path, so a lead agent can hand it to a smaller model without seeing it.
   */
  screenshots?: "inline" | "file";
  /** Where file-mode screenshots go (required for "file"). */
  screenshotDir?: string;
  /** How many file-mode screenshots to keep; older ones are deleted. Default 50. */
  screenshotKeep?: number;
  /** Where `record` saves scripts and `replay` reads them (e.g. ~/.tapline/scripts). */
  scriptsDir?: string;
  /** Where `compare_screen` keeps reference pictures, one folder per app (e.g. ~/.tapline/baselines). */
  baselinesDir?: string;
  /** The live viewer's queue: agent actions wait for a person and stop while paused. */
  control?: ControlQueue;
  /** A scheduled run's hold on the phone (§22.3): while it stands, other agents' actions wait. */
  lease?: PhoneLease;
  /** Shows each agent action to people watching the live viewer. */
  onAction?: (action: ViewerAction) => void;
  /** The live viewer's links (with its token), for the `viewer` tool. */
  viewerLinks?: () => string[];
  /**
   * Opens the live view on this computer (the default browser). When set, `viewer` opens it and never
   * shows the agent the link: its key could approve a held-back touch. Unset (tests) or with
   * `viewerLinkToAgent`, the link is in the answer.
   */
  openViewer?: (link: string) => boolean;
  /** `--viewer-link`: give the agent the link (benchmarks and scripts that drive the viewer themselves). */
  viewerLinkToAgent?: boolean;
  /** Whether the app's frames are on and at which quality, for the `viewer` tool's stats. */
  viewerFeed?: () => { on: boolean; quality: QualityPreset };
  /** The clock a journey measures with, in ms (tests pass their own). Default: Date.now. */
  clock?: () => number;
  /** Waits this many ms (tests pass one that moves their clock). Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called when a journey stops (AGENT-TOOLS 1.12 §17.5), with its state: the report writer's hook. The lines it
   * returns follow the summary in the answer (`Findings: …`, `Report: <folder>`).
   */
  onJourneyStop?: (state: JourneyState) => string[] | Promise<string[]>;
  /**
   * Where journeys keep their report folders (e.g. ~/.tapline/journeys): each journey gets
   * `<yyyy-mm-dd-hhmm>-<slug>/` with its frames, and `stop` writes the report there. Unset: no frames, no report.
   */
  journeysDir?: string;
  /** Runs `gh` and `git` for `export` (AGENT-TOOLS 1.12 §17.5). Unset: export answers that it can't run. Tests pass a fake. */
  exportRunner?: Runner;
  /** Cap for the journey GIF in bytes (tests lower it; default 3 MB). */
  gifMaxBytes?: number;
  /** Where `explore` keeps its report folders (e.g. ~/.tapline/explore): `<app id>/<UTC time>/` (AGENT-TOOLS 1.15 §25.10). Unset: explore answers that it can't keep a report. */
  exploreDir?: string;
  /** Where `bug_report` keeps its bugs (e.g. ~/.tapline/bugs): `<app id>/<bug id>/` (AGENT-TOOLS 1.16 §29.2). Unset: bug_report answers that it can't keep one. */
  bugsDir?: string;
  /** The reproduction check (§29.4) replaced by a hook (tests). Unset: the tool's own check (bugcheck.ts). */
  bugCheck?: BugCheck;
  /** Wall-clock time in ms for the times in a finding and a report (tests pass their own). Default: Date.now. */
  wallClock?: () => number;
  /** How long `explore` waits for the app to be in front or connected again (a crash with `continue`, a move that left the app). Default 60 000 ms. */
  exploreGraceMs?: number;
}

/**
 * Under this many points from its first point, a pointer path is a tap or a hold, not a drag.
 * Tapwright uses the same number, and the viewer page's pending ring (TAP_SLOP in viewer.html)
 * follows it: change all three together.
 */
const TAP_SLOP = 10;
/** Held at least this long, a tap is a long press. */
const LONG_PRESS_MS = 500;

/** The requests whose call may be a road, or tell the map that text was typed (AGENT-TOOLS 1.13 §18.2). */
const ROAD_METHODS: ReadonlySet<string> = new Set(["press", "longPress", "toggle", "back", "openURL", "swipe", "type"]);

const SCRIPT_NAME = /^[A-Za-z0-9][\w.-]{0,60}$/;
/** The answer to a reference name that isn't one: no slashes, so no way out of the references folder. */
/** The names (file names without `extension`) in a folder; none when it isn't there. */
function stemsIn(dir: string, extension: string): string[] {
  try {
    return readdirSync(dir).filter((file) => file.endsWith(extension)).map((file) => file.slice(0, -extension.length));
  } catch {
    return [];
  }
}

const BAD_REFERENCE_NAME ="Error bad_params: name the reference with letters, digits, '.', '_' and '-'.";

/** One recorded request; `route` is the screen it ended on, `fragile` marks a target that only worked that run (a ref). */
interface ScriptStep {
  method: string;
  params: Record<string, unknown>;
  route?: string[];
  /** The name of the place where the step ran, when the host has a map (AGENT-TOOLS 1.15 §26.6). */
  place?: string;
  /** The recorded element's facts (AGENT-TOOLS 1.16 §9.4); never text. */
  seen?: Seen;
  fragile?: boolean;
  /** Typed into a password field: its text wasn't saved (never written to the file). */
  secret?: boolean;
  /** A route's step whose text is a variable or an account's placeholder: `${` in it is not escaped. */
  placeholder?: boolean;
}

const scriptSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  app: z.object({ name: z.string(), id: z.string().optional() }),
  recordedAt: z.string(),
  steps: z.array(
    z.object({
      method: z.string(),
      params: z.record(z.string(), z.unknown()),
      route: z.array(z.string()).optional(),
      fragile: z.boolean().optional(),
    }),
  ),
});
type Script = z.infer<typeof scriptSchema>;

/** A target that works again on a new run: testID, else label, else visible text; refs only work for the run they came from. */
function stableParams(params: unknown, result: unknown): { params: Record<string, unknown>; fragile: boolean } {
  const copy: Record<string, unknown> =
    typeof params === "object" && params !== null ? { ...(params as Record<string, unknown>) } : {};
  // A journey's own flags are not part of a script.
  delete copy["noScroll"];
  delete copy["glass"];
  const target = copy["target"];
  if (typeof target !== "object" || target === null) return { params: copy, fragile: false };
  // A target the agent gave by testID, label, text or point already picked one element: keep it.
  if (!("ref" in target)) return { params: copy, fragile: false };
  const element =
    typeof result === "object" && result !== null && "element" in result
      ? elementSchema.safeParse((result as { element: unknown }).element)
      : null;
  if (element?.success) {
    // The same choice the explorer's action signature makes (§25.3): id, else label, else text.
    const named = namedTarget(element.data);
    if (named !== null) copy["target"] = named;
  }
  const kept = copy["target"];
  const fragile = typeof kept === "object" && kept !== null && "ref" in kept;
  return { params: copy, fragile };
}

/** A step that types an account's value: its text is a placeholder, kept in the script (the value never is). */
function isAccountStep(step: ScriptStep): boolean {
  return step.method === "type" && typeof step.params["text"] === "string" && mentionsVault(step.params["text"]);
}

/**
 * The app refused an account's value because of the kind of field (capability `typeKind`; its `data.secure` says
 * which kind the field is). The answer says it in the words of AGENT-TOOLS 1.13 §18.6, with the field's ref and
 * never anything the app wrote about its text.
 */
function kindRefusal(error: unknown, kind: unknown, fixture = false): string | null {
  if (kind !== "secure" && kind !== "plain") return null;
  if (!(error instanceof TaplineError) || error.code !== "bad_params") return null;
  const details = error.details;
  const data = typeof details === "object" && details !== null ? (details as { data?: unknown }).data : undefined;
  const secure = typeof data === "object" && data !== null ? (data as { secure?: unknown }).secure : undefined;
  if (typeof secure !== "boolean") return null;
  const ref = /^(e\d+)\b/.exec(error.message)?.[1] ?? "the field";
  const is = secure ? "a password field" : "a text field";
  // A fixture is plain test data: it goes only into a text field, never a password field (§20.1, v1.16).
  if (fixture) return `Error bad_params: a fixture goes only into a text field; ${ref} is ${is}.`;
  return kind === "secure"
    ? `Error bad_params: an account's password goes only into a password field; ${ref} is ${is}.`
    : `Error bad_params: an account's username goes only into a text field; ${ref} is ${is}.`;
}

/** A short description of a step, e.g. `press id=save` or `type "Ann" into label="Name"`. */
function describeStep(step: ScriptStep): string {
  const p = step.params;
  const target = p["target"];
  let where = "";
  if (typeof target === "object" && target !== null) {
    const t = target as Record<string, unknown>;
    if (typeof t["testID"] === "string") where = `id=${t["testID"]}`;
    else if (typeof t["label"] === "string") where = `label=${JSON.stringify(t["label"])}`;
    else if (typeof t["text"] === "string") where = `text=${JSON.stringify(t["text"])}`;
    else if (typeof t["ref"] === "string") where = `ref ${t["ref"]}`;
    else if (typeof t["x"] === "number") where = `point ${String(t["x"])},${String(t["y"])}`;
  }
  switch (step.method) {
    case "sleep":
      return `wait ${String(p["seconds"])} s`;
    case "type":
      return `type ${JSON.stringify(p["text"])}${where ? ` into ${where}` : ""}`;
    case "openURL":
      return `open ${String(p["url"])}`;
    case "command":
      return `command ${String(p["name"])}`;
    case "swipe":
      return `swipe ${String(p["x0"])},${String(p["y0"])} → ${String(p["x1"])},${String(p["y1"])}`;
    case "waitFor": {
      const what = ["text", "testID", "label"].find((key) => typeof p[key] === "string");
      const thing = what ? `${what === "testID" ? "id" : what}=${JSON.stringify(p[what])}${p["gone"] === true ? " gone" : ""}` : "";
      return `wait for ${[thing, p["networkIdle"] === true ? "quiet network" : ""].filter(Boolean).join(" and ")}`;
    }
    default:
      return `${step.method}${where ? ` ${where}` : ""}`;
  }
}

const overlaySchema = z.object({
  rev: z.number().optional(),
  screen: z.object({ width: z.number(), height: z.number() }),
  elements: z.array(
    z.object({
      ref: z.string().nullish(),
      type: z.string().nullish(),
      label: z.string().nullish(),
      id: z.string().nullish(),
      frame: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
    }),
  ),
});

const feedAnswerSchema = z.object({
  on: z.boolean(),
  stats: z
    .object({
      frames: z.number(),
      avgCaptureMs: z.number(),
      maxCaptureMs: z.number(),
      observedFrames: z.number(),
      janky: z.number(),
      jankyWhileCapturing: z.number(),
      failures: z.number().optional(),
      lastFailure: z.string().optional(),
      heartbeats: z.number().optional(),
      backoffs: z.number().optional(),
    })
    .optional(),
});

/** Bounds of TAPLINE_FEED_GAP_MS, as the app checks them. */
const MIN_FEED_GAP_MS = 30;
const MAX_FEED_GAP_MS = 2000;

/**
 * The app's `feed` params. For measuring only, TAPLINE_FEED_GAP_MS (30–2000) replaces the app's
 * live pace with a fixed gap between captures; apps without it ignore it.
 */
export function feedParams(on: boolean, quality: QualityPreset, env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const raw = env.TAPLINE_FEED_GAP_MS;
  const gapMs = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (gapMs >= MIN_FEED_GAP_MS && gapMs <= MAX_FEED_GAP_MS) return { on, quality, gapMs };
  return { on, quality };
}

const commandsSchema = z.object({
  commands: z.array(z.object({ name: z.string(), description: z.string() })),
});

const findingsSchema = z.object({
  findings: z.array(z.object({ kind: z.string(), ref: z.string(), other: z.string().optional(), message: z.string() })),
});

/** A phone described as `apps` lists it: name, platform and OS, or the install id when it sends no name. */
function deviceLabel(s: SessionInfo): string {
  // iPhones send no name, so the install id is what tells two of them apart.
  const install = s.device.name === undefined && s.device.id !== undefined ? `install ${s.device.id.slice(0, 6)}` : undefined;
  const device = [s.device.name, [s.device.platform, s.device.osVersion].filter(Boolean).join(" "), install]
    .filter((p): p is string => typeof p === "string" && p !== "")
    .join(", ");
  return device || "unknown device";
}

/** Default screenshot width in pixels: readable, about 1,000 image tokens for a phone screen. */
export const DEFAULT_SCREENSHOT_WIDTH = 600;

/** The app methods whose result may say `closedKeyboard: true` (the app closed the keyboard before acting). */
const KEYBOARD_METHODS: ReadonlySet<string> = new Set(["press", "longPress", "toggle", "type"]);

const SECURE_QUIET_NOTE = "Note: no screenshot: a password field was typed into a moment ago and iOS may still show its last character; look again in a second.";
const NO_SCREENSHOT_NOTE ="Note: no screenshot: this app doesn't support it; add react-native-view-shot.";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** waitFor answers only when its own wait ends (default 10 s): wait that long plus a margin for it. */
function answerTimeoutMs(method: string, params: unknown): number | undefined {
  if (method !== "waitFor") return undefined;
  const timeout = typeof params === "object" && params !== null && "timeout" in params ? params.timeout : undefined;
  return (typeof timeout === "number" && timeout > 0 ? timeout : 10) * 1000 + 5000;
}

function text(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** The target with an `index` that was written beside it moved inside (its own index wins). */
function withIndex(target: Target, index: number | undefined): Target {
  return index !== undefined && target.index === undefined ? { ...target, index } : target;
}

function toWireTarget(target: Target): WireTarget {
  const withIndex = <T extends object>(t: T): T & { index?: number } =>
    target.index !== undefined ? { ...t, index: target.index } : t;
  if (target.ref !== undefined) return { ref: target.ref };
  if (target.id !== undefined) return withIndex({ testID: target.id });
  if (target.label !== undefined) return withIndex({ label: target.label });
  if (target.text !== undefined) return withIndex({ text: target.text });
  return { x: target.x ?? 0, y: target.y ?? 0 };
}

/** The target of a call as the agent wrote it, in words (`"Save"`, `e3`, `120,300`); undefined when it gave none. */
function journeyTargetWords(input: Record<string, unknown>): string | undefined {
  const raw = input["target"] ?? input["tap"];
  const parsed = typeof raw === "object" && raw !== null ? targetSchema.safeParse(raw) : null;
  if (parsed?.success === true) return targetWords(parsed.data);
  if (typeof input["url"] === "string") return input["url"];
  if (typeof input["name"] === "string") return input["name"];
  return undefined;
}

/** A target as the agent wrote it, in words: `id=save`, `"Save"`, `e3`, `120,300`. */
function targetWords(target: Target): string {
  if (target.id !== undefined) return `id=${target.id}`;
  if (target.text !== undefined) return JSON.stringify(target.text);
  if (target.label !== undefined) return JSON.stringify(target.label);
  if (target.ref !== undefined) return target.ref;
  return `${target.x ?? 0},${target.y ?? 0}`;
}

function candidateLines(details: unknown): string[] {
  const lines: string[] = [];
  const bareRefs: string[] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") {
        bareRefs.push(item);
        continue;
      }
      const element = elementSchema.safeParse(item);
      if (element.success) lines.push(formatElement(element.data));
    }
  };
  if (typeof details === "object" && details !== null) {
    const record = details as Record<string, unknown>;
    visit(record["candidates"]);
    visit(record["refs"]);
    const data = record["data"];
    if (typeof data === "object" && data !== null) {
      const nested = data as Record<string, unknown>;
      visit(nested["candidates"]);
      visit(nested["refs"]);
    }
  }
  // Full element lines say more than refs; refs only stand in when the app sent no elements.
  return [...new Set(lines.length > 0 ? lines : bareRefs)];
}

/** At most this many candidates are listed in an `ambiguous` answer (AGENT-TOOLS §4). */
const MAX_CANDIDATES = 5;

const NO_JOURNEY = "Error bad_params: no journey is running; start one with start: true and a goal.";

/**
 * The `ambiguous` block (AGENT-TOOLS §4): the message, `Candidates:` with up to 5 lines indented two
 * spaces, a `(+N more; …)` line when there are more, then the retry line. `total` is the number of
 * matches when known. "N inputs on screen" (`type_text` without a target) has no `index` to add: its
 * retry line and its `(+N more; …)` line say only to use a ref.
 */
export function ambiguousBlock(message: string, candidates: string[], total?: number, retry?: string): string {
  const inputsCase = /^\d+ inputs on screen/.test(message);
  const shown = candidates.slice(0, MAX_CANDIDATES);
  const count = Math.max(total ?? candidates.length, candidates.length);
  const more = count - shown.length;
  const lines = [`Error ambiguous: ${message}`];
  if (shown.length > 0) lines.push("Candidates:", ...shown.map((c) => `  ${c}`));
  if (more > 0) lines.push(inputsCase ? `  (+${more} more; use a ref)` : `  (+${more} more; use a ref or "index")`);
  lines.push(retry ?? (inputsCase ? "Retry with one of the refs as the target." : 'Retry with one of the refs, or add "index" (0-based).'));
  return lines.join("\n");
}

/** A person's input that failed: its code, reason word (when refused) and message, for the viewer. */
function failure(error: unknown): { ok: false; code: string; reason?: string; message: string } {
  const code = error instanceof TaplineError ? error.code : "internal";
  const message = error instanceof Error ? error.message : String(error);
  const reason = reasonOf(code, message);
  return { ok: false, code, ...(reason !== undefined ? { reason } : {}), message };
}

export function describeError(error: unknown): string {
  if (error instanceof TaplineError) {
    if (error.code === "ambiguous") {
      const counted = /^(\d+) (?:elements match|inputs on screen)/.exec(error.message);
      return ambiguousBlock(error.message, candidateLines(error.details), counted?.[1] !== undefined ? Number(counted[1]) : undefined);
    }
    return `Error ${error.code}: ${error.message}`;
  }
  return `Error internal: ${error instanceof Error ? error.message : String(error)}`;
}

/** Ends a guarded call inside the agent's turn with the policy's answer (nothing was touched). */
class PolicyStop extends Error {
  constructor(readonly answer: CallToolResult) {
    super("stopped by the policy");
  }
}

/** Adds a note line to the end of an answer's first text block. */
function appendNote(answer: CallToolResult, note: string): CallToolResult {
  const [top, ...rest] = answer.content;
  if (top === undefined || top.type !== "text") return answer;
  return { ...answer, content: [{ type: "text", text: [top.text.trimEnd(), note].join("\n") }, ...rest] };
}

/** Several notes at the end of an answer, in order. */
function appendNotes(answer: CallToolResult, notes: string[]): CallToolResult {
  return notes.reduce((done, note) => appendNote(done, note), answer);
}

/** Takes the notes collected so far (a call's grant notes) onto the end of the answer and empties the list. */
function flushNotes(answer: CallToolResult, notes: string[]): CallToolResult {
  return appendNotes(answer, notes.splice(0));
}

/**
 * Codes that say a request was refused before anything was touched: the host never sent it (not connected, app in the background)
 * or the app refused it before it dispatched (target missing, not touchable, ambiguous, stale, bad arguments). Anything else
 * (a timeout, a disconnect, an app error, a handler that threw) leaves it uncertain whether the touch was made.
 */
const NOT_DELIVERED_CODES: ReadonlySet<string> = new Set(["not_found", "not_actionable", "ambiguous", "stale", "bad_params", "unsupported", "not_allowed", "not_connected", "in_background", "busy", "paused"]);

/** True when a request's failure proves the touch was not made. */
function notDelivered(error: unknown): boolean {
  return error instanceof TaplineError && NOT_DELIVERED_CODES.has(error.code);
}

/** A grant that let a touch through: what its answer says, and what a failed touch gives back (§19.3, §19.4). */
interface GrantUse {
  name: string;
  /** `2 of 3`: the count including this use. */
  counts: string;
  line: string;
  /** Who made the use and its slot files (§19.4): `release` and the re-check before the touch go by them. */
  owner: string;
  slots: string[];
}

/** The app's refusal when an alert it can't answer is open (a stand-in's own buttons are an ordinary screen). */
const ALERT_IN_WAY = /behind_alert: (An alert is open|Tapline's own prompt is open)/;

/** A needs-a-person moment: what the person does, when the tool goes on by itself, and how it sees the moment cleared. */
interface Moment {
  key: string;
  what: string;
  goOn?: string;
  cleared: () => Promise<boolean> | boolean;
}

/** The dialog's text (§11.5): `Needs a person: <what>. I'll go on by myself when <it clears>.` */
function momentMessage(moment: Pick<Moment, "what" | "goOn">): string {
  return `Needs a person: ${moment.what}.${moment.goOn !== undefined ? ` I'll go on by myself when ${moment.goOn}.` : ""}`;
}

/** The step a batch (`run`, `replay`) stopped at, from its failure line; undefined for any other answer. */
function batchStep(answer: CallToolResult): number | undefined {
  const top = answer.content[0];
  if (answer.isError !== true || top === undefined || top.type !== "text") return undefined;
  const at = /^Error \w+: Ran \d+ of \d+ steps; stopped at step (\d+) /.exec(top.text)?.[1];
  return at === undefined ? undefined : Number(at);
}

/**
 * The error code of an answer that may be a needs-a-person moment (§11.5): the app isn't there, is in the background,
 * stopped answering, or an alert is in the way. `busy` and `paused` are a person already at work, never such a moment.
 */
function momentCode(answer: CallToolResult): "not_connected" | "in_background" | "not_answering" | "not_actionable" | undefined {
  const top = answer.content[0];
  if (answer.isError !== true || top === undefined || top.type !== "text") return undefined;
  const code = /^Error (not_connected|in_background|not_answering|not_actionable):/.exec(top.text)?.[1];
  // A batch that stopped on one of these: `Error <code>: Ran 2 of 5 steps; stopped at step 3 (...): <message>`.
  if (batchStep(answer) !== undefined) {
    if (code === "not_actionable") return ALERT_IN_WAY.test(top.text) ? code : undefined;
    return code === "not_connected" || code === "in_background" || code === "not_answering" ? code : undefined;
  }
  if (code === "not_actionable") return top.text.startsWith("Error not_actionable: behind_alert: ") && ALERT_IN_WAY.test(top.text) ? code : undefined;
  // Only "no app is connected": an `app` argument naming an app that isn't there is the agent's mistake, not a moment.
  if (code === "not_connected") return top.text.startsWith("Error not_connected: No app is connected to Tapline.") ? code : undefined;
  return code === "not_connected" || code === "in_background" || code === "not_answering" ? code : undefined;
}

/** An app's dry-run answer (AGENT-TOOLS 1.8 §11.4). */
/** Elements already read: as they may be shown, and raw (account values in) for the policy only. */
interface KnownElements {
  elements: TreeElement[];
  raw: TreeElement[];
}

const dryRunResultSchema = z.object({
  element: elementSchema.nullish(),
  dryRun: z.literal(true),
  point: z.object({ x: z.number(), y: z.number() }).optional(),
  value: z.unknown().optional(),
  /** The element is off screen and the action would scroll it into view first (§16.2); `point` is where it expects to touch after. */
  scrolls: z.boolean().optional(),
});

/** Whether an app's answer says the action scrolled the element into view first (AGENT-TOOLS 1.12 §16.2). */
function scrolledFirst(result: unknown): boolean {
  return typeof result === "object" && result !== null && "scrolled" in result && result.scrolled === true;
}

/** `Scrolled to it, then tapped …` when the action scrolled first: the sentence goes on after a lead-in. */
/** The text of an answer: its text blocks, joined. */
function answerText(answer: CallToolResult): string {
  return answer.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

function afterScroll(result: unknown, sentence: string): string {
  return scrolledFirst(result) ? `Scrolled to it, then ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}` : sentence;
}

/** For an app without dry runs: every element on its list the target could mean. */
function candidatesFor(target: unknown, elements: TreeElement[]): TreeElement[] {
  if (typeof target !== "object" || target === null) return [];
  const t = target as Record<string, unknown>;
  const lower = (value: unknown): string => (typeof value === "string" ? value.toLowerCase() : "");
  const x = t["x"];
  const y = t["y"];
  let found: TreeElement[];
  if (typeof t["ref"] === "string") found = elements.filter((e) => e.ref === t["ref"]);
  else if (typeof t["testID"] === "string") found = elements.filter((e) => e.testID === t["testID"]);
  else if (typeof t["label"] === "string") found = elements.filter((e) => lower(e.label) === lower(t["label"]));
  else if (typeof t["text"] === "string") {
    const want = lower(t["text"]);
    found = elements.filter((e) => lower(e.text).includes(want) || lower(e.label).includes(want));
  } else if (typeof x === "number" && typeof y === "number") {
    found = elements.filter((e) => {
      const f = e.frame;
      return f !== null && f !== undefined && x >= f.x && x <= f.x + f.width && y >= f.y && y <= f.y + f.height;
    });
  } else found = [];
  const index = t["index"];
  const picked = typeof index === "number" ? found[index] : undefined;
  return picked !== undefined ? [picked] : found;
}

// ---- tool handlers ----------------------------------------------------------

/** Every tool whose answer can end with a crash note (all but `crash`, which tells it in full). */
const CRASH_NOTED_TOOLS = [
  "apps", "openApp", "pair", "look", "run", "inspect", "audit", "uxCheck", "media", "checkLayout", "viewer", "compareScreen", "filmstrip",
  "record", "replay", "tap", "longPress", "typeText", "scroll", "toggle", "appCommand", "waitFor", "swipe", "back",
  "openUrl", "logs", "reload", "performance", "wait", "drive",
] as const satisfies readonly (keyof TaplineTools)[];

/** The tools that measure or compare: fast animations are normal inside them (PLAN-1.6 F4, E8). `compareStep` is `run`'s own. */
const PAUSED_TOOLS = ["compareScreen", "compareStep", "filmstrip", "performance"] as const;

/** Every tool the agent calls, by handler name (the call log numbers these). */
const CALL_TOOLS: Readonly<Record<string, string>> = {
  apps: "apps", openApp: "open_app", pair: "pair", look: "look", run: "run", inspect: "inspect", audit: "audit",
  uxCheck: "ux_check", media: "media", checkLayout: "check_layout", viewer: "viewer", compareScreen: "compare_screen", filmstrip: "filmstrip", record: "record",
  replay: "replay", tap: "tap", longPress: "long_press", typeText: "type_text", scroll: "scroll", toggle: "toggle",
  appCommand: "app_command", waitFor: "wait_for", swipe: "swipe", back: "back", openUrl: "open_url", logs: "logs",
  crash: "crash", reload: "reload", performance: "performance", wait: "wait", sessionReport: "session_report", journey: "journey", map: "map", drive: "drive", explore: "explore", bugReport: "bug_report",
};
/** The calls a journey counts and measures (AGENT-TOOLS 1.12 §17.1): the agent's looks and actions. */
const JOURNEY_TOOLS: ReadonlySet<string> = new Set([
  "look", "run", "inspect", "audit", "ux_check", "check_layout", "compare_screen", "filmstrip", "tap", "long_press", "type_text", "scroll",
  "toggle", "app_command", "wait_for", "swipe", "back", "open_url", "logs", "crash", "wait", "drive",
]);
/** A stress moment a person was asked to do: what must survive, when it was asked, and (rotate) the screen's size then. */
interface StressWaiting {
  survives: Survives | undefined;
  askedAt: number;
  size: { width: number; height: number } | null;
}
/** A stress double tap's two taps, this many ms apart (AGENT-TOOLS 1.12 §17.4): the app makes the second. */
const DOUBLE_TAP_GAP_MS = 80;
/** What the app says of a double tap's second tap. */
const pressSecondSchema = z.union([
  z.object({ done: z.literal(true), afterMs: z.number(), threw: z.string().optional() }),
  z.object({ done: z.literal(false), reason: z.string().regex(/^[a-z_]{1,40}$/), afterMs: z.number() }),
]);
/** The calls after which a journey keeps a small picture of the screen (§17.5); the rest only read text. */
const FRAME_TOOLS: ReadonlySet<string> = new Set([
  "look", "tap", "long_press", "type_text", "scroll", "toggle", "swipe", "back", "open_url", "app_command", "wait_for", "wait", "drive",
]);
/** Calls logged with `"kind": "read"` when they logged no action of their own. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  "apps", "open_app", "pair", "look", "inspect", "audit", "ux_check", "check_layout", "viewer", "compare_screen", "filmstrip", "record",
  "replay", "wait_for", "logs", "crash", "reload", "performance", "wait", "session_report", "bug_report",
]);
/** A look's picture arguments for the call log: booleans and numbers only; undefined when it gave none. */
function pictureArgs(input: Record<string, unknown>): { screenshot?: boolean; width?: number; labels?: boolean } | undefined {
  const out: { screenshot?: boolean; width?: number; labels?: boolean } = {};
  if (typeof input["screenshot"] === "boolean") out.screenshot = input["screenshot"];
  if (typeof input["width"] === "number" && Number.isFinite(input["width"])) out.width = input["width"];
  if (typeof input["labels"] === "boolean") out.labels = input["labels"];
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Tools whose answer carries the changes or the full list unless the call said `look: false`. */
const LISTING_TOOLS: ReadonlySet<string> = new Set(["tap", "long_press", "type_text", "scroll", "toggle", "swipe", "back", "open_url", "app_command", "run"]);
/** Tools that act on one element: after a run of scrolls they log whether the element was already in the list. */
const ELEMENT_ACTIONS: ReadonlySet<string> = new Set(["tap", "long_press", "type_text", "toggle"]);
/** The logged touches that can take the app to another place (the known-way flag reads them). */
const AGENT_TOUCHES: ReadonlySet<string> = new Set(["tap", "long_press", "toggle", "back", "open_url", "swipe"]);

/** What a call in flight collects for the call log. */
/** What the reflexes did in one call (AGENT-TOOLS 1.13 §18.7): the limit is per call, and every line is said in its answer. */
interface ReflexCall {
  fired: Map<string, number>;
  lines: string[];
}

interface CallState {
  call: number;
  tool: string;
  /** The call before this one was a scroll. */
  afterScrolls: boolean;
  /** The call came through the thin call. */
  thin: boolean;
  /** Fast animations were on when the call began (the report says how many calls they covered). */
  fast: boolean;
  entries: Array<{ entry: Omit<ActionLogEntry, "t" | "source">; at: Date }>;
}

/** What a call answers when the screen is not what the person was asked about (§11.3). */
const CHANGED_WHILE_WAITING = "Error not_allowed: needs_confirmation: the screen changed while waiting for the OK; ask again.";

/** A person's OK given while the call waited: what the screen showed then, and where it was given. */
type Waited = { fp: string; via: OkVia; /** The OK was for a draft (§21.3), and where the draft came from. */ draft?: Draft["source"] } | { fp: string; pre: PreUse };

/** A draft shown to a person before the touch that sends it (AGENT-TOOLS 1.14 §21.3): where it came from, the question and the field's text. */
interface Draft {
  source: "grant" | "route";
  /** The policy word that matched, as the dialog says it. */
  word: string;
  caption: string;
  /** The field's text, redacted: what the person was shown and what the OK is bound to. */
  text: string;
}

/** What binds a person's OK to the draft they saw: the text. A changed draft is another question. */
const draftBinding = (draft: Draft | null): string => (draft === null ? "" : `|draft|${draft.text}`);

/**
 * A grant's use taken before the dialog stage (§19.4): a grant that covers the touch asks no one, and when taking its use fails
 * (the audit line can't be written, the limit was reached meanwhile) the touch asks a person through the dialog as usual.
 * `handed` is true once the check right before the touch has taken it over, or it has been given back.
 */
interface PreUse {
  use: GrantUse;
  handed: boolean;
}

/** What a grant offer asks for: the counts and days of a grant a person may create after allowing a touch (§19.6). */
export const GRANT_OFFER_PER_DAY = 3;
export const GRANT_OFFER_DAYS = 7;

/** The tool handlers behind the MCP server. They only talk to a TaplineHost, so they are easy to test. */
/**
 * What one explore run holds for every request any of its moves sends (§25.5): the budget counts each one, and every text it types
 * is known for redaction. Shared by all the moves of the run, so a route, a drive leg, a recovery or a reset cannot step outside it.
 */
interface ExploreRun {
  /** Requests that reached the app and answered, for the steps budget. */
  used: number;
  steps: number;
  minutes: number;
  startedAt: number;
  waited0: number;
  /** Every value the run typed, scrubbed from everything it writes (the same forms and minimum length as a vault value). */
  typed: string[];
  /** The host-level registration of `typed` (the ingress scrubber knows each text from the moment it is typed, until the run ends). */
  ingress?: { add(value: string): void; end(): void };
  /** The reproduction check's deadline: once it is aborted nothing more is sent (§29.4). */
  signal?: AbortSignal;
}

/** The scope of one move of an explore run. */
interface ExploreScope {
  count: number;
  last?: { method: string; result: unknown };
  restoring?: boolean;
  run: ExploreRun;
  /** This move is the explorer's own `type`, and one typing request may go (explore types nowhere else: no route, no drive leg). */
  mayType?: boolean;
}

/** Requests that only read: they cost no step and are never held back by the explore gate. */
/** Requests that touch the app: each is made from an unprotected place (and a scroll at an unskipped view). */
const EXPLORE_TOUCHES: ReadonlySet<string> = new Set(["press", "longPress", "toggle", "type", "scroll", "swipe"]);

const EXPLORE_READS: ReadonlySet<string> = new Set(["tree", "place", "places", "logs", "commands", "audit", "uxCheck", "screenshot", "overlay", "waitFor", "inspect", "check", "feed", "perfSettle", "perfStart", "perfStop"]);

export class TaplineTools {
  private readonly reloadWaitMs: number;
  /** The action log (§12), when one is configured. */
  private readonly actionLog: ActionLog | null;
  /** When the action in flight started, for the log's `ms`. */
  private actionStartedAt: number | undefined;
  /** Set while `run` runs a step: the log ties the action to its batch. */
  private batch: { id: string; step: number } | undefined;
  /** Extra fields for the next log line (a dry run, a confirmed touch). */
  private logExtra: Partial<ActionLogEntry> | undefined;
  /** The clusters the latest `expect.matches` check named under its threshold (1.13.1 item 2). */
  private matchedNames: string[] = [];
  /** The call log (AGENT-TOOLS 1.11 §16.1): this run's id, when it began, and how many calls the agent has made. */
  private readonly sessionTag = randomBytes(4).toString("hex");
  private readonly startedAt = Date.now();
  private callCount = 0;
  /** The call in flight (and everything it awaits): its log entries wait here for the size of its answer. */
  private readonly callScope = new AsyncLocalStorage<CallState>();
  private readonly thinScope = new AsyncLocalStorage<boolean>();
  /** Takes this object's listeners off the host, so a dropped client is not kept alive by it. */
  private readonly disposers: Array<() => void> = [];

  dispose(): void {
    for (const off of this.disposers.splice(0)) off();
  }

  /** A person used the app through another tools object (the live viewer): `{ref}` targets here are stale too. */
  noteViewerInput(): void {
    this.markPersonUsedApp();
  }

  /** Runs a call that came through the thin call, so its log entries say `via: "call"` (§16.1, §18.10). */
  asThinCall<T>(run: () => T): T {
    return this.thinScope.run(true, run);
  }
  private clientIdFn: (() => string | undefined) | undefined;
  /** The tool of the previous call, for scroll runs. */
  private prevCallTool: string | undefined;
  /**
   * The latest full element list the agent was given. `stale`: only changes since. `unseen`: an action since then
   * answered with no list and no changes (`look: false`), so the screen may be another one: neither "in the
   * list" nor "not in it" can be said until a list is seen again.
   */
  private listBase: { elements: TreeElement[]; stale: boolean; unseen: boolean } | undefined;
  /** The list as it was before the current run of scrolls began. */
  private scrollBase: { elements: TreeElement[]; stale: boolean; unseen: boolean } | undefined;
  readonly confirmations: Confirmations;
  private dialogs: Dialogs | undefined;
  /** Milliseconds this server spent waiting for a person's OK; run's 120 s doesn't count them (§9.3). */
  private readonly holdScope = new AsyncLocalStorage<{ ms: number; signal?: AbortSignal; lease?: string; progress?: (line: string, steps: number) => void }>();
  /** Set around every move and read `explore` makes (AGENT-TOOLS 1.15 §25.5): the touch check never asks and no grant is looked at; counts the requests it made. */
  private readonly exploreScope = new AsyncLocalStorage<ExploreScope>();
  /** Read at each use: a host that reloads its policy (a scheduled run asks for its facts) hands every client the new one. */
  private get policy(): PolicyFile {
    return this.options.policy ?? DEFAULT_POLICY;
  }
  private readonly uxRules: UxRules;
  /**
   * Hook for the journey (AGENT-TOOLS 1.12 §17): gives `ux_check` the action labels of earlier screens, and is told
   * what each `ux_check` found. Null while no journey runs (naming is then not checked, and the answer says so).
   */
  uxJourney: UxJourneyHook | null = null;
  private readonly reloadSettleMs: number;
  private readonly stillGapMs: number;
  private readonly stillCapMs: number;
  private readonly noScreenshot = new Set<string>();
  private readonly shotFiles: string[] = [];
  /** Sessions this agent has had an element list for (so later lists can be just the changes). */
  private readonly listed = new Set<string>();
  /** Sessions whose previous answer had an alert open, so the next change block can say `Alert: gone`. */
  private readonly alertOpen = new Set<string>();
  /** What each session's open alert said in the previous answer (title, message, buttons), to see a change of the message alone. */
  private readonly alertSeen = new Map<string, string>();
  /** Per session: how many actions answered with `look: false` since the agent was last given a list or a change block. */
  private readonly unlistedActions = new Map<string, number>();
  /** The route of the latest element list, for recording and checking replays. */
  private lastLookRoute: string[] | undefined;
  /** A person acted (in the viewer, or a finger on the phone) since the agent's last full list: `{ref}` targets fail with `stale`. */
  private personActed = false;
  /** The next answer to the agent says a person used the app, once. */
  private personNotePending = false;
  private recordingState: {
    name: string;
    app: { name: string; id?: string };
    steps: ScriptStep[];
    /** Set while recording a route (AGENT-TOOLS 1.13 §18.5): where it starts, the variables its steps use, and the app's map. */
    route?: { start: string; variables: Set<string>; map: AppMap };
  } | null = null;
  private replayingState = false;
  /** Set inside a reflex's own step (and what it awaits) only: other calls running beside it are not touched (§18.7). */
  private readonly reflexStep = new AsyncLocalStorage<true>();

  /** A reflex's step is no recorded step: inside it nothing is recording. */
  private get recording(): NonNullable<typeof this.recordingState> | null {
    return this.reflexStep.getStore() === true ? null : this.recordingState;
  }
  private set recording(value: typeof this.recordingState) {
    this.recordingState = value;
  }
  /** A reflex's step changes no map (as in a replay): inside it the host reads as replaying. */
  private get replaying(): boolean {
    return this.replayingState || this.reflexStep.getStore() === true;
  }
  private set replaying(value: boolean) {
    this.replayingState = value;
  }
  /** The place the latest element list showed, so an action's road doesn't read the app again (§18.2). */
  private observedPlace: { sessionId: string; place: Place } | undefined;
  /**
   * Whether a person's OK was used for the action in progress: its move is no road (§18.2). Kept per action, so a reflex
   * that runs inside it (its own action) can never reset or set the outer action's state.
   */
  private readonly okScope = new AsyncLocalStorage<{ used: boolean }>();
  /** Whether a guarded touch's request may have reached the app (AGENT-TOOLS 1.14 §19.4): a grant's use is given back only when it surely did not. */
  private readonly deliveryScope = new AsyncLocalStorage<{ sent: boolean }>();
  /** The saved routes running in this call (a drive, a replay): a grant with a `route` covers touches made inside it only (§19.1). */
  private readonly routeScope = new AsyncLocalStorage<string[]>();
  /** True inside a route that carries `"draftsOnly": true` (§18.5, §21.3); it nests: a route inside one is drafts-only too. */
  private readonly draftsScope = new AsyncLocalStorage<boolean>();
  /** The input the agent last typed into (§21.3): the draft's field. A secure field is never kept. */
  private lastTyped: { sessionId: string; ref: string; testID?: string } | undefined;
  /** The grant notes of the call in flight (§19.3): they end its answer, before the call's other closing notes. */
  private readonly grantNotes = new AsyncLocalStorage<string[]>();
  private grantNoticeDone = false;
  private setOk(used: boolean): void {
    const state = this.okScope.getStore();
    if (state !== undefined) state.used = used;
  }
  /**
   * While a script replays (AGENT-TOOLS 1.9 §14.3): the references folder next to it (looked in first), where a
   * failed check puts its red picture, and whether the checks save instead of compare (`--update-references`).
   */
  private replayContext: { referencesDir: string; diffDir: string; update: boolean; gateRepaired: boolean } | null = null;
  /** Where the latest failed check of the running batch saved its picture. */
  private diffSaved: string | null = null;
  /** What the last `performance` call measured, for the `under` limits of a `run` step. */
  private lastPerf: PerfMeasure | undefined;
  /** The elements the latest comparison painted its ignore list from: a recording saves its mask from the same list. */
  private lastMaskElements: TreeResult["elements"] | undefined;
  /** The screen size in points from the latest list or overlay, for the live viewer's 0..1 positions. */
  private lastScreen: { w: number; h: number } | undefined;
  private shotCount = 0;
  private pairWrites = 0;
  /** Per app (by identity): crash events up to this one have been told to the agent. */
  private readonly notedCrashSeqs = new Map<string, number>();
  /** Crash events up to this one happened before this agent's session: an app with no entry above starts here. */
  private readonly crashBaseline: number;
  /** Set inside a tool call (and everything it awaits), so a call within a call (`run`'s steps) adds no notes. */
  private readonly noteScope = new AsyncLocalStorage<true>();
  /** The journey this agent has running (AGENT-TOOLS 1.12 §17.1); one at a time. */
  private journeyRun: Journey | undefined;
  /** The app the running journey started on (its identity and name): its clean-up goes to that app only. */
  private journeyApp: { identity: string; name: string } | undefined;

  /** The journey's own app if it is connected (the current one first), else undefined: never another app (Codex review of 1.5.0). */
  private journeySession(): SessionInfo | undefined {
    const app = this.journeyApp;
    const current = this.host.current();
    if (app === undefined) return current;
    if (current !== undefined && identityOf(current) === app.identity) return current;
    return this.host.sessions().find((s) => identityOf(s) === app.identity);
  }

  /** Why a journey's clean-up didn't reach its app. */
  private journeyAppGone(): string {
    return this.journeyApp === undefined ? "no app is connected" : `${this.journeyApp.name} isn't connected (Tapline changes no other app)`;
  }
  /** The state of the journey that stopped last, for the report writer and the stress moments. */
  private journeyDone: JourneyState | undefined;
  /** Inside `run`: "run" for the batch's own checks (not counted), "step" for a step (counted like a call of its own). */
  private readonly journeyScope = new AsyncLocalStorage<"run" | "step">();
  /** The running journey's frames and report pictures (AGENT-TOOLS 1.12 §17.5); undefined without a `journeysDir`. */
  private recorder: JourneyRecorder | undefined;
  /** The hook this journey gave `ux_check`, to take back at the stop. */
  private journeyHook: UxJourneyHook | undefined;
  private pickerOff: (() => void) | undefined;
  /** Where the last touch of the call in flight was, for the frame's tap ring. */
  private lastTouch: Touch | undefined;
  /** Stress moments that wait for a person (§17.4), by kind: what must survive. */
  private readonly stressWaiting = new Map<string, StressWaiting>();
  /** When the app last left the front or its link dropped, and when an app last connected (real time, for stress done). */
  private readonly appLeftAt = new Map<string, number>();
  private readonly appConnectedAt = new Map<string, number>();
  /** Which app's picker event is being counted right now (set around the media state's own count). */
  private pickerFrom: string | undefined;
  /** "starting" until a journey's set-up is done, "stopping" until its clean-up is done: no other start meanwhile. */
  private journeyBusy: "starting" | "stopping" | undefined;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly otp: OtpService;
  /** The bug report's folders (AGENT-TOOLS 1.16 §29.2); null when this server keeps none. */
  private readonly bugStore: BugStore | null = null;
  /** The finding of the last failed `run` or `replay` of this session, while it is still the last one (§29.3 `from: "failure"`). */
  private lastFailure: Finding | null = null;

  constructor(
    private readonly host: TaplineHost,
    private readonly options: ToolsOptions,
  ) {
    this.reloadWaitMs = options.reloadWaitMs ?? 20_000;
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.confirmations = options.confirmations ?? new Confirmations();
    this.dialogs = options.dialogs;
    this.uxRules = options.uxRules ?? NO_UX_RULES;
    this.actionLog = options.logDir !== undefined ? new ActionLog(options.logDir) : null;
    this.actionLog?.open();
    if (options.bugsDir !== undefined) {
      this.bugStore = new BugStore(options.bugsDir);
      // At start an app's bugs beyond the newest 100 are removed (§29.2).
      this.bugStore.pruneAll();
    }
    this.otp = options.otp ?? createOtpService();
    this.actionLog?.setBackstop((value) => this.backstop(value));
    this.reloadSettleMs = options.reloadSettleMs ?? 1500;
    this.stillGapMs = options.stillGapMs ?? 150;
    this.stillCapMs = options.stillCapMs ?? 2000;
    // A finger on the phone itself: the app saw a real touch. It can't be queued like viewer input
    // (it has already happened), so it only leaves the note and makes `{ref}` targets stale.
    const onTouch = (session: SessionInfo): void => {
      if (this.host.current()?.id === session.id) this.markPersonUsedApp();
    };
    // What a stress moment a person does leaves behind, for `done` to check (AGENT-TOOLS 1.12 §17.4).
    // Kept per app, so another connected app's events never count for the journey's app.
    const onAppState = (session: SessionInfo, state: string): void => {
      if (state !== "active") this.appLeftAt.set(identityOf(session), Date.now());
    };
    const onDisconnect = (session: SessionInfo): void => {
      // The app puts its animations back by itself when it loses the host; the host forgets it was fast.
      forgetAnimations(this.host, session.id);
      this.appLeftAt.set(identityOf(session), Date.now());
    };
    const onConnect = (session: SessionInfo): void => {
      this.appConnectedAt.set(identityOf(session), Date.now());
    };
    // The app's picker used the armed test pictures: that is when a pick was "skipped" (1.5 review, finding 5).
    const onPickerSkipped = (session: SessionInfo, count: number): void => {
      this.pickerFrom = identityOf(session);
      try {
        this.mediaState.recordPickerSkipped(session.app.id, count);
      } finally {
        this.pickerFrom = undefined;
      }
    };
    host.on("touch", onTouch);
    host.on("appState", onAppState);
    host.on("disconnect", onDisconnect);
    host.on("connect", onConnect);
    host.on("pickerSkipped", onPickerSkipped);
    this.disposers.push(() => {
      host.off("touch", onTouch);
      host.off("appState", onAppState);
      host.off("disconnect", onDisconnect);
      host.off("connect", onConnect);
      host.off("pickerSkipped", onPickerSkipped);
    });
    // The measuring tools run with fast animations paused (PLAN-1.6 F4, E8): innermost, so the note is part of the answer.
    for (const name of PAUSED_TOOLS) {
      const original: unknown = Reflect.get(this, name);
      if (typeof original !== "function") continue;
      const method = original as (this: TaplineTools, ...args: unknown[]) => CallToolResult | Promise<CallToolResult>;
      Reflect.set(this, name, (...args: unknown[]) => this.pausingAnimations(() => method.apply(this, args)));
    }
    // Crashes before this agent's session began are not its news.
    this.crashBaseline = host.crashMark();
    for (const name of CRASH_NOTED_TOOLS) {
      const original: unknown = Reflect.get(this, name);
      if (typeof original !== "function") continue;
      const method = original as (this: TaplineTools, ...args: unknown[]) => CallToolResult | Promise<CallToolResult>;
      Reflect.set(this, name, (...args: unknown[]) => this.noting(() => method.apply(this, args), name === "drive"));
    }
    // Outermost: every call of the agent is numbered and logged (reads too) once its answer is known.
    for (const [name, tool] of Object.entries(CALL_TOOLS)) {
      const original: unknown = Reflect.get(this, name);
      if (typeof original !== "function") continue;
      const method = original as (this: TaplineTools, ...args: unknown[]) => CallToolResult | Promise<CallToolResult>;
      Reflect.set(this, name, (...args: unknown[]) => this.loggedCall(tool, args[0], () => method.apply(this, args)));
    }
    // A running journey measures the agent's looks and actions, and shows its answers as a user would see them.
    for (const [name, tool] of Object.entries(CALL_TOOLS)) {
      if (!JOURNEY_TOOLS.has(tool)) continue;
      const original: unknown = Reflect.get(this, name);
      if (typeof original !== "function") continue;
      const method = original as (this: TaplineTools, ...args: unknown[]) => CallToolResult | Promise<CallToolResult>;
      Reflect.set(this, name, (...args: unknown[]) => this.journeyCall(tool, args[0], () => method.apply(this, args)));
    }
  }

  /** Whether fast animations are on for the app being driven now. */
  private fastNow(): boolean {
    const id = this.host.current()?.id;
    return id !== undefined && animationsOn(this.host, id);
  }

  /** Runs a measuring call with fast animations normal, then puts them back, and says so in the answer (E8). */
  private async pausingAnimations(run: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
    const { value, paused, failed } = await withNormalAnimations(this.host, this.host.current()?.id, async () => run(), this.leased);
    return failed ? appendNote(value, ANIMATIONS_NOT_PAUSED_NOTE) : paused ? appendNote(value, ANIMATIONS_PAUSED_NOTE) : value;
  }

  /** The journey running now, for the stress moments and the report writer (AGENT-TOOLS 1.12 §17). */
  currentJourney(): Journey | undefined {
    return this.journeyRun;
  }

  /** The state of the journey that stopped last. */
  finishedJourney(): JourneyState | undefined {
    return this.journeyDone;
  }

  /** Whether the agent sees the app as a user does: a journey is running and its eyes are the user's. */
  private userEyes(): boolean {
    return this.journeyRun?.userEyes === true;
  }

  /**
   * Measures one call of a running journey and shows its answer as a user would see it. Calls inside `run` count
   * as steps (the batch itself and its expectation checks do not); a dry run counts as nothing.
   */
  private journeyCall(tool: string, args: unknown, run: () => CallToolResult | Promise<CallToolResult>): CallToolResult | Promise<CallToolResult> {
    const journey = this.journeyRun;
    if (journey === undefined) return run();
    const input = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
    const scope = this.journeyScope.getStore();
    if (tool === "run") {
      const answer = this.journeyScope.run("run", run);
      return answer instanceof Promise ? answer.then((a) => this.shownToUser(a)) : this.shownToUser(answer);
    }
    if (scope === "run") return run();
    // A dry run counts as nothing, but what it says is still shown as a person would see it (no ids; a drive's own words are eyes-safe).
    if (input["dry_run"] === true) {
      const dry = run();
      return dry instanceof Promise ? dry.then((a) => this.shownToUser(a)) : this.shownToUser(dry);
    }
    const at = this.clock();
    const pre = journey.pre();
    this.lastTouch = undefined;
    const done = (answer: CallToolResult): CallToolResult | Promise<CallToolResult> => {
      // A step of `run` runs with no list, so the screen it ended on is read here (one cheap read), before the step is counted.
      if (scope !== "step") return counted(answer);
      return this.currentRoute().then((route) => {
        if (route !== null) journey.noteFullList({ route, text: "", fromAction: false });
        return counted(answer);
      });
    };
    const counted = (answer: CallToolResult): CallToolResult | Promise<CallToolResult> => {
      const said = answer.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
      const code = answer.isError === true ? /^Error (\w+):/.exec(said)?.[1] : undefined;
      const target = journeyTargetWords(input);
      journey.record(
        { tool, ok: answer.isError !== true, ...(code !== undefined ? { code } : {}), ...(target !== undefined ? { target } : {}), text: said, at, ms: this.clock() - at },
        pre,
      );
      const shown = this.shownToUser(answer);
      const recorder = this.recorder;
      if (recorder === undefined || !FRAME_TOOLS.has(tool)) return shown;
      // The window itself is opened where the answer is made (typeText); here it only keeps the picture away.
      if (this.secureWindow()) return shown;
      // A small picture of the screen after the step, kept in the report's folder and never in the answer.
      const touch = this.lastTouch;
      this.lastTouch = undefined;
      const animating = /^Note: the screen was still changing/m.test(said);
      return recorder.frame(journey.state.steps.length, journey.state.currentScreen, touch, animating).then(() => shown);
    };
    const result = run();
    return result instanceof Promise ? result.then(done) : done(result);
  }

  /** When a password field was last typed into, and whether that was within the second iOS still shows its last character. */
  private secureTypedAt: number | undefined;
  private secureWindow(): boolean {
    return this.secureTypedAt !== undefined && this.clock() - this.secureTypedAt < 1500;
  }

  /** In a user's eyes no id reaches the agent, not even inside an error the app composed. */
  private shownToUser(answer: CallToolResult): CallToolResult {
    if (!this.userEyes()) return answer;
    return { ...answer, content: answer.content.map((block) => (block.type === "text" ? { ...block, text: withoutIds(block.text) } : block)) };
  }

  /** `id` and `label` answer `bad_params` in a journey's user's eyes (§17.1). */
  private hiddenTarget(target: { id?: unknown; label?: unknown } | undefined): CallToolResult | null {
    if (!this.userEyes() || target === undefined) return null;
    return target.id !== undefined || target.label !== undefined ? fail(IDS_HIDDEN) : null;
  }

  /** Whether the journey's `allow` lets this shortcut through (always, outside a user's eyes). */
  private shortcutAllowed(tool: "open_url" | "app_command", what: string): boolean {
    const journey = this.journeyRun;
    return journey === undefined || !journey.userEyes || journey.allows(tool === "open_url" ? OPEN_URL : what);
  }

  private shortcutWords(tool: "open_url" | "app_command", what: string): string {
    return tool === "open_url"
      ? "Error not_allowed: in a journey, open_url is a shortcut a user doesn't have, and this journey's allow doesn't name it; reach the screen the way a user would."
      : `Error not_allowed: in a journey, app_command ${JSON.stringify(what)} is a shortcut a user doesn't have, and this journey's allow doesn't name it.`;
  }

  /** A shortcut in a user's eyes: refused unless `allow` names it, and noted for the report when it goes through. */
  private shortcutRefusal(tool: "open_url" | "app_command", what: string): CallToolResult | null {
    const journey = this.journeyRun;
    if (journey === undefined || !journey.userEyes) return null;
    if (!this.shortcutAllowed(tool, what)) return fail(this.shortcutWords(tool, what));
    journey.noteShortcut({ tool, what });
    return null;
  }

  /** In a user's eyes `animations fast` is off unless `allow` names fast_animations; `normal` always goes (PLAN-1.6 F4, E8). */
  private animationsRefusal(args: unknown): string | null {
    if (!this.userEyes()) return null;
    const speed = typeof args === "object" && args !== null ? (args as { speed?: unknown }).speed : undefined;
    if (speed === "normal" || this.journeyRun?.allows(FAST_ANIMATIONS_ALLOWED) === true) return null;
    return "Error not_allowed: in a journey, fast animations are off: a user waits for them; the journey's allow can name fast_animations.";
  }

  private static readonly SCROLL_TO_TARGET_OFF =
    'Error not_allowed: in a journey, scroll to: "target" is off: a person scrolls until they see it. Scroll down or up, then look.';

  /** What a journey's user's eyes refuse in a step of `run`, before anything runs (a step number first); null when it is fine. */
  private journeyStepRefusal(step: Step, index: number): string | null {
    if (!this.userEyes()) return null;
    const s = step as Record<string, unknown>;
    const hidden = (value: unknown): boolean =>
      typeof value === "object" && value !== null && ("id" in value || "label" in value);
    const expect = s["expect"];
    if (hidden(s["target"]) || hidden(s["tap"]) || hidden(expect) || hidden(s["if"]) || (step.tool === "wait_for" && ("id" in s || "label" in s))) {
      return IDS_HIDDEN.replace("Error bad_params: ", `Error bad_params: step ${index + 1}: `);
    }
    if (step.tool === "scroll" && s["to"] === "target") return TaplineTools.SCROLL_TO_TARGET_OFF.replace("Error not_allowed: ", `Error not_allowed: step ${index + 1}: `);
    if (step.tool === "open_url" && !this.shortcutAllowed("open_url", String(s["url"] ?? ""))) {
      return this.shortcutWords("open_url", "").replace("Error not_allowed: ", `Error not_allowed: step ${index + 1}: `);
    }
    const name = String(s["name"] ?? "");
    // Fast animations have their own allow word (fast_animations), not the command's name.
    if (step.tool === "app_command" && name === "animations") {
      return this.animationsRefusal(s["args"])?.replace("Error not_allowed: ", `Error not_allowed: step ${index + 1}: `) ?? null;
    }
    if (step.tool === "app_command" && name !== "" && !this.shortcutAllowed("app_command", name)) {
      return this.shortcutWords("app_command", name).replace("Error not_allowed: ", `Error not_allowed: step ${index + 1}: `);
    }
    return null;
  }

  /**
   * An agent action on the phone: behind a scheduled run's lease when another holds it, then in the live viewer's queue
   * (a person goes first; paused refuses).
   */
  private agentTurn<T>(run: () => Promise<T>): Promise<T> {
    const control = this.options.control;
    // The flip back of an explorer's toggle is one move with the flip: a pause between them doesn't refuse it (§25.7).
    const restoring = this.exploreScope.getStore()?.restoring === true;
    const go = control !== undefined ? () => control.runAgent(run, restoring ? { ignorePause: true } : {}) : run;
    return this.leaseGate(go);
  }

  /**
   * Behind a scheduled run's lease: another client's call waits (then answers `busy`) while the lease stands. Only the credential the
   * run was given gets through; the client label never does (PR 12 Codex cycle 2).
   */
  leaseGate<T>(run: () => Promise<T>): Promise<T> {
    const lease = this.options.lease;
    if (lease === undefined) return run();
    const who = (this.clientIdFn ?? this.options.clientId)?.()?.replace(/[^\w .@/-]/g, "").slice(0, 60) ?? "";
    return lease.run(who, run, this.holdScope.getStore()?.lease);
  }

  /** `sendRequest` as a value, for helpers that send requests of their own (the animation switch). */
  private readonly leased: TaplineHost["request"] = (...args) => this.sendRequest(...args);

  /** Every request to the app goes through the lease check: a run's call whose lease ran out after it was queued sends nothing (§22.3). */
  private sendRequest(...args: Parameters<TaplineHost["request"]>): ReturnType<TaplineHost["request"]> {
    try {
      this.checkLease();
    } catch (error) {
      return Promise.reject(error);
    }
    // Inside an explore run every request that is not a read is held to the run's rules, whoever sent it: the explorer's own move,
    // a saved route's step, a drive leg, a recovery or a reset (§25.5). Nothing can reach the app around this one gate.
    const scope = this.exploreScope.getStore();
    if (scope?.run.signal?.aborted === true) return Promise.reject(new TaplineError("timeout", "the check ran out of time, so nothing more is sent."));
    const [method, params, options] = args;
    const dry = typeof params === "object" && params !== null && (params as { dryRun?: unknown }).dryRun === true;
    if (scope === undefined || options?.internal === true || dry || EXPLORE_READS.has(method)) return this.host.request(...args);
    return this.exploreSend(scope, args);
  }

  /** The explore gate: the budget, then the typing rules; counts the request it lets through. */
  private async exploreSend(scope: ExploreScope, args: Parameters<TaplineHost["request"]>): Promise<unknown> {
    const [method, rawParams, options] = args;
    const run = scope.run;
    // The flip back of a toggle is one move with the flip (§25.7): the budget never splits them.
    const budget = scope.restoring === true ? null : this.exploreBudget(run);
    if (budget !== null) throw new TaplineError("not_allowed", `explore's ${budget} budget is used up, so nothing more is sent (explore budget: ${budget}).`);
    // A pipelined move carries the request it makes inside it.
    const inner = method === "move" && typeof rawParams === "object" && rawParams !== null ? (rawParams as { method?: unknown }).method : method;
    let params = rawParams;
    // Every touch (a press, a scroll, typing, a swipe) is made from a place that is not protected, and a scroll aims at a view that is not skipped.
    if (typeof inner === "string" && EXPLORE_TOUCHES.has(inner)) await this.exploreTouchGate(inner, method, rawParams, options?.sessionId);
    if (inner === "type") {
      if (method !== "type") throw new TaplineError("not_allowed", "explore types only through its own fill, never inside a drive (explore skip: policy).");
      params = await this.exploreTyping(scope, rawParams, options?.sessionId);
    }
    run.used += 1;
    return this.host.request(method, params, options);
  }

  /**
   * The floor on where a touch is made and what a scroll moves (§25.5), for every request that goes through the gate: the place the app
   * stands on (its stored or person-given name, its route and the live title of the screen) must not be an account, privacy or security
   * place, and a scroll's recipient (the scroll view itself, inherited skip marks included) must pass the whole floor. `back`, links,
   * reloads and commands are not touches: the way out of such a place is always open.
   */
  private async exploreTouchGate(inner: string, method: string, rawParams: unknown, sessionId: string | undefined): Promise<void> {
    const session = (sessionId !== undefined ? this.host.sessions().find((s) => s.id === sessionId) : undefined) ?? this.host.current();
    if (session === undefined) return;
    let raw: unknown;
    try {
      raw = await this.sendRequest("tree", { peek: true }, { sessionId: session.id, internal: true });
    } catch {
      throw new TaplineError("not_allowed", "explore can't tell which place the app is on, so it touches nothing (explore skip: floor).");
    }
    const read = treeResultSchema.safeParse(raw);
    if (!read.success) throw new TaplineError("not_allowed", "explore can't read the screen it would touch (explore skip: floor).");
    const tree = read.data;
    const map = this.mapOf(session);
    const named = map === undefined ? null : await placeSeen({ capabilities: [], latest: () => undefined, request: async () => raw }, map);
    const route = [...(tree.place?.route ?? []), ...(tree.route?.names ?? [])];
    const word = protectedPlaceWord(named ?? "", route, screenTitles(tree.elements));
    if (word !== null) throw new TaplineError("not_allowed", `explore touches nothing on a protected place (policy word ${JSON.stringify(word)}) (explore skip: floor).`);
    if (inner !== "scroll") return;
    const params = method === "move" && typeof rawParams === "object" && rawParams !== null ? (rawParams as { params?: unknown }).params : rawParams;
    const asked: Record<string, unknown> = typeof params === "object" && params !== null ? { ...(params as Record<string, unknown>) } : {};
    let views: TreeElement[];
    if (session.capabilities.includes("dryRun")) {
      const resolved = await this.resolveForPolicy(session, "scroll", asked);
      if (resolved.kind === "error") throw new TaplineError("not_allowed", `explore won't scroll: ${resolved.text.replace(/^Error \w+:\s*/, "")} (explore skip: floor).`);
      views = resolved.raw;
    } else {
      // An app with no dry runs can't say which view moves: every scroll view on the screen must pass.
      views = tree.elements.filter((el) => roleOf(el) === "scroll");
    }
    const rules = this.exploreRules(session);
    for (const view of views) {
      const hit = recipientVerdict(view, rules, false);
      if (hit !== null) {
        const word = hit.word !== undefined ? ` (policy word ${JSON.stringify(this.host.redactOut(hit.word))})` : "";
        throw new TaplineError("not_allowed", `explore won't scroll ${this.shortName(this.host.redactOut(view), false)}${word} (explore skip: ${hit.why}).`);
      }
    }
  }

  /** `steps` or `minutes` when the run's budget is used up, else null. */
  private exploreBudget(run: ExploreRun): "steps" | "minutes" | null {
    if (run.used >= run.steps) return "steps";
    const waited = (this.options.control?.waitedMs() ?? 0) - run.waited0;
    if ((this.clock() - run.startedAt - waited) / 60_000 >= run.minutes) return "minutes";
    return null;
  }

  /**
   * The one way explore types (§25.6): the explorer's own `type` move, into a field that is verified plain, never marked skip, never a
   * password or card field, with no submit. Every other typing (a route's, a drive's) is refused. Returns the request's params with the
   * plain-field guard added, and registers the text for redaction before it is sent.
   */
  private async exploreTyping(scope: ExploreScope, raw: unknown, sessionId: string | undefined): Promise<unknown> {
    if (scope.mayType !== true) throw new TaplineError("not_allowed", "explore types only through its own fill, never in a route or a drive leg (explore skip: policy).");
    if (typeof raw !== "object" || raw === null) throw new TaplineError("not_allowed", "explore won't type that (explore skip: policy).");
    const params: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    if (params["submit"] === true) throw new TaplineError("not_allowed", "explore never presses return while it types (explore skip: may_submit).");
    // One typing request per move: no second one goes through.
    scope.mayType = false;
    const session = this.host.current();
    if (session === undefined || (sessionId !== undefined && session.id !== sessionId)) throw new TaplineError("not_connected", "the app changed while explore was about to type; nothing was typed.");
    // The guard: the SDK refuses a field that isn't plain; the dry run resolves the real field and asks the same, so a secure or unknown field is never typed.
    const checked = await this.resolveForPolicy(session, "type", { ...params, text: "", kind: "plain" });
    if (checked.kind === "error") throw new TaplineError("not_allowed", `explore won't type: ${checked.text.replace(/^Error \w+:\s*/, "")} (explore skip: floor).`);
    const field = checked.raw[0];
    if (field === undefined) throw new TaplineError("not_allowed", "explore won't type: the field could not be resolved (explore skip: floor).");
    const hit = recipientVerdict(field, this.exploreRules(session), false) ?? (field.role === "input" ? null : ({ why: "floor", word: "not an input" } satisfies FloorHit));
    if (hit !== null) throw new TaplineError("not_allowed", `explore won't type into ${this.shortName(this.host.redactOut(field), false)}${hit.word !== undefined ? ` (policy word ${JSON.stringify(hit.word)})` : ""} (explore skip: ${hit.why}).`);
    const text = typeof params["text"] === "string" ? params["text"] : "";
    if (text !== "" && !scope.run.typed.includes(text)) {
      scope.run.typed = [...scope.run.typed, text];
      scope.run.ingress?.add(text);
    }
    return { ...params, kind: "plain" };
  }

  /** The floor's rules for this app: the union of the global and the app's policy lists, the user's skip list and `submit` ids. */
  private exploreRules(session: SessionInfo): FloorRules {
    const lists = exploreLists(this.policy, session.app);
    const settings = exploreSettings(this.policy);
    return { policy: [...lists.confirm, ...lists.block], skip: settings.skip, submit: settings.submit };
  }

  /** Redaction for everything an explore run writes: the vault's values, every text the run typed, and this session's one-time codes. */
  private exploreScrub(run: ExploreRun, text: string): string {
    return this.host.redactOut(this.scrubSecrets(text, { values: run.typed, token: TYPED }));
  }

  /** Whether the screen as it is now has a text input (read without changing anything). Unreadable counts as yes: the strict side. */
  private async screenHasInput(session: SessionInfo): Promise<boolean> {
    try {
      const read = treeResultSchema.safeParse(await this.sendRequest("tree", { peek: true }, { sessionId: session.id, internal: true }));
      return !read.success || read.data.elements.some((el) => roleOf(el) === "input");
    } catch {
      return true;
    }
  }

  /** Throws `lease_lost` when this call carries a lease credential that is not the standing holder's (right before something is sent). */
  checkLease(): void {
    this.options.lease?.assertCurrent(this.holdScope.getStore()?.lease);
  }

  /** The MCP server gives the dialog once it can ask its client (the client's capabilities are known after initialize). */
  setDialogs(dialogs: Dialogs | undefined): void {
    this.dialogs = dialogs;
  }

  /** The agent's client id for the call log; the MCP server passes the client's name once it is known. */
  setClientId(read: () => string | undefined): void {
    this.clientIdFn = read;
  }

  /** A call refused before it reached its tool (an unknown argument): numbered and logged like any other, so the report counts it. */
  rejectedCall(tool: string, args: unknown, answer: CallToolResult): CallToolResult {
    const result = this.loggedCall(tool, args, () => answer);
    return result instanceof Promise ? answer : result;
  }

  /** Numbers a call of the agent and logs it when its answer is known (§16.1). Calls within a call (`run`'s steps) are part of it. */
  private loggedCall(
    tool: string,
    args: unknown,
    run: () => CallToolResult | Promise<CallToolResult>,
  ): CallToolResult | Promise<CallToolResult> {
    if (this.actionLog === null || this.callScope.getStore() !== undefined) return run();
    const afterScrolls = this.prevCallTool === "scroll";
    if (tool === "scroll" && !afterScrolls) this.scrollBase = this.listBase;
    this.prevCallTool = tool;
    const state: CallState = {
      call: ++this.callCount,
      tool,
      afterScrolls,
      thin: this.thinScope.getStore() === true,
      fast: this.fastNow(),
      entries: [],
    };
    const began = new Date();
    let result: CallToolResult | Promise<CallToolResult>;
    try {
      result = this.callScope.run(state, run);
    } catch (error) {
      this.flushCall(state, args, began, undefined);
      throw error;
    }
    if (result instanceof Promise) {
      return result.then(
        (answer) => {
          this.flushCall(state, args, began, answer);
          return answer;
        },
        (error: unknown) => {
          this.flushCall(state, args, began, undefined);
          throw error;
        },
      );
    }
    this.flushCall(state, args, began, result);
    return result;
  }

  private flushCall(state: CallState, args: unknown, began: Date, answer: CallToolResult | undefined): void {
    if (this.actionLog === null) return;
    const said = (answer?.content ?? []).map((block) => (block.type === "text" ? block.text : ""));
    const size = said.reduce((sum, part) => sum + part.length, 0);
    const failed = answer === undefined || answer.isError === true;
    const input = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
    const listed =
      LISTING_TOOLS.has(state.tool) && !failed && input["look"] !== false && input["dry_run"] !== true && !(state.tool === "app_command" && input["name"] === undefined);
    const client = (this.clientIdFn ?? this.options.clientId)?.()?.replace(/[^\w .@/-]/g, "").slice(0, 60);
    const common = {
      session: this.sessionTag,
      call: state.call,
      ...(client !== undefined && client !== "" ? { client } : {}),
      size,
      v: 2 as const,
      ...(state.thin ? { via: "call" as const } : {}),
      ...(state.fast ? { animations: "fast" as const } : {}),
    };
    const code = failed ? /^Error (\w+):/.exec(said.join("\n"))?.[1] : undefined;
    if (state.entries.length > 0) {
      // Actions that went through, in a call that failed after them (an expectation that didn't hold): the call's
      // own outcome goes with them, so the report doesn't count it as a success (Codex review of 1.4.0).
      const callFailed = failed && state.entries.every(({ entry }) => entry.ok) ? { call_failed: code ?? "internal" } : {};
      for (const { entry, at } of state.entries) {
        // `at` is when the action ended. The entry says when it began and how long it took (§16.1), reads and actions alike.
        const ms = entry.ms ?? Math.max(0, at.getTime() - began.getTime());
        const start = entry.ms !== undefined ? new Date(at.getTime() - entry.ms) : began;
        this.actionLog.write({ ...entry, ms, ...common, ...callFailed, ...(listed ? { listed: true } : {}) }, start);
      }
      return;
    }
    // A call that logged no action: a read, or an action refused before it began (then without `kind`).
    const session = this.host.current();
    const lookArgs = state.tool === "look" ? pictureArgs(input) : undefined;
    this.actionLog.write(
      {
        by: "agent",
        tool: state.tool,
        ...(READ_TOOLS.has(state.tool) ? { kind: "read" as const } : {}),
        // the target only (as given); typed text, pictures and log text never
        ...(loggedTarget(args).target !== undefined ? { target: loggedTarget(args).target } : {}),
        ok: !failed,
        ...(code !== undefined ? { code } : {}),
        ms: Date.now() - began.getTime(),
        ...(session !== undefined ? { app: session.app.id ?? session.app.name } : {}),
        ...common,
        ...(listed ? { listed: true } : {}),
        ...(lookArgs !== undefined ? { look_args: lookArgs } : {}),
        // A compare_screen that matched with named changes: the report asks the agent to look at them (1.13.1 item 2).
        ...(state.tool === "compare_screen" && !failed && /^Matches the reference ".*" \([\d.]+% changed, under the /.test(said.join("\n")) ? { matched_with_changes: true } : {}),
      },
      began,
    );
  }

  /**
   * Whether a touch's target was in the list the agent had before its run of scrolls: true (it was), false (it
   * wasn't), undefined (can't be known: no list, a point, or a list that only changed since).
   */
  private knownBeforeScrolls(params: unknown): boolean | undefined {
    const base = this.scrollBase;
    const target = typeof params === "object" && params !== null ? (params as { target?: unknown }).target : undefined;
    if (base === undefined || typeof target !== "object" || target === null) return undefined;
    const t = target as Record<string, unknown>;
    if (!["ref", "testID", "label", "text"].some((key) => typeof t[key] === "string")) return undefined;
    if (base.unseen) return undefined;
    if (candidatesFor(target, base.elements).length > 0) return true;
    return base.stale ? undefined : false;
  }

  /** `map` (AGENT-TOOLS 1.13 §18.8): reads and edits the app's map; never touches the app. The work is in mapcmd.ts. */
  async map(args: Shape<"map">): Promise<CallToolResult> {
    const refused = mapArgsError(args);
    if (refused !== null) return fail(`Error bad_params: ${refused}`);
    if (this.options.maps === undefined) return fail("Error unsupported: this server keeps no maps.");
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const map = this.mapOf(session);
    if (map === undefined) return fail("Error unsupported: this app reports no id of its own, so it has no map.");
    const source = this.placeSource(session);
    const answer = await runMap(args, {
      map,
      app: { name: session.app.name, id: session.app.id },
      here: async () => (await placeNow(source, map))?.place ?? null,
      known: async () =>
        session.capabilities.includes("places") ? map.ensureKnown(session.id, () => source.request("places", {})) : (map.knownPlaces() ?? { source: "none", places: [] }),
      lists: listsFor(this.policy, session.app),
      accounts: this.options.accounts?.store?.names() ?? [],
    });
    return answer.error ? fail(answer.text) : text(answer.text);
  }

  /** `drive` (AGENT-TOOLS 1.13 §18.4): takes the app to a place along the map's roads. The work is in drive.ts. */
  async drive(args: Shape<"drive">, options: { asStep?: boolean } = {}): Promise<CallToolResult> {
    const refused = driveArgsError(args);
    if (refused !== null) return fail(`Error bad_params: ${refused}`);
    if (this.options.maps === undefined) return fail("Error unsupported: this server keeps no maps.");
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const map = this.mapOf(session);
    if (map === undefined) return fail("Error unsupported: this app reports no id of its own, so it has no map.");
    // As a `run` step a drive builds no screen of its own: the batch answers once (9.1).
    // `look: false` (1.13.3) answers the first line only on arrival; a step's own `look` is ignored (§9.1).
    const { look: askedLook, ...withoutLook } = args;
    // With `then`, the run steps answer and take the `look` (drive.ts afterThen).
    const quietLook = options.asStep !== true && askedLook === false && args.dry_run !== true && args.then === undefined;
    const given: Shape<"drive"> & { quiet?: boolean } =
      options.asStep === true ? { ...withoutLook, quiet: true } : quietLook ? { ...args, quiet: true } : args;
    const services = this.driveServices(session, map);
    const routes = this.routeServices(session, args.account, args.brief);
    const drove = (): Promise<CallToolResult> => (given.route !== undefined ? driveRoute(services, routes, given) : driveTo(services, given, routes));
    // A batch keeps only `Note:` lines of a step's answer, so a repair is said as one there.
    const go = async (): Promise<CallToolResult> => {
      const answer = await drove();
      if (quietLook && answer.isError !== true) {
        // No list and no changes were given: the next answer's changes cover this call too, and says so.
        this.markListUnseen();
        this.unlistedActions.set(session.id, (this.unlistedActions.get(session.id) ?? 0) + 1);
      }
      if (options.asStep !== true) return answer;
      return { ...answer, content: answer.content.map((block) => (block.type === "text" ? { ...block, text: block.text.replace(/^Road repaired/gm, "Note: Road repaired") } : block)) };
    };
    // A wait for a person's OK is this call's own, as for `run`.
    return this.holdScope.getStore() !== undefined ? go() : this.holdScope.run({ ms: 0 }, go);
  }

  /** Whether a journey's user's eyes keep a drive to roads: unless its `allow` names `drive` (AGENT-TOOLS 1.13 18.12). */
  private driveRoadsOnly(): boolean {
    const journey = this.journeyRun;
    return journey !== undefined && journey.userEyes && !journey.allows(DRIVE_ALLOWED);
  }

  /** What drive needs from this host: reads, and one move that passes the policy and a person's OK like a single call. */
  private driveServices(session: SessionInfo, map: AppMap): DriveServices {
    const source = this.placeSource(session);
    return {
      map,
      source,
      capabilities: session.capabilities,
      tapsOnly: this.driveRoadsOnly(),
      eyes: this.userEyes(),
      moved: (tool) => this.journeyRun?.noteMove(tool),
      aborted: () => this.holdScope.getStore()?.signal?.aborted === true,
      clock: this.clock,
      sleep: this.sleep,
      describe: describeError,
      known: async () => (session.capabilities.includes("places") ? map.ensureKnown(session.id, () => source.request("places", {})) : (map.knownPlaces() ?? { source: "none", places: [] })),
      tree: async () => {
        // In a user's eyes a drive reads only what is on the glass (17.1).
        const tree = treeResultSchema.safeParse(await this.sendRequest("tree", this.userEyes() ? { glass: true } : {}, { sessionId: session.id }));
        if (!tree.success) throw new TaplineError("internal", "the app returned an element list the host could not read.");
        return tree.data;
      },
      candidates: (target, elements) => candidatesFor(target, elements),
      touch: (call) => this.driveTouch(session, call),
      reflexes: (at) => this.checkReflexes(session, at),
      screen: (line, brief) => this.withLook(session, line, false, this.briefOn(brief)),
    };
  }

  /** Runs what a saved route does with its name in scope: a grant that names the route covers touches made inside it (§19.1). */
  private inRoute<T>(route: string | undefined, run: () => T, draftsOnly = false): T {
    if (route === undefined) return run();
    const drafts = draftsOnly || this.draftsScope.getStore() === true;
    return this.routeScope.run([...(this.routeScope.getStore() ?? []), route], () => this.draftsScope.run(drafts, run));
  }

  /** Whether the saved route of that name in this app's map carries `"draftsOnly": true` (§18.5). */
  private routeDraftsOnly(session: SessionInfo, route: string | undefined): boolean {
    const map = route === undefined ? undefined : this.mapOf(session);
    return route !== undefined && map !== undefined && loadRoute(map.folder(), route)?.draftsOnly === true;
  }

  /**
   * The policy's lists for a touch. In a drafts-only route (§21.3) the words that reach other people ask a person whatever the
   * policy file lists, so that every such touch stops at a draft.
   */
  private touchLists(session: SessionInfo): { confirm: string[]; block: string[] } {
    // `explore` (AGENT-TOOLS 1.15 §25.5): the floor is every touch's confirm list, whatever the policy file says (`"confirm": []`, an
    // app's own empty lists and --no-policy don't lower it): the union of the built-in words and the global and the app's lists.
    if (this.exploreScope.getStore() !== undefined) {
      const union = exploreLists(this.policy, session.app);
      return { confirm: [...new Set([...FLOOR_WORDS, ...union.confirm, ...exploreSettings(this.policy).skip])], block: union.block };
    }
    const lists = listsFor(this.policy, session.app);
    return this.draftsScope.getStore() === true ? { confirm: [...lists.confirm, ...REACH_WORDS], block: lists.block } : lists;
  }

  private routeServices(session: SessionInfo, account: string | undefined, brief: boolean | undefined): RouteServices {
    return {
      accounts: this.options.accounts?.store ?? undefined,
      probeAccount: (field, named) => {
        const used = this.accountText(field.startsWith("${") ? field : "$" + "{account." + field + "}", named, session);
        return used !== null && !used.ok ? used.message : null;
      },
      runSteps: (steps, look, route) => this.inRoute(route, () => this.run({ steps, account, brief, ...(look ? {} : { look: false }) }), this.routeDraftsOnly(session, route)),
      checkSteps: (steps) => {
        // The call's account is the steps' default account here too, as when `run` runs them.
        const before = this.runAccount;
        this.runAccount = account;
        try {
          return this.checkSteps(steps);
        } finally {
          this.runAccount = before;
        }
      },
    };
  }

  /**
   * One move of a drive. The policy and a person's OK are checked as for the same call alone, before the request is sent (§18.4):
   * against the element the drive already read when there is one, else by a dry run. With the app's `move` capability the
   * request also waits for the next target and holds the touch to the element that was checked (`guard`).
   */
  private async driveTouch(session: SessionInfo, call: TouchCall): Promise<TouchOutcome> {
    this.logExtra = undefined;
    this.actionStartedAt = Date.now();
    const lists = this.touchLists(session);
    const { tool, method, params } = call;
    const short = tool === "swipe" && Math.hypot(Number(params["x1"]) - Number(params["x0"]), Number(params["y1"]) - Number(params["y0"])) < 10;
    // A jump's link comes from the map, which an agent can write: its path words are checked as a link-shaped element (§11).
    const url = typeof params["url"] === "string" ? params["url"] : "";
    // A link that can't be fully decoded can't be read for words: it goes to a person (the label is the reason).
    let known =
      tool === "open_url"
        ? [{ ref: "", role: "link", text: linkWords(url), ...(linkReadable(url) ? {} : { label: UNREADABLE_LINK }) } satisfies TreeElement]
        : call.known;
    const guardedTool = tool === "tap" || tool === "long_press" || tool === "toggle" || tool === "open_url" ? tool : short ? "swipe" : null;
    const checked = guardedTool !== null && (lists.confirm.length > 0 || lists.block.length > 0);
    let guard = call.guard;
    // What the drive read may hide account values; the policy and the guard get the raw element (see resolveForPolicy).
    let knownRaw: TreeElement[] | undefined;
    // The policy and the guard are about the element that receives the touch, which may be an ancestor of the one named (§18.4).
    if (call.known !== undefined && (tool === "tap" || tool === "long_press" || tool === "toggle") && (checked || guard !== undefined)) {
      const named = call.known[0];
      const needs = tool === "tap" ? "press" : tool === "long_press" ? "longPress" : "toggle";
      // With account values hidden in what the drive read, the policy and the guard need the raw element: ask the app (a dry run).
      if (named !== undefined && (this.host.redacting || !(named.actions ?? []).includes(needs))) {
        // Not an actor itself (or hidden): the app's own tap resolution (a dry run) says which element takes the touch.
        const resolved = await this.resolveForPolicy(session, method, params);
        if (resolved.kind === "error") {
          this.showAction("agent", method, undefined, params, resolved.code, resolved.reason);
          return { kind: "stop", answer: fail(resolved.text) };
        }
        if (resolved.elements.length !== 1 || resolved.elements[0] === undefined || resolved.raw[0] === undefined) return { kind: "stop", answer: fail("Error not_found: the touch's target could not be resolved for the policy check.") };
        known = resolved.elements;
        knownRaw = resolved.raw;
        if (guard !== undefined) guard = guardOf(resolved.raw[0]);
      }
    }
    let waited: Waited | null = null;
    if (guardedTool !== null && checked) {
      const pair = known === undefined ? undefined : { elements: known, raw: knownRaw ?? known };
      const ready = await this.awaitOk(session, guardedTool, method, params, lists, pair);
      if ("stop" in ready) return { kind: "stop", answer: ready.stop };
      waited = ready.waited;
    }
    let granted: OkVia | undefined;
    let sentDraft = false;
    let covered: GrantUse | undefined;
    const wire = call.pipelined
      ? { method: "move", params: { method, params, ...(guard !== undefined ? { guard } : {}), ...(call.next !== undefined ? { next: call.next } : {}) } }
      : { method, params };
    const timeoutMs = call.pipelined ? (call.next?.capMs ?? 0) + 15_000 : undefined;
    let raw: unknown;
    let moveSent = false;
    try {
      const run = async (): Promise<unknown> => {
        this.setOk(false);
        if (guardedTool !== null && checked) {
          // After a wait for a person, the element is read again: a change during the wait must be caught (§11.3).
          const gate = await this.gatePreflight(session, guardedTool, method, params, lists, waited, waited !== null && tool !== "open_url" ? undefined : known === undefined ? undefined : { elements: known, raw: knownRaw ?? known });
          if ("stop" in gate) throw new PolicyStop(gate.stop);
          granted = gate.via;
          sentDraft = gate.draft === true;
          covered = gate.grant;
        }
        moveSent = true;
        try {
          return await this.sendRequest(wire.method, wire.params, { sessionId: session.id, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
        } catch (error) {
          if (notDelivered(error)) moveSent = false;
          throw error;
        }
      };
      raw = await this.agentTurn(run);
    } catch (error) {
      await this.dropPreUse(waited);
      if (error instanceof PolicyStop) return { kind: "stop", answer: error.answer };
      // The touch surely wasn't made: the grant's use is given back; a sent or uncertain one stays counted (§19.4).
      if (covered !== undefined && !moveSent) await this.releaseGrant(covered);
      this.logExtra = undefined;
      const code = error instanceof TaplineError ? error.code : "internal";
      this.showAction("agent", method, undefined, params, code, error instanceof TaplineError ? reasonOf(error.code, error.message) : undefined);
      return { kind: "error", code, message: error instanceof TaplineError ? error.message : describeError(error) };
    }
    const done = call.pipelined && typeof raw === "object" && raw !== null && "done" in raw ? (raw as { done: unknown }).done : raw;
    const driven = this.exploreScope.getStore();
    if (driven !== undefined) driven.count += 1;
    this.noteTouch(method, params, done);
    this.showAction("agent", method, done, params);
    if (granted !== undefined) this.journeyRun?.noteOk(granted);
    if (covered !== undefined) this.grantNotes.getStore()?.push(covered.line);
    // A jump is a shortcut a user doesn't have; a journey whose `allow` names drive says so in its report (AGENT-TOOLS 1.13 18.12).
    if (call.of === "drive" && tool === "open_url" && this.journeyRun?.userEyes === true) this.journeyRun.noteShortcut({ tool: "open_url", what: url });
    const moved = call.pipelined ? parseMoveResult(raw) : { place: null };
    return { kind: "done", place: moved.place, ...("next" in moved && moved.next !== undefined ? { next: moved.next } : {}), ...(granted !== undefined ? { via: granted } : {}), ...(sentDraft ? { sent: true as const } : {}) };
  }

  // -- explore (AGENT-TOOLS 1.15 §25): the search is in explore.ts, what it may touch in explorefloor.ts

  /** An explore is running in this object: a second one waits for it to end. */
  private exploring = false;

  /**
   * Explore and a recording, a replay or a journey never overlap, from either side: this is the check of the second side.
   * What the explorer itself runs (its routes, its drives, a repair's trials) is inside its scope and is not a rival.
   */
  private exploreExcludes(what: string): string | null {
    if (this.exploring && this.exploreScope.getStore() === undefined) return `Error bad_params: ${what} can't start while an explore is running; wait for it to end.`;
    return null;
  }

  /** `explore`: drives the places nobody has driven, saves them to the map and reports what broke on the way. */
  async explore(args: Shape<"explore"> = {}): Promise<CallToolResult> {
    return (await this.exploreRun(args)).answer;
  }

  /** `explore` with what the command line needs to pick its exit code: the outcome and where the report is. */
  async exploreRun(args: Shape<"explore"> = {}): Promise<{ answer: CallToolResult; outcome?: ExploreOutcome; reportPath?: string }> {
    // Reserved before anything else is read or awaited, held for the whole run and released in `finally`: a record, replay or journey that starts
    // meanwhile sees it, and a second explore answers busy.
    if (this.exploring) return { answer: fail("Error busy: an explore is already running here; wait for it to end.") };
    this.exploring = true;
    try {
      return await this.exploreHeld(args);
    } finally {
      this.exploring = false;
    }
  }

  private async exploreHeld(args: Shape<"explore">): Promise<{ answer: CallToolResult; outcome?: ExploreOutcome; reportPath?: string }> {
    const refuse = (message: string): { answer: CallToolResult } => ({ answer: fail(message) });
    if (args.guide !== undefined && args.guide !== "none") return refuse("Error unsupported: guide isn't offered yet; explore chooses by itself.");
    const budget = { minutes: args.minutes ?? EXPLORE_DEFAULTS.minutes, steps: args.steps ?? EXPLORE_DEFAULTS.steps, depth: args.depth ?? EXPLORE_DEFAULTS.depth };
    for (const name of ["minutes", "steps", "depth"] as const) {
      const [low, high] = EXPLORE_LIMITS[name];
      const value = budget[name];
      const whole = name !== "minutes";
      if (!Number.isFinite(value) || value < low || value > high || (whole && !Number.isInteger(value))) {
        return refuse(`Error bad_params: ${name} is ${whole ? "a whole number" : "a number"} from ${low} to ${high}, not ${String(value)}.`);
      }
    }
    const session = this.host.current();
    if (session === undefined) return { answer: this.notConnected() };
    if (this.options.maps === undefined) return refuse("Error unsupported: this server keeps no maps.");
    const map = this.mapOf(session);
    if (map === undefined) return refuse("Error unsupported: this app reports no id of its own, so it has no map.");
    if (this.options.exploreDir === undefined) return refuse("Error unsupported: this server keeps no explore reports.");
    if (this.journeyRun !== undefined || this.journeyBusy !== undefined) return refuse("Error bad_params: explore can't run during a journey; stop the journey first.");
    if (this.recordingState !== null || this.replayingState || this.rivals > 0) return refuse("Error bad_params: explore can't run while a script is recorded or replayed; finish that first.");
    const fixtureFill = fixtureRef(args.fill ?? "none");
    if (fixtureFill !== null) {
      // `fill: "fixture:<name>.<field>"` (§25.2, v1.16): a vault fixture marked `"explore": true` that has the field.
      const store = this.options.accounts?.store ?? null;
      if (store === null || store.kindOf(fixtureFill.name) !== "fixture") return refuse(`Error bad_params: no fixture "${fixtureFill.name}" in the vault.`);
      if (store.exploreMarked?.(fixtureFill.name) !== true) {
        return refuse(`Error bad_params: fixture "${fixtureFill.name}" isn't marked "explore": true in the vault file, so explore doesn't type it.`);
      }
      const resolved = store.resolveEntry(fixtureFill.name, fixtureFill.field, session.app.id ?? session.app.name);
      if (!resolved.ok) return refuse(`Error bad_params: ${resolved.message}`);
    }
    if (args.account !== undefined) {
      const store = this.options.accounts?.store ?? null;
      if (store === null || !store.names().includes(args.account)) return refuse(`Error bad_params: no account "${args.account}" in the vault.`);
      if (store.kindOf(args.account) !== "account" || store.exploreMarked?.(args.account) !== true) {
        return refuse(`Error bad_params: account "${args.account}" isn't marked "explore": true in the vault file, so explore doesn't use it.`);
      }
    }
    const wall = this.options.wallClock ?? Date.now;
    let folder: ReturnType<typeof openRunFolder>;
    try {
      folder = openRunFolder(this.options.exploreDir, session.app.id ?? session.app.name, new Date(wall()));
    } catch (error) {
      return refuse(`Error internal: explore couldn't make its report folder: ${error instanceof Error ? error.message : String(error)}`);
    }
    const exploreArgs: ExploreArgs = {
      ...budget,
      fill: (args.fill ?? EXPLORE_DEFAULTS.fill) as ExploreFill,
      continue: args.continue ?? EXPLORE_DEFAULTS.continue,
      ...(args.from !== undefined ? { from: args.from } : {}),
      ...(args.focus !== undefined ? { focus: args.focus } : {}),
      ...(args.account !== undefined ? { account: args.account } : {}),
    };
    const progress = this.holdScope.getStore()?.progress;
    const run: ExploreRun = { used: 0, steps: budget.steps, minutes: budget.minutes, startedAt: this.clock(), waited0: this.options.control?.waitedMs() ?? 0, typed: [], ingress: this.host.typedRun() };
    const explorer = new Explorer(this.exploreHost(session, map, wall, progress, run), { args: exploreArgs, folder, graceMs: this.options.exploreGraceMs ?? 60_000 });
    // Calls inside the call add no crash note or wait of their own: the report says what happened.
    let result: Awaited<ReturnType<Explorer["run"]>>;
    try {
      result = await this.noteScope.run(true, () => explorer.run());
    } finally {
      run.ingress?.end();
    }
    if (!isOutcome(result)) return refuse(result.error);
    const reportPath = writeExploreReport(folder, result.report, (text) => this.exploreScrub(run, text), result.detail);
    const where = reportPath ?? `${folder.dir}`;
    const shown = where.startsWith(homedir()) ? `~${where.slice(homedir().length)}`.replace(/\\/g, "/") : where;
    const stopped = result.report.stopped;
    if (stopped === "paused" || stopped === "busy" || stopped === "locked") {
      const why = stopped === "paused" ? "The user paused the agent in the live viewer." : stopped === "busy" ? "A person is using the app in the live viewer." : "The phone is locked.";
      const done = `Done: ${result.report.used.steps} steps, ${result.report.coverage.places} places. Left at: ${result.leftAt ?? "unknown"}. Report: ${shown}`;
      return { answer: fail(`Error ${stopped}: ${why} ${done}`), outcome: result, ...(reportPath !== null ? { reportPath } : {}) };
    }
    const lines = answerLines(result.report, result.findingsLine, shown, result.detail);
    return { answer: text(lines.join("\n")), outcome: result, ...(reportPath !== null ? { reportPath } : {}) };
  }

  /** Runs one move inside the explore scope: the one gate every touch goes through (§25.1, §25.5). Used by the explorer and by the reproduction check. */
  private exploreWithin(run: ExploreRun) {
    return async <T>(go: () => Promise<T>, restoring = false, mayType = false): Promise<{ value: T; count: number; last: { method: string; result: unknown } | undefined }> => {
      const scope: ExploreScope = { count: 0, run, ...(restoring ? { restoring: true } : {}), ...(mayType ? { mayType: true } : {}) };
      const before = run.used;
      const value = await this.exploreScope.run(scope, go);
      // The steps a move cost are the requests the gate let through, successful or not: the same count the budget holds.
      return { value, count: run.used - before, last: scope.last };
    };
  }

  /** What the explorer needs from this host. Every move is an ordinary action of this tool, inside the explorer's scope (§25.1, §25.5). */
  private exploreHost(session: SessionInfo, map: AppMap, wall: () => number, progress: ((line: string, steps: number) => void) | undefined, run: ExploreRun): ExploreHost {
    const identity = identityOf(session);
    const live = (): SessionInfo | undefined => {
      const now = this.host.current();
      return now !== undefined && identityOf(now) === identity ? now : undefined;
    };
    const sleepMs = (ms: number): Promise<void> => this.sleep(ms);
    const within = this.exploreWithin(run);
    const refusal = (answer: CallToolResult): { code: string; message: string; text: string } => {
      const said = answerText(answer);
      const m = /^Error (\w+):\s*([\s\S]*)$/.exec(said);
      return { code: m?.[1] ?? "internal", message: m?.[2] ?? said, text: said };
    };
    const outcomeOf = (answer: CallToolResult, count: number, last: { method: string; result: unknown } | undefined): MoveOutcome => {
      if (answer.isError === true) return { ok: false, used: count, ...refusal(answer) };
      const result = last?.result;
      const settled = typeof result === "object" && result !== null && "settledMs" in result ? (result as { settledMs: unknown }).settledMs : undefined;
      const value = typeof result === "object" && result !== null && "value" in result ? (result as { value: unknown }).value : undefined;
      return { ok: true, used: count, text: answerText(answer), ...(typeof settled === "number" && Number.isFinite(settled) ? { settledMs: settled } : {}), ...(value !== undefined ? { value } : {}) };
    };
    const rulesNow = (): FloorRules => this.exploreRules(session);
    const host: ExploreHost = {
      now: () => this.clock(),
      waitedMs: () => this.options.control?.waitedMs() ?? 0,
      wall: () => new Date(wall()),
      info: () => {
        const now = live() ?? session;
        const platform = now.device.platform === "ios" ? "iOS" : now.device.platform === "android" ? "Android" : now.device.platform;
        const build = now.app.build ?? "";
        return {
          app: now.app.id,
          name: now.app.name,
          appVersion: now.app.version ?? "",
          build: /\((.*)\)\s*$/.exec(build)?.[1] ?? build,
          buildLabel: map.currentBuild(),
          device: { model: now.device.model ?? now.device.name ?? "unknown", os: `${platform}${now.device.osVersion !== undefined ? ` ${now.device.osVersion}` : ""}` },
        };
      },
      map,
      known: async () => {
        const now = live() ?? session;
        return now.capabilities.includes("places") ? map.ensureKnown(now.id, () => this.sendRequest("places", {}, { sessionId: now.id })) : (map.knownPlaces() ?? { source: "none", places: [] });
      },
      tree: async () => {
        const now = live();
        if (now === undefined) return null;
        try {
          const parsed = treeResultSchema.safeParse(await this.sendRequest("tree", {}, { sessionId: now.id }));
          if (!parsed.success) return null;
          // The explorer has just looked: a person's earlier touch no longer makes its refs stale.
          this.personActed = false;
          return parsed.data;
        } catch (error) {
          if (error instanceof TaplineError) return null;
          throw error;
        }
      },
      mark: () => {
        const now = live() ?? session;
        // The window of a move's log lines is a sequence number the host gave each stored line: a full buffer, rollover and a replaced session don't move it.
        return { crash: this.host.crashMark(), id: now.id, seq: this.sessionLogs(now.id).reduce((max, entry) => Math.max(max, entry.seq ?? 0), 0) };
      },
      since: (raw): Since => {
        const mark = raw as { crash: number; id: string; seq: number };
        const events = this.host.crashEventsAfter(mark.crash, session);
        const crashed = events.find((event) => event.kind === "crash");
        const crash = crashed !== undefined && crashed.kind === "crash" ? crashed.crash : null;
        const all = this.sessionLogs(mark.id);
        // A replaced session's lines come twice in that concatenation (its own record and the new session's carried copy): each sequence number counts once.
        const seen = new Set<number>();
        const fresh = all
          .filter((entry) => {
            const seq = entry.seq ?? 0;
            if (seq <= mark.seq || seen.has(seq)) return false;
            seen.add(seq);
            return true;
          })
          .map(({ seq: _seq, ...entry }) => entry);
        return {
          crash,
          disconnected: events.some((event) => event.kind === "disconnect"),
          errors: fresh.filter((entry) => logLevelOf(entry) === "error" && !(crash !== null && entry.fatal === true)),
        };
      },
      move: async (move: ExploreMove): Promise<MoveOutcome> => {
        const restores = move.tool === "toggle" && move.value !== undefined;
        const { value, count, last } = await within(() => {
          switch (move.tool) {
            case "tap":
              return this.tap({ target: move.target, look: false });
            case "toggle":
              return this.toggle({ target: move.target, ...(move.value !== undefined ? { value: move.value } : {}), look: false });
            case "scroll":
              return this.scroll(move.to !== undefined ? { to: move.to, look: false } : { direction: move.direction ?? "down", look: false });
            case "back":
              return this.back({ look: false });
            case "type":
              return this.typeText({ target: move.target, text: move.text, look: false });
          }
        }, restores, move.tool === "type");
        return outcomeOf(value, count, last);
      },
      go: async (place, by, account) => {
        const { value, count } = await within(() => this.drive({ to: place, by, look: false, ...(account !== undefined ? { account } : {}) }));
        return { ok: value.isError !== true, used: count, text: answerText(value) };
      },
      reload: async () => {
        const { value, count } = await within(() => this.reload({}));
        const said = answerText(value);
        return { ok: value.isError !== true && !/has not reconnected yet/.test(said), used: Math.max(count, 1), text: said };
      },
      commands: async () => {
        const now = live();
        if (now === undefined) return [];
        try {
          const parsed = commandsSchema.safeParse(await this.sendRequest("commands", {}, { sessionId: now.id }));
          return parsed.success ? parsed.data.commands.map((c) => c.name) : [];
        } catch {
          return [];
        }
      },
      runCommand: async (name) => {
        const { value, count } = await within(() => this.appCommand({ name, look: false }));
        return { ok: value.isError !== true, used: Math.max(count, 1), text: answerText(value) };
      },
      audit: async () => {
        const now = live();
        if (now === undefined || !now.capabilities.includes("audit")) return null;
        try {
          const parsed = auditResultSchema.safeParse(await this.sendRequest("audit", {}, { sessionId: now.id }));
          if (!parsed.success || parsed.data.issues.length === 0) return null;
          return parsed.data.issues.map((issue) => `${issue.type}: ${issue.element ? formatElement({ ...issue.element, ref: "" }, { actions: false }) : "the screen"}: ${issue.problem}. Fix: ${issue.fix}.`);
        } catch {
          return null;
        }
      },
      ux: async () => {
        const now = live();
        if (now === undefined || !now.capabilities.includes("uxCheck")) return null;
        try {
          const parsed = uxResultSchema.safeParse(await this.sendRequest("uxCheck", {}, { sessionId: now.id }));
          if (!parsed.success || parsed.data.issues.length === 0) return null;
          return parsed.data.issues.map((issue) => `${issue.kind}: ${issue.element ? formatElement({ ...issue.element, ref: "" }, { actions: false }) : "the screen"}: ${issue.problem}.`);
        } catch {
          return null;
        }
      },
      picture: async () => {
        const now = live();
        if (now === undefined || !now.capabilities.includes("screenshot") || this.noScreenshot.has(now.id) || this.secureWindow()) return null;
        try {
          const shot = await this.takeShot(now.id, 300, 0.6);
          return Buffer.from(shot.data, "base64");
        } catch {
          return null;
        }
      },
      frontState: () => {
        const now = live();
        if (now === undefined) return "gone";
        return now.appState === undefined || now.appState.state === "active" ? "front" : "background";
      },
      waitForApp: async (ms) => {
        for (let waited = 0; ; waited += 200) {
          const now = live();
          if (now !== undefined && (now.appState === undefined || now.appState.state === "active")) return true;
          if (waited >= ms) return false;
          await sleepMs(Math.min(200, Math.max(1, ms - waited)));
        }
      },
      redact: (text) => this.exploreScrub(run, text),
      progress: (line, steps) => progress?.(line, steps),
      cancelled: () => this.holdScope.getStore()?.signal?.aborted === true,
      get rules(): FloorRules {
        return rulesNow();
      },
      vaultFill: (entry, field) => {
        const store = this.options.accounts?.store ?? null;
        if (store === null || store.exploreMarked?.(entry) !== true) return "no";
        const kind = store.kindOf(entry);
        // Never a password, a card or the phone's passcode (§25.6): an identity, an address, a note, an account's username, or a fixture's field (v1.16).
        if (kind === "fixture") {
          const app = this.host.current()?.app;
          return app !== undefined && store.resolveEntry(entry, field, app.id ?? app.name).ok ? "ok" : "no";
        }
        const allowed = kind === "identity" ? field !== "phone" : kind === "address" || kind === "note" ? true : kind === "account" ? field === "username" : false;
        return allowed ? "ok" : "no";
      },
    };
    return host;
  }

  // -- the bug report (AGENT-TOOLS 1.16 §29)

  /** What a scroll, a swipe or a link did, for the log (§29.3): directions and points; a link cut down to its plain words; never typed text. */
  private loggedArgs(tool: string, params: unknown): { args?: NonNullable<ActionLogEntry["args"]> } {
    if (typeof params !== "object" || params === null) return {};
    const p = params as Record<string, unknown>;
    const args: NonNullable<ActionLogEntry["args"]> = {};
    if (tool === "scroll") {
      if (typeof p["direction"] === "string") args.direction = p["direction"];
      if (typeof p["to"] === "string") args.to = p["to"];
    } else if (tool === "swipe") {
      for (const key of ["x0", "y0", "x1", "y1"] as const) if (typeof p[key] === "number") args[key] = p[key];
    } else if (tool === "open_url" && typeof p["url"] === "string") args.url = cutDownLink(p["url"]);
    return Object.keys(args).length > 0 ? { args } : {};
  }

  /** Redaction at every sink of a bug report: the vault's values, this session's codes and every value typed in the session, in one pass (§29.6). */
  private bugScrub(text: string): string {
    return this.host.redactOut(this.scrubSecrets(text));
  }

  /** The map of an app: the live one when it is the app in front, else the one this server holds. */
  private bugMap(appId: string): ReturnType<AppMap["data"]> | undefined {
    const live = this.host.current();
    if (live !== undefined && (live.app.id ?? live.app.name) === appId) return this.mapOf(live)?.data();
    return this.options.maps?.forApp({ id: appId, name: appId })?.data();
  }

  private bugContext(store: BugStore): BugContext {
    return {
      store,
      redact: (text) => this.bugScrub(text),
      placeKey: (app, place) => (place === null ? null : (this.bugMap(app)?.places[place]?.key ?? null)),
      roads: (app) => this.bugMap(app)?.roads ?? [],
      needsPerson: (app, step) => {
        const target = step.target;
        if (target === undefined) return false;
        const subject = target.label ?? target.text ?? (target.id !== undefined ? asWords(target.id) : undefined);
        if (subject === undefined) return false;
        const lists = exploreLists(this.policy, { id: app, name: app });
        return matchWord([...FLOOR_WORDS, ...lists.confirm, ...lists.block], { label: subject }) !== null;
      },
    };
  }

  /** `bug_report` (AGENT-TOOLS 1.16 §29.3): one page for whoever fixes it, from a finding, the last failed check, or what was just seen. */
  async bugReport(args: Shape<"bug_report"> = {}): Promise<CallToolResult> {
    const store = this.bugStore;
    if (store === null) return fail("Error unsupported: this server keeps no bug reports.");
    const given = [args.finding !== undefined, args.from !== undefined, args.bug !== undefined].filter(Boolean).length;
    if (given !== 1) return fail("Error bad_params: give exactly one of finding, from and bug.");
    if (args.run !== undefined && args.finding === undefined) return fail("Error bad_params: run goes with finding.");
    if ((args.note !== undefined || args.expected !== undefined) && args.from !== "now") return fail('Error bad_params: note and expected go with from: "now".');
    if (args.export !== undefined) {
      if (args.bug === undefined) return fail("Error bad_params: export goes with bug (the id of a kept bug).");
      if (args.finding !== undefined || args.from !== undefined || args.verify !== undefined || args.with_picture !== undefined) return fail("Error bad_params: export is a call of its own: give bug and export, and with_picture inside export.");
      return this.bugExport(store, args.bug, args.export);
    }
    const verify = args.verify === undefined || args.verify === false || args.verify === 0 ? 0 : args.verify === true ? 3 : args.verify;
    if (!Number.isInteger(verify) || verify < 0 || verify > 10) return fail("Error bad_params: verify is true, false or a whole number from 0 to 10.");
    // Without `verify` a bug from a finding or a failure is checked 3 times; one from `now` is not checked (§29.3, §29.4).
    const runs = args.verify === undefined && args.from !== "now" && args.bug === undefined ? VERIFY_DEFAULT : verify;
    try {
      if (args.bug !== undefined) return await this.bugShow(store, args.bug, args.with_picture === true, runs, args);
      const built =
        args.finding !== undefined
          ? await this.bugFromRun(store, args.finding, args.run, args.with_picture === true)
          : args.from === "failure"
            ? this.bugFromFailure(store)
            : await this.bugFromNow(store, args);
      if (!isBuilt(built)) return built;
      return text(bugAnswer(await this.bugChecked(store, built.made, runs, args), (t) => this.bugScrub(t), { reasonShown: built.reasonShown }));
    } catch (error) {
      if (error instanceof BugGateError) return fail(`Error not_allowed: bug report refused: ${error.message} Nothing was written.`);
      return fail(`Error internal: the bug report couldn't be made: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The check this server runs unless a hook replaces it (tests). */
  private readonly ownCheck: BugCheck = (bug, n, options) => this.runBugCheck(bug, n, options);

  /**
   * The reproduction check (AGENT-TOOLS 1.16 §29.4): `n` runs of the bug's `repro.json`, each from a fresh start, every move through the one
   * explore gate (§25.5: the floor on the real recipient, no dialog, no grant). A step that needs a person stops the check with no move of it.
   */
  async runBugCheck(bug: Parameters<BugCheck>[0], n: number, options: BugCheckOptions): Promise<BugMeta["reproduced"]> {
    const not = (why: string): BugMeta["reproduced"] => ({ checked: false, why });
    const session = this.host.current();
    if (session === undefined) return not("no phone connected");
    // The check goes to a connected session of the bug's own app, and to no other (§29.4): with another app in front it makes no move.
    const appOf = (s: SessionInfo): string => s.app.id ?? s.app.name;
    if (appOf(session) !== bug.app) return not(`the app in front isn't ${bug.app} (it is ${appOf(session)}); open ${bug.app} on the phone first`);
    const identity = identityOf(session);
    if (this.exploring) return not("an explore or another check is running here");
    if (this.journeyRun !== undefined || this.journeyBusy !== undefined) return not("a journey is running");
    if (this.recordingState !== null || this.replayingState || this.rivals > 0) return not("a script is being recorded or replayed");
    const map = this.mapOf(session);
    if (map === undefined) return not("this app reports no id of its own, so it has no map");
    let script: { start: string | null; steps: PathStep[] };
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(bug.dir, "repro.json"), "utf8"));
      const o = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
      script = { start: typeof o["start"] === "string" ? o["start"] : null, steps: Array.isArray(o["steps"]) ? (o["steps"] as PathStep[]) : [] };
    } catch {
      return not("repro.json can't be read");
    }
    this.exploring = true;
    const keptFailure = this.lastFailure;
    let run: ExploreRun | undefined;
    let eh: ExploreHost | undefined;
    const wall = this.options.wallClock ?? Date.now;
    const fresh = (): { run: ExploreRun; eh: ExploreHost } => {
      run?.ingress?.end();
      // A run lasts at most a minute (§29.4); the budget of the gate holds it to that.
      const made: ExploreRun = { used: 0, steps: 300, minutes: RUN_LIMIT_MS / 60_000, startedAt: this.clock(), waited0: this.options.control?.waitedMs() ?? 0, typed: [], ingress: this.host.typedRun() };
      run = made;
      eh = this.exploreHost(session, map, wall, undefined, made);
      return { run: made, eh };
    };
    const current = (): { run: ExploreRun; eh: ExploreHost } => (run !== undefined && eh !== undefined ? { run, eh } : fresh());
    const resultOf = (answer: CallToolResult, last: { method: string; result: unknown } | undefined, unwrap?: string): StepResult => {
      if (answer.isError !== true) {
        const result = last?.result;
        const settled = typeof result === "object" && result !== null && "settledMs" in result ? (result as { settledMs: unknown }).settledMs : undefined;
        return { kind: "ok", ...(typeof settled === "number" && Number.isFinite(settled) ? { settledMs: settled } : {}) };
      }
      let said = answerText(answer);
      if (unwrap !== undefined) {
        // `run` says `Error <code>: Ran 0 of 1 steps; stopped at step 1 (<step>): <message>`; the step's own answer is what the finding holds.
        const head = /^Error (\w+): Ran \d+ of \d+ steps; stopped at step \d+ \(/.exec(said);
        if (head !== null) {
          const rest = said.slice(head[0].length);
          said = `Error ${head[1] ?? "internal"}: ${rest.startsWith(`${unwrap}): `) ? rest.slice(unwrap.length + 3) : rest}`;
        }
      }
      const m = /^Error (\w+):\s*([\s\S]*)$/.exec(said);
      const code = m?.[1] ?? "internal";
      const message = m?.[2] ?? said;
      if (code === "busy" || code === "paused" || code === "locked") return { kind: "stop", code };
      if (code === "not_allowed" && /explore budget/.test(message)) return { kind: "error", code: "budget", message: firstLine(message) };
      if (code === "not_allowed" && /needs_confirmation|blocked|explore skip|policy word|explore touches nothing|explore won't/.test(message)) {
        const word = /policy word "([^"]+)"/.exec(message)?.[1];
        const why = /explore skip: (\w+)/.exec(message)?.[1];
        return { kind: "person", why: word !== undefined ? `the policy word "${this.host.redactOut(word)}"` : why !== undefined ? `the skip floor: ${why}` : "a policy word" };
      }
      return { kind: "error", code, message: firstLine(message) };
    };
    const host: CheckHost = {
      clock: () => this.clock(),
      wall: () => new Date(wall()),
      build: () => {
        const now = this.host.current();
        if (now === undefined) return null;
        const build = now.app.build ?? "";
        return `${now.app.version ?? ""} (${/\((.*)\)\s*$/.exec(build)?.[1] ?? build})`;
      },
      away: () => {
        const now = this.host.current();
        if (now === undefined) return `stopped (the app disconnected)`;
        return identityOf(now) === identity && appOf(now) === bug.app ? null : `stopped (${appOf(now)} is in front now, not ${bug.app})`;
      },
      reset: async (mode, signal) => {
        const { run: fresher, eh: h } = fresh();
        if (signal !== undefined) fresher.signal = signal;
        const reloaded = await h.reload();
        let wiped = false;
        // The standard `app_command reset` clears the app's data: only when it was asked for (§29.4).
        if (mode === "app" && (await h.commands()).includes("reset")) wiped = (await h.runCommand("reset")).ok;
        if (!reloaded.ok && !wiped) return { ok: false };
        // A reset that brought the app to no readable place isn't one (§29.4).
        if ((await h.tree()) === null) return { ok: false };
        const words = wiped ? (reloaded.ok ? "reload and the app's reset command, data cleared" : "the app's reset command, data cleared") : "reload only, data kept";
        return { ok: true, words };
      },
      start: async (place, signal) => {
        const now = current();
        if (signal !== undefined) now.run.signal = signal;
        return (await now.eh.go(place, "any", options.account)).ok;
      },
      step: async (step, typed, signal) => {
        // Defence in depth: the engine checked every step before the run; a step outside the allowlist is refused before any branch (§29.4).
        const wrong = stepsProblem([step]);
        if (wrong !== null) return { kind: "error", code: "bad_params", message: wrong.replace(/^step 1 /, "the step ") };
        const now = current();
        if (signal !== undefined) now.run.signal = signal;
        const within = this.exploreWithin(now.run);
        const { tool, expect, ...rest } = step as PathStep & { expect?: unknown };
        const params: Record<string, unknown> = { ...rest, look: false };
        const asShape = <T extends keyof typeof toolShapes>(): Shape<T> => params as unknown as Shape<T>;
        if (tool === "type_text") {
          if (typed === null) return { kind: "person", why: "a typed value" };
          params["text"] = typed;
          const { value, last } = await within(() => this.typeText(asShape<"type_text">()), false, true);
          return resultOf(value, last);
        }
        if (expect !== undefined) {
          const runStep: Record<string, unknown> = { tool, ...rest, expect };
          const { value, last } = await within(() => this.run({ steps: [runStep], look: false } as unknown as Shape<"run">));
          return resultOf(value, last, describeRunStep(runStep as unknown as Step));
        }
        const call = (): Promise<CallToolResult> | null => {
          switch (tool) {
            case "tap":
              return this.tap(asShape<"tap">());
            case "long_press":
              return this.longPress(asShape<"long_press">());
            case "toggle":
              return this.toggle(asShape<"toggle">());
            case "scroll":
              return this.scroll(asShape<"scroll">());
            case "swipe":
              return this.swipe(asShape<"swipe">());
            case "back":
              return this.back(asShape<"back">());
            case "open_url":
              return this.openUrl(asShape<"open_url">());
            default:
              return null;
          }
        };
        if (!CHECK_TOOLS.includes(tool)) return { kind: "error", code: "bad_params", message: `the check doesn't run a "${String(tool)}" step` };
        const { value, last } = await within(() => call() as Promise<CallToolResult>);
        return resultOf(value, last);
      },
      mark: () => current().eh.mark(),
      since: async (raw) => {
        const { eh: h } = current();
        const after = h.since(raw);
        return {
          crash: after.crash === null ? null : (({ line, crash }) => ({ line, crash }))(crashFacts(after.crash)),
          disconnected: after.disconnected,
          errors: after.errors.map((entry) => errorLine(entry, (t) => h.redact(t))),
        };
      },
      placeKey: async () => {
        const tree = await current().eh.tree();
        return tree === null ? null : map.observe(tree).place.key;
      },
      issues: async (kind) => (kind === "a11y" ? await current().eh.audit() : await current().eh.ux()),
      inFront: () => current().eh.frontState() === "front",
      redact: (t) => current().eh.redact(t),
    };
    try {
      return await this.noteScope.run(true, () => runCheck(host, { finding: bug.finding, meta: bug.meta, script }, n, { reset: options.reset, ...(options.typed !== undefined ? { typed: options.typed } : {}) }));
    } finally {
      run?.ingress?.end();
      this.exploring = false;
      this.lastFailure = keptFailure;
    }
  }

  /** Runs the reproduction check on a bug just made, when there is one and it was asked for; the page and `finding.json` take its result (§29.4). */
  private async bugChecked(store: BugStore, made: BugMade, runs: number, args: Shape<"bug_report">): Promise<BugMade> {
    if (runs <= 0) return made;
    const check = this.options.bugCheck ?? this.ownCheck;
    const app = made.finding.app;
    const reproduced = await check({ app, id: made.meta.id, dir: made.dir, finding: made.finding, meta: made.meta }, runs, { reset: args.reset ?? "own", ...(args.account !== undefined ? { account: args.account } : {}) });
    const meta = store.recordCheck(app, made.meta.id, reproduced, (t) => this.bugScrub(t));
    return meta === null ? made : { ...made, meta };
  }

  /** `{finding, run}`: a finding of an explore report folder (or `"last"`, the newest of the app in front). */
  private async bugFromRun(store: BugStore, findingId: string, run: string | undefined, withPicture: boolean): Promise<Built | CallToolResult> {
    const exploreDir = this.options.exploreDir;
    if (exploreDir === undefined) return fail("Error unsupported: this server keeps no explore reports.");
    let runDir: string | null;
    if (run === undefined || run === "last") {
      const session = this.host.current();
      if (session === undefined) return this.notConnected();
      runDir = newestRun(exploreDir, session.app.id ?? session.app.name);
      if (runDir === null) return fail("Error not_found: no explore report for this app yet; run explore first.");
    } else {
      const asked = run.startsWith("~") ? join(homedir(), run.slice(1)) : run;
      const full = resolve(asked);
      const roots = [exploreDir, ...(this.options.journeysDir !== undefined ? [this.options.journeysDir] : [])].map((root) => resolve(root));
      if (!roots.some((root) => full === root || full.startsWith(root + sep))) return fail("Error bad_params: run is an explore report folder of this server, or \"last\".");
      runDir = full;
    }
    const read = readRunFinding(runDir, findingId);
    if (!read.ok) return fail(`Error ${read.code}: ${read.message}`);
    const made = makeBug(this.bugContext(store), {
      finding: read.finding,
      how: "explore",
      sourceKey: `${read.run}/${read.finding.id}`,
      run: read.run,
      script: read.script,
      picture: read.picture,
      withPicture,
      notChecked: read.finding.kind === "unreachable" ? "an unreachable place has no steps" : "no check was asked for",
    });
    return { made, reasonShown: true };
  }

  /** `{from: "failure"}`: the last failed `run` or `replay` of this session, while it is still the last one. */
  private bugFromFailure(store: BugStore): Built | CallToolResult {
    const failure = this.lastFailure;
    if (failure === null) return fail("Error not_found: there is no failed replay or run in this session to make a bug of (a later run or replay that held clears it).");
    const { steps, cut } = writablePath(failure.path);
    const finding: BugFinding = { ...failure, path: steps };
    const made = makeBug(this.bugContext(store), {
      finding,
      how: "failure",
      sourceKey: `failure/${failure.when}`,
      stepsCut: cut,
      notChecked: "no check was asked for",
    });
    return { made, reasonShown: true };
  }

  /** `{from: "now", note}`: a finding of the kind `observed`, built from the last touches of the action log (§29.3). */
  private async bugFromNow(store: BugStore, args: Shape<"bug_report">): Promise<Built | CallToolResult> {
    const note = args.note?.trim() ?? "";
    if (note === "") return fail('Error bad_params: from: "now" needs a note (what is wrong, one line).');
    for (const [name, value] of [["note", note], ["expected", args.expected?.trim() ?? ""]] as const) {
      if (/[\r\n]/.test(value)) return fail(`Error bad_params: ${name} is one line.`);
      if ([...value].length > 300) return fail(`Error bad_params: ${name} is at most 300 characters.`);
    }
    const logDir = this.options.logDir;
    if (logDir === undefined) return fail("Error unsupported: the action log is off (--no-log), so there is nothing to make a bug of.");
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const appId = session.app.id ?? session.app.name;
    const platform = session.device.platform === "ios" ? "iOS" : session.device.platform === "android" ? "Android" : session.device.platform;
    const wall = this.options.wallClock ?? Date.now;
    // The place now, saved as a look would save it (§18.1).
    let place: string | null = null;
    const map = this.mapOf(session);
    if (map !== undefined) {
      const tree = treeResultSchema.safeParse(await this.sendRequest("tree", { peek: true }, { sessionId: session.id, internal: true }).catch(() => null));
      if (tree.success) place = map.observe(tree.data).place.name;
    }
    let picture: Uint8Array | null = null;
    if (session.capabilities.includes("screenshot") && !this.noScreenshot.has(session.id) && !this.secureWindow()) {
      try {
        picture = Buffer.from((await this.takeShot(session.id, 300, 0.6)).data, "base64");
      } catch {
        picture = null;
      }
    }
    const build = session.app.build ?? "";
    const observed = observedFinding({
      entries: readLogEntries(logDir, this.startedAt),
      app: appId,
      note: this.bugScrub(note),
      ...(args.expected !== undefined ? { expected: this.bugScrub(args.expected.trim()) } : {}),
      info: { appVersion: session.app.version ?? "", build: /\((.*)\)\s*$/.exec(build)?.[1] ?? build, device: { model: session.device.model ?? session.device.name ?? "unknown", os: `${platform}${session.device.osVersion !== undefined ? ` ${session.device.osVersion}` : ""}` }, toolVersion: EXPLORE_TOOL_VERSION },
      when: new Date(wall()),
      place,
      logs: formatLogs(this.sessionLogs(session.id).slice(-20)).split("\n").filter((line) => line !== ""),
      // Any app the user didn't mark as a test app may show personal data: this tool can't know one, so the picture is private (§27.2).
      picture: picture === null ? null : { file: "findings/f1.jpg", private: true },
    });
    if (observed === null) return fail("Error not_found: there is no touch in the action log to make a bug of; drive the app first.");
    const made = makeBug(this.bugContext(store), {
      finding: observed.finding,
      how: "now",
      sourceKey: `now/${observed.finding.when}`,
      picture,
      withPicture: args.with_picture === true,
      stepsCut: observed.stepsCut,
      others: observed.others,
      notChecked: "no check was asked for",
    });
    return { made, reasonShown: false };
  }

  /** `{bug, export}`: sends a kept bug out of the tool's folder, to a GitHub issue or a zip (§29.7). */
  private async bugExport(store: BugStore, id: string, target: BugExportTarget): Promise<CallToolResult> {
    if (!isBugId(id)) return fail(`Error bad_params: "${id}" is not a bug id (bug_ and 16 hex digits).`);
    const session = this.host.current();
    const found = store.locate(id, session !== undefined ? (session.app.id ?? session.app.name) : undefined) ?? store.locate(id);
    if (found === null) return fail(`Error not_found: no bug ${id}; the bugs kept are in ${shownPath(store.base)}.`);
    try {
      const done = await exportBug({ store, redact: (t) => this.bugScrub(t), audit: this.options.audit, run: this.options.exportRunner }, found.app, id, target);
      return done.ok ? text(this.bugScrub(done.lines.join("\n"))) : fail(`Error ${done.code}: ${this.bugScrub(done.message)}`);
    } catch (error) {
      return fail(`Error internal: the export couldn't be made: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** `{bug}`: shows a kept bug; with `with_picture` adds its private picture while the explore report still holds it. */
  private async bugShow(store: BugStore, id: string, withPicture: boolean, runs: number, args: Shape<"bug_report">): Promise<CallToolResult> {
    if (!isBugId(id)) return fail(`Error bad_params: "${id}" is not a bug id (bug_ and 16 hex digits).`);
    const session = this.host.current();
    const found = store.locate(id, session !== undefined ? (session.app.id ?? session.app.name) : undefined) ?? store.locate(id);
    if (found === null) return fail(`Error not_found: no bug ${id}; the bugs kept are in ${shownPath(store.base)}.`);
    const { app, stored } = found;
    let note = "";
    if (withPicture) {
      let bytes: Uint8Array | null = null;
      const source = stored.meta.source;
      const file = stored.finding.picture?.file;
      if (source.how === "explore" && source.run !== undefined && file !== undefined && this.options.exploreDir !== undefined && /^findings\/[\w.-]+$/.test(file) && /^\d{8}T\d{6}Z(?:-\d+)?$/.test(source.run)) {
        try {
          bytes = readFileSync(join(this.options.exploreDir, appFolderName(app), source.run, file));
        } catch {
          bytes = null;
        }
      }
      const done = store.addPicture(app, id, bytes, (t) => this.bugScrub(t));
      note =
        done === "added" ? "The picture is in the folder now." : done === "has" ? "The picture is in the folder already." : "The picture can't be added: its file is gone (it is kept only while the explore report holds it).";
      if (done === "gone") return fail(`Error not_found: ${note}`);
    }
    // A later check of a kept bug replaces `reproduced` and its line (§29.4).
    if (runs > 0) {
      const made: BugMade = { meta: stored.meta, dir: stored.dir, isNew: false, title: bugTitle(stored.finding), finding: stored.finding };
      const meta = (await this.bugChecked(store, made, runs, args)).meta;
      note = `${note}${note === "" ? "" : "\n"}${reproducedAnswer({ meta }, true)}`;
    }
    const page = readFileSync(join(stored.dir, "report.md"), "utf8");
    return text(this.bugScrub([...(note !== "" ? [note] : []), page.trimEnd(), "", `Folder: ${shownPath(stored.dir)}`].join("\n")));
  }

  /** `session_report` (AGENT-TOOLS 1.11 §16.1): where this session's calls went, and the waste in them. */
  sessionReport(args: Shape<"session_report"> = {}): CallToolResult {
    const dir = this.options.logDir;
    if (dir === undefined) return fail("Error unsupported: the action log is off (--no-log), so there is nothing to report.");
    // Names only; a username or password never reaches a report (§18.6).
    return text(reportFor(dir, args.since ?? this.startedAt, this.sessionTag, this.options.accounts?.store?.names()));
  }

  /**
   * Runs a tool call and ends its answer with a note when the app stopped (AGENT-TOOLS 15.2): during this
   * call, or earlier, with its time, once. Calls inside a call (`run`'s steps) add nothing of their own.
   */
  private noting(run: () => CallToolResult | Promise<CallToolResult>, isDrive = false): CallToolResult | Promise<CallToolResult> {
    // Nesting belongs to the call and what it awaits (not to this object), so calls running side by side each
    // count as outermost, and only a step inside a call is skipped.
    if (this.noteScope.getStore() === true) return run();
    const mark = this.host.crashMark();
    const startedWith: AppIdentity | undefined = this.host.current();
    // Reflexes fired during the call are counted for it, and said in its answer (§18.7).
    const reflexes: ReflexCall = { fired: new Map(), lines: [] };
    const grantLines: string[] = [];
    return this.grantNotes.run(grantLines, () =>
      this.noteScope.run(true, () =>
        this.reflexScope.run(reflexes, () => {
          const result = this.personScope.run(new Set<string>(), () => this.afterMoments(run, isDrive));
          const finish = (answer: CallToolResult): CallToolResult =>
            this.withReflexLines(this.withAccountsNote(this.withPersonNote(this.withCrashNotes(flushNotes(answer, grantLines), mark, startedWith))), reflexes);
          // The first answer of a session with grants says which grant is refused, and whether the state file is broken (§19.1, §19.4).
          if (this.options.grants !== undefined && !this.grantNoticeDone) {
            this.grantNoticeDone = true;
            const grants = this.options.grants;
            return Promise.resolve(result).then(async (answer) => finish(appendNotes(answer, GrantBook.noticeLines(await grants.inspect()))));
          }
          return result instanceof Promise ? result.then(finish) : finish(result);
        }),
      ),
    );
  }

  /** What reflexes did in the call in flight: how often each fired, and the lines the answer carries. */
  private readonly reflexScope = new AsyncLocalStorage<ReflexCall>();
  /** A reflex's own step is running (in this call only): it triggers no reflex, no road and no recorded step. */
  private inReflexStep(): boolean {
    return this.reflexStep.getStore() === true;
  }

  /** The `Reflex:` lines (and the notes of a reflex that didn't fire) go right under the answer's first line. */
  private withReflexLines(answer: CallToolResult, call: ReflexCall): CallToolResult {
    if (call.lines.length === 0) return answer;
    const [first, ...rest] = answer.content;
    if (first === undefined || first.type !== "text") return answer;
    const [head = "", ...more] = first.text.split("\n");
    return { ...answer, content: [{ type: "text", text: [head, ...call.lines, ...more].join("\n") }, ...rest] };
  }

  /**
   * AGENT-TOOLS 1.13 §18.7: looks for a declared reflex whose moment has come, and fires it. Called at a place change and before a
   * failure is answered (1.13.1 item 10), never in a dry run, never in a replay, and in a user's-eyes journey only when its
   * `allow` names `reflexes`. Reads nothing unless the app's map holds a reflex. Answers how many fired.
   */
  private async checkReflexes(session: SessionInfo, at?: string): Promise<number> {
    const call = this.reflexScope.getStore();
    if (call === undefined || this.inReflexStep() || this.replaying) return 0;
    const map = this.options.maps === undefined ? undefined : this.mapOf(session);
    const reflexes = map?.data().reflexes ?? [];
    if (map === undefined || reflexes.length === 0) return 0;
    const eyes = this.userEyes() ? "user" : "agent";
    const allows = this.journeyRun?.allows(REFLEXES_ALLOWED) === true;
    if (eyes === "user" && !allows) return 0;
    const lists = listsFor(this.policy, session.app);
    const thisMoment = new Set<string>();
    let fired = 0;
    // A reflex that doesn't fire uses no firing of the moment's three; skips are bounded on their own.
    let skipped = 0;
    while (fired < MAX_REFLEX_FIRINGS && skipped < MAX_REFLEX_SKIPS) {
      let tree: TreeResult;
      let place: string | null;
      try {
        const read = treeResultSchema.safeParse(await this.sendRequest("tree", { peek: true }, { sessionId: session.id }));
        if (!read.success) break;
        tree = read.data;
        place = at ?? (await placeNow(this.placeSource(session), map))?.place.name ?? null;
      } catch {
        break;
      }
      const match = matchReflex(reflexes, tree.elements, {
        place,
        firedThisCall: call.fired,
        eyes,
        journeyAllowsReflexes: allows,
        firedThisMoment: thisMoment,
        alerts: tree.alerts,
        screen: tree.screen,
      });
      if (match === null) break;
      thisMoment.add(match.name);
      // The reflex's step is no move of the agent's: it leaves no road, no recorded step and no map change, and it never asks a
      // person (see `reflexStep`). The scope is this step's own, so a call running beside it is not touched.
      const outcome = await this.reflexStep.run(true, () =>
        fireReflex(
          match,
          (step) => this.runStepNow(step),
          (step) => this.reflexVerdict(session, step, lists),
        ),
      );
      if (!("line" in outcome)) skipped++;
      if ("line" in outcome) {
        call.fired.set(match.name, (call.fired.get(match.name) ?? 0) + 1);
        call.lines.push(outcome.line);
        fired++;
        this.observedPlace = undefined;
      } else if (!call.lines.includes(`Note: ${outcome.skipped}`)) {
        call.lines.push(`Note: ${outcome.skipped}`);
      }
    }
    return fired;
  }

  /**
   * The policy's verdict on a reflex's step, made right before it fires (§18.7): by the words the map keeps, and by the element
   * the app would touch now. It uses the same word lists and the same matching as a single call (`policyWords`).
   */
  private async reflexVerdict(session: SessionInfo, step: ReflexDo, lists: { confirm: string[]; block: string[] }): Promise<ReflexVerdict> {
    if (step.tool === "open_url" && !linkReadable(step.url)) return { kind: "unresolved", why: "its link's percent escapes can't be decoded" };
    const words = reflexWords(step);
    const blockedWord = matchWord(lists.block, words);
    if (blockedWord !== null) return { kind: "blocked", word: this.host.redactOut(blockedWord) };
    const flaggedWord = matchWord(lists.confirm, words);
    if (flaggedWord !== null) return { kind: "flagged", word: this.host.redactOut(flaggedWord) };
    if (lists.confirm.length === 0 && lists.block.length === 0) return { kind: "none" };
    if (step.tool !== "tap" && step.tool !== "long_press" && step.tool !== "toggle") return { kind: "none" };
    const method = step.tool === "tap" ? "press" : step.tool === "long_press" ? "longPress" : "toggle";
    const resolved = await this.resolveForPolicy(session, method, { target: toWireTarget(step.target) });
    if (resolved.kind === "error") return { kind: "unresolved", why: `it can't be checked now (${resolved.text.replace(/^Error \w+: /, "").split("\n")[0]?.slice(0, 120) ?? ""})` };
    const verdict = this.policyWords(lists, resolved);
    return verdict.kind === "none" ? { kind: "none" } : { kind: verdict.kind === "blocked" ? "blocked" : "flagged", word: verdict.word };
  }

  /** The elements a plain id, label or text target means now; null for any other target (an index, a ref, a point) or no read. */
  private async namedCandidates(session: SessionInfo, params: unknown): Promise<TreeElement[] | null> {
    const target = typeof params === "object" && params !== null ? (params as { target?: unknown }).target : undefined;
    if (typeof target !== "object" || target === null) return null;
    const t = target as Record<string, unknown>;
    if ("index" in t || "ref" in t || "x" in t || !("testID" in t || "label" in t || "text" in t)) return null;
    try {
      const read = treeResultSchema.safeParse(await this.sendRequest("tree", { peek: true }, { sessionId: session.id }));
      return read.success ? candidatesFor(target, read.data.elements) : null;
    } catch {
      return null;
    }
  }

  /**
   * After a reflex fired: whether the step may run again (1.13.1 item 10). Only when the target is the one element it was before
   * (its id, role, label and text), or, for a target a sheet hid, the one that came carries the name the failure gave. An index
   * target, an ambiguous one and a changed one are not retried: the original failure is answered, with the Reflex line.
   */
  private async sameTarget(session: SessionInfo, params: unknown, before: TreeElement[] | null, message: string): Promise<boolean> {
    if (before === null || before.length > 1) return false;
    const after = await this.namedCandidates(session, params);
    const [now] = after ?? [];
    if (after === null || after.length !== 1 || now === undefined) return false;
    const [was] = before;
    if (was !== undefined) {
      const key = (e: TreeElement): string => [e.testID ?? "", e.role ?? "", e.label ?? "", e.text ?? ""].join("|");
      return key(was) === key(now);
    }
    const named = /"([^"]+)"/.exec(message)?.[1];
    return named === undefined || [now.text, now.label].some((v) => v?.toLowerCase() === named.toLowerCase());
  }

  /** After a touch that changed the place (§18.7): the arrival is looked at for a reflex before the list is built. */
  private async reflexAtPlaceChange(session: SessionInfo, from: Place | null): Promise<void> {
    if (this.inReflexStep() || this.replaying || this.reflexScope.getStore() === undefined) return;
    const map = this.options.maps === undefined ? undefined : this.mapOf(session);
    if (map === undefined || map.data().reflexes.length === 0) return;
    let arrived: Place | undefined;
    try {
      arrived = (await placeNow(this.placeSource(session), map))?.place;
    } catch {
      return;
    }
    if (arrived === undefined || (from !== null && from.name === arrived.name)) return;
    await this.checkReflexes(session, arrived.name);
  }

  /** The needs-a-person moments already asked about in this call: one dialog per moment per call (§11.5). */
  private readonly personScope = new AsyncLocalStorage<Set<string>>();

  /**
   * AGENT-TOOLS 1.13 §11.5: a call that ended because only a person can go on (the app isn't there, an alert, an app that
   * stopped answering) tells the person in the host's dialog and waits. When the moment clears, the call runs again, so it
   * checks the screen afresh; nothing was done, as the call failed before it began. Without a dialog: today's answer, with a Note.
   */
  private afterMoments(run: () => CallToolResult | Promise<CallToolResult>, isDrive = false): CallToolResult | Promise<CallToolResult> {
    const wasNotAnswering = this.host.current() !== undefined && this.host.isNotAnswering(this.host.current()?.id ?? "");
    const failedFor = this.host.current()?.id;
    const actingBefore = this.host.actingMark();
    const first = run();
    // A tool that answers at once (apps, open_app) never waits for a person.
    if (!(first instanceof Promise)) return first;
    return first.then((answer) =>
      momentCode(answer) === undefined ? answer : this.settleMoments(answer, run, wasNotAnswering ? failedFor : undefined, actingBefore, isDrive),
    );
  }

  /**
   * Runs the call again only when it did nothing: no request that may act on the app was sent, and it isn't a batch
   * (a batch never runs again; the person is told where to continue). Anything else is answered as it failed.
   */
  private async settleMoments(
    first: CallToolResult,
    run: () => CallToolResult | Promise<CallToolResult>,
    notAnsweringBefore: string | undefined,
    actingBefore: number,
    isDrive = false,
  ): Promise<CallToolResult> {
    let answer = first;
    for (let round = 0; round < 4; round++) {
      const moment = await this.momentOf(answer, notAnsweringBefore);
      if (moment === null) return answer;
      const dialogs = this.dialogs;
      const asked = this.personScope.getStore();
      if (dialogs === undefined || !dialogs.available()) return this.withMomentNote(answer, moment.what);
      if (asked === undefined || asked.has(moment.key)) return answer;
      asked.add(moment.key);
      const outcome = await this.askPerson(dialogs, momentMessage(moment), moment.cleared);
      if (outcome === "cant") return appendNote(answer, "They can't now. Ask your user what to do.");
      if (outcome === "no_dialog") return this.withMomentNote(answer, moment.what);
      if (outcome !== "cleared") return answer;
      // The person may have said Done before the app shows it: give it a moment.
      await this.untilTrue(moment.cleared, this.options.personDoneGraceMs ?? 4000);
      const step = batchStep(answer);
      // A drive plans from where the app is, so it is called again; a step number means nothing to it.
      if (step !== undefined && isDrive) return appendNote(answer, "The person is done; run the drive again; it plans from where the app is.");
      if (step !== undefined) return appendNote(answer, `The person is done; continue from step ${step}.`);
      if (this.host.actingMark() !== actingBefore) return appendNote(answer, "The person is done; the call had already acted, so it was not run again. Repeat what is left.");
      // Running it again is the re-check of the screen.
      answer = await run();
      if (momentCode(answer) === undefined) return answer;
    }
    return answer;
  }

  /** Waits for a person in the dialog; the time spent is not the batch's (§9.3). */
  private async askPerson(dialogs: Dialogs, message: string, cleared: () => Promise<boolean> | boolean): Promise<MomentOutcome> {
    const hold = this.holdScope.getStore();
    const started = Date.now();
    try {
      return await askDone(dialogs, message, cleared, {
        ttlMs: this.options.personWaitMs ?? 120_000,
        ...(this.options.personPollMs !== undefined ? { pollMs: this.options.personPollMs } : {}),
        ...(hold?.signal !== undefined ? { signal: hold.signal } : {}),
      });
    } finally {
      if (hold !== undefined) hold.ms += Date.now() - started;
    }
  }

  private async untilTrue(check: () => Promise<boolean> | boolean, forMs: number): Promise<boolean> {
    const until = Date.now() + forMs;
    for (;;) {
      if (await check()) return true;
      if (Date.now() >= until) return false;
      await this.sleep(Math.min(this.options.personPollMs ?? 500, 100));
    }
  }

  /**
   * A host with no dialog keeps today's answer; it ends with what the person has to do. Not for not_connected and
   * not_answering: their text already says it (and the first answer has its own `Note: needs a person`).
   */
  private withMomentNote(answer: CallToolResult, what: string): CallToolResult {
    const code = momentCode(answer);
    if (code === "not_connected" || code === "not_answering") return answer;
    return appendNote(answer, `Note: needs a person: ${what}.`);
  }

  private appName(): string {
    return this.host.current()?.app.name ?? this.host.lastDisconnect()?.session.app.name ?? "the app";
  }

  /** What a person has to do to let this answer's call go on, and how to see it is done; null when it is no such moment. */
  private async momentOf(answer: CallToolResult, notAnsweringBefore: string | undefined): Promise<Moment | null> {
    const code = momentCode(answer);
    const connected = (): boolean => this.host.current() !== undefined;
    const app = plainText(this.appName(), 40);
    // §11.5 gives this line for Tapline word for word (the phone locked is the app not in front), with no "go on" sentence.
    const open = { key: "app", what: `open ${app} on the phone (unlock it first if it's locked)` };
    const restart = { key: "restart", what: `close ${app} and open it again`, goOn: "it connects again" };
    if (code === "not_connected") {
      if (this.options.pairedBefore !== undefined && !this.options.pairedBefore()) {
        return { key: "pair", what: "pair the phone (scan the QR code, or open the app and tap Connect)", goOn: "the app connects", cleared: connected };
      }
      const last = this.host.lastDisconnect();
      const crashed = last !== undefined && this.host.crashEventsAfter(this.notedSeqOf(last.session), last.session).some((event) => event.kind === "disconnect");
      return crashed ? { ...restart, cleared: connected } : { ...open, cleared: connected };
    }
    if (code === "in_background") {
      return { ...open, cleared: () => this.host.current()?.appState?.state !== undefined && this.host.current()?.appState?.state !== "background" };
    }
    if (code === "not_answering") {
      // One that stopped answering twice, or dropped after going silent: the person closes it and opens it again.
      const session = this.host.current();
      if (session === undefined) return { ...restart, cleared: connected };
      if (notAnsweringBefore !== session.id) return null;
      return { ...restart, cleared: () => this.host.current() !== undefined && this.host.current()?.id !== session.id };
    }
    if (code === "not_actionable") {
      const alert = await this.openOsAlert();
      const seen = alert !== null;
      const only = alert !== null && alert.buttons.length === 1 ? alert.buttons[0] : undefined;
      const what =
        only !== undefined
          ? `tap "${plainText(only.text, 40)}" on the alert`
          : alert !== null && alert.title !== ""
            ? `answer the alert "${plainText(alert.title, 60)}" on the phone`
            : "answer the alert on the phone";
      return { key: "alert", what, goOn: "the alert is gone", cleared: this.alertGone(seen) };
    }
    return null;
  }

  /** The first alert over the app that the tool can't tap (an OS alert), or null. */
  private async openOsAlert(): Promise<NonNullable<TreeResult["alerts"]>[number] | null> {
    const session = this.host.current();
    if (session === undefined) return null;
    const tree = treeResultSchema.safeParse(await this.sendRequest("tree", { peek: true }, { sessionId: session.id }).catch(() => null));
    return tree.success ? (tree.data.alerts ?? []).find((alert) => !alert.standIn) ?? null : null;
  }

  /**
   * Whether the alert is gone: seen only when the app reports it (a JavaScript alert, or a build with Tapline's native
   * module). An alert never seen is cleared by the person's Done alone.
   */
  private alertGone(seenAtStart: boolean): () => Promise<boolean> {
    let seen = seenAtStart;
    return async () => {
      if ((await this.openOsAlert()) !== null) {
        seen = true;
        return false;
      }
      return seen;
    };
  }

  /** `media`'s own needs-a-person moment, through the same dialog (a photo-access prompt): true when it cleared or was answered Done. */
  private async personForMedia(message: string): Promise<boolean> {
    const dialogs = this.dialogs;
    const asked = this.personScope.getStore();
    if (dialogs === undefined || !dialogs.available() || asked === undefined || asked.has("media")) return false;
    asked.add("media");
    const outcome = await this.askPerson(dialogs, message, this.alertGone(false));
    return outcome === "cleared";
  }

  private accountsNoteDone = false;

  /** The first answer of the session says an accounts file was refused (it sits in a git repo), once (AGENT-TOOLS 1.13 §18.6). */
  private withAccountsNote(answer: CallToolResult): CallToolResult {
    const loaded = this.options.accounts;
    if (this.accountsNoteDone || loaded === undefined) return answer;
    // A plain vault file carries its warning (§20.2); a refused one says why.
    const line = loaded.store !== null ? loaded.note : `Note: ${loaded.blocked}`;
    if (line === undefined) return answer;
    if (answer.content[0]?.type !== "text") return answer;
    this.accountsNoteDone = true;
    // An answer that is the refusal itself already says it.
    if (loaded.store === null && answer.content[0].text.includes(loaded.blocked)) return answer;
    return appendNote(answer, line);
  }

  /** The first call has been answered, so the "needs a person" note has had its turn. */
  private personNoteDone = false;

  /**
   * The first answer of the session says what only a person can do, once, when something is pending: the app isn't
   * connected (open it on the phone, same Wi-Fi), and the phone has never paired. Nothing pending: never.
   */
  private withPersonNote(answer: CallToolResult): CallToolResult {
    if (this.personNoteDone || this.options.pairedBefore === undefined) return answer;
    if (this.host.current() !== undefined) {
      this.personNoteDone = true;
      return answer;
    }
    if (answer.content[0]?.type !== "text") return answer; // nowhere to put it yet: the next answer says it
    const items: string[] = [];
    if (!this.options.pairedBefore()) items.push("the phone isn't paired yet (call `pair`, then the user scans the QR code or taps Connect)");
    items.push("the app isn't connected (the user opens it on the phone, on the same Wi-Fi as this computer)");
    this.personNoteDone = true;
    return appendNote(answer, `Note: needs a person: ${items.join("; ")}.`);
  }

  /** What was told about this app's crashes so far: the crash events up to this number. */
  private notedSeqOf(app: AppIdentity): number {
    return this.notedCrashSeqs.get(identityOf(app)) ?? this.crashBaseline;
  }

  /**
   * The notes for the app this call used (the one at its start, the one at its end, or, with none connected, the
   * one that dropped last). Other apps' events stay pending until that app is the one being driven.
   */
  private withCrashNotes(answer: CallToolResult, mark: number, startedWith: AppIdentity | undefined): CallToolResult {
    const apps = new Map<string, AppIdentity>();
    const current = this.host.current();
    // A call that started on an app answers for that app only: another app that became current meanwhile (the first
    // one dropped) keeps its crashes pending until it is the one being driven (Codex review of 1.3.0).
    const endedWith: AppIdentity | undefined =
      startedWith === undefined ? (current ?? this.host.lastDisconnect()?.session) : current !== undefined && identityOf(current) === identityOf(startedWith) ? current : undefined;
    for (const app of [startedWith, endedWith]) if (app !== undefined) apps.set(identityOf(app), app);
    const events = [...apps.values()]
      .flatMap((app) => this.host.crashEventsAfter(this.notedSeqOf(app), app))
      .sort((a, b) => a.seq - b.seq);
    if (events.length === 0) return answer;
    const told = this.host.crashMark();
    for (const key of apps.keys()) this.notedCrashSeqs.set(key, told);
    let noted = answer;
    for (const event of events) {
      // During this call: no time. A crash the phone had kept and sent later says when it happened.
      const during = event.seq > mark;
      // A crash kept by an earlier run of the app (this host had not started yet) says so, with its date.
      const earlier = event.kind === "crash" && event.crash.source === "saved" && event.crash.ts < this.host.startedAt;
      noted = appendNote(
        noted,
        event.kind === "crash"
          ? crashNote(event.crash, !(during && event.crash.source === "live"), earlier)
          : disconnectNote(during ? undefined : event.at),
      );
    }
    return noted;
  }

  /** A person used the app: the next answer says so once, and `{ref}` targets are stale until the next full list. */
  private markPersonUsedApp(): void {
    this.personActed = true;
    this.personNotePending = true;
  }

  private notConnected(): CallToolResult {
    const silent = this.silentDropMessage();
    if (silent !== undefined) return fail(`Error not_answering: ${silent}`);
    return fail(`Error not_connected: ${this.noAppMessage()}`);
  }

  /** Set when the silence sweep dropped the last app while it wasn't in the background: it stopped answering. */
  private silentDropMessage(): string | undefined {
    const last = this.host.lastDisconnect();
    if (last === undefined || last.silentForMs === undefined) return undefined;
    const when = new Date(last.at).toTimeString().slice(0, 8);
    return `${last.session.app.name} stopped answering at ${when} (nothing from it for ${Math.round(last.silentForMs / 1000)} s while connected). Ask the user to close the app and open it again; it reconnects by itself then.`;
  }

  /** How to connect an app, shown when nothing is connected. */
  noAppMessage(): string {
    const { url, name } = this.options.connect;
    const lines: string[] = [];
    const last = this.host.lastDisconnect();
    if (last !== undefined) {
      const when = new Date(last.at).toTimeString().slice(0, 8);
      const state = last.session.appState?.state;
      const silent = this.silentDropMessage();
      lines.push(
        silent !== undefined
          ? silent
          : state === "inactive"
          ? `${last.session.app.name} disconnected at ${when} after iOS put something in front of it (a system prompt such as a password request, a call, or Control Center). Tapline can't see or answer it: ask the user to deal with it on the phone. The app reconnects by itself.`
          : state === "background"
          ? `${last.session.app.name} disconnected at ${when} after it went to the background (the user switched apps or locked the phone, and iOS paused it). Ask the user to open the app again: it reconnects by itself.`
          : `${last.session.app.name} disconnected at ${when} (${last.reason}). If the app is still open, it reconnects by itself.`,
      );
    }
    return [
      "No app is connected to Tapline.",
      ...lines,
      `This host listens at ${url} on ${name}.`,
      'To connect a phone, call `pair`. A development build loading its code from this computer then asks by itself: the user taps Connect. Other builds: pass the app\'s URL scheme ("scheme" in app.json, e.g. "myapp") and show the user the QR code to scan.',
      "The phone needs to be on the same Wi-Fi as this computer, and the app must be a build with Tapline turned on, open in the foreground.",
      "A phone that paired with this host before reconnects by itself while the app is open; one paired with a host on another port (e.g. before a restart) needs `pair` again. Once it connects, retry.",
    ].join("\n");
  }

  // -- pair

  async pair(args: Shape<"pair">): Promise<CallToolResult> {
    this.personNoteDone = true; // its answer says what the person does; no "call pair" note on it
    const { url, name } = this.options.connect;
    // Zero-QR pairing (Tapline 1.1): a development build whose JavaScript comes from this computer finds the
    // offer itself and asks its person to connect. Open for 10 minutes, one use, local network only.
    const offer = this.host.openDevOffer(name);
    this.writeOffer(offer);
    const devLine =
      "A development build that loads its JavaScript from this computer (Metro) on the same Wi-Fi asks by itself within a few seconds: the user only taps Connect, no QR code (open for 10 minutes, once).";
    if (args.scheme === undefined || args.scheme.trim() === "") {
      return text(
        [
          `Pairing is open for development builds for 10 minutes (${name}).`,
          devLine,
          "Ask the user to open the app on the phone and tap Connect, then call `apps`.",
          "For a TestFlight or release build, call pair again with the app's URL scheme to get a QR code.",
        ].join("\n"),
      );
    }
    let link: string;
    let forget: string;
    try {
      link = pairingLink({ scheme: args.scheme, url, code: this.host.createPairCode(), name });
      forget = forgetLink(args.scheme);
    } catch (error) {
      return fail(`Error bad_params: ${error instanceof Error ? error.message : String(error)}`);
    }
    const png = await qrPng(link, { type: "png", margin: 2, scale: 8, errorCorrectionLevel: "M" });

    let saved = "";
    const path = this.options.pairImagePath;
    if (path !== undefined) {
      try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, png, { mode: 0o600 });
        saved = ` The same QR code is saved at ${path} until it expires.`;
        // Delete it with its code, unless a newer pair call has replaced it.
        const write = ++this.pairWrites;
        setTimeout(() => {
          if (write === this.pairWrites) rmSync(path, { force: true });
        }, this.options.pairImageLifetimeMs ?? PAIR_CODE_TTL_MS).unref();
      } catch {
        // the image in this result is enough
      }
    }
    const lines = [
      `Pairing link for ${name} (valid 10 minutes, works once):`,
      link,
      "",
      `Show the user the QR code (attached).${saved} They scan it with the phone's camera, open the app and tap Connect.`,
      "The phone needs to be on the same Wi-Fi as this computer, and the app must be a build with Tapline turned on.",
      devLine,
      "Once paired, the app reconnects to this host (this address and port) by itself whenever it is open; call `apps` to check.",
      `To unpair the phone, open ${forget} on it.`,
    ];
    return {
      content: [
        { type: "text", text: lines.join("\n") },
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
      ],
    };
  }

  /** `<offerDir>/<port>.json` (0600): the open offer for the Metro helper. Never fails the pair call. */
  private writeOffer(offer: { code: string; name: string; until: number }): void {
    const dir = this.options.offerDir;
    const port = this.host.boundPort();
    if (dir === undefined || port === undefined) return;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${port}.json`);
      writeFileSync(file, JSON.stringify({ code: offer.code, name: offer.name, port, until: offer.until }), { mode: 0o600 });
      this.host.setDevOfferFile(file);
      const remove = (): void => {
        try {
          // only our own offer: a newer pair call has written its own
          if (existsSync(file) && readFileSync(file, "utf8").includes(offer.code)) rmSync(file, { force: true });
        } catch {
          // gone already
        }
      };
      // Used: the code works once, so Metro stops handing it out at once.
      const onConnect = (): void => {
        if (this.host.currentDevOffer()?.code === offer.code) return;
        this.host.off("connect", onConnect);
        remove();
      };
      this.host.on("connect", onConnect);
      setTimeout(() => {
        this.host.off("connect", onConnect);
        try {
          // only our own offer: a newer pair call has written its own
          if (existsSync(file) && readFileSync(file, "utf8").includes(offer.code)) rmSync(file, { force: true });
        } catch {
          // gone already
        }
      }, Math.max(0, offer.until - Date.now())).unref();
    } catch {
      // the host's own endpoint still has it
    }
  }

  // -- apps

  apps(): CallToolResult {
    const sessions = this.host.sessions();
    if (sessions.length === 0) return text(this.noAppMessage());
    const current = this.host.current();
    const now = Date.now();
    const lines = sessions.map((s) => this.appLine(s, current?.id === s.id, now));
    const footer = sessions.length > 1 ? "\n* = selected. Use open_app {app} to switch." : "\n* = selected.";
    return text(`Connected apps:\n${lines.join("\n")}${footer}`);
  }

  /** One line of the `apps` list. */
  private appLine(s: SessionInfo, selected: boolean, now: number): string {
    const version = s.app.version !== undefined ? ` ${s.app.version}${s.app.build !== undefined ? ` (${s.app.build})` : ""}` : "";
    const age = Math.max(0, Math.round((now - s.connectedAt) / 1000));
    return `${selected ? "*" : " "} ${s.id}  ${s.app.name}${version} [${s.app.id}] on ${deviceLabel(s)}, connected ${age}s ago`;
  }

  openApp(args: Shape<"open_app">): CallToolResult {
    const sessions = this.host.sessions();
    if (sessions.length === 0) return this.notConnected();
    const wanted = args.app.trim().toLowerCase();
    // A session id is exact; an app id or name can match several phones, and Tapline never guesses between them.
    const matches = sessions.filter((s) => s.id.toLowerCase() === wanted);
    if (matches.length === 0) {
      matches.push(...sessions.filter((s) => s.app.id.toLowerCase() === wanted || s.app.name.toLowerCase() === wanted));
    }
    if (matches.length > 1) {
      const current = this.host.current();
      const now = Date.now();
      return fail(
        ambiguousBlock(
          `${matches.length} connected apps match "${args.app}".`,
          matches.map((s) => this.appLine(s, current?.id === s.id, now).trim()),
          undefined,
          "Retry with open_app and one of these session ids.",
        ),
      );
    }
    const session = matches[0];
    if (session === undefined) {
      return fail(
        `Error not_connected: ${args.app} isn't connected. Tapline can't launch apps: open it on the phone, on the same Wi-Fi as this computer (it reconnects by itself), or pair it with pair.`,
      );
    }
    try {
      this.host.select(session.id);
    } catch (error) {
      return fail(describeError(error));
    }
    return text(`Driving ${session.app.name} (${session.app.id}) on ${deviceLabel(session)}.`);
  }

  // -- look

  async look(args: Shape<"look"> = {}): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const parts = await this.lookParts(
      session,
      args.screenshot ?? true,
      args.width ?? DEFAULT_SCREENSHOT_WIDTH,
      false,
      args.labels === true,
    );
    return { content: parts.content, ...(parts.isError ? { isError: true } : {}) };
  }

  // -- run (AGENT-TOOLS 1.8 §9): a batch of steps, answered once

  async run(args: Shape<"run">): Promise<CallToolResult> {
    const before = this.runAccount;
    this.runAccount = args.account;
    try {
      // The batch counts its own waits for a person's OK, unless the call already has a counter (§9.3).
      return await (this.holdScope.getStore() !== undefined ? this.runBatch(args) : this.holdScope.run({ ms: 0 }, () => this.runBatch(args)));
    } finally {
      this.runAccount = before;
    }
  }

  private async runBatch(args: Shape<"run">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const steps = args.steps as Step[];
    const problem = this.checkSteps(steps);
    if (problem !== null) return problem;
    return this.runChecked(args, steps, session);
  }

  /** `run`'s checks of its steps, made before any runs (a bad step is `bad_params`, naming its number); null when they all hold. */
  private checkSteps(steps: Step[]): CallToolResult | null {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    for (const [i, step] of steps.entries()) {
      if (!(RUN_TOOLS as readonly string[]).includes(step.tool)) {
        return fail(`Error bad_params: step ${i + 1}: "${step.tool}" can't be a step (steps act; use it on its own call). Steps can be: ${RUN_TOOLS.join(", ")}.`);
      }
      const shape = toolShapes[step.tool as RunTool];
      const { tool: _tool, expect: _expect, route: _route, place: _place, seen: _seen, repaired: _repaired, if: given_if, optional: _optional, ...given } = step as Step & { route?: unknown; place?: unknown; seen?: unknown; repaired?: unknown };
      // §9.1: `if` needs exactly one of text, id or label.
      if (given_if !== undefined && (typeof given_if !== "object" || given_if === null || Array.isArray(given_if))) {
        return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): if is an object with one of text, id or label (and gone), not ${JSON.stringify(given_if)}.`);
      }
      if (_optional !== undefined && typeof _optional !== "boolean") {
        return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): optional is true or false, not ${JSON.stringify(_optional)}.`);
      }
      if (given_if !== undefined) {
        const checked = ifSchema.safeParse(given_if);
        if (!checked.success) {
          return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): ${checked.error.issues.map((issue) => issue.message).join("; ")}.`);
        }
      }
      // §9.1: a step's own look, screenshot and brief are ignored (the batch answers once), whether its tool has them or not.
      const params = Object.fromEntries(Object.entries(given).filter(([key]) => !(key === "look" || key === "screenshot" || key === "brief") || key in shape));
      if (step.tool === "compare_screen" && (params as { update?: unknown }).update !== undefined) {
        return fail(`Error bad_params: step ${i + 1}: update can't be used in run (a step never saves a reference)`);
      }
      const under = step.expect?.under;
      if (under !== undefined) {
        if (step.tool !== "performance") {
          return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): under goes only on a performance step.`);
        }
        const unknown = badUnderKeys(under);
        if (unknown.length > 0) {
          return fail(
            `Error bad_params: step ${i + 1} (${describeRunStep(step)}): under has ${unknown.map((key) => JSON.stringify(key)).join(", ")}; the limits are ${UNDER_KEYS.join(", ")}.`,
          );
        }
        if (Object.keys(under).length === 0) {
          return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): under is empty; give at least one limit (${UNDER_KEYS.join(", ")}).`);
        }
        const negative = Object.entries(under).filter(([, limit]) => limit < 0 || !Number.isFinite(limit));
        if (negative.length > 0) {
          return fail(
            `Error bad_params: step ${i + 1} (${describeRunStep(step)}): under limits can't be negative (${negative.map(([key]) => key).join(", ")}).`,
          );
        }
        if (under["launch_s"] !== undefined && (step as { launch?: unknown }).launch !== true) {
          return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): launch_s goes only on a launch step (performance with launch: true).`);
        }
      }
      // A step's own look and screenshot are ignored (§9.1).
      if (step.tool === "performance") {
        delete params["look"];
        delete params["screenshot"];
        delete params["brief"];
        // Checked before any step runs (and in a dry run), not when this step's turn comes.
        if (params["launch"] === true && params["tap"] !== undefined) {
          return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): launch reloads the app and tap taps in it; give one of them.`);
        }
      }
      // AGENT-TOOLS 1.11 §4: the shared wording, with the step first.
      const known = Object.keys(shape);
      const stray = Object.keys(params).filter((key) => !known.includes(key));
      if (stray.length > 0) {
        return fail(`Error bad_params: step ${i + 1}: ${step.tool} doesn't take ${stray.join(", ")}; ${known.length === 0 ? "it takes no arguments" : `it takes ${known.join(", ")}`}.`);
      }
      const parsed = z.object(shape).strict().safeParse(params);
      if (!parsed.success) {
        return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`).join("; ")}`);
      }
      // A drive step needs a place or a route, and carries no `then` of its own: the steps after it are the batch's (18.4, 9.1).
      if (step.tool === "drive") {
        const wanted = parsed.data as unknown as DriveArgs;
        const words = `step ${i + 1} (${describeRunStep(step)})`;
        const wrong = driveArgsError(wanted);
        if (wrong !== null) return fail(`Error bad_params: ${words}: ${wrong}`);
        if (wanted.then !== undefined) return fail(`Error bad_params: ${words}: then goes on a drive call of its own; in run, put the steps after the drive step.`);
      }
      // A test account's value is checked before any step runs too (§18.6): whole text, a known account for this app.
      if (step.tool === "type_text") {
        const typed = (params as { text?: unknown }).text;
        const named = (params as { account?: unknown }).account;
        const used = typeof typed === "string" ? this.accountText(typed, typeof named === "string" ? named : undefined, session) : null;
        if (used !== null && !used.ok) return fail(`Error ${used.code}: step ${i + 1} (${describeRunStep(step)}): ${used.message}`);
        // A one-time code names the connected app and nothing else (§20.4); nothing is asked of the daemon before the step runs.
        const wrongApp = typeof typed === "string" ? this.otpPrecheck(typed, session) : null;
        if (wrongApp !== null) return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): ${wrongApp}`);
        // `as` is checked before any step runs too (§18.5): it goes only while a route records.
        const as = (params as { as?: unknown }).as;
        const badAs = typeof as === "string" ? this.asRefusal(as, typeof typed === "string" ? typed : "", typeof named === "string" ? named : undefined) : null;
        if (badAs !== null) return fail(badAs.replace("bad_params: ", `bad_params: step ${i + 1} (${describeRunStep(step)}): `));
      }
      // Every reference name is checked before any step runs: a name with a path in it never reaches the disk.
      const names = [step.tool === "compare_screen" ? (params as { name?: unknown }).name : undefined, step.expect?.matches];
      if (names.some((name) => typeof name === "string" && !SCRIPT_NAME.test(name.trim()))) {
        return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): name the reference with letters, digits, '.', '_' and '-'.`);
      }
      if (step.expect?.ignore !== undefined) {
        const ignored = ignoreListSchema.safeParse(step.expect.ignore);
        if (!ignored.success) {
          return fail(`Error bad_params: step ${i + 1} (${describeRunStep(step)}): expect.ignore: ${ignored.error.issues.map((issue) => issue.message).join("; ")}`);
        }
      }
    }
    for (const [i, step] of steps.entries()) {
      const refused = this.journeyStepRefusal(step, i);
      if (refused !== null) return fail(refused);
    }
    return null;
  }

  private async runChecked(args: Shape<"run">, steps: Step[], session: SessionInfo): Promise<CallToolResult> {
    this.diffSaved = null;
    if (args.dry_run === true) return this.dryRunBatch(steps);
    const before = this.unlistedActions.get(session.id) ?? 0;
    const started = Date.now();
    const hold = this.holdScope.getStore() ?? { ms: 0 };
    const heldAtStart = hold.ms;
    const batchId = `b${started.toString(36)}`;
    // A drive step inside a batch may run a batch of its own (a route): the outer one is put back after it.
    const outerBatch = this.batch;
    const notes: string[] = [];
    const trace: string[] = [];
    let ran = 0;
    let stop: { index: number; code: string; message: string; rest: string[] } | null = null;
    // The newest log time when the current step began: a failed step shows the app's warnings since then (§15.4).
    let stepMark: number | undefined;
    for (const [i, step] of steps.entries()) {
      // Time spent waiting for a person's OK isn't counted (§9.3).
      if (Date.now() - started - (hold.ms - heldAtStart) > RUN_TIMEOUT_MS) {
        stop = { index: i, code: "timeout", message: `the batch ran longer than ${RUN_TIMEOUT_MS / 1000} s`, rest: [] };
        break;
      }
      if (this.holdScope.getStore()?.signal?.aborted === true) {
        stop = { index: i, code: "cancelled", message: "the call was cancelled", rest: [] };
        break;
      }
      const at = Date.now();
      // §9.1: one look, right after the step before settled; a skipped step counts as passed and its expect isn't checked.
      const skipped = await this.skipReason(session, step, i + 1);
      if (typeof skipped === "object" && skipped !== null) {
        stop = { index: i, code: "bad_params", message: skipped.error, rest: [] };
        break;
      }
      if (skipped !== null) {
        trace.push(skipped);
        ran++;
        continue;
      }
      stepMark = this.newestLogTs(session.id);
      this.batch = { id: batchId, step: i + 1 };
      // The verification replay of a repaired script: a step a repair wrote or changed keeps the whole floor (the gate in repair mode); the user's own steps run as written.
      const gated = this.replayContext?.gateRepaired === true && (step as { repaired?: unknown }).repaired !== undefined;
      const answer = await (gated ? this.repairScope(() => this.runStep(step)) : this.runStep(step)).finally(() => {
        this.batch = outerBatch;
      });
      const said = answer.content.map((block) => (block.type === "text" ? block.text : "")).join("\n").trim();
      if (answer.isError === true) {
        stop = { index: i, ...parseError(said) };
        break;
      }
      notes.push(...stepNotes(said, i + 1));
      if (step.expect?.under !== undefined) {
        // AGENT-TOOLS §15.3: the limits a performance step must keep; every broken one is listed.
        const measured = this.lastPerf;
        if (measured === undefined) {
          // A limit nobody measured must not pass.
          stop = { index: i, code: "expect_failed", message: "no measurement to check.", rest: [] };
          break;
        }
        const checked = checkUnder(step.expect.under, measured);
        notes.push(...checked.notes.map((note) => `Note (step ${i + 1}): ${note}`));
        if (checked.missed.length > 0) {
          stop = { index: i, code: "expect_failed", message: `${checked.missed.join("; ")}.`, rest: [] };
          break;
        }
      } else if (step.expect !== undefined) {
        this.matchedNames = [];
        const missed = await this.expectMissed(step.expect);
        if (missed !== null) {
          stop = { index: i, code: "expect_failed", message: `its action ran, but ${missed}`, rest: [] };
          break;
        }
        if (step.expect.matches !== undefined && this.matchedNames.length > 0) {
          notes.push(`Note (step ${i + 1}): the screen matches "${step.expect.matches}" with changes: changed at ${this.matchedNames.join(", ")}`);
        }
        // A picture check that held is kept in a recording, as compare_screen's is: right after the action, the
        // script makes it that step's `matches` again (AGENT-TOOLS 1.9 §14.2).
        if (step.expect.matches !== undefined) {
          const recorded = await this.recordCompare({
            name: step.expect.matches,
            ...(step.expect.threshold !== undefined ? { threshold: step.expect.threshold } : {}),
            ...(step.expect.ignore !== undefined ? { ignore: ignoreListSchema.parse(step.expect.ignore) } : {}),
          });
          if (recorded !== null) {
            stop = { index: i, ...parseError(recorded) };
            break;
          }
        }
      }
      const route = (step as { route?: unknown }).route;
      if (Array.isArray(route) && route.every((part) => typeof part === "string")) {
        const now = await this.currentRoute();
        if (now !== null && now.join(" \u203a ") !== route.join(" \u203a ")) {
          stop = { index: i, code: "expect_failed", message: `its action ran, but it ended on ${now.join(" \u203a ")}; the recording ended on ${route.join(" \u203a ")}`, rest: [] };
          break;
        }
      }
      ran++;
      if (args.trace === true) trace.push(`  ${i + 1}. ${said.split("\n")[0] ?? ""} (${((Date.now() - at) / 1000).toFixed(1)} s)`);
    }
    // The batch is one call: the changes below are measured from the list the agent had before it.
    if (before > 0) this.unlistedActions.set(session.id, before);
    else this.unlistedActions.delete(session.id);
    const total = steps.length;
    const failed = stop !== null;
    // The last failed run or replay is what `bug_report {from: "failure"}` makes a bug of, while it is still the last one (§29.3).
    this.lastFailure = stop !== null ? this.expectFailedFinding(session, steps, stop) : null;
    const head = stop === null
      ? `Ran ${total} of ${total} steps in ${((Date.now() - started) / 1000).toFixed(1)} s.`
      : `Error ${stop.code}: Ran ${ran} of ${total} steps; stopped at step ${stop.index + 1} (${describeRunStep(steps[stop.index] as Step)}): ${stop.message}`;
    const diffNote = stop !== null && this.diffSaved !== null ? [`Note: the difference is saved at ${this.diffSaved}.`] : [];
    const first = [head, ...trace, ...(stop?.rest ?? []), ...diffNote].join("\n");
    const tail = [...(stop !== null ? this.failureLogs(session.id, stop.index + 1, stepMark) : []), ...notes];
    let response: CallToolResult;
    const live = this.host.current();
    if (args.look === false || live === undefined) {
      this.markListUnseen();
      response = text([first, ...tail].join("\n"));
    } else {
      response = await this.withLook(live, first, args.screenshot === true, this.briefOn(args.brief));
      if (tail.length > 0) {
        const [top, ...rest] = response.content;
        if (top !== undefined && top.type === "text") response = { ...response, content: [{ type: "text", text: [top.text.trimEnd(), ...tail].join("\n") }, ...rest] };
      }
    }
    return failed ? { ...response, isError: true } : response;
  }

  /**
   * AGENT-TOOLS 1.13 §9.1: the skipped line when a step's `if` or `optional` doesn't hold, else null. One look per
   * check, no wait. The app answers a `waitFor` with `once`; an older app, or a `ref`, is read from one list.
   */
  private async skipReason(session: SessionInfo, step: Step, number: number): Promise<string | { error: string } | null> {
    for (const condition of conditionsOf(step)) {
      const params = waitParams(condition, this.userEyes());
      const once = params !== null && session.capabilities.includes("waitOnce");
      // The list cuts a long text on the wire (`…(+57)`), so the host can't match one longer than the cut itself.
      if (!once && params !== null && "text" in condition.probe && condition.probe.text.length > WIRE_TEXT_MAX) {
        return { error: `its ${condition.kind} text is longer than the app's list shows, and this app can't check it once; use a shorter text, or a wait_for first.` };
      }
      let holds: boolean;
      if (once) {
        try {
          const raw = await this.sendRequest("waitFor", params, { sessionId: session.id });
          holds = typeof raw === "object" && raw !== null && (raw as { found?: unknown }).found === true;
        } catch {
          // A check that couldn't be made doesn't hide the step: it runs and says what is wrong itself.
          holds = true;
        }
      } else {
        const tree = treeResultSchema.safeParse(await this.sendRequest("tree", { peek: true }, { sessionId: session.id }).catch(() => null));
        holds = tree.success ? holdsIn(tree.data.elements, condition) : true;
      }
      if (!holds) return skippedLine(number, condition.kind, condition.label, condition.gone);
    }
    return null;
  }

  /** The newest log time of a session (or of the app's current session), undefined without lines. */
  private newestLogTs(sessionId: string): number | undefined {
    return this.sessionLogs(sessionId).reduce<number | undefined>((max, e) => (e.ts !== undefined && (max === undefined || e.ts > max) ? e.ts : max), undefined);
  }

  /**
   * A session's buffered lines, also when it has ended. When the same app on the same phone came back as a new
   * session, that session's lines follow. Another app's lines never stand in for it (Codex review of 1.3.0).
   */
  private sessionLogs(sessionId: string): LogEntry[] {
    const record = this.host.sessionRecord(sessionId);
    if (record === undefined) return [];
    const now = this.host.current();
    if (now === undefined || now.id === sessionId || identityOf(now) !== record.identity) return record.events;
    try {
      return [...record.events, ...this.host.logs(now.id)];
    } catch {
      return record.events;
    }
  }

  /** AGENT-TOOLS §15.4: `Logs (since step <n>):` and up to 20 lines at warning or above since the step began. */
  private failureLogs(sessionId: string, step: number, since: number | undefined): string[] {
    const lines = filterLogs(this.sessionLogs(sessionId), { since, level: "warning", limit: 20 });
    return lines.length === 0 ? [] : [`Logs (since step ${step}):`, ...formatLogs(lines).split("\n")];
  }

  /** `run` with dry_run (§11.4): the steps are checked already; step 1 is resolved, nothing is touched. */
  private async dryRunBatch(steps: Step[]): Promise<CallToolResult> {
    const total = steps.length;
    const first = steps[0] as Step;
    const head = `Would run ${total} step${total === 1 ? "" : "s"}`;
    // §11.4: a dry run runs every check, the step's own if and optional too.
    const live = this.host.current();
    const skipped = live === undefined ? null : await this.skipReason(live, first, 1);
    if (typeof skipped === "string") return text(`${head}; step 1 would be skipped (${skipped.replace(/^ {2}1\. skipped \(/, "").replace(/\)\.$/, "")}).`);
    if (skipped !== null) return fail(`Error bad_params: ${head}; step 1 (${describeRunStep(first)}): ${skipped.error}`);
    // A performance step with a tap: the tap resolves like any touch; nothing is measured (AGENT-TOOLS §15.3).
    const perfTap = first.tool === "performance" ? (first as Record<string, unknown>)["tap"] : undefined;
    const probe = perfTap !== undefined ? ({ tool: "tap", target: perfTap } as Step) : first;
    if (["tap", "long_press", "toggle", "type_text", "scroll", "back", "swipe", "drive"].includes(probe.tool)) {
      const answer = await this.runStep({ ...probe, dry_run: true } as Step);
      const said = answer.content.map((block) => (block.type === "text" ? block.text : "")).join("\n").trim();
      const [line, ...rest] = said.split("\n");
      if (answer.isError === true) {
        const { code, message } = parseError(said);
        return fail(`Error ${code}: ${head}; step 1 (${describeRunStep(first)}) would fail: ${message}`);
      }
      const would = (line ?? "").replace(/^Would /, "would ");
      return text([`${head}; step 1 ${would}`, ...rest].join("\n"));
    }
    if (first.tool === "performance") {
      const p = first as Record<string, unknown>;
      return text(`${head}; step 1 would ${p["launch"] === true ? "reload the app and time it to the first settled screen" : `measure ${Number(p["seconds"] ?? 3)} s`}.`);
    }
    return text(`${head}; step 1 would ${describeRunStep(first)}.`);
  }

  /** One step of `run`, as its own tool call without a list. */
  private runStep(step: Step): Promise<CallToolResult> {
    return this.journeyScope.run("step", () => this.runStepNow(step));
  }

  private runStepNow(step: Step): Promise<CallToolResult> {
    const { tool, expect: _expect, route: _route, place: _place, seen: _seen, repaired: _repaired, if: _if, optional: _optional, ...rest } = step as Step & { route?: unknown; place?: unknown; seen?: unknown; repaired?: unknown };
    const quiet = { ...rest, look: false, screenshot: false, brief: false };
    switch (tool as RunTool) {
      case "tap":
        return this.tap(quiet as Shape<"tap">);
      case "long_press":
        return this.longPress(quiet as Shape<"long_press">);
      case "type_text":
        return this.typeText(quiet as Shape<"type_text">);
      case "scroll":
        return this.scroll(quiet as Shape<"scroll">);
      case "toggle":
        return this.toggle(quiet as Shape<"toggle">);
      case "back":
        return this.back(quiet as Shape<"back">);
      case "swipe":
        return this.swipe(quiet as Shape<"swipe">);
      case "open_url":
        return this.openUrl(quiet as Shape<"open_url">);
      case "wait":
        return this.wait({ seconds: Number((rest as { seconds?: unknown }).seconds ?? 0) });
      case "wait_for":
        return this.waitFor(quiet as Shape<"wait_for">);
      case "app_command":
        return this.appCommand(quiet as Shape<"app_command">);
      case "compare_screen":
        return this.compareStep(rest as Shape<"compare_screen">);
      case "performance":
        return this.performance(rest as Shape<"performance">);
      case "drive":
        return this.drive(rest as Shape<"drive">, { asStep: true });
    }
  }

  /** The screen's route names now (one cheap read), or null when the app has no router or didn't answer. */
  private async currentRoute(): Promise<string[] | null> {
    const session = this.host.current();
    if (session === undefined) return null;
    const tree = treeResultSchema.safeParse(await this.sendRequest("tree", { peek: true }, { sessionId: session.id }).catch(() => null));
    return tree.success && tree.data.route !== undefined ? tree.data.route.names : null;
  }

  /** Null when the expectation holds within its time; else how it failed. */
  private async expectMissed(e: Expect): Promise<string | null> {
    if (e.text !== undefined || e.id !== undefined || e.label !== undefined) {
      const missed = await this.textExpectMissed(e);
      if (missed !== null) return missed;
    }
    // A picture check comes last, once the rest held.
    return e.matches === undefined ? null : this.matchMissed(e.matches, e.threshold ?? DEFAULT_MATCH_THRESHOLD, ignoreListSchema.parse(e.ignore ?? []));
  }

  private async textExpectMissed(e: Expect): Promise<string | null> {
    const seconds = e.timeout ?? EXPECT_TIMEOUT_S;
    const which = e.text !== undefined ? { text: e.text } : e.id !== undefined ? { id: e.id } : { label: e.label as string };
    const seen = await this.waitFor({ ...which, ...(e.gone === true ? { gone: true } : {}), timeout: Math.max(0.5, seconds), look: false });
    if (seen.isError === true) return expectFailure(e, seconds);
    if (e.value === undefined || e.gone === true) return null;
    // The element is there: wait for its value (a switch reads "on" or "off").
    const session = this.host.current();
    if (session === undefined) return expectFailure(e, seconds);
    const until = Date.now() + seconds * 1000;
    let actual: string | undefined;
    for (;;) {
      const tree = treeResultSchema.safeParse(await this.sendRequest("tree", { peek: true }, { sessionId: session.id }).catch(() => null));
      const element = tree.success
        ? tree.data.elements.find((el) => (e.id !== undefined ? el.testID === e.id : labelOfElement(el).toLowerCase() === (e.label ?? "").toLowerCase()))
        : undefined;
      if (element !== undefined) {
        actual = typeof element.checked === "boolean" ? (element.checked ? "on" : "off") : typeof element.value === "string" ? element.value : undefined;
        // A switch takes "true" and "false" too (it reads checked=true in the list).
        const wanted = typeof element.checked === "boolean" && (e.value === "true" || e.value === "false") ? (e.value === "true" ? "on" : "off") : e.value;
        if (actual === wanted) return null;
      }
      if (Date.now() >= until) return expectFailure(e, seconds, actual);
      await sleep(100);
    }
  }

  // -- inspect (Tapline 1.1): from the screen to the code

  async inspect(args: Shape<"inspect">): Promise<CallToolResult> {
    const hiddenInspect = this.hiddenTarget(args.target);
    if (hiddenInspect !== null) return hiddenInspect;
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    let raw: unknown;
    try {
      raw = await this.sendRequest("inspect", { target: toWireTarget(args.target) }, { sessionId: session.id });
    } catch (error) {
      return fail(describeError(error));
    }
    const parsed = inspectResultSchema.safeParse(raw);
    if (!parsed.success) return fail("Error internal: the app returned an inspect answer the host could not read.");
    return text(formatInspect(parsed.data, undefined, (t) => this.scrubSecrets(t)));
  }

  // -- audit (AGENT-TOOLS 1.8 §10)

  async audit(args: Shape<"audit"> = {}): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    if (!session.capabilities.includes("audit")) {
      return fail("Error unsupported: this app's Tapline is too old for audit; update react-native-tapline (check_layout works meanwhile).");
    }
    let raw: unknown;
    try {
      raw = await this.sendRequest("audit", args.types !== undefined ? { types: args.types } : {}, { sessionId: session.id });
    } catch (error) {
      return fail(describeError(error));
    }
    const parsed = auditResultSchema.safeParse(raw);
    if (!parsed.success) return fail("Error internal: the app returned an audit the host could not read.");
    const title = auditTitle(await this.currentRoute(), session.app.name);
    return text([formatAudit(title, parsed.data, args.types), ...this.takePersonNote()].join("\n"));
  }

  // -- ux_check (AGENT-TOOLS 1.12 §17.3)

  /** The house rule `max_taps_to_goal`, for the journey to check at stop; undefined when the user set none. */
  get maxTapsToGoal(): number | undefined {
    return this.uxRules.maxTapsToGoal;
  }

  async uxCheck(_args: Shape<"ux_check"> = {}): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    if (!session.capabilities.includes("uxCheck")) {
      return fail("Error unsupported: this app's Tapline is too old for ux_check; update react-native-tapline (audit and check_layout work meanwhile).");
    }
    const earlier = this.uxJourney?.earlier() ?? null;
    let raw: unknown;
    try {
      raw = await this.sendRequest(
        "uxCheck",
        { ...(this.userEyes() ? { glass: true } : {}), ...(this.uxRules.wayBack ? { wayBack: true } : {}), ...(earlier !== null ? { earlier } : {}) },
        { sessionId: session.id },
      );
    } catch (error) {
      return fail(describeError(error));
    }
    const parsed = uxResultSchema.safeParse(raw);
    if (!parsed.success) return fail("Error internal: the app returned a UX check the host could not read.");
    const title = auditTitle(await this.currentRoute(), session.app.name);
    this.uxJourney?.seen?.(
      title,
      parsed.data.actions,
      parsed.data.issues.map((i) => {
        const frame = i.element?.frame ?? i.where?.frame;
        return {
          kind: i.kind,
          problem: i.problem,
          basis: i.basis,
          ...(i.element ? { ref: i.element.ref } : {}),
          ...(frame ? { frame } : {}),
        };
      }),
    );
    const body = formatUxCheck(title, parsed.data, { textRules: this.uxRules.text, journeyRunning: this.uxJourney !== null, eyes: this.userEyes() });
    return text([body, ...this.takePersonNote()].join("\n"));
  }

  // -- media (AGENT-TOOLS 1.12 §17.6): the logic is in media.ts

  /** What `media` remembers per app: the asset ids it added, and the picker skips a journey report reads. */
  readonly mediaState = new MediaState();

  async media(args: Shape<"media"> = {}): Promise<CallToolResult> {
    if (args.remove === true && (args.add !== undefined || args.picker === true)) {
      return fail("Error bad_params: media with remove: true takes nothing else; add and picker are separate calls.");
    }
    if (args.remove !== true && args.add === undefined) {
      return fail("Error bad_params: media needs add (picture paths), or remove: true.");
    }
    if (args.picker === true && args.add === undefined) return fail("Error bad_params: media with picker: true needs add (picture paths).");
    // Adding needs the user's yes, and so does picker: true (its pictures go into the app as if the person picked them;
    // AGENT-TOOLS 1.12 §17.6: media with add needs confirm; 1.5 review, finding 10).
    if (args.remove !== true && args.confirm !== true) {
      return fail(
        args.picker === true
          ? "Error bad_params: media with picker hands pictures to the app as if the person picked them; ask your user first, then pass confirm: true."
          : CONFIRM_ERROR,
      );
    }
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    return runMedia(args, {
      state: this.mediaState,
      session,
      request: (params) => this.sendRequest("media", params, { sessionId: session.id, timeoutMs: 60_000 }),
      describeError,
      askPerson: (message) => this.personForMedia(message),
    });
  }

  // -- check_layout

  async checkLayout(_args: Shape<"check_layout"> = {}): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    let raw: unknown;
    try {
      raw = await this.sendRequest("check", {}, { sessionId: session.id });
    } catch (error) {
      return fail(describeError(error));
    }
    const parsed = findingsSchema.safeParse(raw);
    if (!parsed.success) return fail("Error internal: the app returned layout findings the host could not read.");
    const findings = parsed.data.findings;
    if (findings.length === 0) {
      return text(
        "No layout problems found (tap areas, cut-off edges, overlaps, text contrast, unnamed buttons, truncated text). Refs are from the latest list.",
      );
    }
    const lines = findings.map((f) => `${f.ref} ${f.kind}: ${f.message}`);
    return text(
      [`${findings.length} finding${findings.length === 1 ? "" : "s"} (refs from the latest list):`, ...lines].join("\n"),
    );
  }

  /** Saves a file-mode screenshot (0600, newest `screenshotKeep` kept) and returns its path. */
  private saveShot(sessionId: string, mime: string, data: string): string {
    const dir = this.options.screenshotDir;
    if (dir === undefined) throw new Error("screenshotDir is not set");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ext = mime === "image/png" ? "png" : "jpg";
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${stamp}-${sessionId}-${++this.shotCount}.${ext}`);
    writeFileSync(path, Buffer.from(data, "base64"), { mode: 0o600 });
    this.shotFiles.push(path);
    const keep = Math.max(1, this.options.screenshotKeep ?? 50);
    while (this.shotFiles.length > keep) {
      const old = this.shotFiles.shift();
      if (old !== undefined) rmSync(old, { force: true });
    }
    return path;
  }

  /** Text lines plus an optional screenshot (an image, or a file path in file mode) for the current screen. */
  private async lookParts(
    session: SessionInfo,
    wantScreenshot: boolean,
    width: number = DEFAULT_SCREENSHOT_WIDTH,
    onlyChanges = false,
    labels = false,
    /** A brief answer (AGENT-TOOLS 1.13 §13.4): the answer's first line; the text then starts with it. */
    briefFirst?: string,
  ): Promise<{ content: CallToolResult["content"]; isError: boolean; placeLine?: string }> {
    const sid = session.id;
    // Right after typing into a password field iOS may still show its last character: no picture then, and the note says why.
    const secureQuiet = wantScreenshot && this.secureWindow();
    if (secureQuiet) wantScreenshot = false;
    // Changes only make sense against a list this agent has already been given in this session.
    const askChanges = onlyChanges && this.listed.has(sid);
    // `onlyChanges` is the after-an-action call. With `changes: true` the app keeps the refs and
    // counts on from the highest one; `look` (onlyChanges false) always restarts at e1.
    const eyes = this.userEyes();
    const treeParams: Record<string, unknown> = { ...(askChanges ? { changes: true } : {}), ...(eyes ? { glass: true } : {}) };
    const treePromise = this.sendRequest("tree", treeParams, { sessionId: sid });
    const shotPromise =
      wantScreenshot && !this.noScreenshot.has(sid)
        ? this.sendRequest("screenshot", { format: "jpg", quality: 0.75, maxWidth: width }, { sessionId: sid })
            .then((value) => ({ ok: true as const, value }))
            .catch((error: unknown) => ({ ok: false as const, error }))
        : Promise.resolve(undefined);

    let tree: TreeResult;
    try {
      const raw = await treePromise;
      const parsed = treeResultSchema.safeParse(raw);
      if (!parsed.success) {
        throw new TaplineError("internal", "The app returned a tree the host could not read.");
      }
      tree = parsed.data;
    } catch (error) {
      await shotPromise;
      return { content: [{ type: "text", text: describeError(error) }], isError: true };
    }

    this.listed.add(sid);
    const previousElements = this.listBase?.elements ?? [];
    const seenPlace = this.observePlace(session, tree);
    this.lastLookRoute = tree.route?.names;
    if (tree.screen) this.lastScreen = { w: tree.screen.width, h: tree.screen.height };
    const alertsNow = (tree.alerts ?? []).length > 0;
    const alertGone = this.alertOpen.has(sid) && !alertsNow;
    if (alertsNow) this.alertOpen.add(sid);
    else this.alertOpen.delete(sid);
    // An alert that was open before and now reads differently (its message alone, say) is a change of the alert.
    const signature = alertsNow ? alertSignature(tree) : undefined;
    const alertChanged = signature !== undefined && this.alertSeen.has(sid) && this.alertSeen.get(sid) !== signature;
    if (signature !== undefined) this.alertSeen.set(sid, signature);
    else this.alertSeen.delete(sid);
    const changeBlock = askChanges ? changeParts(tree, { alertGone, alertChanged, eyes }) : null;
    const changesText = changeBlock === null ? null : [changeBlock.label, ...changeBlock.header, ...changeBlock.changes].join("\n");
    // For the call log: the list the agent now has (a change block leaves it as it was, but no longer certain).
    if (changesText === null) this.listBase = { elements: tree.elements, stale: false, unseen: false };
    else if (this.listBase !== undefined) this.listBase = { elements: this.listBase.elements, stale: true, unseen: false };
    // A full list gives every ref a fresh meaning, so refs are trustworthy again.
    if (changesText === null) this.personActed = false;
    // §18.1: `Place:` goes on a full list (a new screen), never on a same-screen answer, and not on the glass of a user's eyes.
    // `look` carries it in its header; an action's answer carries it after its first line (withLook).
    const placeLine = changesText === null && !eyes ? (seenPlace?.line ?? null) : null;
    const lines = [changesText ?? formatTree(tree, { name: session.app.name, id: session.app.id }, { eyes, ...(!onlyChanges && placeLine !== null ? { place: placeLine } : {}) })];
    // Brief: the same facts, cut. The journey's copy of a full list below stays whole.
    const briefed =
      briefFirst === undefined
        ? undefined
        : changeBlock !== null
          ? briefLines({ first: briefFirst, label: changeBlock.label, changes: changeBlock.changes, fixed: changeBlock.header })
          : briefLines({
              first: briefFirst,
              ...(placeLine !== null ? { place: placeLine } : {}),
              changes: [],
              screen: briefScreen(tree.elements, previousElements, { eyes }),
              // The off-screen count stays: what lies below or above is what an agent scrolls for.
              fixed: [...formatStatus(tree), ...offScreenLine(tree, eyes)],
            });
    // A journey keeps the first full list of each screen (and counts the screens entered) for its report.
    if (changesText === null) this.journeyRun?.noteFullList({ route: tree.route?.names ?? [], text: lines[0] ?? "", fromAction: onlyChanges });
    // A full list in place of the changes (most of the screen changed) still says what changed out of view.
    if (askChanges && changesText === null && !eyes && briefed === undefined) lines.push(...formatOffScreenAfterList(tree));
    if (briefed !== undefined) lines[0] = briefed.join("\n");
    const content: CallToolResult["content"] = [];
    // Notes come last (AGENT-TOOLS §3.6), after the list and any `Screenshot:` path line.
    const notes: string[] = [...alertNotes(tree)];
    // The changes are measured from the agent's last list. When actions answered with `look: false`
    // came in between, the block covers them too, and "No visible change." may hide a round trip
    // (a sheet opened by one action and closed by this one): say how far back the list is.
    const unlisted = this.unlistedActions.get(sid) ?? 0;
    this.unlistedActions.delete(sid);
    if (changesText !== null && unlisted > 0) {
      notes.push(`Note: changes are since your last list, ${unlisted + 1} actions ago.`);
    }
    if (tree.elements.length === 0) {
      notes.push(
        "Note: something outside the app (a system sheet or browser) may cover it. Tapline can't see it: ask the user, or use Tapwright.",
      );
    }
    const shot = await shotPromise;
    if (shot === undefined) {
      if (secureQuiet) notes.push(SECURE_QUIET_NOTE);
      else if (wantScreenshot) notes.push(NO_SCREENSHOT_NOTE);
    } else if (shot.ok) {
      const parsed = screenshotResultSchema.safeParse(shot.value);
      if (!parsed.success) notes.push("Note: screenshot unavailable: unreadable response.");
      else {
        const screen = tree.screen;
        const image =
          labels && screen !== null && screen !== undefined
            ? annotateScreenshot(parsed.data, tree.elements, screen)
            : parsed.data;
        if (labels) notes.push("Note: screenshot labeled with each tappable element's box and ref.");
        if (this.options.screenshots === "file") {
          const { mime, data, width: w, height: h } = image;
          try {
            const size = w !== undefined && h !== undefined ? ` (${w}x${h})` : "";
            lines.push(`Screenshot: ${this.saveShot(sid, mime, data)}${size}`);
          } catch (error) {
            notes.push(`Note: screenshot not saved: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else content.push({ type: "image", data: image.data, mimeType: image.mime });
      }
    } else if (shot.error instanceof TaplineError && shot.error.code === "unsupported") {
      this.noScreenshot.add(sid);
      notes.push(NO_SCREENSHOT_NOTE);
    } else {
      notes.push(`Note: screenshot failed: ${shot.error instanceof Error ? shot.error.message : String(shot.error)}`);
    }
    lines.push(...notes, ...this.takePersonNote());
    return {
      content: [{ type: "text", text: lines.join("\n") }, ...content],
      isError: false,
      ...(onlyChanges && placeLine !== null && briefed === undefined ? { placeLine } : {}),
    };
  }

  // -- places and roads (AGENT-TOOLS 1.13 §18.1 to §18.3)

  /** The app's map, when this server keeps maps. */
  private mapOf(session: SessionInfo): AppMap | undefined {
    const map = this.options.maps?.forApp(session.app);
    map?.useSession(session.id);
    return map;
  }

  /** Where the app is, from what this host already holds, and how to ask it. */
  private placeSource(session: SessionInfo): PlaceSource {
    return {
      capabilities: session.capabilities,
      latest: () => this.host.sessions().find((s) => s.id === session.id)?.place,
      request: (method, params) => this.sendRequest(method, params ?? {}, { sessionId: session.id }),
    };
  }

  /** Notes the place a fresh list shows. A script that replays doesn't change the map (§18.9); a map that fails never fails a call. */
  private observePlace(session: SessionInfo, tree: TreeResult): { line: string | null } | undefined {
    if (this.replaying) return undefined;
    try {
      const map = this.mapOf(session);
      if (map === undefined) return undefined;
      const seen = map.observe(tree);
      this.observedPlace = { sessionId: session.id, place: seen.place };
      return { line: seen.line };
    } catch {
      return undefined;
    }
  }

  /** Redaction for what the map keeps: the run's typed values inside an explore, always the vault's values and the session's codes. */
  private mapScrub(text: string): string {
    const run = this.exploreScope.getStore()?.run;
    return run !== undefined ? this.exploreScrub(run, text) : this.replayScrub(text);
  }

  /** A road with every text checked by `mapScrub`: names that change are dropped; null when the move itself holds such a text. */
  private cleanRoad<M extends object>(move: M, names: NonNullable<MapRoad["names"]>): { move: M; names: NonNullable<MapRoad["names"]> } | null {
    const holds = (value: unknown): boolean => typeof value === "string" && this.mapScrub(value) !== value;
    const target = (move as { target?: unknown }).target;
    if (typeof target === "object" && target !== null && Object.values(target).some(holds)) return null;
    if (holds((move as { url?: unknown }).url)) return null;
    const kept: NonNullable<MapRoad["names"]> = {};
    for (const key of ["id", "label", "text"] as const) {
      const value = names[key];
      if (value !== undefined && !holds(value)) kept[key] = value;
    }
    return { move, names: kept };
  }

  /** Before a move: where the app is. Only for calls that can be roads (§18.2). */
  private roadStart(session: SessionInfo, method: string): { map: AppMap; from: Place | null; typed: boolean } | null {
    if (this.options.maps === undefined || this.replaying || !ROAD_METHODS.has(method)) return null;
    try {
      const map = this.mapOf(session);
      if (map === undefined) return null;
      const from = placeBefore(this.placeSource(session), map);
      // Asked now: the look after the move may arrive somewhere else, and that clears it.
      return { map, from, typed: map.typedHere() };
    } catch {
      return null;
    }
  }

  /**
   * After a move: saves it as a road when it left a place and arrived at another, and says what the agent should
   * know (a link that wasn't saved; a move that needed a person's OK). Never fails the call.
   */
  private async roadEnd(
    session: SessionInfo,
    start: { map: AppMap; from: Place | null; typed: boolean },
    call: { method: string; params: unknown; result: unknown },
    neededOk: boolean,
  ): Promise<string[]> {
    try {
      const { map, from } = start;
      if (call.method === "type") {
        map.noteTyped();
        return [];
      }
      const classified = classifyMove({ ...call, by: "agent", neededOk, replaying: this.replaying });
      if ("skip" in classified && classified.skip !== "needed_ok") return [];
      const source = this.placeSource(session);
      const arrived = this.observedPlace?.sessionId === session.id ? this.observedPlace.place : (await placeNow(source, map))?.place;
      if (arrived === undefined) return [];
      const moved = from === null || from.name !== arrived.name;
      if ("skip" in classified) return from !== null && moved ? ["Note: not saved as a road (it needed a person's OK)."] : [];
      // The log keeps where this touch led and whether the map already knew the way, for the report's known-way flag (16.1).
      if (from !== null && moved) {
        const known = map.data().roads.some((road) => road.from === from.name && road.to === arrived.name && (road.by === "tapline" || road.by === "both") && map.isProven(road));
        const logged = this.callScope.getStore()?.entries.at(-1);
        if (logged !== undefined && logged.entry.of === undefined && AGENT_TOUCHES.has(logged.entry.tool)) logged.entry.way = { from: from.name, to: arrived.name, known };
      }
      let move = classified.move;
      if (move.tool === "open_url") {
        // Only a place the link reached keeps it, and only as a pattern, never the real url (§18.3).
        if (!moved) return [];
        if (session.capabilities.includes("places")) await map.ensureKnown(session.id, () => source.request("places", {}));
        const url = (call.params as { url?: unknown }).url;
        const link = typeof url === "string" ? map.rememberLink(url, arrived) : { saved: false as const, message: LINK_NOT_SAVED };
        if (!link.saved) return [link.message];
        move = { ...move, url: link.link };
      }
      // Nothing a person or a run typed, and no vault value or code, goes into a road: a name that shows one is dropped, and a road that
      // can only be told by such a text is not saved (it could not be replayed without the secret either).
      const clean = this.cleanRoad(move, classified.names);
      if (clean === null) return [];
      map.recordMove(from, clean.move, clean.names, arrived, Date.now() - (this.actionStartedAt ?? Date.now()), start.typed ? "typed" : undefined);
      return [];
    } catch {
      return [];
    }
  }

  // -- actions

  /** The one-time note that a person used the app, as note lines (empty when already said). */
  private takePersonNote(): string[] {
    if (!this.personNotePending) return [];
    this.personNotePending = false;
    return ["Note: a person used the app since your last look."];
  }

  /** An action answered with no list and no changes: the call log can't say what is in the list any more. */
  private markListUnseen(): void {
    if (this.listBase !== undefined) this.listBase = { ...this.listBase, unseen: true };
  }

  /** Remembers where a touch landed (points, and the touched element's frame) for the journey's frame and GIF. */
  private noteTouch(method: string, params: unknown, result: unknown): void {
    if (this.recorder === undefined || (method !== "press" && method !== "longPress" && method !== "toggle")) return;
    const element = typeof result === "object" && result !== null && "element" in result ? elementSchema.safeParse((result as { element: unknown }).element) : null;
    const frame = element?.success ? element.data.frame : undefined;
    const target = typeof params === "object" && params !== null ? (params as { target?: unknown }).target : undefined;
    const t = typeof target === "object" && target !== null ? (target as { x?: unknown; y?: unknown }) : undefined;
    const point =
      t !== undefined && typeof t.x === "number" && typeof t.y === "number"
        ? { x: t.x, y: t.y }
        : frame ? { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 } : undefined;
    this.lastTouch = { ...(point !== undefined ? { point } : {}), ...(frame ? { frame } : {}) };
  }

  /** Runs one action in its own approval scope (see `okScope`). */
  private act(...args: Parameters<TaplineTools["actScoped"]>): ReturnType<TaplineTools["actScoped"]> {
    return this.okScope.run({ used: false }, () => this.actScoped(...args));
  }

  /** Runs a request, then (unless disabled) appends the fresh element list and how long the app took to settle. */
  private async actScoped(
    method: string,
    params: unknown,
    describe: (result: unknown) => string,
    withLook: boolean | undefined,
    screenshot?: boolean,
    extraNotes?: (result: unknown) => string[],
    /** True when the result means nothing was done: the first line is then the whole answer. */
    nothingDone?: (result: unknown) => boolean,
    /** Runs inside the agent's turn, right before the request: an answer stops the call there (the policy). */
    preflight?: () => Promise<CallToolResult | null>,
    /** The call's `brief` (else the server's `--brief`): a short answer, and no `Settled in` line (AGENT-TOOLS 1.13 §13.4). */
    brief?: boolean,
    /** A touch that may change nothing: the note after `No visible change.` is made for it (AGENT-TOOLS 1.13 §3). */
    touch?: NoChangeAction,
    /** What goes only to the app: a test account's value and the kind of field it may go into. Nothing else sees it (§18.6). */
    wire?: { values: Record<string, unknown>; sessionId: string; /** A fixture's value: its refusal names a fixture. */ fixture?: true },
  ): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    // The value was made for the app that was current when the account was checked; no other app gets it, and a
    // placeholder never goes to any app as text (§18.6).
    if (wire !== undefined && wire.sessionId !== session.id) {
      return fail("Error not_connected: the app changed while the account's value was being prepared; try again.");
    }
    if (wire === undefined && method === "type" && typeof params === "object" && params !== null && mentionsVault(String((params as { text?: unknown }).text ?? ""))) {
      return fail("Error bad_params: an account value can't be typed as plain text; it needs a loaded account and a connected app.");
    }
    const shortAnswer = this.briefOn(brief);
    const stale = this.staleRef(params);
    if (stale !== null) return stale;
    let result: unknown;
    // While recording, the screen as it is before the move: a step's `seen` is about the element on that screen (1.16 §9.4).
    const screenBefore = this.recording !== null && !this.replaying ? await this.screenBeforeStep(params, session.id) : null;
    // Where the app is before the move; the road is saved after it (AGENT-TOOLS 1.13 §18.2).
    const road = this.roadStart(session, method);
    this.observedPlace = undefined;
    this.actionStartedAt = Date.now();
    // A reflex gets one chance before a failure is answered (1.13.1 item 10); the step then runs again, its checks included.
    let reflexTried = false;
    for (;;) {
      try {
        const timeoutMs = answerTimeoutMs(method, params);
        const run = async (): Promise<unknown> => {
          this.setOk(false);
          if (preflight !== undefined) {
            const stop = await preflight();
            if (stop !== null) throw new PolicyStop(stop);
          }
          // The app gets the value and the kind, not the account's name; the log, the viewer and a recording get `params`.
          // `as` is a recording's name for the text, never the app's business.
          const kept = typeof params === "object" && params !== null ? Object.fromEntries(Object.entries(params).filter(([key]) => key !== "as" && (wire === undefined || key !== "account"))) : params;
          const sent = wire === undefined ? kept : { ...(kept as Record<string, unknown>), ...wire.values };
          // From here the request may reach the app; only a failure that proves it didn't takes that back (a grant's use stays counted).
          const delivery = this.deliveryScope.getStore();
          if (delivery !== undefined) delivery.sent = true;
          try {
            return await this.sendRequest(method, sent, { sessionId: session.id, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });
          } catch (error) {
            if (delivery !== undefined && notDelivered(error)) delivery.sent = false;
            throw error;
          }
        };
        // With the live viewer, a person watching goes first.
        result = await this.agentTurn(run);
        break;
      } catch (error) {
        const failure = error instanceof PolicyStop ? parseError(answerText(error.answer)) : error instanceof TaplineError ? { code: error.code, message: error.message } : null;
        if (!reflexTried && failure !== null && isReflexFailure(failure.code, failure.message)) {
          reflexTried = true;
          const before = this.mapOf(session)?.data().reflexes.length ? await this.namedCandidates(session, params) : null;
          if ((await this.checkReflexes(session)) > 0 && (await this.sameTarget(session, params, before, failure.message))) continue;
        }
        if (error instanceof PolicyStop) return error.answer;
        this.logExtra = undefined;
        this.showAction(
          "agent",
          method,
          undefined,
          params,
          error instanceof TaplineError ? error.code : "internal",
          error instanceof TaplineError ? reasonOf(error.code, error.message) : undefined,
        );
        return fail(kindRefusal(error, wire?.values["kind"], wire?.fixture === true) ?? describeError(error));
      }
    }
    const captured = this.exploreScope.getStore();
    if (captured !== undefined) {
      captured.count += 1;
      captured.last = { method, result };
    }
    const line = describe(result);
    this.noteTouch(method, params, result);
    if (nothingDone?.(result) === true) {
      this.logExtra = undefined;
      return text([line, ...this.takePersonNote()].join("\n"));
    }
    this.showAction("agent", method, result, params);
    // A touch that left the place it was at: a reflex may have its moment now, before the list is built (1.13.1 item 10).
    if (road !== null) await this.reflexAtPlaceChange(session, road.from);
    // A handler that threw: a step of `run` or `replay` fails (the touch happened, and the app's code is what is wrong);
    // anywhere else every answer says so, whether the screen changed or not (lead's decision, review of 1.6 task 5).
    const threwLine = touch !== undefined ? threwText(touch, readPressFacts(result)) : null;
    if (threwLine !== null && this.batch !== undefined) return fail(`Error internal: ${threwLine}`);
    let threwSaid = false;
    let response: CallToolResult;
    const extra = [...(extraNotes?.(result) ?? [])];
    this.lastLookRoute = undefined;
    const settledMs =
      typeof result === "object" && result !== null && "settledMs" in result ? (result as { settledMs: unknown }).settledMs : undefined;
    const settled = typeof settledMs === "number" && Number.isFinite(settledMs) && settledMs >= 0
      ? `Settled in ${(settledMs / 1000).toFixed(2)} s.`
      : undefined;
    if (withLook === false) {
      this.markListUnseen();
      this.unlistedActions.set(session.id, (this.unlistedActions.get(session.id) ?? 0) + 1);
      response = text([line, ...this.takePersonNote()].join("\n"));
    } else {
      // The touch happened about `settledMs` before the answer came; every wait is counted from there.
      const touchedAt = this.clock() - (typeof settledMs === "number" && Number.isFinite(settledMs) ? settledMs : 0);
      // A touch that may change nothing is looked at without a picture first: the picture is for the final look.
      const mayWait = touch !== undefined && this.batch === undefined && !this.replaying;
      const lookAgain = async (shot: boolean): Promise<CallToolResult> => {
        const looked = await this.withLook(session, line, shot, shortAnswer);
        if (settled === undefined || shortAnswer) return looked;
        const [first, ...rest] = looked.content;
        if (first === undefined || first.type !== "text") return looked;
        // `Settled in` is the last line that isn't a note: it goes before the trailing `Note:` lines.
        const all = first.text.trimEnd().split("\n");
        let end = all.length;
        while (end > 1 && all[end - 1]?.startsWith("Note: ") === true) end--;
        all.splice(end, 0, settled);
        return { ...looked, content: [{ type: "text", text: all.join("\n") }, ...rest] };
      };
      // The app waited until it was still (AGENT-TOOLS §6), so the list is fresh.
      response = await lookAgain(screenshot === true && !mayWait);
      // A touch that changed nothing is watched a little longer before it is said so (§3). Not inside `run`
      // (a batch answers once), and the app has to have answered with a list.
      if (mayWait && response.isError !== true && !saysNoVisibleChange(answerText(response)) && screenshot === true) {
        response = await this.withPicture(session, response);
      }
      if (mayWait && touch !== undefined && response.isError !== true && saysNoVisibleChange(answerText(response))) {
        const wait = NO_CHANGE_WATCH_MS - (this.clock() - touchedAt);
        if (wait > 0) await this.sleep(wait);
        const later = await lookAgain(screenshot === true);
        // What the first look said once stays said.
        const carried = answerText(response).split("\n").filter((row) => /^Note: (changes are since your last list|a person used the app)/.test(row));
        const missing = carried.filter((row) => !answerText(later).includes(row));
        const [top, ...rest] = later.content;
        const merged: CallToolResult =
          missing.length > 0 && top !== undefined && top.type === "text"
            ? { ...later, content: [{ type: "text", text: [top.text.trimEnd(), ...missing].join("\n") }, ...rest] }
            : later;
        if (later.isError === true) {
          // The app crashed or went away while it was watched: that answer stands, not a note about a quiet screen.
          response = later;
        } else if (!saysNoVisibleChange(answerText(later))) {
          // Something changed meanwhile: the normal answer, and no note.
          response = merged;
        } else {
          response = merged;
          const seconds = Math.max(this.clock() - touchedAt, 0) / 1000;
          const clause = noChangeClause(
            touch,
            session.capabilities.includes("pressFacts") ? readPressFacts(result) : null,
            saysRequestsRunning(answerText(later)),
            (element) => this.shortName(element, true),
          );
          extra.push(`${noChangeNote(touch, seconds)}${clause !== null ? ` ${clause}` : ""}`);
          // The clause already says a handler threw.
          threwSaid = threwLine !== null;
        }
      }
    }
    if (threwLine !== null && !threwSaid) extra.push(`Note: ${threwLine}`);
    if (road !== null && response.isError !== true) extra.push(...(await this.roadEnd(session, road, { method, params, result }, this.okScope.getStore()?.used === true)));
    const capMs = typeof result === "object" && result !== null && "settleCapMs" in result ? (result as { settleCapMs: unknown }).settleCapMs : undefined;
    if (typeof capMs === "number" && Number.isFinite(capMs) && capMs > 0) {
      extra.push(`Note: the screen was still changing after ${Number((capMs / 1000).toFixed(3))} s (an animation or video); positions may be mid-change.`);
    }
    if (KEYBOARD_METHODS.has(method) && typeof result === "object" && result !== null && "closedKeyboard" in result && result.closedKeyboard === true) {
      extra.push("Note: closed the keyboard first.");
    }
    // `force` let through what the checks refuse (AGENT-TOOLS v1.6): the answer mustn't read like any tap.
    if (typeof result === "object" && result !== null && "forced" in result && typeof result.forced === "string" && /^[a-z_]+$/.test(result.forced)) {
      extra.push(`Note: forced (${result.forced}): a person couldn't have done this.`);
    }
    if (extra.length > 0) {
      const [first, ...rest] = response.content;
      if (first !== undefined && first.type === "text") {
        response = { ...response, content: [{ type: "text", text: [first.text.trimEnd(), ...extra].join("\n") }, ...rest] };
      }
    }
    if (this.recording !== null && !this.replaying) {
      const { params: chosen, fragile } = stableParams(params, result);
      // A ref saved as a label or text that several elements share needs its index (AGENT-TOOLS 1.8 §9.4).
      const stable = await this.withIndexIfShared(params, chosen, result, session.id);
      // A password field's text is never saved in a script (Tapwright's review, M4). An account's value is a
      // placeholder in `params`, so the script keeps it and replays with the account.
      // `as` keeps a variable's placeholder instead, and a route keeps an account's too (AGENT-TOOLS 1.13 §18.5).
      const typed = method === "type" && this.recording.route !== undefined ? routeTyped(stable) : null;
      const secret = typed?.variable === undefined && wire === undefined && method === "type" && typeof result === "object" && result !== null && "secure" in result && result.secure === true;
      const step: ScriptStep = { method, params: typed !== null && !secret ? typed.params : secret ? { ...stable, text: "" } : stable };
      if (secret) step.secret = true;
      if (typed?.placeholder === true) step.placeholder = true;
      if (typed?.variable !== undefined) this.recording.route?.variables.add(typed.variable);
      if (typed?.account === true) this.recording.route?.variables.add("account");
      if (this.lastLookRoute !== undefined) step.route = this.lastLookRoute;
      if (road !== null && road.from !== null) step.place = road.from.name;
      const seen = this.seenFor(result, screenBefore);
      if (seen !== null) step.seen = seen;
      if (fragile) step.fragile = true;
      this.recording.steps.push(step);
    }
    return response;
  }

  /**
   * The screen before a recorded step that targets an element (not a point), for its `seen` (AGENT-TOOLS 1.16 §9.4): one extra read
   * of the tree, a peek that changes no ref, only while recording. Null when it can't be read; no bucket is written then.
   */
  private async screenBeforeStep(params: unknown, sessionId: string): Promise<TreeResult | null> {
    const target = typeof params === "object" && params !== null ? (params as { target?: unknown }).target : undefined;
    if (typeof target !== "object" || target === null || "x" in target) return null;
    const tree = treeResultSchema.safeParse(await this.sendRequest("tree", { peek: true }, { sessionId }).catch(() => null));
    return tree.success ? tree.data : null;
  }

  /**
   * The step's `seen`: the role, the 3 by 3 bucket (none inside a scroll view), the component and the id stem of the element the step
   * acted on, never text. Only for a step that acted on an element; `before` is the screen it was on.
   */
  private seenFor(result: unknown, before: TreeResult | null): Seen | null {
    const element =
      typeof result === "object" && result !== null && "element" in result ? elementSchema.safeParse((result as { element: unknown }).element) : null;
    if (!element?.success) return null;
    return seenOf(element.data, before?.elements ?? null, before?.screen);
  }

  /**
   * When the agent's ref was saved as a testID, label or text that more than one element on screen has, add
   * the element's `index` among them (reading order), so the replay picks the same one instead of
   * answering `ambiguous`. One extra read, only while recording and only for ref targets.
   */
  private async withIndexIfShared(
    original: unknown,
    chosen: Record<string, unknown>,
    result: unknown,
    sessionId: string,
  ): Promise<Record<string, unknown>> {
    const before = typeof original === "object" && original !== null ? (original as { target?: unknown }).target : undefined;
    const target = chosen["target"];
    if (typeof before !== "object" || before === null || !("ref" in before)) return chosen;
    if (typeof target !== "object" || target === null || "ref" in target || "index" in target) return chosen;
    const element = typeof result === "object" && result !== null && "element" in result
      ? elementSchema.safeParse((result as { element: unknown }).element)
      : null;
    if (!element?.success) return chosen;
    const tree = treeResultSchema.safeParse(await this.sendRequest("tree", { peek: true }, { sessionId }).catch(() => null));
    if (!tree.success) return chosen;
    const t = target as { testID?: unknown; label?: unknown; text?: unknown };
    const same = tree.data.elements.filter((el) =>
      typeof t.testID === "string"
        ? el.testID === t.testID
        : typeof t.label === "string"
          ? labelOfElement(el).toLowerCase() === t.label.toLowerCase()
          : typeof t.text === "string"
            ? el.text === t.text
            : false,
    );
    if (same.length < 2) return chosen;
    const at = same.findIndex((el) => el.ref === element.data.ref);
    return at < 0 ? chosen : { ...chosen, target: { ...(target as Record<string, unknown>), index: at } };
  }

  // -- the live viewer

  /** An element's frame (points) as 0..1 of the screen. */
  private normalized(frame: { x: number; y: number; width: number; height: number } | null | undefined): Rect | undefined {
    const screen = this.lastScreen;
    if (!frame || !screen || screen.w <= 0 || screen.h <= 0) return undefined;
    return { x: frame.x / screen.w, y: frame.y / screen.h, w: frame.width / screen.w, h: frame.height / screen.h };
  }

  /** The viewer's description of an action: its kind (protocol 1.4), its element's name and where it was. */
  private describeAction(kind: string, result: unknown, point?: { x: number; y: number }): Omit<ViewerAction, "by" | "ok" | "code"> {
    const element =
      typeof result === "object" && result !== null && "element" in result
        ? elementSchema.safeParse((result as { element: unknown }).element)
        : null;
    const data = element?.success ? element.data : undefined;
    const label = data ? (data.text || data.label || data.testID || undefined) : undefined;
    const rect = this.normalized(data?.frame);
    return {
      kind,
      ...(label ? { label: label.slice(0, 80) } : {}),
      ...(rect ? { rect } : {}),
      ...(point ? { point } : {}),
    };
  }

  /** One line in the action log (§12). Never fails the action. */
  private logAction(by: "agent" | "person", tool: string, params: unknown, result: unknown, code?: string, reason?: string): void {
    if (this.actionLog === null) return;
    const element =
      typeof result === "object" && result !== null && "element" in result
        ? elementSchema.safeParse((result as { element: unknown }).element)
        : null;
    const session = this.host.current();
    const state = by === "agent" ? this.callScope.getStore() : undefined;
    const entry: Omit<ActionLogEntry, "t" | "source"> = {
      by,
      tool,
      ...loggedTarget(params),
      ...this.loggedArgs(tool, params),
      // typed text never reaches the log, not even as the field's value (§12)
      ...(element?.success ? { element: formatElement({ ...element.data, ref: "", value: null, placeholder: null }, { actions: false }) } : {}),
      ok: code === undefined,
      ...(code !== undefined ? { code } : {}),
      ...(reason !== undefined ? { reason } : {}),
      ...(by === "agent" && this.actionStartedAt !== undefined ? { ms: Date.now() - this.actionStartedAt } : {}),
      ...(session !== undefined ? { app: session.app.id ?? session.app.name } : {}),
      ...(by === "agent" && this.batch !== undefined ? { batch: this.batch } : {}),
      ...(by === "agent" ? (this.logExtra ?? {}) : {}),
    };
    if (by === "agent") this.logExtra = undefined;
    if (state === undefined) {
      this.actionLog.write(entry);
      return;
    }
    if (state.tool !== tool) entry.of = state.tool;
    // After scrolls: was the target already in the list before the first one? (a scroll hunt is exact when it was)
    if (state.afterScrolls && state.tool === tool && ELEMENT_ACTIONS.has(tool)) {
      const known = this.knownBeforeScrolls(params);
      if (known !== undefined) entry.in_list = known;
    }
    state.entries.push({ entry, at: new Date() });
  }

  private showAction(by: "agent" | "person", method: string, result: unknown, params: unknown, code?: string, reason?: string): void {
    const onAction = this.options.onAction;
    if (onAction === undefined) {
      this.logAction(by, by === "agent" ? agentKind(method) : method, params, result, code, reason);
      return;
    }
    const target = typeof params === "object" && params !== null ? (params as { target?: unknown }).target : undefined;
    const t = typeof target === "object" && target !== null ? (target as { x?: unknown; y?: unknown }) : undefined;
    const screen = this.lastScreen;
    const point =
      t && typeof t.x === "number" && typeof t.y === "number" && screen ? { x: t.x / screen.w, y: t.y / screen.h } : undefined;
    const kind = by === "agent" ? agentKind(method) : method;
    this.logAction(by, kind, params, result, code, reason);
    const described = this.describeAction(kind, result, point);
    // A failed step has no element in its answer: name it from the target the agent gave, if it's words.
    const named =
      described.label ??
      (t && typeof (t as { text?: unknown }).text === "string" ? (t as { text: string }).text : undefined) ??
      (t && typeof (t as { label?: unknown }).label === "string" ? (t as { label: string }).label : undefined);
    const caption = by === "agent" ? captionFor(kind, kind === "app_command" ? undefined : named, params) : undefined;
    try {
      onAction({
        by,
        ...described,
        ...(caption !== undefined ? { caption } : {}),
        ok: code === undefined,
        ...(code ? { code } : {}),
        ...(reason ? { reason } : {}),
      });
    } catch {
      // a viewer's trouble must not fail the action
    }
  }

  /** The screen size in points, from the latest list or a fresh overlay read. */
  private async screenSize(sessionId: string): Promise<{ w: number; h: number } | undefined> {
    if (this.lastScreen) return this.lastScreen;
    await this.readOverlay(sessionId).catch(() => null);
    return this.lastScreen;
  }

  /** The elements on screen for the live viewer's boxes, in points. */
  async readOverlay(sessionId?: string): Promise<OverlayRead | null> {
    const sid = sessionId ?? this.host.current()?.id;
    if (sid === undefined) return null;
    const parsed = overlaySchema.safeParse(await this.sendRequest("overlay", {}, { sessionId: sid }));
    if (!parsed.success) return null;
    const { rev, screen, elements } = parsed.data;
    this.lastScreen = { w: screen.width, h: screen.height };
    return {
      ...(rev !== undefined ? { rev } : {}),
      size: { w: screen.width, h: screen.height },
      elements: elements.map((e) => ({
        ref: e.ref ?? null,
        type: e.type ?? null,
        label: e.label ?? null,
        id: e.id ?? null,
        rect: { x: e.frame.x, y: e.frame.y, w: e.frame.width, h: e.frame.height },
      })),
    };
  }

  /** Starts or stops the app's frames. */
  async setFeed(on: boolean, quality: QualityPreset): Promise<{ ok: boolean; code?: string; message?: string }> {
    const session = this.host.current();
    if (session === undefined) return { ok: false, message: "No app is connected." };
    try {
      await this.sendRequest("feed", feedParams(on, quality), { sessionId: session.id });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof TaplineError ? error.code : "internal",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** A person's input from the live viewer, mapped onto the app's actions; it goes ahead of the agent. */
  async personInput(input: PersonInput): Promise<InputOutcome> {
    const session = this.host.current();
    if (session === undefined) return { ok: false, code: "reconnecting", message: "The app isn't connected." };
    const run = async (): Promise<InputOutcome> => {
      const size = await this.screenSize(session.id);
      if (size === undefined) return { ok: false, code: "unsupported", message: "Couldn't read the screen size yet." };
      const { method, params, point, swipe } = this.mapInput(input, size);
      // The request reaches the app from here on, whether it succeeds or is refused.
      this.markPersonUsedApp();
      // A drag goes to what takes a finger's drag (a sheet's swipe to close, a pan view) first; when
      // nothing does (a list moves natively), it scrolls, as before.
      if (swipe !== undefined) {
        try {
          const swiped = await this.sendRequest("swipe", swipe, { sessionId: session.id });
          return { ok: true, action: this.describeAction(personKind(input, "swipe"), swiped, point) };
        } catch (error) {
          if (!(error instanceof TaplineError && error.code === "not_actionable")) {
            return { ...failure(error), action: { kind: personKind(input, "swipe"), ...(point ? { point } : {}) } };
          }
        }
      }
      try {
        const result = await this.sendRequest(method, params, { sessionId: session.id });
        return { ok: true, action: this.describeAction(personKind(input, method), result, point) };
      } catch (error) {
        return { ...failure(error), action: { kind: personKind(input, method), ...(point ? { point } : {}) } };
      }
    };
    try {
      const outcome = this.options.control ? await this.options.control.runPerson(run) : await run();
      // The log (§12): a person's input too, its typed text only as a length.
      this.logAction("person", outcome.action?.kind ?? input.type, input.type === "text" ? { text: input.text } : {}, undefined, outcome.ok ? undefined : outcome.code, outcome.reason);
      return outcome;
    } catch (error) {
      return { ok: false, code: "internal", message: error instanceof Error ? error.message : String(error) };
    }
  }

  private mapInput(
    input: PersonInput,
    size: { w: number; h: number },
  ): { method: string; params: Record<string, unknown>; point?: { x: number; y: number }; swipe?: Record<string, unknown> } {
    switch (input.type) {
      case "gesture": {
        const first = input.points[0] ?? [0, 0, 0];
        const last = input.points[input.points.length - 1] ?? first;
        const fx = first[1] * size.w;
        const fy = first[2] * size.h;
        const moved = Math.max(...input.points.map(([, x, y]) => Math.hypot(x * size.w - fx, y * size.h - fy)));
        const target = { x: Math.round(fx), y: Math.round(fy) };
        const point = { x: first[1], y: first[2] };
        if (moved < TAP_SLOP) {
          return { method: last[0] - first[0] >= LONG_PRESS_MS ? "longPress" : "press", params: { target }, point };
        }
        const dx = (last[1] - first[1]) * size.w;
        const dy = (last[2] - first[2]) * size.h;
        // A finger moving up shows what is further down.
        const vertical = Math.abs(dy) >= Math.abs(dx);
        const direction = vertical ? (dy < 0 ? "down" : "up") : dx < 0 ? "right" : "left";
        const seconds = Math.min(5, Math.max(0.05, (last[0] - first[0]) / 1000));
        const swipe = { x0: target.x, y0: target.y, x1: Math.round(last[1] * size.w), y1: Math.round(last[2] * size.h), seconds };
        return { method: "scroll", params: { target, direction, amount: Math.round(Math.abs(vertical ? dy : dx)) }, point, swipe };
      }
      case "scroll": {
        const target = { x: Math.round(input.x * size.w), y: Math.round(input.y * size.h) };
        const vertical = Math.abs(input.dy) >= Math.abs(input.dx);
        const direction = vertical ? (input.dy > 0 ? "down" : "up") : input.dx > 0 ? "right" : "left";
        const amount = Math.round(vertical ? Math.abs(input.dy) * size.h : Math.abs(input.dx) * size.w);
        return { method: "scroll", params: { target, direction, amount }, point: { x: input.x, y: input.y } };
      }
      case "text":
        return { method: "type", params: { text: input.text, replace: false, submit: false } };
      case "key":
        return input.key === "enter"
          ? { method: "type", params: { replace: false, submit: true } }
          : { method: "type", params: { backspace: 1, replace: false, submit: false } };
    }
  }

  async viewer(_args: Shape<"viewer"> = {}): Promise<CallToolResult> {
    const links = this.options.viewerLinks?.() ?? [];
    if (links.length === 0) return fail("Error unsupported: this host has no live viewer.");
    const open = this.options.openViewer;
    const local = links[0];
    let lines: string[];
    if (open !== undefined && this.options.viewerLinkToAgent !== true && local !== undefined) {
      // The key in the link can approve a held-back touch: it goes to the browser, never to the agent.
      const opened = open(local);
      lines = [
        opened
          ? "Opened the live view in a browser on this computer: the user watches the app and what you do there, and can tap and type too."
          : "Couldn't open a browser on this computer. Ask the user to start the MCP server with --viewer-link if they want the link.",
        "The link isn't shown to you: its key can approve touches that need a person's OK.",
        ...(links.length > 1 ? ["For their own devices on Tailscale, the user finds that link in this server's log."] : []),
        "While the user acts in the live view, their touches go first and your actions wait.",
      ];
    } else {
      lines = [
        "Live viewer (watch the app, see what you do, and let the user tap and type too):",
        ...links.map((link) => `- ${link}`),
        "The link carries a key: give it to the user only. While they use the viewer, their touches go first and your actions wait.",
      ];
    }
    const feed = this.options.viewerFeed?.();
    const session = this.host.current();
    if (feed?.on === true && session !== undefined) {
      try {
        const answer = feedAnswerSchema.safeParse(await this.sendRequest("feed", feedParams(true, feed.quality), { sessionId: session.id }));
        const stats = answer.success ? answer.data.stats : undefined;
        if (stats !== undefined) {
          lines.push(
            `Capture: ${stats.frames} frames, ${Math.round(stats.avgCaptureMs)} ms each on average (longest ${Math.round(stats.maxCaptureMs)} ms). Stutter: ${stats.janky} of ${stats.observedFrames} animation frames were slow, ${stats.jankyWhileCapturing} of them during a capture.`,
          );
          if (stats.backoffs !== undefined && stats.backoffs > 0) {
            lines.push(`The feed slowed down ${stats.backoffs} time(s) after slow animation frames near a capture.`);
          }
          if (stats.failures !== undefined && stats.failures > 0) {
            lines.push(
              `Failed captures: ${stats.failures}${stats.lastFailure ? ` (last: ${stats.lastFailure})` : ""}; while captures fail, the viewer gets about one frame a second.`,
            );
          }
        }
      } catch {
        // stats are a bonus
      }
    }
    return text(lines.join("\n"));
  }

  // -- compare_screen and filmstrip

  private async takeShot(sessionId: string, width: number, quality: number): Promise<ShotImage> {
    const raw = await this.sendRequest("screenshot", { format: "jpg", quality, maxWidth: width }, { sessionId });
    const parsed = screenshotResultSchema.safeParse(raw);
    if (!parsed.success) throw new TaplineError("internal", "The app returned a screenshot the host could not read.");
    return parsed.data;
  }

  /** A picture of the screen now, added to an answer that was made without one: its path line (file mode) or image, else a note. */
  private async withPicture(session: SessionInfo, answer: CallToolResult): Promise<CallToolResult> {
    const [first, ...rest] = answer.content;
    if (first === undefined || first.type !== "text") return answer;
    const rows = first.text.trimEnd().split("\n");
    const notes: string[] = [];
    const content: CallToolResult["content"] = [];
    let line: string | undefined;
    if (this.secureWindow()) notes.push(SECURE_QUIET_NOTE);
    else if (this.noScreenshot.has(session.id)) notes.push(NO_SCREENSHOT_NOTE);
    else {
      try {
        const image = await this.takeShot(session.id, DEFAULT_SCREENSHOT_WIDTH, 0.75);
        if (this.options.screenshots === "file") {
          const size = image.width !== undefined && image.height !== undefined ? ` (${image.width}x${image.height})` : "";
          line = `Screenshot: ${this.saveShot(session.id, image.mime, image.data)}${size}`;
        } else content.push({ type: "image", data: image.data, mimeType: image.mime });
      } catch (error) {
        if (error instanceof TaplineError && error.code === "unsupported") {
          this.noScreenshot.add(session.id);
          notes.push(NO_SCREENSHOT_NOTE);
        } else notes.push(`Note: screenshot failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // The path line goes before the Settled line and the notes.
    let end = rows.length;
    while (end > 1 && rows[end - 1]?.startsWith("Note: ") === true) end--;
    if (rows[end - 1]?.startsWith("Settled in") === true) end--;
    if (line !== undefined) rows.splice(end, 0, line);
    rows.push(...notes);
    return { ...answer, content: [{ type: "text", text: rows.join("\n") }, ...rest, ...content] };
  }

  /** Adds an image to a result: inline, or saved with its path in file mode. */
  private deliver(sessionId: string, image: ShotImage, lines: string[], content: CallToolResult["content"]): void {
    if (this.options.screenshots === "file") {
      try {
        const size = image.width !== undefined && image.height !== undefined ? ` (${image.width}x${image.height})` : "";
        lines.push(`Image: ${this.saveShot(sessionId, image.mime, image.data)}${size}`);
      } catch (error) {
        lines.push(`Note: image not saved: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else content.push({ type: "image", data: image.data, mimeType: image.mime });
  }

  /** Where this app's reference pictures are kept, or an error answer. */
  private referenceFolder(session: SessionInfo): string | CallToolResult {
    const dir = this.options.baselinesDir;
    if (dir === undefined) return fail("Error internal: no folder for reference pictures is configured.");
    return join(dir, (session.app.id ?? session.app.name).replace(/[^\w.-]/g, "_"));
  }

  /** The element list for naming regions and masking, read as a peek: the agent's refs and baseline must stay as they are. */
  private async peekElements(sessionId: string): Promise<{ scaleBase: number | undefined; elements: TreeResult["elements"] }> {
    try {
      const tree = treeResultSchema.safeParse(await this.sendRequest("tree", { peek: true }, { sessionId }));
      if (tree.success && tree.data.screen) return { scaleBase: tree.data.screen.width, elements: tree.data.elements };
    } catch {
      // positions stay in pixels
    }
    return { scaleBase: undefined, elements: [] };
  }

  /**
   * Takes the screen and compares it with the saved reference called `name`, never saving. `referencesDirs` are the
   * folders to look in, in order. A missing reference hands back the screenshot, so the caller may save it.
   */
  private async checkAgainstReference(session: SessionInfo, name: string, options: ReferenceOptions): Promise<ReferenceCheck> {
    // A comparison, from a step's `expect` too, is made with animations normal (the tools that say so add the note).
    return (await withNormalAnimations(this.host, session.id, () => this.checkAgainstReferenceNow(session, name, options), this.leased)).value;
  }

  private async checkAgainstReferenceNow(session: SessionInfo, name: string, options: ReferenceOptions): Promise<ReferenceCheck> {
    let shot: ShotImage;
    try {
      shot = await this.stillShot(session.id, options.width, 0.9);
    } catch (error) {
      return { kind: "error", line: describeError(error) };
    }
    this.lastMaskElements = undefined;
    if (!SCRIPT_NAME.test(name)) return { kind: "error", line: BAD_REFERENCE_NAME };
    const clash = this.referenceClash(name, options.referencesDirs);
    if (clash !== null) return { kind: "error", line: clash };
    const path = options.referencesDirs.map((dir) => join(dir, `${name}.jpg`)).find((candidate) => existsSync(candidate));
    if (path === undefined) return { kind: "missing", shot };
    let reference: ShotImage;
    try {
      reference = { mime: "image/jpeg", data: readFileSync(path).toString("base64") };
    } catch (error) {
      // A reference that can't be read (no permission, a folder in its place) is a failed check, never a crash.
      return { kind: "error", line: `Error bad_params: the reference "${name}" can't be read (${error instanceof Error ? error.message : String(error)}). To start over, use update: true.` };
    }
    let refSize: { width: number; height: number };
    let shotSize: { width: number; height: number };
    try {
      refSize = imageSize(reference);
      shotSize = imageSize(shot);
    } catch (error) {
      return { kind: "error", line: `Error bad_params: ${error instanceof Error ? error.message : String(error)} To start over, use update: true.` };
    }
    if (refSize.width !== shotSize.width || refSize.height !== shotSize.height) {
      return {
        kind: "size",
        message: `the reference "${name}" is ${refSize.width}x${refSize.height} px and this screen is ${shotSize.width}x${shotSize.height}; take it at the same width, or update: true.`,
      };
    }

    let seen: { scaleBase: number | undefined; elements: TreeResult["elements"] } | undefined;
    const notes: string[] = [];
    const mask: DiffBox[] = [];
    if (options.ignore.length > 0) {
      seen = await this.peekElements(session.id);
      this.lastMaskElements = seen.elements;
      if (seen.scaleBase === undefined) {
        return { kind: "error", line: "Error internal: couldn't read the screen's elements to paint out what ignore names." };
      }
      const masked = ignoreRects(options.ignore, seen.elements, shotSize.width / seen.scaleBase, shotSize);
      mask.push(...masked.rects);
      notes.push(...masked.notes);
    }
    let diff: DiffResult;
    try {
      diff = diffImages(reference, shot, { mask });
    } catch (error) {
      return { kind: "error", line: `Error bad_params: ${error instanceof Error ? error.message : String(error)} To start over, use update: true.` };
    }
    // The pass bar compares the exact share; the rounded percent is only for showing (a few pixels round to 0%).
    const exactPercent = (diff.changedPixels / Math.max(1, diff.width * diff.height)) * 100;
    if (diff.changedPixels === 0 || exactPercent <= options.threshold) {
      const names = diff.changedPixels === 0 ? [] : await this.changedClusterNames(session.id, diff, seen);
      return { kind: "match", percent: diff.changedPercent, notes, threshold: options.threshold, names };
    }

    // Name the regions in points, with the elements they touch.
    const found = seen ?? (await this.peekElements(session.id));
    const scale = found.scaleBase === undefined ? 1 : diff.width / found.scaleBase;
    const unit = scale === 1 ? "pixels" : "points";
    const regions = diff.boxes.map((box) => {
      const b = { x: box.x / scale, y: box.y / scale, width: box.width / scale, height: box.height / scale };
      const near = elementsUnder(b, found.elements).map((e) => describeElement(e));
      return { at: `@${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`, near };
    });
    const count = regions.length;
    const where = `in ${count} region${count === 1 ? "" : "s"} (${unit})`;
    const lines = [`Differs from the reference "${name}": ${diff.changedPercent}% changed, ${where}:`];
    for (const region of regions.slice(0, MAX_REGION_LINES)) {
      lines.push(`- ${region.at}${region.near.length > 0 ? `: ${region.near.join(", ")}` : ""}`);
    }
    if (count > MAX_REGION_LINES) lines.push(`(+${count - MAX_REGION_LINES} more regions)`);
    const listed = regions.slice(0, MAX_REGION_LINES).map((region) => region.at).join(", ");
    const reason = `${diff.changedPercent}% changed from the reference "${name}" (threshold ${options.threshold}%), ${where}: ${listed}${count > MAX_REGION_LINES ? `, +${count - MAX_REGION_LINES} more` : ""}.`;
    return { kind: "differs", percent: diff.changedPercent, lines, reason, image: diff.image, notes };
  }

  /**
   * The changed clusters of a match to name (1.13.1 item 2): each one that is at least 0.1% of the screen, and every
   * one that overlaps a text element, whatever its size. An element's name, else the place in points. Never fails.
   */
  private async changedClusterNames(
    sessionId: string,
    diff: DiffResult,
    seen: { scaleBase: number | undefined; elements: TreeResult["elements"] } | undefined,
  ): Promise<string[]> {
    const found = seen ?? (await this.peekElements(sessionId));
    const scale = found.scaleBase === undefined ? 1 : diff.width / found.scaleBase;
    const names: string[] = [];
    for (const cluster of diff.clusters) {
      const b = { x: cluster.x / scale, y: cluster.y / scale, width: cluster.width / scale, height: cluster.height / scale };
      const near = elementsUnder(b, found.elements);
      const overText = near.some((e) => (e.text ?? "") !== "");
      if (!overText && clusterPercent(cluster, diff.width, diff.height) < NAMED_CLUSTER_PERCENT) continue;
      names.push(near.length > 0 ? near.map((e) => describeElement(e)).join(", ") : `@${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)}`);
    }
    if (names.length <= MAX_REGION_LINES) return names;
    return [...names.slice(0, MAX_REGION_LINES), `+${names.length - MAX_REGION_LINES} more`];
  }

  /** Why a check does not hold (for `run`, as a step or as `matches`), or null when it matches. */
  private referenceReason(check: ReferenceCheck, name: string): { code: string; message: string } | null {
    switch (check.kind) {
      case "match":
        return null;
      case "missing":
        return { code: "expect_failed", message: `no reference "${name}" yet; save one with compare_screen { name: "${name}" }.` };
      case "size":
        return { code: "bad_params", message: check.message };
      case "error": {
        const { code, message } = parseError(check.line);
        return { code, message };
      }
      case "differs":
        return { code: "expect_failed", message: check.reason };
    }
  }

  /** Whether the screen matches the reference `name` now (`expect.matches`): null when it does, else the reason. */
  private async matchMissed(name: string, threshold: number, ignore: IgnoreItem[]): Promise<string | null> {
    this.lastMaskElements = undefined;
    this.matchedNames = [];
    if (!SCRIPT_NAME.test(name)) return parseError(BAD_REFERENCE_NAME).message;
    const session = this.host.current();
    if (session === undefined) return "the app isn't connected";
    const folder = this.referenceFolder(session);
    if (typeof folder !== "string") return parseError(folder.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")).message;
    if (this.replayContext?.update === true) {
      // --update-references: the check saves the screen into the script's folder, and holds.
      const saved = await this.saveReferenceHere(session, name, DEFAULT_SCREENSHOT_WIDTH, this.replayContext.referencesDir);
      return saved.isError === true ? parseError(saved.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")).message : null;
    }
    const check = await this.checkAgainstReference(session, name, {
      threshold,
      ignore,
      width: DEFAULT_SCREENSHOT_WIDTH,
      referencesDirs: this.referencesDirs(folder),
    });
    this.keepDiff(check, name);
    if (check.kind === "match") this.matchedNames = check.names;
    return this.referenceReason(check, name)?.message ?? null;
  }

  /** Where a check looks for `<name>.jpg`: the folder next to a replayed script first, then the app's own store. */
  private referencesDirs(folder: string): string[] {
    return this.replayContext !== null ? [this.replayContext.referencesDir, folder] : [folder];
  }

  /** In a replay, a failed check leaves its red picture at `<script>.diff/<name>.jpg`. */
  private keepDiff(check: ReferenceCheck, name: string): void {
    if (this.replayContext === null || check.kind !== "differs" || !SCRIPT_NAME.test(name)) return;
    const path = join(this.replayContext.diffDir, `${name}.jpg`);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(check.image.data, "base64"));
      this.diffSaved = path;
    } catch {
      // the failure still reads without the picture
    }
  }

  /**
   * A picture of the screen once it stopped moving: two in a row about 150 ms apart that agree (under 0.1% changed),
   * at most 2 s. The app's settle sees React commits, not a native transition, so a screen pushed by the action before
   * can still be sliding in (found on the phone, 2026-11-12). Past the cap, the last picture.
   */
  private async stillShot(sessionId: string, width: number, quality: number): Promise<ShotImage> {
    let previous = await this.takeShot(sessionId, width, quality);
    const started = Date.now();
    while (Date.now() - started < this.stillCapMs) {
      await sleep(this.stillGapMs);
      const next = await this.takeShot(sessionId, width, quality);
      if (next.data === previous.data) return next;
      try {
        const diff = diffImages(previous, next, { mask: [] });
        if (diff.changedPercent < 0.1) return next;
      } catch {
        return next; // sizes differ (a rotation): nothing to wait for
      }
      previous = next;
    }
    return previous;
  }

  /** Takes the screen and saves it as the reference `name` in `dir`. */
  private async saveReferenceHere(session: SessionInfo, name: string, width: number, dir: string): Promise<CallToolResult> {
    try {
      return this.writeReference(dir, name, await this.stillShot(session.id, width, 0.9));
    } catch (error) {
      return fail(describeError(error));
    }
  }

  private writeReference(folder: string, name: string, shot: ShotImage): CallToolResult {
    // Every write checks the name itself, whatever the caller checked: no way out of the references folder.
    if (!SCRIPT_NAME.test(name)) return fail(BAD_REFERENCE_NAME);
    const clash = this.referenceClash(name, [folder]);
    if (clash !== null) return fail(clash);
    const path = join(folder, `${name}.jpg`);
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, Buffer.from(shot.data, "base64"), { mode: 0o600 });
    } catch (error) {
      return fail(`Error internal: couldn't save the reference: ${error instanceof Error ? error.message : String(error)}`);
    }
    let size = `${shot.width ?? "?"}x${shot.height ?? "?"}`;
    try {
      const real = imageSize(shot);
      size = `${real.width}x${real.height}`;
    } catch {
      // the app's own size stays
    }
    return text(`Saved the reference "${name}" (${size} px).`);
  }

  /** A `compare_screen` step of `run`: it never saves; it holds on a match and stops the batch otherwise. */
  private async compareStep(args: Shape<"compare_screen">): Promise<CallToolResult> {
    this.lastMaskElements = undefined;
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const name = args.name.trim();
    if (!SCRIPT_NAME.test(name)) return fail("Error bad_params: name the reference with letters, digits, '.', '_' and '-'.");
    const folder = this.referenceFolder(session);
    if (typeof folder !== "string") return folder;
    if (this.replayContext?.update === true) {
      return this.saveReferenceHere(session, name, args.width ?? DEFAULT_SCREENSHOT_WIDTH, this.replayContext.referencesDir);
    }
    const check = await this.checkAgainstReference(session, name, {
      threshold: args.threshold ?? DEFAULT_MATCH_THRESHOLD,
      ignore: args.ignore ?? [],
      width: args.width ?? DEFAULT_SCREENSHOT_WIDTH,
      referencesDirs: this.referencesDirs(folder),
    });
    this.keepDiff(check, name);
    const why = this.referenceReason(check, name);
    if (why !== null) return fail(`Error ${why.code}: ${why.message}`);
    if (check.kind !== "match") return fail("Error internal: the comparison gave no answer.");
    // A check that held inside `run` is kept in a recording too, with its options.
    const recorded = await this.recordCompare({
      name,
      ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
      ...(args.ignore !== undefined ? { ignore: args.ignore } : {}),
      ...(args.width !== undefined ? { width: args.width } : {}),
    });
    if (recorded !== null) return fail(recorded);
    return text([matchLine(name, check), ...check.notes.map((n) => `Note: ${n}`)].join("\n"));
  }

  /**
   * Saves a visual check that held as a `compareScreen` step of the recording, when one is running: the name, and the
   * threshold, the ignore list (refs made stable) and the width when given. `update` is never written. Answers an
   * error line when an ignore ref can't be kept in a script, else null (also when nothing is recording).
   */
  private async recordCompare(check: { name: string; threshold?: number; ignore?: IgnoreItem[]; width?: number }): Promise<string | null> {
    if (this.recording === null || this.replaying) return null;
    const session = this.host.current();
    let kept = check.ignore;
    if (session !== undefined && kept !== undefined && kept.length > 0) {
      const stable = await this.stableIgnore(session.id, kept, this.lastMaskElements);
      if (typeof stable === "string") return stable;
      kept = stable;
    }
    if (this.recording === null) return null;
    this.recording.steps.push({
      method: "compareScreen",
      params: {
        name: check.name.trim(),
        ...(check.threshold !== undefined ? { threshold: check.threshold } : {}),
        ...(kept !== undefined && kept.length > 0 ? { ignore: kept } : {}),
        ...(check.width !== undefined ? { width: check.width } : {}),
      },
    });
    return null;
  }

  /**
   * `ignore` as a script keeps it (AGENT-TOOLS 1.9 §14.2): a ref becomes the element's id, else label, else text,
   * read from the list now. A string is the error answer when a ref can't be kept.
   */
  private async stableIgnore(sessionId: string, ignore: IgnoreItem[], known?: TreeResult["elements"]): Promise<IgnoreItem[] | string> {
    if (!ignore.some((item) => !("width" in item) && item.ref !== undefined)) return ignore;
    // The elements the comparison painted out when it had them, so the script keeps exactly that mask.
    const seen = known !== undefined ? { elements: known } : await this.peekElements(sessionId);
    const kept: IgnoreItem[] = [];
    for (const item of ignore) {
      if ("width" in item || item.ref === undefined) {
        kept.push(item);
        continue;
      }
      const element = seen.elements.find((e) => e.ref === item.ref);
      if (element === undefined) return `Error bad_params: ignore ${item.ref} isn't on the screen, so it can't be saved in a script.`;
      // When several elements share the name, the saved item keeps which one it was (`index`, counted as ignoreRects
      // counts: elements with a frame, in list order), so a replay paints out that one and not all of them.
      const framed = seen.elements.filter((e) => e.frame !== undefined);
      const withIndex = (saved: Target, same: (e: TreeResult["elements"][number]) => boolean): IgnoreItem => {
        const matching = framed.filter(same);
        const at = matching.indexOf(element);
        return matching.length > 1 && at >= 0 ? { ...saved, index: at } : saved;
      };
      if (typeof element.testID === "string" && element.testID !== "") {
        const id = element.testID;
        kept.push(withIndex({ id }, (e) => e.testID === id));
      } else if (typeof element.label === "string" && element.label !== "") {
        const label = element.label.toLowerCase();
        kept.push(withIndex({ label: element.label }, (e) => labelOfElement(e).toLowerCase() === label));
      } else if (typeof element.text === "string" && element.text !== "") {
        const text = element.text.toLowerCase();
        kept.push(withIndex({ text: element.text }, (e) => (e.text ?? "").toLowerCase() === text));
      } else {
        return `Error bad_params: ignore ${describeElement(element)} has no id, label or text, so a script couldn't find it again; give it a testID, or ignore a rect {x, y, width, height}.`;
      }
    }
    return kept;
  }

  async compareScreen(args: Shape<"compare_screen">): Promise<CallToolResult> {
    // Each check starts with no mask list: an update, or a first save, never records from an earlier comparison.
    this.lastMaskElements = undefined;
    const recording = this.recording !== null && !this.replaying;
    const session = this.host.current();
    // An ignore ref that a script couldn't find again is refused before anything is compared.
    if (recording && session !== undefined && args.ignore !== undefined && args.ignore.length > 0) {
      const stable = await this.stableIgnore(session.id, args.ignore);
      if (typeof stable === "string") return fail(stable);
    }
    const answer = await this.compareScreenNow(args);
    if (recording && answer.isError !== true) {
      // `update` is never written: the script checks against the reference it carries.
      const recorded = await this.recordCompare({
        name: args.name,
        ...(args.threshold !== undefined ? { threshold: args.threshold } : {}),
        ...(args.ignore !== undefined ? { ignore: args.ignore } : {}),
        ...(args.width !== undefined ? { width: args.width } : {}),
      });
      if (recorded !== null) return fail(recorded);
    }
    return answer;
  }

  private async compareScreenNow(args: Shape<"compare_screen">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const name = args.name.trim();
    if (!SCRIPT_NAME.test(name)) return fail("Error bad_params: name the reference with letters, digits, '.', '_' and '-'.");
    const folder = this.referenceFolder(session);
    if (typeof folder !== "string") return folder;
    const width = args.width ?? DEFAULT_SCREENSHOT_WIDTH;
    const save = (shot: ShotImage): CallToolResult => this.writeReference(folder, name, shot);
    if (args.update === true) {
      try {
        return save(await this.stillShot(session.id, width, 0.9));
      } catch (error) {
        return fail(describeError(error));
      }
    }
    const check = await this.checkAgainstReference(session, name, {
      threshold: args.threshold ?? DEFAULT_MATCH_THRESHOLD,
      ignore: args.ignore ?? [],
      width,
      referencesDirs: [folder],
    });
    switch (check.kind) {
      case "missing":
        return save(check.shot);
      case "error":
        return fail(check.line);
      case "size":
        return fail(`Error bad_params: ${check.message}`);
      case "match":
        return text([matchLine(name, check), ...check.notes.map((n) => `Note: ${n}`)].join("\n"));
      case "differs": {
        const lines = [...check.lines, "The image shows the screen now, faded, with the changed pixels in red.", ...check.notes.map((n) => `Note: ${n}`)];
        const content: CallToolResult["content"] = [];
        this.deliver(session.id, check.image, lines, content);
        return { content: [{ type: "text", text: lines.join("\n") }, ...content] };
      }
    }
  }

  async filmstrip(args: Shape<"filmstrip">): Promise<CallToolResult> {
    const hiddenFilm = this.hiddenTarget(args.tap);
    if (hiddenFilm !== null) return hiddenFilm;
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const count = args.frames ?? 6;
    const interval = args.interval_ms ?? 250;
    const frameWidth = args.frame_width ?? 200;
    const lines: string[] = [];
    try {
      const frames: ShotImage[] = [];
      const started = Date.now();
      if (args.tap !== undefined) {
        // A screenshot takes a few hundred ms on a phone, so frame 1 is the "before".
        // The tap is a touch like any other: the safety policy decides first.
        const pressParams = { target: toWireTarget(args.tap), ...(this.userEyes() ? { noScroll: true } : {}) };
        const tapLists = this.touchLists(session);
        const ready = await this.awaitOk(session, "tap", "press", pressParams, tapLists);
        if ("stop" in ready) return ready.stop;
        // The policy check, the "before" frame and the tap are one turn of the live view's queue: a pause refuses
        // it, a person's input goes first, and the screen can't change between the check and the tap (PR #4 review).
        const turn = async (): Promise<CallToolResult | null> => {
          const gate = await this.policyGate(session, "tap", "press", pressParams, tapLists, ready.waited);
          if ("stop" in gate) return gate.stop;
          let pressSent = false;
          try {
            frames.push(await this.takeShot(session.id, frameWidth, 0.8));
            pressSent = true;
            try {
              await this.sendRequest("press", pressParams, { sessionId: session.id });
            } catch (error) {
              if (notDelivered(error)) pressSent = false;
              throw error;
            }
          } catch (error) {
            if (gate.grant !== undefined && !pressSent) await this.releaseGrant(gate.grant);
            throw error;
          }
          if (gate.grant !== undefined) this.grantNotes.getStore()?.push(gate.grant.line);
          return null;
        };
        let stopped: CallToolResult | null;
        try {
          stopped = await this.agentTurn(turn);
        } finally {
          await this.dropPreUse(ready.waited);
        }
        if (stopped !== null) return stopped;
      }
      for (let i = frames.length; i < count; i++) {
        const at = Date.now();
        frames.push(await this.takeShot(session.id, frameWidth, 0.8));
        const rest = interval - (Date.now() - at);
        if (i < count - 1 && rest > 0) await sleep(rest);
      }
      const spacing = count > 1 ? Math.round((Date.now() - started) / count) : 0;
      const strip = composeFilmstrip(frames, { columns: Math.min(3, count), frameWidth });
      lines.push(
        `Filmstrip: ${count} frames about ${spacing} ms apart, numbered in order, left to right and top to bottom${args.tap !== undefined ? "; frame 1 is just before the tap, the rest follow it" : ""}. Each capture takes a few hundred ms on a phone, so very quick animations fall between frames.`,
      );
      const content: CallToolResult["content"] = [];
      this.deliver(session.id, strip, lines, content);
      return { content: [{ type: "text", text: lines.join("\n") }, ...content] };
    } catch (error) {
      return fail(error instanceof TaplineError ? describeError(error) : `Error internal: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // -- record and replay

  private scriptPath(name: string): string | null {
    const dir = this.options.scriptsDir;
    return dir === undefined || !SCRIPT_NAME.test(name) ? null : join(dir, `${name}.json`);
  }

  /** `home` and `HOME` are one file on Windows and macOS: an error line when a saved script differs from `name` only in case. */
  private scriptClash(name: string): string | null {
    const dir = this.options.scriptsDir;
    if (dir === undefined) return null;
    const twin = caseTwin(name, stemsIn(dir, ".json"));
    return twin === null ? null : `Error bad_params: the script "${name}" differs only in case from the existing "${twin}"; use that name.`;
  }

  /** The same for a reference name: against the pictures in `dirs`, then the compare steps earlier in this recording. */
  private referenceClash(name: string, dirs: readonly string[]): string | null {
    // One list for every folder and the recording: the exact name anywhere is the one meant, so it wins over a twin elsewhere.
    const inFolders = dirs.flatMap((dir) => stemsIn(dir, ".jpg"));
    const earlier =
      this.recording !== null && !this.replaying
        ? this.recording.steps.flatMap((step) => (step.method === "compareScreen" && typeof step.params["name"] === "string" ? [step.params["name"]] : []))
        : [];
    const twin = caseTwin(name, [...inFolders, ...earlier]);
    if (twin === null) return null;
    if (inFolders.includes(twin)) return `Error bad_params: the reference "${name}" differs only in case from the existing "${twin}"; use that name.`;
    return `Error bad_params: the reference "${name}" differs only in case from "${twin}", used earlier in this recording; use that name.`;
  }

  async record(args: Shape<"record">): Promise<CallToolResult> {
    const op = args.action ?? (args.start === true ? "start" : args.stop === true ? "stop" : "status");
    switch (op) {
      case "start": {
        const exclusive = this.exploreExcludes("a recording");
        if (exclusive !== null) return fail(exclusive);
        if (args.route !== undefined) return this.startRoute(args.route, args.name);
        const name = (args.name ?? "").trim() || `session-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
        if (this.scriptPath(name) === null) {
          return fail("Error bad_params: give the script a name of letters, digits, '.', '_' and '-' (e.g. \"checkout\").");
        }
        if (this.recording !== null) return fail(`Error bad_params: already recording "${this.recording.name}"; stop it first.`);
        const scriptClash = this.scriptClash(name);
        if (scriptClash !== null) return fail(scriptClash);
        const session = this.host.current();
        if (session === undefined) return this.notConnected();
        this.recording = { name, app: { name: session.app.name, ...(session.app.id ? { id: session.app.id } : {}) }, steps: [] };
        return text(
          `Recording "${name}" on ${session.app.name}. Every action from now on is a step; wait_for steps check the app is where it should be. Prefer testIDs: they replay best. Stop with record { stop: true }.`,
        );
      }
      case "status":
        return text(
          this.recording === null
            ? `Not recording.\n${this.scriptList()}`
            : `Recording ${this.recording.route !== undefined ? "route " : ""}"${this.recording.name}": ${this.recording.steps.length} step${this.recording.steps.length === 1 ? "" : "s"} so far.`,
        );
      case "discard": {
        if (this.recordStarting !== null && this.recording === this.recordStarting) return fail("Error busy: the recording is still starting; try again in a moment.");
        const was = this.recording?.name;
        this.recording = null;
        return text(was === undefined ? "Not recording." : `Discarded the recording "${was}".`);
      }
      case "stop": {
        const recording = this.recording;
        if (recording === null) return fail("Error bad_params: not recording; start with record { start: true, name }.");
        if (recording === this.recordStarting) return fail("Error busy: the recording is still starting; try again in a moment.");
        if (recording.route !== undefined) return this.stopRoute(recording, recording.route, args.path);
        const path = args.path !== undefined && args.path.trim() !== "" ? args.path.trim() : this.scriptPath(recording.name);
        if (path === null) return fail("Error internal: no scripts folder is configured; give a path.");
        // A twin may have appeared while recording; nothing is written then, and the recording stays to stop again.
        const stopClash = args.path !== undefined && args.path.trim() !== "" ? null : this.scriptClash(recording.name);
        if (stopClash !== null) return fail(stopClash);
        const script: SharedScript = {
          format: "agent-tools-script",
          version: 1,
          name: recording.name,
          app: recording.app.id ?? recording.app.name,
          fresh: true,
          steps: scriptSteps(recording.steps),
        };
        try {
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          writeFileSync(path, `${JSON.stringify(this.backstop(script), null, 2)}\n`, { mode: 0o600 });
        } catch (error) {
          return fail(`Error internal: couldn't save the script: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.recording = null;
        const count = script.steps.length;
        // AGENT-TOOLS 1.9 §14.3: the references the steps use travel with the script.
        const copied = this.copyReferences(script.steps, recording.app, path);
        const withPictures = copied === null ? "" : `, and ${copied.count} reference picture${copied.count === 1 ? "" : "s"} to ${copied.folder}`;
        const lines = [`Saved ${count} step${count === 1 ? "" : "s"} to ${path}${withPictures}.`];
        const ref = refStep(script.steps);
        if (ref !== null) {
          lines.push(
            `Note: step ${ref + 1} targets a ref, which won't exist on a new run, so replay refuses the script. Give that element a testID, or record it again by its text or label.`,
          );
        }
        const secrets = recording.steps.filter((step) => step.secret === true).length;
        if (secrets > 0) {
          lines.push(
            `${secrets} step${secrets === 1 ? " types" : "s type"} into a password field: that text isn't saved. Put a test password into the script before you replay it.`,
          );
        }
        if (recording.steps.some((step) => step.method === "type" && step.secret !== true && !isAccountStep(step))) {
          lines.push("The script keeps the other text typed in it: keep it private.");
        }
        return text(lines.join("\n"));
      }
    }
  }

  /** `record` with `route` (AGENT-TOOLS 1.13 §18.5): what follows is saved as a route from the place the app is at. */
  private async startRoute(raw: string, given: string | undefined): Promise<CallToolResult> {
    const exclusive = this.exploreExcludes("recording a route");
    if (exclusive !== null) return fail(exclusive);
    const name = routeSlug(raw);
    if (name === null) return fail("Error bad_params: give the route a name of letters, digits, '.', '_' and '-' (e.g. \"sign_in\").");
    if (given !== undefined && given.trim() !== "" && routeSlug(given) !== name) {
      return fail(`Error bad_params: name the route in route only; name "${given}" isn't "${name}".`);
    }
    if (this.recording !== null) return fail(`Error bad_params: already recording "${this.recording.name}"; stop it first.`);
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const map = this.mapOf(session);
    if (map === undefined) return fail("Error unsupported: this server keeps no map for this app, so a route can't be saved.");
    const twin = caseTwin(name, Object.keys(map.data().routes));
    if (twin !== null) return fail(`Error bad_params: the route "${name}" differs only in case from the existing "${twin}"; use that name.`);
    // Reserved before the first await (a second start, an explore and a stop all see it), and released if the place can't be found.
    const reserved = { name, app: { name: session.app.name, ...(session.app.id ? { id: session.app.id } : {}) }, steps: [], route: { start: "", variables: new Set<string>(), map } };
    this.recording = reserved;
    this.recordStarting = reserved;
    let here: Awaited<ReturnType<typeof placeNow>> = null;
    try {
      here = await placeNow(this.placeSource(session), map);
    } finally {
      this.recordStarting = null;
      if (here === null && this.recording === reserved) this.recording = null;
    }
    if (here === null) return fail("Error not_found: the app's current place isn't known, so a route can't start here; look at the screen first.");
    if (this.recording !== reserved) return fail("Error bad_params: the recording was discarded while it started.");
    reserved.route.start = here.place.name;
    return text(
      `Recording route "${name}" on ${session.app.name}, from ${here.place.name}. Every action from now on is a step; type_text with as saves its text as a variable. Stop with record { stop: true }.`,
    );
  }

  /** `record` stop for a route: it ends at the place the app is at, and goes into the map folder's `routes/`. */
  private async stopRoute(recording: NonNullable<TaplineTools["recording"]>, route: { start: string; variables: Set<string>; map: AppMap }, path: string | undefined): Promise<CallToolResult> {
    if (path !== undefined && path.trim() !== "") return fail("Error bad_params: a route is saved in the app's map folder; path doesn't apply.");
    const twin = caseTwin(recording.name, Object.keys(route.map.data().routes));
    if (twin !== null) return fail(`Error bad_params: the route "${recording.name}" differs only in case from the existing "${twin}"; use that name.`);
    const session = this.host.current();
    const sameApp = session !== undefined && (session.app.id ?? session.app.name) === (recording.app.id ?? recording.app.name);
    const end = sameApp ? await placeNow(this.placeSource(session), route.map) : null;
    const steps = scriptSteps(recording.steps.map((step) => ({ ...step, params: escapeParams(step.params, step.placeholder === true) })));
    const script = routeScript({ name: recording.name, app: recording.app.id ?? recording.app.name, start: route.start, end: end?.place.name, steps, variables: route.variables });
    let saved: string;
    try {
      saved = await saveRoute(route.map.folder(), this.backstop(script), route.map);
    } catch (error) {
      // The recording stays, so stop can be tried again.
      return fail(`Error internal: couldn't save the route: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.recording = null;
    const way = end === null ? `from ${route.start}` : `${route.start} → ${end.place.name}`;
    const lines = [`Saved route ${script.name} (${way}): ${steps.length} step${steps.length === 1 ? "" : "s"} to ${saved}.`];
    if (route.variables.size > 0) lines.push(`Variables: ${[...route.variables].join(", ")}.`);
    const ref = refStep(steps);
    if (ref !== null) {
      lines.push(`Note: step ${ref + 1} targets a ref, which won't exist on a new run, so replay refuses the route. Give that element a testID, or record it again by its text or label.`);
    }
    const secrets = recording.steps.filter((step) => step.secret === true).length;
    if (secrets > 0) {
      lines.push(`${secrets} step${secrets === 1 ? " types" : "s type"} into a password field: that text isn't saved. Use an account (\${account.password}) or as for it.`);
    }
    if (recording.steps.some((step) => step.method === "type" && step.secret !== true && step.placeholder !== true)) {
      lines.push("The route keeps the other text typed in it (as makes a variable): keep it private.");
    }
    return text(lines.join("\n"));
  }

  /** `<script dir>/<script name>.references` and `.diff` for a script file. */
  private scriptSideFolder(path: string, kind: "references" | "diff"): string {
    return join(dirname(path), `${basename(path).replace(/\.json$/i, "")}.${kind}`);
  }

  /** Copies each reference the steps use from the app's store next to the script; null when there are none. */
  private copyReferences(steps: Step[], app: { name: string; id?: string }, scriptPath: string): { count: number; folder: string } | null {
    const dir = this.options.baselinesDir;
    if (dir === undefined) return null;
    const names = new Set<string>();
    for (const step of steps) {
      const p = step as Record<string, unknown>;
      if (step.tool === "compare_screen" && typeof p["name"] === "string" && SCRIPT_NAME.test(p["name"])) names.add(p["name"]);
      if (step.expect?.matches !== undefined && SCRIPT_NAME.test(step.expect.matches)) names.add(step.expect.matches);
    }
    const store = join(dir, (app.id ?? app.name).replace(/[^\w.-]/g, "_"));
    const folder = this.scriptSideFolder(scriptPath, "references");
    let count = 0;
    for (const name of names) {
      const from = join(store, `${name}.jpg`);
      if (!existsSync(from)) continue;
      try {
        mkdirSync(folder, { recursive: true });
        copyFileSync(from, join(folder, `${name}.jpg`));
        count++;
      } catch {
        // the script still saved; the picture stays in the store
      }
    }
    return count === 0 ? null : { count, folder };
  }

  private scriptList(): string {
    const dir = this.options.scriptsDir;
    if (dir === undefined || !existsSync(dir)) return "No saved scripts.";
    const lines: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
      try {
        const s = readScript(readFileSync(join(dir, file), "utf8"));
        if (s === null) continue;
        lines.push(`- ${s.name} (${s.steps.length} step${s.steps.length === 1 ? "" : "s"}${s.app ? `, ${s.app}` : ""})`);
      } catch {
        // skip unreadable files
      }
    }
    return lines.length === 0 ? "No saved scripts." : ["Saved scripts:", ...lines].join("\n");
  }

  /** `adopt` is a person's choice and only the command line passes it: no tool parameter reaches it (AGENT-TOOLS 1.15 §26.5). */
  async replay(args: Shape<"replay">, options: { updateReferences?: boolean; adopt?: boolean; sideOf?: string; gateRepaired?: boolean } = {}): Promise<CallToolResult> {
    // Held before the first await and released in `finally`: explore can't start while a replay waits for its fresh start or its way to the route's start.
    this.rivals += 1;
    // The outermost replay owns the run's list of typed values (repair's trials and the verification replay add to it, and share it).
    const owner = this.replayTyped === null;
    if (owner) this.replayTyped = { values: [], ingress: this.host.typedRun() };
    try {
      return await this.replayHeld(args, options);
    } finally {
      this.rivals -= 1;
      if (owner) {
        this.replayTyped?.ingress.end();
        this.replayTyped = null;
      }
    }
  }

  /** Every plain text a replay (with its repair trials and the check of a repaired script) has typed, and the scrubber over them. */
  private replayTyped: { values: string[]; ingress: { add(value: string): void; end(): void } } | null = null;

  /** Registers a text a replay is about to type, before it is sent; the run's redaction knows it from then on. */
  private registerReplayTyped(value: string): void {
    const run = this.replayTyped;
    if (run === null || value === "" || run.values.includes(value)) return;
    run.values = [...run.values, value];
    run.ingress.add(value);
  }

  /** Redaction for everything a repair writes or answers: the replay's typed values, the vault's values and this session's one-time codes. */
  private replayScrub(text: string): string {
    return this.host.redactOut(this.scrubSecrets(text, this.replayTyped === null ? null : { values: this.replayTyped.values, token: TYPED }));
  }

  /** Recordings, replays and journeys in progress (counted from their first line): explore refuses to start while any is held. */
  private rivals = 0;
  /** The route recording that is still finding its start place (its state is reserved, and stop and discard wait for it). */
  private recordStarting: object | null = null;

  private async replayHeld(args: Shape<"replay">, options: { updateReferences?: boolean; adopt?: boolean; sideOf?: string; gateRepaired?: boolean }): Promise<CallToolResult> {
    const name = (args.name ?? "").trim();
    const given = (args.path ?? "").trim();
    if (name === "" && given === "") return text(this.scriptList());
    const exclusive = this.exploreExcludes("a replay");
    if (exclusive !== null) return fail(exclusive);
    if (this.recording !== null) return fail(`Error bad_params: stop recording "${this.recording.name}" before replaying.`);
    // On Windows and macOS a twin in another case would be found as if it were this name, and on Linux not: refuse it everywhere.
    const scriptClash = given === "" ? this.scriptClash(name) : null;
    if (scriptClash !== null) return fail(scriptClash);
    let path = given !== "" ? given : this.scriptPath(name);
    // A name that isn't a saved script may be a route in the app's map folder (§18.5).
    if (given === "" && (path === null || !existsSync(path))) path = this.routePath(name) ?? path;
    if (path === null || !existsSync(path)) return fail(`Error not_found: no script "${given || name}".\n${this.scriptList()}`);
    let script: SharedScript | null;
    try {
      script = readScript(readFileSync(path, "utf8"));
    } catch (error) {
      return fail(`Error internal: couldn't read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (script === null) return fail(`Error bad_params: ${path} isn't a script (format agent-tools-script, version 1 or 2).`);
    // A route's variables are filled before anything runs; replay has no values to give, so one with a variable is refused (§18.5).
    const accountStore = this.options.accounts?.store ?? undefined;
    if (script.version === 2) {
      const filled = substituteSteps(script.steps, {}, accountStore, script.variables ?? []);
      if (!filled.ok) return fail(`Error ${filled.code}: ${filled.message}`);
      // A start the app has no way to is refused before the fresh start restarts the app (18.5); at the start, nothing to check.
      const live = this.host.current();
      const liveMap = live === undefined || script.start === undefined ? undefined : this.mapOf(live);
      if (live !== undefined && liveMap !== undefined && script.start !== undefined) {
        const here = await placeSeen(this.placeSource(live), liveMap);
        const problem = startProblem(liveMap, here, script.start, this.driveRoadsOnly());
        if (problem !== null) return fail(`Error ${problem.code}: ${problem.message}`);
      }
    }
    const ref = refStep(script.steps);
    if (ref !== null) return fail(`Error bad_params: step ${ref + 1} targets a ref; a script needs an id, label, text or point.`);
    if (script.steps.length === 0) return text(`Ran 0 of 0 steps in 0.0 s.`);
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const notes: string[] = [];
    script.steps.forEach((step, i) => {
      const target = (step as Record<string, unknown>)["target"];
      if (typeof target === "object" && target !== null && "x" in target) {
        notes.push(`Note (step ${i + 1}): a point target; it breaks when the layout changes.`);
      }
    });
    if (script.fresh !== false) {
      // Tapline can't close and open the app: it starts its JavaScript again (a development build).
      const fresh = await this.reload({});
      const said = fresh.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
      if (fresh.isError === true) notes.push("Note: couldn't start the app fresh (a release build has no reload); the script ran on the screen as it was.");
      else if (said.startsWith("Reload requested, but")) notes.push("Note: the app hadn't reconnected after starting fresh when the steps began.");
    }
    const scriptPath = path;
    // A check of the repaired script borrows the original's picture references and diffs (`sideOf`).
    const sidePath = options.sideOf ?? path;
    const execute = async (steps: Step[]): Promise<CallToolResult> => {
      this.replaying = true;
      this.replayContext = {
        referencesDir: this.scriptSideFolder(sidePath, "references"),
        diffDir: this.scriptSideFolder(sidePath, "diff"),
        update: options.updateReferences === true,
        gateRepaired: options.gateRepaired === true,
      };
      try {
        const answer = await this.inRoute(script.version === 2 ? script.name : undefined, () => this.run({ steps, look: args.look, screenshot: args.screenshot, brief: false }), script.version === 2 && script.draftsOnly === true);
        if (notes.length === 0) return answer;
        const [top, ...rest] = answer.content;
        return top !== undefined && top.type === "text"
          ? { ...answer, content: [{ type: "text", text: [top.text.trimEnd(), ...notes].join("\n") }, ...rest] }
          : answer;
      } finally {
        this.replaying = false;
        this.replayContext = null;
      }
    };
    // Self-repair (§26): `suggest` runs as usual and ranks candidates at the first break; `apply` repairs as it goes.
    let ranSteps: Step[] = script.steps;
    let repairRun: RepairRun | null = null;
    const repairHost = args.repair === undefined ? null : this.repairHost(session, script, scriptPath, execute);
    // Where the script starts, for the replay that proves a repaired script as written (a script that doesn't start fresh needs the app back there).
    const startPlace = repairHost !== null && args.repair === "apply" ? await repairHost.place() : null;
    const backAtStart = async (): Promise<boolean> => {
      if (repairHost === null || script.version === 2 || script.fresh !== false) return true;
      if (startPlace === null) return false;
      if ((await repairHost.place()) === startPlace) return true;
      await repairHost.returnTo(startPlace);
      for (let i = 0; i < 6 && (await repairHost.place()) !== startPlace; i++) await repairHost.back();
      return (await repairHost.place()) === startPlace;
    };
    const run = async (steps: Step[]): Promise<CallToolResult> => {
      if (repairHost === null || args.repair !== "apply") {
        ranSteps = steps;
        return execute(steps);
      }
      repairRun = await runWithRepair(repairHost, steps);
      return repairRun.answer;
    };
    // Everything a repair answers is redacted whole, before any cut or formatting of the caller's.
    const redacted = (answer: CallToolResult): CallToolResult => ({ ...answer, content: answer.content.map((block) => (block.type === "text" ? { ...block, text: this.replayScrub(block.text) } : block)) });
    const finish = async (answer: CallToolResult): Promise<CallToolResult> => {
      if (repairHost === null) return answer;
      if (args.repair === "suggest") return redacted(await this.suggestRepair(repairHost, answer, ranSteps, session, script));
      return redacted(repairRun === null ? answer : await this.finishRepair(session, script, scriptPath, repairRun, options.adopt === true, backAtStart));
    };
    if (script.version !== 2) return finish(await run(script.steps));
    // A route starts at a place: after the fresh start the app is driven there (an `off_route` fails the replay), then it runs (18.5).
    const outcome = await routeRunner.run(script, {}, this.routeContext(run, (place) => this.replayDriveTo(place)), accountStore);
    return outcome.kind === "ran" ? finish(outcome.answer) : fail(`Error ${outcome.code}: ${outcome.message}`);
  }

  // -- self-repairing tests (AGENT-TOOLS 1.15 §26)

  /**
   * Runs what a repair does of its own in the explore gate's scope with no budget: every touch inside meets the whole floor on the
   * element that really receives it, a typing request is refused, and nothing asks a person (§25.5). A hit stops that move before
   * anything is sent, so the candidate that caused it is rejected.
   */
  private repairScope<T>(go: () => Promise<T>): Promise<T> {
    if (this.exploreScope.getStore() !== undefined) return go();
    const run: ExploreRun = { used: 0, steps: Number.POSITIVE_INFINITY, minutes: Number.POSITIVE_INFINITY, startedAt: this.clock(), waited0: this.options.control?.waitedMs() ?? 0, typed: [] };
    return this.exploreScope.run({ count: 0, run }, go);
  }

  /** What a repair needs from this host: the checks of any touch run inside `runSteps`, and nothing here writes the map. */
  private repairHost(session: SessionInfo, script: SharedScript, scriptPath: string, execute: (steps: Step[]) => Promise<CallToolResult>): RepairHost {
    const live = (): SessionInfo => this.host.current() ?? session;
    const map = this.mapOf(session);
    const words = (): string[] => {
      // The union of the global and the app's lists, as explore reads them: an app's own lists never lower the floor (§25.5).
      const lists = exploreLists(this.policy, session.app);
      return [...new Set([...FLOOR_WORDS, ...lists.confirm, ...lists.block, ...exploreSettings(this.policy).skip])];
    };
    const named = script.name || basename(scriptPath, ".json");
    return {
      script: named,
      runSteps: execute,
      // Every move a repair makes of its own meets the whole explore floor on the element that really receives it (§25.5, §26.4).
      trial: (steps) => this.repairScope(() => execute(steps)),
      toggleRole: (place, target) => {
        if (map === undefined || place === null) return null;
        const sig = target.id !== undefined ? `id:${target.id}` : target.label !== undefined ? `label:${target.label}` : target.text !== undefined ? `text:${target.text}` : null;
        if (sig === null) return null;
        const role = map.triedAction(place, target.index !== undefined ? `${sig}#${target.index}` : sig)?.["role"];
        return typeof role === "string" && role !== "" ? role : null;
      },
      tree: async () => {
        const tree = treeResultSchema.safeParse(await this.sendRequest("tree", { peek: true }, { sessionId: live().id }).catch(() => null));
        return tree.success ? tree.data : null;
      },
      place: async () => (map === undefined ? null : placeSeen(this.placeSource(live()), map)),
      placeName: (route) => placeNameFromRoute(route),
      way: (from, to) => {
        if (map === undefined) return null;
        const start = map.data().places[from];
        if (start === undefined || map.data().places[to] === undefined) return null;
        const plan = planWay(map, { name: from, key: start.key, link: null }, { name: to, link: null }, { by: "taps", tapsOnly: true });
        if ("error" in plan || !plan.proven || plan.moves.length === 0) return null;
        const steps: Step[] = [];
        for (const move of plan.moves) {
          const road = move.road;
          const target = road.move.target;
          if (move.viaLink || move.route !== undefined || !["tap", "long_press", "toggle"].includes(road.move.tool) || target === undefined) return null;
          if (target.x !== undefined || target.y !== undefined) return null;
          const by = target.id !== undefined ? { id: target.id } : target.label !== undefined ? { label: target.label } : target.text !== undefined ? { text: target.text } : null;
          if (by === null) return null;
          steps.push({ tool: road.move.tool, target: by, place: road.from } as Step);
        }
        return steps;
      },
      returnTo: async (place) => this.repairScope(async () => (await this.replayDriveTo(place)).ok),
      back: async () => (await this.repairScope(() => execute([{ tool: "back" } as Step]))).isError !== true,
      match: (target, elements) => candidatesFor(wireTarget(target), elements),
      never: {
        draftsOnly: script.version === 2 && script.draftsOnly === true,
        policyHit: (subject) => matchWord(words(), floorSubject(subject)),
      },
      redact: (value) => this.replayScrub(value),
      audit: (detail) => this.options.audit?.write({ kind: "repair", app: session.app.id ?? session.app.name, name: named, detail: this.replayScrub(detail) }) ?? false,
      now: () => this.clock(),
    };
  }

  /** `suggest`: after the usual failure text, the candidates of the first break, ranked, with nothing touched (§26.5). */
  private async suggestRepair(host: RepairHost, answer: CallToolResult, steps: Step[], session: SessionInfo, script: SharedScript): Promise<CallToolResult> {
    const brk = parseBreak(answer);
    if (brk === null) return answer;
    const analysis = await analyse(host, steps, brk.index, brk);
    const lines = [...suggestionText(analysis), ...this.expectFinding(session, script, steps, brk)];
    const [top, ...rest] = answer.content;
    return top !== undefined && top.type === "text" ? { ...answer, content: [{ type: "text", text: [top.text.trimEnd(), ...lines].join("\n") }, ...rest] } : answer;
  }

  /** The §27 finding of an `expect` that failed: a line that reports it and the finding as one JSON line. It is never repaired. */
  private expectFinding(session: SessionInfo, script: SharedScript, steps: Step[], brk: { index: number; code: string; message: string }): string[] {
    const safe = this.expectFailedFinding(session, steps, brk);
    if (safe === null) return [];
    this.lastFailure = safe;
    return [`Finding f1 (expect_failed) at step ${brk.index + 1} of "${script.name}": ${safe.got} Not repaired: an expect that fails is a finding.`, `Finding: ${JSON.stringify(safe)}`];
  }

  /** The finding of a step whose `expect` didn't hold (§26.2, §27.1), redacted; null for any other failure. */
  private expectFailedFinding(session: SessionInfo, steps: Step[], brk: { index: number; code: string; message: string }): Finding | null {
    if (brk.code !== "expect_failed") return null;
    const step = steps[brk.index];
    if (step === undefined) return null;
    const platform = session.device.platform === "ios" ? "iOS" : session.device.platform === "android" ? "Android" : session.device.platform;
    const build = session.app.build ?? "";
    const place = (step as Record<string, unknown>)["place"];
    const wall = this.options.wallClock ?? Date.now;
    const finding: Finding = {
      id: "f1",
      kind: "expect_failed",
      app: session.app.id ?? session.app.name,
      app_version: session.app.version ?? "",
      build: /\((.*)\)\s*$/.exec(build)?.[1] ?? build,
      tool: "tapline",
      tool_version: EXPLORE_TOOL_VERSION,
      when: new Date(wall()).toISOString(),
      device: { model: session.device.model ?? session.device.name ?? "unknown", os: `${platform}${session.device.osVersion !== undefined ? ` ${session.device.osVersion}` : ""}` },
      place: typeof place === "string" ? place : null,
      path_from: typeof place === "string" ? place : null,
      path: steps.slice(0, brk.index + 1).map((item): PathStep => {
        const { tool, expect: _expect, route: _route, place: _place, seen: _seen, repaired: _repaired, ...rest } = item as Step & { route?: unknown; place?: unknown; seen?: unknown; repaired?: unknown };
        // A typed value is never kept (§27.1).
        if (tool !== "type_text") return { tool, ...rest };
        const { text: _text, ...kept } = rest as Record<string, unknown>;
        return { tool, ...kept, text: TYPED };
      }),
      expected: step.expect === undefined ? "the step's expect holds" : `the step's expect holds (${JSON.stringify(step.expect)})`,
      got: cutText(firstLine(this.replayScrub(brk.message)), LOG_LINE_MAX),
      picture: null,
      logs: [],
      repro: null,
      count: 1,
    };
    return redactFinding(finding, (value) => this.replayScrub(value));
  }

  /** `apply` ended: a failure adds its notes (and an expect's finding); a pass with repairs writes the two files and learns the roads (§26.5). */
  private async finishRepair(session: SessionInfo, script: SharedScript, scriptPath: string, run: RepairRun, adopt: boolean, backAtStart: () => Promise<boolean>): Promise<CallToolResult> {
    const withLines = (answer: CallToolResult, lines: string[]): CallToolResult => {
      const [top, ...rest] = answer.content;
      return lines.length === 0 || top === undefined || top.type !== "text" ? answer : { ...answer, content: [{ type: "text", text: [top.text.trimEnd(), ...lines].join("\n") }, ...rest] };
    };
    if (!run.ok) {
      const steps = run.work.map((item) => item.step);
      const finding = run.failure === undefined ? [] : this.expectFinding(session, script, steps, { index: run.failure.step - 1, code: run.failure.code, message: run.failure.message });
      return withLines(run.answer, [...run.notes, ...finding]);
    }
    if (run.repairs.length === 0) return run.answer;
    const dir = dirname(scriptPath);
    const stem = basename(scriptPath).replace(/\.json$/i, "");
    const repairedPath = join(dir, `${stem}.repaired.json`);
    const notesPath = join(dir, `${stem}.repair.md`);
    const origPath = join(dir, `${stem}.orig.json`);
    const wall = this.options.wallClock ?? Date.now;
    const at = new Date(wall());
    const build = this.mapOf(session)?.currentBuild() ?? session.app.build ?? "";
    let original: Record<string, unknown>;
    try {
      const raw: unknown = JSON.parse(readFileSync(scriptPath, "utf8"));
      original = sharedScriptSchema.safeParse(raw).success ? (raw as Record<string, unknown>) : (script as unknown as Record<string, unknown>);
    } catch {
      original = script as unknown as Record<string, unknown>;
    }
    const repaired = this.backstop(repairedScript(original, run.work, { from: basename(scriptPath), at: at.toISOString().replace(/\.\d{3}Z$/, "Z"), build, count: run.repairs.length }));
    const repairedText = `${JSON.stringify(repaired, null, 2)}\n`;
    const markdown = this.replayScrub(repairMarkdown(script.name || stem, { date: at.toISOString().slice(0, 10), version: EXPLORE_TOOL_VERSION, build }, run.repairs));
    // The script as it will be written must pass a fresh, ordinary replay (no repair) on this app; nothing is written when it doesn't (§26.4).
    // The emitted file is proven against exactly the pictures it will use: an adopted file keeps the original's folder; a file written beside the
    // original gets its own sidecar, refreshed from the original's folder first (an older one is replaced, never trusted).
    const picturesFrom = this.scriptSideFolder(scriptPath, "references");
    const picturesTo = this.scriptSideFolder(repairedPath, "references");
    if (!adopt) {
      const stale = this.refreshSidecar(picturesFrom, picturesTo);
      if (stale !== null) return fail(`Error internal: the repaired script's picture references couldn't be refreshed (${stale}); nothing was written.`);
    }
    const refused = await this.verifyEmitted(scriptPath, repairedText, backAtStart, adopt ? scriptPath : repairedPath);
    if (refused !== null) {
      for (const record of run.repairs) this.options.audit?.write({ kind: "repair", app: session.app.id ?? session.app.name, name: script.name || stem, detail: this.replayScrub(`step ${record.step}: ${repairPhrase(record)}, rejected (the repaired script failed its replay as written)`) });
      return fail(refused);
    }
    try {
      writeFileSync(repairedPath, repairedText, { mode: 0o600 });
      writeFileSync(notesPath, markdown, { mode: 0o600 });
    } catch (error) {
      return fail(`Error internal: the run passed, but the repaired script couldn't be written: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.learnRepairs(session, run.repairs);
    const count = run.repairs.length;
    const total = run.work.filter((item) => item.origin !== null).length;
    const phrases = run.repairs.map((record) => (record.kind === "target" ? `step ${record.step} ${repairPhrase(record)}` : `step ${record.step} inserted ${record.shown}`));
    let adopted = false;
    const extra: string[] = [];
    if (adopt) {
      const logged = this.options.audit?.write({ kind: "repair", app: session.app.id ?? session.app.name, name: script.name || stem, detail: "adopted" }) ?? false;
      if (!logged) extra.push("Note: the audit log couldn't be written, so the script was not adopted.");
      else {
        try {
          // The first original is never lost: the copy is made only when there is none yet.
          if (!existsSync(origPath)) copyFileSync(scriptPath, origPath);
          const temporary = join(dir, `${stem}.json.${process.pid}.tmp`);
          writeFileSync(temporary, repairedText, { mode: 0o600 });
          renameSync(temporary, scriptPath);
          rmSync(repairedPath, { force: true });
          adopted = true;
        } catch (error) {
          extra.push(`Note: couldn't adopt the repaired script: ${error instanceof Error ? error.message : String(error)}. The original is unchanged.`);
        }
      }
    }
    const head = `Ran ${total} of ${total} steps in ${run.seconds.toFixed(1)} s, with ${count} repair${count === 1 ? "" : "s"} (${adopted ? "adopted" : "not adopted"}).`;
    const files = adopted
      ? `Adopted: ${stem}.json now holds the repaired script; the original is kept as ${stem}.orig.json. Wrote ${stem}.repair.md.`
      : `Wrote ${stem}.repaired.json and ${stem}.repair.md. The original is unchanged.`;
    return text([head, `Repaired: ${phrases.join("; ")}.`, files, ...extra].join("\n"));
  }

  /**
   * Makes `to` (the repaired file's picture folder) a copy of `from` (the original's), atomically: copied to a temporary folder, then renamed over
   * the old one, which is put back if the rename fails. With no original folder an older sidecar is removed. Null when done, else why not.
   */
  private refreshSidecar(from: string, to: string): string | null {
    const temporary = `${to}.${process.pid}.tmp`;
    const old = `${to}.${process.pid}.old`;
    try {
      rmSync(temporary, { recursive: true, force: true });
      rmSync(old, { recursive: true, force: true });
      if (!existsSync(from)) {
        rmSync(to, { recursive: true, force: true });
        return null;
      }
      cpSync(from, temporary, { recursive: true });
      const had = existsSync(to);
      if (had) renameSync(to, old);
      try {
        renameSync(temporary, to);
      } catch (error) {
        if (had) renameSync(old, to);
        throw error;
      }
      rmSync(old, { recursive: true, force: true });
      return null;
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      return error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Replays the repaired script exactly as it would be written, as an ordinary replay of its own (repair off), from the start the
   * original had. Null when it passes; else the failure to answer with. The probe file lives beside the script for a moment only.
   */
  private async verifyEmitted(scriptPath: string, text: string, backAtStart: () => Promise<boolean>, picturesOf: string): Promise<string | null> {
    const stem = basename(scriptPath).replace(/\.json$/i, "");
    const probe = join(dirname(scriptPath), `${stem}.repaired.json.${process.pid}.probe.json`);
    const nothing = "nothing was written";
    try {
      writeFileSync(probe, text, { mode: 0o600 });
    } catch (error) {
      return `Error internal: the repaired script couldn't be replayed as written (${error instanceof Error ? error.message : String(error)}); ${nothing}.`;
    }
    try {
      if (!(await backAtStart())) return `Error not_connected: the run passed, but the app couldn't be taken back to where the script starts, so the repaired script couldn't be replayed as written; ${nothing}.`;
      const answer = await this.replay({ path: probe }, { sideOf: picturesOf, gateRepaired: true });
      if (answer.isError !== true) return null;
      const said = answer.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
      const [first = "", ...rest] = said.split("\n");
      const m = /^Error (\w+):\s*(.*)$/.exec(first);
      return [`Error ${m?.[1] ?? "internal"}: the run passed with its repairs, but the repaired script failed when replayed as written (${m?.[2] ?? first}); ${nothing}.`, ...rest].join("\n");
    } finally {
      rmSync(probe, { force: true });
    }
  }

  /** A passing `apply` updates the road that has a repaired move: its `move` and `names` take the new target, proven for the build (§26.5). Nothing else of the map. */
  private learnRepairs(session: SessionInfo, repairs: RepairRun["repairs"]): void {
    try {
      const map = this.mapOf(session);
      if (map === undefined) return;
      for (const record of repairs) {
        if (record.kind !== "target" || record.was === null || record.now === null || record.now.index !== undefined) continue;
        const was = record.was;
        const road = map.data().roads.find((candidate) => {
          const target = candidate.move.target;
          if (candidate.move.tool !== record.tool || target === undefined) return false;
          if (record.place !== undefined && candidate.from !== record.place) return false;
          if (was.id !== undefined) return target.id === was.id;
          if (was.label !== undefined) return target.label === was.label;
          return was.text !== undefined && target.text === was.text;
        });
        if (road === undefined) continue;
        const names = record.now.id !== undefined ? { id: record.now.id } : record.now.label !== undefined ? { label: record.now.label } : record.now.text !== undefined ? { text: record.now.text } : null;
        if (names === null || this.cleanRoad({ target: names }, {}) === null) continue;
        const stored = map.repairRoad(road, { ...road.move, target: names }, names, false);
        if (stored !== null) map.markDriven(stored, stored.ms);
      }
    } catch {
      // the map is a help; a repair that passed stands without it
    }
  }

  /** Where a saved route of that name is, in the current app's map folder; null when there is none. */
  private routePath(name: string): string | null {
    const session = this.host.current();
    const map = session === undefined ? undefined : this.mapOf(session);
    return map === undefined ? null : routePathOf(map, name);
  }

  /**
   * What a route needs from this host (§18.5). `here` reads the app's place and writes nothing, so a replay never changes
   * the map. `driveTo` takes the app to a place by link or roads; without one a route runs only from its own start.
   */
  private routeContext<R>(runSteps: (steps: Step[]) => Promise<R>, driveTo?: RouteContext<R>["driveTo"]): RouteContext<R> {
    return {
      here: async () => {
        const session = this.host.current();
        const map = session === undefined ? undefined : this.mapOf(session);
        return session === undefined || map === undefined ? null : placeSeen(this.placeSource(session), map);
      },
      ...(driveTo !== undefined ? { driveTo } : {}),
      runSteps,
    };
  }

  /**
   * A replay's way to a route's start: a drive over a copy of the map that is never written, so a replay still changes nothing
   * (18.9). Every move keeps its policy check and a person's OK.
   */
  private async replayDriveTo(place: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const session = this.host.current();
    const map = session === undefined ? undefined : this.mapOf(session);
    if (session === undefined || map === undefined) return { ok: false, message: "the app has no map to drive with." };
    const frozen = await map.readOnlyCopy();
    const go = async (): Promise<{ ok: true } | { ok: false; message: string }> => {
      // The screen a stopped drive shows must not add to the map either.
      const before = this.replaying;
      this.replaying = true;
      try {
        return await driveQuietly(this.driveServices(session, frozen), { to: place, by: "any" });
      } finally {
        this.replaying = before;
      }
    };
    return this.holdScope.getStore() !== undefined ? go() : this.holdScope.run({ ms: 0 }, go);
  }

  /** Whether an answer is brief: the call's own `brief`, else the server's `--brief` (AGENT-TOOLS 1.13 §13.4). */
  private briefOn(arg: boolean | undefined): boolean {
    return arg ?? this.options.brief === true;
  }

  private async withLook(session: SessionInfo, line: string, screenshot = false, brief = false): Promise<CallToolResult> {
    // The session may have been replaced (app restarted) in the meantime.
    const live = this.host.sessions().some((s) => s.id === session.id) ? session : this.host.current();
    if (live === undefined) return text(`${line}\nNote: the app disconnected, so there's no fresh element list.`);
    // Text only unless asked: a screenshot after every step would cost image tokens the agent rarely needs.
    const parts = await this.lookParts(live, screenshot, DEFAULT_SCREENSHOT_WIDTH, true, false, brief ? line : undefined);
    const [first, ...rest] = parts.content;
    const head = first !== undefined && first.type === "text" ? first.text : "";
    // A brief answer already carries the first line (and its `Place:` line). Otherwise `Place:` follows the first line (§18.1).
    const top = parts.placeLine !== undefined ? `${line}\n${parts.placeLine}` : line;
    return { content: [{ type: "text", text: brief ? head : `${top}\n${head}` }, ...rest], ...(parts.isError ? { isError: true } : {}) };
  }

  /**
   * The element a result carries under `key`, for an answer's first line: without its actions, position or
   * size (AGENT-TOOLS 1.8 §13 rule 1; the change block or list has them). `withoutValue` for type_text,
   * whose sentence says the value (rule 5).
   */
  private elementName(result: unknown, key: "element" | "target" = "element", withoutValue = false): string {
    if (typeof result === "object" && result !== null && key in result) {
      const element = elementSchema.safeParse((result as Record<string, unknown>)[key]);
      if (element.success) {
        const shown = withoutValue ? { ...element.data, value: null, placeholder: null } : element.data;
        return formatElement(shown, { actions: false, frame: false, eyes: this.userEyes() });
      }
    }
    return "element";
  }

  // -- the safety policy (AGENT-TOOLS 1.8 §11)

  /**
   * A guarded touch: the app resolves the target in a dry run, the policy's words are matched against the
   * element's own label and text, and a confirm word waits for a person's OK in the live view. The check runs
   * inside the agent's turn, right before the touch, so nothing a person does in between can change what is
   * touched; when the check can't be made, nothing is touched (fail closed).
   */
  private async guarded(
    tool: "tap" | "long_press" | "toggle" | "swipe",
    method: string,
    params: Record<string, unknown>,
    dryRun: boolean,
    perform: (preflight?: () => Promise<CallToolResult | null>) => Promise<CallToolResult>,
  ): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    this.logExtra = undefined;
    this.actionStartedAt = Date.now();
    const lists = this.touchLists(session);
    if (!dryRun && lists.confirm.length === 0 && lists.block.length === 0) return perform();
    const stale = this.staleRef(params);
    if (stale !== null) return stale;
    if (dryRun) {
      const resolved = await this.resolveForPolicy(session, method, params);
      this.logExtra = { dry_run: true };
      if (resolved.kind === "error") {
        this.showAction("agent", method, undefined, params, resolved.code, resolved.reason);
        return fail(resolved.text);
      }
      const verdict = this.policyWords(lists, resolved);
      const shown = resolved.elements[0];
      if (verdict.kind === "blocked") {
        this.showAction("agent", method, { element: verdict.element }, params, "not_allowed", "blocked");
        return fail(this.blockedLine(verdict.element, verdict.word));
      }
      const would = this.wouldLine(tool, shown, resolved.point, resolved.value, resolved.scrolls);
      let needs = verdict.kind === "confirm" ? ` It needs a person's OK (policy word ${JSON.stringify(verdict.word)}).` : "";
      if (verdict.kind === "confirm") {
        // §19.3: a dry run says a grant would allow it, and counts nothing.
        const grant = await this.grantFor(session, tool, verdict.raw, verdict.word, "peek");
        if (grant !== null) needs = ` It is allowed by grant ${JSON.stringify(grant.name)} (${grant.counts} today).`;
        // §21.3: a touch that sends something stops at a draft first; nothing is shown now.
        else if ((await this.draftSource(session, verdict.raw, verdict.word)) !== null) needs = ` It stops at a draft first, and needs a person's OK (policy word ${JSON.stringify(verdict.word)}).`;
      }
      this.showAction("agent", method, shown !== undefined ? { element: shown } : undefined, params);
      return text([`${would}${needs}`, ...this.takePersonNote()].join("\n"));
    }
    // With a dialog the wait for a person's OK happens here, outside the live view's queue, so their own taps aren't held up.
    const ready = await this.awaitOk(session, tool, method, params, lists);
    if ("stop" in ready) return ready.stop;
    let granted: OkVia | undefined;
    let sentDraft = false;
    let covered: GrantUse | undefined;
    let answer: CallToolResult;
    const delivery = { sent: false };
    try {
      answer = await this.deliveryScope.run(delivery, () =>
        perform(async () => {
          const gate = await this.gatePreflight(session, tool, method, params, lists, ready.waited);
          if ("stop" in gate) return gate.stop;
          granted = gate.via;
          sentDraft = gate.draft === true;
          covered = gate.grant;
          return null;
        }),
      );
    } finally {
      await this.dropPreUse(ready.waited);
    }
    // A use is counted when the touch is made: one that surely wasn't made gives its use back (§19.4). A touch that was sent, or
    // may have been (a timeout, a failed read after it, a handler that threw), stays counted: a repeat must not beat the limits.
    if (covered !== undefined && answer.isError === true && !delivery.sent) await this.releaseGrant(covered);
    const notes = this.grantNotes.getStore();
    const withNotes = notes !== undefined ? flushNotes(answer, notes) : answer;
    if (covered !== undefined && answer.isError !== true) return appendNote(withNotes, covered.line);
    if (granted === undefined || answer.isError === true) return withNotes;
    this.journeyRun?.noteOk(granted);
    return appendNote(withNotes, `Note: ${sentDraft ? "sent" : "allowed"} by a person (in ${granted === "chat" ? "chat" : "the live view"}).`);
  }

  /**
   * The check right before a touch, shared by a single call and a drive's move: the policy's verdict, the person's OK used up,
   * and what the log and the road rules need to know about it (§18.2: a move that needed an OK is never saved as a road).
   */
  private async gatePreflight(
    session: SessionInfo,
    tool: string,
    method: string,
    params: Record<string, unknown>,
    lists: { confirm: string[]; block: string[] },
    waited: Waited | null,
    known?: KnownElements,
  ): Promise<{ stop: CallToolResult } | { via?: OkVia; grant?: GrantUse; draft?: true }> {
    const gate = await this.policyGate(session, tool, method, params, lists, waited, known);
    if ("stop" in gate) return gate;
    if (gate.grant !== undefined) {
      this.logExtra = { ...(this.logExtra ?? {}), grant: gate.grant.name, grant_use: `${gate.grant.counts} today` };
      return { grant: gate.grant };
    }
    if (gate.via === undefined) return {};
    this.logExtra = { ...(this.logExtra ?? {}), confirmed: true, confirmed_by: gate.via, ...(gate.draft === true ? { draft: true } : {}) };
    this.setOk(true);
    return { via: gate.via, ...(gate.draft === true ? { draft: true as const } : {}) };
  }

  /** What the person was asked for and what the screen showed then; the touch is checked against it right before it happens. */
  private fingerprint(element: TreeElement): string {
    return `${elementKey(element)}|${element.label ?? ""}|${element.text ?? ""}`;
  }

  /**
   * AGENT-TOOLS 1.13 §11.3: when the policy flags this touch and the host can show a dialog, ask there and wait for
   * the first answer, from the dialog or the live view, up to the request's 120 s. Runs before the touch's turn in
   * the live view's queue. `waited` carries the OK, used up, to the check right before the touch. Without a dialog,
   * or when nothing needs an OK, `waited` is null and the touch goes the old way.
   */
  private async awaitOk(
    session: SessionInfo,
    tool: string,
    method: string,
    params: Record<string, unknown>,
    lists: { confirm: string[]; block: string[] },
    /** Elements a drive already read: the policy is checked against them instead of a dry run (§18.4). */
    known?: KnownElements,
  ): Promise<{ stop: CallToolResult } | { waited: Waited | null }> {
    const dialogs = this.dialogs;
    // The explorer opens no dialog and no live-view request (§25.5): the check right before the touch stops it.
    if (this.exploreScope.getStore() !== undefined) return { waited: null };
    if (dialogs === undefined || !dialogs.available() || lists.confirm.length === 0) return { waited: null };
    const resolved = known !== undefined ? ({ kind: "ok", elements: known.elements, raw: known.raw } as const) : await this.resolveForPolicy(session, method, params);
    // A target that can't be checked is answered by the check right before the touch.
    if (resolved.kind === "error") return { waited: null };
    const verdict = this.policyWords(lists, resolved);
    if (verdict.kind !== "confirm") return { waited: null };
    if (this.inReflexStep()) return { stop: this.reflexNeedsPerson(verdict.element, verdict.word) };
    // A grant that covers the touch asks no one. Its use is taken here, before the dialog stage, so that a use that can't be
    // taken (the audit line fails) falls back to asking a person; the check right before the touch takes it over (§19.3, §19.4).
    // §21.3: a touch under a draftsOnly grant, or in a drafts-only route, stops at a draft a person sees first: no grant stands in.
    const draft = await this.draftOf(session, verdict.raw, verdict.word);
    const asked: string[] = [];
    const early = draft === null ? await this.grantFor(session, tool, verdict.raw, verdict.word, "use", asked) : null;
    if (early !== null) return { waited: { fp: this.fingerprint(verdict.raw), pre: { use: early, handed: false } } };
    // The reason a grant didn't cover goes into the action log with the touch, also after a long wait.
    const keepAsked = (): void => {
      if (asked[0] !== undefined) this.logExtra = { ...(this.logExtra ?? {}), grant_asked: asked[0] };
    };
    const label = verdict.element.label ?? verdict.element.text ?? undefined;
    const caption = draft?.caption ?? captionFor(tool, label ?? undefined, params) ?? tool;
    const key = this.confirmKey(session, tool, verdict.raw) + draftBinding(draft);
    const ask = { kind: tool, caption, word: verdict.word };
    const fp = this.fingerprint(verdict.raw) + draftBinding(draft);
    const name = this.shortName(verdict.element, false);
    // `why` is a draft's reason for not being sent (§21.3); without one a draft is waiting in the live view.
    const refuse = (tail: string, why?: string): { stop: CallToolResult } => {
      keepAsked();
      this.showAction("agent", method, { element: verdict.element }, params, "not_allowed", "needs_confirmation");
      if (draft !== null) return { stop: fail(this.draftRefusal(name, verdict.word, why, tail)) };
      return { stop: fail(`Error not_allowed: needs_confirmation: ${name} needs a person's OK (policy word ${JSON.stringify(verdict.word)}). ${tail}`) };
    };
    const hold = this.holdScope.getStore();
    const cancelled = hold?.signal;
    const wasCancelled = (): boolean => cancelled?.aborted === true;
    if (wasCancelled()) return refuse("The call was cancelled before anyone answered.", "The call was cancelled before anyone answered.");
    const check = this.confirmations.check(key, ask);
    if (check.granted) {
      keepAsked();
      return { waited: { fp, via: check.via, ...(draft !== null ? { draft: draft.source } : {}) } };
    }
    if ("held" in check) {
      keepAsked();
      this.showAction("agent", method, { element: verdict.element }, params, "not_allowed", "needs_confirmation");
      if (draft !== null) return { stop: fail("Error not_allowed: needs_confirmation: the draft wasn't sent (They declined it just now.). Don't ask again by repeating the call: ask your user what they want.") };
      return {
        stop: fail(
          `Error not_allowed: needs_confirmation: ${name} needs a person's OK (policy word ${JSON.stringify(verdict.word)}), and they declined it just now. Don't ask again by repeating the call: ask your user what they want.`,
        ),
      };
    }
    const abort = new AbortController();
    const waitStarted = Date.now();
    // The dialog's answer goes through the same request the live view answers: the first one wins, the other is closed.
    const noDialog = new Promise<"no_dialog">((resolve) => {
      void (draft !== null
        ? dialogs.askDraft(draft.caption, draft.word, abort.signal)
        : dialogs.askOk(okCaption({ word: verdict.word, tool, role: verdict.element.role ?? "", ...(label !== undefined ? { text: label } : {}), app: session.app.name }), abort.signal)
      ).then((answer) => {
          if (answer === "unavailable") resolve("no_dialog");
          else if (answer !== "aborted") this.confirmations.answer(check.request.id, answer === "allow", "chat");
        });
    });
    // A cancelled or timed-out call closes the dialog and the request, and never touches.
    const onCancel = (): void => this.confirmations.withdraw(check.request.id);
    cancelled?.addEventListener("abort", onCancel, { once: true });
    const settled = await Promise.race([this.confirmations.wait(check.request.id), noDialog]);
    cancelled?.removeEventListener("abort", onCancel);
    abort.abort();
    // Time spent waiting for a person isn't the batch's time (§9.3); it is counted for this call only.
    if (hold !== undefined) hold.ms += Date.now() - waitStarted;
    if (settled === "no_dialog") {
      // The client can't show the dialog (it answered an error, not a choice): the live-view-only answer, no hold.
      return refuse(this.liveViewLine());
    }
    if (wasCancelled()) {
      if (settled.allow) this.confirmations.check(key, ask);
      return refuse("The call was cancelled before anyone answered.", "The call was cancelled before anyone answered.");
    }
    if (settled.expired) return refuse("Nobody answered. Ask your user, or repeat the call to ask again.", "Nobody answered.");
    if (!settled.allow) {
      this.options.audit?.write({ kind: "approval", app: session.app.id ?? session.app.name, name: verdict.word, detail: "declined" });
      return refuse("They declined. Ask your user what to do.", "They declined.");
    }
    const used = this.confirmations.check(key, ask);
    if (!used.granted) return { stop: fail(CHANGED_WHILE_WAITING) };
    // The person said yes in the chat's own dialog: they may also want it as a standing grant (§19.6).
    // A draft a person sends doesn't offer a grant: the next one is shown to them too.
    if (used.via === "chat" && draft === null) await this.offerGrant(session, verdict.word, verdict.raw, asked, cancelled);
    keepAsked();
    return { waited: { fp, via: used.via, ...(draft !== null ? { draft: draft.source } : {}) } };
  }

  /** The answer of a reflex's step that the policy flags at the moment it runs: skipped, never asked (§18.7). */
  private reflexNeedsPerson(element: TreeElement, word: string): CallToolResult {
    return fail(`Error not_allowed: needs_confirmation: ${this.shortName(element, false)} needs a person's OK (policy word ${JSON.stringify(word)}); a reflex never asks.`);
  }

  /** Where an OK is given when no dialog can be shown (AGENT-TOOLS 1.8 §11.2). */
  private liveViewLine(): string {
    return this.options.canConfirm === false
      ? "The live view is off, so nobody can allow it here; ask your user."
      : "The live view asks them now; when they allow it, make the same call again. If nobody is watching, ask your user.";
  }

  /** An OK is for this server, this client, this app, this tool and this element only (Tapwright's review, M1). */
  private confirmKey(session: SessionInfo, tool: string, element: TreeElement): string {
    const client = (this.clientIdFn ?? this.options.clientId)?.() ?? "";
    return `${this.options.confirmScope ?? "mcp"}|${client}|${session.app.id}|${tool}|${elementKey(element)}`;
  }

  /**
   * Runs a call of the agent with its own wait counter and, when there is one, the request's abort signal, so a
   * wait for a person's OK is counted for this call only and closes when the call is cancelled.
   */
  withCall<T>(signal: AbortSignal | undefined, run: () => T, leaseCredential?: string, progress?: (line: string, steps: number) => void): T {
    return this.holdScope.run({ ms: 0, ...(signal !== undefined ? { signal } : {}), ...(leaseCredential !== undefined ? { lease: leaseCredential } : {}), ...(progress !== undefined ? { progress } : {}) }, run);
  }

  /**
   * The policy's verdict on a touch about to happen: stop with an answer (blocked, needs a person's OK, or
   * the check couldn't be made: fail closed), or go on (`granted` when a person's OK is being used up).
   */
  private async policyGate(
    session: SessionInfo,
    tool: string,
    method: string,
    params: Record<string, unknown>,
    lists: { confirm: string[]; block: string[] },
    /** An OK the person gave while the call waited (`awaitOk`): used up, and checked against the screen as it is now. */
    waited?: Waited | null,
    /** Elements a drive already read: checked instead of a dry run; the app's guard holds the touch to them (§18.4). */
    known?: KnownElements,
  ): Promise<{ stop: CallToolResult } | { granted: boolean; via?: OkVia; grant?: GrantUse; draft?: true }> {
    if (lists.confirm.length === 0 && lists.block.length === 0) return { granted: false };
    const resolved = known !== undefined ? ({ kind: "ok", elements: known.elements, raw: known.raw } as const) : await this.resolveForPolicy(session, method, params);
    if (resolved.kind === "error") {
      // Fail closed: what can't be checked isn't touched. The answer is the one the touch would give.
      this.showAction("agent", method, undefined, params, resolved.code, resolved.reason);
      return { stop: fail(resolved.text) };
    }
    const verdict = this.policyWords(lists, resolved);
    if (verdict.kind === "blocked") {
      this.showAction("agent", method, { element: verdict.element }, params, "not_allowed", "blocked");
      return { stop: fail(this.blockedLine(verdict.element, verdict.word)) };
    }
    // `explore` is never asked and no grant stands in for it (§25.5): a touch that needs a person's OK isn't made, and no use is counted.
    if (verdict.kind === "confirm" && this.exploreScope.getStore() !== undefined) {
      this.showAction("agent", method, { element: verdict.element }, params, "not_allowed", "needs_confirmation");
      return { stop: fail(`Error not_allowed: needs_confirmation: ${this.shortName(verdict.element, false)} needs a person's OK (policy word ${JSON.stringify(verdict.word)}); explore never asks, so it skips it.`) };
    }
    // The element that really receives the touch (after any scroll, whichever the target named) meets the whole floor (§25.5): the
    // app's skip marks (inherited ones included), a card or password field and the submit rule, on top of the words above.
    if (this.exploreScope.getStore() !== undefined) {
      const rules = this.exploreRules(session);
      for (const [i, raw] of resolved.raw.entries()) {
        const needsInput = submitWord(raw) !== null && !isListedSubmit(raw, rules);
        const hit = recipientVerdict(raw, rules, needsInput ? await this.screenHasInput(session) : false);
        if (hit === null) continue;
        const shown = resolved.elements[i] ?? raw;
        this.showAction("agent", method, { element: shown }, params, "not_allowed", "needs_confirmation");
        const word = hit.word !== undefined ? ` (policy word ${JSON.stringify(this.host.redactOut(hit.word))})` : "";
        return { stop: fail(`Error not_allowed: needs_confirmation: ${this.shortName(shown, false)} is skipped by explore${word}: the touch would reach a protected control (explore skip: ${hit.why}).`) };
      }
    }
    // A reflex never asks (§18.7): what the screen shows now is flagged, so the reflex is skipped, with no dialog and no request.
    if (verdict.kind === "confirm" && this.inReflexStep()) return { stop: this.reflexNeedsPerson(verdict.element, verdict.word) };
    // §21.3: read again right before the touch: the OK a person gave is for the text they saw.
    // Whether a draft applies was decided where the person was asked; a grant made by their answer in this very call is for the next touch.
    const waiting = waited !== undefined && waited !== null;
    const draftFrom = waiting ? ("draft" in waited ? waited.draft : undefined) : undefined;
    let draft =
      verdict.kind !== "confirm" ? null : waiting ? (draftFrom !== undefined ? await this.draftWith(session, draftFrom, verdict.word) : null) : await this.draftOf(session, verdict.raw, verdict.word);
    // The reserved grant stopped covering the touch while the call waited (R1): its use is back, and the touch goes the way it would have with no grant.
    let lostGrant = false;
    if (waited !== undefined && waited !== null) {
      // §11.3: the same element, with the same label, still touchable (the dry run passed), in the same app in front.
      // A call that was cancelled while it waited never touches.
      const same =
        verdict.kind === "confirm" &&
        this.fingerprint(verdict.raw) + draftBinding(draft) === waited.fp &&
        this.host.current()?.id === session.id &&
        this.holdScope.getStore()?.signal?.aborted !== true;
      if (!same) {
        this.showAction("agent", method, undefined, params, "not_allowed", "needs_confirmation");
        return { stop: fail(CHANGED_WHILE_WAITING) };
      }
      if ("pre" in waited) {
        // The grant's use was taken before the dialog stage. The wait for control may have outlasted what it was taken under (a
        // revocation, draftsOnly, quiet hours, `until`): read the policy again right now, taking no further use.
        const use = waited.pre.use;
        let covers = false;
        try {
          covers = this.options.grants !== undefined && (await this.options.grants.stillCovers({ app: session.app, element: verdict.raw, routes: this.routeScope.getStore() ?? [] }, use));
        } catch {
          covers = false;
        }
        if (covers) {
          // It is this touch's now, and given back if the touch isn't made.
          waited.pre.handed = true;
          return { granted: false, grant: use };
        }
        waited.pre.handed = true;
        await this.releaseGrant(use);
        lostGrant = true;
        draft = verdict.kind === "confirm" ? await this.draftOf(session, verdict.raw, verdict.word) : null;
      } else {
        this.approved(session, verdict.word, waited.via, draft !== null);
        return { granted: true, via: waited.via, ...(draft !== null ? { draft: true as const } : {}) };
      }
    }
    if (verdict.kind === "none") return { granted: false };
    // §19.3: where the policy says a person must OK, a grant may stand in for them: it is used up here, right before the touch.
    // Not for a draft (§21.3): a person sees it first. Not again after the one reserved for this call stopped covering.
    const grant = draft === null && !lostGrant ? await this.grantFor(session, tool, verdict.raw, verdict.word, "use") : null;
    if (grant !== null) return { granted: false, grant };
    const label = verdict.element.label ?? verdict.element.text ?? undefined;
    const caption = draft?.caption ?? captionFor(tool, label ?? undefined, params) ?? tool;
    // The client is part of the key, so one agent can't use up an OK a person gave for another's call.
    const check = this.confirmations.check(this.confirmKey(session, tool, verdict.raw) + draftBinding(draft), { kind: tool, caption, word: verdict.word });
    if (check.granted) {
      this.approved(session, verdict.word, check.via, draft !== null);
      return { granted: true, via: check.via, ...(draft !== null ? { draft: true as const } : {}) };
    }
    const name = this.shortName(verdict.element, false);
    if ("held" in check) {
      this.showAction("agent", method, { element: verdict.element }, params, "not_allowed", "needs_confirmation");
      if (draft !== null) return { stop: fail("Error not_allowed: needs_confirmation: the draft wasn't sent (They declined it just now.). Don't ask again by repeating the call: ask your user what they want.") };
      return {
        stop: fail(
          `Error not_allowed: needs_confirmation: ${name} needs a person's OK (policy word ${JSON.stringify(verdict.word)}), and they declined it just now. Don't ask again by repeating the call: ask your user what they want.`,
        ),
      };
    }
    this.showAction("agent", method, { element: verdict.element }, params, "not_allowed", "needs_confirmation");
    if (draft !== null) return { stop: fail(this.draftRefusal(name, verdict.word, undefined, `${this.liveViewLine()}${check.suffix}`)) };
    return {
      stop: fail(
        `Error not_allowed: needs_confirmation: ${this.shortName(verdict.element, false)} needs a person's OK (policy word ${JSON.stringify(verdict.word)}). ${this.liveViewLine()}${check.suffix}`,
      ),
    };
  }

  /**
   * AGENT-TOOLS 1.14 §19.3: whether a grant covers this touch, which the policy says needs a person. `use` records the use (and
   * the audit line) and `peek` counts nothing. A grant that matched but can't cover the touch adds its note to the call's answer.
   * A touch that is never grantable, or has no grant, answers null: it asks as before.
   */
  private async grantFor(session: SessionInfo, tool: string, element: TreeElement, word: string, mode: "use" | "peek", askedOut?: string[]): Promise<GrantUse | null> {
    const book = this.options.grants;
    if (book === undefined || word === UNREADABLE_LINK) return null;
    const shown = this.host.redactOut((element.label ?? element.text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim()).slice(0, 80);
    let decision: GrantDecision;
    try {
      decision = await book.decide({ app: session.app, element, routes: this.routeScope.getStore() ?? [] }, mode, `${tool} ${JSON.stringify(shown)}`);
    } catch {
      return null;
    }
    // A draftsOnly grant covers nothing by itself: the touch stops at a draft (§21.3).
    if (decision.kind === "draft") return null;
    if (decision.kind === "ask") {
      const notes = this.grantNotes.getStore();
      if (notes !== undefined) for (const note of decision.notes) if (!notes.includes(note)) notes.push(note);
      if (mode === "use" && decision.asked[0] !== undefined) {
        askedOut?.push(...decision.asked);
        this.logExtra = { ...(this.logExtra ?? {}), grant_asked: decision.asked[0] };
      }
      return null;
    }
    return { name: decision.name, line: decision.line, owner: decision.owner, slots: decision.slots, counts: decision.counts };
  }

  /** A person's OK is used up: one `approval` line of the audit log (§23). */
  private approved(session: SessionInfo, word: string, via: OkVia, draft = false): void {
    this.options.audit?.write({
      kind: "approval",
      app: session.app.id ?? session.app.name,
      name: word,
      detail: draft ? "draft sent" : `allowed by a person (in ${via === "chat" ? "chat" : "the live view"})`,
    });
  }

  /**
   * AGENT-TOOLS 1.14 §21.3: why a touch stops at a draft, or null. Under a `draftsOnly` grant that would cover the touch, or in a
   * route that carries `"draftsOnly": true` for a word that reaches other people. Reads nothing from the phone.
   */
  private async draftSource(session: SessionInfo, element: TreeElement, word: string): Promise<"grant" | "route" | null> {
    if (word === UNREADABLE_LINK) return null;
    if (this.draftsScope.getStore() === true && matchWord(REACH_WORDS, element) !== null) return "route";
    const book = this.options.grants;
    if (book === undefined) return null;
    try {
      const decision = await book.decide({ app: session.app, element, routes: this.routeScope.getStore() ?? [] }, "peek", "");
      return decision.kind === "draft" ? "grant" : null;
    } catch {
      return null;
    }
  }

  /** The draft a touch stops at (§21.3), with the question and the field's text as the person will see them; null when none applies. */
  private async draftOf(session: SessionInfo, element: TreeElement, word: string): Promise<Draft | null> {
    const source = await this.draftSource(session, element, word);
    return source === null ? null : this.draftWith(session, source, word);
  }

  /** The draft as the field holds it now. */
  private async draftWith(session: SessionInfo, source: Draft["source"], word: string): Promise<Draft> {
    const text = await this.draftText(session);
    return { source, word, text, caption: draftCaption({ word, app: session.app.name, text }) };
  }

  /**
   * The text of the field the agent last typed into on this screen, else the only input that holds text, read from the app now
   * (Tapline's host reads it from the app, §21.3). Redacted of vault and account values. A secure field is never kept, and what
   * can't be read is an empty draft.
   */
  private async draftText(session: SessionInfo): Promise<string> {
    let read: ReturnType<typeof treeResultSchema.safeParse>;
    try {
      read = treeResultSchema.safeParse(await this.sendRequest("tree", { peek: true }, { sessionId: session.id, internal: true }));
    } catch {
      return "";
    }
    if (!read.success) return "";
    const inputs = read.data.elements.filter((e) => roleOf(e) === "input" || (e.actions ?? []).includes("type"));
    const last = this.lastTyped;
    // By id when it has one: a full look renumbers the refs, so a ref may now name another input.
    const own = last !== undefined && last.sessionId === session.id ? (last.testID !== undefined ? inputs.find((e) => e.testID === last.testID) : inputs.find((e) => e.ref === last.ref)) : undefined;
    const filled = inputs.filter((e) => typeof e.value === "string" && e.value !== "");
    const field = own ?? (filled.length === 1 ? filled[0] : undefined);
    return typeof field?.value === "string" ? this.host.redactOut(field.value) : "";
  }

  /** A draft that wasn't sent, or one that waits in the live view (§21.3). `why` is the reason in parentheses. */
  private draftRefusal(name: string, word: string, why: string | undefined, tail: string): string {
    return why !== undefined
      ? `Error not_allowed: needs_confirmation: the draft wasn't sent (${why}). Ask your user what to do.`
      : `Error not_allowed: needs_confirmation: a draft is waiting for a person (${name}, policy word ${JSON.stringify(word)}). ${tail}`;
  }

  /** A use taken before the dialog stage that no check took over (the call stopped first): given back. */
  private async dropPreUse(waited: Waited | null | undefined): Promise<void> {
    if (waited === null || waited === undefined || !("pre" in waited) || waited.pre.handed) return;
    waited.pre.handed = true;
    await this.releaseGrant(waited.pre.use);
  }

  /** Asked once per app and word in a session, whatever the answer: a person who said no isn't asked at every touch. */
  private readonly grantOffers = new Set<string>();

  /**
   * AGENT-TOOLS 1.14 §19.6: a person has just allowed a touch in the chat's own dialog; the host offers to make that a standing
   * grant. The host starts this, the person answers, and the grant is written only from their answers: nothing a model sends
   * can start, answer or change it. Never offered for what no grant can cover (§19.2), nor where a live grant matched and
   * ran out (a new grant would only undo its limit); an ended grant is renewed this way.
   */
  private async offerGrant(session: SessionInfo, word: string, element: TreeElement, asked: string[], signal: AbortSignal | undefined): Promise<void> {
    const book = this.options.grants;
    const dialogs = this.dialogs;
    if (book === undefined || dialogs === undefined || !dialogs.available() || word === UNREADABLE_LINK || this.inReflexStep()) return;
    if (asked.some((reason) => reason !== "ended")) return;
    if (neverGrantable(word, listsFor(this.policy, session.app).block) || elementNeverGrantable(element)) return;
    const app = session.app.id ?? session.app.name;
    const key = `${app}|${word.toLowerCase()}`;
    if (this.grantOffers.has(key)) return;
    this.grantOffers.add(key);
    const routes = this.routeScope.getStore() ?? [];
    const route = routes[routes.length - 1];
    const spec: GrantSpec = {
      nameBase: grantNameBase(session.app.name, word),
      app,
      words: [word],
      ...(route !== undefined ? { route } : {}),
      perDay: GRANT_OFFER_PER_DAY,
      days: GRANT_OFFER_DAYS,
    };
    const caption = grantCaption(
      { words: spec.words, perDay: spec.perDay, until: book.untilFor(spec.days), ...(route !== undefined ? { route } : {}), draftsOnly: reachesPeople(word) },
      plainText(session.app.name) || "the app",
    );
    if ((await dialogs.askGrant(caption, signal)) !== "allow") return;
    const lift = reachesPeople(word) ? (await dialogs.askLiftDrafts(signal)) === "allow" : false;
    await book.create({ ...spec, ...(lift ? { draftsOnly: false as const } : {}) });
  }

  /** The touch wasn't made: its use is given back (§19.4). */
  private async releaseGrant(use: GrantUse): Promise<void> {
    try {
      await this.options.grants?.release(use);
    } catch {
      // a use that can't be given back stays counted: the safe side
    }
  }

  /** Which policy word, if any, the elements the target could mean carry: a block word first, then a confirm word. */
  private policyWords(
    lists: { confirm: string[]; block: string[] },
    resolved: { elements: TreeElement[]; raw: TreeElement[] },
  ): { kind: "blocked" | "confirm"; element: TreeElement; raw: TreeElement; word: string } | { kind: "none" } {
    // The words are matched on the raw elements, so a label an account value hides is still the word it is. What the
    // verdict carries for showing (`element`, `word`) is scrubbed; `raw` stays inside, for the key and the fingerprint.
    // For `explore` only (§25.5), an element with no label and no text is matched on its id as words, so `delete-row` counts as `Delete`.
    const subject = (element: TreeElement): { label?: string | null; text?: string | null } => (this.exploreScope.getStore() !== undefined ? floorSubject(element) : element);
    for (const [i, raw] of resolved.raw.entries()) {
      const word = matchWord(lists.block, subject(raw));
      const element = resolved.elements[i];
      if (word !== null && element !== undefined) return { kind: "blocked", element, raw, word: this.host.redactOut(word) };
    }
    // A link that couldn't be decoded needs a person's OK, whatever the word lists say.
    for (const [i, raw] of resolved.raw.entries()) {
      const element = resolved.elements[i];
      if (raw.role === "link" && raw.label === UNREADABLE_LINK && element !== undefined) return { kind: "confirm", element, raw, word: UNREADABLE_LINK };
    }
    for (const [i, raw] of resolved.raw.entries()) {
      const word = matchWord(lists.confirm, subject(raw));
      const element = resolved.elements[i];
      if (word !== null && element !== undefined) return { kind: "confirm", element, raw, word: this.host.redactOut(word) };
    }
    return { kind: "none" };
  }

  private blockedLine(element: TreeElement, word: string): string {
    return `Error not_allowed: blocked: ${this.shortName(element, false)} is blocked by the policy (${JSON.stringify(word)}); don't try another way.`;
  }

  /** A dry run the app answers itself (scroll, back, swipe): its checks, nothing touched, one line. */
  private async dryCall(method: string, params: Record<string, unknown>, line: (result: unknown) => string): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    if (!session.capabilities.includes("dryRun")) {
      return fail("Error unsupported: this app's Tapline is too old for dry runs; update react-native-tapline.");
    }
    const stale = this.staleRef(params);
    if (stale !== null) return stale;
    this.actionStartedAt = Date.now();
    let result: unknown;
    try {
      result = await this.sendRequest(method, { ...params, dryRun: true }, { sessionId: session.id });
    } catch (error) {
      this.logExtra = { dry_run: true };
      this.showAction("agent", method, undefined, params, error instanceof TaplineError ? error.code : "internal", error instanceof TaplineError ? reasonOf(error.code, error.message) : undefined);
      return fail(describeError(error));
    }
    if (typeof result !== "object" || result === null || (result as { dryRun?: unknown }).dryRun !== true) {
      return fail("Error internal: the app didn't answer the dry run.");
    }
    this.logExtra = { dry_run: true };
    this.showAction("agent", method, result, params);
    return text([line(result), ...this.takePersonNote()].join("\n"));
  }

  /** A dry run of a tool the policy doesn't guard (type_text): the app's checks, nothing touched. */
  private async dryRun(tool: string, method: string, params: Record<string, unknown>): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const stale = this.staleRef(params);
    if (stale !== null) return stale;
    const resolved = await this.resolveForPolicy(session, method, params);
    this.logExtra = { dry_run: true };
    if (resolved.kind === "error") {
      this.showAction("agent", method, undefined, params, resolved.code, resolved.reason);
      return fail(resolved.text);
    }
    this.showAction("agent", method, resolved.elements[0] !== undefined ? { element: resolved.elements[0] } : undefined, params);
    return text([this.wouldLine(tool, resolved.elements[0], resolved.point, resolved.value, resolved.scrolls), ...this.takePersonNote()].join("\n"));
  }

  /**
   * What a touch would act on. Apps that know dry runs resolve it themselves, with every check; older
   * apps only give their element list, and every element the target could mean is checked.
   */
  private async resolveForPolicy(
    session: SessionInfo,
    method: string,
    params: Record<string, unknown>,
  ): Promise<
    | { kind: "ok"; elements: TreeElement[]; raw: TreeElement[]; point?: { x: number; y: number }; value?: unknown; scrolls?: true }
    | { kind: "error"; text: string; code: string; reason?: string }
  > {
    // `raw` still holds the account values, for the policy and the guard only; `elements` is what may be shown or kept.
    if (session.capabilities.includes("dryRun")) {
      let raw: unknown;
      try {
        raw = await this.sendRequest(method, { ...params, dryRun: true }, { sessionId: session.id, internal: true });
      } catch (error) {
        const reason = error instanceof TaplineError ? reasonOf(error.code, error.message) : undefined;
        return {
          kind: "error",
          text: kindRefusal(error, params["kind"]) ?? describeError(error),
          code: error instanceof TaplineError ? error.code : "internal",
          ...(reason !== undefined ? { reason } : {}),
        };
      }
      const parsed = dryRunResultSchema.safeParse(raw);
      if (!parsed.success) return { kind: "error", text: "Error internal: the app didn't answer the dry run.", code: "internal" };
      const found = parsed.data.element ? [parsed.data.element] : [];
      return {
        kind: "ok",
        elements: this.host.redactOut(found),
        raw: found,
        ...(parsed.data.point !== undefined ? { point: parsed.data.point } : {}),
        ...(parsed.data.value !== undefined ? { value: parsed.data.value } : {}),
        ...(parsed.data.scrolls === true ? { scrolls: true } : {}),
      };
    }
    // An app without dry runs: a swipe is checked by what lies under its start.
    const target = method === "swipe" ? { x: params["x0"], y: params["y0"] } : params["target"];
    if (method === "type" || target === undefined) {
      return { kind: "error", text: "Error unsupported: this app's Tapline is too old for dry runs; update react-native-tapline.", code: "unsupported" };
    }
    let raw: unknown;
    try {
      raw = await this.sendRequest("tree", {}, { sessionId: session.id, internal: true });
    } catch (error) {
      return { kind: "error", text: describeError(error), code: error instanceof TaplineError ? error.code : "internal" };
    }
    const tree = treeResultSchema.safeParse(raw);
    if (!tree.success) return { kind: "error", text: "Error internal: the app returned an element list the host could not read.", code: "internal" };
    const elements = candidatesFor(target, tree.data.elements);
    if (elements.length === 0 && method !== "swipe") {
      return { kind: "error", text: "Error not_found: nothing on screen matches that target.", code: "not_found" };
    }
    const first = elements[0];
    const frame = elements.length === 1 && first !== undefined ? first.frame : null;
    return {
      kind: "ok",
      elements: this.host.redactOut(elements),
      raw: elements,
      ...(frame ? { point: { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) } } : {}),
    };
  }

  /** `Would tap e12 button "Delete trip" at 215,640.` */
  private wouldLine(
    tool: string,
    element: TreeElement | undefined,
    point: { x: number; y: number } | undefined,
    value: unknown,
    scrolls?: boolean,
  ): string {
    const name = element !== undefined ? this.shortName(element, true, scrolls === true) : "the element";
    // Off screen (§16.2): `Would scroll to it, then tap e41 button "Save" id=save at 215,640.` The point is the one expected after the scroll.
    const lead = scrolls === true ? "Would scroll to it, then" : "Would";
    const at = point !== undefined ? ` at ${point.x},${point.y}` : "";
    switch (tool) {
      case "long_press":
        return `${lead} long-press ${name}${at}.`;
      case "toggle":
        return `${lead} toggle ${name}${typeof value === "boolean" ? ` to ${String(value)}` : ""}${at}.`;
      case "type_text":
        return `${lead} type into ${name}${scrolls === true ? at : ""}.`;
      default:
        return `${lead} tap ${name}${at}.`;
    }
  }

  /** `e12 button "Delete trip"`: ref (when asked), role and name, nothing else. */
  private shortName(element: TreeElement, withRef: boolean, withId = false): string {
    return formatElement(
      {
        ref: withRef ? element.ref : "",
        ...(withId ? { testID: element.testID ?? null } : {}),
        role: element.role ?? null,
        type: element.type ?? null,
        label: element.label ?? null,
        text: element.text ?? null,
        textMore: element.textMore ?? null,
      },
      { actions: false, eyes: this.userEyes() },
    );
  }

  /** A `{ref}` target after a person used the app: refs may point elsewhere. */
  private staleRef(params: unknown): CallToolResult | null {
    if (!this.personActed) return null;
    const target = typeof params === "object" && params !== null ? (params as { target?: unknown }).target : undefined;
    if (typeof target === "object" && target !== null && "ref" in target) {
      // The error says it already, so the note isn't repeated.
      this.personNotePending = false;
      return fail(
        "Error stale: a person used the app since your last look, so refs from that list may point elsewhere. Look again, or target by id, label or text.",
      );
    }
    return null;
  }

  tap(args: Shape<"tap">): Promise<CallToolResult> {
    const hiddenTap = this.hiddenTarget(args.target);
    if (hiddenTap !== null) return Promise.resolve(hiddenTap);
    const params = { target: toWireTarget(withIndex(args.target, args.index)), ...(args.force === true ? { force: true } : {}), ...(this.userEyes() ? { noScroll: true } : {}) };
    return this.guarded("tap", "press", params, args.dry_run === true, (preflight) =>
      this.act("press", params, (r) => afterScroll(r, `Tapped ${this.elementName(r)}.`), args.look, args.screenshot, undefined, undefined, preflight, args.brief, "tap"),
    );
  }

  /** `seconds` is accepted for the shared interface; Tapline calls the handler, so it doesn't hold. */
  longPress(args: Shape<"long_press">): Promise<CallToolResult> {
    const hiddenPress = this.hiddenTarget(args.target);
    if (hiddenPress !== null) return Promise.resolve(hiddenPress);
    const params = { target: toWireTarget(withIndex(args.target, args.index)), ...(args.force === true ? { force: true } : {}), ...(this.userEyes() ? { noScroll: true } : {}) };
    return this.guarded("long_press", "longPress", params, args.dry_run === true, (preflight) =>
      this.act("longPress", params, (r) => afterScroll(r, `Long-pressed ${this.elementName(r)}.`), args.look, args.screenshot, undefined, undefined, preflight, args.brief, "long_press"),
    );
  }

  typeText(args: Shape<"type_text">): Promise<CallToolResult> {
    const otpApp = otpReference(args.text);
    if (otpApp === null) return this.typeTextWith(args, undefined);
    // A one-time code (§20.4): the same checks as any typed text first, then the code is asked of Tapwright's daemon, and only
    // for the connected app's own id, only now that a step types it.
    const hiddenField = this.hiddenTarget(args.target);
    if (hiddenField !== null) return Promise.resolve(hiddenField);
    const badAs = this.asRefusal(args.as, args.text, args.account);
    if (badAs !== null) return Promise.resolve(fail(badAs));
    if (args.account !== undefined) return Promise.resolve(fail("Error bad_params: a one-time code takes no account; write ${otp.<app>} alone."));
    const session = this.host.current();
    if (session === undefined) return Promise.resolve(this.notConnected());
    const refused = this.otpRefusal(otpApp, session);
    if (refused !== null) return Promise.resolve(fail(`Error bad_params: ${refused}`));
    const app = session.app.id ?? session.app.name;
    // A dry run checks the field and asks for nothing: no code is fetched, and none is spent.
    if (args.dry_run === true) return this.typeTextWith(args, { value: "", source: undefined, sessionId: session.id });
    return this.otp.fetch(app).then((got: OtpFetch) =>
      got.ok
        ? this.typeTextWith(args, { value: got.code, source: got.source, sessionId: session.id })
        : fail(`Error ${got.reason === "none" ? "not_found" : "unsupported"}: ${got.message}`),
    );
  }

  /** Why `${otp.<app>}` can't be typed for the connected app, or null: the id must be the connected app's own. */
  private otpRefusal(named: string, session: SessionInfo): string | null {
    const own = session.app.id ?? session.app.name;
    return named === own ? null : `\${otp.${named}} names another app than the connected one; a one-time code is typed only for the connected app (${own}), as \${otp.${own}}.`;
  }

  /** What `${otp.<app>}` checks before any step runs: the app it names, as for an account. Null when it holds or isn't a code. */
  private otpPrecheck(text: string, session: SessionInfo): string | null {
    const named = otpReference(text);
    return named === null ? null : this.otpRefusal(named, session);
  }

  private typeTextWith(args: Shape<"type_text">, otp: { value: string; source: string | undefined; sessionId: string } | undefined): Promise<CallToolResult> {
    const hiddenField = this.hiddenTarget(args.target);
    if (hiddenField !== null) return Promise.resolve(hiddenField);
    const badAs = this.asRefusal(args.as, args.text, args.account);
    if (badAs !== null) return Promise.resolve(fail(badAs));
    // A test account's value (§18.6): `params` keeps the placeholder for the log, the viewer and a recording; the
    // value goes to the app only, through `wire`. A one-time code goes the same way.
    const session = this.host.current();
    const account =
      otp !== undefined
        ? ({ ok: true, value: otp.value, kind: undefined, use: undefined } as const)
        : this.accountText(args.text, args.account, session);
    if (account !== null && !account.ok) return Promise.resolve(fail(`Error ${account.code}: ${account.message}`));
    const params: Record<string, unknown> = {
      text: args.text,
      replace: args.replace ?? true,
      submit: args.submit ?? false,
      ...(account !== null && args.text.includes("${account.") ? { account: args.account ?? this.runAccount } : {}),
      ...(this.userEyes() ? { noScroll: true } : {}),
    };
    if (args.target !== undefined) params["target"] = toWireTarget(withIndex(args.target, args.index));
    if (args.force === true) params["force"] = true;
    const wire =
      account !== null && account.ok && session !== undefined
        ? { values: { text: account.value, kind: account.kind }, sessionId: otp?.sessionId ?? session.id, ...(account.use?.kind === "fixture" ? { fixture: true as const } : {}) }
        : undefined;
    // Typing isn't guarded by the policy (§11.1: the form's button is); a dry run still checks the field.
    if (args.dry_run === true) {
      if (wire === undefined) {
        // A placeholder with no checked account is never sent, not even to be resolved.
        if (mentionsVault(args.text)) return Promise.resolve(this.notConnected());
        return this.dryRun("type_text", "type", params);
      }
      const { account: _account, ...plain } = params;
      return this.dryRun("type_text", "type", { ...plain, text: "", ...(wire.values["kind"] !== undefined ? { kind: wire.values["kind"] } : {}) });
    }
    const use = account !== null && account.ok ? account.use : undefined;
    // A plain text typed during a replay is registered for redaction before it is sent (a vault, account or code value is covered already).
    if (wire === undefined && !mentionsVault(args.text)) this.registerReplayTyped(args.text);
    // What the audit line says about the field the value went into (§23): the app's own answer says whether it was secure.
    let secureField: boolean | undefined;
    const typed = this.act(
      "type",
      // `as` is for the recording only: `act` keeps it out of what goes to the app.
      args.as !== undefined ? { ...params, as: args.as } : params,
      (r) => {
        const value = typeof r === "object" && r !== null && "value" in r ? (r as { value: unknown }).value : undefined;
        // AGENT-TOOLS 1.8 §3.3: a secure field's value is never shown, not even as bullets in this line
        const secure = typeof r === "object" && r !== null && "secure" in r && (r as { secure: unknown }).secure === true;
        // Journey or not, iOS shows the last character of a password for about a second: remember when (finding 4).
        if (secure) this.secureTypedAt = this.clock();
        secureField = secure;
        // The draft's field (§21.3): the last input typed into. A secure field's text is never read back.
        const typedInto = !secure && typeof r === "object" && r !== null && "element" in r ? elementSchema.safeParse((r as { element: unknown }).element) : undefined;
        const typedSession = this.host.current();
        if (typedInto?.success === true && typedSession !== undefined) {
          this.lastTyped = { sessionId: typedSession.id, ref: typedInto.data.ref, ...(typedInto.data.testID ? { testID: typedInto.data.testID } : {}) };
        }
        const shown = secure ? " The value is hidden (secure field)." : typeof value === "string" ? ` Value is now ${JSON.stringify(value)}.` : "";
        return afterScroll(r, `Typed into ${this.elementName(r, "element", shown !== "")}${args.submit ? " and submitted" : ""}.${shown}`);
      },
      args.look,
      args.screenshot,
      undefined,
      undefined,
      use?.kind === "card" && session !== undefined ? () => this.cardOk(session, use, params) : undefined,
      args.brief,
      undefined,
      wire,
    );
    if (otp !== undefined && session !== undefined) {
      // One `otp` line per code typed: the app and the source, never the code (§20.4, §23). The answer is scrubbed as well,
      // whatever the app echoed back.
      return typed.then((answer) => {
        if (answer.isError !== true) {
          this.options.audit?.write({ kind: "otp", app: session.app.id ?? session.app.name, detail: `from ${otp.source ?? "Tapwright"}` });
        }
        return { ...answer, content: answer.content.map((part) => (part.type === "text" ? { ...part, text: this.scrubSecrets(part.text) } : part)) };
      });
    }
    if (use === undefined || session === undefined) return typed;
    // Every use of a vault value is one `vault` line: the entry and the field, never the value (§20.1, §23).
    return typed.then((answer) => {
      if (answer.isError !== true) {
        this.options.audit?.write({
          kind: "vault",
          app: session.app.id ?? session.app.name,
          name: use.name,
          detail: `${use.field} into ${secureField === true ? "secure field" : "text field"}`,
        });
      }
      return answer;
    });
  }

  /** Why `as` can't be used on this typed text (AGENT-TOOLS 1.13 §18.5), or null: it goes only while a route records. */
  private asRefusal(as: string | undefined, text: string, account: string | undefined): string | null {
    if (as === undefined) return null;
    if (this.recording?.route === undefined) return "Error bad_params: as goes only while recording a route (record with route).";
    const problem = variableProblem(as);
    if (problem !== null) return `Error bad_params: ${problem}`;
    if (account !== undefined || mentionsVault(text)) return "Error bad_params: as can't go with an account's value; the route keeps its placeholder already.";
    return null;
  }

  /**
   * A card's field is typed only with a person's OK, every time, and no grant covers it (AGENT-TOOLS 1.14 §19.2, §20.1). The
   * dialog's words name the entry and the field, never the value. Returns an answer that stops the call, or null to go on.
   */
  private async cardOk(session: SessionInfo, use: VaultUse, params: Record<string, unknown>): Promise<CallToolResult | null> {
    const { account: _account, ...plain } = params;
    const resolved = await this.resolveForPolicy(session, "type", { ...plain, text: "" });
    if (resolved.kind === "error") return fail(resolved.text);
    const label = resolved.elements[0]?.label ?? resolved.elements[0]?.text ?? undefined;
    const role = resolved.elements[0]?.role ?? "field";
    const app = plainText(session.app.name) || "the app";
    const what = label !== undefined && plainText(label) !== "" ? `"${plainText(label)}"` : `the ${plainText(role, 30) || "field"}`;
    const caption = `Allow: type card "${use.name}" ${use.field} into ${what} in ${app}?`;
    const words = `typing card "${use.name}" ${use.field}`;
    const refuse = (tail: string): CallToolResult => fail(`Error not_allowed: needs_confirmation: ${words} needs a person's OK, every time (no grant covers a card). ${tail}`);
    if (this.inReflexStep()) return refuse("A reflex never asks.");
    const key = this.confirmKey(session, `card:${use.name}.${use.field}`, resolved.raw[0] ?? { ref: "", role: "input" });
    const ask = { kind: "type_text", caption, word: "card" };
    const check = this.confirmations.check(key, ask);
    if (check.granted) {
      this.approved(session, "card", check.via);
      return null;
    }
    if ("held" in check) return refuse("They declined it just now. Don't ask again by repeating the call: ask your user what they want.");
    const dialogs = this.dialogs;
    if (dialogs === undefined || !dialogs.available()) return refuse(`${this.liveViewLine()}${check.suffix}`);
    const hold = this.holdScope.getStore();
    const cancelled = hold?.signal;
    const abort = new AbortController();
    const waitStarted = Date.now();
    const noDialog = new Promise<"no_dialog">((done) => {
      void dialogs.askOk(caption, abort.signal).then((answer) => {
        if (answer === "unavailable") done("no_dialog");
        else if (answer !== "aborted") this.confirmations.answer(check.request.id, answer === "allow", "chat");
      });
    });
    const onCancel = (): void => this.confirmations.withdraw(check.request.id);
    cancelled?.addEventListener("abort", onCancel, { once: true });
    const settled = await Promise.race([this.confirmations.wait(check.request.id), noDialog]);
    cancelled?.removeEventListener("abort", onCancel);
    abort.abort();
    if (hold !== undefined) hold.ms += Date.now() - waitStarted;
    if (settled === "no_dialog") return refuse(this.liveViewLine());
    if (cancelled?.aborted === true) return refuse("The call was cancelled before anyone answered.");
    if (settled.expired) return refuse("Nobody answered. Ask your user, or repeat the call to ask again.");
    if (!settled.allow) {
      this.options.audit?.write({ kind: "approval", app: session.app.id ?? session.app.name, name: "card", detail: "declined" });
      return refuse("They declined. Ask your user what to do.");
    }
    const used = this.confirmations.check(key, ask);
    if (!used.granted) return fail(CHANGED_WHILE_WAITING);
    this.approved(session, "card", used.via);
    return null;
  }

  /** The backstop at the writers of files (§20.3): content values lose any vault value; keys and `${…}` stay. */
  private backstop<T>(value: T): T {
    return redactContent(value, (text) => this.scrubSecrets(text)) as T;
  }

  /** A vault value or a one-time code typed in this session becomes its placeholder. */
  private scrubSecrets(text: string, typed?: TypedSource | null): string {
    const store = this.options.accounts?.store;
    return redactAll(store, this.otp.codes, text, typed);
  }

  /** The batch's account: the default for its steps' `${account.…}` while `run` runs. */
  private runAccount: string | undefined;

  /**
   * What a `type_text` types when its text is a test account's value (AGENT-TOOLS 1.13 §18.6): null when it isn't one,
   * else the value with the kind of field it may go into, or why not. The words carry no `Error code:` start, so `run`
   * can say which step.
   *
   * Hook for `drive` (task 15): its `account` argument goes through here too, as `named`, for the steps it types.
   */
  private accountText(
    text: string,
    named: string | undefined,
    session: SessionInfo | undefined,
  ): { ok: true; value: string; kind: "secure" | "plain" | undefined; use: VaultUse | undefined } | { ok: false; code: string; message: string } | null {
    const mentions = mentionsVault(text);
    if (!mentions && named === undefined) return null;
    // `${otp.<app>}` is typed by `typeText` itself and needs no vault file (§20.4); `run` checks its app separately.
    if (text.includes("${otp.")) {
      if (otpReference(text) !== null && named === undefined) return null;
      return { ok: false, code: "bad_params", message: otpReference(text) !== null ? "a one-time code takes no account; write ${otp.<app>} alone." : "a one-time code is the whole text of a step, not part of one." };
    }
    const loaded = this.options.accounts;
    if (loaded === undefined) return { ok: false, code: "bad_params", message: "no accounts are loaded; start Tapline with --accounts FILE." };
    if (loaded.store === null) return { ok: false, code: "bad_params", message: loaded.blocked };
    if (!mentions) {
      return { ok: false, code: "bad_params", message: `account "${named ?? ""}" is named but the text has no \${account.username} or \${account.password}; the text is the whole value.` };
    }
    // Without an app there is nothing to type into: the call answers `not_connected` before anything is sent.
    if (session === undefined) return null;
    const substituted = substituteAccount(text, loaded.store, named ?? this.runAccount, session.app.id ?? session.app.name);
    if (!substituted.ok) return substituted;
    if (substituted.field === null) return null;
    const fixture = substituted.use?.kind === "fixture";
    // An older app ignores the kind and would type a password into any field.
    if ((substituted.field === "password" || substituted.field === "username" || fixture) && !session.capabilities.includes("typeKind")) {
      return { ok: false, code: "unsupported", message: "this app's Tapline is too old to type an account's value safely; update react-native-tapline." };
    }
    // Only a password and a username are held to a kind of field (§18.6); the rest of the vault goes where the app lets it.
    const field = substituted.field;
    // A fixture goes only into a plain text field, never a password field (§20.1, v1.16).
    return { ok: true, value: substituted.text, kind: field === "password" ? "secure" : field === "username" || fixture ? "plain" : undefined, use: substituted.use ?? { name: named ?? this.runAccount ?? "", kind: "account", field } };
  }

  scroll(args: Shape<"scroll">): Promise<CallToolResult> {
    if (args.to !== undefined && (args.direction !== undefined || args.amount !== undefined)) {
      return Promise.resolve(fail("Error bad_params: use either `to` or `direction`/`amount`, not both."));
    }
    const hiddenScroll = this.hiddenTarget(args.target);
    if (hiddenScroll !== null) return Promise.resolve(hiddenScroll);
    const toTarget = args.to === "target";
    if (toTarget && this.userEyes()) return Promise.resolve(fail(TaplineTools.SCROLL_TO_TARGET_OFF));
    if (toTarget && args.target === undefined) {
      return Promise.resolve(fail('Error bad_params: to: "target" needs a target: the element to bring onto the screen.'));
    }
    const params: Record<string, unknown> =
      args.to !== undefined ? { to: args.to } : { direction: args.direction ?? "down", fraction: args.amount ?? 0.8 };
    if (args.target !== undefined) params["target"] = toWireTarget(args.target);
    const flag = (r: unknown, key: string): unknown =>
      typeof r === "object" && r !== null && key in r ? (r as Record<string, unknown>)[key] : undefined;
    // The element was on screen and clear already: nothing was scrolled, and the first line says so.
    const alreadyThere = (r: unknown): boolean => toTarget && flag(r, "unchanged") === true;
    if (args.dry_run === true) {
      return this.dryCall("scroll", params, (r) => {
        if (toTarget) return `Would scroll ${this.elementName(r)} to ${this.elementName(r, "target")}.`;
        return `Would scroll ${this.elementName(r)} ${args.to !== undefined ? `to ${args.to}` : (args.direction ?? "down")}.`;
      });
    }
    const atEndAlready = (r: unknown): boolean => (args.to === "start" || args.to === "end") && flag(r, "moved") === false;
    return this.act(
      "scroll",
      params,
      (r) => {
        if (alreadyThere(r)) return `${this.elementName(r, "target")} is already on screen.`;
        // to: "start" or "end" with the list already there (AGENT-TOOLS v1.6 §5, shared with Tapwright).
        if (atEndAlready(r)) return `${this.elementName(r)} is already at its ${String(args.to)}.`;
        const offset = flag(r, "offset");
        const at = offset !== undefined ? ` Offset now ${JSON.stringify(offset)}.` : "";
        // "toward" when it stopped before the element was clear: the first line mustn't read like success.
        if (toTarget) return `Scrolled ${this.elementName(r)} ${flag(r, "reached") === false ? "toward" : "to"} ${this.elementName(r, "target")}.${at}`;
        return `Scrolled ${this.elementName(r)} ${args.to !== undefined ? `to ${args.to}` : (args.direction ?? "down")}.${at}`;
      },
      args.look,
      args.screenshot,
      (r) => {
        if (toTarget) {
          // The same sentence as Tapwright's, for a list that ends with the element still under a bar or off screen.
          return flag(r, "reached") === false
            ? ["Note: it doesn't scroll further: the target is as far into view as it gets."]
            : [];
        }
        const moved = flag(r, "moved");
        if (moved !== false || atEndAlready(r)) return [];
        const direction = args.to !== undefined ? (args.to === "start" ? "up" : "down") : (args.direction ?? "down");
        if (direction === "up") {
          return [
            "Note: the scroll view is already at the top (as far as Tapline can scroll it; a person's swipe can reach a little further when the system adds an inset).",
          ];
        }
        if (direction === "left") return ["Note: the scroll view is already at the start."];
        return ["Note: the scroll view is already at the end."];
      },
      undefined,
      undefined,
      args.brief,
    );
  }

  toggle(args: Shape<"toggle">): Promise<CallToolResult> {
    const hiddenSwitch = this.hiddenTarget(args.target);
    if (hiddenSwitch !== null) return Promise.resolve(hiddenSwitch);
    const params: Record<string, unknown> = { target: toWireTarget(withIndex(args.target, args.index)), ...(this.userEyes() ? { noScroll: true } : {}) };
    if (args.value !== undefined) params["value"] = args.value;
    if (args.force === true) params["force"] = true;
    // The switch already had the asked value: the app touched nothing, and that line is the whole answer.
    const unchanged = (r: unknown): boolean => typeof r === "object" && r !== null && "unchanged" in r && r.unchanged === true;
    return this.guarded("toggle", "toggle", params, args.dry_run === true, (preflight) =>
      this.act(
        "toggle",
        params,
        (r) => {
          const value = typeof r === "object" && r !== null && "value" in r ? (r as { value: unknown }).value : undefined;
          if (unchanged(r)) return `${scrolledFirst(r) ? "Scrolled to it; " : ""}${this.elementName(r)} is already ${JSON.stringify(value)}.`;
          return afterScroll(r, `Toggled ${this.elementName(r)}${value !== undefined ? ` to ${JSON.stringify(value)}` : ""}.`);
        },
        args.look,
        args.screenshot,
        undefined,
        unchanged,
        preflight,
        args.brief,
      ),
    );
  }

  async appCommand(args: Shape<"app_command">): Promise<CallToolResult> {
    if (args.name === undefined || args.name.trim() === "") {
      const session = this.host.current();
      if (session === undefined) return this.notConnected();
      let raw: unknown;
      try {
        raw = await this.sendRequest("commands", {}, { sessionId: session.id });
      } catch (error) {
        return fail(describeError(error));
      }
      const parsed = commandsSchema.safeParse(raw);
      if (!parsed.success) return fail("Error internal: the app returned a command list the host could not read.");
      const lines = parsed.data.commands.map((c) => `${c.name}: ${c.description}`);
      return text(
        lines.length > 0
          ? [`${session.app.name} offers ${lines.length} command${lines.length === 1 ? "" : "s"}:`, ...lines].join("\n")
          : `${session.app.name} offers no commands.`,
      );
    }
    const name = args.name.trim();
    if (name === "animations") {
      const refused = this.animationsRefusal(args.args);
      if (refused !== null) return fail(refused);
    }
    const shortcut = name === "animations" ? null : this.shortcutRefusal("app_command", name);
    if (shortcut !== null) return shortcut;
    const blocked = name === "network" ? this.networkRefusal((args.args as { mode?: unknown } | undefined)?.mode) : null;
    if (blocked !== null) return blocked;
    const sessionId = this.host.current()?.id;
    // A measurement holds animations at normal: an explicit switch to fast waits for it to end.
    if (name === "animations" && sessionId !== undefined && (args.args as { speed?: unknown } | undefined)?.speed === "fast") await afterPause(this.host, sessionId);
    const answer = await this.act(
      "command",
      { name, args: args.args ?? {} },
      (r) => {
        const result = typeof r === "object" && r !== null && "result" in r ? (r as { result: unknown }).result : null;
        // Built in `network`: the same line every header carries while a condition is on (AGENT-TOOLS §16.4),
        // then one sentence on what it reaches.
        if (name === "network" && typeof result === "object" && result !== null && "mode" in result && typeof result.mode === "string") {
          const covers = "covers" in result && typeof result.covers === "string" ? ` ${result.covers}` : "";
          return `${networkLine(result.mode)}${covers}`;
        }
        // Standard `language`, `region` and `text_size` (AGENT-TOOLS §16.3): the app's own sentence, e.g. `Text size xl (1.12×).`
        if (typeof result === "object" && result !== null && "say" in result && typeof result.say === "string") return result.say;
        return result === null || result === undefined ? `Ran ${name}.` : `Ran ${name}: ${JSON.stringify(result)}`;
      },
      args.look,
      args.screenshot,
      undefined,
      undefined,
      undefined,
      args.brief,
    );
    // What the app says it is now: the host remembers it, to pause it for a measurement and to end it with the session.
    const speed = (args.args as { speed?: unknown } | undefined)?.speed;
    if (name === "animations" && answer.isError !== true && sessionId !== undefined && (speed === "fast" || speed === "normal")) {
      noteAnimations(this.host, sessionId, speed);
    }
    return answer;
  }

  /** AGENT-TOOLS 1.11 §16.4: a policy whose block list holds `network` refuses a condition; `normal` always goes. */
  private networkRefusal(mode: unknown, app: SessionInfo["app"] | undefined = this.host.current()?.app): CallToolResult | null {
    const names = (words: string[] | undefined): boolean => (words ?? []).some((word) => word.trim().toLowerCase() === "network");
    const own = app === undefined ? undefined : (this.policy.apps?.[app.id ?? ""] ?? this.policy.apps?.[app.name]);
    if (mode !== "normal" && names(listsFor(this.policy, app).block)) {
      const where = own?.block !== undefined && app !== undefined ? `for ${app.name}` : "here";
      return fail(`Error not_allowed: blocked: the safety policy blocks network ${where}.`);
    }
    return null;
  }

  waitFor(args: Shape<"wait_for">): Promise<CallToolResult> {
    const hiddenWait = this.hiddenTarget(args);
    if (hiddenWait !== null) return Promise.resolve(hiddenWait);
    // In a user's eyes it matches what is on the glass only (§17.1).
    const params: Record<string, unknown> = this.userEyes() ? { glass: true } : {};
    if (args.text !== undefined) params["text"] = args.text;
    if (args.id !== undefined) params["testID"] = args.id;
    if (args.label !== undefined) params["label"] = args.label;
    if (args.gone !== undefined) params["gone"] = args.gone;
    if (args.network_idle !== undefined) params["networkIdle"] = args.network_idle;
    if (args.timeout !== undefined) params["timeout"] = args.timeout;
    return this.act(
      "waitFor",
      params,
      (r) => {
        const ms = typeof r === "object" && r !== null && "waitedMs" in r ? (r as { waitedMs: unknown }).waitedMs : undefined;
        return typeof ms === "number" ? `Done after ${(Math.round(ms / 100) / 10).toFixed(1)} s.` : "Done.";
      },
      args.look,
      args.screenshot,
      undefined,
      undefined,
      undefined,
      args.brief,
    );
  }

  /** A drag through React Native's touch system (AGENT-TOOLS 5.2): what a pan view or a swipe-to-close sheet handles. */
  swipe(args: Shape<"swipe">): Promise<CallToolResult> {
    const params: Record<string, unknown> = { x0: args.x0, y0: args.y0, x1: args.x1, y1: args.y1 };
    if (args.seconds !== undefined) params["seconds"] = args.seconds;
    if (args.dry_run === true) {
      return this.dryCall("swipe", params, (r) => {
        const on = this.elementName(r);
        return `Would swipe from (${args.x0}, ${args.y0}) to (${args.x1}, ${args.y1})${on === "element" ? "" : ` starting on ${on}`}.`;
      });
    }
    // A swipe that moves less than 10 pt is a touch where it starts: the policy checks it (AGENT-TOOLS 1.8 §11.1).
    const short = Math.hypot(args.x1 - args.x0, args.y1 - args.y0) < 10;
    const perform = (preflight?: () => Promise<CallToolResult | null>): Promise<CallToolResult> => this.act(
      "swipe",
      params,
      (r) => {
        const on = this.elementName(r);
        return `Swiped from (${args.x0}, ${args.y0}) to (${args.x1}, ${args.y1})${on === "element" ? "" : ` on ${on}`}.`;
      },
      args.look,
      args.screenshot,
      undefined,
      undefined,
      preflight,
      args.brief,
    );
    return short ? this.guarded("swipe", "swipe", params, false, perform) : perform();
  }

  back(args: Shape<"back">): Promise<CallToolResult> {
    if (args.dry_run === true) {
      return this.dryCall("back", {}, (r) => {
        if (typeof r === "object" && r !== null && "closed" in r && r.closed === "sheet") return "Would close the sheet.";
        const route = typeof r === "object" && r !== null && "route" in r ? (r as { route: unknown }).route : undefined;
        const from = Array.isArray(route) && route.every((name) => typeof name === "string") ? ` from ${route.join(" › ")}` : "";
        return `Would go back${from}.`;
      });
    }
    return this.act(
      "back",
      {},
      (r) => {
        if (typeof r === "object" && r !== null && "closed" in r && r.closed === "sheet") return "Closed the sheet.";
        const route = typeof r === "object" && r !== null && "route" in r ? (r as { route: unknown }).route : undefined;
        const from = Array.isArray(route) && route.every((name) => typeof name === "string") ? ` from ${route.join(" › ")}` : "";
        return `Went back${from}.`;
      },
      args.look,
      args.screenshot,
      undefined,
      undefined,
      undefined,
      args.brief,
    );
  }

  async openUrl(args: Shape<"open_url">): Promise<CallToolResult> {
    const refused = this.shortcutRefusal("open_url", args.url);
    if (refused !== null) return refused;
    const answer = await this.act("openURL", { url: args.url }, () => `Opened ${args.url}.`, args.look, args.screenshot, undefined, undefined, undefined, args.brief);
    // The app's own forget link unpairs it, so it drops the connection before answering: that is the link working.
    if (answer.isError === true && /(^|\/)tapline\/forget\/?$/.test(args.url.replace(/[?#].*$/, ""))) {
      const said = answer.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      if (/^Error (reconnecting|not_connected)\b/.test(said)) {
        return text("Unpaired: the app forgot this computer and disconnected. To connect it again, call `pair`.");
      }
    }
    return answer;
  }

  async logs(args: Shape<"logs">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    let entries: LogEntry[] = this.host.logs(session.id, args.since);
    if (entries.length === 0) {
      // Nothing streamed to the host yet; ask the app for the lines it buffered before we connected.
      try {
        const raw = await this.sendRequest("logs", args.since !== undefined ? { since: args.since } : {}, { sessionId: session.id });
        const list = typeof raw === "object" && raw !== null && "entries" in raw ? (raw as { entries: unknown }).entries : [];
        entries = z.array(logEntrySchema).catch([]).parse(list);
      } catch {
        // fall through with an empty list
      }
    }
    const newest = entries.reduce<number | undefined>((max, e) => (e.ts !== undefined && (max === undefined || e.ts > max) ? e.ts : max), undefined);
    const query = { since: args.since, level: args.level, grep: args.grep, limit: args.limit };
    return text(formatLogAnswer(filterLogs(entries, query), query, newest ?? args.since ?? 0));
  }

  /** The newest fatal JS error of the app (`all`: the last 5). Reading them tells the agent what the notes did. */
  crash(args: Shape<"crash"> = {}): CallToolResult {
    // The app being driven, else the one that stopped last. Never every app's crashes at once.
    const known: AppIdentity | undefined = this.host.current() ?? this.host.lastCrashEvent()?.of;
    if (known === undefined) return text(NO_CRASH_TEXT);
    // Reading them tells the agent what the notes of this app said; other apps' stay pending.
    this.notedCrashSeqs.set(identityOf(known), this.host.crashMark());
    const crashes = this.host.crashes(known);
    if (crashes.length === 0) return text(NO_CRASH_TEXT);
    return text(crashes.slice(0, args.all === true ? 5 : 1).map(formatCrash).join("\n\n"));
  }

  async reload(args: Shape<"reload">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    try {
      try {
        // The app goes away on purpose: that is no crash.
        this.host.expectEnd(session.id);
        await this.sendRequest("reload", {}, { sessionId: session.id, timeoutMs: 5000 });
      } catch (error) {
        // The app dies mid-reload, so a dropped connection or a missing answer means it worked.
        const worked = error instanceof TaplineError && (error.code === "reconnecting" || error.code === "timeout" || error.code === "not_answering");
        if (!worked) return fail(describeError(error));
      }
      if (args.look === false) {
        this.markListUnseen();
        return text("Reload requested.");
      }
      const deadline = Date.now() + this.reloadWaitMs;
      for (;;) {
        const now = this.host.current();
        if (now !== undefined && now.id !== session.id) break;
        if (Date.now() > deadline) return text("Reload requested, but the app has not reconnected yet. Try look in a few seconds.");
        await sleep(100);
      }
    } finally {
      // Whatever happened, the wait is over: a reload that "worked" without the app going away must not
      // leave a later, real crash of this session explained.
      this.host.expectEnd(session.id, false);
    }
    await sleep(this.reloadSettleMs);
    return this.withLook(this.host.current() ?? session, "Reloaded; the app reconnected.");
  }

  // -- performance (AGENT-TOOLS §15.3)

  /**
   * `launch`: a JavaScript reload (development builds), timed from the request to the new session's first
   * settled screen. Stops with the answer when the reload can't be made or the app doesn't come back.
   */
  private async timedReload(session: SessionInfo): Promise<{ stop: CallToolResult } | { session: SessionInfo; seconds: number }> {
    const started = Date.now();
    let fresh: SessionInfo | undefined;
    try {
      try {
        // The app goes away on purpose: that is no crash.
        this.host.expectEnd(session.id);
        await this.sendRequest("reload", {}, { sessionId: session.id, timeoutMs: 5000 });
      } catch (error) {
        // The app dies mid-reload, so a dropped connection or a missing answer means it worked.
        const worked = error instanceof TaplineError && (error.code === "reconnecting" || error.code === "timeout" || error.code === "not_answering");
        if (!worked) {
          if (error instanceof TaplineError && error.code === "unsupported") {
            return { stop: fail(`Error unsupported: launch is a JavaScript reload, and only development builds can do one (${error.message}).`) };
          }
          return { stop: fail(describeError(error)) };
        }
      }
      const deadline = Date.now() + this.reloadWaitMs;
      // Only the same app on the same phone, back as a new session, counts: another connected app that became
      // current meanwhile is never measured as the reload (Codex review of 1.3.0).
      const same = identityOf(session);
      while (fresh === undefined) {
        const back = this.host.sessions().find((s) => s.id !== session.id && identityOf(s) === same);
        if (back !== undefined) {
          fresh = back;
          // and the agent goes on driving it, not whichever app the host picked when the old session dropped
          if (this.host.current()?.id !== back.id) this.host.select(back.id);
        } else if (Date.now() > deadline) {
          return { stop: fail(`Error timeout: the app hadn't reconnected ${Number((this.reloadWaitMs / 1000).toFixed(1))} s after the reload; try look in a few seconds.`) };
        } else await sleep(100);
      }
    } finally {
      // The wait is over, whatever happened: a reload that "worked" without the app going away must not leave
      // a later crash of this session explained away.
      this.host.expectEnd(session.id, false);
    }
    // The first settled screen: the app waits until React hasn't committed for a moment (§6).
    // The first settled screen: a launch time is only reported when the app said it settled.
    try {
      await this.sendRequest("perfSettle", {}, { sessionId: fresh.id, timeoutMs: 8000 });
    } catch (error) {
      return { stop: fail(describeError(error)) };
    }
    return { session: fresh, seconds: (Date.now() - started) / 1000 };
  }

  /** One measuring window in the app: start, (the tap,) wait out `seconds`, stop. */
  private async measureWindow(session: SessionInfo, seconds: number, press?: Record<string, unknown>, delivery?: { sent: boolean }): Promise<PerfResult> {
    const id = { sessionId: session.id };
    // The window's number: the stop names it, so a call never takes another call's numbers (an older SDK has none).
    let stopParams: Record<string, unknown> = {};
    try {
      const started = await this.sendRequest("perfStart", {}, id);
      const windowId = typeof started === "object" && started !== null ? (started as { id?: unknown }).id : undefined;
      if (typeof windowId === "number") stopParams = { id: windowId };
    } catch (error) {
      if (error instanceof TaplineError && error.code === "unsupported") {
        throw new TaplineError("unsupported", "this app's Tapline is too old for performance; update react-native-tapline.");
      }
      throw error;
    }
    const started = Date.now();
    try {
      // The caller holds the live view's queue for the whole window when there is a tap (see performance).
      if (press !== undefined) {
        if (delivery !== undefined) delivery.sent = true;
        try {
          await this.sendRequest("press", press, id);
        } catch (error) {
          if (delivery !== undefined && notDelivered(error)) delivery.sent = false;
          throw error;
        }
      }
      const rest = seconds * 1000 - (Date.now() - started);
      if (rest > 0) await sleep(rest);
    } catch (error) {
      await this.sendRequest("perfStop", stopParams, id).catch(() => undefined);
      throw error;
    }
    const parsed = perfResultSchema.safeParse(await this.sendRequest("perfStop", stopParams, id));
    if (!parsed.success) throw new TaplineError("internal", "the app returned performance numbers the host could not read.");
    return parsed.data;
  }

  async performance(args: Shape<"performance"> = {}): Promise<CallToolResult> {
    this.lastPerf = undefined;
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    if (args.launch === true && args.tap !== undefined) {
      return fail("Error bad_params: launch reloads the app and tap taps in it; give one of them.");
    }
    const hiddenPerf = this.hiddenTarget(args.tap);
    if (hiddenPerf !== null) return hiddenPerf;
    const seconds = args.seconds ?? 3;
    try {
      let measure: PerfMeasure;
      if (args.launch === true) {
        const launched = await this.timedReload(session);
        if ("stop" in launched) return launched.stop;
        measure = { result: await this.measureWindow(launched.session, seconds), launchS: launched.seconds };
      } else {
        let press: Record<string, unknown> | undefined;
        if (args.tap !== undefined) {
          // The tap is a touch like any other: the safety policy decides first (as for filmstrip).
          press = { target: toWireTarget(args.tap), ...(this.userEyes() ? { noScroll: true } : {}) };
          const stale = this.staleRef(press);
          if (stale !== null) return stale;
        }
        let ready: { waited: Waited | null } = { waited: null };
        if (press !== undefined) {
          const waitedFor = await this.awaitOk(session, "tap", "press", press, this.touchLists(session));
          if ("stop" in waitedFor) return waitedFor.stop;
          ready = waitedFor;
        }
        // With a tap, the policy check and the whole window are one turn of the live view's queue: a pause refuses
        // it, a person's input goes first and waits for the window, and the screen can't change between the check
        // and the tap (Codex and CodeRabbit reviews of 1.3.0).
        const tapped = press;
        const window = async (): Promise<{ stop: CallToolResult } | { result: PerfResult }> => {
          if (tapped !== undefined) {
            const gate = await this.policyGate(session, "tap", "press", tapped, this.touchLists(session), ready.waited);
            if ("stop" in gate) return { stop: gate.stop };
            const delivery = { sent: false };
            try {
              const result = await this.measureWindow(session, seconds, tapped, delivery);
              if (gate.grant !== undefined) this.grantNotes.getStore()?.push(gate.grant.line);
              return { result };
            } catch (error) {
              if (gate.grant !== undefined && !delivery.sent) await this.releaseGrant(gate.grant);
              throw error;
            }
          }
          return { result: await this.measureWindow(session, seconds, tapped) };
        };
        let outcome: { stop: CallToolResult } | { result: PerfResult };
        try {
          outcome = tapped !== undefined ? await this.agentTurn(window) : await window();
        } finally {
          await this.dropPreUse(ready.waited);
        }
        if ("stop" in outcome) return outcome.stop;
        measure = { result: outcome.result };
      }
      this.lastPerf = measure;
      if (this.recording !== null && !this.replaying) {
        this.recording.steps.push({
          method: "performance",
          params: {
            ...(args.launch === true ? { launch: true } : {}),
            ...(args.seconds !== undefined ? { seconds: args.seconds } : {}),
            ...(args.tap !== undefined ? { tap: args.tap } : {}),
          },
        });
      }
      const tapWords = args.tap === undefined ? undefined : targetWords(args.tap);
      return text([perfFirstLine(measure, tapWords), ...formatPerfLines(measure.result), ...this.takePersonNote()].join("\n"));
    } catch (error) {
      return fail(describeError(error));
    }
  }

  // -- journey (AGENT-TOOLS 1.12 §17.1)

  async journey(args: Shape<"journey"> = {}): Promise<CallToolResult> {
    if (args.start === true && args.stop === true) return fail("Error bad_params: give start or stop, not both.");
    if (args.start === true) return this.journeyStart(args);
    const startOnly = ["goal", "persona", "conditions", "allow"].filter((key) => (args as Record<string, unknown>)[key] !== undefined);
    if (startOnly.length > 0) return fail(`Error bad_params: ${startOnly.join(", ")} go with start: true.`);
    if (args.stop === true) return this.journeyStop(args);
    const stopOnly = ["reached", "why", "export"].filter((key) => (args as Record<string, unknown>)[key] !== undefined);
    if (stopOnly.length > 0) return fail(`Error bad_params: ${stopOnly.join(", ")} go with stop: true.`);
    const running = this.journeyRun;
    if (args.stress !== undefined || args.survives !== undefined || args.done !== undefined) {
      if (running === undefined) return fail(NO_JOURNEY);
      return this.journeyStress(running, args);
    }
    if (args.eyes !== undefined) {
      if (running === undefined) return fail(NO_JOURNEY);
      if (args.eyes === "user") {
        return running.userEyes
          ? text("Already in a user's eyes.")
          : fail("Error bad_params: eyes: \"agent\" can't be turned back to a user's during a journey; start a new one.");
      }
      if (!running.userEyes) return text("Already in the agent's eyes.");
      running.switchEyes();
      // The next list is a full one: what the agent can see just changed.
      const session = this.host.current();
      if (session !== undefined) this.listed.delete(session.id);
      return text("Eyes: the agent's from now on (ids, labels, everything in the tree; jumps and shortcuts allowed). The report says so.");
    }
    if (running !== undefined) {
      const m = running.state.measures;
      return text(
        `Journey running: ${JSON.stringify(running.state.goal)}, ${running.userEyes ? "in a user's eyes" : "in the agent's eyes"}; ${m.taps} taps, ${m.screensEntered} screens so far.`,
      );
    }
    return fail("Error bad_params: give start: true with a goal, or stop: true with reached.");
  }

  private async journeyStart(args: Shape<"journey">): Promise<CallToolResult> {
    const exclusive = this.exploreExcludes("a journey");
    if (exclusive !== null) return fail(exclusive);
    const running = this.journeyRun;
    if (running !== undefined) {
      return fail(`Error bad_params: a journey is already running (${JSON.stringify(running.state.goal)}); stop it first with stop: true and reached.`);
    }
    if (this.journeyBusy !== undefined) {
      return fail(`Error busy: a journey is still ${this.journeyBusy === "starting" ? "starting" : "stopping"}; try again in a moment.`);
    }
    const goal = args.goal?.trim() ?? "";
    if (goal === "") return fail("Error bad_params: start needs a goal: what the user wants to do.");
    if (args.reached !== undefined || args.why !== undefined || args.export !== undefined) {
      return fail("Error bad_params: reached, why and export go with stop: true.");
    }
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    // Taken before the first await: a second start (or one during a stop's clean-up) can't overlap this one.
    this.journeyBusy = "starting";
    try {
      return await this.journeyStarted(args, goal, session);
    } finally {
      // Only the start releases its own hold (a stop never takes it over: it answers busy while this runs).
      if (this.journeyBusy === "starting") this.journeyBusy = undefined;
      if (this.journeyRun === undefined) this.journeyApp = undefined;
    }
  }

  private async journeyStarted(args: Shape<"journey">, goal: string, session: SessionInfo): Promise<CallToolResult> {
    this.journeyApp = { identity: identityOf(session), name: session.app.name };
    const journey = new Journey(
      {
        goal,
        ...(args.persona !== undefined && args.persona.trim() !== "" ? { persona: args.persona.trim() } : {}),
        ...(args.conditions !== undefined ? { conditions: args.conditions } : {}),
        ...(args.allow !== undefined ? { allow: args.allow } : {}),
        ...(args.eyes !== undefined ? { eyes: args.eyes } : {}),
      },
      this.clock,
    );
    const notes: string[] = [];
    const conditions: Conditions = args.conditions ?? {};
    // Network first: the others then run under it. Each goes through the app's own commands (AGENT-TOOLS §16).
    const order = ["network", "language", "region", "text_size"] as const;
    for (const name of order) {
      const value = conditions[name];
      if (value === undefined) continue;
      const record = await this.applyCondition(session, name, value);
      journey.state.conditionRecords.push(record);
      if (!record.applied) notes.push(`Note: condition ${name} ${value} was not applied: ${record.failure ?? "the app refused"}.`);
    }
    // A user waits for animations: fast ones end here unless the journey's allow keeps them (PLAN-1.6 F4, E8).
    if (journey.userEyes && !journey.allows(FAST_ANIMATIONS_ALLOWED) && (await endAnimations(this.host, session.id, this.leased))) {
      notes.push("Note: animations were turned off for this journey: a user waits for them. allow fast_animations keeps them on.");
    }
    this.journeyRun = journey;
    this.journeyDone = undefined;
    this.stressWaiting.clear();
    // The naming memory of an earlier journey (or a hook someone left) is not this journey's.
    this.uxJourney = null;
    this.journeyHook = undefined;
    this.startRecorder(journey, session, notes);
    const live = this.host.current();
    const persona = journey.state.persona ?? "no persona";
    const eyesWords = journey.userEyes ? "in a user's eyes" : "in the agent's eyes";
    const first = `Journey started: "${goal}" as ${persona}, ${eyesWords}.`;
    const applied = journey.state.conditionRecords.filter((r) => r.applied).map((r) => `${r.name.replace("_", " ")} ${r.value}`);
    const head = [first, ...(applied.length > 0 ? [`Conditions: ${applied.join(", ")}.`] : []), ...notes];
    if (live === undefined) {
      return text([...head, "Note: the app is reconnecting, so there's no screen yet; look in a few seconds."].join("\n"));
    }
    const parts = await this.lookParts(live, false, DEFAULT_SCREENSHOT_WIDTH, false);
    const [top, ...rest] = parts.content;
    const list = top !== undefined && top.type === "text" ? top.text : "";
    // The screen the journey starts on is the GIF's first frame.
    await this.recorder?.frame(0, journey.state.currentScreen, undefined, false);
    return this.shownToUser({ content: [{ type: "text", text: [...head, list].join("\n") }, ...rest], ...(parts.isError ? { isError: true } : {}) });
  }

  /** Opens the report folder for a journey that has somewhere to keep one, and hands `ux_check` the hook that feeds it. */
  private startRecorder(journey: Journey, first: SessionInfo, notes: string[]): void {
    const root = this.options.journeysDir;
    if (root === undefined) return;
    try {
      mkdirSync(root, { recursive: true });
      // The newest reports stay; older folders go, so a long-lived host doesn't fill the disk (1.5 review, finding 6).
      pruneJourneys(root, JOURNEYS_KEPT - 1);
      // Frames and naming memory belong to the journey's own app, and only while it is connected and in front.
      const app = identityOf(first);
      const recorder = new JourneyRecorder(freshFolder(root, journey.state.goal, this.clock()), this.frameSource(app), this.clock);
      this.recorder = recorder;
      const mine = (): boolean => {
        const now = this.host.current();
        return now !== undefined && identityOf(now) === app;
      };
      const hook: UxJourneyHook = {
        earlier: () => (mine() ? recorder.earlier(journey.state.currentScreen) : null),
        seen: (title, actions, findings) => {
          if (mine()) void recorder.uxSeen(journey.state.currentScreen, title, actions, findings);
        },
      };
      this.journeyHook = hook;
      this.uxJourney = hook;
      // Only this journey's app: another connected app using its armed pictures is not this journey's skip.
      this.pickerOff = this.mediaState.onPickerSkipped((appId, count) => {
        if (this.pickerFrom !== undefined ? this.pickerFrom !== app : appId !== first.app.id) return;
        recorder.pickerSkips++;
        recorder.pickerPictures += count;
      });
    } catch (error) {
      notes.push(`Note: no report will be written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The recorder's eyes: a read that touches nothing, and a small picture. */
  private frameSource(app: string): FrameSource {
    // Rechecked before each request: the journey's own app or nothing, whatever `open_app` chose meanwhile.
    const bound = (): SessionInfo | undefined => {
      const session = this.journeyApp === undefined ? undefined : this.journeySession();
      return session !== undefined && identityOf(session) === app ? session : undefined;
    };
    return {
      where: () => {
        const now = this.host.current();
        if (now === undefined) return "disconnected";
        if (identityOf(now) !== app) return "other";
        const state = now.appState?.state;
        return state === "background" || state === "inactive" ? "background" : "front";
      },
      peek: async () => {
        const session = bound();
        if (session === undefined) return undefined;
        const tree = treeResultSchema.safeParse(await this.sendRequest("tree", { peek: true }, { sessionId: session.id }).catch(() => null));
        if (!tree.success) return undefined;
        const t = tree.data;
        return {
          signature: screenSignature(t.elements, t.route?.names ?? [], (t.alerts ?? []).length),
          ...(t.screen ? { screen: { w: t.screen.width, h: t.screen.height } } : {}),
          route: t.route?.names ?? [],
        };
      },
      shot: async (width, quality) => {
        const session = bound();
        if (session === undefined || this.noScreenshot.has(session.id)) return undefined;
        // Right after a password was typed iOS may still show its last character: no picture then, from any path (a ux_check's too).
        if (this.secureWindow()) return undefined;
        try {
          // The picture is taken with fast animations paused, as a user would see the screen (PLAN-1.6 F4, E8).
          return (await withNormalAnimations(this.host, session.id, () => this.takeShot(session.id, width, quality), this.leased)).value;
        } catch {
          return undefined;
        }
      },
    };
  }

  private async journeyStop(args: Shape<"journey">): Promise<CallToolResult> {
    // A stop while the start still reads its first screen would let the start's end clear the stop's hold.
    if (this.journeyBusy === "starting") return fail("Error busy: the journey is still starting; stop it in a moment.");
    const running = this.journeyRun;
    if (running === undefined) return fail(NO_JOURNEY);
    if (args.reached === undefined) return fail("Error bad_params: stop needs reached: true or false.");
    // An export writes to the user's GitHub: the agent must say its user asked. Refused before the journey ends, so the call can be made again.
    if (args.export !== undefined && args.export.confirm !== true) {
      return fail("Error bad_params: export writes to your user's GitHub, so it needs confirm: true inside export (only when your user asked for it). The journey is still running.");
    }
    if (this.journeyBusy === "stopping") return fail("Error busy: this journey is already stopping.");
    // Held until the clean-up is done, so a new journey can't start while the old one still changes the app.
    this.journeyBusy = "stopping";
    try {
      // The public-repository check also runs before the journey ends, so a refusal can be answered with public: true on a second stop.
      const run = this.options.exportRunner;
      if (args.export !== undefined && run !== undefined) {
        const refused = await exportRefusal(args.export, run);
        if (refused !== null) return fail(`Error not_allowed: ${refused}. The journey is still running; stop again with the option, or without export.`);
      }
      return await this.journeyStopped(args, running, args.reached);
    } finally {
      if (this.journeyBusy === "stopping") this.journeyBusy = undefined;
    }
  }

  private async journeyStopped(args: Shape<"journey">, running: Journey, reached: boolean): Promise<CallToolResult> {
    const state = running.finish(reached, args.why);
    this.journeyRun = undefined;
    this.journeyDone = state;
    const recorder = this.recorder;
    this.recorder = undefined;
    this.pickerOff?.();
    this.pickerOff = undefined;
    this.uxJourney = null;
    this.journeyHook = undefined;
    this.stressWaiting.clear();
    // From here nothing fails the stop: what goes wrong is a Note line, and the local report stays.
    const failures: string[] = [];
    const attempt = async <T>(what: string, work: () => Promise<T> | T): Promise<T | undefined> => {
      try {
        return await work();
      } catch (error) {
        failures.push(`Note: ${what}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    };
    const lines = [summaryLine(state)];
    const content: CallToolResult["content"] = [];
    try {
      await attempt("conditions could not be undone", () => this.undoConditions(state));
      // A picker stub the journey armed and nobody used goes back, so a person's next pick is their own (finding 5).
      await attempt("the photo picker could not be put back", async () => {
        const live = this.journeySession();
        if (live !== undefined && live.capabilities.includes("media")) await this.sendRequest("media", { op: "disarm" }, { sessionId: live.id });
      });
      const undoLines: string[] = [];
      // A network condition a stress moment turned on mid-flow goes back too (one the journey began with is undone above).
      if (state.networkStress && !state.conditionRecords.some((r) => r.name === "network" && r.applied)) {
        const done = await attempt("the network condition a stress moment set was not undone", async () => {
          const live = this.journeySession();
          return live === undefined ? undefined : this.runCondition(live, "network", "normal");
        });
        undoLines.push(done?.ok === true ? "Undone: network is normal again." : "Note: the network condition a stress moment set was not undone; set it back with app_command network normal.");
      }
      this.journeyApp = undefined;
      const session = this.host.current();
      // The agent's next list is a full one: the journey's lists were of the glass only.
      if (session !== undefined) this.listed.delete(session.id);
      const report =
        recorder === undefined
          ? undefined
          : await attempt("the report could not be written", () =>
              writeReport({
                state,
                rec: recorder,
                maxTaps: this.maxTapsToGoal,
                textRules: this.uxRules.text,
                ...(this.options.gifMaxBytes !== undefined ? { gifMaxBytes: this.options.gifMaxBytes } : {}),
              }),
            );
      if (report !== undefined) lines.push(`${findingsLine(report.counts)} Report: ${report.folder}`);
      lines.push(...summaryNotes(state), ...undoLines, ...(report?.notes ?? []));
      if (report !== undefined) {
        // At most two small key pictures: where the journey ended, and the worst finding's screen.
        if (this.options.screenshots === "file") {
          if (report.keys.length > 0) lines.push(`Pictures: ${report.keys.map((k) => join(report.folder, k)).join(", ")}`);
        } else {
          for (const key of report.keys.slice(0, 2)) {
            const data = await attempt("a key picture could not be read", () => readFileSync(join(report.folder, key)).toString("base64"));
            if (data !== undefined) content.push({ type: "image", data, mimeType: "image/jpeg" });
          }
        }
      }
      const target = args.export;
      if (target !== undefined) {
        if (recorder === undefined) lines.push("Export needs the report folder, which this host isn't set up with; nothing was exported.");
        else if (report === undefined) lines.push("Export skipped: there is no report to export.");
        else {
          const exported = await attempt("the export failed", () => this.exportReport(target, state, report, recorder));
          lines.push(...(exported ?? [`Export failed. The report stays local: ${report.folder}`]));
        }
      }
    } catch (error) {
      failures.push(`Note: the stop did not finish everything: ${error instanceof Error ? error.message : String(error)}`);
    }
    lines.push(...failures);
    if (this.options.onJourneyStop !== undefined) {
      try {
        lines.push(...(await this.options.onJourneyStop(state)));
      } catch (error) {
        lines.push(`Note: the report could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }, ...content] };
  }

  /** `export` of `stop`: the report to GitHub through the user's own gh and git; the report stays local when it fails. */
  private async exportReport(
    target: NonNullable<Shape<"journey">["export"]>,
    state: JourneyState,
    report: Awaited<ReturnType<typeof writeReport>>,
    recorder: JourneyRecorder,
  ): Promise<string[]> {
    const run = this.options.exportRunner;
    if (run === undefined) return [`Export isn't available here (this host has no gh runner); the report stays local: ${report.folder}`];
    const outcome = await exportReport(
      {
        target,
        folder: recorder.folder,
        name: report.name,
        goal: state.goal,
        summary: summaryLine(state),
        findingsLine: findingsLine(report.counts),
        findings: report.findings,
        files: report.exportFiles,
        headline: report.gif !== null ? "journey.gif" : report.firstPicture,
      },
      run,
    );
    return outcome.ok ? outcome.lines : [`Export failed: ${outcome.message}. The report stays local: ${report.folder}`];
  }

  // -- stress moments (AGENT-TOOLS 1.12 §17.4)

  private async journeyStress(running: Journey, args: Shape<"journey">): Promise<CallToolResult> {
    const stress = args.stress;
    if (stress === undefined) return fail("Error bad_params: survives and done go with stress.");
    const kind = stress.kind;
    if (stress.mode !== undefined && kind !== "network") return fail("Error bad_params: mode goes with stress network.");
    if (stress.target !== undefined && kind !== "double_tap") return fail("Error bad_params: target goes with stress double_tap.");
    const survives = args.survives;
    if (args.done === true) {
      const asked = this.stressWaiting.get(kind);
      if (asked === undefined) {
        return fail(`Error bad_params: no ${kind} moment is waiting for a person; ask for it first with journey { stress: { kind: "${kind}" } }.`);
      }
      return this.confirmStress(running, kind, asked, survives);
    }
    if (this.host.current() === undefined) return this.notConnected();
    switch (kind) {
      case "network":
        return this.stressNetwork(running, stress.mode, survives);
      case "double_tap":
        return this.stressDoubleTap(running, stress.target, survives);
      case "relaunch": {
        // A development build reloads; anything else needs a person. Said as what it is.
        const before = this.host.current()?.id;
        const answer = await this.reload({ look: true });
        const said = answer.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
        if (answer.isError === true && /^Error unsupported/.test(said)) return this.waitForPerson(running, kind, "close the app and open it again", survives);
        if (answer.isError === true) return answer;
        await this.reconnected();
        // A reload that timed out leaves the old session: that is no relaunch to record.
        const after = this.host.current();
        if (after === undefined || after.id === before) {
          return fail("Error not_allowed: the app has not come back as a new session after the reload, so the moment can't be counted.");
        }
        return this.stressDone(running, kind, " (reload, not a relaunch)", await this.survivalOf(running, survives));
      }
      case "background":
        return this.waitForPerson(running, kind, "switch to another app and back", survives);
      case "rotate":
        return this.waitForPerson(running, kind, "turn the phone and keep it turned", survives);
    }
  }

  /** `done: true`, or the person's Done in the dialog: counted only when the app shows the moment happened. */
  private async confirmStress(running: Journey, kind: Stress["kind"], asked: StressWaiting, survives: Survives | undefined): Promise<CallToolResult> {
    await this.reconnected();
    // Done is checked, not taken on the agent's word: the app must show that the moment happened.
    // An app that is gone by then is judged by survives (it did not survive), not by what it left behind.
    const unseen = this.host.current() === undefined ? null : await this.stressUnseen(kind, asked);
    if (unseen !== null) return fail(`Error bad_params: ${unseen} Ask the person again, then say done.`);
    this.stressWaiting.delete(kind);
    return this.stressDone(running, kind, "", await this.survivalOf(running, survives ?? asked.survives));
  }

  private async waitForPerson(running: Journey, kind: Stress["kind"], what: string, survives: Survives | undefined): Promise<CallToolResult> {
    const asked: StressWaiting = { survives, askedAt: Date.now(), size: kind === "rotate" ? await this.freshScreenSize() : null };
    this.stressWaiting.set(kind, asked);
    // §11.5: with a dialog the person is told there, and the call waits until the app shows the moment (or they say Done).
    const dialogs = this.dialogs;
    if (dialogs !== undefined && dialogs.available()) {
      const cleared = async (): Promise<boolean> => {
        if ((await this.stressUnseen(kind, asked)) !== null) return false;
        // Left the front is not enough for `background`: the person comes back, so the app can be read again.
        return kind !== "background" || this.host.current()?.appState?.state === "active";
      };
      const outcome = await this.askPerson(dialogs, `Needs a person: ${what}. I'll go on by myself when the app shows it.`, cleared);
      if (outcome === "cleared") return this.confirmStress(running, kind, asked, survives);
      if (outcome === "cant") {
        this.stressWaiting.delete(kind);
        return fail(`Error not_allowed: stress ${kind} needs a person: ${what}. They can't now. Ask your user what to do.`);
      }
    }
    return text(
      [
        `Stress: ${kind} needs a person: ${what}, then say done.`,
        `When they have, call journey { stress: { kind: "${kind}" }, done: true }${survives !== undefined ? " (it checks what you asked to survive then)" : ", with survives to say what must still be there"}.`,
      ].join("\n"),
    );
  }

  /** The screen's size in points from a read that touches nothing; null when the app doesn't answer. */
  private async freshScreenSize(): Promise<{ width: number; height: number } | null> {
    const session = this.host.current();
    if (session === undefined) return null;
    const tree = treeResultSchema.safeParse(await this.sendRequest("tree", { peek: true }, { sessionId: session.id }).catch(() => null));
    const screen = tree.success ? tree.data.screen : null;
    return screen ? { width: screen.width, height: screen.height } : null;
  }

  /**
   * Why a person's stress moment can't be taken as done, or null when the app shows it happened: background left the
   * front (or the link dropped) since it was asked; relaunch connected anew; rotate flipped the screen's size.
   */
  private async stressUnseen(kind: string, asked: StressWaiting): Promise<string | null> {
    const mine = this.journeyApp?.identity ?? "";
    switch (kind) {
      case "background":
        return (this.appLeftAt.get(mine) ?? 0) > asked.askedAt ? null : "The app never left the front since the moment was asked, so it can't be counted.";
      case "relaunch":
        return (this.appConnectedAt.get(mine) ?? 0) > asked.askedAt ? null : "The app hasn't started again since the moment was asked (no new connection), so it can't be counted.";
      case "rotate": {
        const now = await this.freshScreenSize();
        const was = asked.size;
        if (now === null || was === null) return "The screen's size couldn't be read, so the turn can't be confirmed.";
        const flipped = Math.round(now.width) === Math.round(was.height) && Math.round(now.height) === Math.round(was.width) && Math.round(now.width) !== Math.round(now.height);
        return flipped ? null : `The screen is still ${Math.round(now.width)}x${Math.round(now.height)} pt, as when the moment was asked: say done while the phone is turned.`;
      }
      default:
        return null;
    }
  }

  /** Waits for an app after a reload or a person leaving it (a new session comes up), a few seconds at most. */
  private async reconnected(): Promise<void> {
    const deadline = Date.now() + Math.min(this.reloadWaitMs, 8000);
    while (this.host.current() === undefined && Date.now() < deadline) await sleep(100);
    if (this.host.current() !== undefined) await sleep(Math.min(this.reloadSettleMs, 500));
  }

  private async stressNetwork(running: Journey, mode: Stress["mode"], survives: Survives | undefined): Promise<CallToolResult> {
    if (mode === undefined) return fail('Error bad_params: stress network needs mode: "offline", "3g", "lossy" or "normal".');
    // On the journey's own app, the one the stop puts back to normal; never another app selected since.
    const session = this.journeySession();
    if (session === undefined) return fail(`Error not_connected: ${this.journeyAppGone()}.`);
    const done = await this.runCondition(session, "network", mode);
    if (!done.ok) return fail(`Error not_allowed: network ${mode} wasn't applied: ${done.failure}.`);
    running.state.networkStress = mode !== "normal";
    return this.stressDone(running, "network", ` ${mode}`, await this.survivalOf(running, survives));
  }

  /** The same touch twice, 80 ms apart, each through the usual checks and the policy. */
  private async stressDoubleTap(running: Journey, raw: Stress["target"], survives: Survives | undefined): Promise<CallToolResult> {
    const parsed = raw === undefined ? null : targetSchema.safeParse(raw);
    if (parsed === null || !parsed.success) return fail("Error bad_params: stress double_tap needs a target: exactly one of ref, text or x and y.");
    const target = parsed.data;
    // One OK never covers two touches: a target the policy flags (a word that asks a person, or blocks) is refused whole.
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    const lists = this.touchLists(session);
    // Resolved inside the agent's turn, right before the press, as a guarded tap does: a queued person's action can't change
    // what is under the target between the check and the touch.
    const refusal: { answer: CallToolResult | null } = { answer: null };
    const preflight = async (): Promise<CallToolResult | null> => {
      if (lists.confirm.length === 0 && lists.block.length === 0) return null;
      const resolved = await this.resolveForPolicy(session, "press", { target: toWireTarget(target) });
      if (resolved.kind === "error") refusal.answer = fail(resolved.text);
      else {
        const verdict = this.policyWords(lists, resolved);
        if (verdict.kind === "blocked") refusal.answer = fail(this.blockedLine(verdict.element, verdict.word));
        else if (verdict.kind === "confirm") {
          refusal.answer = fail(
            `Error not_allowed: needs_confirmation: double_tap on ${this.shortName(verdict.element, false)} is refused: it needs a person's OK (policy word ${JSON.stringify(verdict.word)}), and one OK never covers two touches. Tap it once instead (a person is asked), or choose another target.`,
          );
        }
      }
      return refusal.answer;
    };
    // Both taps go to the app in one request, in one turn of the agent: the app makes the second DOUBLE_TAP_GAP_MS after
    // the first, so nothing (the control queue, the app's own request queue, a settle) can stretch the gap. The moment is
    // one stress, not two taps of the journey.
    const params = { target: toWireTarget(target), again: DOUBLE_TAP_GAP_MS, ...(this.userEyes() ? { noScroll: true } : {}) };
    let pressed: unknown;
    const answer = await this.act("press", params, (r) => {
      pressed = r;
      return `Tapped ${this.elementName(r)}.`;
    }, false, undefined, undefined, undefined, preflight);
    if (refusal.answer !== null) return refusal.answer;
    const line =(r: CallToolResult): string => (r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n").split("\n")[0] ?? "");
    if (answer.isError === true) {
      return fail(`Stress: double_tap on ${targetWords(target)} didn't happen as asked: ${line(answer)}`);
    }
    const second = pressSecondSchema.safeParse(typeof pressed === "object" && pressed !== null && "second" in pressed ? (pressed as { second: unknown }).second : undefined);
    if (!second.success) {
      return fail(
        `Stress: double_tap on ${targetWords(target)} didn't happen as asked: the app made only the first tap (a double tap in one request needs react-native-tapline 1.5 or later in the app).`,
      );
    }
    const checked = await this.survivalOf(running, survives);
    const done = this.stressDone(running, "double_tap", ` on ${targetWords(target)}`, checked);
    const s = second.data;
    const how = secondTapSentence(s);
    return text(`${line(done)}\n${how}`);
  }

  /** Records the moment and answers it: `Stress: <kind>; it survived: …` or `…; it didn't survive: …`. */
  private stressDone(running: Journey, kind: Stress["kind"], via: string, check: { survived: boolean | null; why: string }): CallToolResult {
    const verdict = check.survived === null ? `; ${check.why}` : check.survived ? `; it survived: ${check.why}` : `; it didn't survive: ${check.why}`;
    const said = `Stress: ${kind}${via}${verdict}`;
    running.state.stress.push({ kind, said, survived: check.survived, afterStep: running.state.steps.length, at: this.clock() });
    return text(said);
  }

  /** Whether what had to survive is still there, from a read that touches nothing. */
  private async survivalOf(running: Journey, survives: Survives | undefined): Promise<{ survived: boolean | null; why: string }> {
    if (survives === undefined || (survives.text === undefined && survives.goal_step === undefined)) {
      return { survived: null, why: "nothing was checked (no survives given)." };
    }
    // The journey's own app, the one the moment happened to; never another app selected since.
    const session = this.journeySession();
    if (session === undefined) return { survived: false, why: "the app isn't connected any more." };
    // What a person sees (AGENT-TOOLS 1.12 §17.4): in a user's eyes the glass only; a label a screen reader hears is no proof.
    const tree = treeResultSchema.safeParse(
      await this.sendRequest("tree", { peek: true, ...(this.userEyes() ? { glass: true } : {}) }, { sessionId: session.id }).catch(() => null),
    );
    if (!tree.success) return { survived: false, why: "the app didn't answer when asked what is on screen." };
    const parts: Array<{ ok: boolean | null; why: string }> = [];
    if (survives.text !== undefined) {
      const wanted = survives.text;
      const holds = (value: unknown): boolean => (typeof value === "string" || typeof value === "number") && String(value).includes(wanted);
      const found = tree.data.elements.find((e) => holds(e.text) || holds(e.value));
      if (found === undefined) parts.push({ ok: false, why: `text ${JSON.stringify(wanted)} is not on screen any more.` });
      else {
        const field = found.role === "textfield" || found.role === "input" || (found.actions ?? []).includes("type");
        parts.push({ ok: true, why: `text ${JSON.stringify(wanted)} is still ${field ? "in the field" : "on screen"}.` });
      }
    }
    if (survives.goal_step !== undefined) parts.push(this.goalStepHolds(running, survives.goal_step, tree.data.route?.names ?? []));
    // A check that couldn't be made (ok null) is no pass: survived only when every check held, null when one was unknown and none failed.
    const survived = parts.some((p) => p.ok === false) ? false : parts.every((p) => p.ok === true) ? true : null;
    return { survived, why: parts.map((p) => p.why).join(" ") };
  }

  /** `goal_step`: a step number (the screen that step ended on) or a screen's name (part of its route). */
  private goalStepHolds(running: Journey, goalStep: string, route: string[]): { ok: boolean | null; why: string } {
    const now = route.join(" › ");
    if (/^\d+$/.test(goalStep.trim())) {
      const n = Number(goalStep);
      const step = running.state.steps[n - 1];
      if (step === undefined) return { ok: false, why: `the journey has no step ${n}.` };
      const screen = step.screen === undefined ? undefined : running.state.screens[step.screen - 1];
      if (screen === undefined || screen.route.length === 0 || route.length === 0) {
        return { ok: null, why: `step ${n}'s screen can't be told apart (the app has no routes); only text can be checked.` };
      }
      const same = screen.route.join(" › ") === now;
      return same ? { ok: true, why: `the app is still on step ${n}'s screen (${now}).` } : { ok: false, why: `the app is on ${now}, not step ${n}'s screen (${screen.route.join(" › ")}).` };
    }
    const named = now.toLowerCase().includes(goalStep.trim().toLowerCase());
    return named ? { ok: true, why: `the app is still on ${now}.` } : { ok: false, why: `the app is on ${now === "" ? "a screen with no route" : now}, not ${JSON.stringify(goalStep)}.` };
  }

  /** The command and arguments that set one of a journey's conditions. */
  private conditionCall(name: keyof Conditions, value: string): { command: string; args: Record<string, unknown> } {
    switch (name) {
      case "network":
        return { command: "network", args: { mode: value } };
      case "language":
        return { command: "language", args: { language: value } };
      case "region":
        return { command: "region", args: { region: value } };
      case "text_size":
        return { command: "text_size", args: { size: value } };
    }
  }

  /** Runs one condition command straight on the app (a journey's own, not the agent's shortcut); the app's answer may say what it was before. */
  private async runCondition(
    session: SessionInfo,
    name: keyof Conditions,
    value: string,
  ): Promise<{ ok: true; previous?: string } | { ok: false; failure: string }> {
    const call = this.conditionCall(name, value);
    if (name === "network") {
      // The app that receives the condition (a journey's own, maybe not the selected one) is the one the policy is read for.
      const refused = this.networkRefusal(value, session.app);
      if (refused !== null) {
        const said = refused.content.map((block) => (block.type === "text" ? block.text : "")).join(" ");
        return { ok: false, failure: said.replace(/^Error \w+: /, "").replace(/\.$/, "") };
      }
    }
    try {
      const raw = await this.sendRequest("command", { name: call.command, args: call.args }, { sessionId: session.id });
      const inner = typeof raw === "object" && raw !== null && "result" in raw ? (raw as { result: unknown }).result : undefined;
      const previous = typeof inner === "object" && inner !== null && "previous" in inner ? (inner as { previous: unknown }).previous : undefined;
      return { ok: true, ...(typeof previous === "string" && previous !== "" ? { previous } : {}) };
    } catch (error) {
      return { ok: false, failure: describeError(error).replace(/^Error \w+: /, "").replace(/\.$/, "") };
    }
  }

  private async applyCondition(session: SessionInfo, name: keyof Conditions, value: string): Promise<ConditionRecord> {
    const done = await this.runCondition(session, name, value);
    if (!done.ok) return { name, value, applied: false, failure: done.failure };
    return { name, value, applied: true, ...(done.previous !== undefined ? { previous: done.previous } : {}) };
  }

  /** At the stop: network goes back to normal, text size to the phone's own, language and region to what the app said they were. */
  private async undoConditions(state: JourneyState): Promise<void> {
    const session = this.journeySession();
    for (const record of state.conditionRecords) {
      if (!record.applied) continue;
      const words = record.name.replace("_", " ");
      if ((record.name === "language" || record.name === "region") && record.previous === undefined) {
        record.undone = false;
        record.undo = `Note: ${words} ${record.value} was not restored: the app doesn't report what it was before.`;
        continue;
      }
      if (session === undefined) {
        record.undone = false;
        record.undo = `Note: ${words} ${record.value} was not undone: ${this.journeyAppGone()}.`;
        continue;
      }
      const back = record.name === "network" ? "normal" : record.name === "text_size" ? "system" : (record.previous ?? "");
      const done = await this.runCondition(session, record.name, back);
      record.undone = done.ok;
      record.undo = done.ok
        ? record.name === "text_size"
          ? "Undone: text size is the phone's own again."
          : `Undone: ${words} is ${back} again.`
        : `Note: ${words} ${record.value} was not undone: ${done.failure}.`;
    }
  }

  async wait(args: Shape<"wait">): Promise<CallToolResult> {
    const session = this.host.current();
    if (session === undefined) return this.notConnected();
    await sleep(args.seconds * 1000);
    if (this.recording !== null && !this.replaying) {
      this.recording.steps.push({ method: "sleep", params: { seconds: args.seconds } });
    }
    return this.withLook(session, `Waited ${args.seconds.toFixed(1)} s.`, args.screenshot === true);
  }
}
