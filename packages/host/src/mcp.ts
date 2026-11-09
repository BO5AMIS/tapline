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
import { ViewerHub, viewerStatusFor } from "./viewer.js";
import { VIEWER_HTML } from "./viewer-page.js";
import { TaplineHost } from "./server.js";
import { TaplineTools, toolShapes } from "./tools.js";

const INSTRUCTIONS = [
  "Tapline lets you see and drive the user's own mobile app running on their phone.",
  'Start with `apps` to see what is connected (if nothing is, `pair` makes a QR code the user scans with the phone), then `look` to read the screen (element refs like "e3" plus a screenshot).',
  "Act with press / type_text / scroll / toggle / open_url using a target: prefer {ref} or {testID} from the latest look.",
  "Every action returns what changed since the last list (added +, gone -, changed ~, moved ↕; unchanged elements keep their refs), or the full list when the screen changed. It has no screenshot: drive by text and call `look` when you need to see the screen.",
  "Actions refuse what a person couldn't tap (off screen, or covered by something on top) and say why; scroll or dismiss first, or pass force: true. `back` goes back like the back button; native tab bars appear as `tab` elements you can press. The `Route:` line names the screen.",
  "Use `wait_for` (an element appears or is gone, or the network is quiet) rather than fixed waits. An `Alert:` line is an alert the app showed: an OS alert needs the user to tap it; Tapline's stand-in alert has buttons you press. `app_command` lists and runs the app's test commands (and `appearance` light/dark).",
  "Screenshots cost image tokens: skip them with screenshot:false, shrink them with width (300 is enough for a layout), and hand them to a smaller model when you can (see the Tapline guide for agents).",
].join(" ");

/** Registers every Tapline tool on an MCP server. */
export function createMcpServer(tools: TaplineTools): McpServer {
  const server = new McpServer({ name: "tapline", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "apps",
    {
      title: "Connected apps",
      description:
        "List the apps currently connected to Tapline (name, id, version, device, how long connected) and which one is selected. Other tools act on the selected app. If none is connected, explains how to connect one.",
      inputSchema: toolShapes.apps,
      annotations: { readOnlyHint: true },
    },
    () => tools.apps(),
  );

  server.registerTool(
    "select_app",
    {
      title: "Select app",
      description: "Choose which connected app the other tools act on, by session id from `apps`. By default the most recently connected app is used.",
      inputSchema: toolShapes.select_app,
    },
    (args) => tools.selectApp(args),
  );

  server.registerTool(
    "pair",
    {
      title: "Pair a phone",
      description:
        'Make a pairing link and QR code for the user\'s phone (valid 10 minutes, works once). The user scans it with the phone\'s camera and taps Connect in the app; from then on the app reconnects to this computer by itself. Needs the app\'s URL scheme ("scheme" in app.json, e.g. "myapp"). Show the user the QR code.',
      inputSchema: toolShapes.pair,
    },
    (args) => tools.pair(args),
  );

  server.registerTool(
    "look",
    {
      title: "Look at the screen",
      description:
        'Read the current screen of the app: one line per element, e.g. `e3 button "Log in" testID=login-button @24,610 354x48 [press, longPress]` (ref, role, text, testID, position x,y and size in points, available actions), plus a screenshot when the app supports it (an image, or a file path when the host runs with --screenshots file; `width` sets its size, `screenshot: false` skips it, `labels: true` draws each tappable element\'s box and ref on it). Use the ref or testID as a target for actions.',
      inputSchema: toolShapes.look,
      annotations: { readOnlyHint: true },
    },
    (args) => tools.look(args),
  );

  server.registerTool(
    "check_layout",
    {
      title: "Check the layout",
      description:
        "Automatic visual checks of the current screen, from the element tree (no screenshot, so cheap): tap areas under 44x44 pt, elements cut off at the screen's left or right edge, overlapping elements, text contrast below WCAG (4.5:1, 3:1 for large text), buttons with no text or label (VoiceOver reads nothing), and text likely cut off by numberOfLines. Findings name elements by ref from the latest list.",
      inputSchema: toolShapes.check_layout,
      annotations: { readOnlyHint: true },
    },
    (args) => tools.checkLayout(args),
  );

  server.registerTool(
    "press",
    {
      title: "Press",
      description:
        "Press (tap) an element by calling its onPress. Target by {ref}, {testID}, {label}, {text, index?} or {x, y}. Returns the result and the fresh element list (no screenshot; call look for one). Errors: not_found, ambiguous (candidates listed), not_actionable (e.g. disabled).",
      inputSchema: toolShapes.press,
    },
    (args) => tools.press(args),
  );

  server.registerTool(
    "long_press",
    {
      title: "Long press",
      description: "Long-press an element by calling its onLongPress. Same targets as `press`. Returns the result and the fresh element list (no screenshot; call look for one).",
      inputSchema: toolShapes.long_press,
    },
    (args) => tools.longPress(args),
  );

  server.registerTool(
    "type_text",
    {
      title: "Type text",
      description:
        "Enter text into a text input. Without `target` it uses the focused input, else the only input on screen. `replace` (default true) replaces the existing text, false appends. `submit` also triggers the keyboard's submit action. Returns the new value and the fresh element list.",
      inputSchema: toolShapes.type_text,
    },
    (args) => tools.typeText(args),
  );

  server.registerTool(
    "scroll",
    {
      title: "Scroll",
      description:
        "Scroll a scroll view / list. Give `direction` (+ optional `amount` in points) or `to` ('start' | 'end'). Without `target` it scrolls the largest scroll view on screen. Returns the new offset and the fresh element list.",
      inputSchema: toolShapes.scroll,
    },
    (args) => tools.scroll(args),
  );

  server.registerTool(
    "toggle",
    {
      title: "Toggle",
      description: "Set a switch/checkbox. `value` true/false sets it; omit to flip it. Returns the new state and the fresh element list.",
      inputSchema: toolShapes.toggle,
    },
    (args) => tools.toggle(args),
  );

  server.registerTool(
    "open_url",
    {
      title: "Open URL",
      description: 'Open a URL or deep link inside the app (Linking.openURL), e.g. "myapp://settings". Returns the fresh element list.',
      inputSchema: toolShapes.open_url,
    },
    (args) => tools.openUrl(args),
  );

  server.registerTool(
    "back",
    {
      title: "Back",
      description:
        "Go back from the focused screen, as the back button or swipe would (React Navigation / Expo Router apps). Returns the fresh element list. not_actionable when there is nothing to go back to.",
      inputSchema: toolShapes.back,
    },
    (args) => tools.back(args),
  );

  server.registerTool(
    "app_command",
    {
      title: "App command",
      description:
        "Commands the app offers for testing (registered with registerTaplineCommand), such as switching the language, signing in as a test user or loading sample data. Without `name`: lists them with their descriptions. With `name` (and `args`): runs it, returns its result and what changed on screen. Built in: appearance { scheme: light | dark | system }.",
      inputSchema: toolShapes.app_command,
    },
    (args) => tools.appCommand(args),
  );

  server.registerTool(
    "compare_screen",
    {
      title: "Compare with a reference",
      description:
        "Visual regression check: the first time (or with update: true) it saves the screen as the reference picture for `name`; after that it compares the screen with it pixel by pixel and reports how much changed, where (regions in points, with the elements there), and an image of the screen with the changes in red. Keep the same width for a name.",
      inputSchema: toolShapes.compare_screen,
      annotations: { readOnlyHint: true },
    },
    (args) => tools.compareScreen(args),
  );

  server.registerTool(
    "filmstrip",
    {
      title: "Filmstrip",
      description:
        "Several screenshots in a row, combined into one numbered image (cheaper than separate screenshots): for animations, transitions and loading states. `press` first presses an element, then films what it sets off.",
      inputSchema: toolShapes.filmstrip,
    },
    (args) => tools.filmstrip(args),
  );

  server.registerTool(
    "viewer",
    {
      title: "Live viewer",
      description:
        "The link to the live viewer: the user watches the app in a browser as you work (your actions are shown), and can tap, scroll and type on it too; their touches go first and your actions wait, and they can pause you. Give the link to the user only (it carries a key). While frames are on, also reports capture time and stutter.",
      inputSchema: toolShapes.viewer,
      annotations: { readOnlyHint: true },
    },
    (args) => tools.viewer(args),
  );

  server.registerTool(
    "record",
    {
      title: "Record a script",
      description:
        'Record a test run as a script you can replay without an AI: { action: "start", name } begins, every action after it (press, type_text, scroll, toggle, open_url, back, app_command, wait_for, wait) becomes a step, { action: "stop" } saves it. Targets are saved by testID, else label, else text (refs only work for one run). Use wait_for steps as checks. Also status and discard.',
      inputSchema: toolShapes.record,
    },
    (args) => tools.record(args),
  );

  server.registerTool(
    "replay",
    {
      title: "Replay a script",
      description:
        "Run a recorded script step by step on the connected app and report each step. It stops at the first step that fails or ends on a different screen (route) than when it was recorded. Without `name`: lists saved scripts.",
      inputSchema: toolShapes.replay,
    },
    (args) => tools.replay(args),
  );

  server.registerTool(
    "wait_for",
    {
      title: "Wait for",
      description:
        "Wait until something is on screen (text contains, testID or label), or gone with `gone: true` (a spinner), and/or until no network request is in flight (`network_idle`). Polls up to `timeout` seconds (default 10). Better than a fixed `wait`: it returns as soon as the app is ready. Returns what changed on screen; error timeout when it didn't happen.",
      inputSchema: toolShapes.wait_for,
    },
    (args) => tools.waitFor(args),
  );

  server.registerTool(
    "logs",
    {
      title: "App logs",
      description:
        "Recent console output and JS errors from the app (last 500). Pass `since` (epoch ms) to get only newer lines; each result ends with the latest timestamp to reuse.",
      inputSchema: toolShapes.logs,
      annotations: { readOnlyHint: true },
    },
    (args) => tools.logs(args),
  );

  server.registerTool(
    "reload",
    {
      title: "Reload app",
      description:
        "Reload the JavaScript bundle (development builds only). Waits for the app to reconnect, then returns the fresh element list. TestFlight/production builds answer `unsupported`.",
      inputSchema: toolShapes.reload,
    },
    (args) => tools.reload(args),
  );

  server.registerTool(
    "wait",
    {
      title: "Wait",
      description: "Wait 0.1 to 30 seconds (for animations, network, navigation), then return the fresh element list.",
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
      accepts: ["tap", "longPress", "scroll", "text", "enter", "backspace", "quality"],
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
    const appStatus = (): void => live.setStatus(viewerStatusFor(host.current()));
    host.on("connect", appStatus);
    host.on("disconnect", appStatus);
    host.on("appState", appStatus);
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
