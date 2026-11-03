import { describe, expect, it, mock } from 'bun:test'

import { Long } from 'bson'

import { uploadMediaToLoco, type MediaUploadConnection, type UploadToLocoOptions } from './media-uploader'
import type { LocoPacket } from './types'

function packet(body: Record<string, unknown>, statusCode = 0): LocoPacket {
  return { packetId: 1, statusCode, method: 'POST', bodyType: 0, body }
}

function fake(post: LocoPacket, complete: LocoPacket | null = packet({ chatLog: { logId: Long.ONE } })) {
  let onPush: (packet: LocoPacket) => void = () => {}
  let onClose: () => void = () => {}
  const writeRaw = mock(async () => {
    if (complete) onPush(complete)
    else onClose()
  })
  const close = mock(() => {})
  const conn: MediaUploadConnection = {
    connectSecure: mock(async () => {}),
    onPush: (handler) => {
      onPush = handler
    },
    onClose: (handler) => {
      onClose = handler
    },
    sendPacket: mock(async () => post),
    writeRaw,
    close,
  }
  return { conn, writeRaw, close }
}

const options: UploadToLocoOptions = {
  shipToken: 'fixture',
  shipHost: 'fixture.invalid',
  shipPort: 1,
  chatId: Long.fromString('100'),
  userId: '1',
  msgType: 18,
  filename: 'test.pdf',
  data: Buffer.from('PDF'),
  deviceType: 'tablet',
}

describe('media upload boundary without sockets', () => {
  it('streams exactly once after POST and returns COMPLETE', async () => {
    const complete = { ...packet({ chatLog: { logId: Long.ONE } }), method: 'COMPLETE' }
    const { conn, writeRaw, close } = fake(packet({ o: 0 }), complete)
    const result = await uploadMediaToLoco(options, () => conn)
    expect(writeRaw).toHaveBeenCalledWith(Buffer.from('PDF'))
    expect(writeRaw).toHaveBeenCalledTimes(1)
    expect(result.completePacket).toBe(complete)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('does not stream or wait for COMPLETE after packet/body POST rejections', async () => {
    for (const post of [packet({}, -203), packet({ status: -203 })]) {
      const { conn, writeRaw, close } = fake(post)
      const result = await uploadMediaToLoco(options, () => conn)
      expect(result).toEqual({ completePacket: null, postStatusCode: -203, postOffset: 0 })
      expect(writeRaw).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledTimes(1)
    }
  })

  it('treats connection closure before COMPLETE as an unknown delivery', async () => {
    const { conn, writeRaw } = fake(packet({ o: 0 }), null)
    const result = await uploadMediaToLoco(options, () => conn)
    expect(result.completePacket).toBeNull()
    expect(writeRaw).toHaveBeenCalledTimes(1)
  })

  it('treats a synthetic POST connection-close packet as uncertainty, not provider rejection', async () => {
    const { conn, writeRaw } = fake(packet({ error: 'connection closed' }, -1))
    await expect(uploadMediaToLoco(options, () => conn)).rejects.toThrow('connection closed')
    expect(writeRaw).not.toHaveBeenCalled()
  })

  it('rejects invalid offsets without streaming and cleans up on connect failure', async () => {
    for (const offset of [-1, 4, 0.5]) {
      const { conn, writeRaw, close } = fake(packet({ o: offset }))
      await expect(uploadMediaToLoco(options, () => conn)).rejects.toThrow('Invalid POST offset')
      expect(writeRaw).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledTimes(1)
    }
    const { conn, close } = fake(packet({}))
    conn.connectSecure = mock(async () => {
      throw new Error('fixture connect failure')
    })
    await expect(uploadMediaToLoco(options, () => conn)).rejects.toThrow('fixture connect failure')
    expect(close).toHaveBeenCalledTimes(1)
  })
})
