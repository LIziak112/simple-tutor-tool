import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { storagePathKey } from "./storage-gc-paths";

export function sweepNoteAndTemporaryFiles(input: {
  dataDir: string;
  versionRows: readonly { bodyPath: string }[];
  imageRows: readonly { path: string }[];
  backupKeepKeys: ReadonlySet<string>;
  relWithinOf: (path: string) => string | null;
  live: ReadonlyMap<string, number>;
  conservative: boolean;
  sweep: (path: string) => boolean;
}) {
  const {
    dataDir,
    versionRows,
    imageRows,
    backupKeepKeys,
    relWithinOf,
    live,
    conservative,
    sweep,
  } = input;
  const notesRoot = resolve(dataDir, "blobs", "notes");
  const counts = { sweptTmp: 0, sweptOrphanFiles: 0, malformedBodyPaths: 0 };
  // 过期临时文件清扫（.tmp- 前缀 = writeFileAtomic 独有命名；窗口内
  // 一律不碰——那是可能仍在途的请求或崩溃现场），以及超窗口的
  // **无行孤儿文件**清扫（正文与图片同框架，复审轮⑥：rename/落位完成、
  // 事务未提交或行已删文件未清的崩溃残留——文件名合模式但不在任何
  // note_versions.body_path / note_images.path 中；窗口内不碰——那可能是
  // 刚落位、事务尚未提交的在途请求）。
  if (existsSync(notesRoot)) {
    const bodyFilePattern = /^v\d+-[0-9a-f]{12}\.json\.gz$/;
    const imageFilePattern = /^img-[0-9a-f-]{36}\.png$/;
    // live 对账集合（正文 + 图片两类行，均在上方单次拉取的数据上派生）。
    // 保留防御：存量路径形态异常（越出根/文件名不合模式）时，其对应文件
    // 无法可靠对账——本轮放弃孤儿清扫（tmp 清扫不受影响），计数
    // malformedBodyPaths 暴露给运维。匹配双方一律 toLowerCase：NTFS 大小写
    // 不敏感，手工迁移/改目录名大小写后磁盘目录名与 DB 路径可能仅大小写
    // 不同——不做归一会把活文件误判成孤儿误删（复审④）。malformed 判定
    // （basename 模式）保持大小写敏感：非小写规范形态本就该按异常保守处理。
    const liveRel = (storedPath: string, pattern: RegExp): string | null => {
      // 越界/根本身判定走共同核（T4）；basename 模式判定保持大小写敏感
      // （malformed 语义：非小写规范形态本就该按异常保守处理，复审④）
      const rel = relWithinOf(storedPath);
      if (rel === null) return null;
      const base = rel.split(/[\\/]/).at(-1) ?? "";
      if (!pattern.test(base)) return null;
      // 键分隔符归一为 "/"：入库串用 "/"（复审⑦）而 path.relative 在
      // Windows 产 "\"，扫描侧统一拼 "/"——两侧一致才能对账
      return rel.split(/[\\/]/).join("/").toLowerCase();
    };
    const liveSet = new Set<string>();
    for (const row of versionRows) {
      const key = liveRel(row.bodyPath, bodyFilePattern);
      if (key === null) {
        counts.malformedBodyPaths += 1;
      } else {
        liveSet.add(key);
      }
    }
    for (const img of imageRows) {
      const key = liveRel(img.path, imageFilePattern);
      if (key === null) {
        counts.malformedBodyPaths += 1;
      } else {
        liveSet.add(key);
      }
    }
    // 备份引用的文件并入 live 集合（T6R.14）：行已随当前库变化，但快照仍
    // 引用的文件不是孤儿。保守模式（存在不可读快照）下整个孤儿清扫本就
    // 放弃——此并入与之独立成立。
    for (const key of backupKeepKeys) liveSet.add(key);
    // tmp 清扫的最小共用件（复审轮⑮：两扫描器共用）
    const sweepTmpFile = (filePath: string): void => {
      if (sweep(filePath)) counts.sweptTmp++;
    };
    // 单目录扫描：tmp 清扫全域通用；孤儿判定仅 notes 域启用（orphan 入参；
    // dirName 用于拼 live 集合的相对键 <noteId>/<文件名>）
    const sweepDir = (dir: string, dirName: string, orphan: boolean): void => {
      for (const name of readdirSync(dir)) {
        const filePath = join(dir, name);
        try {
          if (name.startsWith(".tmp-")) {
            sweepTmpFile(filePath);
          } else if (
            orphan &&
            !conservative && // 不可读快照在场：孤儿判定不可靠，本轮不清
            (bodyFilePattern.test(name) || imageFilePattern.test(name)) &&
            !liveSet.has(`${dirName}/${name}`.toLowerCase()) &&
            !live.has(storagePathKey(dataDir, filePath)) &&
            counts.malformedBodyPaths === 0
          ) {
            if (sweep(filePath)) counts.sweptOrphanFiles++;
          }
        } catch {
          // 文件恰好消失（在途请求刚 rename）——跳过
        }
      }
    };
    // .tmp- 前缀 = lib/blob-io.writeFileAtomic 的独有命名（ink/media/note
    // 三通道共用，复审⑧起不再是 note 独有——ink/media 换用共享原语前的
    // 旧固定名 `<名>.tmp` 后缀残留不在此列，无清扫通道）；media 的最终文件
    // 直接在 blobs/media 根下（无子目录），故根级散文件也要扫 tmp
    const sweepRoot = (root: string, orphan: boolean): void => {
      if (!existsSync(root)) return;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          sweepDir(join(root, entry.name), entry.name, orphan);
        } else if (entry.name.startsWith(".tmp-")) {
          sweepTmpFile(join(root, entry.name));
        }
      }
    };
    sweepRoot(notesRoot, true);
    sweepRoot(resolve(dataDir, "blobs", "ink"), false);
    sweepRoot(resolve(dataDir, "blobs", "media"), false);
  }
  return counts;
}
