import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Review } from '../types'
import { languageOf, parseSymbols, renumber, splitBySymbols, symbolRule } from './ast'
import { buildPrompt, parseDiff, parseGuide } from './diff'
import type { Hunk } from '../types'

const PANE = 'pr-review'
const MAX_DIFF_CHARS = 400_000
const MAX_SHOWN_LINES = 40

const review = atom({ plugin: 'pr-review-guide', key: 'review' } as const, null)
const status = atom({ plugin: 'pr-review-guide', key: 'status' } as const, '')

type Api = EngineInterface

let stop = new AbortController()

async function fetchDiff(
  $: Api,
  args: string,
): Promise<{ source: string; diff: string; ref?: string } | string> {
  const words = args.trim().split(/\s+/).filter(Boolean)

  if (words[0] === 'local') {
    let base = words[1]
    if (!base) {
      for (const guess of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
        const ok = await $.process.run(['git', 'rev-parse', '--verify', '--quiet', guess])
        if (ok.exitCode === 0) {
          base = guess
          break
        }
      }
    }
    if (!base) return 'No base branch found. Use: /guided-pr-review local <base>'
    // Diff the working tree (staged and unstaged) against the merge base, so
    // uncommitted changes are included along with the branch commits.
    const mb = await $.process.run(['git', 'merge-base', base, 'HEAD'])
    const from = mb.exitCode === 0 && mb.stdout.trim() ? mb.stdout.trim() : base
    const run = await $.process.run(['git', 'diff', from], { timeoutMs: 60_000 })
    if (run.exitCode !== 0) return `git diff failed: ${run.stderr.trim()}`
    // `git stash create` makes a commit of the working tree without touching it.
    // It prints nothing when the tree is clean, so HEAD is the right ref then.
    const snap = await $.process.run(['git', 'stash', 'create'])
    const ref = snap.exitCode === 0 && snap.stdout.trim() ? snap.stdout.trim() : 'HEAD'

    return { source: `local changes against ${base}`, diff: run.stdout, ref }
  }

  const target = words.slice(0, 1)
  const run = await $.process.run(['gh', 'pr', 'diff', ...target], { timeoutMs: 60_000 })
  if (run.exitCode !== 0) return `gh pr diff failed: ${run.stderr.trim()}`
  const meta = await $.process.run(['gh', 'pr', 'view', ...target, '--json', 'number,title,headRefOid'])
  let name = ''
  let ref: string | undefined
  try {
    const info = JSON.parse(meta.stdout) as { number: number; title: string; headRefOid: string }
    name = `#${info.number} ${info.title}`
    // The head commit is only usable when this clone already has it.
    const have = await $.process.run(['git', 'cat-file', '-e', `${info.headRefOid}^{commit}`])
    if (have.exitCode === 0) ref = info.headRefOid
  } catch {
    // The title and the head are niceties; the review goes on without them.
  }

  return { source: name ? `PR ${name}` : `PR ${target[0] ?? '(current branch)'}`, diff: run.stdout, ref }
}

/**
 * Asks ast-grep for the declarations of each changed file at the reviewed commit, cuts
 * hunks that cross declarations, and names each hunk's declaration. Files ast-grep
 * cannot read keep their hunks as git made them.
 */
async function splitWithAst($: Api, hunks: Hunk[], ref: string | undefined): Promise<Hunk[]> {
  if (!ref) return hunks

  const files = [...new Set(hunks.map(hunk => hunk.file))].filter(file => languageOf(file)).slice(0, 80)
  const units = new Map<string, ReturnType<typeof parseSymbols>>()
  for (const file of files) {
    const language = languageOf(file)
    if (!language) continue
    const source = await $.process.run(['git', 'show', `${ref}:${file}`])
    if (source.exitCode !== 0) continue
    const scan = await $.process.run(
      ['ast-grep', 'scan', '--stdin', '--inline-rules', symbolRule(language.lang, language.kinds), '--json=compact'],
      { stdin: source.stdout, timeoutMs: 30_000 },
    ).catch(() => undefined)
    if (scan && scan.exitCode === 0) units.set(file, parseSymbols(scan.stdout))
  }

  return renumber(hunks.flatMap(hunk => splitBySymbols(hunk, units.get(hunk.file) ?? [])))
}

const prepare = async ($: Api, args: string) => {
  stop.abort()
  stop = new AbortController()
  await update($, review, () => null)
  await update($, status, () => 'Fetching the diff...')

  const got = await fetchDiff($, args)
  if (typeof got === 'string') {
    await update($, status, () => got)

    return
  }
  const parsed = parseDiff(got.diff)
  if (parsed.length === 0) {
    await update($, status, () => 'The diff has no text hunks to review.')

    return
  }
  await update($, status, () => 'Splitting hunks by declaration with ast-grep...')
  const hunks = await splitWithAst($, parsed, got.ref)

  const note = got.diff.length > MAX_DIFF_CHARS ? ' (large diff, the guide may be coarse)' : ''
  await update($, status, () => `Asking the model to group ${hunks.length} hunks${note}...`)
  const prompt = buildPrompt(got.source, hunks).slice(0, MAX_DIFF_CHARS)
  const reply = await $.model.complete(
    { model: 'sonnet', prompt, maxTokens: 16000, effort: 'medium', timeoutMs: 600_000 },
    { signal: stop.signal },
  )
  if (!reply.isAnswered) {
    await update($, status, () => `The model gave no guide (${reply.reason}).`)

    return
  }
  const guide = parseGuide(reply.text, hunks)
  if (!guide) {
    await update($, status, () => 'The model answer was not valid JSON. Run the command again.')

    return
  }

  const next: Review = { source: got.source, overview: guide.overview, hunks, steps: guide.steps, index: 0 }
  await update($, review, () => next)
  await update($, status, () => '')
  $.ui.toast(`Review guide ready: ${next.steps.length} steps`)
}

function go($: Api, by: number) {
  return update($, review, r =>
    r ? { ...r, index: Math.min(r.steps.length - 1, Math.max(0, r.index + by)) } : r,
  )
}

function toggle($: Api) {
  return update($, review, r =>
    r
      ? {
          ...r,
          steps: r.steps.map((s, i) => (i === r.index ? { ...s, isReviewed: !s.isReviewed } : s)),
        }
      : r,
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'guided-pr-review',
      description: 'Guided PR review: /guided-pr-review [number|url] or /guided-pr-review local [base]',
    })

    return next(e)
  })

  on('command.run', { command: 'guided-pr-review' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'PR review guide', closeOnEscape: true })
    void prepare($, e.args)

    return { text: 'Building the review guide. Follow it in the PR review pane.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, review)
    const message = await read($, status)

    if (!r) {
      return (
        <Box flexDirection="column">
          <Text>{message || 'Run /guided-pr-review [number|url] or /guided-pr-review local [base].'}</Text>
        </Box>
      )
    }

    const step = r.steps[r.index]
    const done = r.steps.filter(s => s.isReviewed).length
    const byId = new Map(r.hunks.map(h => [h.id, h]))

    return (
      <Box flexDirection="column">
        <Button role="dismiss" onPress={() => $.ui.close({ id: PANE })}>Close</Button>
        <Text bold>{r.source}</Text>
        <Text dimColor>{r.overview}</Text>
        <Text dimColor>
          Step {r.index + 1}/{r.steps.length} · {done} reviewed
        </Text>
        <Box>
          <Button key="prev" onPress={() => void go($, -1)}>Prev</Button>
          <Text> </Text>
          <Button key="next" variant="primary" onPress={() => void go($, 1)}>Next</Button>
          <Text> </Text>
          <Button key="done" onPress={() => void toggle($)}>
            {step.isReviewed ? 'Unmark reviewed' : 'Mark reviewed'}
          </Button>
        </Box>
        <Text bold>
          {step.isReviewed ? '[x] ' : '[ ] '}
          {step.title}
        </Text>
        <Text>{step.summary}</Text>
        <Text bold>How to review</Text>
        <Text>{step.howToReview}</Text>
        {step.considerations.length > 0 && <Text bold>Keep in mind</Text>}
        {step.considerations.map(c => (
          <Text>- {c}</Text>
        ))}
        {step.hunkIds.map(id => {
          const hunk = byId.get(id)
          if (!hunk) return null
          const shown = hunk.lines.slice(0, MAX_SHOWN_LINES)
          const cut = hunk.lines.length - shown.length

          return (
            <Box flexDirection="column">
              <Text bold color="cyan">
                {hunk.file} {hunk.header}
              </Text>
              {shown.map(line => (
                <Text color={line.startsWith('+') ? 'green' : line.startsWith('-') ? 'red' : undefined} dimColor={!/^[+-]/.test(line)}>
                  {line || ' '}
                </Text>
              ))}
              {cut > 0 && <Text dimColor>... {cut} more lines</Text>}
            </Box>
          )
        })}
      </Box>
    )
  })
}
