const DB_NAME = 'resonance-library';
const DB_VERSION = 1;
let connection;

function openDB() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      const coins = db.createObjectStore('coins', { keyPath: 'id' });
      coins.createIndex('createdAt', 'createdAt');
      const recordings = db.createObjectStore('recordings', { keyPath: 'id' });
      recordings.createIndex('coinId', 'coinId');
      recordings.createIndex('createdAt', 'createdAt');
    };
    request.onsuccess = () => resolve(request.result);
  });
  return connection;
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAll(storeName) {
  const db = await openDB();
  return requestPromise(db.transaction(storeName).objectStore(storeName).getAll());
}

export async function get(storeName, id) {
  const db = await openDB();
  return requestPromise(db.transaction(storeName).objectStore(storeName).get(id));
}

export async function put(storeName, value) {
  const db = await openDB();
  return requestPromise(db.transaction(storeName, 'readwrite').objectStore(storeName).put(value));
}

export async function remove(storeName, id) {
  const db = await openDB();
  return requestPromise(db.transaction(storeName, 'readwrite').objectStore(storeName).delete(id));
}

export async function recordingsForCoin(coinId) {
  const db = await openDB();
  return requestPromise(db.transaction('recordings').objectStore('recordings').index('coinId').getAll(coinId));
}

export async function deleteCoinAndRecordings(coinId) {
  const db = await openDB();
  const tx = db.transaction(['coins', 'recordings'], 'readwrite');
  tx.objectStore('coins').delete(coinId);
  const index = tx.objectStore('recordings').index('coinId');
  await new Promise((resolve, reject) => {
    const cursor = index.openKeyCursor(IDBKeyRange.only(coinId));
    cursor.onerror = () => reject(cursor.error);
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (!item) return resolve();
      tx.objectStore('recordings').delete(item.primaryKey);
      item.continue();
    };
  });
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
