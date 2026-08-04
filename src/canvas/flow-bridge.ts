/**
 * Bridge between commands and the live React Flow instance.
 *
 * Commands must not import React Flow hooks, so the view publishes the
 * instance here when it mounts.
 */

import type { ReactFlowInstance } from '@xyflow/react';

import type { FlowEdge, FlowNode } from './canvas-adapter';

let instance: ReactFlowInstance<FlowNode, FlowEdge> | null = null;

export const setFlowInstance = (value: ReactFlowInstance<FlowNode, FlowEdge> | null): void => {
  instance = value;
};

export const flowInstance = (): ReactFlowInstance<FlowNode, FlowEdge> | null => instance;

/** Centre of the visible area, in canvas coordinates. */
export const viewportCenter = (): { x: number; y: number } => {
  const flow = instance;
  if (!flow) return { x: 0, y: 0 };
  const { x, y, zoom } = flow.getViewport();
  const width = window.innerWidth;
  const height = window.innerHeight;
  return {
    x: Math.round((-x + width / 2) / zoom),
    y: Math.round((-y + height / 2) / zoom),
  };
};

/** Position for a new node of the given size, centred in the viewport. */
export const centeredAt = (width: number, height: number): { x: number; y: number } => {
  const center = viewportCenter();
  return { x: Math.round(center.x - width / 2), y: Math.round(center.y - height / 2) };
};
