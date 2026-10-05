import io

NL = chr(10)
p = "apps/server/src/db/schema.test.ts"
s = io.open(p, encoding="utf-8").read()

# 1) 把 studentRow 从 students describe 提升到模块级
fn_start = s.find("  /** 一条可直接落库的学生行（linkToken/loginName 均唯一） */")
assert fn_start > 0
fn_end_marker = "  }" + NL
# 找函数完整块：从注释起到第一个 "  }" 顶格缩进闭合
probe = s.find("function studentRow", fn_start)
brace_open = s.find("{", probe)
depth = 0
i = brace_open
while i < len(s):
    if s[i] == "{":
        depth += 1
    elif s[i] == "}":
        depth -= 1
        if depth == 0:
            break
    i += 1
fn_block = s[fn_start : i + 1] + NL
# 移除原位（连同前面的空行残留交给 biome）
s = s[:fn_start] + s[i + 2 :]
# 模块级版本：缩进去掉一层（原为 2 空格）
module_fn = fn_block.replace(NL + "  ", NL, 10**6).lstrip()
# 找插入点：import 区结束后（第一个 describe 前）
first_describe = s.find("describe(")
s = s[:first_describe] + module_fn + NL + NL + s[first_describe:]

# 2) seedNoteRefs 复用 studentRow
old_seed = (
    "    const studentId = randomUUID();" + NL
    + "    const attemptId = randomUUID();" + NL
    + '    const questionId = "练习四-7";' + NL
    + "    const now = new Date().toISOString();" + NL
    + "    db.insert(students)" + NL
    + "      .values({"
)
assert old_seed in s, "seed head"
# 找到 students 插入整段结尾（.run();）
run_end = s.find(".run();", s.find("db.insert(students)", s.find("seedNoteRefs")))
seg_start = s.find("const studentId = randomUUID();", s.find("seedNoteRefs"))
seg_end = run_end + len(".run();")
replacement = (
    "    const student = studentRow();" + NL
    + "    const studentId = student.id;" + NL
    + "    const attemptId = randomUUID();" + NL
    + '    const questionId = "练习四-7";' + NL
    + "    const now = new Date().toISOString();" + NL
    + "    db.insert(students).values(student).run();"
)
s = s[:seg_start] + replacement + s[seg_end:]

# 3) T6R.2 describe 内加 seedNote / seedNoteVersion builders，并转换重复字面量
anchor = "    return { attemptId, questionId };" + NL + "  }" + NL
at = s.find(anchor)
assert at > 0
builders = (
    "    return { attemptId, questionId };" + NL
    + "  }" + NL + NL
    + "  /** 造一行 notes（缺省 rev-a）；返回 noteId */" + NL
    + "  function seedNote(" + NL
    + "    db: ReturnType<typeof createTestDb>," + NL
    + "    o: { attemptId: string; questionId: string; questionRevisionId?: string }," + NL
    + "  ): string {" + NL
    + "    const noteId = randomUUID();" + NL
    + "    db.insert(notes)" + NL
    + "      .values({" + NL
    + "        id: noteId," + NL
    + "        attemptId: o.attemptId," + NL
    + "        questionId: o.questionId," + NL
    + '        questionRevisionId: o.questionRevisionId ?? "rev-a",' + NL
    + "        updatedAt: new Date().toISOString()," + NL
    + "      })" + NL
    + "      .run();" + NL
    + "    return noteId;" + NL
    + "  }" + NL + NL
    + "  /** 造一行 note_versions（缺省 revision=1/hash=a*64）；返回整行（含 id） */" + NL
    + "  function seedNoteVersion(" + NL
    + "    db: ReturnType<typeof createTestDb>," + NL
    + "    noteId: string," + NL
    + "    o: { revision?: number; hash?: string } = {}," + NL
    + "  ): typeof noteVersions.$inferInsert {" + NL
    + "    const revision = o.revision ?? 1;" + NL
    + "    const version = {" + NL
    + "      id: randomUUID()," + NL
    + "      noteId," + NL
    + "      revision," + NL
    + '      bodyPath: `blobs/notes/${noteId}/v${revision}.json.gz`,' + NL
    + '      hash: o.hash ?? "a".repeat(64),' + NL
    + "      strokeCount: 1," + NL
    + "      pointCount: 10," + NL
    + "      paperWidth: 1000," + NL
    + "      paperHeight: 800," + NL
    + "      serverSavedAt: new Date().toISOString()," + NL
    + "      renderVersion: 1," + NL
    + "    };" + NL
    + "    db.insert(noteVersions).values(version).run();" + NL
    + "    return version;" + NL
    + "  }" + NL
)
s = s[:at] + builders + s[at + len(anchor):]

# 4) 用例转换：默认值用例（自定义 questionRevisionId）
old = (
    "    const { attemptId, questionId } = seedNoteRefs(db);" + NL
    + "    const noteId = randomUUID();" + NL
    + "    db.insert(notes)" + NL
    + "      .values({" + NL
    + "        id: noteId," + NL
    + "        attemptId," + NL
    + "        questionId," + NL
    + '        questionRevisionId: "练习四-7@3@snap",' + NL
    + "        updatedAt: new Date().toISOString()," + NL
    + "      })" + NL
    + "      .run();"
)
assert old in s, "defaults case"
s = s.replace(
    old,
    "    const { attemptId, questionId } = seedNoteRefs(db);" + NL
    + '    const noteId = seedNote(db, { attemptId, questionId, questionRevisionId: "练习四-7@3@snap" });',
)

# 5) scratch 两行用例
old = (
    "    const { attemptId, questionId } = seedNoteRefs(db);" + NL
    + "    const now = new Date().toISOString();" + NL
    + "    db.insert(notes)" + NL
    + "      .values({" + NL
    + "        id: randomUUID()," + NL
    + "        attemptId," + NL
    + "        questionId," + NL
    + '        questionRevisionId: "rev-a",' + NL
    + "        updatedAt: now," + NL
    + "      })" + NL
    + "      .run();" + NL
    + "    // 同 (attemptId, questionId, phase='scratch') 第二行：DB 层放行（correction 多行性" + NL
    + "    // 使全列唯一索引不可行；partial unique index 依 attempts 表先例不建）" + NL
    + "    expect(() =>" + NL
    + "      db" + NL
    + "        .insert(notes)" + NL
    + "        .values({" + NL
    + "          id: randomUUID()," + NL
    + "          attemptId," + NL
    + "          questionId," + NL
    + '          questionRevisionId: "rev-a",' + NL
    + "          updatedAt: now," + NL
    + "        })" + NL
    + "        .run()," + NL
    + "    ).not.toThrow();"
)
assert old in s, "two-rows case"
s = s.replace(
    old,
    "    const { attemptId, questionId } = seedNoteRefs(db);" + NL
    + "    seedNote(db, { attemptId, questionId });" + NL
    + "    // 同 (attemptId, questionId, phase='scratch') 第二行：DB 层放行（correction 多行性" + NL
    + "    // 使全列唯一索引不可行；partial unique index 依 attempts 表先例不建）" + NL
    + "    expect(() => seedNote(db, { attemptId, questionId })).not.toThrow();",
)

# 6) note_images 用例的 note+version 字面量
old = (
    "    const { attemptId, questionId } = seedNoteRefs(db);" + NL
    + "    const noteId = randomUUID();" + NL
    + "    const versionId = randomUUID();" + NL
    + "    const now = new Date().toISOString();" + NL
    + "    db.insert(notes)" + NL
    + "      .values({" + NL
    + "        id: noteId," + NL
    + "        attemptId," + NL
    + "        questionId," + NL
    + '        questionRevisionId: "rev-a",' + NL
    + "        updatedAt: now," + NL
    + "      })" + NL
    + "      .run();" + NL
    + "    db.insert(noteVersions)" + NL
    + "      .values({" + NL
    + "        id: versionId," + NL
    + "        noteId," + NL
    + "        revision: 1," + NL
    + '      bodyPath: `blobs/notes/${noteId}/v1.json.gz`,' + NL
    + '      hash: "a".repeat(64),' + NL
    + "        strokeCount: 1," + NL
    + "        pointCount: 10," + NL
    + "        paperWidth: 1000," + NL
    + "        paperHeight: 800," + NL
    + "        serverSavedAt: now," + NL
    + "        renderVersion: 1," + NL
    + "      })" + NL
    + "      .run();"
)
# 注意 v670 块的缩进可能有 6 空格差异——先按原文精确试
if old in s:
    s = s.replace(
        old,
        "    const { attemptId, questionId } = seedNoteRefs(db);" + NL
        + "    const noteId = seedNote(db, { attemptId, questionId });" + NL
        + "    const versionId = seedNoteVersion(db, noteId).id;",
    )
    print("case 670 converted (exact)")
else:
    print("case 670 literal mismatch — leaving for manual pass")

io.open(p, "w", encoding="utf-8", newline=NL).write(s)
print("schema.test pass1 done")
