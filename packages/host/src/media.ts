import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { SessionInfo } from "./server.js";

/**
 * `media` (AGENT-TOOLS 1.12 §17.6): test pictures for an app's photo picker. The host reads the pictures from this
 * computer, checks them, and sends them to the app one per request (a request stays well under the protocol's
 * 64 MiB message limit: 10 MB of picture is about 13.4 MB of base64). The app saves them with its own photo-library
 * module. Nothing here reads the phone's photo library.
 */

export const MEDIA_MAX_FILES = 10;
export const MEDIA_MAX_BYTES = 10 * 1024 * 1024;
/** All the pictures of one call together. */
export const MEDIA_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export const mediaShape = {
  add: z
    .array(z.string().min(1))
    .min(1)
    .max(MEDIA_MAX_FILES)
    .optional()
    .describe(`Paths of pictures on this computer (JPEG or PNG, at most ${MEDIA_MAX_FILES} per call, each at most 10 MB, 20 MB in all)`),
  confirm: z.boolean().optional().describe("true: your user agreed that these pictures may be added to the phone's photo library"),
  remove: z.boolean().optional().describe("true: delete the pictures this session added (iOS asks the person to confirm)"),
  picker: z
    .boolean()
    .optional()
    .describe("Tapline only: the next image pick returns these pictures without the OS picker or the photo library"),
};

export interface MediaArgs {
  add?: string[] | undefined;
  confirm?: boolean | undefined;
  remove?: boolean | undefined;
  picker?: boolean | undefined;
}

export const CONFIRM_ERROR = "Error bad_params: media adds to the phone's photo library; ask your user first, then pass confirm: true.";

/** A picture read and checked, ready to send. */
export interface MediaFile {
  name: string;
  mime: "image/jpeg" | "image/png";
  data: string;
  width: number;
  height: number;
  bytes: number;
}

function ok(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height of a PNG (its header) or a JPEG (its first start-of-frame marker); 0 x 0 when not found. */
export function pictureSize(bytes: Buffer, mime: "image/jpeg" | "image/png"): { width: number; height: number } {
  if (mime === "image/png") {
    return bytes.length >= 24 ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) } : { width: 0, height: 0 };
  }
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return { width: 0, height: 0 };
}

/** Reads and checks the pictures: they exist, are JPEG or PNG (by content, not name), are at most 10 MB, and at most 10 are given. */
export function readPictures(paths: readonly string[]): { files: MediaFile[] } | { error: string } {
  if (paths.length === 0) return { error: "Error bad_params: add needs at least one picture path." };
  if (paths.length > MEDIA_MAX_FILES) {
    return { error: `Error bad_params: add takes at most ${MEDIA_MAX_FILES} pictures per call (got ${paths.length}).` };
  }
  const files: MediaFile[] = [];
  let total = 0;
  for (const given of paths) {
    const path = resolve(given);
    let size: number;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) return { error: `Error bad_params: ${given} is not a file.` };
      size = stat.size;
    } catch {
      return { error: `Error bad_params: ${given} was not found on this computer.` };
    }
    if (size > MEDIA_MAX_BYTES) {
      return { error: `Error bad_params: ${given} is ${(size / (1024 * 1024)).toFixed(1)} MB; each picture may be at most 10 MB.` };
    }
    // The app holds what one call sends in memory: 20 MB in all per call (1.5 review, finding 10).
    total += size;
    if (total > MEDIA_MAX_TOTAL_BYTES) {
      return { error: `Error bad_params: these pictures come to more than ${MEDIA_MAX_TOTAL_BYTES / (1024 * 1024)} MB; send at most 20 MB per call.` };
    }
    const bytes = readFileSync(path);
    const isPng = bytes.length > 8 && PNG_MAGIC.every((b, i) => bytes[i] === b);
    const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!isPng && !isJpeg) return { error: `Error bad_params: ${given} is not a JPEG or PNG picture; media takes only those.` };
    const mime = isPng ? "image/png" : "image/jpeg";
    files.push({ name: basename(path), mime, data: bytes.toString("base64"), ...pictureSize(bytes, mime), bytes: bytes.length });
  }
  return { files };
}

export const addResultSchema = z.object({ id: z.string().optional(), needsPerson: z.boolean().optional() });
export const removeResultSchema = z.object({
  removed: z.number(),
  pending: z.boolean().optional(),
  declined: z.boolean().optional(),
});
export const pickerResultSchema = z.object({ pictures: z.number() });

/** What the host remembers per app (by app id), in memory only. */
export class MediaState {
  /** This host's token on every add and remove: the app deletes only the pictures this host added (one per process). */
  readonly owner = randomBytes(8).toString("hex");
  private readonly added = new Map<string, string[]>();
  private readonly skips = new Map<string, number>();
  private readonly listeners = new Set<(app: string, count: number) => void>();

  addedIds(app: string): string[] {
    return [...(this.added.get(app) ?? [])];
  }

  remember(app: string, ids: readonly string[]): void {
    this.added.set(app, [...(this.added.get(app) ?? []), ...ids]);
  }

  forget(app: string): void {
    this.added.delete(app);
  }

  /** The next photo pick in `app` returns `count` pictures without the OS picker: a journey report marks it "picker skipped". */
  recordPickerSkipped(app: string, count: number): void {
    this.skips.set(app, (this.skips.get(app) ?? 0) + 1);
    for (const listener of [...this.listeners]) listener(app, count);
  }

  /** How many times the picker was skipped in `app` since the last `takePickerSkips` (the journey reads and clears it). */
  pickerSkips(app: string): number {
    return this.skips.get(app) ?? 0;
  }

  takePickerSkips(app: string): number {
    const n = this.skips.get(app) ?? 0;
    this.skips.delete(app);
    return n;
  }

  onPickerSkipped(listener: (app: string, count: number) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** What the media tool needs from the tools object. */
export interface MediaContext {
  state: MediaState;
  session: Pick<SessionInfo, "id" | "app" | "device" | "capabilities">;
  /** Sends one `media` request to the app; throws what the app answered. */
  request: (params: Record<string, unknown>) => Promise<unknown>;
  describeError: (error: unknown) => string;
}

const PERSON_NOTE = "Note: needs a person: allow photo access on the phone (an OS alert Tapline can't tap).";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function parseOr<T>(schema: z.ZodType<T>, raw: unknown): T | null {
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The host side of `media`, after the cheap checks. */
export async function runMedia(args: MediaArgs, ctx: MediaContext): Promise<CallToolResult> {
  // Ids are kept per app install, never per app: another phone with the same app must never be sent them (1.5 review,
  // finding 9). An app that sends no install id gets only what it remembers itself.
  const app = ctx.session.device.id !== undefined && ctx.session.device.id !== "" ? `${ctx.session.app.id}@${ctx.session.device.id}` : null;
  if (!ctx.session.capabilities.includes("media")) {
    return fail("Error unsupported: this app's Tapline is too old for media; update react-native-tapline.");
  }

  if (args.remove === true) {
    const ids = app === null ? [] : ctx.state.addedIds(app);
    let raw: unknown;
    try {
      raw = await ctx.request({ op: "remove", ids, owner: ctx.state.owner });
    } catch (error) {
      return fail(ctx.describeError(error));
    }
    const result = parseOr(removeResultSchema, raw);
    if (result === null) return fail("Error internal: the app returned a media answer the host could not read.");
    if (result.declined === true) {
      return ok("The person declined the delete on the phone; the pictures this session added are still there. Call media with remove: true to ask again.");
    }
    if (app !== null) ctx.state.forget(app);
    if (result.removed === 0) return ok("Nothing to remove: this session added no pictures.");
    const ios = ctx.session.device.platform === "ios";
    const confirm = ios ? " iOS asks the person to confirm the delete on the phone: ask your user to tap Delete." : "";
    const pending = result.pending === true ? " The delete is still waiting for the person." : "";
    return ok(`Removed ${plural(result.removed, "picture")} this session added.${confirm}${pending}`);
  }

  const read = readPictures(args.add ?? []);
  if ("error" in read) return fail(read.error);
  const { files } = read;

  if (args.picker === true) {
    let armed = 0;
    for (const [i, file] of files.entries()) {
      let raw: unknown;
      try {
        raw = await ctx.request({ op: "picker", index: i + 1, total: files.length, name: file.name, mime: file.mime, data: file.data, width: file.width, height: file.height });
      } catch (error) {
        return fail(ctx.describeError(error));
      }
      armed = parseOr(pickerResultSchema, raw)?.pictures ?? armed;
    }
    // Counted when the app uses the stub (its `pickerSkipped` event), not here: an armed stub may never be used.
    return ok(`The next photo pick returns ${plural(files.length, "picture")} without the OS picker (marked "picker skipped" in a journey report).`);
  }

  const added: string[] = [];
  for (const [i, file] of files.entries()) {
    let raw: unknown;
    try {
      raw = await ctx.request({ op: "add", name: file.name, mime: file.mime, data: file.data, owner: ctx.state.owner });
    } catch (error) {
      if (app !== null) ctx.state.remember(app, added);
      const done = added.length > 0 ? ` ${plural(added.length, "picture")} were added before it.` : "";
      return fail(`${ctx.describeError(error)}${done}`);
    }
    const result = parseOr(addResultSchema, raw);
    if (result === null) {
      if (app !== null) ctx.state.remember(app, added);
      return fail("Error internal: the app returned a media answer the host could not read.");
    }
    if (result.needsPerson === true || result.id === undefined) {
      if (app !== null) ctx.state.remember(app, added);
      const left = files.length - i;
      return ok(
        [
          `Added ${added.length} of ${files.length} pictures. A person must allow photo access on the phone first (an OS alert); ask your user to tap Allow, then call media again with the ${plural(left, "picture")} left (${files.slice(i).map((f) => f.name).join(", ")}).`,
          PERSON_NOTE,
        ].join("\n"),
      );
    }
    added.push(result.id);
  }
  if (app !== null) ctx.state.remember(app, added);
  return ok(
    `Added ${plural(added.length, "picture")} to the phone's photo library (${files.map((f) => f.name).join(", ")}); they show in the picker as Recently Added. Call media with remove: true to delete them afterwards.`,
  );
}
