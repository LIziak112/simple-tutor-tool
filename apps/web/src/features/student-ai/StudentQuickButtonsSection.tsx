import { useQueryClient } from "@tanstack/react-query";
import {
  AI_QUICK_BUTTON_MAX_COUNT,
  AI_QUICK_BUTTON_NAME_MAX_CHARS,
  AI_QUICK_BUTTON_PROMPT_MAX_CHARS,
  type AiMaterialPreference,
  DEFAULT_QUICK_BUTTONS,
  type StudentQuickButton,
} from "@tutor/contract";
import {
  ArrowUp,
  Info,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api";
import { randomUuid } from "@/lib/uuid";
import {
  quickButtonsEqual,
  studentQuickButtonsDraftKey,
  studentQuickButtonsKey,
  useSaveStudentQuickButtons,
  useStudentQuickButtons,
} from "./quick-buttons-queries";

/**
 * SAI-08 学生设置「AI 快捷按钮」管理区（需求 §5.2）：
 * - 名称与提示词分开编辑；附件三类（圈画/草稿/正式手写）独立勾选；
 * - 增删改/排序/启用只改本地草稿（queryClient 缓存，切页重挂不丢），
 *   保存才整组 PUT（orderIndex 按位次重排 + baseUpdatedAt 锚点）；
 * - 后台重取不覆盖未保存草稿（draft ?? baseline）；409 AI_SETTINGS_STALE
 *   不自动覆盖输入，显式「放弃本地更改并重新加载」才回服务器值；
 * - 删光允许且保存空组（服务端墓碑，不回填默认）；空态说明自由输入仍可用；
 * - 恢复默认先弹层列明替换范围（当前 N 项 → 默认四项），取消无副作用；
 * - 「实际发送仍服从教师设置的教学模式」说明常驻，不依赖 hover。
 */

/** 深拷贝一份默认四项（恢复默认确认后作为本地草稿，不直接落库） */
function cloneDefaultButtons(): StudentQuickButton[] {
  return DEFAULT_QUICK_BUTTONS.map((button) => ({
    ...button,
    attachmentPref: { ...button.attachmentPref },
  }));
}

export function StudentQuickButtonsSection({
  onDirtyChange,
}: {
  onDirtyChange?: (dirty: boolean) => void;
} = {}) {
  const quickButtonsQuery = useStudentQuickButtons();
  const saveMutation = useSaveStudentQuickButtons();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<StudentQuickButton[] | null>(
    // getQueryData 未命中返回 undefined，折算 null 表示「无草稿」
    () =>
      queryClient.getQueryData<StudentQuickButton[]>(
        studentQuickButtonsDraftKey,
      ) ?? null,
  );
  const [confirmReset, setConfirmReset] = useState(false);

  const data = quickButtonsQuery.data;
  const baseline = data ? data.buttons : null;
  const checked = draft ?? baseline;
  const dirty =
    draft !== null && baseline !== null && !quickButtonsEqual(draft, baseline);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  /** 本地前置契约校验：空白名称/提示词阻止保存（服务端会 400 拒绝） */
  const emptyName = checked?.some((b) => b.name.trim().length === 0) ?? false;
  const emptyPrompt =
    checked?.some((b) => b.prompt.trim().length === 0) ?? false;

  // 草稿写回缓存：gcTime Infinity，切页/卸载重挂不丢；学生登出清 ["student"] 一并带走
  useEffect(() => {
    queryClient.setQueryDefaults(studentQuickButtonsDraftKey, {
      gcTime: Infinity,
    });
    queryClient.setQueryData(studentQuickButtonsDraftKey, draft);
  }, [queryClient, draft]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /** 就地改第 index 项（不动其他项） */
  function updateButton(
    index: number,
    patch: Partial<Omit<StudentQuickButton, "attachmentPref">>,
  ): void {
    if (checked === null) return;
    setDraft(
      checked.map((button, i) =>
        i === index ? { ...button, ...patch } : button,
      ),
    );
  }

  /** 三类附件独立勾选（圈画/草稿/正式手写，不用一个布尔混淆） */
  function updateAttachment(
    index: number,
    key: keyof AiMaterialPreference,
    value: boolean,
  ): void {
    if (checked === null) return;
    setDraft(
      checked.map((button, i) =>
        i === index
          ? {
              ...button,
              attachmentPref: { ...button.attachmentPref, [key]: value },
            }
          : button,
      ),
    );
  }

  function moveUp(index: number): void {
    if (checked === null || index <= 0) return;
    const next = [...checked];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(index - 1, 0, moved);
    setDraft(next);
  }

  function removeButton(index: number): void {
    if (checked === null) return;
    setDraft(checked.filter((_, i) => i !== index));
  }

  function addButton(): void {
    if (checked === null || checked.length >= AI_QUICK_BUTTON_MAX_COUNT) return;
    setDraft([
      ...checked,
      {
        id: randomUuid(),
        name: "",
        prompt: "",
        orderIndex: checked.length,
        enabled: true,
        attachmentPref: { annotation: false, draft: false, formalInk: false },
      },
    ]);
  }

  /** 整组保存：orderIndex 按当前位次重排为 0..n-1 + 版本锚点 */
  function handleSave(): void {
    if (checked === null || data === undefined) return;
    saveMutation.mutate(
      {
        buttons: checked.map((button, index) => ({
          ...button,
          orderIndex: index,
        })),
        baseUpdatedAt: data.updatedAt,
      },
      { onSuccess: () => setDraft(null) },
    );
  }

  /** 版本冲突（其他设备已保存）：显式放弃本地编辑，重新拉服务器值 */
  function discardAndReload(): void {
    setDraft(null);
    queryClient.removeQueries({ queryKey: studentQuickButtonsDraftKey });
    void queryClient.invalidateQueries({ queryKey: studentQuickButtonsKey });
  }

  const staleConflict =
    saveMutation.isError &&
    saveMutation.error instanceof ApiError &&
    saveMutation.error.code === "AI_SETTINGS_STALE";

  return (
    <div className="space-y-5">
      <div>
        <h2 className="font-semibold">AI 快捷按钮</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          在求助 AI 时一键发送的常用问题。可以改名、改提示词、调整附件与顺序。
        </p>
        <p className="mt-2 flex items-start gap-2 text-[0.8125rem] leading-relaxed text-muted-foreground">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
          <span>
            实际发送时，是否携带答案解析与回复尺度仍服从教师设置的教学模式；
            仅启发模式下 AI 只作提示，不直接给出最终答案。
          </span>
        </p>
      </div>

      {quickButtonsQuery.isPending && (
        <p className="text-sm text-muted-foreground">正在加载快捷按钮…</p>
      )}
      {quickButtonsQuery.isError && (
        <div>
          <p role="alert" className="text-sm text-destructive">
            无法加载快捷按钮，请重试。
          </p>
          <Button
            variant="outline"
            className="mt-3 min-h-11"
            onClick={() => void quickButtonsQuery.refetch()}
          >
            重新加载
          </Button>
        </div>
      )}

      {checked !== null && (
        <>
          {checked.length === 0 ? (
            <p className="rounded-xl border border-border bg-card p-4 text-sm leading-relaxed text-muted-foreground">
              没有快捷按钮也可以直接输入问题向 AI
              求助；需要常用问题时点下方「新增按钮」。
            </p>
          ) : (
            <ul className="flex flex-col gap-3">
              {checked.map((button, index) => {
                const number = index + 1;
                return (
                  <li
                    key={button.id}
                    className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:p-5"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={`第 ${number} 项上移`}
                        className="size-11 p-0"
                        disabled={index === 0}
                        onClick={() => moveUp(index)}
                      >
                        <ArrowUp aria-hidden className="size-4" />
                      </Button>
                      <label className="flex min-w-24 cursor-pointer items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          aria-label={`第 ${number} 项启用`}
                          className="size-4 accent-primary"
                          checked={button.enabled}
                          onChange={(event) =>
                            updateButton(index, {
                              enabled: event.target.checked,
                            })
                          }
                        />
                        启用
                      </label>
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={`第 ${number} 项删除`}
                        className="ml-auto size-11 p-0 text-destructive hover:text-destructive"
                        onClick={() => removeButton(index)}
                      >
                        <Trash2 aria-hidden className="size-4" />
                      </Button>
                    </div>
                    <div className="flex flex-col gap-3 sm:flex-row">
                      <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
                        <span>按钮名称</span>
                        <input
                          type="text"
                          aria-label={`第 ${number} 项按钮名称`}
                          className="w-full min-w-0 rounded-lg border border-input bg-transparent px-3 py-2 text-base sm:text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                          maxLength={AI_QUICK_BUTTON_NAME_MAX_CHARS}
                          value={button.name}
                          onChange={(event) =>
                            updateButton(index, { name: event.target.value })
                          }
                        />
                      </label>
                      <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
                        <span>按钮提示词</span>
                        <textarea
                          aria-label={`第 ${number} 项按钮提示词`}
                          className="w-full min-w-0 resize-y rounded-lg border border-input bg-transparent px-3 py-2 text-base sm:text-sm leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
                          maxLength={AI_QUICK_BUTTON_PROMPT_MAX_CHARS}
                          rows={2}
                          value={button.prompt}
                          onChange={(event) =>
                            updateButton(index, { prompt: event.target.value })
                          }
                        />
                      </label>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
                      <span className="text-muted-foreground">
                        发送时附带：
                      </span>
                      <label className="flex cursor-pointer items-center gap-1.5">
                        <input
                          type="checkbox"
                          aria-label={`第 ${number} 项附圈画`}
                          className="size-4 accent-primary"
                          checked={button.attachmentPref.annotation}
                          onChange={(event) =>
                            updateAttachment(
                              index,
                              "annotation",
                              event.target.checked,
                            )
                          }
                        />
                        圈画
                      </label>
                      <label className="flex cursor-pointer items-center gap-1.5">
                        <input
                          type="checkbox"
                          aria-label={`第 ${number} 项附草稿`}
                          className="size-4 accent-primary"
                          checked={button.attachmentPref.draft}
                          onChange={(event) =>
                            updateAttachment(
                              index,
                              "draft",
                              event.target.checked,
                            )
                          }
                        />
                        草稿
                      </label>
                      <label className="flex cursor-pointer items-center gap-1.5">
                        <input
                          type="checkbox"
                          aria-label={`第 ${number} 项附正式手写`}
                          className="size-4 accent-primary"
                          checked={button.attachmentPref.formalInk}
                          onChange={(event) =>
                            updateAttachment(
                              index,
                              "formalInk",
                              event.target.checked,
                            )
                          }
                        />
                        正式手写
                      </label>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {emptyName && (
            <p role="alert" className="text-sm text-destructive">
              按钮名称不能为空；请填写或删除该按钮。
            </p>
          )}
          {!emptyName && emptyPrompt && (
            <p role="alert" className="text-sm text-destructive">
              按钮提示词不能为空；请填写或删除该按钮。
            </p>
          )}

          {saveMutation.isError && !staleConflict && (
            <p
              role="alert"
              className="flex items-start gap-2 text-sm text-destructive"
            >
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              保存失败：
              {saveMutation.error instanceof Error
                ? saveMutation.error.message
                : "网络异常"}
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
                  : "快捷按钮已在其他设备修改"}
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

          <div className="flex flex-wrap items-center justify-between gap-4">
            <p role="status" className="text-xs text-muted-foreground">
              {saveMutation.isPending
                ? "正在保存…"
                : dirty
                  ? "有未保存的更改"
                  : saveMutation.isSuccess
                    ? "更改已保存"
                    : "当前快捷按钮已保存"}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                disabled={checked.length >= AI_QUICK_BUTTON_MAX_COUNT}
                onClick={addButton}
              >
                <Plus aria-hidden />
                新增按钮
              </Button>
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => setConfirmReset(true)}
              >
                <RotateCcw aria-hidden />
                恢复默认
              </Button>
              <Button
                className="min-h-11 px-5"
                disabled={saveMutation.isPending || emptyName || emptyPrompt}
                onClick={handleSave}
              >
                {saveMutation.isPending && (
                  <Loader2 aria-hidden className="motion-safe:animate-spin" />
                )}
                保存快捷按钮
              </Button>
            </div>
          </div>
        </>
      )}

      {/* 恢复默认确认：列明替换范围（当前 N 项 → 默认四项），取消无副作用 */}
      <Dialog
        open={confirmReset}
        onOpenChange={(open) => {
          if (!open) setConfirmReset(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>恢复默认快捷按钮</DialogTitle>
            <DialogDescription asChild>
              <div className="flex flex-col gap-2">
                <p>
                  将替换当前的 {checked?.length ?? 0}{" "}
                  项个人配置，恢复为系统默认的
                  {DEFAULT_QUICK_BUTTONS.length} 项快捷按钮；只影响快捷按钮，
                  不影响其他设置。替换只改本地编辑，仍需点「保存快捷按钮」才生效。
                </p>
                <ul className="flex flex-col gap-1 rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                  {DEFAULT_QUICK_BUTTONS.map((button) => (
                    <li key={button.id}>{button.name}</li>
                  ))}
                </ul>
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
                setDraft(cloneDefaultButtons());
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
