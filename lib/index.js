/**
 * dsh-bilingual —— 宿主半：DeepSeek 翻译代理 + 配置 API。
 *
 * 为什么翻译要放在宿主：
 *   1. API Key 不进浏览器（不暴露在页面/网络面板里）；
 *   2. 浏览器直连 api.deepseek.com 会被 CORS 拦住；
 *   3. 宿主可以统一做超时、批量、错误归一化。
 *
 * 只注册同源前缀路由 `/api/dsh-bilingual/*`；浏览器半侧用普通 fetch 调用。
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-bilingual'

/** webServer 是唯一硬依赖；没有它浏览器半侧拿不到译文。 */
export const inject = ['webServer']

const API_PREFIX = '/api/dsh-bilingual'
const MAX_BODY_BYTES = 256 * 1024
const MAX_ITEMS = 24
const MAX_TEXT_CHARS = 6000
const BATCH_SIZE = 6

const DEFAULTS = Object.freeze({
  apiKey: '',
  model: 'deepseek-chat',
  baseURL: 'https://api.deepseek.com',
  timeoutMs: 60000,
})

let config = { ...DEFAULTS }
let configPath = ''

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function defaultConfigPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-bilingual.json')
}

function normalizeBaseURL(value) {
  const text = String(value || '').trim()
  if (text === '') return DEFAULTS.baseURL
  let url
  try {
    url = new URL(text)
  } catch {
    throw new HttpError(400, 'Base URL 不是合法 URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, 'Base URL 只支持 http/https')
  return text.replace(/\/+$/, '')
}

function normalizeModel(value) {
  const text = String(value || '').trim()
  if (text === '') return DEFAULTS.model
  if (text.length > 120) throw new HttpError(400, '模型名过长')
  return text
}

function normalizeTimeout(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULTS.timeoutMs
  return Math.max(5000, Math.min(180000, Math.round(n)))
}

function loadConfigSync() {
  configPath = defaultConfigPath()
  try {
    const raw = readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return
    if (typeof parsed.apiKey === 'string') config.apiKey = parsed.apiKey
    if (typeof parsed.model === 'string' && parsed.model.trim() !== '') config.model = parsed.model.trim()
    if (typeof parsed.baseURL === 'string' && parsed.baseURL.trim() !== '') {
      try {
        config.baseURL = normalizeBaseURL(parsed.baseURL)
      } catch {
        config.baseURL = DEFAULTS.baseURL
      }
    }
    if (parsed.timeoutMs !== undefined) config.timeoutMs = normalizeTimeout(parsed.timeoutMs)
  } catch {
    // 文件不存在 / 损坏 → 保持默认；绝不让配置阻断启动
  }
}

async function persistConfig() {
  await mkdir(path.dirname(configPath), { recursive: true })
  const tmp = `${configPath}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await rename(tmp, configPath)
  try {
    await chmod(configPath, 0o600)
  } catch {
    // Windows 上 chmod 基本无效；失败不阻断
  }
}

function effectiveKey() {
  const fromConfig = typeof config.apiKey === 'string' ? config.apiKey.trim() : ''
  if (fromConfig !== '') return { key: fromConfig, source: 'plugin' }
  const fromEnv = typeof process.env.DEEPSEEK_API_KEY === 'string' ? process.env.DEEPSEEK_API_KEY.trim() : ''
  if (fromEnv !== '') return { key: fromEnv, source: 'env' }
  return { key: '', source: 'none' }
}

/** DSH 的凭据服务（可选）。存在时优先复用 `DEEPSEEK_API_KEY`，用户不必再贴一遍。 */
let credentials = null

async function resolveKey(override) {
  if (typeof override === 'string' && override.trim() !== '') return { key: override.trim(), source: 'request' }
  const local = effectiveKey()
  if (local.key !== '') return local
  try {
    if (credentials !== null && typeof credentials.resolve === 'function') {
      const hit = await credentials.resolve('DEEPSEEK_API_KEY')
      if (hit !== null && hit !== undefined && typeof hit.value === 'string' && hit.value.trim() !== '') {
        return { key: hit.value.trim(), source: 'credentials' }
      }
    }
  } catch {
    // 凭据服务不可用 → 当作未配置
  }
  return { key: '', source: 'none' }
}

function maskKey(key) {
  if (key === '') return ''
  if (key.length <= 8) return `${key.slice(0, 2)}…${key.slice(-2)}`
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}

async function publicConfig() {
  const current = await resolveKey()
  return {
    ok: true,
    hasKey: current.key !== '',
    keySource: current.source,
    keyHint: maskKey(current.key),
    model: config.model,
    baseURL: config.baseURL,
    timeoutMs: config.timeoutMs,
    configPath,
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  const bytes = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.length),
    'cache-control': 'no-store',
  })
  res.end(bytes)
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        req.destroy()
        reject(new HttpError(413, '请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.trim() === '' ? {} : JSON.parse(text))
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function parseJsonLoose(value) {
  let text = String(value === null || value === undefined ? '' : value).trim()
  if (text === '') return null
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  try {
    return JSON.parse(text)
  } catch {
    // 继续尝试截取
  }
  const objectStart = text.indexOf('{')
  const objectEnd = text.lastIndexOf('}')
  if (objectStart !== -1 && objectEnd > objectStart) {
    try {
      return JSON.parse(text.slice(objectStart, objectEnd + 1))
    } catch {
      // 继续
    }
  }
  const arrayStart = text.indexOf('[')
  const arrayEnd = text.lastIndexOf(']')
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(text.slice(arrayStart, arrayEnd + 1))
    } catch {
      // 放弃
    }
  }
  return null
}

function extractItems(parsed) {
  if (parsed === null || parsed === undefined) return null
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed.items)) return parsed.items
  if (Array.isArray(parsed.translations)) return parsed.translations
  if (Array.isArray(parsed.results)) return parsed.results
  if (parsed.items !== null && typeof parsed.items === 'object') {
    return Object.keys(parsed.items).map((key) => ({ id: key, text: parsed.items[key] }))
  }
  return null
}

function normalizeItems(body) {
  const raw = Array.isArray(body?.items) ? body.items : null
  if (raw === null || raw.length === 0) throw new HttpError(400, 'items 不能为空')
  if (raw.length > MAX_ITEMS) throw new HttpError(400, `一次最多 ${MAX_ITEMS} 段`)
  return raw.map((item, index) => {
    const text = String(item?.text ?? '').trim()
    if (text === '') throw new HttpError(400, `第 ${index + 1} 段没有文本`)
    if (text.length > MAX_TEXT_CHARS) throw new HttpError(400, `第 ${index + 1} 段超过 ${MAX_TEXT_CHARS} 字`)
    const target = item?.target === 'en' ? 'en' : 'zh'
    return {
      id: Number.isInteger(item?.id) ? item.id : index + 1,
      text,
      target,
    }
  })
}

function chunk(array, size) {
  const out = []
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size))
  return out
}

const SYSTEM_PROMPT = [
  'You are a professional bilingual translator for the DeepSeek Harness chat UI.',
  'Translate every item into the target language given by each item: zh = Simplified Chinese, en = natural English.',
  'Return ONLY a JSON object in this exact shape: {"items":[{"id":1,"text":"..."}]}.',
  'Keep every id exactly once and in the original order.',
  'Every id must be returned, including short headings, labels and list-item text; never return an empty string.',
  'Preserve Markdown inline formatting: **bold**, *italic*, `code`, [links](url), $math$, and line breaks.',
  'For table items, preserve the Markdown table structure (header row, separator row, pipe columns) and translate each cell; keep the same rows and columns.',
  'Do NOT add heading markers (#), bullet markers (-, *), numbering, surrounding quotes, or explanations.',
  'Keep code, file paths, URLs, formulas, product names and technical terms unchanged.',
  'Translate the full meaning naturally; never summarize or omit anything.',
  'If a segment is already in the target language, return it unchanged.',
].join('\n')

function validTranslationText(text, target, source) {
  if (typeof text !== 'string' || text.trim() === '') return false
  if (typeof source === 'string' && source.trim() !== '') {
    if (text.replace(/\s+/g, ' ').trim() === source.replace(/\s+/g, ' ').trim()) return false
  }
  const cjk = (text.match(/[\u3400-\u9fff]/g) || []).length
  const latin = (text.match(/[A-Za-z]/g) || []).length
  if (target === 'en') return latin >= 2 && latin >= cjk * 1.5
  if (target === 'zh') return cjk >= 1
  return true
}

async function callDeepSeek(key, items) {
  const url = `${config.baseURL.replace(/\/+$/, '')}/chat/completions`
  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ items }) },
    ],
    temperature: 0.2,
    max_tokens: 4096,
    response_format: { type: 'json_object' },
  }

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.timeoutMs),
    })
  } catch (error) {
    const reason = String(error?.message || error)
    if (/timeout|abort/i.test(reason)) throw new HttpError(504, `DeepSeek 请求超时（${Math.round(config.timeoutMs / 1000)} 秒）`)
    throw new HttpError(502, `无法连接 DeepSeek：${reason}`)
  }

  const raw = await response.text()
  if (!response.ok) {
    let detail = raw.slice(0, 500)
    try {
      const parsed = JSON.parse(raw)
      detail = parsed?.error?.message || parsed?.message || detail
    } catch {
      // 保留原文
    }
    if (response.status === 401) throw new HttpError(401, 'DeepSeek API Key 无效或已过期')
    if (response.status === 402) throw new HttpError(402, 'DeepSeek 账户余额不足')
    throw new HttpError(502, `DeepSeek 返回 ${response.status}：${detail}`)
  }

  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw new HttpError(502, 'DeepSeek 返回的不是 JSON')
  }

  const content = data?.choices?.[0]?.message?.content
  const parsed = typeof content === 'string' ? parseJsonLoose(content) : null
  const list = extractItems(parsed)
  if (list === null) throw new HttpError(502, 'DeepSeek 译文格式无法解析')

  const byId = new Map()
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i]
    if (item === null || typeof item !== 'object') continue
    const text = item.text ?? item.translation ?? item.translated ?? item.value
    if (typeof text !== 'string') continue
    const key = item.id !== undefined ? String(item.id) : String(i + 1)
    byId.set(key, text.trim())
  }

  const out = []
  const missing = []
  for (const item of items) {
    const translated = byId.get(String(item.id))
    if (validTranslationText(translated, item.target, item.text)) {
      out.push({ id: item.id, text: translated.trim() })
    } else {
      missing.push(item)
    }
  }
  return { items: out, missing }
}

async function translateItems(items, keyOverride) {
  const current = await resolveKey(keyOverride)
  if (current.key === '') {
    throw new HttpError(400, '还没有配置 DeepSeek API Key。请打开 设置 → 双语，填入 Key 后再试。')
  }

  const results = []
  const retry = []
  let lastError = null

  // 第一轮：按批请求。某一批失败/漏段时不丢弃已经成功的批次，
  // 只把失败和漏掉的单元留给第二轮逐条重试。
  for (const batch of chunk(items, BATCH_SIZE)) {
    try {
      const result = await callDeepSeek(current.key, batch)
      results.push(...result.items)
      if (result.missing.length > 0) retry.push(...result.missing)
    } catch (error) {
      lastError = error
      const status = typeof error?.status === 'number' ? error.status : 0
      if (status === 401 || status === 402 || status === 403) throw error
      retry.push(...batch)
    }
  }

  // 第二轮：一条一条重试，避免一个短标题/短标签拖死整批。
  for (const item of retry) {
    try {
      const result = await callDeepSeek(current.key, [item])
      results.push(...result.items)
    } catch (error) {
      lastError = error
      const status = typeof error?.status === 'number' ? error.status : 0
      if (status === 401 || status === 402 || status === 403) throw error
    }
  }

  if (results.length === 0) {
    throw lastError || new HttpError(502, 'DeepSeek 没有返回任何译文')
  }
  return results
}

function routeOf(req) {
  return (req.url ?? '').split('?')[0].slice(API_PREFIX.length) || '/'
}

export function apply(ctx) {
  loadConfigSync()

  try {
    credentials = typeof ctx.get === 'function' ? ctx.get('credentials') ?? null : ctx.credentials ?? null
  } catch {
    credentials = null
  }

  try {
    ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        const route = routeOf(req)
        try {
          if (route === '/config' && req.method === 'GET') {
            return sendJson(res, 200, await publicConfig())
          }

          if (route === '/config' && req.method === 'POST') {
            const body = await readBody(req)
            if (Object.prototype.hasOwnProperty.call(body, 'apiKey')) {
              if (body.apiKey === null) config.apiKey = ''
              else if (typeof body.apiKey === 'string') config.apiKey = body.apiKey.trim()
              else throw new HttpError(400, 'apiKey 必须是字符串')
            }
            if (Object.prototype.hasOwnProperty.call(body, 'model')) config.model = normalizeModel(body.model)
            if (Object.prototype.hasOwnProperty.call(body, 'baseURL')) config.baseURL = normalizeBaseURL(body.baseURL)
            if (Object.prototype.hasOwnProperty.call(body, 'timeoutMs')) config.timeoutMs = normalizeTimeout(body.timeoutMs)
            await persistConfig()
            return sendJson(res, 200, await publicConfig())
          }

          if (route === '/translate' && req.method === 'POST') {
            const body = await readBody(req)
            const items = normalizeItems(body)
            const translations = await translateItems(items, body?.apiKey)
            return sendJson(res, 200, { ok: true, items: translations })
          }

          if (route === '/test' && req.method === 'POST') {
            const body = await readBody(req)
            const sample = await translateItems([{ id: 1, text: 'Hello, world.', target: 'zh' }], body?.apiKey)
            return sendJson(res, 200, { ok: true, sample: sample[0]?.text ?? '' })
          }

          if (route === '/health' && req.method === 'GET') {
            const current = await resolveKey()
            return sendJson(res, 200, { ok: true, hasKey: current.key !== '', keySource: current.source })
          }

          return sendJson(res, 404, { error: `未知接口: ${route}` })
        } catch (error) {
          const status = typeof error?.status === 'number' ? error.status : 500
          const message = String(error?.message || error)
          if (status >= 500) {
            try {
              ctx.logger?.warn?.(`[dsh-bilingual] ${message}`)
            } catch {
              // 忽略
            }
          }
          return sendJson(res, status, { error: message })
        }
      },
    })
  } catch (error) {
    // 路由注册失败只让翻译不可用，绝不能影响宿主启动
    try {
      ctx.logger?.error?.(`[dsh-bilingual] 路由注册失败：${String(error?.message || error)}`)
    } catch {
      // 忽略
    }
    return
  }

  resolveKey()
    .then((current) => {
      ctx.logger?.info?.(
        `[dsh-bilingual] 就绪（${current.key === '' ? '未配置 Key' : `Key ${maskKey(current.key)}（${current.source}）`}；模型 ${config.model}）`,
      )
    })
    .catch(() => {})
}

export const __test = {
  normalizeBaseURL,
  normalizeModel,
  normalizeTimeout,
  normalizeItems,
  parseJsonLoose,
  extractItems,
  maskKey,
}
