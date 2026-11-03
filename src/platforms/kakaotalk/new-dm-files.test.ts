import { describe, expect, it, mock, spyOn } from 'bun:test'

import { Long } from 'bson'

import { KakaoTalkClient, KakaoTalkError } from './client'
import type { uploadMediaToLoco } from './protocol/media-uploader'
import { KakaoAttachmentBatchResultSchema, type KakaoChat, type KakaoMember } from './types'

const credentials = {
  oauthToken: 'fixture-token',
  userId: '1',
  deviceUuid: 'fixture-device',
  deviceType: 'tablet' as const,
}

function fixture(fetchImpl?: typeof fetch, uploadMediaImpl?: typeof uploadMediaToLoco) {
  const createChat = mock(async () => ({ statusCode: 0, body: { chatId: Long.fromString('459750513901477') } }))
  const shipMedia = mock(async () => ({ statusCode: 0, body: { status: -203 } }))
  const client = new KakaoTalkClient({ fetchImpl, uploadMediaImpl })
  // Install a completely local session. No login, credential files or sockets.
  Object.assign(client, credentials, { state: { session: { createChat, shipMedia }, loginResult: {} } })
  return { client, createChat, shipMedia }
}

function jsonFetch(responses: Array<Record<string, unknown> | Error>) {
  return mock(async () => {
    const response = responses.shift()
    if (response instanceof Error) throw response
    if (!response) throw new Error('Unexpected request')
    return new Response(JSON.stringify(response), { status: 200 })
  }) as unknown as typeof fetch & ReturnType<typeof mock>
}

describe('phone contacts', () => {
  it('uses the documented POST form, then resolves user_id from a phone match', async () => {
    const fetchImpl = jsonFetch([
      { status: 0, pstn_number: '+82 10-0000-0000' },
      {
        status: 0,
        token: 10,
        friends: [{ userId: '9007199254740993', nickName: '상대', phoneNumber: '+821000000000' }],
      },
    ])
    const { client } = fixture(fetchImpl)
    const result = await client.addFriendByPhone({ nickname: '상대', phoneNumber: '010-0000-0000' })
    expect(result.user_id).toBe('9007199254740993')
    expect(result.success).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://katalk.kakao.com/android/friends/add_by_phonenumber.json')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect((init.body as URLSearchParams).get('phonenumber')).toBe('010-0000-0000')
    expect((init.body as URLSearchParams).get('nickname')).toBe('상대')
    expect((init.body as URLSearchParams).get('country_iso')).toBe('KR')
    expect((init.body as URLSearchParams).get('country_code')).toBe('82')
    expect((init.headers as Record<string, string>).Authorization).toBe('fixture-token-fixture-device')
    const listUrl = new URL(fetchImpl.mock.calls[1][0])
    expect(listUrl.pathname).toBe('/android/friends/list.json')
    expect(listUrl.searchParams.get('token')).toBe('0')
  })

  it('preserves bare 64-bit user IDs in friend JSON', async () => {
    const fetchImpl = mock(
      async () => new Response('{"status":0,"friends":[{"userId":9007199254740993,"nickName":"a"}]}'),
    ) as unknown as typeof fetch
    const { client } = fixture(fetchImpl)
    expect((await client.getFriends())[0]!.user_id).toBe('9007199254740993')
  })

  it('never substitutes a matching nickname for a missing phone match', async () => {
    const fetchImpl = jsonFetch([
      { status: 0, pstn_number: '01000000000' },
      { status: 0, friends: [{ userId: 2, nickName: '동명인', phoneNumber: '01011111111' }] },
    ])
    const { client } = fixture(fetchImpl)
    await expect(client.addFriendByPhone({ nickname: '동명인', phoneNumber: '01000000000' })).rejects.toMatchObject({
      code: 'friend_added_id_unresolved',
    })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('ignores masked unrelated phones and uses the documented PC service prefix', async () => {
    const fetchImpl = jsonFetch([
      { status: 0, pstn_number: '01000000000' },
      {
        status: 0,
        friends: [
          { userId: 3, phoneNumber: '010****1111' },
          { userId: 2, phoneNumber: '01000000000' },
        ],
      },
    ])
    const { client } = fixture(fetchImpl)
    Object.assign(client, { deviceType: 'pc' })
    expect((await client.addFriendByPhone({ nickname: 'a', phoneNumber: '01000000000' })).user_id).toBe('2')
    expect(fetchImpl.mock.calls[0]![0]).toBe('https://katalk.kakao.com/mac/friends/add_by_phonenumber.json')
  })

  it('reports an accepted add with a missing/ambiguous list match without replaying the POST', async () => {
    for (const friends of [
      [],
      [
        { userId: 2, phoneNumber: '01000000000' },
        { userId: 3, phoneNumber: '01000000000' },
      ],
    ]) {
      const fetchImpl = jsonFetch([{ status: 0 }, { status: 0, friends }])
      const { client } = fixture(fetchImpl)
      await expect(client.addFriendByPhone({ nickname: 'a', phoneNumber: '01000000000' })).rejects.toMatchObject({
        code: 'friend_added_id_unresolved',
      })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    }
  })

  it('propagates provider rejection and makes no friend-list request', async () => {
    const fetchImpl = jsonFetch([{ status: -500 }])
    const { client } = fixture(fetchImpl)
    await expect(client.addFriendByPhone({ nickname: 'a', phoneNumber: '01000000000' })).rejects.toMatchObject({
      code: 'add_friend_rejected',
      serverStatus: -500,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not retry uncertain adds or expose transport error text', async () => {
    const fetchImpl = jsonFetch([new Error('secret token in URL')])
    const { client } = fixture(fetchImpl)
    try {
      await client.addFriendByPhone({ nickname: 'a', phoneNumber: '01000000000' })
      throw new Error('Expected failure')
    } catch (error) {
      expect(error).toMatchObject({ code: 'add_friend_unknown' })
      expect((error as Error).message).not.toContain('secret token')
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid input before calling HTTP', async () => {
    const fetchImpl = jsonFetch([])
    const { client } = fixture(fetchImpl)
    await expect(client.addFriendByPhone({ nickname: '', phoneNumber: '01000000000' })).rejects.toMatchObject({
      code: 'invalid_friend_input',
    })
    await expect(client.addFriendByPhone({ nickname: 'a', phoneNumber: 'oops' })).rejects.toMatchObject({
      code: 'invalid_friend_input',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fails closed on missing status, HTTP failure and malformed friend lists', async () => {
    for (const response of [
      new Response('{}'),
      new Response('{"status":0}', { status: 403 }),
      new Response('{"status":0,"friends":null}'),
    ]) {
      const fetchImpl = mock(async () => response) as unknown as typeof fetch
      const { client } = fixture(fetchImpl)
      await expect(client.getFriends()).rejects.toMatchObject({ code: 'get_friends_failed' })
    }
  })
})

describe('direct chats', () => {
  const room = (chatId: string, type: string | number = 'DirectChat') =>
    ({ chat_id: chatId, type, active_members: 2 }) as KakaoChat
  const members = (ids: string[]) => ids.map((id) => ({ user_id: id })) as KakaoMember[]

  it('returns the existing room after checking the full list and both identities', async () => {
    const { client, createChat } = fixture()
    const getChats = spyOn(client, 'getChats').mockResolvedValue([room('100'), room('200')])
    spyOn(client, 'getMembers').mockImplementation(async (id) => members(id === '100' ? ['1', '3'] : ['1', '2']))
    expect(await client.openDirectChat('2')).toEqual({
      success: true,
      status_code: 0,
      chat_id: '200',
      user_id: '2',
      existing: true,
    })
    expect(getChats).toHaveBeenCalledWith({ all: true })
    expect(createChat).not.toHaveBeenCalled()
  })

  it('creates a room with exactly one BSON Long member ID, without a message', async () => {
    const { client, createChat } = fixture()
    spyOn(client, 'getChats').mockResolvedValue([])
    const result = await client.openDirectChat('9007199254740993')
    expect(createChat).toHaveBeenCalledWith([Long.fromString('9007199254740993')])
    expect(result).toEqual({
      success: true,
      status_code: 0,
      chat_id: '459750513901477',
      user_id: '9007199254740993',
      existing: false,
    })
  })

  it('coalesces concurrent opens for the same user into one CREATE', async () => {
    const { client, createChat } = fixture()
    spyOn(client, 'getChats').mockResolvedValue([])
    const [first, second] = await Promise.all([client.openDirectChat('2'), client.openDirectChat('2')])
    expect(first.chat_id).toBe(second.chat_id)
    expect(createChat).toHaveBeenCalledTimes(1)
  })

  it('retains the created room in the session snapshot for a subsequent open', async () => {
    const { client, createChat } = fixture()
    Object.assign(client, {
      state: {
        session: { createChat },
        loginResult: { chatDatas: [{ c: 10, t: 'MultiChat', a: 3, n: 0 }], eof: true },
      },
    })
    spyOn(client, 'getMembers').mockResolvedValue(members(['1', '2']))
    expect((await client.openDirectChat('2')).existing).toBe(false)
    expect((await client.openDirectChat('2')).existing).toBe(true)
    expect(createChat).toHaveBeenCalledTimes(1)
  })

  it('does not mistake two-member groups or open rooms for a direct chat', async () => {
    const { client, createChat } = fixture()
    spyOn(client, 'getChats').mockResolvedValue([room('100', 'MultiChat'), room('200', 'OD')])
    const lookup = spyOn(client, 'getMembers')
    await client.openDirectChat('2')
    expect(lookup).not.toHaveBeenCalled()
    expect(createChat).toHaveBeenCalledTimes(1)
  })

  it('resolves numeric list types through CHATINFO before returning an existing room', async () => {
    const { client, createChat } = fixture()
    spyOn(client, 'getChats').mockResolvedValue([room('100', 11)])
    spyOn(client, 'getChat').mockResolvedValue(room('100'))
    spyOn(client, 'getMembers').mockResolvedValue(members(['1', '2']))
    expect((await client.openDirectChat('2')).existing).toBe(true)
    expect(createChat).not.toHaveBeenCalled()
  })

  it('does not let an unrelated numeric room block creation and rejects unresolved matching types', async () => {
    const { client, createChat } = fixture()
    spyOn(client, 'getChats').mockResolvedValue([room('100', 11)])
    const getMembers = spyOn(client, 'getMembers').mockResolvedValue(members(['1', '3']))
    const getChat = spyOn(client, 'getChat').mockResolvedValue(room('100', 11))
    expect((await client.openDirectChat('2')).existing).toBe(false)
    expect(getChat).not.toHaveBeenCalled()
    getMembers.mockResolvedValue(members(['1', '2']))
    await expect(client.openDirectChat('2')).rejects.toMatchObject({ code: 'direct_chat_type_unresolved' })
    expect(createChat).toHaveBeenCalledTimes(1)
  })

  it('never creates after incomplete discovery or a failed member lookup', async () => {
    const { client, createChat } = fixture()
    const getChats = spyOn(client, 'getChats').mockRejectedValue(new Error('incomplete list'))
    await expect(client.openDirectChat('2')).rejects.toThrow('incomplete list')
    getChats.mockResolvedValue([room('100')])
    spyOn(client, 'getMembers').mockRejectedValue(new Error('members unavailable'))
    await expect(client.openDirectChat('2')).rejects.toThrow('members unavailable')
    expect(createChat).not.toHaveBeenCalled()
  })

  it('rejects ambiguous rooms, invalid IDs and self IDs', async () => {
    const { client, createChat } = fixture()
    spyOn(client, 'getChats').mockResolvedValue([room('100'), room('200')])
    spyOn(client, 'getMembers').mockResolvedValue(members(['1', '2']))
    await expect(client.openDirectChat('2')).rejects.toMatchObject({ code: 'direct_chat_ambiguous' })
    for (const id of ['1', '0', '-1', '9223372036854775808', 'invalid']) {
      await expect(client.openDirectChat(id)).rejects.toMatchObject({ code: 'invalid_user_id' })
    }
    expect(createChat).not.toHaveBeenCalled()
  })

  it('preserves CREATE packet/body rejections and never retries malformed responses', async () => {
    for (const response of [
      { statusCode: -323, body: {} },
      { statusCode: 0, body: { status: -322 } },
      { statusCode: 0, body: {} },
    ]) {
      const { client, createChat } = fixture()
      spyOn(client, 'getChats').mockResolvedValue([])
      createChat.mockResolvedValue(response)
      await expect(client.openDirectChat('2')).rejects.toMatchObject({ code: 'open_direct_chat_failed' })
      expect(createChat).toHaveBeenCalledTimes(1)
    }
  })
})

describe('sequential files', () => {
  const files = Array.from({ length: 7 }, (_, i) => ({ data: Buffer.from(`PDF-${i}`), filename: `${i + 1}.pdf` }))
  const sent = (i: number) => ({
    success: true,
    status_code: 0,
    chat_id: '100',
    log_id: `39470685322673131${i}5`,
    sent_at: 10 + i,
  })

  it('awaits all seven files in input order and retains every log ID', async () => {
    const { client } = fixture()
    let inFlight = 0
    let count = 0
    const send = spyOn(client, 'sendFile').mockImplementation(async () => {
      expect(inFlight++).toBe(0)
      await Promise.resolve()
      inFlight--
      return sent(count++)
    })
    const result = await client.sendFiles('100', files)
    expect(result.success).toBe(true)
    expect(result.completed_count).toBe(7)
    expect(result.files.map((file) => file.log_id)).toEqual(files.map((_, i) => sent(i).log_id))
    expect(send.mock.calls.map((call) => call[2])).toEqual(files.map((file) => file.filename))
    expect(KakaoAttachmentBatchResultSchema.safeParse(result).success).toBe(true)
  })

  it('validates a later file over the caller limit before sending any file', async () => {
    const { client } = fixture()
    const send = spyOn(client, 'sendFile')
    await expect(
      client.sendFiles('100', [files[0]!, { filename: 'large.pdf', data: Buffer.alloc(20) }], { maxFileBytes: 10 }),
    ).rejects.toMatchObject({ code: 'file_limit_exceeded' })
    expect(send).not.toHaveBeenCalled()
  })

  it('reports a rejection per file, preserves completed logs and skips the rest', async () => {
    const { client } = fixture()
    const send = spyOn(client, 'sendFile')
      .mockResolvedValueOnce(sent(0))
      .mockRejectedValueOnce(
        new KakaoTalkError('provider size limit', 'send_file_failed', {
          serverStatus: -203,
          responseFailureKind: 'provider_rejection',
        }),
      )
    const result = await client.sendFiles('100', files)
    expect(result.files.map((file) => file.status)).toEqual([
      'sent',
      'failed',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ])
    expect(result.files[0]!.log_id).toBe(sent(0).log_id)
    expect(result.files[1]!.status_code).toBe(-203)
    expect(result.completed_count).toBe(1)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('marks a lost response unknown and never retries or sends subsequent files', async () => {
    const { client } = fixture()
    const send = spyOn(client, 'sendFile').mockRejectedValue(new Error('connection lost'))
    const result = await client.sendFiles('100', files)
    expect(result.files[0]!.status).toBe('unknown')
    expect(result.files[0]!.log_id).toBeNull()
    expect(result.files.slice(1).every((file) => file.status === 'skipped')).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('handles a false send result as failure and rejects empty batches', async () => {
    const { client } = fixture()
    spyOn(client, 'sendFile').mockResolvedValue({ ...sent(0), success: false, status_code: -203 })
    expect((await client.sendFiles('100', files)).files[0]!.status).toBe('failed')
    await expect(client.sendFiles('100', [])).rejects.toMatchObject({ code: 'invalid_files' })
  })

  it('includes SHIP refusal stage, size and status without opening an uploader', async () => {
    const { client, shipMedia } = fixture()
    const result = await client.sendFiles('100', files)
    expect(result.files[0]).toMatchObject({ status: 'failed', status_code: -203 })
    expect(result.files[0]!.error!.message).toContain('SHIP')
    expect(result.files[0]!.error!.message).toContain('5 bytes')
    expect(shipMedia).toHaveBeenCalledTimes(1)
  })

  it('sends seven actual FILE pipelines using fake SHIP and upload clients', async () => {
    let index = 0
    const upload = mock(async () => ({
      postStatusCode: 0,
      postOffset: 0,
      completePacket: {
        packetId: 1,
        method: 'COMPLETE',
        bodyType: 0,
        statusCode: 0,
        body: { chatLog: { chatId: Long.fromString('100'), logId: Long.fromString(sent(index++).log_id), sendAt: 10 } },
      },
    }))
    const { client, shipMedia } = fixture(undefined, upload)
    shipMedia.mockResolvedValue({ statusCode: 0, body: { k: 'fixture-ticket', vh: 'fixture.invalid', p: 443 } })
    const result = await client.sendFiles('100', files)
    expect(result.completed_count).toBe(7)
    expect(shipMedia).toHaveBeenCalledTimes(7)
    expect(upload.mock.calls.map((call) => call[0].filename)).toEqual(files.map((file) => file.filename))
    expect(result.files.map((file) => file.log_id)).toEqual(files.map((_, i) => sent(i).log_id))
    expect(upload.mock.calls.every((call) => call[0].msgType === 18)).toBe(true)
  })

  it('requires a successful COMPLETE with an exact log ID for confirmed delivery', async () => {
    const complete = (body: Record<string, unknown>, statusCode = 0) => ({
      packetId: 1,
      method: 'COMPLETE',
      bodyType: 0,
      statusCode,
      body,
    })
    for (const [packet, expected] of [
      [null, 'unknown'],
      [complete({ chatLog: { logId: 10 } }, -203), 'failed'],
      [complete({ status: -203 }), 'failed'],
      [complete({ chatLog: {} }), 'unknown'],
      [complete({ chatLog: { logId: 10, chatId: 200 } }), 'unknown'],
      [complete({ chatLog: { logId: 0 } }), 'unknown'],
    ] as const) {
      const upload = mock(async () => ({ postStatusCode: 0, postOffset: 0, completePacket: packet }))
      const { client, shipMedia } = fixture(undefined, upload)
      shipMedia.mockResolvedValue({ statusCode: 0, body: { k: 'fixture-ticket', vh: 'fixture.invalid', p: 443 } })
      const result = await client.sendFiles('100', files)
      expect(result.files[0]!.status).toBe(expected)
      expect(result.files[0]!.log_id).toBeNull()
      expect(result.files.slice(1).every((file) => file.status === 'skipped')).toBe(true)
      expect(upload).toHaveBeenCalledTimes(1)
    }
  })

  it('reports POST refusal distinctly and rejects invalid batch chat IDs', async () => {
    const upload = mock(async () => ({ postStatusCode: -203, postOffset: 0, completePacket: null }))
    const { client, shipMedia } = fixture(undefined, upload)
    shipMedia.mockResolvedValue({ statusCode: 0, body: { k: 'fixture-ticket', vh: 'fixture.invalid', p: 443 } })
    const result = await client.sendFiles('100', files)
    expect(result.files[0]).toMatchObject({ status: 'failed', status_code: -203 })
    expect(result.files[0]!.error!.message).toContain('POST')
    for (const id of ['0', '-1', '9223372036854775808']) {
      await expect(client.sendFiles(id, files)).rejects.toMatchObject({ code: 'invalid_chat_id' })
    }
  })
})
