// IndexedDB keeps binary media outside localStorage, including across tab restarts.
(() => {
  const db = new Promise((resolve, reject) => {
    const req = indexedDB.open('company-media', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('files');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  async function transaction(mode, work) {
    const database = await db;
    return new Promise((resolve, reject) => {
      const tx = database.transaction('files', mode);
      const req = work(tx.objectStore('files'));
      tx.oncomplete = () => resolve(req.result ?? null);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
  async function binary(key) { return transaction('readonly', store => store.get(key)); }
  window.companyMediaStorage = {
    write: (key, bytes) => transaction('readwrite', store => store.put(new Blob([bytes]), key)),
    copyFromUrl: async (key, url) => {
      const response = await fetch(url);
      if (!response.ok) throw Error('file read failed');
      const blob = await response.blob();
      await transaction('readwrite', store => store.put(blob, key));
    },
    read: async key => { const value=await binary(key); return value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : value; },
    readRange: async (key, start, end) => { const value=await binary(key); return value instanceof Blob ? new Uint8Array(await value.slice(start,end).arrayBuffer()) : value?.slice(start,end) ?? null; },
    releaseSource: path => { if (path.startsWith('blob:')) URL.revokeObjectURL(path); },
    move: (from, to) => transaction('readwrite', store => {
      const req = store.get(from);
      req.onsuccess = () => { if (req.result != null) { store.put(req.result, to); store.delete(from); } };
      return req;
    }),
    remove: key => transaction('readwrite', store => store.delete(key)),
  };
})();
