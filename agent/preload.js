// גשר בטוח בין דף התלמיד (שרץ בתוך ה-kiosk) לבין תהליך ה-main.
// חושף window.examAgent עם יכולות שלא קיימות בדפדפן רגיל,
// ומזריק באנר "פיקוח פעיל" קבוע (דרישת שקיפות/הסכמה).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('examAgent', {
  present: true,
  version: '1.0.0',
  info: () => ipcRenderer.invoke('agent-info'),
  // חסימת/שחרור קלט אמיתית
  lockInput: (on) => ipcRenderer.send('agent-lock-input', on),
  // השמעת אירוע קלט מהמורה (שליטה מרחוק)
  remoteInput: (ev) => ipcRenderer.send('agent-remote-input', ev),
});

// ── באנר שקיפות: התלמיד תמיד רואה שהמכשיר בפיקוח ──────────────
window.addEventListener('DOMContentLoaded', () => {
  const bar = document.createElement('div');
  bar.textContent = '🔴 מצב פיקוח פעיל — מכשיר זה מנוטר על ידי אפליקציית המבחן';
  bar.style.cssText = [
    'position:fixed','bottom:0','left:0','right:0','z-index:2147483647',
    'background:#7f1d1d','color:#fff','font:600 12px sans-serif',
    'text-align:center','padding:5px','pointer-events:none','direction:rtl',
  ].join(';');
  document.body.appendChild(bar);
});
