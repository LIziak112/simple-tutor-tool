import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
export const loadFromCheckout = (file) =>
  import(pathToFileURL(join(root, file)).href);
const { analyzeImport, summarizeParsed } = await loadFromCheckout(
  "apps/server/src/services/content-service.ts",
);
const { normalizeForImport } = await loadFromCheckout(
  "apps/server/src/services/import-qm.ts",
);
const { splitLessonBlocks } = await loadFromCheckout(
  "packages/md-dsl/src/index.ts",
);
const { directiveNamesOf, discoverSampleFiles } = await loadFromCheckout(
  "test-support/dsl-samples.ts",
);
const { listDirectives } = await loadFromCheckout(
  "packages/contract/src/index.ts",
);
const registry = listDirectives();

export function digest(value) {
  // 对象键顺序无语义；数组保留返回顺序。报告只保留摘要，不保存教师响应原文。
  const canonical = JSON.stringify(value, (_, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) =>
            a < b ? -1 : a === b ? 0 : 1,
          ),
        )
      : entry,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

export function collectCorpus(manifest) {
  const manifestRows = readFileSync(manifest, "utf8")
    .split(/\r?\n/)
    .map((line) => line.split("\t"));
  const fixedSamples = new Map(
    manifestRows
      .filter(([kind]) => kind === "发布样例")
      .map(([, path, , , id]) => [path, id]),
  );
  const fixedDirectives = manifestRows
    .filter(([kind]) => kind === "DSL 指令")
    .map(([, , name]) => name)
    .sort();
  assert.deepEqual(registry.map(({ name }) => name).sort(), fixedDirectives);

  const samplePaths = discoverSampleFiles(join(root, "samples")).map((file) =>
    relative(root, file).replaceAll("\\", "/"),
  );
  assert.equal(fixedSamples.size, 39);
  assert.deepEqual(samplePaths.sort(), [...fixedSamples.keys()].sort());
  const samples = samplePaths.map((path) => ({
    path,
    markdown: readFileSync(join(root, path), "utf8").replaceAll("\r\n", "\n"),
  }));
  const foreignRef = samples.find(({ path }) =>
    path.startsWith("samples/qm/invalid-02-"),
  );
  assert.ok(foreignRef);
  const missingRef = /::ref\{material=([^}]+)\}/.exec(foreignRef.markdown)?.[1];
  assert.ok(missingRef);

  function registeredExample(name) {
    const definition = registry.find((entry) => entry.name === name);
    assert.ok(definition, `缺少注册指令 ${name}`);
    return definition.example;
  }
  const columns = registeredExample("columns");
  function pack(path, directives, validators) {
    return {
      path: `synthetic/${path}.md`,
      markdown: `---
kind: lecture
teachingPack: {name: "合成教学包", directives: [${directives}], validators: [${validators}]}
---

# ${path}

${columns}

:::future-box
兼容后保留的正文。
:::
`,
    };
  }
  const declared = pack("declared", "columns, col, graph", "judge");
  const missing = pack("missing", "future-box", "future-judge");
  const box = {
    path: "synthetic/box.md",
    markdown: `---\nkind: lecture\n---\n\n# 合成版式盒\n\n${registeredExample("box")}\n`,
  };
  const rubric = {
    path: "synthetic/rubric.md",
    markdown: `---
kind: practice
unit: 合成量表
---

::::question{id=m02-rubric type=solve}
写出计算过程。

:::answer
7
:::

${registeredExample("rubric")}
::::
`,
  };
  const synthetic = [declared, missing, box, rubric];
  const files = [...samples, ...synthetic];

  return {
    fixedSamples,
    samples,
    foreignRef,
    missingRef,
    registeredExample,
    declared,
    missing,
    box,
    rubric,
    synthetic,
    files,
  };
}

export function writeEvidence(
  output,
  {
    corpus,
    opened,
    closed,
    all,
    blockedBatch,
    gateControl,
    anonymous,
    owner,
    sessionRenewals,
    after,
  },
) {
  const {
    fixedSamples,
    samples,
    foreignRef,
    registeredExample,
    declared,
    missing,
    box,
    rubric,
    synthetic,
    files,
  } = corpus;
  const rows = files.map((file, index) => {
    const { path, markdown } = file;
    const single = opened[index];
    const gated = closed[index];
    const entry = all.body.data.files[index];
    const { summary, actions, issues, warnings } = single.body.data;
    const errors = issues.filter(({ level }) => level === "error");
    assert.equal(digest(entry.preview), digest(single.body.data), path);
    assert.equal(
      entry.hasError,
      errors.length > 0 || entry.conflicts.length > 0,
      path,
    );
    assert.ok(entry.folderToCreate && entry.folderId === null, path);

    const expected = /-expected-([A-Z_]+)\.md$/.exec(path)?.[1];
    if (expected) {
      const code = file === foreignRef ? "UNKNOWN_MATERIAL_REF" : expected;
      assert.ok(
        errors.some((issue) => issue.code === code),
        `${path} 缺少 ${code}`,
      );
    }
    if (
      path.startsWith("samples/qm/valid-") ||
      path.startsWith("samples/v2/")
    ) {
      const expectedErrors =
        path === "samples/v2/练习推荐样例.md" ? ["JUDGE_INVALID_ANSWER"] : [];
      assert.deepEqual(
        errors.map(({ code }) => code),
        expectedErrors,
        path,
      );
    }
    if (file === declared || file === missing) {
      assert.deepEqual(
        errors.map(({ code }) => code).sort(),
        file === declared
          ? []
          : ["DIRECTIVE_REF_NOT_FOUND", "VALIDATOR_REF_NOT_FOUND"],
      );
      assert.deepEqual(
        issues
          .filter(({ level }) => level === "warning")
          .map(({ code }) => code),
        ["UNKNOWN_DIRECTIVE"],
      );
      assert.equal(entry.hasError, file === missing);
    }

    // HTTP 摘要只返回计数，题序从预览使用的解析产物补取，再校验摘要与 HTTP 一致。
    const fallbackUnitId = basename(path, ".md");
    const { parsed } = analyzeImport(
      normalizeForImport(markdown, fallbackUnitId),
      { fallbackUnitId },
    );
    assert.deepEqual(summarizeParsed(parsed), summary, path);
    if (file === box || file === rubric) {
      assert.equal(gated.status, 200, path);
      assert.deepEqual(issues, [], path);
      assert.equal(entry.hasError, false, path);
    }
    if (file === box)
      assert.ok(
        parsed.lectures[0]?.markdown.includes(registeredExample("box")),
      );
    if (file === rubric)
      assert.equal(parsed.units[0]?.questions[0]?.rubric?.items.length, 4);
    const questions = parsed.units.flatMap(({ questions }) =>
      questions.map(({ id, type }) => `${id}:${type}`),
    );
    const groups = (parsed.groups ?? []).map(
      ({ id, questionIds }) => `${id}=${questionIds.join(",")}`,
    );
    const lessons =
      summary.kind === "lesson"
        ? parsed.lectures.map(({ markdown }) =>
            splitLessonBlocks(markdown)
              .filter(({ type }) => type === "question")
              .map(({ questionId }) => questionId),
          )
        : [];
    if (summary.kind === "lesson") {
      assert.deepEqual(
        lessons.flat(),
        parsed.units.flatMap(({ questions }) => questions.map(({ id }) => id)),
        path,
      );
    }
    const result = errors.length
      ? "error"
      : issues.length || warnings.length
        ? "warning"
        : "clean";
    return {
      path,
      "frozen-id": fixedSamples.get(path) ?? "合成",
      "single-result": result,
      "http-on": single.status,
      "http-off": gated.status,
      "off-error": gated.body.error ?? "",
      "off-usages":
        gated.body._usages
          ?.map(
            ({ kind, name, line, column }) =>
              `${kind}:${name}@${line}:${column}`,
          )
          .join(",") ?? "",
      kind: summary.kind,
      lectures: summary.lectureCount,
      units: summary.unitCount,
      questions: summary.questionCount,
      materials: summary.materialCount,
      groups: summary.groupCount,
      types: Object.entries(summary.typeDistribution)
        .sort()
        .map(([type, count]) => `${type}:${count}`)
        .join(","),
      actions: actions.map(({ kind }) => kind).join(","),
      issues: issues
        .map(
          ({ level, code, line, column }) =>
            `${level}:${code}@${line}:${column}`,
        )
        .join(","),
      warnings: warnings.map(({ code }) => code).join(","),
      "batch-has-error": entry.hasError,
      "batch-conflicts": entry.conflicts.map(({ code }) => code).join(","),
      "question-order": questions.join(","),
      "group-order": groups.join(";"),
      "lesson-order": lessons.map((ids) => ids.join(",")).join(";"),
      "body-directives": [...directiveNamesOf(markdown)].sort().join(","),
      "source-sha256": digest(markdown),
      "single-on-sha256": digest(single.body),
      "batch-entry-sha256": digest(entry),
      "single-off-sha256": digest(gated.body),
    };
  });

  const covered = new Set(
    samples.flatMap(({ markdown }) => [...directiveNamesOf(markdown)]),
  );
  const registryNames = new Set(registry.map(({ name }) => name));
  const gap = [...registryNames].filter((name) => !covered.has(name)).sort();
  const syntheticNames = new Set(
    synthetic.flatMap(({ markdown }) => [...directiveNamesOf(markdown)]),
  );
  const supplemental = gap.filter((name) => syntheticNames.has(name));
  assert.deepEqual(supplemental, gap);

  const report = [
    [
      "#registry",
      ...registry.map(
        ({ name, aliases }) =>
          `${name}${aliases?.length ? `=${aliases.join(",")}` : ""}`,
      ),
    ],
    [
      "#registry-sha256",
      digest(
        registry.map(({ attrs, ...meta }) => ({
          ...meta,
          attributes: Object.keys(attrs.shape),
        })),
      ),
    ],
    [
      "#fixed-samples",
      samples.length,
      "#opened-single",
      opened.length,
      "#opened-batch",
      all.status,
      all.body.data.files.length,
      digest(all.body),
    ],
    ["#sample-directive-gap", ...gap],
    ["#supplemental-directives", ...supplemental],
    [
      "#uncovered-directives",
      ...gap.filter((name) => !supplemental.includes(name)),
    ],
    [
      "#anonymous",
      anonymous.status,
      anonymous.body.error,
      "#owner-reference",
      owner.status,
      digest(owner.body),
    ],
    [
      "#blocked-batch",
      blockedBatch.status,
      gateControl.path,
      blockedBatch.body.error,
      digest(blockedBatch.body),
    ],
    [
      "#preview-storage",
      "session-renewals",
      sessionRenewals,
      "resource-counts",
      JSON.stringify(
        Object.fromEntries(
          Object.entries(after.rows).map(([table, rows]) => [
            table,
            rows.length,
          ]),
        ),
      ),
      "files",
      JSON.stringify(after.files),
    ],
    Object.keys(rows[0]),
    ...rows.map(Object.values),
  ];
  writeFileSync(
    resolve(output),
    `${report.map((row) => row.join("\t")).join("\n")}\n`,
  );
}
