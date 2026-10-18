/**
 * The package-root row of the `dsh-plugins` collection.
 *
 * It exists for one structural reason: a Host composes a package's browser half
 * from `exports["./client"]`, and it scans a Loader row for that declaration only
 * when the row names the package root. A subpath row such as
 * `dsh-plugins/opencode-go-usage` gets no browser bundle of its own.
 *
 * Making the anchor its own row, instead of promoting one feature plugin to the
 * root, keeps every feature independently toggleable: disabling the OpenCode Go
 * plugin withdraws that widget without taking the collection's UI down with it.
 *
 * It registers nothing itself — the UI lives in `client.js`, and each plugin's
 * Host half lives under `plugins/<name>/`.
 */
export function apply() {}
