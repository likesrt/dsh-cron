/**
 * 面板渲染冒烟：仓库里没有 react，自带一个够用的极简渲染器，
 * 把 client.js 的组件树真跑一遍，抓「刷新后白屏」这类运行时错误。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client.js')

/** 一轮渲染里每个组件实例的 hook 槽。key 是渲染路径。 */
function createRenderer() {
  const hooks = new Map()
  let current = null

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    Fragment: 'Fragment',
    useState(init) {
      const state = current
      const index = state.index++
      if (!(index in state.slots)) state.slots[index] = typeof init === 'function' ? init() : init
      const set = (value) => {
        const next = typeof value === 'function' ? value(state.slots[index]) : value
        if (next !== state.slots[index]) {
          state.slots[index] = next
          state.dirty = true
        }
      }
      return [state.slots[index], set]
    },
    useRef(init) {
      const state = current
      const index = state.index++
      if (!(index in state.slots)) state.slots[index] = { current: init }
      return state.slots[index]
    },
    useEffect(fn) {
      current.index++
      current.pending.push(fn)
    },
    useLayoutEffect() {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
  }

  const stub = (name) => function Stub(props) {
    return { type: `stub:${name}`, props: props ?? {}, children: [] }
  }
  const primitives = new Proxy({}, { get: (_target, prop) => (typeof prop === 'string' ? stub(prop) : undefined) })

  function render(component, props, key) {
    const state = hooks.get(key) ?? { slots: [], index: 0, pending: [], dirty: false }
    hooks.set(key, state)
    const previous = current
    state.index = 0
    state.pending = []
    current = state
    const out = component(props)
    current = previous
    return { out, state }
  }

  function walk(node, key, visit) {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) { node.forEach((child) => walk(child, key, visit)); return }
    if (typeof node === 'string' || typeof node === 'number') { visit({ text: String(node) }); return }
    const { type, props = {}, children = [] } = node
    if (typeof type === 'function') {
      const childKey = `${key}.${type.name || 'anon'}`
      const { out, state } = render(type, { ...props, children }, childKey)
      const pending = state.pending
      state.pending = []
      for (const effect of pending) effect()
      walk(out, childKey, visit)
      return
    }
    visit({ type: String(type), props })
    for (const child of children) walk(child, key, visit)
    if (Array.isArray(props.children)) for (const child of props.children) walk(child, key, visit)
    else if (props.children !== undefined) walk(props.children, key, visit)
  }

  /** 跑到没有状态变化为止（effect 里的 fetch 会落地）。 */
  async function mount(component, key) {
    let latest = render(component, {}, key)
    for (let pass = 0; pass < 10; pass += 1) {
      for (const state of hooks.values()) state.dirty = false
      const pending = latest.state.pending
      latest.state.pending = []
      for (const effect of pending) effect()
      walk(latest.out, key, () => {})
      for (let tick = 0; tick < 40; tick += 1) await Promise.resolve()
      latest = render(component, {}, key)
      if (![...hooks.values()].some((state) => state.dirty)) break
    }
    const text = []
    const classes = new Set()
    const svgs = []
    const switches = []
    const nodes = []
    walk(latest.out, key, (item) => {
      if (item.text !== undefined) { text.push(item.text); return }
      nodes.push({ type: item.type, props: item.props?.type === undefined ? item.props : item.props })
      const className = item.props?.className
      if (typeof className === 'string') className.split(/\s+/).forEach((name) => name && classes.add(name))
      // 图标不写宽高就会被 flex 撑满，这里收集起来一起断言。
      if (item.type === 'svg') svgs.push({ width: item.props?.width, height: item.props?.height })
      // 开关的打开状态是最容易写错的一处：布尔值和显示用的字符串不能混着比。
      if (item.props?.role === 'switch') switches.push(item.props['aria-checked'])
    })
    return { text: text.join(' '), classes, svgs, switches, nodes }
  }

  return { React, primitives, render, mount }
}

const NOW = Date.UTC(2026, 10, 11, 2, 0, 0)

const TASKS = [
  {
    id: 'cron-script', title: '端口巡检', enabled: true, mode: 'script', scheduleText: '每 5 分钟',
    schedule: { kind: 'every-minutes', interval: 5 }, workspace: '/root/workspace',
    script: { command: 'echo hi' }, prompt: null, delivery: { kind: 'silent' },
    target: { kind: 'new_once' }, repeat: null, retries: 0, timeoutMs: null, permission: null,
    agent: {}, tags: [], runCount: 1,
    state: { lastRunAt: new Date(NOW - 60_000).toISOString(), lastResult: 'ok', nextRunAt: new Date(NOW + 120_000).toISOString() },
  },
  {
    id: 'cron-agent', title: '日报', enabled: true, mode: 'agent', scheduleText: '每天 09:00',
    schedule: { kind: 'daily', time: '09:00' }, workspace: '/root/workspace',
    script: null, prompt: '写日报', delivery: { kind: 'silent' },
    target: { kind: 'new_once' }, targetSessionId: 'session-abc',
    repeat: null, retries: 1, timeoutMs: 60_000, permission: 'auto',
    agent: { preset: 'standard', provider: 'me', model: 'deepseek-flash' }, tags: [], runCount: 1,
    state: { lastRunAt: new Date(NOW - 3_600_000).toISOString(), lastResult: 'failed', nextRunAt: new Date(NOW + 3_600_000).toISOString() },
  },
  {
    id: 'cron-paused', title: '一次性', enabled: false, mode: 'script', scheduleText: '仅一次',
    schedule: { kind: 'once', date: '2026-12-31', time: '09:00' }, workspace: '/root/workspace',
    script: { command: 'true' }, prompt: null, delivery: { kind: 'silent' },
    target: { kind: 'new_once' }, repeat: null, retries: 0, timeoutMs: null, permission: null,
    agent: {}, tags: [], runCount: 0,
    state: { lastRunAt: null, lastResult: null, nextRunAt: null },
  },
]

const json = (value) => ({ ok: true, status: 200, json: async () => value })

const RESPONSES = {
  '/tasks': { ok: true, items: TASKS },
  '/status': { ok: true, running: true, taskCount: TASKS.length },
  '/workspaces': { ok: true, items: [{ path: '/root/workspace', taskCount: TASKS.length }] },
  '/targets': { ok: true, available: false, bots: [] },
  '/incidents': { ok: true, incidents: [] },
  '/presets': { ok: true, available: true, items: [{ id: 'standard', name: 'standard', isDefault: true }] },
  '/models': { ok: true, available: true, providers: [{ id: 'me', name: 'me', models: [{ id: 'deepseek-flash', name: 'deepseek-flash' }] }] },
  '/permissions': { ok: true, available: true, items: [{ id: 'auto', name: 'auto' }, { id: 'workspace-write', name: 'workspace-write' }] },
  '/sessions': { ok: true, items: [] },
  '/runs': {
    ok: true,
    runs: [{ runId: 'run-1', status: 'ok', startedAt: new Date(NOW - 60_000).toISOString(), durationMs: 1200, output: '好了', sessionId: 'session-abc' }],
  },
}

/** 加载 client.js，拿到它向各槽注册的组件。 */
function loadClient({ source = CLIENT, configForms = false } = {}) {
  const renderer = createRenderer()
  let loaded = null
  const style = () => ({ set textContent(_value) {}, remove() {} })
  const fakeWindow = {
    __ModuleLoader__: {
      load({ factory }) {
        loaded = factory((id) => {
          if (id === 'react') return renderer.React
          if (id === 'react-dom') return { createPortal: (node) => node }
          if (id === '@deepseek-ai/dsh-client-ui-primitives') return renderer.primitives
          throw new Error(`unexpected require: ${id}`)
        })
      },
    },
  }
  const fakeDocument = {
    getElementById: () => null,
    querySelector: () => null,
    createElement: style,
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  }
  const calls = []
  const fakeFetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' })
    const route = String(url).replace('/dsh-cron/api', '').split('?')[0]
    if (route in RESPONSES) return json(RESPONSES[route])
    if (route.includes('/runs')) return json(RESPONSES['/runs'])
    return json({ ok: true })
  }

  // 面板里有 15 秒轮询和重试定时器；测试里换成不留下真实定时器的空实现。
  const fakeSetInterval = () => 0
  const fakeSetTimeout = (fn) => { if (typeof fn === 'function') fn(); return 0 }
  const noop = () => {}

  const code = fs.readFileSync(source, 'utf8')
  new Function('window', 'document', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', code)(
    fakeWindow, fakeDocument, fakeFetch, fakeSetInterval, noop, fakeSetTimeout, noop,
  )
  assert.ok(loaded, 'client.js 的 factory 没有返回模块')

  const slots = []
  const fakeCtx = {
    effect(fn) { fn() },
    inject(_services, callback) {
      if (!configForms) return
      callback({
        configForms: {
          get: () => ({
            getSnapshot: () => ({
              status: 'ready', writable: true, revision: 1,
              value: { timeZone: 'Asia/Shanghai', timeLimitMs: 180000, maxConcurrent: 3, disableBuiltinSchedule: true },
            }),
            subscribe: () => () => {},
            mutate: async () => true,
            set: async () => true,
          }),
          whileServed: (_namespaces, register) => { register() },
        },
      })
    },
    get: () => undefined,
    slots: {
      inject(_name, register) { register() },
      register(options, component) { slots.push({ name: options.name, component }); return () => {} },
    },
  }
  loaded.apply(fakeCtx)
  return { renderer, slots, calls }
}

const slotOf = (slots, name) => slots.find((item) => item.name === name)?.component

test('主面板：页签、搜索、新建与任务行都渲染出来', async () => {
  const { renderer, slots } = loadClient()
  const page = slotOf(slots, 'main')
  assert.ok(page, '没有注册 main 槽')
  const { text, classes, svgs } = await renderer.mount(page, 'main')

  // 默认停在「已开启」，停用的那条不该出现在列表里，但页签上要数得出来。
  for (const expected of ['定时任务', '已开启 2', '已暂停 1', '已结束 0', '全部 3', '新建', '立即运行', '端口巡检', '日报', '会话']) {
    assert.ok(text.includes(expected), `面板缺少「${expected}」`)
  }
  for (const expected of ['dshcron-tabs', 'dshcron-search', 'dshcron-split', 'dshcron-row']) {
    assert.ok(classes.has(expected), `面板缺少样式类 ${expected}`)
  }
  assert.equal(svgs.filter((svg) => typeof svg.width !== 'number').length, 0, '有图标没写宽高，会被撑成一块')
  // 智能模式那条任务有会话才出现「会话」入口，脚本模式那两条不该有。
  assert.equal(text.split('会话').length - 1 >= 1, true)
})

test('智能模式的编辑器：Agent、模型、权限、执行位置都渲染', async () => {
  // 弹窗平时是关闭的，这里把它打开、并以智能模式起手，才能覆盖到智能模式那几行。
  const patched = fs.readFileSync(CLIENT, 'utf8')
    .replace('const [editorOpen, setEditorOpen] = React.useState(false)', 'const [editorOpen, setEditorOpen] = React.useState(true)')
    .replace("const [editorMode, setEditorMode] = React.useState('script')", "const [editorMode, setEditorMode] = React.useState('agent')")
  const temp = path.join(os.tmpdir(), `dsh-cron-client-agent-${process.pid}.js`)
  fs.writeFileSync(temp, patched)
  try {
    const { renderer, slots } = loadClient({ source: temp })
    const page = slotOf(slots, 'main')
    const { text, classes, svgs } = await renderer.mount(page, 'main')
    for (const expected of ['执行内容', '工作区', '运行 Agent', '运行模型', '权限', '执行位置', '执行周期', '重复次数', '失败重试', '单次超时', '推送', '回原会话', '放弃', '创建', '次', '秒']) {
      assert.ok(text.includes(expected), `编辑器缺少「${expected}」`)
    }
    for (const expected of ['dshcron-drawer', 'dshcron-drawer-head', 'dshcron-drawer-foot', 'dshcron-card', 'dshcron-frow']) {
      assert.ok(classes.has(expected), `编辑器缺少样式类 ${expected}`)
    }
    assert.equal(svgs.filter((svg) => typeof svg.width !== 'number').length, 0, '编辑器里有图标没写宽高')
  } finally {
    fs.rmSync(temp, { force: true })
  }
})

test('插件配置卡片：注册在插件详情页的槽里，字段与提示都在', async () => {
  const { renderer, slots } = loadClient({ configForms: true })
  const card = slotOf(slots, 'plugins.bundle.config')
  assert.ok(card, '没有注册 plugins.bundle.config 槽')
  const { text, switches } = await renderer.mount(card, 'bundle-config')
  // 表单只放用户能决定的事：不再暴露调度精度这种实现参数，超时用秒显示。
  for (const expected of ['时区', '单次超时', '并发上限', '历史保留', '历史条数', '停用内置的自动化任务', '秒', '个', '天', '条', '保存', '放弃修改']) {
    assert.ok(text.includes(expected), `配置卡片缺少「${expected}」`)
  }
  assert.ok(!text.includes('调度精度'), '调度精度不该出现在表单里')
  assert.ok(!text.includes('毫秒'), '毫秒这种单位不该让用户读')
  // 配置里 disableBuiltinSchedule 是 true，开关就必须是打开状态。
  assert.deepEqual(switches, [true], '开关状态和配置值不一致')
})

test('删除任务要先确认：点删除只弹确认框，确认后才发请求', async () => {
  const { renderer, slots, calls } = loadClient()
  const page = slotOf(slots, 'main')
  const first = await renderer.mount(page, 'main')
  const modalOf = (mounted) => mounted.nodes.find((node) => typeof node.props?.title === 'string' && node.props.title.startsWith('删除「'))
  assert.equal(modalOf(first), undefined, '一开始不该有确认框')

  const rowDelete = first.nodes.find((node) => node.props?.title === '删除' && typeof node.props?.onClick === 'function')
  assert.ok(rowDelete, '任务行里没有删除按钮')
  rowDelete.props.onClick()

  const second = await renderer.mount(page, 'main')
  const confirm = modalOf(second)
  assert.ok(confirm, '点删除没有弹确认框')
  assert.equal(confirm.props.title, '删除「端口巡检」？')
  assert.equal(confirm.props.open, true)
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0, '还没确认就发删除请求了')

  const label = (button) => JSON.stringify(button.children ?? '')
  const buttons = confirm.props.footer.children
  const cancel = buttons.find((button) => label(button).includes('取消'))
  const remove = buttons.find((button) => label(button).includes('删除'))
  assert.ok(cancel && remove, '确认框缺少按钮')

  cancel.props.onClick()
  const third = await renderer.mount(page, 'main')
  assert.equal(modalOf(third), undefined, '取消后确认框该关掉')
  assert.equal(calls.filter((call) => call.method === 'DELETE').length, 0, '取消不该删')

  // 再来一次，这回确认
  const opened = await renderer.mount(page, 'main')
  opened.nodes.find((node) => node.props?.title === '删除' && typeof node.props?.onClick === 'function').props.onClick()
  const prompted = await renderer.mount(page, 'main')
  modalOf(prompted).props.footer.children.find((button) => label(button).includes('删除')).props.onClick()
  await renderer.mount(page, 'main')
  assert.ok(calls.some((call) => call.method === 'DELETE'), '确认后没有发删除请求')
})

test('确认框会交代会话归属：有自己会话的提示一并归档，用已有会话的不提', async () => {
  const { renderer, slots } = loadClient()
  const page = slotOf(slots, 'main')
  const modalOf = (mounted) => mounted.nodes.find((node) => typeof node.props?.title === 'string' && node.props.title.startsWith('删除「'))

  /** 把确认框里的文字全捞出来，省得依赖具体的节点层级。 */
  const textOf = (value) => {
    if (value === null || value === undefined || typeof value === 'boolean') return ''
    if (typeof value === 'string') return value
    if (Array.isArray(value)) return value.map(textOf).join(' ')
    return textOf(value.children ?? value.props?.children)
  }

  // 已开启页签里第一行是「端口巡检」（脚本任务，没有自己的会话），第二行是「日报」。
  const first = await renderer.mount(page, 'main')
  const deletes = first.nodes.filter((node) => node.props?.title === '删除' && typeof node.props?.onClick === 'function')
  assert.equal(deletes.length, 2, '已开启页签该有两行删除按钮')

  deletes[0].props.onClick()
  const noSession = await renderer.mount(page, 'main')
  assert.ok(!textOf(modalOf(noSession)).includes('一并归档'), '没有自己会话的任务不该被交代会话')

  deletes[1].props.onClick()
  const withSession = await renderer.mount(page, 'main')
  assert.ok(textOf(modalOf(withSession)).includes('它建的会话会一并归档'), '有自己会话的任务要说明会话归属')
})
