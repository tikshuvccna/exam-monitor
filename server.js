const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Turn   = require('node-turn');

// ── Config ───────────────────────────────────────────────────
// טוען config.json אם קיים (לא נשמר ב-git). אחרת משתמש בברירות מחדל.
// העתק את config.example.json ל-config.json ושנה את הסיסמאות.
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); }
catch { console.warn('⚠️  config.json לא נמצא - משתמש בברירות מחדל. העתק את config.example.json ל-config.json ושנה סיסמאות.'); }

const PORT           = process.env.EXAM_PORT       || cfg.port          || 4555;
const TURN_PORT      = process.env.EXAM_TURN_PORT  || cfg.turnPort      || 3478;
const TURN_USER      = process.env.EXAM_TURN_USER  || cfg.turnUser      || 'examuser';
const TURN_PASS      = process.env.EXAM_TURN_PASS  || cfg.turnPass      || 'exampass';
const ADMIN_PASSWORD = process.env.EXAM_ADMIN_PASS || cfg.adminPassword || 'bandwidth';

// ── SSL ──────────────────────────────────────────────────────
const cert = fs.readFileSync(path.join(__dirname, 'cert.pem'));
const key  = fs.readFileSync(path.join(__dirname, 'key.pem'));

// ── TURN ─────────────────────────────────────────────────────
const turnServer = new Turn({
  listeningPort: TURN_PORT, listeningIps: ['0.0.0.0'], relayIps: ['0.0.0.0'],
  authMech: 'long-term', credentials: { [TURN_USER]: TURN_PASS }, debugLevel: 'OFF',
});
turnServer.start();
console.log(`✅ TURN server פועל על פורט ${TURN_PORT}`);

// ── Session store ─────────────────────────────────────────────
const sessions = new Set();
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.add(token);
  return token;
}
function validSession(cookieHeader) {
  if (!cookieHeader) return false;
  const m = cookieHeader.match(/adminSession=([a-f0-9]+)/);
  return m && sessions.has(m[1]);
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

// ── Log helpers ───────────────────────────────────────────────
function appendLogFile(entry) {
  const timerStr = timerStartTime
    ? ` [שעון: ${formatDurationSec(Math.floor((Date.now() - timerStartTime) / 1000))}]`
    : '';
  const line = `[${new Date(entry.time).toLocaleString('he-IL')}]${timerStr} [${entry.type.toUpperCase()}] ${entry.message}\n`;
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
    'שיתוף חלקי?', 'הועף?', 'כל האירועים',
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
    return [
      s.name, s.ip, s.resolution||'-',
      new Date(s.firstSeen).toLocaleString('he-IL'),
      new Date(s.lastSeen).toLocaleString('he-IL'),
      dur, disconnects, partial, kicked, evtStr,
    ];
  });

  const csvRow = arr => arr.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',');

  const lines = [ ...summary.map(r => csvRow(r)), csvRow(studentHeader), ...studentRows.map(r => csvRow(r)) ];

  try { fs.writeFileSync(STUDENT_FILE, '\uFEFF' + lines.join('\n')); } catch {}
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
  saveStudentFile();
}

function recordStudentEvent(name, event) {
  if (persistentStudents[name]) {
    persistentStudents[name].events.push({ event, time: new Date().toISOString() });
    persistentStudents[name].lastSeen = new Date().toISOString();
    saveStudentFile();
  }
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
const server = https.createServer({ key, cert }, (req, res) => {

  if (req.url === '/admin-login' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (parsed.pass === ADMIN_PASSWORD) {
          const token = createSession();
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `adminSession=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`
          });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false }));
        }
      } catch { res.writeHead(400); res.end(); }
    });
    return;
  }

  if (req.url === '/screenshots-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ enabled: screenshotsEnabled }));
    return;
  }

  // קבלת צילום מסך מתלמיד (אוטומטי)
  if (req.url === '/upload-screenshot' && req.method === 'POST') {
    const studentName = decodeURIComponent(req.headers['x-student-name'] || 'unknown');
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const today = new Date();
        const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
        const safeStudentName = studentName.replace(/[^א-תa-zA-Z0-9_\- ]/g, '').trim() || 'unknown';
        const shotsRoot = path.join(__dirname, 'screenshots');
        const studentDir = path.join(shotsRoot, dateStr, safeStudentName);
        if (!isInside(shotsRoot, studentDir)) { res.writeHead(400); res.end(); return; }
        if (!fs.existsSync(studentDir)) fs.mkdirSync(studentDir, { recursive: true });

        // יצירת שם קובץ מותאם: שם_תאריך_שעה_auto.jpg
        const tsFormatted = makeTimestamp();
        const filePath = path.join(studentDir, `${safeStudentName}_${tsFormatted}_auto.jpg`);
        
        fs.writeFile(filePath, buf, () => {});
        res.writeHead(200); res.end('ok');
      } catch { res.writeHead(500); res.end(); }
    });
    return;
  }

  // צילום מסך ידני (מהמורה)
  if (req.url === '/manual-screenshot' && req.method === 'POST') {
    if (!validSession(req.headers.cookie)) { res.writeHead(403); res.end(); return; }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { studentName, imageData } = JSON.parse(body);
        const today = new Date();
        const dateStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
        const safeStudentName = (studentName || 'manual').replace(/[^א-תa-zA-Z0-9_\- ]/g, '').trim() || 'manual';
        const shotsRoot = path.join(__dirname, 'screenshots');
        const studentDir = path.join(shotsRoot, dateStr, safeStudentName);
        if (!isInside(shotsRoot, studentDir)) { res.writeHead(400); res.end(); return; }
        if (!fs.existsSync(studentDir)) fs.mkdirSync(studentDir, { recursive: true });
        
        // יצירת שם קובץ מותאם: שם_תאריך_שעה_manual.jpg
        const tsFormatted = makeTimestamp();
        const base64Data = imageData.replace(/^data:image\/jpeg;base64,/, '');
        const filePath = path.join(studentDir, `${safeStudentName}_${tsFormatted}_manual.jpg`);
        
        fs.writeFile(filePath, Buffer.from(base64Data, 'base64'), () => {});
        res.writeHead(200); res.end('ok');
      } catch { res.writeHead(500); res.end(); }
    });
    return;
  }

  if (req.url === '/turn-config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user: TURN_USER, pass: TURN_PASS, port: TURN_PORT }));
    return;
  }

  // ── הורדת אפליקציית הפיקוח (Option B) ───────────────────────
  // מחפש קובץ מותקן ב-agent/dist/ ומגיש אותו. אם לא קיים - 404 עם הסבר.
  if (req.url === '/download-agent') {
    const distDir = path.join(__dirname, 'agent', 'dist');
    let file = null;
    try {
      file = fs.readdirSync(distDir).find(f => /(setup|exam-client).*\.exe$/i.test(f))
          || fs.readdirSync(distDir).find(f => /\.exe$/i.test(f));
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

  if (req.url === '/download-report') {
    if (!validSession(req.headers.cookie)) { res.writeHead(403); res.end(); return; }
    saveStudentFile(); 
    const fname = path.basename(STUDENT_FILE);
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${fname}"` });
    try { res.end(fs.readFileSync(STUDENT_FILE)); } catch { res.end('שגיאה'); }
    return;
  }

  if (req.url === '/download-log') {
    if (!validSession(req.headers.cookie)) { res.writeHead(403); res.end(); return; }
    const fname = path.basename(LOG_FILE);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': `attachment; filename="${fname}"` });
    try { res.end(fs.readFileSync(LOG_FILE)); } catch { res.end('שגיאה'); }
    return;
  }

  if (req.url === '/timer-started' && req.method === 'POST') {
    if (!validSession(req.headers.cookie)) { res.writeHead(403); res.end(); return; }
    timerStartTime = Date.now();
    addLog('info', `⏱ השעון הופעל`);
    saveStudentFile();
    res.writeHead(200); res.end();
    return;
  }

  if (req.url === '/admin.html') {
    if (!validSession(req.headers.cookie)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(LOGIN_PAGE);
      return;
    }
  }

  const urlPath  = req.url.split('?')[0];
  const filePath = path.join(__dirname, 'public', urlPath === '/' ? 'index.html' : urlPath);
  const ext      = path.extname(filePath);
  const mime     = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    res.end(data);
  });
});

// ── WebSocket ─────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

function sendToAdmin(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c._isAdmin && c.readyState === 1) c.send(msg); });
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

function getStudentList() {
  return Object.values(students).map(s => ({
    id: s.id, name: s.name, ip: s.ip,
    connectedAt: s.connectedAt, resolution: s.resolution, lastSeen: s.lastSeen,
  }));
}

wss.on('connection', (ws, req) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').replace('::ffff:', '');
  ws._isAdmin   = false;
  ws._studentId = null;

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'admin-join') {
      ws._isAdmin = true;
      ws.send(JSON.stringify({ type: 'state', expectedCount, students: getStudentList(), log, screenshotsEnabled }));
      wss.clients.forEach(client => {
        if (!client._isAdmin && client.readyState === 1) {
          client.send(JSON.stringify({ type: 'request-offer' }));
          if (screenshotsEnabled) client.send(JSON.stringify({ type: 'start-screenshots' }));
        }
      });
      return;
    }
    
    // ── פקודות שליטה מהמורה אל תלמידים ──────────────────────
    // { type:'control', action, target:'all'|[ids]|id, ...payload }
    if (msg.type === 'control') {
      if (!ws._isAdmin) return;                     // רק מורה רשאי
      const { action, target } = msg;
      const ACTIONS = {
        'screen-lock':  m => ({ type:'screen-lock',  on: m.on, message: m.message || '' }),
        'input-block':  m => ({ type:'input-block',  on: m.on }),
        'message':      m => ({ type:'teacher-message', message: m.message || '' }),
        'countdown':    m => ({ type:'countdown', endsAt: m.endsAt, on: m.on }),
        'agent-launch': () => ({ type:'agent-launch' }),  // בקשה לפתוח את אפליקציית הנלווית
        'broadcast-end':() => ({ type:'broadcast-end' }), // סגירת שכבת שידור מסך המורה
      };
      const build = ACTIONS[action];
      if (!build) return;
      const count = sendToStudents(target, build(msg));
      const labels = {
        'screen-lock':  msg.on ? '🔒 נעילת מסך' : '🔓 שחרור מסך',
        'input-block':  msg.on ? '⌨️ חסימת קלט' : '⌨️ שחרור קלט',
        'message':      `✉️ הודעה: "${msg.message || ''}"`,
        'countdown':    msg.on ? '⏳ ספירה לאחור שודרה' : '⏳ ספירה לאחור בוטלה',
        'agent-launch': '🚀 בקשת הפעלת אפליקציית פיקוח',
        'broadcast-end':'📡 שיתוף מסך המורה הופסק',
      };
      addLog('info', `${labels[action]} → ${targetLabel(target)} (${count})`);
      return;
    }

    if (msg.type === 'toggle-auto-shots') {
      screenshotsEnabled = msg.enabled;
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
      expectedCount = parseInt(msg.count) || 0;
      sendToAdmin({ type: 'expected', count: expectedCount });
      addLog('info', `מספר תלמידים צפוי נקבע ל-${expectedCount}`);
      saveStudentFile();
      return;
    }

    if (msg.type === 'kick') {
      const id = parseInt(msg.id);
      const s  = students[id];
      if (s) {
        if (s.ws && s.ws.readyState === 1) { s.ws.send(JSON.stringify({ type: 'kicked' })); s.ws.close(); }
        delete students[id];
        sendToAdmin({ type: 'student-remove', id });
        addLog('warning', `🚫 ${s.name} הועף מהמערכת`);
        recordStudentEvent(s.name, 'הועף מהמערכת');
      }
      return;
    }

    // הוספת האזנה לעצירת שיתוף מסך
    if (msg.type === 'stop-share') {
      if (ws._studentId) {
        sendToAdmin({ type: 'stop-share', id: ws._studentId });
        const sname = students[ws._studentId] ? students[ws._studentId].name : 'תלמיד';
        recordStudentEvent(sname, 'הפסיק לשתף מסך');
      }
      return;
    }

    if (msg.type === 'student-join') {
      const name = (msg.name || '').trim();
      if (!name) return;

      const existing = Object.values(students).find(s => s.name === name);
      if (existing) {
        existing.ws = ws; existing.ip = ip; existing.lastSeen = Date.now();
        ws._studentId = existing.id;
        ws.send(JSON.stringify({ type: 'joined', id: existing.id, name }));
        addLog('reconnect', `${name} התחבר מחדש (${ip})`);
        recordStudent({ name, ip });
        recordStudentEvent(name, 'התחבר מחדש');
        sendToAdmin({ type: 'reconnect', student: { id: existing.id, name, ip, connectedAt: existing.connectedAt, resolution: existing.resolution, lastSeen: existing.lastSeen } });
      } else {
        const id = idCounter++;
        students[id] = { id, ws, name, ip, connectedAt: Date.now(), resolution: null, lastSeen: Date.now() };
        ws._studentId = id;
        ws.send(JSON.stringify({ type: 'joined', id, name }));
        addLog('join', `${name} התחבר (${ip})`);
        recordStudent({ name, ip, resolution: null });
        recordStudentEvent(name, 'התחבר');
        sendToAdmin({ type: 'student-join', student: getStudentList().find(s => s.id === id) });
        const connected = Object.values(students).filter(s => s.ws && s.ws.readyState === 1).length;
        if (expectedCount > 0 && connected > expectedCount) {
          addLog('warning', `⚠️ מחוברים יותר תלמידים מהצפוי! (${connected}/${expectedCount})`);
          sendToAdmin({ type: 'alert', message: `מחוברים יותר תלמידים מהצפוי! (${connected}/${expectedCount})` });
        }
      }
      return;
    }

    if (msg.type === 'resolution') {
      const id = ws._studentId;
      if (id && students[id]) {
        students[id].resolution = msg.resolution;
        students[id].lastSeen   = Date.now();
        students[id].mode = msg.mode || 'screen';
        sendToAdmin({ type: 'resolution', id, resolution: msg.resolution, mode: students[id].mode });
        const sname = students[id].name;
        if (persistentStudents[sname]) {
          persistentStudents[sname].resolution = msg.resolution;
          saveStudentFile();
        }
        if (msg.mode === 'camera') {
          addLog('info', `📷 ${sname} משתף ממצלמת טלפון`);
          recordStudentEvent(sname, 'שיתוף ממצלמת טלפון');
        } else if (msg.surfaceType && msg.surfaceType !== 'monitor') {
          addLog('warning', `⚠️ ${sname} משתף רק חלק מהמסך (סוג: ${msg.surfaceType})`);
          recordStudentEvent(sname, `שיתוף חלקי - סוג: ${msg.surfaceType}`);
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
      const kinds = {
        'tab-hidden':   `👁 ${sname} עזב את לשונית המבחן`,
        'tab-visible':  `👁 ${sname} חזר ללשונית המבחן`,
        'second-screen':`🖥️🖥️ ${sname} מחובר ליותר ממסך אחד`,
        'paste':        `📋 ${sname} הדביק טקסט (${msg.length || '?'} תווים)${msg.preview ? ': "'+msg.preview+'"' : ''}`,
        'copy':         `📋 ${sname} העתיק טקסט מהמבחן`,
        'lock-escape':  `🚪 ${sname} עזב את המסך הנעול`,
      };
      const text = kinds[msg.kind];
      if (!text) return;
      const isWarn = msg.kind !== 'tab-visible';
      addLog(isWarn ? 'warning' : 'info', text);
      recordStudentEvent(sname, text.replace(/^[^ ]+ /, ''));
      if (isWarn) sendToAdmin({ type: 'flag', id, kind: msg.kind, message: text });
      return;
    }

    if (['offer', 'answer', 'ice'].includes(msg.type)) {
      if (msg.target === 'admin') {
        sendToAdmin({ ...msg, from: ws._studentId });
      } else {
        const t = students[msg.target];
        if (t && t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify({ ...msg, from: ws._studentId }));
      }
    }
  });

  ws.on('close', () => {
    const id = ws._studentId;
    if (id && students[id] && students[id].ws === ws) {
      const name = students[id].name;
      students[id].ws = null;
      addLog('disconnect', `${name} התנתק`);
      recordStudentEvent(name, 'התנתק');
      sendToAdmin({ type: 'student-leave', id });
      const connected = Object.values(students).filter(s => s.ws && s.ws.readyState === 1).length;
      if (expectedCount > 0 && connected < expectedCount)
        sendToAdmin({ type: 'alert', message: `⚠️ ${name} התנתק! מחוברים ${connected}/${expectedCount}` });
    }
  });
});

setInterval(() => {
  Object.keys(students).forEach(id => {
    const s = students[id];
    if ((!s.ws || s.ws.readyState !== 1) && Date.now() - s.lastSeen > 5 * 60 * 1000) {
      delete students[id];
      sendToAdmin({ type: 'student-remove', id: parseInt(id) });
    }
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`\n✅ שרת פועל!`);
  console.log(`\n👨‍🏫 דף ניהול:   https://localhost:${PORT}/admin.html`);
  console.log(`\n🔐 סיסמת מורה:  ${ADMIN_PASSWORD}`);
  console.log(`\n👨‍🎓 לתלמידים:   https://<IP שלך>:${PORT}/student.html`);
  console.log(`\nCtrl+C לעצירה\n`);
});