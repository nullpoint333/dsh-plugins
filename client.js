/**
 * The browser half of the `dsh-plugins` collection, shared by every plugin's UI.
 *
 * Three contributions:
 *
 * - `opencode-go-usage` and `minimax-quota` — each renders one compact control
 *   under the composer: the shortest window as a ring, with the remaining
 *   windows, the read time and a refresh action in a popup. They share one
 *   implementation, differing only in the route they read and the windows they
 *   label, because each Host half normalizes its provider's envelope into the
 *   same two-field window (`percent` = share USED, `resetsAt`). Everything comes
 *   from the Host half's route, so this module never holds an API key.
 *
 *   Reading is paced, not polled: the figures live in one store owned by the
 *   plugin (not by the component), so switching conversations re-renders from the
 *   cache instead of re-reading; they are re-read only once they have aged out,
 *   and one timer serves every mount. A widget the user has switched off is not
 *   mounted at all, so its store has no subscribers and its timer stops.
 * - `better-experience` — a Settings page holding this collection's global
 *   preferences: whether each quota widget is shown, and whether a desktop
 *   notification fires when a task ends. Values live in one shared store, so a
 *   toggle takes effect immediately, with no reload.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugins',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Used until the Host reports its own interval. */
    const DEFAULT_UI_REFRESH_MS = 5 * 60_000
    /** A nonsensical interval is ignored rather than obeyed. */
    const MIN_UI_REFRESH_MS = 30_000
    /** Popup geometry: a fixed width, lifted clear of the trigger. */
    const POPUP_WIDTH = 248
    const ANCHOR_GAP = 8
    const VIEWPORT_MARGIN = 8

    /**
     * One quota source the widget knows how to display. Both Host halves answer
     * with the same normalized shape — `usage[windowKey] = { status, percent,
     * resetsAt }`, where `percent` is the share USED — so the Client half needs
     * no per-provider branch in its rendering.
     *
     * `providers` are the ids the session's model selection reports for this
     * source (`llm-pi-ai` provider keys). `name` is this source's own label in
     * the popup, read from its dictionary. `share` is optional and only
     * meaningful where the plan defines the shorter window as a share of a
     * longer one, as OpenCode Go does.
     */
    const QUOTA_WIDGETS = [
      {
        id: 'opencode-go-usage',
        ns: 'opencode-go-usage',
        endpoint: '/plugin/opencode-go-usage/quota',
        providers: ['opencode-go'],
        windows: [
          { key: 'rolling', share: '20%' },
          { key: 'weekly', share: '50%' },
          { key: 'monthly', share: '100%' },
        ],
      },
      {
        id: 'minimax-quota',
        ns: 'minimax-quota',
        endpoint: '/plugin/minimax-quota/quota',
        providers: ['minimax-cn', 'minimax'],
        /* This plan can grant a boosted weekly allowance, which the popup says. */
        boost: true,
        windows: [
          { key: 'interval' },
          { key: 'weekly' },
        ],
      },
    ]

    /**
     * Per-source copy: only what is genuinely specific to one plan — its name,
     * its window labels, its ring tooltip, and the messages about its own
     * credential. Every piece of shared chrome (loading, refresh, close, read
     * time, the reset line, the "not metered" state) lives in the collection's
     * `better-experience` dictionary instead, so it is written once and reads
     * the same in both sections of the popup.
     */
    const DICTS = {
      'opencode-go-usage': {
        en: {
          label: 'OpenCode Go',
          rolling: '5h',
          weekly: 'Week',
          monthly: 'Month',
          ringTitle: '5-hour window · {share} of the monthly allowance · resets {reset} ({in} left)',
          missingCredential: 'OPENCODE_GO_API_KEY is not configured',
        },
        zh: {
          label: 'OpenCode Go',
          rolling: '小时',
          weekly: '周',
          monthly: '月',
          ringTitle: '5 小时窗口 · 占月度额度 {share} · {reset} 重置（还有 {in}）',
          missingCredential: '未配置 OPENCODE_GO_API_KEY',
        },
      },
      'minimax-quota': {
        en: {
          label: 'MiniMax M Plan',
          interval: '5h',
          weekly: 'Week',
          /* MiniMax meters what is LEFT, so its ring tooltip says both. */
          ringTitle: '5-hour window · {used} used · {remaining} left · resets {reset} ({in} left)',
          boost: 'weekly allowance boosted {factor}×',
          missingCredential: 'MINIMAX_CN_API_KEY is not configured',
          notSubscriptionKey: 'MINIMAX_CN_API_KEY is a pay-as-you-go key; the M Plan quota needs the subscription key',
        },
        zh: {
          label: 'MiniMax 套餐',
          interval: '5 小时',
          weekly: '周',
          ringTitle: '5 小时窗口 · 已用 {used} · 剩余 {remaining} · {reset} 重置（还有 {in}）',
          boost: '周额度提升 {factor}×',
          missingCredential: '未配置 MINIMAX_CN_API_KEY',
          notSubscriptionKey: 'MINIMAX_CN_API_KEY 是按量计费密钥；M Plan 额度需要订阅密钥',
        },
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
        kind: 'boolean',
        /** Showing the quota is the plugin's whole point, so it defaults on. */
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
        kind: 'boolean',
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
        dockLabel: 'Usage limits',
        displayHeading: 'Display',
        showQuotaLabel: 'Show the usage limits',
        showQuotaDescription: 'A ring below the composer follows whichever plan the session\u2019s model is spending — OpenCode Go or the MiniMax M Plan — and its popup lists both plans, so you can see at a glance whether the other one has room left. The plan you are not using is only read while that popup is open. Turning this off unmounts the widget, so no requests are made at all.',
        showQuotaStatusOn: 'On — the ring follows the current model.',
        showQuotaStatusOff: 'Off — the widget is hidden and no quota requests are made.',
        /* Shared chrome for the quota popup: written once, used by both plans. */
        loading: 'reading…',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        close: 'Close',
        updatedAt: 'read {time}',
        never: 'no reset time reported',
        unlimited: 'not metered',
        resetsAt: 'resets {time} · {in} left · {remaining} left',
        currentPlan: 'in use',
        noPlanForModel: 'No plan quota for this model',
        notCoveredHint: 'This model is not on a plan this widget can read; open for details.',
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
        dockLabel: '额度',
        displayHeading: '显示',
        showQuotaLabel: '显示额度',
        showQuotaDescription: '输入框下方的圆环跟随当前会话所用套餐（OpenCode Go 或 MiniMax M Plan）；弹出窗口里会同时列出两个套餐，方便一眼看出另一个是否还有余量。没在用的那个套餐只在你打开弹窗时才读取。关闭后组件会被卸载，不会发起任何请求。',
        showQuotaStatusOn: '已开启 — 圆环跟随当前模型。',
        showQuotaStatusOff: '已关闭 — 不显示组件，也不会请求额度数据。',
        /* 额度弹窗共用的文案：写一次，两个套餐共用。 */
        loading: '读取中…',
        refresh: '刷新',
        refreshing: '刷新中…',
        close: '关闭',
        updatedAt: '读取于 {time}',
        never: '未报告重置时间',
        unlimited: '不计量',
        resetsAt: '{time} 重置 · 还有 {in} · 剩余 {remaining}',
        currentPlan: '使用中',
        noPlanForModel: '当前模型没有可读的套餐额度',
        notCoveredHint: '当前模型不在本组件可读的套餐中；打开可查看两个套餐。',
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

    /**
     * A window the plan does not meter: nothing is consumed and no reset is
     * meaningful. Both Host halves use the status `unlimited` for that.
     */
    const isUnlimited = (window) => String(window?.status ?? '').toLowerCase() === 'unlimited'

    /** A window turns warning near its ceiling and error once it is spent. */
    function toneOf(window) {
      const percent = typeof window?.percent === 'number' ? window.percent : null
      const status = String(window?.status ?? '').toLowerCase()
      if (isUnlimited(window)) return 'var(--dsw-alias-label-secondary)'
      if (status !== '' && status !== 'ok' && status !== 'active') return 'var(--dsw-alias-state-error-primary)'
      if (percent !== null && percent >= 100) return 'var(--dsw-alias-state-error-primary)'
      if (percent !== null && percent >= 80) return 'var(--dsw-alias-state-warn-primary)'
      return 'var(--dsw-alias-brand-primary)'
    }

    function shareOf(percent) {
      return percent === null ? 0 : Math.min(100, Math.max(0, percent))
    }

    /** How much of a window is LEFT, when the Host reported a used share. */
    function remainingOf(window) {
      const percent = typeof window?.percent === 'number' ? window.percent : null
      if (percent === null) return null
      return Math.min(100, Math.max(0, 100 - percent))
    }

    /**
     * The reset line for one window, in the collection's shared wording: when it
     * resets, how long is left, and how much of it remains. Both readings travel
     * together because plans differ on which one they meter, and the number a
     * given provider reports is always the surprising one.
     */
    function resetLine(window, now, chrome) {
      const at = localTime(window?.resetsAt)
      if (at === null) return null
      const left = countdown(window?.resetsAt, now)
      if (left === null) return at
      const remaining = remainingOf(window)
      return fill(chrome('resetsAt'), {
        time: at,
        in: left,
        remaining: remaining === null ? '—' : formatPercent(remaining),
      })
    }

    /**
     * One plugin's figures, created per activation and shared by every mount of
     * its control.
     * @param options - `endpoint` is the Host route to read, and `translate`
     *   resolves the copy. The store itself is provider-agnostic.
     */
    function createStore({ endpoint, translate }) {
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
            const response = await fetch(endpoint, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
            })
            const body = await response.json().catch(() => null)
            if (body === null) {
              publish({ ...snapshot, phase: 'error', message: `HTTP ${response.status}` })
              return
            }
            if (body.ok !== true) {
              /* Keys the Host already localized; anything else is its own
                 message, which is more specific than a generic fallback. */
              const localized = body.code === 'missing-credential'
                ? translate('missingCredential')
                : body.code === 'not-a-subscription-key'
                  ? translate('notSubscriptionKey')
                  : undefined
              publish({
                ...snapshot,
                phase: 'error',
                code: body.code,
                message: localized ?? String(body.message ?? `HTTP ${response.status}`),
              })
              return
            }
            if (Number.isFinite(body.refreshMs) && body.refreshMs >= MIN_UI_REFRESH_MS) {
              refreshMs = body.refreshMs
              startTimer()
            }
            readAt = Date.now()
            publish({
              phase: 'ready',
              usage: body.usage ?? {},
              fetchedAt: body.fetchedAt,
              /* Only the MiniMax half reports these; both are optional. */
              boostPermille: Number.isFinite(body.boostPermille) ? body.boostPermille : null,
            })
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

    function WindowRow({ label, window, now, chrome, t }) {
      const unlimited = isUnlimited(window)
      const percent = typeof window?.percent === 'number' ? window.percent : null
      const reset = resetLine(window, now, chrome)
      return h('div', { style: { display: 'grid', gap: 3 } }, [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: 8 },
        }, [
          h('span', {
            key: 'label',
            style: { color: 'var(--dsw-alias-label-secondary)', minWidth: 34 },
          }, label),
          h('span', {
            key: 'track',
            'aria-hidden': true,
            style: {
              position: 'relative', flex: 1, height: 4, borderRadius: 2,
              overflow: 'hidden', background: 'var(--dsw-alias-border-l1)',
            },
          }, h('span', {
            style: {
              position: 'absolute', inset: 0, width: `${unlimited ? 0 : shareOf(percent)}%`,
              borderRadius: 2, background: toneOf(window),
            },
          })),
          h('span', {
            key: 'value',
            style: {
              color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums',
              minWidth: 40, textAlign: 'right',
            },
          }, unlimited ? chrome('unlimited') : formatPercent(percent)),
        ]),
        h('div', {
          key: 'reset',
          style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' },
        }, unlimited ? chrome('never') : (reset ?? chrome('never'))),
      ])
    }

    /**
     * One entry's share of the popup: its name (marked when it is the plan the
     * session is spending), its windows, and its own read state.
     *
     * Each source reports its own freshness, because the section the user is not
     * using is read on demand rather than on a timer — so the two timestamps can
     * legitimately differ, and one shared "read at" line would have to lie about
     * one of them.
     */
    function QuotaSection({ entry, now, chrome }) {
      const { widget, t, store, boostLabel } = entry
      const state = store.snapshot()
      const [primary, ...rest] = widget.windows
      const primaryWindow = state.usage?.[primary.key]

      const status = (() => {
        if (state.phase === 'loading' || state.phase === 'idle') return chrome('loading')
        if (state.phase === 'error') return state.message
        return fill(chrome('updatedAt'), { time: localTime(state.fetchedAt) ?? '—' })
      })()

      return h('section', { className: 'ocg-section', 'data-quota-section': widget.id }, [
        h('div', { key: 'head', className: 'ocg-section__head' }, [
          h('span', { key: 'name', className: 'ocg-section__name' }, t('label')),
          entry.active
            ? h('span', { key: 'chip', className: 'ocg-chip' }, chrome('currentPlan'))
            : null,
        ]),

        state.phase === 'error'
          ? h('div', {
            key: 'body',
            className: 'ocg-section__error',
          }, state.message)
          : h('div', { key: 'body', className: 'ocg-section__body' }, [
            /* The popup's job is comparing plans, so every window is listed —
               including the one the ring already shows, which is what makes
               the two sections readable side by side. */
            h(WindowRow, {
              key: primary.key,
              label: t(primary.key),
              window: primaryWindow,
              now,
              chrome,
              t,
            }),
            ...rest.map((window) => h(WindowRow, {
              key: window.key,
              label: t(window.key),
              window: state.usage?.[window.key],
              now,
              chrome,
              t,
            })),
            /* A plan that grants a boosted allowance says so, because it
               otherwise reads as a quota that failed to shrink. */
            boostLabel === undefined || state.boostPermille === null || state.boostPermille === 1000
              ? null
              : h('div', { key: 'boost', className: 'ocg-section__note' },
                boostLabel((state.boostPermille / 1000).toFixed(2).replace(/\.?0+$/, ''))),
          ]),

        state.phase === 'error'
          ? null
          : h('div', { key: 'status', className: 'ocg-section__status' }, status),
      ])
    }

    /**
     * The collection's one quota control.
     *
     * The trigger shows the plan the session is currently spending, so the
     * figure in the dock is always the one being consumed. The popup shows
     * **every** plan this collection knows how to read, which is the point: with
     * one plan exhausted, the question is whether the other still has room.
     *
     * @param entries - one bound source per plan, in display order.
     * @param activeId - the entry the session's model points at, if any.
     * @param chrome - the collection's shared chrome translator.
     */
    function QuotaControl({ entries, activeId, chrome }) {
      const [open, setOpen] = useState(false)
      const [position, setPosition] = useState(null)
      const [, setRevision] = useState(0)
      const anchor = useRef(null)
      const popup = useRef(null)

      const active = entries.find((entry) => entry.widget.id === activeId)
      const primary = active?.widget.windows[0]
      const activeState = active?.store.snapshot()
      const primaryWindow = activeState?.usage?.[primary?.key]
      const now = Date.now()

      const bump = useCallback(() => setRevision((value) => value + 1), [])

      /* The active store is subscribed for as long as the widget is mounted, so
         its timer runs and the ring stays current. */
      useEffect(() => {
        if (active === undefined) return undefined
        const unsubscribe = active.store.subscribe(bump)
        void active.store.read()
        return unsubscribe
      }, [active, bump])

      /* The other plans are subscribed — and read — only while the popup is
         open. Closing it drops their subscriptions, which stops their timers, so
         a plan the user is not spending is never polled in the background. */
      useEffect(() => {
        if (!open) return undefined
        const others = entries.filter((entry) => entry.widget.id !== activeId)
        const unsubscribes = others.map((entry) => entry.store.subscribe(bump))
        for (const entry of others) void entry.store.read()
        return () => { for (const unsubscribe of unsubscribes) unsubscribe() }
      }, [open, entries, activeId, bump])

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
        for (const entry of entries) void entry.store.read({ force: true })
      }, [entries])

      const ringTitle = (() => {
        if (active === undefined || primary === undefined) return chrome('noPlanForModel')
        const reset = localTime(primaryWindow?.resetsAt)
        const left = countdown(primaryWindow?.resetsAt, now)
        if (reset === null) return active.t(primary.key)
        const remaining = remainingOf(primaryWindow)
        return fill(active.t('ringTitle'), {
          share: primary.share ?? '—',
          reset,
          in: left ?? '—',
          used: formatPercent(typeof primaryWindow?.percent === 'number' ? primaryWindow.percent : null),
          remaining: remaining === null ? '—' : formatPercent(remaining),
        })
      })()

      const panel = open && position !== null ? h('div', {
        key: 'panel',
        ref: popup,
        role: 'dialog',
        'aria-label': chrome('dockLabel'),
        className: 'ocg-popup',
        style: { left: position.left, bottom: position.bottom, width: POPUP_WIDTH },
      }, [
        h('div', { key: 'head', className: 'ocg-popup__head' }, [
          h('span', { key: 'title', className: 'ocg-popup__title' }, chrome('dockLabel')),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'ocg-btn',
            style: { marginLeft: 'auto' },
            title: chrome('close'),
            'aria-label': chrome('close'),
            onClick: () => setOpen(false),
          }, '×'),
        ]),

        ...entries.map((entry) => h(QuotaSection, {
          key: entry.widget.id,
          entry: { ...entry, active: entry.widget.id === activeId },
          now,
          chrome,
        })),

        h('div', { key: 'foot', className: 'ocg-popup__foot' }, [
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'ocg-btn',
            style: { marginLeft: 'auto' },
            disabled: entries.every((entry) => entry.store.snapshot().phase === 'loading'),
            onClick: refresh,
          }, chrome('refresh')),
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
          + '.ocg-popup{position:fixed;z-index:60;box-sizing:border-box;display:grid;gap:10px;padding:10px;border-radius:10px;'
          + 'background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);'
          + 'box-shadow:0 6px 24px rgba(0,0,0,.18);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}'
          + '.ocg-popup__head{display:flex;align-items:center;gap:6px}'
          + '.ocg-popup__title{font-weight:500;color:var(--dsw-alias-label-primary)}'
          + '.ocg-popup__foot{display:flex;align-items:center;gap:8px;border-top:1px solid var(--dsw-alias-border-l1);padding-top:6px}'
          + '.ocg-section{display:grid;gap:6px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}'
          + '.ocg-section:first-of-type{border-top:0;padding-top:0}'
          + '.ocg-section__head{display:flex;align-items:center;gap:6px}'
          + '.ocg-section__name{font-weight:500;color:var(--dsw-alias-label-primary)}'
          + '.ocg-chip{margin-left:auto;padding:0 5px;border-radius:999px;font-size:10px;line-height:15px;'
          + 'color:var(--dsw-alias-brand-primary);border:1px solid var(--dsw-alias-brand-primary)}'
          + '.ocg-section__body{display:grid;gap:8px}'
          + '.ocg-section__status{font-size:10px;color:var(--dsw-alias-label-secondary)}'
          + '.ocg-section__note{font-size:10px;color:var(--dsw-alias-label-secondary)}'
          + '.ocg-section__error{color:var(--dsw-alias-state-warn-primary)}'),

        h('button', {
          key: 'trigger',
          ref: anchor,
          type: 'button',
          className: 'ocg-trigger',
          /* A stable hook for testing and for inspecting the dock. */
          'data-quota-widget': active === undefined ? 'none' : active.widget.id,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          title: ringTitle,
          onClick: () => setOpen((value) => !value),
        }, active === undefined || primary === undefined
          /* No plan to report for this model: still offer the popup, because
             the answer to "is the other one usable?" is in there. */
          ? [
            h('span', { key: 'label' }, chrome('dockLabel')),
            h('span', {
              key: 'value',
              style: { color: 'var(--dsw-alias-label-secondary)' },
            }, '—'),
          ]
          : [
            h('span', { key: 'label' }, active.t(primary.key)),
            h(Ring, {
              key: 'ring',
              percent: isUnlimited(primaryWindow) ? 0 : (primaryWindow?.percent ?? null),
              tone: toneOf(primaryWindow),
            }),
            h('span', {
              key: 'value',
              style: {
                color: 'var(--dsw-alias-label-primary)',
                fontVariantNumeric: 'tabular-nums',
              },
            }, isUnlimited(primaryWindow)
              ? chrome('unlimited')
              : formatPercent(typeof primaryWindow?.percent === 'number' ? primaryWindow.percent : null)),
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

      /**
       * Read one preference from `localStorage`, trusting it only if it is a
       * value the preference actually accepts. A stale or hand-edited key falls
       * back to the default rather than putting the UI into an unknown state.
       */
      const read = (preference) => {
        try {
          const stored = globalThis.localStorage?.getItem(preference.storageKey)
          if (stored !== null && stored !== undefined) {
            if (preference.kind === 'boolean') {
              if (stored === 'true') return true
              if (stored === 'false') return false
            } else if (preference.options.some((option) => option.value === stored)) {
              return stored
            }
          }
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
        get: (id) => values[id],
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
     * One preference row: label, description, the line that states the current
     * consequence, and one control on the right — either the switch or, with
     * `control`, whatever the caller supplies.
     */
    function PreferenceRow({ t, label, description, status, checked, disabled, onChange, control, children }) {
      return h('div', { className: 'bex-row' }, [
        h('div', { key: 'body' }, [
          h('p', { key: 'label', className: 'bex-row__label' }, label),
          h('p', { key: 'desc', className: 'bex-row__description' }, description),
          h('p', { key: 'status', className: 'bex-row__status' }, status),
          children ?? null,
        ]),
        control ?? h('button', {
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
     * The choice control. A native `select` on purpose: it is keyboard- and
     * screen-reader-correct for free, and the theme supplies its surface through
     * the same tokens as everything else.
     */
    function PreferenceChoice({ label, value, options, onChange }) {
      return h('select', {
        className: 'bex-select',
        'aria-label': label,
        value,
        onChange: (event) => onChange(event.target.value),
      }, options.map((option) =>
        h('option', { key: option.value, value: option.value }, option.label)))
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
      /* One subscription covers every row on this page: the store publishes on
         any change, and this hook's listener re-renders unconditionally. The
         display rows then read their own values through `preferences.get`,
         which is also why adding a preference needs no hook of its own. */
      const notifyEnabled = usePreference(preferences, 'notifyOnCompletion')
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
          + '.bex-select{box-sizing:border-box;max-width:220px;min-width:0;padding:4px 8px;border-radius:6px;font:inherit;font-size:12px;line-height:18px;'
          + 'color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);cursor:pointer}'
          + '.bex-select:hover{background:var(--dsw-alias-bg-overlay)}'
          + '.bex-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}'
          + '.bex-section__heading{margin:0;font-weight:500;color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px;text-transform:uppercase;letter-spacing:.04em}'
          + '.bex-page__intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}'
          + '.bex-feedback--ok{color:var(--dsw-alias-state-success-primary);font-size:11px}'
          + '.bex-feedback--warn{color:var(--dsw-alias-state-warn-primary);font-size:11px}'),

        h('p', { key: 'intro', className: 'bex-page__intro' }, t('sectionDescription')),

        /* Display: which quota the widget below the composer shows. Both kinds
           of control render from the PREFERENCES table. */
        h('div', { key: 'display', className: 'bex-section' }, [
          h('h3', { key: 'heading', className: 'bex-section__heading' }, t('displayHeading')),
          ...PREFERENCES
            .filter((preference) => preference.heading === 'displayHeading')
            .map((preference) => {
              const current = preferences.get(preference.id)
              const label = t(preference.label)
              if (preference.kind === 'choice') {
                const chosen = preference.options.find((option) => option.value === current)
                return h(PreferenceRow, {
                  key: preference.id,
                  t,
                  label,
                  description: t(preference.description),
                  status: fill(t(preference.status), { value: t(chosen?.labelKey ?? '') }),
                  control: h(PreferenceChoice, {
                    key: 'control',
                    label,
                    value: current,
                    options: preference.options.map((option) => ({
                      value: option.value,
                      label: t(option.labelKey),
                    })),
                    onChange: (next) => preferences.set(preference.id, next),
                  }),
                })
              }
              return h(PreferenceRow, {
                key: preference.id,
                t,
                label,
                description: t(preference.description),
                status: current === true ? t(preference.statusOn) : t(preference.statusOff),
                checked: current === true,
                disabled: false,
                onChange: () => preferences.set(preference.id, current !== true),
              })
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

        /**
         * Build one widget's translator. `bind` reads the active locale at call
         * time, so a single closure keeps working across a locale switch; the
         * English dictionary is the last resort for a language this collection
         * has no dictionary for.
         */
        const translatorFor = (ns) => {
          const bound = locale === undefined ? undefined : locale.bind(ns)
          const fallback = DICTS[ns]?.en ?? {}
          return (key) => {
            const localized = bound?.(key)
            return localized === undefined || localized === key ? fallback[key] ?? key : localized
          }
        }

        const beTranslate = locale === undefined ? undefined : locale.bind(BETTER_EXPERIENCE_NS)
        const bet = (key) => {
          const localized = beTranslate?.(key)
          return localized === undefined || localized === key
            ? BETTER_EXPERIENCE_DICT.en[key] ?? key
            : localized
        }

        if (locale !== undefined) {
          for (const [ns, dict] of Object.entries(DICTS)) {
            for (const [language, copy] of Object.entries(dict)) {
              ctx.effect(() => locale.register(ns, language, copy))
            }
          }
          for (const [language, dict] of Object.entries(BETTER_EXPERIENCE_DICT)) {
            ctx.effect(() => locale.register(BETTER_EXPERIENCE_NS, language, dict))
          }
        }

        /* The preferences are shared by the dock entries (which read them) and
           the settings page (which writes them), so both are the same object. */
        const preferences = createPreferences()

        /* One store per plan for the whole activation: the control unmounts on
           every conversation switch, and the figures must not follow it down. A
           plan nobody is displaying has no subscribers, so its timer stops and
           it makes no requests. */
        const bound = QUOTA_WIDGETS.map((widget) => {
          const t = translatorFor(widget.ns)
          return {
            widget,
            t,
            store: createStore({ endpoint: widget.endpoint, translate: t }),
            boostLabel: widget.boost === true
              ? (factor) => fill(t('boost'), { factor })
              : undefined,
          }
        })

        /**
         * The provider the session's model selection names.
         *
         * The `modelSelection` projection is `{ lastUsed, next }`, each a
         * `{ provider, model, reasoningEffort? }` or null: `next` is what the
         * following request should use and `lastUsed` is what the last one did.
         * Prefer `next`, since that is the user's current choice, and fall back
         * to `lastUsed` for a session whose next selection has not been written
         * yet. (The composer's model picker merges this projection with its own
         * catalog store under a `current` key; that is its internal shape, not
         * the projection's, and reading it here would find nothing.)
         */
        function selectedProvider(selection) {
          const chosen = selection?.next ?? selection?.lastUsed
          return typeof chosen?.provider === 'string' ? chosen.provider : undefined
        }

        /**
         * The plan the session's model is spending, if this collection reads one
         * for that provider. Absence is normal — the official DeepSeek account
         * has no plan here — and the widget then shows a neutral trigger rather
         * than disappearing, because the popup still answers the useful question.
         *
         * `useProjection('modelSelection')` is a session-scoped standard hook and
         * this entry is session-scoped, so the scope matches. Its store defines a
         * face for every key, so an unknown or not-yet-populated projection is an
         * `undefined` snapshot rather than a throw.
         */
        function activeIdFor(selection) {
          const provider = selectedProvider(selection)
          if (provider === undefined) return undefined
          const match = bound.find((entry) => entry.widget.providers.includes(provider))
          return match?.widget.id
        }

        function QuotaDockEntry(props) {
          const show = usePreference(preferences, 'showQuota')
          /* Reading the projection here is what makes the ring follow the model:
             a model switch re-renders this entry with a new provider. */
          const selection = props.useProjection?.('modelSelection')
          if (show !== true) return null
          return h(QuotaControl, {
            entries: bound,
            activeId: activeIdFor(selection),
            chrome: bet,
          })
        }

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'quota',
          order: 2,
          /* One entry now covers both providers, so its label cannot be either
             provider's; it names what the entry is. */
          label: () => bet('dockLabel'),
        }, QuotaDockEntry))

        /* The page is one component. Its values live in the shared preference
           store, so a toggle here reaches the composer rings immediately. The
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
