/**
 * QM-02 DSL 解析断言（TT-05a，决策记录 §12「注册表探针条件激活」策略）。
 *
 * samples/qm 新语法语料当前**不能**进 parseDocument 主干断言——解析器尚未
 * 注册 material/group/ref/options/option/item 指令（TT-06/QM-04 落地），现在
 * 跑只会得到 UNKNOWN_DIRECTIVE。§12 定案：不提交红测试（实施清单 QM-02
 * 「主干不提交红测试」），也不做会静默变绿的全量 skip——本文件用**注册表
 * 探针**条件激活：
 *
 * - 探针 = 注册表是否已注册 material/group/ref 三个代表指令（getDirective）；
 * - 未注册（当前）：整组 skip，skip 理由打印在输出里，语料预期仍由
 *   packages/contract/src/qm-corpus.test.ts 的契约层骨架锁定（可绿）；
 * - TT-06 注册后：探针翻转，断言自动转执行——TT-06 必须让它们变绿才能合并，
 *   「忘记摘 skip」这条路不存在。
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
  "QM-02 语料 DSL 解析（新指令注册后自动激活；当前 §12 探针未翻转）",
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
  },
);
