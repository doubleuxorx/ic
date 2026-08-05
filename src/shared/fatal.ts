/**
 * Last-resort error surface.
 *
 * A crash in a React render unmounts the whole tree, and a crash in an event
 * handler leaves the interface in whatever state it was in. Either way the
 * window would simply be the background colour with no explanation, which is
 * indistinguishable from a rendering fault. This draws an overlay instead, so a
 * failure always says what happened and offers a reload.
 *
 * The overlay is built with DOM calls rather than markup so it cannot itself
 * depend on React, the theme stylesheet or the bundle having loaded.
 */

const OVERLAY_ID = 'fatal';

export const describeError = (detail: unknown): string => {
  if (detail instanceof Error) {
    return detail.stack ? `${detail.name}: ${detail.message}\n\n${detail.stack}` : `${detail.name}: ${detail.message}`;
  }
  return String(detail);
};

/**
 * A resize observation the browser could not finish delivering in one frame.
 *
 * When a `ResizeObserver` callback changes layout, the browser runs the
 * delivery loop again; past a depth limit it stops and reports whatever is left
 * over as a window error event. Nothing is lost — the remaining observations
 * arrive on the next frame — so this is a notice about scheduling rather than a
 * failure, and it fires routinely while a node is being resized, because the
 * canvas measures nodes with an observer of its own. Covering the window with a
 * crash overlay over it would be wrong.
 *
 * It carries no exception object, which is what tells it apart from a real
 * error that happens to mention the same API.
 */
export const isResizeObserverNotice = (event: { error?: unknown; message?: string }): boolean =>
  !event.error && /^ResizeObserver loop/.test(event.message ?? '');

const BUTTON_STYLE =
  'font:inherit;padding:6px 12px;border:1px solid CanvasText;border-radius:4px;background:transparent;color:inherit;cursor:pointer';

export const reportFatal = (message: string): void => {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) {
    // Keep the first failure: later ones are usually consequences of it.
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'alert');
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483647',
    'padding:24px',
    'overflow:auto',
    'background:Canvas',
    'color:CanvasText',
    'font:12px/1.6 ui-monospace,monospace',
    'white-space:pre-wrap',
  ].join(';');

  const heading = document.createElement('p');
  heading.textContent = 'Something went wrong. Your files on disk are unaffected.';
  heading.style.cssText = 'margin:0 0 12px;font-weight:600';

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload';
  reload.style.cssText = BUTTON_STYLE;
  reload.addEventListener('click', () => window.location.reload());

  const detail = document.createElement('pre');
  detail.textContent = message;
  detail.style.cssText = 'margin:0;white-space:pre-wrap;overflow-wrap:anywhere';

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy';
  copy.style.cssText = BUTTON_STYLE;
  copy.addEventListener('click', () => {
    // Reporting a crash means getting this text somewhere else, and retyping a
    // stack is not reasonable. If the clipboard is unavailable the message is
    // selected instead, so the keyboard still works.
    void Promise.resolve()
      .then(() => navigator.clipboard.writeText(message))
      .then(() => {
        copy.textContent = 'Copied';
      })
      .catch(() => {
        copy.textContent = 'Press Ctrl+C';
        window.getSelection()?.selectAllChildren(detail);
      });
  });

  const buttons = document.createElement('div');
  buttons.style.cssText = 'display:flex;gap:8px;margin:0 0 16px';
  buttons.append(reload, copy);

  overlay.append(heading, buttons, detail);
  document.body.append(overlay);
};
