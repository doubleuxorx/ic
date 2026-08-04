/**
 * JSON Canvas 1.0 — the canonical document model.
 *
 * Rules enforced here:
 *  - Only specification fields are written; React Flow state never leaks in.
 *  - Unknown fields produced by other applications are preserved verbatim.
 *  - Node array order is z-order and is never reordered implicitly.
 *  - Coordinates and dimensions are written as integers.
 *
 * Spec: https://jsoncanvas.org/spec/1.0/
 */

export type CanvasColor = string; // "1".."6" or "#rrggbb"

export const PRESET_COLORS = ['1', '2', '3', '4', '5', '6'] as const;
export type PresetColor = (typeof PRESET_COLORS)[number];

export type NodeSide = 'top' | 'right' | 'bottom' | 'left';
export type EdgeEnd = 'none' | 'arrow';
export type BackgroundStyle = 'cover' | 'ratio' | 'repeat';

/** Fields written by other applications that this one does not understand. */
export type Extra = Record<string, unknown>;

interface NodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
  extra?: Extra;
}

export interface TextNode extends NodeBase {
  type: 'text';
  text: string;
}

export interface FileNode extends NodeBase {
  type: 'file';
  file: string;
  /** Heading or block reference inside the file, always starting with `#`. */
  subpath?: string;
}

export interface LinkNode extends NodeBase {
  type: 'link';
  url: string;
}

export interface GroupNode extends NodeBase {
  type: 'group';
  label?: string;
  background?: string;
  backgroundStyle?: BackgroundStyle;
}

export type CanvasNode = TextNode | FileNode | LinkNode | GroupNode;
export type CanvasNodeType = CanvasNode['type'];

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: NodeSide;
  fromEnd?: EdgeEnd;
  toNode: string;
  toSide?: NodeSide;
  toEnd?: EdgeEnd;
  color?: CanvasColor;
  label?: string;
  extra?: Extra;
}

export interface CanvasDocument {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Unknown top-level fields, preserved on save. */
  extra?: Extra;
}

export const emptyCanvas = (): CanvasDocument => ({ nodes: [], edges: [] });

const NODE_KEYS = ['id', 'type', 'x', 'y', 'width', 'height', 'color'] as const;
const KEYS_BY_TYPE: Record<CanvasNodeType, readonly string[]> = {
  text: ['text'],
  file: ['file', 'subpath'],
  link: ['url'],
  group: ['label', 'background', 'backgroundStyle'],
};
const EDGE_KEYS = [
  'id',
  'fromNode',
  'fromSide',
  'fromEnd',
  'toNode',
  'toSide',
  'toEnd',
  'color',
  'label',
] as const;

const SIDES: readonly string[] = ['top', 'right', 'bottom', 'left'];
const ENDS: readonly string[] = ['none', 'arrow'];
const BACKGROUND_STYLES: readonly string[] = ['cover', 'ratio', 'repeat'];

export class CanvasParseError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const asOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const collectExtra = (source: Record<string, unknown>, known: readonly string[]): Extra | undefined => {
  const extra: Extra = {};
  let found = false;
  for (const key of Object.keys(source)) {
    if (!known.includes(key)) {
      extra[key] = source[key];
      found = true;
    }
  }
  return found ? extra : undefined;
};

/** Colors are either a preset digit or a hex value; anything else is dropped. */
export const normalizeColor = (value: unknown): CanvasColor | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if ((PRESET_COLORS as readonly string[]).includes(trimmed)) return trimmed;
  if (/^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{8}$/.test(trimmed)) return trimmed;
  return undefined;
};

export const isPresetColor = (color: CanvasColor | undefined): color is PresetColor =>
  color !== undefined && (PRESET_COLORS as readonly string[]).includes(color);

const parseNode = (raw: unknown): CanvasNode | null => {
  if (!isRecord(raw)) return null;
  const id = asOptionalString(raw.id);
  const type = raw.type;
  if (!id || typeof type !== 'string') return null;
  if (!['text', 'file', 'link', 'group'].includes(type)) return null;

  const base = {
    id,
    x: asNumber(raw.x),
    y: asNumber(raw.y),
    width: Math.max(1, asNumber(raw.width, 250)),
    height: Math.max(1, asNumber(raw.height, 60)),
    color: normalizeColor(raw.color),
    extra: collectExtra(raw, [...NODE_KEYS, ...KEYS_BY_TYPE[type as CanvasNodeType]]),
  };

  switch (type) {
    case 'text':
      return { ...base, type: 'text', text: typeof raw.text === 'string' ? raw.text : '' };
    case 'file': {
      const file = asOptionalString(raw.file);
      if (!file) return null;
      const subpath = asOptionalString(raw.subpath);
      return { ...base, type: 'file', file, ...(subpath ? { subpath } : {}) };
    }
    case 'link': {
      const url = asOptionalString(raw.url);
      if (!url) return null;
      return { ...base, type: 'link', url };
    }
    case 'group': {
      const label = asOptionalString(raw.label);
      const background = asOptionalString(raw.background);
      const backgroundStyle = asOptionalString(raw.backgroundStyle);
      return {
        ...base,
        type: 'group',
        ...(label ? { label } : {}),
        ...(background ? { background } : {}),
        ...(backgroundStyle && BACKGROUND_STYLES.includes(backgroundStyle)
          ? { backgroundStyle: backgroundStyle as BackgroundStyle }
          : {}),
      };
    }
    default:
      return null;
  }
};

const parseEdge = (raw: unknown, nodeIds: Set<string>): CanvasEdge | null => {
  if (!isRecord(raw)) return null;
  const id = asOptionalString(raw.id);
  const fromNode = asOptionalString(raw.fromNode);
  const toNode = asOptionalString(raw.toNode);
  if (!id || !fromNode || !toNode) return null;
  // Dangling edges would render as ghosts; other applications drop them too.
  if (!nodeIds.has(fromNode) || !nodeIds.has(toNode)) return null;

  const side = (value: unknown): NodeSide | undefined =>
    typeof value === 'string' && SIDES.includes(value) ? (value as NodeSide) : undefined;
  const end = (value: unknown): EdgeEnd | undefined =>
    typeof value === 'string' && ENDS.includes(value) ? (value as EdgeEnd) : undefined;

  const fromSide = side(raw.fromSide);
  const toSide = side(raw.toSide);
  const fromEnd = end(raw.fromEnd);
  const toEnd = end(raw.toEnd);
  const color = normalizeColor(raw.color);
  const label = asOptionalString(raw.label);

  return {
    id,
    fromNode,
    toNode,
    ...(fromSide ? { fromSide } : {}),
    ...(toSide ? { toSide } : {}),
    ...(fromEnd ? { fromEnd } : {}),
    ...(toEnd ? { toEnd } : {}),
    ...(color ? { color } : {}),
    ...(label ? { label } : {}),
    ...(collectExtra(raw, EDGE_KEYS) ? { extra: collectExtra(raw, EDGE_KEYS) } : {}),
  };
};

/** Parse canvas JSON. Invalid entries are dropped rather than failing the file. */
export const parseCanvas = (text: string): CanvasDocument => {
  let raw: unknown;
  const trimmed = text.trim();
  if (trimmed.length === 0) return emptyCanvas();
  try {
    raw = JSON.parse(trimmed);
  } catch (error) {
    throw new CanvasParseError(`not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(raw)) throw new CanvasParseError('canvas must be a JSON object');

  const nodes: CanvasNode[] = [];
  const seen = new Set<string>();
  if (Array.isArray(raw.nodes)) {
    for (const entry of raw.nodes) {
      const node = parseNode(entry);
      if (node && !seen.has(node.id)) {
        seen.add(node.id);
        nodes.push(node);
      }
    }
  }

  const edges: CanvasEdge[] = [];
  const edgeIds = new Set<string>();
  if (Array.isArray(raw.edges)) {
    for (const entry of raw.edges) {
      const edge = parseEdge(entry, seen);
      if (edge && !edgeIds.has(edge.id)) {
        edgeIds.add(edge.id);
        edges.push(edge);
      }
    }
  }

  const extra = collectExtra(raw, ['nodes', 'edges']);
  return { nodes, edges, ...(extra ? { extra } : {}) };
};

const round = (value: number): number => Math.round(value);

const serializeNode = (node: CanvasNode): Record<string, unknown> => {
  // Unknown fields first so specification fields always win.
  const out: Record<string, unknown> = { ...(node.extra ?? {}) };
  out.id = node.id;
  out.type = node.type;
  out.x = round(node.x);
  out.y = round(node.y);
  out.width = round(node.width);
  out.height = round(node.height);
  if (node.color) out.color = node.color;
  switch (node.type) {
    case 'text':
      out.text = node.text;
      break;
    case 'file':
      out.file = node.file;
      if (node.subpath) out.subpath = node.subpath;
      break;
    case 'link':
      out.url = node.url;
      break;
    case 'group':
      if (node.label) out.label = node.label;
      if (node.background) out.background = node.background;
      if (node.backgroundStyle) out.backgroundStyle = node.backgroundStyle;
      break;
  }
  return out;
};

const serializeEdge = (edge: CanvasEdge): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...(edge.extra ?? {}) };
  out.id = edge.id;
  out.fromNode = edge.fromNode;
  if (edge.fromSide) out.fromSide = edge.fromSide;
  if (edge.fromEnd) out.fromEnd = edge.fromEnd;
  out.toNode = edge.toNode;
  if (edge.toSide) out.toSide = edge.toSide;
  if (edge.toEnd) out.toEnd = edge.toEnd;
  if (edge.color) out.color = edge.color;
  if (edge.label) out.label = edge.label;
  return out;
};

/** Serialize to the on-disk representation: stable key order, trailing newline. */
export const serializeCanvas = (document: CanvasDocument): string => {
  const out: Record<string, unknown> = { ...(document.extra ?? {}) };
  out.nodes = document.nodes.map(serializeNode);
  out.edges = document.edges.map(serializeEdge);
  return `${JSON.stringify(out, null, '\t')}\n`;
};

/** Stable, unique node and edge identifiers. */
export const createId = (): string => {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

export const nodeById = (document: CanvasDocument, id: string): CanvasNode | undefined =>
  document.nodes.find((node) => node.id === id);

/** Geometric containment; JSON Canvas groups have no parent references. */
export const nodesInsideGroup = (document: CanvasDocument, group: GroupNode): CanvasNode[] =>
  document.nodes.filter(
    (node) =>
      node.id !== group.id &&
      node.x >= group.x &&
      node.y >= group.y &&
      node.x + node.width <= group.x + group.width &&
      node.y + node.height <= group.y + group.height,
  );

export const boundingBox = (
  nodes: CanvasNode[],
): { x: number; y: number; width: number; height: number } | null => {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
};
