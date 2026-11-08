import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const md = require('../lib/markdown.cjs')

function translationsFor(source, map) {
  const units = md.splitUnits(source)
  const out = {}
  for (const unit of units) {
    if (Object.prototype.hasOwnProperty.call(map, unit.content)) {
      out[md.unitKey(unit)] = map[unit.content]
    }
  }
  return out
}

test('heading translation is appended on the same line', () => {
  const source = '### 3. 重要物理性质'
  const out = md.decorate(source, translationsFor(source, { '3. 重要物理性质': '3. Important physical properties' }))
  assert.equal(out, '### 3. 重要物理性质 3. Important physical properties')
})

test('paragraph translation is inserted as the next paragraph', () => {
  const source = '磁通量是标量。\n\n它有正负之分。'
  const out = md.decorate(
    source,
    translationsFor(source, {
      '磁通量是标量。': 'Magnetic flux is a scalar quantity.',
      '它有正负之分。': 'It can be positive or negative.',
    }),
  )
  assert.equal(out, '磁通量是标量。\n\nMagnetic flux is a scalar quantity.\n\n它有正负之分。\n\nIt can be positive or negative.')
})

test('list item translation stays inside the same bullet and keeps nesting', () => {
  const source = '- **标量性**：磁通量是标量。\n- **高斯磁定律**：净磁通量恒为零。'
  const out = md.decorate(
    source,
    translationsFor(source, {
      '**标量性**：磁通量是标量。': '**Scalar nature**: Magnetic flux is a scalar quantity.',
      '**高斯磁定律**：净磁通量恒为零。': "**Gauss's Law of Magnetism**: The net flux is always zero.",
    }),
  )
  assert.equal(
    out,
    "- **标量性**：磁通量是标量。\n\n  **Scalar nature**: Magnetic flux is a scalar quantity.\n\n- **高斯磁定律**：净磁通量恒为零。\n\n  **Gauss's Law of Magnetism**: The net flux is always zero.\n",
  )
})

test('nested list item is translated separately and does not duplicate the parent', () => {
  const source = '- 父项\n  - 子项'
  const units = md.splitUnits(source)
  assert.deepEqual(units.map((u) => u.kind + ':' + u.content), ['list:父项', 'list:子项'])
  const out = md.decorate(source, translationsFor(source, { 父项: 'Parent', 子项: 'Child' }))
  assert.match(out, /- 父项\n\n  Parent\n/)
  assert.match(out, /  - 子项\n\n    Child/)
})

test('code fences and block math are skipped, tables become translatable units', () => {
  const source = [
    '```js',
    'const a = 1',
    '```',
    '',
    '| 名称 | 值 |',
    '| --- | --- |',
    '| a | 1 |',
    '',
    '$$',
    'E = mc^2',
    '$$',
    '',
    '正文。',
  ].join('\n')
  const units = md.splitUnits(source)
  assert.deepEqual(units.map((u) => u.kind), ['table', 'paragraph'])
  const table = units[0].content
  assert.match(table, /\| 名称 \| 值 \|/)
  const translatedTable = '| Name | Value |\n| --- | --- |\n| a | 1 |'
  const out = md.decorate(source, translationsFor(source, { [table]: translatedTable, '正文。': 'Body.' }))
  assert.match(out, /\| 名称 \| 值 \|\n\| --- \| --- \|\n\| a \| 1 \|\n\n\| Name \| Value \|/)
  assert.match(out, /```js\nconst a = 1\n```/)
})

test('language detection and target selection', () => {
  assert.equal(md.languageOf('磁通量是标量。'), 'zh')
  assert.equal(md.languageOf('Magnetic flux is a scalar quantity.'), 'en')
  assert.equal(md.languageOf('功率因数 0.88 滞后（lagging）：'), 'zh')
  assert.deepEqual(md.translationTarget({ kind: 'paragraph', content: '磁通量是标量。' }), { source: 'zh', target: 'en' })
  assert.deepEqual(md.translationTarget({ kind: 'paragraph', content: 'Magnetic flux is a scalar quantity.' }), { source: 'en', target: 'zh' })
  assert.deepEqual(md.translationTarget({ kind: 'paragraph', content: '功率因数 0.88 滞后（lagging）：' }), { source: 'zh', target: 'en' })
  assert.deepEqual(md.translationTarget({ kind: 'table', content: '| 名称 | 值 |\n| --- | --- |\n| a | 1 |' }), { source: 'zh', target: 'en' })
  assert.equal(md.translationTarget({ kind: 'paragraph', content: '12345' }), null)
  assert.equal(md.translationTarget({ kind: 'paragraph', content: 'const x = { a: 1 };' }), null)
  assert.equal(md.translationTarget({ kind: 'paragraph', content: 'https://example.com/a' }), null)
})

test('cleanTranslation removes headings, bullets and labels', () => {
  assert.equal(md.cleanTranslation('### 3. Important properties', 'heading'), '3. Important properties')
  assert.equal(md.cleanTranslation('- **Scalar nature**: text', 'list'), '**Scalar nature**: text')
  assert.equal(md.cleanTranslation('译文：Magnetic flux.', 'paragraph'), 'Magnetic flux.')
  assert.equal(md.cleanTranslation('```md\nHello\n```', 'paragraph'), 'Hello')
})

test('same source text shares one translation across units', () => {
  const source = '- 重复\n- 重复'
  const out = md.decorate(source, translationsFor(source, { 重复: 'Repeated' }))
  assert.equal((out.match(/Repeated/g) || []).length, 2)
})
