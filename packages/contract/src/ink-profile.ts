import { z } from "zod";

/** 手感、账号命名配置和设备选择共用契约。预测仅用于输入层，不进入笔迹。 */
export const inkProfileConfigSchema = z
  .object({
    renderer: z.enum(["atrament", "freehand"]).default("atrament"),
    smoothing: z.number().min(0).max(1.5).default(0.35),
    thinning: z.number().min(0).max(1).default(0.35),
    streamline: z.number().min(0).max(1).default(0.15),
    sizeScale: z.number().min(0.5).max(2).default(1),
    simulatePressure: z.boolean().default(false),
    prediction: z.boolean().default(false),
    inputMode: z.enum(["pen", "finger"]).default("pen"),
    color: z.enum(["black", "blue", "red"]).default("black"),
    size: z.enum(["thin", "medium", "thick"]).default("medium"),
  })
  .strict();
/** 正文只保存绘制参数；预测和输入偏好不会成为提交证据。 */
export const inkRenderingSchema = inkProfileConfigSchema
  .pick({
    renderer: true,
    smoothing: true,
    thinning: true,
    streamline: true,
    sizeScale: true,
    simulatePressure: true,
  })
  .extend({
    renderer: inkProfileConfigSchema.shape.renderer.removeDefault(),
    smoothing: inkProfileConfigSchema.shape.smoothing.removeDefault(),
    thinning: inkProfileConfigSchema.shape.thinning.removeDefault(),
    streamline: inkProfileConfigSchema.shape.streamline.removeDefault(),
    sizeScale: inkProfileConfigSchema.shape.sizeScale.removeDefault(),
    simulatePressure:
      inkProfileConfigSchema.shape.simulatePressure.removeDefault(),
  });
export const INK_PROFILE_MAX_COUNT = 20;
export const inkProfileWriteSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    config: inkProfileConfigSchema,
  })
  .strict();
export const inkProfileUpdateSchema = inkProfileWriteSchema.extend({
  revision: z.number().int().positive(),
});
export const inkProfileSchema = inkProfileWriteSchema.extend({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  updatedAt: z.string(),
});
export const inkProfileListSchema = z.object({
  profiles: z.array(inkProfileSchema),
});
export const inkProfileOkSchema = z.object({
  ok: z.literal(true),
  data: inkProfileSchema,
});
export const inkProfileListOkSchema = z.object({
  ok: z.literal(true),
  data: inkProfileListSchema,
});
export type InkProfileConfig = z.infer<typeof inkProfileConfigSchema>;
export type InkRendering = z.infer<typeof inkRenderingSchema>;
export const inkRenderingOf = (config: InkProfileConfig): InkRendering =>
  inkRenderingSchema.strip().parse(config);
export type InkProfile = z.infer<typeof inkProfileSchema>;
export type InkProfileWrite = z.infer<typeof inkProfileWriteSchema>;
export type InkProfileUpdate = z.infer<typeof inkProfileUpdateSchema>;
export const DEFAULT_INK_PROFILE_CONFIG = inkProfileConfigSchema.parse({});
