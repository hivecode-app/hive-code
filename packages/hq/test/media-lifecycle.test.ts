import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,chmodSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runMediaTool} from '../src/media-process.ts';
import {makeEnv,until} from './helpers.ts';

const VIDEO=Buffer.from([0,0,0,16,...Buffer.from('ftypisom'),0,0,0,0]);
const alive=(pid:number)=>{try{return !readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1]!.startsWith('Z');}catch{return false;}};

test('a media helper timeout stops its grandchild as well as its wrapper',async()=>{
  const env=await makeEnv(),dir=mkdtempSync(join(tmpdir(),'media-timeout-'));
  const oldPath=process.env.PATH,oldProbe=process.env.MEDIA_FFPROBE;let pid:number|undefined;
  try {
    delete process.env.MEDIA_FFPROBE;
    const tool=join(dir,'ffprobe');writeFileSync(tool,`#!/usr/bin/env node\nconst fs=require('fs'),cp=require('child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(join(dir,'pid'))},String(child.pid));setInterval(()=>{},1000);`);chmodSync(tool,0o700);process.env.PATH=`${dir}:${oldPath}`;
    await assert.rejects(runMediaTool('ffprobe',[],1000),/timed out/);
    pid=Number(readFileSync(join(dir,'pid'),'utf8'));
    await until(()=>!alive(pid!),2000,'helper grandchild stopped');
  }finally{process.env.PATH=oldPath;if(oldProbe===undefined)delete process.env.MEDIA_FFPROBE;else process.env.MEDIA_FFPROBE=oldProbe;if(pid&&alive(pid))process.kill(pid,'SIGKILL');await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});

test('media conversion runs at most two helpers at once',async()=>{
  const env=await makeEnv(),dir=mkdtempSync(join(tmpdir(),'media-queue-'));
  const oldPath=process.env.PATH,oldProbe=process.env.MEDIA_FFPROBE;
  try {
    delete process.env.MEDIA_FFPROBE;mkdirSync(join(dir,'active'));
    const tool=join(dir,'ffprobe');writeFileSync(tool,`#!/usr/bin/env node\nconst fs=require('fs');const file=${JSON.stringify(join(dir,'active'))}+'/'+process.pid;fs.writeFileSync(file,'');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(dir,'release'))})){clearInterval(timer);fs.unlinkSync(file);process.stdout.write(JSON.stringify({format:{duration:'1'},streams:[]}));}},10);`);chmodSync(tool,0o700);process.env.PATH=`${dir}:${oldPath}`;
    for(let i=0;i<5;i++)env.hq.uploads.save(VIDEO,`file${i}.mp4`);
    await until(()=>readdirSync(join(dir,'active')).length>=2,3000,'two helpers started');await new Promise(r=>setTimeout(r,200));
    assert.equal(readdirSync(join(dir,'active')).length,2);
    writeFileSync(join(dir,'release'),'');await env.hq.uploads.drain();assert.equal(readdirSync(join(dir,'active')).length,0);
  }finally{writeFileSync(join(dir,'release'),'');await env.hq.uploads.drain();process.env.PATH=oldPath;if(oldProbe===undefined)delete process.env.MEDIA_FFPROBE;else process.env.MEDIA_FFPROBE=oldProbe;await env.cleanup();rmSync(dir,{recursive:true,force:true});}
});
