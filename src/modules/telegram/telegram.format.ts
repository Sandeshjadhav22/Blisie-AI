import { escapeHtml } from '../../utils/html.js';

/** Stands in for inline code while other rules run. Can't occur in escaped text (no `@` rules). */
const CODE_TOKEN = (index: number) => `@@CODE${String(index)}@@`;

/**
 * Converts the agent's light Markdown into Telegram's HTML parse mode. Everything is escaped
 * first, so only the tags produced here can appear — model output can never inject markup.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const codeSpans: string[] = [];
  let text = escapeHtml(markdown)
    // Protect inline code from the other rules.
    .replace(/`([^`\n]+)`/g, (_match, code: string) => {
      codeSpans.push(`<code>${code}</code>`);
      return CODE_TOKEN(codeSpans.length - 1);
    })
    // Bullets first, so a leading "* " isn't mistaken for italics.
    .replace(/^\s*[-*]\s+/gm, '• ')
    // Headings aren't supported; show them as bold lines.
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<i>$2</i>');

  // Links: only http(s) URLs become anchors.
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label: string, url: string) => `<a href="${url}">${label}</a>`,
  );

  return text.replace(/@@CODE(\d+)@@/g, (_match, index: string) => codeSpans[Number(index)] ?? '');
}
