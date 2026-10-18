/**
 * Host half of `dsh-opencode-go-usage`.
 *
 * OpenCode Go defines its allowance as a monthly dollar amount per model, with
 * a rolling 5-hour window at 20% of it, a weekly window at 50%, and the month
 * itself at 100%. `GET https://opencode.ai/zen/go/v1/usage` reports the used
 * share of each window, and it needs the bearer key.
 *
 * The key must not reach the browser, so this half owns the upstream call and
 * republishes only the three percentages and their reset instants over one
 * loopback HTTP route. That route is registered as an `exact` route, so the
 * server matches it before the Web shell's fallback handler.
 *
 * @module dsh-opencode-go-usage
 */

/** The one route the Client half fetches. */
const ROUTE_PATH = '/plugin/opencode-go-usage/quota'

/** Window names reported by the upstream envelope, in display order. */
const WINDOW_NAMES = ['rolling', 'weekly', 'monthly']

const DEFAULTS = {
  endpoint: 'https://opencode.ai/zen/go/v1/usage',
  credentialRef: 'OPENCODE_GO_API_KEY',
  cacheMs: 5000,
  requestTimeoutMs: 15000,
  userAgent: 'deepseek-harness-opencode-go-usage/1.0',
}

/** Cordis waits for the HTTP carrier: without it this bundle has nowhere to serve. */
export const inject = ['webServer']

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
   * Read the API key per request rather than caching it: resolution is what
   * makes a rotated credential reach the next call without a restart.
   * @returns the bearer key, or undefined while unconfigured.
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

    let response
    try {
      response = await fetch(options.endpoint, {
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
      const upstream = parsed?.error?.message ?? parsed?.error?.type
      const message = typeof upstream === 'string' ? upstream : `HTTP ${response.status}`
      /* An expired or revoked key is worth reporting as itself, not as a
         generic upstream failure: the upstream message says how to fix it. */
      const code = response.status === 429
        ? 'rate-limited'
        : response.status === 401 || response.status === 403
          ? 'unauthorized'
          : 'upstream-error'
      return { status: response.status === 429 ? 429 : 502, body: { ok: false, code, message } }
    }

    const usage = {}
    for (const name of WINDOW_NAMES) {
      const window = parsed?.usage?.[name]
      if (window === null || typeof window !== 'object') continue
      const percent = Number(window.percent)
      usage[name] = {
        status: typeof window.status === 'string' ? window.status : 'unknown',
        percent: Number.isFinite(percent) ? percent : null,
        resetsAt: typeof window.resetsAt === 'string' ? window.resetsAt : null,
      }
    }

    const result = {
      status: 200,
      body: {
        ok: true,
        fetchedAt: new Date().toISOString(),
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
