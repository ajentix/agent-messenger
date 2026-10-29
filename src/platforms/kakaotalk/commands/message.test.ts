import { afterEach, beforeEach, describe, expect, mock, it } from 'bun:test'

const originalConsoleLog = console.log

const mockWithKakaoClient = mock(async (_options: unknown, fn: (client: unknown) => Promise<unknown>) => {
  return fn(mockClient)
})

const mockGetMessages = mock(() =>
  Promise.resolve([{ log_id: '1', message: 'Hello', sender_id: 'user-1', created_at: 1000 }]),
)

const mockSendMessage = mock(() => Promise.resolve({ log_id: '2', message: 'Hi there', created_at: 2000 }))

const mockMarkRead = mock(() =>
  Promise.resolve({ success: true, status_code: 0, chat_id: 'chat-123', watermark: '42' }),
)

const mockEditMessage = mock(() =>
  Promise.resolve({
    success: true,
    status_code: 0,
    chat_id: 'chat-123',
    log_id: '42',
    revision: '1',
    message: 'fixed text',
  }),
)

const mockGetReadState = mock(() =>
  Promise.resolve({
    chat_id: 'chat-123',
    last_log_id: '50',
    watermarks: [
      { user_id: '1', watermark: '50' },
      { user_id: '2', watermark: '49' },
    ],
    messages: [{ log_id: '50', unread_count: 1, read_user_ids: [], unread_user_ids: ['2'] }],
  }),
)

const originalExit = process.exit

const mockClient = {
  getMessages: mockGetMessages,
  sendMessage: mockSendMessage,
  markRead: mockMarkRead,
  editMessage: mockEditMessage,
  getReadState: mockGetReadState,
}

mock.module('./shared', () => ({
  withKakaoClient: mockWithKakaoClient,
}))

import { messageCommand } from './message'

describe('message commands', () => {
  let consoleLogSpy: ReturnType<typeof mock>

  beforeEach(() => {
    mockWithKakaoClient.mockReset()
    mockGetMessages.mockReset()
    mockSendMessage.mockReset()
    mockMarkRead.mockReset()
    mockEditMessage.mockReset()
    mockGetReadState.mockReset()

    mockWithKakaoClient.mockImplementation(async (_options: unknown, fn: (client: unknown) => Promise<unknown>) => {
      return fn(mockClient)
    })
    mockGetMessages.mockImplementation(() =>
      Promise.resolve([{ log_id: '1', message: 'Hello', sender_id: 'user-1', created_at: 1000 }]),
    )
    mockSendMessage.mockImplementation(() => Promise.resolve({ log_id: '2', message: 'Hi there', created_at: 2000 }))
    mockMarkRead.mockImplementation(() =>
      Promise.resolve({ success: true, status_code: 0, chat_id: 'chat-123', watermark: '42' }),
    )
    mockEditMessage.mockImplementation(() =>
      Promise.resolve({
        success: true,
        status_code: 0,
        chat_id: 'chat-123',
        log_id: '42',
        revision: '1',
        message: 'fixed text',
      }),
    )

    consoleLogSpy = mock((..._args: unknown[]) => {})
    console.log = consoleLogSpy
  })

  afterEach(() => {
    console.log = originalConsoleLog
    process.exit = originalExit
  })

  describe('list', () => {
    it('fetches messages for a chat room with default count', async () => {
      await messageCommand.parseAsync(['list', 'chat-123', '--count', '20'], { from: 'user' })

      expect(mockGetMessages).toHaveBeenCalledWith('chat-123', { count: 20, from: undefined })
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0])
      expect(output).toHaveLength(1)
      expect(output[0].log_id).toBe('1')
      expect(output[0].message).toBe('Hello')
    })

    it('respects --count option', async () => {
      await messageCommand.parseAsync(['list', 'chat-123', '--count', '5'], { from: 'user' })

      expect(mockGetMessages).toHaveBeenCalledWith('chat-123', { count: 5, from: undefined })
    })

    it('respects --from option', async () => {
      await messageCommand.parseAsync(['list', 'chat-123', '--count', '20', '--from', '999'], { from: 'user' })

      expect(mockGetMessages).toHaveBeenCalledWith('chat-123', { count: 20, from: '999' })
    })

    it('passes account option to withKakaoClient', async () => {
      await messageCommand.parseAsync(['list', 'chat-123', '--count', '20', '--account', 'my-account'], {
        from: 'user',
      })

      expect(mockWithKakaoClient).toHaveBeenCalledWith(
        expect.objectContaining({ account: 'my-account' }),
        expect.any(Function),
      )
    })
  })

  describe('send', () => {
    it('sends a message to a chat room', async () => {
      await messageCommand.parseAsync(['send', 'chat-123', 'Hello world'], { from: 'user' })

      expect(mockSendMessage).toHaveBeenCalledWith('chat-123', 'Hello world')
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0])
      expect(output.log_id).toBe('2')
      expect(output.message).toBe('Hi there')
    })

    it('passes account option to withKakaoClient', async () => {
      await messageCommand.parseAsync(['send', 'chat-123', 'Hi', '--account', 'my-account'], { from: 'user' })

      expect(mockWithKakaoClient).toHaveBeenCalledWith(
        expect.objectContaining({ account: 'my-account' }),
        expect.any(Function),
      )
    })

    it('resolves --reply-to from chat history and sends a quoted reply', async () => {
      // given
      mockGetMessages.mockImplementation(() =>
        Promise.resolve([
          { log_id: '10', type: 1, author_id: 5, author_name: null, message: 'earlier', attachment: null, sent_at: 1 },
          { log_id: '42', type: 2, author_id: 7, author_name: null, message: 'target', attachment: null, sent_at: 2 },
        ]),
      )

      // when
      await messageCommand.parseAsync(['send', 'chat-123', 'replying', '--reply-to', '42'], { from: 'user' })

      // then
      expect(mockGetMessages).toHaveBeenCalledWith('chat-123', { count: 100 })
      expect(mockSendMessage).toHaveBeenCalledWith('chat-123', 'replying', {
        replyTo: { log_id: '42', author_id: 7, message: 'target', type: 2 },
      })
    })

    it('errors when --reply-to log-id is not found in recent history', async () => {
      // given
      mockGetMessages.mockImplementation(() =>
        Promise.resolve([
          { log_id: '10', type: 1, author_id: 5, author_name: null, message: 'earlier', attachment: null, sent_at: 1 },
        ]),
      )
      const exitSpy = mock((_code?: number): never => {
        throw new Error('process.exit called')
      })
      process.exit = exitSpy as unknown as typeof process.exit

      // when / then
      try {
        await messageCommand.parseAsync(['send', 'chat-123', 'replying', '--reply-to', '999'], { from: 'user' })
      } catch {
        // process.exit stub throws to abort the action
      }

      expect(mockSendMessage).not.toHaveBeenCalled()
      expect(exitSpy).toHaveBeenCalled()
    })
  })

  describe('dense multi-line layout', () => {
    const dense = 'Hello, two updates.\n1. First.\n2. Second.'

    // commander keeps option values on the command object between parseAsync calls,
    // so a --reply-to from an earlier test would otherwise leak into these sends.
    beforeEach(() => {
      for (const name of ['send', 'edit']) {
        const command = messageCommand.commands.find((candidate) => candidate.name() === name)
        command?.setOptionValue('replyTo', undefined)
        command?.setOptionValue('allowDenseLayout', undefined)
      }
    })

    it('refuses to send a dense message before any client call', async () => {
      const originalExit = process.exit
      const exitSpy = mock(() => {
        throw new Error('process.exit called')
      })
      process.exit = exitSpy as unknown as typeof process.exit
      try {
        await messageCommand.parseAsync(['send', 'chat-123', dense], { from: 'user' })
      } catch {
        // process.exit stub throws to abort the action
      } finally {
        process.exit = originalExit
      }

      expect(mockWithKakaoClient).not.toHaveBeenCalled()
      expect(mockSendMessage).not.toHaveBeenCalled()
      expect(exitSpy).toHaveBeenCalled()
    })

    it('refuses a dense edit too', async () => {
      const originalExit = process.exit
      const exitSpy = mock(() => {
        throw new Error('process.exit called')
      })
      process.exit = exitSpy as unknown as typeof process.exit
      try {
        await messageCommand.parseAsync(['edit', 'chat-123', '42', dense], { from: 'user' })
      } catch {
        // process.exit stub throws to abort the action
      } finally {
        process.exit = originalExit
      }

      expect(mockEditMessage).not.toHaveBeenCalled()
    })

    it('sends a blank-line laid out message and honours --allow-dense-layout', async () => {
      await messageCommand.parseAsync(['send', 'chat-123', 'Hello, two updates.\n\n1. First.\n\n2. Second.'], {
        from: 'user',
      })
      await messageCommand.parseAsync(['send', 'chat-123', dense, '--allow-dense-layout'], { from: 'user' })

      expect(mockSendMessage).toHaveBeenCalledTimes(2)
    })
  })

  describe('edit', () => {
    it('calls editMessage with chat-id, log-id and the new text', async () => {
      await messageCommand.parseAsync(['edit', 'chat-123', '42', 'fixed text'], { from: 'user' })

      expect(mockEditMessage).toHaveBeenCalledWith('chat-123', '42', 'fixed text')
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0])
      expect(output).toEqual({
        success: true,
        status_code: 0,
        chat_id: 'chat-123',
        log_id: '42',
        revision: '1',
        message: 'fixed text',
      })
    })

    it('exits non-zero when the server refuses the edit', async () => {
      const exitSpy = mock((_code?: number): never => {
        throw new Error('process.exit called')
      })
      process.exit = exitSpy as unknown as typeof process.exit
      mockEditMessage.mockImplementationOnce(() =>
        Promise.resolve({
          success: false,
          status_code: -212,
          chat_id: 'chat-123',
          log_id: '42',
          revision: null,
          message: null,
        }),
      )

      try {
        await messageCommand.parseAsync(['edit', 'chat-123', '42', 'fixed text'], { from: 'user' })
      } catch {
        // process.exit stub throws to abort the action
      }

      expect(exitSpy).toHaveBeenCalledWith(1)
    })
  })

  describe('unread', () => {
    it('refuses to connect without --enter-room', async () => {
      const exitSpy = mock((_code?: number): never => {
        throw new Error('process.exit called')
      })
      process.exit = exitSpy as unknown as typeof process.exit

      try {
        await messageCommand.parseAsync(['unread', 'chat-123'], { from: 'user' })
      } catch {
        // process.exit stub throws to abort the action
      }

      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(mockWithKakaoClient).not.toHaveBeenCalled()
      expect(mockGetReadState).not.toHaveBeenCalled()
    })

    it('calls getReadState with chat-id, log ids and enterRoom', async () => {
      mockGetReadState.mockImplementation(() =>
        Promise.resolve({
          chat_id: 'chat-123',
          last_log_id: '50',
          watermarks: [
            { user_id: '1', watermark: '50' },
            { user_id: '2', watermark: '49' },
          ],
          messages: [
            { log_id: '49', unread_count: 0, read_user_ids: ['2'], unread_user_ids: [] },
            { log_id: '50', unread_count: 1, read_user_ids: [], unread_user_ids: ['2'] },
          ],
        }),
      )

      await messageCommand.parseAsync(['unread', 'chat-123', '49', '50', '--enter-room'], { from: 'user' })

      expect(mockGetReadState).toHaveBeenCalledWith('chat-123', ['49', '50'], { enterRoom: true })
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0])
      expect(output.messages.map((m: { unread_count: number }) => m.unread_count)).toEqual([0, 1])
    })
  })

  describe('mark-read', () => {
    it('calls markRead with chat-id and log-id, no opts for normal chat', async () => {
      await messageCommand.parseAsync(['mark-read', 'chat-123', '42'], { from: 'user' })

      expect(mockMarkRead).toHaveBeenCalledWith('chat-123', '42', undefined)
      const output = JSON.parse(consoleLogSpy.mock.calls[0][0])
      expect(output).toEqual({ success: true, status_code: 0, chat_id: 'chat-123', watermark: '42' })
    })

    it('forwards --link-id when provided (open chat)', async () => {
      await messageCommand.parseAsync(['mark-read', 'chat-123', '42', '--link-id', '77777'], { from: 'user' })

      expect(mockMarkRead).toHaveBeenCalledWith('chat-123', '42', { linkId: '77777' })
    })

    it('--pretty prints pretty-formatted JSON (consistent with list/send)', async () => {
      await messageCommand.parseAsync(['mark-read', 'chat-123', '42', '--pretty'], { from: 'user' })

      const printed = consoleLogSpy.mock.calls[0][0] as string
      expect(printed).toContain('\n')
      expect(JSON.parse(printed)).toEqual({
        success: true,
        status_code: 0,
        chat_id: 'chat-123',
        watermark: '42',
      })
    })

    it('exits non-zero when result.success is false (e.g. open chat missing --link-id)', async () => {
      const exitSpy = mock((_code?: number): never => {
        throw new Error('process.exit called')
      })
      process.exit = exitSpy as unknown as typeof process.exit
      mockMarkRead.mockImplementationOnce(() =>
        Promise.resolve({ success: false, status_code: -500, chat_id: 'chat-123', watermark: '42' }),
      )

      try {
        await messageCommand.parseAsync(['mark-read', 'chat-123', '42'], { from: 'user' })
      } catch {
        // process.exit stub throws to abort the action
      }

      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    it('exits zero on success', async () => {
      const exitSpy = mock((_code?: number): never => {
        throw new Error('process.exit called')
      })
      process.exit = exitSpy as unknown as typeof process.exit

      await messageCommand.parseAsync(['mark-read', 'chat-123', '42'], { from: 'user' })

      expect(exitSpy).not.toHaveBeenCalled()
    })

    it('passes account option to withKakaoClient', async () => {
      await messageCommand.parseAsync(['mark-read', 'chat-123', '42', '--account', 'my-account'], { from: 'user' })

      expect(mockWithKakaoClient).toHaveBeenCalledWith(
        expect.objectContaining({ account: 'my-account' }),
        expect.any(Function),
      )
    })
  })
})
