/**
 * Issue #375 — lazy locale bundles: verifies that the static export ships
 * each non-English locale as an independent, lazily-loaded chunk.
 *
 * Asserts:
 *  - packaged English messages are present in the eager bundle (the
 *    cold-boot fallback),
 *  - es/pt/fa markers each appear in exactly one code-split chunk (their own
 *    bundle — not inlined into the main module graph),
 *  - no page (`index.html`) eagerly references the es/pt/fa chunks (they are
 *    fetched only when the locale activates), and
 *  - the locale chunks contain no external network references (offline
 *    invariant: chunks are packaged local assets served by the embedded
 *    localhost server).
 *
 * Requires `npm run build:frontend` output (`frontend/out`). Skips with
 * exit 0 when the build output is absent (e.g. `npm test` on a fresh
 * checkout without a preceding frontend build).
 */
import * as fs from 'fs';
import * as path from 'path';

const OUT = path.join(__dirname, '..', 'frontend', 'out');

// Distinctive leaf values from frontend/src/lib/i18n/messages (pos.cartEmpty).
const MARKERS: Record<string, string> = {
  en: 'Cart is empty',
  es: 'El carrito está vacío',
  pt: 'O carrinho está vazio',
  fa: 'سبد خالی است',
};

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function walkFiles(dir: string, predicate: (name: string) => boolean): string[] {
  const found: string[] = [];
  const visit = (d: string): void => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (predicate(entry.name)) found.push(full);
    }
  };
  visit(dir);
  return found;
}

function run(): void {
  const chunksDir = path.join(OUT, '_next', 'static', 'chunks');
  if (!fs.existsSync(chunksDir)) {
    console.log('SKIP: frontend/out missing — run `npm run build:frontend` first (no locale chunk assertions).');
    return;
  }

  const chunks = walkFiles(chunksDir, (name) => name.endsWith('.js'));
  assert(chunks.length > 0, 'no chunks found in frontend/out/_next/static/chunks');

  const filesWith = (marker: string): string[] =>
    chunks.filter((f) => fs.readFileSync(f, 'utf8').includes(marker));

  const enFiles = filesWith(MARKERS.en);
  assert(
    enFiles.length >= 1,
    `packaged English messages must ship eagerly (cold-boot fallback), found in ${enFiles.length} chunks`,
  );

  const lazyByLang: Record<string, string> = {};
  for (const lang of ['es', 'pt', 'fa'] as const) {
    const files = filesWith(MARKERS[lang]);
    assert(
      files.length === 1,
      `${lang} messages must live in exactly one code-split chunk, found in ${files.length}`,
    );
    lazyByLang[lang] = path.basename(files[0]);
  }
  const lazyNames = new Set(Object.values(lazyByLang));
  assert(lazyNames.size === 3, 'es/pt/fa must each have their own distinct chunk');

  // 1. No page eagerly references the lazy locale chunks.
  const pages = walkFiles(OUT, (name) => name === 'index.html');
  assert(pages.length > 0, 'no index.html pages found in frontend/out');
  const eagerRefs: Array<{ page: string; chunk: string }> = [];
  for (const page of pages) {
    const html = fs.readFileSync(page, 'utf8');
    for (const m of html.matchAll(/src="([^"]+)"/g)) {
      const script = m[1].split('/').pop() ?? '';
      if (lazyNames.has(script)) eagerRefs.push({ page, chunk: script });
    }
  }
  assert(
    eagerRefs.length === 0,
    `lazy locale chunks must not be eagerly loaded by any page: ${JSON.stringify(eagerRefs.slice(0, 5))}`,
  );

  // 2. Offline invariant: locale chunks are pure packaged assets.
  for (const lang of ['es', 'pt', 'fa'] as const) {
    const file = chunks.find((f) => path.basename(f) === lazyByLang[lang]);
    const content = fs.readFileSync(file as string, 'utf8');
    assert(
      !/https?:\/\//.test(content),
      `${lang} locale chunk must contain no external network references`,
    );
  }

  const kb = (f: string): string => (fs.statSync(f).size / 1024).toFixed(0);
  console.log('Locale chunk splitting (#375):');
  console.log(`  ✓ packaged English eager (fallback) — ${enFiles.length} chunk(s)`);
  for (const lang of ['es', 'pt', 'fa'] as const) {
    const file = chunks.find((f) => path.basename(f) === lazyByLang[lang]) as string;
    console.log(`  ✓ ${lang} lazy chunk (${lazyByLang[lang]}) — ${kb(file)} KB, not eager on any page, no external refs`);
  }
  console.log('✅ All locale chunk splitting checks passed.');
}

run();
