/**
 * The extra status-bar fields debug mode adds.
 *
 * Kept in its own component because it subscribes to the viewport, which
 * changes on every pan and zoom: with debug mode off this is not rendered at
 * all and the shell re-renders no more often than it did before.
 */

import { useViewport } from '@xyflow/react';

import { useCanvasStore } from '@/canvas/canvas-store';
import { versionLabel } from '@/shared/build-info';
import { useWorkspaceStore } from '@/workspace/workspace-store';

export const DebugStatus = () => {
  const { zoom } = useViewport();
  const document = useCanvasStore((state) => state.document);
  const activeNodeId = useCanvasStore((state) => state.activeNodeId);
  // On the desktop the installed version is the one that matters; the bundle's
  // is the answer in a browser.
  const version = useWorkspaceStore((state) => state.facts?.version);

  return (
    <>
      <span className="debug">{versionLabel(version)}</span>
      <span className="debug">
        {document.nodes.length}n {document.edges.length}e
      </span>
      <span className="debug">{Math.round(zoom * 100)}%</span>
      {activeNodeId ? <span className="debug">editing {activeNodeId}</span> : null}
    </>
  );
};
