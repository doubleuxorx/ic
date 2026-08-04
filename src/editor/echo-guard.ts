/**
 * Tells an external edit apart from the editor's own edit coming back.
 *
 * An editor sends every keystroke up to the store and receives the result back
 * as a new value. That echo can arrive a render late, so a value that differs
 * from the buffer is not necessarily an external change. Adopting a stale echo
 * would undo the newest keystroke; its own echo would then undo that, and the
 * two would alternate until React unmounted the tree. Counting the edits that
 * have not yet been echoed back distinguishes the two cases.
 */

export interface EchoGuard {
  /** Local edits whose echo has not returned yet. */
  pending: number;
}

export const createEchoGuard = (): EchoGuard => ({ pending: 0 });

/** Records an edit made in the editor, which will be echoed back later. */
export const noteLocalEdit = (guard: EchoGuard): void => {
  guard.pending += 1;
};

/**
 * Whether `incoming` should replace `current` in the buffer.
 *
 * Agreement clears the backlog: whatever was outstanding has arrived, and
 * anything later is genuinely external.
 */
export const shouldAdopt = (guard: EchoGuard, incoming: string, current: string): boolean => {
  if (incoming === current) {
    guard.pending = 0;
    return false;
  }
  if (guard.pending > 0) {
    guard.pending -= 1;
    return false;
  }
  return true;
};
