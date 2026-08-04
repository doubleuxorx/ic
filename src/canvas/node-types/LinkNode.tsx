/**
 * Link node — a JSON Canvas `link` node.
 *
 * The URL is shown as text and never fetched: the application makes no network
 * requests. Opening one hands it to the system browser through the validated
 * native command, after an explicit confirmation.
 */

import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';

import { promptFor } from '@/app/ui-store';
import type { FlowNode } from '@/canvas/canvas-adapter';
import { patchNode } from '@/canvas/canvas-store';
import type { LinkNode as LinkCanvasNode } from '@/shared/json-canvas';

import { openLinkDeliberately } from './MarkdownPreview';
import { NodeAction, NodeShell } from './NodeShell';
import { useNodeCommon } from './use-node-common';

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const LinkNodeComponent = ({ id, data, selected }: NodeProps<FlowNode>) => {
  const node = data.node as LinkCanvasNode;
  const { onResizeEnd, remove, chooseColor } = useNodeCommon(id);

  const editUrl = async () => {
    const next = await promptFor('Link address', { value: node.url, confirmLabel: 'Save' });
    if (next && next !== node.url) patchNode(id, { url: next });
  };

  return (
    <NodeShell
      node={node}
      selected={selected === true}
      active={data.active}
      className="link"
      onResizeEnd={onResizeEnd}
      header={<span className="name">{hostOf(node.url)}</span>}
      actions={
        <>
          <NodeAction icon="external" title="Open in browser" onClick={() => void openLinkDeliberately(node.url)} />
          <NodeAction icon="edit" title="Edit address" onClick={() => void editUrl()} />
          <NodeAction icon="palette" title="Colour" onClick={chooseColor} />
          <NodeAction icon="close" title="Delete" onClick={remove} />
        </>
      }
    >
      <div
        className="plain-text"
        style={{ alignItems: 'flex-start', color: 'var(--text-secondary)' }}
        onDoubleClick={(event) => {
          event.stopPropagation();
          void openLinkDeliberately(node.url);
        }}
      >
        {node.url}
      </div>
    </NodeShell>
  );
};

export const LinkNode = memo(LinkNodeComponent);
