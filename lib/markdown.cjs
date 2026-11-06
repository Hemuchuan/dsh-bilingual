/**
 * dsh-bilingual —— Markdown 段落切分与双语拼装（纯函数，可在 Node 里单测）。
 *
 * 设计目标：**不重排原文的 Markdown 结构**，只在每段原文后面插入一段译文。
 * 因此这里做的是“行级切分 + 行尾插入”，而不是把 Markdown 解析成 AST：
 *   - 段落：在段尾插入空行 + 译文；
 *   - 列表项：在列表项自己的文字后面插入空行 + 缩进后的译文（仍属于同一个 <li>）；
 *   - 标题：译文直接拼在标题行末尾（截图里的 `3. 重要物理性质 3. Important...`）；
 *   - 引用：插入 `>` 空行 + `> 译文`；
 *   - 代码块、表格、块级公式、HTML 块：原样跳过，绝不翻译。
 *
 * 这个文件是 CommonJS；build.mjs 会把它内联进浏览器 bundle，tests 直接 require 它。
 */

'use strict'

var CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/g
var LATIN_RE = /[A-Za-z]/g

function countMatches(text, regex) {
  var matches = String(text).match(regex)
  return matches === null ? 0 : matches.length
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)
}

function isHorizontalRule(line) {
  return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)
}

function isFenceStart(line) {
  return /^\s*(`{3,}|~{3,})/.test(line)
}

var BLOCK_TAG_RE = /^\s*<(?:address|article|aside|blockquote|details|div|dl|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|main|nav|ol|p|pre|section|summary|table|ul|video|audio|iframe|script|style|svg)\b/i

function isBlockStart(line) {
  return (
    /^(#{1,6})\s+/.test(line) ||
    /^\s*>/.test(line) ||
    isFenceStart(line) ||
    /^\s*\$\$/.test(line) ||
    isHorizontalRule(line) ||
    /^\s*([-*+]|\d+[.)])\s+/.test(line) ||
    BLOCK_TAG_RE.test(line)
  )
}

/**
 * 把一段 Markdown 切成可翻译单元。
 * 返回的每个单元都带 lineStart / lineEnd（0 基、含端点）与 content。
 */
function splitUnits(text) {
  var source = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : ''
  var lines = source.split('\n')
  var units = []
  var i = 0

  while (i < lines.length) {
    var line = lines[i]

    if (line.trim() === '') {
      i += 1
      continue
    }

    // 代码围栏：整块跳过（含未闭合的尾巴）
    if (isFenceStart(line)) {
      var fenceMatch = line.match(/^\s*(`{3,}|~{3,})/)
      var fenceChar = fenceMatch[1].charAt(0)
      var fenceLen = fenceMatch[1].length
      i += 1
      while (i < lines.length) {
        var closeMatch = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/)
        if (closeMatch !== null && closeMatch[1].charAt(0) === fenceChar && closeMatch[1].length >= fenceLen) {
          i += 1
          break
        }
        i += 1
      }
      continue
    }

    // 块级公式 $$ ... $$
    if (/^\s*\$\$/.test(line)) {
      i += 1
      while (i < lines.length && !/\$\$\s*$/.test(lines[i])) i += 1
      i += 1
      continue
    }

    // 表格：表头 + 分隔行 + 连续含 | 的行
    if (line.indexOf('|') !== -1 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      i += 2
      while (i < lines.length && lines[i].trim() !== '' && lines[i].indexOf('|') !== -1) i += 1
      continue
    }

    // 块级 HTML：整块跳过
    if (BLOCK_TAG_RE.test(line)) {
      i += 1
      while (i < lines.length && lines[i].trim() !== '') i += 1
      continue
    }

    // 标题
    var headingMatch = line.match(/^(#{1,6})\s+(.*)$/)
    if (headingMatch !== null) {
      var headingContent = headingMatch[2].replace(/\s+#+\s*$/, '').trim()
      if (headingContent !== '') {
        units.push({
          kind: 'heading',
          lineStart: i,
          lineEnd: i,
          content: headingContent,
        })
      }
      i += 1
      continue
    }

    // 列表项
    var listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/)
    if (listMatch !== null) {
      var indent = listMatch[1].length
      var marker = listMatch[2]
      var contentIndent = indent + marker.length + 1
      var j = i + 1
      while (j < lines.length) {
        var next = lines[j]
        if (next.trim() === '') break
        var lead = next.match(/^\s*/)[0].length
        var nextIsMarker = /^(\s*)([-*+]|\d+[.)])\s+/.test(next)
        if (nextIsMarker) break
        if (lead <= indent) break
        j += 1
      }
      var contentLines = lines.slice(i, j)
      var firstContent = listMatch[3]
      var rest = contentLines.slice(1).map(function (part) {
        return part.replace(new RegExp('^\\s{0,' + contentIndent + '}'), '')
      })
      var listContent = [firstContent].concat(rest).join('\n').trim()
      if (listContent !== '') {
        units.push({
          kind: 'list',
          lineStart: i,
          lineEnd: j - 1,
          content: listContent,
          indent: indent,
          contentIndent: contentIndent,
        })
      }
      i = j
      continue
    }

    // 引用
    if (/^\s*>/.test(line)) {
      var q = i
      var quoteParts = []
      while (q < lines.length && /^\s*>/.test(lines[q])) {
        quoteParts.push(lines[q].replace(/^\s*>\s?/, ''))
        q += 1
      }
      var quoteContent = quoteParts.join('\n').trim()
      if (quoteContent !== '') {
        units.push({
          kind: 'quote',
          lineStart: i,
          lineEnd: q - 1,
          content: quoteContent,
        })
      }
      i = q
      continue
    }

    // 分隔线
    if (isHorizontalRule(line)) {
      i += 1
      continue
    }

    // 缩进代码块（4 空格 / Tab 开头，且不是列表）：整块跳过
    if (/^( {4,}|\t)/.test(line) && !/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      i += 1
      while (i < lines.length && (lines[i].trim() === '' || /^( {4,}|\t)/.test(lines[i]))) i += 1
      continue
    }

    // 普通段落
    var p = i
    var paragraphParts = []
    while (p < lines.length && lines[p].trim() !== '') {
      if (p > i && isBlockStart(lines[p])) break
      if (p > i && lines[p].indexOf('|') !== -1 && p + 1 < lines.length && isTableSeparator(lines[p + 1])) break
      paragraphParts.push(lines[p])
      p += 1
    }
    if (p === i) {
      i += 1
      continue
    }
    var paragraphContent = paragraphParts.join('\n').trim()
    if (paragraphContent !== '') {
      units.push({
        kind: 'paragraph',
        lineStart: i,
        lineEnd: p - 1,
        content: paragraphContent,
      })
    }
    i = p
  }

  return units
}

/** 译文缓存键：同文不同结构（标题 / 列表 / 段落）分开存，避免缓存串味。 */
function unitKey(unit) {
  return unit.kind + '\u0000' + unit.content
}

/** 去掉 Markdown 标记后再判断语言，避免代码/公式/链接干扰。 */
function textForLanguage(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_~>#]/g, ' ')
}

/**
 * 判断一段文字的主要语言：'zh' / 'en' / null（不翻）。
 *
 * 中文优先：只要有两个以上汉字，并且汉字占比不算太低（>= 30%）或句子里有
 * 中文标点，就按中文处理。这样“功率因数 0.88 滞后（lagging）”这类
 * 中文为主、夹一个英文术语的句子不会被误判成“中英混排”而漏翻；
 * 真正的英文句子仍然走英文分支（翻成中文）。
 */
function languageOf(text) {
  var plain = textForLanguage(text)
  var cjk = countMatches(plain, CJK_RE)
  var latin = countMatches(plain, LATIN_RE)
  var total = cjk + latin
  if (total < 2) return null
  var cjkRatio = cjk / total
  var latinRatio = latin / total
  if (cjk >= 2 && (cjkRatio >= 0.3 || /[。！？；：，、]/.test(plain))) return 'zh'
  if (latinRatio > 0.6 && /\s/.test(plain.trim())) return 'en'
  if (cjk > 0) return 'zh'
  return null
}

/** 这个单元是否值得送翻。 */
function translationTarget(unit) {
  if (unit === null || unit === undefined) return null
  if (['heading', 'paragraph', 'list', 'quote'].indexOf(unit.kind) === -1) return null
  var content = String(unit.content || '').trim()
  if (content.length < 2) return null
  if (/^(https?:\/\/|www\.)\S+$/i.test(content)) return null
  if (/^\s*!?\[[^\]]*\]\([^)]*\)\s*$/.test(content)) return null
  // 纯代码 / 纯符号：没有汉字且代码符号占比高
  var noCjk = countMatches(content, CJK_RE) === 0
  var symbols = countMatches(content, /[{}[\]();=<>|\\]/g)
  if (noCjk && content.length > 0 && symbols / content.length > 0.22) return null
  if (noCjk && /^\s*(?:const|let|var|function|class|import|export|def|return|if|for|while|async|await)\b/.test(content)) return null
  if (noCjk && /(?:=>|\{\s*$)/.test(content)) return null
  var source = languageOf(content)
  if (source === null) return null
  return { source: source, target: source === 'zh' ? 'en' : 'zh' }
}

/** 去掉模型可能带回来的结构前缀 / 说明前缀。 */
function cleanTranslation(raw, kind) {
  var text = String(raw === null || raw === undefined ? '' : raw).trim()
  if (text === '') return ''
  text = text.replace(/^```(?:json|markdown|md|text)?\s*/i, '').replace(/\s*```$/, '').trim()
  text = text.replace(/^(?:译文|翻译|Translation|Translated text)\s*[:：]\s*/i, '').trim()
  if (kind === 'heading') text = text.replace(/^#{1,6}\s+/, '').replace(/\s*\n+\s*/g, ' ')
  if (kind === 'list') text = text.replace(/^\s*([-*+]|\d+[.)])\s+/, '')
  if (kind === 'quote') text = text.replace(/^\s*>\s?/, '')
  return text.trim()
}

/**
 * 把译文插回原文。translations 是 { [unitKey(unit)]: translatedText }。
 * 未命中的单元保持原样；同一个原文出现多次时共用一条译文。
 */
function decorate(text, translations) {
  var source = typeof text === 'string' ? text.replace(/\r\n?/g, '\n') : ''
  var lines = source.split('\n')
  var units = splitUnits(source)
  var append = Object.create(null)

  for (var u = 0; u < units.length; u += 1) {
    var unit = units[u]
    var translated = translations !== null && translations !== undefined ? translations[unitKey(unit)] : undefined
    if (translated === undefined || translated === null) continue
    var clean = cleanTranslation(translated, unit.kind)
    if (clean === '') continue

    if (unit.kind === 'heading') {
      lines[unit.lineStart] = lines[unit.lineStart].replace(/\s+#+\s*$/, '') + ' ' + clean
      continue
    }

    if (unit.kind === 'list') {
      var pad = new Array(unit.contentIndent + 1).join(' ')
      var listBlock = clean
        .split('\n')
        .map(function (part) {
          return pad + part
        })
        .join('\n')
      // 末尾留一个换行：下一项之前保持一个空行（与截图的列表间距一致）
      append[unit.lineEnd] = '\n\n' + listBlock + '\n'
      continue
    }

    if (unit.kind === 'quote') {
      var quoteBlock = clean
        .split('\n')
        .map(function (part) {
          return '> ' + part
        })
        .join('\n')
      append[unit.lineEnd] = '\n>\n' + quoteBlock
      continue
    }

    append[unit.lineEnd] = '\n\n' + clean
  }

  var out = ''
  for (var i = 0; i < lines.length; i += 1) {
    out += lines[i]
    if (append[i] !== undefined) out += append[i]
    if (i < lines.length - 1) out += '\n'
  }
  return out
}

module.exports = {
  splitUnits: splitUnits,
  unitKey: unitKey,
  languageOf: languageOf,
  translationTarget: translationTarget,
  cleanTranslation: cleanTranslation,
  decorate: decorate,
  isTableSeparator: isTableSeparator,
  isBlockStart: isBlockStart,
}
