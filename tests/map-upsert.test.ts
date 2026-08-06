import { describe, expect, it } from 'vitest';

import '@/shared/map-upsert';

/**
 * The polyfill PDF.js needs on WebKitGTK. Node may already have these methods,
 * in which case these tests describe the native ones — which is the point: the
 * polyfill has to behave the same way, or a document renders in one engine and
 * not another.
 */
describe('map upsert', () => {
  it('installs both methods on both prototypes', () => {
    for (const prototype of [Map.prototype, WeakMap.prototype]) {
      for (const name of ['getOrInsert', 'getOrInsertComputed']) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        expect(typeof descriptor?.value).toBe('function');
        expect(descriptor?.enumerable).toBe(false);
      }
    }
  });

  it('returns the existing value and inserts nothing', () => {
    const map = new Map([['key', 'first']]);
    expect(map.getOrInsert('key', 'second')).toBe('first');
    expect(map.getOrInsertComputed('key', () => 'third')).toBe('first');
    expect(map.size).toBe(1);
  });

  it('inserts and returns the value for a missing key', () => {
    const map = new Map<string, string>();
    expect(map.getOrInsert('key', 'value')).toBe('value');
    expect(map.get('key')).toBe('value');
  });

  it('computes the value only for a missing key, and passes the key', () => {
    const map = new Map<string, number>([['known', 1]]);
    const asked: string[] = [];
    const compute = (key: string) => {
      asked.push(key);
      return key.length;
    };

    expect(map.getOrInsertComputed('known', compute)).toBe(1);
    expect(map.getOrInsertComputed('other', compute)).toBe(5);
    expect(asked).toEqual(['other']);
    expect(map.get('other')).toBe(5);
  });

  it('holds a value inserted by the callback itself only if it is newer', () => {
    const map = new Map<string, string>();
    expect(
      map.getOrInsertComputed('key', () => {
        map.set('key', 'from the callback');
        return 'computed';
      }),
    ).toBe('computed');
    expect(map.get('key')).toBe('computed');
  });

  it('refuses a callback that is not callable', () => {
    const map = new Map<string, string>();
    // What PDF.js would hit if the polyfill accepted anything: a silent undefined.
    expect(() => map.getOrInsertComputed('key', undefined as never)).toThrow(TypeError);
  });

  it('works on a WeakMap, whose keys are objects', () => {
    const key = {};
    const weak = new WeakMap<object, string>();
    expect(weak.getOrInsert(key, 'value')).toBe('value');
    expect(weak.get(key)).toBe('value');
    expect(weak.getOrInsertComputed(key, () => 'other')).toBe('value');
  });

  it('treats keys as a Map does, including -0 and NaN', () => {
    const map = new Map<number, string>([[0, 'zero']]);
    expect(map.getOrInsert(-0, 'negative zero')).toBe('zero');

    expect(map.getOrInsert(Number.NaN, 'first')).toBe('first');
    expect(map.getOrInsert(Number.NaN, 'second')).toBe('first');
  });
});
