# Hive Code: הלוגו

"אות בתוך תא": האות H של Hive, חצובה מתוך תא אחד בכוורת. רן בחר בה, בכחול של האפליקציה, ב-07/11/2026.

| קובץ | מה |
|---|---|
| `mark-light.svg` / `.png` | הסימן לבד, `#1F6FEB`, לרקע בהיר |
| `mark-dark.svg` / `.png` | הסימן לבד, `#7AAEFF`, לרקע כהה |
| `logo-light.svg` / `.png` | הסימן והשם (Heebo 700, הומר לקווים), לרקע בהיר |
| `logo-dark.svg` / `.png` | הסימן והשם, לרקע כהה |
| `app-icon.svg` / `.png` | האייקון: סימן לבן על ריבוע כחול |
| `github-avatar.png` | אווטאר ל-GitHub, ‏500×500. GitHub חותך את הפינות בעצמו |

**המקור הוא אחד:** הצורה מוגדרת ב-`packages/app/tool/make_icons.mjs`, שמייצר את האייקון לאנדרואיד (adaptive, כולל monochrome), ל-web, ל-favicon ול-PWA. את הקבצים כאן מייצר `make_brand.mjs`, מאותה הגדרה. משנים את הצורה רק שם, ומריצים את שניהם:

```
node packages/app/tool/make_icons.mjs
npm i --no-save opentype.js && node docs/brand/hive-code/make_brand.mjs
```

בראש README ב-GitHub, עם החלפה לפי מצב כהה:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/hive-code/logo-dark.svg">
  <img alt="Hive Code" src="docs/brand/hive-code/logo-light.svg" height="48">
</picture>
```
