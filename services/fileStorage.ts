/**
 * Local IndexedDB storage provider to store and retrieve original files 
 * (Student Answer Sheet, Question Paper, Answer Key) associated with evaluation reports.
 * This guarantees the system preserves the reports with their correct respective documents
 * even after browser refresh or long periods of time.
 */

const DB_NAME = 'nextgen_eval_files_db';
const STORE_NAME = 'files';
const DB_VERSION = 1;

const openDB = (): Promise<IDBDatabase> => {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || typeof indexedDB === 'undefined' || !indexedDB) {
      return reject(new Error('IndexedDB is not supported or accessible in this environment.'));
    }

    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      
      request.onsuccess = (event: Event) => {
        resolve((event.target as IDBOpenDBRequest).result);
      };
      
      request.onerror = (event: Event) => {
        reject((event.target as IDBOpenDBRequest).error);
      };
    } catch (e) {
      reject(e);
    }
  });
};

export interface StoredSessionFiles {
  student: File | null;
  qp: File | null;
  ak: File | null;
}

export const saveFilesToDB = async (
  id: string,
  student: File | null,
  qp: File | null,
  ak: File | null
): Promise<void> => {
  if (!id) return;
  try {
    const db = await openDB();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    // Convert Files to Blobs to ensure safe, cross-browser compatibility when storing inside IndexedDB
    const data = {
      id,
      studentBlob: student ? new Blob([student], { type: student.type }) : null,
      studentName: student ? student.name : null,
      qpBlob: qp ? new Blob([qp], { type: qp.type }) : null,
      qpName: qp ? qp.name : null,
      akBlob: ak ? new Blob([ak], { type: ak.type }) : null,
      akName: ak ? ak.name : null,
    };

    await new Promise<void>((resolve, reject) => {
      const request = store.put(data);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('[FileStorage] Failed to save actual files to IndexedDB:', error);
  }
};

export const getFilesFromDB = async (id: string): Promise<StoredSessionFiles | null> => {
  if (!id) return null;
  try {
    const db = await openDB();
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    const data = await new Promise<any>((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (!data) return null;

    return {
      student: data.studentBlob && data.studentName 
        ? new File([data.studentBlob], data.studentName, { type: data.studentBlob.type }) 
        : null,
      qp: data.qpBlob && data.qpName 
        ? new File([data.qpBlob], data.qpName, { type: data.qpBlob.type }) 
        : null,
      ak: data.akBlob && data.akName 
        ? new File([data.akBlob], data.akName, { type: data.akBlob.type }) 
        : null,
    };
  } catch (error) {
    console.error('[FileStorage] Failed to fetch actual files from IndexedDB:', error);
    return null;
  }
};

export const deleteFilesFromDB = async (id: string): Promise<void> => {
  if (!id) return;
  try {
    const db = await openDB();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    await new Promise<void>((resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('[FileStorage] Failed to delete actual files from IndexedDB:', error);
  }
};
