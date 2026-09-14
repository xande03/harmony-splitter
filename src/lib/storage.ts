import type { StemLevels } from "./audio/stem-engine";
import { DEFAULT_LEVELS } from "./audio/stem-engine";

export interface TrackMeta {
  id: string;
  name: string;
  size: number;
  duration: number;
  createdAt: number;
  levels: StemLevels;
  master: number;
}

const META_KEY = "stemstudio.tracks.v1";
const DB_NAME = "stemstudio";
const STORE = "audio";

export function loadTracks(): TrackMeta[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(META_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TrackMeta[];
    return parsed.map((t) => ({ ...t, levels: { ...DEFAULT_LEVELS, ...t.levels } }));
  } catch {
    return [];
  }
}

export function saveTracks(tracks: TrackMeta[]) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(META_KEY, JSON.stringify(tracks));
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function putAudio(id: string, data: ArrayBuffer) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(data, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getAudio(id: string): Promise<ArrayBuffer | undefined> {
  const db = await openDb();
  const data = await new Promise<ArrayBuffer | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result as ArrayBuffer | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return data;
}

export async function deleteAudio(id: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
