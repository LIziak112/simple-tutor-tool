import { createHash, randomBytes } from "node:crypto";
import {
  AI_MCP_TOKEN_BYTES,
  AI_SHARE_DEFAULT_VALID_HOURS,
  type AiConnectionCreateRequest,
  type AiConnectionPatchRequest,
  type AiConnectionPublic,
  type AiConnectionTestData,
} from "@tutor/contract";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  type AiConnectionRow,
  aiConnections,
  aiTasks,
} from "../../db/schema.ts";
import { HttpError } from "../../lib/http-error.ts";
import {
  credentialFingerprint,
  openApiKey,
  sealApiKey,
} from "./connection-cipher.ts";
import { parseOutboundBaseUrl } from "./outbound-target.ts";
import {
  type ProviderTransport,
  testProviderConnection,
} from "./provider-client.ts";
import { appendAiFact } from "./student-ai-audit.ts";

/**
 * 学生 AI 连接管理服务（SAI-16，B00 §5.1 表 3 + §7「Key 保存」）。
 *
 * 安全口径（B08 攻击用例表逐行落地的服务层部分）：
 * - secret：明文 Key 只进 sealApiKey 一次；明文 MCP token 只在创建/重置
 *   响应出现一次；库内 configJson 只存密文/哈希/指纹，读接口只回指纹；
 * - key：解密失败统一置 needs_rekey（可解释、可重填恢复），测试连接对
 *   needs_rekey 行直接返回不出站（不无限重试撞明文）；
 * - SSRF 入口：创建/更新 inapp 的 baseUrl 先过 parseOutboundBaseUrl 静态
 *   策略（内网/localhost/云元数据/UserInfo 拒绝；真实调用另有连接级守卫）；
 * - restore/revoke：重置 token 旧哈希立即覆盖失效；删除连接软删
 *   （archivedAt）+ 停发该通道 created 任务（cancelled + 事实），历史
 *   行与已出站任务不动（事实锚点不物理删）；
 * - capability：测试连接只证明连通与 Key 有效，不改 imageCapability
 *   （unknown 不因连通变 supported）；探针固定文案不带题面。
 *
 * 归属与防枚举：一切按 (studentId, connectionId) 复查，不符 → 404
 * NOT_FOUND 同文案（与任务接口一致，不区分不存在/无权）。
 */

// ---------- configJson 内部形态（schema.ts ai_connections 表注释单源） ----------

interface InappConnectionConfig {
  readonly baseUrl: string;
  readonly model: string;
  readonly keyCiphertext: string;
  readonly keyIv: string;
  readonly keyTag: string;
  readonly keyFingerprint: string;
  readonly cipherVersion: number;
  readonly imageCapability: "unknown" | "supported" | "unsupported";
}

interface McpConnectionConfig {
  readonly tokenHash: string;
  readonly tokenFingerprint: string;
}

interface LinkConnectionConfig {
  readonly defaultValidHours: number;
}

/** MCP/分享凭证分用途域前缀：与学生登录链接 Token 的哈希域隔离 */
const MCP_TOKEN_PURPOSE = "ai-mcp-token";

/** 高熵 MCP token（base64url，43 字符；独立于学生登录链接 Token 生成） */
function generateMcpToken(): string {
  return randomBytes(AI_MCP_TOKEN_BYTES).toString("base64url");
}

/** 分用途哈希（sha256 hex）：登录链接 Token 拿到本域认证查不到 */
function hashMcpToken(token: string): string {
  return createHash("sha256")
    .update(`${MCP_TOKEN_PURPOSE}:${token}`, "utf8")
    .digest("hex");
}

/** db.transaction 回调的事务参数类型（与 Db 同源的结构类型） */
type ConnTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 事务参数按 Db 传递（queue 同款口径）：两者包装同一底层连接，查询方法
 * 签名同源；断言只发生在本函数一处。
 */
function asDb(handle: Db | ConnTx): Db {
  return handle as Db;
}

/** inapp baseUrl 出站目标预检：静态策略拒绝 → 400 AI_CONNECTION_INVALID */
function guardBaseUrl(baseUrl: string): string {
  try {
    // 只要 URL 形状与目标策略通过（守卫只做静态检查，真实调用另有连接级防护）
    parseOutboundBaseUrl(baseUrl);
    return baseUrl;
  } catch (error) {
    const message =
      error instanceof Error && error.message.length > 0
        ? error.message
        : "接口地址不允许（仅支持公网 HTTPS/HTTP 目标）";
    throw new HttpError(400, "AI_CONNECTION_INVALID", message);
  }
}

/** 连接行 → 公开视图（只回指纹；configJson 不出服务层） */
function connectionViewOf(row: AiConnectionRow): AiConnectionPublic {
  const base = {
    id: row.id,
    isDefault: row.isDefault,
    verifyStatus: row.verifyStatus,
    verifiedAt: row.verifiedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.channel === "inapp") {
    const config = JSON.parse(row.configJson) as InappConnectionConfig;
    return {
      ...base,
      channel: "inapp",
      baseUrl: config.baseUrl,
      model: config.model,
      keyFingerprint: config.keyFingerprint,
      imageCapability: config.imageCapability,
    };
  }
  if (row.channel === "mcp") {
    const config = JSON.parse(row.configJson) as McpConnectionConfig;
    return {
      ...base,
      channel: "mcp",
      tokenFingerprint: config.tokenFingerprint,
    };
  }
  const config = JSON.parse(row.configJson) as LinkConnectionConfig;
  return {
    id: row.id,
    channel: "link",
    defaultValidHours: config.defaultValidHours,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 查本人 active 连接行：不存在/已归档/他人连接 → 404 同文案（防枚举） */
function loadActiveConnection(
  db: Db,
  studentId: string,
  connectionId: string,
): AiConnectionRow {
  const row = db
    .select()
    .from(aiConnections)
    .where(
      and(
        eq(aiConnections.id, connectionId),
        eq(aiConnections.studentId, studentId),
        isNull(aiConnections.archivedAt),
      ),
    )
    .get();
  if (row === undefined) {
    throw new HttpError(404, "NOT_FOUND", "连接不存在");
  }
  return row;
}

/** 设默认（学生维度跨通道唯一）：事务内先清后设 */
function assignDefault(db: Db, studentId: string, connectionId: string): void {
  db.update(aiConnections)
    .set({ isDefault: false })
    .where(
      and(
        eq(aiConnections.studentId, studentId),
        isNull(aiConnections.archivedAt),
        eq(aiConnections.isDefault, true),
      ),
    )
    .run();
  db.update(aiConnections)
    .set({ isDefault: true })
    .where(eq(aiConnections.id, connectionId))
    .run();
}

// ---------- 读取 ----------

/** GET /ai/connections：本人 active 连接列表（只含公开视图） */
export function listStudentAiConnections(
  db: Db,
  studentId: string,
): AiConnectionPublic[] {
  return db
    .select()
    .from(aiConnections)
    .where(
      and(
        eq(aiConnections.studentId, studentId),
        isNull(aiConnections.archivedAt),
      ),
    )
    .all()
    .map(connectionViewOf);
}

// ---------- 页内派发连接解析（SAI-17 worker 消费，纯增不改既有语义） ----------

/** 派发用 inapp 连接解析产物（明文 Key 只在服务进程内存中流转，绝不回显） */
export interface DispatchInappConnection {
  readonly id: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly imageCapability: "unknown" | "supported" | "unsupported";
  /** 解密后的明文 API Key；null = needs_rekey（不无限重试撞明文，需重填） */
  readonly apiKey: string | null;
}

/**
 * 学生当前 active 的页内连接（同通道至多一条是创建/删除维护的不变量）。
 * 每次派发实时解析：连接被删 → null（worker 按需重配暂停任务）；解密失败
 * → apiKey null（needs_rekey 语义与连接测试一致）。
 */
export function findDispatchInappConnection(
  db: Db,
  studentId: string,
  rootSecret: string,
): DispatchInappConnection | null {
  const row = db
    .select()
    .from(aiConnections)
    .where(
      and(
        eq(aiConnections.studentId, studentId),
        eq(aiConnections.channel, "inapp"),
        isNull(aiConnections.archivedAt),
      ),
    )
    .get();
  if (row === undefined) return null;
  const config = JSON.parse(row.configJson) as InappConnectionConfig;
  const opened = openApiKey(rootSecret, {
    cipherVersion: config.cipherVersion,
    ciphertext: config.keyCiphertext,
    iv: config.keyIv,
    tag: config.keyTag,
    fingerprint: config.keyFingerprint,
  });
  return {
    id: row.id,
    baseUrl: config.baseUrl,
    model: config.model,
    imageCapability: config.imageCapability,
    apiKey: opened.ok ? opened.key : null,
  };
}

// ---------- 创建 ----------

/** POST /ai/connections：三通道创建（Key 即时密封；mcp token 一次性返回） */
export function createStudentAiConnection(
  db: Db,
  input: {
    readonly studentId: string;
    readonly rootSecret: string;
    readonly request: AiConnectionCreateRequest;
  },
): { connection: AiConnectionPublic; credential: { token: string } | null } {
  const { studentId, rootSecret, request } = input;
  // 同学生同通道至多一条 active（先查后插；并发窗口由单进程同步事务天然闭合）
  const existing = db
    .select({ id: aiConnections.id })
    .from(aiConnections)
    .where(
      and(
        eq(aiConnections.studentId, studentId),
        eq(aiConnections.channel, request.channel),
        isNull(aiConnections.archivedAt),
      ),
    )
    .get();
  if (existing !== undefined) {
    throw new HttpError(
      409,
      "AI_STATE_CONFLICT",
      "该通道已有连接，请编辑现有连接或先删除",
    );
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  let configJson: string;
  let credential: { token: string } | null = null;
  if (request.channel === "inapp") {
    guardBaseUrl(request.baseUrl);
    const sealed = sealApiKey(rootSecret, request.apiKey);
    const config: InappConnectionConfig = {
      baseUrl: request.baseUrl,
      model: request.model,
      keyCiphertext: sealed.ciphertext,
      keyIv: sealed.iv,
      keyTag: sealed.tag,
      keyFingerprint: sealed.fingerprint,
      cipherVersion: sealed.cipherVersion,
      imageCapability: request.imageCapability ?? "unknown",
    };
    configJson = JSON.stringify(config);
  } else if (request.channel === "mcp") {
    const token = generateMcpToken();
    const config: McpConnectionConfig = {
      tokenHash: hashMcpToken(token),
      tokenFingerprint: credentialFingerprint(token),
    };
    configJson = JSON.stringify(config);
    credential = { token };
  } else {
    const config: LinkConnectionConfig = {
      defaultValidHours:
        request.defaultValidHours ?? AI_SHARE_DEFAULT_VALID_HOURS,
    };
    configJson = JSON.stringify(config);
  }
  db.insert(aiConnections)
    .values({
      id,
      studentId,
      channel: request.channel,
      isDefault: false,
      configJson,
      verifyStatus: "unverified",
      verifiedAt: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    })
    .run();
  if (request.isDefault === true) {
    assignDefault(db, studentId, id);
  }
  const row = loadActiveConnection(db, studentId, id);
  return { connection: connectionViewOf(row), credential };
}

// ---------- 更新 ----------

/** PATCH /ai/connections/:id：字段按行通道适用；Key 轮换回 unverified */
export function patchStudentAiConnection(
  db: Db,
  input: {
    readonly studentId: string;
    readonly connectionId: string;
    readonly rootSecret: string;
    readonly request: AiConnectionPatchRequest;
  },
): { connection: AiConnectionPublic; credential: { token: string } | null } {
  const { studentId, connectionId, rootSecret, request } = input;
  const row = loadActiveConnection(db, studentId, connectionId);
  if (row.channel !== request.channel) {
    throw new HttpError(
      400,
      "AI_CONNECTION_INVALID",
      `该连接是 ${row.channel} 通道，不接受 ${request.channel} 通道的字段`,
    );
  }
  let credential: { token: string } | null = null;
  let verifyStatus = row.verifyStatus;
  let verifiedAt = row.verifiedAt;
  let configJson = row.configJson;
  if (request.channel === "inapp") {
    if (request.baseUrl !== undefined) guardBaseUrl(request.baseUrl);
    const config = JSON.parse(row.configJson) as InappConnectionConfig;
    // 未提交的字段保持库内原值（SAI-03 定案「缺省 = 不改」）；
    // Key 轮换时五元密文组整体替换
    const keySealed =
      request.apiKey !== undefined
        ? sealApiKey(rootSecret, request.apiKey)
        : undefined;
    const merged: InappConnectionConfig = {
      ...config,
      ...(request.baseUrl !== undefined && { baseUrl: request.baseUrl }),
      ...(request.model !== undefined && { model: request.model }),
      ...(request.imageCapability !== undefined && {
        imageCapability: request.imageCapability,
      }),
      ...(keySealed !== undefined && {
        keyCiphertext: keySealed.ciphertext,
        keyIv: keySealed.iv,
        keyTag: keySealed.tag,
        keyFingerprint: keySealed.fingerprint,
        cipherVersion: keySealed.cipherVersion,
      }),
    };
    configJson = JSON.stringify(merged);
    if (request.apiKey !== undefined) {
      // Key 轮换：验证状态回 unverified（不凭新 Key 存在宣称在线）
      verifyStatus = "unverified";
      verifiedAt = null;
    }
  } else if (request.channel === "mcp") {
    const config = JSON.parse(row.configJson) as McpConnectionConfig;
    let tokenHash = config.tokenHash;
    let tokenFingerprint = config.tokenFingerprint;
    if (request.resetToken === true) {
      const token = generateMcpToken();
      tokenHash = hashMcpToken(token);
      tokenFingerprint = credentialFingerprint(token);
      credential = { token };
    }
    configJson = JSON.stringify({ tokenHash, tokenFingerprint });
  } else {
    const config = JSON.parse(row.configJson) as LinkConnectionConfig;
    configJson = JSON.stringify({
      defaultValidHours: request.defaultValidHours ?? config.defaultValidHours,
    });
  }
  db.update(aiConnections)
    .set({
      configJson,
      verifyStatus,
      verifiedAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(aiConnections.id, connectionId))
    .run();
  if (request.isDefault === true) {
    assignDefault(db, studentId, connectionId);
  } else if (request.isDefault === false) {
    db.update(aiConnections)
      .set({ isDefault: false })
      .where(eq(aiConnections.id, connectionId))
      .run();
  }
  const updated = loadActiveConnection(db, studentId, connectionId);
  return { connection: connectionViewOf(updated), credential };
}

// ---------- 删除 ----------

/**
 * DELETE /ai/connections/:id：软删 + 停发该通道未执行任务。
 * created 任务 → cancelled（每条记 cancelled 事实，detail 注明原因）；
 * dispatching/claimed/uncertain 已出站不可召回、replied/failed 是历史事实，
 * 一律不动（行保留为事实锚点）。删除默认连接不自动补默认（学生重选）。
 */
export function deleteStudentAiConnection(
  db: Db,
  input: {
    readonly studentId: string;
    readonly connectionId: string;
  },
): { id: string } {
  const { studentId, connectionId } = input;
  const row = loadActiveConnection(db, studentId, connectionId);
  const now = new Date().toISOString();
  db.transaction((tx) => {
    tx.update(aiConnections)
      .set({ archivedAt: now, isDefault: false, updatedAt: now })
      .where(eq(aiConnections.id, connectionId))
      .run();
    // 停发该通道未执行任务（迟到领取/回执按任务状态机与 token 失效自然拒绝）
    const pending = tx
      .select()
      .from(aiTasks)
      .where(
        and(
          eq(aiTasks.studentId, studentId),
          eq(aiTasks.channel, row.channel),
          eq(aiTasks.status, "created"),
        ),
      )
      .all();
    for (const task of pending) {
      tx.update(aiTasks)
        .set({ status: "cancelled", updatedAt: now })
        .where(eq(aiTasks.id, task.id))
        .run();
      appendAiFact(asDb(tx), {
        task,
        type: "cancelled",
        detail: { reason: "connection_deleted", connectionId },
      });
    }
  });
  return { id: connectionId };
}

// ---------- 测试连接 ----------

/**
 * POST /ai/connections/:id/test：一次真实测试调用（固定探针、小 max_tokens、
 * 测试时限）。成功 → verified；供应商拒绝/网络失败 → failed；解密失败 →
 * 行置 needs_rekey 且可解释返回（此后再测直接返回，不出站）。探针不带
 * 题面/学生数据（capability 行），成功不改 imageCapability。
 */
export async function testStudentAiConnection(
  db: Db,
  input: {
    readonly studentId: string;
    readonly connectionId: string;
    readonly rootSecret: string;
  },
  deps: { readonly transport?: ProviderTransport } = {},
): Promise<AiConnectionTestData> {
  const { studentId, connectionId, rootSecret } = input;
  const row = loadActiveConnection(db, studentId, connectionId);
  if (row.channel !== "inapp") {
    throw new HttpError(
      400,
      "AI_CONNECTION_INVALID",
      row.channel === "mcp"
        ? "远程 MCP 连接由领取方驱动，无需测试连接"
        : "上下文链接通道没有出站目标，无需测试连接",
    );
  }
  const needsRekeyResult: AiConnectionTestData = {
    verifyStatus: "needs_rekey",
    verifiedAt: null,
    message: "连接密钥待重填：请重新保存 API Key 后再测试",
  };
  if (row.verifyStatus === "needs_rekey") {
    return needsRekeyResult;
  }
  const config = JSON.parse(row.configJson) as InappConnectionConfig;
  const opened = openApiKey(rootSecret, {
    cipherVersion: config.cipherVersion,
    ciphertext: config.keyCiphertext,
    iv: config.keyIv,
    tag: config.keyTag,
    fingerprint: config.keyFingerprint,
  });
  if (!opened.ok) {
    // secret.key 丢失/更换或密文损坏：置 needs_rekey（可解释降级，不抛堆栈）
    db.update(aiConnections)
      .set({ verifyStatus: "needs_rekey", updatedAt: new Date().toISOString() })
      .where(eq(aiConnections.id, connectionId))
      .run();
    return needsRekeyResult;
  }
  const result = await testProviderConnection({
    baseUrl: config.baseUrl,
    apiKey: opened.key,
    model: config.model,
    ...(deps.transport !== undefined && { transport: deps.transport }),
  });
  const now = new Date().toISOString();
  if (result.ok) {
    db.update(aiConnections)
      .set({ verifyStatus: "verified", verifiedAt: now, updatedAt: now })
      .where(eq(aiConnections.id, connectionId))
      .run();
    return {
      verifyStatus: "verified",
      verifiedAt: now,
      message: "连接成功，可以正常发送",
    };
  }
  db.update(aiConnections)
    .set({ verifyStatus: "failed", updatedAt: now })
    .where(eq(aiConnections.id, connectionId))
    .run();
  return { verifyStatus: "failed", verifiedAt: null, message: result.message };
}

// ---------- MCP token 认证（学生 MCP 领取入口共用，SAI-18 接线） ----------

/**
 * 按 token 找 active mcp 连接：哈希命中即返回归属。错 token / 已重置 /
 * 已删除（archived）/ 非 mcp 行 / 登录链接 Token（分用途域不同）→ null。
 */
export function findActiveMcpConnectionByToken(
  db: Db,
  token: string,
): { id: string; studentId: string } | null {
  const tokenHash = hashMcpToken(token);
  const rows = db
    .select({
      id: aiConnections.id,
      studentId: aiConnections.studentId,
      configJson: aiConnections.configJson,
    })
    .from(aiConnections)
    .where(
      and(eq(aiConnections.channel, "mcp"), isNull(aiConnections.archivedAt)),
    )
    .all();
  for (const row of rows) {
    const config = JSON.parse(row.configJson) as McpConnectionConfig;
    if (config.tokenHash === tokenHash) {
      return { id: row.id, studentId: row.studentId };
    }
  }
  return null;
}
