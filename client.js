window.__ModuleLoader__.load({
  id: 'dsh-cron',
  factory: (require) => {
    const React = require('react')
    const {
      Button, Input, Pill, StateDot, Modal, Toast, PathLabel,
      IconPlusOutlineRegular, IconPlayOutlineRegular, IconPauseOutlineRegular,
      IconTrashOutlineRegular, IconEditOutlineRegular, IconClockOutlineRegular,
      IconWarningOutlineRegular, IconCloseOutlineRegular, IconChevronDownOutlineRegular,
      IconSearchOutlineRegular, IconNewChatOutlineRegular,
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const { createPortal } = require('react-dom')
    const h = React.createElement
    const PANEL_ID = 'dsh-cron'
    // 客户端 ctx：用来读 uiWorkspace（选目录）和 sessions（会话名称）。
    let clientCtx = null
    const API = '/dsh-cron/api'

    // ---------------------------------------------------------------- data

    async function api(path, options = {}) {
      const response = await fetch(`${API}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      })
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
      if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    function formatTime(iso) {
      if (!iso) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      const now = Date.now()
      const diff = date.getTime() - now
      const clock = date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
      if (diff < 0) return clock
      return clock
    }

    function relative(iso) {
      if (!iso) return ''
      const diff = new Date(iso).getTime() - Date.now()
      if (Number.isNaN(diff)) return ''
      const abs = Math.abs(diff)
      const minute = 60000, hour = 3600000, day = 86400000
      const text = abs < minute ? '不到 1 分钟'
        : abs < hour ? `${Math.round(abs / minute)} 分钟`
          : abs < day ? `${Math.round(abs / hour)} 小时`
            : `${Math.round(abs / day)} 天`
      return diff >= 0 ? `${text}后` : `${text}前`
    }

    const MODE_LABEL = { script: '脚本模式', agent: '智能模式' }
    const RESULT_LABEL = { ok: '成功', failed: '失败', timeout: '超时', skipped: '跳过', running: '运行中' }

    // ---------------------------------------------------------------- 目录与会话

    function samePath(left, right) {
      if (!left || !right) return false
      const strip = (value) => String(value).replace(/\/+$/, '') || '/'
      return strip(left) === strip(right)
    }

    /** uiWorkspace 服务：浏览目录、调用宿主原生选择器。 */
    function directoryService() {
      const service = clientCtx?.get?.('uiWorkspace')
      return typeof service?.listDirectory === 'function' ? service : null
    }

    /** 宿主自己的会话（mnemon 容器、子智能体）不进选择器，用户列表里本来也看不到。 */
    const INTERNAL_SESSION_ID = /^mnemon-(?:task|run)-v\d+-/
    function internalSession(row) {
      if (!row) return false
      if (row.origin === 'subagent') return true
      return typeof row.id === 'string' && INTERNAL_SESSION_ID.test(row.id)
    }

    /** 会话行：客户端会话列表带 displayTitle，比宿主 /sessions 好用。 */
    function readSessions() {
      const store = clientCtx?.get?.('sessions')?.list
      const snapshot = store?.getSnapshot?.()
      if (!snapshot?.byId) return null
      const ids = Array.isArray(snapshot.ids) && snapshot.ids.length > 0 ? snapshot.ids : Object.keys(snapshot.byId)
      const rows = []
      for (const id of ids) {
        const row = snapshot.byId[id]
        if (!row || row.blank) continue
        if (internalSession(row)) continue
        rows.push({
          sessionId: row.id ?? id,
          title: row.displayTitle ?? row.title ?? id,
          cwd: row.cwd ?? '',
          updatedAt: row.updatedAt ?? 0,
        })
      }
      return rows
    }

    function sessionsFor(rows, workspace) {
      if (!rows) return []
      const scoped = workspace ? rows.filter((row) => samePath(row.cwd, workspace)) : rows
      return scoped.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 100)
    }

    // ---------------------------------------------------------------- schedule picker

    const KINDS = [
      { value: 'once', label: '仅一次' },
      { value: 'monthly', label: '每月' },
      { value: 'weekly', label: '每周' },
      { value: 'daily', label: '每天' },
      { value: 'hourly', label: '每小时' },
      { value: 'every-days', label: '每 N 天' },
      { value: 'every-hours', label: '每 N 小时' },
      { value: 'every-minutes', label: '每 N 分钟' },
      { value: 'every-seconds', label: '每 N 秒' },
      { value: 'cron', label: '自定义' },
    ]
    const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

    function localDate(offsetDays = 0) {
      const date = new Date(Date.now() + offsetDays * 86_400_000)
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    }

    function newSchedule(kind = 'daily') {
      switch (kind) {
        case 'once': return { kind, date: localDate(1), time: '09:00' }
        case 'monthly': return { kind, dayOfMonth: 1, time: '09:00' }
        case 'weekly': return { kind, weekday: 1, time: '09:00' }
        case 'daily': return { kind, time: '09:00' }
        case 'hourly': return { kind, minute: 0 }
        case 'every-days': return { kind, interval: 1, time: '09:00' }
        case 'every-hours': return { kind, interval: 6, minute: 0 }
        case 'every-minutes': return { kind, interval: 30 }
        case 'every-seconds': return { kind, interval: 30 }
        default: return { kind: 'cron', expression: '0 9 * * *' }
      }
    }

    /** Turn a stored schedule into an editable draft, keeping the same kind. */
    function scheduleDraft(schedule) {
      return schedule ? { ...newSchedule(schedule.kind), ...schedule } : newSchedule()
    }

    function NumberField({ value, min, max, step = 1, onChange, suffix }) {
      return h('label', { className: 'dshcron-num' },
        h('input', {
          type: 'number', className: 'dshcron-input dshcron-input--num',
          value: value, min, max, step,
          onChange: (event) => onChange(Math.max(min, Math.min(max, Number(event.target.value) || min))),
        }),
        suffix ? h('span', { className: 'dshcron-suffix' }, suffix) : null)
    }

    function ScheduleField({ value, onChange }) {
      const schedule = value
      const patch = (next) => onChange({ ...schedule, ...next })
      const [preview, setPreview] = React.useState(null)
      const [failure, setFailure] = React.useState('')

      React.useEffect(() => {
        let alive = true
        const timer = setTimeout(() => {
          api('/preview', { method: 'POST', body: { schedule } })
            .then((payload) => { if (alive) { setPreview(payload); setFailure('') } })
            .catch((error) => { if (alive) { setPreview(null); setFailure(error.message) } })
        }, 220)
        return () => { alive = false; clearTimeout(timer) }
      }, [JSON.stringify(schedule)])

      const controls = []
      if (schedule.kind === 'once') {
        controls.push(h('input', {
          key: 'd', type: 'date', className: 'dshcron-input', value: schedule.date,
          onChange: (event) => patch({ date: event.target.value }),
        }))
        controls.push(h('input', {
          key: 't', type: 'time', className: 'dshcron-input', value: schedule.time,
          onChange: (event) => patch({ time: event.target.value }),
        }))
      } else if (schedule.kind === 'monthly') {
        controls.push(h(NumberField, { key: 'd', value: schedule.dayOfMonth, min: 1, max: 31, suffix: '日', onChange: (dayOfMonth) => patch({ dayOfMonth }) }))
        controls.push(h('input', { key: 't', type: 'time', className: 'dshcron-input', value: schedule.time, onChange: (event) => patch({ time: event.target.value }) }))
      } else if (schedule.kind === 'weekly') {
        controls.push(h('select', {
          key: 'w', className: 'dshcron-input dshcron-select', value: schedule.weekday,
          onChange: (event) => patch({ weekday: Number(event.target.value) }),
        }, WEEKDAYS.map((label, index) => h('option', { key: index, value: index + 1 }, label))))
        controls.push(h('input', { key: 't', type: 'time', className: 'dshcron-input', value: schedule.time, onChange: (event) => patch({ time: event.target.value }) }))
      } else if (schedule.kind === 'daily') {
        controls.push(h('input', { key: 't', type: 'time', className: 'dshcron-input', value: schedule.time, onChange: (event) => patch({ time: event.target.value }) }))
      } else if (schedule.kind === 'hourly') {
        controls.push(h(NumberField, { key: 'm', value: schedule.minute, min: 0, max: 59, suffix: '分', onChange: (minute) => patch({ minute }) }))
      } else if (schedule.kind === 'every-days') {
        controls.push(h(NumberField, { key: 'i', value: schedule.interval, min: 1, max: 365, suffix: '天', onChange: (interval) => patch({ interval }) }))
        controls.push(h('input', { key: 't', type: 'time', className: 'dshcron-input', value: schedule.time, onChange: (event) => patch({ time: event.target.value }) }))
      } else if (schedule.kind === 'every-hours') {
        controls.push(h(NumberField, { key: 'i', value: schedule.interval, min: 1, max: 23, suffix: '小时', onChange: (interval) => patch({ interval }) }))
        controls.push(h(NumberField, { key: 'm', value: schedule.minute, min: 0, max: 59, suffix: '分', onChange: (minute) => patch({ minute }) }))
      } else if (schedule.kind === 'every-minutes') {
        controls.push(h(NumberField, { key: 'i', value: schedule.interval, min: 1, max: 1440, suffix: '分钟', onChange: (interval) => patch({ interval }) }))
      } else if (schedule.kind === 'every-seconds') {
        controls.push(h(NumberField, { key: 'i', value: schedule.interval, min: 5, max: 3600, suffix: '秒', onChange: (interval) => patch({ interval }) }))
      } else {
        controls.push(h(Input, {
          key: 'c', value: schedule.expression, placeholder: '0 9 * * *',
          onChange: (event) => patch({ expression: event.target.value }),
        }))
      }

      return h('div', { className: 'dshcron-sched' },
        h('div', { className: 'dshcron-sched-row' },
          h('select', {
            className: 'dshcron-input dshcron-select dshcron-select--kind', value: schedule.kind,
            onChange: (event) => onChange(newSchedule(event.target.value)),
          }, KINDS.map((item) => h('option', { key: item.value, value: item.value }, item.label))),
          controls),
        h('div', { className: 'dshcron-preview' },
          failure
            ? h('span', { className: 'dshcron-preview-bad' }, failure)
            : !preview
              ? h('span', { className: 'dshcron-preview-muted' }, '…')
              : [
                h('span', { key: 'text', className: 'dshcron-preview-text' }, preview.text),
                ...(preview.next ?? []).slice(0, 2).map((iso, index) => h('span', { key: index, className: 'dshcron-preview-next' }, formatTime(iso))),
              ]))
    }

    // ---------------------------------------------------------------- 目录选择器

    function FolderIcon() {
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        h('path', { d: 'M3.5 7.25A2.25 2.25 0 0 1 5.75 5h4.1l1.8 2h6.6a2.25 2.25 0 0 1 2.25 2.25v7A2.75 2.75 0 0 1 17.75 19h-12A2.25 2.25 0 0 1 3.5 16.75v-9.5Z' }))
    }

    function ChevronIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 20 20', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, h('path', { d: 'm7.5 4.5 5 5.5-5 5.5' }))
    }

    /** 右侧抽屉：编辑任务用，和官方那套一样从右边滑出来。 */
    function Drawer({ open, title, onClose, footer, children }) {
      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => { if (event.key === 'Escape') onClose?.() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open, onClose])
      if (!open) return null
      return createPortal(h('div', { className: 'dshcron-drawer-backdrop', onMouseDown: onClose },
        h('aside', {
          className: 'dshcron-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': title,
          onMouseDown: (event) => event.stopPropagation(),
        },
        h('header', { className: 'dshcron-drawer-head' },
          h('h2', { className: 'dshcron-drawer-title' }, title),
          h('button', {
            type: 'button', className: 'dshcron-drawer-close', 'aria-label': '关闭', onClick: onClose,
          }, h(IconCloseOutlineRegular, { size: 16 }))),
        h('div', { className: 'dshcron-drawer-body' }, children),
        footer ? h('footer', { className: 'dshcron-drawer-foot' }, footer) : null)), document.body)
    }

    /** 浏览宿主机目录选工作区：面包屑、路径直达、子目录列表。 */
    function DirectoryPicker({ open, startPath, onPicked, onCancel }) {
      const [listing, setListing] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const [draft, setDraft] = React.useState(startPath ?? '')
      const [showHidden, setShowHidden] = React.useState(false)
      const requestRef = React.useRef(0)
      const controllerRef = React.useRef(null)

      const load = React.useCallback(async (target) => {
        const service = directoryService()
        if (!service) { setFailure('当前环境不支持浏览目录'); return }
        const request = requestRef.current + 1
        requestRef.current = request
        controllerRef.current?.abort()
        const controller = new AbortController()
        controllerRef.current = controller
        setLoading(true)
        try {
          const next = await service.listDirectory(target || undefined, controller.signal)
          if (request !== requestRef.current) return
          setListing(next)
          if (typeof next?.path === 'string') setDraft(next.path)
          setFailure('')
        } catch (error) {
          if (request !== requestRef.current) return
          setFailure(error?.message ?? '无法读取目录')
        } finally {
          if (request === requestRef.current) setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        setListing(null)
        setFailure('')
        setDraft(startPath ?? '')
        setShowHidden(false)
        void load(startPath ?? '')
        const onKeyDown = (event) => { if (event.key === 'Escape') onCancel() }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [open, startPath])

      if (!open) return null

      const entries = (listing?.entries ?? []).filter((entry) => showHidden || !entry.hidden)
      const crumbs = (() => {
        const all = listing?.crumbs ?? []
        const index = all.findIndex((crumb) => crumb.path === listing?.home)
        return index < 0 ? all : all.slice(index)
      })()
      const ready = listing !== null && draft === listing.path

      const dialog = h('div', {
        className: 'dshcron-dir-backdrop',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onCancel() },
      },
      h('section', { className: 'dshcron-dir', role: 'dialog', 'aria-modal': 'true', 'aria-label': '选择工作区' },
        h('header', { className: 'dshcron-dir-header' },
          h('h3', null, '选择工作区'),
          listing
            ? h('nav', { className: 'dshcron-dir-crumbs', 'aria-label': '当前目录' },
              crumbs.map((crumb, index) => h(React.Fragment, { key: crumb.path },
                index > 0 ? h('span', { key: 'sep', className: 'dshcron-dir-sep', 'aria-hidden': 'true' }, '›') : null,
                h('button', {
                  key: 'crumb', type: 'button', title: crumb.path, disabled: loading,
                  'aria-current': index === crumbs.length - 1 ? 'page' : undefined,
                  onClick: () => void load(crumb.path),
                }, crumb.path === listing.home ? '主目录' : (crumb.name || crumb.path)))))
            : null,
          h('form', {
            className: 'dshcron-dir-path',
            onSubmit: (event) => { event.preventDefault(); if (draft.trim()) void load(draft) },
          },
            h('label', { className: 'dshcron-dir-path-label', htmlFor: 'dshcron-dir-path' }, '路径'),
            h('div', { className: 'dshcron-dir-path-row' },
              h('input', {
                id: 'dshcron-dir-path', className: 'dshcron-dir-input', value: draft,
                placeholder: '输入绝对路径', spellCheck: false, autoCapitalize: 'none', autoCorrect: 'off',
                maxLength: 4096, disabled: loading,
                onChange: (event) => { setDraft(event.target.value); setFailure('') },
              }),
              h('button', { type: 'submit', disabled: loading || !draft.trim() }, loading ? '读取中…' : '前往')))),
        h('div', { className: 'dshcron-dir-body', 'aria-busy': loading },
          loading && !listing
            ? h('div', { className: 'dshcron-dir-state' }, h('span', { className: 'dshcron-dir-spinner', 'aria-hidden': 'true' }))
            : listing
              ? entries.length > 0
                ? h('ul', { className: 'dshcron-dir-list' }, entries.map((entry) => h('li', { key: entry.path },
                  h('button', { type: 'button', title: entry.path, disabled: loading, onClick: () => void load(entry.path) },
                    h('span', { className: 'dshcron-dir-folder' }, h(FolderIcon)),
                    h('span', { className: 'dshcron-dir-name' }, entry.name),
                    h('span', { className: 'dshcron-dir-chevron' }, h(ChevronIcon))))))
                : h('div', { className: 'dshcron-dir-state' }, h('p', null, '没有子文件夹'))
              : null,
          failure ? h('div', { className: 'dshcron-dir-error', role: 'alert' }, failure) : null),
        h('footer', { className: 'dshcron-dir-footer' },
          h('button', {
            type: 'button', className: 'dshcron-dir-hidden', 'aria-pressed': showHidden,
            disabled: !listing, onClick: () => setShowHidden((value) => !value),
          },
            h('span', { className: 'dshcron-dir-check', 'aria-hidden': 'true' }),
            h('span', null, '显示隐藏文件夹')),
          h('div', { className: 'dshcron-dir-actions' },
            h('button', { type: 'button', onClick: onCancel }, '取消'),
            h('button', {
              type: 'button', className: 'dshcron-dir-primary', disabled: loading || !ready,
              onClick: () => listing && onPicked(listing.path),
            }, '选择此目录')))));

      return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body)
    }

    /** 带单位后缀的输入框：单位是控件的一部分，不另写说明。 */
    function UnitInput({ value, onChange, unit, placeholder, maxLength }) {
      return h('div', { className: 'dshcron-unit-input' },
        h(Input, { value, placeholder, maxLength, onChange: (event) => onChange(event.target.value) }),
        unit ? h('span', { className: 'dshcron-unit-suffix' }, unit) : null)
    }

    /** 卡片里的一行：左标签、右控件，行间一条细线。 */
    function FieldRow({ label, children, hint }) {
      return h('div', { className: 'dshcron-frow' },
        h('span', { className: 'dshcron-frow-label' }, label),
        h('div', { className: 'dshcron-frow-control' }, children),
        hint ? h('span', { className: 'dshcron-frow-hint' }, hint) : null)
    }

    // ---------------------------------------------------------------- editor

    /** 选项卡式平铺选择：用官方 Pill，支持任意数量自动换行。 */
    function OptionTabs({ value, options, onChange, label, empty }) {
      if (!options.length) return h('div', { className: 'dshcron-tabs-empty' }, empty ?? '—')
      return h('div', { className: 'dshcron-tabs', role: 'tablist', 'aria-label': label },
        options.map((item) => h(Pill, {
          key: item.value,
          active: item.value === value,
          role: 'tab',
          'aria-selected': item.value === value,
          onClick: () => onChange(item.value),
        }, item.label)))
    }

    const EMPTY_FORM = {
      title: '', mode: 'script', schedule: newSchedule(), script: '', prompt: '',
      workspace: '', delivery: { kind: 'silent' }, target: { kind: 'new_once' }, repeat: '', retries: '', timeoutSec: '', permission: '', preset: '', provider: '', model: '',
    }

    function DeliveryField({ value, onChange, targets }) {
      // 已保存的目标摊平成一串选项；任务里存的是 id、别名或渠道，都要能对回来。
      const saved = []
      for (const bot of targets?.available === true ? targets.bots ?? [] : []) {
        for (const target of bot.targets ?? []) {
          saved.push({
            id: `${bot.botId}:${target.targetId}`,
            label: `${bot.channel} · ${target.name}`,
            botId: bot.botId,
            targetId: target.targetId,
            channel: bot.channel,
            name: target.name,
            next: { kind: 'im', botId: bot.botId, targetId: target.targetId },
          })
        }
      }
      const options = [
        { id: 'silent', label: '静默', next: { kind: 'silent' } },
        { id: 'origin', label: '回原会话', next: { kind: 'origin', ...(value.kind === 'origin' && value.sessionId ? { sessionId: value.sessionId } : {}) } },
        { id: 'session', label: '会话日志', next: { kind: 'session' } },
        ...saved,
      ]

      // 任务写的是这组里的哪一个：先按 id，再按别名（目标名或 targetId），最后按渠道。
      const same = (left, right) => typeof left === 'string' && typeof right === 'string'
        && left.trim().toLowerCase() === right.trim().toLowerCase()
      let matched = null
      if (value.kind === 'im') {
        if (value.botId && value.targetId) {
          matched = saved.find((item) => item.botId === value.botId && item.targetId === value.targetId) ?? null
        }
        if (matched === null && value.target) {
          matched = saved.find((item) => same(item.targetId, value.target) || same(item.name, value.target)) ?? null
        }
        if (matched === null && value.bot) {
          const byChannel = saved.filter((item) => same(item.channel, value.bot) || same(item.botId, value.bot))
          matched = byChannel.length === 1 ? byChannel[0] : null
        }
      }
      // 对不上的老值留一条自己，别让下拉把它悄悄改掉；名字用能看懂的词，不摊内部 id。
      const stray = value.kind === 'im' && matched === null
        ? { id: 'im:stray', label: 'IM · 找不到这个目标', next: value }
        : null
      if (stray) options.unshift(stray)
      const current = value.kind === 'im' ? (matched?.id ?? 'im:stray') : value.kind

      return h('select', {
        className: 'dshcron-input dshcron-select', value: current,
        onChange: (event) => {
          const picked = options.find((item) => item.id === event.target.value)
          onChange(picked ? picked.next : { kind: 'silent' })
        },
      }, options.map((item) => h('option', { key: item.id, value: item.id }, item.label)))
    }


    /** 会话下拉：显示会话名称，不摆裸 ID。 */
    function SessionSelect({ value, onChange, rows, placeholder = '选择会话' }) {
      return h('select', {
        className: 'dshcron-input dshcron-select', value: value ?? '',
        onChange: (event) => onChange(event.target.value),
      }, [
        h('option', { key: '', value: '' }, rows.length ? placeholder : '该工作区暂无会话'),
        ...rows.map((row) => h('option', { key: row.sessionId, value: row.sessionId }, row.title)),
      ])
    }

    function TargetField({ value, onChange, rows }) {
      const kind = value?.kind ?? 'new_once'
      return h('div', { className: 'dshcron-target' },
        h(OptionTabs, {
          value: kind, label: '执行位置',
          options: [
            { value: 'new_once', label: '新建会话并复用' },
            { value: 'new', label: '每次新建会话' },
            { value: 'existing', label: '关联已有会话' },
          ],
          onChange: (next) => onChange(next === 'existing'
            ? { kind: 'existing', sessionId: value?.sessionId ?? '' }
            : { kind: next }),
        }),
        kind === 'existing'
          ? h(SessionSelect, {
            value: value?.sessionId ?? '', rows,
            onChange: (sessionId) => onChange({ kind: 'existing', sessionId }),
          })
          : null)
    }

    function Editor({ open, task, initialMode = 'script', workspaces, targets, onClose, onSaved, notify }) {
      const [form, setForm] = React.useState(EMPTY_FORM)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState('')
      const [allSessions, setAllSessions] = React.useState(null)
      const [presets, setPresets] = React.useState({ available: false, items: [] })
      const [models, setModels] = React.useState({ available: false, providers: [] })
      const [permissions, setPermissions] = React.useState({ available: false, items: [] })
      const [pickerOpen, setPickerOpen] = React.useState(false)
      const [logSession, setLogSession] = React.useState('')

      React.useEffect(() => {
        if (!open) return
        setFailure('')
        if (task) {
          setForm({
            title: task.title,
            mode: task.mode,
            schedule: scheduleDraft(task.schedule),
            script: task.script?.command ?? '',
            prompt: task.prompt ?? '',
            workspace: task.workspace,
            delivery: task.delivery ?? { kind: 'silent' },
            target: task.target ?? { kind: 'new_once' },
            repeat: task.repeat ? String(task.repeat) : '',
            retries: task.retries ? String(task.retries) : '',
            permission: task.permission ?? '',
            timeoutSec: task.timeoutMs ? String(Math.round(task.timeoutMs / 1000)) : '',
            preset: task.agent?.preset ?? '',
            provider: task.agent?.provider ?? '',
            model: task.agent?.model ?? '',
          })
          setLogSession(task.delivery?.sessionId ?? '')
        } else {
          setForm({
            ...EMPTY_FORM,
            mode: initialMode,
            workspace: workspaces[0]?.path ?? '',
            preset: presets.items.find((item) => item.isDefault)?.id ?? '',
          })
          setLogSession('')
        }
      }, [open, task?.id])

      // 会话名称走客户端会话列表；拿不到再退回宿主接口。
      React.useEffect(() => {
        if (!open) return undefined
        const store = clientCtx?.get?.('sessions')?.list
        const rows = readSessions()
        if (rows) {
          setAllSessions(rows)
          // 新建会话后列表会变，跟着刷新。
          if (typeof store?.subscribe === 'function') {
            const dispose = store.subscribe(() => setAllSessions(readSessions() ?? []))
            return () => { if (typeof dispose === 'function') dispose() }
          }
          return undefined
        }
        let alive = true
        api('/sessions')
          .then((payload) => {
            if (!alive) return
            setAllSessions((payload.items ?? [])
              .filter((item) => !internalSession({ id: item.sessionId, origin: item.origin }))
              .map((item) => ({ ...item, updatedAt: Date.parse(item.updatedAt) || 0 })))
          })
          .catch(() => { if (alive) setAllSessions([]) })
        return () => { alive = false }
      }, [open])

      React.useEffect(() => {
        if (!open) return undefined
        let alive = true
        api('/models')
          .then((payload) => { if (alive) setModels({ available: payload.available === true, providers: payload.providers ?? [] }) })
          .catch(() => { if (alive) setModels({ available: false, providers: [] }) })
        api('/permissions')
          .then((payload) => { if (alive) setPermissions({ available: payload.available === true, items: payload.items ?? [] }) })
          .catch(() => { if (alive) setPermissions({ available: false, items: [] }) })
        api('/presets')
          .then((payload) => { if (alive) setPresets({ available: payload.available === true, items: payload.items ?? [] }) })
          .catch(() => { if (alive) setPresets({ available: false, items: [] }) })
        return () => { alive = false }
      }, [open])

      const sessionRows = sessionsFor(allSessions, form.workspace)
      const canBrowse = directoryService() !== null

      /** 主动换工作区时，旧的会话选择不再有效。 */
      const changeWorkspace = (path) => {
        setForm((current) => ({
          ...current,
          workspace: path,
          ...(current.target?.kind === 'existing' ? { target: { kind: 'existing', sessionId: '' } } : {}),
        }))
        setLogSession('')
      }

      const patch = (next) => setForm((current) => ({ ...current, ...next }))

      const save = async () => {
        setBusy(true)
        setFailure('')
        try {
          const agent = form.mode === 'agent'
          // 模型任务写会话日志时，就写回这次运行自己的会话。
          const logToRun = agent && form.delivery.kind === 'session'
          const delivery = form.delivery.kind === 'session'
            ? (logToRun ? { kind: 'session' } : { kind: 'session', sessionId: logSession.trim() })
            : form.delivery
          if (delivery.kind === 'session' && !logToRun && !delivery.sessionId) {
            throw new Error('请选择要写入的会话')
          }
          const target = agent ? form.target : undefined
          if (target?.kind === 'existing' && !target.sessionId) {
            throw new Error('请选择要关联的会话')
          }
          const body = {
            title: form.title.trim(),
            mode: form.mode,
            schedule: form.schedule,
            delivery,
            repeat: form.repeat === '' ? null : Number(form.repeat),
            retries: form.retries === '' ? null : Number(form.retries),
            timeoutMs: form.timeoutSec === '' ? null : Number(form.timeoutSec) * 1000,
            permission: form.mode === 'agent' ? form.permission : '',
            workspace: form.workspace,
            ...(target ? { target } : {}),
            ...(agent
              ? {
                prompt: form.prompt,
                agent: {
                  ...(task?.agent ?? {}),
                  preset: form.preset,
                  provider: form.provider,
                  model: form.provider ? form.model : '',
                },
              }
              : { script: form.script }),
          }
          if (task) {
            await api(`/tasks/${task.id}`, { method: 'PATCH', body })
            notify?.('任务已保存')
          } else {
            await api('/tasks', { method: 'POST', body })
            notify?.('任务已创建')
          }
          onSaved()
          onClose()
        } catch (error) {
          setFailure(error.message)
        } finally {
          setBusy(false)
        }
      }

      return h(Drawer, {
        open, onClose, title: task ? '编辑任务' : '新建任务',
        footer: h('div', { className: 'dshcron-footer' },
          h(Button, { variant: 'ghost', size: 'sm', onClick: onClose }, '放弃'),
          h(Button, {
            variant: 'primary', size: 'sm',
            disabled: busy || !form.title.trim() || !form.workspace,
            onClick: save,
          }, busy ? '保存中…' : (task ? '保存' : '创建'))),
      },
      h('div', { className: 'dshcron-form' },
        h('label', { className: 'dshcron-field' },
          h('span', { className: 'dshcron-label' }, '名称'),
          h(Input, {
            value: form.title, maxLength: 80, placeholder: '端口巡检',
            onChange: (event) => patch({ title: event.target.value }),
          })),
        h('div', { className: 'dshcron-field' },
          h('div', { className: 'dshcron-labelrow' },
            h('span', { className: 'dshcron-label' }, '执行内容'),
            h('div', { className: 'dshcron-seg' },
              h(Pill, { active: form.mode === 'script', onClick: () => patch({ mode: 'script' }) }, '脚本模式'),
              h(Pill, { active: form.mode === 'agent', onClick: () => patch({ mode: 'agent' }) }, '智能模式'))),
          form.mode === 'script'
            ? h(Input, {
              value: form.script, placeholder: './cron/check-ports/check.sh',
              onChange: (event) => patch({ script: event.target.value }),
            })
            : h('textarea', {
              className: 'dshcron-textarea', rows: 4, value: form.prompt,
              placeholder: '看看今天的告警，挑出需要人工处理的',
              onChange: (event) => patch({ prompt: event.target.value }),
            })),

        h('div', { className: 'dshcron-group' }, '执行'),
        h('div', { className: 'dshcron-card' },
          h(FieldRow, { label: '工作区' },
            canBrowse
              ? h('button', {
                type: 'button', className: 'dshcron-pick', onClick: () => setPickerOpen(true),
                title: form.workspace || undefined,
              },
              h('span', { className: form.workspace ? 'dshcron-pick-text' : 'dshcron-pick-text dshcron-pick-text--empty' }, form.workspace || '选择目录'),
              h(ChevronIcon, {}))
              : h(Input, {
                value: form.workspace, placeholder: '/绝对路径',
                onChange: (event) => changeWorkspace(event.target.value),
              })),
          form.mode === 'agent'
            ? h(FieldRow, { label: '运行 Agent' },
              presets.available && presets.items.length > 0
                ? h('select', {
                  className: 'dshcron-bare',
                  // 没选过就显示宿主默认那个，避免下拉空白。
                  value: form.preset || presets.items.find((item) => item.isDefault)?.id || presets.items[0].id,
                  onChange: (event) => patch({ preset: event.target.value }),
                }, presets.items.map((item) => h('option', { key: item.id, value: item.id }, item.name)))
                : h(Input, {
                  value: form.preset, placeholder: '默认',
                  onChange: (event) => patch({ preset: event.target.value }),
                }))
            : null,
          form.mode === 'agent' && models.available
            ? h(FieldRow, { label: '运行模型' },
              h('div', { className: 'dshcron-inline' },
                h('select', {
                  className: 'dshcron-bare',
                  value: form.provider,
                  onChange: (event) => patch({ provider: event.target.value, model: '' }),
                }, [
                  h('option', { key: '', value: '' }, '默认提供商'),
                  ...models.providers.map((item) => h('option', { key: item.id, value: item.id }, item.name)),
                ]),
                h('span', { className: 'dshcron-slash' }, '/'),
                h('select', {
                  className: 'dshcron-bare',
                  value: form.model,
                  disabled: !form.provider,
                  onChange: (event) => patch({ model: event.target.value }),
                }, [
                  h('option', { key: '', value: '' }, form.provider ? '默认模型' : '默认'),
                  ...(models.providers.find((item) => item.id === form.provider)?.models ?? [])
                    .map((item) => h('option', { key: item.id, value: item.id }, item.name)),
                ])))
            : null,
          form.mode === 'agent' && permissions.available
            ? h(FieldRow, { label: '权限' },
              h('select', {
                className: 'dshcron-bare',
                value: form.permission,
                onChange: (event) => patch({ permission: event.target.value }),
              }, [
                h('option', { key: '', value: '' }, '跟随会话'),
                ...permissions.items.map((item) => h('option', { key: item.id, value: item.id }, item.name)),
              ]))
            : null,
          form.mode === 'agent'
            ? h(FieldRow, { label: '执行位置' },
              h(TargetField, {
                value: form.target, onChange: (target) => patch({ target }), rows: sessionRows,
              }))
            : null),

        h('div', { className: 'dshcron-group' }, '运行时间'),
        h('div', { className: 'dshcron-card' },
          h('div', { className: 'dshcron-frow dshcron-frow--stack' },
            h('span', { className: 'dshcron-frow-label' }, '执行周期'),
            h('div', { className: 'dshcron-frow-control' },
              h(ScheduleField, { value: form.schedule, onChange: (schedule) => patch({ schedule }) }))),
          h(FieldRow, { label: '重复次数' },
            h(UnitInput, {
              value: form.repeat, placeholder: '不限', unit: '次',
              onChange: (value) => patch({ repeat: value.replace(/[^0-9]/g, '') }),
            }))),

        h('div', { className: 'dshcron-group' }, '失败处理'),
        h('div', { className: 'dshcron-card' },
          h(FieldRow, { label: '失败重试' },
            h(UnitInput, {
              value: form.retries, placeholder: '不重试', unit: '次',
              onChange: (value) => patch({ retries: value.replace(/[^0-9]/g, '').slice(0, 1) }),
            })),
          h(FieldRow, { label: '单次超时' },
            h(UnitInput, {
              value: form.timeoutSec, placeholder: '跟随全局', unit: '秒',
              onChange: (value) => patch({ timeoutSec: value.replace(/[^0-9]/g, '').slice(0, 5) }),
            }))),

        h('div', { className: 'dshcron-group' }, '结果'),
        h('div', { className: 'dshcron-card' },
          h(FieldRow, { label: '推送' },
            h(DeliveryField, { value: form.delivery, onChange: (delivery) => patch({ delivery }), targets })),
          form.delivery.kind === 'session' && form.mode === 'script'
            ? h(FieldRow, { label: '会话' },
              h(SessionSelect, { value: logSession, onChange: setLogSession, rows: sessionRows }))
            : null),

        failure ? h('div', { className: 'dshcron-error' }, failure) : null),
      h(DirectoryPicker, {
        open: pickerOpen,
        startPath: form.workspace || workspaces[0]?.path || '',
        onPicked: (path) => { changeWorkspace(path); setPickerOpen(false) },
        onCancel: () => setPickerOpen(false),
      }))
    }

    // ---------------------------------------------------------------- history

    function History({ task, onClose, onOpenSession }) {
      const [runs, setRuns] = React.useState(null)
      const [failure, setFailure] = React.useState('')

      React.useEffect(() => {
        if (!task) return
        setRuns(null)
        api(`/tasks/${task.id}/runs?limit=30`)
          .then((payload) => setRuns(payload.runs))
          .catch((error) => setFailure(error.message))
      }, [task?.id])

      return h(Modal, {
        open: task !== null, onClose, title: task ? `${task.title} · 执行历史` : '',
        className: 'dshcron-modal', contentClassName: 'dshcron-modal-content dshcron-modal-content--wide',
      },
      failure ? h('div', { className: 'dshcron-error' }, failure) : null,
      runs === null
        ? h('div', { className: 'dshcron-empty-line' }, '…')
        : runs.length === 0
          ? h('div', { className: 'dshcron-empty-line' }, '还没跑过')
          : h('div', { className: 'dshcron-runs' }, runs.map((run) => h('div', { key: run.runId, className: 'dshcron-run' },
            h('div', { className: 'dshcron-run-top' },
              h(StateDot, { state: run.status === 'ok' ? 'done' : run.status === 'skipped' ? 'idle' : 'error' }),
              h('span', { className: 'dshcron-run-status' }, RESULT_LABEL[run.status] ?? run.status),
              h('span', { className: 'dshcron-run-time' }, formatTime(run.startedAt)),
              h('span', { className: 'dshcron-run-meta' }, run.durationMs != null ? `${run.durationMs}ms` : ''),
              run.sessionId
                ? h(Button, {
                  variant: 'ghost', size: 'sm', title: '打开这次运行的会话',
                  icon: h(IconNewChatOutlineRegular, { size: 14 }),
                  onClick: () => onOpenSession?.(run.sessionId),
                }, '会话')
                : null),
            run.output || run.error
              ? h('pre', { className: 'dshcron-run-output' }, (run.output || run.error || '').slice(0, 4000))
              : null))))
    }

    /** 删除前的确认：把要删的任务摊在标题里，免得删错。 */
    function DeleteConfirm({ task, busy, onCancel, onConfirm }) {
      return h(Modal, {
        open: task !== null,
        onClose: onCancel,
        title: task ? `删除「${task.title}」？` : '',
        className: 'dshcron-modal',
        contentClassName: 'dshcron-modal-content',
        footer: h('div', { className: 'dshcron-confirm-actions' },
          h(Button, { 'data-modal-autofocus': true, onClick: onCancel }, '取消'),
          h(Button, {
            variant: 'outline', className: 'dshcron-danger', disabled: busy,
            onClick: () => task && onConfirm(task),
          }, '删除')),
      },
      h('p', { className: 'dshcron-confirm-prompt' },
        task ? `${task.scheduleText} · ${task.workspace}` : ''),
      task && task.target?.kind !== 'existing' && task.targetSessionId
        ? h('p', { className: 'dshcron-confirm-prompt' }, '它建的会话会一并归档')
        : null)
    }

    // ---------------------------------------------------------------- incidents

    function Incidents({ open, onClose, onChanged }) {
      const [items, setItems] = React.useState(null)
      const load = () => api('/incidents?status=open').then((payload) => setItems(payload.incidents)).catch(() => setItems([]))
      React.useEffect(() => { if (open) load() }, [open])

      return h(Modal, {
        open, onClose, title: '待处理的故障',
        className: 'dshcron-modal', contentClassName: 'dshcron-modal-content',
      },
      items === null
        ? h('div', { className: 'dshcron-empty-line' }, '…')
        : items.length === 0
          ? h('div', { className: 'dshcron-empty-line' }, '没有待处理的故障')
          : h('div', { className: 'dshcron-incidents' }, items.map((incident) => h('div', { key: incident.id, className: 'dshcron-incident' },
            h('div', { className: 'dshcron-incident-top' },
              h(IconWarningOutlineRegular, { size: 14 }),
              h('span', { className: 'dshcron-incident-title' }, incident.title),
              h('span', { className: 'dshcron-incident-count' }, `失败 ${incident.count} 次`)),
            h('div', { className: 'dshcron-incident-time' }, `${formatTime(incident.openedAt)} 起 · 最近 ${formatTime(incident.lastSeenAt)}`),
            incident.lastError ? h('pre', { className: 'dshcron-run-output' }, incident.lastError) : null,
            h('div', { className: 'dshcron-incident-actions' },
              h(Button, {
                variant: 'ghost', size: 'sm',
                onClick: async () => { await api(`/incidents/${incident.id}/ack`, { method: 'POST' }); await load(); onChanged?.() },
              }, '确认'))))))
    }

    // ---------------------------------------------------------------- page

    const TABS = [
      { id: 'active', label: '已开启' },
      { id: 'paused', label: '已暂停' },
      { id: 'ended', label: '已结束' },
      { id: 'all', label: '全部' },
    ]

    /** 任务的状态分组：已开启跑着、已暂停、已结束（一次性跑完或次数用尽）。 */
    function taskPhase(task) {
      if (!task.enabled) return 'paused'
      if (!task.state?.nextRunAt) return 'ended'
      return 'active'
    }

    /** 智能模式这条任务跑在哪个会话里；脚本模式没有会话。 */
    function taskSessionId(task) {
      if (task.mode !== 'agent') return null
      if (task.target?.kind === 'existing') return task.target.sessionId ?? null
      return task.targetSessionId ?? null
    }

    function Row({ task, onRun, onToggle, onEdit, onHistory, onDelete, onOpenSession, busy }) {
      const result = task.state?.lastResult
      const phase = taskPhase(task)
      const when = phase === 'paused' ? '已暂停' : phase === 'ended' ? '已结束' : formatTime(task.state?.nextRunAt)
      const sub = phase === 'active' ? relative(task.state?.nextRunAt) : task.scheduleText
      const sessionId = taskSessionId(task)
      const meta = [MODE_LABEL[task.mode] ?? task.mode, task.scheduleText]
      return h('div', { className: 'dshcron-row' },
        h('div', { className: 'dshcron-cell dshcron-cell--time' },
          h(IconClockOutlineRegular, { size: 14, className: 'dshcron-clock' }),
          h('div', null,
            h('div', { className: 'dshcron-when' }, when),
            h('div', { className: 'dshcron-when-sub' }, sub))),
        h('div', { className: 'dshcron-cell dshcron-cell--task' },
          h('div', { className: 'dshcron-title', title: task.title }, task.title),
          h('div', { className: 'dshcron-sub' }, meta.join(' · '))),
        h('div', { className: 'dshcron-cell dshcron-cell--ws', title: task.workspace },
          h(PathLabel, { path: task.workspace })),
        h('div', { className: 'dshcron-cell dshcron-cell--last' },
          result
            ? [h(StateDot, { key: 'dot', state: result === 'ok' ? 'done' : result === 'skipped' ? 'idle' : 'error' }),
              h('span', { key: 'text', className: 'dshcron-last' }, `${RESULT_LABEL[result] ?? result} · ${relative(task.state?.lastRunAt)}`)]
            : h('span', { className: 'dshcron-last dshcron-last--none' }, '未运行')),
        h('div', { className: 'dshcron-cell dshcron-cell--actions' },
          h(Button, { variant: 'ghost', size: 'sm', icon: h(IconPlayOutlineRegular, { size: 14 }), disabled: busy, onClick: () => onRun(task) }, '立即运行'),
          sessionId
            ? h(Button, {
              variant: 'ghost', size: 'sm', title: '打开这条任务的会话',
              icon: h(IconNewChatOutlineRegular, { size: 14 }), onClick: () => onOpenSession(sessionId),
            }, '会话')
            : null,
          h(Button, {
            variant: 'ghost', size: 'sm', title: task.enabled ? '暂停' : '启用',
            icon: task.enabled ? h(IconPauseOutlineRegular, { size: 14 }) : h(IconPlayOutlineRegular, { size: 14 }),
            onClick: () => onToggle(task),
          }, task.enabled ? '暂停' : '启用'),
          h(Button, { variant: 'ghost', size: 'sm', title: '编辑', icon: h(IconEditOutlineRegular, { size: 14 }), onClick: () => onEdit(task) }, '编辑'),
          h(Button, { variant: 'ghost', size: 'sm', title: '执行历史', icon: h(IconClockOutlineRegular, { size: 14 }), onClick: () => onHistory(task) }, '历史'),
          h(Button, { variant: 'ghost', size: 'sm', title: '删除', icon: h(IconTrashOutlineRegular, { size: 14 }), onClick: () => onDelete(task) }, '删除')))
    }

    function CronPage() {
      const [data, setData] = React.useState({ tasks: [], status: null, targets: null, workspaces: [] })
      const [editing, setEditing] = React.useState(null)
      const [editorOpen, setEditorOpen] = React.useState(false)
      const [editorMode, setEditorMode] = React.useState('script')
      const [history, setHistory] = React.useState(null)
      const [incidentsOpen, setIncidentsOpen] = React.useState(false)
      const [openIncidents, setOpenIncidents] = React.useState(0)
      const [busy, setBusy] = React.useState(false)
      const [toast, setToast] = React.useState(null)
      const [failure, setFailure] = React.useState('')
      const [tab, setTab] = React.useState('active')
      const [query, setQuery] = React.useState('')
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [pendingDelete, setPendingDelete] = React.useState(null)

      const notify = (text, tone = 'success') => setToast({ text, tone, key: Date.now() })

      const refresh = React.useCallback(async () => {
        try {
          const [tasks, status, workspaces, targets, incidents] = await Promise.all([
            api('/tasks'), api('/status'), api('/workspaces'), api('/targets'), api('/incidents?status=open'),
          ])
          setData({ tasks: tasks.items, status, workspaces: workspaces.items, targets })
          setOpenIncidents(incidents.incidents.length)
          setFailure('')
        } catch (error) {
          setFailure(error.message)
        }
      }, [])

      React.useEffect(() => {
        refresh()
        const timer = setInterval(refresh, 15000)
        return () => clearInterval(timer)
      }, [refresh])

      const act = async (fn, message) => {
        setBusy(true)
        try {
          const result = await fn()
          await refresh()
          if (message) notify(message)
          return result
        } catch (error) {
          notify(error.message, 'error')
        } finally {
          setBusy(false)
        }
      }

      const openEditor = (task, mode) => {
        setEditing(task)
        setEditorMode(mode ?? task?.mode ?? 'script')
        setEditorOpen(true)
        setMenuOpen(false)
      }

      const openSession = (sessionId) => {
        let workspace
        try { workspace = clientCtx?.get?.('uiWorkspace') } catch { workspace = null }
        if (typeof workspace?.openSession !== 'function') {
          notify('当前环境打不开会话', 'error')
          return
        }
        workspace.openSession(sessionId)
      }

      const tasks = data.tasks
      const counts = { active: 0, paused: 0, ended: 0, all: tasks.length }
      for (const task of tasks) counts[taskPhase(task)] += 1
      const keyword = query.trim().toLowerCase()
      const visible = tasks.filter((task) => {
        if (tab !== 'all' && taskPhase(task) !== tab) return false
        if (!keyword) return true
        return [task.title, task.workspace, task.prompt, task.scheduleText]
          .some((field) => typeof field === 'string' && field.toLowerCase().includes(keyword))
      })

      return h('div', { className: 'dshcron-page' },
        h('header', { className: 'dshcron-head' },
          h('h1', { className: 'dshcron-h1' }, '定时任务'),
          h('div', { className: 'dshcron-head-actions' },
            openIncidents > 0
              ? h(Button, { variant: 'outline', size: 'sm', icon: h(IconWarningOutlineRegular, { size: 14 }), onClick: () => setIncidentsOpen(true) }, `故障 ${openIncidents}`)
              : null,
            h('div', { className: 'dshcron-split' },
              h('button', {
                type: 'button', className: 'dshcron-split-main',
                onClick: () => openEditor(null, 'script'),
              }, h(IconPlusOutlineRegular, { size: 14 }), '新建'),
              h('button', {
                type: 'button', className: 'dshcron-split-caret',
                'aria-label': '更多创建方式', 'aria-expanded': menuOpen,
                onClick: () => setMenuOpen((open) => !open),
              }, h(IconChevronDownOutlineRegular, { size: 14 })),
              menuOpen
                ? h('div', { className: 'dshcron-menu' },
                  h('button', { type: 'button', onClick: () => openEditor(null, 'script') }, '脚本模式任务'),
                  h('button', { type: 'button', onClick: () => openEditor(null, 'agent') }, '智能模式任务'))
                : null,
              menuOpen ? h('div', { className: 'dshcron-menu-backdrop', onClick: () => setMenuOpen(false) }) : null))),

        h('div', { className: 'dshcron-tabs', role: 'tablist' },
          TABS.map((item) => h('button', {
            key: item.id, type: 'button', role: 'tab',
            className: tab === item.id ? 'dshcron-tab dshcron-tab--active' : 'dshcron-tab',
            'aria-selected': tab === item.id,
            onClick: () => setTab(item.id),
          }, `${item.label} ${counts[item.id]}`))),

        h('div', { className: 'dshcron-search' },
          h(IconSearchOutlineRegular, { size: 14, className: 'dshcron-search-icon' }),
          h('input', {
            className: 'dshcron-search-input', value: query,
            placeholder: '搜索定时任务', 'aria-label': '搜索定时任务',
            onChange: (event) => setQuery(event.target.value),
          })),

        failure ? h('div', { className: 'dshcron-error dshcron-error--page' }, failure) : null,

        tasks.length === 0
          ? h('div', { className: 'dshcron-empty' },
            h('p', { className: 'dshcron-empty-title' }, '还没有定时任务'),
            h(Button, { variant: 'outline', size: 'sm', onClick: () => openEditor(null, 'script') }, '新建'))
          : visible.length === 0
            ? h('div', { className: 'dshcron-empty' },
              h('p', { className: 'dshcron-empty-title' }, keyword ? '没有匹配的任务' : '这里还没有任务'))
            : h('div', { className: 'dshcron-table' },
              h('div', { className: 'dshcron-row dshcron-row--head' },
                h('span', null, '下次执行'), h('span', null, '任务'),
                h('span', null, '工作区'), h('span', null, '上次'), h('span', null, '')),
              visible.map((task) => h(Row, {
                key: task.id, task, busy,
                onRun: (item) => act(() => api(`/tasks/${item.id}/run`, { method: 'POST' }), '已触发运行'),
                onToggle: (item) => act(
                  () => api(`/tasks/${item.id}/${item.enabled ? 'pause' : 'resume'}`, { method: 'POST' }),
                  item.enabled ? '已暂停' : '已恢复',
                ),
                onEdit: (item) => openEditor(item),
                onHistory: (item) => setHistory(item),
                onOpenSession: openSession,
                onDelete: (item) => setPendingDelete(item),
              }))),

        h(Editor, {
          open: editorOpen, task: editing, initialMode: editorMode,
          workspaces: data.workspaces, targets: data.targets,
          onClose: () => setEditorOpen(false), onSaved: refresh,
          notify: (text, tone) => notify(text, tone),
        }),
        h(DeleteConfirm, {
          task: pendingDelete, busy,
          onCancel: () => setPendingDelete(null),
          onConfirm: (item) => {
            setPendingDelete(null)
            act(async () => {
              const result = await api(`/tasks/${item.id}`, { method: 'DELETE' })
              const archived = result?.sessions?.archived ?? 0
              notify(archived > 0 ? `任务已删除，${archived} 个会话已归档` : '任务已删除')
            })
          },
        }),
        h(History, { task: history, onClose: () => setHistory(null), onOpenSession: openSession }),
        h(Incidents, { open: incidentsOpen, onClose: () => setIncidentsOpen(false), onChanged: refresh }),
        toast ? h(Toast, { key: toast.key, text: toast.text, tone: toast.tone, onDone: () => setToast(null) }) : null)
    }

    /** 侧边栏与页面共用的表盘图标：细线圆 + 时针分针，小尺寸下也不糊。 */
    function CronIcon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
      h('circle', { cx: 12, cy: 12, r: 8.2 }),
      h('path', { d: 'M12 6.8v5.4l3.7 2.2' }),
      h('circle', { cx: 12, cy: 12, r: 1.1, fill: 'currentColor', stroke: 'none' }))
    }

    // ---------------------------------------------------------------- styles

    const CSS = `
.dshcron-page{box-sizing:border-box;height:100%;overflow-y:auto;padding:24px 32px 48px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.dshcron-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}
.dshcron-h1{margin:0;font-size:17px;font-weight:600;letter-spacing:.01em}
.dshcron-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;margin-top:2px}
.dshcron-head-actions{display:flex;gap:8px;align-items:center}
/* ---- 页签 / 搜索 / 新建 ---- */
.dshcron-tabs{display:flex;gap:4px;margin:0 0 12px}
.dshcron-tab{appearance:none;border:0;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;padding:5px 12px;border-radius:999px;cursor:pointer;font-variant-numeric:tabular-nums}
.dshcron-tab:hover{color:var(--dsw-alias-label-primary)}
.dshcron-tab--active{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dshcron-search{position:relative;display:flex;align-items:center;margin:0 0 14px}
.dshcron-confirm-actions{display:flex;justify-content:flex-end;gap:8px}
.dshcron-danger{color:var(--dsw-alias-state-error-primary);--dsh-button-outline-color:var(--dsw-alias-state-error-primary)}
.dshcron-confirm-prompt{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dshcron-search-icon{position:absolute;left:12px;color:var(--dsw-alias-label-tertiary);pointer-events:none}
.dshcron-search-input{box-sizing:border-box;width:100%;height:36px;padding:0 12px 0 34px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dshcron-search-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dshcron-search-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dshcron-split{position:relative;display:inline-flex;border-radius:10px;overflow:visible;background:var(--dsw-alias-label-primary)}
.dshcron-split-main,.dshcron-split-caret{appearance:none;border:0;background:none;color:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:20px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:7px 12px}
.dshcron-split-main{border-radius:10px 0 0 10px;padding-left:14px}
.dshcron-split-caret{border-radius:0 10px 10px 0;padding:7px 8px;border-left:1px solid rgb(255 255 255 / 18%)}
.dshcron-split-main:hover,.dshcron-split-caret:hover{opacity:.88}
.dshcron-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:40;display:flex;flex-direction:column;min-width:150px;padding:4px;border-radius:12px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgb(0 0 0 / 18%));border:1px solid var(--dsw-alias-border-l1)}
.dshcron-menu button{appearance:none;border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;padding:8px 10px;border-radius:8px;cursor:pointer;white-space:nowrap}
.dshcron-menu button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshcron-menu-backdrop{position:fixed;inset:0;z-index:30}

/* ---- 右侧抽屉 ---- */
.dshcron-drawer-backdrop{position:fixed;inset:0;z-index:1000;display:flex;justify-content:flex-end;background:rgb(15 17 21 / 30%);animation:dshcron-fade .12s ease-out}
.dshcron-drawer-backdrop,.dshcron-drawer-backdrop *{box-sizing:border-box}
.dshcron-drawer{display:grid;grid-template-rows:auto minmax(0,1fr) auto;width:min(560px,100vw);height:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border-left:1px solid var(--dsw-alias-border-l2);box-shadow:-24px 0 64px rgb(15 17 21 / 18%);animation:dshcron-slide-in .18s cubic-bezier(.2,.7,.3,1)}
.dshcron-drawer-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 20px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshcron-drawer-title{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}
.dshcron-drawer-close{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dshcron-drawer-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshcron-drawer-body{overflow-y:auto;padding:16px 20px 28px}
.dshcron-drawer-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
@keyframes dshcron-slide-in{from{transform:translateX(16px);opacity:.4}to{transform:none;opacity:1}}
@keyframes dshcron-fade{from{opacity:0}to{opacity:1}}

/* ---- 卡片式表单 ---- */
.dshcron-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dshcron-frow{display:grid;grid-template-columns:minmax(72px,auto) minmax(0,1fr);gap:12px;align-items:center;padding:8px 14px;border-top:.5px solid var(--dsw-alias-border-l1);min-height:44px}
.dshcron-card>.dshcron-frow:first-child{border-top:0}
.dshcron-frow--stack{align-items:start;padding-top:12px;padding-bottom:12px}
.dshcron-frow--stack>.dshcron-frow-label{padding-top:6px}
.dshcron-frow-label{color:var(--dsw-alias-label-secondary);font-size:13px;white-space:nowrap}
.dshcron-frow-control{min-width:0;display:flex;justify-content:flex-end}
.dshcron-frow-control>select,.dshcron-frow-control>input{width:100%}
.dshcron-frow-control>.dshcron-unit-input{width:100%}
.dshcron-unit-input{display:flex;align-items:center;gap:8px;min-width:0}
.dshcron-unit-input>input{flex:1;min-width:0}
.dshcron-unit-suffix{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12.5px}
.dshcron-frow-hint{grid-column:2;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;margin-top:-4px}
.dshcron-labelrow{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dshcron-bare{appearance:none;border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:right;text-align-last:right;padding:6px 2px;cursor:pointer;outline:none;max-width:100%}
.dshcron-bare:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.dshcron-bare:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);border-radius:6px}
.dshcron-inline{display:flex;align-items:center;gap:6px;min-width:0;justify-content:flex-end}
.dshcron-slash{color:var(--dsw-alias-label-tertiary)}
.dshcron-pick{appearance:none;border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;display:flex;align-items:center;gap:6px;min-width:0;padding:6px 2px;margin-left:auto}
.dshcron-pick-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dshcron-pick-text--empty{color:var(--dsw-alias-label-tertiary)}
.dshcron-pick svg{flex:none;color:var(--dsw-alias-label-tertiary)}

.dshcron-table{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.dshcron-row{display:grid;grid-template-columns:150px minmax(180px,1fr) minmax(120px,220px) 130px auto;gap:12px;align-items:center;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.dshcron-row:first-child{border-top:0}
.dshcron-row--head{padding:9px 16px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshcron-row--head span{white-space:nowrap}
.dshcron-row:not(.dshcron-row--head):hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshcron-cell{min-width:0}
.dshcron-cell--time{display:flex;gap:7px;align-items:flex-start}
.dshcron-clock{color:var(--dsw-alias-label-tertiary);margin-top:2px;flex:none}
.dshcron-when{font-variant-numeric:tabular-nums;font-size:12.5px}
.dshcron-when-sub{color:var(--dsw-alias-label-tertiary);font-size:11.5px;margin-top:1px}
.dshcron-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshcron-cell--ws{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden}
.dshcron-cell--last{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dshcron-last--none{color:var(--dsw-alias-label-tertiary)}
.dshcron-cell--actions{display:flex;gap:2px;justify-content:flex-end}
.dshcron-mode{font-size:11.5px}
.dshcron-empty{display:flex;flex-direction:column;align-items:center;gap:12px;padding:72px 0;color:var(--dsw-alias-label-tertiary);border:1px dashed var(--dsw-alias-border-l2);border-radius:12px}
.dshcron-empty-title{margin:0;font-size:13px}
.dshcron-empty-line{color:var(--dsw-alias-label-tertiary);padding:16px 0;text-align:center}
.dshcron-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
.dshcron-error--page{margin-bottom:12px}
.dshcron-modal{width:min(600px,calc(100vw - 48px))!important}
.dshcron-modal-content{min-width:0;width:100%!important;max-height:calc(100vh - 96px);overflow-y:auto}
.dshcron-modal-content--wide{width:100%!important}
.dshcron-scroll{min-width:0}
.dshcron-form{display:flex;flex-direction:column;gap:16px}
.dshcron-group{margin-top:2px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;letter-spacing:.02em}
.dshcron-form>.dshcron-group:first-child{margin-top:0;padding-top:0;border-top:0}
.dshcron-hint{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px}
.dshcron-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.dshcron-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.dshcron-grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.dshcron-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dshcron-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dshcron-input--num{width:76px;text-align:right;font-variant-numeric:tabular-nums}
.dshcron-select{cursor:pointer;appearance:none;padding-right:24px;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 13px) 14px,calc(100% - 9px) 14px;background-size:4px 4px;background-repeat:no-repeat}
.dshcron-select--kind{width:104px;flex:none}
.dshcron-sched{display:flex;flex-direction:column;gap:8px}
.dshcron-sched-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dshcron-num{display:flex;align-items:center;gap:6px}
.dshcron-suffix{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshcron-preview{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;font-size:12px;color:var(--dsw-alias-label-tertiary);min-height:18px}
.dshcron-preview-text{color:var(--dsw-alias-label-secondary)}
.dshcron-preview-next{font-variant-numeric:tabular-nums}
.dshcron-preview-muted{opacity:.6}
.dshcron-preview-bad{color:var(--dsw-alias-state-error-primary)}
.dshcron-textarea{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;resize:vertical;outline:none;line-height:1.55}
.dshcron-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.dshcron-seg{display:flex;gap:6px;margin-bottom:2px;flex-wrap:wrap}
.dshcron-tabs{display:flex;flex-wrap:wrap;gap:6px;min-width:0}
.dshcron-tabs [role="tab"]{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshcron-tabs-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:4px 0}
.dshcron-path{display:flex;align-items:center;gap:8px;min-width:0}
.dshcron-path-text{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:12px ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:0 10px;height:32px;line-height:30px}
.dshcron-path-text--empty{color:var(--dsw-alias-label-tertiary);background:transparent;border-style:dashed}
.dshcron-target,.dshcron-workspace{display:flex;flex-direction:column;gap:8px;min-width:0}
.dshcron-readonly{height:32px;display:flex;align-items:center;color:var(--dsw-alias-label-tertiary);font-size:12.5px}
.dshcron-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.dshcron-runs{display:flex;flex-direction:column;gap:10px;max-height:52vh;overflow-y:auto}
.dshcron-run{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px}
.dshcron-run-top{display:flex;align-items:center;gap:8px;font-size:12px}
.dshcron-run-status{font-weight:500}
.dshcron-run-time,.dshcron-run-meta{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshcron-run-output{margin:8px 0 0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;color:var(--dsw-alias-label-secondary)}
.dshcron-incidents{display:flex;flex-direction:column;gap:10px;max-height:52vh;overflow-y:auto}
.dshcron-incident{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px}
.dshcron-incident-top{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-state-error-primary);font-size:12.5px}
.dshcron-incident-title{color:var(--dsw-alias-label-primary);font-weight:500}
.dshcron-incident-count{color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.dshcron-incident-time{color:var(--dsw-alias-label-tertiary);font-size:11.5px;margin-top:3px}
.dshcron-incident-actions{margin-top:8px;display:flex;justify-content:flex-end}
/* ---- 插件配置 ---- */
.dshcron-config{display:flex;flex-direction:column;gap:10px;max-width:560px}
.dshcron-config-empty{color:var(--dsw-alias-label-tertiary);font-size:13px}
.dshcron-config-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,180px) max-content;align-items:center;gap:10px;min-height:36px}
.dshcron-config-label{color:var(--dsw-alias-label-primary);font-size:13px}
.dshcron-config-input{min-width:0;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dshcron-config-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dshcron-config-input:disabled{opacity:.6;cursor:not-allowed}
.dshcron-config-unit{color:var(--dsw-alias-label-tertiary);font-size:11.5px;white-space:nowrap}
.dshcron-config-switch{position:relative;width:38px;height:22px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;padding:0}
.dshcron-config-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dshcron-config-switch:disabled{opacity:.55;cursor:not-allowed}
.dshcron-config-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgb(0 0 0 / 20%);transition:transform .15s}
.dshcron-config-switch[aria-checked="true"] .dshcron-config-knob{transform:translateX(16px)}
.dshcron-config-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
.dshcron-config-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.dshcron-config-field{display:flex;flex-direction:column;gap:6px;max-width:420px}
.dshcron-config-control{display:flex;align-items:center;gap:8px;min-width:0}
.dshcron-config-control .dshcron-config-input{flex:1;min-width:0}
/* ---- 目录选择器 ---- */
.dshcron-dir-backdrop{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:24px;background:rgb(15 17 21 / 42%);backdrop-filter:blur(3px)}
.dshcron-dir-backdrop,.dshcron-dir-backdrop *{box-sizing:border-box}
.dshcron-dir{width:min(720px,100%);height:min(620px,calc(100vh - 48px));min-height:420px;display:grid;grid-template-rows:auto minmax(0,1fr) auto;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);box-shadow:0 24px 72px rgb(15 17 21 / 24%)}
.dshcron-dir-header{min-width:0;padding:22px 24px 17px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dshcron-dir-header h3{margin:0 0 12px;font-size:20px;line-height:1.35;font-weight:680}
.dshcron-dir-crumbs{min-width:0;display:flex;align-items:center;flex-wrap:wrap;gap:4px;color:var(--dsw-alias-label-tertiary)}
.dshcron-dir-crumbs button{max-width:210px;overflow:hidden;padding:3px 5px;border:0;border-radius:6px;color:var(--dsw-alias-label-secondary);background:transparent;font:inherit;font-size:12px;line-height:18px;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}
.dshcron-dir-crumbs button:hover:not(:disabled){color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.dshcron-dir-crumbs button[aria-current="page"]{color:var(--dsw-alias-label-primary);font-weight:650}
.dshcron-dir-sep{flex:none;font-size:12px}
.dshcron-dir-path{display:grid;gap:7px;margin-top:12px}
.dshcron-dir-path-label{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:650}
.dshcron-dir-path-row{min-width:0;display:grid;grid-template-columns:minmax(0,1fr) max-content;gap:8px}
.dshcron-dir-input{min-width:0;height:38px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:12px ui-monospace,SFMono-Regular,Consolas,monospace;outline:none}
.dshcron-dir-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dshcron-dir-path-row>button{min-height:38px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);font:inherit;font-size:13px;font-weight:650;cursor:pointer}
.dshcron-dir-path-row>button:disabled{cursor:not-allowed;opacity:.55}
.dshcron-dir-body{min-height:0;overflow-y:auto;padding:14px 16px}
.dshcron-dir-list{display:grid;gap:3px;margin:0;padding:0;list-style:none}
.dshcron-dir-list button{width:100%;min-height:46px;display:grid;grid-template-columns:24px minmax(0,1fr) 18px;align-items:center;gap:10px;padding:7px 11px;border:0;border-radius:9px;color:var(--dsw-alias-label-primary);background:transparent;font:inherit;text-align:left;cursor:pointer}
.dshcron-dir-list button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshcron-dir-list button:disabled{cursor:wait;opacity:.55}
.dshcron-dir-folder{width:24px;height:24px;display:grid;place-items:center;color:var(--dsw-alias-label-secondary)}
.dshcron-dir-folder svg{width:22px;height:22px}
.dshcron-dir-name{min-width:0;overflow:hidden;font-size:14px;line-height:20px;text-overflow:ellipsis;white-space:nowrap}
.dshcron-dir-chevron{width:18px;height:18px;display:grid;place-items:center;color:var(--dsw-alias-label-tertiary)}
.dshcron-dir-chevron svg{width:17px;height:17px}
.dshcron-dir-state{min-height:210px;display:grid;place-content:center;justify-items:center;gap:10px;color:var(--dsw-alias-label-secondary);text-align:center}
.dshcron-dir-state p{margin:0;font-size:13px}
.dshcron-dir-spinner{width:24px;height:24px;border:3px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:dshcron-spin .8s linear infinite}
@keyframes dshcron-spin{to{transform:rotate(360deg)}}
.dshcron-dir-error{margin:8px 0 0;padding:10px 12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:1.5}
.dshcron-dir-footer{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 20px;border-top:1px solid var(--dsw-alias-border-l1)}
.dshcron-dir-hidden{display:inline-flex;align-items:center;gap:7px;padding:2px 0;border:0;color:var(--dsw-alias-label-secondary);background:transparent;font:inherit;font-size:12px;white-space:nowrap;cursor:pointer}
.dshcron-dir-hidden:disabled{cursor:not-allowed;opacity:.52}
.dshcron-dir-check{position:relative;width:15px;height:15px;flex:0 0 15px;border:1px solid var(--dsw-alias-border-l2);border-radius:4px;background:var(--dsw-alias-bg-layer-1)}
.dshcron-dir-hidden[aria-pressed="true"] .dshcron-dir-check{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary)}
.dshcron-dir-hidden[aria-pressed="true"] .dshcron-dir-check::after{content:"";position:absolute;left:4px;top:1px;width:4px;height:8px;border:solid var(--dsw-alias-bg-layer-1);border-width:0 2px 2px 0;transform:rotate(45deg)}
.dshcron-dir-actions{display:flex;gap:8px}
.dshcron-dir-actions button{min-height:36px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);font:inherit;font-size:13px;font-weight:560;white-space:nowrap;cursor:pointer}
.dshcron-dir-actions button:disabled{cursor:not-allowed;opacity:.52}
.dshcron-dir-actions .dshcron-dir-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-layer-1);background:var(--dsw-alias-brand-primary)}
`

    function useStyles() {
      React.useEffect(() => {
        const id = 'dsh-cron-style'
        if (document.getElementById(id)) return undefined
        const style = document.createElement('style')
        style.id = id
        style.textContent = CSS
        document.head.appendChild(style)
        return () => { style.remove() }
      }, [])
    }

    // ---------------------------------------------------------------- 插件配置

    /** 插件管理里的配置卡片：字段与 lib/index.js 的 Config 对应，写回宿主设置。 */
    // 只放用户能决定的事；调度精度这种实现参数不进表单，需要时改 yaml。
    const CONFIG_FIELDS = [
      { key: 'timeZone', label: '时区', kind: 'text', placeholder: 'Asia/Shanghai' },
      { key: 'timeLimitMs', label: '单次超时', kind: 'number', unit: '秒', scale: 1000 },
      { key: 'maxConcurrent', label: '并发上限', kind: 'number', unit: '个' },
      { key: 'historyDays', label: '历史保留', kind: 'number', unit: '天' },
      { key: 'historyRecords', label: '历史条数', kind: 'number', unit: '条' },
      { key: 'disableBuiltinSchedule', label: '停用内置的自动化任务', kind: 'switch' },
    ]

    /** 宿主设置里这条插件入口的表单，挂载时机由 apply 决定，可能比面板晚一点。 */
    let configScope = null

    function useConfigForm() {
      const [snapshot, setSnapshot] = React.useState(null)
      React.useEffect(() => {
        let off = null
        let timer = null
        let tries = 0
        const attach = () => {
          if (!configScope?.getSnapshot) {
            if (tries > 20) return
            tries += 1
            timer = setTimeout(attach, 150)
            return
          }
          const sync = () => setSnapshot(configScope.getSnapshot())
          sync()
          off = configScope.subscribe?.(sync)
        }
        attach()
        return () => {
          if (timer) clearTimeout(timer)
          if (typeof off === 'function') off()
        }
      }, [])
      return snapshot
    }

    function ConfigCard() {
      useStyles()
      const snapshot = useConfigForm()
      const [draft, setDraft] = React.useState({})
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState('')

      const value = snapshot?.value ?? {}
      const writable = snapshot?.writable === true

      // 内置自动化任务是别的插件，配置只是意图：打开这张卡时对一次账，别让开关和现实对不上。
      React.useEffect(() => {
        let alive = true
        const reconcile = async () => {
          const state = await fetch(`${API}/builtin`).then((response) => response.json()).catch(() => null)
          if (!alive || state?.ok !== true || !Array.isArray(state.entries)) return
          const want = state.configured !== true
          const aligned = state.entries.every((entry) => entry.enabled === null || entry.enabled === want)
          if (aligned) return
          await fetch(`${API}/builtin`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ disabled: state.configured === true }),
          }).catch(() => {})
        }
        reconcile()
        return () => { alive = false }
      }, [])
      const shown = (field) => {
        const raw = value[field.key]
        if (raw === undefined || raw === null || raw === '') return ''
        return field.scale ? String(Math.round(Number(raw) / field.scale)) : String(raw)
      }
      const read = (field) => (field.key in draft ? draft[field.key] : shown(field))
      // 开关是布尔值，不能和显示用的字符串比，否则永远显示成关。
      const readSwitch = (field) => (field.key in draft ? draft[field.key] === true : value[field.key] === true)
      const dirty = CONFIG_FIELDS.some((field) => field.key in draft && String(draft[field.key]) !== shown(field))

      const save = async () => {
        if (!configScope) return
        setBusy(true)
        setFailure('')
        try {
          const ops = []
          for (const field of CONFIG_FIELDS) {
            if (!(field.key in draft)) continue
            const raw = draft[field.key]
            const next = field.kind === 'switch'
              ? raw === true
              : field.kind === 'number' ? Number(raw) * (field.scale ?? 1) : raw
            if (field.kind === 'number' && !Number.isFinite(next)) throw new Error(`${field.label}要填数字`)
            ops.push({ op: 'set', path: [field.key], value: next })
          }
          if (ops.length > 0) {
            if (typeof configScope.mutate === 'function') {
              const accepted = await configScope.mutate(ops, snapshot?.revision)
              if (accepted === false) throw new Error('设置没有保存成功，请重试')
            } else {
              for (const op of ops) await configScope.set(op.path[0], op.value)
            }
            // 内置自动化任务是别的插件，得让宿主真的去开/关，不是记个值就完了。
            const builtinOp = ops.find((op) => op.path[0] === 'disableBuiltinSchedule')
            if (builtinOp !== undefined) {
              await fetch(`${API}/builtin`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ disabled: builtinOp.value === true }),
              }).catch(() => {})
            }
          }
          setDraft({})
        } catch (error) {
          setFailure(error?.message ?? String(error))
        } finally {
          setBusy(false)
        }
      }

      if (snapshot === null || snapshot.status === 'loading') {
        return h('div', { className: 'dshcron-config' }, h('p', { className: 'dshcron-config-empty' }, '正在读取配置…'))
      }
      if (snapshot.status === 'unavailable') {
        return h('div', { className: 'dshcron-config' }, h('p', { className: 'dshcron-config-empty' }, '这个部署没有暴露可改的配置'))
      }

      return h('div', { className: 'dshcron-config' },
        CONFIG_FIELDS.map((field) => h('div', { key: field.key, className: 'dshcron-config-field' },
          h('span', { className: 'dshcron-config-label' }, field.label),
          field.kind === 'switch'
            ? h('button', {
              type: 'button', role: 'switch',
              className: 'dshcron-config-switch',
              'aria-checked': readSwitch(field),
              disabled: !writable || busy,
              onClick: () => setDraft((current) => ({ ...current, [field.key]: !readSwitch(field) })),
            }, h('span', { className: 'dshcron-config-knob' }))
            : h('div', { className: 'dshcron-config-control' },
              h('input', {
                className: 'dshcron-config-input',
                value: read(field),
                inputMode: field.kind === 'number' ? 'numeric' : undefined,
                placeholder: field.placeholder,
                disabled: !writable || busy,
                onChange: (event) => setDraft((current) => ({ ...current, [field.key]: event.target.value })),
              }),
              field.unit ? h('span', { className: 'dshcron-config-unit' }, field.unit) : null))),
        failure ? h('div', { className: 'dshcron-config-error' }, failure) : null,
        h('div', { className: 'dshcron-config-actions' },
          h(Button, {
            variant: 'ghost', size: 'sm', disabled: !dirty || busy,
            onClick: () => setDraft({}),
          }, '放弃修改'),
          h(Button, {
            variant: 'primary', size: 'sm', disabled: !dirty || busy || !writable,
            onClick: save,
          }, busy ? '保存中…' : '保存')))
    }

    function Page() {
      useStyles()
      return h(CronPage)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        clientCtx = ctx
        ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: PANEL_ID, inject: () => ({}),
        }, Page)), 'dsh-cron: page')
        ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 12, label: () => '定时任务',
        }, CronIcon)), 'dsh-cron: sidebar')
        // 配置卡片只在宿主确实对外提供这条入口的设置时才注册。
        ctx.inject(['configForms'], (configCtx) => {
          const forms = configCtx.configForms
          configScope = forms.get(PANEL_ID)
          ctx.effect(() => forms.whileServed([PANEL_ID], () => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
            name: 'plugins.bundle.config', key: PANEL_ID, inject: () => ({}),
          }, ConfigCard))), 'dsh-cron: plugin config')
        })
      },
    }
  },
})
