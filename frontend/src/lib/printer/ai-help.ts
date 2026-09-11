/** Copy-diagnostic-and-hand-off-to-AI helper for the printer support-error panel. */

export interface AiProvider {
  id: 'chatgpt' | 'gemini' | 'claude';
  label: string;
  url: string;
}

export const AI_HELP_PROVIDERS: readonly AiProvider[] = [
  { id: 'chatgpt', label: 'ChatGPT', url: 'https://chatgpt.com/' },
  { id: 'gemini', label: 'Gemini', url: 'https://gemini.google.com/app' },
  { id: 'claude', label: 'Claude', url: 'https://claude.ai/new' },
];

const TROUBLESHOOTING_URL = 'https://flopos.com/documentation/troubleshooting';
const SUPPORT_EMAIL = 'support@flopos.com';
const SUPPORT_WHATSAPP_URL = 'https://chat.whatsapp.com/LxHobzv6d2X81NzrVfMjzo?mode=gi_t';

async function resolveAppContext(): Promise<string> {
  try {
    const info = await window.electronAPI?.getAppInfo?.();
    if (info && 'version' in info) return `FloCafe ${info.version} on ${info.platform}`;
  } catch { /* best-effort only */ }
  return 'FloCafe (desktop app)';
}

/** Builds the prompt copied to the clipboard for AI hand-off on a printer failure. */
export async function buildPrinterDiagnosticPrompt(message: string, technicalDetail?: string): Promise<string> {
  const context = await resolveAppContext();
  const lines = [
    `I'm using ${context}, an open-source restaurant point-of-sale app, and a printer job just failed:`,
    '',
    `"${message}"`,
  ];
  if (technicalDetail && technicalDetail !== message) {
    lines.push('', `Technical detail: ${technicalDetail}`);
  }
  lines.push(
    '',
    `FloCafe's printer troubleshooting guide: ${TROUBLESHOOTING_URL}`,
    '',
    `Please help me diagnose and fix it. If it turns out to need FloCafe support directly, tell me to email ${SUPPORT_EMAIL} or ask in the FloCafe WhatsApp community: ${SUPPORT_WHATSAPP_URL}.`,
  );
  return lines.join('\n');
}

/** Copies the diagnostic prompt to the clipboard. Returns whether it succeeded. */
export async function copyPrinterDiagnostic(message: string, technicalDetail?: string): Promise<boolean> {
  try {
    const prompt = await buildPrinterDiagnosticPrompt(message, technicalDetail);
    await navigator.clipboard.writeText(prompt);
    return true;
  } catch {
    return false;
  }
}
