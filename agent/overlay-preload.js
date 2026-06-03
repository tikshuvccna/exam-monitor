// גשר לשכבת-העל: מקבל הודעות וטיימר מתהליך ה-main
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('examOverlay', {
  onMessage:   (cb) => ipcRenderer.on('show-message',  (e, text) => cb(text)),
  onCountdown: (cb) => ipcRenderer.on('set-countdown', (e, data) => cb(data)),
});
