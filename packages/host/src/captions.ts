/**
 * VIEWER-PROTOCOL 1.4: the `kind` of an action the viewer is shown, and the plain-language `caption`
 * for the agent's steps. A caption never carries refs, coordinates, typed text or a link's address,
 * and never the failure reason (the page adds that). A person's steps get no caption from here:
 * the page words them itself ("You tapped …").
 */
import type { PersonInput } from "./viewer.js";

/** The app's method → the AGENT-TOOLS tool the agent called. */
const AGENT_KINDS: Record<string, string> = {
  press: "tap",
  longPress: "long_press",
  type: "type_text",
  scroll: "scroll",
  swipe: "swipe",
  toggle: "toggle",
  back: "back",
  openURL: "open_url",
  waitFor: "wait_for",
  command: "app_command",
  reload: "reload",
};

export function agentKind(method: string): string {
  return AGENT_KINDS[method] ?? method;
}

/** A person's input → the viewer's input name (tap, longPress, drag, scroll, text, enter, backspace). */
export function personKind(input: PersonInput, method: string): string {
  switch (input.type) {
    case "text":
      return "text";
    case "key":
      return input.key;
    case "scroll":
      return "scroll";
    case "gesture":
      if (method === "press") return "tap";
      if (method === "longPress") return "longPress";
      if (method === "swipe") return "drag";
      return "scroll";
  }
}

const NAME_MAX = 24;

/** An element's name for a caption: 24 characters at most, then an ellipsis. */
function shortName(label: string): string {
  const clean = label.replace(/\s+/g, " ").trim();
  return clean.length <= NAME_MAX ? clean : `${clean.slice(0, NAME_MAX).trimEnd()}…`;
}

function field(params: unknown, key: string): unknown {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>)[key] : undefined;
}

const DIRECTIONS = new Set(["up", "down", "left", "right"]);

/** The agent's step in plain words, or undefined for steps a viewer needn't see (wait_for). */
export function captionFor(kind: string, label?: string, params?: unknown): string | undefined {
  const name = label !== undefined && label.trim() !== "" ? shortName(label) : undefined;
  const quoted = name !== undefined ? ` "${name}"` : "";
  switch (kind) {
    case "tap":
      return `Tap${quoted}`;
    case "long_press":
      return `Press and hold${quoted}`;
    case "type_text":
      return name !== undefined ? `Type into${quoted}` : "Type";
    case "scroll": {
      const direction = field(params, "direction");
      return typeof direction === "string" && DIRECTIONS.has(direction) ? `Scroll ${direction}` : "Scroll";
    }
    case "swipe":
      return "Swipe";
    case "toggle": {
      const value = field(params, "value");
      if (value === true) return `Turn on${quoted}`;
      if (value === false) return `Turn off${quoted}`;
      return `Switch${quoted}`;
    }
    case "back":
      return "Go back";
    case "open_url":
      return "Open link";
    case "reload":
      return "Reload the app";
    case "app_command": {
      const command = field(params, "name");
      const scheme = field(field(params, "args"), "scheme");
      if (command === "appearance" && (scheme === "dark" || scheme === "light")) return `Switch to ${scheme} mode`;
      const named = typeof command === "string" && command !== "" ? shortName(command) : name;
      return named !== undefined ? `Run "${named}"` : "Run a test command";
    }
    case "wait_for":
      return undefined;
    default:
      return kind.replace(/_/g, " ");
  }
}
