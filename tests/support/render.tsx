/**
 * Rendering React into jsdom, without a testing library.
 *
 * `createRoot` plus `act` is all these tests need: the components under test take
 * plain props, so nothing here has to stand in for React Flow or CodeMirror. What
 * jsdom cannot do is lay out or paint — no element has a size, no image decodes
 * and no codec exists — so a test here asserts what the application *did*, and
 * anything about what it looks like belongs to the webview self-test.
 */

import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// React only batches updates inside `act` when it is told it is under test;
// without this every render warns and state updates land unpredictably.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Rendered {
  /** The element the component was rendered into. */
  host: HTMLElement;
  /** Apply new props, or render something else entirely. */
  update: (next: ReactNode) => Promise<void>;
  unmount: () => Promise<void>;
  /** First match, or a failure naming what was actually rendered. */
  find: <E extends Element = HTMLElement>(selector: string) => E;
  query: <E extends Element = HTMLElement>(selector: string) => E | null;
  text: () => string;
}

const mounted: Array<{ root: Root; host: HTMLElement }> = [];

export const render = async (element: ReactNode): Promise<Rendered> => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ root, host });

  await act(async () => {
    root.render(element);
  });

  const rendered: Rendered = {
    host,
    update: async (next) => {
      await act(async () => {
        root.render(next);
      });
    },
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
    find: <E extends Element = HTMLElement>(selector: string): E => {
      const found = host.querySelector<E>(selector);
      if (!found) throw new Error(`no ${selector} in:\n${host.innerHTML}`);
      return found;
    },
    query: <E extends Element = HTMLElement>(selector: string) => host.querySelector<E>(selector),
    text: () => host.textContent ?? '',
  };
  return rendered;
};

/** Unmount everything rendered by a test, so the next one starts empty. */
export const cleanup = async (): Promise<void> => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  }
  document.body.innerHTML = '';
};

/** Let effects, promises and state updates settle. */
export const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
  });
};

/** Dispatch an event the way the browser does, inside `act`. */
export const fire = async (target: EventTarget, event: Event): Promise<void> => {
  await act(async () => {
    target.dispatchEvent(event);
  });
};

export const click = (target: Element): Promise<void> =>
  fire(target, new MouseEvent('click', { bubbles: true, cancelable: true }));

/**
 * Type into a controlled input.
 *
 * Assigning `value` is not enough: React defines its own value property on the
 * element to track what it last rendered, and an assignment updates that tracker
 * too, so the change event that follows looks like no change at all. Going through
 * the prototype's setter leaves the tracker stale, which is what makes React
 * notice.
 */
const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;

export const type = async (input: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    nativeValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

export const press = (target: EventTarget, key: string, modifiers: KeyboardEventInit = {}) =>
  fire(target, new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers }));

/** Find a button by its visible label, the way a user would. */
export const button = (host: ParentNode, label: string): HTMLButtonElement => {
  const match = [...host.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) {
    const labels = [...host.querySelectorAll('button')].map((b) => b.textContent?.trim());
    throw new Error(`no button labelled "${label}"; there is ${JSON.stringify(labels)}`);
  }
  return match;
};
