// Preload bridge for the wallet renderer.
//
// The renderer runs sandboxed (contextIsolation:true, nodeIntegration:false,
// sandbox:true) so it can't touch the filesystem directly. When the
// onboarding flow finishes a "Start a new network" or "Join an existing
// network" choice, it has a genesis spec + a keystore that need to land on
// disk where the next ae-node spawn can read them. This preload exposes a
// narrow IPC bridge so the renderer can ask the main process to do that
// for it.
//
// Surfaced API on the renderer side:
//   window.aeNetwork.saveConfig({ mode, spec, keystore })
//     - mode: 'solo' | 'bft' (the consensus mode ae-node should boot in)
//     - spec: GenesisSpec (the public network spec; ignored when mode='solo')
//     - keystore: ValidatorKeystore (the private validator keys; ignored
//       when mode='solo')
//   Returns a promise resolving to {ok: true, configPath} on success.
//
//   window.aeNetwork.isElectron
//     - true here, undefined when running in plain browser dev. Lets the
//       wallet skip the saveConfig call gracefully when there's no main
//       process to talk to.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aeNetwork', {
  isElectron: true,
  saveConfig: (opts) => ipcRenderer.invoke('aeNetwork:saveConfig', opts),
  // Cleanly tear down + relaunch the Electron process so a freshly-saved
  // network config takes effect. The currently-running ae-node child only
  // sees its old spawn env, which is why a relaunch is needed instead of
  // hot-swapping in place.
  relaunch: () => ipcRenderer.invoke('aeNetwork:relaunch'),
});
