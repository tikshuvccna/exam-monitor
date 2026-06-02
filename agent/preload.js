// גשר בטוח בין דף התלמיד (שרץ בתוך ה-kiosk) לבין תהליך ה-main של האפליקציה.
// חושף window.examAgent עם יכולות שלא קיימות בדפדפן רגיל.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('examAgent', {
  present: true,
  version: '1.0.0',
  // חסימת/שחרור קלט אמיתית ברמת מערכת ההפעלה
  lockInput: (on) => ipcRenderer.send('agent-lock-input', on),
});
