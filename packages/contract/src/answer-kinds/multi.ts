/**
 * multi 纯行为：与 choice 共用一份实现（TT-02 原型工程性记录——两者公开结构
 * 同为 OptionsPublicStructure，签名覆盖两种答案形态；登记表两个键引用同一
 * 实现，见 index.ts）。行为正文在 ./choice.ts。
 */
export { choiceMultiBehavior as multiBehavior } from "./choice.ts";
