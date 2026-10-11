import type { Page } from "@playwright/test";

/** 只在隔离验收浏览器计数，检验重复开合是否释放对象URL与全局绘图监听。 */
export async function installReviewResourceProbe(page: Page) {
  await page.addInitScript(() => {
    const urls = new Set<string>();
    const listeners = new Map<
      EventListenerOrEventListenerObject,
      Set<string>
    >();
    const watched = new Set([
      "resize",
      "pointermove",
      "pointerup",
      "pointercancel",
      "blur",
      "mousemove",
      "mouseup",
      "touchmove",
      "touchend",
    ]);
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      urls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      urls.delete(url);
      revoke(url);
    };
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const key = (
      target: EventTarget,
      type: string,
      options?: boolean | EventListenerOptions,
    ) =>
      `${target === window ? "window" : "document"}:${type}:${typeof options === "boolean" ? options : (options?.capture ?? false)}`;
    EventTarget.prototype.addEventListener = function (
      type,
      callback,
      options,
    ) {
      if (
        (this === window || this === document) &&
        callback &&
        watched.has(type)
      ) {
        const entries = listeners.get(callback) ?? new Set<string>();
        entries.add(key(this, type, options));
        listeners.set(callback, entries);
      }
      add.call(this, type, callback, options);
    };
    EventTarget.prototype.removeEventListener = function (
      type,
      callback,
      options,
    ) {
      if (callback) {
        const entries = listeners.get(callback);
        entries?.delete(key(this, type, options));
        if (entries?.size === 0) listeners.delete(callback);
      }
      remove.call(this, type, callback, options);
    };
    Object.defineProperty(window, "reviewResources", {
      value: { urls, listeners },
    });
  });
}

export function reviewResourceCounts(page: Page) {
  return page.evaluate(() => {
    const resources = Object.getOwnPropertyDescriptor(window, "reviewResources")
      ?.value as
      | {
          urls: Set<string>;
          listeners: Map<EventListenerOrEventListenerObject, Set<string>>;
        }
      | undefined;
    if (!resources) throw new Error("验收资源计数未安装");
    return {
      urls: resources.urls.size,
      listeners: [...resources.listeners.values()].reduce(
        (sum, values) => sum + values.size,
        0,
      ),
    };
  });
}
