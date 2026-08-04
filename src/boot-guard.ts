/**
 * Startup and runtime error guard, loaded before the application module.
 *
 * If the main bundle fails to parse, import or mount, the window would
 * otherwise be blank with no explanation. The same is true of an error thrown
 * later, from an event handler or a promise nobody awaited. Both are reported
 * through the shared overlay. It is a module rather than an inline script so
 * the content security policy needs no `unsafe-inline` for scripts.
 */

import { describeError, reportFatal } from '@/shared/fatal';

window.addEventListener(
  'error',
  (event) => {
    const source = event.filename ? `\n\n${event.filename}:${event.lineno}` : '';
    reportFatal(`${describeError(event.error ?? event.message)}${source}`);
  },
  true,
);

window.addEventListener('unhandledrejection', (event) => {
  reportFatal(describeError(event.reason));
});
