// 审查取证脚本：只读 MCP 资源，使用已有 SDK 与 unslop 原版校验函数。
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = "C:/Users/HUAYU/Documents/github/simple-tutor-tool";
const skill =
  "C:/Users/HUAYU/AppData/Local/Temp/ownclass-unslop-20261107/skills/audit";
const out = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  pathToFileURL(`${root}/apps/server/package.json`),
);
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
  routeTopics,
  indexUri,
  topicUri,
} = await import(pathToFileURL(`${skill}/scripts/lib/canon-routed-core.mjs`));
const { walk } = await import(pathToFileURL(`${skill}/scripts/lib/walker.mjs`));
const endpoint = "https://oleg.design/unslop/mcp";
const client = new Client({
  name: "ownclass-unslop-readonly-audit",
  version: "1.0.0",
});
const calls = [];
const read = async (uri) => {
  const result = await client.readResource({ uri }, { timeout: 45000 });
  if (
    result.contents.length !== 1 ||
    result.contents[0].uri !== uri ||
    result.contents[0].mimeType !== "application/json" ||
    typeof result.contents[0].text !== "string"
  )
    throw new Error("MCP 资源形状不符");
  const text = result.contents[0].text;
  calls.push({ uri, bytes: Buffer.byteLength(text) });
  return { text, envelope: JSON.parse(text) };
};
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  const rawIndex = await read(indexUri());
  const index = validateRoutedIndex(rawIndex.envelope);
  console.log(
    JSON.stringify({
      pinnedVersion: index.payload.version,
      indexChecksum: index.checksum,
    }),
  );
  const dir = path.join(out, "canon");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.json.txt"), rawIndex.text);
  const files = walk(root).map((file) =>
    path.relative(root, file).split(path.sep).join("/"),
  );
  const topics = routeTopics(index, files);
  const received = [];
  for (const topic of topics) {
    const raw = await read(topicUri(index.payload.version, topic));
    validateRoutedTopic(raw.envelope, index, topic, raw.text);
    fs.writeFileSync(path.join(dir, `${topic}.json`), raw.text);
    received.push({
      topic,
      checksum: raw.envelope.checksum,
      bytes: Buffer.byteLength(raw.text),
      ruleIds: raw.envelope.payload.rules.map((rule) => rule.id),
    });
    console.log(
      JSON.stringify({
        validatedTopic: topic,
        rules: received.at(-1).ruleIds.length,
        checksum: raw.envelope.checksum,
      }),
    );
  }
  const all = Object.entries(index.payload.topics);
  const report = {
    schemaVersion: 1,
    transport: "MCP Streamable HTTP",
    endpoint,
    origin: "remote",
    localFallback: false,
    version: index.payload.version,
    checksum: index.checksum,
    publishedAt: index.payload.publishedAt,
    projectFiles: files.length,
    requestedTopics: topics,
    notRequestedTopics: all
      .map(([name]) => name)
      .filter((name) => !topics.includes(name)),
    receivedBytes: calls.reduce((sum, item) => sum + item.bytes, 0),
    fullCanonBytes:
      Buffer.byteLength(rawIndex.text) +
      all.reduce((sum, [, entry]) => sum + entry.bytes, 0),
    checks: [
      "MCP 资源 URI 与 MIME",
      "index schema 与 SHA-256",
      "固定版本",
      "各 topic schema 与 SHA-256",
      "topic 精确字节数",
      "topic 规则 ID 集合与标题",
      "rule mode/strength/class/source/license",
    ],
    topics: received,
    calls,
    verified: true,
    compatibleDetectorBindings: false,
  };
  fs.writeFileSync(
    path.join(dir, "retrieval.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const failure = {
    verified: false,
    code: error.code ?? "TRANSPORT",
    message: error.message,
    calls,
  };
  fs.writeFileSync(
    path.join(out, "canon-retrieval-failure.json"),
    JSON.stringify(failure, null, 2),
  );
  console.error(JSON.stringify(failure));
  process.exitCode = 2;
} finally {
  await client.close();
}
