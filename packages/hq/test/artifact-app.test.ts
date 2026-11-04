import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv } from './helpers.ts';
import { ARTIFACT_LINK_TTL, ARTIFACT_TTL } from '../src/artifacts.ts';

test('artifact app metadata is structured; version access renews independently of newer versions', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    await env.hq.start({ listen: true, timers: false });
    const auth = { authorization: `Bearer ${readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim()}`, 'content-type':'application/json' };
    const base = `http://127.0.0.1:${env.hq.port}`;
    const first=env.hq.artifacts.stage('eli',{html:'<p>one</p>',title:'First title'},'app-show-1'); await env.hq.artifacts.finish(first.id,first.version);
    const second=env.hq.artifacts.stage('eli',{id:first.id,html:'<p>two</p>',title:'Second title',note:'Second version'},'app-show-2'); await env.hq.artifacts.finish(second.id,second.version);
    const get=(path:string)=>fetch(base+path,{headers:auth});
    const post=(path:string,body:unknown)=>fetch(base+path,{method:'POST',headers:auth,body:JSON.stringify(body)});
    const infoResponse=await get(`/api/artifacts/${first.id}`);assert.equal(infoResponse.status,200);
    const info=(await infoResponse.json() as any).artifact;
    assert.equal(info.latest,2);assert.deepEqual(info.versions.map((v:any)=>v.version),[2,1]);
    assert.ok(!JSON.stringify(info).includes(env.cfg.stateDir),'no local paths in the DTO');
    const card=env.hq.mailbox.get(`artifact-${first.id}`)!;assert.equal(card.artifact?.latest,2);
    const opened=await (await post(`/api/artifacts/${first.id}/open`,{version:1})).json() as any;
    assert.equal(opened.version,1);assert.equal(opened.access_expires_at,env.clock.t+ARTIFACT_LINK_TTL);
    assert.match(await (await get(new URL(opened.url).pathname)).text(),/one/);
    const apps=await (await get('/api/files?kind=apps&chat=eli')).json() as any;
    assert.equal(apps.files.length,1);assert.equal(apps.files[0].artifact.latest,2);
    env.clock.advance(ARTIFACT_LINK_TTL+1);
    assert.equal((await get(new URL(opened.url).pathname)).status,403);
    const renewed=await (await post(`/api/artifacts/${first.id}/open`,{version:1})).json() as any;
    assert.match(await (await get(new URL(renewed.url).pathname)).text(),/one/);
    assert.equal((await post(`/api/artifacts/${first.id}/keep`,{keep:true})).status,200);
    assert.equal((await (await get(`/api/artifacts/${first.id}`)).json() as any).artifact.pinned,true);
  } finally { await env.cleanup(); }
});

test('removed or expired content keeps its card and cannot report a successful keep', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    await env.hq.start({ listen: true, timers: false });
    const auth = { authorization: `Bearer ${readFileSync(join(env.cfg.stateDir,'api-token'),'utf8').trim()}` };
    const base=`http://127.0.0.1:${env.hq.port}`;
    const shown=env.hq.artifacts.stage('eli',{html:'<p>content</p>',title:'Remains as a card'},'removed-app');await env.hq.artifacts.finish(shown.id,shown.version);
    rmSync(env.hq.artifacts.version(shown.id,1)!.path,{recursive:true,force:true});
    assert.equal((await fetch(`${base}/api/artifacts/${shown.id}/open`,{method:'POST',headers:auth,body:'{"version":1}'})).status,410);
    env.clock.advance(ARTIFACT_TTL+1);env.hq.artifacts.sweep();
    const info=await (await fetch(`${base}/api/artifacts/${shown.id}`,{headers:auth})).json() as any;
    assert.equal(info.artifact.expired,true);assert.equal(env.hq.mailbox.get(`artifact-${shown.id}`)?.artifact?.title,'Remains as a card');
    assert.equal((await fetch(`${base}/api/artifacts/${shown.id}/keep`,{method:'POST',headers:auth,body:'{"keep":true}'})).status,410);
    assert.equal(env.hq.artifacts.get(shown.id)!.pinned,0);
  } finally { await env.cleanup(); }
});
