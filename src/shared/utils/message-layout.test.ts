import { describe, expect, it } from 'bun:test'

import {
  assertReadableMessageLayout,
  findMessageLayoutProblems,
  MessageLayoutError,
} from './message-layout'

describe('findMessageLayoutProblems', () => {
  it('accepts a single line and a message laid out with blank lines', () => {
    expect(findMessageLayoutProblems('Thanks, received!')).toEqual([])
    const good = [
      'Hello, two updates.',
      '',
      '1. The first item is done.',
      'A continuation line inside the item is fine.',
      '',
      '2. The second item is done.',
      '',
      'Let me know if anything is off!',
    ].join('\n')
    expect(findMessageLayoutProblems(good)).toEqual([])
  })

  it('flags a list that starts right after a paragraph line', () => {
    const dense = ['Hello, sorry for the delay.', '', 'Two things:', '1. First.', '2. Second.'].join('\n')
    expect(findMessageLayoutProblems(dense).map((problem) => [problem.kind, problem.line])).toEqual([
      ['list_item_without_blank_line', 4],
    ])
  })

  it('lets items of the same list follow each other (2026-10-30)', () => {
    const reply = ['Hello, thanks for checking!', '', '- Yellow: aligned the tops', '- Purple: removed the repeated intro', '', 'Please send the team address.'].join('\n')
    expect(findMessageLayoutProblems(reply)).toEqual([])
    expect(findMessageLayoutProblems(['Hello.', '', '1. First.', 'more about it', '2. Second.'].join('\n'))).toEqual([])
  })

  it('flags a second paragraph glued to the opening line', () => {
    const dense = 'Hello, I checked it.\nAlso, the wide tables now keep the header row.'
    expect(findMessageLayoutProblems(dense)).toEqual([
      { kind: 'opening_without_blank_line', line: 2, excerpt: 'Also, the wide tables now keep' },
    ])
  })

  it('treats the numbered item right after the opening line as a list item', () => {
    const dense = 'Hello, sorry for the delay.\n1. First.'
    expect(findMessageLayoutProblems(dense).map((problem) => problem.kind)).toEqual(['list_item_without_blank_line'])
  })

  it('reads Korean business messages the same way and handles CRLF', () => {
    const dense = '과장님, 답이 늦어 죄송합니다.\r\n1. 반영했습니다.\r\n2. 확인했습니다.'
    expect(findMessageLayoutProblems(dense)).toHaveLength(1)
    const good = '과장님, 답이 늦어 죄송합니다.\n\n1. 반영했습니다.\n\n2. 확인했습니다.'
    expect(findMessageLayoutProblems(good)).toEqual([])
  })

  it('does not treat a number inside a sentence or a negative amount as a list item', () => {
    expect(findMessageLayoutProblems('Hello.\n\nTotal is 3.5 million.\n-5% this quarter')).toEqual([])
  })
})

describe('assertReadableMessageLayout', () => {
  it('throws with the line numbers unless the caller opts out', () => {
    expect(() => assertReadableMessageLayout('Hi.\n1. One.')).toThrow(MessageLayoutError)
    expect(() => assertReadableMessageLayout('Hi.\n1. One.', { allowDense: true })).not.toThrow()
    try {
      assertReadableMessageLayout('Hi.\n1. One.')
    } catch (error) {
      expect((error as MessageLayoutError).code).toBe('dense_message_layout')
      expect((error as Error).message).toContain('line 2')
    }
  })
})
