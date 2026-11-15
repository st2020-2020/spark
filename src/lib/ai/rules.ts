import type { AIProvider, OrganizeInput } from "./provider";
import type { Organization } from "../types";

const groups: [string, RegExp][] = [
  ["AI", /人工智能|大模型|机器学习|\b(ai|llm|gpt|claude|openai|anthropic)\b/i],
  [
    "开发",
    /编程|代码|开发|接口|数据库|\b(react|next\.?js|typescript|javascript|python|github|api|sqlite)\b/i,
  ],
  ["设计", /设计|排版|交互|配色|\b(ui|ux|figma|design)\b/i],
  ["阅读", /读书|阅读|文章|书单|笔记|\b(book|read|article)\b/i],
  ["工作", /工作|会议|项目|客户|需求|计划|汇报|\b(work|meeting|project)\b/i],
  [
    "生活",
    /生活|旅行|旅游|做饭|美食|运动|散步|跑步|健身|\b(travel|food|life)\b/i,
  ],
  ["灵感", /灵感|想法|创意|点子|也许|\b(idea|inspiration)\b/i],
  ["待办", /待办|明天|下周|记得|需要|\b(todo|to-do|remind)\b/i],
];

export function organizeWithRules(input: OrganizeInput): Organization {
  const text = `${input.title || ""} ${input.content}`;
  const explicit = [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{1,24})/gu)].map(
    (m) => m[1],
  );
  const matched = groups
    .filter(([, regex]) => regex.test(text))
    .map(([tag]) => tag);
  const tags = [...new Set([...explicit, ...matched])].slice(0, 5);
  if (!tags.length)
    tags.push(
      input.source === "image"
        ? "图片收藏"
        : input.source === "url"
          ? "稍后阅读"
          : "随手记",
    );
  const raw = (input.title || input.content)
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const first = raw.match(/^.*?[。！？.!?](?:\s|$)/)?.[0]?.trim() || raw;
  let summary = first.length > 78 ? `${first.slice(0, 77)}…` : first;
  if (!summary)
    summary =
      input.source === "image"
        ? "保存了一张图片，可补充文字帮助整理。"
        : "收藏了一个链接，留待稍后阅读。";
  else if (!/[。！？.!?…]$/.test(summary)) summary += "。";
  return { tags, summary };
}

export class RulesProvider implements AIProvider {
  readonly name = "rules";
  async organize(input: OrganizeInput) {
    return organizeWithRules(input);
  }
}
