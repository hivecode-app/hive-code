import { createServer } from 'node:http';
import { prepareMedia } from '../src/upload-media.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, createReadStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { UPLOAD_PART_BYTES, Uploads } from '../src/uploads.ts';
import { ensureRuntimeIdentity } from '../src/org.ts';
import { workerPath } from '../src/file-access.ts';
import { makeEnv, until } from './helpers.ts';

const ffmpeg = process.env.MEDIA_FFMPEG ?? 'ffmpeg';
async function digest(path: string) { const hash = createHash('sha256'); for await (const b of createReadStream(path)) hash.update(b); return hash.digest('hex'); }
function fixtures(dir: string, large = false) { execFileSync('python3', [new URL('./media-fixtures.py', import.meta.url).pathname, dir, ...(large ? ['large'] : [])]); }

async function apiEnv() {
  const env = await makeEnv({ noStart: true }); await env.hq.start({ listen: true, timers: false });
  const auth = { authorization: `Bearer ${readFileSync(join(env.cfg.stateDir,'api-token'),'utf8').trim()}` };
  const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${env.hq.port}${path}`, { ...init, headers: { ...auth, ...init.headers } });
  return { ...env, call };
}

test('150MB ZIP resumes after part three, survives a new uploader, and completes with identical SHA-256', async () => {
  const env = await apiEnv(); const dir = mkdtempSync(join(tmpdir(),'media-large-'));
  try {
    fixtures(dir,true); const file = join(dir,'large.zip'), bytes = statSync(file).size, hash = await digest(file);
    const opened = await env.call('/api/uploads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'large.zip',bytes})});
    assert.equal(opened.status,200); const id = ((await opened.json()) as any).upload.id;
    const fd = openSync(file,'r');
    try {
      for (let n=0; n < Math.ceil(bytes/UPLOAD_PART_BYTES); n++) {
        const b = Buffer.alloc(Math.min(UPLOAD_PART_BYTES,bytes-n*UPLOAD_PART_BYTES)); readSync(fd,b,0,b.length,n*UPLOAD_PART_BYTES);
        const r = await env.call(`/api/uploads/${id}/parts/${n}`,{method:'PUT',headers:{connection:'close'},body:b}); assert.equal(r.status,200);
        if (n === 2) {
          assert.deepEqual(new Uploads(env.hq.store,env.cfg.stateDir).status(id).parts,[0,1,2]);
          const status = await env.call(`/api/uploads/${id}/status`); assert.deepEqual(((await status.json()) as any).upload.parts,[0,1,2]);
          assert.equal((await env.call(`/api/uploads/${id}/complete`,{method:'POST',body:'{}'})).status,409);
        }
      }
    } finally { closeSync(fd); }
    const response = await env.call(`/api/uploads/${id}/complete`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sha256:hash})});
    assert.equal(response.status,200); const upload = ((await response.json()) as any).upload;
    assert.equal(await digest(env.hq.uploads.get(upload.id)!.path),hash);
    assert.equal(upload.mime,'application/zip');
    const again = await env.call(`/api/uploads/${id}/complete`,{method:'POST',body:'{}'}); assert.equal(((await again.json()) as any).upload.id,upload.id);
    const unknown = env.hq.uploads.save(Buffer.from('unknown bytes'),'sample.xyz'); assert.equal(unknown.mime,'application/octet-stream');
  } finally { await env.cleanup(); rmSync(dir,{recursive:true,force:true}); }
});

test('metadata and sub-60KB thumbnails: 12 PDF pages, three worksheets, 42 seconds, 38 ZIP files and readable office text', async () => {
  const env = await apiEnv(), dir = mkdtempSync(join(tmpdir(),'media-meta-'));
  try {
    fixtures(dir);
    execFileSync(ffmpeg,['-nostdin','-y','-loglevel','error','-f','lavfi','-i','color=c=blue:s=640x360:r=1','-t','42','-c:v','libx264','-pix_fmt','yuv420p',join(dir,'movie.mp4')]);
    for (const [file,expected] of [['pages.pdf',{pages:12}],['book.xlsx',{sheets:3}],['movie.mp4',{duration:42}],['files.zip',{files:38}]] as const) {
      const upload = env.hq.uploads.save(readFileSync(join(dir,file)),file); await env.hq.uploads.prepare(upload.id);
      const u = env.hq.uploads.get(upload.id)!;
      for (const [key,value] of Object.entries(expected)) assert.equal((u.meta as any)[key],value,JSON.stringify(u.meta));
      if (file === 'files.zip') assert.equal(readFileSync(join(u.meta!.readable![1]!,'manifest.txt'),'utf8'),'original manifest content');
      if (file === 'movie.mp4') assert.equal(u.meta!.readable!.filter(p=>p.includes('frame-')).length,5);
      assert.ok(u.meta?.thumb); assert.ok(statSync(u.meta.thumb).size < 60*1024);
      const thumb = await env.call(`/api/uploads/${upload.id}/thumb`); assert.equal(thumb.status,200); assert.equal(thumb.headers.get('content-type'),'image/jpeg');
      const dimensions = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata(); assert.ok(dimensions.width! <= 512 && dimensions.height! <= 512);
      assert.ok(!u.meta.error?.includes('ENOENT'), JSON.stringify(u.meta));
    }
    const doc = env.hq.uploads.save(readFileSync(join(dir,'document.docx')),'document.docx'); await env.hq.uploads.prepare(doc.id);
    const readable = env.hq.uploads.get(doc.id)!.meta!.readable!; assert.match(readFileSync(readable[0]!,'utf8'),/החוזה בתוקף לשלושים יום/);
    const bad = env.hq.uploads.save(readFileSync(join(dir,'unsafe.zip')),'unsafe.zip'); await env.hq.uploads.prepare(bad.id);
    assert.match(env.hq.uploads.get(bad.id)!.meta!.error!,/unsafe archive path/); assert.equal(existsSync(join(env.cfg.stateDir,'escape.txt')),false);
  } finally { await env.cleanup(); rmSync(dir,{recursive:true,force:true}); }
});

test('tell files copies PNG and PDF; envelope describes every kind; closed-task forwarding retains attachments', async () => {
  const env = await makeEnv(), dir = mkdtempSync(join(tmpdir(),'media-files-'));
  try {
    fixtures(dir); const png = join(dir,'image.png'); writeFileSync(png,await sharp({create:{width:40,height:40,channels:3,background:'red'}}).png().toBuffer());
    const ack = await env.hq.ingest.receive({v:1,id:'files-tell',identity:'eli',shift:'eli-1',sessionId:null,ts:new Date().toISOString(),op:'tell',args:{to:'owner',body:'הקבצים מוכנים',files:[png,join(dir,'pages.pdf')]}});
    assert.equal(ack.ok,true); const message = env.hq.mailbox.get('files-tell')!; assert.equal(message.attachments!.length,2);assert.equal(message.attachments![0]!.meta?.width,40);
    rmSync(png); assert.ok(existsSync(env.hq.uploads.get(message.attachments![0]!.id)!.path));
    for (const file of ['pages.pdf','book.xlsx','files.zip','document.docx']) {
      const upload = env.hq.uploads.save(readFileSync(join(dir,file)),file); await env.hq.uploads.prepare(upload.id);
      const text = env.hq.mailbox.envelope({...message,attachments:[upload]}); assert.ok(text.includes(file)); assert.ok(text.includes(env.hq.uploads.get(upload.id)!.path));
    }
    ensureRuntimeIdentity(env.hq.store, {id:'agent-company-t777', name:'עובד', title:'מפתח', project:'agent-company', reports_to:'eli'});
    const t = env.hq.scheduler.addTask({title:'משימה',identity:'agent-company-t777',state:'done',labels:['opened-by:eli']});
    assert.equal(env.hq.mailbox.taskClosed('agent-company-t777'),true);
    assert.equal(env.hq.mailbox.responsibleFor('agent-company-t777'),'eli');
    const sent = env.hq.mailbox.tell({priority:'now',msg_id:'closed-files',from:'owner',to:'agent-company-t777',body:'תבדוק את הקובץ',attachments:message.attachments!.map(a=>a.id)});
    await until(()=>!!env.hq.mailbox.get(`${sent.id}-fwd`),2000,'forwarded');
    assert.deepEqual(env.hq.mailbox.get(`${sent.id}-fwd`)!.attachments?.map(a=>a.id),message.attachments?.map(a=>a.id));
    assert.ok(t.id);
  } finally { await env.cleanup(); rmSync(dir,{recursive:true,force:true}); }
});

test('allowlist resolves symlinks, rejects state credentials and Claude files, and permits only referenced uploads', async () => {
  const env = await makeEnv(), dir = mkdtempSync(join(tmpdir(),'media-access-'));
  try {
    const secret = join(env.cfg.stateDir,'hq.env'); writeFileSync(secret,'secret'); const link=join(dir,'secret'); symlinkSync(secret,link);
    assert.throws(()=>workerPath(env.hq.store,env.cfg.stateDir,'eli',link),/outside the allowed/);
    await assert.rejects(()=>env.hq.uploads.importFiles('eli',[link]),/outside the allowed/);
    await assert.rejects(()=>env.hq.uploads.importFiles('eli',['/home/ran/.claude/settings.json']),/outside the allowed|does not exist/);
    await assert.rejects(()=>env.hq.uploads.importFiles('eli',[join(dir,'missing')]),/does not exist/);
    const upload=env.hq.uploads.save(Buffer.from('data'),'file.xyz'); const path=env.hq.uploads.get(upload.id)!.path;
    assert.throws(()=>workerPath(env.hq.store,env.cfg.stateDir,'eli',path),/outside the allowed/);
    const m=env.hq.mailbox.tell({msg_id:'with-file',to:'eli',body:'קובץ',attachments:[upload.id]});
    assert.equal(workerPath(env.hq.store,env.cfg.stateDir,'eli',path,m.id),path);
    assert.throws(()=>workerPath(env.hq.store,env.cfg.stateDir,'rotem',path,m.id),/outside the allowed/);
  } finally { await env.cleanup(); rmSync(dir,{recursive:true,force:true}); }
});


test('audio and video readable forms include a transcript and video frames', async () => {
  const env = await makeEnv(), dir = mkdtempSync(join(tmpdir(),'media-audio-'));
  const server = createServer((req,res) => { req.resume(); req.on('end',()=>{ res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({text:'הקובץ הוקרא בהצלחה'})); }); });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    execFileSync(ffmpeg,['-nostdin','-y','-loglevel','error','-f','lavfi','-i','sine=frequency=400:duration=1',join(dir,'sound.wav')]);
    const upload=env.hq.uploads.save(readFileSync(join(dir,'sound.wav')),'sound.wav');await env.hq.uploads.prepare(upload.id);
    const meta=await prepareMedia(env.hq.uploads.get(upload.id)!,{url:`http://127.0.0.1:${(server.address() as any).port}`,token:'test'});
    assert.equal(meta.waveform?.length,48);assert.ok(meta.waveform!.every(n=>n>=0&&n<=1));assert.ok(meta.waveform!.some(n=>n>0));assert.equal(meta.transcript,true);
    assert.equal(meta.duration,1);assert.match(readFileSync(meta.readable![0]!,'utf8'),/הקובץ הוקרא בהצלחה/);assert.equal(meta.error,undefined);
    env.hq.store.db.prepare('UPDATE uploads SET meta = ? WHERE id = ?').run(JSON.stringify(meta),upload.id);
    assert.match(env.hq.uploads.description(upload.id),/גרסה קריאה:.*transcript.txt/);
  }finally{await new Promise<void>(r=>server.close(()=>r()));await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test('small direct uploads and peer attachments are readable before a worker receives them',async()=>{
  const env=await apiEnv(),dir=mkdtempSync(join(tmpdir(),'media-delivery-'));
  try {
    fixtures(dir);const doc=join(dir,'document.docx');
    const response=await env.call('/api/uploads',{method:'POST',headers:{'x-file-name':'document.docx'},body:readFileSync(doc)});
    assert.equal(response.status,200);const upload=((await response.json()) as any).upload;
    await env.call('/api/messages/tell',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({msg_id:'direct-document',to:'eli',body:'לקרוא את המסמך',attachments:[upload.id]})});
    // Real Office conversion competes with the full suite on the shared CI runner.
    await until(()=>!!env.launcher.hosts.get('eli-1')?.sent.some(m=>m.msgId==='direct-document'),20_000,'direct document delivered');
    assert.match(env.launcher.hosts.get('eli-1')!.sent.find(m=>m.msgId==='direct-document')!.text,/גרסה קריאה:.*document.md/);
    const ack=await env.hq.ingest.receive({v:1,id:'peer-document',identity:'eli',shift:'eli-1',sessionId:null,ts:new Date().toISOString(),op:'tell',args:{to:'rotem',body:'תקראי את המסמך',urgency:'now',files:[doc]}});
    assert.equal(ack.ok,true);
    await until(()=>!!env.launcher.hosts.get('rotem-1')?.sent.some(m=>m.msgId==='peer-document'),20_000,'peer document delivered');
    assert.match(env.launcher.hosts.get('rotem-1')!.sent.find(m=>m.msgId==='peer-document')!.text,/גרסה קריאה:.*document.md/);
  }finally{await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test('a small JSON file remains file data rather than upload-session metadata',async()=>{
  const env=await apiEnv();
  try {
    const data=Buffer.from('{"answer":42}');
    const response=await env.call('/api/uploads',{method:'POST',headers:{'content-type':'application/json','x-file-name':'answer.json'},body:data});
    assert.equal(response.status,200);const upload=((await response.json()) as any).upload;
    assert.deepEqual(env.hq.uploads.read(upload.id)!.data,data);
  }finally{await env.cleanup();}
});

test('abandoned sessions expire and pending uploads have a bounded quota',async()=>{
  const env=await makeEnv();
  try {
    const {hq,clock}=env;const ids:string[]=[];
    for(let i=0;i<20;i++)ids.push(hq.uploads.open(`file${i}`,200*1024*1024).id);
    assert.throws(()=>hq.uploads.open('overflow',200*1024*1024),/too many unfinished/);
    clock.advance(24*3_600_000);hq.uploads.sweep();
    assert.throws(()=>hq.uploads.status(ids[0]!),/no such upload session/);
    assert.equal(existsSync(join(hq.uploads.dir,ids[0]!)),false);
    assert.ok(hq.uploads.open('next',1).id);
  }finally{await env.cleanup();}
});

test('a corrupt part is replaceable; failed assembly cleans temps and can be retried',async()=>{
  const env=await makeEnv();
  try {
    const {hq}=env;const data=Buffer.from('correct');const opened=hq.uploads.open('file.xyz',data.length);
    hq.uploads.part(opened.id,0,Buffer.from('corrupt'));
    await assert.rejects(hq.uploads.complete(opened.id,createHash('sha256').update(data).digest('hex')),/sha256 mismatch/);
    assert.equal(readdirSync(hq.uploads.dir).some(n=>n.endsWith('.tmp')),false);
    hq.uploads.part(opened.id,0,data);
    hq.store.db.exec("CREATE TRIGGER fail_upload BEFORE INSERT ON uploads BEGIN SELECT RAISE(ABORT,'test insert failure'); END;");
    await assert.rejects(hq.uploads.complete(opened.id),/test insert failure/);
    assert.equal(readdirSync(hq.uploads.dir).some(n=>n.startsWith('u-')),false);
    hq.store.db.exec('DROP TRIGGER fail_upload');
    const [one,two]=await Promise.all([hq.uploads.complete(opened.id),hq.uploads.complete(opened.id)]);assert.equal(one.id,two.id);
    assert.deepEqual(hq.uploads.read(one.id)!.data,data);
  }finally{await env.cleanup();}
});

test('startup removes orphan files and interrupted assembly; raw requests retain the old 25MB bound',async()=>{
  const env=await apiEnv();
  try {
    const {hq}=env;mkdirSync(hq.uploads.dir,{recursive:true});
    const tmp=join(hq.uploads.dir,'u-00000000-0000-0000-0000-000000000000.tmp');writeFileSync(tmp,'partial');
    const orphan=join(hq.uploads.dir,'u-11111111-1111-1111-1111-111111111111.bin');writeFileSync(orphan,'orphan');
    new Uploads(hq.store,env.cfg.stateDir);assert.equal(existsSync(tmp),false);assert.equal(existsSync(orphan),false);
    assert.equal((await env.call('/api/uploads',{method:'POST',body:Buffer.alloc(26*1024*1024)})).status,413);
  }finally{await env.cleanup();}
});

test('assembling and importing large files yield to the event loop',async()=>{
  const env=await makeEnv(),dir=mkdtempSync(join(tmpdir(),'media-stream-'));
  try {
    const {hq}=env;const file=join(dir,'large.xyz');writeFileSync(file,Buffer.alloc(24*1024*1024,7));
    hq.uploads.prepare=async()=>{};
    const session=hq.uploads.open('large.xyz',statSync(file).size);
    for(let n=0;n<3;n++)hq.uploads.part(session.id,n,Buffer.alloc(UPLOAD_PART_BYTES,7));
    let ticks=0;const timer=setInterval(()=>ticks++,0);
    try {
      await hq.uploads.complete(session.id);assert.ok(ticks>0,'assembly yields between bounded blocks');
      ticks=0;await hq.uploads.importFiles('eli',[file]);assert.ok(ticks>0,'file import streams');
    }finally{clearInterval(timer);}
  }finally{await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});


test('a partially imported message leaves no files or rows after a later insert fails',async()=>{
  const env=await makeEnv(),dir=mkdtempSync(join(tmpdir(),'media-import-fail-'));
  try {
    const one=join(dir,'one.xyz'),two=join(dir,'two.xyz');writeFileSync(one,'one');writeFileSync(two,'two');
    env.hq.store.db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON uploads WHEN NEW.name='two.xyz' BEGIN SELECT RAISE(ABORT,'test second failure'); END;");
    await assert.rejects(env.hq.uploads.importFiles('eli',[one,two]),/test second failure/);
    assert.equal((env.hq.store.db.prepare('SELECT COUNT(*) n FROM uploads').get() as {n:number}).n,0);
    assert.deepEqual(readdirSync(env.hq.uploads.dir),[]);
  }finally{await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test('office MIME comes from archive contents rather than the supplied filename',async()=>{
  const env=await makeEnv(),dir=mkdtempSync(join(tmpdir(),'media-mime-'));
  try {
    fixtures(dir);
    const spreadsheet=env.hq.uploads.save(readFileSync(join(dir,'book.xlsx')),'unknown.xyz');await env.hq.uploads.prepare(spreadsheet.id);
    assert.equal(env.hq.uploads.get(spreadsheet.id)!.mime,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const archive=env.hq.uploads.save(readFileSync(join(dir,'files.zip')),'fake.xlsx');await env.hq.uploads.prepare(archive.id);
    assert.equal(env.hq.uploads.get(archive.id)!.mime,'application/zip');
  }finally{await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test('an APK over 100MB sent as a file keeps its MIME and downloads whole',async()=>{
  const env=await apiEnv(),dir=mkdtempSync(join(tmpdir(),'media-apk-'));
  try {
    fixtures(dir);const file=join(dir,'app.apk'),mime='application/vnd.android.package-archive';
    execFileSync('python3',['-I','-c',"import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n  z.writestr('AndroidManifest.xml','x')\n  z.writestr('classes.dex',bytes(101*1024*1024))",file]);
    const [id]=await env.hq.uploads.importFiles('eli',[file]);
    assert.equal(env.hq.uploads.get(id!)!.mime,mime);
    const response=await env.call(`/api/uploads/${id}`);
    assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),mime);
    assert.match(response.headers.get('content-disposition')!,/filename\*=UTF-8''app\.apk/);
    const body=Buffer.from(await response.arrayBuffer());
    assert.ok(body.length>100*1024*1024);assert.equal(createHash('sha256').update(body).digest('hex'),await digest(file));
    const renamed=env.hq.uploads.save(readFileSync(join(dir,'files.zip')),'renamed.apk');await env.hq.uploads.prepare(renamed.id);
    assert.equal(env.hq.uploads.get(renamed.id)!.mime,'application/zip');
  }finally{await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test('drain waits for asynchronous assembly and worker-file imports',async()=>{
  const env=await makeEnv(),dir=mkdtempSync(join(tmpdir(),'media-drain-'));
  try {
    const u=env.hq.uploads;const data=Buffer.alloc(8*1024*1024,1);u.prepare=async()=>{};
    const session=u.open('data.xyz',data.length);u.part(session.id,0,data);let assembled=false;
    const completion=u.complete(session.id).then(()=>{assembled=true;});await u.drain();assert.equal(assembled,true);await completion;
    const path=join(dir,'source.xyz');writeFileSync(path,data);let imported=false;
    const transfer=u.importFiles('eli',[path]).then(()=>{imported=true;});await u.drain();assert.equal(imported,true);await transfer;
  }finally{await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test('concurrent retries of tell files create one message and one copy',async()=>{
  const env=await makeEnv(),dir=mkdtempSync(join(tmpdir(),'media-idempotent-'));
  try {
    const path=join(dir,'file.xyz');writeFileSync(path,Buffer.alloc(1024*1024));
    const entry={v:1,id:'same-files',identity:'eli',shift:'eli-1',sessionId:null,ts:new Date().toISOString(),op:'tell' as const,args:{to:'owner',body:'קובץ',files:[path]}};
    const [one,two]=await Promise.all([env.hq.ingest.receive(entry),env.hq.ingest.receive(entry)]);assert.deepEqual(one,two);
    assert.equal((env.hq.store.db.prepare('SELECT COUNT(*) n FROM uploads').get() as {n:number}).n,1);
    assert.equal(env.hq.mailbox.get(entry.id)!.attachments!.length,1);
  }finally{await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});


test('a direct upload responds before slow conversion completes',async()=>{
  const env=await apiEnv();let release!:()=>void;const gate=new Promise<void>(r=>release=r);let response:Promise<Response>|undefined;
  try {
    env.hq.uploads.prepare=()=>gate;
    response=env.call('/api/uploads',{method:'POST',body:Buffer.from('data')});
    const quick=await Promise.race([response.then(()=>true),new Promise<boolean>(r=>setTimeout(()=>r(false),2000))]);
    assert.equal(quick,true,'the upload response must not wait for conversion');
  }finally{release();await response;await env.cleanup();}
});

test('ODF type and LibreOffice filename follow the archive mimetype',async()=>{
  const env=await makeEnv(),dir=mkdtempSync(join(tmpdir(),'media-odf-'));const oldPath=process.env.PATH;
  try {
    fixtures(dir);const tool=join(dir,'libreoffice');writeFileSync(tool,`#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(join(dir,'inputs'))},process.argv.at(-1)+'\\n');`);chmodSync(tool,0o700);process.env.PATH=`${dir}:${oldPath}`;
    for(const [ext,type] of [['odt','text'],['ods','spreadsheet'],['odp','presentation']]){
      const u=env.hq.uploads.save(readFileSync(join(dir,`sample.${ext}`)),'wrong.odt');await env.hq.uploads.prepare(u.id);
      assert.equal(env.hq.uploads.get(u.id)!.mime,`application/vnd.oasis.opendocument.${type}`);
      assert.ok(readFileSync(join(dir,'inputs'),'utf8').trim().split('\n').at(-1)!.endsWith(`.${ext}`));
    }
  }finally{process.env.PATH=oldPath;await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test('waveform failure preserves the audio transcript',async()=>{
  const env=await makeEnv(),dir=mkdtempSync(join(tmpdir(),'media-wave-failure-'));
  const server=createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({text:'Transcript survives a waveform error'}));});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const previous=process.env.MEDIA_FFMPEG;
  try{
    const audio=join(dir,'source.wav');execFileSync(ffmpeg,['-nostdin','-y','-loglevel','error','-f','lavfi','-i','sine=frequency=400:duration=1',audio]);
    const upload=env.hq.uploads.save(readFileSync(audio),'source.wav');await env.hq.uploads.prepare(upload.id);
    const wrapper=join(dir,'ffmpeg.mjs');
    writeFileSync(wrapper,`#!/usr/bin/env node\nimport {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);if(args.at(-1)?.endsWith('waveform.pcm'))process.exit(3);const result=spawnSync(${JSON.stringify(ffmpeg)},args,{stdio:'inherit'});process.exit(result.status??1);\n`);chmodSync(wrapper,0o700);process.env.MEDIA_FFMPEG=wrapper;
    const meta=await prepareMedia(env.hq.uploads.get(upload.id)!,{url:`http://127.0.0.1:${(server.address() as any).port}`,token:'test'});
    assert.equal(meta.transcript,true);assert.match(readFileSync(meta.readable![0]!,'utf8'),/Transcript survives/);assert.equal(meta.waveform,undefined);
  }finally{if(previous===undefined)delete process.env.MEDIA_FFMPEG;else process.env.MEDIA_FFMPEG=previous;await new Promise<void>(resolve=>server.close(()=>resolve()));await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});
