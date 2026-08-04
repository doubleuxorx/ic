/**
 * Workspace file picker.
 *
 * There is no permanent sidebar: the file list only exists inside the modal
 * opened by `Open file` or `Add file`, so the canvas keeps the whole window.
 * `.app` caches are already excluded by the Rust listing.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { fuzzyScore } from '@/command-palette/command-registry';
import type { FileEntry, FileKind } from '@/shared/ipc-types';

import { flattenTree, useWorkspaceStore } from './workspace-store';

interface Props {
  title: string;
  kinds: FileKind[];
  onPick: (relativePath: string | null) => void;
}

export const FileTree = ({ title, kinds, onPick }: Props) => {
  const tree = useWorkspaceStore((state) => state.tree);
  const refreshTree = useWorkspaceStore((state) => state.refreshTree);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void refreshTree();
    const id = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [refreshTree]);

  const files = useMemo(() => {
    const allowed = new Set(kinds);
    const all = flattenTree(tree).filter((entry) => allowed.has(entry.kind));
    if (query.trim().length === 0) {
      return all.sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, 300);
    }
    return all
      .map((entry) => ({ entry, score: fuzzyScore(query, entry.relativePath) }))
      .filter((item): item is { entry: FileEntry; score: number } => item.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 300)
      .map((item) => item.entry);
  }, [tree, kinds, query]);

  return (
    <div className="palette" role="dialog" aria-label={title}>
      <input
        ref={input}
        value={query}
        placeholder={title}
        aria-label={title}
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setIndex((current) => Math.min(current + 1, files.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setIndex((current) => Math.max(current - 1, 0));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const entry = files[index];
            if (entry) onPick(entry.relativePath);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onPick(null);
          }
        }}
      />
      <div className="file-list">
        {files.length === 0 ? (
          <div className="palette-empty">No matching file in this workspace</div>
        ) : (
          files.map((entry, position) => (
            <div
              key={entry.relativePath}
              className={`file-row ${position === index ? 'active' : ''}`}
              onPointerEnter={() => setIndex(position)}
              onPointerDown={(event) => {
                event.preventDefault();
                onPick(entry.relativePath);
              }}
            >
              <span className="kind">{entry.kind}</span>
              <span className="title">{entry.name}</span>
              <span className="path">{entry.relativePath}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
