// בדיקות עשן/אבטחה לשרת. מריץ עותק של השרת בתיקייה זמנית (לא נוגע בלוגים/צילומים/סיסמאות אמיתיים).
//   npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const PORT = 4600 + Math.floor(Math.random() * 300);
const TURN_PORT = PORT + 1000;
const REDIRECT_PORT = PORT + 2000;
const PASS = 'test-pass-' + crypto.randomBytes(3).toString('hex');
let tmp, proc, passed = 0, failed = 0;

function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra !== undefined ? '→ ' + extra : ''); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function setup() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exam-test-'));
  for (const f of ['server.js', 'generateCert.js']) fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'junction');
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ adminPassword: PASS, port: PORT, turnPort: TURN_PORT, turnPass: 'tp', httpRedirectPort: REDIRECT_PORT }));
  fs.writeFileSync(path.join(tmp, 'SECRET.txt'), 'top-secret-outside-public');
  execFileSync(process.execPath, ['generateCert.js'], { cwd: tmp, stdio: 'ignore' });
}

function startServer() {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, ['server.js'], { cwd: tmp, env: { ...process.env, EXAM_PORT: String(PORT) } });
    let out = '';
    proc.stdout.on('data', d => { out += d; if (out.includes('שרת פועל')) resolve(); });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', code => reject(new Error('server exited ' + code + '\n' + out)));
    setTimeout(() => reject(new Error('server start timeout\n' + out)), 15000);
  });
}

// בקשה גולמית - בלי נרמול נתיב של הלקוח (כך נבדק path traversal באמת)
function rawGet(rawPath, headers = {}) {
  return new Promise(resolve => {
    const sock = tls.connect({ host: '127.0.0.1', port: PORT, rejectUnauthorized: false }, () => {
      const h = Object.entries({ Host: 'localhost', Connection: 'close', ...headers }).map(([k, v]) => `${k}: ${v}`).join('\r\n');
      sock.write(`GET ${rawPath} HTTP/1.1\r\n${h}\r\n\r\n`);
    });
    let data = '';
    sock.on('data', d => data += d);
    sock.on('end', () => resolve({ status: parseInt(data.split(' ')[1]) || 0, body: data }));
    sock.on('error', () => resolve({ status: 0, body: '' }));
  });
}

function http(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: PORT, path: urlPath, method, rejectUnauthorized: false, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function login(pass) {
  const r = await http('POST', '/admin-login', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass }) });
  const cookie = (r.headers['set-cookie'] || [])[0];
  return { r, cookie: cookie ? cookie.split(';')[0] : null };
}

// לקוח WebSocket עם תור הודעות
function client(cookie) {
  const headers = cookie ? { Cookie: cookie } : {};
  const ws = new WebSocket(`wss://127.0.0.1:${PORT}`, { rejectUnauthorized: false, headers });
  const msgs = [];
  const waiters = [];
  ws.on('message', d => {
    let m; try { m = JSON.parse(d); } catch { return; }
    const i = waiters.findIndex(w => w.pred(m));
    if (i >= 0) { const [w] = waiters.splice(i, 1); w.res(m); } else msgs.push(m);
  });
  ws.on('error', () => {});
  const api = {
    ws, msgs,
    open: () => new Promise(r => ws.readyState === 1 ? r() : ws.once('open', r)),
    send: o => ws.send(JSON.stringify(o)),
    next: (pred, ms = 2000) => new Promise((res, rej) => {
      const i = msgs.findIndex(pred);
      if (i >= 0) return res(msgs.splice(i, 1)[0]);
      const w = { pred, res };
      waiters.push(w);
      setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); res(null); } }, ms);
    }),
    drain: () => { msgs.length = 0; },
    close: () => { try { ws.close(); } catch {} },
  };
  return api;
}
const type = t => m => m.type === t;

async function student(name, token) {
  const c = client();
  await c.open();
  c.send({ type: 'student-join', name, token, usingApp: true });
  const j = await c.next(m => m.type === 'joined' || m.type === 'name-taken' || m.type === 'kicked');
  return { c, j };
}

async function main() {
  setup();
  await startServer();
  console.log('server up on', PORT, '\n');

  // ── 1. Path traversal & admin page protection ────────────────
  console.log('Static files / path traversal');
  const traversal = ['/../SECRET.txt', '/..%2fSECRET.txt', '/%2e%2e/SECRET.txt', '/..\\SECRET.txt', '/..%5cSECRET.txt',
    '/../config.json', '/../key.pem', '/../server.js', '/%2e%2e%2f%2e%2e%2fSECRET.txt', '/public/../SECRET.txt', '//..//SECRET.txt'];
  for (const p of traversal) {
    const r = await rawGet(p);
    const leaked = r.body.includes('top-secret-outside-public') || r.body.includes(PASS) || r.body.includes('PRIVATE KEY') || r.body.includes('require(\'https\')');
    ok(!leaked && r.status !== 200, `blocked ${p}`, r.status);
  }
  for (const p of ['/admin.html', '/ADMIN.HTML', '/Admin.html', '/admin.html.', '/admin.html%20', '/admin.html::$DATA', '/admin.html?x', '/%61dmin.html', '/admin.html/']) {
    const r = await rawGet(p);
    const exposesAdmin = r.body.includes('toggleBroadcast');
    ok(!exposesAdmin, `admin page not exposed without login: ${p}`, r.status);
  }
  const idx = await http('GET', '/student.html');
  ok(idx.status === 200 && idx.body.includes('joinExam'), 'student.html served');

  // הפניה מ-HTTP ל-HTTPS: גם באותו פורט וגם בפורט ההפניה הנפרד
  const plainGet = (port, host) => new Promise(resolve => {
    const req = require('http').request({ host: '127.0.0.1', port, path: '/student.html?a=1', headers: { Host: host } }, res => { res.resume(); resolve(res); });
    req.on('error', e => resolve({ statusCode: 0, headers: {}, err: e }));
    req.end();
  });
  for (const [label, port] of [['same port', PORT], ['redirect port', REDIRECT_PORT]]) {
    const r = await plainGet(port, `192.168.1.5:${port}`);
    ok([302, 307].includes(r.statusCode) && r.headers.location === `https://192.168.1.5:${PORT}/student.html?a=1`, `plain http redirects to https (${label})`, r.statusCode + ' ' + r.headers.location);
  }
  const badHost = await plainGet(PORT, 'evil.com/<x>');
  ok(!(badHost.headers.location || '').includes('evil.com/<x>'), 'bad Host header is not reflected in redirect', badHost.headers.location);
  ok(!!idx.headers['content-security-policy'], 'CSP header on html');
  ok((await http('GET', '/download-report')).status === 403, 'report needs login');
  ok((await http('GET', '/download-log')).status === 403, 'log needs login');
  ok((await http('POST', '/manual-screenshot', { body: '{}' })).status === 403, 'manual screenshot needs login');

  // ── 2. Login ─────────────────────────────────────────────────
  console.log('\nLogin');
  const bad = await login('wrong');
  ok(!bad.cookie && JSON.parse(bad.r.body).ok === false, 'wrong password rejected');
  const good = await login(PASS);
  ok(!!good.cookie && /HttpOnly/i.test(good.r.headers['set-cookie'][0]), 'correct password gives HttpOnly cookie');
  const adminPage = await http('GET', '/admin.html', { headers: { Cookie: good.cookie } });
  ok(adminPage.body.includes('toggleBroadcast'), 'admin page served after login');
  ok((await http('GET', '/download-report', { headers: { Cookie: good.cookie } })).status === 200, 'report downloads with session');
  ok((await http('POST', '/admin-login', { body: 'not json' })).status === 400, 'bad login JSON → 400');

  // ── 3. WebSocket auth ────────────────────────────────────────
  console.log('\nWebSocket teacher auth');
  const anon = client(); await anon.open();
  anon.send({ type: 'admin-join' });
  ok(!!(await anon.next(type('auth-required'))), 'unauthenticated admin-join refused');
  ok(!(await anon.next(type('state'), 300)), 'no state leaked to unauthenticated client');
  anon.close();

  const admin = client(good.cookie); await admin.open();
  admin.send({ type: 'admin-join' });
  const st = await admin.next(type('state'));
  ok(!!st && Array.isArray(st.students), 'authenticated admin gets state');

  // ── 4. Students: join, token, name-taken, case/space normalization
  console.log('\nStudent identity');
  const a = await student('Dana  Levi');
  ok(a.j.type === 'joined' && a.j.token && a.j.name === 'Dana Levi', 'join normalizes spaces and returns token', JSON.stringify(a.j));
  const aid = a.j.id;
  const hijack = await student('dana levi');
  ok(hijack.j.type === 'name-taken', 'live name cannot be hijacked without token (case/space variant)');
  hijack.c.close();
  const xss = await student('<img src=x onerror=alert(1)> Evil One');
  ok(xss.j.type === 'joined' && !/[<>]/.test(xss.j.name), 'angle brackets stripped from names', xss.j.name);
  const back = await student('Dana Levi', a.j.token);
  ok(back.j.type === 'joined' && back.j.id === aid, 'reconnect with token keeps same id');
  a.c.close();
  ok(!!(await admin.next(m => m.type === 'student-join' && m.student.id === aid)), 'admin saw student join');

  // ── 5. Student cannot do teacher things ──────────────────────
  console.log('\nStudent privilege checks');
  const victim = await student('Victim Person');
  const attacker = await student('Attacker Person');
  admin.drain();
  attacker.c.send({ type: 'kick', id: victim.j.id });
  attacker.c.send({ type: 'toggle-auto-shots', enabled: true });
  attacker.c.send({ type: 'set-expected', count: 99 });
  attacker.c.send({ type: 'control', action: 'end-exam', target: 'all' });
  attacker.c.send({ type: 'unkick', name: 'x' });
  await sleep(300);
  ok(!(await victim.c.next(type('kicked'), 200)), 'student cannot kick another student');
  ok(!(await victim.c.next(type('end-exam'), 100)), 'student cannot send control commands');
  ok(!admin.msgs.some(m => m.type === 'expected' || m.type === 'auto-shots-status'), 'student cannot change settings');

  // ── ספירת תלמידים: צפוי / מחוברים / התנתקות ──────────────────
  console.log('\nStudent counting');
  {
    const a2 = client(good.cookie); await a2.open();
    a2.send({ type: 'admin-join' });
    const s0 = await a2.next(type('state'));
    const live0 = s0.students.filter(s => s.online).length;
    ok(s0.students.every(s => typeof s.online === 'boolean'), 'state lists online flag per student');

    a2.send({ type: 'set-expected', count: live0 + 1 });
    const e1 = await a2.next(type('expected'));
    ok(e1 && e1.count === live0 + 1, 'expected count is set and echoed', JSON.stringify(e1));

    const extra1 = await student('Count One'), extra2 = await student('Count Two');
    const over = await a2.next(m => m.type === 'alert' && /יותר תלמידים מהצפוי/.test(m.message));
    ok(!!over, 'alert when more students than expected connect');

    a2.drain();
    extra2.c.close();
    const left = await a2.next(m => m.type === 'student-leave' && m.id === extra2.j.id);
    ok(!!left, 'admin notified when a student disconnects');
    const st2 = await new Promise(async res => { const c3 = client(good.cookie); await c3.open(); c3.send({ type: 'admin-join' }); const s = await c3.next(type('state')); c3.close(); res(s); });
    ok(st2.students.filter(s => s.online).length === live0 + 1, 'live count drops by one after disconnect', `${st2.students.filter(s => s.online).length} vs ${live0 + 1}`);

    a2.send({ type: 'set-expected', count: live0 + 2 });
    await a2.next(type('expected'));
    a2.drain();
    extra1.c.close();
    const under = await a2.next(m => m.type === 'alert' && /מחוברים \d+\/\d+/.test(m.message));
    ok(!!under, 'alert when fewer students than expected are connected');

    a2.send({ type: 'set-expected', count: 0 });
    await a2.next(type('expected'));
    a2.close();
  }

  console.log('\nSignalling');
  victim.c.drain(); attacker.c.drain(); admin.drain();
  attacker.c.send({ type: 'offer', subtype: 'broadcast', target: victim.j.id, offer: { sdp: 'fake' } });
  attacker.c.send({ type: 'ice', target: victim.j.id, candidate: { c: 1 } });
  await sleep(200);
  ok(!victim.c.msgs.some(m => m.type === 'offer' || m.type === 'ice'), 'student cannot signal another student (fake broadcast blocked)');
  attacker.c.send({ type: 'offer', target: 'admin', offer: { sdp: 'real' } });
  const off = await admin.next(type('offer'));
  ok(!!off && off.from === attacker.j.id, 'student offer reaches teacher with sender id');
  admin.send({ type: 'offer', subtype: 'broadcast', target: victim.j.id, offer: { sdp: 'bc' } });
  const bc = await victim.c.next(type('offer'));
  ok(!!bc && bc.subtype === 'broadcast', 'teacher broadcast offer reaches student');

  // ── 6. Crash resistance ──────────────────────────────────────
  console.log('\nCrash resistance');
  const evil = client(); await evil.open();
  evil.ws.send('null'); evil.ws.send('123'); evil.ws.send('"str"'); evil.ws.send('[]'); evil.ws.send('{"type":5}');
  evil.send({ type: 'student-join', name: 12345 });
  evil.send({ type: 'student-join', name: { x: 1 } });
  evil.send({ type: 'unkick', name: 5 });
  evil.send({ type: 'event', kind: '__proto__' });
  evil.send({ type: 'event', kind: 'constructor' });
  evil.ws.send(Buffer.from([0xff, 0xfe, 0xfd]), { binary: false });
  await sleep(300);
  const r1 = await http('POST', '/upload-screenshot', { headers: { 'X-Student-Name': '%E0%A4%A' }, body: 'x' });
  ok(r1.status === 403, 'bad %-encoding header does not crash upload', r1.status);
  const huge = client(); await huge.open();
  huge.ws.on('close', () => {});
  try { huge.ws.send('{"type":"ping","pad":"' + 'a'.repeat(400000) + '"}'); } catch {}
  await sleep(300);
  ok((await http('GET', '/student.html')).status === 200, 'server still alive after malformed input');
  ok(huge.ws.readyState !== 1, 'oversized WebSocket frame rejected');
  evil.close(); huge.close();

  // ── 7. Control: lock state, select-all, per-student overrides ─
  console.log('\nControl & exam state');
  admin.send({ type: 'control', action: 'exam-url', target: 'all', url: 'javascript:alert(1)' });
  admin.send({ type: 'control', action: 'exam-url', target: 'all', url: 'file:///etc/passwd' });
  await sleep(150);
  const late0 = await student('Late Zero');
  ok(!(await late0.c.next(type('exam-url'), 300)), 'non-http exam URL rejected');
  late0.c.close();

  admin.send({ type: 'control', action: 'exam-url', target: 'all', url: 'https://example.com/form' });
  admin.send({ type: 'control', action: 'exam-links', target: 'all', links: [{ name: 'A', url: 'https://example.com/a' }, { name: 'bad', url: 'javascript:1' }] });
  admin.send({ type: 'control', action: 'countdown', target: 'all', on: true, durationMs: 10 * 60 * 1000 });
  const cd = await victim.c.next(type('countdown'));
  ok(cd && cd.remainingMs > 590000 && cd.remainingMs <= 600000 && cd.endsAt === undefined, 'countdown sends remaining time, not teacher clock', JSON.stringify(cd));
  const links = await victim.c.next(type('exam-links'));
  ok(links && links.links.length === 1, 'invalid links filtered');

  // "select all" sent as an id array must still be remembered as all
  const allIds = Object.values((await new Promise(r => { admin.drain(); admin.send({ type: 'admin-join' }); admin.next(type('state')).then(r); })).students).filter(s => s.online).map(s => s.id);
  admin.send({ type: 'control', action: 'screen-lock', target: allIds, on: true, message: 'locked!' });
  const lateA = await student('Late Alpha');
  const gotLock = await lateA.c.next(type('screen-lock'));
  ok(gotLock && gotLock.on && gotLock.message === 'locked!', 'lock sent to everyone (as id array) applies to latecomers');
  const gotCd = await lateA.c.next(type('countdown'));
  ok(gotCd && gotCd.remainingMs > 0, 'latecomer gets remaining countdown');
  const gotUrl = await lateA.c.next(type('exam-url'));
  ok(gotUrl && gotUrl.url === 'https://example.com/form', 'latecomer gets exam url');

  // unlock one student: their reconnect must stay unlocked, others stay locked
  admin.send({ type: 'control', action: 'screen-lock', target: [lateA.j.id], on: false });
  await sleep(150);
  lateA.c.close();
  const lateA2 = await student('Late Alpha', lateA.j.token);
  ok(!(await lateA2.c.next(type('screen-lock'), 400)), 'individually unlocked student stays unlocked after reconnect');
  const lateB = await student('Late Beta');
  ok(!!(await lateB.c.next(type('screen-lock'))), 'other newcomers are still locked');

  admin.send({ type: 'control', action: 'screen-lock', target: 'all', on: false });
  await sleep(150);
  const lateC = await student('Late Gamma');
  ok(!(await lateC.c.next(type('screen-lock'), 300)), 'unlock-all clears the lock for newcomers');

  // ── 8. Kick ──────────────────────────────────────────────────
  console.log('\nKick');
  admin.send({ type: 'kick', id: lateB.j.id });
  ok(!!(await lateB.c.next(type('kicked'))), 'kicked student is told');
  for (const variant of ['Late Beta', 'late beta', 'Late   Beta']) {
    const again = await student(variant);
    ok(again.j.type === 'kicked', `kick holds against rejoin as "${variant}"`);
    again.c.close();
  }
  admin.send({ type: 'unkick', name: 'late beta' });
  await sleep(150);
  const unk = await student('Late Beta');
  ok(unk.j.type === 'joined', 'unkick lets them back in');
  unk.c.close();

  // ── 9. Screenshots ───────────────────────────────────────────
  console.log('\nScreenshot upload');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
  const up = (name, token, body) => http('POST', '/upload-screenshot', { headers: { 'X-Student-Name': encodeURIComponent(name), 'X-Student-Token': token || '' }, body });
  ok((await up('Victim Person', '', jpeg)).status === 403, 'upload without token refused');
  ok((await up('Victim Person', 'f'.repeat(32), jpeg)).status === 403, 'upload with wrong token refused');
  ok((await up('Nobody Here', victim.j.token, jpeg)).status === 403, 'upload for unknown student refused');
  ok((await up('Victim Person', victim.j.token, jpeg)).status === 204, 'upload ignored while auto-shots are off');
  admin.send({ type: 'toggle-auto-shots', enabled: true });
  await sleep(150);
  ok((await up('Victim Person', victim.j.token, Buffer.from('not a jpeg'))).status === 400, 'non-JPEG rejected');
  const upOk = await up('Victim Person', victim.j.token, jpeg);
  ok(upOk.status === 200, 'valid upload accepted', upOk.status);
  await sleep(200);
  const shotsDir = path.join(tmp, 'screenshots');
  const saved = fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir, { recursive: true }).filter(f => String(f).endsWith('.jpg')) : [];
  ok(saved.length === 1 && String(saved[0]).includes('Victim Person'), 'screenshot saved in student folder', JSON.stringify(saved));
  const big = await up('Victim Person', victim.j.token, Buffer.alloc(7 * 1024 * 1024, 1)).catch(e => ({ status: e.code }));
  ok(big.status === 413 || big.status === 'ECONNRESET' || big.status === 'EPIPE', 'oversized upload rejected', big.status);
  admin.send({ type: 'toggle-auto-shots', enabled: false });

  // ── 10. Report CSV formula injection ─────────────────────────
  console.log('\nReport');
  const evilName = await student('=HYPERLINK("http://x") Boom');
  await sleep(1300);   // השמירה לקובץ מתעכבת עד שנייה
  const rep = await http('GET', '/download-report', { headers: { Cookie: good.cookie } });
  ok(rep.body.includes(`"'=HYPERLINK`) && !/(^|,)"=HYPERLINK/m.test(rep.body), 'CSV cell starting with = is neutralised');
  evilName.c.close();

  // ── 10b. Evidence, review, scoring, scanner alerts ───────────
  console.log('\nEvidence & review');
  const reviewOf = async name => {
    const r = await http('GET', '/review-data', { headers: { Cookie: good.cookie } });
    return JSON.parse(r.body).students.find(s => s.name === name);
  };
  const ev = (name, token, kind, body = jpeg) => http('POST', '/upload-screenshot', { headers: { 'X-Student-Name': encodeURIComponent(name), 'X-Student-Token': token, 'X-Evidence-Kind': kind }, body });
  ok((await http('GET', '/review-data')).status === 403, 'review data needs login');
  ok((await http('GET', '/shot?p=x')).status === 403, 'shot viewer needs login');

  victim.c.send({ type: 'event', kind: 'ai-ai-window', detail: 'ChatGPT - Google Chrome' });
  await sleep(200);
  admin.drain();
  ok((await ev('Victim Person', victim.j.token, 'ai-ai-window')).status === 200, 'evidence accepted even when auto-shots are off');
  ok((await ev('Victim Person', victim.j.token, 'bogus-kind')).status === 400, 'unknown evidence kind rejected');
  ok((await ev('Victim Person', victim.j.token, 'ai-ai-window')).status === 204, 'evidence burst rate-limited');
  ok((await ev('Victim Person', 'f'.repeat(32), 'ai-ai-window')).status === 403, 'evidence needs the student token');
  let rv = await reviewOf('Victim Person');
  const aiEv = rv && rv.events.filter(e => e.kind === 'ai-ai-window');
  ok(aiEv && aiEv.length === 1 && aiEv[0].shots && aiEv[0].shots.length === 1, 'evidence attached to the flag event', JSON.stringify(aiEv));
  ok(rv && rv.score >= 10 && rv.level === 'medium', 'AI window gives a medium score', rv && rv.score + '/' + rv.level);

  const shot = await http('GET', '/shot?p=' + encodeURIComponent(aiEv[0].shots[0]), { headers: { Cookie: good.cookie } });
  ok(shot.status === 200 && shot.headers['content-type'] === 'image/jpeg', 'teacher can view the evidence image');
  for (const bad of ['../../config.json', '2026-01-01/../../server.js', '2026-01-01/x/..%2f..%2fconfig.json', 'a/b/c.jpg', '2026-01-01/x/y.html']) {
    const r = await http('GET', '/shot?p=' + encodeURIComponent(bad), { headers: { Cookie: good.cookie } });
    ok(r.status === 404 && !r.body.includes(PASS), `shot viewer rejects ${bad}`, r.status);
  }

  // an event flagged in the browser (paste) and its evidence merge into one timeline entry
  victim.c.send({ type: 'event', kind: 'paste', length: 50, preview: '<b>x</b>' });
  await sleep(150);
  await ev('Victim Person', victim.j.token, 'paste');
  rv = await reviewOf('Victim Person');
  const pasteEv = rv.events.filter(e => e.kind === 'paste');
  ok(pasteEv.length === 1 && pasteEv[0].shots && pasteEv[0].shots.length === 1, 'paste flag + evidence merged into one entry');

  // scoring: browser-only students get the extra points; counts are capped
  const web = client(); await web.open();
  web.send({ type: 'student-join', name: 'Browser Only', usingApp: false });
  const wj = await web.next(type('joined'));
  for (let i = 0; i < 12; i++) web.send({ type: 'event', kind: 'tab-hidden' });
  await sleep(300);
  const wrv = await reviewOf('Browser Only');
  ok(wrv && wrv.score === 5 + 5, 'score = browser-only 5 + tab-hidden capped at 5', wrv && wrv.score);
  ok(rv.score > wrv.score || rv.level !== 'low', 'AI flag outranks noisy tab switching');
  const order = JSON.parse((await http('GET', '/review-data', { headers: { Cookie: good.cookie } })).body).students.map(s => s.score);
  ok(order.every((v, i) => i === 0 || order[i - 1] >= v), 'review list sorted by score');

  // scanner alerts
  const cfg = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
  ok(typeof cfg.scannerKey === 'string' && cfg.scannerKey.length >= 16, 'scannerKey generated into config.json');
  const alertReq = (b) => http('POST', '/scan-alert', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  ok((await alertReq({ key: 'nope', student: 'Victim Person', ai: ['x'] })).status === 403, 'scan-alert refuses a wrong key');
  ok((await alertReq({ key: cfg.scannerKey, student: 'Nobody Real', ai: ['x'] })).status === 404, 'scan-alert refuses unknown student');
  admin.drain();
  const sa = await alertReq({ key: cfg.scannerKey, student: 'Victim Person', ai: ['chatgpt'], blocked: [], file: aiEv[0].shots[0] });
  ok(sa.status === 200, 'scan-alert accepted');
  ok(!!(await admin.next(m => m.type === 'flag' && m.kind === 'scan-ai')), 'teacher gets a live flag from the scanner');
  rv = await reviewOf('Victim Person');
  ok(rv.counts['scan-ai'] === 1 && rv.events.some(e => e.kind === 'scan-ai' && e.shots), 'scanner finding stored with its screenshot');
  ok(rv.level === 'high', 'AI window + scanner hit = high suspicion', rv.score);

  // live scanner script end-to-end (needs Python; skipped if not installed)
  const py = ['python', 'python3', 'py'].find(c => { try { execFileSync(c, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } });
  if (py) {
    let out = '';
    try {
      out = execFileSync(py, [path.join(__dirname, 'test_watch.py'), `https://127.0.0.1:${PORT}`, cfg.scannerKey, path.join(tmp, 'screenshots'), 'Victim Person'], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    } catch (e) { out = (e.stdout || '') + (e.stderr || ''); }
    ok(/0 failed/.test(out), 'scanner_watch posts real alerts (python e2e)', out.slice(-300));
    await sleep(300);
    rv = await reviewOf('Victim Person');
    ok(rv.counts['scan-ai'] === 2, 'alert from the Python watcher reached the review list', JSON.stringify(rv.counts));
  } else console.log('  - python not found, skipping scanner e2e');

  // server info for the teacher's "copy student link" button
  ok((await http('GET', '/server-info')).status === 403, 'server-info needs login');
  const si = JSON.parse((await http('GET', '/server-info', { headers: { Cookie: good.cookie } })).body);
  ok(si.port === PORT && Array.isArray(si.studentUrls) && si.studentUrls.every(u => u.startsWith('https://') && u.endsWith(`:${PORT}/student.html`)), 'server-info lists student URLs', JSON.stringify(si));

  // report carries suspicion columns
  const rep2 = await http('GET', '/download-report', { headers: { Cookie: good.cookie } });
  ok(rep2.body.includes('ציון חשד') && rep2.body.includes('צילומי ראיה'), 'CSV report has suspicion score columns');
  web.close();

  // ── 11. Login throttling (last: it blocks this IP for a minute) ─
  console.log('\nLogin throttling');
  let blocked = false;
  for (let i = 0; i < 8; i++) { const r = await login('bad' + i); if (r.r.status === 429) blocked = true; }
  ok(blocked, 'repeated wrong passwords get throttled (429)');
  ok((await login(PASS)).r.status === 429, 'even the right password waits out the block');

  // ── 12. Graceful cleanup / logout ────────────────────────────
  const lo = await http('GET', '/admin-logout', { headers: { Cookie: good.cookie } });
  ok(lo.status === 302, 'logout redirects');
  ok((await http('GET', '/download-report', { headers: { Cookie: good.cookie } })).status === 403, 'session invalid after logout');
}

main().catch(e => { failed++; console.error('\nTEST HARNESS ERROR:', e.message); })
  .finally(() => {
    try { proc && proc.kill(); } catch {}
    setTimeout(() => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      console.log(`\n${passed} passed, ${failed} failed`);
      process.exit(failed ? 1 : 0);
    }, 300);
  });
