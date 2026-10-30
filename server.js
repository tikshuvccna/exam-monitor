const https  = require('https');
const http   = require('http');
const net    = require('net');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');
const { WebSocketServer } = require('ws');
const Turn   = require('node-turn');

// ── Config ───────────────────────────────────────────────────
// טוען config.json אם קיים (לא נשמר ב-git). אחרת משתמש בברירות מחדל.
// העתק את config.example.json ל-config.json ושנה את הסיסמאות.
const CONFIG_PATH = path.join(__dirname, 'config.json');
let cfg = {};
let generatedPassword = null;
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
catch {
  // אין config.json: יוצרים אחד עם סיסמת מורה אקראית (ברירת המחדל הציבורית אינה בטוחה)
  generatedPassword = crypto.randomBytes(5).toString('hex');
  cfg = {
    adminPassword: generatedPassword,
    turnUser: 'examuser', turnPass: crypto.randomBytes(6).toString('hex'),
    port: 4555, turnPort: 3478,
  };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }
  catch { console.warn('⚠️  לא ניתן ליצור config.json - הסיסמה תקפה להפעלה זו בלבד.'); }
}

// מפתח לסורק החיצוני (scanner.py --watch) כדי שיוכל לדווח התראות. נוצר פעם אחת ונשמר ב-config.json
if (!cfg.scannerKey) {
  cfg.scannerKey = crypto.randomBytes(12).toString('hex');
  try { if (fs.existsSync(CONFIG_PATH)) fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch {}
}
const SCANNER_KEY = String(cfg.scannerKey);
// מחיקת צילומים ישנים (ימים). 0 = לא למחוק לעולם (ברירת מחדל)
const RETENTION_DAYS = Math.max(0, parseInt(cfg.screenshotRetentionDays) || 0);

const PORT           = process.env.EXAM_PORT       || cfg.port          || 4555;
const TURN_PORT      = process.env.EXAM_TURN_PORT  || cfg.turnPort      || 3478;
const TURN_USER      = process.env.EXAM_TURN_USER  || cfg.turnUser      || 'examuser';
const TURN_PASS      = process.env.EXAM_TURN_PASS  || cfg.turnPass      || 'exampass';
const ADMIN_PASSWORD = String(process.env.EXAM_ADMIN_PASS || cfg.adminPassword || 'bandwidth');
// אזהרה רק כשלא הוגדרה סיסמה בכלל (נפלנו לברירת המחדל). סיסמה שנבחרה ב-config.json - גם אם פשוטה - לא מציקה בכל הפעלה
const DEFAULT_PASSWORD_IN_USE = !process.env.EXAM_ADMIN_PASS && !cfg.adminPassword;

// ── SSL ──────────────────────────────────────────────────────
const cert = fs.readFileSync(path.join(__dirname, 'cert.pem'));
const key  = fs.readFileSync(path.join(__dirname, 'key.pem'));

// ── TURN ─────────────────────────────────────────────────────
// סדר עדיפות הכתובות (למורה ולתלמידים): Wi-Fi, אחר כך LAN (כבל), אחר כך נקודה חמה, ואחר כך כל השאר.
// מתאמים וירטואליים (VMware, VPN, Tailscale...) תמיד בסוף, כי תלמידים לא יכולים להגיע אליהם.
const KIND_ORDER = { wifi: 0, lan: 1, hotspot: 2, other: 3, virtual: 4 };
const VIRTUAL_RE = /vmware|virtualbox|vbox|vethernet|hyper-v|wsl|docker|tailscale|zerotier|wireguard|openvpn|vpn|tap-|bluetooth|pseudo|loopback/i;
const cleanName = n => String(n).replace(/[‎‏‪-‮]/g, '').trim();   // Windows מוסיף סימני כיווניות לשמות

// ב-Windows שם המתאם ניתן לשינוי ומתורגם, לכן מסווגים לפי תיאור החומרה (Get-NetAdapter). נשמר במטמון.
let adapterCache = null, adapterCacheAt = 0;
function windowsAdapters() {
  if (process.platform !== 'win32') return {};
  if (adapterCache && Date.now() - adapterCacheAt < 60000) return adapterCache;
  adapterCacheAt = Date.now();
  try {
    const json = require('child_process').execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-NetAdapter | Select-Object Name,InterfaceDescription,PhysicalMediaType | ConvertTo-Json -Compress'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const map = {};
    [].concat(JSON.parse(json) || []).forEach(a => { map[cleanName(a.Name)] = { desc: a.InterfaceDescription || '', media: a.PhysicalMediaType || '' }; });
    adapterCache = map;
  } catch { adapterCache = adapterCache || {}; }
  return adapterCache;
}

function adapterKind(name, address) {
  const n = cleanName(name);
  let info = windowsAdapters()[n];
  if (process.platform === 'win32' && !info) { adapterCacheAt = 0; info = windowsAdapters()[n]; }   // מתאם חדש מאז הבדיקה האחרונה
  const desc = info ? info.desc : '';
  const media = info ? info.media : '';
  const cgnat = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address);   // 100.64.0.0/10 (Tailscale ועוד)
  if (cgnat || VIRTUAL_RE.test(n) || VIRTUAL_RE.test(desc)) return 'virtual';
  if (/wi-?fi direct|hosted network/i.test(desc) || /hotspot|local area connection\*|^ap\d|^ap$/i.test(n) || address === '192.168.137.1') return 'hotspot';
  if (/802\.11/.test(media) || /wireless|wi-?fi|wlan/i.test(desc) || /wi-?fi|wlan|wireless|^wl/i.test(n)) return 'wifi';
  if (/802\.3/.test(media) || /ethernet|gbe|lan\b/i.test(desc) || /ethernet|^eth|^en/i.test(n)) return 'lan';
  return 'other';
}

function lanAddresses() {
  const out = [];
  Object.entries(os.networkInterfaces()).forEach(([name, list]) => (list || []).forEach(a => {
    if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) return;
    const kind = adapterKind(name, a.address);
    const rank = a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 2 : 3;
    out.push({ address: a.address, kind, rank });
  }));
  out.sort((x, y) => (KIND_ORDER[x.kind] - KIND_ORDER[y.kind]) || (x.rank - y.rank));
  return out;
}
function pickLanIp() { return (lanAddresses()[0] || { address: '127.0.0.1' }).address; }
const RELAY_IP = cfg.relayIp || pickLanIp();

const turnServer = new Turn({
  listeningPort: TURN_PORT, listeningIps: ['0.0.0.0'], relayIps: [RELAY_IP],
  authMech: 'long-term', credentials: { [TURN_USER]: TURN_PASS }, debugLevel: 'OFF',
});
turnServer.start();
console.log(`✅ TURN server פועל על פורט ${TURN_PORT}`);

// ── Session store ─────────────────────────────────────────────
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // התחברות מורה תקפה ל-8 שעות
const sessions = new Map();                  // token -> expiresAt
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}
function sessionToken(cookieHeader) {
  const m = cookieHeader && String(cookieHeader).match(/(?:^|;\s*)adminSession=([a-f0-9]+)/);
  return m ? m[1] : null;
}
function validSession(cookieHeader) {
  const t = sessionToken(cookieHeader);
  if (!t) return false;
  const exp = sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
// הגבלת ניסיונות כניסה: 5 כשלונות מאותה כתובת -> חסימה לדקה
const loginFails = {};   // ip -> { n, until }
function loginBlocked(ip) {
  const f = loginFails[ip];
  return !!(f && f.until && f.until > Date.now());
}
function loginFailed(ip) {
  const f = loginFails[ip] || (loginFails[ip] = { n: 0, until: 0 });
  if (++f.n >= 5) { f.until = Date.now() + 60 * 1000; f.n = 0; }
}

// ── Session log files (חדשים בכל הפעלת שרת) ─────────────────
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);

// מוודא שנתיב יעד נשאר בתוך תיקיית הבסיס (הגנה מפני path traversal)
function isInside(baseDir, target) {
  const rel = path.relative(baseDir, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function makeTimestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

const SESSION_TS   = makeTimestamp();
const LOG_FILE     = path.join(LOGS_DIR, `exam-log_${SESSION_TS}.txt`);
const STUDENT_FILE = path.join(LOGS_DIR, `exam-students_${SESSION_TS}.csv`);

// ── Session state ─────────────────────────────────────────────
let screenshotsEnabled = false;
let expectedCount     = 0;
let students          = {};
let log               = [];
let idCounter         = 1;
let persistentStudents = {};
let timerStartTime    = null;
let examStartedAt     = null;

// מצב מבחן נוכחי - מוחל אוטומטית על תלמידים שמצטרפים/מתחברים מחדש
let examState = {
  examUrl: null,          // אתר המבחן המוטמע
  links: [],              // קישורים מאושרים
  countdown: null,        // { on, endsAt }
  lock: null,             // { on, message }
  inputBlock: false,      // חסימת קלט פעילה
};
// תלמידים שהועפו - חסומים מהצטרפות מחדש לזמן קצר
const kicked = {};        // key: "name|ip" -> timestamp; וגם key: "name"
const KICK_BLOCK_MS = 2 * 60 * 1000;  // חסימה ל-2 דקות

// ── Log helpers ───────────────────────────────────────────────
function appendLogFile(entry) {
  const timerStr = timerStartTime
    ? ` [שעון: ${formatDurationSec(Math.floor((Date.now() - timerStartTime) / 1000))}]`
    : '';
  const line = `[${new Date(entry.time).toLocaleString('he-IL')}]${timerStr} [${entry.type.toUpperCase()}] ${String(entry.message).replace(/[\r\n]+/g, ' ')}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

function formatDurationSec(sec) {
  if (sec < 60) return `${sec}ש'`;
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2,'0')} דק'`;
}

function saveStudentFile() {
  const allSt = Object.values(persistentStudents);
  const totalCount = allSt.length;

  const durations = allSt.map(s => {
    const first = new Date(s.firstSeen).getTime();
    const last  = new Date(s.lastSeen).getTime();
    return (last - first) / 1000;
  }).filter(d => d > 0);
  const avgDur = durations.length
    ? Math.round(durations.reduce((a,b) => a+b, 0) / durations.length)
    : 0;

  const examStart = examStartedAt ? new Date(examStartedAt).toLocaleString('he-IL') : 'טרם הוחל';
  const timerStartStr = timerStartTime ? new Date(timerStartTime).toLocaleString('he-IL') : 'לא הופעל';

  const partialCount = allSt.filter(s => (s.events||[]).some(e => e.event.includes('שיתוף חלקי'))).length;
  const kickedCount = allSt.filter(s => (s.events||[]).some(e => e.event.includes('הועף'))).length;
  const disconnectCount = allSt.filter(s => (s.events||[]).some(e => e.event === 'התנתק')).length;

  const summary = [
    ['=== סיכום מבחן ===', ''],
    ['מספר תלמידים צפוי', expectedCount || 'לא הוגדר'],
    ['מספר תלמידים שנכחו', totalCount],
    ['שעת כניסת תלמיד ראשון', examStart],
    ['שעת הפעלת השעון', timerStartStr],
    ['זמן שהייה ממוצע', formatDurationSec(avgDur)],
    ['תלמידים שניסו שיתוף חלקי', partialCount],
    ['תלמידים שהתנתקו (לפחות פעם אחת)', disconnectCount],
    ['תלמידים שהועפו', kickedCount],
    ['', ''],
    ['=== פרטי תלמידים ===', ''],
  ];

  const studentHeader = [
    'שם תלמיד', 'כתובת IP', 'רזולוציה מסך', 'שעת כניסה ראשונה',
    'שעת יציאה אחרונה', 'זמן שהייה כולל', 'מספר התנתקויות',
    'שיתוף חלקי?', 'הועף?', 'ציון חשד', 'רמת חשד', 'צילומי ראיה', 'כל האירועים',
  ];

  const studentRows = allSt.map(s => {
    const first = new Date(s.firstSeen).getTime();
    const last  = new Date(s.lastSeen).getTime();
    const dur   = formatDurationSec(Math.round((last - first) / 1000));
    const evts  = (s.events||[]);
    const disconnects = evts.filter(e => e.event === 'התנתק').length;
    const partial     = evts.some(e => e.event.includes('שיתוף חלקי')) ? 'כן ⚠️' : 'לא';
    const kicked      = evts.some(e => e.event.includes('הועף'))        ? 'כן 🚫' : 'לא';
    const evtStr      = evts.map(e => `${new Date(e.time).toLocaleTimeString('he-IL')}: ${e.event}`).join(' | ');
    const live        = Object.values(students).find(x => x.name === s.name);
    const sus         = suspicionOf(s, live ? !!live.usingApp : undefined);
    const shotCount   = evts.reduce((n, e) => n + (e.shots ? e.shots.length : 0), 0);
    const levelHe     = { high: 'גבוה', medium: 'בינוני', low: 'נמוך' }[sus.level];
    return [
      s.name, s.ip, s.resolution||'-',
      new Date(s.firstSeen).toLocaleString('he-IL'),
      new Date(s.lastSeen).toLocaleString('he-IL'),
      dur, disconnects, partial, kicked, sus.score, levelHe, shotCount, evtStr,
    ];
  });

  // תא שמתחיל ב-= + - @ ייפתח כנוסחה באקסל - מקדימים גרש כדי לנטרל
  const csvCell = v => { let t = String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return `"${t.replace(/"/g,'""')}"`; };
  const csvRow = arr => arr.map(csvCell).join(',');

  const lines = [ ...summary.map(r => csvRow(r)), csvRow(studentHeader), ...studentRows.map(r => csvRow(r)) ];

  try { fs.writeFileSync(STUDENT_FILE, '\uFEFF' + lines.join('\n')); } catch {}
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveStudentFile(); }, 1000);
}

function recordStudent(s) {
  const now = new Date().toISOString();
  if (!persistentStudents[s.name]) {
    persistentStudents[s.name] = {
      name: s.name, ip: s.ip, firstSeen: now, lastSeen: now,
      resolution: s.resolution || null, events: [],
    };
    if (!examStartedAt) examStartedAt = now;
  } else {
    persistentStudents[s.name].lastSeen = now;
    persistentStudents[s.name].ip = s.ip;
  }
  scheduleSave();
}

// kind: קטגוריה לניקוד/סינון. extra.shots: צילומי ראיה (נתיבים יחסיים)
function recordStudentEvent(name, event, kind, extra) {
  if (persistentStudents[name]) {
    const ev = { event, time: new Date().toISOString(), kind: kind || 'info' };
    if (extra && extra.shots) ev.shots = extra.shots.slice(0, 4);
    persistentStudents[name].events.push(ev);
    persistentStudents[name].lastSeen = new Date().toISOString();
    scheduleSave();
    return ev;
  }
  return null;
}

// ── ניקוד חשד ─────────────────────────────────────────────────
// weight = נקודות לכל אירוע; cap = כמה אירועים מהסוג נספרים (רעש כמו מעבר לשונית לא מנפח את הציון)
const SUSPICION = {
  'ai-ai-window':       { weight: 10, cap: 3 },
  'ai-clip-question':   { weight: 8,  cap: 3 },
  'scan-ai':            { weight: 8,  cap: 3 },
  'ai-snip-tool':       { weight: 4,  cap: 3 },
  'lock-escape':        { weight: 4,  cap: 3 },
  'partial-share':      { weight: 4,  cap: 2 },
  'ai-printscreen':     { weight: 3,  cap: 3 },
  'ai-clip-image':      { weight: 3,  cap: 3 },
  'ai-off-list-nav':    { weight: 3,  cap: 4 },
  'second-screen':      { weight: 3,  cap: 2 },
  'stop-share':         { weight: 3,  cap: 3 },
  'paste':              { weight: 2,  cap: 5 },
  'scan-offlist':       { weight: 2,  cap: 3 },
  'ai-clip-text':       { weight: 1,  cap: 5 },
  'tab-hidden':         { weight: 1,  cap: 5 },
  'disconnect':         { weight: 1,  cap: 5 },
};
const BROWSER_ONLY_POINTS = 5;   // בלי האפליקציה אי אפשר לגלות כלי AI בזמן אמת
function suspicionOf(p, usingApp) {
  const counts = {};
  (p.events || []).forEach(e => { if (e.kind) counts[e.kind] = (counts[e.kind] || 0) + 1; });
  let score = 0;
  Object.keys(SUSPICION).forEach(k => { if (counts[k]) score += SUSPICION[k].weight * Math.min(counts[k], SUSPICION[k].cap); });
  if (usingApp === false) score += BROWSER_ONLY_POINTS;
  const level = score >= 15 ? 'high' : score >= 6 ? 'medium' : 'low';
  return { score, level, counts };
}

fs.appendFileSync(LOG_FILE, `${'='.repeat(60)}\nמבחן התחיל: ${new Date().toLocaleString('he-IL')}\n${'='.repeat(60)}\n`);

// ── Login page ────────────────────────────────────────────────
const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head><meta charset="UTF-8"><title>כניסת מורה</title>
<style>
  body{background:#0a0e1a;color:#e2e8f0;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;flex-direction:column;gap:16px;}
  input[type=password]{background:#1e293b;border:1px solid #334155;color:#e2e8f0;border-radius:8px;padding:12px 20px;font-size:16px;text-align:center;outline:none;width:260px;}
  button{background:#00d4aa;color:#000;border:none;border-radius:8px;padding:12px 32px;font-size:16px;font-weight:600;cursor:pointer;}
  h2{font-size:20px;margin-bottom:4px;} p{color:#64748b;font-size:13px;}
</style>
</head>
<body>
  <h2>🔐 כניסת מורה</h2>
  <p>הכנס את הסיסמה להמשך</p>
  <input type="password" id="p" placeholder="סיסמה" onkeydown="if(event.key==='Enter')login()">
  <button onclick="login()">כניסה</button>
  <p id="err" style="color:#ef4444;display:none">סיסמה שגויה</p>
  <script>
    function login(){
      const p=document.getElementById('p').value;
      fetch('/admin-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pass:p})})
        .then(r=>r.json()).then(d=>{
          if(d.ok) location.href='/admin.html';
          else document.getElementById('err').style.display='block';
        });
    }
  </script>
</body></html>`;

// ── HTTP server ───────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
// CSP: חוסם טעינת סקריפטים חיצוניים. inline נשאר כי הדפים משתמשים בו.
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com data:; img-src 'self' data: blob:; media-src 'self' blob:; " +
  "connect-src 'self' wss: ws: http://127.0.0.1:7345; frame-src https: http:; base-uri 'self'; object-src 'none'";

function clientIp(req) { return (req.socket.remoteAddress || '').replace('::ffff:', ''); }

// קורא גוף בקשה עם הגבלת גודל (מונע מילוי זיכרון)
function readBody(req, res, limit, cb) {
  const chunks = []; let size = 0, aborted = false;
  req.on('data', d => {
    if (aborted) return;
    size += d.length;
    if (size > limit) { aborted = true; res.writeHead(413); res.end(); req.destroy(); return; }
    chunks.push(d);
  });
  req.on('end', () => { if (!aborted) cb(Buffer.concat(chunks)); });
  req.on('error', () => {});
}

function todayStr() {
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}`;
}
function safeFolderName(name, fallback) {
  return String(name || '').replace(/[^א-תa-zA-Z0-9_\- ]/g, '').trim().slice(0, 60) || fallback;
}
const SHOTS_ROOT = path.join(__dirname, 'screenshots');
// מחזיר נתיב יחסי "תאריך/תלמיד/קובץ" (לשימוש בקישורי צפייה), או null
let shotSeq = 0;
function saveShot(studentName, buf, kind, fallback) {
  const safe = safeFolderName(studentName, fallback);
  const day = todayStr();
  const studentDir = path.join(SHOTS_ROOT, day, safe);
  if (!isInside(SHOTS_ROOT, studentDir)) return null;
  fs.mkdirSync(studentDir, { recursive: true });
  const file = `${safe}_${makeTimestamp()}_${String(++shotSeq % 1000).padStart(3, '0')}_${kind}.jpg`;
  fs.writeFile(path.join(studentDir, file), buf, () => {});
  return `${day}/${safe}/${file}`;
}
// בדיקת נתיב יחסי שהגיע מבחוץ -> נתיב מלא בטוח, או null
function resolveShot(rel) {
  if (typeof rel !== 'string') return null;
  const parts = rel.split('/');
  if (parts.length !== 3) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parts[0])) return null;
  if (!/^[א-תa-zA-Z0-9_\- ]+$/.test(parts[1]) || !/^[א-תa-zA-Z0-9_\- .]+\.jpg$/i.test(parts[2])) return null;
  if (parts[2].includes('..')) return null;
  const full = path.join(SHOTS_ROOT, parts[0], parts[1], parts[2]);
  return isInside(SHOTS_ROOT, full) ? full : null;
}

// מחיקת תיקיות תאריך ישנות (רק אם הוגדר screenshotRetentionDays ב-config.json)
function pruneOldScreenshots() {
  if (!RETENTION_DAYS || !fs.existsSync(SHOTS_ROOT)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  fs.readdirSync(SHOTS_ROOT).forEach(d => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;           // רק תיקיות בפורמט תאריך
    const t = Date.parse(d + 'T00:00:00');
    if (t && t < cutoff) {
      try { fs.rmSync(path.join(SHOTS_ROOT, d), { recursive: true, force: true }); console.log(`🧹 נמחקו צילומים ישנים: ${d}`); } catch {}
    }
  });
}
try { pruneOldScreenshots(); } catch {}

// ראיות מהאפליקציה/דף התלמיד (לכל שם תלמיד): הגבלת קצב וכמות
const EVIDENCE_KINDS = new Set(['tab-hidden','second-screen','paste','lock-escape','ai-clip-question','ai-clip-text','ai-clip-image','ai-ai-window','ai-snip-tool','ai-printscreen','ai-off-list-nav']);
const AUTO_SHOT_CAP = 800;      // צילומים אוטומטיים לתלמיד
const EVIDENCE_CAP  = 150;      // צילומי ראיה לתלמיד
const shotStats = {};           // nameKey -> { auto, evidence, lastEvidence:{kind:ts} }
function statsFor(name) { return shotStats[nameKey(name)] || (shotStats[nameKey(name)] = { auto: 0, evidence: 0, lastEvidence: {} }); }

function handleRequest(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const pathname = req.url.split('?')[0];

  if (pathname === '/admin-login' && req.method === 'POST') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, blocked: true })); return; }
    readBody(req, res, 2048, buf => {
      try {
        const parsed = JSON.parse(buf.toString('utf8'));
        if (typeof parsed.pass === 'string' && safeEqual(parsed.pass, ADMIN_PASSWORD)) {
          const token = createSession();
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `adminSession=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          loginFailed(ip);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
        }
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (pathname === '/admin-logout') {
    const t = sessionToken(req.headers.cookie);
    if (t) sessions.delete(t);
    res.writeHead(302, { Location: '/admin.html', 'Set-Cookie': 'adminSession=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
    res.end();
    return;
  }

  if (pathname === '/screenshots-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ enabled: screenshotsEnabled }));
    return;
  }

  // קבלת צילום מסך מתלמיד (אוטומטי) - דורש טוקן של תלמיד מחובר
  if (pathname === '/upload-screenshot' && req.method === 'POST') {
    let studentName = '';
    try { studentName = decodeURIComponent(req.headers['x-student-name'] || ''); } catch {}
    const st = findStudentByName(studentName);
    if (!st || !req.headers['x-student-token'] || !safeEqual(req.headers['x-student-token'], st.token)) {
      res.writeHead(403); res.end(); return;
    }
    const evKind = String(req.headers['x-evidence-kind'] || '');
    const isEvidence = !!evKind;
    if (isEvidence && !EVIDENCE_KINDS.has(evKind)) { res.writeHead(400); res.end(); return; }
    // צילום אוטומטי רק כשהמורה הפעיל; צילום ראיה (בעקבות דגל) תמיד
    if (!isEvidence && !screenshotsEnabled) { res.writeHead(204); res.end(); return; }
    const stats = statsFor(st.name);
    if (isEvidence) {
      const last = stats.lastEvidence[evKind] || 0;
      if (stats.evidence >= EVIDENCE_CAP || Date.now() - last < 1500) { res.writeHead(204); res.end(); return; }
      stats.lastEvidence[evKind] = Date.now();
    } else if (stats.auto >= AUTO_SHOT_CAP) { res.writeHead(204); res.end(); return; }
    readBody(req, res, 6 * 1024 * 1024, buf => {
      try {
        if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) { res.writeHead(400); res.end(); return; }   // חייב להיות JPEG
        const rel = saveShot(st.name, buf, isEvidence ? 'flag-' + evKind : 'auto', 'unknown');
        if (!rel) { res.writeHead(400); res.end(); return; }
        if (isEvidence) {
          stats.evidence++;
          attachEvidence(st.name, evKind, rel);
        } else stats.auto++;
        res.writeHead(200); res.end('ok');
      } catch { res.writeHead(500); res.end(); }
    });
    return;
  }

  // צילום מסך ידני (מהמורה)
  if (pathname === '/manual-screenshot' && req.method === 'POST') {
    if (!validSession(req.headers.cookie)) { res.writeHead(403); res.end(); return; }
    readBody(req, res, 15 * 1024 * 1024, buf => {
      try {
        const { studentName, imageData } = JSON.parse(buf.toString('utf8'));
        if (typeof imageData !== 'string') { res.writeHead(400); res.end(); return; }
        const img = Buffer.from(imageData.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
        if (!saveShot(studentName, img, 'manual', 'manual')) { res.writeHead(400); res.end(); return; }
        res.writeHead(200); res.end('ok');
      } catch { res.writeHead(500); res.end(); }
    });
    return;
  }

  // צפייה בצילום (מורה בלבד)
  if (pathname === '/shot') {
    if (!validSession(req.headers.cookie)) { res.writeHead(403); res.end(); return; }
    let rel = '';
    try { rel = new URL(req.url, 'https://x').searchParams.get('p') || ''; } catch {}
    const full = resolveShot(rel);
    if (!full) { res.writeHead(404); res.end(); return; }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
      res.end(data);
    });
    return;
  }

  // כתובות שהתלמידים צריכים להקליד (כתובות ה-LAN של מחשב המורה) - להצגה בדף המורה
  if (pathname === '/server-info') {
    if (!validSession(req.headers.cookie)) { res.writeHead(403); res.end(); return; }
    const ips = lanAddresses();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ port: Number(PORT), studentUrls: ips.map(x => `https://${x.address}:${PORT}/student.html`) }));
    return;
  }

  // נתוני סקירה למורה: לכל תלמיד ציון חשד, ספירת אירועים וציר זמן עם ראיות
  if (pathname === '/review-data') {
    if (!validSession(req.headers.cookie)) { res.writeHead(403); res.end(); return; }
    const rows = Object.values(persistentStudents).map(p => {
      const live = Object.values(students).find(x => x.name === p.name);
      const sus = suspicionOf(p, live ? !!live.usingApp : undefined);
      return {
        name: p.name, ip: p.ip, online: isLive(live), usingApp: live ? !!live.usingApp : null,
        score: sus.score, level: sus.level, counts: sus.counts,
        autoShots: (shotStats[nameKey(p.name)] || {}).auto || 0,
        events: (p.events || []).slice(-200),
      };
    }).sort((a, b) => b.score - a.score);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ students: rows, now: new Date().toISOString() }));
    return;
  }

  // התראה מהסורק החיצוני (scanner.py --watch)
  if (pathname === '/scan-alert' && req.method === 'POST') {
    readBody(req, res, 20 * 1024, buf => {
      try {
        const m = JSON.parse(buf.toString('utf8'));
        if (typeof m.key !== 'string' || !safeEqual(m.key, SCANNER_KEY)) { res.writeHead(403); res.end(); return; }
        const p = persistentStudents[normalizeName(m.student)] ||
          Object.values(persistentStudents).find(x => nameKey(x.name) === nameKey(m.student));
        if (!p) { res.writeHead(404); res.end(); return; }
        const ai = (Array.isArray(m.ai) ? m.ai : []).map(x => clip(String(x), 80)).slice(0, 5);
        const blocked = (Array.isArray(m.blocked) ? m.blocked : []).map(x => clip(String(x), 80)).slice(0, 5);
        const shots = resolveShot(m.file) ? [m.file] : undefined;
        if (ai.length) {
          const text = `🔎 הסורק זיהה אתר/כלי AI אצל ${p.name}: ${ai.join(', ')}`;
          addLog('warning', text);
          recordStudentEvent(p.name, `הסורק זיהה אתר AI: ${ai.join(', ')}`, 'scan-ai', { shots });
          const live = Object.values(students).find(x => x.name === p.name);
          if (live) sendToAdmin({ type: 'flag', id: live.id, kind: 'scan-ai', message: text });
        } else if (blocked.length) {
          addLog('info', `🔎 הסורק: ${p.name} באתר שלא ברשימה: ${blocked.join(', ')}`);
          recordStudentEvent(p.name, `הסורק: אתר לא ברשימה: ${blocked.join(', ')}`, 'scan-offlist', { shots });
        }
        res.writeHead(200); res.end('ok');
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  // פרטי TURN - נדרשים לכל לקוח (רשת מקומית); הסיסמה אקראית ב-config.json
  if (pathname === '/turn-config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ user: TURN_USER, pass: TURN_PASS, port: TURN_PORT }));
    return;
  }

  // ── הורדת אפליקציית הפיקוח (Option B) ───────────────────────
  // מחפש קובץ מותקן ב-agent/dist/ ומגיש אותו. אם לא קיים - 404 עם הסבר.
  if (pathname === '/download-agent') {
    const distDir = path.join(__dirname, 'agent', 'dist');
    let file = null;
    try {
      // הקובץ החדש ביותר (כך גרסה ישנה שנשארה בתיקייה לא מוגשת)
      const exes = fs.readdirSync(distDir).filter(f => /\.exe$/i.test(f))
        .map(f => ({ f, t: fs.statSync(path.join(distDir, f)).mtimeMs, setup: /(setup|exam-client)/i.test(f) }))
        .sort((a, b) => (b.setup - a.setup) || (b.t - a.t));
      file = exes.length ? exes[0].f : null;
    } catch {}
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('אפליקציית הפיקוח טרם נבנתה. ראה agent/README.md (npm install && npm run build).');
      return;
    }
    const full = path.join(distDir, file);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${file}"`,
    });
    fs.createReadStream(full).pipe(res);
    return;
  }

  if (pathname === '/download-report') {
    if (!validSession(req.headers.cookie)) { res.writeHead(403); res.end(); return; }
    saveStudentFile();
    const fname = path.basename(STUDENT_FILE);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fname}"` });
    try { res.end(fs.readFileSync(STUDENT_FILE)); } catch { res.end('שגיאה'); }
    return;
  }

  if (pathname === '/download-log') {
    if (!validSession(req.headers.cookie)) { res.writeHead(403); res.end(); return; }
    const fname = path.basename(LOG_FILE);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${fname}"` });
    try { res.end(fs.readFileSync(LOG_FILE)); } catch { res.end('שגיאה'); }
    return;
  }

  if (pathname === '/timer-started' && req.method === 'POST') {
    if (!validSession(req.headers.cookie)) { res.writeHead(403); res.end(); return; }
    timerStartTime = Date.now();
    addLog('info', `⏱ השעון הופעל`);
    saveStudentFile();
    res.writeHead(200); res.end();
    return;
  }

  // ── קבצים סטטיים: רק מתוך public/ ──────────────────────────
  let urlPath;
  try { urlPath = decodeURIComponent(pathname); } catch { res.writeHead(400); res.end(); return; }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^[\/\\]+/, '');
  // ב-Windows: נקודה/רווח בסוף, ':' (זרם נתונים חלופי) ותווי NUL עוקפים בדיקות שם קובץ
  if (/[\0:]/.test(rel) || /[. ](\/|\\|$)/.test(rel)) { res.writeHead(404); res.end('Not found'); return; }
  const filePath = path.resolve(PUBLIC_DIR, rel);
  if (!isInside(PUBLIC_DIR, filePath)) { res.writeHead(404); res.end('Not found'); return; }
  const ext = path.extname(filePath).toLowerCase();
  if (!MIME[ext]) { res.writeHead(404); res.end('Not found'); return; }

  if (path.basename(filePath).toLowerCase() === 'admin.html' && !validSession(req.headers.cookie)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP, 'Cache-Control': 'no-store' });
    res.end(LOGIN_PAGE);
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const headers = { 'Content-Type': MIME[ext], 'Cache-Control': 'no-store' };
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;
    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = https.createServer({ key, cert }, (req, res) => {
  try { handleRequest(req, res); }
  catch (e) {
    console.error('request error:', e.message);
    try { if (!res.headersSent) res.writeHead(500); res.end(); } catch {}
  }
});
server.on('clientError', (err, socket) => { try { socket.destroy(); } catch {} });

// ── הפניה מ-HTTP ל-HTTPS ──────────────────────────────────────
// תלמיד שמקליד http://... בטעות מופנה אוטומטית ל-https. אותו פורט משרת את שניהם: הבייט הראשון
// בחיבור מוצפן (TLS) הוא 0x16, כל דבר אחר הוא HTTP רגיל.
function httpsLocation(req) {
  const m = /^(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::\d+)?$/i.exec(String(req.headers.host || ''));
  const host = m ? m[1] : pickLanIp();   // Host לא תקין -> לא משקפים אותו חזרה
  return `https://${host}${Number(PORT) === 443 ? '' : ':' + PORT}${req.url && req.url[0] === '/' ? req.url : '/'}`;
}
function redirectHandler(req, res) {
  res.writeHead(307, { Location: httpsLocation(req), 'Cache-Control': 'no-store' });   // 307 ולא 301: דפדפנים לא שומרים לצמיתות
  res.end();
}
const redirectServer = http.createServer(redirectHandler);
redirectServer.on('clientError', (err, socket) => { try { socket.destroy(); } catch {} });

const mux = net.createServer(socket => {
  socket.on('error', () => {});
  socket.setTimeout(10000, () => socket.destroy());   // חיבור שלא שלח כלום
  socket.once('data', buf => {
    socket.setTimeout(0);
    socket.pause();
    socket.unshift(buf);
    (buf[0] === 0x16 ? server : redirectServer).emit('connection', socket);
    process.nextTick(() => socket.resume());
  });
});

// ── WebSocket ─────────────────────────────────────────────────
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });
// ה-ws מאזין לאותו שרת; אם הפורט תפוס השגיאה מגיעה גם דרכו - מונעים קריסה
wss.on('error', () => {});

function sendToAdmin(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c._isAdmin && c.readyState === 1) c.send(msg); });
}

// איתות WebRTC מתלמיד אל המורה: רק למסך המורה האחרון שהתחבר (מונע שתי תשובות מכרטיסיות כפולות)
let latestAdminWs = null;
function sendSignalToAdmin(data) {
  const msg = JSON.stringify(data);
  if (latestAdminWs && latestAdminWs.readyState === 1 && latestAdminWs._isAdmin) { latestAdminWs.send(msg); return; }
  sendToAdmin(data);
}

// שולח הודעה לתלמידים לפי target: 'all' | מערך ids | id יחיד
function sendToStudents(target, payload) {
  const ids = target === 'all'
    ? Object.keys(students)
    : (Array.isArray(target) ? target : [target]).map(String);
  const msg = JSON.stringify(payload);
  let sent = 0;
  ids.forEach(id => {
    const s = students[id];
    if (s && s.ws && s.ws.readyState === 1) { s.ws.send(msg); sent++; }
  });
  return sent;
}

// מחיל את מצב המבחן הנוכחי על תלמיד בודד שהצטרף/התחבר מחדש
function applyExamStateTo(s) {
  const ws = s && s.ws;
  if (!ws || ws.readyState !== 1) return;
  const send = obj => ws.send(JSON.stringify(obj));
  const ov = s.ov || {};
  const lock  = 'lock' in ov ? ov.lock : examState.lock;
  const block = 'inputBlock' in ov ? ov.inputBlock : examState.inputBlock;
  if (examState.links && examState.links.length) send({ type:'exam-links', links: examState.links });
  if (examState.examUrl)   send({ type:'exam-url', url: examState.examUrl });
  if (examState.countdown) {
    const remainingMs = examState.countdown.endsAt - Date.now();
    if (remainingMs > 0) send({ type:'countdown', on:true, remainingMs });
  }
  if (lock)  send({ type:'screen-lock', on:true, message: lock.message });
  if (block) send({ type:'input-block', on:true });
  if (screenshotsEnabled)  send({ type:'start-screenshots' });
}

// מחזיר תיאור קריא של היעד עבור הלוג
function targetLabel(target) {
  if (target === 'all') return 'כל התלמידים';
  const ids = (Array.isArray(target) ? target : [target]);
  const names = ids.map(id => (students[id] ? students[id].name : `#${id}`));
  return names.join(', ');
}

function addLog(type, message) {
  const entry = { type, message, time: new Date().toISOString() };
  log.push(entry);
  if (log.length > 500) log.shift();
  appendLogFile(entry);
  sendToAdmin({ type: 'log', entry });
}

function isLive(s) { return !!(s && s.ws && s.ws.readyState === 1); }

function getStudentList() {
  return Object.values(students).map(s => ({
    id: s.id, name: s.name, ip: s.ip, online: isLive(s),
    connectedAt: s.connectedAt, resolution: s.resolution, lastSeen: s.lastSeen, usingApp: !!s.usingApp,
  }));
}

// ── שמות: ניקוי והשוואה ───────────────────────────────────────
function normalizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFC').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}
function nameKey(name) { return normalizeName(name).toLowerCase(); }
function findStudentByName(name) {
  const k = nameKey(name);
  if (!k) return null;
  return Object.values(students).find(s => nameKey(s.name) === k) || null;
}
function clip(v, n) { return typeof v === 'string' ? v.slice(0, n) : ''; }
function validHttpUrl(u) { return typeof u === 'string' && u.length < 2000 && /^https?:\/\/[^\s]+$/i.test(u); }

// מצרף צילום ראיה לאירוע האחרון מאותו סוג (עד 15 שניות אחורה); אם אין - יוצר אירוע חדש
function attachEvidence(name, kind, rel) {
  const p = persistentStudents[name];
  if (!p) return;
  const now = Date.now();
  for (let i = p.events.length - 1; i >= 0 && i >= p.events.length - 8; i--) {
    const e = p.events[i];
    if (e.kind === kind && now - Date.parse(e.time) < 15000 && (!e.shots || e.shots.length < 3)) {
      e.shots = (e.shots || []).concat(rel);
      scheduleSave();
      return;
    }
  }
  recordStudentEvent(name, 'צילום ראיה', kind, { shots: [rel] });
}

// ── איתות WebRTC ──────────────────────────────────────────────
function handleSignal(ws, msg) {
  if (!['offer', 'answer', 'ice'].includes(msg.type)) return false;
  const out = { type: msg.type, from: ws._studentId };
  if (msg.subtype === 'broadcast') out.subtype = 'broadcast';
  if (msg.offer)     out.offer = msg.offer;
  if (msg.answer)    out.answer = msg.answer;
  if (msg.candidate) out.candidate = msg.candidate;
  if (ws._isAdmin) {
    const t = students[msg.target];
    if (t && isLive(t)) t.ws.send(JSON.stringify(out));
  } else if (ws._studentId && msg.target === 'admin') {
    sendSignalToAdmin(out);       // תלמיד יכול לאתת רק מול המורה
  }
  return true;
}

const ADMIN_ONLY = new Set(['control', 'toggle-auto-shots', 'set-expected', 'kick', 'unkick']);

function handleControl(ws, msg) {
  const { action } = msg;
  let target = msg.target;
  // מערך שמכסה את כל התלמידים נחשב 'all' (כדי שהמצב יישמר לחוזרים)
  if (Array.isArray(target)) {
    const live = Object.values(students).filter(isLive).map(s => String(s.id));
    if (live.length && live.every(id => target.map(String).includes(id))) target = 'all';
  } else if (target !== 'all' && target != null) {
    target = [target];
  }
  if (target == null) return;

  const ACTIONS = {
    'screen-lock':  m => ({ type:'screen-lock',  on: !!m.on, message: clip(m.message, 200) }),
    'input-block':  m => ({ type:'input-block',  on: !!m.on }),
    'message':      m => ({ type:'teacher-message', message: clip(m.message, 500) }),
    'countdown':    m => ({ type:'countdown', on: !!m.on, remainingMs: m.remainingMs }),
    'agent-launch': () => ({ type:'agent-launch' }),  // בקשה לפתוח את אפליקציית הנלווית
    'broadcast-end':() => ({ type:'broadcast-end' }), // סגירת שכבת שידור מסך המורה
    'end-exam':     () => ({ type:'end-exam' }),       // סיום מבחן - משחרר ויוצא מהאפליקציה
    'exam-url':     m => ({ type:'exam-url', url: m.url }), // הטמעת אתר המבחן (Option B)
    'exam-links':   m => ({ type:'exam-links', links: m.links }), // רשימת קישורים מאושרים
  };
  if (!ACTIONS[action]) return;

  // ולידציה וניקוי לפני שידור
  if (action === 'exam-url') {
    if (!validHttpUrl(msg.url)) { addLog('warning', '⚠️ כתובת אתר מבחן לא תקינה (נדרש http/https) - לא שודרה'); return; }
  }
  if (action === 'exam-links') {
    msg.links = (Array.isArray(msg.links) ? msg.links : [])
      .filter(l => l && typeof l.name === 'string' && validHttpUrl(l.url))
      .slice(0, 30).map(l => ({ name: l.name.slice(0, 60), url: l.url }));
  }
  let countdownEndsAt = null;
  if (action === 'countdown') {
    if (msg.on) {
      // משך בלבד (לא שעון של המורה): כל תלמיד סופר מהרגע שקיבל
      const dur = Number(msg.durationMs) || (Number(msg.endsAt) ? Number(msg.endsAt) - Date.now() : 0);
      if (!(dur > 0 && dur < 24 * 3600 * 1000)) return;
      countdownEndsAt = Date.now() + dur;
      msg.remainingMs = dur;
    } else msg.remainingMs = 0;
  }

  const count = sendToStudents(target, ACTIONS[action](msg));

  if (target === 'all') {
    if (action === 'exam-url')    examState.examUrl = msg.url;
    if (action === 'exam-links')  examState.links = msg.links;
    if (action === 'countdown')   examState.countdown = msg.on ? { on:true, endsAt: countdownEndsAt } : null;
    if (action === 'screen-lock') { examState.lock = msg.on ? { on:true, message: clip(msg.message, 200) } : null; Object.values(students).forEach(s => { if (s.ov) delete s.ov.lock; }); }
    if (action === 'input-block') { examState.inputBlock = !!msg.on; Object.values(students).forEach(s => { if (s.ov) delete s.ov.inputBlock; }); }
    if (action === 'end-exam') {
      examState = { examUrl:null, links:[], countdown:null, lock:null, inputBlock:false };
      Object.values(students).forEach(s => { s.ov = {}; });
    }
  } else if (action === 'screen-lock' || action === 'input-block') {
    // נעילה/שחרור לתלמידים נבחרים: זוכרים לכל אחד בנפרד (כדי שלא יחזרו נעולים/משוחררים בטעות)
    target.forEach(id => {
      const s = students[id]; if (!s) return;
      s.ov = s.ov || {};
      if (action === 'screen-lock') s.ov.lock = msg.on ? { on:true, message: clip(msg.message, 200) } : null;
      else s.ov.inputBlock = !!msg.on;
    });
  }
  const labels = {
    'screen-lock':  msg.on ? '🔒 נעילת מסך' : '🔓 שחרור מסך',
    'input-block':  msg.on ? '⌨️ חסימת קלט' : '⌨️ שחרור קלט',
    'message':      `✉️ הודעה: "${clip(msg.message, 500)}"`,
    'countdown':    msg.on ? '⏳ ספירה לאחור שודרה' : '⏳ ספירה לאחור בוטלה',
    'agent-launch': '🚀 בקשת הפעלת אפליקציית פיקוח',
    'broadcast-end':'📡 שיתוף מסך המורה הופסק',
    'end-exam':     '🏁 המבחן הסתיים - שוחררו תלמידים',
    'exam-url':     `🌐 אתר המבחן שודר: ${msg.url || ''}`,
    'exam-links':   `🔗 שודרו ${(msg.links||[]).length} קישורים מאושרים`,
  };
  addLog('info', `${labels[action]} → ${targetLabel(target)} (${count})`);
}

function handleStudentJoin(ws, msg, ip) {
  const name = normalizeName(msg.name);
  if (!name) return;

  // חסימת תלמיד שהועף - לא יכול להצטרף מחדש מיד
  const key = nameKey(name);
  const kickedAt = kicked[`${key}|${ip}`] || kicked[key];
  if (kickedAt && Date.now() - kickedAt < KICK_BLOCK_MS) {
    ws.send(JSON.stringify({ type: 'kicked' }));
    ws.close();
    return;
  }

  const usingApp = !!msg.usingApp;
  const clientToken = typeof msg.token === 'string' ? msg.token : '';
  const existing = findStudentByName(name);
  if (existing) {
    // השם תפוס ע"י חיבור חי של מישהו אחר (בלי הטוקן הנכון) - לא מאפשרים השתלטות
    if (isLive(existing) && existing.ws !== ws && !(clientToken && safeEqual(clientToken, existing.token))) {
      ws.send(JSON.stringify({ type: 'name-taken' }));
      return;
    }
    if (isLive(existing) && existing.ws !== ws) {
      // אותו תלמיד התחבר מחדש - החיבור הישן מתבטל בלי להציף התנתקות
      existing.ws._studentId = null;
      try { existing.ws.close(); } catch {}
    }
    if (!(clientToken && safeEqual(clientToken, existing.token))) existing.token = crypto.randomBytes(16).toString('hex');
    existing.ws = ws; existing.ip = ip; existing.lastSeen = Date.now(); existing.usingApp = usingApp;
    ws._studentId = existing.id;
    ws.send(JSON.stringify({ type: 'joined', id: existing.id, name: existing.name, token: existing.token }));
    addLog('reconnect', `${existing.name} התחבר מחדש (${ip})${usingApp ? ' 🛡️ באפליקציה' : ' 🌐 בדפדפן'}`);
    recordStudent({ name: existing.name, ip });
    recordStudentEvent(existing.name, 'התחבר מחדש', 'reconnect');
    sendToAdmin({ type: 'reconnect', student: { id: existing.id, name: existing.name, ip, connectedAt: existing.connectedAt, resolution: existing.resolution, lastSeen: existing.lastSeen, usingApp, online: true } });
    applyExamStateTo(existing);   // מחיל מצב מבחן נוכחי (אתר/קישורים/טיימר/נעילה)
  } else {
    const id = idCounter++;
    const token = crypto.randomBytes(16).toString('hex');
    students[id] = { id, ws, name, ip, connectedAt: Date.now(), resolution: null, lastSeen: Date.now(), usingApp, token, ov: {} };
    ws._studentId = id;
    ws.send(JSON.stringify({ type: 'joined', id, name, token }));
    addLog(usingApp ? 'join' : 'warning', `${name} התחבר (${ip})${usingApp ? ' 🛡️ באפליקציה' : ' 🌐 בדפדפן בלבד - לא באפליקציה!'}`);
    recordStudent({ name, ip, resolution: null });
    recordStudentEvent(name, 'התחבר', 'join');
    sendToAdmin({ type: 'student-join', student: getStudentList().find(s => s.id === id) });
    const connected = Object.values(students).filter(isLive).length;
    if (expectedCount > 0 && connected > expectedCount) {
      addLog('warning', `⚠️ מחוברים יותר תלמידים מהצפוי! (${connected}/${expectedCount})`);
      sendToAdmin({ type: 'alert', message: `מחוברים יותר תלמידים מהצפוי! (${connected}/${expectedCount})` });
    }
    applyExamStateTo(students[id]);   // מחיל מצב מבחן נוכחי על תלמיד חדש
  }
}

function handleMessage(ws, msg, ip, req) {
  if (ADMIN_ONLY.has(msg.type) && !ws._isAdmin) return;

  if (msg.type === 'admin-join') {
    // חייב להיות מחובר כמורה (עוגיית הסשן) וממקור תקין
    const origin = req.headers.origin;
    const sameOrigin = !origin || (() => { try { return new URL(origin).host === req.headers.host; } catch { return false; } })();
    if (!ws._authed || !sameOrigin || !validSession(req.headers.cookie)) {
      ws.send(JSON.stringify({ type: 'auth-required' }));
      return;
    }
    ws._isAdmin = true;
    latestAdminWs = ws;
    ws.send(JSON.stringify({ type: 'state', expectedCount, students: getStudentList(), log, screenshotsEnabled }));
    wss.clients.forEach(client => {
      if (!client._isAdmin && client.readyState === 1) {
        client.send(JSON.stringify({ type: 'request-offer' }));
        if (screenshotsEnabled) client.send(JSON.stringify({ type: 'start-screenshots' }));
      }
    });
    return;
  }

  if (msg.type === 'control') { handleControl(ws, msg); return; }

  if (msg.type === 'toggle-auto-shots') {
    screenshotsEnabled = !!msg.enabled;
    addLog('info', screenshotsEnabled ? '📸 צילומי מסך אוטומטיים הופעלו' : '📸 צילומי מסך אוטומטיים הופסקו');
    wss.clients.forEach(c => {
      if (!c._isAdmin && c.readyState === 1) {
        c.send(JSON.stringify({ type: screenshotsEnabled ? 'start-screenshots' : 'stop-screenshots' }));
      }
    });
    sendToAdmin({ type: 'auto-shots-status', enabled: screenshotsEnabled });
    return;
  }

  if (msg.type === 'set-expected') {
    expectedCount = Math.max(0, Math.min(1000, parseInt(msg.count) || 0));
    sendToAdmin({ type: 'expected', count: expectedCount });
    addLog('info', `מספר תלמידים צפוי נקבע ל-${expectedCount}`);
    saveStudentFile();
    return;
  }

  // התלמיד חוזר לתקן שם שגוי - מסירים אותו כדי שהשם המתוקן יתחיל נקי
  if (msg.type === 'leave-rename') {
    const id = ws._studentId;
    if (id && students[id] && students[id].ws === ws) {
      const name = students[id].name;
      delete students[id];
      ws._studentId = null;
      sendToAdmin({ type: 'student-remove', id });
      addLog('info', `✏️ ${name} חזר לתקן את שמו`);
    }
    return;
  }

  if (msg.type === 'kick') {
    const id = parseInt(msg.id);
    const s  = students[id];
    if (s) {
      // רישום החסימה - מונע הצטרפות מחדש מיידית (לפי שם מנורמל, וגם לפי שם+IP)
      const k = nameKey(s.name);
      kicked[`${k}|${s.ip}`] = Date.now();
      kicked[k] = Date.now();
      if (isLive(s)) { s.ws.send(JSON.stringify({ type: 'kicked' })); s.ws.close(); }
      delete students[id];
      sendToAdmin({ type: 'student-remove', id });
      addLog('warning', `🚫 ${s.name} הועף מהמערכת (חסום ל-${KICK_BLOCK_MS/60000} דק')`);
      recordStudentEvent(s.name, 'הועף מהמערכת', 'kick');
    }
    return;
  }

  // ביטול חסימת תלמיד שהועף (מאפשר חזרה לפני תום הזמן)
  if (msg.type === 'unkick') {
    const name = normalizeName(msg.name);
    const k = nameKey(name);
    if (k) {
      Object.keys(kicked).forEach(key => { if (key === k || key.startsWith(k + '|')) delete kicked[key]; });
      addLog('info', `✅ חסימת ${name} בוטלה`);
    }
    return;
  }

  // הוספת האזנה לעצירת שיתוף מסך
  if (msg.type === 'stop-share') {
    if (ws._studentId && students[ws._studentId]) {
      sendToAdmin({ type: 'stop-share', id: ws._studentId });
      recordStudentEvent(students[ws._studentId].name, 'הפסיק לשתף מסך', 'stop-share');
    }
    return;
  }

  if (msg.type === 'student-join') {
    if (ws._isAdmin) return;
    handleStudentJoin(ws, msg, ip);
    return;
  }

  if (msg.type === 'resolution') {
    const id = ws._studentId;
    if (id && students[id]) {
      const resolution = clip(msg.resolution, 20);
      const surfaceType = clip(msg.surfaceType, 20);
      students[id].resolution = resolution;
      students[id].lastSeen   = Date.now();
      students[id].mode = msg.mode === 'camera' ? 'camera' : 'screen';
      sendToAdmin({ type: 'resolution', id, resolution, mode: students[id].mode });
      const sname = students[id].name;
      if (persistentStudents[sname]) {
        persistentStudents[sname].resolution = resolution;
        scheduleSave();
      }
      if (msg.mode === 'camera') {
        addLog('info', `📷 ${sname} משתף ממצלמת טלפון`);
        recordStudentEvent(sname, 'שיתוף ממצלמת טלפון', 'camera');
      } else if (surfaceType && surfaceType !== 'monitor') {
        addLog('warning', `⚠️ ${sname} משתף רק חלק מהמסך (סוג: ${surfaceType})`);
        recordStudentEvent(sname, `שיתוף חלקי - סוג: ${surfaceType}`, 'partial-share');
        sendToAdmin({ type: 'alert', message: `${sname} משתף חלון או כרטיסיה בלבד!` });
      }
    }
    return;
  }

  if (msg.type === 'ping') {
    const id = ws._studentId;
    if (id && students[id]) students[id].lastSeen = Date.now();
    return;
  }

  // ── דיווח אירוע חשד מהתלמיד (החלפת לשונית, הדבקה, מסך שני) ──
  if (msg.type === 'event') {
    const id = ws._studentId;
    if (!id || !students[id]) return;
    const sname = students[id].name;
    const preview = clip(msg.preview, 60), detail = clip(msg.detail, 100);
    const length = Number.isFinite(msg.length) ? msg.length : '?';
    const kinds = {
      'tab-hidden':   `👁 ${sname} עזב את לשונית המבחן`,
      'tab-visible':  `👁 ${sname} חזר ללשונית המבחן`,
      'second-screen':`🖥️🖥️ ${sname} מחובר ליותר ממסך אחד`,
      'paste':        `📋 ${sname} הדביק טקסט (${length} תווים)${preview ? ': "'+preview+'"' : ''}`,
      'copy':         `📋 ${sname} העתיק טקסט מהמבחן`,
      'lock-escape':  `🚪 ${sname} עזב את המסך הנעול`,
      'exam-tab-mode':`🪟 ${sname} פתח את המבחן בלשונית נפרדת (זיהוי החלפת לשונית כבוי לו; המסך המשותף ממשיך להיות מנוטר)`,
      // גילויי AI מהאפליקציה
      'ai-clip-question': `🤖 ${sname} העתיק את שאלת המבחן ללוח${detail ? ': "'+detail+'"' : ''}`,
      'ai-clip-text':     `🤖 ${sname} העתיק טקסט ללוח${detail ? ' ('+detail+')' : ''}`,
      'ai-clip-image':    `📸 ${sname} העתיק תמונה ללוח (צילום מסך?)`,
      'ai-ai-window':     `🤖🚨 ${sname} פתח כלי בינה מלאכותית${detail ? ': '+detail : ''}`,
      'ai-snip-tool':     `📸 ${sname} פתח כלי גזירת מסך`,
      'ai-printscreen':   `📸 ${sname} לחץ על מקש צילום מסך`,
      'ai-off-list-nav':  `🔗⚠️ ${sname} ניווט לאתר לא מאושר${detail ? ': '+detail : ''}`,
    };
    const text = typeof msg.kind === 'string' && Object.prototype.hasOwnProperty.call(kinds, msg.kind) ? kinds[msg.kind] : null;
    if (!text) return;
    const isWarn = msg.kind !== 'tab-visible';
    addLog(isWarn ? 'warning' : 'info', text);
    recordStudentEvent(sname, text.replace(/^[^ ]+ /, ''), msg.kind);
    if (isWarn) sendToAdmin({ type: 'flag', id, kind: msg.kind, message: text });
    return;
  }

  handleSignal(ws, msg);
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  ws._isAdmin   = false;
  ws._studentId = null;
  ws._authed    = validSession(req.headers.cookie);
  ws._alive     = true;

  ws.on('error', () => {});                 // frame לא תקין וכו' - לא מפילים את השרת
  ws.on('pong', () => { ws._alive = true; });

  ws.on('message', raw => {
    try {
      ws._alive = true;
      let msg; try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
      handleMessage(ws, msg, ip, req);
    } catch (e) { console.error('ws message error:', e.message); }
  });

  ws.on('close', () => {
    if (latestAdminWs === ws) latestAdminWs = null;
    const id = ws._studentId;
    if (id && students[id] && students[id].ws === ws) {
      const name = students[id].name;
      students[id].ws = null;
      addLog('disconnect', `${name} התנתק`);
      recordStudentEvent(name, 'התנתק', 'disconnect');
      sendToAdmin({ type: 'student-leave', id });
      const connected = Object.values(students).filter(isLive).length;
      if (expectedCount > 0 && connected < expectedCount)
        sendToAdmin({ type: 'alert', message: `⚠️ ${name} התנתק! מחוברים ${connected}/${expectedCount}` });
    }
  });
});

// דופק: חיבורים "תקועים" (נתק רשת בלי סגירה) מזוהים ונסגרים תוך ~30 שניות
setInterval(() => {
  wss.clients.forEach(c => {
    if (c._alive === false) { try { c.terminate(); } catch {} return; }
    c._alive = false;
    try { c.ping(); } catch {}
  });
}, 15000);

setInterval(() => {
  Object.keys(students).forEach(id => {
    const s = students[id];
    if ((!s.ws || s.ws.readyState !== 1) && Date.now() - s.lastSeen > 5 * 60 * 1000) {
      delete students[id];
      sendToAdmin({ type: 'student-remove', id: parseInt(id) });
    }
  });
  // ניקוי חסימות שפגו, סשנים שפגו וניסיונות כניסה ישנים
  const now = Date.now();
  Object.keys(kicked).forEach(k => { if (now - kicked[k] > KICK_BLOCK_MS) delete kicked[k]; });
  sessions.forEach((exp, t) => { if (exp < now) sessions.delete(t); });
  Object.keys(loginFails).forEach(ip => { if (loginFails[ip].until < now && loginFails[ip].n === 0) delete loginFails[ip]; });
}, 30000);

// טיפול בשגיאת "הפורט תפוס" - הודעה ברורה במקום קריסה מכוערת
mux.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ הפורט ${PORT} כבר בשימוש - כנראה השרת כבר פועל בחלון אחר.`);
    console.error(`   סגור את החלון הקודם של השרת ונסה שוב, או הרץ:`);
    console.error(`   npx kill-port ${PORT}\n`);
  } else {
    console.error(`\n❌ שגיאת שרת: ${err.message}\n`);
  }
  process.exit(1);
});

// רשת ביטחון אחרונה: תקלה בלתי צפויה נרשמת ולא מפילה מבחן באמצע
process.on('uncaughtException', err => { console.error('uncaughtException:', err && err.stack || err); });
process.on('unhandledRejection', err => { console.error('unhandledRejection:', err && err.stack || err); });

const KIND_LABEL = { wifi: 'Wi-Fi', lan: 'LAN', hotspot: 'נקודה חמה', other: 'אחר', virtual: 'וירטואלי' };

// פורט 80: מי שמקליד רק את ה-IP (בלי פורט) מגיע לכאן ומופנה ל-https. אופציונלי - אם הפורט תפוס או חסום, מדלגים.
const HTTP_REDIRECT_PORT = cfg.httpRedirectPort === undefined ? 80 : Number(cfg.httpRedirectPort);
if (HTTP_REDIRECT_PORT > 0 && HTTP_REDIRECT_PORT !== Number(PORT)) {
  const r80 = http.createServer(redirectHandler);
  r80.on('clientError', (err, socket) => { try { socket.destroy(); } catch {} });
  r80.on('error', err => console.warn(`ℹ️  הפניית HTTP בפורט ${HTTP_REDIRECT_PORT} לא פעילה (${err.code}). הפניה בפורט ${PORT} כן עובדת.`));
  r80.listen(HTTP_REDIRECT_PORT);
}

mux.listen(PORT, () => {
  const ips = lanAddresses();
  const mainHost = ips.length ? ips[0].address : 'localhost';
  console.log(`\n✅ שרת פועל!`);
  console.log(`\n👨‍🏫 דף ניהול:   https://${mainHost}:${PORT}/admin.html   (או במחשב הזה: https://localhost:${PORT}/admin.html)`);
  if (generatedPassword) {
    console.log(`\n🔐 נוצר config.json חדש עם סיסמת מורה אקראית. הסיסמה לא מוצגת כאן - פתח את config.json (שדה adminPassword), שם גם אפשר לשנות אותה.`);
  } else if (DEFAULT_PASSWORD_IN_USE) {
    console.log(`\n⚠️  סיסמת המורה היא ברירת המחדל הידועה! שנה את adminPassword ב-config.json`);
  } else {
    console.log(`\n🔐 סיסמת מורה: ב-config.json`);
  }
  console.log(`\n🔎 סקירת חשד: כפתור "סקירה" בדף המורה. סורק חי: python scanner.py --watch --server https://localhost:${PORT} --key <scannerKey מתוך config.json>`);
  if (ips.length) {
    console.log(`\n👨‍🎓 לתלמידים:   https://${mainHost}:${PORT}/student.html   ← הקישור הראשי (${KIND_LABEL[ips[0].kind]})`);
    if (ips.length > 1) {
      console.log(`   קישורים חלופיים, לפי סדר עדיפות (Wi-Fi → LAN → נקודה חמה → אחר):`);
      ips.slice(1).forEach(x => console.log(`     https://${x.address}:${PORT}/student.html   (${KIND_LABEL[x.kind]})`));
    }
  } else {
    console.log(`\n👨‍🎓 לתלמידים:   לא נמצא חיבור רשת! התחבר ל-Wi-Fi / LAN / נקודה חמה והפעל מחדש.`);
  }
  console.log(`\nCtrl+C לעצירה\n`);
});
