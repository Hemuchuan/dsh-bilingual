/**
 * dsh-bilingual —— 浏览器半（手写 __ModuleLoader__ bundle，无需构建工具）。
 *
 * 三件事：
 *   1. 影子注册 assistant-step 渲染器，把每个正文块的 markdown 交给
 *      `decorate()`：原文 + 每段下面的译文，仍然走官方 `MarkdownText`；
 *   2. 在会话头注册「双语」开关（sessionStorage，手动开启，默认关）；
 *   3. 在 设置 → 双语 里配置 DeepSeek Key / 模型 / Base URL，并测试连接。
 *
 * 翻译只改显示层：会话记录、发给模型的上下文、复制按钮都仍是原文。
 */

window.__ModuleLoader__.load({
  id: 'dsh-bilingual',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    /*__INLINE_MARKDOWN__*/

    var React = require('react')
    var h = React.createElement

    var primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      primitives = null
    }

    var MarkdownText = primitives !== null && primitives.MarkdownText !== null && primitives.MarkdownText !== undefined ? primitives.MarkdownText : FallbackMarkdown
    var JsonBlock = primitives !== null && primitives.JsonBlock !== null && primitives.JsonBlock !== undefined ? primitives.JsonBlock : null
    if (primitives !== null && primitives.default !== null && primitives.default !== undefined) {
      if (primitives.default.MarkdownText !== null && primitives.default.MarkdownText !== undefined) MarkdownText = primitives.default.MarkdownText
      if (primitives.default.JsonBlock !== null && primitives.default.JsonBlock !== undefined) JsonBlock = primitives.default.JsonBlock
    }

    var API = '/api/dsh-bilingual'
    var ENABLED_KEY = 'dsh-bilingual.enabled'
    var CACHE_KEY = 'dsh-bilingual.cache.v4'
    var LEGACY_CACHE_KEY = 'dsh-bilingual.cache.v3'
    var LEGACY_CACHE_KEY_1 = 'dsh-bilingual.cache.v2'
    var LEGACY_CACHE_KEY_2 = 'dsh-bilingual.cache.v1'
    var CACHE_LIMIT = 400
    var STYLE_ID = 'dsh-bilingual-styles'

    // ---------------------------------------------------------------- 小工具

    function safeGetStorage(kind, key) {
      try {
        if (kind === 'session' && typeof sessionStorage !== 'undefined') return sessionStorage.getItem(key)
        if (kind === 'local' && typeof localStorage !== 'undefined') return localStorage.getItem(key)
      } catch (error) {
        return null
      }
      return null
    }

    function safeSetStorage(kind, key, value) {
      try {
        if (kind === 'session' && typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, value)
        if (kind === 'local' && typeof localStorage !== 'undefined') localStorage.setItem(key, value)
      } catch (error) {
        // 隐私模式 / 配额满：只影响下次是否记得
      }
    }

    function readEnabled() {
      return safeGetStorage('session', ENABLED_KEY) === '1'
    }

    function loadCache() {
      var map = new Map()
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(LEGACY_CACHE_KEY)
          localStorage.removeItem(LEGACY_CACHE_KEY_1)
          localStorage.removeItem(LEGACY_CACHE_KEY_2)
        }
      } catch (error) {
        // 清不掉旧缓存也不影响：下面读的是新 key
      }
      var raw = safeGetStorage('local', CACHE_KEY)
      if (raw === null) return map
      try {
        var parsed = JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object') return map
        Object.keys(parsed).forEach(function (key) {
          if (typeof parsed[key] === 'string' && parsed[key].trim() !== '') map.set(key, parsed[key])
        })
      } catch (error) {
        return map
      }
      return map
    }

    var cache = loadCache()
    var saveTimer = null

    function scheduleCacheSave() {
      if (typeof setTimeout !== 'function') return
      if (saveTimer !== null) return
      saveTimer = setTimeout(function () {
        saveTimer = null
        try {
          var object = {}
          var count = 0
          cache.forEach(function (value, key) {
            if (count >= CACHE_LIMIT) return
            object[key] = value
            count += 1
          })
          safeSetStorage('local', CACHE_KEY, JSON.stringify(object))
        } catch (error) {
          // 存不下就算了，内存缓存仍然有效
        }
      }, 400)
    }

    // ---------------------------------------------------------------- 响应式池

    var store = {
      enabled: readEnabled(),
      version: 0,
      listeners: new Set(),
      pending: 0,
      lastError: '',
      lastErrorStatus: 0,
      retryToken: 0,
      subscribe: function (listener) {
        store.listeners.add(listener)
        return function () {
          store.listeners.delete(listener)
        }
      },
      getVersion: function () {
        return store.version
      },
      bump: function () {
        store.version += 1
        store.listeners.forEach(function (listener) {
          try {
            listener()
          } catch (error) {
            // 单个订阅者失败不影响其它 UI
          }
        })
      },
      setEnabled: function (value) {
        store.enabled = value === true
        safeSetStorage('session', ENABLED_KEY, store.enabled ? '1' : '0')
        store.bump()
      },
      setError: function (message) {
        store.lastError = message === null || message === undefined ? '' : String(message)
        store.bump()
      },
      retry: function () {
        store.retryToken += 1
        store.lastError = ''
        store.bump()
      },
      get: function (key) {
        return cache.get(key)
      },
      put: function (key, value) {
        cache.set(key, value)
        if (cache.size > CACHE_LIMIT) {
          var first = cache.keys().next()
          if (first.done !== true) cache.delete(first.value)
        }
        scheduleCacheSave()
      },
    }

    var inflight = new Set()

    /** 一条译文是否真的像目标语言；空串 / 原样返回都不算。 */
    function validTranslation(text, target, source) {
      if (typeof text !== 'string' || text.trim() === '') return false
      if (typeof source === 'string' && source.trim() !== '') {
        var normalizedText = text.replace(/\s+/g, ' ').trim()
        var normalizedSource = source.replace(/\s+/g, ' ').trim()
        if (normalizedText === normalizedSource) return false
      }
      var cjk = (text.match(/[\u3400-\u9fff]/g) || []).length
      var latin = (text.match(/[A-Za-z]/g) || []).length
      if (target === 'en') return latin >= 2 && latin >= cjk * 1.5
      if (target === 'zh') return cjk >= 1
      return true
    }

    /**
     * 批量请求偶尔会漏掉某个短标题/短标签（模型只回了长段落）。
     * 漏掉的单元单独重试——一次只发一条，避免一条坏数据拖垮整批。
     */
    var scheduledRetries = new Set()
    var retryState = new Map()

    /** 读缓存前先校验目标语言；命中但内容不对的条目直接删掉重翻。 */
    function cachedValue(unit, target) {
      var key = DSHBMarkdown.unitKey(unit)
      if (!cache.has(key)) return null
      var value = cache.get(key)
      if (validTranslation(value, target, unit.content)) return value
      cache.delete(key)
      scheduleCacheSave()
      return null
    }

    function cachedValueForKey(key, target, source) {
      if (!cache.has(key)) return null
      var value = cache.get(key)
      if (validTranslation(value, target, source)) return value
      cache.delete(key)
      scheduleCacheSave()
      return null
    }

    function scheduleRetries(missing) {
      if (store.enabled !== true) return
      if (store.lastErrorStatus === 401 || store.lastErrorStatus === 402 || store.lastErrorStatus === 403) return
      missing.forEach(function (item, index) {
        if (cachedValueForKey(item.key, item.target, item.text) !== null || scheduledRetries.has(item.key)) return
        scheduledRetries.add(item.key)
        setTimeout(function () {
          scheduledRetries.delete(item.key)
          retryOne(item)
        }, 700 + index * 450)
      })
    }

    function retryOne(item) {
      if (store.enabled !== true || cachedValueForKey(item.key, item.target, item.text) !== null) return
      var used = retryState.get(item.key) || 0
      if (used >= 2) return
      retryState.set(item.key, used + 1)
      apiPost('/translate', { items: [{ id: 1, text: item.text, target: item.target }] })
        .then(function (data) {
          var list = data !== null && data !== undefined && Array.isArray(data.items) ? data.items : []
          var translated = list[0] !== undefined && list[0] !== null ? list[0].text : ''
          if (validTranslation(translated, item.target, item.text)) {
            store.put(item.key, translated.trim())
            store.lastError = ''
            store.lastErrorStatus = 0
            store.bump()
            return
          }
          if (used + 1 < 2) {
            setTimeout(function () {
              retryOne(item)
            }, 1200 * (used + 1))
          }
        })
        .catch(function (error) {
          store.lastErrorStatus = error !== null && error !== undefined && typeof error.status === 'number' ? error.status : 0
          if (store.lastErrorStatus === 401 || store.lastErrorStatus === 402 || store.lastErrorStatus === 403) return
          if (used + 1 < 2) {
            setTimeout(function () {
              retryOne(item)
            }, 1500 * (used + 1))
          }
        })
    }

    function translationsFor(text) {
      var units = DSHBMarkdown.splitUnits(text)
      var out = {}
      for (var i = 0; i < units.length; i += 1) {
        var target = DSHBMarkdown.translationTarget(units[i])
        if (target === null) continue
        var value = cachedValue(units[i], target.target)
        if (value !== null) out[DSHBMarkdown.unitKey(units[i])] = value
      }
      return out
    }

    function ensureTranslations(text) {
      if (store.enabled !== true) return
      var units = DSHBMarkdown.splitUnits(text)
      var missing = []
      for (var i = 0; i < units.length; i += 1) {
        var unit = units[i]
        var target = DSHBMarkdown.translationTarget(unit)
        if (target === null) continue
        var key = DSHBMarkdown.unitKey(unit)
        if (cachedValue(unit, target.target) !== null || inflight.has(key)) continue
        // 心跳每 4 秒扫一次；失败 3 次后不再自动重试，避免持续烧 API。
        if ((retryState.get(key) || 0) >= 3) continue
        missing.push({ key: key, text: unit.content, target: target.target, kind: unit.kind })
      }
      if (missing.length === 0) return

      // 按目标语言分组：同一个请求里混着 zh→en 和 en→zh，模型更容易漏短句。
      var groups = {}
      missing.forEach(function (item) {
        if (groups[item.target] === undefined) groups[item.target] = []
        groups[item.target].push(item)
      })

      Object.keys(groups).forEach(function (target) {
        var group = groups[target]
        // 短标题/短标签单独发：它们正是批量请求里最容易被模型漏掉的部分。
        var short = group.filter(function (item) {
          return item.kind === 'table' || item.text.length <= 160
        })
        var long = group.filter(function (item) {
          return item.text.length > 160
        })
        short.forEach(function (item, index) {
          setTimeout(function () {
            requestGroup([item])
          }, index * 220)
        })
        if (long.length > 0) requestGroup(long)
      })
    }

    function requestGroup(group) {
      if (group.length === 0) return
      group.forEach(function (item) {
        inflight.add(item.key)
      })
      store.pending += 1
      store.bump()

      var payload = {
        items: group.map(function (item, index) {
          return { id: index + 1, text: item.text, target: item.target }
        }),
      }
      var still = group.slice()

      apiPost('/translate', payload)
        .then(function (data) {
          var byId = {}
          var list = data !== null && data !== undefined && Array.isArray(data.items) ? data.items : []
          list.forEach(function (item) {
            if (item !== null && item !== undefined && item.id !== undefined) byId[String(item.id)] = item.text
          })
          var got = 0
          group.forEach(function (item, index) {
            var translated = byId[String(index + 1)]
            if (validTranslation(translated, item.target, item.text)) {
              store.put(item.key, translated.trim())
              got += 1
            }
          })
          if (got > 0) {
            store.lastError = ''
            store.lastErrorStatus = 0
          }
        })
        .catch(function (error) {
          store.lastErrorStatus = error !== null && error !== undefined && typeof error.status === 'number' ? error.status : 0
          store.lastError = error !== null && error !== undefined && error.message ? error.message : String(error)
        })
        .then(function () {
          group.forEach(function (item) {
            inflight.delete(item.key)
          })
          store.pending = Math.max(0, store.pending - 1)
          still = group.filter(function (item) {
            return cachedValueForKey(item.key, item.target, item.text) === null
          })
          store.bump()
          if (still.length > 0) scheduleRetries(still)
        })
    }

    // ---------------------------------------------------------------- HTTP

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try {
          data = text === '' ? null : JSON.parse(text)
        } catch (error) {
          data = null
        }
        if (!res.ok) {
          var message = data !== null && data !== undefined && data.error ? data.error : 'HTTP ' + res.status
          var err = new Error(message)
          err.status = res.status
          throw err
        }
        return data
      })
    }

    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }

    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body === null || body === undefined ? {} : body),
      }).then(readJson)
    }

    // ---------------------------------------------------------------- 宿主 Markdown 小件

    var FALLBACK_LABELS = {
      copy: '复制',
      copied: '已复制',
      'codeBlock.title': '代码',
      'codeBlock.wrap': '自动换行',
      'codeBlock.unwrap': '取消换行',
      'markdown.footnotes': '脚注',
      'message.think': '思考',
      'message.stopped': '已停止',
      'message.unknownBlock': '未知内容',
    }

    function tFallback(key, params) {
      var text = FALLBACK_LABELS[key] !== undefined ? FALLBACK_LABELS[key] : key
      if (params !== null && params !== undefined) {
        Object.keys(params).forEach(function (name) {
          text = text.split('{' + name + '}').join(String(params[name]))
        })
      }
      return text
    }

    function safeT(t, key, params) {
      if (typeof t === 'function') {
        try {
          var value = t(key, params)
          if (typeof value === 'string' && value !== '' && value !== key) return value
        } catch (error) {
          // 宿主词典缺失时走内置文案
        }
      }
      return tFallback(key, params)
    }

    function markdownLabels(t) {
      var tr = typeof t === 'function' ? t : tFallback
      return {
        code: {
          copyLabel: tr('copy'),
          copiedLabel: tr('copied'),
          toolbarLabels: {
            codeLabel: tr('codeBlock.title'),
            wrapLabel: tr('codeBlock.wrap'),
            unwrapLabel: tr('codeBlock.unwrap'),
          },
        },
        footnotes: tr('markdown.footnotes'),
      }
    }

    function isWindowsStylePath(value) {
      return /^[A-Za-z]:[/\\]/.test(value) || value.indexOf('\\\\') === 0
    }

    function isAbsoluteWorkspacePath(value) {
      return value.charAt(0) === '/' || isWindowsStylePath(value)
    }

    function fileMediaUrl(base, value) {
      if ((!/^https?:/i.test(base) && base.indexOf('dsh-app://app/') !== 0) || !isAbsoluteWorkspacePath(value)) return undefined
      if (/^[/\\]{2}/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return undefined
      return new URL('api/file?path=' + encodeURIComponent(value), base).href
    }

    function localPathMediaUrl(base, value) {
      var path
      try {
        path = decodeURIComponent(String(value).split(/[?#]/)[0] || '')
      } catch (error) {
        return undefined
      }
      return fileMediaUrl(base, path)
    }

    function makePathImages() {
      if (typeof document === 'undefined') return undefined
      return {
        resolve: function (value) {
          return localPathMediaUrl(document.baseURI, value)
        },
      }
    }

    function FallbackMarkdown(props) {
      return h('pre', { className: 'dsb-fallback-md' }, String(props.text === null || props.text === undefined ? '' : props.text))
    }

    function FallbackUnknown(props) {
      return h('pre', { className: 'dsb-fallback-md' }, JSON.stringify(props.payload, null, 2))
    }

    // ---------------------------------------------------------------- 影子里程碑

    function useStore() {
      var useSync = React.useSyncExternalStore
      if (typeof useSync === 'function') return useSync(store.subscribe, store.getVersion, store.getVersion)
      var pair = React.useState(store.getVersion())
      React.useEffect(function () {
        return store.subscribe(function () {
          pair[1](store.getVersion())
        })
      }, [])
      return pair[0]
    }

    function useInView(ref, active) {
      var unavailable = typeof IntersectionObserver === 'undefined'
      var pair = React.useState(unavailable ? true : false)
      React.useEffect(function () {
        if (unavailable || active !== true) return undefined
        var element = ref.current
        if (element === null || element === undefined) return undefined
        var observer = new IntersectionObserver(
          function (entries) {
            pair[1](
              entries.some(function (entry) {
                return entry.isIntersecting === true
              }),
            )
          },
          { rootMargin: '200px' },
        )
        observer.observe(element)
        return function () {
          observer.disconnect()
        }
      }, [active, unavailable])
      return pair[0]
    }

    function AssistantStep(props) {
      var data = props.node !== null && props.node !== undefined && props.node.data !== null && props.node.data !== undefined ? props.node.data : {}
      var blocks = Array.isArray(data.blocks) ? data.blocks : []
      var groupPart = props.groupPart
      var t = typeof props.t === 'function' ? props.t : tFallback
      var tr = function (key, params) {
        return safeT(t, key, params)
      }
      var labels = markdownLabels(tr)
      var pathImages = makePathImages()
      var enabled = store.enabled
      var version = useStore()
      var retryToken = store.retryToken
      var rootRef = React.useRef(null)
      var settled = data.status !== 'running'
      var inView = useInView(rootRef, enabled === true)

      var blockKey = ''
      for (var bi = 0; bi < blocks.length; bi += 1) {
        blockKey += (blocks[bi] && blocks[bi].kind ? blocks[bi].kind : '?') + ':' + (blocks[bi] && blocks[bi].text ? blocks[bi].text : '') + '\u0000'
      }

      React.useEffect(function () {
        if (enabled !== true || settled !== true || inView !== true) return
        if (groupPart === 'reasoning') return
        var seen = {}
        for (var i = 0; i < blocks.length; i += 1) {
          var block = blocks[i]
          if (block === null || block === undefined || block.kind !== 'text') continue
          var text = typeof block.text === 'string' ? block.text : ''
          if (text.trim() === '' || seen[text] === true) continue
          seen[text] = true
          ensureTranslations(text)
        }
      }, [enabled, settled, inView, groupPart, blockKey, retryToken])

      // 兜底：有些回合在正文已经显示后还会继续跑工具/收尾，data.status 长时间
      // 停在 running。正文块稳定 1.8 秒后就先翻，避免“表格/横线后面整段没译文”
      // 一直等到回合彻底结束。文本继续增长时 blockKey 变化会重置计时器。
      React.useEffect(function () {
        if (enabled !== true || settled === true) return
        if (groupPart === 'reasoning') return
        var timer = setTimeout(function () {
          var seen = {}
          for (var i = 0; i < blocks.length; i += 1) {
            var block = blocks[i]
            if (block === null || block === undefined || block.kind !== 'text') continue
            var text = typeof block.text === 'string' ? block.text : ''
            if (text.trim() === '' || seen[text] === true) continue
            seen[text] = true
            ensureTranslations(text)
          }
        }, 1800)
        return function () {
          clearTimeout(timer)
        }
      }, [enabled, settled, inView, groupPart, blockKey, retryToken])

      // 心跳补翻：不管 status / 视口 / effect 依赖有没有漏掉，只要插件开着，
      // 每 4 秒扫一遍这一行里的正文块；已翻译的会直接命中缓存，不发请求。
      // 这是“下半截整段没译文”的最后一道保险。
      React.useEffect(function () {
        if (enabled !== true || groupPart === 'reasoning') return undefined
        var timer = setInterval(function () {
          if (store.enabled !== true) return
          var seen = {}
          for (var i = 0; i < blocks.length; i += 1) {
            var block = blocks[i]
            if (block === null || block === undefined || block.kind !== 'text') continue
            var text = typeof block.text === 'string' ? block.text : ''
            if (text.trim() === '' || seen[text] === true) continue
            seen[text] = true
            ensureTranslations(text)
          }
        }, 4000)
        return function () {
          clearInterval(timer)
        }
      }, [enabled, groupPart, blockKey, retryToken])

      var reasoningHidden = false
      try {
        var turnProcess = props.turnProcess
        if (
          turnProcess !== null &&
          turnProcess !== undefined &&
          turnProcess.foldable === true &&
          turnProcess.spec !== null &&
          turnProcess.spec !== undefined &&
          turnProcess.spec.answerStep === data.step &&
          turnProcess.spec.inlineReasoning === true &&
          turnProcess.open !== true
        ) {
          reasoningHidden = true
        }
      } catch (error) {
        reasoningHidden = false
      }

      var rendered = []
      for (var i = 0; i < blocks.length; i += 1) {
        var block = blocks[i]
        if (block === null || block === undefined) continue
        if (groupPart === 'reasoning' && block.kind !== 'reasoning') continue
        if (groupPart === 'response' && block.kind === 'reasoning') continue

        if (block.kind === 'text') {
          var text = typeof block.text === 'string' ? block.text : ''
          var decorated = text
          if (enabled === true && groupPart !== 'reasoning' && settled === true) {
            var map = translationsFor(text)
            decorated = DSHBMarkdown.decorate(text, map)
          }
          rendered.push(
            h(MarkdownText, {
              key: 'text-' + i,
              text: decorated,
              streaming: data.status === 'running',
              labels: labels,
              pathImages: pathImages,
            }),
          )
          continue
        }

        if (block.kind === 'reasoning') {
          if (typeof block.text !== 'string' || block.text.trim() === '') continue
          if (reasoningHidden === true) continue
          rendered.push(
            h(
              'details',
              { key: 'reasoning-' + i, className: 'dsb-think' },
              h('summary', { className: 'dsb-think-summary' }, tr('message.think')),
              h(
                'div',
                { className: 'dsb-think-body' },
                h(MarkdownText, {
                  text: block.text,
                  streaming: data.status === 'running',
                  labels: labels,
                  pathImages: pathImages,
                }),
              ),
            ),
          )
          continue
        }

        if (block.kind === 'image') {
          var group = [block]
          while (i + 1 < blocks.length && blocks[i + 1] !== null && blocks[i + 1] !== undefined && blocks[i + 1].kind === 'image') {
            group.push(blocks[i + 1])
            i += 1
          }
          var images = group.map(function (item) {
            return { attachment: item.attachment }
          })
          var node = null
          try {
            if (typeof props.renderSlot === 'function') {
              node = props.renderSlot('conversation.chat.message.images', {
                images: images,
                loadImage: props.loadImage,
                align: 'start',
              })
            } else if (typeof props.renderFactorySlot === 'function') {
              node = props.renderFactorySlot('conversation.chat.message.images', {
                images: images,
                loadImage: props.loadImage,
                align: 'start',
              })
            }
          } catch (error) {
            node = null
          }
          if (node !== null && node !== undefined) rendered.push(h(React.Fragment, { key: 'images-' + i }, node))
          continue
        }

        if (block.kind === 'tool-call') continue

        rendered.push(
          JsonBlock !== null
            ? h(JsonBlock, {
                key: 'unknown-' + i,
                label: tr('message.unknownBlock'),
                payload: block.block !== undefined ? block.block : block,
                truncatedLabel: function (total) {
                  return '…（共 ' + total + ' 项）'
                },
              })
            : h(FallbackUnknown, { key: 'unknown-' + i, payload: block.block !== undefined ? block.block : block }),
        )
      }

      if (data.status === 'interrupted' && (groupPart === undefined || groupPart === 'response' || groupPart === 'reasoning')) {
        rendered.push(h('span', { key: 'stopped', className: 'dsb-stopped' }, tr('message.stopped')))
      }

      return h(
        'div',
        {
          ref: rootRef,
          className: 'dsb-assistant',
          'data-bilingual': enabled === true ? '1' : '0',
          'data-group-part': groupPart,
          'data-status': data.status,
          'data-version': version,
        },
        rendered,
      )
    }

    class AssistantBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error }
      }

      componentDidCatch(error) {
        try {
          console.error('[dsh-bilingual] 助手行渲染失败，已退回纯文本：', error)
        } catch (ignored) {
          // 忽略
        }
      }

      render() {
        if (this.state.error !== null) {
          var data = this.props.node !== null && this.props.node !== undefined && this.props.node.data !== null && this.props.node.data !== undefined ? this.props.node.data : {}
          var blocks = Array.isArray(data.blocks) ? data.blocks : []
          var children = []
          for (var i = 0; i < blocks.length; i += 1) {
            var block = blocks[i]
            if (block === null || block === undefined) continue
            if (block.kind === 'text' && typeof block.text === 'string') {
              children.push(h('pre', { key: 'fallback-text-' + i, className: 'dsb-fallback-md' }, block.text))
            }
          }
          return h('div', { className: 'dsb-assistant dsb-assistant-fallback' }, children)
        }
        return this.props.children
      }
    }

    // ---------------------------------------------------------------- 开关 / 设置 UI

    function ToggleButton() {
      useStore()
      var enabled = store.enabled
      var busy = store.pending > 0
      var error = store.lastError
      var title = enabled
        ? busy
          ? '正在翻译…'
          : error !== ''
            ? '翻译失败：' + error
            : '关闭双语对照'
        : '开启双语对照（每段原文下方追加另一种语言）'
      return h(
        'button',
        {
          type: 'button',
          className: 'dsb-toggle',
          'data-on': enabled === true ? '1' : '0',
          'data-busy': busy === true ? '1' : '0',
          'data-error': error !== '' ? '1' : '0',
          title: title,
          'aria-pressed': enabled === true ? 'true' : 'false',
          onClick: function () {
            store.setEnabled(!store.enabled)
          },
        },
        h('span', { className: 'dsb-toggle-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'dsb-toggle-label' }, '双语'),
        h('span', { className: 'dsb-toggle-build' }, 'v4'),
        enabled === true ? h('span', { className: 'dsb-toggle-state' }, 'ON') : null,
      )
    }

    function Field(props) {
      return h(
        'label',
        { className: 'dsb-field' },
        h('span', { className: 'dsb-field-label' }, props.label),
        h('input', {
          className: 'dsb-input',
          type: props.type || 'text',
          value: props.value,
          placeholder: props.placeholder || '',
          spellCheck: false,
          autoComplete: 'off',
          onChange: function (event) {
            props.onChange(event.target.value)
          },
        }),
        props.hint ? h('span', { className: 'dsb-field-hint' }, props.hint) : null,
      )
    }

    function SettingsPage() {
      useStore()
      var remotePair = React.useState(null)
      var remote = remotePair[0]
      var setRemote = remotePair[1]
      var draftPair = React.useState({ apiKey: '', model: 'deepseek-chat', baseURL: 'https://api.deepseek.com' })
      var draft = draftPair[0]
      var setDraft = draftPair[1]
      var statusPair = React.useState('')
      var status = statusPair[0]
      var setStatus = statusPair[1]
      var busyPair = React.useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]

      React.useEffect(function () {
        var alive = true
        apiGet('/config')
          .then(function (data) {
            if (!alive) return
            setRemote(data)
            setDraft(function (current) {
              return {
                apiKey: current.apiKey,
                model: data.model || 'deepseek-chat',
                baseURL: data.baseURL || 'https://api.deepseek.com',
              }
            })
          })
          .catch(function (error) {
            if (!alive) return
            setStatus('宿主未连接：' + (error.message || String(error)) + '。请重启 DSH 后再打开本页。')
          })
        return function () {
          alive = false
        }
      }, [])

      function save() {
        setBusy(true)
        setStatus('保存中…')
        var payload = { model: draft.model, baseURL: draft.baseURL }
        if (draft.apiKey.trim() !== '') payload.apiKey = draft.apiKey.trim()
        apiPost('/config', payload)
          .then(function (data) {
            setRemote(data)
            setDraft(function (current) {
              return { apiKey: '', model: data.model, baseURL: data.baseURL }
            })
            setStatus('已保存。')
            store.retry()
          })
          .catch(function (error) {
            setStatus('保存失败：' + (error.message || String(error)))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function test() {
        setBusy(true)
        setStatus('正在测试 DeepSeek…')
        var payload = {}
        if (draft.apiKey.trim() !== '') payload.apiKey = draft.apiKey.trim()
        apiPost('/test', payload)
          .then(function (data) {
            setStatus('连接正常。示例：' + (data.sample || '（空）'))
            store.retry()
          })
          .catch(function (error) {
            setStatus('连接失败：' + (error.message || String(error)))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function clearKey() {
        setBusy(true)
        setStatus('正在清除…')
        apiPost('/config', { apiKey: '' })
          .then(function (data) {
            setRemote(data)
            setStatus('已清除插件里保存的 Key。')
          })
          .catch(function (error) {
            setStatus('清除失败：' + (error.message || String(error)))
          })
          .then(function () {
            setBusy(false)
          })
      }

      function clearCache() {
        cache.clear()
        retryState.clear()
        scheduledRetries.clear()
        try {
          if (typeof localStorage !== 'undefined') {
            localStorage.removeItem(CACHE_KEY)
            localStorage.removeItem(LEGACY_CACHE_KEY)
            localStorage.removeItem(LEGACY_CACHE_KEY_1)
            localStorage.removeItem(LEGACY_CACHE_KEY_2)
          }
        } catch (error) {
          // 清不掉内存缓存也已经清空
        }
        store.lastError = ''
        store.lastErrorStatus = 0
        store.retry()
        setStatus('译文缓存已清空，正在按需重译…')
      }

      var enabled = store.enabled
      var keySourceLabel =
        remote === null
          ? ''
          : remote.keySource === 'plugin'
            ? '插件设置'
            : remote.keySource === 'env'
              ? '环境变量'
              : remote.keySource === 'credentials'
                ? 'DSH 凭据'
                : remote.keySource === 'request'
                  ? '本次请求'
                  : '未知来源'
      var keyState =
        remote === null
          ? '读取中…'
          : remote.hasKey === true
            ? '已配置（' + remote.keyHint + '，来源：' + keySourceLabel + '）'
            : '未配置'

      return h(
        'div',
        { className: 'dsb-settings' },
        h('div', { className: 'dsb-settings-head' }, h('h2', { className: 'dsb-settings-title' }, '双语对照'), h('p', { className: 'dsb-settings-desc' }, '开启后，助手回复的每一段原文下方会自动追加另一种语言：中文→英文、英文→中文。只改显示，不改会话记录，也不进入模型上下文。')),
        h(
          'div',
          { className: 'dsb-card' },
          h(
            'div',
            { className: 'dsb-row' },
            h('div', null, h('div', { className: 'dsb-card-title' }, '当前会话开关'), h('div', { className: 'dsb-muted' }, enabled ? '已开启（只在本标签页生效）' : '关闭（默认）')),
            h(
              'button',
              {
                type: 'button',
                className: 'dsb-button dsb-button-primary',
                onClick: function () {
                  store.setEnabled(!store.enabled)
                },
              },
              enabled ? '关闭双语' : '开启双语',
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsb-card' },
          h('div', { className: 'dsb-card-title' }, 'DeepSeek 通道'),
          h('div', { className: 'dsb-muted' }, '会自动读取 DSH 已保存的 DEEPSEEK_API_KEY（设置 → 模型 里的凭据）；也可以在这里单独填一个 Key（填了则优先用这里的），只保存在本机 ' + (remote !== null && remote.configPath ? remote.configPath : '<DSH_HOME>/dsh-bilingual.json') + '，不会写进会话。'),
          h(Field, {
            label: 'API Key',
            type: 'password',
            value: draft.apiKey,
            placeholder: remote !== null && remote.hasKey === true ? '已保存 ' + remote.keyHint + '，留空保持不变' : 'sk-...',
            onChange: function (value) {
              setDraft(function (current) {
                return { apiKey: value, model: current.model, baseURL: current.baseURL }
              })
            },
          }),
          h('div', { className: 'dsb-muted dsb-key-state' }, 'Key 状态：' + keyState),
          h(Field, {
            label: '模型',
            value: draft.model,
            placeholder: 'deepseek-chat',
            hint: '默认 deepseek-chat；也可以填兼容端点的模型名。',
            onChange: function (value) {
              setDraft(function (current) {
                return { apiKey: current.apiKey, model: value, baseURL: current.baseURL }
              })
            },
          }),
          h(Field, {
            label: 'Base URL',
            value: draft.baseURL,
            placeholder: 'https://api.deepseek.com',
            hint: '必须是 OpenAI 兼容的 /chat/completions 端点；默认 DeepSeek 官方。',
            onChange: function (value) {
              setDraft(function (current) {
                return { apiKey: current.apiKey, model: current.model, baseURL: value }
              })
            },
          }),
          h(
            'div',
            { className: 'dsb-actions' },
            h(
              'button',
              { type: 'button', className: 'dsb-button dsb-button-primary', disabled: busy, onClick: save },
              busy ? '处理中…' : '保存',
            ),
            h('button', { type: 'button', className: 'dsb-button', disabled: busy, onClick: test }, '测试连接'),
            h('button', { type: 'button', className: 'dsb-button', disabled: busy, onClick: clearCache }, '清空译文缓存'),
            h('button', { type: 'button', className: 'dsb-button dsb-button-danger', disabled: busy, onClick: clearKey }, '清除 Key'),
          ),
          status !== '' ? h('div', { className: 'dsb-status' }, status) : null,
        ),
        h(
          'div',
          { className: 'dsb-card' },
          h('div', { className: 'dsb-card-title' }, '说明'),
          h('ul', { className: 'dsb-help' }, h('li', null, '默认关闭；点会话头部的「双语」或上面的按钮开启。'), h('li', null, '只翻译助手回复的正文段落、标题、列表、引用和表格；代码块、公式不翻译。表格会以一张完整的译文表附在原文表下方。'), h('li', null, '原文保持不变；复制按钮复制的仍是原文。'), h('li', null, '同一段译文会缓存在本机，滚动回来不会重复请求。')),
        ),
        h('div', { className: 'dsb-muted', style: { padding: '0 4px' } }, 'dsh-bilingual · 构建 2026-11-09 · 缓存 v4'),
      )
    }

    // ---------------------------------------------------------------- 样式

    var CSS = [
      '.dsb-assistant{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dsb-think{margin:4px 0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.6}',
      '.dsb-think-summary{cursor:pointer;color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:20px;user-select:none}',
      '.dsb-think-summary:hover{color:var(--dsw-alias-label-secondary,#5f6672)}',
      '.dsb-think-body{margin-top:6px;padding-left:10px;border-left:2px solid var(--dsw-alias-border-l1,rgba(127,127,127,.22));color:var(--dsw-alias-label-secondary,#5f6672)}',
      '.dsb-stopped{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:18px}',
      '.dsb-fallback-md{white-space:pre-wrap;word-break:break-word;margin:0;font:inherit}',
      '.dsb-toggle{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#5f6672);font:12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer;white-space:nowrap;transition:background-color .15s ease,border-color .15s ease,color .15s ease}',
      '.dsb-toggle:hover{background:rgba(127,127,127,.10)}',
      '.dsb-toggle[data-on="1"]{border-color:var(--dsw-alias-brand-primary,#4d6bfe);color:var(--dsw-alias-brand-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 10%,transparent)}',
      '.dsb-toggle[data-error="1"]{border-color:var(--dsw-alias-state-error-primary,#e5484d);color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsb-toggle-dot{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.45;flex:none}',
      '.dsb-toggle[data-on="1"] .dsb-toggle-dot{opacity:1}',
      '.dsb-toggle[data-busy="1"] .dsb-toggle-dot{animation:dsb-pulse 1s ease-in-out infinite}',
      '.dsb-toggle-state{font-size:10px;font-weight:600;letter-spacing:.04em;opacity:.9}',
      '.dsb-toggle-build{font-size:9px;font-weight:500;opacity:.55;margin-left:-1px}',
      '@keyframes dsb-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}',
      '.dsb-settings{display:flex;flex-direction:column;gap:14px;max-width:760px;padding:4px 0 24px;color:var(--dsw-alias-label-primary,#1b1c20);font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}',
      '.dsb-settings-head{display:flex;flex-direction:column;gap:6px}',
      '.dsb-settings-title{margin:0;font-size:18px;line-height:26px;font-weight:600}',
      '.dsb-settings-desc{margin:0;color:var(--dsw-alias-label-secondary,#5f6672)}',
      '.dsb-card{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}',
      '.dsb-card-title{font-weight:600;font-size:13px}',
      '.dsb-muted{color:var(--dsw-alias-label-tertiary,#8a8f98);font-size:12px;line-height:1.6}',
      '.dsb-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dsb-field{display:flex;flex-direction:column;gap:5px}',
      '.dsb-field-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#5f6672)}',
      '.dsb-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.25));border-radius:7px;background:var(--dsw-alias-bg-layer-2,#f7f8fa);color:var(--dsw-alias-label-primary,#1b1c20);font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;outline:none}',
      '.dsb-input:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 18%,transparent)}',
      '.dsb-field-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.dsb-key-state{font-size:11px}',
      '.dsb-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}',
      '.dsb-button{appearance:none;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.3));border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#1b1c20);font:12px/1 system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer}',
      '.dsb-button:hover:not(:disabled){background:rgba(127,127,127,.10)}',
      '.dsb-button:disabled{opacity:.5;cursor:default}',
      '.dsb-button-primary{border-color:var(--dsw-alias-brand-primary,#4d6bfe);background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff}',
      '.dsb-button-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary,#4d6bfe);filter:brightness(1.06)}',
      '.dsb-button-danger{color:var(--dsw-alias-state-error-primary,#e5484d);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 45%,transparent)}',
      '.dsb-status{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#5f6672);white-space:pre-wrap;word-break:break-word}',
      '.dsb-help{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary,#5f6672);font-size:12px;line-height:1.8}',
    ].join('')

    function installStyles(ctx) {
      function mount() {
        if (typeof document === 'undefined' || document.head === null) return
        if (document.getElementById(STYLE_ID) !== null) return
        var style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = CSS
        document.head.appendChild(style)
      }
      mount()
      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(function () {
            mount()
            return function () {
              var element = document.getElementById(STYLE_ID)
              if (element !== null && element.parentNode !== null) element.parentNode.removeChild(element)
            }
          }, 'dsh-bilingual: styles')
        }
      } catch (error) {
        // 样式失败不影响功能
      }
    }

    // ---------------------------------------------------------------- 注册

    function registerAssistant(ctx) {
      try {
        ctx.slots.inject('conversation.chat.node', function () {
          return ctx.slots.register(
            {
              name: 'conversation.chat.node',
              key: 'assistant-step',
              locale: 'chat',
              priority: -10,
            },
            function (props) {
              return h(AssistantBoundary, props, h(AssistantStep, props))
            },
          )
        })
      } catch (error) {
        try {
          console.error('[dsh-bilingual] assistant-step 注册失败：', error)
        } catch (ignored) {
          // 忽略
        }
      }
    }

    function registerToggle(ctx) {
      try {
        ctx.slots.inject('conversation.session.header.actions', function () {
          return ctx.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'dsh-bilingual-toggle',
              order: 60,
              label: function () {
                return '双语'
              },
            },
            ToggleButton,
          )
        })
      } catch (error) {
        try {
          console.warn('[dsh-bilingual] 会话头开关注册失败，可在 设置 → 双语 中开启：', error)
        } catch (ignored) {
          // 忽略
        }
      }
    }

    function registerSettings(ctx) {
      try {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-bilingual',
              order: 47,
              locale: 'dsh-bilingual',
              label: function () {
                return '双语'
              },
            },
            SettingsPage,
          )
        })
      } catch (error) {
        try {
          console.warn('[dsh-bilingual] 设置页注册失败：', error)
        } catch (ignored) {
          // 忽略
        }
      }
    }

    function apply(ctx) {
      installStyles(ctx)
      registerAssistant(ctx)
      registerToggle(ctx)
      registerSettings(ctx)
      try {
        ctx.logger?.info?.('[dsh-bilingual] 浏览器半已加载')
      } catch (error) {
        // 忽略
      }
    }

    module.exports = {
      name: 'dsh-bilingual',
      inject: ['slots'],
      apply: apply,
      __internals: {
        store: store,
        ensureTranslations: ensureTranslations,
        translationsFor: translationsFor,
        decorate: DSHBMarkdown.decorate,
        splitUnits: DSHBMarkdown.splitUnits,
        translationTarget: DSHBMarkdown.translationTarget,
      },
    }
    return module.exports
  },
})
