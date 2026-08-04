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
  reload.style.cssText =
    'font:inherit;margin:0 0 16px;padding:6px 12px;border:1px solid CanvasText;border-radius:4px;background:transparent;color:inherit;cursor:pointer';
  reload.addEventListener('click', () => window.location.reload());

  const detail = document.createElement('pre');
  detail.textContent = message;
  detail.style.cssText = 'margin:0;white-space:pre-wrap;overflow-wrap:anywhere';

  overlay.append(heading, reload, detail);
  document.body.append(overlay);
};
