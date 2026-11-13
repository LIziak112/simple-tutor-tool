import { z } from "zod";
import {
  learningPackEvidenceStateSchema,
  learningPackManifestMissingSchema,
} from "./learning-pack.ts";

// ---------- 预览响应（POST …/review-pack/preview） ----------

/** 预览文件清单行（zip 内路径 + 用户可读分类 + 预估字节） */
export const reviewPackPreviewFileSchema = z.object({
  path: z.string().min(1),
  kind: z.enum([
    "pack",
    "review",
    "schema",
    "question-md",
    "media",
    "evidence",
    "ink",
    // T6R.20 新增（只增不改）：题干标注成对附件（底图 PNG＋笔迹 JSON）
    "annotation",
    // LR-PR3 新增（只增不改，学习记录模型设计稿 §7.2）：按角色投影的
    // LearningRecord（record.json + record-schema.json）
    "record",
  ]),
  bytes: z.number().int().min(0),
  refs: z.array(z.string()).default([]),
});

/** 逐张图片附件行（真实图片单独下载用；missing 附原因） */
export const reviewPackAttachmentSchema = z.object({
  path: z.string().min(1),
  kind: z.enum(["media", "evidence", "ink", "annotation"]),
  state: z.enum(["ready", "missing"]),
  /** ready：实测字节；missing：0 */
  bytes: z.number().int().min(0),
  /** missing 原因（中文，用户可读） */
  reason: z.string().min(1).optional(),
  /** 逐张下载 URL（仅 ready 携带：媒体走公开 /blobs、证据图走学生/教师直出端点） */
  downloadUrl: z.string().min(1).optional(),
});

/** 预览响应 data（对话框数据源；reviewMd 与 zip 内 review.md 逐字节一致） */
export const reviewPackPreviewDataSchema = z.object({
  role: z.enum(["student", "teacher"]),
  questionNo: z.number().int().min(1),
  /** 交卷快照是否存在（false=题目已删/升级遗留，stemMd 为空） */
  questionPresent: z.boolean(),
  /** 手写作答题（solve/apply/find-error）：作答即笔迹、无草稿层属正常（文案分叉用） */
  handwritten: z.boolean(),
  evidenceState: learningPackEvidenceStateSchema,
  /** 学生视角答案公布态（教师恒 true；未公布时前端提示「无判定属正常」） */
  released: z.boolean(),
  /** 包内是否携带参考答案/判定（教师 true；学生恒 false） */
  answersIncluded: z.boolean(),
  /** 全部附件在场才为 true（有缺失=false，前端据此渲染不完整警示） */
  complete: z.boolean(),
  files: z.array(reviewPackPreviewFileSchema),
  missing: z.array(learningPackManifestMissingSchema),
  attachments: z.array(reviewPackAttachmentSchema),
  /** review.md 全文（复制文字载荷的上半；与 zip 内文件逐字节一致） */
  reviewMd: z.string(),
  /** questions/qNNN/stem.md 全文（复制文字载荷的下半——题面+学生答案〔教师包含参考答案/判定〕） */
  questionMd: z.string(),
});

export type ReviewPackPreviewFile = z.infer<typeof reviewPackPreviewFileSchema>;
export type ReviewPackAttachment = z.infer<typeof reviewPackAttachmentSchema>;
export type ReviewPackPreviewData = z.infer<typeof reviewPackPreviewDataSchema>;
