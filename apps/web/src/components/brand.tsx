import { GraduationCap } from "lucide-react";
import { BRAND_NAME, BRAND_TAGLINE } from "@/lib/brand";

export function Brand() {
  return (
    <div className="flex items-start gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <GraduationCap aria-hidden className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="text-lg font-semibold tracking-tight">{BRAND_NAME}</p>
        <p
          lang="en"
          className="mt-1 text-xs leading-relaxed text-muted-foreground"
        >
          {BRAND_TAGLINE}
        </p>
      </div>
    </div>
  );
}
