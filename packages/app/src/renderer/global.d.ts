import type { PreloadBridge } from '@mongo-gui/core';

declare global {
  interface Window {
    /** Present only inside Electron, where the preload script exposes it. */
    mongoGui?: PreloadBridge;
  }
}
