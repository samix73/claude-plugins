export type Hunk = {
  id: string
  file: string
  header: string
  /** The declaration (method, class, ...) the hunk changes, when ast-grep found one. */
  symbol?: string
  lines: string[]
}

export type Step = {
  title: string
  summary: string
  /** How to review: what to look at and in which order. */
  howToReview: string
  /** Things to keep in mind: risks, invariants, edge cases, missing tests. */
  considerations: string[]
  hunkIds: string[]
  isReviewed: boolean
}

export type Review = {
  /** Cache key of the reviewed PR or local checkout. */
  key: string
  /** The command arguments the guide was built from, reused by Sync. */
  args: string
  source: string
  overview: string
  hunks: Hunk[]
  steps: Step[]
  index: number
}

declare module 'claude-code' {
  interface PluginState {
    'pr-review-guide': { review: Review | null; status: string }
  }
}
