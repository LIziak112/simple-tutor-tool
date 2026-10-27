import { useSyncExternalStore } from "react";
import { createExternalPrefStore } from "@/lib/create-external-pref-store";

/**
 * 题组材料排版偏好（M5 扩展 / better-interface 交互）：
 * - split: 左右分栏（左侧材料，右侧题目；支持中缝比例拖拽与协同圈画）
 * - stack: 列表形式（材料在上，题目在下方依次堆叠展示）
 *
 * 状态持久化到 localStorage，按设备/浏览器记住学生选择。默认采用 split（左右分栏）。
 */
export type GroupMaterialLayout = "split" | "stack";

const STORAGE_KEY = "ownclass:group-material-layout";
const DEFAULT_LAYOUT: GroupMaterialLayout = "split";

function readStoredLayout(): GroupMaterialLayout {
  try {
    if (typeof window !== "undefined") {
      const val = window.localStorage?.getItem(STORAGE_KEY);
      if (val === "stack" || val === "split") return val;
    }
  } catch {
    /* 存储不可读（如禁用第三方 Cookie 或沙箱模式）时回退默认，不阻断渲染 */
  }
  return DEFAULT_LAYOUT;
}

const store = createExternalPrefStore<GroupMaterialLayout>(readStoredLayout());

export function getGroupMaterialLayout(): GroupMaterialLayout {
  return store.get();
}

export function setGroupMaterialLayout(layout: GroupMaterialLayout): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage?.setItem(STORAGE_KEY, layout);
    }
  } catch {
    /* 存储写入失败不抛错，本次会话内仍更新内存 store */
  }
  store.set(layout);
}

export function useGroupMaterialLayout(): [
  GroupMaterialLayout,
  (layout: GroupMaterialLayout) => void,
] {
  const value = useSyncExternalStore(
    store.subscribe,
    store.get,
    () => DEFAULT_LAYOUT,
  );
  return [value, setGroupMaterialLayout];
}

/** 仅供单元测试重置 store 状态 */
export function _resetGroupMaterialLayoutStoreForTest(): void {
  store.set(readStoredLayout());
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    try {
      if (event.key === STORAGE_KEY) {
        const val = event.newValue;
        if (val === "stack" || val === "split") {
          store.set(val);
        } else if (val === null) {
          store.set(DEFAULT_LAYOUT);
        }
      }
    } catch {
      /* 事件处理异常静默防御 */
    }
  });
}
