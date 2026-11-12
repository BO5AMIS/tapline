/** gifenc 1.0.3 ships no types: the small part of it Tapline uses (CommonJS build, so the default export holds the functions). */
declare module "gifenc" {
  type Palette = number[][];
  interface WriteFrameOptions {
    palette?: Palette;
    /** Milliseconds (the encoder rounds to hundredths of a second). */
    delay?: number;
    /** -1 once, 0 forever, n times. */
    repeat?: number;
    transparent?: boolean;
    transparentIndex?: number;
    dispose?: number;
    colorDepth?: number;
  }
  interface GifEncoder {
    writeFrame(index: Uint8Array, width: number, height: number, options?: WriteFrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  interface Gifenc {
    GIFEncoder(options?: { initialCapacity?: number; auto?: boolean }): GifEncoder;
    quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, options?: { format?: "rgb565" | "rgb444" | "rgba4444" }): Palette;
    applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: Palette, format?: "rgb565" | "rgb444" | "rgba4444"): Uint8Array;
  }
  const gifenc: Gifenc;
  export default gifenc;
}
