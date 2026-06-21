'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

type Mode = 'count' | 'hybrid';

interface Suggestion {
  query: string;
  count: number;
}

interface SuggestResponse {
  source: 'cache' | 'trie' | 'empty';
  node?: string | null;
  suggestions?: Suggestion[];
}

interface TrendingItem {
  query: string;
  score: number;
}

interface Metrics {
  cache_hit_rate: number;
  trie_size: number;
  suggest_latency_ms: { p95: number };
  write_reduction_factor: number | null;
}

const fmt = (n: number) => n.toLocaleString();

export default function SearchConsole() {
  const [value, setValue] = useState('');
  const [mode, setMode] = useState<Mode>('hybrid');
  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const [route, setRoute] = useState<{ text: string; cls: string }>({ text: 'idle', cls: '' });
  const [status, setStatus] = useState('');
  const [statusErr, setStatusErr] = useState(false);
  const [ack, setAck] = useState<string | null>(null);
  const [trending, setTrending] = useState<TrendingItem[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);

  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // ---- suggestions ----
  const fetchSuggestions = useCallback(
    async (q: string, m: Mode) => {
      const prefix = q.trim();
      if (!prefix) {
        setOpen(false);
        setItems([]);
        setRoute({ text: 'idle', cls: '' });
        setStatus('');
        return;
      }
      setStatus('routing…');
      setStatusErr(false);
      try {
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(prefix)}&mode=${m}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: SuggestResponse = await res.json();
        const list = data.suggestions || [];
        setItems(list);
        setActive(-1);
        setOpen(list.length > 0);
        if (data.source === 'cache') {
          setRoute({ text: `cache HIT · ${data.node}`, cls: 'hit' });
        } else if (data.source === 'trie') {
          setRoute({ text: `MISS → trie · ${data.node || ''}`, cls: 'miss' });
        } else {
          setRoute({ text: 'idle', cls: '' });
        }
        setStatus(list.length ? '' : 'no matches');
      } catch (err) {
        setStatus(`error: ${(err as Error).message}`);
        setStatusErr(true);
        setOpen(false);
      }
    },
    [],
  );

  const onInput = (next: string) => {
    setValue(next);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => fetchSuggestions(next, mode), 150);
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    fetchSuggestions(value, m);
  };

  // ---- submit ----
  const submit = useCallback(async (q: string) => {
    const query = q.trim();
    if (!query) return;
    setValue(query);
    setOpen(false);
    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAck(`${data.message} · "${query}"`);
      setTimeout(loadTrending, 400);
    } catch (err) {
      setAck(`error submitting · ${(err as Error).message}`);
    }
  }, []);

  // ---- keyboard ----
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submit(active >= 0 ? items[active].query : value);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  // ---- trending ----
  const loadTrending = useCallback(async () => {
    try {
      const res = await fetch('/api/trending?n=10');
      const data = await res.json();
      setTrending(data.trending || []);
    } catch {
      /* leave previous list in place */
    }
  }, []);

  // ---- metrics ----
  const loadMetrics = useCallback(async () => {
    try {
      const res = await fetch('/api/metrics');
      setMetrics(await res.json());
    } catch {
      /* ignore transient errors */
    }
  }, []);

  useEffect(() => {
    loadTrending();
    loadMetrics();
    const t = setInterval(loadTrending, 5000);
    const m = setInterval(loadMetrics, 4000);
    return () => {
      clearInterval(t);
      clearInterval(m);
    };
  }, [loadTrending, loadMetrics]);

  // close dropdown on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);

  return (
    <>
      <section className="gauges">
        <div className="gauge">
          <div className="label">cache hit rate</div>
          <div className="value">
            {metrics ? Math.round(metrics.cache_hit_rate * 100) : '—'}
            <span>%</span>
          </div>
        </div>
        <div className="gauge">
          <div className="label">suggest p95</div>
          <div className="value">
            {metrics ? metrics.suggest_latency_ms.p95 : '—'}
            <span>ms</span>
          </div>
        </div>
        <div className="gauge">
          <div className="label">trie entries</div>
          <div className="value">{metrics ? fmt(metrics.trie_size) : '—'}</div>
        </div>
        <div className="gauge">
          <div className="label">write reduction</div>
          <div className="value">
            {metrics && metrics.write_reduction_factor ? metrics.write_reduction_factor : '—'}
            <span>×</span>
          </div>
        </div>
      </section>

      <section className="stage">
        <div className="searchcol">
          <div className="field-wrap" ref={boxRef}>
            <div className="field">
              <span className="prompt">&gt;_</span>
              <input
                id="q"
                ref={inputRef}
                type="text"
                value={value}
                placeholder="start typing a query…"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => onInput(e.target.value)}
                onKeyDown={onKeyDown}
                onFocus={() => items.length && setOpen(true)}
              />
              <button className="go" onClick={() => submit(value)}>
                search
              </button>
            </div>

            {open && (
              <div className="dropdown">
                {items.map((it, i) => (
                  <div
                    key={it.query}
                    className={`opt ${i === active ? 'active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      submit(it.query);
                    }}
                  >
                    <div className="body">
                      <span className="rank">{String(i + 1).padStart(2, '0')}</span>
                      <span className="q">{it.query}</span>
                    </div>
                    <span className="c">{fmt(it.count)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="controls">
            <div className="modes">
              <button className={mode === 'count' ? 'on' : ''} onClick={() => switchMode('count')}>
                all-time
              </button>
              <button className={mode === 'hybrid' ? 'on' : ''} onClick={() => switchMode('hybrid')}>
                hybrid · recency
              </button>
            </div>
            <span className={`route ${route.cls}`}>
              <span className="dot" />
              {route.text}
            </span>
          </div>

          <div className={`status ${statusErr ? 'err' : ''}`}>{status}</div>

          <div className={`ack ${ack ? 'show' : ''}`}>
            <span className="tag">ack</span> {ack}
          </div>
        </div>

        <aside className="panel">
          <div className="panel-head">
            <h2>Trending</h2>
            <span className="pulse" title="live" />
          </div>
          {trending.length ? (
            trending.map((t, i) => (
              <div className="trend" key={t.query}>
                <span className="n">{String(i + 1).padStart(2, '0')}</span>
                <span className="q">{t.query}</span>
                <span className="s">{t.score}</span>
              </div>
            ))
          ) : (
            <div className="trend empty">
              <span className="q">no activity yet — submit a search</span>
            </div>
          )}
        </aside>
      </section>
    </>
  );
}
