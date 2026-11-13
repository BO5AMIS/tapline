import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  configDir,
  hostUrl,
  markPaired,
  pairedBefore,
  reachableHost,
  resolveConfig,
  screenshotMode,
  viewerMode,
  type HostConfig,
  type ResolveOptions,
  type ScreenshotMode,
  type ViewerMode,
} from "./config.js";
import { loadAccounts, type GitProbe } from "./accounts.js";
import { Confirmations } from "./confirm.js";
import { ControlQueue } from "./control.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isToolName, callTool, type ToolName } from "./dispatch.js";
import { realRunner } from "./journeyexport.js";
import { MapRegistry } from "./places.js";
import { AuditLog } from "./auditlog.js";
import { GrantBook } from "./grants.js";
import { DEFAULT_POLICY, NO_POLICY, loadPolicy, type PolicyFile } from "./policy.js";
import { TaplineHost, type ListenResult } from "./server.js";
import { restoreAnimations } from "./animations.js";
import { TaplineTools, type ToolsOptions } from "./tools.js";
import { NO_UX_RULES, loadUxRules, type UxRules } from "./uxcheck.js";
import { VIEWER_ACCEPTS, ViewerHub, viewerStatusForHost } from "./viewer.js";
import { VIEWER_HTML } from "./viewer-page.js";

/** How long a client of the thin call may stay silent before its tools (its report, its journey) are dropped. */
export const CLIENT_IDLE_MS = 30 * 60 * 1000;

/** What a queued call answers when its client left before it started (nobody reads it). */
const CANCELLED: CallToolResult = { content: [{ type: "text", text: "Error cancelled: the client left before this call started, so it never ran." }], isError: true };

/** The client id of a thin call that names none. */
export const ANONYMOUS_CLIENT = "anonymous";

export interface RuntimeOptions extends ResolveOptions {
  screenshots?: string;
  viewer?: string;
  noLog?: boolean;
  policy?: string;
  noPolicy?: boolean;
  /** `--no-dialog`: a person's OK is asked in the live view only, never in the host's dialog (AGENT-TOOLS 1.13 §11.3). */
  noDialog?: boolean;
  viewerLink?: boolean;
  uxRules?: string;
  /** `--accounts FILE`: test accounts (AGENT-TOOLS 1.13 §18.6). A file inside a git work tree that doesn't ignore it loads nothing. */
  accounts?: string;
  /** Tests: the git questions the accounts file is checked with. */
  gitProbe?: GitProbe;
  /** `--brief`: actions answer briefly unless a call says `brief: false` (AGENT-TOOLS 1.13 §13.4). */
  brief?: boolean;
  /** `--maps DIR`: where the apps' maps live, `<DIR>/<app id>/` (AGENT-TOOLS 1.13 §18.9). Default `~/.tapline/maps`. */
  maps?: string;
  /** Serve `POST /api/<tool>`: set by a standalone `tapline host`, never by an agent's MCP server (AGENT-TOOLS 1.13 §18.10). */
  api?: boolean;
  /** Where the host's own lines go. Default: stderr with a `[tapline]` prefix (stdout is the MCP protocol's). */
  log?: (message: string) => void;
  /** Clock for the idle sweep (tests). Default Date.now. */
  clock?: () => number;
  /** Opens the live view in a browser (tests). Default: this computer's default browser. */
  openBrowser?: (link: string) => boolean;
}

export interface Runtime {
  host: TaplineHost;
  confirmations: Confirmations;
  config: HostConfig;
  listening: ListenResult;
  /** Where apps reach this host. */
  url: string;
  /** The port the host bound. */
  port: number;
  viewerLinks: string[];
  remoteViewer: boolean;
  /**
   * A tools object for one client; the same object for the same id. `undefined` is the connection itself (one MCP
   * server). Other ids are dropped after 30 minutes without a call.
   */
  toolsFor(clientId: string | undefined): TaplineTools;
  close(): Promise<void>;
}

function stderrLog(message: string): void {
  process.stderr.write(`[tapline] ${message}\n`);
}

/** Opens a link in the default browser of this computer; false when that couldn't start. */
function openInBrowser(link: string): boolean {
  try {
    const [command, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", link.replace(/&/g, "^&")]]
        : process.platform === "darwin"
          ? ["open", [link]]
          : ["xdg-open", [link]];
    const child = spawn(command as string, args as string[], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * The wiring an MCP server and a standalone host share: the host, the person's confirmations, the live viewer on the
 * host's port, the policy, the log folders and the 3 s control queue. Rejects with a plain message when an option is
 * wrong or no port is free (the message's lines are for the log).
 */
export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const log = options.log ?? stderrLog;
  const clock = options.clock ?? Date.now;
  let screenshots: ScreenshotMode;
  let viewer: ViewerMode;
  let policy: PolicyFile;
  let uxRules: UxRules = NO_UX_RULES;
  // The safety policy (AGENT-TOOLS 1.8 §11): built in, from --policy FILE, or none with --no-policy. The user's UX
  // house rules (1.12 §17.3): --ux-rules FILE; a bad file stops the host with a plain message.
  screenshots = screenshotMode(options.screenshots, options.env);
  viewer = viewerMode(options.viewer, options.env);
  policy = options.noPolicy === true ? NO_POLICY : options.policy !== undefined ? loadPolicy(options.policy) : DEFAULT_POLICY;
  if (options.uxRules !== undefined) uxRules = loadUxRules(options.uxRules);
  // The test accounts (AGENT-TOOLS 1.13 §18.6). A refused file still starts the server, with no accounts and the reason.
  const accounts = options.accounts !== undefined ? await loadAccounts(options.accounts, options.gitProbe) : undefined;
  if (accounts !== undefined && accounts.store === null) log(accounts.blocked);

  const config = await resolveConfig(options);
  const clients = new Map<string, { tools: TaplineTools; lastUsed: number }>();
  const host = new TaplineHost({
    ...(accounts?.store != null ? { redact: accounts.store.redact } : {}),
    token: config.token,
    port: config.port,
    portFallback: config.portFallback,
    hosts: config.hosts,
    ...(options.api === true
      ? {
          api: async (tool: string, args: Record<string, unknown>, clientId: string | undefined, signal: AbortSignal) =>
            isToolName(tool) ? thinCall(tool, args, clientId, signal) : undefined,
        }
      : {}),
  });
  host.on("connect", () => markPaired(options.env));
  host.on("connect", (s) => log(`app connected: ${s.app.name} (${s.id}) on ${s.device.name ?? s.device.platform}`));
  host.on("disconnect", (s, reason) => log(`app disconnected: ${s.app.name} (${s.id}): ${reason}`));
  host.on("warning", (message) => log(message));

  for (const note of config.notes) log(note);
  let advertised = config.advertisedHost;
  let listening: ListenResult;
  try {
    listening = await host.listen();
    for (const { host: h, port } of listening.listening) log(`listening on ws://${h}:${port}/`);
    for (const { host: h, error } of listening.failed) log(`could not listen on ${h}: ${error}`);
    advertised = reachableHost(config, listening.listening);
  } catch (error) {
    throw new Error(
      `failed to start: ${error instanceof Error ? error.message : String(error)}\n` +
        "Every port tried is taken (other Tapline hosts?). Pick a free one with --port or TAPLINE_PORT.",
    );
  }
  const port = host.boundPort() ?? config.port;
  const url = hostUrl({ advertisedHost: advertised }, port);
  log(`apps connect to ${url}; use the pair tool to connect a phone`);

  // The live viewer rides on this host's port: local by default, the tailnet with --viewer remote.
  const viewerToken = randomBytes(24).toString("base64url");
  const remoteViewer = viewer === "remote" && config.tailscaleIp !== null;
  const viewerHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, ...(remoteViewer ? [`${config.tailscaleIp}:${port}`] : [])];
  const viewerLinks = [
    `http://127.0.0.1:${port}/viewer?token=${viewerToken}`,
    ...(remoteViewer ? [`http://${config.tailscaleIp}:${port}/viewer?token=${viewerToken} (from your own devices on Tailscale)`] : []),
  ];
  const control = new ControlQueue();
  const confirmations = new Confirmations();
  let hub: ViewerHub | undefined;
  const openBrowser = options.openBrowser ?? openInBrowser;

  // One map per app for every client of this host: places, roads and links grow as agents drive (§18.9).
  const maps = new MapRegistry({ mapsDir: options.maps ?? join(configDir(options.env), "maps") });

  // Grants (AGENT-TOOLS 1.14 §19) live in the policy file: no file, no grants. The audit log (§23) has no off switch.
  const audit = new AuditLog(join(configDir(options.env), "audit"));
  audit.open();
  let grants: GrantBook | undefined;
  if (options.noPolicy !== true && options.policy !== undefined) grants = new GrantBook({ policyPath: options.policy, audit });
  const toolsOptions: ToolsOptions = {
    maps,
    audit,
    ...(grants !== undefined ? { grants } : {}),
    ...(options.brief === true ? { brief: true } : {}),
    policy,
    uxRules,
    ...(accounts !== undefined ? { accounts } : {}),
    confirmations,
    canConfirm: viewer !== "off",
    connect: { url, name: config.name },
    pairedBefore: () => pairedBefore(options.env),
    pairImagePath: join(configDir(options.env), `pair-${port}.png`),
    offerDir: join(configDir(options.env), "offers"),
    screenshots,
    screenshotDir: join(configDir(options.env), "shots"),
    scriptsDir: join(configDir(options.env), "scripts"),
    baselinesDir: join(configDir(options.env), "baselines"),
    // Journey reports (AGENT-TOOLS 1.12 §17.5) and the user's own gh and git for `export`
    journeysDir: join(configDir(options.env), "journeys"),
    exportRunner: realRunner,
    // The action log (AGENT-TOOLS 1.8 §12), unless --no-log
    ...(options.noLog === true ? {} : { logDir: join(configDir(options.env), "log") }),
    ...(viewer === "off"
      ? {}
      : {
          control,
          onAction: (action) => hub?.pushAction(action),
          viewerLinks: () => viewerLinks,
          openViewer: (link: string) => openBrowser(link),
          viewerLinkToAgent: options.viewerLink === true || process.env["TAPLINE_VIEWER_LINK"] === "1",
          viewerFeed: () => hub?.feed() ?? { on: false, quality: "balanced" },
        }),
  };
  // The connection's own tools: what an MCP server uses, and what the live viewer's person input goes through.
  const primary = new TaplineTools(host, toolsOptions);

  /** Every call through `/api` is a thin call: the log says so, and the report flags a run of them (§16.1). */
  function thinCall(tool: ToolName, args: Record<string, unknown>, clientId: string | undefined, signal: AbortSignal): Promise<CallToolResult> {
    // A thin call never uses the MCP server's tools: those hold its dialog and the OKs given for its calls.
    const tools = toolsFor(clientId ?? ANONYMOUS_CLIENT);
    // Calls that share a tools object run one after another: they share its per-call state (a run's account).
    const before = lanes.get(tools) ?? Promise.resolve();
    // A call whose client left while it waited in the line is dropped before it starts; a running one is told to stop waiting.
    const answer = before.then(() => (signal.aborted ? CANCELLED : tools.withCall(signal, () => tools.asThinCall(() => callTool(tools, tool, args)))));
    lanes.set(tools, answer.then(() => undefined, () => undefined));
    return answer;
  }
  const lanes = new WeakMap<TaplineTools, Promise<void>>();

  function toolsFor(clientId: string | undefined): TaplineTools {
    if (clientId === undefined) return primary;
    const now = clock();
    for (const [id, entry] of clients) {
      if (now - entry.lastUsed <= CLIENT_IDLE_MS) continue;
      entry.tools.dispose();
      clients.delete(id);
    }
    const known = clients.get(clientId);
    if (known !== undefined) {
      known.lastUsed = now;
      return known.tools;
    }
    // The call log names the agent by this id.
    const tools = new TaplineTools(host, { ...toolsOptions, clientId: () => clientId, confirmScope: "api" });
    clients.set(clientId, { tools, lastUsed: now });
    return tools;
  }

  if (viewer !== "off") {
    const live = new ViewerHub({
      token: viewerToken,
      html: VIEWER_HTML,
      allowedHosts: () => viewerHosts,
      allowRemote: remoteViewer,
      accepts: [...VIEWER_ACCEPTS],
      control,
      setFeed: (on, quality) => {
        void primary.setFeed(on, quality).then((outcome) => {
          // Without an app, or in the background, the status already says so (appStatus below).
          if (!outcome.ok && on && host.current() !== undefined && outcome.code !== "in_background") {
            live.setStatus({ detail: `The app can't stream its screen: ${outcome.message ?? ""}` });
          }
        });
      },
      readOverlay: () => primary.readOverlay(),
      runInput: async (input) => {
        const outcome = await primary.personInput(input);
        // The request reached the app: every client's refs from before it are stale.
        if (outcome.action !== undefined) for (const entry of clients.values()) entry.tools.noteViewerInput();
        return outcome;
      },
      confirmations,
    });
    hub = live;
    host.setHttpExtension(live);
    host.on("frame", (session, frame) => {
      if (host.current()?.id === session.id) live.pushFrame(frame);
    });
    const appStatus = (): void => live.setStatus(viewerStatusForHost(host));
    host.on("connect", appStatus);
    host.on("disconnect", appStatus);
    host.on("appState", appStatus);
    host.on("notAnswering", appStatus);
    host.on("answering", appStatus);
    appStatus();
    log(`live viewer: ${remoteViewer ? "this computer and your Tailscale devices" : "this computer only"} (the viewer tool opens it in a browser here)`);
    // The link for the user's own devices: here in the log, never in an answer to the agent.
    if (remoteViewer) for (const link of viewerLinks.slice(1)) log(`live viewer for your devices: ${link}`);
  }
  if (screenshots === "file") log(`screenshots are saved in ${join(configDir(options.env), "shots")} (newest 50 kept)`);

  return {
    host,
    confirmations,
    config,
    listening,
    url,
    port,
    viewerLinks,
    remoteViewer,
    toolsFor,
    // The maps are written at most once a second while driving, and in full here.
    close: async () => {
      await maps.flushAll().catch(() => undefined);
      // The phone is never left fast-forwarded with nobody watching (PLAN-1.6 F4, E8).
      await restoreAnimations(host).catch(() => undefined);
      for (const entry of clients.values()) entry.tools.dispose();
      clients.clear();
      primary.dispose();
      await host.close();
    },
  };
}
