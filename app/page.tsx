import SearchConsole from '@/components/SearchConsole';

export default function Home() {
  return (
    <main className="shell">
      <header className="masthead">
        <div className="brand">
          <span className="kicker">prefix search engine</span>
          <h1 className="title">
            type<em>·</em>ahead
          </h1>
        </div>
        <div className="coords">
          <div>
            cache <b>3× redis</b> · consistent hashing
          </div>
          <div>
            serving <b>trie top-k</b> · write-back batching
          </div>
        </div>
      </header>

      <SearchConsole />

      <footer className="colophon">
        <span>
          read path: cache → trie · write path: buffer → batch flush → postgres
        </span>
        <span>eventual consistency · PA/EL · ~82% cache hit rate</span>
      </footer>
    </main>
  );
}
