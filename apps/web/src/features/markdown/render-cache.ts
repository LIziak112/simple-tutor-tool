import type { ReactElement } from "react";
import Markdown, { type Components } from "react-markdown";
import {
  richMarkdownRehypePlugins,
  richMarkdownRehypePluginsCompact,
  richMarkdownRehypePluginsWithLrNodes,
  richMarkdownRemarkPlugins,
  richMarkdownRemarkPluginsWithLrNodes,
} from "./pipeline";

/**
 * Markdown 渲染结果缓存（性能：大量习题加载卡顿，2026-10-28）。
 *
 * 背景：`RichMarkdown` 每挂载一次就跑完整管线（remark → rehype → KaTeX →
 * sanitize）；选择题每个选项各挂一次（130 题 × 5 ≈ 650 次）。题卡懒挂载
 * （AttemptQuestionRow）之后，同一题面还会随着滚动反复挂载/卸载，重复解析
 * 变成滚动路径上的固定开销。
 *
 * 做法：按「管线变体 + 解析源文」缓存 `react-markdown` 的渲染结果元素。
 * 元素是不可变描述，跨位置复用不会串状态：指令宿主组件在渲染期从上下文
 * 读作答状态（BlankAnswersProvider / DirectiveSessionProvider），不烘进元素。
 *
 * 边界：
 * - 缓存键必须包含全部影响解析的维度（紧凑形态、LR 节点开关），否则跨形态
 *   串内容；`questionPlaceholder` 只影响外层 Provider，不进键。
 * - 命中时直接返回同一元素，React 对相同元素引用短路，不再跑管线。
 * - 复用元素意味着 hast 节点对象（passNode）跨实例共享；指令宿主只读
 *   `node.properties`，不要在下游改写节点属性。
 * - 单条 source 超过 `MAX_SOURCE_LENGTH` 不入缓存（讲义整篇这类超长文解析
 *   结果体积大、复用率低）。
 */

const MAX_ENTRIES = 500;
const MAX_SOURCE_LENGTH = 20_000;

const cache = new Map<string, ReactElement>();

export type MarkdownVariant = {
  lrNodes: boolean;
  compact: boolean;
};

function variantKey(variant: MarkdownVariant): string {
  if (variant.lrNodes) return "lr";
  return variant.compact ? "compact" : "base";
}

function pluginsOf(variant: MarkdownVariant) {
  return {
    remarkPlugins: variant.lrNodes
      ? richMarkdownRemarkPluginsWithLrNodes
      : richMarkdownRemarkPlugins,
    rehypePlugins: variant.lrNodes
      ? richMarkdownRehypePluginsWithLrNodes
      : variant.compact
        ? richMarkdownRehypePluginsCompact
        : richMarkdownRehypePlugins,
  };
}

/** 渲染 Markdown（带缓存）；同一 source + 变体只解析一次。 */
export function renderMarkdownCached(
  source: string,
  variant: MarkdownVariant,
  components: Components,
): ReactElement {
  const cacheable = source.length <= MAX_SOURCE_LENGTH;
  const key = cacheable ? `${variantKey(variant)}\u0000${source}` : null;
  if (key !== null) {
    const hit = cache.get(key);
    if (hit !== undefined) {
      // LRU：命中移到队尾
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
  }
  const { remarkPlugins, rehypePlugins } = pluginsOf(variant);
  const element = Markdown({
    children: source,
    remarkPlugins,
    rehypePlugins,
    components,
  });
  if (key !== null) {
    cache.set(key, element);
    if (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (!oldest.done) cache.delete(oldest.value);
    }
  }
  return element;
}

/** 测试与热更新用：清空缓存（生产路径不调用）。 */
export function clearMarkdownRenderCache(): void {
  cache.clear();
}

/** 测试用：当前缓存条数。 */
export function markdownRenderCacheSize(): number {
  return cache.size;
}
