/**
 * Node and edge component registries.
 *
 * These objects are module constants so React Flow never sees a new identity
 * on re-render, which would remount every node on the canvas.
 */

import type { EdgeTypes, NodeTypes } from '@xyflow/react';

import { CanvasEdge } from './CanvasEdge';
import { FileNode } from './FileNode';
import { GroupNode } from './GroupNode';
import { LinkNode } from './LinkNode';
import { TextNode } from './TextNode';

export const nodeTypes: NodeTypes = {
  text: TextNode,
  file: FileNode,
  link: LinkNode,
  group: GroupNode,
};

export const edgeTypes: EdgeTypes = {
  canvas: CanvasEdge,
};

export { TextNode, FileNode, LinkNode, GroupNode, CanvasEdge };
