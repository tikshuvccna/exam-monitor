@echo off
chcp 65001 >nul
title Exam Monitor Server
cd /d "%~dp0"

echo ============================================
echo            Exam Monitor Server
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed.
    echo Install from https://nodejs.org then run this file again.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [1/3] Installing packages... ^(first time only, may take a minute^)
    call npm install
    if errorlevel 1 ( echo [ERROR] npm install failed. & pause & exit /b 1 )
) else (
    echo [1/3] Packages already installed. OK
)

if not exist "cert.pem" (
    echo [2/3] Generating SSL certificate...
    node generateCert.js
) else (
    echo [2/3] SSL certificate exists. OK
)

REM --- One-time: let student PCs on the LAN reach the server (Windows asks for permission once) ---
netsh advfirewall firewall show rule name="Exam Monitor 4555 HTTP" >nul 2>nul
if errorlevel 1 (
    echo.
    echo ============================================================
    echo   FIRST RUN - one-time Windows firewall setup
    echo ============================================================
    echo   Windows blocks other computers from reaching this PC.
    echo   To let students connect, this program will now:
    echo     1. Open TCP 4555 ^(web^), TCP 80 ^(redirect http to https^) and UDP 3478 + relay ports ^(TURN^)
    echo     2. Remove old Windows rules that block Node.js, if any
    echo   Windows will ask for administrator permission - click Yes.
    echo   This happens only once. Nothing else is changed.
    echo ============================================================
    echo.
    pause
    call :open_firewall
    netsh advfirewall firewall show rule name="Exam Monitor 4555 HTTP" >nul 2>nul
    if errorlevel 1 (
        echo.
        echo The firewall was NOT opened ^(permission was denied^).
        echo Students cannot connect. Run this file again and click Yes.
        echo.
    ) else (
        echo Done - students on the same network can now connect.
        echo.
    )
)

REM --- Free port 4555 if a previous server is stuck on it ---
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4555" ^| findstr "LISTENING"') do (
    echo [info] Port 4555 was in use by PID %%p - closing old server...
    taskkill /F /PID %%p >nul 2>nul
)

echo [3/3] Starting server...
echo   The teacher and student links are printed below, in priority order:
echo   Wi-Fi first, then LAN, then hotspot, then anything else.
echo   ^(to stop: close this window or Ctrl+C^)
echo.

node server.js

echo.
echo Server stopped.
pause
exit /b 0

:open_firewall
REM kept outside the if-block so folder names containing ) or & do not break parsing
set "FWSCRIPT=%~dp0scripts\setup-firewall.ps1"
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$env:FWSCRIPT,'-Port','4555'"
goto :eof
