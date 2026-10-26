import type { TeamsAttachment, TeamsReferenceAttachment } from './types'
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
