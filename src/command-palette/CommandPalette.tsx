/**
 * Command palette.
 *
 * This is the application's only menu. It lists every registered command with
 * its shortcut, keeps unavailable commands visible but disabled, and runs the
 * same code path a keyboard shortcut would.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { useUiStore } from '@/app/ui-store';

import {
  displayShortcut,
  searchCommands,
  type CommandContext,
} from './command-registry';

interface Props {
  context: CommandContext;
}

export const CommandPalette = ({ context }: Props) => {
  const open = useUiStore((state) => state.paletteOpen);
  const close = useUiStore((state) => state.closePalette);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);

  const results = useMemo(() => searchCommands(query, context), [query, context]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
    // Focus after the overlay is mounted so the caret lands in the field.
    const id = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // `Open settings` prefills the query rather than opening another surface.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (typeof detail === 'string') {
        setQuery(detail);
        setIndex(0);
      }
    };
    window.addEventListener('ic:palette-query', handler);
    return () => window.removeEventListener('ic:palette-query', handler);
  }, []);

  useEffect(() => {
    const active = list.current?.querySelector('.palette-item.active');
    active?.scrollIntoView({ block: 'nearest' });
  }, [index, results]);

  if (!open) return null;

  const run = async (position: number) => {
    const entry = results[position];
    if (!entry || !entry.available) return;
    close();
    await entry.command.execute(context);
  };

  return (
    <div
      className="overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          ref={input}
          value={query}
          placeholder="Type a command"
          aria-label="Command"
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setIndex((current) => Math.min(current + 1, results.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setIndex((current) => Math.max(current - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              void run(index);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        />
        <div className="palette-list" ref={list}>
          {results.length === 0 ? (
            <div className="palette-empty">No matching command</div>
          ) : (
            results.map((entry, position) => (
              <div
                key={entry.command.id}
                className={`palette-item ${position === index ? 'active' : ''}`}
                aria-disabled={!entry.available}
                onPointerEnter={() => setIndex(position)}
                onPointerDown={(event) => {
                  event.preventDefault();
                  void run(position);
                }}
              >
                <span className="category">{entry.command.category}</span>
                <span className="title">{entry.command.title}</span>
                {entry.command.defaultShortcut ? (
                  <span className="shortcut">
                    {displayShortcut(entry.command.defaultShortcut)}
                  </span>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
