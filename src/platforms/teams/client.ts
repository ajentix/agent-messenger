import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'

import { escapeHtml, markdownToHtml } from '@/shared/utils/markdown-to-html'

import { SUBSTRATE_SEARCH_URL } from './app-config'
import {
  appendAttachmentTags,
  attachmentIdFromETag,
  messageReferenceAttachment,
  prependQuoteTag,
  referenceAttachments,
} from './attachments'
import { TeamsCredentialManager } from './credential-manager'
import { TeamsGraph, graphMessage, graphTeam, graphChannel, graphUser, graphFile, segment, messageText } from './graph'
import { sanitizeTeamsHtml } from './html-sanitizer'
import { TeamsTokenProvider } from './token-provider'
import type {
  TeamsAccountType,
  TeamsAttachment,
  TeamsChannel,
  TeamsChat,
  TeamsChatType,
  TeamsFile,
  TeamsMessage,
  TeamsMessageFormat,
  TeamsSendMessageOptions,
  TeamsRegion,
  TeamsSearchResult,
  TeamsTeam,
  TeamsUser,
} from './types'
import { TeamsError } from './types'

interface RateLimitBucket {
  remaining: number
  resetAt: number
}

type JsonRecord = Record<string, unknown>

const PERSONAL_MSG_API_BASE = 'https://msgapi.teams.live.com/v1'
const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 100
const DEFAULT_REGION: TeamsRegion = 'amer'
const REGIONS: TeamsRegion[] = ['amer', 'emea', 'apac']
const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0'
const MAX_MESSAGE_FILES = 10
const MAX_ATTACHMENT_SIZE = 250 * 1024 * 1024
const SMALL_UPLOAD_LIMIT = 4 * 1024 * 1024
const UPLOAD_CHUNK_SIZE = 10 * 320 * 1024
const CHAT_FILES_FOLDER = 'Microsoft Teams Chat Files'

interface DriveItemMetadata {
  id?: string
  name?: string
  eTag?: string
  webUrl?: string
  webDavUrl?: string
  size?: number
  parentReference?: { driveId?: string }
}

interface ChatRecipient {
  identifier: string
  invite: { objectId: string } | { email: string }
}

function reactionUnicode(emoji: string): string {
  const aliases: Record<string, string> = {
    like: '👍',
    heart: '❤️',
    laugh: '😆',
    surprised: '😮',
    sad: '😢',
    angry: '😠',
  }
  return Object.hasOwn(aliases, emoji) ? aliases[emoji] : emoji
}

// Personal (Teams for Life) skypetokens carry a consumer `skypeid` (e.g.
// "live:..." or "8:live:..."); work/school tokens carry an org identity. Used
// only to guess the account type when a caller logs in with a bare token.
function isPersonalToken(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as {
      skypeid?: string
    }
    const skypeId = payload.skypeid ?? ''
    return skypeId.includes('live:') || skypeId.startsWith('8:live:')
  } catch {
    return false
  }
}

function stripHtml(content: string | undefined): string | undefined {
  if (content === undefined) return undefined
  const stripped = content.replace(/<[^>]*>/g, '')
  return stripped
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function parsePropertyArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {}
  }
  return []
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringFrom(record: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function recordFrom(record: JsonRecord, keys: string[]): JsonRecord | undefined {
  for (const key of keys) {
    const value = record[key]
    if (isRecord(value)) return value
  }
  return undefined
}

function arrayFrom(record: JsonRecord, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function propertyValue(record: JsonRecord, names: string[]): string | undefined {
  const properties = arrayFrom(record, ['Properties', 'properties'])
  const normalized = names.map((name) => name.toLowerCase())
  for (const property of properties) {
    if (!isRecord(property)) continue
    const name = stringFrom(property, ['Name', 'name', 'Key', 'key'])
    if (!name || !normalized.includes(name.toLowerCase())) continue
    const value = property.Value ?? property.value
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function resultString(record: JsonRecord, keys: string[]): string | undefined {
  return stringFrom(record, keys) ?? propertyValue(record, keys)
}

function parseSubstrateResult(value: unknown): TeamsSearchResult | null {
  if (!isRecord(value)) return null
  const source = recordFrom(value, ['Source', 'source']) ?? value
  const author = recordFrom(source, ['Author', 'author', 'From', 'from'])
  const email = author && recordFrom(author, ['EmailAddress', 'emailAddress'])
  const extensions = recordFrom(source, ['Extensions'])
  const id = resultString(source, ['InternetMessageId', 'MessageId', 'id', 'Id', 'ReferenceId'])
  const channelId = resultString(source, ['channel_id', 'ChannelId', 'ClientThreadId', 'ThreadId', 'ConversationId'])
  if (!id || !channelId) return null
  const htmlContent = resultString(source, ['content', 'Content'])
  const preview = resultString(source, ['Preview', 'Summary'])
  const content =
    htmlContent !== undefined
      ? messageText(htmlContent)
      : (preview ?? messageText(resultString(value, ['HitHighlightedSummary']) ?? ''))
  return {
    id,
    channel_id: channelId,
    content,
    author: {
      id:
        (extensions && stringFrom(extensions, ['SkypeSpaces_ConversationPost_Extension_FromSkypeInternalId'])) ??
        (author && stringFrom(author, ['id', 'Id', 'ObjectId'])) ??
        propertyValue(source, ['AuthorId']) ??
        '',
      displayName:
        (email && stringFrom(email, ['Name'])) ??
        (author && stringFrom(author, ['displayName', 'DisplayName', 'Name'])) ??
        propertyValue(source, ['AuthorDisplayName', 'Author']) ??
        'Unknown',
    },
    thread_id:
      resultString(source, ['ClientConversationId'])?.split(';messageid=')[1] ??
      resultString(source, ['thread_id', 'ClientConversationId', 'ThreadId']),
    team_name: resultString(source, ['team_name', 'TeamName']),
    channel_name: resultString(source, ['channel_name', 'ChannelName']),
    timestamp: resultString(source, ['timestamp', 'Timestamp', 'DateTimeSent', 'LastModifiedTime']) ?? '',
    permalink: resultString(source, ['permalink', 'Permalink', 'WebUrl', 'Url']),
    raw: value,
  }
}

function parseSubstrateResults(data: unknown): TeamsSearchResult[] {
  if (!isRecord(data)) return []
  const results: TeamsSearchResult[] = []
  for (const entitySet of arrayFrom(data, ['EntitySets', 'entitySets'])) {
    if (!isRecord(entitySet)) continue
    for (const resultSet of arrayFrom(entitySet, ['ResultSets', 'resultSets'])) {
      if (!isRecord(resultSet)) continue
      for (const rawResult of arrayFrom(resultSet, ['Results', 'results'])) {
        const result = parseSubstrateResult(rawResult)
        if (result) results.push(result)
      }
    }
  }
  return results
}

function validateSearchLimit(value: number | undefined): number {
  if (value === undefined) return 20
  if (!Number.isInteger(value) || value < 1) {
    throw new TeamsError('Search limit must be a positive integer.', 'invalid_pagination')
  }
  return value
}

function validateSearchFrom(value: number | undefined): number {
  if (value === undefined) return 0
  if (!Number.isInteger(value) || value < 0) {
    throw new TeamsError('Search from offset must be a non-negative integer.', 'invalid_pagination')
  }
  return value
}

function isSharePointOrOneDriveUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    const normalizedHost = hostname.toLowerCase()
    return (
      normalizedHost.includes('sharepoint.com') ||
      normalizedHost.includes('-my.sharepoint') ||
      normalizedHost === '1drv.ms' ||
      normalizedHost.endsWith('.1drv.ms') ||
      normalizedHost === 'onedrive.live.com' ||
      normalizedHost.endsWith('.onedrive.live.com')
    )
  } catch {
    return false
  }
}

// Only these hosts receive the Skype token on a raw download fetch. Teams file
// metadata can carry arbitrary URLs, so we never attach credentials to a host
// outside this allowlist — that would leak the token to a third party.
function isTrustedSkypeDownloadHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return (
      host === 'teams.microsoft.com' ||
      host.endsWith('.teams.microsoft.com') ||
      host.endsWith('.asm.skype.com') ||
      host.endsWith('.asyncgw.teams.microsoft.com') ||
      host === 'substrate.office.com' ||
      host.endsWith('.substrate.office.com')
    )
  } catch {
    return false
  }
}

function getFileDownloadSource(file: TeamsFile): { route: 'graph' | 'skype'; url: string } {
  const shareUrl = [file.sharepoint_url, file.url, file.object_url].find((candidate): candidate is string =>
    Boolean(candidate && isSharePointOrOneDriveUrl(candidate)),
  )
  if (shareUrl) return { route: 'graph', url: shareUrl }

  const directUrl = file.object_url ?? file.url
  if (!directUrl) {
    throw new TeamsError(`File has no downloadable URL: ${file.id}`, 'file_url_missing')
  }
  if (!isTrustedSkypeDownloadHost(directUrl)) {
    throw new TeamsError(`Refusing to download ${file.id} from an untrusted host: ${directUrl}`, 'file_url_untrusted')
  }
  return { route: 'skype', url: directUrl }
}

async function readDownloadResponse(response: Response, codePrefix: string): Promise<Buffer> {
  if (!response.ok) {
    throw new TeamsError(`File download failed with HTTP ${response.status}`, `${codePrefix}_${response.status}`)
  }

  return Buffer.from(await response.arrayBuffer())
}

function formatContent(content: string, format: TeamsMessageFormat): string {
  if (format === 'html') return sanitizeTeamsHtml(content)
  return format === 'markdown' ? markdownToHtml(content) : escapeHtml(content).replace(/\r?\n/g, '<br>')
}

// groupId => Teams/channel thread (handled by listTeams). "48:notes"/
// streamofnotes => the user's self ("to me") chat. Anything else without a
// non-chat threadType is a normal 1:1 (no topic) or group (has topic) chat.
function classifyChat(
  id: string,
  tp?: { topic?: string; threadType?: string; groupId?: string },
): TeamsChatType | null {
  if (tp?.groupId) return null
  if (id === '48:notes' || tp?.threadType === 'streamofnotes') return 'self'
  if (tp?.threadType && tp.threadType !== 'chat') return null
  return tp?.topic ? 'group' : 'oneOnOne'
}

export class TeamsClient {
  private token: string | null = null
  private tokenExpiresAt?: Date
  private isPersonalAccount: boolean = false
  private region: TeamsRegion = DEFAULT_REGION
  private regionDiscovered: boolean = false
  private tokenProvider?: TeamsTokenProvider
  private buckets: Map<string, RateLimitBucket> = new Map()
  private globalRateLimitUntil: number = 0

  constructor(private credManager: TeamsCredentialManager = new TeamsCredentialManager()) {}

  async login(credentials?: {
    token: string
    tokenExpiresAt?: string
    accountType?: TeamsAccountType
    region?: TeamsRegion
  }): Promise<this> {
    if (credentials) {
      if (!credentials.token) {
        throw new TeamsError('Token is required', 'missing_token')
      }
      this.token = credentials.token
      if (credentials.tokenExpiresAt) {
        this.tokenExpiresAt = new Date(credentials.tokenExpiresAt)
      }
      this.isPersonalAccount = credentials.accountType
        ? credentials.accountType === 'personal'
        : isPersonalToken(credentials.token)
      if (credentials.region) {
        this.region = credentials.region
        this.regionDiscovered = true
      }
      if (credentials.accountType) {
        this.getTokenProvider().bindAccount(credentials.accountType)
      }
      return this
    }

    const { ensureTeamsAuth } = await import('./ensure-auth')
    await ensureTeamsAuth()
    const creds = await this.credManager.getTokenWithExpiry()
    if (!creds) {
      throw new TeamsError(
        'No Teams credentials found. Make sure Microsoft Teams is logged in via the desktop app or a supported Chromium browser.',
        'no_credentials',
      )
    }
    return this.login({
      token: creds.token,
      tokenExpiresAt: creds.tokenExpiresAt,
      accountType: creds.accountType,
      region: creds.region,
    })
  }

  getRegion(): TeamsRegion {
    return this.region
  }

  getToken(): string {
    return this.ensureAuth()
  }

  getAccountType(): TeamsAccountType {
    return this.isPersonalAccount ? 'personal' : 'work'
  }

  async getIdToken(): Promise<string | null> {
    const { TeamsTokenExtractor } = await import('./token-extractor')
    const extractor = new TeamsTokenExtractor()
    return extractor.extractIdToken(this.getAccountType())
  }

  private ensureAuth(): string {
    if (this.token === null) {
      throw new TeamsError('Not authenticated. Call .login() first.', 'not_authenticated')
    }
    return this.token
  }

  private isTokenExpired(): boolean {
    if (!this.tokenExpiresAt) {
      return false
    }
    return this.tokenExpiresAt.getTime() < Date.now()
  }

  private getBucketKey(method: string, path: string): string {
    const normalized = path
      .replace(/\/teams\/[^/]+/, '/teams/{team_id}')
      .replace(/\/channels\/[^/]+/, '/channels/{channel_id}')
      .replace(/\/messages\/[^/]+/, '/messages/{message_id}')
      .replace(/\/users\/[^/]+/, '/users/{user_id}')
      .replace(/\/members\/[^/]+/, '/members/{member_id}')
    return `${method}:${normalized}`
  }

  private async waitForRateLimit(bucketKey: string): Promise<void> {
    const now = Date.now()

    if (this.globalRateLimitUntil > now) {
      await this.sleep(this.globalRateLimitUntil - now)
    }

    const bucket = this.buckets.get(bucketKey)
    if (bucket && bucket.remaining === 0 && bucket.resetAt * 1000 > now) {
      await this.sleep(bucket.resetAt * 1000 - now)
    }
  }

  private updateBucket(bucketKey: string, response: Response): void {
    const remaining = response.headers.get('X-RateLimit-Remaining')
    const reset = response.headers.get('X-RateLimit-Reset')

    if (remaining !== null && reset !== null) {
      this.buckets.set(bucketKey, {
        remaining: parseInt(remaining, 10),
        resetAt: parseFloat(reset),
      })
    }
  }

  private async handleRateLimitResponse(response: Response): Promise<number> {
    const retryAfter = response.headers.get('Retry-After')
    const waitMs = parseFloat(retryAfter || '1') * 1000

    this.globalRateLimitUntil = Date.now() + waitMs
    await this.sleep(waitMs)
    return waitMs
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private getMsgApiBase(): string {
    if (this.isPersonalAccount) return PERSONAL_MSG_API_BASE
    return `https://${this.region}.ng.msg.teams.microsoft.com/v1`
  }

  private async discoverRegion(): Promise<void> {
    if (this.isPersonalAccount) {
      this.regionDiscovered = true
      return
    }

    const token = this.ensureAuth()

    for (const region of REGIONS) {
      try {
        const response = await fetch(`https://${region}.ng.msg.teams.microsoft.com/v1/users/ME/properties`, {
          headers: {
            'X-Skypetoken': token,
          },
        })

        if (response.ok || response.status !== 403) {
          this.region = region
          break
        }
      } catch {}
    }

    this.regionDiscovered = true
  }

  private async request<T>(method: string, path: string, body?: unknown, baseUrl?: string): Promise<T> {
    if (this.isTokenExpired()) {
      throw new TeamsError('Token has expired. Run "auth login" or "auth extract" to refresh.', 'token_expired')
    }

    if (baseUrl === undefined && !this.regionDiscovered) {
      await this.discoverRegion()
    }

    const url = `${baseUrl ?? this.getMsgApiBase()}${path}`
    const bucketKey = this.getBucketKey(method, path)

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.waitForRateLimit(bucketKey)

      const headers: Record<string, string> = {
        'X-Skypetoken': this.ensureAuth(),
        'Content-Type': 'application/json',
      }

      const options: RequestInit = {
        method,
        headers,
      }

      if (body !== undefined) {
        options.body = JSON.stringify(body)
      }

      const response = await fetch(url, options)
      this.updateBucket(bucketKey, response)

      if (response.status === 429) {
        if (method === 'GET' && attempt < MAX_RETRIES) {
          await this.handleRateLimitResponse(response)
          continue
        }
        const errorBody = (await response.json().catch(() => null)) as {
          message?: string
        } | null
        throw new TeamsError(errorBody?.message || 'Rate limited', 'rate_limited')
      }

      if (method === 'GET' && response.status >= 500 && attempt < MAX_RETRIES) {
        await this.sleep(BASE_BACKOFF_MS * 2 ** attempt)
        continue
      }

      if (!response.ok) {
        const errorBody = (await response.json().catch(() => null)) as {
          message?: string
          code?: string | number
        } | null
        throw new TeamsError(
          errorBody?.message || `HTTP ${response.status}`,
          errorBody?.code?.toString() ?? `http_${response.status}`,
        )
      }

      if (response.status === 204) {
        return undefined as T
      }

      const text = await response.text()
      return (text.trim() ? JSON.parse(text) : undefined) as T
    }

    throw new TeamsError('Request failed after retries', 'max_retries')
  }

  async testAuth(): Promise<TeamsUser> {
    interface UserProperties {
      userDetails?: string
      primaryMemberName?: string
      locale?: string
    }
    const props = await this.request<UserProperties>('GET', '/users/ME/properties')
    const userDetails = props.userDetails ? JSON.parse(props.userDetails) : {}
    return {
      id: 'ME',
      displayName: userDetails.name || props.primaryMemberName || 'Teams User',
    }
  }

  async listTeams(): Promise<TeamsTeam[]> {
    interface Conversation {
      id: string
      threadProperties?: {
        groupId?: string
        spaceThreadTopic?: string
        productThreadType?: string
        threadType?: string
      }
    }
    interface ConversationsResponse {
      conversations: Conversation[]
    }
    const data = await this.request<ConversationsResponse>('GET', '/users/ME/conversations')

    const teamsMap = new Map<string, TeamsTeam>()
    for (const conv of data.conversations) {
      const tp = conv.threadProperties
      if (!tp?.groupId) continue
      if (!tp.productThreadType?.includes('Teams') && tp.threadType !== 'space') continue

      if (!teamsMap.has(tp.groupId)) {
        teamsMap.set(tp.groupId, {
          id: tp.groupId,
          name: tp.spaceThreadTopic || 'Unknown Team',
        })
      }
    }

    return Array.from(teamsMap.values())
  }

  // Graph carries team display names; Skype conversation topics name channels.
  async listJoinedTeams(): Promise<TeamsTeam[]> {
    return (await this.graph().collection('/me/joinedTeams')).map(graphTeam)
  }

  // Realtime messages only carry a conversation id; a channel's parent teamId
  // (== groupId) lives on the conversation, so the listener resolves it through
  // this channelId -> teamId map.
  async buildChannelTeamMap(): Promise<Map<string, string>> {
    interface Conversation {
      id: string
      threadProperties?: {
        groupId?: string
        productThreadType?: string
        threadType?: string
      }
    }
    interface ConversationsResponse {
      conversations: Conversation[]
    }
    const data = await this.request<ConversationsResponse>('GET', '/users/ME/conversations')

    const channelToTeam = new Map<string, string>()
    for (const conv of data.conversations ?? []) {
      const tp = conv.threadProperties
      if (!tp?.groupId) continue
      if (!tp.productThreadType?.includes('Teams') && tp.threadType !== 'space') continue
      channelToTeam.set(conv.id, tp.groupId)
    }

    return channelToTeam
  }

  async listChats(): Promise<TeamsChat[]> {
    interface ConversationMessage {
      content?: string
      composetime?: string
      originalarrivaltime?: string
    }
    interface Conversation {
      id: string
      threadProperties?: {
        topic?: string
        threadType?: string
        groupId?: string
      }
      lastMessage?: ConversationMessage
    }
    interface ConversationsResponse {
      conversations: Conversation[]
    }
    const data = await this.request<ConversationsResponse>(
      'GET',
      '/users/ME/conversations?view=msnp24Equivalent&pageSize=500',
    )

    const chats: TeamsChat[] = []
    for (const conv of data.conversations ?? []) {
      const type = classifyChat(conv.id, conv.threadProperties)
      if (!type) continue

      chats.push({
        id: conv.id,
        type,
        topic: conv.threadProperties?.topic,
        last_message: stripHtml(conv.lastMessage?.content),
        last_message_at: conv.lastMessage?.composetime ?? conv.lastMessage?.originalarrivaltime,
      })
    }

    return chats
  }

  async getChatMessagesPage(
    chatId: string,
    limit = 50,
    cursor?: string,
  ): Promise<{ messages: TeamsMessage[]; next_cursor?: string }> {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new TeamsError('Limit must be a positive integer.', 'invalid_pagination')
    const encodedChatId = encodeURIComponent(chatId)
    let path = `/users/ME/conversations/${encodedChatId}/messages?startTime=0&view=msnp24Equivalent&pageSize=${Math.min(limit, 100)}`
    if (cursor) {
      const url = new URL(cursor)
      if (
        url.origin !== new URL(this.getMsgApiBase()).origin ||
        !decodeURIComponent(url.pathname).endsWith(`/conversations/${chatId}/messages`)
      ) {
        throw new TeamsError('Untrusted message pagination URL.', 'untrusted_pagination')
      }
      path = url.pathname.replace(/^\/v1/, '') + url.search
    }
    const page = await this.request<{ messages: Array<Record<string, any>>; _metadata?: { backwardLink?: string } }>(
      'GET',
      path,
    )
    return {
      messages: (page.messages ?? []).map((raw) => ({
        id: raw.id,
        channel_id: chatId,
        author: { id: raw.from ?? '', displayName: raw.imdisplayname ?? 'Unknown' },
        content: raw.messagetype === 'Text' ? (raw.content ?? '') : messageText(raw.content ?? ''),
        timestamp: raw.composetime ?? raw.originalarrivaltime ?? '',
        raw_content: raw.content ?? '',
        content_type: raw.messagetype ?? '',
        mentions: parsePropertyArray(raw.properties?.mentions),
        attachments: parsePropertyArray(raw.properties?.files),
        raw,
      })),
      next_cursor: page._metadata?.backwardLink || undefined,
    }
  }

  async getChatMessages(chatId: string, limit = 50): Promise<TeamsMessage[]> {
    const messages: TeamsMessage[] = [],
      seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await this.getChatMessagesPage(chatId, limit - messages.length, cursor)
      messages.push(...page.messages.slice(0, limit - messages.length))
      if (page.messages.length === 0) break
      cursor = page.next_cursor
      if (cursor && seen.has(cursor)) throw new TeamsError('Repeated message pagination cursor.', 'repeated_pagination')
      if (cursor) seen.add(cursor)
    } while (cursor && messages.length < limit)
    return messages
  }

  async sendChatMessage(
    chatId: string,
    content: string,
    format: TeamsMessageFormat = 'text',
    options?: TeamsSendMessageOptions,
  ): Promise<TeamsMessage> {
    const files = options?.files ?? []
    this.validateMessageFiles(content, files)
    // Resolve the quoted message before uploading anything, so a wrong ID never leaves files behind.
    const quoted = options?.quote ? await this.findChatMessage(chatId, options.quote) : undefined
    if (files.length > 0 || quoted) {
      if (files.length > 0) await this.validateAttachmentFiles(files)
      const records: TeamsAttachment[] = []
      if (files.length > 0) {
        const recipients = await this.resolveChatRecipients(chatId)
        for (const filePath of files) records.push(await this.uploadChatFileResolved(filePath, recipients))
      }
      let html = appendAttachmentTags(content ? formatContent(content, format) : '', records)
      if (quoted) html = prependQuoteTag(html, quoted.id)
      const raw = await this.graph().request('POST', `/chats/${segment(chatId)}/messages`, {
        body: { contentType: 'html', content: html },
        attachments: [...(quoted ? [messageReferenceAttachment(quoted)] : []), ...referenceAttachments(records)],
      })
      return {
        ...graphMessage(raw, chatId),
        attachments: records,
        ...(quoted ? { quoted_message_id: quoted.id } : {}),
      }
    }

    interface SendResponse {
      OriginalArrivalTime?: number
    }
    const encodedChatId = encodeURIComponent(chatId)
    const response = await this.request<SendResponse>('POST', `/users/ME/conversations/${encodedChatId}/messages`, {
      content: formatContent(content, format),
      messagetype: 'RichText/Html',
      contenttype: 'text',
    })

    const arrivalTime = response?.OriginalArrivalTime
    return {
      id: arrivalTime ? String(arrivalTime) : '',
      channel_id: chatId,
      author: { id: 'ME', displayName: 'Me' },
      content,
      timestamp: arrivalTime ? new Date(arrivalTime).toISOString() : new Date().toISOString(),
    }
  }

  /** Find one message in a chat by ID through Chat Service, newest pages first. */
  async findChatMessage(chatId: string, messageId: string, maxPages = 5): Promise<TeamsMessage> {
    if (!/^\d+$/.test(messageId)) throw new TeamsError('Quoted message ID must be numeric.', 'quote_invalid_id')
    let cursor: string | undefined
    for (let page = 0; page < maxPages; page++) {
      const result = await this.getChatMessagesPage(chatId, 100, cursor)
      const found = result.messages.find((message) => message.id === messageId)
      if (found) {
        if (found.deleted_at || (found.raw as { properties?: { deletetime?: unknown } } | undefined)?.properties?.deletetime)
          throw new TeamsError('Quoted message was deleted.', 'quote_deleted')
        return found
      }
      if (!result.next_cursor) break
      cursor = result.next_cursor
    }
    throw new TeamsError('Quoted message was not found in this chat.', 'quote_not_found')
  }

  async editChatMessage(
    chatId: string,
    messageId: string,
    content: string,
    format: TeamsMessageFormat = 'text',
  ): Promise<TeamsMessage> {
    interface EditResponse {
      edittime?: string | number
    }
    const encodedChatId = encodeURIComponent(chatId)
    const encodedMessageId = encodeURIComponent(messageId)
    // Skype messaging backend requires skypeeditedid to duplicate the URL message id.
    const response = await this.request<EditResponse>(
      'PUT',
      `/users/ME/conversations/${encodedChatId}/messages/${encodedMessageId}`,
      {
        content: formatContent(content, format),
        messagetype: 'RichText/Html',
        contenttype: 'text',
        skypeeditedid: messageId,
      },
    )

    const editTime = response?.edittime
    return {
      id: messageId,
      channel_id: chatId,
      author: { id: 'ME', displayName: 'Me' },
      content,
      timestamp: editTime ? new Date(Number(editTime) || editTime).toISOString() : new Date().toISOString(),
    }
  }

  private graph(): TeamsGraph {
    return new TeamsGraph(() => this.getTokenProvider().getGraphToken())
  }

  private channelPath(teamId: string, channelId: string): string {
    return `/teams/${segment(teamId)}/channels/${segment(channelId)}`
  }

  private messagePath(teamId: string, channelId: string, messageId: string, rootMessageId?: string): string {
    return (
      this.channelPath(teamId, channelId) +
      '/messages/' +
      (rootMessageId ? `${segment(rootMessageId)}/replies/` : '') +
      segment(messageId)
    )
  }

  async getTeam(teamId: string): Promise<TeamsTeam> {
    return graphTeam(await this.graph().request('GET', `/teams/${segment(teamId)}`))
  }

  async listChannels(teamId: string): Promise<TeamsChannel[]> {
    return (await this.graph().collection(`/teams/${segment(teamId)}/channels`)).map((raw) => graphChannel(raw, teamId))
  }

  async getChannel(teamId: string, channelId: string): Promise<TeamsChannel> {
    return graphChannel(await this.graph().request('GET', this.channelPath(teamId, channelId)), teamId)
  }

  async sendMessage(
    teamId: string,
    channelId: string,
    content: string,
    rootMessageId?: string,
    format: TeamsMessageFormat = 'text',
    options?: TeamsSendMessageOptions,
  ): Promise<TeamsMessage> {
    const files = options?.files ?? []
    this.validateMessageFiles(content, files)
    const path =
      this.channelPath(teamId, channelId) + '/messages' + (rootMessageId ? `/${segment(rootMessageId)}/replies` : '')
    if (files.length > 0) {
      await this.validateAttachmentFiles(files)
      const records: TeamsAttachment[] = []
      const folder = await this.fileFolder(teamId, channelId)
      for (const filePath of files) records.push(await this.uploadDriveAttachment(folder.driveId, folder.id, filePath))
      const raw = await this.graph().request('POST', path, {
        body: { contentType: 'html', content: appendAttachmentTags(formatContent(content, format), records) },
        attachments: referenceAttachments(records),
      })
      return { ...graphMessage(raw, channelId, rootMessageId), attachments: records }
    }
    const raw = await this.graph().request('POST', path, {
      body: { contentType: 'html', content: formatContent(content, format) },
    })
    return graphMessage(raw, channelId, rootMessageId)
  }

  async getMessages(teamId: string, channelId: string, limit = 50): Promise<TeamsMessage[]> {
    const values = await this.graph().collection(
      this.channelPath(teamId, channelId) + `/messages?$top=${Math.min(limit, 50)}`,
      limit,
    )
    return values.map((raw) => graphMessage(raw, channelId))
  }

  async getThreadReplies(
    teamId: string,
    channelId: string,
    rootMessageId: string,
    limit = 50,
  ): Promise<TeamsMessage[]> {
    const values = await this.graph().collection(
      this.channelPath(teamId, channelId) + `/messages/${segment(rootMessageId)}/replies?$top=${Math.min(limit, 50)}`,
      limit,
    )
    return values.map((raw) => graphMessage(raw, channelId, rootMessageId))
  }

  async searchMessages(query: string, opts: { limit?: number; from?: number } = {}): Promise<TeamsSearchResult[]> {
    const size = validateSearchLimit(opts.limit)
    const from = validateSearchFrom(opts.from)
    const tokenProvider = this.getTokenProvider()
    const substrateToken = await tokenProvider.getSubstrateToken()
    const tenantId = await tokenProvider.getTenantId()
    const userId = await tokenProvider.getUserId()

    const response = await fetch(SUBSTRATE_SEARCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${substrateToken}`,
        'Content-Type': 'application/json',
        'X-Client-Flights': 'SearchV2Flight,SubstrateSearchFanoutFlight,lutmsearchmsg,TMSParseRefiningQueries',
        'X-Client-UI-Language': 'en-US',
        'x-anchormailbox': `Oid:${userId}@${tenantId}`,
      },
      body: JSON.stringify({
        cvid: randomUUID(),
        logicalId: randomUUID(),
        scenario: { Name: 'powerbar', Dimensions: [{ DimensionName: 'QueryType', DimensionValue: 'Messages' }] },
        entityRequests: [
          {
            entityType: 'Message',
            contentSources: ['Teams'],
            propertySet: 'Optimized',
            fields: [
              'Extension_SkypeSpaces_ConversationPost_Extension_FromSkypeInternalId_String',
              'Extension_SkypeSpaces_ConversationPost_Extension_ThreadType_String',
              'Extension_SkypeSpaces_ConversationPost_Extension_SkypeGroupId_String',
              'Extension_SkypeSpaces_ConversationPost_Extension_SenderTenantId_String',
            ],
            from,
            size,
            query: { queryString: query, displayQueryString: query },
          },
        ],
      }),
    })

    const data = (await response.json().catch(() => ({}))) as unknown
    if (!response.ok) {
      const message = isRecord(data)
        ? stringFrom(data, ['message', 'Message', 'error_description', 'error'])
        : undefined
      throw new TeamsError(message ?? `HTTP ${response.status}`, `substrate_${response.status}`)
    }

    return parseSubstrateResults(data)
  }

  private getTokenProvider(): TeamsTokenProvider {
    this.tokenProvider ??= new TeamsTokenProvider(this.credManager)
    return this.tokenProvider
  }

  async getMessage(
    teamId: string,
    channelId: string,
    messageId: string,
    rootMessageId?: string,
  ): Promise<TeamsMessage> {
    return graphMessage(
      await this.graph().request('GET', this.messagePath(teamId, channelId, messageId, rootMessageId)),
      channelId,
      rootMessageId,
    )
  }

  async deleteMessage(teamId: string, channelId: string, messageId: string, rootMessageId?: string): Promise<void> {
    // Resolve the exact team/channel/reply before writing to Chat Service, which
    // uses the existing Skype token instead of Graph's broader delete scope.
    const message = await this.getMessage(teamId, channelId, messageId, rootMessageId)
    if (message.id !== messageId)
      throw new TeamsError('Delete target did not match the message.', 'delete_target_mismatch')
    if (message.deleted_at) return
    const conversationId = rootMessageId ? `${channelId};messageid=${rootMessageId}` : channelId
    const result = await this.request<{ errorCode?: number | string } | undefined>(
      'DELETE',
      `/users/ME/conversations/${segment(conversationId)}/messages/${segment(messageId)}`,
    )
    if (result?.errorCode !== undefined && Number(result.errorCode) !== 0)
      throw new TeamsError(`Chat Service delete failed: ${result.errorCode}`, 'message_delete_failed')
  }

  async addReaction(
    teamId: string,
    channelId: string,
    messageId: string,
    emoji: string,
    rootMessageId?: string,
  ): Promise<void> {
    await this.graph().request('POST', this.messagePath(teamId, channelId, messageId, rootMessageId) + '/setReaction', {
      reactionType: reactionUnicode(emoji),
    })
  }

  async removeReaction(
    teamId: string,
    channelId: string,
    messageId: string,
    emoji: string,
    rootMessageId?: string,
  ): Promise<void> {
    await this.graph().request(
      'POST',
      this.messagePath(teamId, channelId, messageId, rootMessageId) + '/unsetReaction',
      { reactionType: reactionUnicode(emoji) },
    )
  }

  async listUsers(teamId: string): Promise<TeamsUser[]> {
    return (await this.graph().collection(`/teams/${segment(teamId)}/members`)).map(graphUser)
  }

  async getUser(userId: string): Promise<TeamsUser> {
    return graphUser(await this.graph().request('GET', `/users/${segment(userId)}`))
  }

  private validateMessageFiles(content: string, files: string[]): void {
    if (files.length > MAX_MESSAGE_FILES)
      throw new TeamsError(`A message can include at most ${MAX_MESSAGE_FILES} files.`, 'too_many_files')
    if (!content && files.length === 0)
      throw new TeamsError('Message content or at least one file is required.', 'empty_message')
  }

  private async validateAttachmentFile(filePath: string): Promise<number> {
    let info
    try {
      info = await stat(filePath)
    } catch {
      throw new TeamsError(`File not found: ${filePath}`, 'file_not_found')
    }
    if (!info.isFile()) throw new TeamsError(`Path is not a regular file: ${filePath}`, 'file_not_regular')
    if (info.size <= 0) throw new TeamsError(`File is empty: ${filePath}`, 'file_empty')
    if (info.size > MAX_ATTACHMENT_SIZE)
      throw new TeamsError(`File exceeds the 250 MiB limit: ${filePath}`, 'file_too_large')
    return info.size
  }

  private async validateAttachmentFiles(filePaths: string[]): Promise<void> {
    for (const filePath of filePaths) await this.validateAttachmentFile(filePath)
  }

  // Graph /chats/{id}/members needs Chat.Read-family scopes the Teams token
  // does not carry, so the roster comes from the chat service thread instead.
  private async resolveChatRecipients(chatId: string): Promise<ChatRecipient[]> {
    if (chatId === '48:notes') return []
    const me = await this.graph().request<{ id?: string }>('GET', '/me?$select=id')
    if (!me.id) throw new TeamsError('The signed-in user id is unavailable.', 'chat_member_unresolved')
    const thread = await this.request<{ id?: string; members?: Array<{ id?: string }> }>(
      'GET',
      `/threads/${segment(chatId)}`,
    )
    if (thread.id !== chatId || !Array.isArray(thread.members))
      throw new TeamsError('The chat roster did not match the target chat.', 'chat_member_unresolved')
    const recipients: ChatRecipient[] = []
    for (const member of thread.members) {
      const mri = typeof member.id === 'string' ? member.id : ''
      if (mri.startsWith('28:')) continue
      const objectId = mri.match(/^8:orgid:([0-9a-f-]{36})$/i)?.[1]
      if (!objectId)
        throw new TeamsError(`A chat member cannot be resolved: ${mri || 'unknown'}`, 'chat_member_unresolved')
      if (objectId.toLowerCase() === me.id.toLowerCase()) continue
      // A disabled account stays in the roster but makes the whole SharePoint invite fail
      // ("One or more users could not be resolved"). It cannot sign in, so it is skipped.
      const user = await this.graph().request<{ id?: string; accountEnabled?: boolean }>(
        'GET',
        `/users/${segment(objectId)}?$select=id,accountEnabled`,
      )
      if (user.id?.toLowerCase() !== objectId.toLowerCase())
        throw new TeamsError(`A chat member cannot be resolved: ${mri}`, 'chat_member_unresolved')
      if (user.accountEnabled === false) continue
      recipients.push({ identifier: objectId, invite: { objectId } })
    }
    return recipients
  }

  private async inviteChatRecipients(driveId: string, itemId: string, recipients: ChatRecipient[]): Promise<void> {
    if (recipients.length === 0) return
    await this.graph().request('POST', `/drives/${segment(driveId)}/items/${segment(itemId)}/invite`, {
      requireSignIn: true,
      sendInvitation: false,
      roles: ['read'],
      recipients: recipients.map((recipient) => recipient.invite),
    })
  }

  private async getDriveItem(driveId: string, itemId: string): Promise<DriveItemMetadata> {
    return this.graph().request<DriveItemMetadata>(
      'GET',
      `/drives/${segment(driveId)}/items/${segment(itemId)}?$select=id,name,eTag,webUrl,webDavUrl,size,parentReference`,
    )
  }

  private async uploadDriveAttachment(
    driveId: string,
    folderId: string,
    filePath: string,
    folderPath?: string,
  ): Promise<TeamsAttachment> {
    const bytes = await readFile(filePath)
    const name = basename(filePath)
    const itemId = await this.uploadDriveBytes(driveId, folderId, name, bytes, folderPath)
    const item = await this.getDriveItem(driveId, itemId)
    if (!item.id || !item.name || !item.eTag)
      throw new TeamsError('Uploaded drive item metadata is incomplete.', 'attachment_metadata_missing')
    const contentUrl = item.webDavUrl ?? item.webUrl
    if (!contentUrl) throw new TeamsError('Uploaded drive item has no web URL.', 'attachment_url_missing')
    return {
      id: attachmentIdFromETag(item.eTag),
      name: item.name,
      content_url: contentUrl,
      web_url: item.webUrl ?? contentUrl,
      drive_id: driveId,
      item_id: item.id,
      size: item.size ?? bytes.byteLength,
      shared_with: [],
    }
  }

  private async uploadDriveBytes(
    driveId: string,
    folderId: string,
    name: string,
    bytes: Uint8Array,
    folderPath?: string,
  ): Promise<string> {
    const graph = this.graph()
    const itemPath = folderPath
      ? `/me/drive/root:/${segment(folderPath)}/${segment(name)}:`
      : `/drives/${segment(driveId)}/items/${segment(folderId)}:/${segment(name)}:`
    if (bytes.byteLength <= SMALL_UPLOAD_LIMIT) {
      const raw = await graph.request<DriveItemMetadata>(
        'PUT',
        `${itemPath}/content?@microsoft.graph.conflictBehavior=rename`,
        undefined,
        bytes,
      )
      if (!raw.id) throw new TeamsError('Small upload did not return a drive item.', 'attachment_upload_missing')
      return raw.id
    }

    const session = await graph.request<{ uploadUrl?: string }>('POST', `${itemPath}/createUploadSession`, {
      item: { '@microsoft.graph.conflictBehavior': 'rename' },
    })
    if (!session.uploadUrl)
      throw new TeamsError('Upload session did not return an upload URL.', 'upload_session_missing')
    let uploadUrl: URL
    try {
      uploadUrl = new URL(session.uploadUrl)
    } catch {
      throw new TeamsError('Upload session returned an invalid upload URL.', 'upload_url_invalid')
    }
    if (uploadUrl.protocol !== 'https:') throw new TeamsError('Upload URL must use HTTPS.', 'upload_url_untrusted')

    let uploadedItemId: string | undefined
    try {
      for (let start = 0; start < bytes.byteLength; start += UPLOAD_CHUNK_SIZE) {
        const end = Math.min(start + UPLOAD_CHUNK_SIZE, bytes.byteLength) - 1
        const chunk = bytes.slice(start, end + 1)
        const response = await fetch(uploadUrl.toString(), {
          method: 'PUT',
          headers: {
            'Content-Length': String(chunk.byteLength),
            'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`,
          },
          body: chunk as unknown as RequestInit['body'],
        })
        if (!response.ok)
          throw new TeamsError(`Upload chunk failed with HTTP ${response.status}.`, 'upload_chunk_failed')
        if (end === bytes.byteLength - 1) {
          if (response.status !== 200 && response.status !== 201)
            throw new TeamsError('Final upload chunk did not return a drive item.', 'upload_chunk_failed')
          const raw = (await response.json().catch(() => ({}))) as DriveItemMetadata
          uploadedItemId = raw.id
        }
      }
      if (!uploadedItemId)
        throw new TeamsError('Upload session did not identify the uploaded item.', 'attachment_upload_missing')
    } catch (error) {
      try {
        await fetch(uploadUrl.toString(), { method: 'DELETE' })
      } catch {}
      if (error instanceof TeamsError) throw error
      throw new TeamsError('Upload chunk failed.', 'upload_chunk_failed')
    }

    return uploadedItemId
  }

  private async uploadChatFileResolved(filePath: string, recipients: ChatRecipient[]): Promise<TeamsAttachment> {
    const drive = await this.graph().request<{ id?: string }>('GET', '/me/drive?$select=id')
    if (!drive.id) throw new TeamsError('OneDrive is unavailable.', 'drive_missing')
    const attachment = await this.uploadDriveAttachment(drive.id, '', filePath, CHAT_FILES_FOLDER)
    try {
      await this.inviteChatRecipients(drive.id, attachment.item_id, recipients)
    } catch (error) {
      // Leave no unshared copy behind; a retry would otherwise upload a renamed duplicate.
      await this.graph()
        .request('DELETE', `/drives/${segment(drive.id)}/items/${segment(attachment.item_id)}`)
        .catch(() => undefined)
      throw error
    }
    return { ...attachment, shared_with: recipients.map((recipient) => recipient.identifier) }
  }

  async uploadChatFile(chatId: string, filePath: string): Promise<TeamsAttachment> {
    await this.validateAttachmentFile(filePath)
    const recipients = await this.resolveChatRecipients(chatId)
    return this.uploadChatFileResolved(filePath, recipients)
  }

  async uploadChannelAttachment(teamId: string, channelId: string, filePath: string): Promise<TeamsAttachment> {
    await this.validateAttachmentFile(filePath)
    const folder = await this.fileFolder(teamId, channelId)
    return this.uploadDriveAttachment(folder.driveId, folder.id, filePath)
  }

  private async fileFolder(teamId: string, channelId: string): Promise<{ id: string; driveId: string }> {
    const folder = await this.graph().request('GET', this.channelPath(teamId, channelId) + '/filesFolder')
    if (!folder.id || !folder.parentReference?.driveId)
      throw new TeamsError('Channel drive folder unavailable.', 'file_folder_missing')
    return { id: folder.id, driveId: folder.parentReference.driveId }
  }

  async uploadFile(teamId: string, channelId: string, filePath: string): Promise<TeamsFile> {
    const folder = await this.fileFolder(teamId, channelId)
    const bytes = await readFile(filePath)
    const path = `/drives/${segment(folder.driveId)}/items/${segment(folder.id)}:/${segment(basename(filePath))}:/content`
    const raw = await this.graph().request('PUT', path, undefined, new Uint8Array(bytes))
    return graphFile(raw, folder.driveId)
  }

  async listFiles(teamId: string, channelId: string): Promise<TeamsFile[]> {
    const folder = await this.fileFolder(teamId, channelId)
    return (
      await this.graph().collection(`/drives/${segment(folder.driveId)}/items/${segment(folder.id)}/children`)
    ).map((raw) => graphFile(raw, folder.driveId))
  }

  async downloadFile(teamId: string, channelId: string, fileId: string): Promise<{ buffer: Buffer; file: TeamsFile }> {
    const files = await this.listFiles(teamId, channelId)
    const file = files.find((candidate) => candidate.id === fileId)
    if (!file) {
      throw new TeamsError(`File not found: ${fileId}`, 'file_not_found')
    }

    if (file.drive_id) {
      if (file.is_folder) throw new TeamsError('Cannot download a folder as a file.', 'file_is_folder')
      const token = await this.getTokenProvider().getGraphToken()
      const response = await fetch(
        `${GRAPH_API_BASE}/drives/${segment(file.drive_id)}/items/${segment(file.id)}/content`,
        { headers: { Authorization: `Bearer ${token}` }, redirect: 'follow' },
      )
      return { buffer: await readDownloadResponse(response, 'graph_download'), file }
    }
    const source = getFileDownloadSource(file)
    if (source.route === 'graph') {
      const graphToken = await new TeamsTokenProvider(this.credManager).getGraphToken()
      const shareId = `u!${Buffer.from(source.url).toString('base64url').replace(/=+$/, '')}`
      const response = await fetch(`${GRAPH_API_BASE}/shares/${shareId}/driveItem/content`, {
        headers: {
          Authorization: `Bearer ${graphToken}`,
        },
        redirect: 'follow',
      })
      return { buffer: await readDownloadResponse(response, 'graph_download'), file }
    }

    if (this.isTokenExpired()) {
      throw new TeamsError('Token has expired. Run "auth login" or "auth extract" to refresh.', 'token_expired')
    }
    const skypeToken = this.getToken()
    const response = await fetch(source.url, {
      headers: {
        Authorization: `Bearer ${skypeToken}`,
        'X-Skypetoken': skypeToken,
      },
      redirect: 'follow',
    })
    return { buffer: await readDownloadResponse(response, 'skype_download'), file }
  }
}
