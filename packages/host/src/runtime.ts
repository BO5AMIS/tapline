import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { combinedRedact, loadAccounts, type AccountsLoad, type AccountStore, type GitProbe } from "./accounts.js";
import { bounded, ScheduleTimeout, VAULT_LOAD_TIMEOUT_MS } from "./runschedule.js";
import type { VaultDeps } from "./vault.js";
import { createOtpService, type OtpService } from "./otpclient.js";
import { Confirmations } from "./confirm.js";
import { ControlQueue, PhoneLease } from "./control.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ApiCredentials } from "./api.js";
import { isToolName, callTool, TOOL_META, type ToolName } from "./dispatch.js";
import { hashMapsLoaded, policyFingerprint } from "./hostfacts.js";
import { realRunner } from "./journeyexport.js";
import { MapRegistry } from "./places.js";
import { AuditLog } from "./auditlog.js";
import { GrantBook } from "./grants.js";
import { DEFAULT_POLICY, NO_POLICY, loadPolicy, type PolicyFile } from "./policy.js";
import { TaplineError, TaplineHost, type ListenResult } from "./server.js";
import { restoreAnimations } from "./animations.js";
import { TaplineTools, describeError, type ToolsOptions } from "./tools.js";
import { NO_UX_RULES, loadUxRules, type UxRules } from "./uxcheck.js";
import { VIEWER_ACCEPTS, ViewerHub, viewerStatusForHost } from "./viewer.js";
import { VIEWER_HTML } from "./viewer-page.js";

/** How long a client of the thin call may stay silent before its tools (its report, its journey) are dropped. */
export const CLIENT_IDLE_MS = 30 * 60 * 1000;

/** The pseudo-tools of `/api` a scheduled run uses on a running host (read-only facts, and the run-wide lease). */
export const HOST_FACTS_TOOL = "_host_facts";
export const LEASE_TOOL = "_lease";

/** How long a run-wide lease stands without a renewal. */
export const LEASE_TTL_MS = 45_000;

/** A path as one spelling for a comparison: its real path when it exists, else the absolute one; case folded on Windows. */
export function canonicalPath(path: string): string {
  let full: string;
  try {
    full = realpathSync.native(path);
  } catch {
    full = resolve(path);
  }
  return process.platform === "win32" ? full.toLowerCase() : full;
}

/**
 * What a running host was started with: paths and flags, and hashes of what it has LOADED (never the content). The same path is not
 * the same policy: asked for its facts, the host first reloads its policy, vault and maps from disk into its live state and reports
 * hashes of that, and a run compares them with what it would load itself.
 */
export interface HostFacts {
  version: 3;
  /** Random, made when this host started: a run pins it and every later call must reach this very host. */
  instance: string;
  /** The policy file's canonical path; null for the built-in policy. */
  policy: string | null;
  noPolicy: boolean;
  accounts: string | null;
  maps: string;
  /** sha256 of the loaded policy's canonical JSON; null for the built-in policy. */
  policyHash: string | null;
  /** HMAC-SHA256, keyed with the host token, of the decrypted vault's canonical JSON (values and per-app permissions); null when there is no vault. */
  accountsHash: string | null;
  /** sha256 over the canonical JSON of every map the host now holds (read from disk again). */
  mapsHash: string;
}

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
  /** Tests: how a one-time code is asked of Tapwright's daemon (AGENT-TOOLS 1.14 §20.4). Default: the real daemon. */
  otp?: OtpService;
  /** `--brief`: actions answer briefly unless a call says `brief: false` (AGENT-TOOLS 1.13 §13.4). */
  brief?: boolean;
  /** Tests: how a protected vault is opened (DPAPI, keychain). Default: this system's own. */
  vaultDeps?: VaultDeps;
  /** `--maps DIR`: where the apps' maps live, `<DIR>/<app id>/` (AGENT-TOOLS 1.13 §18.9). Default `~/.tapline/maps`. */
  maps?: string;
  /** Serve `POST /api/<tool>`: set by a standalone `tapline host`, never by an agent's MCP server (AGENT-TOOLS 1.13 §18.10). */
  api?: boolean;
  /** Where the host's own lines go. Default: stderr with a `[tapline]` prefix (stdout is the MCP protocol's). */
  log?: (message: string) => void;
  /** Tests: how long another client's action waits for a scheduled run's lease before it answers `busy`. Default 30 s. */
  leaseGiveUpMs?: number;
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
  /** The maps this host holds, one per app. */
  maps: MapRegistry;
  /** The policy and the vault as the host holds them now (they change when a scheduled run's facts query reloads them). */
  live: { policy(): PolicyFile; accounts(): AccountsLoad | undefined };
  /**
   * A tools object for one client; the same object for the same id. `undefined` is the connection itself (one MCP
   * server). Other ids are dropped after 30 minutes without a call.
   */
  toolsFor(clientId: string | undefined): TaplineTools;
  /** True while a person (live view) or an agent is driving the phone, or the live view has paused agents (a scheduled run waits, §22.3). */
  phoneInUse(): boolean;
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
  const instanceId = randomBytes(16).toString("hex");
  policy = options.noPolicy === true ? NO_POLICY : options.policy !== undefined ? loadPolicy(options.policy) : DEFAULT_POLICY;
  if (options.uxRules !== undefined) uxRules = loadUxRules(options.uxRules);
  // The test accounts (AGENT-TOOLS 1.13 §18.6). A refused file still starts the server, with no accounts and the reason.
  // The load is bounded: a keychain or DPAPI call that stalls is killed, and the host starts with no accounts and says why (never hangs).
  let accounts: AccountsLoad | undefined;
  if (options.accounts !== undefined) {
    const file = options.accounts;
    try {
      accounts = await bounded("loading the vault", VAULT_LOAD_TIMEOUT_MS, (signal) => loadAccounts(file, options.gitProbe, options.vaultDeps, signal));
    } catch (error) {
      if (!(error instanceof ScheduleTimeout)) throw error;
      accounts = { store: null, blocked: `the vault file can't be opened: ${error.message}` };
    }
  }
  if (accounts !== undefined) {
    const said = accounts.store === null ? accounts.blocked : accounts.note;
    if (said !== undefined) log(said);
  }

  const config = await resolveConfig(options);
  const clients = new Map<string, { tools: TaplineTools; lastUsed: number }>();
  // One-time codes (AGENT-TOOLS 1.14 §20.4): a code typed in this session is scrubbed from everything the host passes on, as a vault value is.
  const otp = options.otp ?? createOtpService({ env: options.env });
  // The policy and vault the host runs under now: a facts query reloads them from disk (reloadLive below).
  // Redaction is cumulative for the session (§20.3): a vault value that was loaded once stays scrubbed until the process ends, even
  // after a reload replaced it; only the current values can be typed. `retired` holds the stores a reload replaced.
  const retired: AccountStore[] = [];
  const retiredPrints = new Set<string>();
  const withHistory = (load: AccountsLoad): AccountsLoad => {
    if (load.store === null) return load;
    const current = load.store;
    // One scrubber over the current and every retired value, matched together against the original text (never chained).
    let built = -1;
    let combined: (text: string) => string = current.redact;
    const redact = (text: string): string => {
      if (built !== retired.length) {
        combined = retired.length === 0 ? current.redact : combinedRedact([current, ...retired]);
        built = retired.length;
      }
      return combined(text);
    };
    return { ...load, store: { ...current, redact } };
  };
  let currentRaw: AccountsLoad | undefined = accounts;
  const live: { policy: PolicyFile; accounts: AccountsLoad | undefined } = { policy, accounts: accounts === undefined ? undefined : withHistory(accounts) };
  const host = new TaplineHost({
    redact: (text: string) => otp.codes.redact(live.accounts?.store != null ? live.accounts.store.redact(text) : text),
    redactsVault: accounts?.store != null,
    token: config.token,
    port: config.port,
    portFallback: config.portFallback,
    hosts: config.hosts,
    ...(options.api === true
      ? {
          api: async (tool: string, args: Record<string, unknown>, clientId: string | undefined, signal: AbortSignal, credentials: ApiCredentials) => {
            // A caller that pinned an instance is refused by any other host: the run never falls through to one with other settings.
            if (credentials.instance !== undefined && credentials.instance !== instanceId) {
              return { content: [{ type: "text", text: "Error wrong_host: this is not the host the schedule checked (another instance answers here); nothing was run." }], isError: true };
            }
            if (tool === HOST_FACTS_TOOL) {
              // Reload first, then report what is loaded: a vault that can't be read, or a policy that no longer loads, is an error.
              try {
                return { content: [{ type: "text", text: JSON.stringify({ ...facts, ...(await reloadLive()) }) }] };
              } catch (error) {
                const why = error instanceof Error ? error.message : String(error);
                return { content: [{ type: "text", text: `Error facts_unavailable: the host could not reload what it runs under (${why}); don't reuse it.` }], isError: true };
              }
            }
            if (tool === LEASE_TOOL) return leaseCall(args, clientId, credentials.lease);
            return isToolName(tool) ? thinCall(tool, args, clientId, signal, credentials.lease) : undefined;
          },
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
  const lease = new PhoneLease({ now: clock, ...(options.leaseGiveUpMs !== undefined ? { giveUpMs: options.leaseGiveUpMs } : {}) });
  const mapsDir = options.maps ?? join(configDir(options.env), "maps");
  const facts: Omit<HostFacts, "policyHash" | "accountsHash" | "mapsHash"> = {
    version: 3,
    instance: instanceId,
    policy: options.noPolicy !== true && options.policy !== undefined ? canonicalPath(options.policy) : null,
    noPolicy: options.noPolicy === true,
    accounts: options.accounts !== undefined ? canonicalPath(options.accounts) : null,
    maps: canonicalPath(mapsDir),
  };
  const confirmations = new Confirmations();
  let hub: ViewerHub | undefined;
  const openBrowser = options.openBrowser ?? openInBrowser;

  // One map per app for every client of this host: places, roads and links grow as agents drive (§18.9).
  const maps = new MapRegistry({ mapsDir: options.maps ?? join(configDir(options.env), "maps") });

  // Grants (AGENT-TOOLS 1.14 §19) live in the policy file: no file, no grants. The audit log (§23) has no off switch.
  const audit = new AuditLog(join(configDir(options.env), "audit"));
  audit.open();
  let grants: GrantBook | undefined;
  if (options.noPolicy !== true && options.policy !== undefined) {
    grants = new GrantBook({ policyPath: options.policy, audit });
    // Prune at start (§19.4): the uses of a grant that has ended or was revoked.
    void grants.prune().catch(() => undefined);
  }
  const fixedOptions: Omit<ToolsOptions, "policy" | "accounts"> = {
    maps,
    audit,
    otp,
    lease,
    ...(grants !== undefined ? { grants } : {}),
    ...(options.brief === true ? { brief: true } : {}),
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
  // Every tools object reads the policy and the vault through these getters, so a reload reaches the ones already made.
  const optionsWith = (extra: Partial<ToolsOptions>): ToolsOptions => ({
    ...fixedOptions,
    ...extra,
    get policy(): PolicyFile {
      return live.policy;
    },
    get accounts(): AccountsLoad | undefined {
      return live.accounts;
    },
  });
  // The connection's own tools: what an MCP server uses, and what the live viewer's person input goes through.
  const primary = new TaplineTools(host, optionsWith({}));

  // Serialized: two facts queries must not discard each other's freshly loaded maps.
  let reloading: Promise<unknown> = Promise.resolve();
  /**
   * Reads the policy, the vault (decrypting it again) and the maps from disk into the live state, and answers hashes of what is now
   * loaded. Rejects, changing nothing that was loaded before, when the policy or the vault can't be read.
   */
  function reloadLive(): Promise<Pick<HostFacts, "policyHash" | "accountsHash" | "mapsHash">> {
    const run = async (): Promise<Pick<HostFacts, "policyHash" | "accountsHash" | "mapsHash">> => {
      const nextPolicy = options.noPolicy !== true && options.policy !== undefined ? loadPolicy(options.policy) : null;
      let nextAccounts: AccountsLoad | undefined;
      let accountsHash: string | null = null;
      if (options.accounts !== undefined) {
        const loaded = await bounded("loading the vault", VAULT_LOAD_TIMEOUT_MS, (signal) => loadAccounts(options.accounts as string, options.gitProbe, options.vaultDeps, signal));
        if (loaded.store === null) throw new Error(loaded.blocked.replace(/[.\s]+$/, ""));
        if (loaded.fingerprint === undefined) throw new Error("the vault can't be fingerprinted");
        accountsHash = loaded.fingerprint(config.token);
        nextAccounts = loaded;
      }
      if (nextPolicy !== null) live.policy = nextPolicy;
      if (nextAccounts !== undefined) {
        const before = currentRaw;
        if (before?.store != null && nextAccounts.store !== null) {
          const oldPrint = before.fingerprint?.(config.token);
          const newPrint = nextAccounts.fingerprint?.(config.token);
          if ((oldPrint === undefined || oldPrint !== newPrint) && (oldPrint === undefined || !retiredPrints.has(oldPrint))) {
            retired.push(before.store);
            if (oldPrint !== undefined) retiredPrints.add(oldPrint);
          }
        }
        currentRaw = nextAccounts;
        live.accounts = withHistory(nextAccounts);
      }
      await maps.reload();
      const mapsHash = hashMapsLoaded(mapsDir, (app) => {
        const map = maps.forApp({ id: app, name: app });
        return map === undefined ? null : { status: map.loadedStatus(), data: map.data() };
      });
      return { policyHash: nextPolicy === null ? null : policyFingerprint(nextPolicy), accountsHash, mapsHash };
    };
    const answer = reloading.then(run, run);
    reloading = answer.catch(() => undefined);
    return answer;
  }

  /** Every call through `/api` is a thin call: the log says so, and the report flags a run of them (§16.1). */
  function thinCall(tool: ToolName, args: Record<string, unknown>, clientId: string | undefined, signal: AbortSignal, leaseCredential?: string): Promise<CallToolResult> {
    // A credential that is not the standing holder's (expired included) is a run that lost the phone: refused, even when no one holds the lease now.
    try {
      lease.assertCurrent(leaseCredential);
    } catch (error) {
      if (!(error instanceof TaplineError)) throw error;
      return Promise.resolve({ content: [{ type: "text", text: describeError(error) }], isError: true });
    }
    // A thin call never uses the MCP server's tools: those hold its dialog and the OKs given for its calls.
    const tools = toolsFor(clientId ?? ANONYMOUS_CLIENT);
    // Calls that share a tools object run one after another: they share its per-call state (a run's account).
    const before = lanes.get(tools) ?? Promise.resolve();
    // A call whose client left while it waited in the line is dropped before it starts; a running one is told to stop waiting.
    // Every tool that changes anything waits behind a scheduled run's lease (not only the touches); the holder's credential goes through.
    const run = (): Promise<CallToolResult> => tools.asThinCall(() => callTool(tools, tool, args));
    const mutating = !TOOL_META[tool].readOnly;
    // A lease that stays held for the whole wait answers `busy`, as a tool does for its own refusals.
    const gated = (): Promise<CallToolResult> =>
      tools.leaseGate(run).catch((error: unknown): CallToolResult => {
        if (!(error instanceof TaplineError)) throw error;
        return { content: [{ type: "text", text: describeError(error) }], isError: true };
      });
    const answer = before.then(() => (signal.aborted ? CANCELLED : tools.withCall(signal, () => (mutating ? gated() : run()), leaseCredential)));
    lanes.set(tools, answer.then(() => undefined, () => undefined));
    return answer;
  }
  const lanes = new WeakMap<TaplineTools, Promise<void>>();

  /**
   * `_lease {action: "acquire" | "renew" | "release"}`: a scheduled run's hold on the phone (§22.3). The first acquire answers an
   * unguessable credential; renew and release (and every call the run makes) must present it, and a client label alone never counts.
   */
  function leaseCall(args: Record<string, unknown>, clientId: string | undefined, credential: string | undefined): CallToolResult {
    const owner = clientId ?? ANONYMOUS_CLIENT;
    const reply = (body: Record<string, unknown>, isError = false): CallToolResult => ({
      content: [{ type: "text", text: JSON.stringify(body) }],
      ...(isError ? { isError: true } : {}),
    });
    const action = args["action"];
    if (action === "release") return reply({ ok: lease.release(credential) });
    if (action === "acquire" || action === "renew") {
      const ttl = typeof args["ttl_ms"] === "number" ? args["ttl_ms"] : LEASE_TTL_MS;
      if (action === "renew") return reply(lease.renew(credential, ttl) ? { ok: true } : { ok: false, by: "lost" });
      const taken = lease.acquire(owner, ttl, control.driver() === "person" || control.paused(), credential);
      if (!taken.ok) return reply({ ok: false, by: taken.by });
      return reply(credential === undefined ? { ok: true, credential: taken.credential } : { ok: true });
    }
    return reply({ error: "action is acquire, renew or release" }, true);
  }

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
    const tools = new TaplineTools(host, optionsWith({ clientId: () => clientId, confirmScope: "api" }));
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
    maps,
    live: { policy: () => live.policy, accounts: () => live.accounts },
    toolsFor,
    phoneInUse: () => control.driver() !== null || control.paused(),
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
