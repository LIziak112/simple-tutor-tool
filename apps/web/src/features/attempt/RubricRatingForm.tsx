import {
  RUBRIC_EVIDENCE_MAX_CHARS,
  RUBRIC_NOTE_MAX_CHARS,
  type Rubric,
  type RubricRating,
  rubricTotalOf,
} from "@tutor/contract";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * 量表逐项打分表单（模块 3）：每项 1–N 档单选 + 一句依据（可选）+ 整体一句话。
 * 自评与「自行改写」裁定共用；只收集输入，不做任何服务端语义判断。
 * 可达性：每项一个 radiogroup（题名作 aria-label），原生 radio 键盘可切换。
 */
export function RubricRatingForm({
  rubric,
  initial,
  initialNote = "",
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  rubric: Rubric;
  initial?: readonly RubricRating[] | null;
  initialNote?: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (ratings: RubricRating[], note: string) => void;
  onCancel?: () => void;
}) {
  const formId = useId();
  const [levels, setLevels] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      (initial ?? []).map((rating) => [rating.id, rating.level]),
    ),
  );
  const [evidence, setEvidence] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (initial ?? [])
        .filter((rating) => rating.evidence !== undefined)
        .map((rating) => [rating.id, rating.evidence ?? ""]),
    ),
  );
  const [note, setNote] = useState(initialNote);
  const missing = rubric.items.filter((item) => levels[item.id] === undefined);
  const ratings: RubricRating[] = rubric.items.flatMap((item) => {
    const level = levels[item.id];
    if (level === undefined) return [];
    const text = (evidence[item.id] ?? "").trim();
    return [{ id: item.id, level, ...(text !== "" ? { evidence: text } : {}) }];
  });
  const levelOptions = Array.from({ length: rubric.levels }, (_, i) => i + 1);

  return (
    <form
      className="flex flex-col gap-3"
      data-slot="rubric-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (missing.length > 0 || busy) return;
        onSubmit(ratings, note.trim());
      }}
    >
      {rubric.items.map((item) => (
        <fieldset
          key={item.id}
          className="flex flex-col gap-1.5 rounded-lg border border-border/60 p-2.5"
        >
          <legend className="px-1 text-sm font-medium">
            {item.title}
            {item.desc !== undefined && (
              <span className="ml-1.5 font-normal text-muted-foreground">
                {item.desc}
              </span>
            )}
          </legend>
          <div
            role="radiogroup"
            aria-label={`${item.title} 档位`}
            className="flex flex-wrap gap-1.5"
          >
            {levelOptions.map((level) => {
              const checked = levels[item.id] === level;
              return (
                <label
                  key={level}
                  className={`flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-md border px-3 text-sm ${
                    checked
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border hover:bg-muted"
                  }`}
                >
                  <input
                    type="radio"
                    className="sr-only"
                    name={`${formId}-${item.id}`}
                    value={level}
                    checked={checked}
                    disabled={busy}
                    onChange={() =>
                      setLevels((prev) => ({ ...prev, [item.id]: level }))
                    }
                  />
                  {level}
                </label>
              );
            })}
          </div>
          <input
            type="text"
            className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            placeholder="一句依据（可选，引用作答原文更好）"
            aria-label={`${item.title} 依据`}
            maxLength={RUBRIC_EVIDENCE_MAX_CHARS}
            value={evidence[item.id] ?? ""}
            disabled={busy}
            onChange={(event) =>
              setEvidence((prev) => ({
                ...prev,
                [item.id]: event.target.value,
              }))
            }
          />
        </fieldset>
      ))}
      <input
        type="text"
        className="h-9 rounded-md border border-input bg-background px-2 text-sm"
        placeholder="整体一句话（可选）"
        aria-label="整体评语"
        maxLength={RUBRIC_NOTE_MAX_CHARS}
        value={note}
        disabled={busy}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          className="min-h-11"
          disabled={busy || missing.length > 0}
        >
          {submitLabel}
        </Button>
        {onCancel !== undefined && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="min-h-11"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </Button>
        )}
        <span className="text-xs text-muted-foreground" role="status">
          {missing.length > 0
            ? `还有 ${missing.length} 项未评`
            : `合计 ${rubricTotalOf(ratings)} / ${rubric.items.length * rubric.levels}`}
        </span>
      </div>
    </form>
  );
}
