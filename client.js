/**
 * Client half of `dsh-opencode-go-usage`.
 *
 * Renders the OpenCode Go allowance below the composer: the rolling 5-hour
 * window, the week, and the month, each as a used share of its own allowance.
 * Everything comes from the Host half's route, so this module never holds the
 * API key.
 */
window.__ModuleLoader__.load({
  id: 'dsh-opencode-go-usage',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** Host-owned route, same origin as the page. */
    const ENDPOINT = '/plugin/opencode-go-usage/quota'
    /** Poll period; a page also refreshes when it becomes visible again. */
    const REFRESH_MS = 60_000
    const NS = 'opencode-go-usage'

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
        refresh: 'Refresh now',
        updatedAt: 'updated {time}',
        windowTitle: '{label} · {share} of the monthly allowance · resets {reset} (in {in})',
        missingCredential: 'OPENCODE_GO_API_KEY is not configured',
        unreachable: 'The Harness quota route did not answer',
      },
      zh: {
        label: 'OpenCode Go 限额',
        rolling: '5小时',
        weekly: '周',
        monthly: '月',
        loading: '读取中…',
        refresh: '立即刷新',
        updatedAt: '更新于 {time}',
        windowTitle: '{label} · 占月度额度 {share} · {reset} 重置（还有 {in}）',
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

    /** Coarse remaining time; the exact instant stays in the tooltip. */
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

    function WindowCell({ window, label, share, title, t }) {
      const percent = typeof window?.percent === 'number' ? window.percent : null
      const width = percent === null ? 0 : Math.min(100, Math.max(0, percent))
      return h('span', {
        title,
        style: { display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' },
      }, [
        h('span', { key: 'label', style: { color: 'var(--dsw-alias-label-secondary)' } }, label),
        h('span', {
          key: 'track',
          'aria-hidden': true,
          style: {
            position: 'relative', display: 'inline-block', width: 46, height: 4,
            borderRadius: 2, overflow: 'hidden', background: 'var(--dsw-alias-border-l1)',
          },
        }, h('span', {
          style: {
            position: 'absolute', inset: 0, width: `${width}%`,
            borderRadius: 2, background: toneOf(window),
          },
        })),
        h('span', {
          key: 'value',
          style: {
            color: 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums',
          },
        }, formatPercent(percent)),
      ])
    }

    function QuotaStrip({ t }) {
      const [state, setState] = useState({ phase: 'loading' })

      const load = useCallback(async () => {
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
              message: body.code === 'missing-credential' ? t('missingCredential') : String(body.message ?? `HTTP ${response.status}`),
            })
            return
          }
          setState({ phase: 'ready', usage: body.usage ?? {}, fetchedAt: body.fetchedAt })
        } catch {
          setState({ phase: 'error', code: 'unreachable', message: t('unreachable') })
        }
      }, [t])

      useEffect(() => {
        load()
        const timer = setInterval(load, REFRESH_MS)
        const onVisibility = () => {
          if (document.visibilityState === 'visible') load()
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [load])

      const now = Date.now()
      const cells = WINDOWS.map(({ key, share }) => {
        const window = state.usage?.[key]
        const reset = localTime(window?.resetsAt)
        const left = countdown(window?.resetsAt, now)
        const title = reset === null
          ? `${t(key)} · ${share}`
          : fill(t('windowTitle'), { label: t(key), share, reset, in: left ?? '—' })
        return h(WindowCell, { key, window, label: t(key), share, title, t })
      })

      const trailing = state.phase === 'error'
        ? h('span', {
          key: 'status',
          style: { color: 'var(--dsw-alias-state-warn-primary)' },
        }, state.message)
        : state.phase === 'loading'
          ? h('span', { key: 'status' }, t('loading'))
          : h('span', { key: 'status' }, fill(t('updatedAt'), {
            time: localTime(state.fetchedAt) ?? '—',
          }))

      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12,
          fontSize: 11, lineHeight: '16px', padding: '2px 2px 0',
          color: 'var(--dsw-alias-label-secondary)',
        },
      }, [
        h('style', { key: 'style' },
          '.ocg-quota-btn{background:transparent;border:0;padding:0;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:4px}'
          + '.ocg-quota-btn:hover{color:var(--dsw-alias-label-primary)}'
          + '.ocg-quota-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}'),
        h('span', {
          key: 'brand',
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 5,
            color: 'var(--dsw-alias-label-primary)', fontWeight: 500,
          },
        }, [
          h('span', {
            key: 'dot',
            'aria-hidden': true,
            style: {
              width: 6, height: 6, borderRadius: 3,
              background: state.phase === 'ready' ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-state-idle-primary)',
            },
          }),
          t('label'),
        ]),
        ...cells,
        h('span', {
          key: 'trailing',
          style: { display: 'inline-flex', alignItems: 'center', gap: 8, marginLeft: 'auto' },
        }, [
          trailing,
          h('button', {
            key: 'refresh',
            type: 'button',
            className: 'ocg-quota-btn',
            title: t('refresh'),
            'aria-label': t('refresh'),
            onClick: load,
          }, '⟳'),
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
        }, (props) => h(QuotaStrip, { ...props, t })))
      },
    }
  },
})
