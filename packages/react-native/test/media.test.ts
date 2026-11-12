import { setEventSink } from '../src/events';
import {
  addedAssetIds,
  media,
  pickerArmed,
  registerTaplinePickerHook,
  resetMedia,
  setMediaModules,
  setMediaPatience,
  type MediaModules,
  type TaplinePickerPicture,
} from '../src/media';
import { TaplineError } from '../src/types';

// AGENT-TOOLS 1.12 §17.6: media in the app. Every optional module is mocked.

const PICTURE = { name: 'breakfast.jpg', mime: 'image/jpeg', data: 'QUJD' };

interface Library {
  createAssetAsync: jest.Mock<Promise<{ id: string }>, [string]>;
  deleteAssetsAsync: jest.Mock<Promise<boolean>, [string[]]>;
  getPermissionsAsync: jest.Mock<Promise<unknown>, [boolean?]>;
  requestPermissionsAsync: jest.Mock<Promise<unknown>, [boolean?]>;
  // Reading the library: Tapline must never call any of these.
  getAssetsAsync: jest.Mock;
  getAssetInfoAsync: jest.Mock;
  getAlbumsAsync: jest.Mock;
  getAlbumAsync: jest.Mock;
}

function expoLibrary(permission: 'granted' | 'undetermined' | 'denied' = 'granted'): Library {
  let n = 0;
  let state = permission;
  return {
    createAssetAsync: jest.fn(async (_uri: string) => ({ id: `asset-${++n}` })),
    deleteAssetsAsync: jest.fn(async (_ids: string[]) => true),
    getPermissionsAsync: jest.fn(async () => ({ granted: state === 'granted', status: state, canAskAgain: state !== 'denied' })),
    requestPermissionsAsync: jest.fn(async () => {
      state = 'granted';
      return { granted: true, status: 'granted' };
    }),
    getAssetsAsync: jest.fn(),
    getAssetInfoAsync: jest.fn(),
    getAlbumsAsync: jest.fn(),
    getAlbumAsync: jest.fn(),
  };
}

function noReads(lib: Library): void {
  expect(lib.getAssetsAsync).not.toHaveBeenCalled();
  expect(lib.getAssetInfoAsync).not.toHaveBeenCalled();
  expect(lib.getAlbumsAsync).not.toHaveBeenCalled();
  expect(lib.getAlbumAsync).not.toHaveBeenCalled();
}

function fileSystem() {
  return {
    cacheDirectory: 'file:///cache/',
    writeAsStringAsync: jest.fn(async () => undefined),
    deleteAsync: jest.fn(async () => undefined),
  };
}

function modules(parts: Partial<MediaModules>): MediaModules {
  return { expo: null, cameraRoll: null, fileSystem: fileSystem(), imagePicker: null, ...parts };
}

beforeEach(() => {
  setMediaPatience(40);
});

afterEach(() => {
  resetMedia();
  setMediaModules(undefined);
  setEventSink(null);
});

describe('add with expo-media-library', () => {
  test('writes the picture to the cache, saves it, remembers the id and removes the temporary file', async () => {
    const lib = expoLibrary();
    const files = fileSystem();
    setMediaModules(modules({ expo: lib, fileSystem: files }));
    expect(await media({ op: 'add', ...PICTURE })).toEqual({ id: 'asset-1' });
    expect(files.writeAsStringAsync).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\/\/cache\/tapline-media-.*\.jpg$/), 'QUJD', { encoding: 'base64' });
    expect(lib.createAssetAsync).toHaveBeenCalledTimes(1);
    expect(files.deleteAsync).toHaveBeenCalledWith(expect.stringContaining('tapline-media-'), { idempotent: true });
    expect(addedAssetIds()).toEqual(['asset-1']);
    noReads(lib);
  });

  test('asks only for write access, and remembers every id in order', async () => {
    const lib = expoLibrary('undetermined');
    setMediaModules(modules({ expo: lib }));
    await media({ op: 'add', ...PICTURE });
    await media({ op: 'add', ...PICTURE, name: 'b.png', mime: 'image/png' });
    expect(lib.requestPermissionsAsync).toHaveBeenCalledWith(true);
    expect(lib.getPermissionsAsync).toHaveBeenCalledWith(true);
    expect(addedAssetIds()).toEqual(['asset-1', 'asset-2']);
    noReads(lib);
  });

  test('answers needsPerson while the OS prompt is unanswered, and works once the person allowed', async () => {
    const lib = expoLibrary('undetermined');
    let allow: () => void = () => undefined;
    lib.requestPermissionsAsync.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          allow = () => resolve({ granted: true, status: 'granted' });
        }),
    );
    setMediaModules(modules({ expo: lib }));
    expect(await media({ op: 'add', ...PICTURE })).toEqual({ needsPerson: true });
    expect(lib.createAssetAsync).not.toHaveBeenCalled();
    // The agent asks again while the prompt is still up: the same prompt, not a second one.
    expect(await media({ op: 'add', ...PICTURE })).toEqual({ needsPerson: true });
    expect(lib.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    lib.getPermissionsAsync.mockResolvedValue({ granted: true, status: 'granted' });
    allow();
    expect(await media({ op: 'add', ...PICTURE })).toEqual({ id: 'asset-1' });
  });

  test('says a denied permission in words', async () => {
    const lib = expoLibrary('denied');
    setMediaModules(modules({ expo: lib }));
    await expect(media({ op: 'add', ...PICTURE })).rejects.toMatchObject({ code: 'not_actionable', message: expect.stringContaining('did not allow adding photos') });
    expect(lib.createAssetAsync).not.toHaveBeenCalled();
  });

  test('refuses a bad request', async () => {
    setMediaModules(modules({ expo: expoLibrary() }));
    await expect(media({ op: 'add', name: 'a.jpg' })).rejects.toMatchObject({ code: 'bad_params' });
    await expect(media({ op: 'fly' })).rejects.toMatchObject({ code: 'bad_params' });
    await expect(media('x')).rejects.toMatchObject({ code: 'bad_params' });
  });
});

describe('add with @react-native-camera-roll/camera-roll', () => {
  function roll() {
    let n = 0;
    return {
      save: jest.fn(async () => `ph://camera-${++n}`),
      deletePhotos: jest.fn(async () => undefined),
      getPhotos: jest.fn(),
    };
  }

  test('falls back to it when expo-media-library is missing', async () => {
    const cameraRoll = roll();
    setMediaModules(modules({ cameraRoll }));
    expect(await media({ op: 'add', ...PICTURE })).toEqual({ id: 'ph://camera-1' });
    expect(cameraRoll.save).toHaveBeenCalledWith(expect.stringContaining('tapline-media-'), { type: 'photo' });
    expect(addedAssetIds()).toEqual(['ph://camera-1']);
    expect(cameraRoll.getPhotos).not.toHaveBeenCalled();
  });

  test('prefers expo-media-library when both are there', async () => {
    const lib = expoLibrary();
    const cameraRoll = roll();
    setMediaModules(modules({ expo: lib, cameraRoll }));
    await media({ op: 'add', ...PICTURE });
    expect(cameraRoll.save).not.toHaveBeenCalled();
    expect(lib.createAssetAsync).toHaveBeenCalled();
  });

  test('while the OS prompt is up the answer is needsPerson, and a retry does not save twice', async () => {
    const cameraRoll = roll();
    let allow: () => void = () => undefined;
    cameraRoll.save.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          allow = () => resolve('ph://late');
        }),
    );
    setMediaModules(modules({ cameraRoll }));
    expect(await media({ op: 'add', ...PICTURE })).toEqual({ needsPerson: true });
    allow();
    expect(await media({ op: 'add', ...PICTURE })).toEqual({ id: 'ph://late' });
    expect(cameraRoll.save).toHaveBeenCalledTimes(1);
    expect(addedAssetIds()).toEqual(['ph://late']);
  });
});

describe('add without a library', () => {
  test('is unsupported, in the shared words', async () => {
    setMediaModules(modules({}));
    const error = await media({ op: 'add', ...PICTURE }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaplineError);
    expect(error).toMatchObject({
      code: 'unsupported',
      message: "this app has no photo-library module (expo-media-library or @react-native-camera-roll/camera-roll); Tapwright's media adds pictures for any app.",
    });
    expect(addedAssetIds()).toEqual([]);
  });

  test('is unsupported without a file system to hand the picture over', async () => {
    setMediaModules({ expo: expoLibrary(), cameraRoll: null, fileSystem: null, imagePicker: null });
    await expect(media({ op: 'add', ...PICTURE })).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('expo-file-system') });
  });
});

describe('remove', () => {
  test('deletes only what this session added, then forgets them', async () => {
    const lib = expoLibrary();
    setMediaModules(modules({ expo: lib }));
    await media({ op: 'add', ...PICTURE });
    await media({ op: 'add', ...PICTURE });
    expect(await media({ op: 'remove' })).toEqual({ removed: 2 });
    expect(lib.deleteAssetsAsync).toHaveBeenCalledTimes(1);
    expect(lib.deleteAssetsAsync).toHaveBeenCalledWith(['asset-1', 'asset-2']);
    expect(addedAssetIds()).toEqual([]);
    expect(await media({ op: 'remove' })).toEqual({ removed: 0 });
    expect(lib.deleteAssetsAsync).toHaveBeenCalledTimes(1);
    noReads(lib);
  });

  test('also deletes ids the host kept from this session, never anything else', async () => {
    const lib = expoLibrary();
    setMediaModules(modules({ expo: lib }));
    await media({ op: 'add', ...PICTURE });
    await media({ op: 'remove', ids: ['asset-1', 'earlier-session', 7] });
    expect(lib.deleteAssetsAsync).toHaveBeenCalledWith(['asset-1', 'earlier-session']);
  });

  test('nothing to delete is not a call to the library', async () => {
    const lib = expoLibrary();
    setMediaModules(modules({ expo: lib }));
    expect(await media({ op: 'remove' })).toEqual({ removed: 0 });
    expect(lib.deleteAssetsAsync).not.toHaveBeenCalled();
  });

  test('keeps the ids when the person declines the OS confirmation', async () => {
    const lib = expoLibrary();
    setMediaModules(modules({ expo: lib }));
    await media({ op: 'add', ...PICTURE });
    lib.deleteAssetsAsync.mockResolvedValueOnce(false);
    expect(await media({ op: 'remove' })).toEqual({ removed: 0, declined: true });
    expect(addedAssetIds()).toEqual(['asset-1']);
  });

  test('says pending while the person has not answered, then forgets when they confirm', async () => {
    const lib = expoLibrary();
    setMediaModules(modules({ expo: lib }));
    await media({ op: 'add', ...PICTURE });
    let confirm: () => void = () => undefined;
    lib.deleteAssetsAsync.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          confirm = () => resolve(true);
        }),
    );
    expect(await media({ op: 'remove' })).toEqual({ removed: 1, pending: true });
    confirm();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(addedAssetIds()).toEqual([]);
  });

  test('uses the camera roll to delete what the camera roll saved', async () => {
    const deletePhotos = jest.fn(async () => undefined);
    setMediaModules(modules({ cameraRoll: { save: jest.fn(async () => 'ph://1'), deletePhotos } }));
    await media({ op: 'add', ...PICTURE });
    await media({ op: 'remove' });
    expect(deletePhotos).toHaveBeenCalledWith(['ph://1']);
  });

  test('without a library it is unsupported too', async () => {
    setMediaModules(modules({}));
    await expect(media({ op: 'remove' })).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('picker', () => {
  function pickerModule() {
    const library = jest.fn(async () => ({ canceled: true, assets: null }));
    const camera = jest.fn(async () => ({ canceled: true, assets: null }));
    const mod: Record<string, unknown> = { launchImageLibraryAsync: library, launchCameraAsync: camera, MediaTypeOptions: {} };
    return { mod, library, camera };
  }

  const arm = (extra: Record<string, unknown> = {}) => media({ op: 'picker', index: 1, total: 1, width: 640, height: 480, ...PICTURE, ...extra });

  test('the next launchImageLibraryAsync returns the pictures as if picked, without the OS picker', async () => {
    const { mod, library } = pickerModule();
    setMediaModules(modules({ imagePicker: mod }));
    expect(await arm()).toEqual({ pictures: 1, hooks: 0 });
    expect(pickerArmed()).toBe(true);
    const result = (await (mod.launchImageLibraryAsync as (o: unknown) => Promise<unknown>)({ mediaTypes: 'images' })) as {
      canceled: boolean;
      assets: Array<Record<string, unknown>>;
    };
    expect(library).not.toHaveBeenCalled();
    expect(result.canceled).toBe(false);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({ uri: 'data:image/jpeg;base64,QUJD', type: 'image', fileName: 'breakfast.jpg', mimeType: 'image/jpeg', width: 640, height: 480 });
  });

  test('disarm puts the picker back: the next pick is the OS picker again (1.5 review, finding 5)', async () => {
    const { mod, library } = pickerModule();
    setMediaModules(modules({ imagePicker: mod }));
    await arm();
    expect(pickerArmed()).toBe(true);
    expect(await media({ op: 'disarm' })).toEqual({ disarmed: true });
    expect(pickerArmed()).toBe(false);
    await (mod.launchImageLibraryAsync as (o: unknown) => Promise<unknown>)({ mediaTypes: 'images' });
    expect(library).toHaveBeenCalledTimes(1);
    expect(await media({ op: 'disarm' })).toEqual({ disarmed: false });
  });

  test('also answers launchCameraAsync, with several pictures staged one request at a time', async () => {
    const { mod } = pickerModule();
    setMediaModules(modules({ imagePicker: mod }));
    expect(await arm({ index: 1, total: 2 })).toEqual({ pictures: 1, hooks: 0 });
    expect(pickerArmed()).toBe(false);
    expect(await arm({ index: 2, total: 2, name: 'label.png', mime: 'image/png' })).toEqual({ pictures: 2, hooks: 0 });
    const result = (await (mod.launchCameraAsync as () => Promise<unknown>)()) as { assets: unknown[] };
    expect(result.assets).toHaveLength(2);
  });

  test('is used once: the original is back for the second call', async () => {
    const { mod, library, camera } = pickerModule();
    const originalLibrary = mod.launchImageLibraryAsync;
    const originalCamera = mod.launchCameraAsync;
    setMediaModules(modules({ imagePicker: mod }));
    await arm();
    expect(mod.launchImageLibraryAsync).not.toBe(originalLibrary);
    await (mod.launchImageLibraryAsync as () => Promise<unknown>)();
    expect(mod.launchImageLibraryAsync).toBe(originalLibrary);
    expect(mod.launchCameraAsync).toBe(originalCamera);
    expect(pickerArmed()).toBe(false);
    await (mod.launchImageLibraryAsync as () => Promise<unknown>)();
    expect(library).toHaveBeenCalledTimes(1);
    expect(camera).not.toHaveBeenCalled();
  });

  test('tells the host when the pick was skipped', async () => {
    const { mod } = pickerModule();
    setMediaModules(modules({ imagePicker: mod }));
    const events: Array<[string, unknown]> = [];
    setEventSink((event, data) => events.push([event, data]));
    await arm();
    await (mod.launchImageLibraryAsync as () => Promise<unknown>)();
    expect(events).toContainEqual(['pickerSkipped', { count: 1 }]);
  });

  test('is restored when the connection ends, and the pictures are forgotten', async () => {
    const { mod } = pickerModule();
    const original = mod.launchImageLibraryAsync;
    setMediaModules(modules({ imagePicker: mod }));
    await arm();
    resetMedia();
    expect(mod.launchImageLibraryAsync).toBe(original);
    expect(pickerArmed()).toBe(false);
  });

  test('arming again replaces the pictures and wraps only once', async () => {
    const { mod } = pickerModule();
    const original = mod.launchImageLibraryAsync;
    setMediaModules(modules({ imagePicker: mod }));
    await arm();
    await arm({ name: 'second.jpg' });
    const result = (await (mod.launchImageLibraryAsync as () => Promise<unknown>)()) as { assets: Array<{ fileName: string }> };
    expect(result.assets.map((a) => a.fileName)).toEqual(['second.jpg']);
    expect(mod.launchImageLibraryAsync).toBe(original);
  });

  test('is unsupported without expo-image-picker or a hook', async () => {
    setMediaModules(modules({}));
    await expect(arm()).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('registerTaplinePickerHook') });
  });

  test('is unsupported, naming the hook, when the picker module is read-only', async () => {
    const frozen = Object.freeze({ launchImageLibraryAsync: async () => ({ canceled: true }), launchCameraAsync: async () => ({ canceled: true }) });
    setMediaModules(modules({ imagePicker: frozen }));
    await expect(arm()).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining("can't be wrapped") });
    expect(pickerArmed()).toBe(false);
  });

  test('a registered hook gets the pictures for an app with another picker', async () => {
    setMediaModules(modules({}));
    const got: TaplinePickerPicture[][] = [];
    const unregister = registerTaplinePickerHook((pictures) => {
      got.push([...pictures]);
    });
    expect(await arm()).toEqual({ pictures: 1, hooks: 1 });
    expect(got[0]?.[0]).toMatchObject({ uri: 'data:image/jpeg;base64,QUJD', fileName: 'breakfast.jpg', width: 640, height: 480 });
    unregister();
    await expect(arm()).rejects.toMatchObject({ code: 'unsupported' });
  });

  test('never touches the photo library', async () => {
    const lib = expoLibrary();
    const { mod } = pickerModule();
    setMediaModules(modules({ expo: lib, imagePicker: mod }));
    await arm();
    await (mod.launchImageLibraryAsync as () => Promise<unknown>)();
    expect(lib.createAssetAsync).not.toHaveBeenCalled();
    expect(lib.requestPermissionsAsync).not.toHaveBeenCalled();
    noReads(lib);
  });
});
