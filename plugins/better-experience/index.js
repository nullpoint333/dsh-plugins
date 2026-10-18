/**
 * Host half of `dsh-plugins/better-experience`.
 *
 * Everything this plugin does happens in the browser: a settings page with a
 * toggle, and a session-scoped runtime that fires a desktop notification on
 * the running → idle transition. The Host half exists only so the Loader row
 * has a real plugin to activate, and so the user can disable the plugin in
 * one place and take the whole feature with it.
 */

/** localStorage key holding the user's preference. */
export const STORAGE_KEY = 'dsh-plugins.better-experience.notify-on-completion'

/**
 * The default is "off": desktop notifications need an explicit grant, and a
 * silent grant prompt is the wrong first impression.
 * @returns {boolean}
 */
export function readDefaultEnabled() {
  return false
}

/**
 * No backend work to register. The runtime lives in the Client half; this
 * half's `apply` is empty so the row's activation is a no-op.
 * @param _ctx
 * @param _config
 */
export function apply(_ctx, _config) {}
