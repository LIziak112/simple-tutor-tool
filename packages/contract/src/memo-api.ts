import { z } from "zod";
import {
  learningContentIdSchema,
  learningContextSchema,
} from "./learning-context.ts";

/** 在本文件内把成功响应壳的 data 具体化（不从 index.ts 导入，避免循环依赖） */
function apiOkExtend<T extends z.ZodType>(dataSchema: T) {
  return z.object({ ok: z.literal(true), data: dataSchema });
}

/**
 * 随笔契约（2026-11-10，个人学习迭代模块 5 第一步「随笔记录端」）。
 *
 * 实体口径（第 3 版计划 §8 / 问题清单 Q16、Q17、B8）：
 * - 一条随笔 = 学习者本人在任意设备随手记下的一段东西：文字 / 语音 / 图片 /
 *   手写，四种形态第一批都收；原始随笔**不可变**（只追加，本人可删），整理稿
 *   是以后（模块 5 第二步）的派生版本，不改原文；
 * - 每条自动带**上下文锚**（记录时在哪道题 / 哪篇讲义，或无锚）与可选标签
 *   （易错 / 疑问 / 待办 …，≤ 5 个）；锚只是回链，不参与权限；
 * - **默认仅本人**：未逐条授权时教师不可见；Agent 经本人 token
 *   （学生 / 个人 MCP）可读本人随笔、可代为转记（source=agent）；
 * - 媒体（语音 / 图片 / 手写 PNG）按内容寻址存 blobs/memos/<sha256>.<ext>，
 *   格式只认文件内容；语音原格式落盘不转码（线上无 ffmpeg），转写在 Agent 侧；
 * - 离线也能记：客户端生成 clientId，服务端按 (学生, clientId) 幂等——同一条
 *   补传多次只落一行。
 *
 * 错误码（统一 ApiErr 壳）：
 * - MEMO_NOT_FOUND（404）：不存在 / 已删 / 不是本人（不暴露存在性）；
 * - MEMO_TOO_LARGE（413）：语音超 20 MB 或图片 / 手写超 10 MB；
 * - MEMO_METADATA_TOO_LARGE（413）：请求信封或来源等元数据总字节超限，整条拒绝；
 * - MEMO_UNSUPPORTED_TYPE（415）：按内容识别不是支持的音频 / 图片格式；
 * - MEMO_MEDIA_TOO_LARGE_FOR_MCP（413）：MCP 取件超过内联字节预算。
 */

/** 文字随笔 / 媒体随笔说明文字的长度上限（字符） */
export const MEMO_TEXT_MAX = 5000;
/** 来源、标签、设备和设备时间等元数据按序列化 JSON 的 UTF-8 总字节计，保留完整合法值。 */
export const MEMO_METADATA_MAX_BYTES = 64 * 1024;
/** JSON 信封额外容纳正文最坏的 JSON 转义（每 UTF-16 单元最多 6 字节）和固定字段。 */
export const MEMO_JSON_BODY_MAX_BYTES =
  MEMO_METADATA_MAX_BYTES + MEMO_TEXT_MAX * 6 + 1024;
export const MEMO_METADATA_TOO_LARGE = "MEMO_METADATA_TOO_LARGE";
export const MEMO_METADATA_LIMIT_MESSAGE =
  "随笔请求或来源元数据过大，请精简后重试";
/** 单个标签长度上限（字符）与每条标签个数上限 */
export const MEMO_TAG_MAX = 20;
export const MEMO_TAGS_MAX = 5;
/** 快捷标签只在契约定义，所有输入仍受相同数量与长度限制。 */
export const MEMO_PRESET_TAGS = [
  "易错",
  "疑问",
  "待办",
  "灵感",
  "复习",
] as const;
/** 语音：单条 ≤ 20 MB、≤ 10 分钟（Q16 默认取法） */
export const MEMO_VOICE_MAX_BYTES = 20 * 1024 * 1024;
export const MEMO_VOICE_MAX_SECONDS = 600;
/** 图片 / 手写 PNG：单张 ≤ 10 MB（手机实拍一页纸质笔记在此之内） */
export const MEMO_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** MCP 取件（get_memo_media）内联 base64 的原始字节预算 */
export const MEMO_MCP_MEDIA_MAX_BYTES = 8 * 1024 * 1024;
/** 锚的展示文案上限（如「第 3 题 · 导数专项」） */
export const MEMO_ANCHOR_LABEL_MAX = 120;

/** 随笔形态 */
export const memoKindSchema = z.enum(["text", "voice", "image", "ink"]);
export type MemoKind = z.infer<typeof memoKindSchema>;

/** 来源：self 本人在界面记的 / agent Agent 经 MCP 代为转记的 */
export const memoSourceSchema = z.enum(["self", "agent"]);
export type MemoSource = z.infer<typeof memoSourceSchema>;

/** 记录设备（展示 + 整理时的上下文；客户端自报，不做权限用） */
export const memoDeviceSchema = z.enum([
  "phone",
  "tablet",
  "desktop",
  "agent",
  "other",
]);
export type MemoDevice = z.infer<typeof memoDeviceSchema>;

/** 语音文件格式（按内容魔数识别；浏览器 MediaRecorder 原格式：Safari mp4/m4a、Chrome webm/ogg） */
export const memoVoiceFormatSchema = z.enum([
  "webm",
  "mp4",
  "m4a",
  "ogg",
  "wav",
  "mp3",
]);
export type MemoVoiceFormat = z.infer<typeof memoVoiceFormatSchema>;

/** 图片 / 手写格式（与 ::image 媒体管线同一白名单） */
export const memoImageFormatSchema = z.enum(["png", "jpg", "webp", "gif"]);
export type MemoImageFormat = z.infer<typeof memoImageFormatSchema>;

export const memoMediaFormatSchema = z.enum([
  ...memoVoiceFormatSchema.options,
  ...memoImageFormatSchema.options,
]);
export type MemoMediaFormat = z.infer<typeof memoMediaFormatSchema>;

/** 媒体 MIME（下载直出 / MCP 内联共用） */
export const MEMO_MEDIA_CONTENT_TYPE: Record<MemoMediaFormat, string> = {
  webm: "audio/webm",
  mp4: "audio/mp4",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/**
 * 上下文锚（B8 首轮：当前题 / 讲义节 / 无锚；附件页码锚等模块 6 第二步）。
 * label 在记录时就定下来（「第 3 题 · 导数专项」），以后题目 / 讲义改名或
 * 删除也不影响回看；id 只用于回链跳转。
 */
export const memoAnchorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("question"),
    attemptId: z.string().min(1).max(80),
    questionId: learningContentIdSchema,
    label: z.string().trim().min(1).max(MEMO_ANCHOR_LABEL_MAX),
  }),
  z.object({
    kind: z.literal("lecture"),
    lectureId: learningContentIdSchema,
    /** 讲义小节 id（有则锚到节；无则锚到整篇） */
    sectionId: learningContentIdSchema.nullable(),
    label: z.string().trim().min(1).max(MEMO_ANCHOR_LABEL_MAX),
  }),
  z.object({ kind: z.literal("none") }),
]);
export type MemoAnchor = z.infer<typeof memoAnchorSchema>;

export const MEMO_ANCHOR_NONE: MemoAnchor = { kind: "none" };

/** 写入口与来源展开后的元数据共用计量；读侧不截断历史记录。 */
export interface MemoMetadataInput {
  readonly anchor?: unknown;
  readonly context?: unknown;
  readonly tags?: unknown;
  readonly device?: unknown;
  readonly deviceId?: unknown;
  readonly recordedAt?: unknown;
}
/** 标签：去首尾空白、非空、≤ 20 字、≤ 5 个、去重（服务端再去重一次） */
export const memoTagsSchema = z
  .array(z.string().trim().min(1).max(MEMO_TAG_MAX))
  .max(MEMO_TAGS_MAX);

/** 媒体元信息（列表只给元信息，字节走 memoMediaUrl / MCP get_memo_media） */
export const memoMediaSchema = z.object({
  format: memoMediaFormatSchema,
  bytes: z.number().int().positive(),
  /** 语音时长（秒，客户端录制时自报；图片为 null） */
  durationSec: z.number().int().nonnegative().nullable(),
});
export type MemoMedia = z.infer<typeof memoMediaSchema>;

/** 一条随笔（列表 / 创建响应 / MCP 共用） */
export const memoSchema = z.object({
  id: z.uuid(),
  /** 本人递增序号；可选以兼容旧服务端与离线缓存。新写入始终有值。 */
  seq: z.number().int().positive().optional(),
  parentMemoSeq: z.number().int().positive().nullable().optional(),
  context: learningContextSchema.nullable().optional(),
  deviceId: z.uuid().nullable().optional(),
  kind: memoKindSchema,
  /** 文字随笔的正文；媒体随笔的可选说明（没有为 null） */
  text: z.string().max(MEMO_TEXT_MAX).nullable(),
  /** 媒体元信息；文字随笔为 null */
  media: memoMediaSchema.nullable(),
  anchor: memoAnchorSchema,
  tags: memoTagsSchema,
  source: memoSourceSchema,
  device: memoDeviceSchema,
  /** 服务端收到时间：UTC ISO */
  createdAt: z.string().min(1),
  /** 设备上记下的时间（离线补传时早于 createdAt）：UTC ISO；缺省同 createdAt */
  recordedAt: z.string().min(1),
});
export type Memo = z.infer<typeof memoSchema>;

/** 创建随笔共用字段（文字 JSON 与媒体 multipart 文本字段都按它校验） */
export const memoCreateBaseSchema = z.object({
  /** 客户端生成的 UUID；(学生, clientId) 幂等键——离线补传重复只落一行 */
  clientId: z.uuid(),
  context: learningContextSchema.optional(),
  deviceId: z.uuid().optional(),
  anchor: memoAnchorSchema.optional(),
  tags: memoTagsSchema.optional(),
  device: memoDeviceSchema.optional(),
  /** 设备上记下的时间（UTC ISO；缺省 = 服务端时间） */
  recordedAt: z.iso.datetime({ offset: true }).optional(),
});

/** POST /api/student/memos（JSON）：文字随笔 */
export const memoCreateTextSchema = memoCreateBaseSchema.extend({
  text: z.string().trim().min(1).max(MEMO_TEXT_MAX),
});
export type MemoCreateText = z.infer<typeof memoCreateTextSchema>;

/** 浏览器补传声明的队列归属，必须与请求实际会话匹配。 */
export const MEMO_OUTBOX_ACCOUNT_HEADER = "x-tutor-memo-account";
export const MEMO_OUTBOX_ACCOUNT_CHANGED = "MEMO_OUTBOX_ACCOUNT_CHANGED";

/**
 * POST /api/student/memos/media（multipart）：语音 / 图片 / 手写。文件走 file
 * 字段；其余为文本字段（anchor / tags 为 JSON 字符串，路由先 JSON.parse 再按
 * 本 schema 校验）。
 */
export const memoCreateMediaSchema = memoCreateBaseSchema.extend({
  kind: z.enum(["voice", "image", "ink"]),
  /** 媒体随笔的可选说明 */
  text: z.string().trim().max(MEMO_TEXT_MAX).optional(),
  /** 语音时长（秒）；图片 / 手写不传 */
  durationSec: z.number().int().min(0).max(MEMO_VOICE_MAX_SECONDS).optional(),
});
export type MemoCreateMedia = z.infer<typeof memoCreateMediaSchema>;

/** GET /api/student/memos 查询：时间倒序、游标分页、可按形态 / 标签 / 锚过滤 */
export const memoListQuerySchema = z.object({
  seq: z.coerce.number().int().positive().optional(),
  questionId: learningContentIdSchema.optional(),
  parentMemoSeq: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  /** 上一页返回的 nextCursor */
  cursor: z.string().min(1).max(200).optional(),
  kind: memoKindSchema.optional(),
  tag: z.string().trim().min(1).max(MEMO_TAG_MAX).optional(),
  /** 只看锚在某次作答 / 某篇讲义上的 */
  attemptId: z.string().min(1).max(80).optional(),
  lectureId: learningContentIdSchema.optional(),
  /** 只看这个时刻之后记的（recordedAt ≥ since；Agent 增量读） */
  since: z.iso.datetime({ offset: true }).optional(),
});
export type MemoListQuery = z.infer<typeof memoListQuerySchema>;

export const memoListDataSchema = z.object({
  memos: z.array(memoSchema),
  /** 还有更早的就给游标，否则 null */
  nextCursor: z.string().nullable(),
});
export type MemoListData = z.infer<typeof memoListDataSchema>;

/**
 * MCP add_memo（Agent 转记）入参：正文必填；锚可选——Agent 报 id（须是本人
 * 可见的作答 / 讲义，否则 404），label 可省，省略时服务端按作答单元 / 讲义
 * 标题生成。
 */
export const memoAgentCreateSchema = z.object({
  /** 同一操作重试复用此 UUID；省略时保留旧客户端每次新增行为。 */
  operationId: z.uuid().optional(),
  parentMemoSeq: z.number().int().positive().optional(),
  text: z.string().trim().min(1).max(MEMO_TEXT_MAX),
  tags: memoTagsSchema.optional(),
  anchor: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("question"),
        attemptId: z.string().min(1).max(80),
        questionId: learningContentIdSchema,
        label: z.string().trim().min(1).max(MEMO_ANCHOR_LABEL_MAX).optional(),
      }),
      z.object({
        kind: z.literal("lecture"),
        lectureId: learningContentIdSchema,
        sectionId: learningContentIdSchema.nullable().optional(),
        label: z.string().trim().min(1).max(MEMO_ANCHOR_LABEL_MAX).optional(),
      }),
    ])
    .optional(),
  recordedAt: z.iso.datetime({ offset: true }).optional(),
});
export type MemoAgentCreate = z.infer<typeof memoAgentCreateSchema>;

export const memoOkSchema = apiOkExtend(memoSchema);
export const memoListOkSchema = apiOkExtend(memoListDataSchema);

/** 媒体直出 URL（<audio> / <img> 直接引用；同源 Cookie 鉴权，仅本人） */
export function memoMediaUrl(memoId: string): string {
  return `/api/student/memos/${encodeURIComponent(memoId)}/media`;
}

/** 形态文案 */
export const MEMO_KIND_LABEL: Record<MemoKind, string> = {
  text: "文字",
  voice: "语音",
  image: "图片",
  ink: "手写",
};

/** 语音时长展示：62 → 「1:02」 */
export function formatMemoDuration(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

/** 标签规范化：去空白、去空、去重、截断到上限（两端共用，服务端落库前再做一次） */
export function normalizeMemoTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === "" || tag.length > MEMO_TAG_MAX || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MEMO_TAGS_MAX) break;
  }
  return out;
}
