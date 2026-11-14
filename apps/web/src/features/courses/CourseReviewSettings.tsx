import {
  REVIEW_EXAM_TYPES,
  REVIEW_TEMPLATE_PRESETS,
  reviewTemplateIdSchema,
} from "@tutor/contract";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUpdateCourse } from "./course-queries";
/** 展示配置独立于课程授权，现有课程无需补填。 */
export function CourseReviewSettings({
  courseId,
  examType,
  reviewTemplateId,
}: {
  courseId: string;
  examType?: string | null | undefined;
  reviewTemplateId?: string | null | undefined;
}) {
  const [exam, setExam] = useState(examType ?? "");
  const [template, setTemplate] = useState(reviewTemplateId ?? "");
  const [saved, setSaved] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const mutation = useUpdateCourse(courseId);
  return (
    <section
      aria-label="复盘偏好"
      className="rounded-xl border border-border bg-card p-4"
    >
      <h2 className="font-semibold">复盘偏好</h2>
      <p className="text-sm text-muted-foreground">
        只推荐结果页的展示方式，不改变题型、判分或答案公布规则；单元里指定的模板优先。
      </p>
      <form
        className="mt-3 flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setSaved(false);
          const selected = reviewTemplateIdSchema
            .nullable()
            .safeParse(template || null);
          if (!selected.success) {
            setValidationError("当前模板不可用，请重新选择默认模板。");
            return;
          }
          setValidationError(null);
          mutation.mutate(
            { examType: exam.trim() || null, reviewTemplateId: selected.data },
            { onSuccess: () => setSaved(true) },
          );
        }}
      >
        <label
          className="flex flex-col gap-1 text-sm"
          htmlFor="course-review-exam"
        >
          考试类型（可自填）
          <Input
            className="min-h-11"
            id="course-review-exam"
            list="review-exam-types"
            value={exam}
            maxLength={80}
            onChange={(e) => {
              setExam(e.target.value);
              setSaved(false);
            }}
          />
        </label>
        <datalist id="review-exam-types">
          {REVIEW_EXAM_TYPES.map((type) => (
            <option key={type} value={type} />
          ))}
        </datalist>
        <label className="flex flex-col gap-1 text-sm">
          默认复盘模板
          <select
            className="min-h-11 rounded border border-border bg-background px-2"
            aria-label="默认复盘模板"
            value={template}
            onChange={(e) => {
              setTemplate(e.target.value);
              setSaved(false);
            }}
          >
            <option value="">按考试类型和题型自动选择</option>
            {REVIEW_TEMPLATE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <Button
          className="min-h-11 w-fit"
          type="submit"
          disabled={mutation.isPending}
        >
          {mutation.isPending ? "正在保存…" : "保存复盘偏好"}
        </Button>
        {validationError && (
          <p role="alert" className="text-sm text-destructive">
            {validationError}
          </p>
        )}
        {mutation.isError && (
          <p role="alert" className="text-sm text-destructive">
            {mutation.error instanceof Error
              ? mutation.error.message
              : "保存失败，请稍后重试。"}
          </p>
        )}
        {saved && (
          <p role="status" className="text-sm">
            复盘偏好已保存。
          </p>
        )}
      </form>
    </section>
  );
}
