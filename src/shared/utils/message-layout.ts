/**
 * Readable layout check for multi-line chat messages.
 *
 * KakaoTalk shows a message exactly as sent. A business message whose opening
 * line, numbered items, and paragraphs are separated by single line breaks
 * reads as one dense block on a phone, which recipients have called out. The
 * convention the senders agreed on (2026-10-29) is:
 *
 *   - a blank line after the opening line (greeting and first sentence), and
 *   - a blank line before every list item (`1.`, `2)`, `-`, `•`, `①` ...).
 *
 * Continuation lines inside an item may stay on a single line break.
 *
 * The check only reports problems. It never rewrites the text, because the
 * text that a person approved must be the text that is sent.
 */

export type MessageLayoutProblemKind = 'opening_without_blank_line' | 'list_item_without_blank_line'

export interface MessageLayoutProblem {
  readonly kind: MessageLayoutProblemKind
  /** 1-based line number of the line that needs a blank line before it. */
  readonly line: number
  /** The start of that line, for a human-readable error. */
  readonly excerpt: string
}

const LIST_ITEM = /^\s*(?:\d{1,2}[.)]|[-•▪*]|[①-⑳])\s+/u

export function isListItemLine(line: string): boolean {
  return LIST_ITEM.test(line)
}

export function findMessageLayoutProblems(text: string): MessageLayoutProblem[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const problems: MessageLayoutProblem[] = []
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const previous = lines[index - 1] ?? ''
    if (line.trim().length === 0 || previous.trim().length === 0) continue
    if (isListItemLine(line)) {
      problems.push({ kind: 'list_item_without_blank_line', line: index + 1, excerpt: line.trim().slice(0, 30) })
    } else if (index === 1) {
      problems.push({ kind: 'opening_without_blank_line', line: index + 1, excerpt: line.trim().slice(0, 30) })
    }
  }
  return problems
}

export class MessageLayoutError extends Error {
  readonly code = 'dense_message_layout'
  readonly problems: readonly MessageLayoutProblem[]

  constructor(problems: readonly MessageLayoutProblem[]) {
    const where = problems.map((problem) => `line ${problem.line} ("${problem.excerpt}")`).join(', ')
    super(
      `Message needs a blank line after the opening line and before each list item: ${where}. ` +
        'Add the blank lines and get the text approved again, or pass --allow-dense-layout to send it as is.',
    )
    this.name = 'MessageLayoutError'
    this.problems = problems
  }
}

/** Throws `MessageLayoutError` unless the layout is readable or the caller opted out. */
export function assertReadableMessageLayout(text: string, options: { allowDense?: boolean } = {}): void {
  if (options.allowDense) return
  const problems = findMessageLayoutProblems(text)
  if (problems.length > 0) throw new MessageLayoutError(problems)
}
