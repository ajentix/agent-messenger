import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

import { Command } from 'commander'

import { handleError } from '@/shared/utils/error-handler'
import { formatOutput } from '@/shared/utils/output'

import { TeamsClient } from '../client'
import { TeamsCredentialManager } from '../credential-manager'
import { resolveFormat } from './format'

export async function listAction(options: { pretty?: boolean }): Promise<void> {
  try {
    const credManager = new TeamsCredentialManager()
    const cred = await credManager.getTokenWithExpiry()

    if (!cred) {
      console.log(formatOutput({ error: 'Not authenticated. Run "auth extract" first.' }, options.pretty))
      process.exit(1)
    }

    const client = await new TeamsClient().login({
      token: cred.token,
      tokenExpiresAt: cred.tokenExpiresAt,
      accountType: cred.accountType,
      region: cred.region,
    })
    const chats = await client.listChats()

    const output = chats.map((chat) => ({
      id: chat.id,
      type: chat.type,
      topic: chat.topic,
      last_message: chat.last_message,
      last_message_at: chat.last_message_at,
    }))

    console.log(formatOutput(output, options.pretty))
  } catch (error) {
    handleError(error as Error)
  }
}

export async function historyAction(
  chatId: string,
  options: { limit?: number; pretty?: boolean; page?: boolean; cursor?: string; includeSystem?: boolean },
): Promise<void> {
  try {
    const credManager = new TeamsCredentialManager()
    const cred = await credManager.getTokenWithExpiry()

    if (!cred) {
      console.log(formatOutput({ error: 'Not authenticated. Run "auth extract" first.' }, options.pretty))
      process.exit(1)
    }

    const client = await new TeamsClient().login({
      token: cred.token,
      tokenExpiresAt: cred.tokenExpiresAt,
      accountType: cred.accountType,
      region: cred.region,
    })
    const limit = options.limit && options.limit > 0 ? options.limit : 50
    const page =
      options.page || options.cursor
        ? await client.getChatMessagesPage(chatId, limit, options.cursor, { includeSystem: options.includeSystem })
        : undefined
    const messages =
      page?.messages ?? (await client.getChatMessages(chatId, limit, { includeSystem: options.includeSystem }))

    const output = messages.map((msg) => ({
      ...msg,
      raw: undefined,
      id: msg.id,
      author: msg.author.displayName,
      content: msg.content,
      html: msg.html,
      files: msg.files,
      timestamp: msg.timestamp,
    }))

    console.log(formatOutput(page ? { messages: output, next_cursor: page.next_cursor } : output, options.pretty))
  } catch (error) {
    handleError(error as Error)
  }
}

export async function getAction(chatId: string, messageId: string, options: { pretty?: boolean }): Promise<void> {
  try {
    const credManager = new TeamsCredentialManager()
    const cred = await credManager.getTokenWithExpiry()

    if (!cred) {
      console.log(formatOutput({ error: 'Not authenticated. Run "auth extract" first.' }, options.pretty))
      process.exit(1)
    }

    const client = await new TeamsClient().login({
      token: cred.token,
      tokenExpiresAt: cred.tokenExpiresAt,
      accountType: cred.accountType,
      region: cred.region,
    })
    const message = await client.getChatMessage(chatId, messageId)

    const output = {
      id: message.id,
      author: message.author.displayName,
      content: message.content,
      html: message.html,
      files: message.files,
      timestamp: message.timestamp,
    }

    console.log(formatOutput(output, options.pretty))
  } catch (error) {
    handleError(error as Error)
  }
}

export async function sendAction(
  chatId: string,
  content = '',
  options: { pretty?: boolean; format?: string; files?: string[]; file?: string[]; quote?: string },
): Promise<void> {
  const format = resolveFormat(options.format, options.pretty)
  // Commander names a repeatable --file option `file`.
  options = { ...options, files: options.files ?? options.file }

  try {
    const credManager = new TeamsCredentialManager()
    const cred = await credManager.getTokenWithExpiry()

    if (!cred) {
      console.log(formatOutput({ error: 'Not authenticated. Run "auth extract" first.' }, options.pretty))
      process.exit(1)
    }

    const client = await new TeamsClient().login({
      token: cred.token,
      tokenExpiresAt: cred.tokenExpiresAt,
      accountType: cred.accountType,
      region: cred.region,
    })
    const message =
      options.files?.length || options.quote
        ? await client.sendChatMessage(chatId, content, format, {
            ...(options.files?.length ? { files: options.files } : {}),
            ...(options.quote ? { quote: options.quote } : {}),
          })
        : await client.sendChatMessage(chatId, content, format)

    const output = {
      ...message,
      raw: undefined,
      id: message.id,
      content: message.content,
      timestamp: message.timestamp,
    }

    console.log(formatOutput(output, options.pretty))
  } catch (error) {
    handleError(error as Error)
  }
}

export async function editAction(
  chatId: string,
  messageId: string,
  content: string | undefined,
  options: {
    pretty?: boolean
    format?: string
    dropImages?: boolean
    images?: string[]
    image?: string[]
    mediaHost?: string
  },
): Promise<void> {
  const format = resolveFormat(options.format, options.pretty)

  try {
    const credManager = new TeamsCredentialManager()
    const cred = await credManager.getTokenWithExpiry()

    if (!cred) {
      console.log(formatOutput({ error: 'Not authenticated. Run "auth extract" first.' }, options.pretty))
      process.exit(1)
    }

    const client = await new TeamsClient().login({
      token: cred.token,
      tokenExpiresAt: cred.tokenExpiresAt,
      accountType: cred.accountType,
      region: cred.region,
    })
    const images = await Promise.all(
      // Commander names a repeatable --image option `image`.
      (options.images ?? options.image ?? []).map(async (path) => ({
        data: await readFile(path),
        filename: basename(path),
      })),
    )
    // Like the Teams app, an edit keeps the images already in the message unless asked not to.
    // Without new content it keeps the text and mentions too, so images can be added on their own.
    const message = await client.editChatMessage(chatId, messageId, content, format, {
      keepImages: !options.dropImages,
      ...(images.length > 0 ? { images } : {}),
      ...(options.mediaHost ? { mediaHost: options.mediaHost } : {}),
    })

    const output = {
      ...message,
      raw: undefined,
      id: message.id,
      content: message.content,
      timestamp: message.timestamp,
    }

    console.log(formatOutput(output, options.pretty))
  } catch (error) {
    handleError(error as Error)
  }
}

export const chatCommand = new Command('chat')
  .description('Chat commands (1:1, group, and self chats)')
  .addCommand(
    new Command('list')
      .description('List 1:1, group, and self chats')
      .option('--pretty', 'Pretty print JSON output')
      .action(listAction),
  )
  .addCommand(
    new Command('history')
      .description('Get chat message history')
      .argument('<chat-id>', 'Chat ID')
      .option('--limit <n>', 'Number of messages to fetch', '50')
      .option('--page', 'Return one archive page with next_cursor')
      .option('--cursor <url>', 'Continue from a returned archive cursor')
      .option('--include-system', 'Include membership, call and other system records')
      .option('--pretty', 'Pretty print JSON output')
      .action((chatId, options) => {
        return historyAction(chatId, {
          limit: parseInt(options.limit, 10),
          pretty: options.pretty,
          page: options.page,
          cursor: options.cursor,
          includeSystem: options.includeSystem,
        })
      }),
  )
  .addCommand(
    new Command('get')
      .description('Get a single chat message')
      .argument('<chat-id>', 'Chat ID')
      .argument('<message-id>', 'Message ID')
      .option('--pretty', 'Pretty print JSON output')
      .action(getAction),
  )
  .addCommand(
    new Command('send')
      .description('Send a message to a chat')
      .argument('<chat-id>', 'Chat ID')
      .argument('[content]', 'Message content (optional when using --file)')
      .option('--format <format>', 'Message format: text, markdown, or html', 'text')
      .option(
        '--file <path>',
        'Attach a file (repeatable)',
        (value: string, previous: string[]) => [...previous, value],
        [],
      )
      .option('--quote <message-id>', 'Quote a message in the same chat, as a Teams reply does')
      .option('--pretty', 'Pretty print JSON output')
      .action(sendAction),
  )
  .addCommand(
    new Command('edit')
      .description('Edit a message in a chat (your own messages only)')
      .argument('<chat-id>', 'Chat ID')
      .argument('<message-id>', 'Message ID')
      .argument('[content]', 'New message content (omit to keep the current text and mentions)')
      .option('--format <format>', 'Message format: text, markdown, or html', 'text')
      .option('--drop-images', 'Remove the images already in the message instead of keeping them')
      .option(
        '--image <path>',
        'Add a PNG, JPEG or GIF image below the message (repeatable)',
        (value: string, previous: string[]) => [...previous, value],
        [],
      )
      .option('--media-host <url>', 'Teams media gateway for new images, when the chat has none stored yet')
      .option('--pretty', 'Pretty print JSON output')
      .action(editAction),
  )
