import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { RichMarkdown } from "../RichMarkdown";
import {
  GroupDirective,
  ItemDirective,
  MaterialDirective,
  OptionDirective,
  OptionsDirective,
  RefDirective,
  SegDirective,
  VariantDirective,
} from "./Qm";

/**
 * TT-06 材料/组/引用渲染壳：静态形态 + 优雅降级。
 * 经完整渲染管线（RichMarkdown）验证宿主还原与 sanitize 白名单，
 * 并单测各壳组件的缺省文案。
 */

/** 组件直测的宿主基础 props（name 取注册表主名；组件本身不读该字段） */
const hostProps = (name: string) => ({ name, index: 0, docIndex: 0 });

describe("Qm 渲染壳（完整管线）", () => {
  it("材料块：title 标题与正文渲染，{{slot}} 原样保留为文本", () => {
    const { container } = render(
      createElement(RichMarkdown, {
        source:
          '::::material{id=mat-1 title="给定资料"}\n全省粮食总产量 3,096.2 万吨。{{slot-1}}\n::::',
      }),
    );
    expect(container.querySelector("[data-slot='material']")).not.toBeNull();
    expect(screen.getByText("给定资料")).toBeInTheDocument();
    expect(screen.getByText(/3,096\.2/)).toBeInTheDocument();
    expect(container.textContent).toContain("{{slot-1}}");
  });

  it("题组：title 与 label 徽章渲染；::ref 锚点不可见（不出「未支持」）", () => {
    const { container } = render(
      createElement(RichMarkdown, {
        source:
          '::::group{id=grp-1 title="根据以下资料回答" label="1～5"}\n说明正文。\n\n::ref{material=mat-1}\n::ref{question=q-1}\n::::',
      }),
    );
    expect(
      container.querySelector("[data-slot='question-group']"),
    ).not.toBeNull();
    expect(screen.getByText("根据以下资料回答")).toBeInTheDocument();
    expect(screen.getByText("1～5")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("未支持指令");
    expect(container.textContent).not.toContain("mat-1");
  });

  it("选项池与选项：allow-repeat 标注与选项正文；排序项与备选参考壳", () => {
    const { container } = render(
      createElement(RichMarkdown, {
        source: [
          "::::options{allow-repeat=true}",
          ":::option{id=opt-1}",
          "甲选项。",
          ":::",
          "::::",
          "",
          ":::item{fixed=true}",
          "固定项文本。",
          ":::",
          "",
          ":::variant",
          "备选参考文本。",
          ":::",
        ].join("\n"),
      }),
    );
    expect(
      container.querySelector("[data-slot='matching-options']"),
    ).not.toBeNull();
    expect(screen.getByText("选项池（可重复选用）")).toBeInTheDocument();
    expect(screen.getByText("甲选项。")).toBeInTheDocument();
    const item = container.querySelector("[data-slot='ordering-item']");
    expect(item).not.toBeNull();
    expect(item?.textContent).toContain("固定项");
    const variant = container.querySelector("[data-slot='response-variant']");
    expect(variant?.textContent).toContain("备选参考");
  });

  it("片段锚点透明包裹：正文照常渲染", () => {
    const { container } = render(
      createElement(RichMarkdown, {
        source: ":::seg{id=seg-1}\n锚点内正文。\n:::",
      }),
    );
    expect(
      container.querySelector("[data-slot='material-seg']"),
    ).not.toBeNull();
    expect(screen.getByText("锚点内正文。")).toBeInTheDocument();
  });
});

describe("Qm 渲染壳（组件直测缺省文案）", () => {
  it("material 缺省标题「材料」；group 缺省「题组」且无 label 徽章", () => {
    const { container } = render(
      createElement(
        MaterialDirective,
        { ...hostProps("material"), attrs: {} },
        "正文",
      ),
    );
    expect(screen.getByText("材料")).toBeInTheDocument();
    render(
      createElement(
        GroupDirective,
        { ...hostProps("group"), attrs: {} },
        "说明",
      ),
    );
    expect(screen.getByText("题组")).toBeInTheDocument();
    expect(container.querySelector("span")).toBeNull();
  });

  it("options 缺省不带「可重复选用」；ref 恒空输出（合法空输出不触发降级）", () => {
    render(
      createElement(
        OptionsDirective,
        { ...hostProps("options"), attrs: { "allow-repeat": false } },
        null,
      ),
    );
    expect(screen.queryByText("选项池（可重复选用）")).not.toBeInTheDocument();
    const { container } = render(
      createElement(RefDirective, {
        ...hostProps("ref"),
        attrs: { material: "mat-1" },
      }),
    );
    expect(container.textContent).toBe("");
    // item 无标记时不渲染 fixed/distractor 标签行
    render(
      createElement(
        ItemDirective,
        { ...hostProps("item"), attrs: { fixed: false, distractor: false } },
        "项",
      ),
    );
    expect(screen.queryByText("固定项")).not.toBeInTheDocument();
    render(
      createElement(
        VariantDirective,
        { ...hostProps("variant"), attrs: {} },
        "文本",
      ),
    );
    render(
      createElement(
        OptionDirective,
        { ...hostProps("option"), attrs: {} },
        "选项",
      ),
    );
    render(
      createElement(SegDirective, { ...hostProps("seg"), attrs: {} }, "片段"),
    );
    expect(screen.getByText("选项")).toBeInTheDocument();
  });
});
