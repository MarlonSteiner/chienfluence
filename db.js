// Clips live in IndexedDB on the phone, so nothing is lost if the app closes mid-class.

const DB_NAME = 'chienfluence';
let dbp;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('sessions', { keyPath: 'id' });
      const clips = db.createObjectStore('clips', { keyPath: 'id' });
      clips.createIndex('session', 'sessionId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function run(store, mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const result = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const db = {
  putSession: (s) => run('sessions', 'readwrite', (st) => st.put(s)),
  getSession: (id) => run('sessions', 'readonly', (st) => st.get(id)),
  allSessions: () => run('sessions', 'readonly', (st) => st.getAll()),
  deleteSession: (id) => run('sessions', 'readwrite', (st) => st.delete(id)),
  putClip: (c) => run('clips', 'readwrite', (st) => st.put(c)),
  deleteClip: (id) => run('clips', 'readwrite', (st) => st.delete(id)),
  clipsFor: (sessionId) => run('clips', 'readonly', (st) => st.index('session').getAll(sessionId))
    .then((cs) => cs.sort((a, b) => a.index - b.index)),
};
