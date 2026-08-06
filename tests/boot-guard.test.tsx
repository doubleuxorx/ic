// @vitest-environment jsdom
/**
 * The startup guard, from the window's point of view.
 *
 * `tests/fatal.test.ts` covers the predicates; this covers the wiring, which is
 * where the bug was. The guard installs one capturing listener on the window, and
 * a capturing listener sees events that do not bubble — which is every `error` an
 * image or media element raises about its own source. Treating one of those as a
 * script error covered a working application with an overlay reading "undefined".
 *
 * The rule the tests below pin down: a failure nothing else can report stays
 * fatal, and a failure the owning node already reports does not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fire } from './support/render';

const overlay = () => document.getElementById('fatal');

/** The guard installs itself when it loads, so each test loads it again. */
const installGuard = async (): Promise<void> => {
  vi.resetModules();
  await import('@/boot-guard');
};

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('failures the application must report', () => {
  it('reports a script error with where it came from', async () => {
    await installGuard();

    await fire(
      window,
      new ErrorEvent('error', {
        error: new Error('undefined is not a function'),
        message: 'undefined is not a function',
        filename: 'ic://localhost/assets/index.js',
        lineno: 42,
      }),
    );

    const shown = overlay();
    expect(shown).not.toBeNull();
    expect(shown?.textContent).toContain('undefined is not a function');
    expect(shown?.textContent).toContain('assets/index.js:42');
    // The one thing a user must be told, whatever else happened.
    expect(shown?.textContent).toContain('Your files on disk are unaffected');
  });

  it('reports a promise nobody awaited', async () => {
    await installGuard();

    const event = new Event('unhandledrejection') as Event & { reason?: unknown };
    event.reason = new Error('workspace_open failed');
    await fire(window, event);

    expect(overlay()?.textContent).toContain('workspace_open failed');
  });

  /**
   * A bundle or stylesheet that fails to load is dispatched at the element, like
   * a media failure, but nothing else in the application would ever say so and
   * the window would simply be empty.
   */
  it('reports a script or stylesheet that failed to load', async () => {
    await installGuard();
    const script = document.createElement('script');
    document.body.append(script);

    await fire(script, new Event('error'));

    expect(overlay()).not.toBeNull();
  });

  it('keeps the first failure rather than the last', async () => {
    await installGuard();

    await fire(window, new ErrorEvent('error', { error: new Error('first') }));
    await fire(window, new ErrorEvent('error', { error: new Error('second') }));

    expect(overlay()?.textContent).toContain('first');
    expect(overlay()?.textContent).not.toContain('second');
  });
});

describe('failures that are not the application failing', () => {
  it('ignores a source an image or media element refused', async () => {
    await installGuard();

    for (const tag of ['img', 'video', 'audio', 'source', 'track']) {
      const element = document.createElement(tag);
      document.body.append(element);
      await fire(element, new Event('error'));
      expect(overlay(), `${tag} drew the overlay`).toBeNull();
    }
  });

  /**
   * The browser raises this when a `ResizeObserver` callback changes layout more
   * often than it can settle in one frame. Nothing is lost, and the canvas
   * measures every node with an observer, so it fires while a node is resized.
   */
  it('ignores an undelivered resize observation', async () => {
    await installGuard();

    await fire(
      window,
      new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' }),
    );

    expect(overlay()).toBeNull();
  });

  /** A real error that merely mentions the same API is still an error. */
  it('does not ignore a genuine failure inside an observer callback', async () => {
    await installGuard();

    await fire(
      window,
      new ErrorEvent('error', {
        error: new TypeError('ResizeObserver callback threw'),
        message: 'ResizeObserver callback threw',
      }),
    );

    expect(overlay()).not.toBeNull();
  });
});
