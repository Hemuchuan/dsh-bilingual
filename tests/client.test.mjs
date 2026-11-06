import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function loadClient() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  let loaded = null

  class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }
  }

  const React = {
    createElement: (...args) => ({ args }),
    Component,
    Fragment: Symbol('Fragment'),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  }

  const primitives = {
    MarkdownText: function MarkdownText() {},
    JsonBlock: function JsonBlock() {},
  }

  const window = {
    __ModuleLoader__: {
      load: (entry) => {
        loaded = entry.factory((name) => {
          if (name === 'react') return React
          if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives
          throw new Error('unexpected require: ' + name)
        })
      },
    },
  }

  const context = {
    window,
    console,
    URL,
    Map,
    Set,
    Symbol,
    setTimeout,
    clearTimeout,
    fetch: () => Promise.reject(new Error('no network in test')),
    sessionStorage: {
      getItem: () => null,
      setItem: () => {},
    },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
  }
  vm.runInNewContext(source, context, { filename: 'client.js' })
  return loaded
}

test('client bundle loads and registers all three slots', () => {
  const loaded = loadClient()
  assert.equal(loaded.name, 'dsh-bilingual')
  const registered = []
  const ctx = {
    effect: (fn) => {
      fn()
      return () => {}
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    slots: {
      inject: (name, callback) => {
        const off = callback()
        registered.push(name)
        return off
      },
      register: (meta, component) => {
        assert.ok(meta.name)
        assert.ok(typeof component === 'function')
        return () => {}
      },
    },
  }
  loaded.apply(ctx)
  assert.deepEqual(registered.sort(), [
    'conversation.chat.node',
    'conversation.session.header.actions',
    'settings.section',
  ])
})

test('client internals expose the markdown pipeline', () => {
  const loaded = loadClient()
  const units = loaded.__internals.splitUnits('### 标题\n\n正文。')
  assert.equal(units.map((unit) => unit.kind).join(','), 'heading,paragraph')
  assert.equal(loaded.__internals.translationTarget(units[1]).target, 'en')
})
