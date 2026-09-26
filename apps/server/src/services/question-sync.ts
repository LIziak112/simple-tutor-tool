import type { Question } from "@tutor/contract";
import { eq } from "drizzle-orm";
// 本模块会被 reparse CLI（Node 24 原生类型剥离运行）经 reparse-service 间接导入，
// 相对导入必须带 .ts 扩展名（见 tsconfig.base.json 注释与 tutor-lint 先例）
import type { Db } from "../db/client.ts";
import { knowledgePoints, questionKnowledge } from "../db/schema.ts";

/**
 * 题目结构化字段与考点关联的落库辅助（T1.10 起被导入/单题编辑共用，T1.14 起
 * reparse 命令同样复用——三处语义必须完全一致，因此收进本模块，禁止各自复制一份）：
 * - questionFields：解析出的 Question → questions 表列（不含 id/version/deletedAt）；
 * - syncQuestionKnowledge：考点同名归一（knowledge_points 复用 + 关联全量替换）；
 * - loadKnowledgeIdByName：全量考点名 → id 映射（归一复用的查询入口）。
 */

/** 事务回调拿到的数据库句柄类型（better-sqlite3 同步事务） */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 题目结构化字段（不含 id/version；update 与 insert 共用） */
export function questionFields(
  question: Question,
  unitId: string,
  order: number,
  now: string,
): {
  unitId: string;
  order: number;
  type: Question["type"];
  difficulty: number;
  stemMd: string;
  optionsJson: string | null;
  answersJson: string | null;
  hintsJson: string;
  solutionMd: string | null;
  sourceMd: string;
  updatedAt: string;
} {
  return {
    unitId,
    order,
    type: question.type,
    difficulty: question.difficulty,
    stemMd: question.stemMd,
    optionsJson:
      question.options !== undefined ? JSON.stringify(question.options) : null,
    answersJson:
      question.answers !== undefined ? JSON.stringify(question.answers) : null,
    hintsJson: JSON.stringify(question.hints),
    solutionMd: question.solutionMd ?? null,
    sourceMd: question.sourceMd,
    updatedAt: now,
  };
}

/** 全量考点名 → id 映射（同名归一复用的基准；调用方在事务内传入 tx 保证一致读） */
export function loadKnowledgeIdByName(db: Tx): Map<string, string> {
  return new Map(
    db
      .select({ id: knowledgePoints.id, name: knowledgePoints.name })
      .from(knowledgePoints)
      .all()
      .map((row) => [row.name, row.id] as const),
  );
}

/** 同步题目的考点关联：同名 knowledge_point 复用（无则建），关联全量替换 */
export function syncQuestionKnowledge(
  tx: Tx,
  question: Question,
  knowledgeIdByName: Map<string, string>,
): void {
  tx.delete(questionKnowledge)
    .where(eq(questionKnowledge.questionId, question.id))
    .run();
  const seen = new Set<string>();
  for (const name of question.knowledge) {
    if (seen.has(name)) continue; // 同名去重（关联表复合主键）
    seen.add(name);
    let pointId = knowledgeIdByName.get(name);
    if (pointId === undefined) {
      pointId = crypto.randomUUID();
      tx.insert(knowledgePoints).values({ id: pointId, name }).run();
      knowledgeIdByName.set(name, pointId);
    }
    tx.insert(questionKnowledge)
      .values({ questionId: question.id, knowledgePointId: pointId })
      .run();
  }
}
