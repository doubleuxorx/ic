import { describe, expect, it } from 'vitest';

import { describeError, isResizeObserverNotice } from '@/shared/fatal';

describe('describeError', () => {
  it('keeps the stack when there is one', () => {
    const error = new Error('boom');
    expect(describeError(error)).toContain('Error: boom');
    expect(describeError(error)).toContain(error.stack ?? '');
  });

  it('falls back to the string form of anything else', () => {
    expect(describeError('plain')).toBe('plain');
    expect(describeError(undefined)).toBe('undefined');
  });
});

describe('isResizeObserverNotice', () => {
  it('recognises both wordings browsers use', () => {
    expect(
      isResizeObserverNotice({
        message: 'ResizeObserver loop completed with undelivered notifications.',
      }),
    ).toBe(true);
    expect(isResizeObserverNotice({ message: 'ResizeObserver loop limit exceeded' })).toBe(true);
  });

  it('reports a real error that happens to mention the same API', () => {
    expect(
      isResizeObserverNotice({
        error: new TypeError('ResizeObserver loop is not a function'),
        message: 'ResizeObserver loop is not a function',
      }),
    ).toBe(false);
  });

  it('reports everything else', () => {
    expect(isResizeObserverNotice({ message: 'TypeError: x is not a function' })).toBe(false);
    expect(isResizeObserverNotice({})).toBe(false);
  });
});
