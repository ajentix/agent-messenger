import { escapeHtml } from '@/shared/utils/markdown-to-html'

import { TeamsError } from './types'

// Chat images go to the Teams async media gateway (AMS) the way the Teams app uploads them,
// and the message body points at them with an AMSImage tag.

export type ChatImageType = 'png' | 'jpeg' | 'gif'

export interface ChatImage {
  data: Uint8Array
  filename: string
}

export interface ChatImageSize {
  type: ChatImageType
  width: number
  height: number
}

export const MAX_CHAT_IMAGES = 10
// Teams shows wide images scaled down to this width; the full size opens on click.
export const CHAT_IMAGE_DISPLAY_WIDTH = 800

const MEDIA_HOST = /^https:\/\/[a-z0-9-]+\.asyncgw\.teams\.microsoft\.com$/
const MEDIA_HOST_IN_HTML = /\bsrc="(https:\/\/[a-z0-9-]+\.asyncgw\.teams\.microsoft\.com)\/v1\/objects\//i

export function isChatMediaHost(host: string): boolean {
  return MEDIA_HOST.test(host)
}

export function chatMediaHostIn(html: string): string | undefined {
  return html.match(MEDIA_HOST_IN_HTML)?.[1]?.toLowerCase()
}

export function readChatImageSize(data: Uint8Array, filename = 'image'): ChatImageSize {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { type: 'png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) {
    return { type: 'gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 1 < bytes.length && bytes[offset] === 0xff) {
      // Any number of 0xff fill bytes may precede a marker.
      while (offset + 1 < bytes.length && bytes[offset + 1] === 0xff) offset++
      const marker = bytes[offset + 1]
      if (offset + 4 > bytes.length) break
      const length = bytes.readUInt16BE(offset + 2)
      if (length < 2 || offset + 2 + length > bytes.length) break
      // SOF markers carry the frame size; DHT (C4), JPG (C8) and DAC (CC) share the range but do not.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (length < 7) break
        return { type: 'jpeg', width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
      }
      offset += 2 + length
    }
  }
  throw new TeamsError(`${filename} is not a PNG, JPEG or GIF image.`, 'image_type_unsupported')
}

export function chatImageTag(host: string, objectId: string, size: ChatImageSize): string {
  const scale = size.width > CHAT_IMAGE_DISPLAY_WIDTH ? CHAT_IMAGE_DISPLAY_WIDTH / size.width : 1
  const width = Math.max(1, Math.round(size.width * scale))
  const height = Math.max(1, Math.round(size.height * scale))
  const id = escapeHtml(objectId)
  const src = escapeHtml(`${host}/v1/objects/${encodeURIComponent(objectId)}/views/imgo`)
  return (
    `<p><img itemscope="" itemtype="http://schema.skype.com/AMSImage" src="${src}" width="${width}" height="${height}"` +
    ` id="${id}" itemid="${id}" alt="image" style="vertical-align:bottom; width:${width}px; height:${height}px;"></p>`
  )
}
