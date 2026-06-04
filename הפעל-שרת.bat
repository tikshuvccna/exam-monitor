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

REM --- שחרור פורט 4555 אם שרת קודם תקוע עליו ---
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4555" ^| findstr "LISTENING"') do (
    echo [מידע] פורט 4555 היה בשימוש ^(PID %%p^) - סוגר שרת קודם...
    taskkill /F /PID %%p >nul 2>nul
)

REM --- הצגת כתובת ה-IP לתלמידים ---
echo [3/3] מאתר את כתובת ה-IP שלך...
echo.
echo ============================================
echo   כתובות לתלמידים ^(העתק לתלמידים^):
echo ============================================
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set "ip=%%a"
    call :trim_and_print
)
echo.
echo   דף מורה ^(במחשב הזה^):  https://localhost:4555/admin.html
echo ============================================
echo   ^(אם קישור לא עובד, נסה אחר - בחר את הכתובת שבאותה
echo    רשת Wi-Fi/LAN כמו התלמידים.^)
echo.
echo מפעיל שרת... ^(לעצירה: סגור חלון זה או Ctrl+C^)
echo.

node server.js

echo.
echo השרת נעצר.
pause
exit /b 0

:trim_and_print
set "ip=%ip: =%"
echo   https://%ip%:4555/student.html
goto :eof
