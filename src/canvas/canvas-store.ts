/**
 * Canonical canvas state.
 *
 * The document is exactly what is written to disk. Selection, the active
 * editor, drag previews, playback and the viewport are deliberately kept beside
 * it and never serialized into `.canvas` files.
 */

import { create } from 'zustand';

import { errorMessage, isRevisionConflict } from '@/shared/errors';
import { ipc } from '@/shared/ipc-types';
import {
  createId,
  emptyCanvas,
  parseCanvas,
  serializeCanvas,
  type CanvasDocument,
  type CanvasEdge,
  type CanvasNode,
} from '@/shared/json-canvas';
import { useWorkspaceStore } from '@/workspace/workspace-store';
import {
  applyOp,
  emptyHistory,
  invertOp,
  pushHistory,
  type CanvasOp,
  type History,
} from './history';

export const AUTOSAVE_DELAY_MS = 800;
const VIEWPORT_PERSIST_DELAY_MS = 1200;

/** Selections are compared by contents, since their order is already stable. */
const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/** A selection the canvas has been asked to adopt, rather than one it made. */
export interface SelectionRequest {
  ids: string[];
  edgeIds: string[];
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface ConflictState {
  relativePath: string;
  diskContents: string;
  diskRevision: string;
}

interface CanvasStore {
  path: string | null;
  document: CanvasDocument;
  revision: string;
  history: History;
  dirty: boolean;
  saving: boolean;
  lastError: string | null;
  conflict: ConflictState | null;

  /**
   * Temporary interaction state.
   *
   * `selection` mirrors what React Flow reports; it is never fed back to the
   * canvas, because a mirror that also drives its source oscillates forever
   * whenever the two disagree for even one render. A command that wants a
   * particular selection raises `selectionRequest`, whose identity changes only
   * when something genuinely asks, so the canvas can apply it exactly once.
   */
  selection: string[];
  selectedEdges: string[];
  selectionRequest: SelectionRequest | null;
  activeNodeId: string | null;
  viewport: Viewport;

  load: (relativePath: string) => Promise<void>;
  createCanvas: (relativePath: string) => Promise<void>;
  closeCanvas: () => void;
  mutate: (op: CanvasOp, options?: { mergeKey?: string }) => void;
  undo: () => void;
  redo: () => void;
  save: (options?: { force?: boolean }) => Promise<void>;
  scheduleSave: () => void;
  /** Asks the canvas to select exactly these; used by commands. */
  setSelection: (ids: string[], edgeIds?: string[]) => void;
  /** Records what the canvas already selected; used by the canvas alone. */
  reportSelection: (ids: string[], edgeIds: string[]) => void;
  setActiveNode: (id: string | null) => void;
  setViewport: (viewport: Viewport) => void;
  onExternalChange: (paths: string[]) => Promise<void>;
  resolveConflict: (choice: 'keep-mine' | 'take-disk') => Promise<void>;
  clearError: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let viewportTimer: ReturnType<typeof setTimeout> | null = null;

export const useCanvasStore = create<CanvasStore>((set, get) => ({
  path: null,
  document: emptyCanvas(),
  revision: '',
  history: emptyHistory(),
  dirty: false,
  saving: false,
  lastError: null,
  conflict: null,

  selection: [],
  selectedEdges: [],
  selectionRequest: null,
  activeNodeId: null,
  viewport: { x: 0, y: 0, zoom: 1 },

  load: async (relativePath) => {
    const content = await ipc.documentRead(relativePath);
    const document = parseCanvas(content.contents);
    const settings = useWorkspaceStore.getState().settings;
    const viewport = settings.viewports[relativePath] ?? { x: 0, y: 0, zoom: 1 };
    set({
      path: relativePath,
      document,
      revision: content.revision,
      history: emptyHistory(),
      dirty: false,
      conflict: null,
      selection: [],
      selectedEdges: [],
      selectionRequest: null,
      activeNodeId: null,
      viewport,
      lastError: null,
    });
    await useWorkspaceStore.getState().patchSettings({ lastCanvas: relativePath });
  },

  createCanvas: async (relativePath) => {
    await ipc.documentCreate(relativePath, serializeCanvas(emptyCanvas()));
    await useWorkspaceStore.getState().refreshTree();
    await get().load(relativePath);
  },

  closeCanvas: () => {
    set({
      path: null,
      document: emptyCanvas(),
      revision: '',
      history: emptyHistory(),
      dirty: false,
      selection: [],
      selectedEdges: [],
      selectionRequest: null,
      activeNodeId: null,
    });
  },

  mutate: (op, options) => {
    const before = get().document;
    const inverse = invertOp(before, op);
    const next = applyOp(before, op);
    set({
      document: next,
      history: pushHistory(get().history, {
        op,
        inverse,
        ...(options?.mergeKey ? { mergeKey: options.mergeKey } : {}),
        at: Date.now(),
      }),
      dirty: true,
    });
    get().scheduleSave();
  },

  undo: () => {
    const { history, document } = get();
    const entry = history.past[history.past.length - 1];
    if (!entry) return;
    const next = applyOp(document, entry.inverse);
    set({
      document: next,
      history: { past: history.past.slice(0, -1), future: [entry, ...history.future] },
      dirty: true,
      activeNodeId: null,
    });
    get().scheduleSave();
  },

  redo: () => {
    const { history, document } = get();
    const entry = history.future[0];
    if (!entry) return;
    const next = applyOp(document, entry.op);
    set({
      document: next,
      history: { past: [...history.past, entry], future: history.future.slice(1) },
      dirty: true,
      activeNodeId: null,
    });
    get().scheduleSave();
  },

  scheduleSave: () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void get().save();
    }, AUTOSAVE_DELAY_MS);
  },

  save: async ({ force = false } = {}) => {
    const { path, document, revision, dirty, saving, conflict } = get();
    if (!path || saving || conflict) return;
    if (!dirty && !force) return;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    set({ saving: true });
    try {
      const result = await ipc.documentWrite(path, revision, serializeCanvas(document));
      set({ revision: result.revision, dirty: false, saving: false, lastError: null });
    } catch (error) {
      set({ saving: false });
      if (isRevisionConflict(error)) {
        set({
          conflict: {
            relativePath: path,
            diskContents: error.currentContents,
            diskRevision: error.currentRevision,
          },
        });
      } else {
        set({ lastError: errorMessage(error) });
      }
    }
  },

  setSelection: (ids, edgeIds = []) =>
    set({
      selection: ids,
      selectedEdges: edgeIds,
      selectionRequest: { ids, edgeIds },
    }),

  reportSelection: (ids, edgeIds) => {
    const { selection, selectedEdges } = get();
    if (sameIds(selection, ids) && sameIds(selectedEdges, edgeIds)) return;
    set({ selection: ids, selectedEdges: edgeIds });
  },

  setActiveNode: (id) => set({ activeNodeId: id }),

  setViewport: (viewport) => {
    set({ viewport });
    const path = get().path;
    if (!path) return;
    if (viewportTimer) clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => {
      const workspace = useWorkspaceStore.getState();
      void workspace.patchSettings({
        viewports: { ...workspace.settings.viewports, [path]: viewport },
      });
    }, VIEWPORT_PERSIST_DELAY_MS);
  },

  onExternalChange: async (paths) => {
    const { path, dirty } = get();
    if (!path || !paths.includes(path)) return;
    try {
      const content = await ipc.documentRead(path);
      if (content.revision === get().revision) return;
      if (!dirty) {
        // Nothing local to lose: adopt the external version.
        set({
          document: parseCanvas(content.contents),
          revision: content.revision,
          history: emptyHistory(),
        });
      } else {
        set({
          conflict: {
            relativePath: path,
            diskContents: content.contents,
            diskRevision: content.revision,
          },
        });
      }
    } catch (error) {
      set({ lastError: errorMessage(error) });
    }
  },

  resolveConflict: async (choice) => {
    const conflict = get().conflict;
    if (!conflict) return;
    if (choice === 'take-disk') {
      set({
        document: parseCanvas(conflict.diskContents),
        revision: conflict.diskRevision,
        history: emptyHistory(),
        dirty: false,
        conflict: null,
      });
      return;
    }
    // Keep the in-memory version: adopt the disk revision so the next write
    // succeeds, then write immediately.
    set({ revision: conflict.diskRevision, conflict: null, dirty: true });
    await get().save({ force: true });
  },

  clearError: () => set({ lastError: null }),
}));

/** Convenience helpers used by commands and node components. */

export const selectedNodes = (): CanvasNode[] => {
  const { document, selection } = useCanvasStore.getState();
  const ids = new Set(selection);
  return document.nodes.filter((node) => ids.has(node.id));
};

export const patchNode = (id: string, changes: Partial<CanvasNode>, mergeKey?: string): void => {
  useCanvasStore.getState().mutate(
    { type: 'patch-nodes', patches: [{ id, changes }] },
    mergeKey ? { mergeKey } : undefined,
  );
};

export const addNode = (node: CanvasNode): void => {
  useCanvasStore.getState().mutate({ type: 'insert-nodes', nodes: [node] });
};

export const addEdge = (edge: CanvasEdge): void => {
  useCanvasStore.getState().mutate({ type: 'insert-edges', edges: [edge] });
};

export const newEdgeId = createId;
