import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const site = readFileSync(new URL('../deploy/caddy/agent-company.caddy', import.meta.url), 'utf8');
const publish = readFileSync(new URL('../packages/app/tool/qa/publish_qa.sh', import.meta.url), 'utf8');

test('reports receive an opaque-origin sandbox and CORS for their local assets', () => {
  const reports = site.slice(site.indexOf('\thandle /qa/* {'), site.indexOf('\n\thandle {', site.indexOf('\thandle /qa/* {')));
  assert.match(reports, /Content-Security-Policy "sandbox allow-scripts allow-popups"/);
  assert.match(reports, /Access-Control-Allow-Origin "\*"/);
  assert.match(reports, /Referrer-Policy "no-referrer"/);
  assert.doesNotMatch(site, /handle_path \/qa\/hq/);
});

test('the authenticated QA app has its own storage-capable route and API proxy', () => {
  assert.match(site, /handle_path \/qa-app\/hq\/\* \{\s+reverse_proxy 127\.0\.0\.1:7420/);
  const app = site.slice(site.indexOf('\thandle /qa-app/* {'), site.indexOf('\n\t# Reports'));
  assert.match(app, /file_server/);
  assert.doesNotMatch(app, /sandbox/);
});

test('publishing and removing a QA app cannot delete report directories', () => {
  assert.match(publish, /dest="\/var\/www\/hq-app\/qa-app"/);
  assert.match(publish, /--base-href "\/qa-app\/"/);
  assert.match(publish, /rsync -a --delete build\/web\/ "\$dest\/"/);
  assert.doesNotMatch(publish, /(?:dest=|--base-href )"[^"\n]*\/qa(?:\/|")/);
});

test('deploy cleanup and drift inspection preserve the QA app directory', async () => {
  const { execFileSync } = await import('node:child_process');
  for (const file of ['deploy.sh','drift-check.sh']) {
    const source = readFileSync(new URL(`./${file}`,import.meta.url),'utf8');
    const block = source.match(/case (?:"\$\(basename "\$x"\)"|"\$n") in current \| releases \| qa[^\n]*esac/)?.[0];
    assert.ok(block, `${file}: cleanup policy found`);
    // Only the policy runs. External writes are replaced by recording functions.
    const out = execFileSync('bash',['-c',`sudo() { echo delete; }; say() { :; }; d() { echo drift; }; x=qa-app; n=qa-app; ${block}`],{encoding:'utf8'});
    assert.equal(out,'',`${file} must preserve qa-app`);
  }
});
