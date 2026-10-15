import { GraduationCap } from "lucide-react";
import { BRAND_NAME, BRAND_TAGLINE } from "@/lib/brand";

export function Brand({
  compact = false,
  compactLabel = "教师工作台",
}: {
  compact?: boolean;
  compactLabel?: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`flex shrink-0 items-center justify-center rounded-[10px] bg-primary text-primary-foreground ${compact ? "size-[34px]" : "size-10"}`}
      >
        <GraduationCap aria-hidden className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="text-xl font-semibold leading-tight tracking-tight">
          {BRAND_NAME}
        </p>
        <p
          lang={compact ? "zh-CN" : "en"}
          className="mt-1 text-xs leading-relaxed text-muted-foreground"
        >
          {compact ? compactLabel : BRAND_TAGLINE}
        </p>
      </div>
    </div>
  );
}
