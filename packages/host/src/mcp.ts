import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join } from "node:path";
import {
  configDir,
  hostUrl,
  reachableHost,
  resolveConfig,
  screenshotMode,
  viewerMode,
  type ResolveOptions,
  type ScreenshotMode,
  type ViewerMode,
} from "./config.js";
import { randomBytes } from "node:crypto";
import { ControlQueue } from "./control.js";
import { VIEWER_ACCEPTS, ViewerHub, viewerStatusForHost } from "./viewer.js";
import { VIEWER_HTML } from "./viewer-page.js";
import { TaplineHost } from "./server.js";
import { INSTRUCTIONS, toolDescription } from "./tool-text.js";
import { TaplineTools, toolShapes } from "./tools.js";

/** Registers every Tapline tool on an MCP server. */
export function createMcpServer(tools: TaplineTools): McpServer {
  const server = new McpServer({ name: "tapline", version: "1.0.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "apps",
    {
      title: "Connected apps",
      description: toolDescription("apps"),
      inputSchema: toolShapes.apps,
      annotations: { readOnlyHint: true },
    },
    () => tools.apps(),
  );

  server.registerTool(
    "open_app",
    {
      title: "Open app",
      description: toolDescription("open_app"),
      inputSchema: toolShapes.open_app,
    },
    (args) => tools.openApp(args),
  );

  server.registerTool(
    "pair",
    {
      title: "Pair a phone",
      description: toolDescription("pair"),
      inputSchema: toolShapes.pair,
    },
    (args) => tools.pair(args),
  );

  server.registerTool(
    "look",
    {
      title: "Look at the screen",
      description: toolDescription("look"),
      inputSchema: toolShapes.look,
      annotations: { readOnlyHint: true },
    },
    (args) => tools.look(args),
  );

  server.registerTool(
    "check_layout",
    {
      title: "Check the layout",
      description: toolDescription("check_layout"),
      inputSchema: toolShapes.check_layout,
      annotations: { readOnlyHint: true },
    },
    (args) => tools.checkLayout(args),
  );

  server.registerTool(
    "tap",
    {
      title: "Tap",
      description: toolDescription("tap"),
      inputSchema: toolShapes.tap,
    },
    (args) => tools.tap(args),
  );

  server.registerTool(
    "swipe",
    {
      title: "Swipe",
      description: toolDescription("swipe"),
      inputSchema: toolShapes.swipe,
    },
    (args) => tools.swipe(args),
  );

  server.registerTool(
    "long_press",
    {
      title: "Long press",
      description: toolDescription("long_press"),
      inputSchema: toolShapes.long_press,
    },
    (args) => tools.longPress(args),
  );

  server.registerTool(
    "type_text",
    {
      title: "Type text",
      description: toolDescription("type_text"),
      inputSchema: toolShapes.type_text,
    },
    (args) => tools.typeText(args),
  );

  server.registerTool(
    "scroll",
    {
      title: "Scroll",
      description: toolDescription("scroll"),
      inputSchema: toolShapes.scroll,
    },
    (args) => tools.scroll(args),
  );

  server.registerTool(
    "toggle",
    {
      title: "Toggle",
      description: toolDescription("toggle"),
      inputSchema: toolShapes.toggle,
    },
    (args) => tools.toggle(args),
  );

  server.registerTool(
    "open_url",
    {
      title: "Open URL",
      description: toolDescription("open_url"),
      inputSchema: toolShapes.open_url,
    },
    (args) => tools.openUrl(args),
  );

  server.registerTool(
    "back",
    {
      title: "Back",
      description: toolDescription("back"),
      inputSchema: toolShapes.back,
    },
    (args) => tools.back(args),
  );

  server.registerTool(
    "app_command",
    {
      title: "App command",
      description: toolDescription("app_command"),
      inputSchema: toolShapes.app_command,
    },
    (args) => tools.appCommand(args),
  );

  server.registerTool(
    "compare_screen",
    {
      title: "Compare with a reference",
      description: toolDescription("compare_screen"),
      inputSchema: toolShapes.compare_screen,
      annotations: { readOnlyHint: true },
    },
    (args) => tools.compareScreen(args),
  );

  server.registerTool(
    "filmstrip",
    {
      title: "Filmstrip",
      description: toolDescription("filmstrip"),
      inputSchema: toolShapes.filmstrip,
    },
    (args) => tools.filmstrip(args),
  );

  server.registerTool(
    "viewer",
    {
      title: "Live viewer",
      description: toolDescription("viewer"),
      inputSchema: toolShapes.viewer,
      annotations: { readOnlyHint: true },
    },
    (args) => tools.viewer(args),
  );

  server.registerTool(
    "record",
    {
      title: "Record a script",
      description: toolDescription("record"),
      inputSchema: toolShapes.record,
    },
    (args) => tools.record(args),
  );

  server.registerTool(
    "replay",
    {
      title: "Replay a script",
      description: toolDescription("replay"),
      inputSchema: toolShapes.replay,
    },
    (args) => tools.replay(args),
  );

  server.registerTool(
    "wait_for",
    {
      title: "Wait for",
      description: toolDescription("wait_for"),
      inputSchema: toolShapes.wait_for,
      annotations: { readOnlyHint: true },
    },
    (args) => tools.waitFor(args),
  );

  server.registerTool(
    "logs",
    {
      title: "App logs",
      description: toolDescription("logs"),
      inputSchema: toolShapes.logs,
      annotations: { readOnlyHint: true },
    },
    (args) => tools.logs(args),
  );

  server.registerTool(
    "reload",
    {
      title: "Reload app",
      description: toolDescription("reload"),
      inputSchema: toolShapes.reload,
    },
    (args) => tools.reload(args),
  );

  server.registerTool(
    "wait",
    {
      title: "Wait",
      description: toolDescription("wait"),
      inputSchema: toolShapes.wait,
      annotations: { readOnlyHint: true },
    },
    (args) => tools.wait(args),
  );

  return server;
}

function log(message: string): void {
  process.stderr.write(`[tapline] ${message}\n`);
}

/** Runs the host and serves MCP over stdio. stdout is reserved for the protocol; everything else goes to stderr. */
export async function runMcp(options: ResolveOptions & { screenshots?: string; viewer?: string } = {}): Promise<boolean> {
  let screenshots: ScreenshotMode;
  let viewer: ViewerMode;
  try {
    screenshots = screenshotMode(options.screenshots, options.env);
    viewer = viewerMode(options.viewer, options.env);
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
  let hub: ViewerHub | undefined;
  const tools = new TaplineTools(host, {
    connect: { url, name: config.name },
    pairImagePath: join(configDir(), `pair-${port}.png`),
    screenshots,
    screenshotDir: join(configDir(), "shots"),
    scriptsDir: join(configDir(), "scripts"),
    baselinesDir: join(configDir(), "baselines"),
    ...(viewer === "off"
      ? {}
      : {
          control,
          onAction: (action) => hub?.pushAction(action),
          viewerLinks: () => viewerLinks,
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
    log(`live viewer: ${remoteViewer ? "this computer and your Tailscale devices" : "this computer only"} (the viewer tool gives the link)`);
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
