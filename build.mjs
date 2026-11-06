/**
 * 把 lib/markdown.cjs 内联进 lib/client.template.js，产出 lib/client.js。
 *
 * 为什么要内联：客户端 bundle 是一个 `window.__ModuleLoader__.load({factory})`
 * 表达式，只能 require 宿主注入的模块（react / primitives），不能 require 本包的
 * 相对文件。所以纯函数在构建时拼进去，测试仍然直接 require markdown.cjs。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const markdown = readFileSync(`${root}lib/markdown.cjs`, 'utf8')
const template = readFileSync(`${root}lib/client.template.js`, 'utf8')

const marker = '    /*__INLINE_MARKDOWN__*/'
if (!template.includes(marker)) throw new Error('client.template.js 里找不到内联标记')

const inlined = `    var DSHBMarkdown = (function () {
      var module = { exports: {} }
      var exports = module.exports
${markdown}
      return module.exports
    })()`

const output = template.replace(marker, inlined)
writeFileSync(`${root}lib/client.js`, output, 'utf8')
console.log(`built lib/client.js (${Buffer.byteLength(output, 'utf8')} bytes)`)
