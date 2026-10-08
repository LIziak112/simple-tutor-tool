/**
 * review-pack 文件/附件分类的用户可读名（单一来源）：
 * 预览清单行前缀（review-pack-panel）与合成图图注（export-review-image）共用，
 * 未知 kind 由调用方回退到原始值。
 */
export const REVIEW_PACK_KIND_LABELS: Record<string, string> = {
  pack: "清单",
  review: "提示词",
  schema: "结构说明",
  "question-md": "题目文字",
  media: "配图",
  evidence: "手写原稿图",
  ink: "手写笔迹",
};
