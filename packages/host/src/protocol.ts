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
  value: z.unknown().nullish(),
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
  network: z.object({ inFlight: z.number() }).optional(),
  /** With `changes: true`: what changed since the previous tree call. */
  changes: z
    .object({
      sameRoute: z.boolean(),
      added: z.array(z.string()),
      removed: z.array(elementSchema),
      changed: z.array(z.object({ ref: z.string(), was: z.record(z.string(), z.unknown()) })),
      moved: z.array(z.string()),
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
});
export type LogEntry = z.infer<typeof logEntrySchema>;

/** A target exactly as it travels on the wire. */
export type WireTarget =
  | { ref: string }
  | { testID: string }
  | { label: string }
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
  | "reload";
