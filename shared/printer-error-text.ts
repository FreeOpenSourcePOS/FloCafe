/**
 * Printer error text seen by nobody outside the store: CUPS queue names, IPP hosts, IP addresses,
 * spool paths, and the staff home folder. Everything a fix needs stays; identifiers do not.
 */

const EMAIL = /[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+/g;
// Before the path rules, a URI carries a host, a port, and its queue.
const URI = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b(?::\d{1,5})?/g;
const IPV6 = /\[[0-9a-f:]+\]|\b(?:[0-9a-f]{1,4}:){2,}[0-9a-f:]{1,}/gi;
// `lp: Host till.office.lan is not available`
// The last label starts with a letter, so a version such as v1.2.3 stays.
const HOSTNAME =
  /\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*\.?(?::\d{1,5})?\b/gi;
// Node names the host as typed, also a single label: `getaddrinfo ENOTFOUND till-pc`.
const AFTER_NET_CODE =
  /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)\s+([^\s"',;]+)/g;
const WINDOWS_PATH = /(?:[A-Za-z]:\\|\\\\)[^\s"'<>;:]*/g;
// A quoted path can hold spaces (`C:\Users\Ada Smith\...`), so it goes whole.
const QUOTED_PATH = /(["'“])(?:[A-Za-z]:\\|\\\\|~?\/)[^"'”]*["'”]/g;
// The rest of an unquoted path after a space: ` Smith\AppData\...`.
const PATH_TAIL = /<path>(?:\s+[^\s\\<>"']*\\[^\s"'<>;:]*)+/g;
const POSIX_PATH = /(?:~|\/[A-Za-z._~][\w.+@~-]*)(?:[\w.+@~/-]*)/g;
const QUOTED = /"[^"]*"|'[^']*'|“[^”]*”/g;
// Quotes that are not names: a number, an API name (WritePrinter), or a full sentence.
const SAFE_QUOTE = /^(?:\d+|[A-Z][a-z]+(?:[A-Z][a-z]+)+|(?:\S+\s+){2,}\S+[.!?])$/;
const AFTER_QUEUE_WORD = /\b(printer|queue|class|destination|dest|-d)\s+([^\s"',;]+)/gi;
// A CUPS queue id keeps an underscore or a hyphen and a capital: EPSON_TM-T20III_Series.
const QUEUE_ID = /\b(?=[\w-]*[A-Z])(?=[\w-]*[_-])[\w-]{3,80}\b/g;

const MAX_TEXT = 300;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The printer error text as it may leave the machine: one line, no queue, host, IP, path, or user. */
export function scrubPrinterErrorText(text: unknown, printerName?: string): string {
  if (typeof text !== 'string') return '';
  let value = (text.split('\n', 1)[0] ?? '').trim();
  if (printerName && printerName.trim()) {
    value = value.replace(new RegExp(escapeRegExp(printerName.trim()), 'gi'), '<queue>');
  }
  value = value
    .replace(QUOTED_PATH, '<path>')
    .replace(EMAIL, '<email>')
    .replace(URI, '<url>')
    .replace(IPV4, '<ip>')
    .replace(IPV6, '<ip>')
    .replace(WINDOWS_PATH, '<path>')
    .replace(PATH_TAIL, '<path>')
    .replace(POSIX_PATH, '<path>')
    .replace(HOSTNAME, '<host>')
    .replace(AFTER_NET_CODE, (match, code: string, token: string) =>
      token.startsWith('<') ? match : `${code} <host>`,
    )
    // Any other quote can be a queue name, whatever its length.
    .replace(QUOTED, (match) => {
      const inner = match.slice(1, -1);
      return !inner.includes('<') && !SAFE_QUOTE.test(inner) ? '<queue>' : match;
    })
    // Only a queue-shaped token after the word: "the printer in FloCafe" keeps its words.
    .replace(AFTER_QUEUE_WORD, (match, word: string, token: string) =>
      /[A-Z0-9_-]/.test(token) ? `${word} <queue>` : match,
    )
    .replace(QUEUE_ID, '<queue>');
  value = value.trim();
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value;
}
