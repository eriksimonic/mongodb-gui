export interface MongoGuiApi {
  ping(): Promise<string>;
}

declare global {
  interface Window {
    /** Present only inside Electron, where the preload script exposes it. */
    mongoGui?: MongoGuiApi;
  }
}
