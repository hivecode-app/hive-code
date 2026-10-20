// QA sandbox, not a test: an hq on a temp dir with fake shifts and no Telegram/push, on 127.0.0.1:7499,
// with a question from the system (no options, with a link) and one from Yoav (with options).
// The app's web build talks to it through tool/qa/serve.mjs. Run: node packages/hq/test/qa-sandbox.mts
import { makeEnv } from './helpers.ts';
import { startApi } from '../src/api.ts';

const env = await makeEnv();
env.clock.now = Date.now;
const api = await startApi(env.hq, 'qa-admin-token', '127.0.0.1', Number(process.env.QA_PORT ?? 7499));
env.hq.mailbox.ask({
  msg_id: 'account-login-hive-owner-qa', from: 'hq',
  question: 'חיבור החשבון hive-owner לחברה, מתי שנוח לך.\n1. פותחים את הקישור ומתחברים כ-hive-owner.\n2. בסוף מופיע קוד. מדביקים אותו כאן כתשובה.\nhttps://example.com/oauth/authorize?code=true&state=qa',
});
env.hq.mailbox.ask({ msg_id: 'ask-yoav-qa', from: 'yoav', question: 'איזה לוגו? פרטים: https://example.com/logos', options: ['רצף', 'דלת'] });
const code = env.hq.auth.createPairCode({ kind: 'admin' });
console.log(`hq sandbox on ${api.port}; pair code ${code.code}`);
process.on('SIGTERM', async () => { await api.close(); await env.cleanup(); process.exit(0); });
