import { existsSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";

const gate = process.env.OWNCLASS_TEST_AMENDMENT_STAGE_GATE;
if (!gate) throw new Error("缺少教师勘误暂停点");
const nativeTransaction = Database.prototype.transaction;
const delay = new Int32Array(new SharedArrayBuffer(4));
Database.prototype.transaction = function transaction(callback) {
  const native = nativeTransaction.call(this, callback);
  return Object.assign((...args) => native(...args), {
    default: native.default,
    deferred: native.deferred,
    exclusive: native.exclusive,
    database: native.database,
    immediate(...args) {
      const result = native.immediate(...args);
      if (!result?.intent || !result?.teacherId || !result?.operationId)
        return result;
      writeFileSync(
        gate,
        JSON.stringify({
          attemptId: result.attemptId,
          operationId: result.operationId,
        }),
      );
      const release = `${gate}.${result.operationId}.release`;
      const deadline = Date.now() + 40_000;
      while (!existsSync(release) && Date.now() < deadline)
        Atomics.wait(delay, 0, 0, 50);
      if (!existsSync(release)) throw new Error("测试未释放教师勘误暂停点");
      return result;
    },
  });
};
