import type {
  AnnotationBaseImageMeta,
  AnnotationUploadMeta,
  NoteImageUploadMeta,
} from "@tutor/contract";
import {
  ANNOTATION_BASE_IMAGE_FORM_FIELDS,
  ANNOTATION_FORM_FIELDS,
  annotationPhaseSchema,
  annotationUploadMetaSchema,
  NOTE_IMAGE_FORM_FIELDS,
  noteImageUploadMetaSchema,
} from "@tutor/contract";
import { firstIssueMessage, HttpError } from "./http-error";

/**
 * multipart 表单字段的共享解析（T6R.4/T6R.5）：
 * - strictFormInt：严格十进制整数串 → number（T6R.4 复审③口径——Number("")
 *   ===0 / Number("  ")===0 / 科学计数 / 十六进制 / 小数一律不转，交契约
 *   schema 出 400；JSON 通道的 number 形态契约不变，此转换属 multipart
 *   传输层）；
 * - parseNoteImageUploadForm：补图 POST（学生 ⑤ / 教师 ⑧）共用的字段集
 *   组装——image 文件 + spec/pageIndex/cropX/cropY/cropW/cropH/pixelWidth/
 *   pixelHeight 八个元信息字段 → 契约 noteImageUploadMetaSchema 校验。
 * 两处路由（student.ts / teacher.ts）共用一份，不各自手抄字段清单。
 */

/** parseBody 的宽松字段形态（值形态不定，读取处 typeof 收窄；复审轮⑬简化） */
export type LooseFormBody = Record<string, unknown>;

/** multipart 字符串字段严格十进制整数解析；非字符串/非严格形态返回 undefined */
export function strictFormInt(
  form: LooseFormBody,
  key: string,
): number | undefined {
  const raw = form[key];
  if (typeof raw !== "string") return undefined;
  return /^\d+$/.test(raw) ? Number(raw) : undefined;
}

/** multipart 字符串字段原样读取（非字符串字段返回 undefined） */
export function formString(
  form: LooseFormBody,
  key: string,
): string | undefined {
  const raw = form[key];
  return typeof raw === "string" ? raw : undefined;
}

/** 补图上传的 multipart 形态约束（字段名集与错误文案，两端口径一致） */
const IMAGE_FORM_HINT =
  "请求需为 multipart/form-data，且包含 image 文件与 spec、pageIndex、cropX、cropY、cropW、cropH、pixelWidth、pixelHeight 字段";

/**
 * 解析补图上传表单：image 文件 + 元信息字段 → { png, meta }。
 * - image 必须是文件字段（字符串字段说明客户端组装错误）→ 400 VALIDATION_ERROR；
 * - 元信息字段经严格整数/字符串读取后组装 crop 形状，过契约
 *   noteImageUploadMetaSchema（crop 越硬上限 / 像素维超上限 / 非法枚举
 *   均 400 VALIDATION_ERROR）；
 * - PNG 字节本身的魔数/尺寸/限额校验在 note-service.attachNoteImage。
 */
export async function parseNoteImageUploadForm(form: LooseFormBody): Promise<{
  pngBytes: Uint8Array;
  meta: NoteImageUploadMeta;
}> {
  const image = form[NOTE_IMAGE_FORM_FIELDS.image];
  if (!(image instanceof File)) {
    throw new HttpError(400, "VALIDATION_ERROR", IMAGE_FORM_HINT);
  }
  // 字段名走契约单一来源（NOTE_IMAGE_FORM_FIELDS）——与 web 客户端
  // postNoteImageApi 同一张表，两端不各自手抄字符串（T6R.6 复审⑪）
  const F = NOTE_IMAGE_FORM_FIELDS;
  const parsed = noteImageUploadMetaSchema.safeParse({
    spec: formString(form, F.spec),
    pageIndex: strictFormInt(form, F.pageIndex),
    crop: {
      x: strictFormInt(form, F.cropX),
      y: strictFormInt(form, F.cropY),
      width: strictFormInt(form, F.cropW),
      height: strictFormInt(form, F.cropH),
    },
    pixelWidth: strictFormInt(form, F.pixelWidth),
    pixelHeight: strictFormInt(form, F.pixelHeight),
  });
  if (!parsed.success) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `补图元信息不合法：${firstIssueMessage(parsed.error)}`,
    );
  }
  // 字节在解析层一次读出（复审轮⑮：两路由不再各自 arrayBuffer 转换）
  const pngBytes = new Uint8Array(await image.arrayBuffer());
  return { pngBytes, meta: parsed.data };
}

/** 标注底图上传的 multipart 形态约束（字段名集与错误文案，单一来源） */
const ANNOTATION_BASE_IMAGE_FORM_HINT =
  "请求需为 multipart/form-data，且包含 image 文件与 questionRevisionId、baseRenderVersion 字段（phase 可选，缺省 scratch）";

/**
 * 标注 phase 参数解析（T6R.20，查询参数与表单字段共用）：缺省 scratch；
 * 非法值 400（值域单源 annotationPhaseSchema）。学生/教师两路由共用。
 */
export function parseAnnotationPhaseParam(raw: string | undefined) {
  const parsed = annotationPhaseSchema.safeParse(raw ?? "scratch");
  if (!parsed.success) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "标注 phase 不合法（只接受 scratch 或 correction）",
    );
  }
  return parsed.data;
}

/**
 * 解析标注底图上传表单（T6R.20 学生端唯一上传方）：image 文件＋客户端回传
 * 身份字段 → { pngBytes, meta }。
 * - image 必须是文件字段 → 400 VALIDATION_ERROR；
 * - questionRevisionId 非空串、baseRenderVersion 严格十进制整数、phase 缺省
 *   scratch（经 annotationPhaseSchema 校验）；
 * - PNG 字节本身的魔数/宽度/限额校验在 annotation-service.registerBaseImage。
 */
export async function parseAnnotationBaseImageForm(
  form: LooseFormBody,
): Promise<{ pngBytes: Uint8Array; meta: AnnotationBaseImageMeta }> {
  const F = ANNOTATION_BASE_IMAGE_FORM_FIELDS;
  const image = form[F.image];
  if (!(image instanceof File)) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      ANNOTATION_BASE_IMAGE_FORM_HINT,
    );
  }
  const baseRenderVersion = strictFormInt(form, F.baseRenderVersion);
  const phase = formString(form, F.phase);
  const parsedPhase = annotationPhaseSchema.safeParse(phase ?? "scratch");
  if (!parsedPhase.success) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      "标注 phase 不合法（只接受 scratch 或 correction）",
    );
  }
  const questionRevisionId = formString(form, F.questionRevisionId);
  if (
    questionRevisionId === undefined ||
    questionRevisionId.length === 0 ||
    baseRenderVersion === undefined
  ) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      ANNOTATION_BASE_IMAGE_FORM_HINT,
    );
  }
  const pngBytes = new Uint8Array(await image.arrayBuffer());
  return {
    pngBytes,
    meta: {
      questionRevisionId,
      baseRenderVersion,
      phase: parsedPhase.data,
    },
  };
}

/** 标注正文上传的 multipart 形态约束（字段名集与错误文案，单一来源） */
const ANNOTATION_UPLOAD_FORM_HINT =
  "请求需为 multipart/form-data，且包含 body 文件与 baseRevision、mutationId 字段";

/**
 * 解析标注正文上传表单（T6R.20 学生端 PUT …/annotation；审查修复 13 从
 * student.ts 内联收敛——与笔记/底图表单同分层）：body 文件（gzip 或原始
 * JSON）＋baseRevision/mutationId/phase 字段 → { bodyBytes, meta }。
 * - body 必须是文件字段 → 400 VALIDATION_ERROR；
 * - 元信息经严格整数/字符串读取后过契约 annotationUploadMetaSchema（越界/
 *   非法 phase 均 400 VALIDATION_ERROR）；
 * - 正文字节的 gzip/限额/schema 校验在 annotation-service.putAnnotationDoc。
 */
export async function parseAnnotationUploadForm(
  form: LooseFormBody,
): Promise<{ bodyBytes: Uint8Array; meta: AnnotationUploadMeta }> {
  const F = ANNOTATION_FORM_FIELDS;
  const body = form[F.body];
  if (!(body instanceof File)) {
    throw new HttpError(400, "VALIDATION_ERROR", ANNOTATION_UPLOAD_FORM_HINT);
  }
  const parsed = annotationUploadMetaSchema.safeParse({
    baseRevision: strictFormInt(form, F.baseRevision),
    mutationId: formString(form, F.mutationId),
    phase: formString(form, F.phase),
  });
  if (!parsed.success) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `标注上传元信息不合法：${firstIssueMessage(parsed.error)}`,
    );
  }
  return { bodyBytes: new Uint8Array(await body.arrayBuffer()), meta: parsed.data };
}
