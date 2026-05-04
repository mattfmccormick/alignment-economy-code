// Type declarations for the preload bridge exposed in
// `ae-app/electron/preload.cjs`. The renderer can call these only when
// running inside the Electron shell; in plain browser dev (Vite, no
// Electron) `window.aeNetwork` is undefined and callers should
// short-circuit with `if (window.aeNetwork) { ... }`.

export {};

declare global {
  interface Window {
    aeNetwork?: {
      isElectron: true;
      saveConfig: (opts: {
        mode: 'solo' | 'bft';
        spec?: unknown;
        keystore?: unknown;
      }) => Promise<{ ok: boolean; error?: string; mode?: string; configPath?: string }>;
    };
  }
}
