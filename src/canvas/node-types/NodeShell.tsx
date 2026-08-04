/**
 * Shared node chrome: border, colour, connection dots and hover actions.
 *
 * The four connection dots sit centred on each side and only become visible
 * while the pointer is over the node or the node is selected, which is what
 * keeps the canvas free of permanent controls.
 */

import { memo, type ReactNode } from 'react';
import { Handle, NodeResizer, Position } from '@xyflow/react';

import type { CanvasNode } from '@/shared/json-canvas';
import { contrastText, resolveColor } from '@/theme/theme-store';

export type IconName =
  | 'edit'
  | 'close'
  | 'palette'
  | 'external'
  | 'folder'
  | 'play'
  | 'pause'
  | 'chevron-left'
  | 'chevron-right'
  | 'plus'
  | 'minus';

const PATHS: Record<IconName, ReactNode> = {
  edit: <path d="M2.5 11.5v-2l7-7 2 2-7 7h-2z" />,
  close: (
    <>
      <path d="M3 3l8 8" />
      <path d="M11 3l-8 8" />
    </>
  ),
  palette: (
    <>
      <circle cx="7" cy="7" r="5" />
      <circle cx="7" cy="4.6" r="0.9" />
      <circle cx="4.6" cy="8" r="0.9" />
      <circle cx="9.4" cy="8" r="0.9" />
    </>
  ),
  external: (
    <>
      <path d="M8 2h4v4" />
      <path d="M12 2L6.5 7.5" />
      <path d="M11 8.5V12H2V3h3.5" />
    </>
  ),
  folder: <path d="M1.5 11.5v-8h4l1.5 2h5.5v6z" />,
  play: <path d="M4 2.5l7 4.5-7 4.5z" />,
  pause: (
    <>
      <path d="M4.5 2.5v9" />
      <path d="M9.5 2.5v9" />
    </>
  ),
  'chevron-left': <path d="M8.5 2.5L4 7l4.5 4.5" />,
  'chevron-right': <path d="M5.5 2.5L10 7l-4.5 4.5" />,
  plus: (
    <>
      <path d="M7 2.5v9" />
      <path d="M2.5 7h9" />
    </>
  ),
  minus: <path d="M2.5 7h9" />,
};

export const Icon = ({ name }: { name: IconName }) => (
  <svg viewBox="0 0 14 14" aria-hidden="true">
    {PATHS[name]}
  </svg>
);

interface ActionProps {
  icon: IconName;
  title: string;
  onClick: () => void;
}

export const NodeAction = ({ icon, title, onClick }: ActionProps) => (
  <button
    type="button"
    className="icon-button nodrag"
    title={title}
    aria-label={title}
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
    onPointerDown={(event) => event.stopPropagation()}
  >
    <Icon name={icon} />
  </button>
);

const SIDES = [
  { id: 'top', position: Position.Top },
  { id: 'right', position: Position.Right },
  { id: 'bottom', position: Position.Bottom },
  { id: 'left', position: Position.Left },
] as const;

interface ShellProps {
  node: CanvasNode;
  selected: boolean;
  active: boolean;
  className?: string;
  header?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  onResizeEnd?: (rect: { x: number; y: number; width: number; height: number }) => void;
  minWidth?: number;
  minHeight?: number;
}

const NodeShellInner = ({
  node,
  selected,
  active,
  className = '',
  header,
  actions,
  children,
  onResizeEnd,
  minWidth = 120,
  minHeight = 60,
}: ShellProps) => {
  const color = resolveColor(node.color);
  const foreground = contrastText(node.color);

  return (
    <>
      <NodeResizer
        isVisible={selected}
        minWidth={minWidth}
        minHeight={minHeight}
        lineClassName="resize-line"
        handleClassName="resize-handle"
        onResizeEnd={(_, params) =>
          onResizeEnd?.({
            x: params.x,
            y: params.y,
            width: params.width,
            height: params.height,
          })
        }
      />
      <div
        className={`node ${className} ${color ? 'colored' : ''} ${active ? 'active' : ''}`}
        style={{
          ...(color ? ({ '--node-color': color } as Record<string, string>) : {}),
          ...(foreground && node.type === 'group' ? { color: foreground } : {}),
        }}
      >
        {header ? <div className="node-header">{header}</div> : null}
        {actions ? <div className="node-actions">{actions}</div> : null}
        <div className="node-body">{children}</div>
      </div>
      {SIDES.map((side) => (
        <Handle
          key={side.id}
          id={side.id}
          type="source"
          position={side.position}
          isConnectableStart
          isConnectableEnd
        />
      ))}
    </>
  );
};

export const NodeShell = memo(NodeShellInner);
