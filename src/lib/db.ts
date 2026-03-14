import { openDB, type IDBPDatabase } from 'idb';
import type { Organization, Session, Agenda, Talk } from '@/types';

const DB_NAME = 'minutes-app';
const DB_VERSION = 1;

type StoreMap = {
  organizations: Organization;
  sessions: Session;
  agendas: Agenda;
  talks: Talk;
};

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('organizations')) {
          db.createObjectStore('organizations', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('sessions')) {
          db.createObjectStore('sessions', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('agendas')) {
          db.createObjectStore('agendas', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('talks')) {
          db.createObjectStore('talks', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

function createStore<K extends keyof StoreMap>(storeName: K) {
  type T = StoreMap[K];
  return {
    async getAll(): Promise<T[]> {
      const db = await getDB();
      return db.getAll(storeName) as Promise<T[]>;
    },
    async getById(id: string): Promise<T | undefined> {
      const db = await getDB();
      return db.get(storeName, id) as Promise<T | undefined>;
    },
    async save(item: T): Promise<void> {
      const db = await getDB();
      await db.put(storeName, item);
    },
    async remove(id: string): Promise<void> {
      const db = await getDB();
      await db.delete(storeName, id);
    },
  };
}

export const organizationsStore = createStore('organizations');
export const sessionsStore = createStore('sessions');
export const agendasStore = createStore('agendas');
export const talksStore = createStore('talks');
