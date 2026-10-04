import { test, expect } from 'claude-code/testing'

import { parseDiff, parseGuide } from './diff'

const diff = [
  'diff --git a/a.ts b/a.ts',
  'index 1..2 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1,2 @@',
  '-old',
  '+new',
  ' same',
  '@@ -10,1 +10,2 @@',
  ' x',
  '+y',
  'diff --git a/b.ts b/b.ts',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  '',
].join('\n')

test('parseDiff splits hunks by file', () => {
  const hunks = parseDiff(diff)
  expect(hunks.map(h => [h.id, h.file, h.lines.length])).toEqual([
    ['h1', 'a.ts', 3],
    ['h2', 'a.ts', 2],
    ['h3', 'b.ts', 2],
  ])
})

test('parseGuide places every hunk once', () => {
  const hunks = parseDiff(diff)
  const reply =
    'Here: ' +
    JSON.stringify({
      overview: 'o',
      steps: [
        { title: 't', summary: 's', howToReview: 'h', considerations: ['c'], hunkIds: ['h2', 'h2', 'zz'] },
      ],
    })
  const guide = parseGuide(reply, hunks)
  expect(guide?.steps.map(s => s.hunkIds)).toEqual([['h2'], ['h1', 'h3']])
  expect(parseGuide('nope', hunks)).toBeUndefined()
})
