import { useEffect, useRef, useState, type ReactNode } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Bold from '@tiptap/extension-bold';
import BulletList from '@tiptap/extension-bullet-list';
import Document from '@tiptap/extension-document';
import HardBreak from '@tiptap/extension-hard-break';
import Highlight from '@tiptap/extension-highlight';
import History from '@tiptap/extension-history';
import Link from '@tiptap/extension-link';
import ListItem from '@tiptap/extension-list-item';
import OrderedList from '@tiptap/extension-ordered-list';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import Text from '@tiptap/extension-text';
import {
  Bold as BoldIcon,
  Highlighter,
  Link2,
  List,
  ListOrdered,
  MoreHorizontal,
  Redo2,
  Undo2,
} from 'lucide-react';
import type { SparkDocument } from '../api/types';
import {
  EMPTY_DOCUMENT,
  inspectSparkDocumentSupport,
  isValidHttpUrl,
  sanitizeDocumentRoot,
  type RawEditorNode,
} from '../lib/document';
import { handleMenuKeyDown } from '../lib/menuKeyboard';
import { extractFilesFromDataTransfer } from '../lib/uploads';

// Pasted HTML uses these same fixed schemas before any editor update is serialized.
const DocumentLink = Link.extend({
  addAttributes() {
    return { href: { default: null } };
  },
}).configure({
  openOnClick: false,
  autolink: false,
  protocols: ['http', 'https'],
  isAllowedUri: isValidHttpUrl,
});

const DocumentOrderedList = OrderedList.extend({
  addAttributes() {
    return {
      start: {
        default: 1,
        parseHTML: (element: HTMLElement) => {
          const value = Number(element.getAttribute('start'));
          return Number.isInteger(value) && value >= 1 && value <= 10000 ? value : 1;
        },
      },
    };
  },
});

interface RichTextEditorProps {
  value: SparkDocument;
  onChange: (doc: SparkDocument) => void;
  onShortcutSubmit?: () => void;
  onFocusChange?: (focused: boolean) => void;
  onToolbarInteract?: () => void;
  onFilesAdded?: (files: File[]) => void;
  autoFocus?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  resetToken?: number;
  suggestions?: (editor: Editor) => ReactNode;
  leadingTools?: ReactNode;
  extraMoreItems?: (closeMenu: () => void) => ReactNode;
  betweenEditorAndToolbar?: ReactNode;
  trailingSlot?: ReactNode;
  externalMenuOpen?: boolean;
  onCloseExternalMenus?: () => void;
}

export function RichTextEditor({
  value,
  onChange,
  onShortcutSubmit,
  onFocusChange,
  onToolbarInteract,
  onFilesAdded,
  autoFocus = false,
  placeholder = '记下想法，或粘贴网址…',
  ariaLabel = '收藏正文编辑器',
  disabled = false,
  resetToken = 0,
  suggestions,
  leadingTools,
  extraMoreItems,
  betweenEditorAndToolbar,
  trailingSlot,
  externalMenuOpen = false,
  onCloseExternalMenus,
}: RichTextEditorProps) {
  const support = inspectSparkDocumentSupport(value);
  const isComposingRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const onShortcutSubmitRef = useRef(onShortcutSubmit);
  const onFocusChangeRef = useRef(onFocusChange);
  const onToolbarInteractRef = useRef(onToolbarInteract);
  const onFilesAddedRef = useRef(onFilesAdded);
  onChangeRef.current = onChange;
  onShortcutSubmitRef.current = onShortcutSubmit;
  onFocusChangeRef.current = onFocusChange;
  onToolbarInteractRef.current = onToolbarInteract;
  onFilesAddedRef.current = onFilesAdded;

  const [isDragOver, setIsDragOver] = useState(false);

  const [aaOpen, setAaOpen] = useState(false);
  const [linkPanelOpen, setLinkPanelOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [linkUrlInput, setLinkUrlInput] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [serializeError, setSerializeError] = useState<string | null>(null);

  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const aaWrapRef = useRef<HTMLDivElement | null>(null);
  const aaTriggerRef = useRef<HTMLButtonElement | null>(null);
  const linkWrapRef = useRef<HTMLDivElement | null>(null);
  const linkTriggerRef = useRef<HTMLButtonElement | null>(null);
  const linkInputRef = useRef<HTMLInputElement | null>(null);
  const moreWrapRef = useRef<HTMLDivElement | null>(null);
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const savedSelectionRef = useRef<{ from: number; to: number } | null>(null);

  const editor = useEditor({
    editable: !disabled && support.supported,
    extensions: [
      Document,
      Paragraph,
      Text,
      HardBreak,
      Bold,
      Highlight.configure({ multicolor: false }),
      DocumentLink,
      BulletList,
      DocumentOrderedList,
      ListItem,
      History,
      Placeholder.configure({ placeholder }),
    ],
    content: support.supported ? support.document.content : EMPTY_DOCUMENT.content,
    editorProps: {
      attributes: {
        role: 'textbox',
        tabindex: '0',
        'aria-multiline': 'true',
        'aria-label': ariaLabel,
      },
      handleDOMEvents: {
        compositionstart: () => {
          isComposingRef.current = true;
          return false;
        },
        compositionend: () => {
          isComposingRef.current = false;
          return false;
        },
        focus: () => {
          onFocusChangeRef.current?.(true);
          return false;
        },
        blur: () => {
          onFocusChangeRef.current?.(false);
          return false;
        },
      },
      handleKeyDown: (_view, event) => {
        if (event.isComposing || isComposingRef.current || event.keyCode === 229) {
          return false;
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          onShortcutSubmitRef.current?.();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      const sanitized = sanitizeDocumentRoot(ed.getJSON() as RawEditorNode);
      if (sanitized.ok) {
        setSerializeError(null);
        onChangeRef.current(sanitized.document);
      } else {
        setSerializeError(sanitized.message);
      }
    },
  });

  useEffect(() => {
    if (!editor || !support.supported) return;
    const current = sanitizeDocumentRoot(editor.getJSON() as RawEditorNode);
    const currentJson = current.ok ? JSON.stringify(current.document) : '';
    const nextJson = JSON.stringify(support.document);
    if (currentJson !== nextJson) {
      editor.commands.setContent(support.document.content, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken, editor]);

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!disabled && support.supported, false);
  }, [disabled, editor, support.supported]);

  useEffect(() => {
    if (editor && autoFocus && !disabled && support.supported) {
      editor.commands.focus('end');
    }
  }, [autoFocus, disabled, editor, support.supported]);

  // Close internal popovers when an external popover (e.g., project picker) opens
  useEffect(() => {
    if (externalMenuOpen) {
      setAaOpen(false);
      setLinkPanelOpen(false);
      setMoreOpen(false);
    }
  }, [externalMenuOpen]);

  // Outside click & Escape handling with focus restoration
  useEffect(() => {
    if (!aaOpen && !linkPanelOpen && !moreOpen) return;

    const onClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (aaOpen && aaWrapRef.current && !aaWrapRef.current.contains(target)) {
        setAaOpen(false);
      }
      if (linkPanelOpen && linkWrapRef.current && !linkWrapRef.current.contains(target)) {
        setLinkPanelOpen(false);
      }
      if (moreOpen && moreWrapRef.current && !moreWrapRef.current.contains(target)) {
        setMoreOpen(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();

      const active = document.activeElement;
      if (linkPanelOpen) {
        setLinkPanelOpen(false);
        if (linkWrapRef.current?.contains(active)) {
          linkTriggerRef.current?.focus();
        }
        return;
      }
      if (aaOpen) {
        setAaOpen(false);
        if (aaWrapRef.current?.contains(active)) {
          aaTriggerRef.current?.focus();
        }
        return;
      }
      if (moreOpen) {
        setMoreOpen(false);
        if (moreWrapRef.current?.contains(active)) {
          moreTriggerRef.current?.focus();
        }
      }
    };

    document.addEventListener('mousedown', onClickOutside);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [aaOpen, linkPanelOpen, moreOpen]);

  useEffect(() => {
    if (linkPanelOpen) {
      window.requestAnimationFrame(() => {
        linkInputRef.current?.focus();
        linkInputRef.current?.select();
      });
    }
  }, [linkPanelOpen]);

  if (!support.supported) {
    return (
      <div className="sp-stack">
        <div className="sp-banner sp-banner--warning">
          <span>
            {support.reason ?? '正文包含当前编辑器暂不支持的内容协议。'} 为防止丢失原有内容，已保留原文并禁用富文本覆写。
          </span>
        </div>
        <pre className="sp-editor-raw">
          {JSON.stringify(value, null, 2)}
        </pre>
      </div>
    );
  }

  const toggleLinkPopover = () => {
    onToolbarInteractRef.current?.();
    onCloseExternalMenus?.();
    setAaOpen(false);
    setMoreOpen(false);

    if (linkPanelOpen) {
      setLinkPanelOpen(false);
      return;
    }

    if (editor) {
      savedSelectionRef.current = {
        from: editor.state.selection.from,
        to: editor.state.selection.to,
      };
      const existing = editor.getAttributes('link')?.href;
      setLinkUrlInput(typeof existing === 'string' && existing ? existing : 'https://');
    } else {
      savedSelectionRef.current = null;
      setLinkUrlInput('https://');
    }
    setLinkError(null);
    setLinkPanelOpen(true);
  };

  const applyLink = () => {
    if (!editor) return;
    const trimmed = linkUrlInput.trim();
    const sel = savedSelectionRef.current;

    if (!trimmed) {
      const chain = editor.chain().focus();
      if (sel) chain.setTextSelection(sel);
      chain.extendMarkRange('link').unsetLink().run();
      setLinkPanelOpen(false);
      setLinkError(null);
      return;
    }

    if (!isValidHttpUrl(trimmed)) {
      setLinkError('请输入有效的 http:// 或 https:// 网址（不支持包含用户名或密码的链接）。');
      return;
    }

    const hasRange = sel ? sel.from !== sel.to : !editor.state.selection.empty;
    const isInLink = editor.isActive('link');
    const chain = editor.chain().focus();
    if (sel) chain.setTextSelection(sel);

    if (hasRange || isInLink) {
      chain.extendMarkRange('link').setLink({ href: trimmed }).run();
    } else {
      chain
        .insertContent({
          type: 'text',
          text: trimmed,
          marks: [{ type: 'link', attrs: { href: trimmed } }],
        })
        .run();
    }

    setLinkPanelOpen(false);
    setLinkError(null);
  };

  const removeLink = () => {
    if (!editor) return;
    const sel = savedSelectionRef.current;
    const chain = editor.chain().focus();
    if (sel) chain.setTextSelection(sel);
    chain.extendMarkRange('link').unsetLink().run();
    setLinkPanelOpen(false);
    setLinkError(null);
  };

  const canUndo = editor?.can().undo() ?? false;
  const canRedo = editor?.can().redo() ?? false;
  const hasAaActive = Boolean(
    editor?.isActive('bold') ||
      editor?.isActive('highlight') ||
      editor?.isActive('bulletList') ||
      editor?.isActive('orderedList'),
  );

  return (
    <div>
      {serializeError && (
        <div className="sp-banner sp-banner--error sp-composer-notice">
          <span>{serializeError}</span>
        </div>
      )}

      <div
        className={`sp-editor-dropzone ${isDragOver ? 'is-drag-over' : ''}`}
        onPasteCapture={(e) => {
          if (disabled || !onFilesAddedRef.current) return;
          const files = extractFilesFromDataTransfer(e.clipboardData);
          if (files.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            onFilesAddedRef.current(files);
          }
        }}
        onDragOver={(e) => {
          if (disabled || !onFilesAddedRef.current) return;
          const hasFiles =
            Boolean(e.dataTransfer?.types?.includes('Files')) ||
            Boolean(e.dataTransfer?.files && e.dataTransfer.files.length > 0);
          if (hasFiles) {
            e.preventDefault();
            setIsDragOver(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setIsDragOver(false);
          }
        }}
        onDrop={(e) => {
          setIsDragOver(false);
          if (disabled || !onFilesAddedRef.current) return;
          const files = extractFilesFromDataTransfer(e.dataTransfer);
          if (files.length > 0) {
            e.preventDefault();
            e.stopPropagation();
            onFilesAddedRef.current(files);
          }
        }}
      >
        <EditorContent editor={editor} className="sp-composer-editor" />
      </div>

      {editor && !disabled && suggestions?.(editor)}
      {betweenEditorAndToolbar}

      <div className="sp-editor-toolbar" ref={toolbarRef} role="toolbar" aria-label="编辑与格式工具栏">
        <div className="sp-editor-tools-left">
          {leadingTools}

          <div className="sp-popover-anchor sp-popover-anchor--mobile-span" ref={linkWrapRef}>
            <button
              ref={linkTriggerRef}
              type="button"
              className="sp-tool-btn"
              aria-label="附加链接"
              data-tooltip="附加链接"
              aria-expanded={linkPanelOpen}
              aria-pressed={editor?.isActive('link') ?? false}
              disabled={disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={toggleLinkPopover}
            >
              <Link2 size={18} strokeWidth={2} aria-hidden="true" />
            </button>

            {linkPanelOpen && (
              <div
                className="sp-popover sp-popover--above sp-popover--form"
                role="dialog"
                aria-label="附加链接"
              >
                <div className="sp-stack sp-stack--tight">
                  <label htmlFor="sp-editor-link-input" className="sp-popover-label">
                    正文链接地址
                  </label>
                  <input
                    ref={linkInputRef}
                    id="sp-editor-link-input"
                    type="url"
                    className="sp-input"
                    aria-label="链接地址"
                    placeholder="https://example.com"
                    value={linkUrlInput}
                    onChange={(e) => setLinkUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        applyLink();
                      }
                    }}
                  />
                  {linkError && <div className="sp-error-text">{linkError}</div>}
                  <div className="sp-row sp-row--end">
                    <button
                      type="button"
                      className="sp-btn sp-btn--sm sp-btn--quiet"
                      onClick={() => {
                        setLinkPanelOpen(false);
                        linkTriggerRef.current?.focus();
                      }}
                    >
                      取消
                    </button>
                    <button type="button" className="sp-btn sp-btn--sm" onClick={removeLink}>
                      移除
                    </button>
                    <button type="button" className="sp-btn sp-btn--sm sp-btn--primary" onClick={applyLink}>
                      应用
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <span className="sp-toolbar-divider" aria-hidden="true" />

          <div className="sp-popover-anchor" ref={aaWrapRef}>
            <button
              ref={aaTriggerRef}
              type="button"
              className="sp-tool-btn sp-tool-btn--aa"
              aria-label="文字格式"
              data-tooltip="文字格式"
              aria-haspopup="true"
              aria-expanded={aaOpen}
              aria-pressed={hasAaActive}
              disabled={disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onToolbarInteractRef.current?.();
                onCloseExternalMenus?.();
                setLinkPanelOpen(false);
                setMoreOpen(false);
                setAaOpen((v) => !v);
              }}
            >
              <span aria-hidden="true">Aa</span>
            </button>

            {aaOpen && (
              <div className="sp-aa-popover" role="group" aria-label="文字格式选项">
                <button
                  type="button"
                  className="sp-tool-btn"
                  aria-label="加粗"
                  data-tooltip="加粗"
                  data-tooltip-placement="top"
                  aria-pressed={editor?.isActive('bold') ?? false}
                  disabled={disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onToolbarInteractRef.current?.();
                    editor?.chain().focus().toggleBold().run();
                  }}
                >
                  <BoldIcon size={18} strokeWidth={2} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="sp-tool-btn"
                  aria-label="高亮"
                  data-tooltip="高亮"
                  data-tooltip-placement="top"
                  aria-pressed={editor?.isActive('highlight') ?? false}
                  disabled={disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onToolbarInteractRef.current?.();
                    editor?.chain().focus().toggleHighlight().run();
                  }}
                >
                  <Highlighter size={18} strokeWidth={2} aria-hidden="true" />
                </button>
                <span className="sp-toolbar-divider" aria-hidden="true" />
                <button
                  type="button"
                  className="sp-tool-btn"
                  aria-label="无序列表"
                  data-tooltip="无序列表"
                  data-tooltip-placement="top"
                  aria-pressed={editor?.isActive('bulletList') ?? false}
                  disabled={disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onToolbarInteractRef.current?.();
                    editor?.chain().focus().toggleBulletList().run();
                  }}
                >
                  <List size={18} strokeWidth={2} aria-hidden="true" />
                </button>

                <button
                  type="button"
                  className="sp-tool-btn"
                  aria-label="有序列表"
                  data-tooltip="有序列表"
                  data-tooltip-placement="top"
                  aria-pressed={editor?.isActive('orderedList') ?? false}
                  disabled={disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onToolbarInteractRef.current?.();
                    editor?.chain().focus().toggleOrderedList().run();
                  }}
                >
                  <ListOrdered size={18} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            )}
          </div>

          <span className="sp-toolbar-divider" aria-hidden="true" />

          <div
            className="sp-popover-anchor sp-popover-anchor--mobile-span"
            ref={moreWrapRef}
            onKeyDown={(e) => {
              if (moreOpen) handleMenuKeyDown(e);
            }}
          >
            <button
              ref={moreTriggerRef}
              type="button"
              className="sp-tool-btn"
              aria-label="更多"
              data-tooltip="更多"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              disabled={disabled}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onToolbarInteractRef.current?.();
                onCloseExternalMenus?.();
                setAaOpen(false);
                setLinkPanelOpen(false);
                setMoreOpen((v) => !v);
              }}
            >
              <MoreHorizontal size={18} strokeWidth={2} aria-hidden="true" />
            </button>

            {moreOpen && (
              <div
                className="sp-popover sp-popover--above"
                role="menu"
                aria-label="更多编辑选项"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="sp-menu-item"
                  disabled={disabled || !canUndo}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    editor?.chain().focus().undo().run();
                    setMoreOpen(false);
                  }}
                >
                  <Undo2 size={15} strokeWidth={2} aria-hidden="true" />
                  <span>撤销</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sp-menu-item"
                  disabled={disabled || !canRedo}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    editor?.chain().focus().redo().run();
                    setMoreOpen(false);
                  }}
                >
                  <Redo2 size={15} strokeWidth={2} aria-hidden="true" />
                  <span>重做</span>
                </button>
                {extraMoreItems && (
                  <>
                    <div className="sp-menu-divider" role="separator" />
                    {extraMoreItems(() => setMoreOpen(false))}
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {trailingSlot}
      </div>
    </div>
  );
}
