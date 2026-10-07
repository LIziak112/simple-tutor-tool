/**
 * 封存订正的展示共享件（T6R.15 闸门修复 F12 最小版抽取）：结果页订正区
 * （CorrectionSection）与题目笔记本页（StudentQuestionNotebookPage）此前
 * 双写「已封存行收窄 + 反思分栏」。此处导出谓词 sealedCorrectionsOf（顺带
 * 给笔记本页 sealedAt: string 的精确类型）与 ReflectionColumns（「我卡在
 * 哪里/我的错因」分栏 JSX）；不抽整卡（两页卡片形态有意不同：结果页带
 * 「订正 n」序号与图标，笔记本页不带）。
 */
import type { NoteRecordMeta } from "@tutor/contract";

/** 已封存行类型收窄（sealedAt 非空；服务端保证封存行 sealedAt 恒非空） */
export type SealedCorrection = NoteRecordMeta & { sealedAt: string };

/** 订正行的已封存段（sealedAt 非空收窄；openCorrectionOf 的对侧） */
export function sealedCorrectionsOf(
  rows: readonly NoteRecordMeta[],
): SealedCorrection[] {
  return rows.filter((row): row is SealedCorrection => row.sealedAt != null);
}

/** 反思行的最小消费面（两页共用；NoteRecordMeta 的 Pick） */
type ReflectionRow = Pick<NoteRecordMeta, "stuckAt" | "errorCause">;

/** 封存反思分栏：「我卡在哪里」/「我的错因」两栏（未填不渲染对应栏） */
export function ReflectionColumns({ row }: { row: ReflectionRow }) {
  return (
    <>
      {row.stuckAt != null && row.stuckAt !== "" && (
        <p className="text-sm">
          <span className="text-muted-foreground">我卡在哪里：</span>
          {row.stuckAt}
        </p>
      )}
      {row.errorCause != null && row.errorCause !== "" && (
        <p className="text-sm">
          <span className="text-muted-foreground">我的错因：</span>
          {row.errorCause}
        </p>
      )}
    </>
  );
}
