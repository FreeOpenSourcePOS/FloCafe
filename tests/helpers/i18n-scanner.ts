import * as fs from 'node:fs';
import * as path from 'node:path';

/** Walk frontend TypeScript source without depending on shell tools. */
export function walkTypeScriptFiles(dir: string): string[] {
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'out') continue;
        visit(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(full);
      }
    }
  };
  visit(dir);
  return files;
}

/**
 * Collect every translation key called in the given TypeScript source directory.
 * Resolves both:
 * 1. Scoped `useTranslations('namespace')` bindings (e.g. `const t = useTranslations('pos'); t('title')` -> `pos.title`,
 *    `const tCommon = useTranslations('common'); tCommon('save')` -> `common.save`)
 * 2. Unscoped / global translation calls (e.g. `const t = useTranslations(); t('pos.title')` -> `pos.title`,
 *    inline `useTranslations('pos')('title')` -> `pos.title`, or standalone `t('foo.bar')`)
 */
const DEFAULT_FRONTEND_SRC = path.resolve(__dirname, '../../frontend/src');

export function collectCalledKeys(dir: string = DEFAULT_FRONTEND_SRC): Set<string> {
  const out = new Set<string>();
  const scopedRegex = /(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*useTranslations\(\s*(?:['"`]([^'"`]+)['"`])?\s*\)/g;
  const inlineRegex = /useTranslations\(\s*(?:['"`]([^'"`]+)['"`])?\s*\)\s*\(\s*(['"`])([^'"`]+)\2/g;
  const dottedRegex = /\bt\(\s*(['"`])([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\1/g;

  for (const file of walkTypeScriptFiles(dir)) {
    const source = fs.readFileSync(file, 'utf8');

    // 1. Find scoped translator bindings: const t = useTranslations('namespace')
    const scopes = new Map<string, string>();
    let sm: RegExpExecArray | null;
    while ((sm = scopedRegex.exec(source)) !== null) {
      scopes.set(sm[1], sm[2] || '');
    }

    // 2. Find inline useTranslations('namespace')('key')
    let im: RegExpExecArray | null;
    while ((im = inlineRegex.exec(source)) !== null) {
      const ns = im[1] || '';
      const key = im[3];
      out.add(ns ? `${ns}.${key}` : key);
    }

    // 3. For each bound translator, collect its literal call arguments
    for (const [varName, ns] of scopes.entries()) {
      const callRegex = new RegExp(`\\b${varName}\\(\\s*(['"\`])([a-zA-Z0-9_]+(?:\\.[a-zA-Z0-9_]+)*)\\1`, 'g');
      let cm: RegExpExecArray | null;
      while ((cm = callRegex.exec(source)) !== null) {
        const key = cm[2];
        out.add(ns ? `${ns}.${key}` : key);
      }
    }

    // 4. Catch any standalone t('dotted.key') calls not tied to useTranslations
    let dm: RegExpExecArray | null;
    while ((dm = dottedRegex.exec(source)) !== null) {
      out.add(dm[2]);
    }
  }
  return out;
}
