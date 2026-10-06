/**
 * 会话级偏好 store 小工厂（T6R.9 复审⑩）：模块级单值 + 订阅——多个消费方
 * （多画布/多题卡）即时同步同一状态。input-preference（会话输入偏好）与
 * note-layout（设备布局偏好）共用；持久化/默认值策略由调用方包裹
 * （工厂只管内存态与通知，set 同值幂等不通知）。
 */
export interface ExternalPrefStore<T> {
  /** 当前值 */
  get(): T;
  /** 设置新值并通知订阅者（同值幂等） */
  set(next: T): void;
  /** 订阅变化（返回取消函数） */
  subscribe(cb: (next: T) => void): () => void;
}

export function createExternalPrefStore<T>(initial: T): ExternalPrefStore<T> {
  let current = initial;
  const listeners = new Set<(next: T) => void>();
  return {
    get: () => current,
    set: (next) => {
      if (next === current) return;
      current = next;
      for (const cb of [...listeners]) cb(next);
    },
    subscribe: (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}
