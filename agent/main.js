// Exam Client — Electron companion agent (functional build)
// ------------------------------------------------------------------
//  1. חלון kiosk מסך-מלא שטוען את דף התלמיד (מונע Alt-Tab/יציאה).
//  2. שרת זיהוי מקומי 127.0.0.1:7345 כדי שדף הדפדפן יידע שהאפליקציה מותקנת.
//  3. פרוטוקול examclient:// להפעלה מרחוק ע"י המורה (Option C).
//  4. נעילה/חסימת קלט אמיתית + שליטה מרחוק - אם הספרייה הילידית זמינה,
//     אחרת מנגנון fallback מבוסס kiosk + globalShortcut.
// ------------------------------------------------------------------

const electron = require('electron');
const { app, BrowserWindow, BrowserView, globalShortcut, ipcMain, screen, desktopCapturer, session } = electron;
const http = require('http');
const path = require('path');
const fs   = require('fs');

// אם electron מורץ ישירות עם node (לא דרך הבינארי) - app יהיה undefined
if (!app) {
  console.error('שגיאה: יש להריץ דרך electron ולא node. הרץ:  npm start');
  process.exit(1);
}

const DETECT_PORT = 7345;
// סיסמת יציאה שהמורה מוסר. ניתן לשנות ב-exam-config.json (exitPass) או במשתנה EXAM_EXIT_PASS

// ── כתובת שרת המבחן ───────────────────────────────────────────
// סדר עדיפויות: env > config שמור > ברירת מחדל. נשמר בין הפעלות.
const CONFIG_FILE = path.join(app.getPath('userData'), 'exam-config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch { return {}; }
}
function writeConfig(patch) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...readConfig(), ...patch })); } catch {}
}
function loadExamUrl() {
  if (process.env.EXAM_URL) return process.env.EXAM_URL;
  return readConfig().examUrl || '';
}
// כתובת חדשה = שרת חדש, לכן גם טביעת האצבע של התעודה שנשמרה מתאפסת
function saveExamUrl(url) { writeConfig({ examUrl: url, certPin: '' }); }
const EXIT_PASSWORD = process.env.EXAM_EXIT_PASS || readConfig().exitPass || 'examexit';
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

// ── אימות תעודת השרת ───────────────────────────────────────────
// שרת המבחן משתמש בתעודה עצמית. במקום לקבל כל תעודה, "מצמידים" (TOFU) את טביעת האצבע
// של התעודה בחיבור הראשון לשרת שהוגדר, ומאז דורשים אותה. אתרים אחרים (אתר המבחן עצמו)
// נבדקים כרגיל לפי רשימת הרשויות של המערכת.
function serverHost() { try { return new URL(examUrl).hostname; } catch { return ''; } }
function certVerify(req, cb) {
  if (!serverHost() || req.hostname !== serverHost()) return cb(-3);   // -3 = אימות רגיל של Chromium
  const fp = req.certificate && req.certificate.fingerprint;
  if (!fp) return cb(-2);
  const pinned = readConfig().certPin;
  if (!pinned) { writeConfig({ certPin: fp }); return cb(0); }
  return cb(pinned === fp ? 0 : -2);
}

let win = null;
let inputLocked = false;

// ── ספרייה ילידית לקלט (אופציונלית) ───────────────────────────
// נטענת רק אם הותקנה. בלעדיה האפליקציה עדיין עובדת (kiosk + קיצורים).
// נטענת אחרי app.whenReady כדי לא להתנגש באתחול של electron.
// (הוסרה תמיכה בשליטה מרחוק/robotjs: אף חלק במערכת לא השתמש בה, והיא אפשרה הקלדה על מחשב התלמיד)
const nativeInput = null;

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

// ── תצוגת המבחן (אתר אמיתי, לא iframe) ─────────────────────────
// BrowserView שמכסה את חלון ה-kiosk אך משאיר את student.html חי מתחתיו -
// כך שיתוף המסך והקשר לשרת ממשיכים לרוץ ברקע בזמן שהתלמיד עושה את המבחן.
let examView = null;
let examViewUrl = '';        // האתר שנטען כעת (לא טוענים מחדש אותו אתר בחיבור מחדש)
let examViewHidden = false;  // מוסתר בזמן נעילת מסך / שידור מסך המורה
let approvedDomains = [];   // דומיינים מאושרים - ניווט מחוצה להם מסומן (לא נחסם)
let examHost = '';          // הדומיין של אתר המבחן עצמו - תמיד מאושר
const LINKS_BAR_PX = 56;    // פס הקישורים המאושרים של student.html נשאר גלוי מתחת לאתר המבחן
function examBounds() {
  const b = win.getContentBounds();
  const reserve = approvedDomains.length ? LINKS_BAR_PX : 0;
  return { x: 0, y: 0, width: b.width, height: Math.max(100, b.height - reserve) };
}
function openExamView(url) {
  if (!url || !win || !/^https?:\/\//i.test(url)) return;
  try { examHost = new URL(url).hostname.replace(/^www\./, ''); } catch { examHost = ''; }
  if (!examView) {
    examView = new BrowserView({ webPreferences: { contextIsolation: true } });
    examView.webContents.session.setCertificateVerifyProc(certVerify);
    if (!examViewHidden) win.addBrowserView(examView);
    // הגבלה רכה: אם הניווט יוצא מהדומיינים המאושרים - מדווחים למורה (לא חוסמים)
    examView.webContents.on('did-navigate', (e, navUrl) => checkApprovedNav(navUrl));
    examView.webContents.on('did-navigate-in-page', (e, navUrl) => checkApprovedNav(navUrl));
    // חלון חדש (target=_blank / window.open, למשל לחיצה על תמונה) נפתח בחלון צף מעל המבחן,
    // כך שדף המבחן נשאר פתוח מתחת ואין חלון חופשי מחוץ ל-kiosk
    examView.webContents.setWindowOpenHandler(({ url: u }) => {
      openViewer(u);
      return { action: 'deny' };
    });
  } else if (examViewUrl === url) {
    // אותו אתר כבר פתוח - לא טוענים מחדש (נפילת רשת קצרה לא תאפס תשובות של התלמיד)
    applyExamBounds();
    return;
  }
  examViewUrl = url;
  applyExamBounds();
  examView.webContents.loadURL(url);
  // שמירה על סדר השכבות: overlay (טיימר/הודעות) תמיד למעלה
  if (overlay) overlay.setAlwaysOnTop(true, 'screen-saver');
}
function applyExamBounds() {
  if (!examView || !win) return;
  examView.setBounds(examBounds());
}
function closeExamView() {
  closeViewer();
  if (examView && win) { win.removeBrowserView(examView); examView.webContents.destroy(); }
  examView = null; examViewUrl = ''; examHost = '';
}

// חלון צף לתמונות/קישורים שנפתחים מתוך אתר המבחן (Esc או ✕ לסגירה). דף המבחן נשאר חי מתחתיו.
let viewer = null;
function closeViewer() {
  if (viewer && !viewer.isDestroyed()) viewer.destroy();
  viewer = null;
}
function openViewer(url) {
  if (!win || !/^https?:\/\//i.test(url)) return;
  if (viewer && !viewer.isDestroyed()) { viewer.loadURL(url); viewer.show(); return; }
  const wa = screen.getPrimaryDisplay().workAreaSize;
  viewer = new BrowserWindow({
    parent: win, width: Math.round(wa.width * 0.8), height: Math.round(wa.height * 0.85), center: true,
    minimizable: false, fullscreenable: false, autoHideMenuBar: true, backgroundColor: '#0f172a',
    title: 'לסגירה: Esc או ✕',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const v = viewer;
  v.removeMenu();
  v.setAlwaysOnTop(true, 'screen-saver', 1);   // מעל חלון ה-kiosk וה-overlay
  v.webContents.session.setCertificateVerifyProc(certVerify);
  v.on('closed', () => { if (viewer === v) viewer = null; });
  v.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') v.close();
  });
  // בתוך החלון הצף נשארים באותו חלון; ניווט פנימי נבדק מול הרשימה המאושרת
  v.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:\/\//i.test(u)) v.loadURL(u);
    return { action: 'deny' };
  });
  // תמונה היא לא "ניווט לאתר" - לא מדווחים עליה גם אם היא מאוחסנת בדומיין אחר
  const check = navUrl => {
    v.webContents.executeJavaScript('document.contentType').then(t => {
      if (!/^image\//i.test(String(t))) checkApprovedNav(navUrl);
    }).catch(() => checkApprovedNav(navUrl));
  };
  v.webContents.on('did-navigate', (e, navUrl) => check(navUrl));
  v.webContents.on('did-navigate-in-page', (e, navUrl) => check(navUrl));
  v.once('ready-to-show', () => v.show());
  v.loadURL(url);
}
// BrowserView תמיד מצויר מעל הדף. כדי שמסך הנעילה / שידור המורה יראו - מסירים אותו זמנית
function setExamHidden(hidden) {
  examViewHidden = !!hidden;
  if (examViewHidden) closeViewer();   // נעילה / שידור מורה - שום חלון צף לא נשאר מעל
  if (!examView || !win) return;
  if (examViewHidden) { try { win.removeBrowserView(examView); } catch {} }
  else { try { win.addBrowserView(examView); applyExamBounds(); } catch {} }
  if (overlay) overlay.setAlwaysOnTop(true, 'screen-saver');
}

// בדיקת ניווט מול הרשימה המאושרת - מדווח אך לא חוסם (כדי לא לשבור הפניות מבחן)
let _lastFlaggedHost = '';
// דומיינים של התחברות/הפניות בלבד (מדויקים - לא כל דומיין שמכיל "google" או "live")
const BENIGN_HOSTS = /^(accounts\.google\.com|[a-z0-9-]+\.gstatic\.com|gstatic\.com|[a-z0-9-]+\.googleusercontent\.com|login\.microsoftonline\.com|login\.live\.com|[a-z0-9-]*\.?recaptcha\.net|forms\.gle)$/i;
function checkApprovedNav(navUrl) {
  if (!approvedDomains.length) return;            // אין רשימה -> אין הגבלה
  let host;
  try { host = new URL(navUrl).hostname.replace(/^www\./,''); } catch { return; }
  if (host === _lastFlaggedHost) return;          // לא לשלוח שוב ושוב לאותו דומיין
  const ok = host === examHost || approvedDomains.some(d => host === d || host.endsWith('.' + d));
  const benign = BENIGN_HOSTS.test(host);
  if (!ok && !benign) {
    _lastFlaggedHost = host;
    flagCheat('off-list-nav', host);
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
  // אימות תעודת השרת בהצמדת טביעת אצבע (ראה certVerify)
  win.webContents.session.setCertificateVerifyProc(certVerify);
  // הדף הראשי רשאי להציג רק את שרת המבחן ואת המסכים הפנימיים; חלונות חדשים נחסמים
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, navUrl) => {
    if (navUrl.startsWith('data:')) return;
    let ok = false;
    try { ok = new URL(navUrl).hostname === serverHost(); } catch {}
    if (!ok) e.preventDefault();
  });

  // ── תיקון getDisplayMedia ב-Electron ──────────────────────────
  // בדפדפן יש בורר מסך מובנה; ב-Electron חובה לספק handler.
  // בוחרים אוטומטית את המסך הראשי המלא (התלמיד לא צריך לבחור - וגם
  // לא יכול "בטעות" לשתף רק חלון, מה שמחזק את הפיקוח).
  win.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then(sources => {
      // המסך הראשי דווקא (לא בהכרח הראשון ברשימה), ללא אודיו
      const primaryId = String(screen.getPrimaryDisplay().id);
      const primary = (sources || []).find(s => String(s.display_id) === primaryId) || (sources || [])[0];
      if (primary) callback({ video: primary });
      else callback({});
    }).catch(() => callback({}));
  }, { useSystemPicker: false });

  // אם נכשלת טעינת דף המבחן - מציגים מסך שגיאה ידידותי במקום מסך ריק נעול
  win.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (code === -3) return; // ABORTED - לא רלוונטי
    if (isMainFrame === false) return; // כשל בתת-מסגרת (iframe) לא מחליף את כל הדף
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
    ${currentErr ? `<p style="color:#ef4444;font-size:13px;">${String(currentErr).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</p>` : ''}
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
    <p style="color:#94a3b8;font-size:13px;max-width:440px;text-align:center;">${String(msg).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</p>
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
  const srv = http.createServer((req, res) => {
    // רק דף התלמיד של שרת המבחן רשאי לשאול אם האפליקציה מותקנת (לא כל אתר באינטרנט)
    let allowed = '*';
    try { if (examUrl) allowed = new URL(examUrl).origin; } catch {}
    if (allowed === '*' || req.headers.origin === allowed) res.setHeader('Access-Control-Allow-Origin', allowed);
    if (req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ app: 'exam-client', version: app.getVersion(), nativeInput: !!nativeInput }));
      return;
    }
    res.writeHead(404); res.end();
  });
  // אם הפורט תפוס (מופע אחר כבר רץ) - לא מקריסים את האפליקציה, רק מתעלמים
  srv.on('error', err => {
    if (err.code === 'EADDRINUSE') console.log('detect server: port in use (instance already running) - skipping');
    else console.error('detect server error:', err.message);
  });
  srv.listen(DETECT_PORT, '127.0.0.1', () => console.log(`detect server on 127.0.0.1:${DETECT_PORT}`));
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
if (!gotLock) {
  // מופע שני (למשל לחיצה נוספת על "הפעל אפליקציה") - יוצא מיד.
  // המופע הראשון יקבל 'second-instance' ויביא את עצמו לקדמת הבמה.
  app.quit();
  process.exit(0);
}
app.on('second-instance', (e, argv) => {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  handleProtocol(argv.find(a => a.startsWith('examclient://')));
});
function handleProtocol(url) {
  if (!url) return;
  const action = url.replace('examclient://', '').replace(/\/$/, '');
  // רק הפעלה. נעילה/יציאה דרך קישור אינטרנט הוסרו: כל אתר היה יכול לשלוח אותן
  if (action === 'start' && !win) createWindow();
}

// ── 4. נעילה / חסימת קלט אמיתית ────────────────────────────────
const LOCK_KEYS = ['Alt+Tab','Alt+F4','Super','Control+W','Control+Shift+I','F11','Control+R','CommandOrControl+Q'];
function setLock(on) {
  inputLocked = on;
  if (on) {
    // חסימת קיצורים נפוצים (לא חוסם Ctrl+Alt+Del - אבטחת מערכת ההפעלה)
    LOCK_KEYS.forEach(k => { try { globalShortcut.register(k, () => {}); } catch {} });
    if (win) { win.setKiosk(true); win.setAlwaysOnTop(true, 'screen-saver'); win.focus(); }
  } else {
    // משחררים רק את קיצורי הנעילה - קיצורי היציאה וזיהוי PrintScreen נשארים פעילים
    LOCK_KEYS.forEach(k => { try { globalShortcut.unregister(k); } catch {} });
  }
  // אם יש ספרייה ילידית - אפשר לחסום קלט עמוק יותר (תלוי-פלטפורמה).
  // robotjs לבדו לא חוסם קלט; לחסימה מלאה צריך hook ברמת מערכת ההפעלה.
  // ה-kiosk + alwaysOnTop נותן חסימה מעשית טובה ברוב המקרים.
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

// אותו דיווח לא נשלח שוב ושוב: חלון AI שנשאר פתוח היה מציף את הלוג ואת צלילי ההתראה כל 2.5 שניות
const lastFlag = {};
const FLAG_COOLDOWN_MS = { 'ai-window': 60000, 'snip-tool': 60000 };
function flagCheat(kind, detail) {
  const key = kind + '|' + (detail || '');
  const now = Date.now();
  if (lastFlag[key] && now - lastFlag[key] < (FLAG_COOLDOWN_MS[kind] || 15000)) return;
  lastFlag[key] = now;
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
        flagCheat('clip-text', `${txt.length} תווים`);   // רק האורך - לא שולחים את תוכן הלוח של התלמיד
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
let windowCheckRunning = false;
function checkActiveWindow() {
  if (windowCheckRunning) return;   // לא מריצים בדיקה חדשה כל עוד הקודמת רצה
  windowCheckRunning = true;
  // PowerShell: כותרת החלון הפעיל + שם התהליך
  const ps = `Add-Type @'
using System;using System.Runtime.InteropServices;using System.Text;
public class W{[DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")]public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
[DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int p);}
'@;$h=[W]::GetForegroundWindow();$sb=New-Object Text.StringBuilder 256;[void][W]::GetWindowText($h,$sb,256);$p=0;[void][W]::GetWindowThreadProcessId($h,[ref]$p);$proc=(Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName;Write-Output "$($sb.ToString())|$proc"`;
  exec(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"')}"`, { timeout: 8000, windowsHide: true }, (err, stdout) => {
    windowCheckRunning = false;
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
  let tick = 0;
  detectTimer = setInterval(() => {
    checkClipboard();                         // כל 2.5 שניות (זול)
    if (tick++ % 2 === 0) checkActiveWindow(); // חלון פעיל כל 5 שניות (מריץ PowerShell)
  }, 2500);
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
  // (הוסר: יציאה מהירה ללא סיסמה - איפשרה לכל תלמיד לצאת מהמבחן)
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
ipcMain.on('agent-set-exam-hidden', (e, hidden) => setExamHidden(hidden));
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
// פתיחת אתר המבחן בתצוגה אמיתית מעל student.html (שנשאר חי לניטור)
ipcMain.on('open-exam', (e, url) => openExamView(url));
ipcMain.on('close-exam', () => closeExamView());
ipcMain.on('set-approved-links', (e, urls) => {
  approvedDomains = (Array.isArray(urls) ? urls : []).map(u => { try { return new URL(u).hostname.replace(/^www\./,''); } catch { return null; } }).filter(Boolean);
  applyExamBounds();   // פס הקישורים מופיע/נעלם -> משנים את גובה אתר המבחן
});

// ── אתחול ──────────────────────────────────────────────────────
app.whenReady().then(() => {
  startDetectServer();
  registerExitHotkeys();
  registerScreenshotInterception();
  createWindow();
  createOverlay();         // שכבת-על לטיימר/הודעות מעל כל אתר
  startCheatDetection();   // גילוי פעיל כל עוד האפליקציה רצה
  handleProtocol(process.argv.find(a => a.startsWith('examclient://')));
});
app.on('window-all-closed', () => { /* נשאר חי כדי לשרת examclient:// ואת שרת הזיהוי */ });
