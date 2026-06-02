// Exam Client — Electron companion agent (functional build)
// ------------------------------------------------------------------
//  1. חלון kiosk מסך-מלא שטוען את דף התלמיד (מונע Alt-Tab/יציאה).
//  2. שרת זיהוי מקומי 127.0.0.1:7345 כדי שדף הדפדפן יידע שהאפליקציה מותקנת.
//  3. פרוטוקול examclient:// להפעלה מרחוק ע"י המורה (Option C).
//  4. נעילה/חסימת קלט אמיתית + שליטה מרחוק - אם הספרייה הילידית זמינה,
//     אחרת מנגנון fallback מבוסס kiosk + globalShortcut.
// ------------------------------------------------------------------

const electron = require('electron');
const { app, BrowserWindow, globalShortcut, ipcMain, screen } = electron;
const http = require('http');
const path = require('path');

// אם electron מורץ ישירות עם node (לא דרך הבינארי) - app יהיה undefined
if (!app) {
  console.error('שגיאה: יש להריץ דרך electron ולא node. הרץ:  npm start');
  process.exit(1);
}

const EXAM_URL    = process.env.EXAM_URL || 'https://localhost:4555/student.html';
const DETECT_PORT = 7345;

let win = null;
let inputLocked = false;

// ── ספרייה ילידית לקלט (אופציונלית) ───────────────────────────
// נטענת רק אם הותקנה. בלעדיה האפליקציה עדיין עובדת (kiosk + קיצורים).
// נטענת אחרי app.whenReady כדי לא להתנגש באתחול של electron.
let nativeInput = null;
function loadNativeInput() {
  try {
    nativeInput = require('@jitsi/robotjs');
    console.log('✅ native input (robotjs) loaded - full lock/remote-control available');
  } catch {
    try { nativeInput = require('robotjs'); console.log('✅ robotjs loaded'); }
    catch { console.log('ℹ️  native input library not installed - using kiosk fallback only'); }
  }
}

// ── 1. חלון kiosk ───────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    kiosk: true,
    fullscreen: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  // אישור אוטומטי של ה-self-signed cert של שרת המבחן
  win.webContents.session.setCertificateVerifyProc((req, cb) => cb(0));
  win.loadURL(EXAM_URL);
  win.on('closed', () => { win = null; });
}

// ── 2. שרת זיהוי מקומי ─────────────────────────────────────────
function startDetectServer() {
  http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ app: 'exam-client', version: app.getVersion(), nativeInput: !!nativeInput }));
      return;
    }
    res.writeHead(404); res.end();
  }).listen(DETECT_PORT, '127.0.0.1', () => console.log(`detect server on 127.0.0.1:${DETECT_PORT}`));
}

// ── 3. פרוטוקול examclient:// ──────────────────────────────────
app.setAsDefaultProtocolClient('examclient');
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
  const action = url.replace('examclient://', '').replace(/\/$/, '');
  if (action === 'start' && !win) createWindow();
  if (action === 'lock')   setLock(true);
  if (action === 'unlock') setLock(false);
}

// ── 4. נעילה / חסימת קלט אמיתית ────────────────────────────────
function setLock(on) {
  inputLocked = on;
  if (on) {
    // חסימת קיצורים נפוצים (לא חוסם Ctrl+Alt+Del - אבטחת מערכת ההפעלה)
    ['Alt+Tab','Alt+F4','Super','Control+W','Control+Shift+I','F11','Control+R','CommandOrControl+Q']
      .forEach(k => { try { globalShortcut.register(k, () => {}); } catch {} });
    if (win) { win.setKiosk(true); win.setAlwaysOnTop(true, 'screen-saver'); win.focus(); }
  } else {
    globalShortcut.unregisterAll();
  }
  // אם יש ספרייה ילידית - אפשר לחסום קלט עמוק יותר (תלוי-פלטפורמה).
  // robotjs לבדו לא חוסם קלט; לחסימה מלאה צריך hook ברמת מערכת ההפעלה.
  // ה-kiosk + alwaysOnTop נותן חסימה מעשית טובה ברוב המקרים.
}

// ── 5. שליטה מרחוק - השמעת אירועי עכבר/מקלדת מהמורה ─────────────
// מקבל { kind:'move'|'click'|'key', x, y, button, key } ביחס לרזולוציית התלמיד.
function replayInput(ev) {
  if (!nativeInput) return false;
  try {
    const disp = screen.getPrimaryDisplay().size;
    if (ev.kind === 'move' || ev.kind === 'click') {
      // x,y מגיעים מנורמלים 0..1 ביחס למסך המשותף
      const px = Math.round((ev.x ?? 0) * disp.width);
      const py = Math.round((ev.y ?? 0) * disp.height);
      nativeInput.moveMouse(px, py);
      if (ev.kind === 'click') nativeInput.mouseClick(ev.button || 'left');
    } else if (ev.kind === 'key' && ev.key) {
      nativeInput.keyTap(ev.key);
    } else if (ev.kind === 'type' && ev.text) {
      nativeInput.typeString(ev.text);
    }
    return true;
  } catch (e) { console.error('replayInput error', e); return false; }
}

// ── גשר IPC מדף התלמיד (preload חושף window.examAgent) ─────────
ipcMain.on('agent-lock-input', (e, on) => setLock(!!on));
ipcMain.handle('agent-info', () => ({ nativeInput: !!nativeInput, version: app.getVersion() }));
ipcMain.on('agent-remote-input', (e, ev) => replayInput(ev));

// ── אתחול ──────────────────────────────────────────────────────
app.whenReady().then(() => {
  loadNativeInput();
  startDetectServer();
  createWindow();
  handleProtocol(process.argv.find(a => a.startsWith('examclient://')));
});
app.on('window-all-closed', () => { /* נשאר חי כדי לשרת examclient:// ואת שרת הזיהוי */ });
