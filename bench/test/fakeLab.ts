import type { CallResult, ToolSession } from "../src/mcp.js";

/** A small model of the lab screen: enough to answer like a tool and to hit-test a viewer tap. */

export const W = 440;
export const H = 956;
const BAR = 100;

interface El {
  id: string;
  text?: string;
  role: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fixed?: boolean;
  disabled?: boolean;
  sheet?: boolean;
}

const col = (id: string, y: number, extra: Partial<El> = {}): El => ({
  id,
  role: "button",
  x: 80,
  y,
  w: 280,
  h: 40,
  ...extra,
});

function buildElements(): El[] {
  const els: El[] = [
    col("lab-under-header", 50),
    col("lab-taps", 150),
    col("lab-save", 200, { w: 130 }),
    col("lab-cancel", 200, { x: 230, w: 130 }),
    col("lab-dup-1", 300, { text: "Duplicate" }),
    col("lab-dup-2", 350, { text: "Duplicate" }),
    col("lab-disabled", 400, { disabled: true }),
    col("lab-input", 450, { role: "input" }),
    col("lab-input-2", 500, { role: "input" }),
    col("lab-switch", 550, { role: "switch" }),
    col("lab-anim-toggle", 600, { role: "switch" }),
    col("lab-covered", 650),
    col("lab-open-sheet", 700),
    col("lab-alert", 750),
    col("lab-native-alert", 830),
    col("lab-share", 960),
    col("lab-long", 1010),
    col("lab-reset", 1060),
    col("lab-fineprint", 1110, { role: "text" }),
    { id: "lab-edge-tl", role: "button", x: 0, y: 100, w: 60, h: 40, fixed: true },
    { id: "lab-edge-tr", role: "button", x: 380, y: 100, w: 60, h: 40, fixed: true },
    { id: "lab-edge-bl", role: "button", x: 0, y: 900, w: 60, h: 40, fixed: true },
    { id: "lab-edge-br", role: "button", x: 380, y: 900, w: 60, h: 40, fixed: true },
    { id: "lab-sheet-button", role: "button", x: 80, y: 400, w: 280, h: 40, fixed: true, sheet: true },
    { id: "lab-sheet-close", role: "button", x: 80, y: 460, w: 280, h: 40, fixed: true, sheet: true },
  ];
  for (let n = 1; n <= 40; n++) {
    els.push(col(`lab-row-${n}`, 1160 + (n - 1) * 40, { text: `Row ${n}`, h: 36, role: "text" }));
  }
  els.push(col("lab-bottom", 2800));
  return els;
}

export interface Bugs {
  /** A tap on lab-covered succeeds. */
  falseSuccessCovered?: boolean;
  /** With the sheet open, taps behind it answer not_found. */
  notFoundBehindSheet?: boolean;
  /** A viewer tap under the navigation bar lands on lab-under-header (a real miss). */
  barLetsTouchThrough?: boolean;
  /**
   * The tool doesn't see the OS share sheet: look lists the lab as usual, and a tap on a lab element
   * lands on a share target, which opens another app (the incident this guards against).
   */
  shareTouchThrough?: boolean;
  /**
   * Behind OS-drawn UI (the share sheet, a native alert) a tap answers the right refusal but presses
   * the element anyway. The cover hides lab-state, so only a read after it closes shows it.
   */
  pressesBehindCover?: boolean;
}

export const LAB_APP = "Lab (com.example.lab)";
export const OTHER_APP = "Other (com.example.other)";

export interface FakeOptions {
  bugs?: Bugs;
  /** The tool lists `alert`. */
  alertTool?: boolean;
  /** The tool has no listTools at all. */
  noListTools?: boolean;
  viewerLink?: string;
  /** look cuts the state text after this many characters and adds an ellipsis. */
  truncateStateAt?: number;
  /**
   * The share sheet as iOS 26 shows it: a popover over a full-screen dismiss region. A tap in the
   * region outside the sheet closes it; `alert dismiss` doesn't.
   */
  popoverShare?: boolean;
  /**
   * lab-state scrolls with the lab, as on the phone: off the top it isn't listed, and `wait_for`
   * (which sees only what's on screen) can't read it.
   */
  stateScrolls?: boolean;
  /**
   * Lists `lab-freeze` (below lab-reset): a tap blocks the app for `ms` of real time, and then
   * `froze` goes up by one. How the tool answers during the freeze depends on `kind`:
   * - `in-app` (like Tapline): the tap itself and every call until the freeze ends answer not_answering;
   * - `real-touch` (like a fixed Tapwright): the tap succeeds, `look` and `wait_for` answer not_answering;
   * - `hangs`: the tap succeeds, a `look` answers only when the freeze is over;
   * - `silent-success`: the tap succeeds, but nothing froze (`froze` stays 0).
   */
  freeze?: { ms: number; kind: "in-app" | "real-touch" | "hangs" | "silent-success" };
}

/** Where lab-state sits on the lab's content when it scrolls (`stateScrolls`). */
const STATE_Y = 120;

/** The iOS 26 share popover's parts, as Tapwright lists them. */
const POPOVER_REGION = { x: 0, y: 0, w: 440, h: 956 };
const POPOVER_SHEET = { x: 9, y: 530, w: 422, h: 414 };

export class FakeLab {
  scroll = 0;
  private readonly maxScroll = 1900;
  pressed = "-";
  typed = "";
  typed2 = "";
  switchOn = false;
  taps = 0;
  long = 0;
  anim = false;
  sheet = false;
  alert = "none";
  shared = "none";
  row = "-";
  standIn = false;
  nativeAlert = false;
  shareOpen = false;
  /** The app in the foreground. */
  foreground = LAB_APP;
  /** `back` on the lab itself went back to the app's previous screen (the lab's deep link brings it back). */
  offLab = false;
  /** How many freezes happened since the last reset. */
  froze = 0;
  /** The app is frozen until this `performance.now()` time (`options.freeze`). */
  private freezeUntil = 0;
  readonly calls: string[] = [];
  private readonly els = buildElements();

  constructor(readonly options: FakeOptions = {}) {
    if (options.freeze) {
      this.els.push(col("lab-freeze", 1110));
      // The fine print gives way: the freeze button takes its place below lab-reset.
      const fine = this.els.find((e) => e.id === "lab-fineprint");
      if (fine) Object.assign(fine, { y: 1150, h: 8 });
    }
  }

  state(): string {
    return (
      `pressed=${this.pressed} typed=${this.typed} typed2=${this.typed2} ` +
      `switch=${this.switchOn ? "on" : "off"} taps=${this.taps} long=${this.long} slow=0 ` +
      `anim=${this.anim ? "on" : "off"} sheet=${this.sheet ? "open" : "closed"} alert=${this.alert} ` +
      `shared=${this.shared} row=${this.row} froze=${this.froze}`
    );
  }

  /** The app's JavaScript is blocked by a freeze right now. */
  private frozen(): boolean {
    return performance.now() < this.freezeUntil;
  }

  /** Resolves when the freeze is over. */
  private async thawed(): Promise<void> {
    const left = this.freezeUntil - performance.now();
    if (left > 0) await new Promise((res) => setTimeout(res, left));
  }

  private reset(): void {
    this.froze = 0;
    this.pressed = "-";
    this.typed = "";
    this.typed2 = "";
    this.switchOn = false;
    this.taps = 0;
    this.long = 0;
    this.anim = false;
    this.sheet = false;
    this.alert = "none";
    this.shared = "none";
    this.row = "-";
    this.standIn = false;
    this.nativeAlert = false;
    this.shareOpen = false;
  }

  /** lab-state (or the sheet's copy) is on screen, so a look lists it and wait_for can read it. */
  stateOnScreen(): boolean {
    if (this.sheet || !this.options.stateScrolls) return true;
    const y = STATE_Y - this.scroll;
    return y + 20 > 0 && y < H;
  }

  private rect(el: El): { x: number; y: number; w: number; h: number } {
    return { x: el.x, y: el.fixed ? el.y : el.y - this.scroll, w: el.w, h: el.h };
  }

  private visible(el: El): boolean {
    if (el.sheet && !this.sheet) return false;
    const r = this.rect(el);
    return r.y + r.h > 0 && r.y < H;
  }

  private inRect(el: El, x: number, y: number): boolean {
    const r = this.rect(el);
    return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
  }

  /** What a finger at (x, y) points hits: an element, or nothing (bar, overlay, sheet scrim). */
  hit(x: number, y: number): El | null {
    if (this.nativeAlert || this.standIn || this.shareOpen) return null;
    if (this.sheet) return this.els.find((e) => e.sheet && this.inRect(e, x, y)) ?? null;
    if (y < BAR) {
      const through = this.options.bugs?.barLetsTouchThrough;
      return through ? (this.els.find((e) => e.id === "lab-under-header" && this.inRect(e, x, y)) ?? null) : null;
    }
    const covered = this.els.find((e) => e.id === "lab-covered");
    if (covered && this.inRect(covered, x, y)) return null;
    return this.els.find((e) => !e.sheet && this.inRect(e, x, y)) ?? null;
  }

  /** A person's tap, as fractions of the screen. */
  personTap(fx: number, fy: number): void {
    const el = this.hit(fx * W, fy * H);
    if (el) this.press(el);
  }

  private press(el: El): void {
    this.pressed = el.id.replace(/^lab-/, "");
    switch (el.id) {
      case "lab-taps":
        this.taps++;
        break;
      case "lab-open-sheet":
        this.sheet = true;
        break;
      case "lab-sheet-close":
        this.sheet = false;
        break;
      case "lab-alert":
        this.standIn = true;
        break;
      case "lab-native-alert":
        this.nativeAlert = true;
        break;
      case "lab-share":
        this.shareOpen = true;
        this.shared = "opened";
        break;
      case "lab-reset":
        this.reset();
        break;
      case "lab-freeze": {
        const freeze = this.options.freeze;
        if (freeze && freeze.kind !== "silent-success") {
          this.froze++;
          this.freezeUntil = performance.now() + freeze.ms;
        }
        break;
      }
      default: {
        const m = /^lab-row-(\d+)$/.exec(el.id);
        if (m?.[1]) this.row = m[1];
      }
    }
  }

  private find(target: unknown): El[] {
    if (typeof target !== "object" || target === null) return [];
    const t = target as { id?: unknown; text?: unknown };
    return this.els.filter(
      (e) =>
        (e.sheet ? this.sheet : true) &&
        ((typeof t.id === "string" && e.id === t.id) || (typeof t.text === "string" && e.text === t.text)),
    );
  }

  private line(el: El, n: number): string {
    const r = this.rect(el);
    const text = el.text ? ` "${el.text}"` : "";
    return `e${n} ${el.role}${text} id=${el.id} @${r.x},${r.y} ${r.w}x${r.h} [tap]`;
  }

  private look(): string {
    if (this.foreground !== LAB_APP) {
      return [`Screen ${W}x${H} pt @3x · 1 elements`, `App: ${this.foreground}`, 'e1 button "Post"'].join("\n");
    }
    if (this.offLab) return [`Screen ${W}x${H} pt @3x · 1 elements`, `App: ${LAB_APP}`, 'e1 header "Home"'].join("\n");
    if (this.shareOpen && this.options.popoverShare) {
      const r = POPOVER_REGION;
      const s = POPOVER_SHEET;
      return [
        `Screen ${W}x${H} pt @3x · 2 elements`,
        `App: ${LAB_APP}`,
        `e1 other "dismiss popup" id=PopoverDismissRegion @${r.x},${r.y} ${r.w}x${r.h} [tap]`,
        `e2 other id=ActivityListView @${s.x},${s.y} ${s.w}x${s.h}`,
      ].join("\n");
    }
    if (this.shareOpen && !this.options.bugs?.shareTouchThrough) {
      // A tool that sees the share sheet: it covers the lab, so only its own controls show.
      return [`Screen ${W}x${H} pt @3x · 1 elements`, `App: ${LAB_APP}`, 'e1 button "Close"'].join("\n");
    }
    const shown = this.els.filter((e) => this.visible(e));
    // The sheet hides everything behind it, lab-state included; it carries a copy of the line.
    const stateId = this.sheet ? "lab-sheet-state" : "lab-state";
    let text = this.state();
    const cut = this.options.truncateStateAt;
    if (cut !== undefined && text.length > cut) text = `${text.slice(0, cut)}…`;
    const stateY = this.sheet || !this.options.stateScrolls ? 8 : STATE_Y - this.scroll;
    const stateLines = this.stateOnScreen() ? [`e0 text "${text}" id=${stateId} @20,${stateY} 400x20`] : [];
    const visible = this.sheet ? shown.filter((e) => e.sheet) : shown;
    return [
      `Screen ${W}x${H} pt @3x · ${visible.length + 1} elements`,
      `App: ${LAB_APP}`,
      ...(this.standIn ? ['Alert: "Alert" buttons OK, Cancel'] : []),
      ...(this.nativeAlert ? ['Alert: "Native alert" [Cancel] [OK]'] : []),
      ...stateLines,
      ...visible.map((e, i) => this.line(e, i + 1)),
      // The in-app stand-in draws the alert's buttons as elements (Cancel first, as the lab orders them).
      ...(this.standIn
        ? [
            'e98 button "Cancel" id=tapline-alert-button-0 @40,500 170x44 [tap]',
            'e99 button "OK" id=tapline-alert-button-1 @230,500 170x44 [tap]',
          ]
        : []),
    ].join("\n");
  }

  /** Why a person couldn't tap this element, or null. */
  private refusal(el: El): string | null {
    if (this.foreground !== LAB_APP) return `Error not_found: no element ${el.id}`;
    if (this.nativeAlert || this.standIn) return "Error not_actionable: behind_alert: an alert is open";
    if (this.shareOpen) return "Error not_actionable: covered by the share sheet";
    if (this.sheet && !el.sheet) {
      return this.options.bugs?.notFoundBehindSheet
        ? `Error not_found: no element ${el.id}`
        : "Error not_actionable: covered by the sheet";
    }
    if (el.disabled) return "Error not_actionable: disabled";
    if (el.id === "lab-covered" && !this.options.bugs?.falseSuccessCovered) {
      return "Error not_actionable: covered by lab-overlay";
    }
    const r = this.rect(el);
    const cy = r.y + r.h / 2;
    if (!el.fixed && cy < BAR && cy >= 0) return "Error not_actionable: covered by the navigation bar";
    if (cy < 0 || cy > H) return "Error not_actionable: off_screen, scroll to it";
    return null;
  }

  private tap(args: Record<string, unknown>): string {
    const target = args.target;
    const textTarget = typeof target === "object" && target !== null ? (target as { text?: unknown }).text : undefined;
    const idTarget = typeof target === "object" && target !== null ? (target as { id?: unknown }).id : undefined;
    if (this.standIn && (textTarget === "OK" || idTarget === "tapline-alert-button-1")) {
      this.standIn = false;
      this.alert = "ok";
      return 'Tapped e9 button "OK".';
    }
    if (this.standIn && (textTarget === "Cancel" || idTarget === "tapline-alert-button-0")) {
      this.standIn = false;
      this.alert = "cancel";
      return 'Tapped e98 button "Cancel".';
    }
    if (this.shareOpen && this.options.popoverShare) {
      const p = typeof target === "object" && target !== null ? (target as { x?: unknown; y?: unknown }) : {};
      if (typeof p.x !== "number" || typeof p.y !== "number") return "Error not_actionable: covered by the share sheet";
      const s = POPOVER_SHEET;
      if (p.x >= s.x && p.x <= s.x + s.w && p.y >= s.y && p.y <= s.y + s.h) return "Tapped a share target.";
      this.shareOpen = false;
      this.shared = "dismissed";
      return "Tapped dismiss popup.";
    }
    const found = this.find(target);
    const first = found[0];
    if (!first) return "Error not_found: nothing matches";
    if (found.length > 1) {
      return [
        `Error ambiguous: ${found.length} elements match`,
        "Candidates:",
        ...found.map((e, i) => this.line(e, i + 1)),
      ].join("\n");
    }
    if (this.shareOpen && this.options.bugs?.shareTouchThrough && this.foreground === LAB_APP) {
      // The touch lands on a share target: another app opens.
      this.shareOpen = false;
      this.foreground = OTHER_APP;
      return `Tapped ${first.id}.\nSettled in 0.10 s.`;
    }
    const refused = this.refusal(first);
    if (refused && this.options.bugs?.pressesBehindCover && (this.shareOpen || this.nativeAlert)) {
      this.pressed = first.id.replace(/^lab-/, "");
      return refused;
    }
    if (refused) return refused;
    this.press(first);
    return `Tapped ${first.id}.\nSettled in 0.10 s.${this.standIn ? '\nAlert: "Alert" buttons OK, Cancel' : ""}`;
  }

  call(name: string, args: Record<string, unknown>): CallResult {
    this.calls.push(name);
    const ok = (text: string): CallResult => ({ text, images: 0, isError: false, ms: 1 });
    const err = (text: string): CallResult => ({ text, images: 0, isError: true, ms: 1 });
    const out = (text: string): CallResult => (text.startsWith("Error") ? err(text) : ok(text));
    if (this.frozen()) {
      const kind = this.options.freeze?.kind;
      const reads = name === "look" || name === "wait_for";
      if (kind === "in-app" || (kind === "real-touch" && reads)) {
        return err("Error not_answering: the app is not answering");
      }
    }
    if (this.offLab && !["look", "open_url", "viewer", "back"].includes(name)) {
      return err("Error not_found: the lab isn't on screen");
    }
    switch (name) {
      case "look":
        return ok(this.look());
      case "open_url":
        this.foreground = LAB_APP;
        this.offLab = false;
        return ok("Opened.");
      case "viewer":
        return ok(this.options.viewerLink ?? "no viewer");
      case "tap": {
        const frozeBefore = this.froze;
        const answer = this.tap(args);
        // A tool that works inside the app gets no answer to the tap that freezes it.
        if (this.froze > frozeBefore && this.options.freeze?.kind === "in-app") {
          return err("Error not_answering: the app did not answer the tap");
        }
        return out(answer);
      }
      case "long_press": {
        const found = this.find(args.target);
        const el = found[0];
        if (!el) return out("Error not_found: nothing matches");
        const refused = this.refusal(el);
        if (refused) return out(refused);
        this.press(el);
        if (el.id === "lab-long") this.long++;
        return ok("Long pressed.");
      }
      case "type_text": {
        const el = this.find(args.target)[0];
        if (!el) return out("Error not_found: nothing matches");
        const refused = this.refusal(el);
        if (refused) return out(refused);
        const text = typeof args.text === "string" ? args.text : "";
        if (el.id === "lab-input") this.typed = text;
        else this.typed2 = text;
        return ok(`Typed into ${el.id}.`);
      }
      case "toggle": {
        const el = this.find(args.target)[0];
        if (!el) return out("Error not_found: nothing matches");
        const refused = this.refusal(el);
        if (refused) return out(refused);
        const on = args.value === true;
        if (el.id === "lab-switch") this.switchOn = on;
        else this.anim = on;
        return ok("Toggled.");
      }
      case "scroll": {
        if (args.to === "start") this.scroll = 0;
        else if (args.to === "end") this.scroll = this.maxScroll;
        else {
          const amount = typeof args.amount === "number" ? args.amount : 0.8;
          const dir = args.direction === "up" ? -1 : 1;
          this.scroll = Math.min(this.maxScroll, Math.max(0, this.scroll + dir * amount * H));
        }
        return ok("Scrolled.");
      }
      case "wait_for":
        return this.foreground === LAB_APP &&
          this.stateOnScreen() &&
          this.state().includes(typeof args.text === "string" ? args.text : "\u0000")
          ? ok("Done after 0.0 s.")
          : err("Error timeout: the text did not appear");
      case "alert": {
        if (this.nativeAlert) {
          this.nativeAlert = false;
          this.alert = args.action === "accept" ? "native-ok" : "native-cancel";
          return ok("Alert answered.");
        }
        if (this.shareOpen && args.action === "dismiss" && !this.options.popoverShare) {
          this.shareOpen = false;
          this.shared = "dismissed";
          return ok("Share sheet dismissed.");
        }
        return err("Error not_found: no alert");
      }
      case "back":
        if (this.shareOpen) {
          this.shareOpen = false;
          this.shared = "dismissed";
        } else {
          this.offLab = true; // the lab's own back button leaves the lab
        }
        return ok("Went back.");
      default:
        return err(`Error bad_params: unknown tool ${name}`);
    }
  }

  tool(): ToolSession {
    const names = [
      "look", "tap", "long_press", "type_text", "toggle", "scroll", "wait_for", "open_url", "viewer", "back",
      ...(this.options.alertTool ? ["alert"] : []),
    ];
    return {
      // wait_for polls for 100 ms, so a viewer tap that arrives a moment later is still seen
      call: async (name, args) => {
        // This tool never answers a look during the freeze, until the app is back.
        if (name === "look" && this.options.freeze?.kind === "hangs") await this.thawed();
        let r = this.call(name, args);
        for (let i = 0; name === "wait_for" && r.isError && i < 5; i++) {
          await new Promise((res) => setTimeout(res, 20));
          r = this.call(name, args);
        }
        return r;
      },
      ...(this.options.noListTools ? {} : { listTools: () => Promise.resolve(names) }),
    };
  }
}
