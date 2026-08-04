/**
 * Operation-based undo/redo.
 *
 * Every mutation of the canonical document goes through an operation that can
 * be inverted against the document it was applied to. Undo therefore never
 * snapshots the whole canvas, and geometry is only recorded at the end of a
 * drag or resize.
 */

import type { CanvasDocument, CanvasEdge, CanvasNode } from '@/shared/json-canvas';

export interface NodePatch {
  id: string;
  changes: Partial<CanvasNode>;
}

export interface EdgePatch {
  id: string;
  changes: Partial<CanvasEdge>;
}

export type CanvasOp =
  | { type: 'insert-nodes'; nodes: CanvasNode[]; at?: number }
  | { type: 'delete-nodes'; ids: string[] }
  | { type: 'patch-nodes'; patches: NodePatch[] }
  | { type: 'insert-edges'; edges: CanvasEdge[] }
  | { type: 'delete-edges'; ids: string[] }
  | { type: 'patch-edges'; patches: EdgePatch[] }
  | { type: 'reorder-nodes'; order: string[] }
  | { type: 'batch'; ops: CanvasOp[] };

const withNodes = (document: CanvasDocument, nodes: CanvasNode[]): CanvasDocument => ({
  ...document,
  nodes,
});

const withEdges = (document: CanvasDocument, edges: CanvasEdge[]): CanvasDocument => ({
  ...document,
  edges,
});

export const applyOp = (document: CanvasDocument, op: CanvasOp): CanvasDocument => {
  switch (op.type) {
    case 'insert-nodes': {
      const nodes = [...document.nodes];
      const at = op.at ?? nodes.length;
      nodes.splice(Math.min(Math.max(at, 0), nodes.length), 0, ...op.nodes);
      return withNodes(document, nodes);
    }
    case 'delete-nodes': {
      const ids = new Set(op.ids);
      // Edges referencing removed nodes cannot survive: the format forbids them.
      const edges = document.edges.filter((e) => !ids.has(e.fromNode) && !ids.has(e.toNode));
      return {
        ...document,
        nodes: document.nodes.filter((n) => !ids.has(n.id)),
        edges,
      };
    }
    case 'patch-nodes': {
      const byId = new Map(op.patches.map((p) => [p.id, p.changes]));
      return withNodes(
        document,
        document.nodes.map((node) => {
          const changes = byId.get(node.id);
          return changes ? ({ ...node, ...changes } as CanvasNode) : node;
        }),
      );
    }
    case 'insert-edges':
      return withEdges(document, [...document.edges, ...op.edges]);
    case 'delete-edges': {
      const ids = new Set(op.ids);
      return withEdges(
        document,
        document.edges.filter((edge) => !ids.has(edge.id)),
      );
    }
    case 'patch-edges': {
      const byId = new Map(op.patches.map((p) => [p.id, p.changes]));
      return withEdges(
        document,
        document.edges.map((edge) => {
          const changes = byId.get(edge.id);
          return changes ? { ...edge, ...changes } : edge;
        }),
      );
    }
    case 'reorder-nodes': {
      const byId = new Map(document.nodes.map((node) => [node.id, node]));
      const ordered: CanvasNode[] = [];
      for (const id of op.order) {
        const node = byId.get(id);
        if (node) {
          ordered.push(node);
          byId.delete(id);
        }
      }
      // Anything not mentioned keeps its relative order at the end.
      for (const node of document.nodes) if (byId.has(node.id)) ordered.push(node);
      return withNodes(document, ordered);
    }
    case 'batch':
      return op.ops.reduce(applyOp, document);
  }
};

/** Build the operation that undoes `op` when applied to the result of `op`. */
export const invertOp = (before: CanvasDocument, op: CanvasOp): CanvasOp => {
  switch (op.type) {
    case 'insert-nodes':
      return { type: 'delete-nodes', ids: op.nodes.map((node) => node.id) };
    case 'delete-nodes': {
      const ids = new Set(op.ids);
      const ops: CanvasOp[] = [];
      before.nodes.forEach((node, index) => {
        if (ids.has(node.id)) ops.push({ type: 'insert-nodes', nodes: [node], at: index });
      });
      const removedEdges = before.edges.filter((e) => ids.has(e.fromNode) || ids.has(e.toNode));
      if (removedEdges.length > 0) ops.push({ type: 'insert-edges', edges: removedEdges });
      return { type: 'batch', ops };
    }
    case 'patch-nodes': {
      const byId = new Map(before.nodes.map((node) => [node.id, node]));
      const patches: NodePatch[] = [];
      for (const patch of op.patches) {
        const node = byId.get(patch.id);
        if (!node) continue;
        const changes: Record<string, unknown> = {};
        for (const key of Object.keys(patch.changes)) {
          changes[key] = (node as unknown as Record<string, unknown>)[key];
        }
        patches.push({ id: patch.id, changes: changes as Partial<CanvasNode> });
      }
      return { type: 'patch-nodes', patches };
    }
    case 'insert-edges':
      return { type: 'delete-edges', ids: op.edges.map((edge) => edge.id) };
    case 'delete-edges': {
      const ids = new Set(op.ids);
      return { type: 'insert-edges', edges: before.edges.filter((edge) => ids.has(edge.id)) };
    }
    case 'patch-edges': {
      const byId = new Map(before.edges.map((edge) => [edge.id, edge]));
      const patches: EdgePatch[] = [];
      for (const patch of op.patches) {
        const edge = byId.get(patch.id);
        if (!edge) continue;
        const changes: Record<string, unknown> = {};
        for (const key of Object.keys(patch.changes)) {
          changes[key] = (edge as unknown as Record<string, unknown>)[key];
        }
        patches.push({ id: patch.id, changes: changes as Partial<CanvasEdge> });
      }
      return { type: 'patch-edges', patches };
    }
    case 'reorder-nodes':
      return { type: 'reorder-nodes', order: before.nodes.map((node) => node.id) };
    case 'batch': {
      // Invert each step against the document state it actually saw.
      const inverses: CanvasOp[] = [];
      let state = before;
      for (const step of op.ops) {
        inverses.unshift(invertOp(state, step));
        state = applyOp(state, step);
      }
      return { type: 'batch', ops: inverses };
    }
  }
};

export interface HistoryEntry {
  op: CanvasOp;
  inverse: CanvasOp;
  /** Consecutive entries sharing a merge key within the window are coalesced. */
  mergeKey?: string;
  at: number;
}

export interface History {
  past: HistoryEntry[];
  future: HistoryEntry[];
}

export const emptyHistory = (): History => ({ past: [], future: [] });

/** Typing in one node should not produce one undo step per keystroke. */
export const MERGE_WINDOW_MS = 700;
const HISTORY_LIMIT = 500;

export const pushHistory = (history: History, entry: HistoryEntry): History => {
  const last = history.past[history.past.length - 1];
  if (
    last &&
    entry.mergeKey !== undefined &&
    last.mergeKey === entry.mergeKey &&
    entry.at - last.at < MERGE_WINDOW_MS
  ) {
    const merged: HistoryEntry = {
      op: { type: 'batch', ops: [last.op, entry.op] },
      // The older inverse must run last when undoing the merged step.
      inverse: { type: 'batch', ops: [entry.inverse, last.inverse] },
      mergeKey: entry.mergeKey,
      at: entry.at,
    };
    return { past: [...history.past.slice(0, -1), merged], future: [] };
  }
  const past = [...history.past, entry];
  return { past: past.slice(-HISTORY_LIMIT), future: [] };
};
