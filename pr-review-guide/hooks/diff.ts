import type { Hunk, Step } from '../types'

const MAX_HUNK_LINES = 120
const NO_NEWLINE_MARK = String.fromCharCode(92)

/** Splits a unified diff into hunks, each tagged with its file and an id (h1, h2, ...). */
export const parseDiff = (diff: string): Hunk[] => {
  const hunks: Hunk[] = []
  let file = ''
  let current: Hunk | undefined

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      current = undefined
      const match = / b\/(.+)$/.exec(line)
      file = match ? match[1] : line.slice('diff --git '.length)
    } else if (line.startsWith('@@')) {
      current = { id: `h${hunks.length + 1}`, file, header: line, lines: [] }
      hunks.push(current)
    } else if (current && !line.startsWith(NO_NEWLINE_MARK)) {
      current.lines.push(line)
    }
  }
  for (const hunk of hunks) {
    while (hunk.lines.length && hunk.lines[hunk.lines.length - 1] === '') hunk.lines.pop()
  }

  return hunks
}

/** The hunk as the model reads it; very long hunks are cut. */
export const hunkText = (hunk: Hunk): string => {
  const shown = hunk.lines.slice(0, MAX_HUNK_LINES)
  const cut = hunk.lines.length - shown.length

  return [
    `### ${hunk.id} ${hunk.file}${hunk.symbol ? " :: " + hunk.symbol : ""}`,
    hunk.header,
    ...shown,
    ...(cut > 0 ? [`... ${cut} more lines`] : []),
  ].join('\n')
}

type RawStep = {
  title?: unknown
  summary?: unknown
  howToReview?: unknown
  considerations?: unknown
  hunkIds?: unknown
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Reads the model's JSON answer into steps. Unknown hunk ids are dropped, a hunk
 * named twice stays in its first step, and hunks nobody named end in a last step,
 * so every hunk of the diff is reviewed exactly once.
 */
export const parseGuide = (
  reply: string,
  hunks: Hunk[],
): { overview: string; steps: Step[] } | undefined => {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined

  let raw: { overview?: unknown; steps?: unknown }
  try {
    raw = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (!Array.isArray(raw.steps)) return undefined

  const known = new Set(hunks.map(hunk => hunk.id))
  const seen = new Set<string>()
  const steps: Step[] = []

  for (const item of raw.steps as RawStep[]) {
    const ids = [
      ...new Set(
        (Array.isArray(item.hunkIds) ? item.hunkIds : []).filter(
          (id): id is string => typeof id === 'string' && known.has(id) && !seen.has(id),
        ),
      ),
    ]
    if (ids.length === 0) continue
    for (const id of ids) seen.add(id)
    steps.push({
      title: text(item.title) || 'Untitled step',
      summary: text(item.summary),
      howToReview: text(item.howToReview),
      considerations: (Array.isArray(item.considerations) ? item.considerations : []).filter(
        (one): one is string => typeof one === 'string',
      ),
      hunkIds: ids,
      isReviewed: false,
    })
  }

  const rest = hunks.filter(hunk => !seen.has(hunk.id)).map(hunk => hunk.id)
  if (rest.length > 0) {
    steps.push({
      title: 'Other changes',
      summary: 'Hunks the guide did not place in a step.',
      howToReview: 'Read each hunk and decide if it belongs with the rest of the change.',
      considerations: [],
      hunkIds: rest,
      isReviewed: false,
    })
  }

  return steps.length > 0 ? { overview: text(raw.overview), steps } : undefined
}

export const buildPrompt = (source: string, hunks: Hunk[]): string =>
  [
    `You prepare a guided code review of: ${source}.`,
    'Below is the diff, split into hunks with ids (h1, h2, ...).',
    'Hunks are already cut along declarations: "h3 file :: name" is a change inside that',
    'method, class or type. Use the names to group hunks that touch the same unit or call each other.',
    '',
    'Group the hunks into review steps. A step holds hunks that belong together',
    '(one behavior change, one refactor, a change and its tests, a rename across files).',
    'Order the steps so a reviewer meets the foundations first (types, contracts, core logic),',
    'then the callers, then tests, config and generated files last.',
    'Put every hunk in exactly one step.',
    '',
    'For each step give:',
    '- title: short, names the change.',
    '- summary: one or two sentences on what the change does and why.',
    '- howToReview: concrete advice: what to read first, what to compare, what to run or trace.',
    '- considerations: 2-5 specific points for THIS code: edge cases, invariants, error paths,',
    '  concurrency, security, compatibility, missing tests, or doubts about the approach.',
    '  Do not write generic advice. If a hunk is trivial, say it is safe to skim.',
    '- hunkIds: the ids of the hunks in the step.',
    '',
    'Answer with JSON only, no code fence, in this shape:',
    '{"overview": "2-3 sentences on the whole change and the riskiest part",',
    ' "steps": [{"title": "", "summary": "", "howToReview": "", "considerations": [""], "hunkIds": ["h1"]}]}',
    '',
    '=== DIFF ===',
    hunks.map(hunkText).join('\n\n'),
  ].join('\n')
