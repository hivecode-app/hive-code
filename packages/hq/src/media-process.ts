import {spawn} from 'node:child_process';

/** Helpers own a process group: a wrapper timing out must not leave LibreOffice running. */
export function runMediaTool(command:string,args:string[],timeoutMs=60_000):Promise<string>{
  const executable=command==='ffmpeg'?(process.env.MEDIA_FFMPEG??command):command==='ffprobe'?(process.env.MEDIA_FFPROBE??command):command;
  return new Promise((resolve,reject)=>{
    const child=spawn(executable,args,{detached:true,stdio:['ignore','pipe','pipe']});
    let out='',error='',bytes=0,failure:Error|undefined;
    const stop=(reason:Error)=>{failure=reason;if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{/* already exited */}};
    const timer=setTimeout(()=>stop(new Error(`${command} timed out`)),timeoutMs);
    child.stdout.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>4*1024*1024)stop(new Error(`${command} output too large`));else out+=b.toString();});
    child.stderr.on('data',(b:Buffer)=>{error=(error+b.toString()).slice(-4096);});
    child.on('error',(err)=>{clearTimeout(timer);reject(err);});
    child.on('close',(code)=>{clearTimeout(timer);if(failure)reject(failure);else if(code!==0)reject(new Error(error.trim().split('\n').at(-1)||`${command} failed (${code})`));else resolve(out);});
  });
}
