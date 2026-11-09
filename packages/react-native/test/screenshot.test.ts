import { Dimensions, PixelRatio } from 'react-native';
import { screenshot, screenshotAvailable } from '../src/actions';
import { TaplineError } from '../src/types';

const mockCaptureScreen = jest.fn<Promise<string>, [Record<string, unknown>]>();

// react-native-view-shot is an optional peer, not installed here.
jest.mock('react-native-view-shot', () => ({ captureScreen: (options: Record<string, unknown>) => mockCaptureScreen(options) }), { virtual: true });

beforeEach(() => {
  mockCaptureScreen.mockReset();
  mockCaptureScreen.mockResolvedValue('BASE64DATA');
  jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 402, height: 874, scale: 3, fontScale: 1 });
  jest.spyOn(PixelRatio, 'get').mockReturnValue(3);
});

afterEach(() => jest.restoreAllMocks());

describe('screenshot', () => {
  test('is available when react-native-view-shot can be required', () => {
    expect(screenshotAvailable()).toBe(true);
  });

  test('defaults: jpg, quality 0.7, scaled to 600 px wide', async () => {
    const result = await screenshot({});
    expect(mockCaptureScreen).toHaveBeenCalledWith({ format: 'jpg', quality: 0.7, result: 'base64', width: 600, height: 1304 });
    expect(result).toEqual({ mime: 'image/jpeg', data: 'BASE64DATA', width: 600, height: 1304 });
  });

  test('honours format, quality and maxWidth', async () => {
    const result = await screenshot({ format: 'png', quality: 0.9, maxWidth: 300 });
    expect(mockCaptureScreen).toHaveBeenCalledWith({ format: 'png', quality: 0.9, result: 'base64', width: 300, height: 652 });
    expect(result.mime).toBe('image/png');
    expect(result.width).toBe(300);
  });

  test('never upscales beyond the native pixel width', async () => {
    const result = await screenshot({ maxWidth: 5000 });
    expect(result.width).toBe(1206); // 402 pt * 3
    expect(result.height).toBe(2622);
  });

  test('capture failures become internal errors', async () => {
    mockCaptureScreen.mockRejectedValue(new Error('no snapshot'));
    await expect(screenshot({})).rejects.toMatchObject({ code: 'internal', message: expect.stringContaining('no snapshot') });
    await expect(screenshot({})).rejects.toBeInstanceOf(TaplineError);
  });
});
