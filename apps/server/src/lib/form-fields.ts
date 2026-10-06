import type { NoteImageUploadMeta } from "@tutor/contract";
import { noteImageUploadMetaSchema } from "@tutor/contract";
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
export function parseNoteImageUploadForm(form: LooseFormBody): {
  png: File;
  meta: NoteImageUploadMeta;
} {
  const image = form.image;
  if (!(image instanceof File)) {
    throw new HttpError(400, "VALIDATION_ERROR", IMAGE_FORM_HINT);
  }
  const parsed = noteImageUploadMetaSchema.safeParse({
    spec: formString(form, "spec"),
    pageIndex: strictFormInt(form, "pageIndex"),
    crop: {
      x: strictFormInt(form, "cropX"),
      y: strictFormInt(form, "cropY"),
      width: strictFormInt(form, "cropW"),
      height: strictFormInt(form, "cropH"),
    },
    pixelWidth: strictFormInt(form, "pixelWidth"),
    pixelHeight: strictFormInt(form, "pixelHeight"),
  });
  if (!parsed.success) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      `补图元信息不合法：${firstIssueMessage(parsed.error)}`,
    );
  }
  return { png: image, meta: parsed.data };
}
