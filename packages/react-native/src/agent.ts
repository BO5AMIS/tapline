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

export interface AgentDeps {
  storage: TaplineStorage;
  linking: LinkingLike;
  /** Ask the user; resolves true when they agree. */
  confirm(title: string, message: string, ok: string): Promise<boolean>;
  /** Tell the user something (one alert). */
  notify(title: string, message: string): void;
  clientDeps?: ClientDeps;
  log?: (line: string) => void;
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
    });
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

  private connect(options: Pick<ClientOptions, 'url' | 'token' | 'pairCode' | 'onPaired' | 'onRejected'>): void {
    this.client?.stop();
    this.client = null;
    if (this.stopped) return;
    const client = new TaplineClient({ ...options, app: this.options.app, deviceId: this.installId }, this.deps.clientDeps);
    this.client = client;
    client.start();
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
