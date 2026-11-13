import type { AiPolicyResolution } from "@tutor/contract";
import type { Db } from "../../db/client.ts";
import type { AiTaskRow } from "../../db/schema.ts";
import { sqliteAiPolicyConfigSource } from "./ai-policy-config-source.ts";
import {
  type DispatchInappConnection,
  findDispatchInappConnection,
} from "./connection-service.ts";
import { outboundPromptSnapshotOf } from "./student-ai-context.ts";
import { asDb, type QueueTx } from "./student-ai-shared.ts";
import {
  type AiPolicyConfigSource,
  resolveAttemptQuestionAiPolicy,
} from "./teaching-policy-service.ts";

export function currentTaskPolicy(
  db: Db | QueueTx,
  task: AiTaskRow,
  configSource: AiPolicyConfigSource = sqliteAiPolicyConfigSource,
): AiPolicyResolution | undefined {
  try {
    const { resolution } = resolveAttemptQuestionAiPolicy(
      asDb(db),
      task.studentId,
      task.attemptId,
      task.questionId,
      configSource,
    );
    return resolution;
  } catch {
    return undefined;
  }
}

/** 回信沿用发送时的尺度，当前策略收紧后待恢复授权再展示。 */
export function taskPolicyAllowsReply(
  task: AiTaskRow,
  resolution: AiPolicyResolution | undefined,
): boolean {
  return (
    resolution?.usable === true &&
    (resolution.mode === "open_study" || task.modeAtSend === resolution.mode)
  );
}

export function policyUsable(
  db: Db | QueueTx,
  task: AiTaskRow,
  configSource: AiPolicyConfigSource = sqliteAiPolicyConfigSource,
  purpose?: "deliver_reply",
): boolean {
  const resolution = currentTaskPolicy(db, task, configSource);
  return purpose === "deliver_reply"
    ? taskPolicyAllowsReply(task, resolution)
    : resolution?.usable === true;
}

/** 供应商退避期间规则发生变化时，让学生按新规则显式继续。 */
export function outboundRulesAreCurrent(db: Db, task: AiTaskRow): boolean {
  try {
    const arm = outboundPromptSnapshotOf(db, task, sqliteAiPolicyConfigSource);
    return (
      task.modeAtSend === arm.modeAtSend && task.promptHash === arm.promptHash
    );
  } catch {
    return false;
  }
}

export function dispatchConnectionIsCurrent(
  db: Db,
  studentId: string,
  rootSecret: string,
  sent: DispatchInappConnection,
): boolean {
  const current = findDispatchInappConnection(db, studentId, rootSecret);
  return (
    current !== null &&
    sent.id === current.id &&
    sent.baseUrl === current.baseUrl &&
    sent.model === current.model &&
    sent.imageCapability === current.imageCapability &&
    sent.apiKey === current.apiKey
  );
}
