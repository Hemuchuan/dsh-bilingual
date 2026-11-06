import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

function makeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = {}
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body), 'utf8'))
    req.emit('end')
  })
  return req
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(chunk) {
      this.body = Buffer.from(chunk).toString('utf8')
    },
  }
}

async function call(handler, method, route, body) {
  const res = makeRes()
  await handler(makeReq(method, '/api/dsh-bilingual' + route, body), res)
  return { status: res.statusCode, json: JSON.parse(res.body) }
}

test('host retries a missing short segment individually instead of dropping the batch', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-bilingual-retry-'))
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  process.env.DSH_HOME = home

  let handler = null
  const ctx = {
    webServer: {
      register(options) {
        handler = options.handler
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }

  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async (_url, options) => {
    requests += 1
    const payload = JSON.parse(options.body)
    const items = JSON.parse(payload.messages[1].content).items
    // Simulate the model omitting every short item when it is batched:
    // a multi-item request returns only the first item; a single-item retry
    // returns that item.
    const returned = items.length > 1 ? [items[0]] : items
    const content = JSON.stringify({
      items: returned.map((item) => ({
        id: item.id,
        text: item.target === 'en' ? `English ${item.id}` : `中文 ${item.id}`,
      })),
    })
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ choices: [{ message: { content } }] })
      },
    }
  }

  try {
    const mod = await import('../lib/index.js')
    mod.apply(ctx)
    await call(handler, 'POST', '/config', { apiKey: 'sk-retry-1234567890' })
    const result = await call(handler, 'POST', '/translate', {
      items: [
        { id: 1, text: '功率因数 0.88 滞后（lagging）：', target: 'en' },
        { id: 2, text: '三、写成相量', target: 'en' },
      ],
    })
    assert.equal(result.status, 200)
    assert.equal(result.json.items.length, 2)
    assert.equal(result.json.items[0].text, 'English 1')
    assert.equal(result.json.items[1].text, 'English 2')
    assert.ok(requests >= 2, 'expected a batch request plus an individual retry')
  } finally {
    try {
      if (handler !== null) await call(handler, 'POST', '/config', { apiKey: '' })
    } catch {
      // 清理失败不影响测试结论
    }
    globalThis.fetch = originalFetch
    process.env.DSH_HOME = previousHome
    if (previousKey !== undefined) process.env.DEEPSEEK_API_KEY = previousKey
    rmSync(home, { recursive: true, force: true })
  }
})

test('host config + translate route with a fake DeepSeek endpoint', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'dsh-bilingual-test-'))
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY
  process.env.DSH_HOME = home

  let handler = null
  const ctx = {
    webServer: {
      register(options) {
        handler = options.handler
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }

  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ items: [{ id: 1, text: '你好，世界。' }] }) } }],
        })
      },
    }
  }

  try {
    const mod = await import('../lib/index.js')
    mod.apply(ctx)
    assert.ok(handler)

    let result = await call(handler, 'GET', '/config')
    assert.equal(result.status, 200)
    assert.equal(result.json.hasKey, false)

    result = await call(handler, 'POST', '/config', { apiKey: 'sk-test-1234567890', model: 'deepseek-chat' })
    assert.equal(result.status, 200)
    assert.equal(result.json.hasKey, true)
    assert.equal(result.json.keyHint, 'sk-…7890')
    const saved = JSON.parse(readFileSync(path.join(home, 'dsh-bilingual.json'), 'utf8'))
    assert.equal(saved.apiKey, 'sk-test-1234567890')

    result = await call(handler, 'POST', '/translate', { items: [{ id: 1, text: 'Hello, world.', target: 'zh' }] })
    assert.equal(result.status, 200)
    assert.equal(result.json.items[0].text, '你好，世界。')
    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /\/chat\/completions$/)
    assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test-1234567890')

    result = await call(handler, 'POST', '/translate', { items: [] })
    assert.equal(result.status, 400)

    result = await call(handler, 'POST', '/config', { apiKey: '' })
    assert.equal(result.json.hasKey, false)
  } finally {
    globalThis.fetch = originalFetch
    process.env.DSH_HOME = previousHome
    if (previousKey !== undefined) process.env.DEEPSEEK_API_KEY = previousKey
    rmSync(home, { recursive: true, force: true })
  }
})
