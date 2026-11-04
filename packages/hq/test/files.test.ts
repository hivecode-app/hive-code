import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv } from './helpers.ts';

test('files API authenticates, filters conversations and kinds, and excludes internal mail', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    await env.hq.start({ listen: true, timers: false });
    const auth = { authorization: `Bearer ${readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim()}` };
    const base = `http://127.0.0.1:${env.hq.port}`;
    assert.equal((await fetch(`${base}/api/files`)).status, 401);
    const pdf = env.hq.uploads.save(Buffer.from('%PDF-1.4\nexample'), 'very long file name.pdf');
    const other = env.hq.uploads.save(Buffer.from('unknown'), 'sample.xyz');
    env.hq.mailbox.tell({ msg_id: 'owner-pdf', from: 'owner', to: 'dana', body: 'read'.repeat(100), attachments: [pdf.id] });
    env.hq.mailbox.tell({ msg_id: 'worker-file', from: 'dana', to: 'owner', body: 'result', attachments: [other.id] });
    env.hq.mailbox.tell({ msg_id: 'internal-file', from: 'dana', to: 'yoav', body: 'internal', attachments: [other.id] });
    const call = async (query = '') => { const r = await fetch(`${base}/api/files${query}`, { headers: auth }); assert.equal(r.status, 200); return await r.json() as any; };
    const all = await call('?chat=dana');
    assert.equal(all.files.length, 2);
    assert.ok(all.files.every((f: any) => f.chat === 'dana' && !('path' in f)));
    const documents = (await call('?kind=documents')).files;
    assert.deepEqual(documents.map((f: any) => f.id), [pdf.id]);
    assert.equal(documents[0].caption, 'read'.repeat(60));
    assert.ok(all.files.every((f: any) => f.caption !== 'internal'));
    assert.deepEqual((await call('?chat=yoav')).files, []);
    assert.deepEqual((await call('?task=99999')).files, []);
    assert.equal((await fetch(`${base}/api/files?kind=invalid`, { headers: auth })).status, 400);
  } finally { await env.cleanup(); }
});

test('derived preview API exposes only the prepared PDF and archive manifest entries', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    await env.hq.start({ listen: true, timers: false });
    const auth = { authorization: `Bearer ${readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim()}` };
    const base = `http://127.0.0.1:${env.hq.port}`;
    const a = env.hq.uploads.save(Buffer.from('office'), 'test.xyz');
    const upload = env.hq.uploads.get(a.id)!;
    await env.hq.uploads.prepare(a.id);
    const dir = `${upload.path}.d`; mkdirSync(join(dir, 'files'), { recursive: true });
    const manifest = join(dir, 'manifest.txt'), preview = join(dir, 'document.pdf');
    writeFileSync(manifest, 'a.txt\n'); writeFileSync(join(dir, 'files', 'a.txt'), 'archive entry'); writeFileSync(preview, '%PDF-1.4\npreview');
    env.hq.store.db.prepare('UPDATE uploads SET meta=? WHERE id=?').run(JSON.stringify({ readable: [manifest, join(dir, 'files'), preview], files: 1 }), a.id);
    const get = (suffix: string) => fetch(`${base}/api/uploads/${a.id}/${suffix}`, { headers: auth });
    assert.deepEqual(await (await get('entries')).json(), { entries: ['a.txt'] });
    assert.equal(await (await get('entry?name=a.txt')).text(), 'archive entry');
    assert.equal((await get('entry?name=../document.pdf')).status, 404);
    assert.equal(await (await get('preview')).text(), '%PDF-1.4\npreview');
  } finally { await env.cleanup(); }
});

test('authenticated original supports bounded byte ranges for native video seeking',async()=>{
  const env=await makeEnv({noStart:true});
  try{
    await env.hq.start({listen:true,timers:false});
    const auth={authorization:`Bearer ${readFileSync(join(env.cfg.stateDir,'api-token'),'utf8').trim()}`};
    const upload=env.hq.uploads.save(Buffer.from('0123456789'),'clip.xyz');
    const url=`http://127.0.0.1:${env.hq.port}/api/uploads/${upload.id}`;
    const response=await fetch(url,{headers:{...auth,range:'bytes=2-5'}});
    assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 2-5/10');assert.equal(await response.text(),'2345');
    const tail=await fetch(url,{headers:{...auth,range:'bytes=-3'}});assert.equal(await tail.text(),'789');
    assert.equal((await fetch(url,{headers:{...auth,range:'bytes=90-99'}})).status,416);
    assert.equal((await fetch(url,{headers:{range:'bytes=0-1'}})).status,401);
  }finally{await env.cleanup();}
});

test('task filters keep historical shift boundaries, stable artifact ownership and pagination',async()=>{
  const env=await makeEnv({noStart:true});
  try {
    const {hq,clock}=env;await hq.start({listen:true,timers:false});hq.store.setToggle('scheduler',false);
    const auth={authorization:`Bearer ${readFileSync(join(env.cfg.stateDir,'api-token'),'utf8').trim()}`},base=`http://127.0.0.1:${hq.port}`;
    const call=async(q:string)=>{const response=await fetch(`${base}/api/files${q}`,{headers:auth});assert.equal(response.status,200);return await response.json() as any;};
    const old=hq.scheduler.addTask({title:'Previous task',state:'running',identity:'eli'}),start=clock.t;
    hq.store.db.prepare('INSERT INTO shifts(id,identity,shift_no,state,task_id,started_at,ended_at) VALUES (?,?,?,?,?,?,?)').run('eli-old','eli',1,'ended',old.id,start-1,start+10);
    const pdf=hq.uploads.save(Buffer.from('%PDF-1.4\nfixture'),'report.pdf');
    const tell=(id:string,upload:string)=>hq.mailbox.tell({msg_id:id,from:'eli',to:'owner',body:id,attachments:[upload]});
    tell('old-file',pdf.id);
    const oldApp=hq.artifacts.stage('eli',{html:'<p>First task</p>',title:'Persistent task'},'old-task-show');await hq.artifacts.finish(oldApp.id,1);
    clock.advance(10);tell('at-end',pdf.id);
    clock.advance(1);tell('between-shifts',pdf.id);
    hq.store.db.prepare('UPDATE tasks SET state=? WHERE id=?').run('done',old.id);
    const current=hq.scheduler.addTask({title:'Current task',state:'running',identity:'eli'});
    hq.store.db.prepare('INSERT INTO shifts(id,identity,shift_no,state,task_id,started_at) VALUES (?,?,?,?,?,?)').run('eli-new','eli',2,'live',current.id,start+20);
    clock.advance(9);tell('new-file',pdf.id);
    const update=hq.artifacts.stage('eli',{id:oldApp.id,html:'<p>Updated during the next task</p>',title:'Persistent task'},'old-task-update');await hq.artifacts.finish(update.id,update.version);
    const newApp=hq.artifacts.stage('eli',{html:'<p>New task</p>',title:'Current task app'},'new-task-show');await hq.artifacts.finish(newApp.id,1);
    const first=await call(`?task=${old.id}`),second=await call(`?task=${current.id}`);
    assert.deepEqual(new Set(first.files.map((f:any)=>f.message)),new Set(['old-file','at-end',`artifact-${oldApp.id}`]));
    assert.deepEqual(new Set(second.files.map((f:any)=>f.message)),new Set(['new-file',`artifact-${newApp.id}`]));
    assert.ok((await call('?chat=eli')).files.some((f:any)=>f.message==='between-shifts'&&f.task===null));
    const upload=hq.uploads.save(Buffer.from('archive source'),'log.xyz');
    for(let n=0;n<201;n++){clock.advance(1);tell(`page-${n}`,upload.id);}
    const page1=await call(`?task=${current.id}&kind=other`),page2=await call(`?task=${current.id}&kind=other&offset=${page1.next}`);
    assert.equal(page1.total,201);assert.equal(page1.files.length,200);assert.equal(page1.next,200);
    assert.equal(page2.files.length,1);assert.equal(page2.next,null);assert.ok(!page1.files.some((a:any)=>a.message===page2.files[0].message));
  }finally{await env.cleanup();}
});
