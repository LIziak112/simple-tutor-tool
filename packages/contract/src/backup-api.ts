import { z } from "zod";

/**
 * 备份与恢复 API 契约（T4.5 起为权威定义，依据 Phase4 清单 §2 D20/D21 与 §4 T4.5）：
 * 快照列表、恢复请求（multipart）与恢复摘要的 data 部分；错误码。
 *
 * 口径（D20 备份范围，用户定）：
 * - 下载备份含主库快照、内核库快照及配套工件（如有内核）、blobs/、shared/、secret.key，
 *   排除 backups/。两库用 VACUUM INTO 捕获已提交数据；
 * - 日常自动快照只含主库（启动时 + 每 24h，保留 14 份轮转）；
 * - 备份/恢复是**整库操作**：多教师共存一个库（D14 一生一师但同库），
 *   主机指定的有效管理员才可查看快照、下载或恢复，恢复仍需登录密码（D21）。
 *
 * 恢复安全（D21，用户定）：
 * - 恢复请求必须带**登录密码**（multipart 的 password 字段），服务端 scrypt 校验，
 *   错误密码 → 403 BACKUP_INVALID_PASSWORD；
 * - 服务端执行顺序：预检 zip → 同卷暂存与校验 → 确认独占后做一次主库快照 →
 *   记录替换计划并切换 DATA_DIR 内容（保留 backups/）→ 重开数据连接；
 * - 恢复后以**恢复库中的会话**为准：当前登录会话可能失效，属预期——
 *   响应携带 sessionWarning=true，UI 据此提示重新登录。
 *
 * 下载响应（GET /api/teacher/backup/download）是 zip 文件直出、无 JSON schema，
 * 响应头约定（与 /export/learning-pack 同模式）：
 * - content-type: application/zip；
 * - content-disposition: attachment; filename="tutor-backup-<北京时间戳>.zip"；
 * - cache-control: no-store；
 * - zip 内主库文件命名为 tutor-YYYYMMDD-HHMMSS.db，双库归档加入内核库、清单及固定工件。
 *
 * 恢复请求（POST /api/teacher/backup/restore）为 multipart/form-data（与笔迹上传同模式）：
 * - 字段 zip：File（备份 zip 全量字节）；
 * - 字段 password：string（当前教师登录密码，非空）。
 * hc RPC 对 multipart 路由推断不出 form 入参类型，前端用同构 fetch 直调
 * （见 apps/web/src/lib/api.ts），本文件仍权威定义响应 data 与错误码。
 */

/** 备份上传体积上限（zip 文件本身）：256 MB（一对一自部署规模留足余量） */
export const BACKUP_MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

/**
 * multipart 整包 body 预检上限（content-length 比较，app.ts 路由前置中间件）：
 * zip 上限 + boundary/头部等开销余量 1 MB。
 */
export const BACKUP_UPLOAD_BODY_LIMIT = BACKUP_MAX_UPLOAD_BYTES + 1024 * 1024;

/** 快照保留份数（超出删最旧；启动 + 每 24h + 下载兜底 + 恢复前保险共用同一轮转） */
export const BACKUP_KEEP_COUNT = 14;

/** 快照文件命名：tutor-YYYYMMDD-HHMMSS.db（北京时间；同秒冲突加 -2/-3 序号） */
export const BACKUP_SNAPSHOT_NAME_PATTERN = /^tutor-\d{8}-\d{6}(-\d+)?\.db$/;

/** 双库归档的固定顶层文件及内容指纹。无内核数据引用的旧归档可省略这组文件。 */
export const BACKUP_KERNEL_DATABASE = "learning-kernel.sqlite";
export const BACKUP_KERNEL_MANIFEST = "learning-kernel-backup.json";
export const BACKUP_KERNEL_ARTIFACT = "learning-kernel-artifact.tgz";
export const backupKernelManifestSchema = z.strictObject({
  formatVersion: z.literal(1),
  productSha256: z.hash("sha256"),
  kernelSha256: z.hash("sha256"),
  kernelSchemaVersion: z.number().int().positive(),
  kernelArtifactSha256: z.hash("sha256"),
});

// ---------- 快照列表 ----------

/** 最近快照项（GET /api/teacher/backup/snapshots 的 data 元素） */
export const backupSnapshotSchema = z.object({
  /** 文件名（tutor-YYYYMMDD-HHMMSS.db） */
  filename: z.string().min(1),
  /** 快照创建时间（文件 mtime，UTC ISO 字符串） */
  createdAt: z.string().min(1),
  /** 文件大小（字节） */
  sizeBytes: z.number().int().min(0),
});

/** 快照列表响应 data（按创建时间倒序，最多 BACKUP_KEEP_COUNT 个） */
export const backupSnapshotListDataSchema = z.object({
  snapshots: z.array(backupSnapshotSchema),
});

// ---------- 恢复摘要 ----------

/**
 * 恢复响应 data（POST /api/teacher/backup/restore）。
 * restoredFiles = 落位 DATA_DIR 的文件总数（两库、secret.key 和 blobs/shared
 * 递归文件，归档校验元数据仅在暂存使用）；snapshotTime = 从 zip 内主库文件名解析的快照时点（北京时间戳转
 * UTC ISO；zip 内为 tutor.db（非快照命名）时为 null，表示无法判定时点）。
 */
export const backupRestoreResultSchema = z.object({
  /** zip 内的 db 文件名（快照命名或 tutor.db；实际落位统一更名为 DATA_DIR/tutor.db） */
  dbFilename: z.string().min(1),
  /** 快照时点（UTC ISO）；zip 内 db 非 tutor-YYYYMMDD-HHMMSS.db 命名时为 null */
  snapshotTime: z.string().nullable(),
  /** 恢复写入的文件总数（数据库、secret.key 和 blobs/shared 递归文件） */
  restoredFiles: z.number().int().min(1),
  /** 当前登录会话可能已失效（恢复库中的会话为准）——UI 据此提示重新登录 */
  sessionWarning: z.literal(true),
});

// ---------- 错误码 ----------

export const BACKUP_OPERATOR_REQUIRED = "BACKUP_OPERATOR_REQUIRED";

/**
 * 备份相关错误码（鉴权 401 见 auth.ts）：
 * - BACKUP_OPERATOR_REQUIRED：当前会话无整站备份权限（403）；
 * - BACKUP_INVALID_PASSWORD：恢复时登录密码不正确（403，D21）；
 * - BACKUP_ZIP_INVALID：zip 损坏、结构不符、双库不匹配或缺少必需文件（400）；
 * - BACKUP_TOO_LARGE：恢复上传或 ZIP 展开预算超限（413）；
 * - BACKUP_ROLLBACK_FAILED：自动回滚未完成，保留旧数据暂存目录并保持数据库关闭（500）；
 * - BACKUP_RESTORE_FAILED：进程占用、另一次恢复或恢复标记冲突（409），或替换 DATA_DIR 失败（500）。
 */
export const backupErrorCodeSchema = z.enum([
  BACKUP_OPERATOR_REQUIRED,
  "BACKUP_INVALID_PASSWORD",
  "BACKUP_ZIP_INVALID",
  "BACKUP_TOO_LARGE",
  "BACKUP_RESTORE_FAILED",
  "BACKUP_ROLLBACK_FAILED",
]);

// ---------- 具体化的成功壳 ----------

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({
    ok: z.literal(true),
    data: dataSchema,
  });
}

export const backupSnapshotListOkSchema = apiOkExtend(
  backupSnapshotListDataSchema,
);
export const backupRestoreOkSchema = apiOkExtend(backupRestoreResultSchema);

// ---------- 推断类型导出 ----------

export type BackupSnapshot = z.infer<typeof backupSnapshotSchema>;
export type BackupSnapshotList = z.infer<typeof backupSnapshotListDataSchema>;
export type BackupRestoreResult = z.infer<typeof backupRestoreResultSchema>;
