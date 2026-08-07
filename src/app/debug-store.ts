/**
 * Debug mode.
 *
 * Off, the application shows nothing of itself. On, it keeps the status bar
 * visible with the build it is running, adds the numbers that are otherwise
 * invisible (node and edge counts, zoom, the active node), puts the internals
 * in the information panel, and publishes the stores on `window.ic` so they can
 * be inspected from the webview console. Nothing here changes behaviour — it
 * only makes the current state legible.
 *
 * The choice is remembered locally, so a debugging session survives a restart.
 */

import { create } from 'zustand';

import { useCanvasStore } from '@/canvas/canvas-store';
import { allCommands, runCommand } from '@/command-palette/command-registry';
import { useDocumentStore } from '@/editor/document-store';
import { useEditorSettings } from '@/editor/editor-settings';
import { useMediaStore } from '@/media/media-view-store';
import { BUILD } from '@/shared/build-info';
import { useThemeStore } from '@/theme/theme-store';
import { useWorkspaceStore } from '@/workspace/workspace-store';

import { useUiStore } from './ui-store';

const STORAGE_KEY = 'ic.debug';

const readStored = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    // Storage can be unavailable; debug mode is simply off.
    return false;
  }
};

/**
 * The stores, as the console sees them. Handles only: this hands out the same
 * objects the application uses rather than a copy, so `ic.canvas.getState()`
 * answers about the canvas that is actually on screen.
 */
const handles = () => ({
  build: BUILD,
  canvas: useCanvasStore,
  documents: useDocumentStore,
  editor: useEditorSettings,
  media: useMediaStore,
  theme: useThemeStore,
  ui: useUiStore,
  workspace: useWorkspaceStore,
  commands: allCommands,
  run: runCommand,
});

const apply = (enabled: boolean): void => {
  if (typeof document !== 'undefined') {
    if (enabled) document.documentElement.dataset.debug = 'on';
    else delete document.documentElement.dataset.debug;
  }
  if (typeof window === 'undefined') return;
  const global = window as typeof window & { ic?: ReturnType<typeof handles> };
  if (enabled) global.ic = handles();
  else delete global.ic;
};

interface DebugStore {
  enabled: boolean;
  set: (enabled: boolean) => void;
  toggle: () => void;
}

export const useDebugStore = create<DebugStore>((set, get) => ({
  enabled: false,
  set: (enabled) => {
    apply(enabled);
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
    } catch {
      // Persisting is best-effort; the session still honours the choice.
    }
    set({ enabled });
  },
  toggle: () => get().set(!get().enabled),
}));

/** Called once at startup, before React renders. */
export const initDebug = (): void => {
  const enabled = readStored();
  apply(enabled);
  useDebugStore.setState({ enabled });
};
