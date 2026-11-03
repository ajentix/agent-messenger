import { LANG, PC_OS_NAME, getLocoDeviceConfig } from './protocol/config'
import { exactInteger, parseJsonPreservingIntegers } from './protocol/exact-json'
import type { KakaoDeviceType, KakaoFriend } from './types'

const KAKAO_SERVICE_HOST = 'https://katalk.kakao.com'

export interface FriendServiceCredentials {
  oauthToken: string
  deviceUuid: string
  deviceType: KakaoDeviceType
}

export interface AddFriendByPhoneInput {
  nickname: string
  phoneNumber: string
  countryIso?: string
  countryCode?: string
}

export interface FriendServiceResponse {
  status: number
  body: Record<string, unknown>
}

function servicePrefix(deviceType: KakaoDeviceType): string {
  return deviceType === 'tablet' ? 'android' : 'mac'
}

export function buildFriendServiceHeaders(credentials: FriendServiceCredentials): Record<string, string> {
  const device = getLocoDeviceConfig(credentials.deviceType)
  const osName = device.os === 'android' ? 'An/13' : `Md/${PC_OS_NAME}`
  return {
    Authorization: `${credentials.oauthToken}-${credentials.deviceUuid}`,
    A: `${device.os}/${device.appVersion}/${LANG}`,
    'User-Agent': `KT/${device.appVersion} ${osName} ${LANG}`,
    Accept: '*/*',
    'Accept-Language': 'ko',
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
  }
}

async function requestFriendService(
  credentials: FriendServiceCredentials,
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<FriendServiceResponse> {
  const timeout = AbortSignal.timeout(15_000)
  try {
    const response = await fetchImpl(`${KAKAO_SERVICE_HOST}/${servicePrefix(credentials.deviceType)}${path}`, {
      ...init,
      redirect: 'error',
      signal: timeout,
      headers: buildFriendServiceHeaders(credentials),
    })
    if (!response.ok) throw new Error(`Friend service HTTP ${response.status}`)
    const parsed = parseJsonPreservingIntegers(await response.text())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid friend response')
    const body = parsed as Record<string, unknown>
    if (typeof body.status !== 'number' || !Number.isSafeInteger(body.status)) throw new Error('Invalid friend status')
    return { status: body.status, body }
  } catch {
    // Do not include fetch errors or response bodies, which can contain credentials.
    throw new Error(
      'Friend service request failed or returned an invalid response; do not repeat an add without checking the friend list',
    )
  }
}

export async function addFriendByPhoneRequest(
  credentials: FriendServiceCredentials,
  input: AddFriendByPhoneInput,
  fetchImpl: typeof fetch = fetch,
): Promise<FriendServiceResponse> {
  const form = new URLSearchParams({
    nickname: input.nickname,
    country_iso: input.countryIso ?? 'KR',
    country_code: input.countryCode ?? '82',
    phonenumber: input.phoneNumber,
  })
  return requestFriendService(
    credentials,
    '/friends/add_by_phonenumber.json',
    { method: 'POST', body: form },
    fetchImpl,
  )
}

export async function listFriendsRequest(
  credentials: FriendServiceCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<FriendServiceResponse> {
  const query = new URLSearchParams({
    type: JSON.stringify(['plus', 'normal']),
    event_types: JSON.stringify(['create']),
    token: '0',
  })
  return requestFriendService(credentials, `/friends/list.json?${query.toString()}`, { method: 'GET' }, fetchImpl)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function idString(value: unknown): string | null {
  try {
    const id = exactInteger(value).digits
    if (BigInt(id) > 0n) return id
  } catch {}
  return null
}

export function parseFriends(body: Record<string, unknown>): KakaoFriend[] {
  const rawFriends = body.friends
  if (!Array.isArray(rawFriends)) throw new Error('Friend response missing friends array')
  return rawFriends.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Malformed friend record')
    const friend = raw as Record<string, unknown>
    const userId = idString(friend.userId)
    if (!userId) throw new Error('Friend response missing exact userId')
    return {
      user_id: userId,
      nickname: asString(friend.friendNickName) ?? asString(friend.nickName) ?? '',
      phone_number: asString(friend.phoneNumber),
      direct_chat_id: idString(friend.directChatId),
    }
  })
}

export function findFriend(
  friends: readonly KakaoFriend[],
  input: { phoneNumber: string; countryCode?: string },
): KakaoFriend | null {
  const expected = canonicalPhone(input.phoneNumber, input.countryCode ?? '82')
  const matches = friends.filter((friend) => {
    if (!friend.phone_number) return false
    try {
      return canonicalPhone(friend.phone_number, input.countryCode ?? '82') === expected
    } catch {
      // Hidden or masked phone fields cannot establish an identity match.
      return false
    }
  })
  if (matches.length > 1) throw new Error('Multiple friends match the phone number; user ID resolution is ambiguous')
  return matches[0] ?? null
}

export function canonicalPhone(phone: string, countryCode: string): string {
  const trimmed = phone.trim()
  if (!/^\+?[\d ()-]+$/.test(trimmed)) throw new Error('Invalid phone number')
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length < 4 || digits.length > 15) throw new Error('Invalid phone number length')
  if (trimmed.startsWith('+')) return digits
  if (digits.startsWith(countryCode) && !digits.startsWith('0')) return digits
  return countryCode + digits.replace(/^0/, '')
}
