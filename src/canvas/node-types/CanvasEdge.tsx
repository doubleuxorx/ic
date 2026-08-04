/**
 * Edge rendering.
 *
 * Arrow ends, colour and label all round-trip through the JSON Canvas fields;
 * nothing about an edge is stored outside the document. The label is editable
 * in place because relationship descriptions are the point of most arrows.
 */

import { memo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';

import type { FlowEdge } from '@/canvas/canvas-adapter';
import { useCanvasStore } from '@/canvas/canvas-store';
import { resolveColor } from '@/theme/theme-store';

const CanvasEdgeComponent = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  markerStart,
  markerEnd,
}: EdgeProps<FlowEdge>) => {
  const edge = data?.edge;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(edge?.label ?? '');

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const color = resolveColor(edge?.color);

  const commit = () => {
    setEditing(false);
    const label = draft.trim();
    if (!edge || label === (edge.label ?? '')) return;
    useCanvasStore.getState().mutate({
      type: 'patch-edges',
      patches: [{ id, changes: label.length > 0 ? { label } : { label: undefined } }],
    });
  };

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        style={color ? { stroke: color } : undefined}
      />
      {edge?.label || editing || selected ? (
        <EdgeLabelRenderer>
          <div
            className={`edge-label nodrag nopan ${editing ? 'editing' : ''}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              ...(color ? { borderColor: color } : {}),
              ...(!edge?.label && !editing ? { opacity: 0.35 } : {}),
            }}
            onDoubleClick={(event) => {
              event.stopPropagation();
              setDraft(edge?.label ?? '');
              setEditing(true);
            }}
          >
            {editing ? (
              <input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') commit();
                  if (event.key === 'Escape') setEditing(false);
                }}
              />
            ) : (
              (edge?.label ?? 'label')
            )}
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
};

export const CanvasEdge = memo(CanvasEdgeComponent);
