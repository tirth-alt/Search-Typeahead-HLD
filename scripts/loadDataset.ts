// Dataset ingestion -> Postgres. Derives counts by aggregation (COUNT per
// normalized query). Run via `npm run load -- <args>`:
//
//   npm run load -- --synthetic 120000                         # no download
//   npm run load -- --dir files/aol_data --min-count 2 --out files/aol_agg.tsv
//   npm run load -- --agg-file files/aol_agg.tsv --top 1000000 --min-count 3
//
// For the full ~35M-row AOL aggregation, give Node more heap:
//   node --max-old-space-size=4096 ... (run tsx through node if needed)
import fs from 'node:fs';
import zlib from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';
import * as store from '../lib/store';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (name: string): boolean => process.argv.includes(name);

function openStream(p: string): NodeJS.ReadableStream {
  const s = fs.createReadStream(p);
  return p.endsWith('.gz') ? s.pipe(zlib.createGunzip()) : s;
}

async function aggregateInto(file: string, counter: Map<string, number>): Promise<void> {
  const rl = readline.createInterface({ input: openStream(file), crlfDelay: Infinity });
  let header: string[] | null = null;
  let qi = 1;
  let delim = '\t';
  let n = 0;
  for await (const line of rl) {
    if (header === null) {
      delim = line.split('\t').length - 1 >= line.split(',').length - 1 ? '\t' : ',';
      const cols = line.split(delim).map((c) => c.trim().toLowerCase());
      qi = cols.indexOf('query');
      if (qi < 0) qi = cols.length > 1 ? 1 : 0;
      header = cols;
      continue;
    }
    const parts = line.split(delim);
    if (parts.length <= qi) continue;
    const q = parts[qi].trim().toLowerCase();
    if (!q || q === '-') continue;
    counter.set(q, (counter.get(q) || 0) + 1);
    n++;
  }
  console.log(`  ${path.basename(file)}: ${n.toLocaleString()} query rows (delim=${JSON.stringify(delim)}, col=${qi})`);
}

async function aggregatePaths(paths: string[], minCount: number): Promise<Array<[string, number]>> {
  const counter = new Map<string, number>();
  for (const p of paths) await aggregateInto(p, counter);
  const rows: Array<[string, number]> = [];
  for (const [q, c] of counter) if (c >= minCount) rows.push([q, c]);
  return rows;
}

function writeTsv(rows: Array<[string, number]>, file: string): Promise<void> {
  const out = fs.createWriteStream(file);
  for (const [q, c] of rows) out.write(`${q}\t${c}\n`);
  out.end();
  return new Promise((resolve) => out.on('finish', () => resolve()));
}

async function readAgg(file: string, top: number | null, minCount: number): Promise<Array<[string, number]>> {
  const rows: Array<[string, number]> = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const i = line.lastIndexOf('\t');
    if (i < 0) continue;
    const q = line.slice(0, i);
    const c = parseInt(line.slice(i + 1), 10);
    if (q && c >= minCount) rows.push([q, c]);
  }
  if (top) {
    rows.sort((a, b) => b[1] - a[1]);
    return rows.slice(0, top);
  }
  return rows;
}

// Zipf-distributed synthetic queries — no download required, good for demos.
function synthetic(n: number): Array<[string, number]> {
  const heads = ['how to', 'best', 'buy', 'cheap', 'free', 'download', 'what is', 'iphone', 'samsung',
    'java', 'python', 'amazon', 'google', 'weather', 'news', 'movie', 'song', 'recipe', 'near me', 'online', 'review'];
  const tails = ['tutorial', 'price', '2026', 'review', 'online', 'near me', 'for sale', 'guide', 'vs', 'app',
    'login', 'meaning', 'today', 'free', 'pro max', 'case', 'charger', 'stock', 'results', 'live', 'download', 'lyrics'];
  const mids = ['', 'best ', 'new ', 'cheap ', 'top ', 'the '];
  const out = new Map<string, number>();
  let rank = 1;
  let i = 0;
  while (out.size < n) {
    const h = heads[i % heads.length];
    const m = mids[Math.floor(i / heads.length) % mids.length];
    const t = tails[Math.floor(i / (heads.length * mids.length)) % tails.length];
    const suffix = i >= 5000 ? ` ${Math.floor(i / 5000)}` : '';
    const q = `${h} ${m}${t}${suffix}`.trim();
    if (!out.has(q)) {
      out.set(q, Math.max(1, Math.floor(10_000_000 / Math.pow(rank, 1.1))));
      rank++;
    }
    i++;
  }
  return [...out.entries()];
}

async function main(): Promise<void> {
  const file = arg('--file');
  const dir = arg('--dir');
  const synth = arg('--synthetic');
  const aggFile = arg('--agg-file');
  const out = arg('--out');
  const top = arg('--top') ? parseInt(arg('--top')!, 10) : null;
  const minCount = arg('--min-count') ? parseInt(arg('--min-count')!, 10) : 1;

  if (!file && !dir && !synth && !aggFile) {
    console.error('provide --file, --dir, --agg-file, or --synthetic');
    process.exit(1);
  }

  console.log('aggregating...');
  let rows: Array<[string, number]>;
  if (synth) {
    rows = synthetic(parseInt(synth, 10));
  } else if (aggFile) {
    rows = await readAgg(aggFile, top, minCount);
  } else {
    let paths: string[];
    if (dir) {
      paths = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.txt.gz') || f.endsWith('.txt'))
        .sort()
        .map((f) => path.join(dir, f));
    } else {
      paths = [file!];
    }
    rows = await aggregatePaths(paths, minCount);
    if (top) {
      rows.sort((a, b) => b[1] - a[1]);
      rows = rows.slice(0, top);
    }
  }
  console.log(`${rows.length.toLocaleString()} distinct queries to load`);

  if (out) {
    await writeTsv(rows, out);
    console.log(`wrote ${rows.length.toLocaleString()} rows to ${out}`);
    return;
  }

  store.initPool();
  try {
    await store.initSchema();
    if (!has('--no-truncate')) await store.truncate();
    await store.bulkLoad(rows);
    console.log(`done. rows in DB: ${(await store.countRows()).toLocaleString()}`);
  } finally {
    await store.closePool();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
