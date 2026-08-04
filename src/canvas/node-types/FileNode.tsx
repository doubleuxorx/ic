/**
 * File node — a JSON Canvas `file` node referencing a workspace file.
 *
 * The kind is taken from verified facts (content sniffing in Rust), not from
 * the extension, and decides which view is mounted. Inactive nodes show a
 * lightweight preview; only the active node mounts an editor or a full viewer.
 */

import { memo } from 'react';
import type { NodeProps } from '@xyflow/react';

import { toast } from '@/app/ui-store';
import type { FlowNode } from '@/canvas/canvas-adapter';
import { useCanvasStore } from '@/canvas/canvas-store';
import { AudioNode } from '@/media/AudioNode';
import { PdfNode } from '@/media/PdfNode';
import { ImageNode } from '@/media/ImageNode';
import { VideoNode } from '@/media/VideoNode';
import { formatBytes, useFileFacts } from '@/media/media-view-store';
import { errorMessage } from '@/shared/errors';
import { ipc } from '@/shared/ipc-types';
import type { FileNode as FileCanvasNode } from '@/shared/json-canvas';
import { baseName, parentDirectory } from '@/workspace/workspace-store';

import { MarkdownFileView } from './MarkdownFileView';
import { NodeAction, NodeShell } from './NodeShell';
import { useNodeCommon } from './use-node-common';

const FileNodeComponent = ({ id, data, selected }: NodeProps<FlowNode>) => {
  const node = data.node as FileCanvasNode;
  const active = data.active;
  const setActiveNode = useCanvasStore((state) => state.setActiveNode);
  const { onResizeEnd, remove, chooseColor } = useNodeCommon(id);
  const { facts, error } = useFileFacts(node.file);

  const kind = facts?.kind ?? 'unsupported';
  const name = baseName(node.file);

  const body = (() => {
    if (error) return <div className="placeholder">{error}</div>;
    if (!facts) return <div className="placeholder">Reading file</div>;
    switch (kind) {
      case 'markdown':
      case 'text':
        return (
          <MarkdownFileView
            relativePath={node.file}
            subpath={node.subpath}
            active={active}
            plain={kind === 'text'}
          />
        );
      case 'image':
        return <ImageNode nodeId={id} relativePath={node.file} active={active} alt={name} />;
      case 'pdf':
        return (
          <PdfNode
            relativePath={node.file}
            active={active}
            width={node.width}
            height={node.height}
          />
        );
      case 'video':
        return <VideoNode nodeId={id} relativePath={node.file} active={active} />;
      case 'audio':
        return <AudioNode nodeId={id} relativePath={node.file} active={active} />;
      default:
        return (
          <div className="placeholder">
            {name}
            <br />
            {formatBytes(facts.size)} — no in-canvas view for this type
          </div>
        );
    }
  })();

  const openExternally = () => {
    void ipc.openPath(node.file).catch((openError) => toast(errorMessage(openError), 'error'));
  };

  return (
    <NodeShell
      node={node}
      selected={selected === true}
      active={active}
      className={`file ${kind}`}
      onResizeEnd={onResizeEnd}
      header={
        <>
          <span className="name" title={node.file}>
            {name}
            {node.subpath ? <span style={{ opacity: 0.7 }}> {node.subpath}</span> : null}
          </span>
          <span style={{ marginLeft: 'auto', opacity: 0.7 }}>{parentDirectory(node.file)}</span>
        </>
      }
      actions={
        active ? (
          <NodeAction icon="close" title="Done (Escape)" onClick={() => setActiveNode(null)} />
        ) : (
          <>
            <NodeAction icon="edit" title="Activate (Enter)" onClick={() => setActiveNode(id)} />
            <NodeAction icon="external" title="Open externally" onClick={openExternally} />
            <NodeAction icon="palette" title="Colour" onClick={chooseColor} />
            <NodeAction icon="close" title="Remove from canvas" onClick={remove} />
          </>
        )
      }
    >
      <div
        style={{ height: '100%' }}
        onDoubleClick={() => setActiveNode(id)}
      >
        {body}
      </div>
    </NodeShell>
  );
};

export const FileNode = memo(FileNodeComponent);
