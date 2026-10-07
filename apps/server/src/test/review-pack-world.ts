import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { QuestionAnswers } from "@tutor/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { noteImages, responses as responsesTable } from "../db/schema.ts";
import { attachNoteImage, saveNoteVersion } from "../services/note-service.ts";
import {
  frozenDraftAttempt,
  snapshotJsonOf,
  submitAttemptStatus,
} from "./evidence-fixtures.ts";
import { gzipJson, makeNotePng, noteDoc } from "./note-fixtures.ts";
import { insertEvidence } from "./note-world.ts";

/**
 * review-pack 测试共享世界件（T6R.13 /simplify D10）：服务测试与学生/教师
 * 路由测试原先各自手写同一六步序列——直插冻结行（题干带答案/解析/提示
 * 哨兵）→ 存草稿 → 附分析图 →（可选直插 pending 行）→ 置已交卷 → 插
 * frozen 证据行 →（可选教师批注哨兵）。参数化收敛，哨兵文案可注入。
 *
 * 产物：attemptId / versionId / analysisPath（ready 分析图行对应盘上路径，
 * 删除做「丢图片/生成期间状态变化」用例用）。
 */

/** 泄露哨兵默认值（题库侧秘密内容，学生包任何文件不得出现） */
export const REVIEW_SENTINELS = {
  answer: "42",
  solution: "哨兵解析：先算括号内再取相反数",
  hint: "哨兵提示：从数轴方向入手",
  comment: "哨兵评语：过程跳步需当面确认",
} as const;

export interface ReviewPackWorldOptions {
  studentId: string;
  /** 卷内题号即 questionId（缺省「复习题-1」） */
  questionId?: string;
  /** 题干（缺省含 [[answer 哨兵]] 的填空题） */
  stemMd?: string;
  /** 不建草稿（缺省建：存稿 + 一页 ready 分析图 + frozen 证据） */
  withNote?: boolean;
  /** 直插 pending 态分析图行（未生成 → 显式缺失原因用例） */
  pendingAnalysisRow?: boolean;
  /** 教师批注（评语哨兵 + 判错——学生包绝不携带） */
  mark?: boolean;
  /** 哨兵文案覆盖（路由测试沿用各自历史文案时注入） */
  sentinels?: Partial<Record<keyof typeof REVIEW_SENTINELS, string>>;
}

export interface ReviewPackWorld {
  readonly attemptId: string;
  readonly questionId: string;
  readonly versionId: string | null;
  /** ready 分析图的盘上绝对路径（withNote=false 为 null） */
  readonly analysisPath: string | null;
}

/** 世界构建（六步序列；夹具直插口径同 evidence-fixtures/note-world 注释） */
export function makeReviewPackWorld(
  db: Db,
  dataDir: string,
  options: ReviewPackWorldOptions,
): ReviewPackWorld {
  const questionId = options.questionId ?? "复习题-1";
  const sentinel = { ...REVIEW_SENTINELS, ...options.sentinels };
  const stemMd =
    options.stemMd ??
    `计算 $(-3)+7-(-2)$ 的结果，填在括号里：[[${sentinel.answer}]]`;
  const { attemptId } = frozenDraftAttempt(db, options.studentId, [
    {
      questionId,
      snapshotJson: snapshotJsonOf({
        id: questionId,
        stemMd,
        answers: {
          kind: "fill",
          blanks: [[sentinel.answer]],
        } satisfies QuestionAnswers,
        solutionMd: sentinel.solution,
        hints: [sentinel.hint],
      }),
    },
  ]);
  let versionId: string | null = null;
  let analysisPath: string | null = null;
  if (options.withNote !== false) {
    const receipt = saveNoteVersion(
      db,
      dataDir,
      options.studentId,
      attemptId,
      questionId,
      gzipJson(noteDoc(3, 40)),
      { baseRevision: 0, mutationId: randomUUID() },
    );
    versionId = receipt.versionId;
    attachNoteImage(
      db,
      dataDir,
      { kind: "student", id: options.studentId },
      receipt.versionId,
      makeNotePng(1000, 800),
      {
        spec: "analysis",
        pageIndex: 0,
        crop: { x: 0, y: 0, width: 1000, height: 800 },
        pixelWidth: 1000,
        pixelHeight: 800,
      },
    );
    // noteImages.path 相对 DATA_DIR（已含 blobs/notes 前缀；root 只做包含校验）
    const row = db
      .select()
      .from(noteImages)
      .where(eq(noteImages.noteVersionId, receipt.versionId))
      .get();
    analysisPath = row === undefined ? null : join(dataDir, row.path);
    if (options.pendingAnalysisRow) {
      db.insert(noteImages)
        .values({
          id: randomUUID(),
          noteVersionId: receipt.versionId,
          spec: "analysis",
          pageIndex: 1,
          cropX: 0,
          cropY: 760,
          cropW: 1000,
          cropH: 640,
          pixelWidth: 1000,
          pixelHeight: 640,
          path: "pending/未生成.png",
          state: "pending",
        })
        .run();
    }
  }
  submitAttemptStatus(db, attemptId);
  if (options.withNote !== false) {
    insertEvidence(db, attemptId, questionId, "frozen", versionId);
  }
  if (options.mark === true) {
    db.update(responsesTable)
      .set({ teacherComment: sentinel.comment, finalCorrect: false })
      .where(eq(responsesTable.attemptId, attemptId))
      .run();
  }
  return { attemptId, questionId, versionId, analysisPath };
}
