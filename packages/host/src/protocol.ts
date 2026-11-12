import { z } from "zod";

/** Wire protocol version implemented by this host (see docs/PROTOCOL.md). */
export const PROTOCOL_VERSION = 1;

/** WebSocket close codes. */
export const CLOSE_BAD_TOKEN = 4001;
export const CLOSE_NOT_AUTHENTICATED = 4002;
export const CLOSE_BAD_PROTOCOL = 4003;
export const CLOSE_BAD_PAIR_CODE = 4004;

export const ERROR_CODES = [
  "not_found",
  "ambiguous",
  "not_actionable",
  "unsupported",
  "bad_params",
  "timeout",
  "internal",
] as const;
export type AppErrorCode = (typeof ERROR_CODES)[number];

export const appInfoSchema = z.object({
  name: z.string().default("Unknown app"),
  id: z.string().default("unknown"),
  version: z.string().optional(),
  build: z.string().optional(),
});
export type AppInfo = z.infer<typeof appInfoSchema>;

export const deviceInfoSchema = z.object({
  platform: z.string().default("unknown"),
  osVersion: z.string().optional(),
  model: z.string().optional(),
  name: z.string().optional(),
  /** Random id of this app install (tells apart phones that send no name or model). */
  id: z.string().optional(),
});
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

export const helloSchema = z.object({
  type: z.literal("hello"),
  protocol: z.number(),
  /** The host's token, or `pairCode` from a pairing link (exactly one of them). */
  token: z.string().optional(),
  pairCode: z.string().optional(),
  app: appInfoSchema.default({ name: "Unknown app", id: "unknown" }),
  device: deviceInfoSchema.default({ platform: "unknown" }),
  capabilities: z.array(z.string()).default([]),
});
export type Hello = z.infer<typeof helloSchema>;

export const pingSchema = z.object({ type: z.literal("ping") });
export const pongSchema = z.object({ type: z.literal("pong") });

export const appErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  data: z.unknown().optional(),
  candidates: z.unknown().optional(),
  refs: z.unknown().optional(),
});
export type AppErrorPayload = z.infer<typeof appErrorSchema>;

export const responseSchema = z.object({
  type: z.literal("response"),
  id: z.number(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: appErrorSchema.optional(),
});
export type ResponseMessage = z.infer<typeof responseSchema>;

export const eventSchema = z.object({
  type: z.literal("event"),
  event: z.string(),
  data: z.unknown().optional(),
});
export type EventMessage = z.infer<typeof eventSchema>;

/** Anything the app may send after `hello`. */
export const appMessageSchema = z.discriminatedUnion("type", [
  pingSchema,
  pongSchema,
  responseSchema,
  eventSchema,
  helloSchema,
]);
export type AppMessage = z.infer<typeof appMessageSchema>;

// ---- element / target types -------------------------------------------------

export const frameSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});
export type Frame = z.infer<typeof frameSchema>;

export const elementSchema = z.object({
  ref: z.string(),
  type: z.string().nullish(),
  role: z.string().nullish(),
  testID: z.string().nullish(),
  label: z.string().nullish(),
  text: z.string().nullish(),
  /** How many characters of the text the app left out (it sends at most 2000). */
  textMore: z.number().nullish(),
  value: z.unknown().nullish(),
  /** An empty input's placeholder (AGENT-TOOLS v1.7). */
  placeholder: z.string().nullish(),
  frame: frameSchema.nullish(),
  actions: z.array(z.string()).nullish(),
  disabled: z.boolean().nullish(),
  selected: z.boolean().nullish(),
  checked: z.union([z.boolean(), z.string()]).nullish(),
});
export type TreeElement = z.infer<typeof elementSchema>;

export const treeResultSchema = z.object({
  screen: z
    .object({
      width: z.number(),
      height: z.number(),
      scale: z.number().optional(),
    })
    .nullish(),
  elements: z.array(elementSchema),
  /** How many elements lie wholly above and below the screen; absent when none. */
  offScreen: z.object({ above: z.number(), below: z.number() }).nullish(),
  /** The focused screen (apps using React Navigation / Expo Router). */
  route: z
    .object({
      names: z.array(z.string()),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    })
    .optional(),
  /** Open alerts the app showed (Alert.alert / Alert.prompt). */
  alerts: z
    .array(
      z.object({
        kind: z.enum(["alert", "prompt"]),
        title: z.string(),
        message: z.string().nullable(),
        buttons: z.array(z.object({ text: z.string(), style: z.enum(["default", "cancel", "destructive"]) })),
        standIn: z.boolean(),
      }),
    )
    .optional(),
  /** Network requests still running. */
  network: z
    .object({
      inFlight: z.number().optional(),
      /** The condition Tapline's `network` command put on the app's requests; absent when normal. */
      condition: z.string().optional(), // any string: a mode a newer SDK adds must not make the whole tree unreadable
    })
    .optional(),
  /** True while the software keyboard is up (absent from older SDKs and when it is down). */
  keyboard: z.boolean().nullish(),
  /** With `changes: true`: what changed since the previous tree call. */
  changes: z
    .object({
      sameRoute: z.boolean(),
      added: z.array(z.string()),
      removed: z.array(elementSchema),
      changed: z.array(z.object({ ref: z.string(), was: z.record(z.string(), z.unknown()) })),
      moved: z.array(z.string()),
      /** Elements off screen whose text, label, value or state changed, as they are now (no ref), with the old values. */
      offScreen: z.array(z.object({ element: elementSchema, was: z.record(z.string(), z.unknown()) })).nullish(),
      /** How many more changed off screen than `offScreen` holds. */
      offScreenMore: z.number().nullish(),
      /** The keyboard came up or went down since then. */
      keyboard: z.enum(["shown", "hidden"]).nullish(),
    })
    .optional(),
});
export type TreeResult = z.infer<typeof treeResultSchema>;

/** A frame of the app's live picture, sent as `event: "frame"` while a viewer watches. */
export const appFrameSchema = z.object({
  seq: z.number(),
  rev: z.number().optional(),
  capturedAt: z.number(),
  captureMs: z.number().optional(),
  mime: z.string(),
  data: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
});

export const screenshotResultSchema = z.object({
  mime: z.string(),
  data: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
});
export type ScreenshotResult = z.infer<typeof screenshotResultSchema>;

export const logEntrySchema = z.object({
  level: z.string().optional(),
  message: z.string(),
  ts: z.number().optional(),
  stack: z.string().optional(),
  fatal: z.boolean().optional(),
  /** On a fatal error: the error type, and React's component stack when the SDK had one. */
  name: z.string().optional(),
  componentStack: z.string().optional(),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

/** The `crash` event: a fatal JS error the SDK kept on the phone and sends after it connects again. */
export const crashEventSchema = z.object({
  name: z.string().optional(),
  message: z.string(),
  stack: z.string().optional(),
  componentStack: z.string().optional(),
  ts: z.number().optional(),
});

/** A target exactly as it travels on the wire. */
export type WireTarget =
  | { ref: string }
  | { testID: string; index?: number }
  | { label: string; index?: number }
  | { text: string; index?: number }
  | { x: number; y: number };

/** Request methods the host knows how to issue. */
export type Method =
  | "tree"
  | "screenshot"
  | "press"
  | "longPress"
  | "type"
  | "scroll"
  | "toggle"
  | "openURL"
  | "logs"
  | "reload"
  | "perfStart"
  | "perfStop"
  | "perfSettle"
  /** Tells the app the host has its saved crash (`{ ts }`), so it can forget it. */
  | "crashAck";
