/**
 * 已绑定音效的持久化副本。
 *
 * 桌面版写到 `userData/samples/<encodeURIComponent(代号)>.bin`：
 * 打包后窗口是 `loadFile` 打开的（file:// 源），Chromium 在 file:// 下不给用
 * IndexedDB —— 打开就一直挂住、写入报 UnknownError，表现就是「重开程序后
 * 之前加载的音效全没了」。所以桌面版走主进程落盘，浏览器预览才用 IndexedDB。
 */
import { desktopApi } from '../core/desktop'

const DB_NAME = 'hitsound-studio'
const STORE = 'samples'

/** 桌面版且主进程提供了样本读写（老版本 preload 没有就退回 IndexedDB） */
function disk() {
  const a = desktopApi()
  return a && a.sampleWrite && a.sampleRead && a.sampleDelete ? a : null
}

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

export async function putSample(name: string, blob: Blob): Promise<void> {
  const a = disk()
  if (a) {
    const r = await a.sampleWrite!(name, new Uint8Array(await blob.arrayBuffer()))
    if (!r.ok) throw new Error(r.error || '写入音效文件失败')
    return
  }
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(blob, name)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function getSample(name: string): Promise<Blob | null> {
  const a = disk()
  if (a) {
    const r = await a.sampleRead!(name)
    if (!r.ok || !r.data) return null
    // 复制一份：IPC 传回来的 Uint8Array 可能挂在 SharedArrayBuffer 上，Blob 不吃
    const copy = new Uint8Array(r.data.byteLength)
    copy.set(r.data)
    return new Blob([copy.buffer])
  }
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(name)
    req.onsuccess = () => resolve((req.result as Blob) || null)
    req.onerror = () => reject(req.error)
  })
}

export async function deleteSample(name: string): Promise<void> {
  const a = disk()
  if (a) {
    await a.sampleDelete!(name)
    return
  }
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(name)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function listSamples(): Promise<string[]> {
  const a = disk()
  if (a?.sampleList) {
    const r = await a.sampleList()
    return r.names || []
  }
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAllKeys()
    req.onsuccess = () => resolve(req.result as string[])
    req.onerror = () => reject(req.error)
  })
}
