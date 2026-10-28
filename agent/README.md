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
                   # On Windows without admin rights / Developer Mode, the code-signing tool fails with
                   # "Cannot create symbolic link". Build without signing instead:
                   #   set CSC_IDENTITY_AUTO_DISCOVERY=false
                   #   npx electron-builder --win nsis -c.win.signAndEditExecutable=false
```
The server's `/download-agent` route auto-serves whatever `.exe` lands in `agent/dist/`.

> ⚠️ Native build tools (a recent Node + Windows Build Tools) are required for
> `electron-builder`. The first `npm install` downloads Electron (~100 MB).

## Run it in dev
```powershell
cd agent
npm start
```
This opens the kiosk window pointed at `EXAM_URL`. Verified working: the detect
server answers `GET http://127.0.0.1:7345/ping` → `{"app":"exam-client","nativeInput":true}`.

> ⚠️ **If you see "יש להריץ דרך electron ולא node":** the env var
> `ELECTRON_RUN_AS_NODE=1` is set, which forces Electron into plain-Node mode.
> Unset it (`Remove-Item Env:\ELECTRON_RUN_AS_NODE`) and run again. Normal PCs
> don't have it set.

## Point it at your server (IMPORTANT)
On a **student** PC, `localhost` means the student's own machine — not the teacher's.
So the agent must be told the **teacher's IP**. There are three ways, in priority order:

1. **First-run prompt (default):** on first launch the app shows a "הגדרת שרת המבחן"
   screen. The student types the teacher's IP (e.g. `192.168.1.50`) — the app fills in
   the rest (`https://192.168.1.50:4555/student.html`) and **remembers it** for next time
   (saved in `%APPDATA%/exam-client/exam-config.json`).
2. **Env var (for testing / scripted deploy):**
   ```powershell
   $env:EXAM_URL = "https://192.168.1.50:4555/student.html"; npm start
   ```
3. **Pre-seed the config** during IT deployment by writing `exam-config.json`.

If the exam page fails to load, the app shows a friendly **error screen** with
**Retry / Change server / Exit** — the student is never trapped on a blank page.

## Lock / input-block
`setLock()` in `main.js` blocks common shortcuts via Electron `globalShortcut` and keeps the
kiosk window on top. While the screen is locked or the teacher is broadcasting their screen,
the exam site view is hidden so the lock/broadcast layer is visible. Remote control (robotjs)
was removed: nothing used it and it allowed typing on student PCs.

## Server certificate
The agent trusts the server's self-signed certificate by pinning its fingerprint on first
connect (stored in `exam-config.json`). If the teacher regenerates `cert.pem`, students must
use **Change server** on the error screen (or delete `exam-config.json`) to re-pin.

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
