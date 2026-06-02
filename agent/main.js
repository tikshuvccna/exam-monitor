// Exam Client - Electron companion agent
// ------------------------------------------------------------------
// תפקידים:
//  1. כריות מסך מלא (kiosk) שטוען את דף התלמיד - מונע Alt-Tab/יציאה.
//  2. שרת זיהוי מקומי על 127.0.0.1:7345 כדי שדף הדפדפן ידע שהאפליקציה מותקנת.
//  3. רישום פרוטוקול examclient:// כך שהמורה יכול "להפעיל" אותה מרחוק (Option C).
//  4. נקודות אחיזה לנעילה/חסימת קלט אמיתית ברמת מערכת ההפעלה (ראה lockInput()).
// ------------------------------------------------------------------

const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const http = require('http');

// כתובת השרת של המורה - יש לעדכן ל-IP/דומיין בפועל, או להעביר כ-argv.
const EXAM_URL = process.env.EXAM_URL || 'https://localhost:4555/student.html';
const DETECT_PORT = 7345;

let win = null;

// ── 1. חלון kiosk ───────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    kiosk: true,
    fullscreen: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      preload: require('path').join(__dirname, 'preload.js'),
    },
  });
  // self-signed cert של שרת המבחן - מאשרים אוטומטית
  win.webContents.session.setCertificateVerifyProc((req, cb) => cb(0));
  win.loadURL(EXAM_URL);
  win.on('closed', () => { win = null; });
}

// ── 2. שרת זיהוי מקומי ─────────────────────────────────────────
function startDetectServer() {
  http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');   // כדי שדף הדפדפן יוכל לבדוק
    if (req.url === '/ping') { res.writeHead(200); res.end('exam-client'); return; }
    res.writeHead(404); res.end();
  }).listen(DETECT_PORT, '127.0.0.1', () => {
    console.log(`detect server on 127.0.0.1:${DETECT_PORT}`);
  });
}

// ── 3. רישום פרוטוקול examclient:// (Option C) ─────────────────
app.setAsDefaultProtocolClient('examclient');
// אם המשתמש פותח examclient://start והאפליקציה כבר רצה - נביא אותה לקדמת הבמה.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on('second-instance', (e, argv) => {
    if (win) { win.show(); win.focus(); }
    handleProtocol(argv.find(a => a.startsWith('examclient://')));
  });
}
function handleProtocol(url) {
  if (!url) return;
  // examclient://start  /  examclient://lock  וכו'
  const action = url.replace('examclient://', '').replace(/\/$/, '');
  if (action === 'start' && !win) createWindow();
  // ניתן להרחיב: lock / unlock וכו'
}

// ── 4. נעילה / חסימת קלט אמיתית (נקודת הרחבה) ─────────────────
// ברירת מחדל: חסימה ברמת ה-kiosk (globalShortcut חוסם קיצורים).
// לחסימה מלאה של מקלדת/עכבר ושליטה מרחוק התקן @nut-tree/nut-js או robotjs
// והשלם כאן את הקריאות ל-API שלהם.
function lockInput(on) {
  if (on) {
    // חסימת קיצורים נפוצים (לא חוסם Ctrl+Alt+Del - אבטחת Windows)
    ['Alt+Tab','Alt+F4','Super','Control+W','Control+Shift+I','F11','Control+R']
      .forEach(k => { try { globalShortcut.register(k, () => {}); } catch {} });
  } else {
    globalShortcut.unregisterAll();
  }
  // TODO: לחסימה אמיתית של כל המקלדת/עכבר:
  //   const { keyboard, mouse } = require('@nut-tree/nut-js');  // או robotjs
  //   והשתמש ב-hook ברמת מערכת ההפעלה.
}

// גשר IPC מדף התלמיד (preload חושף window.examAgent)
ipcMain.on('agent-lock-input', (e, on) => lockInput(!!on));

// ── אתחול ──────────────────────────────────────────────────────
app.whenReady().then(() => {
  startDetectServer();
  createWindow();
  handleProtocol(process.argv.find(a => a.startsWith('examclient://')));
});
app.on('window-all-closed', () => { /* נשאר חי כדי לשרת examclient:// ואת שרת הזיהוי */ });
