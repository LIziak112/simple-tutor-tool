/**
 * 拖拽选择的文件展开（桌面浏览器；iPad Safari 拖文件夹不可靠属预期，
 * 多选文件入口是全平台基线兜底，不为此做特殊处理）。
 *
 * 从 DataTransfer 拿到 File[]：优先走 webkitGetAsEntry 递归进目录（保住
 * 相对路径，与 webkitdirectory 同语义——含拖入文件夹的根名，供「按子目录
 * 建文件夹」与随行图片配对的精确路径匹配用）；浏览器不给 entry（部分环境
 * 直接拖文件）时退回 dataTransfer.files。
 */

/** entry.file() / reader.readEntries() 的回调风格 API 转 Promise */
function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readEntryBatch(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => reader.readEntries(resolve, reject));
}

/** 递归收集目录下全部文件（relPath 为该目录自身的相对路径，含结尾 /） */
async function collectDirectory(
  entry: FileSystemDirectoryEntry,
  relPath: string,
  out: File[],
): Promise<void> {
  const reader = entry.createReader();
  // readEntries 每次最多返回约 100 条：循环读到空批次为止，防大目录漏文件
  for (;;) {
    const batch = await readEntryBatch(reader);
    if (batch.length === 0) break;
    for (const child of batch) {
      await collectEntry(child, relPath, out);
    }
  }
}

/** 单个 entry：文件 → 读出 File 并挂相对路径；目录 → 递归 */
async function collectEntry(
  entry: FileSystemEntry,
  parentPath: string,
  out: File[],
): Promise<void> {
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry);
    out.push(withRelativePath(file, `${parentPath}${entry.name}`));
    return;
  }
  if (entry.isDirectory) {
    await collectDirectory(
      entry as FileSystemDirectoryEntry,
      `${parentPath}${entry.name}/`,
      out,
    );
  }
}

/**
 * 给 File 实例挂 webkitRelativePath（拖拽路径与文件夹选择 input 同语义）。
 * 原型上的 webkitRelativePath 是 getter，实例 defineProperty 覆盖之——
 * jsdom 的 File 构造不支持该属性，组件测试用同一手法模拟文件夹选择。
 */
function withRelativePath(file: File, relativePath: string): File {
  Object.defineProperty(file, "webkitRelativePath", {
    value: relativePath,
    configurable: true,
  });
  return file;
}

/**
 * 展开拖拽的 DataTransfer：文件与文件夹（递归）→ 带相对路径的 File[]。
 * 读目录或读文件失败的条目跳过不抛（部分拖入的系统文件不可读），其余照常返回。
 */
export async function filesFromDataTransfer(
  dataTransfer: DataTransfer,
): Promise<File[]> {
  const items = dataTransfer.items;
  const entries: FileSystemEntry[] = [];
  if (items !== undefined) {
    // DataTransferItemList 不是可迭代/ArrayLike：按下标快照（异步展开前必须
    // 先取 entry——drop 事件返回后 items 会被清空，entry 引用仍可用）
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item === undefined) continue;
      const entry = item.webkitGetAsEntry();
      if (entry !== null) entries.push(entry);
    }
  }
  if (entries.length === 0) {
    // 无 entry（如直接拖文件的降级路径）：至少保住文件本身（无相对路径）
    const files: File[] = [];
    for (const file of dataTransfer.files) files.push(file);
    return files;
  }
  const out: File[] = [];
  for (const entry of entries) {
    try {
      await collectEntry(entry, "", out);
    } catch {
      // 单个 entry 失败不影响其余拖入内容
    }
  }
  return out;
}
