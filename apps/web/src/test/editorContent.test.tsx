import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { SparkDocument } from '../api/types';
import { RichTextEditor } from '../components/RichTextEditor';
import { loadDraft, saveDraft } from '../lib/drafts';

it('allows only document attributes when opening a saved draft, resetting content and pasting HTML', () => {
  const document = (text: string) => ({
    schema_version: 1,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{
      type: 'text', text, marks: [{ type: 'link', attrs: { href: 'https://example.test/note', class: 'imported-theme', target: 'reader' } }],
    }] }] },
  });
  saveDraft('user-a', 'inbox', { document: document('草稿链接') });
  const draft = loadDraft<{ document: SparkDocument }>('user-a', 'inbox').data!;
  expect(draft.document.content.content[0]).toEqual({
    type: 'paragraph', content: [{ type: 'text', text: '草稿链接',
      marks: [{ type: 'link', attrs: { href: 'https://example.test/note' } }] }],
  });
  const onChange = vi.fn();
  const { rerender } = render(<RichTextEditor value={draft.document} onChange={onChange} />);
  function check(text: string) {
    const link = within(screen.getByRole('textbox', { name: '收藏正文编辑器' })).getByRole('link', { name: text });
    expect(link).toHaveAttribute('href', 'https://example.test/note');
    expect(link).not.toHaveClass('imported-theme');
    expect(link).not.toHaveAttribute('target', 'reader');
  }
  check('草稿链接');
  rerender(<RichTextEditor value={document('详情链接') as SparkDocument} resetToken={1} onChange={onChange} />);
  check('详情链接');
  const editor = screen.getByRole('textbox', { name: '收藏正文编辑器' });
  fireEvent.paste(editor, { clipboardData: {
    files: [], items: [], types: ['text/html', 'text/plain'],
    getData: (type: string) => type === 'text/html'
      ? '<p><a href="https://example.test/note" class="imported-theme" target="reader">粘贴链接</a></p>'
      : '粘贴链接',
  } });
  expect(editor).toHaveTextContent('粘贴链接');
  const pasted = editor.querySelector('a');
  expect(pasted).not.toBeNull();
  expect(editor.querySelector('.imported-theme, [target="reader"]')).toBeNull();
});
