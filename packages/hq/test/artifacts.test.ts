import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ARTIFACT_LINK_TTL, ARTIFACT_TTL, csvRows, type ShowResult } from '../src/artifacts.ts';
import sharp from 'sharp';
import { vendorAssets } from '../src/artifact-vendor.ts';
import { makeEnv, until } from './helpers.ts';

async function apiEnv() {
  const env = await makeEnv({noStart:true}); await env.hq.start({listen:true,timers:false});
  const auth={authorization:`Bearer ${readFileSync(join(env.cfg.stateDir,'api-token'),'utf8').trim()}`};
  const base=`http://127.0.0.1:${env.hq.port}`;
  const show = async (id:string,args:Record<string,unknown>,identity='eli') => {
    const response=await fetch(`${base}/v1/ops`,{method:'POST',headers:{...auth,'content-type':'application/json'},body:JSON.stringify({v:1,id,identity,shift:`${identity}-1`,sessionId:null,ts:new Date().toISOString(),op:'show',args})});
    return {status:response.status,body:await response.json() as any};
  };
  return {...env,auth,base,show};
}

test('show: directory, version update in the same card, signed URLs, auth, version binding and twelve hours', async()=>{
  const env=await apiEnv(), dir=mkdtempSync(join(tmpdir(),'artifact-'));
  try {
    writeFileSync(join(dir,'index.html'),'<link rel="stylesheet" href="style.css"><script type="module" src="app.js"></script><p>דוח</p>');
    writeFileSync(join(dir,'style.css'),'body{color:navy}');writeFileSync(join(dir,'app.js'),'document.body.dataset.ready="yes"');
    const shown=await env.show('show-1',{path:dir,title:'דוח פרטי'});assert.equal(shown.status,200,JSON.stringify(shown.body));
    const first=shown.body.result as ShowResult;assert.equal(first.version,1);assert.ok(first.url.includes('/v1/'));
    const a=env.hq.artifacts.get(first.id)!;const message=env.hq.mailbox.get(a.message_id)!;
    assert.ok(message.body.includes(first.url));assert.match(message.body,/בקשות חיצוניות חסומות/);
    const get=(url:string)=>fetch(env.base+new URL(url).pathname);
    const response=await get(first.url);assert.equal(response.status,200);assert.match(await response.text(),/דוח/);
    assert.match(response.headers.get('content-security-policy')!,/sandbox allow-scripts/);
    assert.equal(response.headers.get('access-control-allow-origin'),'*');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
    assert.equal((await get(first.url.replace('index.html','style.css'))).headers.get('content-type'),'text/css');
    assert.equal((await get(first.url.replace('index.html','app.js'))).headers.get('content-type'),'text/javascript');
    assert.equal((await fetch(`${env.base}/artifacts/${first.id}/v1/index.html`)).status,403);
    assert.equal((await fetch(`${env.base}/api/artifacts/${first.id}/open`,{method:'POST',body:'{}'})).status,401);
    const open=await fetch(`${env.base}/api/artifacts/${first.id}/open`,{method:'POST',headers:env.auth,body:'{}'});assert.equal(open.status,200);
    env.clock.advance(1000);writeFileSync(join(dir,'index.html'),'<p>גרסה שנייה</p>');
    const second=(await env.show('show-2',{path:dir,title:'דוח מעודכן',id:first.id,note:'נוסף פירוט'})).body.result as ShowResult;
    assert.equal(second.id,first.id);assert.equal(second.version,2);
    assert.equal(env.hq.mailbox.list('owner').filter(m=>m.id===a.message_id).length,1);
    assert.equal(env.hq.mailbox.get(`${a.message_id}-v2`)!.kind,'system');
    assert.equal((await get(first.url.replace('/v1/','/v2/'))).status,403);
    assert.equal((await get(second.url)).status,200);
    const replay=(await env.show('show-2',{path:dir,title:'דוח מעודכן',id:first.id})).body.result as ShowResult;assert.equal(replay.version,2);
    const unauthorized=await env.show('show-bad',{html:'<p>אחר</p>',title:'דוח',id:first.id},'rotem');assert.equal(unauthorized.status,403);
    env.clock.advance(ARTIFACT_LINK_TTL);assert.equal((await get(first.url)).status,403);
    assert.equal((await get(second.url)).status,403);
    assert.equal((await fetch(`${env.base}/api/artifacts/${first.id}/open`,{method:'POST',headers:env.auth,body:'{}'})).status,200,'fresh device-signed URL');
  }finally{await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test('thirty days from the latest version, pinning, expiration leaves the card and closing tasks does not delete content',async()=>{
  const env=await apiEnv();
  try {
    const first=(await env.show('expiry-1',{html:'<p>דוח</p>',title:'דוח'})).body.result as ShowResult;
    env.clock.advance(ARTIFACT_TTL-1000);env.hq.artifacts.sweep();assert.ok(existsSync(env.hq.artifacts.version(first.id,1)!.path));
    const second=(await env.show('expiry-2',{html:'<p>חדש</p>',title:'דוח',id:first.id})).body.result as ShowResult;
    env.clock.advance(2000);env.hq.artifacts.sweep();assert.equal(env.hq.artifacts.get(first.id)!.expired,0);
    env.hq.artifacts.keep(first.id,true);env.clock.advance(ARTIFACT_TTL);env.hq.artifacts.sweep();assert.equal(env.hq.artifacts.get(first.id)!.expired,0);
    env.hq.artifacts.keep(first.id,false);env.hq.artifacts.sweep();assert.equal(env.hq.artifacts.get(first.id)!.expired,1);
    assert.equal(existsSync(env.hq.artifacts.version(first.id,second.version)!.path),false);
    assert.ok(env.hq.mailbox.get(env.hq.artifacts.get(first.id)!.message_id));
    assert.ok(existsSync(env.hq.artifacts.get(first.id)!.thumb!));
    assert.equal((await fetch(`${env.base}/api/artifacts/${first.id}/thumb`,{headers:env.auth})).status,200);
  }finally{await env.cleanup();}
});

test('path allowlist rejects a symlink to state and traversal, bounds content, and escapes Markdown',async()=>{
  const env=await apiEnv(),dir=mkdtempSync(join(tmpdir(),'artifact-access-'));
  try {
    const link=join(dir,'state');symlinkSync(env.cfg.stateDir,link);
    assert.equal((await env.show('link',{path:link,title:'דוח'})).status,403);
    const md=join(dir,'report.md');writeFileSync(md,'<script>window.bad=true</script>');
    const result=(await env.show('md',{path:md,title:'דוח'})).body.result as ShowResult;
    const version=env.hq.artifacts.version(result.id,1)!;assert.ok(existsSync(join(version.path,'Heebo-400.ttf')));assert.ok(existsSync(join(version.path,'OFL.txt')));assert.match(readFileSync(join(version.path,'index.html'),'utf8'),/&lt;script&gt;/);
    const token=new URL(result.url).pathname.split('/')[4]!;
    assert.throws(()=>env.hq.artifacts.content(result.id,1,token,'../../../../artifact-key'),/no such artifact file/);
    assert.equal((await env.show('bad-html',{html:42,title:'דוח'})).status,400);
    const big=join(dir,'large.html');writeFileSync(big,Buffer.alloc(50*1024*1024+1));
    assert.equal((await env.show('big',{path:big,title:'דוח'})).status,413);
    rmSync(big);writeFileSync(join(dir,'index.html'),'<p>דוח</p>');symlinkSync(dir,join(dir,'loop'));
    assert.equal((await env.show('cycle',{path:dir,title:'דוח'})).status,403);
  }finally{await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test('offline CSP covers fetch, images, scripts, forms and popups; network opt-in keeps the opaque origin',async()=>{
  const env=await apiEnv();
  try {
    const offline=env.hq.artifacts.headers(false)['content-security-policy']!;
    assert.match(offline,/default-src 'self' 'unsafe-inline' data: blob:/);assert.doesNotMatch(offline.split(';')[0]!,/https:/);
    assert.match(offline,/form-action 'none'/);assert.match(offline,/base-uri 'none'/);assert.match(offline,/sandbox allow-scripts$/);
    assert.doesNotMatch(offline,/allow-popups|allow-forms|allow-same-origin/);
    const online=env.hq.artifacts.headers(true)['content-security-policy']!;assert.match(online,/blob: https:/);assert.match(online,/sandbox allow-scripts$/);
    const shown=(await env.show('online',{html:'<p>דוח</p>',title:'דוח',network:true})).body.result as ShowResult;
    assert.match(env.hq.mailbox.get(env.hq.artifacts.get(shown.id)!.message_id)!.body,/פונה לרשת/);
  }finally{await env.cleanup();}
});

test('Google Fonts CSS and font data are vendored locally with correct extensions and relative paths',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'artifact-font-'));
  try {
    writeFileSync(join(dir,'index.html'),'<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo">');
    const fetched:string[]=[];
    const fetcher=async(input:any)=>{
      const url=String(input);fetched.push(url);
      return new Response(url.includes('googleapis') ? '@font-face{font-family:Heebo;src:url(https://fonts.gstatic.com/heebo.woff2)}' : 'font bytes',{headers:{'content-type':url.includes('googleapis')?'text/css':'font/woff2'}});
    };
    assert.deepEqual(await vendorAssets(dir,fetcher as typeof fetch),[]);
    assert.equal(fetched.length,2);assert.doesNotMatch(readFileSync(join(dir,'index.html'),'utf8'),/googleapis/);
    const names=readdirSync(join(dir,'_vendor'));assert.ok(names.some(n=>n.endsWith('.css')));assert.ok(names.some(n=>n.endsWith('.woff2')));
    const css=readFileSync(join(dir,'_vendor',names.find(n=>n.endsWith('.css'))!),'utf8');assert.doesNotMatch(css,/https:/);assert.match(css,/url\(\.\/[^/]+\.woff2\)/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});


test('a slow older version cannot replace the latest card or thumbnail',async()=>{
  const env=await apiEnv();let release:(()=>void)|undefined;
  const server=createServer((req,res)=>{release=()=>{if (res.writableEnded) return; res.writeHead(200,{'content-type':'text/css'});res.end('body{color:blue}');};});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  try {
    const port=(server.address() as any).port;
    const slow=env.show('slow-version',{html:`<link rel="stylesheet" href="http://127.0.0.1:${port}/style.css"><p>ישן</p>`,title:'ישן'});
    await until(()=>!!release,2000,'old version download');
    const id=(env.hq.store.db.prepare('SELECT artifact FROM artifact_versions WHERE op_id = ?').get('slow-version') as {artifact:string}).artifact;
    env.clock.advance(ARTIFACT_TTL+1);env.hq.artifacts.sweep();
    assert.equal(env.hq.artifacts.get(id)!.expired,0,'do not delete a preparation at the TTL boundary');
    const picture=join(tmpdir(),`artifact-new-${id}.png`);writeFileSync(picture,await sharp({create:{width:64,height:64,channels:3,background:'red'}}).png().toBuffer());
    const newer=(await env.show('fast-version',{path:picture,title:'חדש',id})).body.result as ShowResult;rmSync(picture);
    const thumb=readFileSync(env.hq.artifacts.get(id)!.thumb!);
    release!();await slow;
    const card=env.hq.mailbox.get(env.hq.artifacts.get(id)!.message_id)!;
    assert.ok(card.body.includes(newer.url),card.body);assert.ok(card.body.startsWith('חדש'));
    assert.deepEqual(readFileSync(env.hq.artifacts.get(id)!.thumb!),thumb);
  }finally{release?.();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await env.cleanup();}
});


test('CSV preserves quoted commas, newlines, escaped quotes and Hebrew cells',()=>{
  assert.deepEqual(csvRows('name,value\r\n"אחד, שניים","line 1\nline 2"\r\n"a""b",42'),[['name','value'],['אחד, שניים','line 1\nline 2'],['a"b','42']]);
  assert.throws(()=>csvRows('"open'),/unclosed CSV quote/);
});


test('vendored ES modules retain relative import specifiers',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'artifact-module-'));
  try {
    writeFileSync(join(dir,'index.html'),'<script type="module" src="https://cdn.example/app.js"></script>');
    const fetcher=async(input:any)=>new Response(String(input).endsWith('app.js') ? 'import {value} from "./dep.js";document.body.textContent=value;' : 'export const value="ok";',{headers:{'content-type':'text/javascript'}});
    assert.deepEqual(await vendorAssets(dir,fetcher as typeof fetch),[]);
    const js=readdirSync(join(dir,'_vendor')).map(n=>readFileSync(join(dir,'_vendor',n),'utf8'));
    assert.ok(js.some(text=>/from "\.\/[^/]+\.js"/.test(text)));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('failed preparation never publishes a pending version and retry can complete it',async()=>{
  const env=await apiEnv();
  try {
    const first=(await env.show('ready-1',{html:'<p>מוכן</p>',title:'מוכן'})).body.result as ShowResult;
    const before=env.hq.artifacts.get(first.id)!;
    const thumb=readFileSync(before.thumb!);
    const body=env.hq.mailbox.get(before.message_id)!.body;
    const original=(env.hq.artifacts as any).assertBounds;
    (env.hq.artifacts as any).assertBounds=()=>{throw new Error('injected preparation failure');};
    const failed=await env.show('ready-2',{html:'<p>חדש</p>',title:'חדש',id:first.id});
    assert.equal(failed.status,500);
    const after=env.hq.artifacts.get(first.id)!;
    assert.equal(after.latest,1);assert.equal(after.title,'מוכן');assert.equal(after.expires_at,before.expires_at);
    assert.deepEqual(readFileSync(after.thumb!),thumb);
    assert.throws(()=>env.hq.artifacts.open(first.id,2),/not ready/);
    assert.equal(env.hq.mailbox.get(after.message_id)!.body,body);
    (env.hq.artifacts as any).assertBounds=original;
    const retried=(await env.show('ready-2',{html:'<p>חדש</p>',title:'חדש',id:first.id})).body.result as ShowResult;
    assert.equal(retried.version,2);assert.equal(env.hq.artifacts.get(first.id)!.latest,2);
  } finally {await env.cleanup();}
});

test('invalid or oversized preview falls back safely',async()=>{
  const env=await apiEnv(),dir=mkdtempSync(join(tmpdir(),'artifact-errors-'));
  try {
    for (const [name,data] of [['bad.png',Buffer.from('not an image')],['large.svg',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="20000"><rect width="100%" height="100%" fill="red"/></svg>')]] as const) {
      const path=join(dir,name);writeFileSync(path,data);
      const shown=await env.show(`preview-${name}`,{path,title:'תמונה'});
      assert.equal(shown.status,200,JSON.stringify(shown.body));
      assert.match(shown.body.result.warnings.join(' '),/preview/i);
      assert.ok(existsSync(env.hq.artifacts.get(shown.body.result.id)!.thumb!));
    }
  } finally {await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test('malformed tokens and escapes are client errors',async()=>{
  const env=await apiEnv();
  try {
    const shown=(await env.show('token-errors',{html:'<p>בדיקה</p>',title:'דוח'})).body.result as ShowResult;
    const url=new URL(shown.url),parts=url.pathname.split('/'), token=parts[4]!;
    const forged=token.slice(0,token.indexOf('-')+1)+'א'.repeat(43);
    assert.equal((await fetch(env.base+url.pathname.replace(token,encodeURIComponent(forged)))).status,403);
    assert.throws(()=>env.hq.artifacts.content(shown.id,1,forged,'index.html'),/invalid artifact token/);
    assert.equal((await fetch(env.base+url.pathname.replace('index.html','broken%ZZ'))).status,404);
  } finally {await env.cleanup();}
});

test('the real Caddy artifact route preserves sandbox headers and denies app/API routes',async()=>{
  const env=await apiEnv(),dir=mkdtempSync(join(tmpdir(),'artifact-caddy-'));
  const portServer=createServer();await new Promise<void>(r=>portServer.listen(0,'127.0.0.1',r));
  const port=(portServer.address() as {port:number}).port;await new Promise<void>(r=>portServer.close(()=>r()));
  const site=readFileSync(new URL('../../../deploy/caddy/agent-company.caddy',import.meta.url),'utf8');
  const block=site.slice(site.indexOf('art.hq.example.com {')).replace('art.hq.example.com',`http://127.0.0.1:${port}`).replace('127.0.0.1:7420',`127.0.0.1:${env.hq.port}`);
  const config=join(dir,'Caddyfile');writeFileSync(config,`{\n admin off\n auto_https off\n}\n${block}`);
  const proc=spawn('caddy',['run','--config',config,'--adapter','caddyfile'],{env:{...process.env,XDG_DATA_HOME:dir,XDG_CONFIG_HOME:dir},stdio:['ignore','pipe','pipe']});
  let error:Error|undefined,logs='';proc.on('error',e=>{error=e;});proc.stderr.on('data',b=>{logs=(logs+b).slice(-4000);});
  const exit=new Promise<void>(r=>{proc.once('exit',()=>r());proc.once('error',()=>r());});
  const base=`http://127.0.0.1:${port}`;
  try {
    let ready=false;
    for(let attempt=0;attempt<100&&!ready;attempt++) {
      if(error)throw error;
      try{ready=(await fetch(base+'/api/artifacts')).status===403;}catch{/* wait for this test's listener */}
      if(!ready)await new Promise(r=>setTimeout(r,50));
    }
    assert.ok(ready,`Caddy starts: ${logs}`);
    const shown=(await env.show('via-caddy',{html:'<p>דוח</p>',title:'דוח'})).body.result as ShowResult;
    const response=await fetch(base+new URL(shown.url).pathname);
    assert.equal(response.status,200);assert.equal(response.headers.get('content-security-policy'),env.hq.artifacts.headers(false)['content-security-policy']);
    assert.equal(response.headers.get('access-control-allow-origin'),'*');assert.equal(response.headers.get('referrer-policy'),'no-referrer');
    assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.equal(response.headers.get('x-dns-prefetch-control'),'off');
    assert.equal((await fetch(base+'/api/artifacts/anything/open',{method:'POST',headers:env.auth})).status,403);
    assert.equal((await fetch(base+'/hq/api/state',{headers:env.auth})).status,403);
  }finally{if(proc.exitCode===null&&!error)proc.kill('SIGTERM');await exit;await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});
