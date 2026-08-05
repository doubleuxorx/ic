/**
 * Edge rendering.
 *
 * Arrow ends, colour and label all round-trip through the JSON Canvas fields;
 * nothing about an edge is stored outside the document. The label is editable
 * in place because relationship descriptions are the point of most arrows.
 *
 * Arrowheads are drawn here rather than left to an SVG marker, because a marker
 * can only be turned by the tangent at the very endpoint and that is not the
 * direction the line appears to arrive from. See `edge-geometry`.
 */

import { memo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, type EdgeProps } from '@xyflow/react';

import { asSide, hasArrow, type FlowEdge } from '@/canvas/canvas-adapter';
import { useCanvasStore } from '@/canvas/canvas-store';
import { ARROW_LENGTH, ARROW_SPREAD, edgeCurve } from '@/canvas/edge-geometry';
import { resolveColor } from '@/theme/theme-store';

const ArrowHead = ({
  x,
  y,
  angle,
  color,
}: {
  x: number;
  y: number;
  angle: number;
  color: string | null;
}) => (
  <path
    className="edge-arrow"
    d={`M${-ARROW_LENGTH},${-ARROW_SPREAD} L0,0 L${-ARROW_LENGTH},${ARROW_SPREAD}`}
    transform={`translate(${x} ${y}) rotate(${angle})`}
    style={color ? { stroke: color } : undefined}
  />
);

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
}: EdgeProps<FlowEdge>) => {
  const edge = data?.edge;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(edge?.label ?? '');

  const {
    path,
    label: labelPoint,
    fromAngle,
    toAngle,
  } = edgeCurve(
    { x: sourceX, y: sourceY },
    asSide(sourcePosition) ?? 'bottom',
    { x: targetX, y: targetY },
    asSide(targetPosition) ?? 'top',
  );
  const labelX = labelPoint.x;
  const labelY = labelPoint.y;

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
      <BaseEdge id={id} path={path} style={color ? { stroke: color } : undefined} />
      {hasArrow(edge?.fromEnd, 'none') ? (
        <ArrowHead x={sourceX} y={sourceY} angle={fromAngle} color={color} />
      ) : null}
      {hasArrow(edge?.toEnd, 'arrow') ? (
        <ArrowHead x={targetX} y={targetY} angle={toAngle} color={color} />
      ) : null}
      {edge?.label || editing || selected ? (
        <EdgeLabelRenderer>
          <div
            className={`edge-label nodrag nopan ${editing ? 'editing' : ''}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              ...(color ? { borderColor: color } : {}),
              ...(!edge?.label && !editing ? { opacity: 0.35 } : {}),
            }}
            // A single click, not a double one. The chip is only on screen
            // when the edge is selected or already carries text, so a click on
            // it can mean nothing except "edit this label".
            onClick={(event) => {
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
