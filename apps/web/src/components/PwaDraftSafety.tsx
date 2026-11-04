import { usePwaUpdateGuard } from "@/lib/pwa-update-safety";

/** 保稿检查常驻整页，学生编辑区卸载后仍保护模块内尚未落盘的稿件。 */
export function PwaDraftSafety() {
  usePwaUpdateGuard(
    async () => {
      const { prepareRetainedStudentDraftsForPwaUpdate } = await import(
        "@/features/attempt/pwa-draft-safety"
      );
      await prepareRetainedStudentDraftsForPwaUpdate();
    },
    "retained-student-drafts",
    true,
  );
  return null;
}
