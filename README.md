# dsh-plugins

A collection of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugins, delivered as **one bundle**.

| Plugin | What it does |
| --- | --- |
| [`opencode-go-usage`](plugins/opencode-go-usage) | Shows the OpenCode Go subscription's 5-hour, weekly and monthly quota below the composer |

## Install

Needs a DSH whose profile carries the Web carrier (`dsh-web-app`). Install the
bundle from the sidebar's **Plugins** page, or with the `plugin_manager` tool:

```jsonc
{ "action": "install_bundle", "target": "github:nullpoint333/dsh-plugins" }
```

One install brings in every plugin in this repository, and each row can then be
enabled or disabled on its own. The manager verifies a GitHub repository with
`git ls-remote` before installing, using the profile directory's own Git and proxy
configuration, so an SSH remote or an internally mirrored URL works the same way.

There are no dependencies, no install scripts and no build step: the JavaScript
files are the whole implementation.

## Plugins

### `opencode-go-usage`

OpenCode Go defines every allowance as a monthly dollar amount per model, and
derives the shorter windows from it:

| Window | Allowance | Upstream field |
| --- | --- | --- |
| 5 hours (rolling) | 20% of the monthly limit | `rolling` |
| Week | 50% of the monthly limit | `weekly` |
| Month | 100% of the monthly limit | `monthly` |

Under the composer it stays one compact control: the label `5h` (`小时` in the
Chinese locale) next to a **single ring** filled to the rolling window's used
share, with the percentage beside it. Opening that control shows the weekly and
monthly windows as bars with their percentages and reset times, when the figures
were last read, and a refresh action; the ring's tooltip carries the 5-hour
window's reset time and countdown.

**Nothing polls.** The figures are read once when the page loads and change only
when you press **Refresh**, so the reported read time always says how current they
are — opening the popup deliberately does not re-read them.

`GET https://opencode.ai/zen/go/v1/usage` returns:

```json
{ "usage": {
  "rolling": { "status": "ok", "percent": 2, "resetsAt": "2026-10-18T11:02:12.000Z" },
  "weekly":  { "status": "ok", "percent": 1, "resetsAt": "2026-10-19T00:00:00.000Z" },
  "monthly": { "status": "ok", "percent": 0, "resetsAt": "2026-11-18T06:01:17.000Z" } } }
```

That call needs the bearer key, so it stays on the Host half. The browser half
fetches only the projected percentages and reset instants from
`/plugin/opencode-go-usage/quota`, a loopback route this plugin registers, and
never receives the key. The key is resolved per request through
`ctx.credentials` as `OPENCODE_GO_API_KEY` — so a rotated credential reaches the
next call without a restart — falling back to the same-named environment
variable. The allowance belongs to the account behind that key, so each machine
shows its own quota.

Configuration (optional; every field has a default) is overridden from the
profile's own `cordis.patch.yml`:

```yaml
- id: opencode-go-usage
  config:
    endpoint: 'https://opencode.ai/zen/go/v1/usage'
    credentialRef: 'OPENCODE_GO_API_KEY'
    cacheMs: 5000
    requestTimeoutMs: 15000
```

## Repository layout

The repository root **is** the package root, which is what makes
`github:nullpoint333/dsh-plugins` a valid install target: an install spec names a
repository, and the manager imports the package it finds there.

```
package.json                      the one package: bundle + client declaration
cordis.patch.yml                  one Loader row per plugin, plus the root row
host.js                           package-root row (see below)
client.js                         the package's single browser half — all UI
locale/{en,zh}.json               the bundle's card in the Plugins page
icon.svg
plugins/
  opencode-go-usage/
    index.js                      Host half: upstream call + loopback route
    locale/{en,zh}.json           this plugin's own row in the Plugins page
    icon.svg
```

A subpath plugin exports its own `locale/*.json` and `icon` for display and is
never read as a package of its own.

### Why there is a separate root row

A browser half belongs to a **package**, not to a Loader row: the module id is the
package name, and the Host composes the bundle from the package's
`exports["./client"]`. The Host scans a row for that declaration only when the row
names the **package root** — verified here by inserting one probe package twice,
first as `pkg/probe` and then as `pkg`, where only the second form produced a live
slot registration.

So `host.js` is the anchor and registers nothing itself. Keeping the anchor
separate from the feature plugins is deliberate: if a feature plugin were the
root, disabling it would take every other plugin's UI down with it.

### Adding a plugin

1. `plugins/<name>/index.js` — the Host half. Export `apply(ctx, config)` and
   declare `inject` for the services it needs.
2. Add `"./<name>": "./plugins/<name>/index.js"` to `exports`, plus its
   `./<name>/locale/*.json` and `./<name>/icon` when it has display metadata.
3. Add a row to `cordis.patch.yml`:

   ```yaml
   - id: <name>
     name: 'dsh-plugins/<name>'
   ```
4. For UI, register from `client.js` — the one bundle every plugin shares; there
   is no per-plugin browser bundle.
5. `plugins/<name>/locale/{en,zh}.json` gives the plugin its own title and
   description in the Plugins page.

Two consequences to know before choosing this layout:

- All UI shares one bundle, so a plugin with a UI cannot be published from this
  repository on its own — it is always part of the collection.
- A single git spec cannot address a subdirectory, so splitting this into several
  packages under one repository would move distribution from `github:` installs
  to a registry.

## Requirements and limits

- `opencode-go-usage` needs the Web carrier (`ctx.webServer`). An Electron-only
  profile loads the page over `file://` and that plugin stays inactive.
- Its route is registered as an `exact` route, so it is matched before the Web
  shell's fallback handler and is **not** behind the connection's own
  authorization. It exposes quota percentages only — never the API key — and the
  listener is loopback-bound by the `webserver` row's `host` config.
- `status` values other than `ok` and a used share of 100% render as an error, a
  share of 80% or more as a warning.

### Switching between a working copy and the published package

A local-path install (`link:`) runs this directory, so edits take effect at once;
a `github:` install runs a downloaded copy. On Windows the switch back is not
symmetric — `remove_bundle` reports `applied` but pnpm leaves the
`node_modules/<name>` symlink behind, and the next install then fails with:

```
[ERR_PNPM_EPERM] [importPackage ...\node_modules\dsh-plugins]
EPERM: operation not permitted, rename '..._tmp_<pid>_<n>' -> '...\dsh-plugins'
```

Delete that leftover symlink before installing the published package, and let the
manager recreate the link when you switch back. A machine that never had a local
install is unaffected: there is no entry for the rename to collide with.

## License

MIT — see [LICENSE](LICENSE).
