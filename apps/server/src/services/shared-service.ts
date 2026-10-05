import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { LibraryBatchData, SharedFileSummary } from "@tutor/contract";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { lectures, units } from "../db/schema";
import { HttpError } from "../lib/http-error";
import { beijingExportStampOf } from "./export-csv";
import {
  exportLectureMd,
  exportUnitMd,
  safeFilename,
} from "./library-service.ts";

/**
 * 共享目录领域服务（T2B.7，D15–D18）——DATA_DIR/shared/ 读写集中在**本模块单点**：
 * 发布（复制快照 + 伴生 meta.json）、目录列表（规模防线）、读文件（预览/导入用）、
 * 删除（教师删自己的 / 管理员删任意）。
 *
 * 路径安全（要点硬约束）：请求带进来的 filename 一律先经 sharedFilenameSchema
 * 形状校验（路由层 400），本模块再做第二道防线——resolve 拼接后必须仍位于
 * shared 目录内，且必须命中**目录扫描白名单**（readdirSync 的真实文件名集合），
 * 两道任一不过即拒绝（400 / 404），杜绝 `../` 穿越读到目录外文件。
 *
 * 目录内文件是独立快照（D16）：发布写盘后与任何资源库无关联，源资源继续修改
 * 不影响已发布文件；本地直接放入的文件（无伴生 meta）与在线发布文件同源并列
 * （D15），可预览可导入，仅管理员可删（D18）。
 */

/** 共享目录相对 DATA_DIR 的名称 */
export const SHARED_DIR_NAME = "shared";

/** 列表规模防线（D15）：最多列出前 200 个文件 */
export const SHARED_MAX_LIST_FILES = 200;

/** 列表规模防线（D15）：单文件 > 1MB 不列出 */
export const SHARED_MAX_LIST_FILE_BYTES = 1024 * 1024;

/** 伴生元数据（D16：`<同名>.md.meta.json`；发布者显示与删除权限的依据） */
export interface SharedFileMeta {
  readonly teacherId: string;
  readonly loginName: string;
  readonly publishedAt: string;
}

/** 共享目录绝对路径 */
export function sharedDirOf(dataDir: string): string {
  return join(dataDir, SHARED_DIR_NAME);
}

// ---------- 目录扫描与路径安全（单点） ----------

/** 扫描目录白名单：全部 .md 普通文件名（目录不存在 / 不可读 → 空集合） */
function scanSharedWhitelist(dataDir: string): Set<string> {
  const dir = sharedDirOf(dataDir);
  if (!existsSync(dir)) return new Set();
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return new Set();
  }
  return new Set(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name),
  );
}

/**
 * 校验并解析共享文件名 → 绝对路径（所有读/删入口必经）。
 * 形状非法（含路径分隔符等）→ 400 VALIDATION_ERROR；resolve 后越出目录 → 400；
 * 未命中目录扫描白名单（文件不存在）→ 404 SHARED_FILE_NOT_FOUND（D17）。
 */
function requireSharedMdPath(dataDir: string, filename: string): string {
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".." ||
    filename.includes("\0")
  ) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "文件名不合法（不能包含路径分隔符）",
    );
  }
  const dir = resolve(sharedDirOf(dataDir));
  const path = resolve(dir, filename);
  if (path !== join(dir, filename)) {
    // resolve 会归一化 `..` 等片段：结果不再位于目录内的拼接位置即穿越
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "文件名不合法（不能包含路径分隔符）",
    );
  }
  if (!scanSharedWhitelist(dataDir).has(filename)) {
    throw new HttpError(404, "SHARED_FILE_NOT_FOUND", "共享文件不存在");
  }
  return path;
}

/** 读取伴生 meta（`<md 文件名>.meta.json`）；缺失 / 损坏 / 形状不符 → null（本地文件） */
export function readSharedMeta(
  dataDir: string,
  filename: string,
): SharedFileMeta | null {
  const metaPath = join(sharedDirOf(dataDir), `${filename}.meta.json`);
  if (!existsSync(metaPath)) return null;
  try {
    const raw: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as Record<string, unknown>).teacherId !== "string" ||
      typeof (raw as Record<string, unknown>).loginName !== "string" ||
      typeof (raw as Record<string, unknown>).publishedAt !== "string"
    ) {
      return null;
    }
    const record = raw as {
      teacherId: string;
      loginName: string;
      publishedAt: string;
    };
    return {
      teacherId: record.teacherId,
      loginName: record.loginName,
      publishedAt: record.publishedAt,
    };
  } catch {
    return null;
  }
}

// ---------- 发布（D16：复制快照） ----------

/**
 * 写入共享目录（service 单点）：文件名 `<标题>-<登录名>-<时间戳>.md`，标题先过
 * safeFilename（D16）、登录名字符集 D2 已保证安全；时间戳固定 Asia/Shanghai
 * （§0.3 显示口径，不随服务器时区变）；同秒重名自动加序号 `-2`；
 * 同目录写伴生 `<同名>.meta.json`。返回实际写入的文件名（供成功提示展示）。
 * now 可注入（测试同秒重名序号）。
 */
export function publishToShared(
  dataDir: string,
  input: {
    markdown: string;
    title: string;
    teacherId: string;
    loginName: string;
    now?: Date;
  },
): { filename: string } {
  const dir = sharedDirOf(dataDir);
  mkdirSync(dir, { recursive: true });
  const now = input.now ?? new Date();
  const base = `${safeFilename(input.title)}-${input.loginName}-${beijingExportStampOf(now)}`;
  const whitelist = scanSharedWhitelist(dataDir);
  // 同秒重名加序号 -2、-3…（D16）；从 2 起与「无序号」形态区分
  let sequence = 1;
  let filename = `${base}.md`;
  while (whitelist.has(filename)) {
    sequence += 1;
    filename = `${base}-${sequence}.md`;
  }
  writeFileSync(join(dir, filename), input.markdown, "utf8");
  writeFileSync(
    join(dir, `${filename}.meta.json`),
    JSON.stringify({
      teacherId: input.teacherId,
      loginName: input.loginName,
      publishedAt: now.toISOString(),
    } satisfies SharedFileMeta),
    "utf8",
  );
  return { filename };
}

/**
 * 发布单元（POST /api/teacher/library/units/:id/publish）：
 * 文件内容**逐字复用** exportUnitMd 的输出（T2A.2 口径：frontmatter + 未软删各题
 * sourceMd，可往返）；文件名标题段用单元展示标题（exportUnitMd 不返回标题，此处
 * 另查行，域内 404 口径与之一致）。
 */
export function publishUnitToShared(
  db: Db,
  dataDir: string,
  teacherId: string,
  loginName: string,
  unitId: string,
): { filename: string } {
  const unit = db
    .select({ title: units.title })
    .from(units)
    .where(and(eq(units.teacherId, teacherId), eq(units.id, unitId)))
    .get();
  if (unit === undefined) {
    throw new HttpError(404, "UNIT_NOT_FOUND", "练习单元不存在");
  }
  const { markdown } = exportUnitMd(db, teacherId, unitId);
  return publishToShared(dataDir, {
    markdown,
    title: unit.title,
    teacherId,
    loginName,
  });
}

/**
 * 发布讲义（POST /api/teacher/library/lectures/:id/publish）：
 * 内容**逐字复用** exportLectureMd（`kind: lecture` frontmatter + 原文——缺了
 * frontmatter 重新导入会被识别为缺省 practice，D16）；标题 = 讲义标题。
 */
export function publishLectureToShared(
  db: Db,
  dataDir: string,
  teacherId: string,
  loginName: string,
  lectureId: string,
): { filename: string } {
  const lecture = db
    .select({ title: lectures.title })
    .from(lectures)
    .where(and(eq(lectures.teacherId, teacherId), eq(lectures.id, lectureId)))
    .get();
  if (lecture === undefined) {
    throw new HttpError(404, "LECTURE_NOT_FOUND", "讲义不存在");
  }
  const { markdown } = exportLectureMd(db, teacherId, lectureId);
  return publishToShared(dataDir, {
    markdown,
    title: lecture.title,
    teacherId,
    loginName,
  });
}

/**
 * 批量发布（POST /api/teacher/library/batch action=publish）：逐项复用上面的
 * 单项发布实现（快照语义、文件名、伴生 meta 完全一致）。单条失败逐条记录、
 * 不中断其余（越权/不存在的 id 按域口径 404 → ok=false，与 move/delete 等批量
 * 动作同一结果形状；成功项带实际写入的 filename 供前端提示）。
 */
export function batchPublishToShared(
  db: Db,
  dataDir: string,
  teacherId: string,
  loginName: string,
  input: { kind: "lecture" | "unit"; ids: string[] },
): LibraryBatchData {
  return {
    results: input.ids.map((id) => {
      try {
        const { filename } =
          input.kind === "unit"
            ? publishUnitToShared(db, dataDir, teacherId, loginName, id)
            : publishLectureToShared(db, dataDir, teacherId, loginName, id);
        return { id, ok: true, filename };
      } catch (err) {
        if (err instanceof HttpError) {
          return { id, ok: false, error: err.code, message: err.message };
        }
        return {
          id,
          ok: false,
          error: "INTERNAL",
          message: "操作失败，请稍后重试",
        };
      }
    }),
  };
}

// ---------- 轻量信息提取（D15：frontmatter / 标题级，不做完整解析） ----------

/** frontmatter 键 → 原始值（首块 `---` 围栏内；首行非 `---` 返回空 Map） */
function frontmatterOf(lines: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  if ((lines[0] ?? "").trim() !== "---") return map;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed === "---" || trimmed === "...") break;
    const sep = trimmed.indexOf(":");
    if (sep <= 0) continue;
    map.set(trimmed.slice(0, sep).trim(), trimmed.slice(sep + 1).trim());
  }
  return map;
}

/** frontmatter 值去引号（导出产物为 JSON 双引号标量；手写文件取原文） */
function unquoteYaml(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "string" && parsed.length > 0) return parsed;
  } catch {
    // 非 JSON 标量：按原文
  }
  return value;
}

/** 题目容器开始行（与 exportUnitMd/ensureQuestionId 同一形态口径） */
const QUESTION_OPEN_RE = /^:{4}question(\{.*)?$/;

/**
 * 轻量提取类型 / 标题 / 题数（D15：解析 frontmatter/标题级信息，不做完整 lint）：
 * - kind：frontmatter `kind: lecture` → lecture，其余（含 v1 与缺省）→ practice；
 * - title：讲义取首个 H1；练习取 frontmatter unit；兜底文件名去 .md 扩展名；
 * - questionCount：`::::question` 行数。
 */
function extractSummaryInfo(
  filename: string,
  markdown: string,
): {
  kind: "lecture" | "practice";
  title: string;
  questionCount: number;
} {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const fm = frontmatterOf(lines);
  const kind: "lecture" | "practice" =
    unquoteYaml(fm.get("kind")) === "lecture" ? "lecture" : "practice";
  let title: string | undefined;
  if (kind === "lecture") {
    title = lines
      .slice(1)
      .find((line) => /^#\s+.+/.test(line))
      ?.replace(/^#\s+/, "")
      .trim();
  } else {
    title = unquoteYaml(fm.get("unit"));
  }
  if (title === undefined || title.length === 0) {
    title = filename.replace(/\.md$/i, "");
  }
  let questionCount = 0;
  for (const line of lines) {
    if (QUESTION_OPEN_RE.test(line)) questionCount += 1;
  }
  return { kind, title, questionCount };
}

// ---------- 列表（D15） ----------

/** 列表查看者（canDelete 的计算口径：教师 = 发布者本人；管理员 = 全部） */
export type SharedViewer =
  | { readonly kind: "teacher"; readonly teacherId: string }
  | { readonly kind: "admin" };

/**
 * 共享目录列表（GET /api/teacher/shared 与 GET /api/admin/shared-files）：
 * 只列 ≤1MB 的 .md，按发布时间（meta.publishedAt，本地文件用 mtime）倒序，
 * 最多前 200 个（超出 truncated=true）；>1MB 的计数进 oversizeHidden 供页面提示。
 * 目录不存在 / 不可读 → 空列表（不报错，空态引导）。
 */
export function listSharedFiles(
  dataDir: string,
  viewer: SharedViewer,
): {
  files: SharedFileSummary[];
  truncated: boolean;
  oversizeHidden: number;
} {
  const dir = sharedDirOf(dataDir);
  const whitelist = scanSharedWhitelist(dataDir);
  let oversizeHidden = 0;
  const entries: Array<{
    filename: string;
    markdown: string;
    publishedAt: string;
    source: "published" | "local";
    meta: SharedFileMeta | null;
  }> = [];
  for (const filename of whitelist) {
    let size: number;
    let mtimeMs: number;
    try {
      const stat = statSync(join(dir, filename));
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      continue; // 扫描与 stat 之间被删除：跳过
    }
    if (size > SHARED_MAX_LIST_FILE_BYTES) {
      oversizeHidden += 1;
      continue;
    }
    let markdown: string;
    try {
      markdown = readFileSync(join(dir, filename), "utf8");
    } catch {
      continue;
    }
    const meta = readSharedMeta(dataDir, filename);
    entries.push({
      filename,
      markdown,
      meta,
      source: meta === null ? "local" : "published",
      publishedAt: meta?.publishedAt ?? new Date(mtimeMs).toISOString(),
    });
  }
  // 时间倒序（新发布在前）；同刻按文件名稳定排序
  entries.sort((a, b) =>
    a.publishedAt === b.publishedAt
      ? a.filename < b.filename
        ? 1
        : -1
      : a.publishedAt < b.publishedAt
        ? 1
        : -1,
  );
  const truncated = entries.length > SHARED_MAX_LIST_FILES;
  const files = entries.slice(0, SHARED_MAX_LIST_FILES).map((entry) => {
    const info = extractSummaryInfo(entry.filename, entry.markdown);
    const canDelete =
      viewer.kind === "admin"
        ? true
        : entry.meta !== null && entry.meta.teacherId === viewer.teacherId;
    return {
      filename: entry.filename,
      kind: info.kind,
      title: info.title,
      questionCount: info.questionCount,
      publisher: entry.meta?.loginName ?? null,
      publishedAt: entry.publishedAt,
      source: entry.source,
      canDelete,
    } satisfies SharedFileSummary;
  });
  return { files, truncated, oversizeHidden };
}

// ---------- 读文件（预览 / 导入共用） ----------

/** 读取共享文件原文（白名单 + resolve 双重校验后读；预览与导入的数据源） */
export function readSharedMarkdown(dataDir: string, filename: string): string {
  return readFileSync(requireSharedMdPath(dataDir, filename), "utf8");
}

// ---------- 删除（D18） ----------

/** 删除 .md 与伴生 .meta.json（删除已过白名单校验的路径；meta 不存在则跳过） */
function deleteSharedFile(dataDir: string, filename: string): void {
  const dir = sharedDirOf(dataDir);
  const mdPath = requireSharedMdPath(dataDir, filename);
  const metaPath = join(dir, `${filename}.meta.json`);
  unlinkSync(mdPath);
  if (existsSync(metaPath)) {
    try {
      unlinkSync(metaPath);
    } catch {
      // meta 删除失败不阻断主文件删除（下次发布重名序号会自然避开）
    }
  }
}

/**
 * 教师删除（DELETE /api/teacher/shared/:filename，D18）：
 * 发布者删自己的（meta.teacherId 匹配）；他人发布的或本地文件（无 meta）→
 * 403 FORBIDDEN_SHARED_FILE（本地文件仅管理员可删）。
 */
export function deleteSharedFileAsTeacher(
  dataDir: string,
  teacherId: string,
  filename: string,
): void {
  // 先只做路径校验（404 优先于 403：文件都不存在时按不存在处理，不暴露 meta 信息）
  requireSharedMdPath(dataDir, filename);
  const meta = readSharedMeta(dataDir, filename);
  if (meta === null || meta.teacherId !== teacherId) {
    throw new HttpError(
      403,
      "FORBIDDEN_SHARED_FILE",
      "只能删除自己发布的共享文件（本地放入的文件请联系管理员删除）",
    );
  }
  deleteSharedFile(dataDir, filename);
}

/** 管理员删除（DELETE /api/admin/shared-files/:filename，D18）：可删任意，含本地文件 */
export function deleteSharedFileAsAdmin(
  dataDir: string,
  filename: string,
): void {
  deleteSharedFile(dataDir, filename);
}
