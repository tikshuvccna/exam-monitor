מערכת פיקוח מבחן
=================

🚀 הדרך הקלה (מומלץ):
לחץ פעמיים על הקובץ  "הפעל-שרת.bat"  (או "start-server.bat").
הוא מתקין הכל אוטומטית, יוצר תעודה, ומפעיל את השרת -
וגם מציג את הכתובות לשלוח לתלמידים.

---

הפעלה ידנית (חלופה):
1. npm install
2. node generateCert.js   (פעם אחת בלבד - יוצר cert.pem ו-key.pem)
3. node server.js

הפעלה רגילה (אחרי הראשונה):
1. node server.js

קישורים:
- דף מורה:    https://localhost:4555/admin.html  (סיסמה: bandwidth)
- דף תלמיד:   https://<IP שלך>:4555/student.html

בכניסה ראשונה לדפדפן: לחץ Advanced ואז Proceed anyway

קבצי תיעוד (נשמרים אוטומטית):
- exam-log.json      - לוג כל האירועים
- exam-students.json - נתוני כל התלמידים

למציאת ה-IP שלך: ipconfig
