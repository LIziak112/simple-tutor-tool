import { z } from "zod";

/** 学生账号在当前浏览器中的展示偏好；不包含对话、材料或凭据。 */
export const studentAiDisplayPreferenceSchema = z.object({
  version: z.literal(1).default(1),
  layout: z.enum(["inline", "side", "dialog"]).default("inline"),
});
export type StudentAiDisplayPreference = z.infer<
  typeof studentAiDisplayPreferenceSchema
>;
export type StudentAiDisplayLayout = StudentAiDisplayPreference["layout"];
