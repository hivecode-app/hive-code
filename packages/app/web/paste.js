// Paste/drop belongs to the composer that received the event, even if file reading finishes
// after a chat switch. Await local staging before reading another large original.
(() => {
  let handler = null;
  window.companyPaste = {
    set: fn => { handler = fn; },
    clear: fn => { if (handler === fn) handler = null; },
  };
  async function deliver(files, fn) {
    for (const file of files.slice(0, 20)) {
      if (file.size > 200 * 1024 * 1024) {
        try { await fn(new Uint8Array(), 'too-large', file.name); } catch { /* The next valid file still belongs to this event. */ }
        continue;
      }
      let path, release = true;
      try {
        path = URL.createObjectURL(file);
        release = await fn(new Uint8Array(), file.type, file.name || '', path, file.size) !== false;
      } catch (_) {
        try { await fn(new Uint8Array(), 'read-failed', file.name); } catch { /* A closed composer must not drop the remaining originals. */ }
      } finally {
        if (path && release) URL.revokeObjectURL(path);
      }
    }
    if (files.length > 20) { try { await fn(new Uint8Array(), 'too-many', ''); } catch { /* The original composer may have closed. */ } }
  }
  document.addEventListener('dragover', event => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  document.addEventListener('drop', async event => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    if (handler) await deliver(Array.from(event.dataTransfer.files), handler);
  });
  document.addEventListener('paste', async event => {
    const data = event.clipboardData;
    if (!handler || !data) return;
    const files = Array.from(data.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
    // Word/web selections often contain an image rendition of their text; keep those as text.
    if (!files.length || (data.getData('text/plain') || '').trim() && files.every(file => file.type.startsWith('image/'))) return;
    event.preventDefault(); event.stopPropagation();
    await deliver(files, handler);
  }, true);
})();
