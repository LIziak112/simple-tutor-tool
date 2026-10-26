import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isActivatingTarget,
  isOverlayOpen,
  isSuppressedKeyEvent,
  isTextEditingEvent,
} from "./practice-keyboard";

/**
 * 单题专注键盘方案的纯裁决（M3-D3 §9.2）：文本编辑区判定必须看 composedPath
 * （穿透 shadow DOM——MathLive 与 AI 输入的宿主结构），弹层打开与默认抑制
 * 状态（合成中/长按/已被处理）直接短路。用例全部走真实 dispatch，保证
 * composedPath 在 jsdom 下的真实形态。
 */

function keydownOf(
  target: Element,
  init: KeyboardEventInit & { cancelable?: boolean } = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    composed: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isTextEditingEvent（composedPath 判定文本编辑区）", () => {
  it("文本 input 与 textarea 命中，radio/checkbox 不算编辑区", () => {
    const text = document.createElement("input");
    text.type = "text";
    document.body.appendChild(text);
    expect(isTextEditingEvent(keydownOf(text))).toBe(true);

    const area = document.createElement("textarea");
    document.body.appendChild(area);
    expect(isTextEditingEvent(keydownOf(area))).toBe(true);

    const radio = document.createElement("input");
    radio.type = "radio";
    document.body.appendChild(radio);
    expect(isTextEditingEvent(keydownOf(radio))).toBe(false);

    const check = document.createElement("input");
    check.type = "checkbox";
    document.body.appendChild(check);
    expect(isTextEditingEvent(keydownOf(check))).toBe(false);
  });

  it("数值/邮箱等文本类 input 命中", () => {
    const number = document.createElement("input");
    number.type = "number";
    document.body.appendChild(number);
    expect(isTextEditingEvent(keydownOf(number))).toBe(true);
    const email = document.createElement("input");
    email.type = "email";
    document.body.appendChild(email);
    expect(isTextEditingEvent(keydownOf(email))).toBe(true);
  });

  it("contenteditable 命中", () => {
    const editable = document.createElement("div");
    // jsdom 未实现 contentEditable IDL 属性 setter，与真实浏览器一致地写属性值
    editable.setAttribute("contenteditable", "true");
    document.body.appendChild(editable);
    expect(isTextEditingEvent(keydownOf(editable))).toBe(true);
  });

  it("shadow DOM 内的文本输入（嵌套自定义元素宿主）经 composedPath 命中", () => {
    const hostTag = "kbd-shadow-host";
    if (customElements.get(hostTag) === undefined) {
      customElements.define(
        hostTag,
        class extends HTMLElement {
          constructor() {
            super();
            const root = this.attachShadow({ mode: "open" });
            const input = document.createElement("input");
            input.type = "text";
            root.appendChild(input);
          }
        },
      );
    }
    const host = document.createElement(hostTag);
    document.body.appendChild(host);
    const inner = host.shadowRoot?.querySelector("input");
    if (inner === null || inner === undefined)
      throw new Error("shadow 输入未创建");
    // jsdom 下 shadow 内派发的事件 target 被重定向到宿主、composedPath 为空：
    // 只能像真实键盘事件一样（来源恒为焦点元素）先聚焦，经焦点链命中
    inner.focus();
    expect(isTextEditingEvent(keydownOf(inner))).toBe(true);
  });

  it("MathLive 宿主元素（math-field）命中", () => {
    const field = document.createElement("math-field");
    document.body.appendChild(field);
    expect(isTextEditingEvent(keydownOf(field))).toBe(true);
  });

  it("普通容器与选项标签不命中", () => {
    const container = document.createElement("div");
    const label = document.createElement("label");
    container.appendChild(label);
    document.body.appendChild(container);
    expect(isTextEditingEvent(keydownOf(label))).toBe(false);
    expect(isTextEditingEvent(keydownOf(container))).toBe(false);
  });
});

describe("isActivatingTarget（按钮/链接保留自身 Enter）", () => {
  it("button、a 与 role=button 命中；radio 与容器不命中", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    expect(isActivatingTarget(keydownOf(button))).toBe(true);

    const link = document.createElement("a");
    link.href = "https://ownclass.example";
    document.body.appendChild(link);
    expect(isActivatingTarget(keydownOf(link))).toBe(true);

    const pseudo = document.createElement("span");
    pseudo.setAttribute("role", "button");
    document.body.appendChild(pseudo);
    expect(isActivatingTarget(keydownOf(pseudo))).toBe(true);

    const radio = document.createElement("input");
    radio.type = "radio";
    document.body.appendChild(radio);
    expect(isActivatingTarget(keydownOf(radio))).toBe(false);
  });
});

describe("isSuppressedKeyEvent（默认抑制状态）", () => {
  it("长按 repeat、输入法合成、defaultPrevented、IME keyCode 229 均抑制", () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    expect(isSuppressedKeyEvent(keydownOf(target, { repeat: true }))).toBe(
      true,
    );
    expect(isSuppressedKeyEvent(keydownOf(target, { isComposing: true }))).toBe(
      true,
    );
    const prevented = keydownOf(target);
    prevented.preventDefault();
    expect(isSuppressedKeyEvent(prevented)).toBe(true);
    expect(isSuppressedKeyEvent(keydownOf(target, { keyCode: 229 }))).toBe(
      true,
    );
    expect(isSuppressedKeyEvent(keydownOf(target))).toBe(false);
  });
});

describe("isOverlayOpen（弹层打开不推进）", () => {
  it("role=dialog 且 data-state=open 命中；closed 或移除后不命中", () => {
    expect(isOverlayOpen()).toBe(false);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    expect(isOverlayOpen()).toBe(true);
    dialog.setAttribute("data-state", "closed");
    expect(isOverlayOpen()).toBe(false);
    dialog.setAttribute("data-state", "open");
    dialog.remove();
    expect(isOverlayOpen()).toBe(false);
  });
});
