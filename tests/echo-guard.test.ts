import { describe, expect, it } from 'vitest';

import { createEchoGuard, noteLocalEdit, shouldAdopt } from '@/editor/echo-guard';

describe('echo guard', () => {
  it('adopts a change nobody here made', () => {
    const guard = createEchoGuard();
    expect(shouldAdopt(guard, 'from disk', 'in buffer')).toBe(true);
  });

  it('ignores a value the editor itself produced', () => {
    const guard = createEchoGuard();
    noteLocalEdit(guard);
    // The buffer is already at "ab"; "a" is last keystroke's echo arriving late.
    expect(shouldAdopt(guard, 'a', 'ab')).toBe(false);
  });

  it('survives a burst of keystrokes echoed out of step', () => {
    const guard = createEchoGuard();
    // Two quick edits: the buffer reaches "ab" before either echo returns.
    noteLocalEdit(guard);
    noteLocalEdit(guard);

    expect(shouldAdopt(guard, 'a', 'ab')).toBe(false);
    expect(shouldAdopt(guard, 'ab', 'ab')).toBe(false);

    // Agreement reached, so the next disagreement is genuinely external.
    expect(shouldAdopt(guard, 'external', 'ab')).toBe(true);
  });

  it('treats agreement as clearing everything outstanding', () => {
    const guard = createEchoGuard();
    noteLocalEdit(guard);
    noteLocalEdit(guard);
    noteLocalEdit(guard);

    // A render can coalesce several echoes into one value.
    expect(shouldAdopt(guard, 'abc', 'abc')).toBe(false);
    expect(guard.pending).toBe(0);
    expect(shouldAdopt(guard, 'reloaded', 'abc')).toBe(true);
  });

  it('cannot oscillate between two values', () => {
    // The failure it exists to prevent: adopting one value emits the other,
    // which is adopted in turn, forever.
    const guard = createEchoGuard();
    let buffer = 'ab';
    let adoptions = 0;

    for (const incoming of ['a', 'ab', 'a', 'ab']) {
      noteLocalEdit(guard);
      if (shouldAdopt(guard, incoming, buffer)) {
        buffer = incoming;
        adoptions += 1;
      }
    }

    expect(adoptions).toBe(0);
    expect(buffer).toBe('ab');
  });
});
