import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
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
  type ResolveOptions,
  type ScreenshotMode,
  type ViewerMode,
} from "./config.js";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ControlQueue } from "./control.js";
import { Confirmations } from "./confirm.js";
import { DEFAULT_POLICY, NO_POLICY, loadPolicy, type PolicyFile } from "./policy.js";
import { VIEWER_ACCEPTS, ViewerHub, viewerStatusForHost } from "./viewer.js";
import { VIEWER_HTML } from "./viewer-page.js";
import { TaplineHost } from "./server.js";
import { INSTRUCTIONS, toolDescription } from "./tool-text.js";
import { z } from "zod";
import { TaplineTools, toolShapes, unknownArgumentError, type ToolArgs } from "./tools.js";

type ToolName = keyof typeof toolShapes;
type ToolAnswer = Awaited<ReturnType<TaplineTools["apps"]>>;

/**
 * A tool's input for the MCP server: its own keys, with unknown ones let through (the SDK would strip them
 * silently) so `guarded` can refuse them. The published JSON schema is cleaned of the resulting
 * `additionalProperties` in `createMcpServer`.
 */
function looseInput(name: ToolName): z.ZodObject<z.ZodRawShape, z.core.$loose> {
  return z.object<z.ZodRawShape>(toolShapes[name]).passthrough();
}

/** Runs a tool's handler only when every argument is one the tool has; else answers bad_params. */
function guarded<K extends ToolName>(
  name: K,
  handler: (args: ToolArgs<K>) => ToolAnswer | Promise<ToolAnswer>,
): (args: Record<string, unknown>) => ToolAnswer | Promise<ToolAnswer> {
  return (args) => unknownArgumentError(name, args) ?? handler(args as ToolArgs<K>);
}

/**
 * Drops `additionalProperties` from the tool list: it only came from letting unknown keys through to `guarded`.
 * Reaches the SDK's own list handler by its method name; when the SDK changes that, the schema simply keeps it.
 */
function publishPlainSchemas(server: McpServer): void {
  const handlers: unknown = Reflect.get(server.server, "_requestHandlers");
  const original: unknown = handlers instanceof Map ? handlers.get("tools/list") : undefined;
  if (!(handlers instanceof Map) || typeof original !== "function") {
    process.stderr.write("tapline: the MCP SDK changed; tool schemas keep additionalProperties (harmless, but strict clients may refuse it)\n");
    return;
  }
  const list = original as (request: unknown, extra: unknown) => Promise<{ tools: Array<{ inputSchema: Record<string, unknown> }> }>;
  handlers.set("tools/list", async (request: unknown, extra: unknown) => {
    const answer = await list(request, extra);
    for (const tool of answer.tools) delete tool.inputSchema["additionalProperties"];
    return answer;
  });
}

/** Registers every Tapline tool on an MCP server. */
export function createMcpServer(tools: TaplineTools): McpServer {
  const server = new McpServer({ name: "tapline", version: "1.3.1" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "apps",
    {
      title: "Connected apps",
      description: toolDescription("apps"),
      inputSchema: looseInput("apps"),
      annotations: { readOnlyHint: true },
    },
    guarded("apps", () => tools.apps()),
  );

  server.registerTool(
    "open_app",
    {
      title: "Open app",
      description: toolDescription("open_app"),
      inputSchema: looseInput("open_app"),
    },
    guarded("open_app", (args) => tools.openApp(args)),
  );

  server.registerTool(
    "pair",
    {
      title: "Pair a phone",
      description: toolDescription("pair"),
      inputSchema: looseInput("pair"),
    },
    guarded("pair", (args) => tools.pair(args)),
  );

  server.registerTool(
    "look",
    {
      title: "Look at the screen",
      description: toolDescription("look"),
      inputSchema: looseInput("look"),
      annotations: { readOnlyHint: true },
    },
    guarded("look", (args) => tools.look(args)),
  );

  server.registerTool(
    "check_layout",
    {
      title: "Check the layout",
      description: toolDescription("check_layout"),
      inputSchema: looseInput("check_layout"),
      annotations: { readOnlyHint: true },
    },
    guarded("check_layout", (args) => tools.checkLayout(args)),
  );

  server.registerTool(
    "run",
    {
      title: "Run several steps",
      description: toolDescription("run"),
      inputSchema: looseInput("run"),
    },
    guarded("run", (args) => tools.run(args)),
  );

  server.registerTool(
    "audit",
    {
      title: "Audit the screen's accessibility",
      description: toolDescription("audit"),
      inputSchema: looseInput("audit"),
      annotations: { readOnlyHint: true },
    },
    guarded("audit", (args) => tools.audit(args)),
  );

  server.registerTool(
    "inspect",
    {
      title: "Find the code behind an element",
      description: toolDescription("inspect"),
      inputSchema: looseInput("inspect"),
      annotations: { readOnlyHint: true },
    },
    guarded("inspect", (args) => tools.inspect(args)),
  );

  server.registerTool(
    "tap",
    {
      title: "Tap",
      description: toolDescription("tap"),
      inputSchema: looseInput("tap"),
    },
    guarded("tap", (args) => tools.tap(args)),
  );

  server.registerTool(
    "swipe",
    {
      title: "Swipe",
      description: toolDescription("swipe"),
      inputSchema: looseInput("swipe"),
    },
    guarded("swipe", (args) => tools.swipe(args)),
  );

  server.registerTool(
    "long_press",
    {
      title: "Long press",
      description: toolDescription("long_press"),
      inputSchema: looseInput("long_press"),
    },
    guarded("long_press", (args) => tools.longPress(args)),
  );

  server.registerTool(
    "type_text",
    {
      title: "Type text",
      description: toolDescription("type_text"),
      inputSchema: looseInput("type_text"),
    },
    guarded("type_text", (args) => tools.typeText(args)),
  );

  server.registerTool(
    "scroll",
    {
      title: "Scroll",
      description: toolDescription("scroll"),
      inputSchema: looseInput("scroll"),
    },
    guarded("scroll", (args) => tools.scroll(args)),
  );

  server.registerTool(
    "toggle",
    {
      title: "Toggle",
      description: toolDescription("toggle"),
      inputSchema: looseInput("toggle"),
    },
    guarded("toggle", (args) => tools.toggle(args)),
  );

  server.registerTool(
    "open_url",
    {
      title: "Open URL",
      description: toolDescription("open_url"),
      inputSchema: looseInput("open_url"),
    },
    guarded("open_url", (args) => tools.openUrl(args)),
  );

  server.registerTool(
    "back",
    {
      title: "Back",
      description: toolDescription("back"),
      inputSchema: looseInput("back"),
    },
    guarded("back", (args) => tools.back(args)),
  );

  server.registerTool(
    "app_command",
    {
      title: "App command",
      description: toolDescription("app_command"),
      inputSchema: looseInput("app_command"),
    },
    guarded("app_command", (args) => tools.appCommand(args)),
  );

  server.registerTool(
    "compare_screen",
    {
      title: "Compare with a reference",
      description: toolDescription("compare_screen"),
      inputSchema: looseInput("compare_screen"),
      annotations: { readOnlyHint: true },
    },
    guarded("compare_screen", (args) => tools.compareScreen(args)),
  );

  server.registerTool(
    "filmstrip",
    {
      title: "Filmstrip",
      description: toolDescription("filmstrip"),
      inputSchema: looseInput("filmstrip"),
    },
    guarded("filmstrip", (args) => tools.filmstrip(args)),
  );

  server.registerTool(
    "viewer",
    {
      title: "Live viewer",
      description: toolDescription("viewer"),
      inputSchema: looseInput("viewer"),
      annotations: { readOnlyHint: true },
    },
    guarded("viewer", (args) => tools.viewer(args)),
  );

  server.registerTool(
    "record",
    {
      title: "Record a script",
      description: toolDescription("record"),
      inputSchema: looseInput("record"),
    },
    guarded("record", (args) => tools.record(args)),
  );

  server.registerTool(
    "replay",
    {
      title: "Replay a script",
      description: toolDescription("replay"),
      inputSchema: looseInput("replay"),
    },
    guarded("replay", (args) => tools.replay(args)),
  );

  server.registerTool(
    "wait_for",
    {
      title: "Wait for",
      description: toolDescription("wait_for"),
      inputSchema: looseInput("wait_for"),
      annotations: { readOnlyHint: true },
    },
    guarded("wait_for", (args) => tools.waitFor(args)),
  );

  server.registerTool(
    "logs",
    {
      title: "App logs",
      description: toolDescription("logs"),
      inputSchema: looseInput("logs"),
      annotations: { readOnlyHint: true },
    },
    guarded("logs", (args) => tools.logs(args)),
  );

  server.registerTool(
    "crash",
    {
      title: "App crash",
      description: toolDescription("crash"),
      inputSchema: looseInput("crash"),
      annotations: { readOnlyHint: true },
    },
    guarded("crash", (args) => tools.crash(args)),
  );

  server.registerTool(
    "reload",
    {
      title: "Reload app",
      description: toolDescription("reload"),
      inputSchema: looseInput("reload"),
    },
    guarded("reload", (args) => tools.reload(args)),
  );

  server.registerTool(
    "performance",
    {
      title: "Performance",
      description: toolDescription("performance"),
      inputSchema: looseInput("performance"),
    },
    guarded("performance", (args) => tools.performance(args)),
  );

  server.registerTool(
    "wait",
    {
      title: "Wait",
      description: toolDescription("wait"),
      inputSchema: looseInput("wait"),
      annotations: { readOnlyHint: true },
    },
    guarded("wait", (args) => tools.wait(args)),
  );

  publishPlainSchemas(server);
  return server;
}

function log(message: string): void {
  process.stderr.write(`[tapline] ${message}\n`);
}

/** Runs the host and serves MCP over stdio. stdout is reserved for the protocol; everything else goes to stderr. */
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

export async function runMcp(
  options: ResolveOptions & { screenshots?: string; viewer?: string; noLog?: boolean; policy?: string; noPolicy?: boolean; viewerLink?: boolean } = {},
): Promise<boolean> {
  let screenshots: ScreenshotMode;
  let viewer: ViewerMode;
  let policy: PolicyFile;
  try {
    screenshots = screenshotMode(options.screenshots, options.env);
    viewer = viewerMode(options.viewer, options.env);
    // The safety policy (AGENT-TOOLS 1.8 §11): built in, from --policy FILE, or none with --no-policy.
    policy = options.noPolicy === true ? NO_POLICY : options.policy !== undefined ? loadPolicy(options.policy) : DEFAULT_POLICY;
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    return false;
  }
  const config = await resolveConfig(options);
  const host = new TaplineHost({
    token: config.token,
    port: config.port,
    portFallback: config.portFallback,
    hosts: config.hosts,
  });
  host.on("connect", () => markPaired(options.env));
  host.on("connect", (s) => log(`app connected: ${s.app.name} (${s.id}) on ${s.device.name ?? s.device.platform}`));
  host.on("disconnect", (s, reason) => log(`app disconnected: ${s.app.name} (${s.id}): ${reason}`));
  host.on("warning", (message) => log(message));

  for (const note of config.notes) log(note);
  let advertised = config.advertisedHost;
  try {
    const result = await host.listen();
    for (const { host: h, port } of result.listening) log(`listening on ws://${h}:${port}/`);
    for (const { host: h, error } of result.failed) log(`could not listen on ${h}: ${error}`);
    advertised = reachableHost(config, result.listening);
  } catch (error) {
    log(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
    log("Every port tried is taken (other Tapline hosts?). Pick a free one with --port or TAPLINE_PORT.");
    return false;
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
  const tools = new TaplineTools(host, {
    policy,
    confirmations,
    canConfirm: viewer !== "off",
    connect: { url, name: config.name },
    pairedBefore: () => pairedBefore(options.env),
    pairImagePath: join(configDir(), `pair-${port}.png`),
    offerDir: join(configDir(), "offers"),
    screenshots,
    screenshotDir: join(configDir(), "shots"),
    scriptsDir: join(configDir(), "scripts"),
    baselinesDir: join(configDir(), "baselines"),
    // The action log (AGENT-TOOLS 1.8 §12), unless --no-log
    ...(options.noLog === true ? {} : { logDir: join(configDir(), "log") }),
    ...(viewer === "off"
      ? {}
      : {
          control,
          onAction: (action) => hub?.pushAction(action),
          viewerLinks: () => viewerLinks,
          openViewer: (link: string) => openInBrowser(link),
          viewerLinkToAgent: options.viewerLink === true || process.env["TAPLINE_VIEWER_LINK"] === "1",
          viewerFeed: () => hub?.feed() ?? { on: false, quality: "balanced" },
        }),
  });
  if (viewer !== "off") {
    const live = new ViewerHub({
      token: viewerToken,
      html: VIEWER_HTML,
      allowedHosts: () => viewerHosts,
      allowRemote: remoteViewer,
      accepts: [...VIEWER_ACCEPTS],
      control,
      setFeed: (on, quality) => {
        void tools.setFeed(on, quality).then((outcome) => {
          // Without an app, or in the background, the status already says so (appStatus below).
          if (!outcome.ok && on && host.current() !== undefined && outcome.code !== "in_background") {
            live.setStatus({ detail: `The app can't stream its screen: ${outcome.message ?? ""}` });
          }
        });
      },
      readOverlay: () => tools.readOverlay(),
      runInput: (input) => tools.personInput(input),
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
  if (screenshots === "file") log(`screenshots are saved in ${join(configDir(), "shots")} (newest 50 kept)`);
  const server = createMcpServer(tools);
  const shutdown = (): void => {
    void host.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("close", shutdown);
  await server.connect(new StdioServerTransport());
  return true;
}
