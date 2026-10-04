import { test, expect } from 'claude-code/testing'

import { innermost, parseSymbols, splitBySymbols } from './ast'

const symbols = parseSymbols(
  JSON.stringify([
    { text: 'class A\n{', range: { start: { line: 0 }, end: { line: 19 } } },
    { text: 'void One()\n{', range: { start: { line: 2 }, end: { line: 6 } } },
    { text: 'void Two()\n{', range: { start: { line: 8 }, end: { line: 12 } } },
  ]),
)

test('parseSymbols reads 1-based ranges and a short label', () => {
  expect(symbols.map(s => [s.label, s.start, s.end])).toEqual([
    ['class A', 1, 20],
    ['void One()', 3, 7],
    ['void Two()', 9, 13],
  ])
  expect(innermost(symbols, 4)?.label).toBe('void One()')
  expect(innermost(symbols, 8)?.label).toBe('class A')
  expect(parseSymbols('not json')).toEqual([])
})

test('splitBySymbols cuts a hunk where the touched declaration changes', () => {
  const hunk = {
    id: 'h1',
    file: 'A.cs',
    header: '@@ -3,11 +3,11 @@',
    lines: [
      ' a', // new 3, One
      '-b', // new 4, One
      '+B', // new 4, One
      ' c', // new 5
      ' d', // 6
      ' e', // 7
      ' f', // 8, class level
      ' g', // 9, Two
      '-h', // 10, Two
      '+H', // 10, Two
      ' i', // 11
    ],
  }
  const pieces = splitBySymbols(hunk, symbols)
  expect(pieces.map(p => p.symbol)).toEqual(['void One()', 'void Two()'])
  expect(pieces.map(p => p.lines.length)).toEqual([8, 3])
  expect(pieces[1].header).toBe('@@ -10,2 +10,2 @@ void Two()')
})

test('splitBySymbols leaves a hunk alone without symbols', () => {
  const hunk = { id: 'h1', file: 'x.txt', header: '@@ -1 +1 @@', lines: ['-a', '+b'] }
  expect(splitBySymbols(hunk, [])).toEqual([hunk])
})
