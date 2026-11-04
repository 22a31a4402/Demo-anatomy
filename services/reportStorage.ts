import { EvaluationReport } from '../types';

const DB_NAME = 'nextgen_eval_reports_db';
const STORE_NAME = 'reports';
const DB_VERSION = 1;

const openReportsDB = (): Promise<IDBDatabase> => {
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

export const saveReportToDB = async (report: EvaluationReport): Promise<void> => {
  if (!report || !report.id) return;
  try {
    const db = await openReportsDB();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    await new Promise<void>((resolve, reject) => {
      const request = store.put(report);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('[ReportStorage] Failed to save report to IndexedDB:', error);
  }
};

export const getReportFromDB = async (id: string): Promise<EvaluationReport | null> => {
  if (!id) return null;
  try {
    const db = await openReportsDB();
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    const report = await new Promise<EvaluationReport | null>((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });

    return report;
  } catch (error) {
    console.error('[ReportStorage] Failed to fetch report from IndexedDB:', error);
    return null;
  }
};

export const getAllReportsFromDB = async (): Promise<EvaluationReport[]> => {
  try {
    const db = await openReportsDB();
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    const reports = await new Promise<EvaluationReport[]>((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });

    return reports;
  } catch (error) {
    console.error('[ReportStorage] Failed to fetch all reports from IndexedDB:', error);
    return [];
  }
};

export const deleteReportFromDB = async (id: string): Promise<void> => {
  if (!id) return;
  try {
    const db = await openReportsDB();
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    await new Promise<void>((resolve, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (error) {
    console.error('[ReportStorage] Failed to delete report from IndexedDB:', error);
  }
};
