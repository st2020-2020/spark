import { useEffect, useId, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../context/ApiContext';
import { useAuth } from '../context/AuthContext';
import { getFriendlyErrorMessage } from '../api/errors';
import { generateIdempotencyKey } from '../lib/idempotency';

export type MentionChoice = { kind: '#' | '@'; id: string; name: string };

function triggerAtCaret(editor: Editor) {
  const { $from, empty } = editor.state.selection;
  if (!empty || !editor.isEditable || !editor.isFocused || editor.view.composing) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n');
  const match = /(?:^|[\s，。！？、（(]|\p{Script=Han})([#@])([\p{L}\p{M}\p{N}_-]{0,96})$/u.exec(before);
  if (!match) return null;
  return { kind: match[1] as '#' | '@', q: match[2], from: $from.pos - match[2].length - 1, to: $from.pos };
}

export function MentionPicker({ editor, onChoose, onBusy }: {
  editor: Editor; onChoose: (choice: MentionChoice) => void; onBusy: (busy: boolean) => void;
}) {
  const api = useApi();
  const { user } = useAuth();
  const client = useQueryClient();
  const listId = useId();
  const [trigger, setTrigger] = useState<ReturnType<typeof triggerAtCaret>>(null);
  const [index, setIndex] = useState(0);
  const [error, setError] = useState('');
  const composing = useRef(false);
  const selectionGeneration = useRef(0);
  const pending = useRef(false);
  const alive = useRef(false);
  const dismissed = useRef('');
  const retry = useRef({ name: '', key: '' });
  const dom = editor.view.dom;
  useEffect(() => {
    alive.current = true;
    let frame = 0;
    function sync() {
      const next = composing.current ? null : triggerAtCaret(editor);
      const signature = JSON.stringify(next);
      if (signature === dismissed.current) return;
      dismissed.current = '';
      setTrigger(old => JSON.stringify(old) === signature ? old : next);
    }
    function start() { selectionGeneration.current++; composing.current = true; setTrigger(null); }
    function end() { composing.current = false; cancelAnimationFrame(frame); frame = requestAnimationFrame(sync); }
    function blur() { selectionGeneration.current++; setTrigger(null); }
    dom.addEventListener('compositionstart', start);
    dom.addEventListener('compositionend', end);
    editor.on('transaction', sync).on('focus', sync).on('blur', blur);
    return () => {
      alive.current = false;
      cancelAnimationFrame(frame);
      dom.removeEventListener('compositionstart', start);
      dom.removeEventListener('compositionend', end);
      editor.off('transaction', sync).off('focus', sync).off('blur', blur);
    };
  }, [editor, dom]);

  useEffect(() => { setIndex(0); setError(''); }, [trigger]);
  const options = useQuery({
    queryKey: [trigger?.kind === '@' ? 'projects' : 'tags', 'mention', user?.id, trigger?.q],
    enabled: !!trigger,
    queryFn: async () => {
      const q = trigger?.q;
      const result = trigger?.kind === '@'
        ? await api.listProjects({ state: 'active', q, limit: 12 })
        : await api.listTags({ q, limit: 12 });
      return result.items.map(({ id, name }) => ({ id, name }));
    },
  });
  const choices = [...(options.data ?? [])];
  const newName = trigger?.q.trim().normalize('NFC') ?? '';
  if (options.isSuccess && trigger?.kind === '#' && newName && [...newName].length <= 24 &&
      !choices.some(c => c.name.toLocaleLowerCase() === newName.toLocaleLowerCase())) {
    choices.push({ id: '', name: newName });
  }
  async function choose(i: number) {
    const choice = choices[i];
    if (!trigger || !choice || pending.current) return;
    const generation = selectionGeneration.current;
    try {
      let item = choice;
      if (!item.id) {
        pending.current = true;
        onBusy(true);
        if (retry.current.name !== newName) retry.current = { name: newName, key: generateIdempotencyKey() };
        item = await api.createTag({ name: newName }, retry.current.key);
        retry.current = { name: '', key: '' };
        void client.invalidateQueries({ queryKey: ['tags'] });
      }
      if (!alive.current || generation !== selectionGeneration.current || editor.isDestroyed || JSON.stringify(triggerAtCaret(editor)) !== JSON.stringify(trigger)) return;
      editor.chain().deleteRange({ from: trigger.from, to: trigger.to }).focus().run();
      onChoose({ kind: trigger.kind, id: item.id, name: item.name });
      setTrigger(null);
    } catch (err) {
      if (alive.current && generation === selectionGeneration.current) { setError(getFriendlyErrorMessage(err)); void options.refetch(); }
    } finally {
      pending.current = false;
      if (alive.current) onBusy(false);
    }
  }
  useEffect(() => {
    if (!trigger) return;
    function key(event: KeyboardEvent) {
      if (event.isComposing || composing.current || event.keyCode === 229 || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!['ArrowDown','ArrowUp','Enter','Escape'].includes(event.key)) return;
      if (event.key === 'Enter' && !choices.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { selectionGeneration.current++; dismissed.current = JSON.stringify(trigger); setTrigger(null); }
      else if (event.key === 'Enter') void choose(index);
      else if (choices.length) setIndex((index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length);
    }
    dom.addEventListener('keydown', key, true);
    dom.setAttribute('aria-controls', listId);
    if (choices[index]) dom.setAttribute('aria-activedescendant', listId + '-' + index);
    return () => {
      dom.removeEventListener('keydown', key, true);
      dom.removeAttribute('aria-controls');
      dom.removeAttribute('aria-activedescendant');
    };
  });
  if (!trigger) return null;
  return <div className="sp-mention" onMouseDown={e => e.preventDefault()}>
    <div id={listId} role="listbox" aria-label={trigger.kind === '#' ? '标签联想' : '项目联想'}>
      {choices.map((c, i) => <button key={c.id || 'create'} type="button" role="option"
        id={listId + '-' + i} aria-selected={index === i} tabIndex={-1}
        onClick={() => void choose(i)}>{c.id ? trigger.kind + c.name : `新建标签「${c.name}」`}</button>)}
    </div>
    {options.isPending && <p role="status">正在查找…</p>}
    {!options.isPending && !options.isError && !choices.length && <p role="status">{trigger.kind === '#' ? '请输入 1–24 字的标签名' : '没有匹配的进行中项目'}</p>}
    {(error || options.isError) && <p role="alert">{error || getFriendlyErrorMessage(options.error)} <button type="button" onClick={() => void options.refetch()}>重试</button></p>}
  </div>;
}
