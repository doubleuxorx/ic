/**
 * The canvas. It is the entire application surface: there is no sidebar, no
 * toolbar and no menu bar. Controls appear on hover, and everything else is
 * reachable from the command palette.
 *
 * Interaction state lives in React Flow; the canonical document is only written
 * when a gesture completes, so dragging never serializes a canvas per frame.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  MiniMap,
  ReactFlow,
  SelectionMode,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  useStore,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type OnSelectionChangeParams,
  type Viewport,
} from '@xyflow/react';

import '@xyflow/react/dist/base.css';

import { createId, type CanvasNode } from '@/shared/json-canvas';
import { useUiStore } from '@/app/ui-store';

import {
  asSide,
  toFlowEdges,
  toFlowNodes,
  type FlowEdge,
  type FlowNode,
} from './canvas-adapter';
import { useCanvasStore } from './canvas-store';
import { edgeTypes, nodeTypes } from './node-types';
import { membersOf } from './selection';
import { correctWheel } from './wheel';
import { MAX_ZOOM, MIN_ZOOM, backgroundGrid } from './zoom';

// Stable identities: React Flow re-registers listeners when these props change,
// so they must not be rebuilt on every render.
const MULTI_SELECTION_KEYS = ['Shift', 'Meta', 'Control'];
/** Middle and right button pan; left is left free for selection. */
const PAN_BUTTONS = [1, 2];
const PRO_OPTIONS = { hideAttribution: true };

/**
 * The dot grid, respaced as the canvas scales. It subscribes to the transform
 * on its own so that a zoom gesture repaints the background without rebuilding
 * the node list.
 */
const CanvasBackground = () => {
  const zoom = useStore((state) => state.transform[2]);
  const { gap, size } = backgroundGrid(zoom);
  return <Background variant={BackgroundVariant.Dots} gap={gap} size={size} />;
};

interface DragContext {
  /** Group members captured at drag start, with their original positions. */
  members: Map<string, { x: number; y: number }>;
  origin: { x: number; y: number };
}

export const CanvasView = ({ showMinimap }: { showMinimap: boolean }) => {
  const document = useCanvasStore((state) => state.document);
  const selectionRequest = useCanvasStore((state) => state.selectionRequest);
  const activeNodeId = useCanvasStore((state) => state.activeNodeId);
  const reportSelection = useCanvasStore((state) => state.reportSelection);
  const setActiveNode = useCanvasStore((state) => state.setActiveNode);
  const mutate = useCanvasStore((state) => state.mutate);
  const setViewport = useCanvasStore((state) => state.setViewport);
  const storedViewport = useCanvasStore((state) => state.viewport);

  const flow = useReactFlow<FlowNode, FlowEdge>();
  const drag = useRef<DragContext | null>(null);
  const wrapper = useRef<HTMLDivElement | null>(null);

  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);

  // The document is authoritative for everything except which elements are
  // selected, so a rebuild carries the current selection flags across.
  const nextNodes = useMemo(
    () => toFlowNodes(document, { activeNodeId }),
    [document, activeNodeId],
  );
  const nextEdges = useMemo(() => toFlowEdges(document), [document]);

  useEffect(() => {
    setNodes((current) => {
      const selected = new Set(current.filter((node) => node.selected).map((node) => node.id));
      return nextNodes.map((node) =>
        selected.has(node.id) ? { ...node, selected: true } : node,
      );
    });
  }, [nextNodes]);

  useEffect(() => {
    setEdges((current) => {
      const selected = new Set(current.filter((edge) => edge.selected).map((edge) => edge.id));
      return nextEdges.map((edge) =>
        selected.has(edge.id) ? { ...edge, selected: true } : edge,
      );
    });
  }, [nextEdges]);

  // A selection asked for by a command. Nothing React Flow reports can reach
  // here, so applying it cannot start a cycle.
  useEffect(() => {
    if (!selectionRequest) return;
    const wantedNodes = new Set(selectionRequest.ids);
    const wantedEdges = new Set(selectionRequest.edgeIds);
    setNodes((current) =>
      current.map((node) =>
        node.selected === wantedNodes.has(node.id)
          ? node
          : { ...node, selected: wantedNodes.has(node.id) },
      ),
    );
    setEdges((current) =>
      current.map((edge) =>
        edge.selected === wantedEdges.has(edge.id)
          ? edge
          : { ...edge, selected: wantedEdges.has(edge.id) },
      ),
    );
  }, [selectionRequest]);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const onSelectionChange = useCallback(
    ({ nodes: selectedNodes, edges: selectedFlowEdges }: OnSelectionChangeParams) => {
      reportSelection(
        selectedNodes.map((node) => node.id),
        selectedFlowEdges.map((edge) => edge.id),
      );
    },
    [reportSelection],
  );

  /** Dragging a group carries whatever it geometrically contains. */
  const onNodeDragStart = useCallback(
    (_: unknown, node: FlowNode) => {
      const canvasNode = node.data.node;
      if (canvasNode.type !== 'group') {
        drag.current = null;
        return;
      }
      const members = new Map<string, { x: number; y: number }>();
      for (const member of membersOf(useCanvasStore.getState().document, node.id)) {
        members.set(member.id, { x: member.x, y: member.y });
      }
      drag.current = { members, origin: { x: canvasNode.x, y: canvasNode.y } };
    },
    [],
  );

  const onNodeDrag = useCallback((_: unknown, node: FlowNode) => {
    const context = drag.current;
    if (!context || context.members.size === 0) return;
    const dx = node.position.x - context.origin.x;
    const dy = node.position.y - context.origin.y;
    setNodes((current) =>
      current.map((candidate) => {
        const start = context.members.get(candidate.id);
        return start ? { ...candidate, position: { x: start.x + dx, y: start.y + dy } } : candidate;
      }),
    );
  }, []);

  /** Geometry reaches the document once, at the end of the gesture. */
  const onNodeDragStop = useCallback(
    (_: unknown, node: FlowNode, dragged: FlowNode[]) => {
      const moved = new Map<string, { x: number; y: number }>();
      for (const candidate of dragged.length > 0 ? dragged : [node]) {
        moved.set(candidate.id, candidate.position);
      }
      const context = drag.current;
      if (context) {
        const dx = node.position.x - context.origin.x;
        const dy = node.position.y - context.origin.y;
        for (const [id, start] of context.members) {
          moved.set(id, { x: start.x + dx, y: start.y + dy });
        }
      }
      drag.current = null;

      const byId = new Map(useCanvasStore.getState().document.nodes.map((n) => [n.id, n]));
      const patches = [...moved.entries()]
        .filter(([id, position]) => {
          const existing = byId.get(id);
          return (
            existing &&
            (Math.round(existing.x) !== Math.round(position.x) ||
              Math.round(existing.y) !== Math.round(position.y))
          );
        })
        .map(([id, position]) => ({
          id,
          changes: { x: Math.round(position.x), y: Math.round(position.y) },
        }));
      if (patches.length > 0) mutate({ type: 'patch-nodes', patches });
    },
    [mutate],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;
      const fromSide = asSide(connection.sourceHandle);
      const toSide = asSide(connection.targetHandle);
      mutate({
        type: 'insert-edges',
        edges: [
          {
            id: createId(),
            fromNode: connection.source,
            toNode: connection.target,
            ...(fromSide ? { fromSide } : {}),
            ...(toSide ? { toSide } : {}),
            toEnd: 'arrow',
          },
        ],
      });
    },
    [mutate],
  );

  const onReconnect = useCallback(
    (oldEdge: FlowEdge, connection: Connection) => {
      if (!connection.source || !connection.target) return;
      const fromSide = asSide(connection.sourceHandle);
      const toSide = asSide(connection.targetHandle);
      mutate({
        type: 'patch-edges',
        patches: [
          {
            id: oldEdge.id,
            changes: {
              fromNode: connection.source,
              toNode: connection.target,
              fromSide,
              toSide,
            },
          },
        ],
      });
    },
    [mutate],
  );

  const onNodeDoubleClick = useCallback(
    (_: unknown, node: FlowNode) => {
      if (node.data.node.type !== 'group') setActiveNode(node.id);
    },
    [setActiveNode],
  );

  // Restore the viewport saved for this canvas.
  const restored = useRef<string | null>(null);
  const path = useCanvasStore((state) => state.path);
  useEffect(() => {
    if (!path || restored.current === path) return;
    restored.current = path;
    flow.setViewport(storedViewport);
  }, [path, storedViewport, flow]);

  const onMoveEnd = useCallback(
    (_: unknown, viewport: Viewport) => setViewport(viewport),
    [setViewport],
  );

  // Shift+wheel moves the canvas left and right, where a plain wheel moves it up
  // and down: the event is caught on the way down and its delta put on the
  // horizontal axis, so React Flow, further along, pans it sideways rather than
  // cancelling the gesture. The event is corrected rather than replaced by a
  // synthetic one, which keeps everything downstream — React Flow, d3-zoom, the
  // pane — handling the event the engine sent. The listener is native rather
  // than a React prop because React's own wheel listeners are passive and run in
  // both phases.
  useEffect(() => {
    const element = wrapper.current;
    if (!element) return undefined;
    element.addEventListener('wheel', correctWheel, { capture: true });
    return () =>
      element.removeEventListener('wheel', correctWheel, { capture: true });
  }, []);

  return (
    <ReactFlow<FlowNode, FlowEdge>
      ref={wrapper}
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onSelectionChange={onSelectionChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      onReconnect={onReconnect}
      onNodeDoubleClick={onNodeDoubleClick}
      onPaneClick={() => {
        setActiveNode(null);
        useUiStore.getState().closePalette();
      }}
      onMoveEnd={onMoveEnd}
      connectionMode={ConnectionMode.Loose}
      // Deletion, copy and paste are commands, so the canvas does not bind them.
      deleteKeyCode={null}
      multiSelectionKeyCode={MULTI_SELECTION_KEYS}
      selectionKeyCode="Shift"
      panOnDrag={PAN_BUTTONS}
      selectionOnDrag
      // Touching a node is enough to select it: nodes here are large enough that
      // requiring one to be enclosed would mean zooming out before every gesture.
      selectionMode={SelectionMode.Partial}
      panOnScroll
      zoomOnPinch
      // A double click is how a node is opened for editing, so it must not also
      // change the zoom — including on the pane, where a double click that
      // missed a node would otherwise jump the viewport.
      zoomOnDoubleClick={false}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      onlyRenderVisibleElements
      proOptions={PRO_OPTIONS}
      nodesDraggable={activeNodeId === null}
      elevateNodesOnSelect={false}
      elevateEdgesOnSelect
      fitView={false}
    >
      <CanvasBackground />
      {showMinimap ? <MiniMap pannable zoomable position="bottom-right" /> : null}
    </ReactFlow>
  );
};

export const nodeCenter = (node: CanvasNode) => ({
  x: node.x + node.width / 2,
  y: node.y + node.height / 2,
});
