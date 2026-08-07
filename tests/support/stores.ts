/**
 * Putting the stores back how they started.
 *
 * Zustand stores are module singletons, so one test's canvas is the next test's
 * canvas unless something resets them. The initial state is captured here at
 * import time, before any test has touched it, and restored wholesale — actions
 * included, since in these stores the actions live in the state.
 */

import type { StoreApi } from 'zustand';

import { useDebugStore } from '@/app/debug-store';
import { useUiStore } from '@/app/ui-store';
import { useCanvasStore } from '@/canvas/canvas-store';
import { setFlowInstance } from '@/canvas/flow-bridge';
import { useDocumentStore } from '@/editor/document-store';
import { useEditorSettings } from '@/editor/editor-settings';
import { useMediaStore } from '@/media/media-view-store';
import { useThemeStore } from '@/theme/theme-store';
import { useWorkspaceStore } from '@/workspace/workspace-store';

const stores = [
  useUiStore,
  useDebugStore,
  useCanvasStore,
  useDocumentStore,
  useEditorSettings,
  useMediaStore,
  useThemeStore,
  useWorkspaceStore,
] as unknown as Array<StoreApi<Record<string, unknown>>>;

const initial = stores.map((store) => ({ ...store.getState() }));

export const resetStores = (): void => {
  stores.forEach((store, index) => store.setState(initial[index] as never, true));
  // Debug mode also puts things outside the store — an attribute on the
  // document and the handles on `window` — so it is turned off through its own
  // action rather than by restoring its state.
  useDebugStore.getState().set(false);
  setFlowInstance(null);
};

/**
 * A canvas instance that answers the view commands without React Flow.
 *
 * The real one is published by the canvas view when it mounts; commands only ever
 * reach it through `flow-bridge`, so this is the whole surface they use.
 */
export interface FlowCalls {
  zoomIn: number;
  zoomOut: number;
  fitView: number;
  viewport: { x: number; y: number; zoom: number };
}

export const installFlow = (): FlowCalls => {
  const calls: FlowCalls = { zoomIn: 0, zoomOut: 0, fitView: 0, viewport: { x: 0, y: 0, zoom: 1 } };
  setFlowInstance({
    zoomIn: () => {
      calls.zoomIn += 1;
    },
    zoomOut: () => {
      calls.zoomOut += 1;
    },
    fitView: () => {
      calls.fitView += 1;
      return true;
    },
    getViewport: () => calls.viewport,
    setViewport: (viewport: { x: number; y: number; zoom: number }) => {
      calls.viewport = viewport;
    },
  } as never);
  return calls;
};
