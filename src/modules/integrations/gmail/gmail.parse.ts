import type { gmail_v1 } from '@googleapis/gmail';

/**
 * Pure helpers for turning Gmail API payloads into our shapes.
 * The worker repo has a copy (worker/src/gmail/gmail.parse.ts) — change both together.
 */

export interface EmailAddress {
  name?: string;
  email: string;
}

type Header = gmail_v1.Schema$MessagePartHeader;

export function getHeader(headers: Header[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((header) => header.name?.toLowerCase() === lower)?.value ?? undefined;
}

/** Splits an address header on commas that aren't inside quotes or angle brackets. */
function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;
  for (const char of value) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === '<' && !inQuotes) inAngle = true;
    else if (char === '>' && !inQuotes) inAngle = false;
    if (char === ',' && !inQuotes && !inAngle) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Parses `"Rahul Sharma" <rahul@example.com>`, `rahul@example.com` or `<rahul@example.com>`. */
export function parseAddress(value: string): EmailAddress | null {
  const trimmed = value.trim();
  const angle = /^(.*)<([^<>]+)>\s*$/.exec(trimmed);
  if (angle) {
    const email = angle[2]?.trim().toLowerCase() ?? '';
    const name = angle[1]
      ?.trim()
      .replace(/^"(.*)"$/, '$1')
      .replace(/\\"/g, '"')
      .trim();
    return email.includes('@') ? { email, ...(name ? { name } : {}) } : null;
  }
  return trimmed.includes('@') ? { email: trimmed.toLowerCase() } : null;
}

export function parseAddressList(value: string | undefined): EmailAddress[] {
  if (!value) return [];
  return splitAddressList(value)
    .map(parseAddress)
    .filter((address): address is EmailAddress => address !== null);
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Good-enough HTML → text for reading an email; not a sanitizer. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (entity: string, code: string) => {
      if (code.startsWith('#x')) return String.fromCodePoint(parseInt(code.slice(2), 16));
      if (code.startsWith('#')) return String.fromCodePoint(parseInt(code.slice(1), 10));
      return HTML_ENTITIES[code.toLowerCase()] ?? entity;
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function findPart(
  part: gmail_v1.Schema$MessagePart | undefined,
  mimeType: string,
): gmail_v1.Schema$MessagePart | undefined {
  if (!part) return undefined;
  // Attachments that happen to be text/plain aren't the body.
  if (part.mimeType === mimeType && part.body?.data && !part.filename) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

const MAX_BODY_LENGTH = 50_000;

/** The readable body of a message: text/plain if present, otherwise text/html converted to text. */
export function extractBody(payload: gmail_v1.Schema$MessagePart | undefined): string {
  const plain = findPart(payload, 'text/plain');
  let body = '';
  if (plain?.body?.data) {
    body = decodeBase64Url(plain.body.data);
  } else {
    const html = findPart(payload, 'text/html');
    if (html?.body?.data) body = htmlToText(decodeBase64Url(html.body.data));
  }
  return body.length > MAX_BODY_LENGTH ? `${body.slice(0, MAX_BODY_LENGTH)}\n…` : body;
}

export function listAttachments(
  payload: gmail_v1.Schema$MessagePart | undefined,
): { filename: string; mimeType: string; size: number }[] {
  const attachments: { filename: string; mimeType: string; size: number }[] = [];
  const walk = (part: gmail_v1.Schema$MessagePart | undefined) => {
    if (!part) return;
    if (part.filename) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body?.size ?? 0,
      });
    }
    part.parts?.forEach(walk);
  };
  walk(payload);
  return attachments;
}

/** Converts a Gmail message (format=metadata or full) into the fields we store. */
export function toEmailFields(message: gmail_v1.Schema$Message) {
  const headers = message.payload?.headers ?? undefined;
  const labelIds = message.labelIds ?? [];
  return {
    gmailId: message.id ?? '',
    threadId: message.threadId ?? '',
    from: parseAddressList(getHeader(headers, 'From'))[0],
    to: parseAddressList(getHeader(headers, 'To')),
    cc: parseAddressList(getHeader(headers, 'Cc')),
    subject: getHeader(headers, 'Subject') ?? '',
    snippet: message.snippet ?? '',
    receivedAt: new Date(Number(message.internalDate ?? Date.now())),
    labelIds,
    isUnread: labelIds.includes('UNREAD'),
    isImportant: labelIds.includes('IMPORTANT'),
    isInbox: labelIds.includes('INBOX'),
    isSent: labelIds.includes('SENT'),
  };
}
