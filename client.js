/**
 * The browser half of the `dsh-plugins` collection, shared by every plugin's UI.
 *
 * Under the composer it renders one compact control — the rolling 5-hour window
 * as a ring — and opening it shows a popup with the weekly and monthly windows,
 * when the figures were read, and a refresh action. Everything comes from the
 * Host half's route, so this module never holds the API key.
 *
 * Nothing here polls. The figures load once on mount and change only when the
 * reader asks for a refresh, which is what makes the displayed read time worth
 * showing.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugins',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Host-owned route, same origin as the page. */
    const ENDPOINT = '/plugin/opencode-go-usage/quota'
    const NS = 'opencode-go-usage'
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

    function QuotaControl({ t }) {
      const [state, setState] = useState({ phase: 'loading' })
      const [open, setOpen] = useState(false)
      const [position, setPosition] = useState(null)
      const anchor = useRef(null)
      const popup = useRef(null)

      const load = useCallback(async () => {
        setState((current) => ({ phase: 'loading', usage: current.usage, fetchedAt: current.fetchedAt }))
        try {
          const response = await fetch(ENDPOINT, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          const body = await response.json().catch(() => null)
          if (body === null) {
            setState({ phase: 'error', message: `HTTP ${response.status}` })
            return
          }
          if (body.ok !== true) {
            setState({
              phase: 'error',
              code: body.code,
              message: body.code === 'missing-credential'
                ? t('missingCredential')
                : String(body.message ?? `HTTP ${response.status}`),
            })
            return
          }
          setState({ phase: 'ready', usage: body.usage ?? {}, fetchedAt: body.fetchedAt })
        } catch {
          setState({ phase: 'error', code: 'unreachable', message: t('unreachable') })
        }
      }, [t])

      /* Read once. There is no polling and no refresh on visibility: the reader
         decides when the figures are re-read, and the popup reports when. */
      useEffect(() => {
        load()
      }, [load])

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
          }, state.phase === 'loading'
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
            onClick: load,
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

        if (locale !== undefined) {
          for (const [language, dict] of Object.entries(DICT)) {
            ctx.effect(() => locale.register(NS, language, dict))
          }
        }

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'opencode-go-usage',
          order: 2,
          label: () => t('label'),
        }, (props) => h(QuotaControl, { ...props, t })))
      },
    }
  },
})
