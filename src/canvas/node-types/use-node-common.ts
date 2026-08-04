/** Behaviour every node shares: geometry commits, colour and deletion. */

import { useCallback } from 'react';

import { pickColor } from '@/app/ui-store';
import { patchNode, useCanvasStore } from '@/canvas/canvas-store';

export const useNodeCommon = (id: string) => {
  /** Geometry is written once, when the gesture ends. */
  const onResizeEnd = useCallback(
    (rect: { x: number; y: number; width: number; height: number }) => {
      patchNode(id, {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    },
    [id],
  );

  const remove = useCallback(() => {
    useCanvasStore.getState().mutate({ type: 'delete-nodes', ids: [id] });
  }, [id]);

  const chooseColor = useCallback(async () => {
    const color = await pickColor('Node colour');
    if (color === undefined) return;
    patchNode(id, color === null ? { color: undefined } : { color });
  }, [id]);

  return { onResizeEnd, remove, chooseColor };
};
