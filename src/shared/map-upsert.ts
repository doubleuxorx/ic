/**
 * `getOrInsert` and `getOrInsertComputed` for `Map` and `WeakMap`, on engines
 * that do not have them yet.
 *
 * PDF.js 6 uses these throughout — sixteen call sites in the main-thread build
 * and thirty in the worker — but they are a TC39 proposal (Upsert, stage 2.7)
 * that WebKitGTK 2.48 does not implement. Without this, no PDF opened on Linux
 * at all: loading failed with "this.#methodPromises.getOrInsertComputed is not
 * a function" and the node showed that sentence where a page should be.
 *
 * Import it before PDF.js, in the window and in the worker (`pdf-worker.ts`).
 * On an engine that already has the methods it changes nothing.
 *
 * https://github.com/tc39/proposal-upsert
 */

// Nothing is exported: this module is imported for its effect. The marker is
// what makes it a module, which `declare global` below requires.
export {};

declare global {
  interface Map<K, V> {
    getOrInsert(key: K, defaultValue: V): V;
    getOrInsertComputed(key: K, callback: (key: K) => V): V;
  }

  interface WeakMap<K extends WeakKey, V> {
    getOrInsert(key: K, defaultValue: V): V;
    getOrInsertComputed(key: K, callback: (key: K) => V): V;
  }
}

/** What both prototypes have in common, and all these methods need. */
type Upsertable = {
  has(key: never): boolean;
  get(key: never): unknown;
  set(key: never, value: never): unknown;
};

/** Added the way the engine would add it: not enumerable, still replaceable. */
const define = (prototype: Upsertable, name: string, value: unknown) => {
  if (typeof (prototype as Record<string, unknown>)[name] === 'function') return;
  Object.defineProperty(prototype, name, {
    value,
    writable: true,
    enumerable: false,
    configurable: true,
  });
};

const install = (prototype: Upsertable) => {
  define(prototype, 'getOrInsert', function (this: Upsertable, key: never, value: never) {
    if (this.has(key)) return this.get(key);
    this.set(key, value);
    return value;
  });

  define(
    prototype,
    'getOrInsertComputed',
    function (this: Upsertable, key: never, callback: (key: never) => never) {
      if (typeof callback !== 'function') {
        throw new TypeError('getOrInsertComputed: callback is not a function');
      }
      if (this.has(key)) return this.get(key);
      // The callback may itself insert this key, which is why the value is set
      // afterwards rather than reserved first: the last write wins, as in the
      // proposal.
      const value = callback(key);
      this.set(key, value);
      return value;
    },
  );
};

install(Map.prototype);
install(WeakMap.prototype);
