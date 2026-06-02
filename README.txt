מערכת פיקוח מבחן
=================

הפעלה ראשונה:
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
