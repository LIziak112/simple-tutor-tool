// 补审复核：只读取本轮已固定版本，不重新解析 latest，不修改应用源码。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const evidence = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(evidence, "../../..");
const skill =
  "C:/Users/HUAYU/AppData/Local/Temp/ownclass-unslop-20261107/skills/audit";
const require = createRequire(path.join(root, "apps/server/package.json"));
const { Client } = await import(
  pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js"))
);
const { StreamableHTTPClientTransport } = await import(
  pathToFileURL(
    require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  )
);
const {
  validateRoutedIndex,
  validateRoutedTopic,
  indexUri,
  topicUri,
  routeTopics,
} = await import(pathToFileURL(`${skill}/scripts/lib/canon-routed-core.mjs`));
const { walk } = await import(pathToFileURL(`${skill}/scripts/lib/walker.mjs`));
const saved = JSON.parse(
  fs.readFileSync(path.join(evidence, "canon/retrieval.json"), "utf8"),
);
const review = JSON.parse(
  fs.readFileSync(path.join(evidence, "canon-rule-review.json"), "utf8"),
);
const client = new Client({
  name: "ownclass-unslop-pinned-revalidation",
  version: "1.0.0",
});
const resources = [];
const read = async (uri, name) => {
  const result = await client.readResource({ uri }, { timeout: 45000 });
  assert.equal(result.contents.length, 1);
  const item = result.contents[0];
  assert.equal(item.uri, uri);
  assert.equal(item.mimeType, "application/json");
  assert.equal(typeof item.text, "string");
  const envelope = JSON.parse(item.text);
  const local = fs.readFileSync(
    path.join(evidence, `canon/${name}.json${name === "index" ? ".txt" : ""}`),
    "utf8",
  );
  assert.equal(item.text, local, `${name} 与已保存的固定快照不同`);
  // 校验和覆盖按键排序的紧凑 JSON；资源文件的缩进/末尾换行不属于 payload。
  const canonicalPayload = JSON.stringify(envelope.payload, (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
  const checksum = createHash("sha256").update(canonicalPayload).digest("hex");
  assert.equal(checksum, envelope.checksum);
  resources.push({
    uri,
    bytes: Buffer.byteLength(item.text),
    checksum,
    identicalToSavedSnapshot: true,
  });
  return { envelope, text: item.text };
};

try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(saved.endpoint)),
  );
  const rawIndex = await read(indexUri(saved.version), "index");
  const index = validateRoutedIndex(rawIndex.envelope, saved.version);
  assert.equal(index.checksum, saved.checksum);
  const files = walk(root).map((file) =>
    path.relative(root, file).split(path.sep).join("/"),
  );
  const topics = routeTopics(index, files);
  assert.deepEqual(topics, saved.requestedTopics);
  const rules = [];
  let tamperedPayloadRejected = false;
  for (const topic of topics) {
    const raw = await read(topicUri(saved.version, topic), topic);
    validateRoutedTopic(raw.envelope, index, topic, raw.text);
    for (const rule of raw.envelope.payload.rules) {
      const rows = review.manualAssessments.filter(
        (row) => row.ruleId === rule.id,
      );
      assert.equal(rows.length, 1, `${rule.id} 必须恰好有一条复核`);
      const row = rows[0];
      for (const field of [
        "topic",
        "mode",
        "strength",
        "class",
        "source",
        "title",
      ])
        assert.equal(row[field], rule[field]);
      assert.equal(row.canonVersion, saved.version);
      assert.equal(row.canonChecksum, saved.checksum);
      assert.equal(row.topicChecksum, raw.envelope.checksum);
      assert.ok(row.assessment && row.evidence && row.disposition);
      rules.push(rule.id);
    }
    if (!tamperedPayloadRejected) {
      const altered = structuredClone(raw.envelope);
      altered.payload.rules[0].statement += " changed";
      assert.throws(() =>
        validateRoutedTopic(altered, index, topic, JSON.stringify(altered)),
      );
      tamperedPayloadRejected = true;
    }
  }
  assert.equal(rules.length, 56);
  assert.equal(new Set(rules).size, 56);
  assert.equal(review.manualAssessments.length, 56);
  const report = {
    checkedAt: new Date().toISOString(),
    endpoint: saved.endpoint,
    transport: "MCP Streamable HTTP",
    version: saved.version,
    indexChecksum: saved.checksum,
    latestResolvedAgain: false,
    resources,
    applicableTopics: topics,
    ruleCount: rules.length,
    reviewRowsMatched: review.manualAssessments.length,
    independentNodeCryptoHashesValid: true,
    tamperedPayloadRejected,
    verified: true,
  };
  fs.writeFileSync(
    path.join(evidence, "canon/remote-revalidation.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await client.close();
}
