/** Selection helpers shared by commands and the canvas view. */

import {
  boundingBox,
  createId,
  nodesInsideGroup,
  type CanvasDocument,
  type CanvasNode,
  type GroupNode,
} from '@/shared/json-canvas';

export const GROUP_PADDING = 32;
export const GROUP_HEADER = 28;

/** A group wrapping the given nodes with room for its label. */
export const groupAround = (nodes: CanvasNode[], label?: string): GroupNode | null => {
  const box = boundingBox(nodes);
  if (!box) return null;
  return {
    id: createId(),
    type: 'group',
    x: Math.round(box.x - GROUP_PADDING),
    y: Math.round(box.y - GROUP_PADDING - GROUP_HEADER),
    width: Math.round(box.width + GROUP_PADDING * 2),
    height: Math.round(box.height + GROUP_PADDING * 2 + GROUP_HEADER),
    ...(label ? { label } : {}),
  };
};

/** Nodes a group currently contains, resolved geometrically at call time. */
export const membersOf = (document: CanvasDocument, groupId: string): CanvasNode[] => {
  const group = document.nodes.find((node) => node.id === groupId);
  if (!group || group.type !== 'group') return [];
  return nodesInsideGroup(document, group);
};

/** Offset used when duplicating or pasting so copies are visible. */
export const PASTE_OFFSET = 32;

export const offsetNodes = (
  nodes: CanvasNode[],
  dx: number,
  dy: number,
): { nodes: CanvasNode[]; idMap: Map<string, string> } => {
  const idMap = new Map<string, string>();
  const copies = nodes.map((node) => {
    const id = createId();
    idMap.set(node.id, id);
    return { ...node, id, x: Math.round(node.x + dx), y: Math.round(node.y + dy) };
  });
  return { nodes: copies, idMap };
};
