# מלון מלכת שבא — דשבורד ביקורות

דשבורד BI לניתוח ביקורות גוגל של מלון מלכת שבא באילת לאורך זמן: מגמת דירוג כללי,
תת-דירוגים (חדרים/שירות/מיקום), נפח ופילוח ביקורות יומי, זיהוי אוטומטי של נושאים
חוזרים (ניקיון, רעש, בריכה, אוכל, צוות ועוד) כדי להראות מה משתפר ומה לא, ופיד
ביקורות מלא עם טקסט וסינון.

**🔗 לינק חי:** https://itailironne.github.io/queen-of-sheba-reviews-dashboard/

## מבנה הפרויקט

| קובץ/תיקייה | מה זה |
|---|---|
| `reviews_dashboard.html` | הדשבורד עצמו — HTML עצמאי, קורא את `data/*.json` ב-fetch() |
| `data/reviews.json` | מאגר ביקורות גדל והולך (deduped by content hash) |
| `data/snapshots.json` | נקודת מדידה יומית — דירוג כללי, סה"כ ביקורות, דירוג Tripadvisor |
| `scripts/scrape-reviews.js` | Playwright — סורק את דף הביקורות שגוגל מארחת |
| `scripts/merge-and-build.js` | מפרסר, מתייג נושאים, וממזג לתוך `data/` |
| `scripts/lib/parse.js` | לוגיקת הפרסור/תיוג המשותפת |
| `scripts/update-dashboard.ps1` | נקודת הכניסה למשימה המתוזמנת היומית |
| `scripts/update-prompt.txt` | ההנחיות שה-agent היומי (`claude -p`) פועל לפיהן |
| `HANDOFF.md` | תיעוד טכני מלא — מנגנון הסקרייפינג, מגבלות ידועות, החלטות עיצוב |

## עדכון ידני

```
npm install
npm run update   # = scrape + merge
git add data/ && git commit -m "Manual update" && git push
```

## עדכון אוטומטי

משימה מתוזמנת ב-Windows (`QueenOfShebaReviewsAutoUpdate`) רצה יומית ומריצה את
`scripts\update-dashboard.ps1`, שמפעיל `claude -p` עם `scripts/update-prompt.txt`
כדי לסרוק, למזג, לוודא תקינות, ולדחוף. ראו `HANDOFF.md` לפרטים המלאים, כולל
המגבלה הידועה שגוגל טוענת רק כ-30 ביקורות אחרונות בכל ריצה (הפתרון: ריצה יומית +
דדופ בונים היסטוריה מלאה עם הזמן).
