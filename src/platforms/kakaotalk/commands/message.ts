import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

import { Command, Option } from 'commander'

import { handleError } from '@/shared/utils/error-handler'
import { assertReadableMessageLayout } from '@/shared/utils/message-layout'
import { formatOutput } from '@/shared/utils/output'

import { guessMimeFromFilename } from '../media-upload'
import type { KakaoMessage, KakaoReplyTarget } from '../types'
import { withKakaoClient } from './shared'

async function listAction(
  chatId: string,
  options: { account?: string; count?: string; from?: string; pretty?: boolean },
): Promise<void> {
  try {
    const count = options.count ? Number.parseInt(options.count, 10) : 20
    const messages = await withKakaoClient(options, (client) =>
      client.getMessages(chatId, { count, from: options.from }),
    )
    console.log(formatOutput(messages, options.pretty))
  } catch (error) {
    handleError(error as Error)
  }
}

async function sendAction(
  chatId: string,
  text: string,
  options: { account?: string; pretty?: boolean; replyTo?: string; mention?: string[]; allowDenseLayout?: boolean },
): Promise<void> {
  try {
    // Refuse a dense multi-line message before any network call (see message-layout.ts).
    assertReadableMessageLayout(text, { allowDense: options.allowDenseLayout })
    const result = await withKakaoClient(options, async (client) => {
      if (options.replyTo === undefined && !options.mention?.length) {
        return client.sendMessage(chatId, text)
      }

      const replyTo =
        options.replyTo === undefined ? undefined : await resolveReplyTarget(client, chatId, options.replyTo)
      return client.sendMessage(chatId, text, {
        ...(replyTo ? { replyTo } : {}),
        ...(options.mention?.length ? { mentions: options.mention } : {}),
      })
    })
    console.log(formatOutput(result, options.pretty))
    if (!result.success) {
      process.exit(1)
    }
  } catch (error) {
    handleError(error as Error)
  }
}

async function editAction(
  chatId: string,
  logId: string,
  text: string,
  options: { account?: string; pretty?: boolean; allowDenseLayout?: boolean },
): Promise<void> {
  try {
    assertReadableMessageLayout(text, { allowDense: options.allowDenseLayout })
    const result = await withKakaoClient(options, (client) => client.editMessage(chatId, logId, text))
    console.log(formatOutput(result, options.pretty))
    if (!result.success) {
      process.exit(1)
    }
  } catch (error) {
    handleError(error as Error)
  }
}

async function unreadAction(
  chatId: string,
  logIds: string[],
  options: { account?: string; pretty?: boolean; enterRoom?: boolean },
): Promise<void> {
  try {
    if (!options.enterRoom) {
      throw new Error('Reading watermarks sends CHATONROOM (room entry). Pass --enter-room to confirm.')
    }
    const result = await withKakaoClient(options, (client) => client.getReadState(chatId, logIds, { enterRoom: true }))
    console.log(formatOutput(result, options.pretty))
  } catch (error) {
    handleError(error as Error)
  }
}

// A reply attachment needs the source message's author, text, and type — not
// just its log_id — so we look it up in the chat's recent history.
async function resolveReplyTarget(
  client: {
    getMessages: (chatId: string, opts: { count: number }) => Promise<KakaoMessage[]>
  },
  chatId: string,
  logId: string,
): Promise<KakaoReplyTarget> {
  const messages = await client.getMessages(chatId, { count: 100 })
  const source = messages.find((m) => m.log_id === logId)
  if (!source) {
    throw new Error(`Reply target log-id ${logId} not found in the latest 100 messages of chat ${chatId}`)
  }
  return {
    log_id: source.log_id,
    author_id: source.author_id,
    message: source.message,
    type: source.type,
  }
}

type UploadKind = 'auto' | 'photo' | 'video' | 'audio' | 'file' | 'multi'

async function uploadAction(
  chatId: string,
  filePaths: string[],
  options: { account?: string; pretty?: boolean; as?: UploadKind; mime?: string; maxFileBytes?: string },
): Promise<void> {
  try {
    const inputs = filePaths.map((p) => ({ data: readFileSync(resolve(p)), filename: basename(p), mime: options.mime }))
    const maxFileBytes = options.maxFileBytes === undefined ? undefined : Number(options.maxFileBytes)
    if (maxFileBytes !== undefined && (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0))
      throw new Error('--max-file-bytes must be a positive integer')
    for (const input of inputs) {
      if (input.data.byteLength === 0) throw new Error(`File ${input.filename} is empty`)
      if (maxFileBytes !== undefined && input.data.byteLength > maxFileBytes)
        throw new Error(
          `File ${input.filename} has ${input.data.byteLength} bytes, exceeding the caller limit of ${maxFileBytes} bytes`,
        )
    }
    const allPhotos = inputs.every((file) =>
      (file.mime ?? guessMimeFromFilename(file.filename)).toLowerCase().startsWith('image/'),
    )
    const requestedKind = options.as ?? 'auto'
    const kind: UploadKind = requestedKind === 'auto' && inputs.length > 1 && allPhotos ? 'multi' : requestedKind
    if (kind === 'multi' && (inputs.length < 2 || !allPhotos))
      throw new Error('--as=multi requires 2 or more image files; use --as=file for multiple documents')
    if (inputs.length > 1 && !['auto', 'file', 'multi'].includes(kind))
      throw new Error(`--as=${kind} accepts exactly one file path`)

    const result = await withKakaoClient(options, async (client) => {
      if (inputs.length > 1 && (kind === 'file' || kind === 'auto')) {
        return client.sendFiles(chatId, inputs, { maxFileBytes })
      }
      if (kind === 'multi') {
        return client.sendMultiPhoto(chatId, inputs)
      }

      if (filePaths.length !== 1) {
        throw new Error(`--as=${kind} accepts exactly one file path`)
      }
      const { data, filename } = inputs[0]!

      switch (kind) {
        case 'auto':
          return client.sendAttachment(chatId, data, filename, options.mime)
        case 'photo':
          return client.sendPhoto(chatId, data, filename)
        case 'video':
          return client.sendVideo(chatId, data, filename)
        case 'audio':
          return client.sendAudio(chatId, data, filename)
        case 'file':
          return client.sendFile(chatId, data, filename, options.mime ?? 'application/octet-stream')
      }
    })
    console.log(formatOutput(result, options.pretty))
    if (!result.success) {
      process.exit(1)
    }
  } catch (error) {
    handleError(error as Error)
  }
}

async function markReadAction(
  chatId: string,
  logId: string,
  options: { account?: string; linkId?: string; pretty?: boolean },
): Promise<void> {
  try {
    const result = await withKakaoClient(options, (client) =>
      client.markRead(chatId, logId, options.linkId !== undefined ? { linkId: options.linkId } : undefined),
    )
    console.log(formatOutput(result, options.pretty))
    if (!result.success) {
      process.exit(1)
    }
  } catch (error) {
    handleError(error as Error)
  }
}

export const messageCommand = new Command('message')
  .description('KakaoTalk message commands')
  .addCommand(
    new Command('list')
      .description('List messages in a chat room')
      .argument('<chat-id>', 'Chat room ID')
      .option('--account <id>', 'Use a specific KakaoTalk account')
      .option('-n, --count <number>', 'Number of messages to fetch', '20')
      .option('--from <log-id>', 'Fetch messages starting from this log ID')
      .option('--pretty', 'Pretty print JSON output')
      .action(listAction),
  )
  .addCommand(
    new Command('send')
      .description('Send a text message to a chat room')
      .argument('<chat-id>', 'Chat room ID')
      .argument('<text>', 'Message text')
      .option('--account <id>', 'Use a specific KakaoTalk account')
      .option('--reply-to <log-id>', 'Send as a quoted reply to this message log ID')
      .option(
        '--mention <user-id>',
        'Mention a room member whose @nickname appears in the text (repeatable)',
        (value: string, previous: string[] = []) => [...previous, value],
      )
      .option('--allow-dense-layout', 'Send even if the opening line or list items lack a blank line before them')
      .option('--pretty', 'Pretty print JSON output')
      .action(sendAction),
  )
  .addCommand(
    new Command('edit')
      .description('Edit a text message (your own messages only, within 24h)')
      .argument('<chat-id>', 'Chat room ID')
      .argument('<log-id>', 'Log ID of the message to edit')
      .argument('<text>', 'New message text')
      .option('--account <id>', 'Use a specific KakaoTalk account')
      .option('--allow-dense-layout', 'Edit even if the opening line or list items lack a blank line before them')
      .option('--pretty', 'Pretty print JSON output')
      .action(editAction),
  )
  .addCommand(
    new Command('unread')
      .description(
        'Show how many members have not read a message (the "1" next to it). Sends CHATONROOM, so --enter-room is required',
      )
      .argument('<chat-id>', 'Chat room ID')
      .argument('[log-ids...]', 'Log IDs to check (default: the last message in the room)')
      .option('--enter-room', 'Confirm sending CHATONROOM (room entry) to read member watermarks')
      .option('--account <id>', 'Use a specific KakaoTalk account')
      .option('--pretty', 'Pretty print JSON output')
      .action(unreadAction),
  )
  .addCommand(
    new Command('upload')
      .description(
        'Send attachments. Multiple images use a gallery; multiple documents or --as=file use sequential files with one result per file.',
      )
      .argument('<chat-id>', 'Chat room ID')
      .argument('<file-paths...>', 'One or more file paths')
      .option('--account <id>', 'Use a specific KakaoTalk account')
      .addOption(
        new Option('--as <kind>', 'Force an attachment kind').choices([
          'auto',
          'photo',
          'video',
          'audio',
          'file',
          'multi',
        ]),
      )
      .option('--mime <type>', 'Override MIME type (otherwise inferred from filename)')
      .option('--max-file-bytes <bytes>', 'Optional caller size limit per file, checked before sending any file')
      .option('--pretty', 'Pretty print JSON output')
      .action(uploadAction),
  )
  .addCommand(
    new Command('mark-read')
      .description('Mark messages in a chat room as read up to a given log ID')
      .argument('<chat-id>', 'Chat room ID')
      .argument('<log-id>', 'Watermark log ID (mark messages up to and including this log_id as read)')
      .option('--account <id>', 'Use a specific KakaoTalk account')
      .option('--link-id <li>', 'Open-chat link ID (REQUIRED for open chats / 오픈채팅)')
      .option('--pretty', 'Pretty print JSON output')
      .action(markReadAction),
  )
