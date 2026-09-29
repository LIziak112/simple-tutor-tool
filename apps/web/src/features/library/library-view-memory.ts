import type { FolderSelection } from "./FolderSidebar";

/**
 * 资源库视图记忆（页签 + 文件夹选中）：
 * - URL ?tab= 为显式意图（直达页签）；URL 无参数时恢复上次记忆的视图，
 *   避免从其他页面回来被重置回题库/「全部」；
 * - sessionStorage 按浏览器页签隔离、关闭即清；隐私模式等读写失败时静默降级
 *   （仅当次组件生命周期内记忆）。
 */

export type LibraryTab = "lectures" | "units" | "recycle";

/** URL ?tab= 的合法取值（缺省/非法值回落 units，保持 /t/library 直达旧口径） */
export function parseLibraryTab(value: string | null): LibraryTab {
  return value === "lectures" || value === "recycle" ? value : "units";
}

/** sessionStorage 键（测试需直接注入记忆值，故导出） */
export const LIBRARY_TAB_STORAGE_KEY = "tutor.library.tab";
export const LIBRARY_FOLDER_STORAGE_KEY = "tutor.library.folder";

function readStored(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // 隐私模式等场景静默降级：组件 state 仍承载当次会话的记忆
  }
}

export function readRememberedTab(): LibraryTab {
  return parseLibraryTab(readStored(LIBRARY_TAB_STORAGE_KEY));
}

export function writeRememberedTab(tab: LibraryTab): void {
  writeStored(LIBRARY_TAB_STORAGE_KEY, tab);
}

/**
 * 文件夹选中的序列化：undefined（全部）/ null（未归类）/ string（文件夹 id）
 * 三态无法整体 JSON 化（undefined 会被丢弃）——用 "all" 哨兵区分 undefined，
 * null 与字符串 id 原样 JSON 化。
 */
export function readRememberedFolder(): FolderSelection {
  const raw = readStored(LIBRARY_FOLDER_STORAGE_KEY);
  if (raw === null || raw === "all") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed === "string") return parsed;
  } catch {
    // 值损坏视作没有记忆
  }
  return undefined;
}

export function writeRememberedFolder(folder: FolderSelection): void {
  writeStored(
    LIBRARY_FOLDER_STORAGE_KEY,
    folder === undefined ? "all" : JSON.stringify(folder),
  );
}
