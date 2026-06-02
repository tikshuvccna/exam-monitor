# Exam Client — companion agent

Native companion app that unlocks the "real" (OS-level) versions of the control features.
A browser tab alone **cannot** lock the OS, block all input, or be remote-controlled — this
agent is what makes those possible. See `../ANALYSIS.md` §6 for the full rationale.

## What it does
- **Kiosk window** — runs the student page fullscreen, always-on-top, blocking Alt-Tab/Alt-F4
  and common shortcuts (`main.js → lockInput`). Eliminates the browser-escape problem.
- **Local detect server** on `127.0.0.1:7345` — the student web page does
  `fetch('http://127.0.0.1:7345/ping')`; if it answers, the page knows the agent is
  installed and skips the download prompt.
- **`examclient://` protocol** — once installed, the teacher's "🚀 הפעל אפליקציה" button
  makes the student page navigate to `examclient://start`, and Windows launches the
  already-installed agent. This is **Option C** (remote launch). It does **not** install
  anything — install happens once via the steps below.
- **`window.examAgent.lockInput(on)`** — the page calls this (via `preload.js`) to get real
  OS-level input blocking instead of the browser-only swallow.

## Build the installer (produces the .exe served by /download-agent — Option B)
```powershell
cd agent
npm install
npm run build      # → agent/dist/Exam Client Setup x.y.z.exe
```
The server's `/download-agent` route auto-serves whatever `.exe` lands in `agent/dist/`.

> ⚠️ Native build tools (a recent Node + Windows Build Tools) are required for
> `electron-builder`. The first `npm install` downloads Electron (~100 MB).

## Point it at your server
Set the exam URL before building, or via env at runtime:
```powershell
$env:EXAM_URL = "https://192.168.1.50:4555/student.html"; npm start
```
Default is `https://localhost:4555/student.html`.

## Making lock/input-block & remote control "real" (next step)
`main.js → lockInput()` currently blocks shortcuts via Electron `globalShortcut`. For a
**full** keyboard/mouse freeze and remote control, install a native input library and wire
it in (marked `TODO` in `main.js`):
```powershell
npm install @nut-tree/nut-js   # or: npm install robotjs
```
- `lockInput(true)` → engage a low-level input hook / `BlockInput`.
- Remote control → receive `{x,y,kind}` events from the teacher (over the existing WebSocket
  or a WebRTC data channel) and replay them with `mouse.setPosition` / `keyboard.type`.

## Security / consent — do not skip
- Show a **persistent visible banner** whenever lock/input-block/remote-control is active.
- **Sign the installer** (code-signing cert) so SmartScreen/Defender don't quarantine it and
  students can trust it.
- Use **per-student tokens** and a real shared secret for the agent↔server channel — not the
  default TURN/admin passwords.
- The agent should only run during an exam and have an obvious kill switch.

## Deployment (Option A — zero student steps)
For school-managed PCs, have IT push the built MSI/EXE once via Group Policy / Intune /
imaging. Then on exam day students just open the page (or the agent auto-launches) with
**no install step at all**. This is the recommended path for a managed lab.
