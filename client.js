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
     * One quota widget's identity. Both Host halves answer with the same
     * normalized shape — `usage[windowKey] = { status, percent, resetsAt }`,
     * where `percent` is the share USED — so the Client half needs no
     * per-provider branch. `windows[0]` drives the ring; the rest fill the popup.
     *
     * `share` is optional and only meaningful where the plan itself defines the
     * shorter window as a share of a longer one, as OpenCode Go does.
     * `preference` names the Better experience toggle that governs this widget.
     */
    const QUOTA_WIDGETS = [
      {
        id: 'opencode-go-usage',
        ns: 'opencode-go-usage',
        endpoint: '/plugin/opencode-go-usage/quota',
        /* The provider ids this widget answers for, as the session's model
           selection reports them (`llm-pi-ai` provider keys). */
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
        windows: [
          { key: 'interval' },
          { key: 'weekly' },
        ],
      },
    ]

    /** The preference value that means "follow the session's model". */
    const QUOTA_SOURCE_AUTO = 'auto'
    const QUOTA_SOURCE_BOTH = 'both'
    const QUOTA_SOURCE_OFF = 'off'

    /** Per-widget copy. A window's label is read from its own key. */
    const DICTS = {
      'opencode-go-usage': {
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
          unlimited: 'not metered',
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
          unlimited: '不计量',
          ringTitle: '5 小时窗口 · 占月度额度 {share} · {reset} 重置（还有 {in}）',
          resetsAt: '{time} 重置 · 还有 {in}',
          missingCredential: '未配置 OPENCODE_GO_API_KEY',
          unreachable: 'Harness 限额路由无响应',
        },
      },
      'minimax-quota': {
        en: {
          label: 'MiniMax plan usage',
          interval: '5h',
          weekly: 'Week',
          loading: 'reading…',
          refresh: 'Refresh',
          refreshing: 'Refreshing…',
          close: 'Close',
          updatedAt: 'read {time}',
          never: 'no reset time reported',
          unlimited: 'not metered',
          /* MiniMax meters what is LEFT, so the popup states both readings. */
          ringTitle: '5-hour window · {used} used · {remaining} left · resets {reset} ({in} left)',
          resetsAt: 'resets {time} · {in} left · {remaining} left',
          boost: 'weekly allowance boosted {factor}×',
          missingCredential: 'MINIMAX_CN_API_KEY is not configured',
          notSubscriptionKey: 'MINIMAX_CN_API_KEY is a pay-as-you-go key; the M Plan quota needs the subscription key',
          unreachable: 'The Harness quota route did not answer',
        },
        zh: {
          label: 'MiniMax 套餐额度',
          interval: '5 小时',
          weekly: '周',
          loading: '读取中…',
          refresh: '刷新',
          refreshing: '刷新中…',
          close: '关闭',
          updatedAt: '读取于 {time}',
          never: '未报告重置时间',
          unlimited: '不计量',
          ringTitle: '5 小时窗口 · 已用 {used} · 剩余 {remaining} · {reset} 重置（还有 {in}）',
          resetsAt: '{time} 重置 · 还有 {in} · 剩余 {remaining}',
          boost: '周额度提升 {factor}×',
          missingCredential: '未配置 MINIMAX_CN_API_KEY',
          notSubscriptionKey: 'MINIMAX_CN_API_KEY 是按量计费密钥；M Plan 额度需要订阅密钥',
          unreachable: 'Harness 限额路由无响应',
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
        id: 'quotaSource',
        storageKey: 'dsh-plugins.better-experience.quota-source',
        kind: 'choice',
        /* Following the model is the point of the unified widget, so it is the
           default; every other value is an explicit override. */
        default: QUOTA_SOURCE_AUTO,
        options: [
          { value: QUOTA_SOURCE_AUTO, labelKey: 'quotaSourceAuto' },
          { value: 'opencode-go-usage', labelKey: 'quotaSourceOpencode' },
          { value: 'minimax-quota', labelKey: 'quotaSourceMinimax' },
          { value: QUOTA_SOURCE_BOTH, labelKey: 'quotaSourceBoth' },
          { value: QUOTA_SOURCE_OFF, labelKey: 'quotaSourceOff' },
        ],
        heading: 'displayHeading',
        label: 'quotaSourceLabel',
        description: 'quotaSourceDescription',
        status: 'quotaSourceStatus',
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
        quotaSourceLabel: 'Quota shown below the composer',
        quotaSourceDescription: 'One ring, following whichever provider the session\u2019s model uses: OpenCode Go or the MiniMax M Plan. Pin it to one provider, show both rings, or turn it off. A hidden widget is not mounted, so its requests stop too.',
        quotaSourceAuto: 'Follow the current model',
        quotaSourceOpencode: 'Always OpenCode Go',
        quotaSourceMinimax: 'Always MiniMax',
        quotaSourceBoth: 'Show both',
        quotaSourceOff: 'Do not show',
        quotaSourceStatus: 'Now: {value}.',
        quotaSourceStatusAuto: 'Now: following the current model.',
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
        quotaSourceLabel: '输入框下方显示的额度',
        quotaSourceDescription: '只保留一个圆环，自动跟随当前会话所用模型的服务商：OpenCode Go 或 MiniMax M Plan。也可以固定到其中一个、两个都显示，或直接关闭。隐藏的组件不会被挂载，因此它的额度请求也会停止。',
        quotaSourceAuto: '跟随当前模型',
        quotaSourceOpencode: '固定 OpenCode Go',
        quotaSourceMinimax: '固定 MiniMax',
        quotaSourceBoth: '两个都显示',
        quotaSourceOff: '不显示',
        quotaSourceStatus: '当前：{value}。',
        quotaSourceStatusAuto: '当前：跟随当前模型。',
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

    function resetLine(window, now, t) {
      const at = localTime(window?.resetsAt)
      if (at === null) return null
      const left = countdown(window?.resetsAt, now)
      if (left === null) return at
      const remaining = remainingOf(window)
      return fill(t('resetsAt'), {
        time: at,
        in: left,
        /* Both readings travel together: providers differ on which one they
           meter, and one of them is always the surprising number. */
        remaining: remaining === null ? '—' : formatPercent(remaining),
        used: formatPercent(typeof window?.percent === 'number' ? window.percent : null),
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

    function WindowRow({ label, window, now, t }) {
      const unlimited = isUnlimited(window)
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
              position: 'absolute', inset: 0, width: `${unlimited ? 0 : shareOf(percent)}%`,
              borderRadius: 2, background: toneOf(window),
            },
          })),
          h('span', {
            key: 'value',
            style: {
              color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums',
              minWidth: 34, textAlign: 'right',
            },
          }, unlimited ? t('unlimited') : formatPercent(percent)),
        ]),
        h('div', {
          key: 'reset',
          style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' },
        }, unlimited ? t('never') : (reset ?? t('never'))),
      ])
    }

    /**
     * One plugin's compact quota control.
     * @param widgets - `windows[0]` drives the ring; the rest fill the popup.
     *   The list is identical in shape for every provider, so adding one is a
     *   Host half plus a QUOTA_WIDGETS entry.
     */
    function QuotaControl({ t, store, windows, widgetId, boostLabel }) {
      const [open, setOpen] = useState(false)
      const [position, setPosition] = useState(null)
      const [, setRevision] = useState(0)
      const anchor = useRef(null)
      const popup = useRef(null)
      const primary = windows[0]
      const rest = windows.slice(1)

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
      const primaryWindow = state.usage?.[primary.key]
      const ringTitle = (() => {
        const reset = localTime(primaryWindow?.resetsAt)
        const left = countdown(primaryWindow?.resetsAt, now)
        if (reset === null) return t(primary.key)
        const remaining = remainingOf(primaryWindow)
        return fill(t('ringTitle'), {
          share: primary.share ?? '—',
          reset,
          in: left ?? '—',
          used: formatPercent(typeof primaryWindow?.percent === 'number' ? primaryWindow.percent : null),
          remaining: remaining === null ? '—' : formatPercent(remaining),
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
          : h('div', { key: 'body', style: { display: 'grid', gap: 8 } }, rest.map((window) =>
            h(WindowRow, {
              key: window.key,
              label: t(window.key),
              window: state.usage?.[window.key],
              now,
              t,
            }))),

        /* A plan that grants a boosted weekly allowance says so, because it
           otherwise reads as a quota that failed to shrink. */
        boostLabel === undefined || state.boostPermille === null || state.boostPermille === 1000
          ? null
          : h('div', {
            key: 'boost',
            style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)' },
          }, boostLabel((state.boostPermille / 1000).toFixed(2).replace(/\.?0+$/, ''))),

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
          /* A stable hook for testing and for inspecting the dock: both widgets
             render the same markup, and their window labels can coincide. */
          'data-quota-widget': widgetId,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          title: ringTitle,
          onClick: () => setOpen((value) => !value),
        }, [
          h('span', { key: 'label' }, t(primary.key)),
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
            ? t('unlimited')
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

        /* One store per widget for the whole activation: a control unmounts on
           every conversation switch, and the figures must not follow it down.
           A widget nobody is displaying simply has no subscribers, so its timer
           stops and it makes no requests. */
        const bound = QUOTA_WIDGETS.map((widget) => {
          const t = translatorFor(widget.ns)
          return {
            widget,
            t,
            store: createStore({ endpoint: widget.endpoint, translate: t }),
            boostLabel: widget.ns === 'minimax-quota'
              ? (factor) => fill(t('boost'), { factor })
              : undefined,
          }
        })

        /**
         * Which widgets to show. `auto` follows the session's own model, so the
         * one ring is always the quota the user is actually spending.
         *
         * `useProjection('modelSelection')` is a session-scoped standard hook,
         * and this entry is session-scoped, so the scope matches. Its store
         * always defines a face per key — an unknown or not-yet-populated key is
         * an `undefined` snapshot, never a throw — so an unexpected provider
         * leaves the dock empty instead of breaking the composer.
         */
        function resolveWidgets(source, selection) {
          if (source === QUOTA_SOURCE_OFF) return []
          if (source === QUOTA_SOURCE_BOTH) return bound
          if (source !== QUOTA_SOURCE_AUTO) {
            return bound.filter((entry) => entry.widget.id === source)
          }
          const provider = selection?.current?.provider
          if (typeof provider !== 'string') return []
          return bound.filter((entry) => entry.widget.providers.includes(provider))
        }

        function QuotaDockEntry(props) {
          const source = usePreference(preferences, 'quotaSource')
          /* Reading the projection here is what makes the widget follow the
             model: a model switch re-renders this entry with a new provider. */
          const selection = props.useProjection?.('modelSelection')
          const shown = resolveWidgets(source, selection)
          if (shown.length === 0) return null
          return h('div', { style: { display: 'inline-flex', alignItems: 'center' } },
            shown.map((entry) => h(QuotaControl, {
              ...props,
              key: entry.widget.id,
              t: entry.t,
              store: entry.store,
              widgetId: entry.widget.id,
              windows: entry.widget.windows,
              boostLabel: entry.boostLabel,
            })))
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
