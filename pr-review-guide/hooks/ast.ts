import type { Hunk } from '../types'

/** One declaration found by ast-grep: lines are 1-based and inclusive. */
export type CodeUnit = { label: string; start: number; end: number }

/** ast-grep language and the node kinds that count as a unit of review, by file extension. */
const LANGUAGES: Record<string, { lang: string; kinds: string[] }> = {
  cs: {
    lang: 'csharp',
    kinds: [
      'class_declaration',
      'struct_declaration',
      'interface_declaration',
      'enum_declaration',
      'record_declaration',
      'method_declaration',
      'constructor_declaration',
      'property_declaration',
    ],
  },
  ts: {
    lang: 'typescript',
    kinds: ['function_declaration', 'class_declaration', 'method_definition', 'interface_declaration', 'type_alias_declaration', 'enum_declaration'],
  },
  tsx: {
    lang: 'tsx',
    kinds: ['function_declaration', 'class_declaration', 'method_definition', 'interface_declaration', 'type_alias_declaration', 'enum_declaration'],
  },
  js: { lang: 'javascript', kinds: ['function_declaration', 'class_declaration', 'method_definition'] },
  jsx: { lang: 'javascript', kinds: ['function_declaration', 'class_declaration', 'method_definition'] },
  py: { lang: 'python', kinds: ['class_definition', 'function_definition'] },
  go: { lang: 'go', kinds: ['function_declaration', 'method_declaration', 'type_declaration'] },
  rs: { lang: 'rust', kinds: ['function_item', 'impl_item', 'struct_item', 'enum_item', 'trait_item'] },
  java: { lang: 'java', kinds: ['class_declaration', 'interface_declaration', 'enum_declaration', 'method_declaration', 'constructor_declaration'] },
  kt: { lang: 'kotlin', kinds: ['class_declaration', 'object_declaration', 'function_declaration'] },
  rb: { lang: 'ruby', kinds: ['class', 'module', 'method', 'singleton_method'] },
  swift: { lang: 'swift', kinds: ['class_declaration', 'protocol_declaration', 'function_declaration'] },
  cpp: { lang: 'cpp', kinds: ['class_specifier', 'struct_specifier', 'function_definition'] },
  c: { lang: 'c', kinds: ['struct_specifier', 'function_definition'] },
}

export const languageOf = (file: string): { lang: string; kinds: string[] } | undefined =>
  LANGUAGES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()]

/** The YAML rule `ast-grep scan --inline-rules` takes to find a language's declarations. */
export const symbolRule = (lang: string, kinds: string[]): string =>
  [
    'id: unit',
    `language: ${lang}`,
    'rule:',
    '  any:',
    ...kinds.map(kind => `    - kind: ${kind}`),
  ].join(String.fromCharCode(10))

type Match = { text?: string; range?: { start?: { line?: number }; end?: { line?: number } } }

/** Reads `ast-grep scan --json` output into symbols; anything odd gives no symbols. */
export const parseSymbols = (json: string): CodeUnit[] => {
  let matches: Match[]
  try {
    matches = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(matches)) return []

  const symbols: CodeUnit[] = []
  for (const match of matches) {
    const start = match.range?.start?.line
    const end = match.range?.end?.line
    if (typeof start !== 'number' || typeof end !== 'number') continue
    const first = (match.text ?? '').split(String.fromCharCode(10))[0].replace(/\s*[{=:].*$/, '').trim()
    symbols.push({ label: first.slice(0, 90), start: start + 1, end: end + 1 })
  }

  return symbols
}

/** The smallest symbol that holds a line of the new file. */
export const innermost = (symbols: CodeUnit[], line: number): CodeUnit | undefined => {
  let best: CodeUnit | undefined
  for (const symbol of symbols) {
    if (line < symbol.start || line > symbol.end) continue
    if (!best || symbol.end - symbol.start < best.end - best.start) best = symbol
  }

  return best
}

type Segment = { symbol: CodeUnit | undefined; lines: string[]; oldStart: number; newStart: number }

const HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Cuts a hunk where the code it touches moves from one declaration to the next, so
 * each piece holds the changes of one method, class or type. Unchanged lines never
 * make a piece of their own. A hunk inside one declaration only gets its `symbol`.
 */
export const splitBySymbols = (hunk: Hunk, symbols: CodeUnit[]): Hunk[] => {
  const found = HEADER.exec(hunk.header)
  if (!found || symbols.length === 0) return [hunk]

  let oldLine = Number(found[1])
  let newLine = Number(found[2])
  const segments: Segment[] = []

  for (const line of hunk.lines) {
    const mark = line[0]
    const symbol = innermost(symbols, newLine)
    const last = segments[segments.length - 1]
    const isChange = mark === '+' || mark === '-'

    if (!last || (isChange && last.symbol !== symbol && last.lines.some(one => one[0] === '+' || one[0] === '-'))) {
      segments.push({ symbol, lines: [line], oldStart: oldLine, newStart: newLine })
    } else {
      if (isChange && !last.lines.some(one => one[0] === '+' || one[0] === '-')) last.symbol = symbol
      last.lines.push(line)
    }
    if (mark !== '+') oldLine += 1
    if (mark !== '-') newLine += 1
  }

  return segments.map(segment => {
    const oldCount = segment.lines.filter(one => one[0] !== '+').length
    const newCount = segment.lines.filter(one => one[0] !== '-').length
    const label = segment.symbol?.label

    return {
      ...hunk,
      header: `@@ -${segment.oldStart},${oldCount} +${segment.newStart},${newCount} @@${label ? ' ' + label : ''}`,
      lines: segment.lines,
      symbol: label,
    }
  })
}

/** Gives the hunks fresh ids, h1, h2, ... in order. */
export const renumber = (hunks: Hunk[]): Hunk[] => hunks.map((hunk, i) => ({ ...hunk, id: `h${i + 1}` }))
