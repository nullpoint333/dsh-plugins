/**
 * The browser half of the `dsh-plugins` collection, shared by every plugin's UI.
 *
 * Two contributions:
 *
 * - `opencode-go-usage` — under the composer it renders one compact control, the
 *   rolling 5-hour window as a ring, and opening it shows a popup with the weekly
 *   and monthly windows, when the figures were read, and a refresh action.
 *   Everything comes from the Host half's route, so this module never holds the
 *   API key. Reading is paced, not polled: the figures live in one store owned
 *   by the plugin (not by the component), so switching conversations re-renders
 *   from the cache instead of re-reading; they are re-read only once they have
 *   aged out, and one timer serves every mount.
 * - `better-experience` — a Settings page that holds this collection's global
 *   preferences. The first such preference is a desktop notification when the
 *   model finishes a turn. The toggle's state is held in `localStorage`; the
 *   runtime lives in the same page so it can use the shell's `useSessionStatus`
 *   hook to subscribe to the active session. The page stays mounted while the
 *   settings panel is open.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugins',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Host-owned route, same origin as the page. */
    const ENDPOINT = '/plugin/opencode-go-usage/quota'
    const NS = 'opencode-go-usage'
    /** Used until the Host reports its own interval. */
    const DEFAULT_UI_REFRESH_MS = 5 * 60_000
    /** A nonsensical interval is ignored rather than obeyed. */
    const MIN_UI_REFRESH_MS = 30_000
    /** Popup geometry: a fixed width, lifted clear of the trigger. */
    const POPUP_WIDTH = 248
    const ANCHOR_GAP = 8
    const VIEWPORT_MARGIN = 8

    /**
     * OpenCode Go fixes each window against the model's monthly limit, so the
     * share is a property of the plan and not of the current usage.
     */
    const WINDOWS = [
      { key: 'rolling', share: '20%' },
      { key: 'weekly', share: '50%' },
      { key: 'monthly', share: '100%' },
    ]

    const DICT = {
      en: {
        label: 'OpenCode Go limits',
        rolling: '5h',
        weekly: 'Week',
        monthly: 'Month',
        loading: 'reading…',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        close: 'Close',
        updatedAt: 'read {time}',
        never: 'no reset time reported',
        ringTitle: '5-hour window · {share} of the monthly allowance · resets {reset} ({in} left)',
        resetsAt: 'resets {time} · {in} left',
        missingCredential: 'OPENCODE_GO_API_KEY is not configured',
        unreachable: 'The Harness quota route did not answer',
      },
      zh: {
        label: 'OpenCode Go 限额',
        rolling: '小时',
        weekly: '周',
        monthly: '月',
        loading: '读取中…',
        refresh: '刷新',
        refreshing: '刷新中…',
        close: '关闭',
        updatedAt: '读取于 {time}',
        never: '未报告重置时间',
        ringTitle: '5 小时窗口 · 占月度额度 {share} · {reset} 重置（还有 {in}）',
        resetsAt: '{time} 重置 · 还有 {in}',
        missingCredential: '未配置 OPENCODE_GO_API_KEY',
        unreachable: 'Harness 限额路由无响应',
      },
    }

    const BETTER_EXPERIENCE_NS = 'better-experience'

    /**
     * The collection's global preferences, in one table. Adding a preference
     * means adding an entry here plus its copy in the dictionary; the page
     * renders the rows from this list, so no view code changes.
     *
     * Keys are namespaced under `dsh-plugins.better-experience.*` so a future
     * plugin in this collection cannot collide with one of these.
     */
    const PREFERENCES = [
      {
        id: 'showQuota',
        storageKey: 'dsh-plugins.better-experience.show-quota',
        /** Showing the ring is the plugin's whole point, so it defaults on. */
        default: true,
        heading: 'displayHeading',
        label: 'showQuotaLabel',
        description: 'showQuotaDescription',
        statusOn: 'showQuotaStatusOn',
        statusOff: 'showQuotaStatusOff',
      },
      {
        id: 'notifyOnCompletion',
        storageKey: 'dsh-plugins.better-experience.notify-on-completion',
        /** Desktop notifications need an explicit grant, so this defaults off. */
        default: false,
        heading: 'notifyHeading',
        label: 'notifyLabel',
        description: 'notifyDescription',
        statusOn: 'notifyStatusOn',
        statusOff: 'notifyStatusOff',
      },
    ]

    const BETTER_EXPERIENCE_DICT = {
      en: {
        sectionTitle: 'Better experience',
        sectionDescription: 'Global preferences shared by every plugin in this collection.',
        displayHeading: 'Display',
        showQuotaLabel: 'Show the OpenCode Go quota',
        showQuotaDescription: 'Shows the rolling 5-hour window as a ring below the composer; opening it reveals the weekly and monthly windows. Turning this off also stops the quota requests, since nothing is left to display them.',
        showQuotaStatusOn: 'On — the ring is shown below the composer.',
        showQuotaStatusOff: 'Off — the ring is hidden and no quota requests are made.',
        notifyHeading: 'Notifications',
        notifyLabel: 'Notify when a task completes',
        notifyDescription: 'Send a desktop notification when the model finishes a turn. The browser must grant the notification permission; once granted, the runtime is active while this settings page is open.',
        notifyStatusOn: 'On — notifications fire when a task ends.',
        notifyStatusOff: 'Off — the runtime is inactive.',
        notifyStatusUnsupported: 'This browser does not expose the Notifications API; the toggle is visible but cannot fire.',
        notifyStatusBlocked: 'Notifications are blocked by the browser. Allow them in the page\u2019s site settings, then re-open this page.',
        testButton: 'Send a test notification',
        testSending: 'Sending…',
        testSent: 'Test notification sent. If you did not see it, check the OS notification center.',
        testUnavailable: 'Notifications are off or blocked in this browser.',
        notifTitle: 'Task complete',
        notifBody: 'The model finished a turn in DeepSeek Harness.',
      },
      zh: {
        sectionTitle: '更好的体验',
        sectionDescription: '本插件集合中所有插件共享的全局偏好。',
        displayHeading: '显示',
        showQuotaLabel: '显示 OpenCode Go 额度',
        showQuotaDescription: '在输入框下方以圆环显示 5 小时滚动窗口，点击可展开周、月额度。关闭后同时也停止额度请求——因为已经没有需要展示的地方。',
        showQuotaStatusOn: '已开启 — 输入框下方显示额度圆环。',
        showQuotaStatusOff: '已关闭 — 不显示额度圆环，也不会请求额度数据。',
        notifyHeading: '通知',
        notifyLabel: '任务完成时发送通知',
        notifyDescription: '在模型完成一轮时发送桌面通知。浏览器需要授予通知权限；授予后，只要设置页保持打开，运行时就会持续生效。',
        notifyStatusOn: '已开启 — 任务结束时发送通知。',
        notifyStatusOff: '已关闭 — 运行时不会发送通知。',
        notifyStatusUnsupported: '当前浏览器未提供通知接口；开关可见但无法触发。',
        notifyStatusBlocked: '通知已被浏览器屏蔽。请在站点的通知设置中放行后，重新打开本页面。',
        testButton: '发送测试通知',
        testSending: '发送中…',
        testSent: '已发送测试通知。如果未看到，请检查系统通知中心。',
        testUnavailable: '通知未开启或被浏览器屏蔽。',
        notifTitle: '任务完成',
        notifBody: 'DeepSeek Harness 中的模型已完成一轮。',
      },
    }

    /** Fill `{name}` placeholders without pulling in a formatting library. */
    function fill(template, values) {
      return template.replace(/\{(\w+)\}/g, (whole, name) =>
        Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : whole)
    }

    /** Percentages arrive as numbers; keep a fraction only when it exists. */
    function formatPercent(percent) {
      if (typeof percent !== 'number' || !Number.isFinite(percent)) return '—'
      return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`
    }

    /** Coarse remaining time; the exact instant stays alongside it. */
    function countdown(resetsAt, now) {
      const at = Date.parse(resetsAt ?? '')
      if (!Number.isFinite(at)) return null
      const minutes = Math.max(0, Math.round((at - now) / 60_000))
      if (minutes < 60) return `${minutes}m`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
      return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, '0')}h`
    }

    function localTime(value) {
      const at = Date.parse(value ?? '')
      if (!Number.isFinite(at)) return null
      return new Date(at).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    }

    /** A window turns warning near its ceiling and error once it is spent. */
    function toneOf(window) {
      const percent = typeof window?.percent === 'number' ? window.percent : null
      const status = String(window?.status ?? '').toLowerCase()
      if (status !== '' && status !== 'ok' && status !== 'active') return 'var(--dsw-alias-state-error-primary)'
      if (percent !== null && percent >= 100) return 'var(--dsw-alias-state-error-primary)'
      if (percent !== null && percent >= 80) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-brand-primary)'
    }

    function shareOf(percent) {
      return percent === null ? 0 : Math.min(100, Math.max(0, percent))
    }

    function resetLine(window, now, t) {
      const at = localTime(window?.resetsAt)
      if (at === null) return null
      const left = countdown(window?.resetsAt, now)
      return left === null ? at : fill(t('resetsAt'), { time: at, in: left })
    }

    /**
     * The plugin's one copy of the figures, created per activation and shared by
     * every mount of the control.
     * @param translate - the namespace translator, read at call time.
     */
    function createStore(translate) {
      let snapshot = { phase: 'idle' }
      /** When this browser last completed a read, for ageing out the cache. */
      let readAt = 0
      let refreshMs = DEFAULT_UI_REFRESH_MS
      let inFlight = null
      let timer = null
      const listeners = new Set()

      const publish = (next) => {
        snapshot = next
        for (const listener of [...listeners]) listener()
      }

      const isStale = () => Date.now() - readAt >= refreshMs

      const startTimer = () => {
        if (timer !== null) clearInterval(timer)
        timer = setInterval(() => { void read() }, refreshMs)
      }

      /**
       * Read the quota unless the cached figures are still fresh.
       * @param options - `force` ignores freshness, and is what the refresh
       *   action uses.
       */
      function read({ force = false } = {}) {
        if (inFlight !== null) return inFlight
        if (!force && !isStale()) return Promise.resolve()
        inFlight = (async () => {
          publish({ ...snapshot, phase: 'loading' })
          try {
            const response = await fetch(ENDPOINT, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            })
            const body = await response.json().catch(() => null)
            if (body === null) {
              publish({ ...snapshot, phase: 'error', message: `HTTP ${response.status}` })
              return
            }
            if (body.ok !== true) {
              publish({
                ...snapshot,
                phase: 'error',
                code: body.code,
                message: body.code === 'missing-credential'
                  ? translate('missingCredential')
                  : String(body.message ?? `HTTP ${response.status}`),
              })
              return
            }
            if (Number.isFinite(body.refreshMs) && body.refreshMs >= MIN_UI_REFRESH_MS) {
              refreshMs = body.refreshMs
              startTimer()
            }
            readAt = Date.now()
            publish({ phase: 'ready', usage: body.usage ?? {}, fetchedAt: body.fetchedAt })
          } catch {
            publish({ ...snapshot, phase: 'error', code: 'unreachable', message: translate('unreachable') })
          } finally {
            inFlight = null
          }
        })()
        return inFlight
      }

      /** Subscribe one mount; the timer exists only while a mount does. */
      const subscribe = (listener) => {
        listeners.add(listener)
        if (timer === null) startTimer()
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0 && timer !== null) {
            clearInterval(timer)
            timer = null
          }
        }
      }

      return { read, subscribe, snapshot: () => snapshot }
    }

    /** One ring: a track plus the used share, starting at twelve o'clock. */
    function Ring({ percent, tone, size = 18 }) {
      const stroke = 2.5
      const radius = (size - stroke) / 2
      const circumference = 2 * Math.PI * radius
      const drawn = (shareOf(percent) / 100) * circumference
      const centre = size / 2
      return h('svg', {
        width: size, height: size, viewBox: `0 0 ${size} ${size}`,
        'aria-hidden': true, style: { display: 'block', flex: 'none' },
      }, [
        h('circle', {
          key: 'track', cx: centre, cy: centre, r: radius, fill: 'none',
          stroke: 'var(--dsw-alias-border-l1)', strokeWidth: stroke,
        }),
        h('circle', {
          key: 'value', cx: centre, cy: centre, r: radius, fill: 'none',
          stroke: tone, strokeWidth: stroke, strokeLinecap: 'round',
          strokeDasharray: `${drawn} ${circumference - drawn}`,
          transform: `rotate(-90 ${centre} ${centre})`,
        }),
      ])
    }

    function WindowRow({ label, window, now, t }) {
      const percent = typeof window?.percent === 'number' ? window.percent : null
      const reset = resetLine(window, now, t)
      return h('div', { style: { display: 'grid', gap: 3 } }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: 8 },
        }, [
          h('span', { key: 'label', style: { color: 'var(--dsw-alias-label-secondary)' } }, label),
          h('span', {
            key: 'track',
            'aria-hidden': true,
            style: {
              position: 'relative', flex: 1, height: 4, borderRadius: 2,
              overflow: 'hidden', background: 'var(--dsw-alias-border-l1)',
            },
          }, h('span', {
            style: {
              position: 'absolute', inset: 0, width: `${shareOf(percent)}%`,
              borderRadius: 2, background: toneOf(window),
            },
          })),
          h('span', {
            key: 'value',
            style: {
              color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums',
              minWidth: 34, textAlign: 'right',
            },
          }, formatPercent(percent)),
        ]),
        h('div', {
          key: 'reset',
          style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' },
        }, reset ?? t('never')),
      ])
    }

    function QuotaControl({ t, store }) {
      const [open, setOpen] = useState(false)
      const [position, setPosition] = useState(null)
      const [, setRevision] = useState(0)
      const anchor = useRef(null)
      const popup = useRef(null)

      /* The store outlives this mount, so a conversation switch re-renders from
         the cached figures and re-reads them only once they have aged out. */
      useEffect(() => {
        const unsubscribe = store.subscribe(() => setRevision((value) => value + 1))
        void store.read()
        return unsubscribe
      }, [store])

      /* The popup is placed from the trigger's viewport rect, so an ancestor's
         overflow cannot clip it, and it follows the trigger while it moves. */
      useEffect(() => {
        if (!open) {
          setPosition(null)
          return undefined
        }
        const place = () => {
          const element = anchor.current
          if (element === null) return
          const rect = element.getBoundingClientRect()
          const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - POPUP_WIDTH - VIEWPORT_MARGIN)
          setPosition({
            left: Math.min(Math.max(VIEWPORT_MARGIN, rect.left), maxLeft),
            bottom: Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.top + ANCHOR_GAP),
          })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        const onPointerDown = (event) => {
          const target = event.target
          if (anchor.current?.contains(target) === true) return
          if (popup.current?.contains(target) === true) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const refresh = useCallback(() => {
        void store.read({ force: true })
      }, [store])

      const state = store.snapshot()
      const now = Date.now()
      const rolling = state.usage?.rolling
      const ringTitle = (() => {
        const reset = localTime(rolling?.resetsAt)
        const left = countdown(rolling?.resetsAt, now)
        if (reset === null) return t('rolling')
        return fill(t('ringTitle'), {
          share: WINDOWS[0].share, reset, in: left ?? '—',
        })
      })()

      const panel = open && position !== null ? h('div', {
        ref: popup,
        role: 'dialog',
        'aria-label': t('label'),
        className: 'ocg-popup',
        style: { left: position.left, bottom: position.bottom, width: POPUP_WIDTH },
      }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: 6 },
        }, [
          h('span', {
            key: 'title',
            style: { fontWeight: 500, color: 'var(--dsw-alias-label-primary)' },
          }, t('label')),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'ocg-btn',
            style: { marginLeft: 'auto' },
            title: t('close'),
            'aria-label': t('close'),
            onClick: () => setOpen(false),
          }, '×'),
        ]),

        state.phase === 'error'
          ? h('div', {
            key: 'body',
            style: { color: 'var(--dsw-alias-state-warn-primary)' },
          }, state.message)
          : h('div', { key: 'body', style: { display: 'grid', gap: 8 } }, [
            h(WindowRow, { key: 'weekly', label: t('weekly'), window: state.usage?.weekly, now, t }),
            h(WindowRow, { key: 'monthly', label: t('monthly'), window: state.usage?.monthly, now, t }),
          ]),

        h('div', {
          key: 'foot',
          style: {
            display: 'flex', alignItems: 'center', gap: 8,
            borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: 6,
          },
        }, [
          h('span', {
            key: 'read',
            style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' },
          }, state.phase === 'loading' || state.phase === 'idle'
            ? t('loading')
            : state.phase === 'error'
              ? t('never')
              : fill(t('updatedAt'), { time: localTime(state.fetchedAt) ?? '—' })),
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'ocg-btn',
            style: { marginLeft: 'auto' },
            disabled: state.phase === 'loading',
            onClick: refresh,
          }, state.phase === 'loading' ? t('refreshing') : t('refresh')),
        ]),
      ]) : null

      return h('div', { style: { display: 'inline-flex' } }, [
        h('style', { key: 'style' },
          '.ocg-trigger{display:inline-flex;align-items:center;gap:6px;background:transparent;border:0;margin:0;padding:2px 6px;font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:6px}'
          + '.ocg-trigger:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}'
          + '.ocg-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}'
          + '.ocg-btn{background:transparent;border:0;margin:0;padding:2px 6px;font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:4px}'
          + '.ocg-btn:hover:enabled{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}'
          + '.ocg-btn:disabled{opacity:.55;cursor:default}'
          + '.ocg-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}'
          /* One literal shadow: the theme publishes no elevation token, and a
             popover needs the separation. Everything else is a theme token. */
          + '.ocg-popup{position:fixed;z-index:60;box-sizing:border-box;display:grid;gap:8px;padding:10px;border-radius:10px;'
          + 'background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);'
          + 'box-shadow:0 6px 24px rgba(0,0,0,.18);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}'),

        h('button', {
          key: 'trigger',
          ref: anchor,
          type: 'button',
          className: 'ocg-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          title: ringTitle,
          onClick: () => setOpen((value) => !value),
        }, [
          h('span', { key: 'label' }, t('rolling')),
          h(Ring, { key: 'ring', percent: rolling?.percent ?? null, tone: toneOf(rolling) }),
          h('span', {
            key: 'value',
            style: {
              color: 'var(--dsw-alias-label-primary)',
              fontVariantNumeric: 'tabular-nums',
            },
          }, formatPercent(typeof rolling?.percent === 'number' ? rolling.percent : null)),
        ]),

        panel,
      ])
    }

    /* --- better-experience ------------------------------------------------- */

    /**
     * The collection's one preference store, created per activation and shared
     * by the settings page and by whoever acts on a preference.
     *
     * `localStorage` is the durable layer, but it cannot wake a mounted view:
     * `storage` events do not fire in the tab that wrote the value. So the
     * store keeps the live values in memory and publishes on every change,
     * which is what makes the settings toggle reach the composer ring without
     * a reload. Reads tolerate a missing or blocked store (private mode, a
     * partitioned origin): the defaults stand and the toggles stay honest.
     */
    function createPreferences() {
      const values = {}
      const listeners = new Set()

      const read = (preference) => {
        try {
          const stored = globalThis.localStorage?.getItem(preference.storageKey)
          if (stored === 'true') return true
          if (stored === 'false') return false
        } catch {
          /* Fall through to the default. */
        }
        return preference.default
      }

      for (const preference of PREFERENCES) values[preference.id] = read(preference)

      const publish = () => {
        for (const listener of [...listeners]) listener()
      }

      return {
        get: (id) => values[id] === true,
        set: (id, next) => {
          if (values[id] === next) return
          values[id] = next
          const preference = PREFERENCES.find((entry) => entry.id === id)
          if (preference !== undefined) {
            try {
              /* Absent means "default", so the default is stored by removal:
                 a later release can change a default without a migration. */
              if (next === preference.default) {
                globalThis.localStorage?.removeItem(preference.storageKey)
              } else {
                globalThis.localStorage?.setItem(preference.storageKey, String(next))
              }
            } catch {
              /* A blocked store is a non-fatal degradation; the in-memory
                 value still drives this session. */
            }
          }
          publish()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    /**
     * Subscribe one component to the preference store. Returns the value and
     * re-renders its component on any preference change; the store is the same
     * object for the whole activation, so a change made on the settings page
     * lands in the composer ring too.
     */
    function usePreference(preferences, id) {
      const [, setRevision] = useState(0)
      useEffect(
        () => preferences.subscribe(() => setRevision((value) => value + 1)),
        [preferences],
      )
      return preferences.get(id)
    }

    /**
     * Reduce the Notifications API to one of three states the page renders:
     * `unsupported` (no constructor at all), `denied` (permission refused or
     * blocked), `granted` (notifications are allowed), or `prompt` (no
     * decision yet — the next user gesture will request it).
     */
    function notificationCapability() {
      const Ctor = globalThis.Notification
      if (Ctor === undefined) return 'unsupported'
      if (Ctor.permission === 'granted') return 'granted'
      if (Ctor.permission === 'denied') return 'denied'
      return 'prompt'
    }

    /**
     * One preference row: label, description, the line that states the
     * current consequence, an optional extra block, and the switch.
     */
    function PreferenceRow({ t, label, description, status, checked, disabled, onChange, children }) {
      return h('div', { className: 'bex-row' }, [
        h('div', { key: 'body' }, [
          h('p', { key: 'label', className: 'bex-row__label' }, label),
          h('p', { key: 'desc', className: 'bex-row__description' }, description),
          h('p', { key: 'status', className: 'bex-row__status' }, status),
          children ?? null,
        ]),
        h('button', {
          key: 'toggle',
          type: 'button',
          role: 'switch',
          className: 'bex-toggle',
          'aria-checked': checked === true,
          'aria-label': label,
          disabled: disabled === true,
          onClick: onChange,
        }, h('span', { key: 'knob', className: 'bex-toggle__knob' })),
      ])
    }

    /**
     * The page itself: the collection's preference hub. Rows come from the
     * PREFERENCES table, so a new global option is a table entry plus its copy.
     *
     * Scope rule, learned the hard way: the renderer assembles a root entry's
     * props with `standardKit`, which spreads the ROOT standard binding — so
     * hooks such as `useSessions` and `useSessionStatus` really are present on
     * the props object here. A session-scoped hook has no source for a
     * root-scoped entry, and the loader reports that as a `SlotAssemblyError`.
     * The entry error boundary RETHROWS that class instead of containing it, so
     * a stray call renders the whole page blank with nothing in the UI to
     * explain why. A `settings.section` page is root-scoped: this component
     * therefore calls only React's own hooks, and reads no standard hook.
     *
     * Preference values come from the shared store, which is also what the
     * composer ring reads — so a toggle here takes effect immediately, without
     * a reload.
     */
    function BetterExperiencePage({ t, preferences }) {
      /* Both reads subscribe this component to the store, so either toggle
         re-renders the page — and, because the composer ring subscribes to the
         same store, it follows along without a reload. */
      const notifyEnabled = usePreference(preferences, 'notifyOnCompletion')
      const showQuota = usePreference(preferences, 'showQuota')
      const capability = useMemo(notificationCapability, [notifyEnabled])
      const [testState, setTestState] = useState('idle')
      const [errorMessage, setErrorMessage] = useState(null)

      const sendTest = useCallback(async () => {
        setErrorMessage(null)
        const Ctor = globalThis.Notification
        if (Ctor === undefined) {
          setTestState('blocked')
          return
        }
        let permission = Ctor.permission
        if (permission !== 'granted') {
          try {
            permission = await Ctor.requestPermission()
          } catch (error) {
            permission = 'denied'
            setErrorMessage(error instanceof Error ? error.message : String(error))
          }
        }
        if (permission !== 'granted') {
          setTestState('blocked')
          return
        }
        try {
          new Ctor(t('notifTitle'), {
            body: t('notifBody'),
            tag: 'dsh-plugins:test',
          })
          setTestState('sent')
          setTimeout(() => setTestState('idle'), 4000)
        } catch (error) {
          setTestState('blocked')
          setErrorMessage(error instanceof Error ? error.message : String(error))
        }
      }, [t])

      /* The status line under a toggle states the consequence, not the bit. */
      const notifyStatus = (() => {
        if (capability === 'unsupported') return t('notifyStatusUnsupported')
        if (capability === 'denied') return t('notifyStatusBlocked')
        return notifyEnabled ? t('notifyStatusOn') : t('notifyStatusOff')
      })()

      return h('div', { className: 'bex-page', style: { display: 'grid', gap: 20, padding: '16px 20px' } }, [
        h('style', { key: 'style' },
          '.bex-toggle{position:relative;display:inline-flex;align-items:center;width:36px;height:20px;flex:none;'
          + 'background:var(--dsw-alias-border-l2);border:0;border-radius:999px;cursor:pointer;padding:0;transition:background .12s ease}'
          + '.bex-toggle[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}'
          + '.bex-toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}'
          + '.bex-toggle:disabled{opacity:.55;cursor:default}'
          + '.bex-toggle__knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-overlay);transition:transform .12s ease}'
          + '.bex-toggle[aria-checked="true"] .bex-toggle__knob{transform:translateX(16px)}'
          + '.bex-row{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:start;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}'
          + '.bex-row__label{margin:0 0 4px;font-weight:500;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}'
          + '.bex-row__description{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}'
          + '.bex-row__status{margin:8px 0 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}'
          + '.bex-row__error{margin:8px 0 0;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:16px}'
          + '.bex-actions{margin:8px 0 0;display:flex;align-items:center;gap:8px}'
          + '.bex-btn{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;padding:4px 10px;border-radius:6px;cursor:pointer}'
          + '.bex-btn:hover:enabled{background:var(--dsw-alias-bg-layer-2)}'
          + '.bex-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}'
          + '.bex-btn:disabled{opacity:.55;cursor:default}'
          + '.bex-section{display:grid;gap:8px}'
          + '.bex-section__heading{margin:0;font-weight:500;color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px;text-transform:uppercase;letter-spacing:.04em}'
          + '.bex-page__intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}'
          + '.bex-feedback--ok{color:var(--dsw-alias-state-success-primary);font-size:11px}'
          + '.bex-feedback--warn{color:var(--dsw-alias-state-warn-primary);font-size:11px}'),

        h('p', { key: 'intro', className: 'bex-page__intro' }, t('sectionDescription')),

        /* Display: whether the collection's visible surfaces are on. */
        h('div', { key: 'display', className: 'bex-section' }, [
          h('h3', { key: 'heading', className: 'bex-section__heading' }, t('displayHeading')),
          h(PreferenceRow, {
            key: 'showQuota',
            t,
            label: t('showQuotaLabel'),
            description: t('showQuotaDescription'),
            status: showQuota ? t('showQuotaStatusOn') : t('showQuotaStatusOff'),
            checked: showQuota,
            disabled: false,
            onChange: () => preferences.set('showQuota', !showQuota),
          }),
        ]),

        /* Notifications: the runtime is the page's test action for now. */
        h('div', { key: 'notifications', className: 'bex-section' }, [
          h('h3', { key: 'heading', className: 'bex-section__heading' }, t('notifyHeading')),
          h(PreferenceRow, {
            key: 'notify',
            t,
            label: t('notifyLabel'),
            description: t('notifyDescription'),
            status: notifyStatus,
            checked: notifyEnabled,
            disabled: capability === 'unsupported',
            onChange: () => preferences.set('notifyOnCompletion', !notifyEnabled),
          }, [
            errorMessage === null ? null : h('p', {
              key: 'error',
              className: 'bex-row__error',
            }, errorMessage),
            capability === 'unsupported' ? null : h('div', { key: 'actions', className: 'bex-actions' }, [
              h('button', {
                key: 'test',
                type: 'button',
                className: 'bex-btn',
                disabled: testState === 'sending',
                onClick: sendTest,
              }, testState === 'sending' ? t('testSending') : t('testButton')),
              testState === 'sent' ? h('span', {
                key: 'testOk',
                className: 'bex-feedback--ok',
              }, t('testSent')) : null,
              testState === 'blocked' ? h('span', {
                key: 'testWarn',
                className: 'bex-feedback--warn',
              }, t('testUnavailable')) : null,
            ]),
          ]),
        ]),
      ])
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.get('locale')
        /* `bind` reads the active locale at call time, so one closure keeps
           working across a locale switch; the raw key is the last resort for a
           language this namespace has no dictionary for. */
        const translate = locale === undefined ? undefined : locale.bind(NS)
        const t = (key) => {
          const localized = translate?.(key)
          return localized === undefined || localized === key ? DICT.en[key] ?? key : localized
        }

        const beTranslate = locale === undefined ? undefined : locale.bind(BETTER_EXPERIENCE_NS)
        const bet = (key) => {
          const localized = beTranslate?.(key)
          return localized === undefined || localized === key
            ? BETTER_EXPERIENCE_DICT.en[key] ?? key
            : localized
        }

        if (locale !== undefined) {
          for (const [language, dict] of Object.entries(DICT)) {
            ctx.effect(() => locale.register(NS, language, dict))
          }
          for (const [language, dict] of Object.entries(BETTER_EXPERIENCE_DICT)) {
            ctx.effect(() => locale.register(BETTER_EXPERIENCE_NS, language, dict))
          }
        }

        /* One store for the whole activation: the control unmounts on every
           conversation switch, and the figures must not follow it down. */
        const store = createStore(t)

        /* The preferences are shared by the dock (which reads `showQuota`) and
           the settings page (which writes it), so both are the same object. */
        const preferences = createPreferences()

        /**
         * The dock entry. Hiding the ring is a real off switch, not just a
         * hidden element: with nothing mounted the shared store has no
         * subscribers, so its timer stops and no quota requests are made.
         */
        function QuotaDockEntry({ t: translate, store: quotaStore, preferences: prefs }) {
          const visible = usePreference(prefs, 'showQuota')
          if (!visible) return null
          return h(QuotaControl, { t: translate, store: quotaStore })
        }

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'opencode-go-usage',
          order: 2,
          label: () => t('label'),
        }, (props) => h(QuotaDockEntry, { ...props, t, store, preferences })))

        /* The page is one component. Its values live in the shared preference
           store, so a toggle here reaches the composer ring immediately. The
           owner passes the section's `close` and the standard seat; this
           component reads neither, because a root-scoped page must not call a
           session-scoped standard hook (see the note on the component). A
           defensive wrapper keeps any future render error visible inline
           instead of letting the slot entry blank the page. */
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'better-experience',
          order: 12,
          label: () => bet('sectionTitle'),
        }, () => {
          try {
            return h(BetterExperiencePage, { t: bet, preferences })
          } catch (error) {
            const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
            /* Surface the error to the developer console (where it can be
               inspected) and to the page itself, so an empty page is
               impossible even if the host or this bundle ever regresses. */
            if (typeof console !== 'undefined') console.error('[dsh-plugins better-experience]', error)
            return h('div', { className: 'bex-page', style: { padding: '16px 20px' } }, [
              h('style', { key: 'style' },
                '.bex-page__error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:pre-wrap}'
              ),
              h('pre', { key: 'message', className: 'bex-page__error' }, message),
            ])
          }
        }))
      },
    }
  },
})
