# dsh-plugins

A collection of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
plugins, delivered as **one bundle**.

| Plugin | What it does |
| --- | --- |
| [`opencode-go-usage`](plugins/opencode-go-usage) | Shows the OpenCode Go subscription's 5-hour, weekly and monthly quota below the composer |
| [`minimax-quota`](plugins/minimax-quota) | Shows the MiniMax M Plan's 5-hour and weekly allowance below the composer |
| [`better-experience`](plugins/better-experience) | The Settings page that holds this collection's global preferences — today, whether each quota ring is shown and whether a desktop notification fires when a task ends. |

Preferences are live: changing one on the **Better experience** page takes
effect at once, with no reload.

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

**Reading is paced, not polled.** The figures are held per plugin rather than per
view, so switching conversations re-renders them from the cache instead of
re-reading; they are re-read only once they are older than `uiRefreshMs` (5 minutes
by default), which is also the interval of the single timer that runs while the
control is on screen. Opening the popup does not re-read — **Refresh** is the only
thing that forces one.

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
    uiRefreshMs: 300000
```

### `minimax-quota`

MiniMax's M Plan is also a subscription with two independently refreshing
windows, and the same allowance is shared by every tool that uses the key:

| Window | Covers | Length |
| --- | --- | --- |
| 5 hours | non-video models (text, image, audio) | 5 hours from first use |
| Week | every model, video included | 7 days from first use |

A non-video model needs **both** windows to have something left, so a spent
5-hour window stops work even while the week is nearly untouched — which is
exactly what makes a two-window display worth having.

MiniMax documents the figures in its console and in its own CLI (`mmx quota`).
This plugin reads the same route that CLI uses:

```
GET https://api.minimax.cn/v1/token_plan/remains
Authorization: Bearer <M Plan subscription key>

{ "model_remains": [ { "model_name": "general",
    "start_time": …, "end_time": …, "remains_time": …,
    "current_interval_remaining_percent": 0,
    "weekly_start_time": …, "weekly_end_time": …,
    "current_weekly_remaining_percent": 86, "weekly_boost_permille": 1500 } ],
  "base_resp": { "status_code": 0, "status_msg": "success" } }
```

Two details of that payload are worth naming, because both are easy to get
backwards:

- **The percentages are what is LEFT, not what is used.** The Host half
  converts them, so every widget in this collection draws the same thing (the
  share spent), and the MiniMax popup prints both readings rather than picking
  one.
- **The count field is named `*_usage_count` but is treated as REMAINING.**
  MiniMax's own CLI reads it that way and flips to `total - count` only when
  `*_remaining_percent` disproves that reading by the smaller margin. The Host
  half mirrors that, and where the two readings disagree with the reported
  percentage by more than one point the reported percentage wins rather than a
  guess.

The route needs the **subscription** key (`sk-…`). A pay-as-you-go key starts
with `sk-api-`, belongs to a different endpoint, and is metered against the
account balance instead; the plugin detects that and says so rather than
reporting an empty allowance. The key never reaches the browser: the Host half
owns the call and republishes only the projected shares and reset instants over
`/plugin/minimax-quota/quota`.

Configuration (optional; every field has a default):

```yaml
- id: minimax-quota
  config:
    # The international base is 'https://api.minimax.io'; both serve this route.
    endpoint: 'https://api.minimax.cn'
    credentialRef: 'MINIMAX_CN_API_KEY'
    # The plan entry carrying the text/image/audio allowance.
    modelName: 'general'
    cacheMs: 5000
    requestTimeoutMs: 15000
    uiRefreshMs: 300000
```

### `better-experience`

This plugin owns the **Better experience** Settings page — a place for the
collection's global preferences to live, so the next plugin that needs a
preference does not have to invent its own page.

The page renders one section per concern, and each row is: a label, a
description, a status line that states the **consequence** of the current
value rather than the bit itself, and the switch.

| Preference | Key | Default | What it does |
| --- | --- | --- | --- |
| Show the OpenCode Go quota | `show-quota` | **on** | Shows the OpenCode Go ring below the composer. Turning it off is a real off switch, not a hidden element: with nothing mounted that widget's store has no subscribers, so its timer stops and no requests are made. |
| Show the MiniMax plan usage | `show-minimax-quota` | **on** | The same, for the MiniMax M Plan ring. The two are independent. |
| Notify when a task completes | `notify-on-completion` | off | Sends a desktop notification when the model finishes a turn. |

Keys live under `localStorage['dsh-plugins.better-experience.<name>']`, so a
future plugin in this collection cannot collide with them. A value equal to
its default is stored by **removing** the key, which lets a later release
change a default without a migration.

The live values are not read from `localStorage` on every render: `storage`
events do not fire in the tab that wrote them, so that would not wake a
mounted view anyway. Instead one in-memory store is created per activation
and shared by every subscriber — the settings page writes it, and the
composer ring reads it. That is what makes the quota toggle take effect
**immediately, with no reload**; `localStorage` is only the durable layer
behind it. Both are exercised by the repository's offline checks (below).

### The notification row today

The row, its persistence, and its availability handling work, and a **Send a
test notification** action verifies the OS-level permission and the API path
without waiting for a real task to end. Firing automatically on task
completion is **not implemented yet**: it needs session state, and a
`settings.section` page is root-scoped, so it cannot read a session-scoped
hook. That runtime belongs in a session-scoped seat (the composer dock
alongside the quota ring), sharing this same preference store.

## Offline checks

The browser half can be verified without a browser. Both scripts load
`client.js` through the module-loader shim and inject React, so they catch
render-time failures that a browser only reports as a blank slot:

```
node render-test.cjs   <client.js>                    # both entries render
node interact-test.cjs <client.js>                    # toggles, no Notifications API
node interact-test.cjs <client.js> --notifications    # toggles, permission granted
```

`interact-test.cjs` mounts both entries in a jsdom DOM and clicks the real
toggles, so it covers the shared-store reactivity that static rendering
cannot see. It also supplies the root standard seat with hooks that throw,
which is how a stray session-hook call in a root-scoped page is caught
before it blanks the page.

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
  minimax-quota/
    index.js                      Host half: plan call + loopback route
    locale/{en,zh}.json           this plugin's own row in the Plugins page
    icon.svg
  better-experience/
    index.js                      Host half: empty (the page is browser-only)
    locale/{en,zh}.json           this plugin's own row in the Plugins page
    icon.svg
```

A subpath plugin exports its own `locale/*.json` and `icon` for display and is
never read as a package of its own.

The two quota widgets share one browser implementation: each Host half
normalizes its provider's envelope into the same window shape (`percent` = the
share USED, plus `resetsAt`), and `QUOTA_WIDGETS` in `client.js` names the route,
the order and the window labels. A third provider is therefore a Host half, a
`QUOTA_WIDGETS` entry, and two `PREFERENCES` rows — no new view code.

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
6. **After editing a plugin file, republish before it can show.** The Host
   snapshots a package's client entry when the bundle activates, so a lone edit to
   `client.js` — or to a plugin's Host half — does not reach the running
   composition on its own; the previous module keeps answering until the bundle is
   composed again. Toggle the bundle off and on (the Plugins page, or
   `plugin_manager` `set_bundle`), then reload the page so the browser takes the
   new bundle.
7. **Global preferences go on the `better-experience` page, not on a new
   page of their own.** Future plugins in this collection should add their
   preference to that section and store it under
   `localStorage['dsh-plugins.better-experience.<key>']` so the page stays
   the one place to manage collection-wide options.
8. **Never call a standard `use*` hook whose scope does not match the slot.**
   The renderer builds a root entry's props from the root standard binding
   (`standardKit` in `dsh-client-ui-renderer`), so names such as
   `useSessions` and `useSessionStatus` really are present as props. But a
   *session*-scoped hook has no source for a *root*-scoped entry, and the
   loader signals that with a `SlotAssemblyError` — which the entry error
   boundary deliberately **rethrows** rather than containing. The result is
   not a crashed row but a **blank page with no visible error**. A
   `settings.section` page is root-scoped: use React's own hooks and the
   entry's own inject face, and read session state from a session-scoped
   slot instead.

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
