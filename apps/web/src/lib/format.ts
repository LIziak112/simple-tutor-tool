/**
 * 通用格式化工具（2026-10-06 自 T6R.1 实验室上提为共享实现）。
 *
 * 历史注：ExportWizard.tsx 与 teacher-backup/BackupSection.tsx 各持有一份
 * 旧的 KB/MB 口径本地实现；因迁移会直接改变用户可见的单位文案，未在
 * 上提时一并改动——后续统一单位口径时以本份为准（含非有限/负值防护）。
 */

/** 字节数的人类可读格式（1024 进制，一位小数；非有限/负值返回"—"） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}
