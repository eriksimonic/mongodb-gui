import type { PreloadBridge } from '@mongo-gui/core';

declare global {
  interface Window {
    /** Present only inside Electron, where the preload script exposes it. */
    mongoGui?: PreloadBridge;
    mongoGuiWindow?: {
      act(action: 'minimize' | 'toggle-maximize' | 'close'): void;
      isMaximized(): Promise<boolean>;
      onMaximized(listener: (maximized: boolean) => void): () => void;
    };
  }
}
