import { render, screen } from "@testing-library/react";
import type {
  AttemptContextGroup,
  AttemptContextMaterial,
} from "@tutor/contract";
import { expect, it } from "vitest";
import { LessonGroupBlock } from "./LessonGroupBlock";

/**
 * 讲练页题组块（QM-14 细项 1）：组头 + 共享材料在讲练单列布局的流式呈现——
 * groupSegmentsOfUnit 解释出的组段在首个成员题卡之前渲染一次。数据解释与
 * 材料渲染均复用既有单源（attempt-context-view / MaterialPanel），本组件只
 * 承担讲练语境的排版。
 */

const GROUP: AttemptContextGroup = {
  id: "grp-1",
  title: "根据以下资料回答第 1～2 题",
  label: "1–2",
  introMd: "先读材料，再作答。",
  materialRefs: [{ material: "mat-1" }],
  questionIds: ["ls-m", "ls-o"],
  sourceVersion: 1,
};

const MATERIAL: AttemptContextMaterial = {
  id: "mat-1",
  title: "某省粮食生产",
  contentMd: "2025 年粮食总产量 $3{,}096.2$ 万吨，实现 {{slot-1}} 十二年增产。",
  anchors: [],
  slots: [{ id: "slot-1", slotKind: "choice", order: 0 }],
  mediaPaths: [],
  sourceVersion: 1,
};

it("渲染组头（标题/标签/说明）与共享材料（槽位标记编号空位）", () => {
  render(<LessonGroupBlock group={GROUP} materials={[MATERIAL]} />);
  expect(screen.getByText("根据以下资料回答第 1～2 题")).toBeVisible();
  expect(screen.getByText("1–2")).toBeVisible();
  expect(screen.getByText("先读材料，再作答。")).toBeVisible();
  // MaterialPanel 渲染材料标题与编号空位（{{slot-1}} → （1））
  expect(
    screen.getByRole("region", { name: "共享材料：某省粮食生产" }),
  ).toBeVisible();
  expect(screen.getByText("（1）")).toBeVisible();
});

it("零材料组只渲染组头（materials 空数组合法）", () => {
  render(<LessonGroupBlock group={GROUP} materials={[]} />);
  expect(screen.getByText("根据以下资料回答第 1～2 题")).toBeVisible();
  expect(screen.queryByRole("region", { name: /共享材料/ })).toBeNull();
});

it("多材料按引用序全部渲染", () => {
  const second: AttemptContextMaterial = {
    ...MATERIAL,
    id: "mat-2",
    title: "补充资料",
    slots: [],
  };
  render(<LessonGroupBlock group={GROUP} materials={[MATERIAL, second]} />);
  expect(
    screen.getByRole("region", { name: "共享材料：某省粮食生产" }),
  ).toBeVisible();
  expect(
    screen.getByRole("region", { name: "共享材料：补充资料" }),
  ).toBeVisible();
});
