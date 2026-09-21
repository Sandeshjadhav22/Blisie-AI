import { describe, expect, it } from 'vitest';

import {
  extractBody,
  htmlToText,
  listAttachments,
  parseAddress,
  parseAddressList,
  toEmailFields,
} from '../src/modules/integrations/gmail/gmail.parse.js';
import { startOfDayInTimezone } from '../src/utils/time.js';

const b64 = (text: string) => Buffer.from(text).toString('base64url');

describe('parseAddress', () => {
  it.each([
    ['"Rahul Sharma" <Rahul@Example.com>', { name: 'Rahul Sharma', email: 'rahul@example.com' }],
    ['Amit <amit@example.com>', { name: 'Amit', email: 'amit@example.com' }],
    ['<noreply@example.com>', { email: 'noreply@example.com' }],
    ['plain@example.com', { email: 'plain@example.com' }],
  ])('parses %s', (input, expected) => {
    expect(parseAddress(input)).toEqual(expected);
  });

  it('returns null for junk', () => {
    expect(parseAddress('undisclosed-recipients:;')).toBeNull();
  });

  it('splits lists without breaking quoted commas', () => {
    expect(
      parseAddressList('"Sharma, Rahul" <rahul@example.com>, amit@example.com, <x@example.com>'),
    ).toEqual([
      { name: 'Sharma, Rahul', email: 'rahul@example.com' },
      { email: 'amit@example.com' },
      { email: 'x@example.com' },
    ]);
  });
});

describe('extractBody', () => {
  it('prefers text/plain in multipart/alternative', () => {
    expect(
      extractBody({
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: b64('Hi Sandesh,\nSee you at 3.') } },
          { mimeType: 'text/html', body: { data: b64('<p>Hi</p>') } },
        ],
      }),
    ).toBe('Hi Sandesh,\nSee you at 3.');
  });

  it('falls back to HTML converted to text, ignoring attachments', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'text/html',
          body: { data: b64('<style>p{}</style><p>Hello&nbsp;<b>there</b> &amp; bye</p><br>Next') },
        },
        {
          mimeType: 'text/plain',
          filename: 'notes.txt',
          body: { data: b64('attachment'), size: 10 },
        },
      ],
    };
    expect(extractBody(payload)).toBe('Hello there & bye\n\nNext');
    expect(listAttachments(payload)).toEqual([
      { filename: 'notes.txt', mimeType: 'text/plain', size: 10 },
    ]);
  });

  it('decodes numeric entities', () => {
    expect(htmlToText('It&#39;s &#x2014; done')).toBe("It's — done");
  });
});

describe('toEmailFields', () => {
  it('maps headers and labels', () => {
    const fields = toEmailFields({
      id: 'm1',
      threadId: 't1',
      internalDate: '1790000000000',
      labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'],
      snippet: 'Can you send the proposal?',
      payload: {
        headers: [
          { name: 'from', value: 'Rahul <rahul@example.com>' },
          { name: 'Subject', value: 'Proposal' },
        ],
      },
    });
    expect(fields).toMatchObject({
      gmailId: 'm1',
      from: { name: 'Rahul', email: 'rahul@example.com' },
      subject: 'Proposal',
      isUnread: true,
      isImportant: true,
      isInbox: true,
      isSent: false,
    });
    expect(fields.receivedAt.toISOString()).toBe('2026-09-21T14:13:20.000Z');
  });
});

describe('startOfDayInTimezone', () => {
  it('finds local midnight in India (UTC+5:30)', () => {
    // 01:00 on 22 Sep in India is still 21 Sep in UTC.
    expect(
      startOfDayInTimezone(new Date('2026-09-21T19:30:00Z'), 'Asia/Kolkata').toISOString(),
    ).toBe('2026-09-21T18:30:00.000Z');
  });

  it('handles DST days in New York', () => {
    // 8 Mar 2026: clocks jump forward at 2am; midnight is still UTC-5.
    expect(
      startOfDayInTimezone(new Date('2026-03-08T15:00:00Z'), 'America/New_York').toISOString(),
    ).toBe('2026-03-08T05:00:00.000Z');
    // 1 Nov 2026: clocks fall back at 2am; midnight is UTC-4.
    expect(
      startOfDayInTimezone(new Date('2026-11-01T20:00:00Z'), 'America/New_York').toISOString(),
    ).toBe('2026-11-01T04:00:00.000Z');
  });

  it('is identity at UTC midnight', () => {
    expect(startOfDayInTimezone(new Date('2026-09-21T00:00:00Z'), 'UTC').toISOString()).toBe(
      '2026-09-21T00:00:00.000Z',
    );
  });
});
