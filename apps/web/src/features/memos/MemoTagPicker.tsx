import {
  MEMO_PRESET_TAGS,
  MEMO_TAGS_MAX,
  normalizeMemoTags,
} from "@tutor/contract";
import { useEffect, useState } from "react";
import { memoTagSuggestionsApi } from "@/lib/memo-enhancement-api";
import { splitMemoTagInput } from "./memo-format";
/** 自由输入与快捷项共用同一份草稿，满额时仍可取消已选标签。 */
export function MemoTagPicker({
  id,
  value,
  onChange,
  disabled,
  account,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  account: string | null;
}) {
  const [common, setCommon] = useState<{
    account: string | null;
    tags: string[];
  }>({ account: null, tags: [] });
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (account !== null)
        void memoTagSuggestionsApi()
          .then((data) => {
            if (active) setCommon({ account, tags: data.tags });
          })
          .catch(() => {});
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [account]);
  const selected = normalizeMemoTags(splitMemoTagInput(value));
  const options = [
    ...new Set([
      ...MEMO_PRESET_TAGS,
      ...(common.account === account ? common.tags : []),
      ...selected,
    ]),
  ];
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="sr-only">
        标签
      </label>
      <input
        id={id}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="标签（逗号分隔，最多5个）"
        className="min-h-11 rounded-lg border bg-background px-3 text-sm"
      />
      <div className="flex flex-wrap gap-1">
        {options.map((tag) => {
          const active = selected.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              aria-pressed={active}
              disabled={
                disabled || (!active && selected.length >= MEMO_TAGS_MAX)
              }
              className="min-h-11 rounded-lg border px-3 text-xs aria-pressed:bg-primary/10"
              onClick={() =>
                onChange(
                  (active
                    ? selected.filter((t) => t !== tag)
                    : [...selected, tag]
                  ).join(", "),
                )
              }
            >
              {tag}
            </button>
          );
        })}
      </div>
      {splitMemoTagInput(value).length > MEMO_TAGS_MAX && (
        <span role="alert" className="text-xs text-destructive">
          标签最多 {MEMO_TAGS_MAX} 个
        </span>
      )}
    </div>
  );
}
