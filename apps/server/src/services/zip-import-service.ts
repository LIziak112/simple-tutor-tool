import type { ImportCommitData, ImportPreviewData } from "@tutor/contract";
import type { Db } from "../db/client";
import { HttpError } from "../lib/http-error";
import type { ZipEntry } from "../lib/zip-read";
import { readZipEntries, ZipReadError } from "../lib/zip-read";
import { getCapabilityProfile } from "./capability-profile-service";
import { commitImport, previewImport } from "./content-service";
import { saveMedia } from "./media-service";

/**
 * ZipImportService——AI 侧 zip 打包上传导入（MCP import_zip 工具的服务端实现）。
 *
 * 场景：AI 客户端把若干内容 Markdown 与其引用的图片打成一个 zip，一次调用完成
 * 「解包 → md/图片配对 → 上传被引用图片 → 改写 ::image src → 逐份导入」。
 * 网页端等价物是导入页的「随行图片」（apps/web 的 companion-media.ts）——本模块
 * 与之**语义对齐但独立实现**（不抽共享包，两端各自的口径差异写清注释）：
 * - 服务端 extractMediaImageSrcs（media-service）只认严格哈希形态
 *   （blobs/media/<64hex>.<ext>）——它核对的是「服务端已上传文件」的存在性；
 * - 本模块与前端 companion-media 一样匹配**任意** ::image src 文件名——要配对的
 *   是 zip 内的本地文件名（AI 生成文档里的图片名是模型起的标识，与内容真实
 *   sha256 不一致），配对规则与前端三条硬口径完全一致：
 *   ① src 与 zip 条目相对路径完全一致 → 优先配对；
 *   ② 否则 basename（文件名）全局唯一匹配；
 *   ③ basename 命中多个条目 → 冲突，不配对不改写（宁可提示消除歧义，
 *     不冒「静默传错图」的险）；
 *   ④ 配不上的引用不改写；外链 URL（scheme / 协议相对 //）一律归未配对。
 *
 * 硬口径（同前端）：只上传被任一 md 引用到的图片（未引用的 zip 图片不上传、
 * 不落盘）；改写只动「配对成功且上传成功」的 src 引号内值，md 其余内容逐字节
 * 不变；配不上 / 冲突 / 上传失败的引用原样保留，由导入侧 IMAGE_SRC_NOT_FOUND
 * （严格形态引用）与本工具报告的未配对清单兜底。
 *
 * 部分失败不回滚整体（与网页批量导入一致）：图片逐张独立上传（魔数白名单与
 * 5MB 上限由 saveMedia 自然生效），每份 md 独立事务 commitImport，结果逐项
 * 如实呈现。
 */

// ---------- 限额（MCP import_zip 的解包上限，见工具描述） ----------

/** zip 内文件条目数上限 */
export const ZIP_IMPORT_MAX_ENTRIES = 300;
/** 单个解压条目字节上限（与图片上传 5MB 同量级） */
export const ZIP_IMPORT_MAX_ENTRY_BYTES = 5 * 1024 * 1024;
/** 全部条目解压后合计字节上限 */
export const ZIP_IMPORT_MAX_TOTAL_BYTES = 48 * 1024 * 1024;

/** md 条目名（任意层级；.md / .markdown 大小写不敏感，与 fallbackUnitIdOf 扩展名口径一致） */
const MD_ENTRY_NAME_PATTERN = /\.(md|markdown)$/i;
/** 图片条目名（扩展名与 saveMedia 魔数白名单同族；真实格式仍由上传时的魔数判定） */
const IMAGE_ENTRY_NAME_PATTERN = /\.(png|jpe?g|webp|gif)$/i;

// ---------- base64 解码与解包 ----------

/**
 * 解码 import_zip 的 dataBase64（与 upload_image 同口径）：
 * 容忍传输层折行（剥离全部空白后校验标准形态）；url-safe（-/_）等其他编码
 * 不给静默误解码，直接中文报错指导重新编码。
 */
export function decodeImportZipBase64(
  dataBase64: string,
  zipName: string,
): Buffer {
  const compact = dataBase64.replace(/\s+/g, "");
  if (
    compact.length === 0 ||
    compact.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)
  ) {
    throw new HttpError(
      400,
      "INVALID_BASE64",
      `「${zipName}」的 dataBase64 不是合法 base64（需标准字母表 A-Z a-z 0-9 + / 与至多两个 = 填充），请重新编码后重试`,
    );
  }
  return Buffer.from(compact, "base64");
}

/** 解包产物：zip 内的 md 文件、图片条目与「既非 md 也非图片」的忽略清单 */
export interface ZipImportBundle {
  /** 全部 .md 条目（zip 内相对路径 + 解码文本，顺序与中央目录一致） */
  readonly mdFiles: ReadonlyArray<{
    readonly path: string;
    readonly markdown: string;
  }>;
  /** 全部图片扩展名条目（无论是否被引用；上传阶段只取被引用者） */
  readonly imageEntries: ReadonlyArray<{
    readonly name: string;
    readonly data: Uint8Array;
  }>;
  /** 既非 .md 也非图片扩展名的条目名（报告中如实列出，不参与任何处理） */
  readonly ignoredFiles: readonly string[];
}

/**
 * 解包并校验 import zip：
 * - 读取走 lib/zip-read（只读、逐条 CRC、条目名安全校验拒穿越）——ZipReadError
 *   （损坏 / 非 zip / 不安全条目名 / ZIP64 / 加密）转 400 ZIP_INVALID，
 *   中文说明原样透传；
 * - 限额（超限 413 ZIP_TOO_LARGE）：条目 ≤300、单条目 ≤5MB、解压后合计 ≤48MB；
 * - 按扩展名三分：.md（任意层级）解码为文本、图片条目保留字节、其余进忽略清单；
 * - 一个 .md 都没有 → 400 ZIP_NO_MARKDOWN（没有可导入的内容）。
 */
export function unpackImportZip(zipBytes: Uint8Array): ZipImportBundle {
  let entries: ZipEntry[];
  try {
    entries = readZipEntries(
      Buffer.from(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength),
    );
  } catch (err) {
    if (err instanceof ZipReadError) {
      throw new HttpError(400, "ZIP_INVALID", `压缩包无法解析：${err.message}`);
    }
    throw err;
  }
  if (entries.length > ZIP_IMPORT_MAX_ENTRIES) {
    throw new HttpError(
      413,
      "ZIP_TOO_LARGE",
      `压缩包条目数超过上限（最多 ${ZIP_IMPORT_MAX_ENTRIES} 个文件，当前 ${entries.length} 个），请分批导入`,
    );
  }
  let totalBytes = 0;
  for (const entry of entries) {
    if (entry.data.byteLength > ZIP_IMPORT_MAX_ENTRY_BYTES) {
      throw new HttpError(
        413,
        "ZIP_TOO_LARGE",
        `压缩包内文件「${entry.name}」超过单文件 5 MB 上限，请移出该文件或压缩后重试`,
      );
    }
    totalBytes += entry.data.byteLength;
  }
  if (totalBytes > ZIP_IMPORT_MAX_TOTAL_BYTES) {
    throw new HttpError(
      413,
      "ZIP_TOO_LARGE",
      `压缩包解压后合计超过 48 MB 上限（当前约 ${Math.round(totalBytes / 1024 / 1024)} MB），请分批导入`,
    );
  }

  const mdFiles: { path: string; markdown: string }[] = [];
  const imageEntries: { name: string; data: Uint8Array }[] = [];
  const ignoredFiles: string[] = [];
  for (const entry of entries) {
    if (MD_ENTRY_NAME_PATTERN.test(entry.name)) {
      mdFiles.push({ path: entry.name, markdown: decodeMarkdown(entry.data) });
    } else if (IMAGE_ENTRY_NAME_PATTERN.test(entry.name)) {
      imageEntries.push({ name: entry.name, data: entry.data });
    } else {
      ignoredFiles.push(entry.name);
    }
  }
  if (mdFiles.length === 0) {
    throw new HttpError(
      400,
      "ZIP_NO_MARKDOWN",
      "压缩包内没有 .md 文件，没有可导入的内容",
    );
  }
  return { mdFiles, imageEntries, ignoredFiles };
}

/** 解码 md 条目为 UTF-8 文本：与网页端 File.text() 对齐去掉开头 BOM（留着会破坏首行 frontmatter 识别） */
function decodeMarkdown(data: Buffer): string {
  const text = data.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---------- 配对与改写（纯函数，口径对齐前端 companion-media，独立实现） ----------

/** 跨平台分隔符取 basename（zip 条目名恒为 / 分隔；src 侧防御性容忍 \） */
export function basenameOf(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/**
 * 外链 / 内联数据 URI 判定：带 URL scheme（http:、https:、data: …，scheme 至少
 * 2 字符——单字母 + 冒号是 Windows 盘符不是协议）或协议相对 `//` 开头的 src
 * 不可能与 zip 内文件配对（DSL 本就只支持 blobs/ 路径，外链由 lint
 * IMAGE_SRC_NOT_BLOBS 警告），直接归入未配对。
 */
export function isExternalSrc(src: string): boolean {
  return /^[a-z][a-z0-9+.-]{1,}:/i.test(src) || src.startsWith("//");
}

/**
 * 从 md 文本提取 ::image 引用的 src（任意文件名形态，去重保序）。
 * 正则与指令语法同构：`::image{…src="值"…}`，属性行内（不跨行）、双引号值；
 * 与 media-service extractMediaImageSrcs 的口径差异见文件头注释。
 */
export function extractImageRefs(markdowns: readonly string[]): string[] {
  // 字面量求值即新对象（同 media-service 口径：避免共享 /g 实例跨调用串 lastIndex）
  const pattern = /::image\{[^}\n]*?\bsrc="([^"\n}]+)"/g;
  const seen = new Set<string>();
  for (const md of markdowns) {
    for (const match of md.matchAll(pattern)) {
      const src = match[1];
      if (src !== undefined) seen.add(src);
    }
  }
  // Set 保插入序：同图多处引用只收集一次，顺序稳定可测
  return [...seen];
}

/** 配对结果（refs 全部来自当前 zip 内 md 的 ::image 引用，全局去重后） */
export interface ZipImagePairing {
  /** 配对成功：md 里的 src → zip 内条目名（多个 src 可指向同一条目） */
  readonly pairs: ReadonlyMap<string, string>;
  /** basename 冲突：同名条目有多个，无法确定配哪张 → 不配对、不改写 */
  readonly conflicts: ReadonlyArray<{
    readonly src: string;
    readonly name: string;
  }>;
  /** 未配对（无匹配条目 / 外链 URL）：不改写，原样进导入 */
  readonly unmatched: readonly string[];
}

/**
 * 配对规则（顺序即优先级，与前端 pairImageRefs 一致）：
 * ① src 与 zip 条目相对路径完全一致 → 优先配对；
 * ② 否则 basename 全局唯一匹配（md 引用常不带目录前缀）；
 * ③ basename 命中多个条目 → 冲突，不配对；
 * ④ 配不上的引用不改写；外链 URL（isExternalSrc）不参与匹配、归未配对。
 */
export function pairImageRefs(
  refs: readonly string[],
  imageEntryNames: readonly string[],
): ZipImagePairing {
  const exactNames = new Set(imageEntryNames);
  const byName = new Map<string, string[]>();
  for (const name of imageEntryNames) {
    const base = basenameOf(name);
    const list = byName.get(base);
    if (list === undefined) byName.set(base, [name]);
    else list.push(name);
  }

  const pairs = new Map<string, string>();
  const conflicts: { src: string; name: string }[] = [];
  const unmatched: string[] = [];
  for (const src of refs) {
    if (isExternalSrc(src)) {
      unmatched.push(src);
      continue;
    }
    // ① 相对路径完全一致（zip 条目名在包内唯一）
    if (exactNames.has(src)) {
      pairs.set(src, src);
      continue;
    }
    // ② basename 唯一匹配；③ 多候选 → 冲突
    const base = basenameOf(src);
    const sameName = byName.get(base) ?? [];
    if (sameName.length === 1) {
      const only = sameName[0];
      if (only !== undefined) pairs.set(src, only);
      continue;
    }
    if (sameName.length >= 2) {
      conflicts.push({ src, name: base });
      continue;
    }
    // ④ 无匹配
    unmatched.push(src);
  }
  return { pairs, conflicts, unmatched };
}

/**
 * 把 md 中配对成功并已上传的 ::image src 改写为服务端返回的真实路径。
 * 只替换匹配到的 src 属性值（引导的属性行、alt/width 等不受影响），其余内容
 * 逐字节不变；rewrites 里没有的 src（冲突 / 未配对 / 上传失败）原样保留。
 * 函数式替换：返回串里的 $ 等字符按字面处理。
 */
export function rewriteImageSrcs(
  markdown: string,
  rewrites: ReadonlyMap<string, string>,
): string {
  if (rewrites.size === 0) return markdown;
  return markdown.replace(
    /::image\{([^}\n]*?)\bsrc="([^"\n}]+)"/g,
    (whole: string, lead: string, src: string): string => {
      const to = rewrites.get(src);
      return to === undefined ? whole : `::image{${lead}src="${to}"`;
    },
  );
}

// ---------- 编排：dry-run 预览与 confirm 执行 ----------

/** 一次 zip 导入的公共输入（解码与解包产物 + 目标文件夹 + zip 留档名） */
export interface ZipImportRunInput {
  readonly bundle: ZipImportBundle;
  /** 目标资源库文件夹；null = 未归类 */
  readonly folderId: string | null;
  /** zip 展示名（缺省 mcp-import.zip），报告回显用 */
  readonly zipName: string;
}

/** 配对的中间产物：配对结果 + 按条目聚合的引用清单 + 条目字节索引 */
interface ZipImagePlan {
  readonly pairing: ZipImagePairing;
  /** 配对成功的 zip 条目名 → 引用它的 src 清单（Map 保插入序，输出稳定） */
  readonly srcsByEntry: ReadonlyMap<string, readonly string[]>;
  /** 图片条目名 → 解压字节（上传与 dry-run 体积展示用） */
  readonly dataByName: ReadonlyMap<string, Uint8Array>;
  /** 被 md 引用到的条目名（配对目标 ∪ 冲突候选；其余 = 未引用不上传） */
  readonly referencedEntryNames: ReadonlySet<string>;
}

/** 配对计算（dry-run 与 confirm 共用，一次算好） */
function planZipImages(bundle: ZipImportBundle): ZipImagePlan {
  const refs = extractImageRefs(bundle.mdFiles.map((file) => file.markdown));
  const names = bundle.imageEntries.map((entry) => entry.name);
  const pairing = pairImageRefs(refs, names);
  const srcsByEntry = new Map<string, string[]>();
  for (const [src, entry] of pairing.pairs) {
    const list = srcsByEntry.get(entry);
    if (list === undefined) srcsByEntry.set(entry, [src]);
    else list.push(src);
  }
  const dataByName = new Map(
    bundle.imageEntries.map((entry) => [entry.name, entry.data] as const),
  );
  // 被「引用到」= 配对目标（将上传）∪ 冲突候选（被引用但歧义不上传）；
  // 两者之外才是真正未被引用的 zip 图片
  const referencedEntryNames = new Set<string>(pairing.pairs.values());
  for (const { name } of pairing.conflicts) {
    for (const candidate of names) {
      if (basenameOf(candidate) === name) referencedEntryNames.add(candidate);
    }
  }
  return { pairing, srcsByEntry, dataByName, referencedEntryNames };
}

/** 单份 md 的配对视图（从全局配对结果中筛出该文件涉及的引用） */
function fileImageRefs(
  refs: readonly string[],
  pairing: ZipImagePairing,
): {
  paired: { src: string; zipEntry: string }[];
  conflicts: { src: string; name: string }[];
  unmatched: string[];
} {
  const paired: { src: string; zipEntry: string }[] = [];
  for (const src of refs) {
    const entry = pairing.pairs.get(src);
    if (entry !== undefined) paired.push({ src, zipEntry: entry });
  }
  return {
    paired,
    conflicts: pairing.conflicts.filter((c) => refs.includes(c.src)),
    unmatched: pairing.unmatched.filter((src) => refs.includes(src)),
  };
}

/** dry-run 单文件条目：lint/动作预览 + 该文件的配对视图 */
export interface ZipImportDryRunFile {
  readonly path: string;
  readonly summary: ImportPreviewData["summary"];
  readonly issues: ImportPreviewData["issues"];
  readonly actions: ImportPreviewData["actions"];
  readonly warnings: ImportPreviewData["warnings"];
  readonly images: {
    readonly paired: ReadonlyArray<{
      readonly src: string;
      readonly zipEntry: string;
    }>;
    readonly conflicts: ReadonlyArray<{
      readonly src: string;
      readonly name: string;
    }>;
    readonly unmatched: readonly string[];
  };
}

/** dry-run 报告（零写入：不落库、不上传任何图片） */
export interface ZipImportDryRunReport {
  readonly confirmed: false;
  readonly dryRun: true;
  readonly zipName: string;
  readonly files: readonly ZipImportDryRunFile[];
  readonly images: {
    /** 将上传的图片张数（按 zip 条目去重；同图多 md / 多 src 只传一次） */
    readonly uploadCount: number;
    readonly uploads: ReadonlyArray<{
      readonly zipEntry: string;
      readonly bytes: number;
      readonly referencedSrcs: readonly string[];
    }>;
    readonly conflicts: ZipImagePairing["conflicts"];
    readonly unmatched: readonly string[];
    /** zip 内未被任何 md 引用的图片（不会上传，仅提示） */
    readonly notReferenced: readonly string[];
  };
  readonly ignoredFiles: readonly string[];
  readonly notice: string;
}

/**
 * dry-run 预览（零写入）：逐 md lint + 动作预览 + 配对总览。
 * previewImport 的 dataDir 传 undefined——图片还没上传，此刻报
 * IMAGE_SRC_NOT_FOUND 会误导 AI（配对 / 冲突 / 未配对状态由本报告单独给出）。
 */
export function previewZipImport(
  db: Db,
  teacherId: string,
  input: ZipImportRunInput,
): ZipImportDryRunReport {
  const { bundle, folderId, zipName } = input;
  const plan = planZipImages(bundle);

  const files: ZipImportDryRunFile[] = bundle.mdFiles.map((file) => {
    const preview = previewImport(
      db,
      teacherId,
      {
        markdown: file.markdown,
        filename: basenameOf(file.path),
        folderId,
      },
      undefined,
    );
    return {
      path: file.path,
      summary: preview.summary,
      issues: preview.issues,
      actions: preview.actions,
      warnings: preview.warnings,
      images: fileImageRefs(extractImageRefs([file.markdown]), plan.pairing),
    };
  });

  const uploads = [...plan.srcsByEntry].map(([entry, srcs]) => ({
    zipEntry: entry,
    bytes: plan.dataByName.get(entry)?.byteLength ?? 0,
    referencedSrcs: [...srcs],
  }));

  return {
    confirmed: false,
    dryRun: true,
    zipName,
    files,
    images: {
      uploadCount: uploads.length,
      uploads,
      conflicts: [...plan.pairing.conflicts],
      unmatched: [...plan.pairing.unmatched],
      notReferenced: bundle.imageEntries
        .filter((entry) => !plan.referencedEntryNames.has(entry.name))
        .map((entry) => entry.name),
    },
    ignoredFiles: [...bundle.ignoredFiles],
    notice:
      "以上为 dry-run 预览：未写库、未上传任何图片。确认无误后带 confirm=true 再次调用 import_zip，将上传被引用的图片、改写引用并逐份导入（每份 md 独立事务，部分失败不回滚整体）",
  };
}

/** confirm 阶段单张图片的上传结果 */
export interface ZipImportImageUploadResult {
  readonly zipEntry: string;
  readonly bytes: number;
  readonly referencedSrcs: readonly string[];
  /** 成功时的真实 src（blobs/media/<hash>.<ext>）；失败为 null */
  readonly src: string | null;
  /** 失败原因（saveMedia 的 415 UNSUPPORTED_MEDIA_TYPE / 413 MEDIA_TOO_LARGE）；成功为 null */
  readonly error: { readonly code: string; readonly message: string } | null;
}

/** confirm 阶段单份 md 的导入结果（成功 / 结构化失败） */
export type ZipImportFileResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly report: ImportCommitData;
      /** 未改写（冲突 / 未配对 / 图片上传失败）而原样保留的引用清单 */
      readonly unresolvedRefs: readonly string[];
    }
  | {
      readonly ok: false;
      readonly path: string;
      /** commitImport 的业务错误（422 LINT_ERROR 附 _issues 等原样透传） */
      readonly error: {
        readonly code: string;
        readonly message: string;
      } & Record<string, unknown>;
      readonly unresolvedRefs: readonly string[];
    };

/** confirm 报告（部分失败不回滚：逐项如实呈现） */
export interface ZipImportConfirmReport {
  readonly confirmed: true;
  readonly zipName: string;
  readonly images: {
    readonly uploaded: number;
    readonly failed: number;
    readonly results: readonly ZipImportImageUploadResult[];
  };
  readonly files: readonly ZipImportFileResult[];
  readonly notice: string;
}

/**
 * confirm 执行（写库 + 落盘）：
 * ① 对配对成功的图片逐张 saveMedia（内容寻址幂等；未被任何 md 引用的 zip 图片
 *    不上传；单张失败不阻断其余）；
 * ② 用返回的真实 src 改写各 md（只动配对且上传成功的 src 引号内值）；
 * ③ 逐份 commitImport（带 dataDir——存在性核对此时真实生效；sourcePath 留档
 *    `zip:<zip内路径>`）。每份独立事务，部分失败不回滚整体。
 */
export function commitZipImport(
  db: Db,
  teacherId: string,
  dataDir: string,
  input: ZipImportRunInput,
): ZipImportConfirmReport {
  const { bundle, folderId, zipName } = input;
  const plan = planZipImages(bundle);

  // ① 上传被引用图片（逐张独立；saveMedia 魔数白名单 / 5MB 校验自然生效）
  const results: ZipImportImageUploadResult[] = [];
  const srcByEntry = new Map<string, string>();
  for (const [entry, srcs] of plan.srcsByEntry) {
    const data = plan.dataByName.get(entry);
    if (data === undefined) continue; // 理论不可达（pairs 的值必来自 imageEntries），防御
    try {
      const saved = saveMedia(dataDir, data);
      srcByEntry.set(entry, saved.src);
      results.push({
        zipEntry: entry,
        bytes: saved.bytes,
        referencedSrcs: srcs,
        src: saved.src,
        error: null,
      });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err; // 非业务异常交给上层统一 500
      results.push({
        zipEntry: entry,
        bytes: data.byteLength,
        referencedSrcs: srcs,
        src: null,
        error: { code: err.code, message: err.message },
      });
    }
  }

  // ② 改写映射：仅「配对成功且上传成功」的 src → 真实 src
  const rewrites = new Map<string, string>();
  for (const [src, entry] of plan.pairing.pairs) {
    const realSrc = srcByEntry.get(entry);
    if (realSrc !== undefined) rewrites.set(src, realSrc);
  }

  // ③ 逐份导入（独立事务；rewrites 里没有的引用原样保留）。
  // T7.7：教师启用集整批查一次（逐文件 commitImport 内不再各查一遍 teachers）
  const enabledCapabilities = getCapabilityProfile(
    db,
    teacherId,
  ).enabledCapabilities;
  const files: ZipImportFileResult[] = bundle.mdFiles.map((file) => {
    const rewritten = rewriteImageSrcs(file.markdown, rewrites);
    const refs = extractImageRefs([file.markdown]);
    const unresolvedRefs = refs.filter((src) => !rewrites.has(src));
    try {
      const report = commitImport(
        db,
        teacherId,
        {
          markdown: rewritten,
          filename: basenameOf(file.path),
          folderId,
          sourcePath: `zip:${file.path}`,
        },
        dataDir,
        enabledCapabilities,
      );
      return { ok: true, path: file.path, report, unresolvedRefs };
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      return {
        ok: false,
        path: file.path,
        error: { code: err.code, message: err.message, ...(err.extra ?? {}) },
        unresolvedRefs,
      };
    }
  });

  return {
    confirmed: true,
    zipName,
    images: {
      uploaded: results.filter((r) => r.error === null).length,
      failed: results.filter((r) => r.error !== null).length,
      results,
    },
    files,
    notice:
      "配对冲突、未配对或图片上传失败的引用未改写、原样保留在导入原文中；其中 blobs/media/ 严格形态的引用可再经 import_markdown dry-run 看到 IMAGE_SRC_NOT_FOUND 警告",
  };
}
