import {
  IMPORT_MAX_BATCH_BYTES,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_FILES_PER_BATCH,
} from "@tutor/contract";
export function renamedPath(path: string, name: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? `${path.slice(0, slash + 1)}${name}` : name;
}
export function precheckBatchLimits(
  files: readonly { bytes: number; path: string }[],
): string | null {
  if (files.length > IMPORT_MAX_FILES_PER_BATCH) {
    return `单批最多导入 ${IMPORT_MAX_FILES_PER_BATCH} 个文件（当前 ${files.length} 个），请分批导入。`;
  }
  for (const file of files) {
    if (file.bytes > IMPORT_MAX_FILE_BYTES) {
      return `文件「${file.path}」超过单文件 1 MB 上限，请拆分后再导入。`;
    }
  }
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  if (total > IMPORT_MAX_BATCH_BYTES) {
    return `单批 markdown 合计超过 10 MB 上限（当前约 ${Math.round(total / 1024 / 1024)} MB），请分批导入。`;
  }
  return null;
}
