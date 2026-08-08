/**
 * Inline text node — a JSON Canvas `text` node.
 *
 * The same node type backs both Markdown cards and plain title boxes: whether
 * the content looks like prose or a single unformatted line decides how it is
 * presented. No proprietary typography metadata is stored, so the node stays
 * portable.
 */

import { memo, useCallback } from 'react';
import type { NodeProps } from '@xyflow/react';

import { MarkdownEditor } from '@/editor/MarkdownEditor';
import { patchNode, useCanvasStore } from '@/canvas/canvas-store';
import type { FlowNode } from '@/canvas/canvas-adapter';
import { contentScale, type TextNode as TextCanvasNode } from '@/shared/json-canvas';

import { MarkdownPreview } from './MarkdownPreview';
import { NodeAction, NodeShell } from './NodeShell';
import { useNodeCommon } from './use-node-common';

/** A short single line without Markdown syntax reads as a title, not prose. */
const MARKDOWN_SYNTAX = /[*_`#>[\]!|]|^\s*[-+]\s|^\s*\d+\.\s/m;

export const looksLikeTitle = (text: string): boolean => {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.includes('\n')) return false;
  return !MARKDOWN_SYNTAX.test(trimmed) && trimmed.length <= 80;
};

const TextNodeComponent = ({ id, data, selected }: NodeProps<FlowNode>) => {
  const node = data.node as TextCanvasNode;
  const active = data.active;
  const setActiveNode = useCanvasStore((state) => state.setActiveNode);
  const { onResizeEnd, remove, chooseColor } = useNodeCommon(id);

  const onChange = useCallback(
    (text: string) => patchNode(id, { text }, `text:${id}`),
    [id],
  );

  const title = looksLikeTitle(node.text);

  return (
    <NodeShell
      node={node}
      selected={selected === true}
      active={active}
      className="text"
      onResizeEnd={onResizeEnd}
      actions={
        active ? null : (
          <>
            <NodeAction icon="edit" title="Edit (Enter)" onClick={() => setActiveNode(id)} />
            <NodeAction icon="palette" title="Colour" onClick={chooseColor} />
            <NodeAction icon="close" title="Delete" onClick={remove} />
          </>
        )
      }
    >
      {active ? (
        <MarkdownEditor
          value={node.text}
          onChange={onChange}
          onExit={() => setActiveNode(null)}
          onSave={() => void useCanvasStore.getState().save({ force: true })}
        />
      ) : (
        <div onDoubleClick={() => setActiveNode(id)} style={{ height: '100%' }}>
          {title ? (
            <div
              className="plain-text title"
              // Against the height the contents are laid out at, which is the
              // node's own height only while it is drawn at normal size.
              style={{ fontSize: sizeForTitle(node.height / contentScale(node)) }}
            >
              {node.text}
            </div>
          ) : (
            <MarkdownPreview source={node.text} scrollable={selected === true} />
          )}
        </div>
      )}
    </NodeShell>
  );
};

/** Title boxes scale with their node so a heading stays legible when zoomed out. */
const sizeForTitle = (height: number): string => {
  const size = Math.max(14, Math.min(48, Math.round(height * 0.35)));
  return `${size}px`;
};

export const TextNode = memo(TextNodeComponent);
