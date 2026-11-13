import { randomUUID } from "node:crypto";
import type { Db } from "../../db/client.ts";

// ---------- 运行代际（SAI-15 实施步骤 7：恢复数据库后旧运行代际失效） ----------

const connectionEpochs = new WeakMap<object, string>();

/**
 * 当前运行代际：按底层连接（db.$client）派生的不透明 token——备份恢复
 * （restoreFromBackup → DbHandle.restart 换连接）后必然变化，且不落库、
 * 不随备份回滚。出站/领取时随 generation 一并交给执行方，写回时核对：
 * 恢复后的迟到结果即使与备份内 generation 一致也按 runtime_epoch_stale
 * 记迟到事实拒绝——不能依赖备份内旧 generation 自己排除迟到结果（备份
 * 可能包含同代次的进行中行）。恢复后配置经新连接重取（Proxy 转发到
 * 当前底层连接，sqliteAiPolicyConfigSource 每次实时读库）。
 */
export function runtimeEpochOf(db: Db): string {
  const connection = db.$client;
  let epoch = connectionEpochs.get(connection);
  if (epoch === undefined) {
    epoch = randomUUID();
    connectionEpochs.set(connection, epoch);
  }
  return epoch;
}
