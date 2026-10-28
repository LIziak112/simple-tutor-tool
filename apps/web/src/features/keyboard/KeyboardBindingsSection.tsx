import { ChevronDown, Keyboard, RotateCcw } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { isImeComposing } from "@/features/attempt/practice-keyboard";
import {
  findConflicts,
  formatKeys,
  PRACTICE_KEYBOARD_COMMANDS,
  resolveBindings,
} from "./command-registry";
import { specOf } from "./key-spec";
import {
  saveKeyboardBindings,
  useKeyboardBindingState,
} from "./keyboard-binding-store";
import { useKeyboardDevice } from "./keyboard-device";

/**
 * 学生设置「学习偏好 → 自定义键位」分区（2026-10-28 快捷键体系）：
 * - 仅键盘设备渲染（纯触控 iPad / 手机不出现，功能全走屏上按钮）；
 * - 录制式改键：点击「修改」后监听下一次按键（Esc 取消；Ctrl/Alt/Cmd 组合
 *   与不可绑定键行内给原因文案），录制监听在 window 捕获阶段消费按键；
 * - 冲突即时检测（findConflicts）：冲突行标红并与『占先命令』对因说明，
 *   存在冲突时保存禁用——撞固定键（1–9 选项数字）同样拒绝；
 * - 暂存-保存（沿用做题方式区先例）：选择暂存、保存生效、后台重取
 *   （跨标签保存）不覆盖本地编辑、可显式载入已保存值；
 * - 「恢复默认键位」= 草稿置空覆盖表（仍走保存生效）；固定命令只读展示。
 */
export function KeyboardBindingsSection(): ReactNode | null {
  const keyboardDevice = useKeyboardDevice();
  if (!keyboardDevice) return null;
  return <KeyboardBindingsEditor />;
}

function KeyboardBindingsEditor(): ReactNode {
  const saved = useKeyboardBindingState();
  const [draft, setDraft] = useState<{
    bindings: Record<string, readonly string[]>;
    base: Readonly<Record<string, readonly string[]>>;
    owner: string | null;
  } | null>(null);
  const [recording, setRecording] = useState<string | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(
    null,
  );

  const selected = draft?.bindings ?? saved.bindings;
  const dirty =
    draft !== null &&
    JSON.stringify(draft.bindings) !== JSON.stringify(saved.bindings);
  const baseChanged =
    draft !== null &&
    JSON.stringify(draft.base) !== JSON.stringify(saved.bindings);
  const conflicts = useMemo(
    () => findConflicts(PRACTICE_KEYBOARD_COMMANDS, selected),
    [selected],
  );
  const resolvedDraft = useMemo(
    () => resolveBindings(PRACTICE_KEYBOARD_COMMANDS, selected),
    [selected],
  );
  const bound = saved.accountId !== null;

  // 录制监听：window 捕获阶段消费按键（preventDefault 防浏览器快捷键如 /
  // 快速查找；stopPropagation 防页面级监听把录制键当业务输入）
  useEffect(() => {
    if (recording === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        setRecordError(null);
        return;
      }
      // IME 合成中间态：不退出录制也不改键，等下一次真实按键
      if (isImeComposing(event)) return;
      const spec = specOf(event);
      if (spec === null) {
        setRecordError(
          event.ctrlKey || event.altKey || event.metaKey
            ? "不支持含 Ctrl / Alt / Cmd 的组合，请换一个键"
            : "该键不可绑定，请换一个键",
        );
        return;
      }
      const target = recording;
      setRecordError(null);
      setRecording(null);
      setDraft((prev) => ({
        bindings: {
          ...(prev?.bindings ?? saved.bindings),
          [target]: [spec],
        },
        base: prev?.base ?? saved.bindings,
        owner: saved.accountId,
      }));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [recording, saved.bindings, saved.accountId]);

  const resetDraft = () => {
    setDraft(null);
    setRecording(null);
    setRecordError(null);
  };

  return (
    <details className="group">
      <summary className="flex min-h-16 cursor-pointer list-none items-center gap-4 p-5 focus-visible:outline-2 focus-visible:outline-ring sm:p-6 [&::-webkit-details-marker]:hidden">
        <Keyboard
          aria-hidden
          className="size-5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 space-y-1">
          <span className="block font-medium">自定义键位</span>
          {dirty && (
            <span className="block text-xs font-medium text-primary">
              有未保存更改
            </span>
          )}
          <span className="block text-sm text-muted-foreground">
            修改单题专注作答的键盘快捷键；触屏作答不受影响。
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground group-open:rotate-180"
        />
      </summary>
      <div className="border-t border-border p-4 sm:p-6">
        {!bound ? (
          <p className="text-sm text-muted-foreground">登录后可修改键位。</p>
        ) : (
          <>
            <ul className="space-y-2">
              {PRACTICE_KEYBOARD_COMMANDS.map((command) => {
                const conflict = conflicts.find(
                  (item) => item.commandId === command.id,
                );
                const isRecording = recording === command.id;
                return (
                  <li
                    key={command.id}
                    className={`flex min-h-11 items-center justify-between gap-3 rounded-lg border p-3 ${
                      conflict ? "border-destructive" : "border-border"
                    }`}
                  >
                    <div className="min-w-0 space-y-0.5">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {command.label}
                        {!command.customizable && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                            固定
                          </span>
                        )}
                      </p>
                      <p className="text-xs leading-5 text-muted-foreground">
                        {command.description}
                      </p>
                      {conflict && (
                        <p
                          role="alert"
                          className="text-xs text-destructive"
                        >{`与『${conflict.otherLabel}』冲突，请换一个键`}</p>
                      )}
                      {isRecording && (
                        <p className="text-xs font-medium text-primary">
                          按下新快捷键，Esc 取消
                          {recordError !== null && ` · ${recordError}`}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <kbd className="rounded-md border border-border bg-muted px-2 py-1 text-xs font-medium">
                        {isRecording
                          ? "…"
                          : formatKeys(resolvedDraft[command.id])}
                      </kbd>
                      {command.customizable && (
                        <Button
                          variant="outline"
                          className="min-h-11"
                          onClick={() => {
                            setRecording(isRecording ? null : command.id);
                            setRecordError(null);
                          }}
                        >
                          {isRecording ? "取消" : "修改"}
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {baseChanged && (
              <p className="mt-3 text-sm text-muted-foreground">
                其他页面已修改键位，你的选择已保留。
                <Button
                  variant="link"
                  className="min-h-11"
                  onClick={resetDraft}
                >
                  载入已保存值
                </Button>
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button
                className="min-h-11"
                disabled={!dirty || conflicts.length > 0}
                onClick={() => {
                  try {
                    saveKeyboardBindings(selected, draft?.owner);
                    setDraft(null);
                    setRecording(null);
                    setNotice({ error: false, text: "键位已保存" });
                  } catch {
                    setNotice({
                      error: true,
                      text: "未能保存键位，请确认账号和浏览器存储后重试。",
                    });
                  }
                }}
              >
                保存键位
              </Button>
              {dirty && (
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={resetDraft}
                >
                  取消更改
                </Button>
              )}
              <Button
                variant="outline"
                className="min-h-11"
                disabled={Object.keys(selected).length === 0 && !dirty}
                onClick={() => {
                  setDraft((prev) => ({
                    bindings: {},
                    base: prev?.base ?? saved.bindings,
                    owner: saved.accountId,
                  }));
                  setRecording(null);
                  setRecordError(null);
                }}
              >
                <RotateCcw aria-hidden className="size-4" />
                恢复默认键位
              </Button>
              {dirty && (
                <span className="text-sm text-muted-foreground">
                  有未保存更改
                </span>
              )}
            </div>
            {notice && (
              <p
                role={notice.error ? "alert" : "status"}
                className={`mt-2 text-sm ${notice.error ? "text-destructive" : "text-muted-foreground"}`}
              >
                {notice.text}
              </p>
            )}
          </>
        )}
      </div>
    </details>
  );
}
