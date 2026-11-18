import type {
  BreakNode,
  BulletList,
  DocumentRoot,
  ListItem,
  Mark,
  OrderedList,
  Paragraph,
  SparkDocument,
  TextNode,
} from '../api/types';

export const MAX_TEXT_AND_INTENT_CHARS = 50000;
export const MAX_DOCUMENT_NODES = 10000;
export const MAX_LIST_DEPTH = 3;
export const MAX_LINK_LENGTH = 4096;

export const EMPTY_DOCUMENT: SparkDocument = {
  schema_version: 1,
  content: {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  },
};

export interface RawEditorNode {
  type?: unknown;
  text?: unknown;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: unknown; attrs?: Record<string, unknown> }>;
  content?: RawEditorNode[];
}

export type DocumentSerializeResult =
  | { ok: true; document: SparkDocument; nodeCount: number }
  | { ok: false; unsupported: boolean; message: string };

export function countUnicodeChars(value: string): number {
  return Array.from(value).length;
}

export function isValidHttpUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.length > MAX_LINK_LENGTH) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    return Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

export function inspectSparkDocumentSupport(raw: unknown): { supported: boolean; reason?: string } {
  if (!raw || typeof raw !== 'object') {
    return { supported: false, reason: '文档结构无效' };
  }
  const doc = raw as { schema_version?: unknown; content?: unknown };
  if (doc.schema_version !== 1) {
    return { supported: false, reason: `暂不支持的内容协议版本（v${String(doc.schema_version)}）` };
  }
  const result = sanitizeDocumentRoot(doc.content);
  if (!result.ok) {
    return { supported: false, reason: result.message };
  }
  return { supported: true };
}

function sanitizeMarks(
  rawMarks: RawEditorNode['marks'],
): { ok: true; marks?: Mark[] } | { ok: false; message: string } {
  if (!rawMarks || rawMarks.length === 0) {
    return { ok: true };
  }
  const seenTypes = new Set<string>();
  const marks: Mark[] = [];
  for (const m of rawMarks) {
    if (!m || typeof m.type !== 'string') {
      return { ok: false, message: '包含未知文本标记' };
    }
    if (m.type === 'bold' || m.type === 'highlight') {
      if (!seenTypes.has(m.type)) {
        seenTypes.add(m.type);
        marks.push({ type: m.type });
      }
    } else if (m.type === 'link') {
      const href = typeof m.attrs?.href === 'string' ? m.attrs.href.trim() : '';
      if (!isValidHttpUrl(href)) {
        return { ok: false, message: '正文链接仅支持无凭据的 HTTP(S) 网址' };
      }
      if (!seenTypes.has('link')) {
        seenTypes.add('link');
        marks.push({ type: 'link', attrs: { href } });
      }
    } else {
      return { ok: false, message: `包含当前不支持的文本格式：${m.type}` };
    }
  }
  if (marks.length > 3) {
    return { ok: false, message: '单个文本片段最多支持 3 种格式标记' };
  }
  return { ok: true, marks: marks.length > 0 ? marks : undefined };
}

export function sanitizeDocumentRoot(rawRoot: unknown): DocumentSerializeResult {
  if (!rawRoot || typeof rawRoot !== 'object') {
    return { ok: false, unsupported: true, message: '文档根节点缺失' };
  }
  const root = rawRoot as RawEditorNode;
  if (root.type !== 'doc') {
    return { ok: false, unsupported: true, message: `未知文档根节点类型：${String(root.type)}` };
  }

  let nodeCount = 1;
  const checkNodeLimit = (): string | null => {
    nodeCount += 1;
    if (nodeCount > MAX_DOCUMENT_NODES) {
      return `文档节点数超过上限（${MAX_DOCUMENT_NODES}）`;
    }
    return null;
  };

  const sanitizeInline = (
    node: RawEditorNode,
  ): { ok: true; node: TextNode | BreakNode | null } | { ok: false; unsupported: boolean; message: string } => {
    if (node.type === 'text') {
      const text = typeof node.text === 'string' ? node.text : '';
      if (text.length === 0) {
        return { ok: true, node: null };
      }
      const limitErr = checkNodeLimit();
      if (limitErr) return { ok: false, unsupported: false, message: limitErr };
      const marksRes = sanitizeMarks(node.marks);
      if (!marksRes.ok) {
        return { ok: false, unsupported: false, message: marksRes.message };
      }
      const clean: TextNode = marksRes.marks
        ? { type: 'text', text, marks: marksRes.marks }
        : { type: 'text', text };
      return { ok: true, node: clean };
    }
    if (node.type === 'hardBreak') {
      const limitErr = checkNodeLimit();
      if (limitErr) return { ok: false, unsupported: false, message: limitErr };
      return { ok: true, node: { type: 'hardBreak' } };
    }
    return {
      ok: false,
      unsupported: true,
      message: `包含当前不支持的行内节点：${String(node.type)}`,
    };
  };

  const sanitizeParagraph = (
    node: RawEditorNode,
  ): { ok: true; node: Paragraph } | { ok: false; unsupported: boolean; message: string } => {
    const limitErr = checkNodeLimit();
    if (limitErr) return { ok: false, unsupported: false, message: limitErr };
    const inlineContent: Array<TextNode | BreakNode> = [];
    for (const child of node.content ?? []) {
      const res = sanitizeInline(child);
      if (!res.ok) return res;
      if (res.node) inlineContent.push(res.node);
    }
    return {
      ok: true,
      node: inlineContent.length > 0 ? { type: 'paragraph', content: inlineContent } : { type: 'paragraph' },
    };
  };

  const sanitizeListItem = (
    node: RawEditorNode,
    listDepth: number,
  ): { ok: true; node: ListItem } | { ok: false; unsupported: boolean; message: string } => {
    if (node.type !== 'listItem') {
      return { ok: false, unsupported: true, message: `列表中包含未知节点：${String(node.type)}` };
    }
    const limitErr = checkNodeLimit();
    if (limitErr) return { ok: false, unsupported: false, message: limitErr };
    const children: Array<Paragraph | BulletList | OrderedList> = [];
    for (const child of node.content ?? []) {
      if (child.type === 'paragraph') {
        const pRes = sanitizeParagraph(child);
        if (!pRes.ok) return pRes;
        children.push(pRes.node);
      } else if (child.type === 'bulletList' || child.type === 'orderedList') {
        const lRes = sanitizeList(child, listDepth + 1);
        if (!lRes.ok) return lRes;
        children.push(lRes.node);
      } else {
        return { ok: false, unsupported: true, message: `列表项包含不支持的节点：${String(child.type)}` };
      }
    }
    if (children.length === 0) {
      children.push({ type: 'paragraph' });
    }
    return { ok: true, node: { type: 'listItem', content: children } };
  };

  const sanitizeList = (
    node: RawEditorNode,
    listDepth: number,
  ): { ok: true; node: BulletList | OrderedList } | { ok: false; unsupported: boolean; message: string } => {
    if (listDepth > MAX_LIST_DEPTH) {
      return { ok: false, unsupported: false, message: `列表嵌套最多支持 ${MAX_LIST_DEPTH} 层` };
    }
    const limitErr = checkNodeLimit();
    if (limitErr) return { ok: false, unsupported: false, message: limitErr };
    const items: ListItem[] = [];
    for (const child of node.content ?? []) {
      const itemRes = sanitizeListItem(child, listDepth);
      if (!itemRes.ok) return itemRes;
      items.push(itemRes.node);
    }
    if (items.length === 0) {
      items.push({ type: 'listItem', content: [{ type: 'paragraph' }] });
    }
    if (node.type === 'orderedList') {
      const rawStart = node.attrs?.start;
      const start =
        typeof rawStart === 'number' && Number.isInteger(rawStart) && rawStart >= 1 && rawStart <= 10000
          ? rawStart
          : undefined;
      return {
        ok: true,
        node:
          start !== undefined && start !== 1
            ? { type: 'orderedList', attrs: { start }, content: items }
            : { type: 'orderedList', content: items },
      };
    }
    return { ok: true, node: { type: 'bulletList', content: items } };
  };

  const blocks: DocumentRoot['content'] = [];
  for (const child of root.content ?? []) {
    if (child.type === 'paragraph') {
      const res = sanitizeParagraph(child);
      if (!res.ok) return res;
      blocks.push(res.node);
    } else if (child.type === 'bulletList' || child.type === 'orderedList') {
      const res = sanitizeList(child, 1);
      if (!res.ok) return res;
      blocks.push(res.node);
    } else {
      return {
        ok: false,
        unsupported: true,
        message: `正文包含当前暂不支持的块级节点：${String(child.type)}`,
      };
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'paragraph' });
  }

  return {
    ok: true,
    nodeCount,
    document: {
      schema_version: 1,
      content: {
        type: 'doc',
        content: blocks,
      },
    },
  };
}

export function derivePlainText(doc: SparkDocument): string {
  const lines: string[] = [];

  const readParagraph = (p: Paragraph): string => {
    if (!p.content) return '';
    return p.content
      .map((node) => (node.type === 'text' ? node.text : '\n'))
      .join('');
  };

  const walkBlocks = (blocks: Array<Paragraph | BulletList | OrderedList>): void => {
    for (const block of blocks) {
      if (block.type === 'paragraph') {
        lines.push(readParagraph(block));
      } else {
        for (const item of block.content) {
          walkBlocks(item.content);
        }
      }
    }
  };

  walkBlocks(doc.content.content);
  return lines.join('\n');
}

export function createDocumentFromPlainText(text: string): SparkDocument {
  const paragraphs = text.split(/\r?\n/);
  const content: Paragraph[] =
    paragraphs.length > 0
      ? paragraphs.map((line) =>
          line.length > 0
            ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
            : { type: 'paragraph' },
        )
      : [{ type: 'paragraph' }];

  return {
    schema_version: 1,
    content: {
      type: 'doc',
      content,
    },
  };
}

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>"'()]+/i;

export function extractFirstHttpUrl(doc: SparkDocument): string | undefined {
  let found: string | undefined;

  const walkBlocks = (blocks: Array<Paragraph | BulletList | OrderedList>): void => {
    for (const block of blocks) {
      if (found) return;
      if (block.type === 'paragraph') {
        for (const inline of block.content ?? []) {
          if (inline.type === 'text') {
            const linkMark = inline.marks?.find((m) => m.type === 'link');
            if (linkMark && linkMark.type === 'link' && isValidHttpUrl(linkMark.attrs.href)) {
              found = linkMark.attrs.href;
              return;
            }
            const match = inline.text.match(URL_IN_TEXT_RE);
            if (match && isValidHttpUrl(match[0])) {
              found = match[0];
              return;
            }
          }
        }
      } else {
        for (const item of block.content) {
          walkBlocks(item.content);
          if (found) return;
        }
      }
    }
  };

  walkBlocks(doc.content.content);
  return found;
}
