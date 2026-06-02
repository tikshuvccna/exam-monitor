# Exam Monitor — Analysis, Review & Roadmap

> Generated 2026-06-02. Covers the `exam-monitor-2204` codebase: a Hebrew-language
> live exam-proctoring system (teacher watches students' screens over WebRTC).

---

## 1. What this project is

A LAN-based exam invigilation tool. Students open `student.html`, identify with their
full name, and share their **entire screen**. The teacher opens `admin.html` (password
protected) and sees every student's screen live in a grid, with logging, alerts,
screenshots, and CSV/log export.

### Components

| File | Role |
|------|------|
| [server.js](server.js) | HTTPS + WebSocket signalling server, TURN server, session auth, screenshot upload, logging, CSV/report export |
| [public/student.html](public/student.html) | Student client — join, share screen via `getDisplayMedia`, WebRTC offer, auto-screenshots, auto-reconnect |
| [public/admin.html](public/admin.html) | Teacher dashboard — live video grid, hover-zoom, popup, kick, manual screenshot, admin-screen recording, timer, exports |
| [public/index.html](public/index.html) | Landing page with two links |
| [scanner.py](scanner.py) | Offline OCR pass (OpenCV + EasyOCR) over saved screenshots → flags AI sites (Claude/ChatGPT) as `VIOLATION` |
| [scanner_gemini.py](scanner_gemini.py) | Alternate Gemini-based scanner |
| `logs/`, `screenshots/`, `exam_scan_log.csv` | Captured run data |

### Data flow

```
Student browser ──getDisplayMedia──▶ WebRTC P2P ──video──▶ Teacher browser
       │                                                         ▲
       └──WSS signalling (offer/ice)──▶ server.js ──signalling──┘
       └──POST /upload-screenshot (jpeg every 3s)──▶ screenshots/<date>/<name>/
                                                          │
                                          scanner.py (offline) ──▶ exam_scan_log.csv
```

WebRTC is **peer-to-peer**: the video never flows through `server.js`. The server only
relays signalling (SDP offer/answer + ICE) and runs a local TURN server (`node-turn` on
:3478) so media can traverse the LAN when direct connection fails.

---

## 2. Overall assessment

**The good.** This is a genuinely capable system for a single-file-per-page,
no-build-step project. The WebRTC mesh is correct, signalling is clean, auto-reconnect
works, the partial-share detection (`displaySurface !== 'monitor'`) is a smart anti-cheat
touch, and the per-session log/CSV files with a Hebrew summary block are practical for a
teacher. The offline OCR scanner is a clever second line of defence. The UI is polished.

**The shape of the risk.** Everything assumes a *cooperative LAN classroom*. As soon as
you start adding **remote control / screen-blocking / input-blocking** (your requested
features), the threat model flips: you are now building something that can take over a
machine, and the current security posture (hardcoded passwords, no per-student auth,
trust-the-client design) is not strong enough for that. Section 5 addresses this head-on.

---

## 2b. Fixes already applied (2026-06-02)

The following were fixed directly in the code:

- ✅ **Credentials moved out of source.** `server.js` now loads `config.json` (git-ignored)
  or `EXAM_*` env vars, falling back to defaults. Copy `config.example.json` →
  `config.json` and change the passwords. Added `.gitignore`.
- ✅ **Path-traversal guard** added (`isInside`) on both screenshot write paths.
- ✅ **admin.html interval leak** fixed — per-card duration timers are tracked in
  `cardTimers` and cleared on `student-remove`.
- ✅ **student.html ping stacking** fixed — `startPing` now guards a single `pingInterval`.
- ✅ **`disconnectCount` inconsistency** fixed — summary now uses exact-match like the rows.

Still recommended (not auto-applied — they change the join protocol, so they belong in a
planned commit): **per-student tokens**, **session TTL**, **auth on `/upload-screenshot`**.

---

## 3. Code review — issues & suggestions

Ordered roughly by importance. Severity: 🔴 fix soon · 🟡 should fix · 🟢 nice-to-have.

### Security

- 🔴 **Hardcoded credentials in source.** `ADMIN_PASSWORD = 'bandwidth'`, and TURN
  `examuser/exampass` are committed in [server.js:10-12](server.js#L10-L12). Anyone with
  the file (or the `.rar` backups) has the teacher password. Move to an env var / a
  git-ignored `config.json`, and generate the TURN password at startup.
- 🔴 **`/upload-screenshot` is unauthenticated** ([server.js:228](server.js#L228)). Any
  device on the LAN can POST arbitrary JPEGs under any `X-Student-Name` and create
  directories on disk. At minimum, tie uploads to a known WebSocket session/token.
- 🟡 **Students are identified by name only** — no token. A second person typing
  `"תלמיד 3"` is treated as a reconnect of the first and takes over their slot
  ([server.js:420-428](server.js#L420-L428)). Issue a per-student token on first join and
  require it on reconnect.
- 🟡 **Sessions never expire and live only in memory.** `sessions` is an in-process `Set`
  ([server.js:27](server.js#L27)) — fine for a single run, but tokens are valid forever
  until restart. Add a TTL.
- 🟡 **Filename sanitisation is the only path guard.** `safeStudentName` strips odd chars
  ([server.js:237](server.js#L237)) but the defence-in-depth move is to also verify the
  resolved path stays inside `screenshots/` before writing.
- 🟢 The login page is served over the same self-signed cert users must click through;
  document that clearly (the README already does).

### Correctness / bugs

- 🟡 **`updateStudentCard` leaks a `setInterval` per student that never clears**
  ([admin.html:473](public/admin.html#L473)). When a student is removed the card is
  deleted but the 1-second duration timer keeps firing forever (it just no-ops on a
  missing element). Over a long multi-class day this accumulates. Store the interval id
  and `clearInterval` on `student-remove`.
- 🟡 **`startPing` can stack intervals on reconnect** ([student.html:295](public/student.html#L295)).
  Every `joined` message calls `startPing()` again without clearing the previous one, so a
  student who reconnects N times sends N pings per tick. Guard with a single stored id.
- 🟡 **`disconnectCount` summary uses a stale label.** The CSV builder counts events whose
  text `includes('התנתק')` ([server.js:96](server.js#L96)) but per-row it filters
  `=== 'התנתק'` ([server.js:123](server.js#L123)). Pick one convention; the `includes`
  form will also match future strings like "התנתק זמנית".
- 🟢 **Two screenshot cadences exist:** client uploads every 3s
  ([student.html:288](public/student.html#L288)) but the OCR uses whatever landed. 3s ×
  many students × full-res JPEG is a lot of disk over an exam; consider 10–15s, or only
  upload on visual change.
- 🟢 **`log` array is capped at 500 in memory but the file grows unbounded** — intended,
  but note it for long sessions.

### Architecture / maintainability

- 🟡 **Three large HTML files with inline `<script>` and inline CSS.** It works, but the
  admin client is ~600 lines of logic in a `.html`. As you add the control features below,
  the message-handling `switch` will balloon. Consider extracting `admin.js` / `student.js`
  and a tiny shared `protocol.js` describing message types.
- 🟡 **No shared message-type constants.** Strings like `'toggle-auto-shots'`,
  `'request-offer'`, `'kicked'` are duplicated across client and server. One typo = a
  silent dead feature. A single `const MSG = {...}` shared file removes a whole class of
  bugs — and you'll add ~8 new message types for the control features.
- 🟢 **Magic numbers** (3000ms screenshots, 5-min stale cleanup, 500 log cap, ports) could
  live in one config block at the top of `server.js`.
- 🟢 **`node-turn@0.0.6`** is an old, lightly-maintained package. It works for LAN; just be
  aware if you ever expose this beyond the classroom you'd want `coturn`.

### UX

- 🟢 The admin header is getting crowded (7+ buttons). The new control features need a
  toolbar/menu grouping ("Monitor" vs "Control" modes) rather than more loose buttons.
- 🟢 Surface the OCR scanner results in the dashboard instead of only `exam_scan_log.csv`,
  so the teacher sees AI-site flags live-ish.

---

## 4. ⚠️ Read this before building the control features

You asked for: **(a) remote-control a student, (b) broadcast your screen to all,
(c) block the screen of all / selected students, (d) block keyboard & mouse.**

These split cleanly into **two tiers**, and the difference matters a lot:

| Feature | Can a browser do it? | Notes |
|---------|----------------------|-------|
| **(b) Show your screen to all** | ✅ **Yes, fully** | Pure WebRTC — same tech you already use, reversed direction. |
| **(c) Block screen** | ⚠️ **Browser-only: yes, but only covers the browser tab/fullscreen overlay** | A web page can show a fullscreen blocking overlay, but the student can Alt-Tab / close the tab. A *real* OS-level screen lock needs an agent (see below). |
| **(d) Block keyboard/mouse** | ⚠️ **Browser-only: only inside the tab** | JS can swallow keys/clicks within its own page, and Pointer/Keyboard Lock in fullscreen helps, but it **cannot** block the OS. Escape/Alt-Tab/Ctrl-Alt-Del always work. |
| **(a) Remote control** | ❌ **Not from a plain browser** | Moving the student's real mouse/keyboard requires running code outside the browser sandbox. |

### The core constraint

A web page **cannot** control the operating system, block OS input, or truly lock a
machine. The browser sandbox forbids it — by design, that's what keeps the web safe. So:

- Features **(b)** and a *soft* version of **(c)/(d)** (overlay + in-tab input swallowing,
  only meaningful while the student stays fullscreen) can be done **today, in the browser**,
  reusing your stack.
- Features **(a)** and *hard* **(c)/(d)** (real remote control, real screen lock, real
  input block) require a **native companion agent** on each student PC — a small
  background program (e.g. an Electron app, a Node/Python service, or a signed `.exe`)
  that the browser page talks to. This is a significant addition and has real security and
  consent implications (you're effectively shipping remote-admin software).

**My recommendation:** build the browser-only tier first (it covers most real classroom
needs and reuses everything you have), and treat the native agent as a deliberate Phase 2
with its own security design. The rest of this doc gives you concrete designs for both.

---

## 5. Feature designs

### Shared groundwork (do this first)

All four features are **teacher → student commands** plus, for some, a **student → teacher
media stream**. Add a small, uniform command channel over the existing WebSocket so you're
not inventing a new message type ad-hoc each time.

**1. Targeting.** Every control command carries a target:

```js
// teacher → server
{ type: 'control', action: 'lock-screen', target: 'all' }          // everyone
{ type: 'control', action: 'lock-screen', target: [3, 7, 12] }     // selected ids
{ type: 'control', action: 'lock-screen', target: 5 }              // one id
```

**2. Server fan-out.** One helper, used by every feature:

```js
function sendToStudents(target, payload) {
  const ids = target === 'all'
    ? Object.keys(students)
    : (Array.isArray(target) ? target : [target]).map(String);
  ids.forEach(id => {
    const s = students[id];
    if (s?.ws?.readyState === 1) s.ws.send(JSON.stringify(payload));
  });
}
```

**3. Selection in the UI.** Add a checkbox to each student card (and a "select all")
so the teacher can pick targets. This single UI addition powers (a), (c) and (d).

**4. Message-type constants.** Introduce `MSG` constants now (see §3) — you're about to add
~8 message types.

---

### Feature (b) — Broadcast teacher's screen to all  ✅ browser-only, easiest

This is your existing WebRTC pipeline **reversed**: the teacher becomes the sender, every
student becomes a receiver. Highest value-to-effort ratio — build it first.

**Teacher side (admin.html):**
1. Add a "📡 Broadcast my screen" button.
2. On click: `navigator.mediaDevices.getDisplayMedia(...)` (you already do this for
   recording — see [admin.html:361](public/admin.html#L361)).
3. For **each connected student**, create a `RTCPeerConnection`, add the broadcast track,
   create an offer, and send it tagged as a *broadcast* offer:
   `ws.send({ type:'offer', subtype:'broadcast', target:id, offer })`.

**Student side (student.html):**
1. Handle an incoming broadcast offer: create a peer connection, `setRemoteDescription`,
   answer back.
2. `ontrack` → drop the teacher's stream into a **fullscreen video overlay** ("המורה משתף
   מסך") that covers the page until the broadcast ends.

**Server:** your existing offer/answer/ice relay already handles this — just make sure the
`subtype` field is passed through (it will be, since you spread `...msg`).

**Effort:** Low. ~1 evening. Reuses 90% of existing code.

---

### Feature (c) — Block / freeze student screens  ⚠️ two versions

#### Soft (browser-only) — do this now
Send a command; the student page shows an **opaque fullscreen overlay** that eats all
input and optionally requests fullscreen + pointer lock.

```js
// teacher → students
sendToStudents(target, { type:'screen-lock', on:true, message:'המבחן הושהה' });
```

Student handler:
```js
if (msg.type === 'screen-lock') {
  if (msg.on) {
    showLockOverlay(msg.message);              // fixed, z-index:99999, covers all
    document.documentElement.requestFullscreen?.();
  } else hideLockOverlay();
}
```
**Limitation to communicate clearly:** this only holds while the student stays on the page.
Alt-Tab / closing the tab escapes it. You *can* detect the escape — listen for
`visibilitychange` / `blur` / `fullscreenchange` and fire an alert to the teacher
("⚠️ תלמיד X עזב את המסך הנעול"). That detection is genuinely useful even though the lock
isn't absolute.

#### Hard (native agent) — Phase 2
Real lock = the companion agent puts a topmost, always-on-top fullscreen window over the OS
and disables task-switching. Only an installed agent can do this. Same `screen-lock`
command, different executor.

**Effort:** Soft = Low. Hard = High (needs the agent, §6).

---

### Feature (d) — Block keyboard & mouse  ⚠️ two versions

#### Soft (browser-only) — do this now
Within the student tab you can swallow input:
```js
function blockInput(on) {
  if (on) {
    window.addEventListener('keydown',  swallow, true);
    window.addEventListener('keyup',    swallow, true);
    window.addEventListener('mousedown',swallow, true);
    window.addEventListener('contextmenu', swallow, true);
    document.body.requestPointerLock?.();
  } else { /* removeEventListener for each */ }
}
const swallow = e => { e.preventDefault(); e.stopPropagation(); };
```
Combine with the lock overlay from (c). **Hard limit:** the browser cannot block
`Alt+Tab`, `Ctrl+Alt+Del`, the Windows key, or closing the tab. It only governs input
*inside the focused tab*. Treat soft input-block as "discourage + detect", not "prevent".

#### Hard (native agent) — Phase 2
The agent uses an OS-level low-level input hook (Windows `SetWindowsHookEx`
`WH_KEYBOARD_LL`/`WH_MOUSE_LL`, or `BlockInput`) to genuinely freeze the machine. This is
powerful and intrusive — gate it behind explicit policy and visible student notice.

**Effort:** Soft = Low. Hard = High.

---

### Feature (a) — Remote control a student  ❌ needs native agent

A browser tab **cannot** move the real OS cursor or type into other apps. Full remote
control requires the companion agent. Architecture:

```
Teacher admin.html ──"control" stream (mouse/keyboard events as data)──▶ server.js
        ▲                                                                    │
        │ (student's screen via existing WebRTC video)                       ▼
   Student agent (native) ◀── relays events ── replays them on the OS (robotjs / pyautogui)
```

1. Teacher already sees the student screen (existing WebRTC). Overlay a transparent
   "control surface" `<div>` on that video; capture `mousemove`/`mousedown`/`keydown`,
   translate coordinates into the student's resolution (you already track `resolution`),
   and send them over a WebRTC **data channel** or the WebSocket:
   `{ type:'remote-input', target:id, event:{kind:'move', x, y} }`.
2. The **student agent** (not the browser) receives these and replays them on the OS via a
   library like `robotjs` (Node) or `pyautogui` (Python).
3. Require an explicit, per-session **consent + visible banner** on the student machine.

**Effort:** High — this is the flagship feature and depends entirely on §6.

---

## 5b. More feature ideas (beyond the four you requested)

Effort = rough size. Agent = needs the native companion (Phase 2); otherwise browser-only.

### Anti-cheat / detection — browser-only, high value
- **Live AI-site flagging in the dashboard** — surface `scanner.py` results live as a red
  badge on the student's card, not just in the CSV after the exam. *(Med, no agent)*
- **Tab-switch / focus-loss alerts** — alert the instant a student leaves the exam tab via
  `visibilitychange`/`blur`. Cheap, very effective. *(Low, no agent)*
- **Second-monitor detection** — `window.screen.isExtended` flags an extra screen the
  share might not cover. *(Low, no agent)*
- **Clipboard / large-paste monitoring** — log big pastes into the exam. *(Low, no agent)*
- **Periodic webcam liveness snapshot** (with consent) — a face photo every N minutes.
  *(Med, no agent)*

### Teacher workflow
- **Roster reconciliation** — paste a class list; dashboard shows missing students and
  unexpected names. *(Med, no agent)*
- **Private message / warning to one student** — push a banner ("חזור לשיתוף מסך מלא")
  without kicking. *(Low, no agent — and it's the same channel as the control features)*
- **Exam countdown broadcast** — the teacher's timer shows on every student screen with
  auto-warnings at 10/5/1 min. *(Low, no agent)*
- **Screenshot replay timeline** — scrub back through a student's captured screenshots.
  *(Med, no agent)*

### Robustness / ops
- **Session persistence across server restart** — currently all state is in-memory; a
  crash mid-exam loses everything. *(Med, no agent)*
- **Adaptive quality** — let the teacher drop frame rate when many students connect.
  *(Low, no agent)*
- **"Raise hand" button** — students request help silently. *(Low, no agent)*

**Quick wins to pair with Phase 1:** tab-switch alerts, second-monitor detection, private
warning message, and live AI-site flagging — all browser-only, all high signal, and the
private-message one reuses the exact `sendToStudents` fan-out the control features need.

---

## 6. The native companion agent (Phase 2 enabler for a, hard-c, hard-d)

To do *real* control/lock/input-block you need a small program installed on each student
PC. Options, cheapest-integration first:

| Approach | Pros | Cons |
|----------|------|------|
| **Electron app** wrapping the existing student page | Reuse all your HTML/JS; Electron's `globalShortcut`, `kiosk`/`fullscreen`, and Node access give OS hooks + `robotjs` | ~150 MB install; you ship & sign an app |
| **Node service + robotjs** alongside the browser | Lightweight, pure-Node, talks to your existing WSS | Native build toolchain; no UI of its own |
| **Python service + pyautogui/pynput** | Matches your `scanner.py` stack | Bundling into an `.exe` (PyInstaller); separate process from the browser |

**Recommended path:** an **Electron "exam client"** that *is* the student page in kiosk
mode. It eliminates the browser-escape problem (you control fullscreen, disable shortcuts),
gives you `robotjs` for remote control, and reuses your entire existing front-end. The
teacher dashboard can stay a normal browser page.

### "Auto-install with no download / no student steps" — what's actually possible

You asked: can the server send a command that auto-installs the companion app so students
don't have to download anything or do extra steps?

**The fully-silent, pushed-from-the-server version is impossible — by design.** A web page
that could silently install software on a visitor's machine *is* a remote-code-execution
exploit; browsers, Windows, and antivirus exist specifically to prevent it. There is no
API or flag for it, and anything claiming to do it would be flagged as malware. So "zero
download, zero steps, pushed from the server" cannot exist.

**But the real goal — don't make students do a long, confusing install — is achievable.**
Best options, in order:

| Approach | Student steps at exam time | Notes |
|----------|----------------------------|-------|
| **A. IT pre-deploys the agent** (MSI via Group Policy / Intune / school imaging) | **Zero** | The right answer for school-managed PCs. The agent is already there; students just open the page. This is how real proctoring software is deployed. |
| **B. Signed one-click installer** | Download once → double-click → "Yes" | Host `exam-client-setup.exe`; the student page shows a "Download exam client" button *only when no agent is detected*. After first install it's there forever. |
| **C. Protocol handler (`examclient://`)** | Click a link → "Open?" | Once installed (via A or B), the teacher **can** remote-*launch*/command the agent: the page opens `examclient://start` and Windows runs the already-installed program. This is the closest legitimate thing to "send a command to start it". |

**Detection so returning students skip everything:** the page tries to reach the local
agent (e.g. `fetch('http://127.0.0.1:7345/ping')` or a localhost WebSocket the agent
listens on).
- Agent answers → go straight into the exam, no prompt.
- No answer → show the download button (option B) or the install instructions.

So the honest model is **install once (ideally by IT), then remote-launch & command** —
the "start it from the dashboard" command you want is real; the "install from nothing"
command is not. Design the UX around (A)+(C): zero steps for managed PCs, one-time
double-click for everyone else.

### Non-negotiables for the agent
- **Consent & visibility.** A persistent on-screen banner whenever control/lock is active.
  Silent remote control of someone's machine is the line between "proctoring tool" and
  "spyware" — stay firmly on the right side, including for your own legal protection.
- **Strong auth.** Per-student tokens, a real shared secret for the agent↔server channel,
  not `exampass`.
- **Scope limit & kill switch.** Agent only runs during an exam, students can see it's
  running, and there's an obvious way to stop it.
- **Signed binary** so AV/SmartScreen don't quarantine it and so students can trust it.

---

## 7. Suggested roadmap

**Phase 0 — harden what exists (½–1 day)**
Move password & TURN creds out of source; auth `/upload-screenshot`; add per-student
tokens; fix the two interval leaks; add `MSG` constants + extract `admin.js`/`student.js`.

**Phase 1 — browser-only control tier (2–4 days)** *(covers most classroom needs)*
1. (b) Broadcast teacher screen to all. ← start here, biggest win
2. Student selection checkboxes + `sendToStudents` fan-out.
3. (c-soft) Lock overlay + escape detection/alerts.
4. (d-soft) In-tab input swallow + pointer lock.

**Phase 2 — native agent (larger project)**
5. Electron kiosk student client.
6. (c-hard) real OS screen lock, (d-hard) real input block.
7. (a) remote control via data channel + `robotjs`, with consent banner.

**Phase 3 — polish**
8. Surface OCR/AI-site flags live in the dashboard.
9. Toolbar grouping (Monitor / Control modes), per-student status badges.

---

## 8. One-line verdicts

- **Solid foundation, cooperative-LAN threat model.** Good WebRTC, good logging, nice UX.
- **Do Phase 0 before anything else** — you're about to add powerful features onto
  hardcoded-password auth.
- **Broadcast-to-all (b) is your quick win** — pure browser, reuses everything.
- **Screen-lock & input-block are "real" only with a native agent.** In the browser they're
  *discourage + detect*, which is still useful — just be honest with users about the limit.
- **Remote control (a) is a Phase-2, native-agent feature** with genuine consent/security
  weight. Build it deliberately, not as a quick toggle.
