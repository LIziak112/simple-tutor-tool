import { z } from "zod";
import { questionRevisionIdSchema } from "./attempt-submission.ts";
import { questionSchema } from "./content.ts";

/** 内容 id 沿用源 DSL 契约，旧锚与新坐标共用，不截断合法来源。 */
export const learningContentIdSchema = questionSchema.shape.id;
const contentId = learningContentIdSchema.nullable();
/** 名称快照沿用源内容无长度上限的语义。 */
const title = z.string().nullable();

/** 稳定内容坐标与名称快照，不依赖某次作答的存续。 */
export const learningContentSchema = z.object({
  courseId: contentId,
  unitId: contentId,
  lectureId: contentId,
  sectionId: contentId,
  questionId: contentId,
  titles: z.object({ course: title, unit: title, lecture: title }),
});

/** 页面、随笔与后续 MCP 共用的版本化上下文。设备信息只用于展示。 */
export const learningContextSchema = z.object({
  schemaVersion: z.literal(1),
  content: learningContentSchema,
  session: z
    .object({
      attemptId: z.uuid(),
      questionRevisionId: questionRevisionIdSchema,
      questionNo: z.number().int().positive(),
      questionCount: z.number().int().positive(),
      settlementSeq: z.number().int().positive().nullable(),
    })
    .refine((s) => s.questionNo <= s.questionCount, "题序不能超过总题数")
    .nullable(),
  view: z
    .object({
      surface: z.enum(["attempt", "result", "lesson", "lecture", "other"]),
      layout: z.string().max(80).nullable(),
      viewId: z.string().min(1).max(160),
    })
    .nullable(),
  deviceId: z.uuid().nullable(),
});
export type LearningContext = z.infer<typeof learningContextSchema>;
