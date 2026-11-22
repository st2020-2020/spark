import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { bridge, message, type State } from './bridge';
import { Notice, Login } from './shared';
import { Panel } from './Panel';
import { Book } from './Book';
import '../../../web/src/styles/tokens.css';
import './desktop.css';

const book = new URLSearchParams(location.search).get('mode') === 'main';
function App() {
  const [state, set] = useState<State>(),
    [error, bad] = useState(''),
    [rev, update] = useState(0);
  const refresh = () => update((v) => v + 1);
  useEffect(() => {
    const c = new AbortController();
    bridge()<State>('state', 'GET', undefined, c.signal)
      .then((v) => {
        set(v);
        bad('');
      })
      .catch((e) => {
        if (!c.signal.aborted) bad(message(e));
      });
    return () => c.abort();
  }, [rev]);
  useEffect(() => {
    window.addEventListener('spark-state', refresh);
    window.addEventListener('spark-show', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('spark-state', refresh);
      window.removeEventListener('spark-show', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);
  useEffect(() => {
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    function paint() {
      const root = document.documentElement;
      root.dataset.palette = state?.palette || 'mint';
      root.dataset.mode =
        state?.mode === 'system' || !state?.mode
          ? scheme.matches
            ? 'dark'
            : 'light'
          : state.mode;
    }
    paint();
    scheme.addEventListener('change', paint);
    return () => scheme.removeEventListener('change', paint);
  }, [state?.palette, state?.mode]);
  const req = useMemo(
    () => bridge(state?.session.account_id),
    [state?.session.account_id],
  );
  if (!state)
    return (
      <div className="pair" role="status">
        {error ? (
          <>
            <Notice text={error} />
            <button onClick={refresh}>重试</button>
          </>
        ) : (
          '正在打开手帐…'
        )}
      </div>
    );
  if (!state.session.account_id)
    return (
      <section
        className={book ? 'pair-page' : 'panel'}
        onKeyDown={(e) => {
          if (!book && e.key === 'Escape') void req('window/hide', 'POST');
        }}
      >
        <Login
          state={state}
          panel={!book}
          onSuccess={() => {
            refresh();
            if (book) void req('window/panel', 'POST');
          }}
        />
      </section>
    );
  return book ? (
    <Book
      key={state.session.account_id}
      state={state}
      req={req}
      refresh={refresh}
    />
  ) : (
    <Panel key={state.session.account_id} state={state} req={req} />
  );
}
createRoot(document.getElementById('root')!).render(<App />);
