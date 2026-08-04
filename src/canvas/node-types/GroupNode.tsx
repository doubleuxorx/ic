/**
 * Group node — a JSON Canvas `group` node.
 *
 * Groups are visual containers with no parent references in the format:
 * membership is geometric. Dragging a group therefore moves whatever it
 * currently contains, which is computed at drag start in `CanvasView`.
 */

import { memo, useState } from 'react';
import type { NodeProps } from '@xyflow/react';

import type { FlowNode } from '@/canvas/canvas-adapter';
import { patchNode } from '@/canvas/canvas-store';
import type { GroupNode as GroupCanvasNode } from '@/shared/json-canvas';
import { resolveColor } from '@/theme/theme-store';

import { NodeAction, NodeShell } from './NodeShell';
import { useNodeCommon } from './use-node-common';

const GroupNodeComponent = ({ id, data, selected }: NodeProps<FlowNode>) => {
  const node = data.node as GroupCanvasNode;
  const { onResizeEnd, remove, chooseColor } = useNodeCommon(id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.label ?? '');

  const commit = () => {
    setEditing(false);
    const label = draft.trim();
    if (label !== (node.label ?? '')) {
      patchNode(id, label.length > 0 ? { label } : { label: undefined });
    }
  };

  return (
    <NodeShell
      node={node}
      selected={selected === true}
      active={data.active}
      className="group"
      minWidth={160}
      minHeight={120}
      onResizeEnd={onResizeEnd}
      actions={
        <>
          <NodeAction
            icon="edit"
            title="Rename group"
            onClick={() => {
              setDraft(node.label ?? '');
              setEditing(true);
            }}
          />
          <NodeAction icon="palette" title="Colour" onClick={chooseColor} />
          <NodeAction icon="close" title="Delete group" onClick={remove} />
        </>
      }
    >
      <div
        className="group-label"
        style={resolveColor(node.color) ? { color: resolveColor(node.color) as string } : undefined}
        onDoubleClick={(event) => {
          event.stopPropagation();
          setDraft(node.label ?? '');
          setEditing(true);
        }}
      >
        {editing ? (
          <input
            className="nodrag"
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') commit();
              if (event.key === 'Escape') setEditing(false);
            }}
            onPointerDown={(event) => event.stopPropagation()}
          />
        ) : (
          (node.label ?? 'Group')
        )}
      </div>
    </NodeShell>
  );
};

export const GroupNode = memo(GroupNodeComponent);
