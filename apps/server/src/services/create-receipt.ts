import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Db } from "../db/client";
import { createReceipts } from "../db/create-receipt-schema";
import { canonicalJsonOf } from "../lib/canonical-json";
import { HttpError } from "../lib/http-error";

type CreateKind = typeof createReceipts.$inferSelect.kind;

/** 只保存资源标识和计数。回执重放时，各入口按当前授权重新投影。 */
export function createOnce<T>(
  db: Db,
  kind: CreateKind,
  actorId: string,
  operationId: string,
  payload: unknown,
  resultSchema: z.ZodType<T>,
  create: (db: Db) => T,
): T {
  const requestHash = createHash("sha256")
    .update(canonicalJsonOf(payload))
    .digest("hex");
  return db.transaction(
    (tx) => {
      const receipt = tx
        .select()
        .from(createReceipts)
        .where(
          and(
            eq(createReceipts.kind, kind),
            eq(createReceipts.actorId, actorId),
            eq(createReceipts.operationId, operationId),
          ),
        )
        .get();
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          throw new HttpError(
            409,
            "CREATE_OPERATION_MISMATCH",
            "这次创建操作已用于另一份请求",
          );
        return resultSchema.parse(JSON.parse(receipt.resultJson));
      }
      // 下层建卷/布置事务在同一连接上执行，作为外层事务的保存点。
      const result = create(Object.assign(tx, { $client: db.$client }));
      tx.insert(createReceipts)
        .values({
          kind,
          actorId,
          operationId,
          requestHash,
          resultJson: JSON.stringify(result),
        })
        .run();
      return result;
    },
    { behavior: "immediate" },
  );
}
