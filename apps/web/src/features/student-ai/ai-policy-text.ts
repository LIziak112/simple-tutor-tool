import type {
  AiPolicyInheritableMode,
  AiPolicyResolution,
} from "@tutor/contract";

/**
 * SAI-07 教学模式与裁决原因的界面文案（教师端配置组件共用）。
 * 模式名与需求 §3.1 口径一致；「有效结果」整句以服务端 resolution
 * （resolveAiPolicy 单源）拼装，前端不另算一套合并规则。
 */

/** 模式名（含 inherit 第四值，供「继承（当前：…）」与单选标签复用） */
export const AI_INHERITABLE_MODE_LABELS: Record<
  AiPolicyInheritableMode,
  string
> = {
  open_study: "开放伴学",
  guided_only: "仅启发",
  post_submit_only: "完成后可用",
  inherit: "继承",
};

/**
 * 有效结果整句：作答中视角的合并结果 + 来源。
 * reason=completed 不出现在配置预览（服务端 previewResolution 恒作答中），
 * 防御性给出文案避免未知枚举渲染空白。
 */
export function aiResolutionText(resolution: AiPolicyResolution): string {
  if (!resolution.usable) {
    switch (resolution.reason) {
      case "student_closed":
        return "作答中不可用（来自学生设置）";
      case "assignment_closed":
        return "作答中不可用（来自作业设置）";
      case "teacher_default_closed":
        return "作答中不可用（你的默认设置为完成后可用）";
      default:
        return "作答中不可用";
    }
  }
  const mode = resolution.mode ?? "open_study";
  const label = AI_INHERITABLE_MODE_LABELS[mode];
  switch (resolution.reason) {
    case "teacher_default":
      return `${label}（跟随你的默认设置）`;
    case "student_override":
      return `${label}（来自学生设置）`;
    case "assignment_override":
      return `${label}（来自作业设置）`;
    default:
      return label;
  }
}
