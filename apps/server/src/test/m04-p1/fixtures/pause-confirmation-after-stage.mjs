import { existsSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";

const gate = process.env.OWNCLASS_TEST_CONFIRM_STAGE_GATE;
if (!gate) throw new Error("缺少测试交卷暂停点");
const nativeTransaction = Database.prototype.transaction;
const delay = new Int32Array(new SharedArrayBuffer(4));
const observed = new Set();
Database.prototype.transaction = function transaction(callback) {
  const native = nativeTransaction.call(this, callback);
  return Object.assign((...args) => native(...args), {
    default: native.default,
    deferred: native.deferred,
    exclusive: native.exclusive,
    database: native.database,
    immediate(...args) {
      const result = native.immediate(...args);
      if (
        !result?.request ||
        !result?.operationId ||
        !result?.stepAttemptId ||
        observed.has(result.operationId)
      )
        return result;
      observed.add(result.operationId);
      // native.immediate 已返回，确认意图和原稿预留已提交。阻塞进程，不持有 SQLite 锁。
      writeFileSync(
        gate,
        JSON.stringify({
          attemptId: result.attemptId,
          operationId: result.operationId,
        }),
      );
      const released = `${gate}.${result.operationId}.release`;
      const deadline = Date.now() + 40_000;
      while (!existsSync(released) && Date.now() < deadline)
        Atomics.wait(delay, 0, 0, 50);
      if (!existsSync(released)) throw new Error("测试未释放交卷暂停点");
      return result;
    },
  });
};
