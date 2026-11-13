import type { MaterialPublic, QuestionGroupPublic } from "@tutor/contract";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type AttemptContextSnapshotRow,
  attemptContextFreezes,
  attemptContextSnapshots,
} from "../db/schema.ts";
import type { RepositoryTx } from "./material-repository.ts";

/** 冻结快照实体类型 */
export type AttemptContextKind = "material" | "group";

/** 单条冻结内容（判别联合：kind 决定 snapshot 形态与来源版本语义） */
export type AttemptContextSnapshotEntry =
  | {
      readonly kind: "material";
      readonly sourceId: string;
      readonly sourceVersion: number;
      /** 学生作答所需的材料公开投影（materialPublicSchema 形态） */
      readonly snapshot: MaterialPublic;
    }
  | {
      readonly kind: "group";
      readonly sourceId: string;
      readonly sourceVersion: number;
      /** 学生作答所需的题组公开投影（questionGroupPublicSchema 形态） */
      readonly snapshot: QuestionGroupPublic;
    };

/**
 * 冻结 attempt 上下文快照（QM-06/TT-07 开卷闭包的存储入口）：同一
 * (attemptId, kind, sourceId, sourceVersion) 去重（同一材料同版本一次存储），
 * 同 ID 不同版本并存不覆盖（§5.3）。整批同事务：任一行写入失败（如 attempt
 * 不存在的 FK 冲突）→ 全批回滚（「材料快照与 responses 同时成功才算开卷
 * 成功」的原子性基础）。返回实际新插入行数（去重命中的不计）。
 */
export function freezeAttemptContextSnapshots(
  db: Db,
  attemptId: string,
  entries: readonly AttemptContextSnapshotEntry[],
  now: string,
): number {
  return db.transaction((tx) =>
    freezeAttemptContextSnapshotsWithin(tx, attemptId, entries, now),
  );
}

/**
 * freezeAttemptContextSnapshots 的事务内实现（tt-07a / QM-06）：四来源建卷
 * 把快照冻结与 attempt 行、responses 预插放进**同一个建卷事务**——开卷途中
 * 任一环节失败全回滚，不留半冻结状态（saveMaterialWithin 同款形态）。
 */
export function freezeAttemptContextSnapshotsWithin(
  tx: RepositoryTx,
  attemptId: string,
  entries: readonly AttemptContextSnapshotEntry[],
  now: string,
): number {
  let inserted = 0;
  for (const entry of entries) {
    const result = tx
      .insert(attemptContextSnapshots)
      .values({
        id: crypto.randomUUID(),
        attemptId,
        kind: entry.kind,
        sourceId: entry.sourceId,
        sourceVersion: entry.sourceVersion,
        snapshotJson: JSON.stringify(entry.snapshot),
        frozenAt: now,
      })
      .onConflictDoNothing({
        target: [
          attemptContextSnapshots.attemptId,
          attemptContextSnapshots.kind,
          attemptContextSnapshots.sourceId,
          attemptContextSnapshots.sourceVersion,
        ],
      })
      .run();
    inserted += result.changes;
  }
  tx.insert(attemptContextFreezes)
    .values({ attemptId, frozenAt: now })
    .onConflictDoNothing()
    .run();
  return inserted;
}

export function hasAttemptContextFreeze(db: Db, attemptId: string): boolean {
  return (
    db
      .select({ id: attemptContextFreezes.attemptId })
      .from(attemptContextFreezes)
      .where(eq(attemptContextFreezes.attemptId, attemptId))
      .get() !== undefined
  );
}

/** 某卷全部冻结上下文（作答渲染/导出/错题重练只读快照的读取入口） */
export function listAttemptContextSnapshots(
  db: Db,
  attemptId: string,
): AttemptContextSnapshotRow[] {
  return db
    .select()
    .from(attemptContextSnapshots)
    .where(eq(attemptContextSnapshots.attemptId, attemptId))
    .orderBy(
      asc(attemptContextSnapshots.kind),
      asc(attemptContextSnapshots.sourceId),
      asc(attemptContextSnapshots.sourceVersion),
    )
    .all();
}

/** 精确取一条冻结快照（(attempt, kind, sourceId, sourceVersion) 定位） */
export function getAttemptContextSnapshot(
  db: Db,
  attemptId: string,
  kind: AttemptContextKind,
  sourceId: string,
  sourceVersion: number,
): AttemptContextSnapshotRow | null {
  return (
    db
      .select()
      .from(attemptContextSnapshots)
      .where(
        and(
          eq(attemptContextSnapshots.attemptId, attemptId),
          eq(attemptContextSnapshots.kind, kind),
          eq(attemptContextSnapshots.sourceId, sourceId),
          eq(attemptContextSnapshots.sourceVersion, sourceVersion),
        ),
      )
      .get() ?? null
  );
}
