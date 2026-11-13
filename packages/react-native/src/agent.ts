import { CLOSE_BAD_TOKEN, TaplineClient, type ClientDeps, type ClientOptions } from './client';
import { parseTaplineLink } from './link';
import { originalLog } from './logs';
import type { TaplineStorage } from './storage';
import { isRecord, type AppInfo } from './types';

export const PAIRING_KEY = 'tapline.pairing';
export const INSTALL_KEY = 'tapline.install';

/** The computer this app is paired with. */
export interface Pairing {
  url: string;
  token: string;
  name: string;
  /** The one-time code this pairing was made with: a launch link carrying it again is already handled. */
  code?: string;
}

/** The slice of React Native's Linking that Tapline uses. */
export interface LinkingLike {
  getInitialURL(): Promise<string | null | undefined>;
  addEventListener(type: 'url', listener: (event: { url: string }) => void): { remove(): void };
}

export interface AgentOptions {
  app?: AppInfo;
  /** Connect straight to this host instead of pairing. */
  direct?: { url: string; token: string };
}

/** A development offer (Tapline 1.1): what the computer serving this app's JavaScript lets it fetch after `pair`. */
export interface DevOffer {
  code: string;
  name: string;
  /** The host's port, when Metro passes the offer on (the host may listen where Metro is the only way in). */
  port?: number;
}

/** Where development offers come from: the computer Metro serves this app's code from. */
export interface OfferSource {
  /** Metro's host (an IP or name) and port, or null when the code isn't loaded from a development server. */
  devServer(): { host: string; port: number } | null;
  /** The offer at http://host:port/tapline/offer (Metro's or a host's), or null (none open, nothing there, timeout). */
  fetchOffer(host: string, port: number, timeoutMs: number): Promise<DevOffer | null>;
  /** False while the app is in the background: no polling then. */
  active?(): boolean;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

/** The ports a Tapline host takes (7210, else up to 7219). */
export const HOST_PORTS = [7210, 7211, 7212, 7213, 7214, 7215, 7216, 7217, 7218, 7219];

/** Loopback (a simulator) or a private LAN address; never Tailscale or the internet: offers stay on the Wi-Fi. */
export function isLocalNetworkHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
  }
  // unique-local IPv6, but not Tailscale's own range (fd7a:115c:a1e0::/48)
  return (/^f[cd][0-9a-f]{2}:/.test(h) && !h.startsWith('fd7a:115c:a1e0:')) || h.startsWith('fe80:');
}

export interface AgentDeps {
  storage: TaplineStorage;
  linking: LinkingLike;
  /** Ask the user; resolves true when they agree. */
  confirm(title: string, message: string, ok: string): Promise<boolean>;
  /** Tell the user something (one alert). */
  notify(title: string, message: string): void;
  clientDeps?: ClientDeps;
  log?: (line: string) => void;
  /** Zero-QR pairing in development builds; absent in other builds. */
  offers?: OfferSource;
}

function randomId(): string {
  let id = '';
  while (id.length < 12) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

/** host:port of a ws:// URL. */
function addressOf(url: string): string {
  return /^wss?:\/\/([^/?#]+)/i.exec(url)?.[1] ?? url;
}

/** True for loopback, Tailscale (100.64.0.0/10, *.ts.net, fd7a:115c:a1e0::/48) and private LAN addresses. */
export function isNearbyAddress(address: string): boolean {
  const host = (address.startsWith('[') ? address.slice(1, address.indexOf(']')) : address.replace(/:\d+$/, '')).toLowerCase();
  if (host === 'localhost' || host.endsWith('.ts.net') || host.endsWith('.local')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 127 ||
      a === 10 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    );
  }
  return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || host.startsWith('fe80:');
}

function readPairing(raw: string | null): Pairing | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value) && typeof value.url === 'string' && typeof value.token === 'string') {
      const pairing: Pairing = { url: value.url, token: value.token, name: typeof value.name === 'string' ? value.name : 'a computer' };
      if (typeof value.code === 'string' && value.code !== '') pairing.code = value.code;
      return pairing;
    }
  } catch {
    // a broken entry: treat as not paired
  }
  return null;
}

/** How long an accepted offer may go without a welcome before the agent gives up on it and resumes the saved home. */
export const OFFER_PAIR_TIMEOUT_MS = 15_000;

/**
 * The in-app side of pairing: connects to the remembered computer, and handles pairing and
 * forget links (asking the user before connecting anywhere new). Work runs one step at a time.
 */
export class TaplineAgent {
  private client: TaplineClient | null = null;
  private subscription: { remove(): void } | null = null;
  private pairing: Pairing | null = null;
  private installId: string | undefined;
  private stopped = false;
  private chain: Promise<void> = Promise.resolve();
  /** Pairing codes already handled: the launch link can arrive twice (initial URL and event). */
  private readonly seenCodes = new Set<string>();
  private offerTimer: unknown = null;
  private offerStarted = 0;
  private asking = false;
  private pairTimer: unknown = null;

  constructor(
    private readonly options: AgentOptions,
    private readonly deps: AgentDeps,
  ) {}

  /** Resolves once the remembered computer is dialled and the launch link handled. Never rejects. */
  start(): Promise<void> {
    try {
      this.subscription = this.deps.linking.addEventListener('url', (event) => {
        void this.handleUrl(event.url);
      });
    } catch {
      // no link events: only the launch link can pair
    }
    return this.enqueue(async () => {
      this.installId = await this.loadInstallId();
      if (this.stopped) return;
      if (!this.options.direct) {
        this.pairing = readPairing(await this.deps.storage.getItem(PAIRING_KEY).catch(() => null));
      }
      this.reconnectHome();
      const initial = await this.deps.linking.getInitialURL().catch(() => null);
      if (typeof initial === 'string' && initial !== '') await this.onLink(initial, true);
      this.watchOffers();
    });
  }

  /**
   * Zero-QR pairing (Tapline 1.1): while this development build isn't paired, it looks for an offer from the
   * computer its code comes from (every 2 s for a minute, then every 5 s). The person still taps Connect.
   */
  private watchOffers(): void {
    const offers = this.deps.offers;
    if (offers === undefined || this.options.direct || this.stopped) return;
    const server = offers.devServer();
    if (server === null || !isLocalNetworkHost(server.host)) return;
    this.offerStarted = Date.now();
    this.scheduleOffer(offers, server, 0);
  }

  private scheduleOffer(offers: OfferSource, host: { host: string; port: number }, ms: number): void {
    if (this.stopped) return;
    const set = offers.setTimeout ?? ((fn: () => void, wait: number) => setTimeout(fn, wait));
    this.offerTimer = set(() => {
      this.offerTimer = null;
      void this.checkOffer(offers, host);
    }, ms);
  }

  private async checkOffer(offers: OfferSource, server: { host: string; port: number }): Promise<void> {
    if (this.stopped) return;
    const next = Date.now() - this.offerStarted < 60_000 ? 2000 : 5000;
    if (this.holdsLiveHome() || this.asking || (offers.active !== undefined && !offers.active())) {
      this.scheduleOffer(offers, server, next);
      return;
    }
    const { host } = server;
    // Metro first (the phone always reaches it), then the ports a host takes.
    const viaMetro = await offers.fetchOffer(host, server.port, 1500).catch(() => null);
    let hit: { offer: DevOffer; port: number } | null =
      viaMetro !== null && typeof viaMetro.port === 'number' && !this.seenCodes.has(viaMetro.code) ? { offer: viaMetro, port: viaMetro.port } : null;
    if (hit === null) {
      const found = await Promise.all(
        HOST_PORTS.map((port) => offers.fetchOffer(host, port, 1500).then((offer) => (offer ? { offer, port } : null), () => null)),
      );
      hit = found.find((f): f is { offer: DevOffer; port: number } => f !== null && !this.seenCodes.has(f.offer.code)) ?? null;
    }
    if (hit !== null && !this.holdsLiveHome() && !this.stopped) {
      const chosen = hit;
      await this.enqueue(() => this.onOffer(host, chosen.port, chosen.offer));
    }
    this.scheduleOffer(offers, server, next);
  }

  /**
   * A saved pairing whose computer answers. One that doesn't (its host stopped, or moved to another port) no longer
   * blocks an offer from the computer this app's code comes from: the person is still asked before connecting.
   */
  private holdsLiveHome(): boolean {
    return this.pairing !== null && this.client !== null && this.client.connected;
  }

  private async onOffer(host: string, port: number, offer: DevOffer): Promise<void> {
    // Skipped here, the offer stays eligible: it is remembered only once the person is actually asked.
    if (this.stopped || this.holdsLiveHome()) return;
    this.seenCodes.add(offer.code);
    // The address is Metro's own: the computer that already runs this app's code, never one the offer names.
    const url = `ws://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}/`;
    this.asking = true;
    let agreed = false;
    try {
      agreed = await this.deps.confirm(
        'Connect for testing?',
        `${offer.name} (${host}), the computer this app's code comes from, will be able to see and use this app while it is open. Only connect to your own computer.`,
        'Connect',
      );
    } finally {
      this.asking = false;
    }
    if (!agreed || this.stopped) return;
    // The saved home may have reconnected while the person decided: never replace a working connection.
    if (this.holdsLiveHome()) return;
    const name = offer.name;
    const client = this.connect({
      url,
      pairCode: offer.code,
      onPaired: (token) => {
        this.clearPairTimer();
        void this.enqueue(() => this.remember({ url, token, name, code: offer.code }));
      },
      onRejected: () => this.onPairingRefused(name),
    });
    if (client !== null) this.watchPairing(client);
  }

  /**
   * The offered computer may never answer, and a client retries without limit. If it hasn't paired within
   * OFFER_PAIR_TIMEOUT_MS it is stopped and the saved home (if any) resumes. The saved pairing stays in storage
   * until the new one succeeds.
   */
  private watchPairing(client: TaplineClient): void {
    this.clearPairTimer();
    const set = this.deps.offers?.setTimeout ?? ((fn: () => void, wait: number) => setTimeout(fn, wait));
    this.pairTimer = set(() => {
      this.pairTimer = null;
      if (this.stopped || this.client !== client || client.connected) return;
      this.log('the offered computer did not answer; going back to the saved one');
      this.reconnectHome();
    }, OFFER_PAIR_TIMEOUT_MS);
  }

  private clearPairTimer(): void {
    if (this.pairTimer === null) return;
    const clear = this.deps.offers?.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    clear(this.pairTimer);
    this.pairTimer = null;
  }

  /** Connects to the direct host, else the paired computer, if there is one. */
  private reconnectHome(): void {
    const direct = this.options.direct;
    const home = direct ?? this.pairing;
    if (home === null) {
      this.client?.stop();
      this.client = null;
      return;
    }
    const name = direct ? 'the computer' : (this.pairing?.name ?? 'the computer');
    this.connect({ url: home.url, token: home.token, onRejected: (code) => this.onTokenRefused(code, name) });
  }

  stop(): void {
    this.stopped = true;
    this.clearPairTimer();
    if (this.offerTimer !== null) {
      const clear = this.deps.offers?.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
      clear(this.offerTimer);
      this.offerTimer = null;
    }
    try {
      this.subscription?.remove();
    } catch {
      // ignore
    }
    this.subscription = null;
    this.client?.stop();
    this.client = null;
  }

  /** Handles a pairing or forget link; other links are ignored. */
  handleUrl(url: string): Promise<void> {
    return this.enqueue(() => this.onLink(url));
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task).catch((error: unknown) => {
      this.log(`pairing step failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.chain = next;
    return next;
  }

  private log(line: string): void {
    try {
      (this.deps.log ?? originalLog)(`[tapline] ${line}`);
    } catch {
      // never throw into the app
    }
  }

  private connect(options: Pick<ClientOptions, 'url' | 'token' | 'pairCode' | 'onPaired' | 'onRejected'>): TaplineClient | null {
    this.clearPairTimer();
    this.client?.stop();
    this.client = null;
    if (this.stopped) return null;
    const client = new TaplineClient({ ...options, app: this.options.app, deviceId: this.installId }, this.deps.clientDeps);
    this.client = client;
    client.start();
    return client;
  }

  /**
   * `launch`: the link the app was opened by. Expo Go hands that same link to every reload of the
   * project, so a launch link this phone has already acted on is not acted on again.
   */
  private async onLink(url: string, launch = false): Promise<void> {
    if (this.stopped) return;
    const link = parseTaplineLink(url);
    if (link === null) return;
    if (link.kind === 'forget') {
      if (launch && this.pairing === null && !this.options.direct) return; // forgotten already
      await this.forget();
      return;
    }
    if (this.seenCodes.has(link.code)) return;
    this.seenCodes.add(link.code);
    if (this.pairing?.code === link.code) {
      this.log(`this pairing link was used already: paired with ${this.pairing.name}`);
      return;
    }
    // At launch, a link to the computer this phone is already paired with needs no question: Expo Go
    // hands every reload the link it was opened by, and a pairing saved before codes were kept can't
    // recognise its code. A link opened while the app runs still asks (re-pairing on purpose).
    if (launch && this.pairing !== null && this.pairing.url === link.url) {
      this.log(`already paired with ${this.pairing.name}`);
      return;
    }
    const address = addressOf(link.url);
    const warning = isNearbyAddress(address)
      ? ''
      : ' Careful: this address is not on your Tailscale network or your local network.';
    const agreed = await this.deps.confirm(
      'Connect for testing?',
      `${link.name} (${address}) will be able to see and use this app while it is open.${warning} ` +
        'Only connect to your own computer.',
      'Connect',
    );
    if (!agreed || this.stopped) return;
    const { url: hostUrl, name } = link;
    this.connect({
      url: hostUrl,
      pairCode: link.code,
      onPaired: (token) => {
        // In the queue, so a forget link that follows can't be undone by a late save.
        void this.enqueue(() => this.remember({ url: hostUrl, token, name, code: link.code }));
      },
      onRejected: () => this.onPairingRefused(name),
    });
  }

  private async remember(pairing: Pairing): Promise<void> {
    if (this.stopped) return;
    this.pairing = pairing;
    this.log(`paired with ${pairing.name}`);
    try {
      await this.deps.storage.setItem(PAIRING_KEY, JSON.stringify(pairing));
    } catch {
      this.log('could not save the pairing; it lasts until the app restarts');
    }
  }

  private onPairingRefused(name: string): void {
    if (this.stopped) return;
    this.deps.notify(
      'Tapline',
      `The pairing code from ${name} has expired or was already used. Make a new one on the computer and scan or open it again.`,
    );
    this.reconnectHome();
  }

  private onTokenRefused(code: number, name: string): void {
    if (this.stopped || code !== CLOSE_BAD_TOKEN) return;
    this.client = null;
    if (!this.options.direct && this.pairing !== null) {
      // The key is dead: forget it, so the computer's next pairing link is asked about, even at launch.
      this.pairing = null;
      void this.enqueue(() => this.deps.storage.removeItem(PAIRING_KEY).catch(() => undefined));
    }
    this.deps.notify(
      'Tapline',
      `${name} no longer accepts this phone (its Tapline key changed). Scan or open a new pairing code from it to connect again.`,
    );
  }

  private async forget(): Promise<void> {
    const name = this.options.direct ? 'the computer' : this.pairing?.name;
    this.client?.stop();
    this.client = null;
    this.pairing = null;
    await this.deps.storage.removeItem(PAIRING_KEY).catch(() => undefined);
    if (this.stopped) return;
    this.deps.notify(
      'Tapline',
      name !== undefined
        ? `Disconnected from ${name}. Scan or open a new pairing code to connect again.`
        : 'This app was not paired with a computer.',
    );
  }

  private async loadInstallId(): Promise<string> {
    try {
      const saved = await this.deps.storage.getItem(INSTALL_KEY);
      if (saved !== null && /^[0-9a-f]{12}$/.test(saved)) return saved;
      const id = randomId();
      await this.deps.storage.setItem(INSTALL_KEY, id);
      return id;
    } catch {
      return randomId();
    }
  }
}
