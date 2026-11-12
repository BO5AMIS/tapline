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
import { Confirmations } from "./confirm.js";
import { ControlQueue } from "./control.js";
import { isToolName, callTool } from "./dispatch.js";
import { realRunner } from "./journeyexport.js";
import { DEFAULT_POLICY, NO_POLICY, loadPolicy, type PolicyFile } from "./policy.js";
import { TaplineHost, type ListenResult } from "./server.js";
import { TaplineTools, type ToolsOptions } from "./tools.js";
import { NO_UX_RULES, loadUxRules, type UxRules } from "./uxcheck.js";
import { VIEWER_ACCEPTS, ViewerHub, viewerStatusForHost } from "./viewer.js";
import { VIEWER_HTML } from "./viewer-page.js";

/** How long a client of the thin call may stay silent before its tools (its report, its journey) are dropped. */
export const CLIENT_IDLE_MS = 30 * 60 * 1000;

export interface RuntimeOptions extends ResolveOptions {
  screenshots?: string;
  viewer?: string;
  noLog?: boolean;
  policy?: string;
  noPolicy?: boolean;
  viewerLink?: boolean;
  uxRules?: string;
  /** `--brief`: actions answer briefly unless a call says `brief: false` (AGENT-TOOLS 1.13 §13.4). */
  brief?: boolean;
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

  const config = await resolveConfig(options);
  const clients = new Map<string, { tools: TaplineTools; lastUsed: number }>();
  const host = new TaplineHost({
    token: config.token,
    port: config.port,
    portFallback: config.portFallback,
    hosts: config.hosts,
    ...(options.api === true
      ? {
          api: async (tool: string, args: Record<string, unknown>, clientId: string | undefined) =>
            isToolName(tool) ? callTool(toolsFor(clientId), tool, args) : undefined,
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

  const toolsOptions: ToolsOptions = {
    ...(options.brief === true ? { brief: true } : {}),
    policy,
    uxRules,
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

  function toolsFor(clientId: string | undefined): TaplineTools {
    if (clientId === undefined) return primary;
    const now = clock();
    for (const [id, entry] of clients) if (now - entry.lastUsed > CLIENT_IDLE_MS) clients.delete(id);
    const known = clients.get(clientId);
    if (known !== undefined) {
      known.lastUsed = now;
      return known.tools;
    }
    // The call log names the agent by this id.
    const tools = new TaplineTools(host, { ...toolsOptions, clientId: () => clientId });
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
      runInput: (input) => primary.personInput(input),
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
    close: () => host.close(),
  };
}
