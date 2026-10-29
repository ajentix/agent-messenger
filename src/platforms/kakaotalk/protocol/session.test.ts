import { describe, expect, it, mock } from 'bun:test'

import { Long } from 'bson'
import { serialize } from 'bson'

import {
  buildModifyMessageBody,
  buildTypingActionBody,
  MODIFY_MESSAGE_METHOD,
  sendModifyMessagePacket,
  sendMessagePacket,
  sendTypingPacket,
  TYPING_ACTION_METHOD,
} from './session'
import type { LocoPacket } from './types'

type SentPacket = { method: string; body: Record<string, unknown> }

describe('message WRITE wire contract', () => {
  it('keeps plain text WRITE byte-for-byte identical without extra', async () => {
    const { connection, sent } = fakeConnection()
    const chatId = Long.fromString('459750513901477')
    await sendMessagePacket(connection, chatId, 'hello')
    expect(sent[0]!.method).toBe('WRITE')
    const original = { chatId, msg: 'hello', type: 1, noSeen: false }
    expect(serialize(sent[0]!.body)).toEqual(serialize(original))
  })

  it('serializes mentions as numeric user IDs in a type 1 WRITE extra', async () => {
    const { connection, sent } = fakeConnection()
    const mentions = [{ at: [1, 2], len: 8, user_id: 437696862 }]
    await sendMessagePacket(connection, Long.fromString('100'), '@리트머스 유영준 @리트머스 유영준', 1, { mentions })
    expect(sent).toEqual([
      {
        method: 'WRITE',
        body: {
          chatId: Long.fromString('100'),
          msg: '@리트머스 유영준 @리트머스 유영준',
          type: 1,
          noSeen: false,
          extra: '{"mentions":[{"at":[1,2],"len":8,"user_id":437696862}]}',
        },
      },
    ])
  })

  it('serializes reply mentions in type 26 while preserving a full-width source log ID', async () => {
    const { connection, sent } = fakeConnection()
    const extra = {
      mentions: [{ at: [1], len: 8, user_id: 437696862 }],
      src_type: 1,
      src_logId: '3961980999585314818',
      src_linkId: 0,
      src_userId: 437696862,
      src_message: '원문',
    }
    await sendMessagePacket(connection, Long.fromString('100'), '@리트머스 유영준 확인했습니다', 26, extra)
    expect(sent[0]!.method).toBe('WRITE')
    expect(sent[0]!.body.type).toBe(26)
    expect(sent[0]!.body.extra).toBe(JSON.stringify(extra))
    expect(JSON.parse(sent[0]!.body.extra as string).src_logId).toBe('3961980999585314818')
  })
})

// Fake connection object that captures every sendPacket call. We test
// sendTypingPacket (the extracted wire-boundary function) directly rather than
// the LocoSession class method — LocoSession.sendTyping is a two-line delegation
// to this helper, and testing the class would require mock.module('./session',
// …) which collides with client.test.ts's LocoSession mock.
function fakeConnection(returnPacket: LocoPacket = { statusCode: 0, body: {} }): {
  connection: { sendPacket: (method: string, body: Record<string, unknown>) => Promise<LocoPacket> }
  sent: SentPacket[]
  sendPacketMock: ReturnType<typeof mock>
} {
  const sent: SentPacket[] = []
  const sendPacketMock = mock(async (method: string, body: Record<string, unknown>) => {
    sent.push({ method, body })
    return returnPacket
  })
  return { connection: { sendPacket: sendPacketMock }, sent, sendPacketMock }
}

describe('typing indicator wire contract', () => {
  it('TYPING_ACTION_METHOD is the exact string "ACTION" that KakaoTalk expects on the wire', () => {
    expect(TYPING_ACTION_METHOD).toBe('ACTION')
  })

  it('emits type=1 and omits linkId entirely for normal chats', () => {
    const body = buildTypingActionBody(Long.fromString('459750513901477'))

    expect((body.chatId as { toString(): string }).toString()).toBe('459750513901477')
    expect(body.type).toBe(1)
    expect('linkId' in body).toBe(false)
  })

  it('includes linkId when provided (open-chat pulse)', () => {
    const body = buildTypingActionBody(Long.fromString('123'), Long.fromString('77777'))

    expect(body.type).toBe(1)
    expect((body.linkId as { toString(): string }).toString()).toBe('77777')
  })

  it('never sets linkId=null when caller passes undefined (would change server routing)', () => {
    const body = buildTypingActionBody(Long.fromString('123'), undefined)

    expect(body.linkId).toBeUndefined()
    expect('linkId' in body).toBe(false)
  })

  it('body only carries chatId + type for normal chats (no stray fields)', () => {
    const body = buildTypingActionBody(Long.fromString('123'))

    expect(Object.keys(body).sort()).toEqual(['chatId', 'type'])
  })

  it('body only carries chatId + type + linkId for open chats (no stray fields)', () => {
    const body = buildTypingActionBody(Long.fromString('123'), Long.fromString('77777'))

    expect(Object.keys(body).sort()).toEqual(['chatId', 'linkId', 'type'])
  })
})

describe('sendTypingPacket → sendPacket wire boundary', () => {
  it('calls connection.sendPacket("ACTION", body) exactly once for a normal chat, with full-width Long chatId preserved', async () => {
    const { connection, sent, sendPacketMock } = fakeConnection()

    await sendTypingPacket(connection, Long.fromString('459750513901477'))

    expect(sendPacketMock).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(1)
    const packet = sent[0]!
    expect(packet.method).toBe('ACTION')
    expect((packet.body.chatId as Long).toString()).toBe('459750513901477')
    expect(packet.body.type).toBe(1)
    expect('linkId' in packet.body).toBe(false)
  })

  it('calls sendPacket with full-width Long linkId preserved for an open-chat pulse', async () => {
    const { connection, sent } = fakeConnection()

    await sendTypingPacket(connection, Long.fromString('459750513901477'), Long.fromString('280368495100000'))

    const packet = sent[0]!
    expect(packet.method).toBe('ACTION')
    expect((packet.body.chatId as Long).toString()).toBe('459750513901477')
    expect((packet.body.linkId as Long).toString()).toBe('280368495100000')
    expect(packet.body.type).toBe(1)
  })

  it('propagates the LocoPacket returned by sendPacket verbatim', async () => {
    const expected = { statusCode: 0, body: { hello: 'world' } }
    const { connection } = fakeConnection(expected)

    const result = await sendTypingPacket(connection, Long.fromString('123'))

    expect(result).toBe(expected)
  })

  it('emits the same wire packet the reverse-engineered client builds (spec-lock)', async () => {
    const { connection, sent } = fakeConnection()

    await sendTypingPacket(connection, Long.fromString('123'), Long.fromString('456'))

    const packet = sent[0]!
    expect(packet.method).toBe(TYPING_ACTION_METHOD)
    expect(packet.body).toEqual(buildTypingActionBody(Long.fromString('123'), Long.fromString('456')))
  })
})

describe('message edit wire contract', () => {
  it('MODIFY_MESSAGE_METHOD is the exact string "MODIFYMSG" that KakaoTalk expects on the wire', () => {
    expect(MODIFY_MESSAGE_METHOD).toBe('MODIFYMSG')
  })

  it('carries chatId, logId, text type 1, the new text and an empty extra object', () => {
    const body = buildModifyMessageBody(
      Long.fromString('468258044152571'),
      Long.fromString('3960132955101280257'),
      'fixed',
    )

    expect((body.chatId as { toString(): string }).toString()).toBe('468258044152571')
    expect((body.logId as { toString(): string }).toString()).toBe('3960132955101280257')
    expect(body.type).toBe(1)
    expect(body.msg).toBe('fixed')
    expect(body.extra).toBe('{}')
    expect(Object.keys(body).sort()).toEqual(['chatId', 'extra', 'logId', 'msg', 'type'])
  })

  it('calls connection.sendPacket("MODIFYMSG", body) exactly once and returns its packet', async () => {
    const reply: LocoPacket = { statusCode: 0, body: { status: 0, modifiedChatLog: { revision: 1 } } }
    const { connection, sent, sendPacketMock } = fakeConnection(reply)

    const result = await sendModifyMessagePacket(connection, Long.fromString('100'), Long.fromString('42'), 'fixed')

    expect(sendPacketMock).toHaveBeenCalledTimes(1)
    expect(sent[0]!.method).toBe('MODIFYMSG')
    expect((sent[0]!.body.logId as { toString(): string }).toString()).toBe('42')
    expect(result).toBe(reply)
  })
})
