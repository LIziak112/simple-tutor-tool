import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/copy";

/**
 * 复制反馈关联被复制内容，凭据更新后不会沿用旧配置的成功状态。
 * 教师 /t/connect 与学生 /s/settings/ai 共用（example=true 时按钮标注
 * 「复制示例」，明示片段含占位符、不可直接使用）。
 */
export function CopyBlock({
  label,
  text,
  ariaLabel,
  example = false,
}: {
  label: string;
  text: string;
  ariaLabel: string;
  example?: boolean;
}) {
  const [result, setResult] = useState<{ text: string; ok: boolean } | null>(
    null,
  );
  const copied = result?.text === text && result.ok;
  const failed = result?.text === text && !result.ok;

  async function handleCopy() {
    setResult({ text, ok: await copyText(text) });
  }

  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-5 py-3">
        <p className="text-sm font-medium">{label}</p>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 px-4"
          aria-label={ariaLabel}
          onClick={() => void handleCopy()}
        >
          {copied ? (
            <>
              <Check aria-hidden />
              已复制
            </>
          ) : (
            <>
              <Copy aria-hidden />
              {example ? "复制示例" : "复制"}
            </>
          )}
        </Button>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[0.8125rem] leading-relaxed break-all whitespace-pre-wrap">
        {text}
      </pre>
      <p role="status" className="sr-only">
        {copied ? "已复制" : ""}
      </p>
      {failed && (
        <p role="alert" className="px-5 pb-4 text-sm text-destructive">
          复制失败，请选中内容手动复制。
        </p>
      )}
    </div>
  );
}
