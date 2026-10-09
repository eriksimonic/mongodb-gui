/**
 * The P0-2 preload bridge type. Only the Electron preload still imports it. Delete this file
 * when P1-4 replaces the preload with the RPC client.
 */
export interface MongoGuiApi {
  ping(): Promise<string>;
}

declare global {
  interface Window {
    /** Present only inside Electron, where the preload script exposes it. */
    mongoGui?: MongoGuiApi;
  }
}
