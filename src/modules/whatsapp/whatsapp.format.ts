/** Stands in for bold spans while the italic rules run. */
const BOLD_TOKEN = (index: number) => `\u0000B${String(index)}\u0000`;

/**
 * Converts our light Markdown to WhatsApp's formatting: `**bold**` → `*bold*`, `_italic_` and
 * `*italic*` → `_italic_`, bullets → "•", headings → bold lines, and `[label](url)` → "label (url)"
 * (WhatsApp links plain URLs itself). WhatsApp has no HTML, so nothing needs escaping.
 * The worker keeps a copy in worker/src/channels/format.ts — change both together.
 */
export function markdownToWhatsApp(markdown: string): string {
  const bold: string[] = [];
  const keepBold = (_match: string, inner: string) => {
    bold.push(`*${inner}*`);
    return BOLD_TOKEN(bold.length - 1);
  };
  return (
    markdown
      .replace(/^\s*[-*]\s+/gm, '• ')
      .replace(/^#{1,6}\s+(.+)$/gm, keepBold)
      .replace(/\*\*([^*\n]+)\*\*/g, keepBold)
      .replace(/__([^_\n]+)__/g, keepBold)
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1_$2_')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)')
      // eslint-disable-next-line no-control-regex
      .replace(/\u0000B(\d+)\u0000/g, (_match, index: string) => bold[Number(index)] ?? '')
  );
}
