/**
 * Adapters between the canonical JSON Canvas document and React Flow.
 *
 * React Flow-specific fields exist only on this side of the boundary. Nothing
 * produced here is ever written back into a `.canvas` file.
 */

import { MarkerType, type Edge, type EdgeMarker, type Node } from '@xyflow/react';

import type { CanvasDocument, CanvasEdge, CanvasNode, NodeSide } from '@/shared/json-canvas';
import { resolveColor } from '@/theme/theme-store';

export interface FlowNodeData extends Record<string, unknown> {
  node: CanvasNode;
  active: boolean;
}

export interface FlowEdgeData extends Record<string, unknown> {
  edge: CanvasEdge;
}

export type FlowNode = Node<FlowNodeData>;
export type FlowEdge = Edge<FlowEdgeData>;

export const NODE_COMPONENT_BY_TYPE: Record<CanvasNode['type'], string> = {
  text: 'text',
  file: 'file',
  link: 'link',
  group: 'group',
};

/**
 * Selection is deliberately absent here: React Flow owns which elements are
 * selected, and re-deriving it from the document would make the two overwrite
 * each other. `CanvasView` carries the existing flags across a rebuild.
 */
export const toFlowNodes = (
  document: CanvasDocument,
  options: { activeNodeId: string | null },
): FlowNode[] => {
  const count = document.nodes.length;
  return document.nodes.map((node, index) => ({
    id: node.id,
    type: NODE_COMPONENT_BY_TYPE[node.type],
    position: { x: node.x, y: node.y },
    width: node.width,
    height: node.height,
    selected: false,
    // Array order is z-order. Groups stay behind ordinary nodes while keeping
    // their relative order among themselves.
    zIndex: node.type === 'group' ? index - count : index,
    // A node being edited must not be dragged by the same pointer gesture.
    draggable: options.activeNodeId !== node.id,
    data: { node, active: options.activeNodeId === node.id },
    selectable: true,
  }));
};

/** Choose the side an edge leaves from when the file does not specify one. */
export const inferSides = (
  from: CanvasNode,
  to: CanvasNode,
): { fromSide: NodeSide; toSide: NodeSide } => {
  const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromSide: 'right', toSide: 'left' } : { fromSide: 'left', toSide: 'right' };
  }
  return dy >= 0 ? { fromSide: 'bottom', toSide: 'top' } : { fromSide: 'top', toSide: 'bottom' };
};

/** `toEnd` defaults to an arrow, `fromEnd` to nothing, per the specification. */
const marker = (
  end: CanvasEdge['toEnd'],
  fallback: 'none' | 'arrow',
  color: string | null,
): EdgeMarker | undefined =>
  (end ?? fallback) === 'arrow'
    ? {
        type: MarkerType.ArrowClosed,
        width: 16,
        height: 16,
        color: color ?? 'var(--edge)',
      }
    : undefined;

export const toFlowEdges = (document: CanvasDocument): FlowEdge[] => {
  const byId = new Map(document.nodes.map((node) => [node.id, node]));
  const edges: FlowEdge[] = [];
  for (const edge of document.edges) {
    const from = byId.get(edge.fromNode);
    const to = byId.get(edge.toNode);
    if (!from || !to) continue;
    const inferred = inferSides(from, to);
    const color = resolveColor(edge.color);
    const markerStart = marker(edge.fromEnd, 'none', color);
    const markerEnd = marker(edge.toEnd, 'arrow', color);
    edges.push({
      id: edge.id,
      source: edge.fromNode,
      target: edge.toNode,
      sourceHandle: edge.fromSide ?? inferred.fromSide,
      targetHandle: edge.toSide ?? inferred.toSide,
      type: 'canvas',
      selected: false,
      data: { edge },
      zIndex: 1,
      ...(markerStart ? { markerStart } : {}),
      ...(markerEnd ? { markerEnd } : {}),
    });
  }
  return edges;
};

/** React Flow handle ids are the JSON Canvas side names. */
export const asSide = (handle: string | null | undefined): NodeSide | undefined =>
  handle === 'top' || handle === 'right' || handle === 'bottom' || handle === 'left'
    ? handle
    : undefined;

export const DEFAULT_SIZES: Record<CanvasNode['type'], { width: number; height: number }> = {
  text: { width: 320, height: 180 },
  file: { width: 400, height: 340 },
  link: { width: 400, height: 260 },
  group: { width: 640, height: 460 },
};
