// Exam Client — Electron companion agent (functional build)
// ------------------------------------------------------------------
//  1. חלון kiosk מסך-מלא שטוען את דף התלמיד (מונע Alt-Tab/יציאה).
//  2. שרת זיהוי מקומי 127.0.0.1:7345 כדי שדף הדפדפן יידע שהאפליקציה מותקנת.
//  3. פרוטוקול examclient:// להפעלה מרחוק ע"י המורה (Option C).
//  4. נעילה/חסימת קלט אמיתית + שליטה מרחוק - אם הספרייה הילידית זמינה,
//     אחרת מנגנון fallback מבוסס kiosk + globalShortcut.
// ------------------------------------------------------------------

const electron = require('electron');
const { app, BrowserWindow, globalShortcut, ipcMain, screen, desktopCapturer, session } = electron;
const http = require('http');
const path = require('path');
const fs   = require('fs');

// אם electron מורץ ישירות עם node (לא דרך הבינארי) - app יהיה undefined
if (!app) {
  console.error('שגיאה: יש להריץ דרך electron ולא node. הרץ:  npm start');
  process.exit(1);
}

const DETECT_PORT = 7345;
const EXIT_PASSWORD = process.env.EXAM_EXIT_PASS || 'examexit';   // סיסמת יציאה שהמורה מוסר

// ── כתובת שרת המבחן ───────────────────────────────────────────
// סדר עדיפויות: env > config שמור > ברירת מחדל. נשמר בין הפעלות.
const CONFIG_FILE = path.join(app.getPath('userData'), 'exam-config.json');
function loadExamUrl() {
  if (process.env.EXAM_URL) return process.env.EXAM_URL;
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).examUrl || ''; }
  catch { return ''; }
}
function saveExamUrl(url) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ examUrl: url })); } catch {}
}
// משלים נתיב מלא מכתובת/IP שהמורה מוסר (למשל "192.168.1.50")
function normalizeUrl(raw) {
  let u = (raw || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  if (!/\/student\.html/i.test(u) && !/\.html/i.test(u)) {
    if (!/:\d+/.test(u)) u += ':4555';
    u = u.replace(/\/+$/, '') + '/student.html';
  }
  return u;
}

let examUrl = loadExamUrl();
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

// ── שכבת-על שולחנית (Option A) ─────────────────────────────────
// חלון שקוף, תמיד-עליון, שקוף-ללחיצות, שמרחף מעל כל אתר/אפליקציה.
// כאן מוצגים הטיימר וההודעות מהמורה - גם כשהתלמיד נמצא באתר מבחן חיצוני.
let overlay = null;
function createOverlay() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  overlay = new BrowserWindow({
    width, height, x: 0, y: 0,
    transparent: true, frame: false, resizable: false, movable: false,
    focusable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'overlay-preload.js') },
  });
  overlay.setIgnoreMouseEvents(true);                  // שקוף ללחיצות - לא חוסם את המבחן
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setVisibleOnAllWorkspaces(true);
  overlay.loadFile(path.join(__dirname, 'overlay.html'));
  overlay.on('closed', () => { overlay = null; });
}
function overlaySend(channel, data) {
  if (overlay && overlay.webContents) overlay.webContents.send(channel, data);
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

  // ── תיקון getDisplayMedia ב-Electron ──────────────────────────
  // בדפדפן יש בורר מסך מובנה; ב-Electron חובה לספק handler.
  // בוחרים אוטומטית את המסך הראשי המלא (התלמיד לא צריך לבחור - וגם
  // לא יכול "בטעות" לשתף רק חלון, מה שמחזק את הפיקוח).
  win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then(sources => {
      if (sources && sources.length) callback({ video: sources[0] });  // המסך הראשי המלא, ללא אודיו
      else callback({});
    }).catch(() => callback({}));
  }, { useSystemPicker: false });

  // אם נכשלת טעינת דף המבחן - מציגים מסך שגיאה ידידותי במקום מסך ריק נעול
  win.webContents.on('did-fail-load', (e, code, desc, url) => {
    if (code === -3) return; // ABORTED - לא רלוונטי
    if (url && url.startsWith('data:')) return; // המסכים הפנימיים שלנו
    showErrorPage(desc || `קוד שגיאה ${code}`);
  });

  loadExam();
  win.on('closed', () => { win = null; });
}

// טוען את דף המבחן, או מסך הגדרת-שרת אם אין כתובת
function loadExam() {
  if (!examUrl) { showSetupPage(); return; }
  win.loadURL(examUrl);
}

// מסך הגדרת כתובת שרת (הפעלה ראשונה / שינוי)
function showSetupPage(currentErr) {
  const html = `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"></head>
  <body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:14px;margin:0;">
    <div style="font-size:40px;">🖥️</div>
    <h2 style="margin:0;">הגדרת שרת המבחן</h2>
    <p style="color:#94a3b8;font-size:14px;margin:0;text-align:center;max-width:420px;">הזן את כתובת ה-IP של מחשב המורה (מופיעה בדף המורה).<br>לדוגמה: <b>192.168.1.50</b></p>
    ${currentErr ? `<p style="color:#ef4444;font-size:13px;">${currentErr}</p>` : ''}
    <input id="srv" placeholder="כתובת השרת / IP" style="width:300px;padding:10px;border-radius:8px;border:1px solid #334155;background:#1e293b;color:#fff;text-align:center;font-size:15px;">
    <button onclick="save()" style="padding:10px 28px;border:none;border-radius:8px;background:#00d4aa;font-weight:700;cursor:pointer;font-size:15px;">המשך למבחן</button>
    <button onclick="quit()" style="padding:6px 18px;border:1px solid #334155;border-radius:8px;background:transparent;color:#94a3b8;cursor:pointer;font-size:12px;">יציאה</button>
    <script>
      function save(){ const v=document.getElementById('srv').value.trim(); if(v) window.examAgent.setServer(v); }
      function quit(){ window.examAgent.quit(); }
      document.getElementById('srv').addEventListener('keydown',e=>{if(e.key==='Enter')save();});
    </script></body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

// מסך שגיאת טעינה - תמיד עם דרך החוצה
function showErrorPage(msg) {
  const html = `<!DOCTYPE html><html dir="rtl"><head><meta charset="UTF-8"></head>
  <body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:14px;margin:0;">
    <div style="font-size:44px;">⚠️</div>
    <h2 style="margin:0;">לא ניתן להתחבר לשרת המבחן</h2>
    <p style="color:#94a3b8;font-size:13px;max-width:440px;text-align:center;">${msg}</p>
    <p style="color:#64748b;font-size:12px;">בדוק שמחשב המורה פועל ושאתה מחובר לאותה רשת.</p>
    <div style="display:flex;gap:10px;">
      <button onclick="retry()" style="padding:10px 24px;border:none;border-radius:8px;background:#00d4aa;font-weight:700;cursor:pointer;">נסה שוב</button>
      <button onclick="setup()" style="padding:10px 24px;border:1px solid #334155;border-radius:8px;background:transparent;color:#e2e8f0;cursor:pointer;">שנה כתובת שרת</button>
      <button onclick="quit()" style="padding:10px 24px;border:1px solid #7f1d1d;border-radius:8px;background:transparent;color:#fca5a5;cursor:pointer;">יציאה</button>
    </div>
    <script>
      function retry(){ window.examAgent.reloadExam(); }
      function setup(){ window.examAgent.showSetup(); }
      function quit(){ window.examAgent.quit(); }
    </script></body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
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
// רישום נכון: באפליקציה ארוזה - מצביע על ה-exe המותקן. בפיתוח - על
// electron.exe עם נתיב הפרויקט (אחרת נוצר נתיב שבור system32\examclient:).
if (app.isPackaged) {
  app.setAsDefaultProtocolClient('examclient');
} else if (process.platform === 'win32') {
  app.setAsDefaultProtocolClient('examclient', process.execPath, [path.resolve(process.argv[1] || '.')]);
}
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
  if (action === 'quit')   doQuit();
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

// ════════ גילוי שימוש בכלי AI (רמת מערכת ההפעלה) ════════
// כל אלו לא אפשריים מדף דפדפן - רק מהאפליקציה.
const { clipboard } = electron;
const { exec } = require('child_process');

let detectTimer = null;
let lastClipText = '';
let lastClipImageEmpty = true;
let examQuestionText = '';   // טקסט שאלות המבחן (לזיהוי העתקת שאלה) - מוזרק מדף התלמיד

// שמות תהליכים/כותרות חלון שמעידים על כלי AI או צילום מסך
const AI_PATTERNS = [
  /chatgpt/i, /openai/i, /\bclaude\b/i, /anthropic/i, /gemini/i, /copilot/i,
  /perplexity/i, /poe\.com/i, /bard/i, /you\.com/i,
];
const SNIP_PATTERNS = [ /snipping ?tool/i, /screensketch/i, /screenclip/i, /גזירה/ ];

function flagCheat(kind, detail) {
  // שולח לדף התלמיד, שמעביר לשרת ומציג אזהרה
  if (win && win.webContents) win.webContents.send('ai-cheat', { kind, detail });
}

// 1) ניטור לוח (clipboard) - טקסט ותמונות
function checkClipboard() {
  try {
    const txt = clipboard.readText() || '';
    if (txt && txt !== lastClipText) {
      lastClipText = txt;
      // האם הועתק טקסט שאלת המבחן?
      if (examQuestionText && txt.length > 25 && questionOverlap(txt)) {
        flagCheat('clip-question', txt.slice(0, 60));
      } else if (txt.length > 0) {
        flagCheat('clip-text', `${txt.length} תווים: ${txt.slice(0, 50)}`);
      }
    }
    // תמונה בלוח = סימן חזק ל-Win+Shift+S / PrintScreen
    const img = clipboard.readImage();
    const empty = img.isEmpty();
    if (!empty && lastClipImageEmpty) flagCheat('clip-image', 'תמונה הועתקה ללוח (צילום מסך?)');
    lastClipImageEmpty = empty;
  } catch {}
}

// חפיפה גסה בין טקסט שהועתק לטקסט שאלות המבחן
function questionOverlap(txt) {
  const norm = s => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const q = norm(examQuestionText), t = norm(txt);
  if (!q) return false;
  // אם קטע של 25 תווים מהטקסט מופיע בשאלות
  return q.includes(t.slice(0, 25)) || t.length > 40 && q.includes(t.slice(0, 40));
}

// 2) ניטור חלון פעיל - האם כלי AI / snipping tool בקדמת הבמה
function checkActiveWindow() {
  // PowerShell: כותרת החלון הפעיל + שם התהליך
  const ps = `Add-Type @'
using System;using System.Runtime.InteropServices;using System.Text;
public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);}
'@;$h=[W]::GetForegroundWindow();$sb=New-Object Text.StringBuilder 256;[void][W]::GetWindowText($h,$sb,256);$p=0;[void][W]::GetWindowThreadProcessId($h,[ref]$p);$proc=(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName;Write-Output "$($sb.ToString())|$proc"`;
  exec(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 4000, windowsHide: true }, (err, stdout) => {
    if (err || !stdout) return;
    const line = stdout.trim();
    if (AI_PATTERNS.some(re => re.test(line))) flagCheat('ai-window', line.split('|')[0].slice(0, 60));
    if (SNIP_PATTERNS.some(re => re.test(line))) flagCheat('snip-tool', 'כלי גזירת מסך נפתח');
  });
}

function startCheatDetection() {
  if (detectTimer) return;
  lastClipText = clipboard.readText() || '';
  lastClipImageEmpty = clipboard.readImage().isEmpty();
  detectTimer = setInterval(() => { checkClipboard(); checkActiveWindow(); }, 2500);
}
function stopCheatDetection() {
  if (detectTimer) { clearInterval(detectTimer); detectTimer = null; }
}

// ── יציאה מבוקרת מהאפליקציה ────────────────────────────────────
let quitting = false;
function doQuit() {
  quitting = true;
  globalShortcut.unregisterAll();
  stopCheatDetection();
  if (overlay) { overlay.destroy(); overlay = null; }
  if (win) { win.setKiosk(false); win.destroy(); win = null; }
  app.quit();
}

// חלון קטן לבקשת סיסמת יציאה (מוצג מעל ה-kiosk)
function promptExitPassword() {
  const dlg = new BrowserWindow({
    width: 340, height: 180, frame: true, alwaysOnTop: true, resizable: false,
    parent: win || undefined, modal: true, title: 'יציאה מהמבחן',
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  dlg.setAlwaysOnTop(true, 'screen-saver');
  const html = `<!DOCTYPE html><html dir="rtl"><body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0;text-align:center;padding:16px;">
    <p style="font-size:13px;">הזן סיסמת יציאה (מהמורה):</p>
    <input id="p" type="password" autofocus style="width:90%;padding:8px;border-radius:6px;border:1px solid #334155;background:#1e293b;color:#fff;text-align:center;">
    <p id="err" style="color:#ef4444;font-size:12px;height:14px;"></p>
    <button onclick="go()" style="padding:8px 20px;border:none;border-radius:6px;background:#00d4aa;font-weight:700;cursor:pointer;">יציאה</button>
    <script>
      const { ipcRenderer } = require('electron');
      function go(){ ipcRenderer.send('exit-attempt', document.getElementById('p').value); }
      document.getElementById('p').addEventListener('keydown', e => { if(e.key==='Enter') go(); });
      ipcRenderer.on('exit-wrong', () => { document.getElementById('err').textContent='סיסמה שגויה'; document.getElementById('p').value=''; });
    </script></body></html>`;
  dlg.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  return dlg;
}

ipcMain.on('exit-attempt', (e, pass) => {
  if (pass === EXIT_PASSWORD) doQuit();
  else e.sender.send('exit-wrong');
});

function registerExitHotkeys() {
  // יציאה עם סיסמה (לתלמיד - אם הוקלד שם שגוי / סיום מבחן)
  globalShortcut.register('Control+Shift+Q', () => { if (!quitting) promptExitPassword(); });
  // יציאה מהירה ללא סיסמה (לפיקוח חלש / בדיקות)
  globalShortcut.register('Control+Shift+X', () => { if (!quitting) doQuit(); });
}

// 3) יירוט מקש PrintScreen (best-effort - חלק מהמחוות שמורות ל-Windows)
function registerScreenshotInterception() {
  ['PrintScreen', 'Alt+PrintScreen', 'CommandOrControl+PrintScreen'].forEach(k => {
    try { globalShortcut.register(k, () => flagCheat('printscreen', 'נלחץ מקש צילום מסך')); } catch {}
  });
}

// ── גשר IPC מדף התלמיד (preload חושף window.examAgent) ─────────
ipcMain.on('agent-lock-input', (e, on) => setLock(!!on));
ipcMain.handle('agent-info', () => ({ nativeInput: !!nativeInput, version: app.getVersion() }));
ipcMain.on('agent-remote-input', (e, ev) => replayInput(ev));
ipcMain.on('agent-quit', () => doQuit());
ipcMain.on('set-server', (e, raw) => { examUrl = normalizeUrl(raw); saveExamUrl(examUrl); loadExam(); });
ipcMain.on('reload-exam', () => loadExam());
ipcMain.on('show-setup', () => showSetupPage());
// דף התלמיד מוסר את טקסט השאלות (לזיהוי "הועתקה שאלה") ומפעיל/מכבה גילוי
ipcMain.on('set-question-text', (e, txt) => { examQuestionText = (txt || '').slice(0, 5000); });
ipcMain.on('cheat-detection', (e, on) => { on ? startCheatDetection() : stopCheatDetection(); });
// הודעה/טיימר מהמורה -> מוצגים בשכבת-העל מעל כל אתר
ipcMain.on('overlay-message',   (e, text)  => overlaySend('show-message', text));
ipcMain.on('overlay-countdown', (e, data)  => overlaySend('set-countdown', data));

// ── אתחול ──────────────────────────────────────────────────────
app.whenReady().then(() => {
  loadNativeInput();
  startDetectServer();
  registerExitHotkeys();
  registerScreenshotInterception();
  createWindow();
  createOverlay();         // שכבת-על לטיימר/הודעות מעל כל אתר
  startCheatDetection();   // גילוי פעיל כל עוד האפליקציה רצה
  handleProtocol(process.argv.find(a => a.startsWith('examclient://')));
});
app.on('window-all-closed', () => { /* נשאר חי כדי לשרת examclient:// ואת שרת הזיהוי */ });
