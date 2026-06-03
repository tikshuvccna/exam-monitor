@echo off
chcp 65001 >nul
title שרת פיקוח מבחן
cd /d "%~dp0"

echo ============================================
echo            שרת פיקוח מבחן
echo ============================================
echo.

REM --- בדיקה ש-Node מותקן ---
where node >nul 2>nul
if errorlevel 1 (
    echo [שגיאה] Node.js לא מותקן.
    echo התקן מ: https://nodejs.org  ואז הפעל קובץ זה שוב.
    echo.
    pause
    exit /b 1
)

REM --- התקנת חבילות בפעם הראשונה ---
if not exist "node_modules" (
    echo [1/3] מתקין חבילות... ^(פעם ראשונה בלבד, עשוי לקחת דקה^)
    call npm install
    if errorlevel 1 (
        echo [שגיאה] התקנת החבילות נכשלה.
        pause
        exit /b 1
    )
) else (
    echo [1/3] חבילות כבר מותקנות. ✓
)

REM --- יצירת תעודת SSL בפעם הראשונה ---
if not exist "cert.pem" (
    echo [2/3] יוצר תעודת אבטחה...
    node generateCert.js
) else (
    echo [2/3] תעודת אבטחה קיימת. ✓
)

REM --- הצגת כתובת ה-IP לתלמידים ---
echo [3/3] מאתר את כתובת ה-IP שלך...
echo.
echo ============================================
echo   כתובות לתלמידים ^(העתק לתלמידים^):
echo ============================================
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    echo   https://%%a:4555/student.html
)
echo.
echo   דף מורה ^(במחשב הזה^):  https://localhost:4555/admin.html
echo ============================================
echo.
echo מפעיל שרת... ^(לעצירה: סגור חלון זה או Ctrl+C^)
echo.

node server.js

echo.
echo השרת נעצר.
pause
