import { render, screen } from "@testing-library/react";
import * as contract from "@tutor/contract";
import { listDirectives, tipDirective } from "@tutor/contract";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DirectiveContainerHost,
  DirectiveLeafHost,
  DirectiveTextHost,
  directiveComponents,
} from "./directives";
import { RichMarkdown } from "./RichMarkdown";
import {
  DIRECTIVE_HOST_ATTRS,
  deriveDirectiveHostAttrs,
  richMarkdownSanitizeSchema,
} from "./sanitize";

afterEach(() => vi.restoreAllMocks());

/** 正反用例共用同一断言，同时检查漏项和多余项。 */
function assertComponentNamesConsistent(
  components: Readonly<Record<string, unknown>>,
) {
  expect(Object.keys(components).sort()).toEqual(
    listDirectives()
      .map((definition) => definition.name)
      .sort(),
  );
}

describe("指令注册表与渲染映射一致性", () => {
  it("主名集合与组件自有键集合完全相等", () => {
    assertComponentNamesConsistent(directiveComponents);
  });

  it("删掉一条组件映射时，同一个一致性断言会失败", () => {
    const incomplete = { ...directiveComponents };
    delete incomplete.tip;
    expect(() => assertComponentNamesConsistent(incomplete)).toThrow();
  });

  it("多出一条组件映射时，同一个一致性断言会失败", () => {
    // T7.2 起表值是「schema 绑定渲染器」，多出条目复用一条真实渲染器即可触发
    const tip = directiveComponents.tip;
    if (tip === undefined) {
      throw new Error("fixture 前置失败：tip 渲染器缺失");
    }
    expect(() =>
      assertComponentNamesConsistent({
        ...directiveComponents,
        "extra-tip": tip,
      }),
    ).toThrow();
  });

  it("所有已声明别名归一到有组件映射的主名", () => {
    for (const definition of listDirectives()) {
      for (const alias of definition.aliases ?? []) {
        expect(contract.getDirective(alias)?.name).toBe(definition.name);
        expect(Object.hasOwn(directiveComponents, definition.name)).toBe(true);
        expect(Object.hasOwn(directiveComponents, alias)).toBe(false);
      }
    }
  });

  it("局部别名在完整渲染管线中使用主名组件，不增加别名映射", () => {
    // 当前生产定义没有别名；只 mock 查询，不向全局注册表登记测试指令。
    const originalGetDirective = contract.getDirective;
    const definition = { ...tipDirective, aliases: ["legacy-tip"] };
    vi.spyOn(contract, "getDirective").mockImplementation((name) =>
      name === "legacy-tip" ? definition : originalGetDirective(name),
    );
    expect(contract.getDirective("legacy-tip")?.name).toBe("tip");
    expect(Object.hasOwn(directiveComponents, "legacy-tip")).toBe(false);
    const { container } = render(
      createElement(RichMarkdown, {
        source: ':::legacy-tip{title="旧名提示"}\n别名正文\n:::',
      }),
    );
    expect(container.querySelector("[data-slot='callout']")).not.toBeNull();
    expect(screen.getByText("旧名提示")).toBeInTheDocument();
    expect(screen.getByText("别名正文")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("未支持指令");
  });

  describe.each([
    ["容器", DirectiveContainerHost],
    ["块", DirectiveLeafHost],
    ["行内", DirectiveTextHost],
  ] as const)("%s宿主的查表边界", (_label, Host) => {
    it("映射中有名字但注册表不认识时仍降级", () => {
      vi.spyOn(contract, "getDirective").mockReturnValue(undefined);
      const { container } = render(
        createElement(
          Host,
          {
            node: { properties: { directive: "tip" } },
          },
          "保留正文",
        ),
      );
      expect(container).toHaveTextContent("保留正文");
      expect(container).toHaveTextContent("未支持指令：tip");
      expect(container.querySelector("[data-slot='callout']")).toBeNull();
    });

    it("注册表命中但没有自有组件映射时保留正文降级", () => {
      vi.spyOn(contract, "getDirective").mockReturnValue({
        ...tipDirective,
        name: "constructor",
      });
      const { container } = render(
        createElement(
          Host,
          {
            node: { properties: { directive: "legacy-tip" } },
          },
          "保留正文",
        ),
      );
      expect(container).toHaveTextContent("保留正文");
      expect(container).toHaveTextContent("未支持指令：legacy-tip");
    });
  });
});

describe("指令清洗白名单同源推导", () => {
  it("白名单是全部 schema 属性键与四个宿主属性的并集", () => {
    const keys = new Set(["directive", "dclass", "index", "dindex"]);
    for (const definition of listDirectives()) {
      // 当前所有注册定义均使用 ZodObject；类型变化应显式调整推导与测试。
      expect(definition.attrs).toBeInstanceOf(z.ZodObject);
      if (definition.attrs instanceof z.ZodObject) {
        for (const key of Object.keys(definition.attrs.shape)) keys.add(key);
      }
    }
    expect([...DIRECTIVE_HOST_ATTRS].sort()).toEqual([...keys].sort());
    for (const tag of [
      "directive-container",
      "directive-leaf",
      "directive-text",
    ]) {
      expect(richMarkdownSanitizeSchema.attributes?.[tag]).toEqual(
        DIRECTIVE_HOST_ATTRS,
      );
    }
  });

  it("构造的 schema 新增与移除属性会改变推导结果，不改真实注册表", () => {
    const before = listDirectives();
    const schema = z.strictObject({ title: z.string().optional() });
    const fixture = { ...tipDirective, attrs: schema };
    expect(deriveDirectiveHostAttrs([fixture])).toContain("title");
    expect(deriveDirectiveHostAttrs([fixture])).not.toContain("customCourse");
    const extended = schema.extend({ customCourse: z.string().optional() });
    expect(
      deriveDirectiveHostAttrs([{ ...fixture, attrs: extended }]),
    ).toContain("customCourse");
    expect(
      deriveDirectiveHostAttrs([
        { ...fixture, attrs: extended.omit({ title: true }) },
      ]),
    ).not.toContain("title");
    expect(listDirectives()).toEqual(before);
  });

  it("重复属性去重，空清单保留四个宿主属性", () => {
    const attrs = z.strictObject({
      title: z.string().optional(),
      index: z.string().optional(),
    });
    const fixture = { ...tipDirective, attrs };
    const result = deriveDirectiveHostAttrs([fixture, fixture]);
    expect(result.filter((key) => key === "title")).toHaveLength(1);
    expect(result.filter((key) => key === "index")).toHaveLength(1);
    expect(deriveDirectiveHostAttrs([]).sort()).toEqual(
      ["directive", "dclass", "index", "dindex"].sort(),
    );
  });
});
