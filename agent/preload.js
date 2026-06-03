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
  // יציאה מהאפליקציה (סיום מבחן מהמורה)
  quit: () => ipcRenderer.send('agent-quit'),
  // ניהול כתובת שרת / טעינה מחדש (משמש את מסכי ההגדרה והשגיאה)
  setServer: (url) => ipcRenderer.send('set-server', url),
  reloadExam: () => ipcRenderer.send('reload-exam'),
  showSetup: () => ipcRenderer.send('show-setup'),
  // גילוי שימוש ב-AI: דף התלמיד נרשם לקבלת אירועי חשד
  onCheat: (cb) => ipcRenderer.on('ai-cheat', (e, data) => cb(data)),
  // מסירת טקסט שאלות המבחן (לזיהוי "הועתקה שאלה")
  setQuestionText: (txt) => ipcRenderer.send('set-question-text', txt),
  // הודעה/טיימר -> שכבת-על מעל כל אתר (Option A)
  overlayMessage:   (text) => ipcRenderer.send('overlay-message', text),
  overlayCountdown: (data) => ipcRenderer.send('overlay-countdown', data),
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
