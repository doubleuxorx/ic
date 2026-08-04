/** Error shapes crossing the IPC boundary. */

export interface RevisionConflict {
  kind: 'revision-mismatch';
  message: string;
  currentRevision: string;
  currentContents: string;
}

export interface PlainIpcError {
  kind: 'error';
  message: string;
}

export type IpcError = RevisionConflict | PlainIpcError;

export const isRevisionConflict = (error: unknown): error is RevisionConflict =>
  typeof error === 'object' &&
  error !== null &&
  (error as { kind?: string }).kind === 'revision-mismatch';

/** Rust commands returning `SecurityError` serialize to a plain string. */
export const errorMessage = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'unexpected error';
};
