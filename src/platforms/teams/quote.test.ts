import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { messageReferenceAttachment, prependQuoteTag } from './attachments'
import { TeamsClient } from './client'
import type { TeamsMessage } from './types'

const AUTHOR = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'

const quoted: TeamsMessage = {
  id: '1793067404262',
  channel_id: '19:chat@thread.v2',
  author: { id: `https://amer.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:${AUTHOR}`, displayName: 'Robert' },
  content: 'Yeongjun Sechan\n재무 미팅 내용 넣어주라!',
  timestamp: '2026-10-27T02:16:44.262Z',
}

describe('Teams quote helpers', () => {
  it('builds a Graph message reference from a Chat Service message', () => {
    const attachment = messageReferenceAttachment(quoted)
    expect(attachment.id).toBe(quoted.id)
    expect(attachment.contentType).toBe('messageReference')
    const content = JSON.parse(attachment.content)
    expect(content.messageId).toBe(quoted.id)
    expect(content.messagePreview).toBe('Yeongjun Sechan 재무 미팅 내용 넣어주라!')
    expect(content.messageSender.user).toEqual({ userIdentityType: 'aadUser', id: AUTHOR, displayName: 'Robert' })
  })

  it('rejects a quoted author without an organization ID', () => {
    expect(() => messageReferenceAttachment({ ...quoted, author: { id: '28:bot', displayName: 'Bot' } })).toThrow(
      'not an organization user',
    )
  })

  it('puts the quote tag before the body', () => {
    expect(prependQuoteTag('<p>hi</p>', '1')).toBe('<attachment id="1"></attachment><p>hi</p>')
  })
})

describe('TeamsClient quoted chat messages', () => {
  const originalFetch = globalThis.fetch
  let calls: Array<{ url: string; options?: RequestInit }> = []
  let responses: Response[] = []

  beforeEach(() => {
    calls = []
    responses = []
    globalThis.fetch = async (url: string | URL | Request, options?: RequestInit) => {
      calls.push({ url: url.toString(), options })
      const response = responses.shift()
      if (!response) throw new Error('No mock response configured')
      return response
    }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  const client = async (): Promise<TeamsClient> => {
    const value = await new TeamsClient().login({ token: 'skype', region: 'emea' })
    ;(value as any).getTokenProvider().getGraphToken = async () => 'graph'
    return value
  }

  const page = (ids: string[], backwardLink?: string) =>
    json({
      messages: ids.map((id) => ({
        id,
        from: `https://emea.ng.msg.teams.microsoft.com/v1/users/ME/contacts/8:orgid:${AUTHOR}`,
        imdisplayname: 'Robert',
        messagetype: 'RichText/Html',
        content: '<p>재무 미팅 내용 넣어주라!</p>',
        composetime: '2026-10-27T02:16:44.262Z',
      })),
      ...(backwardLink ? { _metadata: { backwardLink } } : {}),
    })

  it('quotes a message in the same chat through Graph without uploading files', async () => {
    responses.push(
      page(['1793067404262']),
      json({ id: '1793200000000', chatId: '19:chat@thread.v2', body: { contentType: 'html', content: '' } }, 201),
    )
    const message = await (
      await client()
    ).sendChatMessage('19:chat@thread.v2', '확인했습니다\n\n감사합니다\n', 'text', {
      quote: '1793067404262',
    })
    expect(message.quoted_message_id).toBe('1793067404262')
    const post = calls.at(-1)!
    expect(post.url).toBe('https://graph.microsoft.com/v1.0/chats/19%3Achat%40thread.v2/messages')
    const body = JSON.parse(String(post.options?.body))
    expect(body.body.content).toBe(
      '<attachment id="1793067404262"></attachment><p>확인했습니다</p><p>&nbsp;</p><p>감사합니다</p>',
    )
    expect(body.attachments).toHaveLength(1)
    expect(body.attachments[0].contentType).toBe('messageReference')
    expect(calls.some((call) => call.url.includes('/drive'))).toBe(false)
  })

  it('stops before any write when the quoted message is not in the chat', async () => {
    responses.push(page(['1']))
    await expect(
      (await client()).sendChatMessage('19:chat@thread.v2', '확인', 'text', { quote: '1793067404262' }),
    ).rejects.toThrow('not found in this chat')
    expect(calls.every((call) => (call.options?.method ?? 'GET') === 'GET')).toBe(true)
  })

  it('rejects a non-numeric quote ID before reading the chat', async () => {
    await expect((await client()).sendChatMessage('19:chat@thread.v2', '확인', 'text', { quote: 'abc' })).rejects.toThrow(
      'must be numeric',
    )
    expect(calls).toHaveLength(0)
  })

  it('still requires content or a file when quoting', async () => {
    await expect((await client()).sendChatMessage('19:chat@thread.v2', '', 'text', { quote: '1' })).rejects.toThrow(
      'content or at least one file',
    )
  })
})
