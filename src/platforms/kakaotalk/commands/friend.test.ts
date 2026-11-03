import { afterEach, describe, expect, it, mock } from 'bun:test'

const getFriends = mock(async () => [{ user_id: '2', nickname: '테스트', phone_number: null, direct_chat_id: null }])
const addFriendByPhone = mock(async () => ({
  success: true,
  status_code: 0,
  user_id: '2',
  nickname: '테스트',
  phone_number: '01000000000',
}))
const withKakaoClient = mock(async (_options: unknown, fn: (client: unknown) => Promise<unknown>) =>
  fn({ getFriends, addFriendByPhone }),
)
mock.module('./shared', () => ({ withKakaoClient }))

import { friendCommand } from './friend'

const originalLog = console.log
afterEach(() => {
  console.log = originalLog
})

describe('friend CLI', () => {
  it('prints a friend list through the account-scoped client', async () => {
    const log = mock(() => {})
    console.log = log
    await friendCommand.parseAsync(['list', '--account', 'fixture'], { from: 'user' })
    expect(withKakaoClient).toHaveBeenLastCalledWith(
      expect.objectContaining({ account: 'fixture' }),
      expect.any(Function),
    )
    expect(JSON.parse(log.mock.calls[0]![0])[0].user_id).toBe('2')
  })

  it('passes phone, name and country parameters and returns user_id JSON', async () => {
    const log = mock(() => {})
    console.log = log
    await friendCommand.parseAsync(
      [
        'add-phone',
        '01000000000',
        '테스트',
        '--country-iso',
        'KR',
        '--country-code',
        '82',
        '--account',
        'fixture',
        '--pretty',
      ],
      { from: 'user' },
    )
    expect(addFriendByPhone).toHaveBeenCalledWith({
      phoneNumber: '01000000000',
      nickname: '테스트',
      countryIso: 'KR',
      countryCode: '82',
    })
    expect(JSON.parse(log.mock.calls[0]![0]).user_id).toBe('2')
  })
})
