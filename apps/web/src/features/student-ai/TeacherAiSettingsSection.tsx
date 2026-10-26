import { useQueryClient } from "@tanstack/react-query";
import {
  AI_PROMPT_TEMPLATE_MAX_CHARS,
  type AiPromptTemplateKey,
  type AiTeacherSettingsPutRequest,
  type AiTeachingMode,
  DEFAULT_AI_PROMPT_TEMPLATES,
} from "@tutor/contract";
import {
  ChevronDown,
  Info,
  Loader2,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSettingsNavigation } from "@/features/teacher-settings/settings-navigation";
import { ApiError } from "@/lib/api";
import {
  teacherAiSettingsDraftKey,
  teacherAiSettingsKey,
  useSaveTeacherAiSettings,
  useTeacherAiSettings,
} from "./ai-policy-queries";
import { AI_INHERITABLE_MODE_LABELS } from "./ai-policy-text";
import { useAiSettingsSave } from "./ai-settings-save";

/**
 * SAI-07 教师设置「AI 伴学」区（默认模式 + 三模板，需求 §3.1/§5.1/§11）：
 * - 模式与模板只改本地草稿（queryClient 缓存，切分类不丢），保存才 PUT；
 * - 保存请求只带变化字段（模板恢复默认 → null）+ baseUpdatedAt 版本锚点；
 * - 409 AI_SETTINGS_STALE 不自动覆盖输入：显示冲突并提供显式「放弃本地更改
 *   并重新加载」；其余失败保留编辑可重试；
 * - 模板 tab 切换编辑，「恢复默认模板」先弹层预览默认全文并说明替换范围
 *   （只替换当前模式模板，其他两个模式不受影响）；
 * - 复用设置页离开确认（settings-navigation）与持续挂载控制器。
 */

/** 默认模式三选项（需求 §3.1：未设置即开放伴学） */
const MODE_OPTIONS: ReadonlyArray<{
  value: AiTeachingMode;
  description: string;
}> = [
  {
    value: "open_study",
    description: "作答中即可求助；AI 参考已有答案解析提供完整帮助。",
  },
  {
    value: "guided_only",
    description: "作答中只指出当前错误、必要概念或下一步，不直接给最终答案。",
  },
  {
    value: "post_submit_only",
    description:
      "本题完成后才可求助；作答中的新发送、领取与链接读取都会被拒绝。",
  },
];

/** 模板三 tab（键名与契约 DEFAULT_AI_PROMPT_TEMPLATES 一一对应） */
const TEMPLATE_TABS: ReadonlyArray<{
  key: AiPromptTemplateKey;
  label: string;
}> = [
  { key: "open", label: "开放伴学" },
  { key: "guided", label: "仅启发" },
  { key: "review", label: "完成后复盘" },
];

const TEMPLATE_KEYS = TEMPLATE_TABS.map(({ key }) => key);

/** 模板键 → PUT 请求字段名（契约 aiTeacherSettingsPutRequestSchema） */
const PROMPT_FIELDS: Record<
  AiPromptTemplateKey,
  "promptsOpen" | "promptsGuided" | "promptsReview"
> = {
  open: "promptsOpen",
  guided: "promptsGuided",
  review: "promptsReview",
};

/** 本地草稿：模板存装配后正文（null → 默认文本），保存时再折算 null/文本 */
interface AiSettingsDraft {
  defaultMode: AiTeachingMode;
  prompts: Record<AiPromptTemplateKey, string>;
}

/** 服务端值 → 装配后的展示基线（null 模板显示默认正文） */
function toBaseline(data: {
  defaultMode: AiTeachingMode;
  promptsOpen: string | null;
  promptsGuided: string | null;
  promptsReview: string | null;
}): AiSettingsDraft {
  return {
    defaultMode: data.defaultMode,
    prompts: {
      open: data.promptsOpen ?? DEFAULT_AI_PROMPT_TEMPLATES.open,
      guided: data.promptsGuided ?? DEFAULT_AI_PROMPT_TEMPLATES.guided,
      review: data.promptsReview ?? DEFAULT_AI_PROMPT_TEMPLATES.review,
    },
  };
}

export function TeacherAiSettingsSection() {
  const settingsQuery = useTeacherAiSettings();
  const saveMutation = useSaveTeacherAiSettings();
  const queryClient = useQueryClient();
  const navigation = useSettingsNavigation();
  const [draft, setDraft] = useState<AiSettingsDraft | null>(
    // getQueryData 未命中返回 undefined，折算 null 表示「无草稿」
    () =>
      queryClient.getQueryData<AiSettingsDraft>(teacherAiSettingsDraftKey) ??
      null,
  );
  const [activeTemplate, setActiveTemplate] =
    useState<AiPromptTemplateKey>("open");
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const data = settingsQuery.data;
  const baseline = useMemo(() => (data ? toBaseline(data) : null), [data]);
  const checked = draft ?? baseline;
  const dirty =
    baseline !== null &&
    checked !== null &&
    (checked.defaultMode !== baseline.defaultMode ||
      TEMPLATE_KEYS.some(
        (key) => checked.prompts[key] !== baseline.prompts[key],
      ));

  /** 模板正文空/纯空白：本地前置契约校验（空模板保存会被 400 拒绝） */
  const emptyTemplate =
    checked !== null &&
    TEMPLATE_KEYS.some((key) => checked.prompts[key].trim().length === 0);

  const setNavigationDraft = navigation?.setDraft;
  useEffect(() => {
    queryClient.setQueryDefaults(teacherAiSettingsDraftKey, {
      gcTime: Infinity,
    });
    queryClient.setQueryData(teacherAiSettingsDraftKey, draft);
  }, [queryClient, draft]);
  useEffect(() => {
    setNavigationDraft?.("ai-settings", {
      dirty,
      discard: () => {
        setDraft(null);
        queryClient.removeQueries({ queryKey: teacherAiSettingsDraftKey });
      },
    });
    return () =>
      setNavigationDraft?.("ai-settings", {
        dirty: false,
        discard: () => {},
      });
  }, [dirty, queryClient, setNavigationDraft]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /** 组装增量 PUT：只带变化字段；模板草稿等于默认正文 → null（恢复默认） */
  function buildRequest(): AiTeacherSettingsPutRequest | null {
    if (baseline === null || checked === null || data === undefined)
      return null;
    const request: AiTeacherSettingsPutRequest = {
      baseUpdatedAt: data.updatedAt,
    };
    if (checked.defaultMode !== baseline.defaultMode) {
      request.defaultMode = checked.defaultMode;
    }
    for (const key of TEMPLATE_KEYS) {
      if (checked.prompts[key] !== baseline.prompts[key]) {
        request[PROMPT_FIELDS[key]] =
          checked.prompts[key] === DEFAULT_AI_PROMPT_TEMPLATES[key]
            ? null
            : checked.prompts[key];
      }
    }
    const changed =
      request.defaultMode !== undefined ||
      request.promptsOpen !== undefined ||
      request.promptsGuided !== undefined ||
      request.promptsReview !== undefined;
    return changed ? request : null;
  }

  async function handleSave(): Promise<void> {
    const request = buildRequest();
    if (request === null) return;
    await saveMutation.mutateAsync(request, {
      onSuccess: () => setDraft(null),
    });
  }

  const sharedSave = useAiSettingsSave("ai-settings", {
    dirty,
    blocked: baseline === null || settingsQuery.isError || emptyTemplate,
    save: handleSave,
  });

  /** 版本冲突（其他页面已保存）：显式放弃本地编辑，重新拉服务器值 */
  function discardAndReload(): void {
    setDraft(null);
    queryClient.removeQueries({ queryKey: teacherAiSettingsDraftKey });
    void queryClient.invalidateQueries({ queryKey: teacherAiSettingsKey });
  }

  const staleConflict =
    saveMutation.isError &&
    saveMutation.error instanceof ApiError &&
    saveMutation.error.code === "AI_SETTINGS_STALE";

  const activeTab =
    TEMPLATE_TABS.find(({ key }) => key === activeTemplate) ?? TEMPLATE_TABS[0];
  if (activeTab === undefined) throw new Error("模板 tab 常量缺失");

  return (
    <div className="teacher-config-section">
      <div>
        <h2 className="font-semibold">AI 伴学</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          为你的学生设定 AI 伴学的默认策略与三套提示词模板。
        </p>
        <p className="mt-2 flex items-start gap-2 text-[0.8125rem] leading-relaxed text-muted-foreground">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>
            允许求助时，已有答案和解析会一起提供给 AI。
            仅启发通过提示词要求控制输出，不能保证原始答案保密。
          </span>
        </p>
      </div>

      {settingsQuery.isPending && (
        <p className="text-sm text-muted-foreground">正在加载 AI 设置…</p>
      )}
      {settingsQuery.isError && (
        <div>
          <p role="alert" className="text-sm text-destructive">
            无法加载 AI 设置，请重试。
          </p>
          <Button
            variant="outline"
            className="mt-3"
            onClick={() => void settingsQuery.refetch()}
          >
            重新加载
          </Button>
        </div>
      )}

      {baseline !== null && checked !== null && (
        <>
          <fieldset className="m-0 divide-y divide-border overflow-hidden rounded-xl border border-border bg-card p-0">
            <legend className="sr-only">默认模式</legend>
            {MODE_OPTIONS.map(({ value, description }) => (
              <label
                key={value}
                className="flex min-h-11 cursor-pointer items-start gap-3 px-5 py-4 sm:px-7"
              >
                <span className="flex min-h-11 min-w-11 items-center justify-center">
                  <input
                    type="radio"
                    name="ai-default-mode"
                    aria-label={AI_INHERITABLE_MODE_LABELS[value]}
                    className="size-5 accent-primary"
                    checked={checked.defaultMode === value}
                    onChange={() =>
                      setDraft({ ...checked, defaultMode: value })
                    }
                  />
                </span>
                <span className="min-w-0">
                  <span className="block text-[0.9375rem] font-semibold">
                    {AI_INHERITABLE_MODE_LABELS[value]}
                  </span>
                  <span className="mt-1 block max-w-[54ch] text-[0.8125rem] leading-relaxed text-muted-foreground">
                    {description}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
            保存后对后续操作生效；学生与作业可以单独覆盖这一默认。
            本题完成后一律按开放伴学复盘。
          </p>

          <div className="group rounded-xl border border-border bg-card p-4 sm:p-5">
            <button
              type="button"
              aria-controls="teacher-ai-template-editor"
              aria-expanded={templatesOpen}
              onClick={() => {
                setTemplatesOpen((open) => !open);
              }}
              className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-md text-start text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span>
                伴学提示词模板
                {checked &&
                  TEMPLATE_KEYS.some(
                    (key) => checked.prompts[key] !== baseline.prompts[key],
                  ) && (
                    <span className="ml-2 text-xs text-primary">
                      有未保存更改
                    </span>
                  )}
              </span>
              <ChevronDown
                aria-hidden
                className={`size-4 shrink-0 transition-transform ${templatesOpen ? "rotate-180" : ""}`}
              />
            </button>
            <div
              id="teacher-ai-template-editor"
              hidden={!templatesOpen}
              className="mt-3 flex flex-col gap-3"
            >
              <div
                role="tablist"
                aria-label="提示词模板"
                className="flex flex-wrap gap-2"
              >
                {TEMPLATE_TABS.map(({ key, label }) => (
                  <Button
                    key={key}
                    type="button"
                    variant="outline"
                    aria-label={`模板：${label}`}
                    aria-selected={activeTemplate === key}
                    className="min-h-11"
                    onClick={() => setActiveTemplate(key)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <label className="flex flex-col gap-1.5 text-sm">
                <span>
                  {activeTab.label}模板正文（
                  {activeTab.key === "review"
                    ? "完成后复盘不按作答中求助处理"
                    : "可描述教学方法、语言与详细程度"}
                  ）
                </span>
                <textarea
                  aria-label={`${activeTab.label}模板正文`}
                  className="min-h-44 w-full resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-sm leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                  maxLength={AI_PROMPT_TEMPLATE_MAX_CHARS}
                  value={checked.prompts[activeTemplate]}
                  onChange={(event) =>
                    setDraft({
                      ...checked,
                      prompts: {
                        ...checked.prompts,
                        [activeTemplate]: event.target.value,
                      },
                    })
                  }
                />
                <span className="text-xs text-muted-foreground">
                  {checked.prompts[activeTemplate].length}/
                  {AI_PROMPT_TEMPLATE_MAX_CHARS} 字符；仅启发模式在模板外始终
                  保留模式要求，模板误删也不会失去约束。
                </span>
              </label>
              {emptyTemplate && (
                <p role="alert" className="text-xs text-destructive">
                  模板正文不能为空；要恢复默认请用「恢复默认模板」。
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                className="min-h-11 self-start"
                onClick={() => setConfirmReset(true)}
              >
                <RotateCcw aria-hidden />
                恢复默认模板
              </Button>
            </div>
          </div>

          {saveMutation.isError && !staleConflict && (
            <p
              role="alert"
              className="flex items-start gap-2 text-sm text-destructive"
            >
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              {saveMutation.error instanceof Error
                ? saveMutation.error.message
                : "保存失败"}
              。更改仍保留，请重试保存。
            </p>
          )}
          {staleConflict && (
            <div
              role="alert"
              className="flex flex-col items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm"
            >
              <p className="flex items-start gap-2 text-destructive">
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                {saveMutation.error instanceof Error
                  ? saveMutation.error.message
                  : "AI 设置已在其他页面被修改"}
                。你的编辑未被覆盖，请自行比对其重新保存，或放弃本地更改。
              </p>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={discardAndReload}
              >
                放弃本地更改并重新加载
              </Button>
            </div>
          )}

          {!sharedSave && (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
              <p role="status" className="text-xs text-muted-foreground">
                {saveMutation.isPending
                  ? "正在保存…"
                  : dirty
                    ? "有未保存的更改"
                    : saveMutation.isSuccess
                      ? "更改已保存"
                      : "当前设置已保存"}
              </p>
              <Button
                className="min-h-11 px-5"
                disabled={saveMutation.isPending || !dirty || emptyTemplate}
                onClick={() => void handleSave().catch(() => {})}
              >
                {saveMutation.isPending && (
                  <Loader2 aria-hidden className="motion-safe:animate-spin" />
                )}
                保存 AI 设置
              </Button>
            </div>
          )}
        </>
      )}

      {/* 恢复默认确认：预览默认全文 + 替换范围说明（只影响当前模板） */}
      <Dialog
        open={confirmReset}
        onOpenChange={(open) => {
          if (!open) setConfirmReset(false);
        }}
      >
        <DialogContent className="teacher-theme">
          <DialogHeader>
            <DialogTitle>恢复默认模板</DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-2">
                <p>
                  将把「{activeTab.label}」的模板正文替换为系统默认， 只替换「
                  {activeTab.label}」的模板正文，其他两个模式的模板不受影响。
                  替换只改本地编辑，仍需点「保存 AI 设置」才生效。
                </p>
                <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  {DEFAULT_AI_PROMPT_TEMPLATES[activeTemplate]}
                </pre>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="min-h-11"
              onClick={() => setConfirmReset(false)}
            >
              取消
            </Button>
            <Button
              className="min-h-11"
              onClick={() => {
                if (checked !== null) {
                  setDraft({
                    ...checked,
                    prompts: {
                      ...checked.prompts,
                      [activeTemplate]:
                        DEFAULT_AI_PROMPT_TEMPLATES[activeTemplate],
                    },
                  });
                }
                setConfirmReset(false);
              }}
            >
              恢复默认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
