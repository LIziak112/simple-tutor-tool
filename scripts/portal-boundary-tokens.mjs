const decode = (text) =>
  text.replace(
    /\\(?:u\{([\da-f]+)\}|u([\da-f]{4})|x([\da-f]{2})|([\s\S]))/gi,
    (_, wide, unicode, hex, char) =>
      wide || unicode || hex
        ? String.fromCodePoint(Number.parseInt(wide ?? unicode ?? hex, 16))
        : ({ n: "\n", r: "\r", t: "\t" }[char] ?? char),
  );

/** 有界词法扫描：区分注释、字符串、模板插值与正则，不执行被检源码。 */
export function tokensOf(source) {
  const tokens = [];
  let at = 0;
  let previous = "";
  const push = (kind, value, start) => {
    tokens.push({ kind, value, start });
    previous = value;
  };
  const quoted = (quote) => {
    const start = at++;
    let raw = "";
    while (at < source.length) {
      const char = source[at++];
      if (char === "\\") {
        raw += char + (source[at++] ?? "");
        continue;
      }
      if (char === quote) break;
      raw += char;
    }
    push("string", decode(raw), start);
  };
  const regex = () => {
    const start = at++;
    let value = "";
    let characterClass = false;
    while (at < source.length) {
      const char = source[at++];
      if (char === "\\") {
        value += char + (source[at++] ?? "");
        continue;
      }
      if (char === "[") characterClass = true;
      if (char === "]") characterClass = false;
      if (char === "/" && !characterClass) break;
      value += char;
    }
    while (/[a-z]/i.test(source[at] ?? "") && at < source.length) at++;
    push("regex", value, start);
  };
  const template = () => {
    const start = at++;
    let raw = "";
    let segment = start;
    while (at < source.length) {
      const char = source[at++];
      if (char === "\\") {
        raw += char + (source[at++] ?? "");
        continue;
      }
      if (char === "`") {
        push("template", decode(raw), segment);
        break;
      }
      if (char === "$" && source[at] === "{") {
        push("template", decode(raw), segment);
        raw = "";
        at++;
        scan(true);
        segment = at;
        continue;
      }
      raw += char;
    }
  };
  function scan(stopAtBrace = false) {
    let braces = 0;
    while (at < source.length) {
      const char = source[at];
      if (/\s/.test(char)) {
        at++;
        continue;
      }
      if (char === "/" && source[at + 1] === "/") {
        at = source.indexOf("\n", at + 2);
        if (at < 0) at = source.length;
        continue;
      }
      if (char === "/" && source[at + 1] === "*") {
        const end = source.indexOf("*/", at + 2);
        at = end < 0 ? source.length : end + 2;
        continue;
      }
      if (char === '"' || char === "'") {
        quoted(char);
        continue;
      }
      if (char === "`") {
        template();
        continue;
      }
      if (
        char === "/" &&
        (!previous ||
          /^(?:=|\(|\[|\{|,|:|;|!|\?|>|&&|\|\||return|throw|case|yield)$/.test(
            previous,
          ))
      ) {
        regex();
        continue;
      }
      if (char === "}" && stopAtBrace && braces === 0) {
        at++;
        return;
      }
      if (char === "{") braces++;
      if (char === "}") braces--;
      if (/[\w$]/.test(char)) {
        const start = at++;
        while (/[\w$]/.test(source[at] ?? "") && at < source.length) at++;
        push("word", source.slice(start, at), start);
        continue;
      }
      const start = at++;
      push("punct", char, start);
    }
  }
  scan();
  return tokens;
}
