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

  it("组外题零材料（不携带无关材料；多材料题级引用不在学生投影，导出闭包同口径）", () => {
    expect(exportMaterialsOfQuestion(context, "q-9")).toEqual([]);
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
