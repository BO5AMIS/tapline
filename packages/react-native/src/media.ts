import { emitEvent } from './events';
import { TaplineError, isRecord } from './types';

/**
 * `media` (AGENT-TOOLS 1.12 §17.6): test pictures for an app's photo picker.
 *
 * - `add`: saves a picture the host sent into the phone's photo library through the app's own
 *   `expo-media-library` (else `@react-native-camera-roll/camera-roll`). The OS asks the person for access.
 * - `remove`: deletes only the assets this session added.
 * - `picker`: the next `expo-image-picker` call (or a registered hook) gets the pictures, without the OS picker.
 *
 * Every module is optional and loaded the way the SDK loads react-native-view-shot. Tapline never reads
 * the photo library: nothing here lists, queries or fetches assets.
 */

const UNSUPPORTED_LIBRARY =
  "this app has no photo-library module (expo-media-library or @react-native-camera-roll/camera-roll); Tapwright's media adds pictures for any app.";
const UNSUPPORTED_FILES =
  "this app has no expo-file-system, which Tapline needs to hand a picture to the photo library (npx expo install expo-file-system).";

/** How long to wait for the person to answer an OS prompt before telling the agent a person must. */
const DEFAULT_PATIENCE_MS = 4000;

// ---- optional modules -------------------------------------------------------

interface PermissionResult {
  granted?: boolean;
  status?: string;
}

interface ExpoMediaLibrary {
  createAssetAsync: (uri: string) => Promise<unknown>;
  deleteAssetsAsync: (ids: string[]) => Promise<unknown>;
  getPermissionsAsync: (writeOnly?: boolean) => Promise<unknown>;
  requestPermissionsAsync: (writeOnly?: boolean) => Promise<unknown>;
}

interface CameraRollModule {
  save: (uri: string, options?: { type?: string }) => Promise<unknown>;
  deletePhotos: (uris: string[]) => Promise<unknown>;
}

interface FileSystemModule {
  cacheDirectory: string;
  writeAsStringAsync: (uri: string, contents: string, options: { encoding: string }) => Promise<unknown>;
  deleteAsync: (uri: string, options?: { idempotent?: boolean }) => Promise<unknown>;
}

type PickerFn = (...args: unknown[]) => Promise<unknown>;
type PickerModule = Record<string, unknown>;

export interface MediaModules {
  expo: ExpoMediaLibrary | null;
  cameraRoll: CameraRollModule | null;
  fileSystem: FileSystemModule | null;
  imagePicker: PickerModule | null;
}

function fn(value: unknown): boolean {
  return typeof value === 'function';
}

function isExpoMediaLibrary(value: unknown): value is ExpoMediaLibrary {
  return isRecord(value) && fn(value.createAssetAsync) && fn(value.deleteAssetsAsync) && fn(value.requestPermissionsAsync) && fn(value.getPermissionsAsync);
}

function isCameraRoll(value: unknown): value is CameraRollModule {
  return isRecord(value) && fn(value.save) && fn(value.deletePhotos);
}

function isFileSystem(value: unknown): value is FileSystemModule {
  return isRecord(value) && typeof value.cacheDirectory === 'string' && fn(value.writeAsStringAsync) && fn(value.deleteAsync);
}

/** A module's exports, or its `default` when that is where an ES module put them. */
function unwrap<T>(mod: unknown, check: (value: unknown) => value is T): T | null {
  if (check(mod)) return mod;
  return isRecord(mod) && check(mod.default) ? mod.default : null;
}

/**
 * Metro needs literal module names, and treats a require as optional only when it sits directly inside a `try`
 * block: otherwise an app without the module fails to bundle at all (found on the phone with Wayfare, 2026-11-12).
 */
function load(name: string): unknown {
  switch (name) {
    case 'expo-media-library':
      try {
        return require('expo-media-library');
      } catch {
        return null;
      }
    case '@react-native-camera-roll/camera-roll':
      try {
        return require('@react-native-camera-roll/camera-roll');
      } catch {
        return null;
      }
    case 'expo-file-system/legacy':
      try {
        return require('expo-file-system/legacy');
      } catch {
        return null;
      }
    case 'expo-file-system':
      try {
        return require('expo-file-system');
      } catch {
        return null;
      }
    default:
      try {
        return require('expo-image-picker');
      } catch {
        return null;
      }
  }
}

function tryLoad<T>(name: string, check: (value: unknown) => value is T): T | null {
  try {
    return unwrap(load(name), check);
  } catch {
    return null;
  }
}

let override: MediaModules | undefined;
let loaded: MediaModules | undefined;

function modules(): MediaModules {
  if (override !== undefined) return override;
  if (loaded === undefined) {
    const cameraRollRaw = tryLoadRaw('@react-native-camera-roll/camera-roll');
    const cameraRollModule = unwrap(cameraRollRaw, isCameraRoll) ?? (isRecord(cameraRollRaw) ? unwrap(cameraRollRaw.CameraRoll, isCameraRoll) : null);
    const picker = tryLoadRaw('expo-image-picker');
    loaded = {
      expo: tryLoad('expo-media-library', isExpoMediaLibrary),
      cameraRoll: cameraRollModule,
      // SDK 54 moved the classic API to /legacy; older SDKs have it at the top.
      fileSystem: tryLoad('expo-file-system/legacy', isFileSystem) ?? tryLoad('expo-file-system', isFileSystem),
      imagePicker: isRecord(picker) ? picker : null,
    };
  }
  return loaded;
}

function tryLoadRaw(name: string): unknown {
  try {
    return load(name);
  } catch {
    return null;
  }
}

/** Replace the optional modules (tests); undefined restores the lookup. */
export function setMediaModules(next: MediaModules | undefined): void {
  override = next;
  loaded = undefined;
  resetMedia();
  addedIds.length = 0;
  permissionPending = null;
  pendingSaves.clear();
}

let patienceMs = DEFAULT_PATIENCE_MS;

/** How long an OS prompt is waited for before the answer says a person must (tests shorten it). */
export function setMediaPatience(ms: number): void {
  patienceMs = ms;
}

// ---- state kept in memory for this session ----------------------------------

/**
 * Asset ids added, in order, each with the host that added it (its `owner`, one per host process): `remove` only
 * deletes its own host's pictures, never an earlier host's that the app still remembers. Never written anywhere.
 */
const addedIds: Array<{ id: string; owner: string }> = [];
let permissionPending: Promise<unknown> | null = null;
/** A camera-roll save the person has not answered yet, by picture name, so a retry waits for it instead of saving twice. */
const pendingSaves = new Map<string, Promise<string>>();

/** The asset ids this session has added and not yet removed. */
export function addedAssetIds(): readonly string[] {
  return addedIds.map((added) => added.id);
}

/** The host that asks: its `owner` token, or '' from a host that sends none. */
function ownerOf(params: Record<string, unknown>): string {
  return typeof params.owner === 'string' ? params.owner : '';
}

type Waited<T> = { done: true; value: T } | { done: false };

/** Waits for `promise` for `ms`; `{done:false}` when it is still waiting (it carries on in the background). */
function within<T>(promise: Promise<T>, ms: number): Promise<Waited<T>> {
  return new Promise<Waited<T>>((resolve, reject) => {
    const timer = setTimeout(() => resolve({ done: false }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ done: true, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function badParams(message: string): TaplineError {
  return new TaplineError('bad_params', message);
}

function paramString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value === '') throw badParams(`${key} must be a non-empty string`);
  return value;
}

function paramNumber(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function extensionOf(mime: string): string {
  return mime === 'image/png' ? 'png' : 'jpg';
}

// ---- add ----------------------------------------------------------------------

export interface AddOutcome {
  /** The new asset's id; absent when a person must answer the OS prompt first. */
  id?: string;
  needsPerson?: boolean;
}

function isGranted(result: unknown): boolean {
  return isRecord(result) && (result.granted === true || result.status === 'granted');
}

/** expo-media-library: write-only access, asked once. `granted`, `denied`, or `pending` while the person has not answered. */
async function expoAccess(lib: ExpoMediaLibrary): Promise<'granted' | 'denied' | 'pending'> {
  const current = await lib.getPermissionsAsync(true);
  if (isGranted(current)) return 'granted';
  if (isRecord(current) && current.canAskAgain === false) return 'denied';
  permissionPending ??= lib.requestPermissionsAsync(true).finally(() => {
    permissionPending = null;
  });
  const waited = await within(permissionPending, patienceMs);
  if (!waited.done) return 'pending';
  return isGranted(waited.value) ? 'granted' : 'denied';
}

function assetIdOf(asset: unknown): string {
  if (isRecord(asset) && typeof asset.id === 'string' && asset.id !== '') return asset.id;
  throw new TaplineError('internal', 'the photo library did not return the new picture\'s id');
}

async function writeTemp(files: FileSystemModule, mime: string, data: string): Promise<string> {
  const uri = `${files.cacheDirectory}tapline-media-${Date.now()}-${Math.floor(Math.random() * 1e6)}.${extensionOf(mime)}`;
  await files.writeAsStringAsync(uri, data, { encoding: 'base64' });
  return uri;
}

async function addPicture(params: Record<string, unknown>): Promise<AddOutcome> {
  const name = paramString(params, 'name');
  const mime = paramString(params, 'mime');
  const data = paramString(params, 'data');
  const { expo, cameraRoll, fileSystem } = modules();
  if (expo === null && cameraRoll === null) throw new TaplineError('unsupported', UNSUPPORTED_LIBRARY);
  if (fileSystem === null) throw new TaplineError('unsupported', UNSUPPORTED_FILES);

  if (expo !== null) {
    const access = await expoAccess(expo);
    if (access === 'pending') return { needsPerson: true };
    if (access === 'denied') {
      throw new TaplineError('not_actionable', 'the person did not allow adding photos (Settings > the app > Photos); ask your user to allow it, then call media again.');
    }
    const uri = await writeTemp(fileSystem, mime, data);
    try {
      const id = assetIdOf(await expo.createAssetAsync(uri));
      addedIds.push({ id, owner: ownerOf(params) });
      return { id };
    } finally {
      await fileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
    }
  }

  // @react-native-camera-roll: iOS asks for add-only access by itself when the save starts.
  const library = cameraRoll;
  if (library === null) throw new TaplineError('unsupported', UNSUPPORTED_LIBRARY);
  let saving = pendingSaves.get(name);
  let temp: string | null = null;
  if (saving === undefined) {
    const uri = await writeTemp(fileSystem, mime, data);
    temp = uri;
    saving = library.save(uri, { type: 'photo' }).then((saved) => {
      if (typeof saved !== 'string' || saved === '') throw new TaplineError('internal', 'the photo library did not return the new picture\'s id');
      return saved;
    });
    pendingSaves.set(name, saving);
    const cleanup = (): void => {
      pendingSaves.delete(name);
      if (temp !== null) void fileSystem.deleteAsync(temp, { idempotent: true }).catch(() => undefined);
    };
    saving.then(
      (id) => {
        cleanup();
        addedIds.push({ id, owner: ownerOf(params) });
      },
      cleanup,
    );
  }
  const waited = await within(saving, patienceMs);
  if (!waited.done) return { needsPerson: true };
  return { id: waited.value };
}

// ---- remove -------------------------------------------------------------------

export interface RemoveOutcome {
  removed: number;
  /** The person has not answered the OS delete confirmation yet. */
  pending?: boolean;
  /** The person declined the delete; the pictures stay (and stay remembered). */
  declined?: boolean;
}

function forget(ids: readonly string[]): void {
  for (const id of ids) {
    const at = addedIds.findIndex((added) => added.id === id);
    if (at >= 0) addedIds.splice(at, 1);
  }
}

async function removePictures(params: Record<string, unknown>): Promise<RemoveOutcome> {
  const { expo, cameraRoll } = modules();
  if (expo === null && cameraRoll === null) throw new TaplineError('unsupported', UNSUPPORTED_LIBRARY);
  // This host's pictures in the phone's memory, plus the ids the host kept itself (after a JS reload). An earlier
  // host's pictures stay: a restarted host is another session (1.5 review).
  const owner = ownerOf(params);
  const mine = addedIds.filter((added) => added.owner === owner).map((added) => added.id);
  const fromHost = Array.isArray(params.ids) ? params.ids.filter((id): id is string => typeof id === 'string' && id !== '') : [];
  const ids = [...new Set([...mine, ...fromHost])];
  if (ids.length === 0) return { removed: 0 };
  const deleting: Promise<unknown> = expo !== null ? expo.deleteAssetsAsync(ids) : (cameraRoll as CameraRollModule).deletePhotos(ids);
  const settle = (outcome: unknown): boolean => {
    const declined = outcome === false;
    if (!declined) forget(ids);
    return declined;
  };
  const waited = await within(deleting, patienceMs);
  if (!waited.done) {
    deleting.then(settle, () => undefined);
    return { removed: ids.length, pending: true };
  }
  return settle(waited.value) ? { removed: 0, declined: true } : { removed: ids.length };
}

// ---- picker -------------------------------------------------------------------

/** A picture handed to a photo picker, as an `expo-image-picker` asset describes it. */
export interface TaplinePickerPicture {
  uri: string;
  fileName: string;
  mimeType: string;
  width: number;
  height: number;
  base64: string;
}

/** What a hook receives when pictures are armed for the app's own picker. */
export type TaplinePickerHook = (pictures: readonly TaplinePickerPicture[]) => void | Promise<void>;

const hooks = new Set<TaplinePickerHook>();

/**
 * For an app whose photo picker is not expo-image-picker: called when the agent arms test pictures
 * (`media` with `picker: true`), so the app can hand them to its own picker once. Returns the unregister function.
 */
export function registerTaplinePickerHook(hook: TaplinePickerHook): () => void {
  hooks.add(hook);
  return () => {
    hooks.delete(hook);
  };
}

const WRAPPED = ['launchImageLibraryAsync', 'launchCameraAsync'] as const;

/** A staged picture holds its bytes once, as base64; the data URI is made only when it is handed over (finding 10). */
type Staged = Omit<TaplinePickerPicture, 'uri'>;

let staged: Staged[] = [];
let armed: Staged[] | null = null;
let restoreOriginals: (() => void) | null = null;

function asPicture(p: Staged): TaplinePickerPicture {
  return { ...p, uri: `data:${p.mimeType};base64,${p.base64}` };
}

function pickerResult(pictures: readonly Staged[]): unknown {
  return {
    canceled: false,
    assets: pictures.map((p) => ({
      uri: `data:${p.mimeType};base64,${p.base64}`,
      assetId: null,
      width: p.width,
      height: p.height,
      type: 'image',
      fileName: p.fileName,
      fileSize: Math.floor((p.base64.length * 3) / 4),
      mimeType: p.mimeType,
      exif: null,
      base64: null,
    })),
  };
}

/** Wraps the picker's launch functions; false when the module's properties can't be replaced. */
function installWrappers(mod: PickerModule): boolean {
  if (restoreOriginals !== null) return true;
  const originals = new Map<string, unknown>();
  const wrapper = (name: string): PickerFn => async (...args: unknown[]) => {
    const pictures = armed;
    const original = originals.get(name);
    if (pictures === null) {
      // Nothing pending any more: behave as the app's own picker does.
      return typeof original === 'function' ? (original as PickerFn)(...args) : undefined;
    }
    // One use: the original is back before the result is handed over.
    resetMedia();
    emitEvent('pickerSkipped', { count: pictures.length });
    return pickerResult(pictures);
  };
  const done: string[] = [];
  for (const name of WRAPPED) {
    const original = mod[name];
    if (typeof original !== 'function') continue;
    originals.set(name, original);
    const replacement = wrapper(name);
    try {
      mod[name] = replacement;
    } catch {
      // read-only export
    }
    if (mod[name] === replacement) done.push(name);
  }
  if (done.length === 0) return false;
  restoreOriginals = () => {
    for (const name of done) {
      try {
        mod[name] = originals.get(name);
      } catch {
        // already gone
      }
    }
  };
  return true;
}

async function armPicker(params: Record<string, unknown>): Promise<{ pictures: number; hooks: number }> {
  const index = paramNumber(params, 'index') ?? 1;
  const total = paramNumber(params, 'total') ?? 1;
  const data = paramString(params, 'data');
  const mime = paramString(params, 'mime');
  const name = paramString(params, 'name');
  if (index === 1) staged = [];
  staged.push({
    fileName: name,
    mimeType: mime,
    width: paramNumber(params, 'width') ?? 0,
    height: paramNumber(params, 'height') ?? 0,
    base64: data,
  });
  if (index < total) return { pictures: staged.length, hooks: 0 };

  const pictures = staged;
  staged = [];
  const mod = modules().imagePicker;
  const wrapped = mod !== null && installWrappers(mod);
  if (!wrapped && hooks.size === 0) {
    throw new TaplineError(
      'unsupported',
      mod === null
        ? "this app has no expo-image-picker; register a hook with registerTaplinePickerHook(fn) in the app so Tapline can hand its own picker the pictures."
        : "this app's expo-image-picker can't be wrapped (its exports are read-only); register a hook with registerTaplinePickerHook(fn).",
    );
  }
  armed = wrapped ? pictures : null;
  let called = 0;
  const forHooks = hooks.size > 0 ? pictures.map(asPicture) : [];
  for (const hook of [...hooks]) {
    try {
      await hook(forHooks);
      called += 1;
    } catch {
      // a broken hook must not break the run
    }
  }
  emitEvent('pickerArmed', { count: pictures.length });
  return { pictures: pictures.length, hooks: called };
}

/** Puts the picker back as the app made it and forgets pictures not yet used. Called after one use and on disconnect. */
export function resetMedia(): void {
  const restore = restoreOriginals;
  restoreOriginals = null;
  armed = null;
  staged = [];
  if (restore !== null) restore();
}

/** Whether a picker stub is waiting for its one use. */
export function pickerArmed(): boolean {
  return armed !== null;
}

// ---- the protocol method --------------------------------------------------------

/** `media {op: "add" | "remove" | "picker", ...}` (AGENT-TOOLS 1.12 §17.6). One picture per `add` and `picker` request. */
export async function media(rawParams: unknown): Promise<unknown> {
  if (!isRecord(rawParams)) throw badParams('params must be an object');
  switch (rawParams.op) {
    case 'add':
      return addPicture(rawParams);
    case 'remove':
      return removePictures(rawParams);
    case 'picker':
      return armPicker(rawParams);
    case 'disarm': {
      // The host's journey stopped: a stub nobody used goes back, so a person's next pick is their own.
      const was = armed !== null || staged.length > 0;
      resetMedia();
      return { disarmed: was };
    }
    default:
      throw badParams('op must be "add", "remove", "picker" or "disarm"');
  }
}
