/**
 * Open Markdown documents referenced by file nodes.
 *
 * One entry per path, shared by every node referencing it. Content is saved
 * atomically with revision checking, a crash-recovery copy is kept while a
 * document is dirty, and external modifications surface as conflicts instead of
 * silently overwriting either side.
 */

import { create } from 'zustand';

import { toast } from '@/app/ui-store';
import { errorMessage, isRevisionConflict } from '@/shared/errors';
import { ipc } from '@/shared/ipc-types';

export const DOCUMENT_AUTOSAVE_MS = 900;
const RECOVERY_DELAY_MS = 2500;

export interface OpenDocument {
  relativePath: string;
  contents: string;
  revision: string;
  dirty: boolean;
  saving: boolean;
  loading: boolean;
  error: string | null;
  conflict: { diskContents: string; diskRevision: string } | null;
}

interface DocumentStore {
  docs: Record<string, OpenDocument>;
  open: (relativePath: string) => Promise<void>;
  setContents: (relativePath: string, contents: string) => void;
  save: (relativePath: string, options?: { force?: boolean }) => Promise<void>;
  saveAll: () => Promise<void>;
  reload: (relativePath: string) => Promise<void>;
  resolveConflict: (relativePath: string, choice: 'keep-mine' | 'take-disk') => Promise<void>;
  dirtyPaths: () => string[];
  adoptRecovery: (relativePath: string, contents: string, baseRevision: string) => void;
}

const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useDocumentStore = create<DocumentStore>((set, get) => ({
  docs: {},

  open: async (relativePath) => {
    const existing = get().docs[relativePath];
    if (existing && !existing.loading) return;
    set((state) => ({
      docs: {
        ...state.docs,
        [relativePath]: {
          relativePath,
          contents: existing?.contents ?? '',
          revision: existing?.revision ?? '',
          dirty: false,
          saving: false,
          loading: true,
          error: null,
          conflict: null,
        },
      },
    }));
    try {
      const content = await ipc.documentRead(relativePath);
      set((state) => ({
        docs: {
          ...state.docs,
          [relativePath]: {
            relativePath,
            contents: content.contents,
            revision: content.revision,
            dirty: false,
            saving: false,
            loading: false,
            error: null,
            conflict: null,
          },
        },
      }));
    } catch (error) {
      set((state) => ({
        docs: {
          ...state.docs,
          [relativePath]: {
            ...(state.docs[relativePath] as OpenDocument),
            loading: false,
            error: errorMessage(error),
          },
        },
      }));
    }
  },

  setContents: (relativePath, contents) => {
    const doc = get().docs[relativePath];
    if (!doc || doc.contents === contents) return;
    set((state) => ({
      docs: {
        ...state.docs,
        [relativePath]: { ...(state.docs[relativePath] as OpenDocument), contents, dirty: true },
      },
    }));

    const existingSave = saveTimers.get(relativePath);
    if (existingSave) clearTimeout(existingSave);
    saveTimers.set(
      relativePath,
      setTimeout(() => void get().save(relativePath), DOCUMENT_AUTOSAVE_MS),
    );

    // A recovery copy protects unsaved content between autosaves.
    const existingRecovery = recoveryTimers.get(relativePath);
    if (existingRecovery) clearTimeout(existingRecovery);
    recoveryTimers.set(
      relativePath,
      setTimeout(() => {
        const current = get().docs[relativePath];
        if (current?.dirty) {
          void ipc
            .recoveryWrite(relativePath, current.contents, current.revision)
            .catch(() => undefined);
        }
      }, RECOVERY_DELAY_MS),
    );
  },

  save: async (relativePath, { force = false } = {}) => {
    const doc = get().docs[relativePath];
    if (!doc || doc.saving || doc.conflict) return;
    if (!doc.dirty && !force) return;
    const timer = saveTimers.get(relativePath);
    if (timer) {
      clearTimeout(timer);
      saveTimers.delete(relativePath);
    }
    set((state) => ({
      docs: {
        ...state.docs,
        [relativePath]: { ...(state.docs[relativePath] as OpenDocument), saving: true },
      },
    }));
    try {
      const result = await ipc.documentWrite(relativePath, doc.revision, doc.contents);
      set((state) => ({
        docs: {
          ...state.docs,
          [relativePath]: {
            ...(state.docs[relativePath] as OpenDocument),
            revision: result.revision,
            dirty: false,
            saving: false,
            error: null,
          },
        },
      }));
      await ipc.recoveryClear(relativePath).catch(() => undefined);
    } catch (error) {
      const conflict = isRevisionConflict(error)
        ? { diskContents: error.currentContents, diskRevision: error.currentRevision }
        : null;
      set((state) => ({
        docs: {
          ...state.docs,
          [relativePath]: {
            ...(state.docs[relativePath] as OpenDocument),
            saving: false,
            conflict,
            error: conflict ? null : errorMessage(error),
          },
        },
      }));
      if (conflict) toast(`${relativePath} changed on disk`, 'error');
    }
  },

  saveAll: async () => {
    for (const path of get().dirtyPaths()) {
      await get().save(path);
    }
  },

  reload: async (relativePath) => {
    const doc = get().docs[relativePath];
    if (!doc) return;
    try {
      const content = await ipc.documentRead(relativePath);
      if (content.revision === doc.revision) return;
      if (!doc.dirty) {
        set((state) => ({
          docs: {
            ...state.docs,
            [relativePath]: {
              ...(state.docs[relativePath] as OpenDocument),
              contents: content.contents,
              revision: content.revision,
            },
          },
        }));
      } else {
        set((state) => ({
          docs: {
            ...state.docs,
            [relativePath]: {
              ...(state.docs[relativePath] as OpenDocument),
              conflict: { diskContents: content.contents, diskRevision: content.revision },
            },
          },
        }));
      }
    } catch {
      // The file may have been removed; the node shows its own error state.
    }
  },

  resolveConflict: async (relativePath, choice) => {
    const doc = get().docs[relativePath];
    if (!doc?.conflict) return;
    if (choice === 'take-disk') {
      set((state) => ({
        docs: {
          ...state.docs,
          [relativePath]: {
            ...(state.docs[relativePath] as OpenDocument),
            contents: doc.conflict?.diskContents ?? '',
            revision: doc.conflict?.diskRevision ?? '',
            dirty: false,
            conflict: null,
          },
        },
      }));
      await ipc.recoveryClear(relativePath).catch(() => undefined);
      return;
    }
    set((state) => ({
      docs: {
        ...state.docs,
        [relativePath]: {
          ...(state.docs[relativePath] as OpenDocument),
          revision: doc.conflict?.diskRevision ?? '',
          conflict: null,
          dirty: true,
        },
      },
    }));
    await get().save(relativePath, { force: true });
  },

  dirtyPaths: () =>
    Object.values(get().docs)
      .filter((doc) => doc.dirty)
      .map((doc) => doc.relativePath),

  adoptRecovery: (relativePath, contents, baseRevision) => {
    set((state) => ({
      docs: {
        ...state.docs,
        [relativePath]: {
          relativePath,
          contents,
          revision: baseRevision,
          dirty: true,
          saving: false,
          loading: false,
          error: null,
          conflict: null,
        },
      },
    }));
  },
}));
