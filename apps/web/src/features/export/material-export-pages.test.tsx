import type {
  AttemptContextData,
  AttemptContextMaterial,
} from "@tutor/contract";
import { describe, expect, it } from "vitest";
import { exportMaterialsOfQuestion } from "./material-export-pages";

/**
 * 导出材料闭包纯函数测试（QM-16 细项 1）：组内题收组材料全部版本、
 * 组外题零材料、字母编号、版本徽标、槽位编号正文。渲染栅格化属浏览器
 * 链路（html-to-image），由 e2e/真机覆盖，不在 jsdom 单测伪造。
 */

function material(
  id: string,
  version: number,
  content: string,
  title?: string,
): AttemptContextMaterial & { id: string; sourceVersion: number } {
  return {
    id,
    sourceVersion: version,
    ...(title !== undefined ? { title } : {}),
    contentMd: content,
    anchors: [],
    slots: [{ id: `${id}-s1`, slotKind: "match", order: 0 }],
    mediaPaths: [],
  };
}

describe("exportMaterialsOfQuestion（导出材料闭包）", () => {
  const context: AttemptContextData = {
    attemptId: "a-1",
    materials: [
      material("m-1", 1, "Passage with {{m-1-s1}}.", "阅读材料"),
      material("m-1", 2, "第二版 {{m-1-s1}}。", "阅读材料"),
      material("m-2", 1, "独立材料，组未引用。"),
    ],
    groups: [
      {
        id: "g-1",
        sourceVersion: 1,
        title: "组",
        introMd: "",
        materialRefs: [{ material: "m-1" }, { material: "m-1" }],
        questionIds: ["q-1", "q-2"],
      },
    ],
  };

  it("组内题：组引用材料全部版本（引用序去重、版本键不塌缩）、字母编号、版本徽标、槽位编号", () => {
    const materials = exportMaterialsOfQuestion(context, "q-1");
    expect(materials).toHaveLength(2);
    expect(materials[0]).toMatchObject({
      letter: "A",
      label: "阅读材料（历史版本 1）",
    });
    expect(materials[0]?.contentMd).toBe("Passage with **（1）**.");
    expect(materials[1]).toMatchObject({
      letter: "B",
      label: "阅读材料（历史版本 2）",
    });
    expect(materials[1]?.contentMd).toBe("第二版 **（1）**。");
  });

  it("组外题零材料（不携带无关材料）；题级引用随学生投影并入闭包（审查 P2-2：与服务端组∪题级同源）", () => {
    expect(exportMaterialsOfQuestion(context, "q-9")).toEqual([]);
    // 题级引用（无组）也进闭包——多材料题正文引用的材料随题导出
    const withQuestionRefs = exportMaterialsOfQuestion(context, "q-3", [
      { material: "m-2" },
    ]);
    expect(withQuestionRefs).toHaveLength(1);
    expect(withQuestionRefs[0]).toMatchObject({
      letter: "A",
      label: "材料",
    });
    expect(withQuestionRefs[0]?.contentMd).toBe("独立材料，组未引用。");
  });

  it("组引用 ∪ 题级引用去重；编号口径与服务端闭包对齐（审查 P3-2：(id, sourceVersion) 稳定序）", () => {
    // 组引用顺序（m-2 先、m-1 后）与 id 稳定序（m-1 < m-2）相反——字母编号
    // 必须按服务端 frozenMaterialsForQuestion 的 (id, sourceVersion) 排序，
    // 两出口（PNG 材料页 / 单题包）字母一致
    const mixed: AttemptContextData = {
      attemptId: "a-3",
      materials: [
        material("m-2", 1, "材料二正文。", "材料二"),
        material("m-1", 1, "材料一 v1 {{m-1-s1}}。", "材料一"),
        material("m-1", 2, "材料一 v2 {{m-1-s1}}。", "材料一"),
      ],
      groups: [
        {
          id: "g-3",
          sourceVersion: 1,
          title: "组",
          introMd: "",
          materialRefs: [{ material: "m-2" }, { material: "m-1" }],
          questionIds: ["q-7"],
        },
      ],
    };
    // 组 ∪ 题级同材料去重（m-1 两版本各一条，不因重复引用翻倍）
    const union = exportMaterialsOfQuestion(mixed, "q-7", [
      { material: "m-1" },
    ]);
    expect(union.map((item) => `${item.letter}:${item.label}`)).toEqual([
      "A:材料一（历史版本 1）",
      "B:材料一（历史版本 2）",
      "C:材料二",
    ]);
    // 仅题级（组外题）零材料口径不回归
    expect(exportMaterialsOfQuestion(mixed, "q-8")).toEqual([]);
  });

  it("无标题材料回落「材料」；未声明槽位标记原样保留", () => {
    const single: AttemptContextData = {
      attemptId: "a-2",
      materials: [
        {
          id: "m-3",
          sourceVersion: 1,
          contentMd: "含未知标记 {{nope}} 的正文。",
          anchors: [],
          slots: [],
          mediaPaths: [],
        },
      ],
      groups: [
        {
          id: "g-2",
          sourceVersion: 1,
          title: "组",
          introMd: "",
          materialRefs: [{ material: "m-3" }],
          questionIds: ["q-5"],
        },
      ],
    };
    const materials = exportMaterialsOfQuestion(single, "q-5");
    expect(materials).toEqual([
      {
        letter: "A",
        label: "材料",
        contentMd: "含未知标记 {{nope}} 的正文。",
      },
    ]);
  });
});
