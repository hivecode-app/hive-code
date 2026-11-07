import type { InboxItemDTO } from '@company/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export type OwnerLanguage = 'en' | 'he';
export function productPreferences(companyDir: string): { owner_language: OwnerLanguage } {
  try {
    const org = parse(readFileSync(join(companyDir, 'org.yaml'), 'utf8')) as Record<string, unknown> | null;
    return { owner_language: org?.owner_language === 'he' ? 'he' : 'en' };
  } catch { return { owner_language: 'en' }; }
}

export const systemCopy = {
  done: { en: 'Done: {title}', he: 'הסתיים: {title}' },
  started: { en: 'Work started', he: 'העבודה התחילה' },
  resumed: { en: 'Work resumed', he: 'העבודה נמשכת' },
  stopped: { en: 'Work stopped', he: 'העבודה נעצרה' },
  waiting: { en: 'Waiting for your answer', he: 'מחכה לתשובה שלך' },
  offline: { en: 'No connection to the server', he: 'אין חיבור לשרת' },
  release: { en: 'Release {title}?', he: 'לשחרר את {title}?' },
  approval: { en: 'Approve this action?', he: 'לאשר את הפעולה?' },
  question: { en: 'Question for you', he: 'שאלה אליך' },
  signin: { en: 'Sign-in needed', he: 'נדרשת כניסה' },
  approve: { en: 'Approve {title}?', he: 'לאשר את {title}?' },
} as const;

export function systemText(key: keyof typeof systemCopy, language: OwnerLanguage, title = ''): string {
  return systemCopy[key][language].replace('{title}', title);
}

/** System notification chrome follows the server language; worker-written content stays intact. */
export function notificationTitle(item: Pick<InboxItemDTO, 'kind' | 'title' | 'headline'> & { action?: string | null }, language: OwnerLanguage): string {
  if (item.kind === 'go') {
    const subject = item.headline?.trim();
    if (!subject) return systemText('approval', language);
    if (/[?؟]$/.test(subject)) return subject;
    return systemText(item.action === 'release' ? 'release' : 'approve', language, subject);
  }
  if (item.kind === 'ask') return item.headline?.trim() || systemText('question', language);
  if (item.kind === 'login') return systemText('signin', language);
  return item.title;
}
