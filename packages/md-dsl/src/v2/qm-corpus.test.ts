/**
 * QM-02 DSL 解析断言（TT-05a，决策记录 §12「注册表探针条件激活」策略）。
 *
 * samples/qm 新语法语料不能在指令注册前进 parseDocument 主干断言——注册前
 * 跑只会得到 UNKNOWN_DIRECTIVE。§12 定案：不提交红测试（实施清单 QM-02
 * 「主干不提交红测试」），也不做会静默变绿的全量 skip——本文件用**注册表
 * 探针**条件激活：
 *
 * - 探针 = 注册表是否已注册 material/group/ref 三个代表指令（getDirective）；
 * - 未注册：整组 skip，skip 理由打印在输出里，语料预期仍由
 *   packages/contract/src/qm-corpus.test.ts 的契约层骨架锁定（可绿）；
 * - TT-06 注册后：探针翻转，断言自动转执行——TT-06 必须让它们变绿才能合并，
 *   「忘记摘 skip」这条路不存在。
 *
 * **TT-06（2026-10-24）探针已翻转**：8 指令注册后本组全量执行，并按 §5.9
 * 时序解除补齐 15 份全量回归（8 有效 0 error + 7 错误命中预期码）。探针机制
 * 保留——万一注册表回退，本组自动回到 skip 而不是假绿。
 *
 * 错误语料（invalid-01~07）的 lint 断言同法：错误码本身也依赖 TT-06 的
 * §5.4.3 码表注册，同探针下激活。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDirective } from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { parseDocument } from "./parse.ts";

const CORPUS_DIR = fileURLToPath(
  new URL("../../../../samples/qm/", import.meta.url),
);

/** 注册表探针：TT-06 注册新指令后翻转（§12 策略的机械执行者） */
function newDslRegistered(): boolean {
  return (
    getDirective("material") !== undefined &&
    getDirective("group") !== undefined &&
    getDirective("ref") !== undefined
  );
}

function readCorpus(name: string): string {
  return readFileSync(`${CORPUS_DIR}${name}`, "utf8");
}

describe.skipIf(!newDslRegistered())(
  "QM-02 语料 DSL 解析（新指令注册后自动激活；TT-06 已翻转，全量执行）",
  () => {
    it("valid-01 资料分析：1 材料（2 锚点 + 1 图片）+ 1 组（5 子题）解析零 issue", () => {
      const doc = parseDocument(readCorpus("valid-01-资料分析五题.md"));
      expect(doc.issues.filter((i) => i.level === "error")).toHaveLength(0);
      const unit = doc.units[0];
      expect(unit?.materials?.length).toBe(1);
      expect(unit?.materials?.[0]?.anchors).toHaveLength(2);
      expect(unit?.groups?.[0]?.questionIds).toEqual([
        "zl-1",
        "zl-2",
        "zl-3",
        "zl-4",
        "zl-5",
      ]);
      expect(unit?.questions.map((question) => question.type)).toEqual([
        "choice",
        "choice",
        "multi",
        "fill",
        "choice",
      ]);
    });

    it("valid-03 二十空完形：材料 20 槽 + 20 道逐空绑定 choice 子题", () => {
      const doc = parseDocument(readCorpus("valid-03-二十空完形.md"));
      expect(doc.issues.filter((i) => i.level === "error")).toHaveLength(0);
      const unit = doc.units[0];
      expect(unit?.materials?.[0]?.slots).toHaveLength(20);
      expect(unit?.questions).toHaveLength(20);
      // 每题 ::ref{slot=slot-n} 与题号一致（增删空位不串答）
      expect(unit?.questions[19]?.materialRefs).toEqual([
        { material: "mat-1", slot: "slot-20" },
      ]);
    });

    it("invalid-01 缺材料：lint 报 UNKNOWN_MATERIAL_REF（两遍解析第二遍报错，不静默）", () => {
      const doc = parseDocument(
        readCorpus("invalid-01-缺材料-expected-UNKNOWN_MATERIAL_REF.md"),
      );
      expect(doc.issues.some((i) => i.code === "UNKNOWN_MATERIAL_REF")).toBe(
        true,
      );
    });

    // ---- TT-06 语料验收转正（§5.9 时序解除）：15 份全量进回归 ----

    /** 8 份有效语料：tutor-lint 语义零 error（与 pnpm tutor-lint 分跑记录互证） */
    const VALID_FILES = [
      "valid-01-资料分析五题.md",
      "valid-02-英语阅读五题.md",
      "valid-03-二十空完形.md",
      "valid-04-七选五.md",
      "valid-05-固定项排序.md",
      "valid-06-多材料申论翻译作文.md",
      "valid-07-两问证明计算.md",
      "valid-08-旧七型混合题.md",
    ] as const;

    for (const file of VALID_FILES) {
      it(`${file}：全量解析 0 error（有效语料验收）`, () => {
        const doc = parseDocument(readCorpus(file));
        expect(
          doc.issues.filter((i) => i.level === "error"),
          `${file} 的 error issue：${doc.issues
            .filter((i) => i.level === "error")
            .map((i) => `${i.code}@${i.line}`)
            .join("、")}`,
        ).toEqual([]);
      });
    }

    /**
     * 7 份错误语料的 lint 层预期码（文件名 expected- 前缀；与 contract
     * qm-corpus.test.ts 的 EXPECTED_INVALID 双核对——此处是实际 lint 结果，
     * 那里是名册锁定）。invalid-02/06 允许伴随码：
     * - invalid-02：跨域是导入/发布层码，静态 lint 先报文档内不可解析；
     * - invalid-06：材料内的 :::solution 同时命中通用 SOLUTION_OUTSIDE_QUESTION。
     */
    const INVALID_EXPECTED: Readonly<Record<string, readonly string[]>> = {
      "invalid-01-缺材料-expected-UNKNOWN_MATERIAL_REF.md": [
        "UNKNOWN_MATERIAL_REF",
      ],
      "invalid-02-跨教师域-expected-MATERIAL_REF_OUT_OF_DOMAIN.md": [
        "UNKNOWN_MATERIAL_REF",
      ],
      "invalid-03-重复循环组-expected-GROUP_MEMBER_DUPLICATED.md": [
        "GROUP_MEMBER_DUPLICATED",
        "GROUP_NESTED_OR_CYCLIC",
      ],
      "invalid-04-未知槽位-expected-UNKNOWN_SLOT_REF.md": ["UNKNOWN_SLOT_REF"],
      "invalid-05-越界锚点-expected-SEG_RANGE_OUT_OF_BOUNDS.md": [
        "SEG_RANGE_OUT_OF_BOUNDS",
      ],
      "invalid-06-材料含答案指令-expected-MATERIAL_CONTAINS_ANSWER.md": [
        "MATERIAL_CONTAINS_ANSWER",
      ],
      "invalid-07-非法选项引用-expected-INVALID_OPTION_REF.md": [
        "INVALID_OPTION_REF",
      ],
    };

    for (const [file, codes] of Object.entries(INVALID_EXPECTED)) {
      it(`${file}：命中预期错误码 ${codes.join(" + ")}`, () => {
        const doc = parseDocument(readCorpus(file));
        const actual = doc.issues
          .filter((i) => i.level === "error")
          .map((i) => i.code);
        for (const code of codes) {
          expect(actual, `${file} 实际：${actual.join("、")}`).toContain(code);
        }
      });
    }
  },
);
