import { describe, expect, it } from 'vitest';
import {
  countUnicodeChars,
  derivePlainText,
  extractFirstHttpUrl,
  inspectSparkDocumentSupport,
  isValidHttpUrl,
  sanitizeDocumentRoot,
} from '../lib/document';
import { splitHighlightSegments } from '../lib/highlight';
import { validateImageFile } from '../lib/uploads';

// Inline mirror of contracts/examples/document.json so tests work inside isolated container builds
const exampleDoc = {
  schema_version: 1,
  content: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: '收藏离线同步方案',
            marks: [{ type: 'bold' }],
          },
        ],
      },
    ],
  },
};

describe('document protocol v1', () => {
  it('accepts contract example document and derives plain text', () => {
    const support = inspectSparkDocumentSupport(exampleDoc);
    expect(support.supported).toBe(true);
    expect(derivePlainText(exampleDoc as Parameters<typeof derivePlainText>[0])).toBe('收藏离线同步方案');
  });

  it('strips extra TipTap attributes from highlight and link marks', () => {
    const res = sanitizeDocumentRoot({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Spark',
              marks: [
                { type: 'highlight', attrs: { color: '#fff2b3' } },
                { type: 'link', attrs: { href: 'https://example.com/sync', target: '_blank' } },
              ],
            },
          ],
        },
      ],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.document).toEqual({
        schema_version: 1,
        content: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                {
                  type: 'text',
                  text: 'Spark',
                  marks: [
                    { type: 'highlight' },
                    { type: 'link', attrs: { href: 'https://example.com/sync' } },
                  ],
                },
              ],
            },
          ],
        },
      });
      expect(extractFirstHttpUrl(res.document)).toBe('https://example.com/sync');
    }
  });

  it('rejects credentialed or non-http(s) URLs', () => {
    expect(isValidHttpUrl('https://example.com/a?b=1')).toBe(true);
    expect(isValidHttpUrl('http://user:pass@example.com/a')).toBe(false);
    expect(isValidHttpUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects unsupported schema_version and unknown nodes without dropping', () => {
    expect(inspectSparkDocumentSupport({ schema_version: 2, content: {} }).supported).toBe(false);
    const unknownBlock = sanitizeDocumentRoot({
      type: 'doc',
      content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'const x = 1' }] }],
    });
    expect(unknownBlock.ok).toBe(false);
    if (!unknownBlock.ok) {
      expect(unknownBlock.unsupported).toBe(true);
    }
  });

  it('enforces max list nesting depth of 3', () => {
    const makeNestedList = (depth: number): Record<string, unknown> => ({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content:
            depth <= 1
              ? [{ type: 'paragraph', content: [{ type: 'text', text: 'leaf' }] }]
              : [{ type: 'paragraph' }, makeNestedList(depth - 1)],
        },
      ],
    });

    expect(sanitizeDocumentRoot({ type: 'doc', content: [makeNestedList(3)] }).ok).toBe(true);
    expect(sanitizeDocumentRoot({ type: 'doc', content: [makeNestedList(4)] }).ok).toBe(false);
  });

  it('counts Unicode codepoints accurately and highlights safely', () => {
    expect(countUnicodeChars('中文A😀')).toBe(4);
    expect(splitHighlightSegments('离线冲突处理可以参考', '冲突 参考')).toEqual([
      { text: '离线', match: false },
      { text: '冲突', match: true },
      { text: '处理可以', match: false },
      { text: '参考', match: true },
    ]);
  });

  it('validates image file size and mime type cleanly', () => {
    const oversized = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', {
      type: 'image/png',
    });
    expect(validateImageFile(oversized).ok).toBe(false);
    const badMime = new File(['abc'], 'note.txt', { type: 'text/plain' });
    expect(validateImageFile(badMime).ok).toBe(false);
    const valid = new File([new Uint8Array([137, 80, 78, 71])], 'ok.png', {
      type: 'image/png',
    });
    expect(validateImageFile(valid)).toEqual({ ok: true, mimeType: 'image/png' });
  });
});
