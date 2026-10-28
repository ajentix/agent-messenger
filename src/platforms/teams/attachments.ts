import type { TeamsAttachment, TeamsMessage, TeamsMessageReferenceAttachment, TeamsReferenceAttachment } from './types'
import { TeamsError } from './types'

const GUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

export function attachmentIdFromETag(eTag: string | undefined): string {
  const match = typeof eTag === 'string' ? eTag.match(new RegExp(`\\{?(${GUID_PATTERN})\\}?`, 'i')) : undefined
  if (!match) throw new TeamsError('Drive item eTag does not contain a GUID.', 'attachment_etag_missing')
  // eTags carry an uppercase GUID, while Teams stores and returns attachment ids in lowercase.
  return match[1].toLowerCase()
}

export function referenceAttachments(records: TeamsAttachment[]): TeamsReferenceAttachment[] {
  return records.map((record) => ({
    id: record.id,
    contentType: 'reference',
    contentUrl: record.content_url,
    name: record.name,
  }))
}

export function appendAttachmentTags(html: string, records: TeamsAttachment[]): string {
  return html + records.map((record) => `<attachment id="${record.id}"></attachment>`).join('')
}

const ORGID = /8:orgid:([0-9a-f-]{36})/i

/** Graph quote attachment. Teams stores it as a Reply blockquote that points at the message ID. */
export function messageReferenceAttachment(message: TeamsMessage): TeamsMessageReferenceAttachment {
  const userId = message.author.id.match(ORGID)?.[1]?.toLowerCase()
  if (!userId) throw new TeamsError('Quoted message author is not an organization user.', 'quote_author_unknown')
  return {
    id: message.id,
    contentType: 'messageReference',
    content: JSON.stringify({
      messageId: message.id,
      messagePreview: message.content.replace(/\s+/g, ' ').trim().slice(0, 200),
      messageSender: {
        application: null,
        device: null,
        user: { userIdentityType: 'aadUser', id: userId, displayName: message.author.displayName },
      },
    }),
  }
}

export function prependQuoteTag(html: string, messageId: string): string {
  return `<attachment id="${messageId}"></attachment>` + html
}
