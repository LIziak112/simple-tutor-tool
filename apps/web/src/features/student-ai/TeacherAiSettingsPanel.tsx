import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AiSettingsSaveContext,
  type AiSettingsSaveControl,
} from "./ai-settings-save";
import { TeacherAiPromptsSection } from "./TeacherAiPromptsSection";
import { TeacherAiSettingsSection } from "./TeacherAiSettingsSection";

export function TeacherAiSettingsPanel() {
  const [controls, setControls] = useState<
    Record<string, AiSettingsSaveControl>
  >({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<"saved" | "failed" | null>(null);
  const register = useCallback(
    (id: string, control: AiSettingsSaveControl | null) => {
      setControls((previous) => {
        const next = { ...previous };
        if (control) next[id] = control;
        else delete next[id];
        return next;
      });
    },
    [],
  );
  const entries = Object.values(controls);
  const dirty = entries.some((entry) => entry.dirty);
  const blocked = entries.length < 2 || entries.some((entry) => entry.blocked);
  async function save() {
    if (saving || blocked || !dirty) return;
    setSaving(true);
    setResult(null);
    // 两个端点独立确认：成功区清草稿，失败区留在原处等待重试。
    const results = await Promise.allSettled(
      entries.filter((entry) => entry.dirty).map((entry) => entry.save()),
    );
    setResult(
      results.some((entry) => entry.status === "rejected") ? "failed" : "saved",
    );
    setSaving(false);
  }
  return (
    <AiSettingsSaveContext value={{ register }}>
      <fieldset
        disabled={saving}
        className="m-0 min-w-0 space-y-4 border-0 p-0"
      >
        <legend className="sr-only">AI 设置</legend>
        <TeacherAiSettingsSection />
        <TeacherAiPromptsSection />
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <p role="status" className="text-sm text-muted-foreground">
          {saving
            ? "正在保存…"
            : result === "failed"
              ? "部分设置未保存，已保留编辑，请重试。"
              : blocked
                ? "请先处理未完成加载或正文为空的设置。"
                : dirty
                  ? "有未保存的 AI 设置"
                  : result === "saved"
                    ? "AI 设置已保存"
                    : "当前 AI 设置已保存"}
        </p>
        <Button
          className="min-h-11 px-5"
          disabled={saving || blocked || !dirty}
          onClick={() => void save()}
        >
          {saving && <Loader2 aria-hidden className="animate-spin" />}
          保存 AI 设置
        </Button>
      </div>
    </AiSettingsSaveContext>
  );
}
