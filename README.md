# dsh-opencode-go-usage

Shows the **OpenCode Go** subscription allowance inside the Harness Web UI, in the
ambient row below the composer (slot `conversation.composer.dock`).

## Install

Needs a DSH whose profile carries the Web carrier (`dsh-web-app`). Install the
bundle from the sidebar's **Plugins** page, or with the `plugin_manager` tool:

```jsonc
{ "action": "install_bundle", "target": "github:nullpoint333/dsh-opencode-go-usage" }
```

The manager verifies a GitHub repository with `git ls-remote` before installing,
using the profile directory's own Git and proxy configuration, so an SSH remote or
an internally mirrored URL works the same way.

The strip can only read a quota once the machine has an OpenCode Go key:

- the profile credential store as `OPENCODE_GO_API_KEY` — what `dsh` writes when
  you connect the `opencode-go` provider — or
- the same-named process environment variable.

The allowance belongs to the account behind that key, so each machine shows its
own quota rather than a shared total.

There are no dependencies, no install scripts and no build step: the two
JavaScript files are the whole implementation.

## What it displays

OpenCode Go defines every allowance as a monthly dollar amount per model, and
derives the shorter windows from it:

| Window | Allowance | Upstream field |
| --- | --- | --- |
| 5 hours (rolling) | 20% of the monthly limit | `rolling` |
| Week | 50% of the monthly limit | `weekly` |
| Month | 100% of the monthly limit | `monthly` |

Each window shows the **used share** as a percentage and a small bar; hovering a
window gives the exact reset instant and a countdown. The strip refreshes every
60 seconds, whenever the page becomes visible again, and on the `⟳` button.

## How it reads the data

`GET https://opencode.ai/zen/go/v1/usage` returns:

```json
{ "usage": {
  "rolling": { "status": "ok", "percent": 2, "resetsAt": "2026-10-18T11:02:12.000Z" },
  "weekly":  { "status": "ok", "percent": 1, "resetsAt": "2026-10-19T00:00:00.000Z" },
  "monthly": { "status": "ok", "percent": 0, "resetsAt": "2026-11-18T06:01:17.000Z" } } }
```

That call needs the bearer key, so it stays on the Host half. The Client half
fetches only the projected percentages and reset instants from
`/plugin/opencode-go-usage/quota`, a loopback route this bundle registers, and
never receives the key.

The key is resolved per request through `ctx.credentials`, so a rotated
credential reaches the next call without a restart. It falls back to the
same-named process environment variable when the credential service is absent.

## Configuration

Optional; every field has a default, so the row may carry an empty `config`.
Override it from the profile's own `cordis.patch.yml`:

```yaml
- id: opencode-go-usage
  config:
    endpoint: 'https://opencode.ai/zen/go/v1/usage'
    credentialRef: 'OPENCODE_GO_API_KEY'
    cacheMs: 5000
    requestTimeoutMs: 15000
```

## Requirements and limits

- Needs the Web carrier (`ctx.webServer`). An Electron-only profile loads the
  page over `file://` and this bundle stays inactive.
- The route is registered as an `exact` route, so it is matched before the Web
  shell's fallback handler, and it is **not** behind the connection's own
  authorization. It exposes quota percentages only — never the key — and the
  listener is loopback-bound by the `webserver` row's `host` config.
- `status` values other than `ok` and a used share of 100% render as an error,
  a share of 80% or more as a warning.

## Repository layout

The repository root **is** the package root, which is what makes
`github:nullpoint333/dsh-opencode-go-usage` a valid install target: an install spec
names a repository, and the manager imports the package it finds there.

```
package.json          bundle + client declaration, exports
cordis.patch.yml      the Loader row this bundle inserts
index.js              Host half — owns the upstream call and the route
client.js             Client half — exports["./client"], the browser bundle
locale/{en,zh}.json   plugin-manager title and description
icon.svg              plugin artwork
LICENSE, README.md
```

### Adding a second plugin

A browser half belongs to a **package**, not to a Loader row: the module id is
the package name, and the host composes a bundle from the package's
`exports["./client"]`. The host scans a row for that declaration only when the
row is the **package root** — verified here by inserting one probe package twice,
first as `pkg/probe` and then as `pkg`, where only the second form produced a
live slot registration. So:

- A plugin **with a UI** must be its own package and be inserted as a
  package-root row. One plugin per repository keeps `github:<owner>/<repo>`
  working.
- Several plugins may share one package only as **subpath** rows
  (`name: pkg/component`), which is the `dsh-ops` pattern — but then they share
  that package's single browser half, and any UI must be contributed by it.
- A monorepo of packages is fine for source layout, but a single git spec cannot
  address a subdirectory, so those packages reach users through a registry or a
  local path instead.

### Switching between a working copy and the published package

A local-path install (`link:`) runs this directory, so edits take effect at once;
a `github:` install runs a downloaded copy. On Windows the switch back is not
symmetric — `remove_bundle` reports `applied` but pnpm leaves the
`node_modules/<name>` symlink behind, and the next install then fails with:

```
[ERR_PNPM_EPERM] [importPackage ...\node_modules\dsh-opencode-go-usage]
EPERM: operation not permitted, rename '..._tmp_<pid>_<n>' -> '...\dsh-opencode-go-usage'
```

Delete that leftover symlink before installing the published package, and let the
manager recreate the link when you switch back. A machine that never had a local
install is unaffected: there is no entry for the rename to collide with.

## License

MIT — see [LICENSE](LICENSE).
