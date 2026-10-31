// Which of verify-prod's checks this install has (scripts/verify-prod.mjs). Every group of checks is declared with
// the setting that makes it relevant; one that is not runs as a skip with its reason, never as a failure. On hq-host
// every group runs. Pure: verify-prod passes in what it read (hq's config, the files).
import { join } from 'node:path';

/**
 * fromFile: $STATE/hq.config.json as written (null = none). cfg: the config hq runs with (loadConfig), for its defaults.
 * exists(path): fs.existsSync. Returns { <group>: { run: boolean, why?: string } }.
 */
export function verifyPlan({ fromFile, cfg, companyHome, engine, env = {}, apksigner, exists }) {
  const yes = { run: true };
  const no = (why) => ({ run: false, why });
  const rel = cfg.appReleaseDir;
  const apk = Boolean(rel) && exists(join(rel, 'app-release.json'));
  return {
    configInGit: exists(join(companyHome, 'company/hq.config.json')) ? yes
      : no(companyHome === engine ? 'COMPANY_HOME לא מוגדר, ואין חברה לקרוא ממנה את ההגדרות של hq' : 'ההגדרות של hq נכתבו בהתקנה, ואין company/hq.config.json בחברה'),
    dictation: cfg.dictate?.url ? yes : no('הכתבה לא מוגדרת (dictate.url)'),
    webApp: (rel && exists(join(rel, 'main.dart.js'))) || exists(join(engine, 'web/main.dart.js'))
      || exists(join(engine, 'packages/app/build/web/main.dart.js')) ? yes
      : no('אין בשרת הזה build של האפליקציה ל-web'),
    apk: apk ? yes : no(rel ? `אין שחרור של האפליקציה ב-${rel}` : 'אין שחרור של האפליקציה לאנדרואיד (appReleaseDir)'),
    apkSignature: !apk ? no('אין APK לבדוק') : exists(apksigner) ? yes : no(`אין apksigner בשרת הזה (${apksigner})`),
    tab: env.VERIFY_TAB_URL || fromFile?.tab?.baseUrl ? yes : no('מסירת טאב לא מוגדרת (tab.baseUrl)'),
  };
}
