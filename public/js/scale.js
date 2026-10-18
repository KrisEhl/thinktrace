// Resolution of the game world. On HiDPI screens one world pixel is one CSS
// pixel (2 device pixels), so text in the level is as sharp as the HUD; on
// standard screens it stays 2 CSS pixels. Either way pixels map evenly.
// K converts sizes and speeds tuned for the 2x layout into world units.
const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
export const DEVICE_PX = dpr >= 2 ? dpr : 2;
export const SCALE = DEVICE_PX / dpr;
export const K = 2 / SCALE;
