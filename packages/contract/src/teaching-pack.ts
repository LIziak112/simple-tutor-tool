import { z } from "zod";

/**
 * 教学包声明契约（T7.8 / 方案 §4.6）：教学方法即文档的最小分发单元。
 *
 * teachingPack 是 frontmatter 的可选命名空间——一份 DSL 文档 + 能力声明引用：
 * - 它是**依赖声明**，不是能力定义：能力面从当前系统清单（capabilities.json）
 *   解析，声明不复制定义、不覆盖题型路由、不要求列齐正文实际使用的全部指令；
 * - name/version 仅是分享标签（导入仍按既有资源键与教师域合并，无版本升级算法）；
 * - directives 引用已注册指令名（别名经注册表归一，lint 校验存在性），
 *   validators 引用题型能力表的内置 validatorId；
 * - 无该字段就是普通 MD，行为与现状完全一致。
 *
 * strictObject 拒绝未知键：声明是教师/AI 手写数据，拼写错误 fail fast
 * （frontmatter 校验失败 → INVALID_FRONTMATTER error），不静默丢弃半份声明。
 * 引用存在性（DIRECTIVE_REF_NOT_FOUND / VALIDATOR_REF_NOT_FOUND）由 md-dsl
 * lint 层校验——schema 只管形状，注册表是运行期事实。
 */
export const teachingPackSchema = z.strictObject({
  /** 声明格式版本；当前唯一支持 1（缺省 1） */
  formatVersion: z.literal(1).default(1),
  /** 教学包名称（分享时的展示名，非空必填） */
  name: z.string().min(1, "teachingPack.name 不能为空"),
  /** 版本标签（教师自维护的分享标记；缺省字符串 "1"，改版本 = 改标签重导） */
  version: z.string().min(1, "teachingPack.version 不能为空").default("1"),
  /** 依赖的指令引用（已注册名称，别名合法；缺省空数组 = 不声明指令依赖） */
  directives: z.array(z.string().min(1)).default([]),
  /** 依赖的校验器引用（题型能力表 validatorId；缺省空数组） */
  validators: z.array(z.string().min(1)).default([]),
});
export type TeachingPack = z.infer<typeof teachingPackSchema>;
