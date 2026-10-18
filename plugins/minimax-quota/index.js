/**
 * Host half of `dsh-plugins/minimax-quota`.
 *
 * MiniMax's M Plan is a subscription with two independently refreshing windows,
 * exactly like OpenCode Go's plan model: a 5-hour window for the non-video
 * models and a 7-day window for everything. The subscription shares one
 * allowance across every tool that uses the key. Usage is visible in the
 * console, and the official CLI (`mmx quota`) reads it from:
 *
 *   GET {base}/v1/token_plan/remains      Authorization: Bearer <subscription key>
 *
 * which answers `{ model_remains: [...], base_resp: { status_code, status_msg } }`.
 * The subscription key must not reach the browser, so this half owns the call
 * and republishes only the projected shares and reset instants over one loopback
 * route.
 *
 * A subscription key is recognised by the `sk-` prefix; the CLI sends an
 * `sk-api-` key to `/account/query_balance` instead. This plugin only handles
 * the subscription case and says so explicitly rather than reporting an empty
 * allowance.
 *
 * @module dsh-plugins/minimax-quota
 */

/** The one route the Client half fetches. */
const ROUTE_PATH = '/plugin/minimax-quota/quota'

const DEFAULTS = {
  /* The Chinese cluster; the CLI's own `cn` base. The international base is
     `https://api.minimax.io`, which the same route also accepts. */
  endpoint: 'https://api.minimax.cn',
  credentialRef: 'MINIMAX_CN_API_KEY',
  /* The entry that carries the text/image/audio allowance. A plan can also
     report `video`, which is a separate window and absent from the lower tiers. */
  modelName: 'general',
  cacheMs: 5000,
  requestTimeoutMs: 15000,
  uiRefreshMs: 300_000,
  userAgent: 'deepseek-harness-minimax-quota/1.0',
}

/** Cordis waits for the HTTP carrier: without it this bundle has nowhere to serve. */
export const inject = ['webServer']

const clampPercent = (value) => Math.min(100, Math.max(0, value))

/** Epoch milliseconds to an ISO instant, or null when the field is absent. */
const toIso = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}

/**
 * Resolve one window's remaining share from MiniMax's three fields.
 *
 * The count field is named `*_usage_count` but the official CLI treats it as the
 * REMAINING count by default, and flips to `total - count` only when
 * `*_remaining_percent` disproves the first reading by a smaller margin. That
 * asymmetry is deliberate there, so it is mirrored here; when the two readings
 * disagree with the reported percentage by more than one point, the reported
 * percentage wins rather than a guess.
 *
 * @returns the remaining share in 0..100, or null when nothing usable is present.
 */
function resolveRemaining(usageCount, totalCount, remainingPercent) {
  const hasPercent = typeof remainingPercent === 'number' && Number.isFinite(remainingPercent)
  const usableCounts = typeof totalCount === 'number' && Number.isFinite(totalCount) && totalCount > 0
    && typeof usageCount === 'number' && Number.isFinite(usageCount)
    && usageCount >= 0 && usageCount <= totalCount

  if (!usableCounts) return hasPercent ? clampPercent(remainingPercent) : null

  let remaining = usageCount
  if (hasPercent) {
    const asUsage = (usageCount / totalCount) * 100
    const asRemaining = ((totalCount - usageCount) / totalCount) * 100
    const usageGap = Math.abs(asUsage - remainingPercent)
    const remainingGap = Math.abs(asRemaining - remainingPercent)
    if (Math.min(usageGap, remainingGap) > 1) return clampPercent(remainingPercent)
    if (remainingGap < usageGap) remaining = totalCount - usageCount
  }
  return clampPercent((remaining / totalCount) * 100)
}

/**
 * A model that the plan does not cover at all: no counts on either window and
 * both statuses at the sentinel. The CLI's own test, kept identical.
 */
function notInPlan(entry) {
  return entry.current_interval_total_count === 0
    && entry.current_weekly_total_count === 0
    && entry.current_interval_status === 3
    && entry.current_weekly_status === 3
}

/**
 * Project one `model_remains` entry into the normalized two-window shape the
 * Client half renders. `percent` is the USED share, so both quota widgets in
 * this collection read the same way.
 */
function projectEntry(entry) {
  const windows = {}

  const intervalRemaining = resolveRemaining(
    entry.current_interval_usage_count,
    entry.current_interval_total_count,
    entry.current_interval_remaining_percent,
  )
  if (intervalRemaining !== null) {
    windows.interval = {
      status: 'ok',
      percent: clampPercent(100 - intervalRemaining),
      remainingPercent: intervalRemaining,
      /* The 5-hour window's own reset. */
      resetsAt: toIso(entry.end_time),
      startsAt: toIso(entry.start_time),
    }
  }

  const weeklyRemaining = resolveRemaining(
    entry.current_weekly_usage_count,
    entry.current_weekly_total_count,
    entry.current_weekly_remaining_percent,
  )
  if (weeklyRemaining !== null) {
    /* A status of 3 on the weekly window means the plan does not meter it. */
    const unlimited = entry.current_weekly_status === 3
    windows.weekly = {
      status: unlimited ? 'unlimited' : 'ok',
      percent: unlimited ? 0 : clampPercent(100 - weeklyRemaining),
      remainingPercent: weeklyRemaining,
      resetsAt: toIso(entry.weekly_end_time),
      startsAt: toIso(entry.weekly_start_time),
    }
  }

  return windows
}

/**
 * Register the quota route. The registration is an effect, so unloading or
 * reconfiguring the plugin withdraws the route without a restart.
 * @param ctx - the Cordis context, with `ctx.webServer` injected.
 * @param config - the plugin's optional `config` row.
 */
export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config ?? {}) }
  /** Last upstream answer, so several open pages poll upstream once. */
  let cache

  /**
   * Read the key per request rather than caching it: resolution is what makes a
   * rotated credential reach the next call without a restart.
   * @returns the subscription key, or undefined while unconfigured.
   */
  const readApiKey = async () => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      try {
        const resolved = await credentials.resolve(options.credentialRef)
        if (typeof resolved?.value === 'string' && resolved.value.length > 0) return resolved.value
      } catch (error) {
        ctx.logger?.warn(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const ambient = process.env[options.credentialRef]
    return typeof ambient === 'string' && ambient.length > 0 ? ambient : undefined
  }

  /**
   * Call the upstream quota endpoint and project its envelope.
   * @returns an HTTP status and the body to answer with.
   */
  const readUsage = async () => {
    if (cache !== undefined && Date.now() - cache.at < options.cacheMs) return cache.result

    const apiKey = await readApiKey()
    if (apiKey === undefined) {
      const result = {
        status: 503,
        body: {
          ok: false,
          code: 'missing-credential',
          message: `${options.credentialRef} is not configured`,
        },
      }
      cache = { at: Date.now(), result }
      return result
    }

    /* An `sk-api-` key is a pay-as-you-go account key, and the plan endpoint
       knows nothing about it. Say which key is wrong instead of answering with
       an empty allowance the user would read as "used up". */
    if (apiKey.startsWith('sk-api-')) {
      const result = {
        status: 409,
        body: {
          ok: false,
          code: 'not-a-subscription-key',
          message: `${options.credentialRef} is a pay-as-you-go key; the M Plan quota needs the subscription key`,
        },
      }
      cache = { at: Date.now(), result }
      return result
    }

    const url = `${options.endpoint.replace(/\/+$/, '')}/v1/token_plan/remains`
    let response
    try {
      response = await fetch(url, {
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${apiKey}`,
          'user-agent': options.userAgent,
        },
        signal: AbortSignal.timeout(options.requestTimeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return {
        status: 502,
        body: { ok: false, code: 'unreachable', message: `quota request failed: ${reason}` },
      }
    }

    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = undefined
    }

    if (!response.ok) {
      const upstream = parsed?.base_resp?.status_msg ?? parsed?.error?.message
      const message = typeof upstream === 'string' ? upstream : `HTTP ${response.status}`
      const code = response.status === 429
        ? 'rate-limited'
        : response.status === 401 || response.status === 403
          ? 'unauthorized'
          : 'upstream-error'
      return { status: response.status === 429 ? 429 : 502, body: { ok: false, code, message } }
    }

    /* The envelope reports its own failures with HTTP 200. */
    const statusCode = parsed?.base_resp?.status_code
    if (typeof statusCode === 'number' && statusCode !== 0) {
      const message = typeof parsed?.base_resp?.status_msg === 'string'
        ? parsed.base_resp.status_msg
        : `MiniMax status ${statusCode}`
      const code = statusCode === 1004 || statusCode === 2049 ? 'unauthorized' : 'upstream-error'
      return { status: 502, body: { ok: false, code, message } }
    }

    const entries = Array.isArray(parsed?.model_remains)
      ? parsed.model_remains.filter((entry) => entry !== null && typeof entry === 'object')
      : []

    /* Prefer the named entry, then any entry the plan actually meters. The
       video window is a separate allowance and is absent from the lower tiers. */
    const named = entries.find((entry) => entry.model_name === options.modelName)
    const metered = entries.filter((entry) => !notInPlan(entry))
    const entry = named !== undefined && !notInPlan(named) ? named : metered[0]

    if (entry === undefined) {
      const result = {
        status: 200,
        body: {
          ok: false,
          code: 'no-window',
          message: entries.length === 0
            ? 'MiniMax reported no plan windows for this account'
            : 'MiniMax reported windows, but none carries a usable share',
        },
      }
      cache = { at: Date.now(), result }
      return result
    }

    const usage = projectEntry(entry)
    if (Object.keys(usage).length === 0) {
      const result = {
        status: 200,
        body: {
          ok: false,
          code: 'no-window',
          message: 'MiniMax reported a plan window without a usable share',
        },
      }
      cache = { at: Date.now(), result }
      return result
    }

    const result = {
      status: 200,
      body: {
        ok: true,
        fetchedAt: new Date().toISOString(),
        /* How often the browser half may re-read on its own. The M Plan windows
           are metered upstream and a reader switching conversations must not
           turn into a stream of requests. */
        refreshMs: options.uiRefreshMs,
        /* Which upstream entry these figures came from, so a plan that reports
           several windows is never silently mixed together. */
        model: typeof entry.model_name === 'string' ? entry.model_name : null,
        /* A weekly boost multiplier, when the plan grants one. */
        boostPermille: typeof entry.weekly_boost_permille === 'number'
          ? entry.weekly_boost_permille
          : null,
        usage,
      },
    }
    cache = { at: Date.now(), result }
    return result
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      const { status, body } = await readUsage()
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store',
      })
      res.end(payload)
    },
  }))
}
