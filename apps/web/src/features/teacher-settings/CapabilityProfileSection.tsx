import type { CapabilitySwitch } from "@tutor/contract";
import { toEnabledCapabilities } from "@tutor/contract";
import { Check, Loader2, PenLine, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  useCapabilityProfile,
  useSaveCapabilityProfile,
} from "@/features/teacher-settings/capability-profile-queries";

/** mutation/query 错误的展示文案（Error 消息优先，兜底中文提示） */
function errText(
  failed: boolean,
  error: unknown,
  fallback: string,
): string | null {
  if (!failed) return null;
  return error instanceof Error ? error.message : fallback;
}

/** 同构的告警条（role=alert；两处错误展示共用） */
function alertNode(text: string | null): ReactNode {
  if (text === null) return null;
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      {text}
    </p>
  );
}

/**
 * 设置页「辅助能力」区（T7.7 / 方案 §4.5）：教师级 steps / ink 两项开关。
 * - 仅控制辅助能力：关闭 steps = 学生端完整展开逐步揭晓；关闭 ink = 隐藏
 *   手写与草稿入口（已有笔迹保留只读）。判断 / 选择 / 填空与最终答案输入
 *   是正式作答，始终可用、不出现在勾选中；
 * - 生效方式：学生重新打开页面（读时计算，无推送）；
 * - 开关不清空答案/笔迹、不改提交规则、不参与判分。
 * 三态齐全（加载/错误/数据）、触控目标 ≥44px（min-h-11）。
 */
export function CapabilityProfileSection() {
  const profileQuery = useCapabilityProfile();
  const saveMutation = useSaveCapabilityProfile();
  /** 勾选态（服务端数据到达时同步一次；保存成功后以重取结果为准） */
  const [checked, setChecked] = useState<Record<CapabilitySwitch, boolean>>({
    steps: true,
    ink: true,
  });
  const loaded = profileQuery.data?.enabledCapabilities;
  useEffect(() => {
    if (loaded === undefined) return;
    setChecked(toEnabledCapabilities(loaded));
  }, [loaded]);

  const switches: ReadonlyArray<{
    readonly key: CapabilitySwitch;
    readonly label: string;
    readonly description: string;
  }> = [
    {
      key: "steps",
      label: "逐步揭晓",
      description: "讲义与题目里的 :::steps 交互——关闭后学生端完整展开全部步骤",
    },
    {
      key: "ink",
      label: "手写辅助",
      description:
        "手写作答区、全屏手写与题卡草稿纸——关闭后隐藏入口，仍可填写最终答案",
    },
  ];

  const errorText = errText(
    profileQuery.isError,
    profileQuery.error,
    "加载失败，请刷新重试",
  );
  const actionError = errText(
    saveMutation.isError,
    saveMutation.error,
    "保存失败，请稍后重试",
  );

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 text-card-foreground">
      <div>
        <h2 className="text-sm font-semibold">辅助能力（学生作答方式）</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          只控制辅助作答方式，正式作答（判断、选择、填空与最终答案）始终可用。
        </p>
      </div>

      {profileQuery.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          正在加载设置…
        </p>
      )}
      {alertNode(errorText)}

      {profileQuery.data && (
        <>
          <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
            <legend className="sr-only">辅助能力开关</legend>
            {switches.map(({ key, label, description }) => (
              <label
                key={key}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border bg-background px-3 py-2.5 text-sm outline-none transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50"
              >
                <input
                  type="checkbox"
                  checked={checked[key]}
                  onChange={(event) =>
                    setChecked((prev) => ({
                      ...prev,
                      [key]: event.target.checked,
                    }))
                  }
                  aria-label={label}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 font-medium">
                    <PenLine aria-hidden className="size-3.5 text-primary" />
                    {label}
                  </span>
                  <span className="text-xs leading-5 text-muted-foreground">
                    {description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          <p className="text-xs leading-5 text-muted-foreground">
            保存后学生重新打开页面生效。已有答案、笔迹与草稿不会被清除；关闭期间
            手写题仍可填写最终答案提交。
          </p>

          {alertNode(actionError)}

          <div>
            <Button
              type="button"
              className="min-h-11 px-6"
              disabled={saveMutation.isPending}
              onClick={() =>
                saveMutation.mutate({
                  enabledCapabilities: (["steps", "ink"] as const).filter(
                    (key) => checked[key],
                  ),
                })
              }
            >
              {saveMutation.isPending ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" />
                  正在保存…
                </>
              ) : saveMutation.isSuccess && !actionError ? (
                <>
                  <Check aria-hidden />
                  已保存
                </>
              ) : (
                "保存"
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
