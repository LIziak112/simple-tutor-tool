import { lintDocument } from "@tutor/md-dsl";
import type { Db } from "../db/client";
import { HttpError } from "../lib/http-error";
import { type ZipArchiveWriter, zipBufferOf } from "../lib/zip-write";
import { readSpecFile } from "../spec-files";
import { exportLectureMd, exportUnitMd } from "./library-service";
import { extractMediaImageSrcs, statMediaSrc } from "./media-service";

/**
 * 教学包 ZIP 导出（T7.8 / 方案 §4.6）：把一份单元/讲义导出为可分享的包——
 * - content.md：当前资源正文（复用 export.md：域校验 404、frontmatter 回写
 *   教学包声明）；
 * - capabilities-snapshot.json：导出时刻当前系统的能力清单（/api/public/spec
 *   同源 readSpecFile）——**仅归档供 AI 阅读，不注册能力、不覆盖运行配置**，
 *   ZIP 再导入时进解包 ignored 清单，不参与任何处理；
 * - 正文引用的本地图片按原 src 路径（blobs/media/<hash>.<ext>）随行——
 *   ZIP 导入配对规则①（相对路径完全一致）精确命中，内容寻址幂等使重导 src 不变。
 *
 * 导出前检查（清单要求）：对导出文本重跑 lint，error 级问题（含声明引用失效
 * DIRECTIVE_REF_NOT_FOUND / VALIDATOR_REF_NOT_FOUND）→ 422 LINT_ERROR，不生成包。
 * 图片缺失（文件不在盘上）跳过随行、md 引用原样保留——再导入由既有
 * IMAGE_SRC_NOT_FOUND warning 兜底，不阻断导出。
 */

/** 导出资源类型（与 export.md 同口径） */
export type TeachingPackKind = "unit" | "lecture";

/** 导出产物：zip 字节 + 附件文件名（export.md 同款 base 换 .zip 后缀） */
export interface TeachingPackExport {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly filename: string;
}

export async function exportTeachingPackZip(
  db: Db,
  teacherId: string,
  kind: TeachingPackKind,
  id: string,
  dataDir: string,
  /** 规范目录覆盖（与 /api/public/spec 同源；缺省走 spec-files 目录候选） */
  specDir?: string | undefined,
): Promise<TeachingPackExport> {
  // ① 当前资源正文（export*Md 内含域校验 404 与 teachingPack 声明回写）
  const exported =
    kind === "unit"
      ? exportUnitMd(db, teacherId, id)
      : exportLectureMd(db, teacherId, id);

  // ② 导出前检查：声明引用仍可用（error 级 lint → 不生成包）
  const { issues } = lintDocument(exported.markdown);
  const errors = issues.filter((issue) => issue.level === "error");
  const first = errors[0];
  if (first !== undefined) {
    throw new HttpError(
      422,
      "LINT_ERROR",
      `教学包导出前检查未通过（第 ${first.line} 行：${first.message}），未生成包；请修正后重试`,
      { _issues: errors },
    );
  }

  // ③ 当前系统能力清单快照（仅归档）
  const snapshot = await readSpecFile("capabilities.json", specDir);

  // ④ 收集正文引用的本地图片：statMediaSrc 是「zip 打包图片在场核对」的既定
  //    单点（question-evidence 与学情包导出共用，越界/缺失中文 reason）；
  //    缺失（reason）跳过随行，见文件头注释
  const images: { src: string; absPath: string }[] = [];
  for (const src of extractMediaImageSrcs([exported.markdown])) {
    const stat = statMediaSrc(dataDir, src);
    if (!("reason" in stat)) images.push({ src, absPath: stat.absPath });
  }

  // ⑤ 组包（文本 deflate；图片已压缩 → store 仅存储；条目名按原 src 路径写
  //    子目录，archiver 同款口径见 export-service 的 media 条目）
  const bytes = await zipBufferOf((archive: ZipArchiveWriter) => {
    archive.append(Buffer.from(exported.markdown, "utf8"), {
      name: "content.md",
    });
    archive.append(Buffer.from(snapshot.content, "utf8"), {
      name: "capabilities-snapshot.json",
    });
    for (const image of images) {
      archive.file(image.absPath, { name: image.src, store: true });
    }
  });

  return {
    bytes,
    filename: `${exported.filename.replace(/\.md$/u, "")}.zip`,
  };
}
