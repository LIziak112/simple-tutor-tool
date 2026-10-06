/**
 * 通用键值后端（T6R.8 复审⑥：第三份 KV 后端复制收敛）——memory 与
 * idb-keyval 两实现的完整 get/set/del/keys 面。
 *
 * 复制链治理：draft-store（KVBackend，无 keys）、event-queue
 * （EventStoreBackend）暂留原位不动——两侧接口面与语义（防抖/前缀扫描
 * 键形态）各有差异，强行统一会动 T2.9/T4.0a 的既有行为；本库为**新消费方
 * （note-store）落点**，复制链止于第三份。既有两处迁移到本库属独立重构
 * 单（另单处理，不在 T6R.8 扩面）。
 *
 * keys(prefix) 的 IDB 实现把前缀下推为 IDBKeyRange.bound（复审⑤）：不再
 * getAllKeys 全库扫描后内存过滤——会话前缀扫描（bind 补传、listPending）
 * 在长库下的成本与库大小解耦。上界取 prefix + U+FFFF：合法 JSON.stringify
 * 键（本仓键形态）不包含该字符，区间恰好覆盖全部前缀键。
 */
import { createStore, del, get, set } from "idb-keyval";

/**
 * 键值存取完整面（新消费方按需 Pick 收窄）。keys 已随 getAll 落地删除
 * （T6R.9 复审⑮：无消费方的死面）；del 暂无消费方但**保留**——草稿域
 * 「不静默删除未同步内容」的口径随时可能需要显式删除原语，届时迁移
 * draft-store/event-queue 时共用。
 */
export interface KVStoreBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  /**
   * 一次列出 prefix 前缀的键值对（T6R.9 复审⑧：bind/flush 扫描单事务取
   * 全量，替代逐键 get 的串行往返）。键值同序（对象存储按键排序遍历）；
   * 非字符串键丢弃（防御口径）。
   */
  getAll(prefix: string): Promise<Array<[string, unknown]>>;
}

/** 内存实现（jsdom 自动回退、单测隔离与故障注入用；不持久） */
export function memoryKVBackend(): KVStoreBackend {
  const map = new Map<string, unknown>();
  return {
    get: async (key) => map.get(key),
    set: async (key, value) => {
      map.set(key, value);
    },
    del: async (key) => {
      map.delete(key);
    },
    getAll: async (prefix) =>
      Array.from(map.entries()).filter(([key]) => key.startsWith(prefix)),
  };
}

/**
 * 前缀区间：[prefix, prefix+U+FFFF]。上界依据（复审⑭修正表述）：本仓键
 * 是 JSON.stringify 的数组串，prefix 后只可能是 `,`（0x2C）或 `]`（0x5D）
 * 等小于 U+FFFF 的后继字符——prefix+U+FFFF 恰好覆盖全部前缀键且不越入
 * 下一段。上界字符用 String.fromCharCode 显式构造——源码里放不可见字符
 * （U+FFFF）易在评审中被误删。
 */
function prefixRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound(prefix, prefix + String.fromCharCode(0xffff));
}

/** idb-keyval 实现（生产默认；专用 db/store 隔离其他 IDB 数据） */
export function idbKVBackend(
  dbName: string,
  storeName: string,
): KVStoreBackend {
  const store = createStore(dbName, storeName);
  return {
    get: (key) => get(key, store),
    set: (key, value) => set(key, value, store),
    del: (key) => del(key, store),
    getAll: async (prefix) => {
      // 同一事务内 getAllKeys + getAll（同一 range 同序）；回调返回 Promise
      // 的口径与 keys 同（customStore 只 resolve 回调返回值）
      const range = prefixRange(prefix);
      const request = <T>(r: IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
      const [rawKeys, values] = await store("readonly", (objectStore) =>
        Promise.all([
          request(objectStore.getAllKeys(range)),
          request(objectStore.getAll(range)),
        ]),
      );
      const pairs: Array<[string, unknown]> = [];
      for (let i = 0; i < rawKeys.length; i++) {
        const key = rawKeys[i];
        if (typeof key === "string") pairs.push([key, values[i] ?? null]);
      }
      return pairs;
    },
  };
}
