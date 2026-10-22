import type { PracticeLayout } from "@tutor/contract";
import { ListChecks, SquareKanban } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  savePracticePreference,
  usePracticePreference,
} from "./practice-preference-store";

/**
 * 学生设置「学习偏好 → 做题方式」配置行（M3-D1，计划 §7.1）：
 * - 默认布局二选一（列表/单题）+ 键盘快捷键开关，选择暂存、保存生效；
 * - 后台重取（跨标签保存）不覆盖本地编辑，可显式载入已保存值；
 * - 快捷键开关 D1 仅存储不生效（D3 接线），文案如实注明后续启用。
 * 沿用 StudentAiDisplaySection 的暂存-保存交互先例。
 */

const layoutOptions = [
  {
    value: "list" as const,
    title: "列表作答",
    description: "整卷连续作答，可随时上下浏览各题。",
    icon: ListChecks,
  },
  {
    value: "single" as const,
    title: "单题专注",
    description: "一次只看一题，按题号逐题推进。",
    icon: SquareKanban,
  },
];

export function StudentPracticePreferenceSection() {
  const saved = usePracticePreference();
  const [draft, setDraft] = useState<{
    layout: PracticeLayout;
    keyboardShortcuts: boolean;
    base: { layout: PracticeLayout; keyboardShortcuts: boolean };
    owner: string | null;
  } | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(
    null,
  );
  const selected = draft ?? {
    layout: saved.layout,
    keyboardShortcuts: saved.keyboardShortcuts,
  };
  const dirty =
    draft !== null &&
    (draft.layout !== saved.layout ||
      draft.keyboardShortcuts !== saved.keyboardShortcuts);
  const baseChanged =
    draft !== null &&
    (draft.base.layout !== saved.layout ||
      draft.base.keyboardShortcuts !== saved.keyboardShortcuts);
  const bound = saved.accountId !== null;

  const update = (
    patch: Partial<{ layout: PracticeLayout; keyboardShortcuts: boolean }>,
  ) => {
    setDraft({
      layout: patch.layout ?? selected.layout,
      keyboardShortcuts: patch.keyboardShortcuts ?? selected.keyboardShortcuts,
      base: draft?.base ?? {
        layout: saved.layout,
        keyboardShortcuts: saved.keyboardShortcuts,
      },
      owner: saved.accountId,
    });
    setNotice(null);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="font-medium">做题方式</h3>
        <p className="text-sm text-muted-foreground">
          设置进入练习时的默认呈现；每次作答中也可在「更多」里临时切换。
        </p>
      </div>
      {!bound ? (
        <p className="text-sm text-muted-foreground">登录后可设置做题方式。</p>
      ) : (
        <>
          <fieldset className="grid min-w-0 gap-3 sm:grid-cols-2">
            <legend className="sr-only">选择默认做题布局</legend>
            {layoutOptions.map(({ value, title, description, icon: Icon }) => (
              <label
                key={value}
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border p-3 outline-none has-focus-visible:ring-3 has-focus-visible:ring-ring/50 ${
                  selected.layout === value
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-muted/40"
                }`}
              >
                <input
                  className="size-4 shrink-0 accent-primary"
                  type="radio"
                  name="practice-default-layout"
                  value={value}
                  checked={selected.layout === value}
                  onChange={() => update({ layout: value })}
                />
                <Icon aria-hidden className="size-5 shrink-0 text-primary" />
                <span className="min-w-0 space-y-0.5">
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="block text-xs leading-5 text-muted-foreground">
                    {description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border border-border p-3 outline-none has-focus-visible:ring-3 has-focus-visible:ring-ring/50">
            <input
              className="size-4 shrink-0 accent-primary"
              type="checkbox"
              checked={selected.keyboardShortcuts}
              onChange={(event) =>
                update({ keyboardShortcuts: event.target.checked })
              }
            />
            <span className="min-w-0 space-y-0.5">
              <span className="block text-sm font-medium">键盘快捷键</span>
              <span className="block text-xs leading-5 text-muted-foreground">
                保存后作为默认偏好；快捷键将在后续更新中启用。
              </span>
            </span>
          </label>
        </>
      )}
      {baseChanged && (
        <p className="text-sm text-muted-foreground">
          其他页面已修改做题方式，你的选择已保留。
          <Button
            variant="link"
            className="min-h-11"
            onClick={() => {
              setDraft(null);
              setNotice(null);
            }}
          >
            载入已保存值
          </Button>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          className="min-h-11"
          disabled={!dirty}
          onClick={() => {
            try {
              savePracticePreference(selected, draft?.owner);
              setDraft(null);
              setNotice({ error: false, text: "做题方式已保存" });
            } catch {
              setNotice({
                error: true,
                text: "未能保存做题方式，请确认账号和浏览器存储后重试。",
              });
            }
          }}
        >
          保存做题方式
        </Button>
        {dirty && (
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => {
              setDraft(null);
              setNotice(null);
            }}
          >
            取消更改
          </Button>
        )}
        {dirty && (
          <span className="text-sm text-muted-foreground">有未保存更改</span>
        )}
      </div>
      {notice && (
        <p
          role={notice.error ? "alert" : "status"}
          className={`text-sm ${notice.error ? "text-destructive" : "text-muted-foreground"}`}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
