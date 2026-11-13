import { lstatSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  noteImages,
  notes,
  noteVersions,
  submissionEvidence,
} from "../db/schema";
import { resolveWithinRoot } from "../lib/blob-io";
import { sweepAnnotationFiles } from "./annotation-file-gc";
import { collectBackupReferencedPaths } from "./backup-service";
import { gcInkFiles } from "./ink-gc";
import { sweepNoteAndTemporaryFiles } from "./note-file-gc";
import {
  liveStoragePaths,
  safeStorageFile,
  storagePathKey,
} from "./storage-gc-paths";

function noteFileOf(dataDir: string, path: string, suffix: string) {
  return resolveWithinRoot(dataDir, join("blobs", "notes"), path, {
    suffix,
    violationCode: "NOTE_BODY_PATH_INVALID",
  });
}

// ---------- GC（未引用版本延迟回收 + 备份引用保留清单；自动调度本批未接线） ----------

/** 安全窗口（毫秒）：版本/临时文件创建后至少保留这么久才可回收（暂定值） */
export const NOTE_GC_SAFETY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface NoteGcOptions {
  /** 回收判定时刻（默认当前时间；测试注入） */
  now?: Date;
  /** 安全窗口毫秒数（默认 NOTE_GC_SAFETY_WINDOW_MS；测试注入） */
  safetyWindowMs?: number;
  /** 只盘点候选和字节数。 */
  dryRun?: boolean;
}

/** GC 执行摘要（测试与运维观察口径） */
export interface NoteGcResult {
  candidateVersionRows: number;
  candidateFiles: number;
  candidateBytes: number;
  fileFailures: number;
  /** 删除的 note_versions 行数（文件删除失败不影响此计数） */
  deletedVersionRows: number;
  /** 随版本连带删除的 note_images 行数 */
  deletedImageRows: number;
  /** 实际删除的正文文件数 */
  deletedFiles: number;
  /** 清扫的过期临时文件数 */
  sweptTmp: number;
  /** 清扫的超窗口无行孤儿正文文件数（崩溃/失败残留） */
  sweptOrphanFiles: number;
  /** 超窗口但被保留集合（头指针/证据引用）挡下的版本数 */
  keptByReference: number;
  /**
   * 超窗口但被**备份引用保留清单**挡下的版本数（T6R.14：backups/ 快照 db
   * 引用的版本——当前库已无引用，删除会破坏该备份的恢复完整性）。
   */
  keptByBackup: number;
  /**
   * 不可读的备份快照数（损坏/非 SQLite 文件）。>0 时本轮**放弃版本删除与
   * 孤儿清扫**（不可读备份可能引用任何 blobs/notes 文件，保守不删）——
   * 正常部署恒为 0；持续 >0 需运维处理坏快照（轮转按 mtime 删除，
   * 坏文件不会自愈）。
   */
  unreadableBackupDbs: number;
  /**
   * 存量路径形态异常（复审轮⑥起含正文与图片两类）：bodyPath 越出 blobs/notes
   * 或文件名不合 v<rev>-<hash12>.json.gz 模式、imagePath 越出根或不合
   * img-<uuid>.png 模式。>0 时本轮**放弃孤儿文件清扫**（保守不删，见下），
   * 计数暴露给运维排查——正常数据恒为 0（字段名沿用 bodyPaths 兼容既有
   * 观测面，语义已扩为两类）。
   */
  malformedBodyPaths: number;
}

/**
 * 未引用版本延迟回收（方案 §6.3；备份引用保留清单已随 T6R.14 落地——见
 * 保留集合说明。**自动调度仍未接线**：A 批次保持保守，回收由运维显式调用
 * 或后续批次在保留清单验证充分后接线，不以节省空间破坏可恢复性）。
 *
 * 保留集合（绝不可删）：
 * - 所有 notes.currentVersionId（工作头/订正检查点头）；
 * - 所有 submission_evidence.version_id（提交原稿）；
 * - 安全窗口内创建的全部版本与临时文件（在途上传、丢回执重试窗口——
 *   后者即 mutationId 幂等窗口：版本行被回收后幂等记录随之消失，窗口外
 *   重放按 CAS 冲突可诊断处理，见 note_versions.mutation_id 列注释）；
 * - 全部 note_images 行引用的图片文件（被行引用即活文件——行随所属版本
 *   删除时才连带删文件；「正在生成图片的版本」的保留由图片行的存在性
 *   天然承载：T6R.6 生成通道只要先落行或落 .tmp 就不会被误清）；
 * - **备份引用保留清单**（T6R.14，方案 §6.3「保留中的数据库备份引用也要
 *   纳入保留集合」）：backups/ 下的快照 db 是整库时点拷贝，其
 *   note_versions/note_images 行指向的 blobs/notes 文件与当前库共享磁盘，
 *   回收会把「备份可恢复」变成「备份恢复出缺图」。每次 GC 现扫现存快照
 *   （只读打开逐个取 body_path/path），引用路径并入保留集合；快照按 14 份
 *   轮转删除后引用自然释放，下一轮 GC 即可回收。快照损坏不可读时**保守
 *   放弃本轮版本删除与孤儿清扫**（不可读备份可能引用任何文件——宁可漏删
 *   不可误删，与存量路径形态异常的既有口径一致；tmp 清扫不受影响）。
 *
 * 删除顺序：先事务删行（FK 拒绝=仍有引用→跳过下轮再试），后删文件
 * （行已删，文件删除失败只是占空间的孤儿，不产生悬垂引用——坏方向是
 * 「行在文件无」，这里不会发生）。
 */
export function gcNoteVersions(
  db: Db,
  dataDir: string,
  options: NoteGcOptions = {},
): NoteGcResult {
  const now = options.now ?? new Date();
  const windowMs = options.safetyWindowMs ?? NOTE_GC_SAFETY_WINDOW_MS;
  const cutoffMs = now.getTime() - windowMs;
  const cutoff = new Date(cutoffMs).toISOString();
  const result: NoteGcResult = {
    candidateVersionRows: 0,
    candidateFiles: 0,
    candidateBytes: 0,
    fileFailures: 0,
    deletedVersionRows: 0,
    deletedImageRows: 0,
    deletedFiles: 0,
    sweptTmp: 0,
    sweptOrphanFiles: 0,
    keptByReference: 0,
    keptByBackup: 0,
    unreadableBackupDbs: 0,
    malformedBodyPaths: 0,
  };
  const sweep = (filePath: string, cutoff = Infinity): boolean => {
    try {
      const stat = lstatSync(filePath);
      if (!safeStorageFile(dataDir, filePath)) {
        result.fileFailures++;
        return false;
      }
      if (!stat.isFile() || stat.mtimeMs >= cutoff) return false;
      result.candidateFiles++;
      result.candidateBytes += stat.size;
      if (options.dryRun) return false;
      unlinkSync(filePath);
      return true;
    } catch (error) {
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        )
      ) {
        result.fileFailures++;
      }
      return false;
    }
  };
  const notesRoot = resolve(dataDir, "blobs", "notes");
  /**
   * relative + 越界判定的共同核（T4：relKeyOf/liveRel 共用）——返回原始
   * path.relative 结果（null = 越出根或恰为根本身）；分隔符/大小写归一与
   * 形态判定由两侧各自完成（见各自注释）。
   */
  const relWithinOf = (storedPath: string): string | null => {
    const rel = relative(notesRoot, resolve(dataDir, storedPath));
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel;
  };
  /**
   * 存储路径 → notes 域内对账键（"/" 分隔、小写；越界 → null）。备份保留
   * 清单与版本删除判定共用同一归一（NTFS 大小写不敏感，复审④）；与孤儿
   * 清扫 liveRel 的差异仅在后者额外要求 basename 合模式（malformed 语义
   * 保留在 liveRel 侧，本函数不做形态判定）。
   */
  const relKeyOf = (storedPath: string): string | null => {
    const rel = relWithinOf(storedPath);
    return rel === null ? null : rel.split(/[\\/]/).join("/").toLowerCase();
  };

  /**
   * 备份引用保留清单（T6R.14）：快照扫描件在 backup-service.
   * collectBackupReferencedPaths（快照枚举/只读/坏件计数在其侧单测），
   * 这里只做 notes 域内的键归一并入保留集合。不可读快照计数触发本轮
   * 保守模式（版本删除与孤儿清扫全停）。
   */
  const backupKeepKeys = new Set<string>();
  const backupReferenced = collectBackupReferencedPaths(dataDir);
  result.unreadableBackupDbs = backupReferenced.unreadable;
  for (const storedPath of backupReferenced.paths) {
    const key = relKeyOf(storedPath);
    if (key !== null) backupKeepKeys.add(key);
  }
  // 保守模式：存在不可读快照时不删任何版本、不清任何孤儿（tmp 清扫不受影响）
  const conservative = result.unreadableBackupDbs > 0;

  // 保留集合（isNotNull 在 SQL 层裁掉 NULL 头/无版本证据行，免空值入集合）
  const keep = new Set<string>();
  for (const row of db
    .select({ id: notes.currentVersionId })
    .from(notes)
    .where(isNotNull(notes.currentVersionId))
    .all()) {
    // isNotNull 已在 SQL 层裁 NULL；TS 侧守卫兜底（drizzle 不收窄字段类型）
    if (row.id !== null) keep.add(row.id);
  }
  const sealed = new Set(
    db
      .select({ id: notes.id })
      .from(notes)
      .where(isNotNull(notes.sealedAt))
      .all()
      .map(({ id }) => id),
  );
  for (const row of db
    .select({ id: submissionEvidence.versionId })
    .from(submissionEvidence)
    .where(isNotNull(submissionEvidence.versionId))
    .all()) {
    if (row.id !== null) keep.add(row.id);
  }

  // 单次全表拉取（复审轮⑯：候选筛选与 live 对账同一份数据，消双全表扫描）；
  // serverSavedAt 为定长 UTC ISO，字典序即时间序，内存过滤与 SQL lt 等价
  const versionRows = db
    .select({
      id: noteVersions.id,
      noteId: noteVersions.noteId,
      bodyPath: noteVersions.bodyPath,
      savedAt: noteVersions.serverSavedAt,
    })
    .from(noteVersions)
    .all();
  // 图片行单次全量拉取：候选版本的连带删除（消逐候选 N+1 查询）与
  // 孤儿对账 live 集合同源（复审轮⑥：图片文件纳入孤儿清扫框架）
  const imageRows = db
    .select({
      id: noteImages.id,
      noteVersionId: noteImages.noteVersionId,
      path: noteImages.path,
    })
    .from(noteImages)
    .all();
  const imagesByVersion = new Map<string, { id: string; path: string }[]>();
  for (const img of imageRows) {
    const list = imagesByVersion.get(img.noteVersionId);
    if (list === undefined) {
      imagesByVersion.set(img.noteVersionId, [img]);
    } else {
      list.push(img);
    }
  }

  const pendingFiles = new Map<string, { file: string; refs: number }>();
  for (const row of versionRows) {
    if (row.savedAt >= cutoff) continue; // 窗口内不动（在途/幂等窗口）
    if (keep.has(row.id) || sealed.has(row.noteId)) {
      result.keptByReference += 1;
      continue;
    }
    if (conservative) continue; // 不可读快照在场：本轮不删（宁可漏删不可误删）
    const images = imagesByVersion.get(row.id) ?? [];
    // 备份引用保留清单：当前库无引用、但某快照引用的版本——删了会让该备份
    // 恢复出缺正文（方案 §6.3「保留中的数据库备份引用也要纳入保留集合」）。
    // C4：判定**同时看正文键与图片键**——bodyPath 形态异常（relKeyOf=null）
    // 的版本只查正文键会漏判，连带 unlink 掉快照引用的图片；任一键命中
    // 即整版本保守跳过（行与文件都不动）。
    const bodyKey = relKeyOf(row.bodyPath);
    const bodyKept = bodyKey !== null && backupKeepKeys.has(bodyKey);
    const imageKept = images.some((img) => {
      const key = relKeyOf(img.path);
      return key !== null && backupKeepKeys.has(key);
    });
    if (bodyKept || imageKept) {
      result.keptByBackup += 1;
      continue;
    }
    result.candidateVersionRows++;
    if (!options.dryRun) {
      try {
        const removed = db.transaction(
          (tx) => {
            if (
              tx
                .select({ id: notes.id })
                .from(notes)
                .where(eq(notes.currentVersionId, row.id))
                .get() !== undefined
            )
              return false;
            if (
              tx
                .select({ id: notes.id })
                .from(notes)
                .where(and(eq(notes.id, row.noteId), isNotNull(notes.sealedAt)))
                .get() !== undefined
            )
              return false;
            if (
              tx
                .select({ id: submissionEvidence.id })
                .from(submissionEvidence)
                .where(eq(submissionEvidence.versionId, row.id))
                .get() !== undefined
            )
              return false;
            tx.delete(noteImages)
              .where(eq(noteImages.noteVersionId, row.id))
              .run();
            const deleted = tx
              .delete(noteVersions)
              .where(
                and(
                  eq(noteVersions.id, row.id),
                  lt(noteVersions.serverSavedAt, cutoff),
                ),
              )
              .run();
            if (deleted.changes !== 1) tx.rollback();
            return true;
          },
          { behavior: "immediate" },
        );
        if (!removed) continue;
      } catch {
        continue;
      }
      result.deletedVersionRows++;
      result.deletedImageRows += images.length;
    }
    for (const [path, suffix] of [
      [row.bodyPath, ".json.gz"],
      ...images.map((img) => [img.path, ".png"] as const),
    ] as const) {
      try {
        const file = noteFileOf(dataDir, path, suffix);
        const key = storagePathKey(dataDir, file);
        pendingFiles.set(key, {
          file,
          refs: (pendingFiles.get(key)?.refs ?? 0) + 1,
        });
      } catch {
        result.fileFailures++;
      }
    }
  }
  const live = liveStoragePaths(db, dataDir, backupReferenced.paths);
  for (const [key, { file, refs }] of pendingFiles) {
    if ((live.get(key) ?? 0) <= (options.dryRun ? refs : 0) && sweep(file)) {
      if (file.endsWith(".json.gz")) result.deletedFiles++;
    }
  }

  const swept = sweepNoteAndTemporaryFiles({
    dataDir,
    versionRows,
    imageRows,
    backupKeepKeys,
    relWithinOf,
    live,
    conservative,
    sweep: (path) => sweep(path, cutoffMs),
  });
  Object.assign(result, swept);
  if (!conservative) {
    result.sweptOrphanFiles += gcInkFiles(dataDir, live, (path) =>
      sweep(path, cutoffMs),
    );
    result.sweptOrphanFiles += sweepAnnotationFiles(dataDir, live, (path) =>
      sweep(path, cutoffMs),
    );
  }
  return result;
}
