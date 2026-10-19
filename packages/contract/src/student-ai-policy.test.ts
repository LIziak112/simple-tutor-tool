import { expect, it } from "vitest";
import type { z } from "zod";
import {
  AI_PROMPT_TEMPLATE_MAX_CHARS,
  AI_QUICK_BUTTON_MAX_COUNT,
  AI_QUICK_BUTTON_NAME_MAX_CHARS,
  AI_QUICK_BUTTON_PROMPT_MAX_CHARS,
  aiPolicyErrorCodeSchema,
  aiPolicyInheritableModeSchema,
  aiPolicyOverrideDataSchema,
  aiPolicyOverridePutRequestSchema,
  aiPolicyResolutionSchema,
  aiTeacherSettingsDataSchema,
  aiTeacherSettingsPutRequestSchema,
  DEFAULT_AI_PROMPT_TEMPLATES,
  DEFAULT_AI_TEACHER_MODE,
  DEFAULT_QUICK_BUTTONS,
  studentQuickButtonsPutRequestSchema,
} from "./student-ai-policy";

/**
 * SAI-02 教学配置与预设契约测试（B01 批次断言表逐行落地）。
 * 泄露边界双断言口径（允许时断言答案确实外发、禁止时断言学生可读响应无答案）
 * 适用于学生端 AI 接口的路由层测试；本文件只锁配置契约本身：
 * 裁决结果是服务端输出（aiPolicyResolutionSchema 仅作响应），学生请求
 * 携带 effectiveMode/teacherId 等越权字段一律按 strict 契约拒绝。
 */

/** 取一个合法按钮做变异基底（不直接改 DEFAULT_QUICK_BUTTONS 常量） */
const baseButton = { ...DEFAULT_QUICK_BUTTONS[0] };

/** 断言输入被 schema 拒绝且首条校验信息含指定片段（中文报错口径） */
function expectRejectsWith<T extends z.ZodType>(
  schema: T,
  input: unknown,
  fragment: string,
): void {
  const result = schema.safeParse(input);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues[0]?.message).toContain(fragment);
  }
}

it("新账号/无配置默认开放伴学，继承与显式开放在配置空间可区分", () => {
  expect(DEFAULT_AI_TEACHER_MODE).toBe("open_study");
  expect(
    aiTeacherSettingsDataSchema.parse({
      defaultMode: "open_study",
      promptsOpen: null,
      promptsGuided: null,
      promptsReview: null,
      updatedAt: "2026-10-15T00:00:00.000Z",
    }).defaultMode,
  ).toBe("open_study");
  // 继承是显式第四值，序列化为 "inherit" 而不是折叠成 open_study
  expect(aiPolicyInheritableModeSchema.parse("inherit")).toBe("inherit");
  expect(aiPolicyInheritableModeSchema.parse("guided_only")).toBe(
    "guided_only",
  );
  // 学生/作业覆盖响应：存储值 inherit 与有效裁决 open_study 并存可往返
  expect(
    aiPolicyOverrideDataSchema.parse({
      mode: "inherit",
      resolution: {
        usable: true,
        mode: "open_study",
        reason: "teacher_default",
      },
    }).mode,
  ).toBe("inherit");
});

it("学生请求伪造 effectiveMode/teacherId 等越权字段被 strict 契约拒绝", () => {
  expect(
    studentQuickButtonsPutRequestSchema.safeParse({
      buttons: DEFAULT_QUICK_BUTTONS,
      effectiveMode: "open_study",
      teacherId: "t-1",
    }).success,
  ).toBe(false);
  expect(
    aiPolicyOverridePutRequestSchema.safeParse({
      mode: "open_study",
      effectiveMode: "open_study",
    }).success,
  ).toBe(false);
  // 裁决是服务端输出：不可用时不携带回答尺度，可用时必有 mode
  expect(
    aiPolicyResolutionSchema.safeParse({
      usable: false,
      mode: "open_study",
      reason: "student_closed",
    }).success,
  ).toBe(false);
  expect(
    aiPolicyResolutionSchema.safeParse({
      usable: true,
      reason: "teacher_default",
    }).success,
  ).toBe(false);
  expect(
    aiPolicyResolutionSchema.parse({ usable: false, reason: "student_closed" })
      .reason,
  ).toBe("student_closed");
});

it("空白名称、空模板与超限内容给出明确中文校验失败", () => {
  expect(AI_QUICK_BUTTON_NAME_MAX_CHARS).toBe(16);
  expect(AI_QUICK_BUTTON_PROMPT_MAX_CHARS).toBe(500);
  expect(AI_PROMPT_TEMPLATE_MAX_CHARS).toBe(8000);
  expect(AI_QUICK_BUTTON_MAX_COUNT).toBe(12);

  expectRejectsWith(
    studentQuickButtonsPutRequestSchema,
    { buttons: [{ ...baseButton, name: "  " }] },
    "名称",
  );
  expectRejectsWith(
    studentQuickButtonsPutRequestSchema,
    { buttons: [{ ...baseButton, prompt: "" }] },
    "提示词",
  );
  expectRejectsWith(
    aiTeacherSettingsPutRequestSchema,
    { promptsGuided: "   " },
    "模板",
  );
  // 超限：按钮名 17 字、按钮提示词 501 字、模板 8001 字
  expect(
    studentQuickButtonsPutRequestSchema.safeParse({
      buttons: [{ ...baseButton, name: "名".repeat(17) }],
    }).success,
  ).toBe(false);
  expect(
    studentQuickButtonsPutRequestSchema.safeParse({
      buttons: [{ ...baseButton, prompt: "字".repeat(501) }],
    }).success,
  ).toBe(false);
  expect(
    aiTeacherSettingsPutRequestSchema.safeParse({
      promptsOpen: "模".repeat(8001),
    }).success,
  ).toBe(false);
});

it("presets 全部删除合法，契约不强制恢复四个默认按钮", () => {
  expect(
    studentQuickButtonsPutRequestSchema.safeParse({ buttons: [] }).success,
  ).toBe(true);
});

it("同一 ID 重复与排序冲突不能留下不确定列表", () => {
  expectRejectsWith(
    studentQuickButtonsPutRequestSchema,
    { buttons: [baseButton, { ...baseButton }] },
    "重复",
  );
  const other = {
    ...DEFAULT_QUICK_BUTTONS[1],
    orderIndex: baseButton.orderIndex,
  };
  expectRejectsWith(
    studentQuickButtonsPutRequestSchema,
    { buttons: [baseButton, other] },
    "顺序",
  );
  // 超过 12 个按钮拒绝
  const tooMany = Array.from({ length: 13 }, (_, i) => ({
    ...baseButton,
    id: `btn-${i}`,
    orderIndex: i,
  }));
  expect(
    studentQuickButtonsPutRequestSchema.safeParse({ buttons: tooMany }).success,
  ).toBe(false);
});

it("教师正式模板与学生按钮提示词分开字段，互相携带即拒绝", () => {
  // 学生按钮请求携带教师模板字段 → 拒绝
  expect(
    studentQuickButtonsPutRequestSchema.safeParse({
      buttons: [{ ...baseButton, promptsGuided: "教师模板" }],
    }).success,
  ).toBe(false);
  // 教师设置请求携带学生按钮字段 → 拒绝
  expect(
    aiTeacherSettingsPutRequestSchema.safeParse({
      promptsGuided: "教师模板",
      buttons: [],
    }).success,
  ).toBe(false);
});

it("默认四按钮的名称、提示词与附件选择符合需求钉死项", () => {
  expect(DEFAULT_QUICK_BUTTONS.map((b) => b.name)).toEqual([
    "启发下一步",
    "查当前步骤",
    "讲核心概念",
    "完整拆解",
  ]);
  for (const button of DEFAULT_QUICK_BUTTONS) {
    expect(button.prompt.trim().length).toBeGreaterThan(0);
    expect(button.enabled).toBe(true);
  }
  expect(new Set(DEFAULT_QUICK_BUTTONS.map((b) => b.id)).size).toBe(4);
  // 需求 §4.2：「查当前步骤」默认附带已有非空书写材料
  expect(DEFAULT_QUICK_BUTTONS[1]?.attachmentPref).toEqual({
    annotation: true,
    draft: true,
    formalInk: true,
  });
  // 需求 §4.2：「讲概念」默认不附图
  expect(DEFAULT_QUICK_BUTTONS[2]?.attachmentPref).toEqual({
    annotation: false,
    draft: false,
    formalInk: false,
  });
  // 默认按钮本身可整组作为 PUT 载荷（恢复默认 = 显式提交默认值）
  expect(
    studentQuickButtonsPutRequestSchema.safeParse({
      buttons: DEFAULT_QUICK_BUTTONS,
    }).success,
  ).toBe(true);
});

it("默认提示词模板三键齐全，恢复默认（显式 null）合法", () => {
  expect(Object.keys(DEFAULT_AI_PROMPT_TEMPLATES).sort()).toEqual([
    "guided",
    "open",
    "review",
  ]);
  for (const body of Object.values(DEFAULT_AI_PROMPT_TEMPLATES)) {
    expect(body.trim().length).toBeGreaterThan(0);
    expect(body.length).toBeLessThanOrEqual(AI_PROMPT_TEMPLATE_MAX_CHARS);
  }
  expect(
    aiTeacherSettingsPutRequestSchema.safeParse({
      promptsOpen: null,
      promptsGuided: null,
      promptsReview: null,
    }).success,
  ).toBe(true);
});

it("默认回答帮助学生回到解题，并使用前端支持的数学格式", () => {
  for (const body of Object.values(DEFAULT_AI_PROMPT_TEMPLATES)) {
    expect(body).toContain("下一步");
    expect(body).toContain("数学公式");
    expect(body).toContain("不虚构");
  }
});

it("暂存提交带可选 baseUpdatedAt 版本锚点，非字符串拒绝", () => {
  expect(
    studentQuickButtonsPutRequestSchema.safeParse({
      buttons: [],
      baseUpdatedAt: "2026-10-15T00:00:00.000Z",
    }).success,
  ).toBe(true);
  expect(
    studentQuickButtonsPutRequestSchema.safeParse({
      buttons: [],
      baseUpdatedAt: 123,
    }).success,
  ).toBe(false);
  expect(
    aiTeacherSettingsPutRequestSchema.safeParse({
      defaultMode: "guided_only",
      baseUpdatedAt: "2026-10-15T00:00:00.000Z",
    }).success,
  ).toBe(true);
  expect(
    aiTeacherSettingsPutRequestSchema.safeParse({
      defaultMode: "guided_only",
      baseUpdatedAt: true,
    }).success,
  ).toBe(false);
});

it("错误码枚举覆盖模板、按钮、策略与版本冲突四类", () => {
  for (const code of [
    "AI_PROMPT_INVALID",
    "AI_BUTTONS_INVALID",
    "AI_POLICY_INVALID",
    "AI_SETTINGS_STALE",
  ]) {
    expect(aiPolicyErrorCodeSchema.options).toContain(code);
  }
  expect(aiPolicyErrorCodeSchema.safeParse("ai_prompt_invalid").success).toBe(
    false,
  );
});
