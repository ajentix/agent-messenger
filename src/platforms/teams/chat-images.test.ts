import { describe, expect, it } from 'bun:test'

import { chatImageTag, chatMediaHostIn, isChatMediaHost, readChatImageSize } from './chat-images'

describe('chat images', () => {
  it('reads PNG, GIF and JPEG sizes', () => {
    const png = Buffer.alloc(24)
    png.writeUInt32BE(0x89504e47, 0)
    png.write('IHDR', 12, 'ascii')
    png.writeUInt32BE(2168, 16)
    png.writeUInt32BE(1236, 20)
    expect(readChatImageSize(png)).toEqual({ type: 'png', width: 2168, height: 1236 })

    const gif = Buffer.alloc(10)
    gif.write('GIF89a', 0, 'ascii')
    gif.writeUInt16LE(320, 6)
    gif.writeUInt16LE(200, 8)
    expect(readChatImageSize(gif)).toEqual({ type: 'gif', width: 320, height: 200 })

    // SOI, an APP0 segment, then a complete baseline SOF0 segment (length 17).
    const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03, ...Array(9).fill(0)]
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, ...sof])
    expect(readChatImageSize(jpeg)).toEqual({ type: 'jpeg', width: 800, height: 600 })

    // Fill bytes before a marker are legal and must be skipped.
    const filled = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xff, ...sof])
    expect(readChatImageSize(filled)).toEqual({ type: 'jpeg', width: 800, height: 600 })

    // A segment that runs past the end of the file is not trusted.
    expect(() => readChatImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02]))).toThrow(
      'is not a PNG, JPEG or GIF image.',
    )
  })

  it('rejects other files by name', () => {
    expect(() => readChatImageSize(Buffer.from('%PDF-1.7 something'), 'a.pdf')).toThrow(
      'a.pdf is not a PNG, JPEG or GIF image.',
    )
  })

  it('scales wide images to the Teams display width and keeps small ones', () => {
    expect(
      chatImageTag('https://kr-prod.asyncgw.teams.microsoft.com', 'obj1', { type: 'png', width: 2168, height: 1236 }),
    ).toBe(
      '<p><img itemscope="" itemtype="http://schema.skype.com/AMSImage" src="https://kr-prod.asyncgw.teams.microsoft.com/v1/objects/obj1/views/imgo" width="800" height="456" id="obj1" itemid="obj1" alt="image" style="vertical-align:bottom; width:800px; height:456px;"></p>',
    )
    expect(
      chatImageTag('https://kr-prod.asyncgw.teams.microsoft.com', 'obj2', { type: 'gif', width: 320, height: 200 }),
    ).toContain('width="320" height="200"')
  })

  it('finds the media gateway host and accepts only gateway hosts', () => {
    expect(
      chatMediaHostIn('<img src="https://kr-prod.asyncgw.teams.microsoft.com/v1/objects/0-skr-d1-x/views/imgo">'),
    ).toBe('https://kr-prod.asyncgw.teams.microsoft.com')
    expect(chatMediaHostIn('<img src="https://example.com/v1/objects/x/views/imgo">')).toBeUndefined()
    expect(isChatMediaHost('https://kr-prod.asyncgw.teams.microsoft.com')).toBe(true)
    expect(isChatMediaHost('https://evil.example.com')).toBe(false)
  })
})
