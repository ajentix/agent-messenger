import { Command } from 'commander'

import { handleError } from '@/shared/utils/error-handler'
import { formatOutput } from '@/shared/utils/output'

import { withKakaoClient } from './shared'

async function listAction(options: { account?: string; pretty?: boolean }): Promise<void> {
  try {
    const result = await withKakaoClient(options, (client) => client.getFriends())
    console.log(formatOutput(result, options.pretty))
  } catch (error) {
    handleError(error as Error)
  }
}

async function addAction(
  phoneNumber: string,
  nickname: string,
  options: { account?: string; pretty?: boolean; countryIso?: string; countryCode?: string },
): Promise<void> {
  try {
    const result = await withKakaoClient(options, (client) =>
      client.addFriendByPhone({
        phoneNumber,
        nickname,
        countryIso: options.countryIso,
        countryCode: options.countryCode,
      }),
    )
    console.log(formatOutput(result, options.pretty))
  } catch (error) {
    handleError(error as Error)
  }
}

export const friendCommand = new Command('friend')
  .description('KakaoTalk friend commands')
  .addCommand(
    new Command('list')
      .description('List friends with user IDs and phone numbers when available')
      .option('--account <id>', 'Use a specific KakaoTalk account')
      .option('--pretty', 'Pretty print JSON output')
      .action(listAction),
  )
  .addCommand(
    new Command('add-phone')
      .description('Add a contact by phone and name, then resolve its user ID from the friend list')
      .argument('<phone-number>', 'Phone number (local or international format)')
      .argument('<name>', 'Contact name')
      .option('--country-iso <iso>', 'Two-letter country ISO', 'KR')
      .option('--country-code <code>', 'Calling code without +', '82')
      .option('--account <id>', 'Use a specific KakaoTalk account')
      .option('--pretty', 'Pretty print JSON output')
      .action(addAction),
  )
