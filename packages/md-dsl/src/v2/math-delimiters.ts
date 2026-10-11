/** 仅识别真实TeX命令；注释和已转义反斜线不能参与配对。 */
export function sizedMathDelimiters(value: string) {
  const commands: { name: "left" | "right"; start: number; end: number }[] = [];
  let depth = 0;
  let unmatchedRight = false;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === "%") {
      const newline = value.indexOf("\n", index);
      if (newline < 0) break;
      index = newline;
    } else if (value[index] === "\\") {
      const start = index;
      index++;
      if (!/[a-zA-Z]/.test(value[index] ?? "")) continue;
      while (/[a-zA-Z]/.test(value[index + 1] ?? "")) index++;
      const name = value.slice(start + 1, index + 1);
      if (name !== "left" && name !== "right") continue;
      commands.push({ name, start, end: index + 1 });
      if (name === "left") depth++;
      else if (depth > 0) depth--;
      else unmatchedRight = true;
    }
  }
  return {
    commands,
    depth,
    unmatchedRight,
    unbalanced: depth > 0 || unmatchedRight,
  };
}

/** 历史显示降级只移除伸缩尺寸命令，不猜测数值、运算符或缺失括号。 */
export function simplifySizedMathDelimiters(value: string): string | null {
  const { commands, unbalanced } = sizedMathDelimiters(value);
  if (!unbalanced) return null;
  let result = value;
  for (const command of [...commands].reverse()) {
    let end = command.end;
    while (/\s/.test(value[end] ?? "")) end++;
    if (value[end] === ".") end++;
    else end = command.end;
    result = result.slice(0, command.start) + result.slice(end);
  }
  return result;
}
