import type {
  StudentAnswer,
  StudentMcpPracticeData,
  StudentMcpPracticeListData,
  StudentMcpPracticeQuestionData,
} from "@tutor/contract";
import { assertMetadataByteBudget } from "./memo-budget.ts";

type QuestionData = StudentMcpPracticeQuestionData;
type ImageMetadata = QuestionData["images"][number];
/** 纯src预检在stat前；stat后用真实MIME/byteSize再验，交付前按完整结构验。 */
export type QuestionMetadataInput = Omit<QuestionData, "images"> & {
  images: readonly (Pick<ImageMetadata, "src"> &
    Partial<Omit<ImageMetadata, "src">>)[];
};

/** 只豁免明确正文键；选项编号、匹配/排序ID和未来新增字段仍属于元数据。 */
const answerBodyKeys = {
  judge: ["value"],
  choice: [],
  multi: [],
  fill: ["values"],
  final: ["finalAnswer"],
  response: ["title", "body"],
  matching: [],
  ordering: [],
} as const satisfies {
  [Kind in StudentAnswer["kind"]]: readonly (keyof Extract<
    StudentAnswer,
    { kind: Kind }
  >)[];
};

type BodyKey<T> = T extends unknown ? Extract<keyof T, string> : never;

function omitBody<T extends object>(
  input: T,
  keys: readonly BodyKey<T>[],
): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  const bodyKeys = new Set<string>(keys);
  for (const [key, value] of Object.entries(input as Record<string, unknown>))
    if (!bodyKeys.has(key)) metadata[key] = value;
  return metadata;
}

function answerMetadata(answer: StudentAnswer | null) {
  return answer === null ? null : omitBody(answer, answerBodyKeys[answer.kind]);
}

/** 从完整公开响应扣除闭合的已知正文，不构建容易漏掉新元字段的白名单。 */
export function studentMcpQuestionMetadata(data: QuestionMetadataInput) {
  const { matchingOptions, orderingItems, ...question } = omitBody(
    data.question,
    ["stemMd", "options"],
  );
  return {
    ...data,
    question: {
      ...question,
      ...(data.question.matchingOptions === undefined
        ? {}
        : {
            matchingOptions: {
              ...data.question.matchingOptions,
              options: data.question.matchingOptions.options.map((option) =>
                omitBody(option, ["text"]),
              ),
            },
          }),
      ...(data.question.orderingItems === undefined
        ? {}
        : {
            orderingItems: data.question.orderingItems.map((item) =>
              omitBody(item, ["text"]),
            ),
          }),
    },
    materials: data.materials.map((material) =>
      omitBody(material, ["contentMd"]),
    ),
    currentAnswer: answerMetadata(data.currentAnswer),
  };
}

export function assertStudentMcpQuestionMetadata(
  data: QuestionMetadataInput,
): void {
  assertMetadataByteBudget(
    Buffer.byteLength(JSON.stringify(studentMcpQuestionMetadata(data)), "utf8"),
  );
}

export function assertStudentMcpPracticeMetadata(
  data: StudentMcpPracticeData,
): void {
  assertMetadataByteBudget(
    Buffer.byteLength(
      JSON.stringify({
        ...data,
        questions: data.questions.map((question) =>
          omitBody(question, ["stemExcerpt"]),
        ),
      }),
      "utf8",
    ),
  );
}

export function assertStudentMcpListMetadata(
  data: StudentMcpPracticeListData,
): void {
  assertMetadataByteBudget(Buffer.byteLength(JSON.stringify(data), "utf8"));
}
