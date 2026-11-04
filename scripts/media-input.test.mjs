import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function page() {
  const events = {};
  const window = {};
  const objects=new Map(),revoked=[];
  const blobURL={createObjectURL(file){const path=`blob:${objects.size}`;objects.set(path,file);return path;},revokeObjectURL(path){revoked.push(path);}};
  vm.runInNewContext(readFileSync(new URL('../packages/app/web/paste.js', import.meta.url), 'utf8'), { window, document: { addEventListener: (name, fn) => { events[name] = fn; } }, Uint8Array, URL:blobURL });
  return { window, events, objects, revoked };
}
const file = (name, type='application/pdf') => ({ name, type, size: 3, arrayBuffer: async () => new Uint8Array([1,2,3]).buffer });
test('three dropped files stay with the original handler across a chat switch', async () => {
  const { window, events } = page();
  const first = [], second = [];
  window.companyPaste.set(async (_bytes, _mime, name) => { first.push(name); window.companyPaste.set(async (_b, _m, n) => second.push(n)); });
  let prevented = false;
  await events.drop({ dataTransfer: { files: [file('one.pdf'),file('two.zip'),file('three.xyz')] }, preventDefault: () => { prevented=true; } });
  assert.deepEqual(first, ['one.pdf','two.zip','three.xyz']); assert.deepEqual(second,[]); assert.equal(prevented,true);
});
test('a pasted non-image file works; size and read failures are visible to its composer', async () => {
  const { window, events } = page(); const delivered = [];
  window.companyPaste.set(async (bytes,mime,name) => {if(name==='broken.pdf'&&mime!=='read-failed')throw Error('read');delivered.push({length:bytes.length,mime,name});});
  await events.paste({ clipboardData: { getData: () => '',items:[{kind:'file',getAsFile:()=>file('document.pdf')}] }, preventDefault(){}, stopPropagation(){} });
  await events.drop({ dataTransfer: { files: [{...file('large.zip'),size:201*1024*1024},{...file('broken.pdf'),arrayBuffer:async()=>{throw Error('read');}}] }, preventDefault(){} });
  assert.deepEqual(delivered.map(d=>d.mime),['application/pdf','too-large','read-failed']);
});

test('a 190MB original crosses the bridge as an object URL without any binary copy',async()=>{
  const {window,events,objects,revoked}=page();let received;
  const original={...file('large.mp4','video/mp4'),size:190*1024*1024,arrayBuffer:async()=>{throw Error('must not materialize the original');}};
  window.companyPaste.set(async(bytes,mime,name,path,size)=>{assert.equal(bytes.length,0);assert.equal(objects.get(path),original);assert.deepEqual(revoked,[]);received={mime,name,path,size};});
  await events.drop({dataTransfer:{files:[original]},preventDefault(){}});
  assert.equal(received.mime,'video/mp4');assert.equal(received.size,original.size);assert.ok(received.path.startsWith('blob:'));assert.deepEqual(revoked,[received.path]);
});

test('a failed local copy can retain the original URL for an explicit retry',async()=>{
  const {window,events,revoked}=page();
  window.companyPaste.set(async()=>false);
  await events.drop({dataTransfer:{files:[file('retry.pdf')]},preventDefault(){}});
  assert.deepEqual(revoked,[]);
});
test('dropping a file without an open composer keeps the application on screen',async()=>{
  const {events}=page();let prevented=false;
  await events.drop({dataTransfer:{files:[file('orphan.pdf')]},preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
});
