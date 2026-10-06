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

/** 键值存取完整面（新消费方按需 Pick 收窄） */
export interface KVStoreBackend {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  /** 列出以 prefix 开头的全部键（乱序允许；IDB 侧已下推 range） */
  keys(prefix: string): Promise<string[]>;
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
    keys: async (prefix) =>
      Array.from(map.keys()).filter((key) => key.startsWith(prefix)),
  };
}

/**
 * 前缀区间：[prefix, prefix+U+FFFF]。上界字符用 String.fromCharCode
 * 显式构造——源码里放不可见字符（U+FFFF）易在评审中被误删；合法
 * JSON.stringify 键不含它，区间恰好覆盖全部前缀键。
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
    keys: async (prefix) => {
      // getAllKeys 带 range：过滤下推到 IDB 层（非字符串键天然落在字符串
      // 区间外；防御性保留类型收窄）。回调内断言为解包后的值类型：
      // idb-keyval 运行时会 promisify 返回的 IDBRequest，但其 UseStore
      // 类型不表达该解包（本仓安装版本的类型联合按裸 Request 推断）
      const all = await store(
        "readonly",
        (objectStore) =>
          objectStore.getAllKeys(
            prefixRange(prefix),
          ) as unknown as IDBValidKey[],
      );
      return all.filter((key): key is string => typeof key === "string");
    },
  };
}
