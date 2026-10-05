import io

NL = chr(10)
p = "apps/server/src/db/schema.test.ts"
s = io.open(p, encoding="utf-8").read()

def note_version_block(revision: str, hash_expr: str, extra_indent: str = "        ") -> str:
    return (
        "    db.insert(noteVersions)" + NL
        + "      .values({" + NL
        + "        id: versionId," + NL
        + "        noteId," + NL
        + "        revision: " + revision + "," + NL
        + "        bodyPath: `blobs/notes/${noteId}/v" + revision + ".json.gz`," + NL
        + "        hash: " + hash_expr + "," + NL
        + "        strokeCount: 1," + NL
        + "        pointCount: 10," + NL
        + "        paperWidth: 1000," + NL
        + "        paperHeight: 800," + NL
        + "        serverSavedAt: now," + NL
        + "        renderVersion: 1," + NL
        + "      })" + NL
        + "      .run();"
    )

common_head = (
    "    const { attemptId%s } = seedNoteRefs(db);" + NL
    + "    const noteId = randomUUID();" + NL
    + "    const versionId = randomUUID();" + NL
    + "    const now = new Date().toISOString();" + NL
    + "    db.insert(notes)" + NL
    + "      .values({" + NL
    + "        id: noteId," + NL
    + "        attemptId," + NL
)

# ---- 670: note_images ----
old = (
    common_head % ""
    + "        questionId," + NL
    + '        questionRevisionId: "rev-a",' + NL
    + "        updatedAt: now," + NL
    + "      })" + NL
    + "      .run();" + NL
    + note_version_block("1", '"a".repeat(64)')
)
assert old in s, "670"
s = s.replace(
    old,
    "    const { attemptId, questionId } = seedNoteRefs(db);" + NL
    + "    const noteId = seedNote(db, { attemptId, questionId });" + NL
    + "    const versionId = seedNoteVersion(db, noteId).id;",
    1,
)

# ---- 742: submission_evidence（revision 2 / hash b）----
old = (
    common_head % ""
    + "        questionId," + NL
    + '        questionRevisionId: "rev-a",' + NL
    + "        updatedAt: now," + NL
    + "      })" + NL
    + "      .run();" + NL
    + note_version_block("2", '"b".repeat(64)').replace("strokeCount: 1,", "strokeCount: 3,").replace("pointCount: 10,", "pointCount: 30,")
)
assert old in s, "742"
s = s.replace(
    old,
    "    const { attemptId, questionId } = seedNoteRefs(db);" + NL
    + "    const noteId = seedNote(db, { attemptId, questionId });" + NL
    + '    const versionId = seedNoteVersion(db, noteId, { revision: 2, hash: "b".repeat(64) }).id;',
    1,
)

# ---- 827: 头指针切换（自定义 questionId）----
old = (
    "    const { attemptId } = seedNoteRefs(db);" + NL
    + "    const noteId = randomUUID();" + NL
    + "    const versionId = randomUUID();" + NL
    + "    const now = new Date().toISOString();" + NL
    + "    db.insert(notes)" + NL
    + "      .values({" + NL
    + "        id: noteId," + NL
    + "        attemptId," + NL
    + '        questionId: "任意-DSL.id",' + NL
    + '        questionRevisionId: "rev-a",' + NL
    + "        updatedAt: now," + NL
    + "      })" + NL
    + "      .run();" + NL
    + note_version_block("1", '"a".repeat(64)')
)
assert old in s, "827"
s = s.replace(
    old,
    "    const { attemptId } = seedNoteRefs(db);" + NL
    + '    const noteId = seedNote(db, { attemptId, questionId: "任意-DSL.id" });' + NL
    + "    const versionId = seedNoteVersion(db, noteId).id;",
    1,
)

io.open(p, "w", encoding="utf-8", newline=NL).write(s)
print("pass2: 670/742/827 converted")
