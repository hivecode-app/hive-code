import { runMediaTool } from './media-process.ts';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import type { Upload } from './uploads.ts';
import type { DictateConfig } from './dictate.ts';

export interface UploadMeta {
  detected_mime?: string;
  width?: number; height?: number; pages?: number; duration?: number; sheets?: number; slides?: number; files?: number;
  waveform?: number[];
  transcript?: boolean;
  sheet_rows?: { name: string; rows: number }[];
  thumb?: string; readable?: string[]; error?: string;
}

/** Every format has a small thumbnail; expensive helpers run outside the event loop with bounded time/output. */
export async function prepareMedia(u: Upload, dictate?: DictateConfig): Promise<UploadMeta> {
  const meta: UploadMeta = {};
  const errors: string[] = [];
  const dir = `${u.path}.d`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const run = runMediaTool;
  let preview: string | Buffer | undefined;
  try {
    if (u.mime.startsWith('image/')) {
      const image = await sharp(u.path, { limitInputPixels: 100_000_000 }).metadata();
      meta.width = image.width; meta.height = image.height; preview = u.path;
    } else if (u.mime === 'application/pdf') {
      const info = await run('pdfinfo', [u.path]);
      meta.pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
      await run('pdftoppm', ['-f', '1', '-singlefile', '-scale-to', '512', '-jpeg', '-jpegopt', 'quality=70', u.path, join(dir, 'page')]);
      preview = join(dir, 'page.jpg');
    } else if (u.mime.startsWith('video/') || u.mime.startsWith('audio/')) {
      const probe = JSON.parse(await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', u.path])) as { format?: { duration?: string }; streams?: { codec_type: string; width?: number; height?: number }[] };
      meta.duration = Number(probe.format?.duration);
      if (u.mime.startsWith('audio/') && meta.duration && meta.duration <= 3600) {
        const pcm = join(dir,'waveform.pcm');
        try {
          await run('ffmpeg',['-nostdin','-y','-protocol_whitelist','file','-i',u.path,'-vn','-ac','1','-ar','1000','-t','3600','-f','s16le',pcm]);
          const samples=readFileSync(pcm), count=Math.floor(samples.length/2);
          meta.waveform=Array.from({length:48},(_,bin)=>{let peak=0;for(let n=Math.floor(bin*count/48);n<Math.floor((bin+1)*count/48);n++)peak=Math.max(peak,Math.abs(samples.readInt16LE(n*2)));return Math.round(peak/32768*1000)/1000;});
        } catch (err) { errors.push(`waveform: ${(err as Error).message.slice(0,200)}`); } finally {rmSync(pcm,{force:true});}
      }
      const video = probe.streams?.find((s) => s.codec_type === 'video');
      if (video) {
        meta.width = video.width; meta.height = video.height;
        await run('ffmpeg', ['-nostdin', '-y', '-protocol_whitelist', 'file', '-i', u.path, '-vf', 'fps=1/10:start_time=0:round=up,scale=512:512:force_original_aspect_ratio=decrease', '-frames:v', '30', join(dir, 'frame-%02d.jpg')]);
        const frames = readdirSync(dir).filter((f) => f.startsWith('frame-')).sort().map((f) => join(dir, f));
        preview = frames[0]; meta.readable = frames;
      }
      if (dictate?.url && dictate.token) {
        const audio = join(dir, 'audio.mp3');
        await run('ffmpeg', ['-nostdin', '-y', '-protocol_whitelist', 'file', '-i', u.path, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', audio]);
        const data = readFileSync(audio);
        if (data.length > 25 * 1024 * 1024) throw new Error('audio exceeds transcription limit');
        const response = await fetch(new URL('/transcribe', dictate.url), { method: 'POST', headers: { authorization: `Bearer ${dictate.token}`, 'content-type': 'audio/mpeg' }, body: data, signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`transcription failed (${response.status})`);
        const result = await response.json() as { text?: string; transcript?: string };
        const text = result.text ?? result.transcript;
        if (!text) throw new Error('transcription returned no text');
        meta.transcript = true;
        const transcript = join(dir, 'transcript.txt'); writeFileSync(transcript, text, { mode: 0o400 });
        meta.readable = [...(meta.readable ?? []), transcript];
      } else errors.push('transcription is not configured');
    } else if (/zip|tar|gzip|officedocument|opendocument|text\/csv/.test(u.mime)) {
      Object.assign(meta, JSON.parse(await run('python3', ['-I', fileURLToPath(new URL('./upload-extract.py', import.meta.url)), u.path, dir, u.mime])));
      const mime = meta.detected_mime ?? u.mime;
      if (/wordprocessing|presentation|opendocument/.test(mime)) {
        const ext = mime.startsWith('application/vnd.oasis.opendocument.') ? ({text:'.odt',spreadsheet:'.ods',presentation:'.odp'} as Record<string,string>)[mime.split('.').at(-1)!]! : mime.includes('wordprocessing') ? '.docx' : '.pptx';
        const source = extname(u.path) === ext ? u.path : join(dir,`document${ext}`);
        if(source !== u.path) await copyFile(u.path,source);
        await run('libreoffice', ['-env:UserInstallation=file://' + join(dir, 'lo-profile'), '--headless', '--convert-to', 'pdf', '--outdir', dir, source]);
        const pdf = readdirSync(dir).find((p) => p.endsWith('.pdf'));
        if (pdf) {
          const path = join(dir, pdf);
          const info = await run('pdfinfo', [path]); meta.pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);
          await run('pdftoppm', ['-f', '1', '-singlefile', '-scale-to', '512', '-jpeg', path, join(dir, 'page')]);
          preview = join(dir, 'page.jpg');
          meta.readable = [...(meta.readable ?? []), path];
        }
      }
    }
  } catch (err) { errors.push(((err as { stderr?: string }).stderr?.trim().split('\n').at(-1) ?? (err as Error).message).slice(0, 300)); }
  try {
    const generic = Buffer.from('<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg"><rect width="512" height="512" fill="#f7f7f5"/><path d="M160 100h130l62 62v250H160z" fill="white" stroke="#777" stroke-width="8"/><path d="M195 230h120m-120 50h120m-120 50h80" stroke="#777" stroke-width="10"/></svg>');
    const thumb = join(dir, 'thumb.jpg');
    // 512px at quality 65 is normally small; hard cap enforced even for noisy images.
    let quality = 65, data: Buffer;
    do { data = await sharp(preview ?? generic, { limitInputPixels: 100_000_000 }).rotate().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality }).toBuffer(); quality -= 15; } while (data.length >= 60 * 1024 && quality >= 20);
    if (data.length >= 60 * 1024) data = await sharp(data).resize(256, 256, { fit: 'inside' }).jpeg({ quality: 30 }).toBuffer();
    writeFileSync(thumb, data, { mode: 0o600 }); meta.thumb = thumb;
  } catch (err) { errors.push(`thumbnail: ${(err as Error).message.slice(0, 200)}`); }
  if (errors.length) meta.error = errors.join('; ');
  return meta;
}
