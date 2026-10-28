import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { appendAttachmentTags, attachmentIdFromETag, referenceAttachments } from './attachments'
import { TeamsClient } from './client'
import { TeamsError } from './types'

describe('Teams attachments', () => {
  it('extracts the GUID from quoted eTags and rejects missing GUIDs', () => {
    const guid = '11111111-1111-1111-1111-111111111111'
    expect(attachmentIdFromETag(`"{${guid}},3"`)).toBe(guid)
    expect(attachmentIdFromETag(`${guid},7`)).toBe(guid)
    expect(attachmentIdFromETag('"{9F1FCD81-5822-4B40-85FE-FEB114ADD057},2"')).toBe(
      '9f1fcd81-5822-4b40-85fe-feb114add057',
    )
    expect(() => attachmentIdFromETag(undefined)).toThrow(TeamsError)
  })

  it('builds reference attachments and matching body tags', () => {
    const records = [
      {
        id: 'a',
        name: 'a.pdf',
        content_url: 'https://dav/a',
        web_url: 'https://web/a',
        drive_id: 'd',
        item_id: 'i',
        size: 1,
        shared_with: [],
      },
    ]
    expect(referenceAttachments(records)).toEqual([
      { id: 'a', contentType: 'reference', contentUrl: 'https://dav/a', name: 'a.pdf' },
    ])
    expect(appendAttachmentTags('<p>Hi</p>', records)).toBe('<p>Hi</p><attachment id="a"></attachment>')
  })
})

describe('TeamsClient attachment uploads', () => {
  const originalFetch = globalThis.fetch
  let calls: Array<{ url: string; options?: RequestInit }> = []
  let responses: Response[] = []
  let tempDir = ''

  beforeEach(async () => {
    calls = []
    responses = []
    tempDir = await mkdtemp(join(tmpdir(), 'teams-attachments-'))
    globalThis.fetch = async (url: string | URL | Request, options?: RequestInit) => {
      calls.push({ url: url.toString(), options })
      const response = responses.shift()
      if (!response) throw new Error('No mock response configured')
      return response
    }
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    await rm(tempDir, { recursive: true, force: true })
  })

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  const client = async (): Promise<TeamsClient> => {
    const value = await new TeamsClient().login({ token: 'skype', region: 'emea' })
    ;(value as any).getTokenProvider().getGraphToken = async () => 'graph'
    return value
  }

  const ME = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const MEMBER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  const OTHER = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

  it('uploads a small chat file with rename behavior and invites members once', async () => {
    const file = join(tempDir, 'report.pdf')
    await writeFile(file, 'pdf')
    responses.push(
      json({ id: ME }),
      json({
        id: 'chat',
        members: [
          { id: `8:orgid:${ME.toUpperCase()}` },
          { id: `8:orgid:${MEMBER}` },
          { id: '28:bot-app' },
          { id: `8:orgid:${OTHER}` },
        ],
      }),
      json({ id: MEMBER, accountEnabled: true }),
      json({ id: OTHER, accountEnabled: true }),
      json({ id: 'drive' }),
      json({ id: 'item' }),
      json({
        id: 'item',
        name: 'report.pdf',
        eTag: '"{11111111-1111-1111-1111-111111111111},3"',
        webUrl: 'https://web/report.pdf',
        webDavUrl: 'https://dav/report.pdf',
        size: 3,
      }),
      json({}),
    )
    const record = await (await client()).uploadChatFile('chat', file)
    expect(record.shared_with).toEqual([MEMBER, OTHER])
    expect(calls[1].url).toBe('https://emea.ng.msg.teams.microsoft.com/v1/threads/chat')
    expect(calls[1].options?.headers).toMatchObject({ 'X-Skypetoken': 'skype' })
    expect(calls.some((call) => call.url.includes('/chats/'))).toBe(false)
    expect(calls[2].url).toContain(`/users/${MEMBER}?`)
    expect(calls[5].url).toContain('/me/drive/root:/Microsoft%20Teams%20Chat%20Files/report.pdf:/content?')
    expect(calls[5].url).toContain('conflictBehavior=rename')
    expect(JSON.parse(String(calls[7].options?.body))).toEqual({
      requireSignIn: true,
      sendInvitation: false,
      roles: ['read'],
      recipients: [{ objectId: MEMBER }, { objectId: OTHER }],
    })
  })

  it('skips disabled accounts that stay in the chat roster', async () => {
    const file = join(tempDir, 'report.pdf')
    await writeFile(file, 'pdf')
    responses.push(
      json({ id: ME }),
      json({ id: 'chat', members: [{ id: `8:orgid:${ME}` }, { id: `8:orgid:${MEMBER}` }, { id: `8:orgid:${OTHER}` }] }),
      json({ id: MEMBER, accountEnabled: false }),
      json({ id: OTHER, accountEnabled: true }),
      json({ id: 'drive' }),
      json({ id: 'item' }),
      json({ id: 'item', name: 'report.pdf', eTag: '"{11111111-1111-1111-1111-111111111111},3"', webDavUrl: 'https://dav/r.pdf' }),
      json({}),
    )
    const record = await (await client()).uploadChatFile('chat', file)
    expect(record.shared_with).toEqual([OTHER])
    expect(JSON.parse(String(calls.at(-1)!.options?.body)).recipients).toEqual([{ objectId: OTHER }])
  })

  it('deletes the uploaded copy when sharing fails, so a retry does not leave a duplicate', async () => {
    const file = join(tempDir, 'report.pdf')
    await writeFile(file, 'pdf')
    responses.push(
      json({ id: ME }),
      json({ id: 'chat', members: [{ id: `8:orgid:${ME}` }, { id: `8:orgid:${MEMBER}` }] }),
      json({ id: MEMBER, accountEnabled: true }),
      json({ id: 'drive' }),
      json({ id: 'item' }),
      json({ id: 'item', name: 'report.pdf', eTag: '"{11111111-1111-1111-1111-111111111111},3"', webDavUrl: 'https://dav/r.pdf' }),
      json({ error: { message: 'One or more users could not be resolved' } }, 400),
      new Response(null, { status: 204 }),
    )
    await expect((await client()).uploadChatFile('chat', file)).rejects.toThrow()
    const last = calls.at(-1)!
    expect(last.options?.method).toBe('DELETE')
    expect(last.url).toContain('/drives/drive/items/item')
  })

  it('stops before uploading when a chat member cannot be resolved', async () => {
    const file = join(tempDir, 'report.pdf')
    await writeFile(file, 'pdf')
    responses.push(
      json({ id: ME }),
      json({ id: 'chat', members: [{ id: `8:orgid:${ME}` }, { id: '8:guest:visitor' }] }),
    )
    await expect((await client()).uploadChatFile('chat', file)).rejects.toThrow(
      'A chat member cannot be resolved: 8:guest:visitor',
    )
    expect(calls).toHaveLength(2)
    expect(calls.some((call) => call.url.includes('/content') || call.url.includes('createUploadSession'))).toBe(false)
  })

  it('stops before uploading when the roster belongs to another chat', async () => {
    const file = join(tempDir, 'report.pdf')
    await writeFile(file, 'pdf')
    responses.push(json({ id: ME }), json({ id: 'other-chat', members: [{ id: `8:orgid:${MEMBER}` }] }))
    await expect((await client()).uploadChatFile('chat', file)).rejects.toThrow(
      'The chat roster did not match the target chat.',
    )
    expect(calls).toHaveLength(2)
  })

  it('skips member lookup and invites for the self notes chat', async () => {
    const file = join(tempDir, 'note.pdf')
    await writeFile(file, 'pdf')
    responses.push(
      json({ id: 'drive' }),
      json({ id: 'item' }),
      json({
        id: 'item',
        name: 'note.pdf',
        eTag: '"{33333333-3333-3333-3333-333333333333},1"',
        webDavUrl: 'https://dav/note.pdf',
      }),
    )
    const record = await (await client()).uploadChatFile('48:notes', file)
    expect(record.shared_with).toEqual([])
    expect(calls.map((call) => call.url).some((url) => url.includes('/threads/') || url.endsWith('/invite'))).toBe(
      false,
    )
  })

  it('uploads a channel attachment into the channel folder with rename behavior', async () => {
    const file = join(tempDir, 'report.pdf')
    await writeFile(file, 'pdf')
    responses.push(
      json({ id: 'folder', parentReference: { driveId: 'drive' } }),
      json({ id: 'item' }),
      json({
        id: 'item',
        name: 'report 1.pdf',
        eTag: '{44444444-4444-4444-4444-444444444444},1',
        webUrl: 'https://web/r',
      }),
    )
    const record = await (await client()).uploadChannelAttachment('team', 'channel', file)
    expect(record).toMatchObject({
      id: '44444444-4444-4444-4444-444444444444',
      name: 'report 1.pdf',
      drive_id: 'drive',
    })
    expect(calls[1].url).toContain(
      '/drives/drive/items/folder:/report.pdf:/content?@microsoft.graph.conflictBehavior=rename',
    )
  })

  it('deletes a failed upload session without forwarding authorization', async () => {
    const file = join(tempDir, 'large.bin')
    await writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 1, 1))
    responses.push(
      json({ id: ME }),
      json({ id: 'chat', members: [{ id: `8:orgid:${ME}` }] }),
      json({ id: 'drive' }),
      json({ uploadUrl: 'https://upload.test/session' }),
      new Response(null, { status: 500 }),
      new Response(null, { status: 204 }),
    )
    await expect((await client()).uploadChatFile('chat', file)).rejects.toThrow(TeamsError)
    expect(calls[4].options?.headers).not.toHaveProperty('Authorization')
    expect(calls[5].options?.method).toBe('DELETE')
    expect(calls[5].options?.headers).toBeUndefined()
  })

  it('uploads sequential 320 KiB multiple chunks and sends a reference body', async () => {
    const file = join(tempDir, 'large.bin')
    const total = 4 * 1024 * 1024 + 1
    await writeFile(file, Buffer.alloc(total, 1))
    responses.push(
      json({ id: ME }),
      json({ id: 'chat', members: [{ id: `8:orgid:${ME}` }] }),
      json({ id: 'drive' }),
      json({ uploadUrl: 'https://upload.test/session' }),
      new Response(null, { status: 202 }),
      json({ id: 'item' }, 201),
      json({
        id: 'item',
        name: 'large.bin',
        eTag: '{11111111-1111-1111-1111-111111111111},1',
        webUrl: 'https://web/large',
        size: total,
      }),
      json({
        id: 'message',
        body: {
          contentType: 'html',
          content: '<p>See</p><attachment id="11111111-1111-1111-1111-111111111111"></attachment>',
        },
      }),
    )
    const message = await (await client()).sendChatMessage('chat', 'See', 'text', { files: [file] })
    expect(message.attachments).toHaveLength(1)
    expect(calls[4].options?.headers).toMatchObject({
      'Content-Range': `bytes 0-3276799/${total}`,
      'Content-Length': '3276800',
    })
    expect(calls[5].options?.headers).toMatchObject({
      'Content-Range': `bytes 3276800-${total - 1}/${total}`,
      'Content-Length': String(total - 3276800),
    })
    const body = JSON.parse(String(calls[7].options?.body))
    expect(body.body.content).toContain('<attachment id="11111111-1111-1111-1111-111111111111"></attachment>')
    expect(body.attachments).toEqual([
      {
        id: '11111111-1111-1111-1111-111111111111',
        contentType: 'reference',
        contentUrl: 'https://web/large',
        name: 'large.bin',
      },
    ])
  })

  it('posts channel files through the channel folder without an invite', async () => {
    const file = join(tempDir, 'report.pdf')
    await writeFile(file, 'pdf')
    responses.push(
      json({ id: 'folder', parentReference: { driveId: 'drive' } }),
      json({ id: 'item' }),
      json({
        id: 'item',
        name: 'report.pdf',
        eTag: '{22222222-2222-2222-2222-222222222222},1',
        webUrl: 'https://web/report',
      }),
      json({
        id: 'message',
        body: { contentType: 'html', content: '<attachment id="22222222-2222-2222-2222-222222222222"></attachment>' },
      }),
    )
    await (await client()).sendMessage('team', 'channel', '', undefined, 'text', { files: [file] })
    const body = JSON.parse(String(calls[3].options?.body))
    expect(calls[0].url).toContain('/teams/team/channels/channel/filesFolder')
    expect(calls[1].url).toContain('conflictBehavior=rename')
    expect(body.attachments[0].contentType).toBe('reference')
    expect(calls.some((call) => call.url.endsWith('/invite'))).toBe(false)
  })

  it('rejects invalid attachments before making Graph requests', async () => {
    const value = await client()
    const empty = join(tempDir, 'empty.txt')
    await writeFile(empty, '')
    await expect(value.sendChatMessage('chat', '', 'text')).rejects.toThrow('Message content or at least one file')
    await expect(value.sendChatMessage('chat', 'x', 'text', { files: [empty] })).rejects.toThrow('File is empty')
    await expect(value.sendChatMessage('chat', 'x', 'text', { files: [join(tempDir, 'missing')] })).rejects.toThrow(
      'File not found',
    )
    await expect(
      value.sendChatMessage('chat', 'x', 'text', { files: Array.from({ length: 11 }, () => 'x') }),
    ).rejects.toThrow('at most 10 files')
    expect(calls).toHaveLength(0)
  })
})
