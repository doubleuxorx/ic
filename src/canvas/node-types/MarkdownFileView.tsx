/**
 * Markdown file node body.
 *
 * The preview renders the referenced file (optionally only the section named by
 * the node's subpath). Activating the node opens the same CodeMirror component
 * used by inline nodes and writes back to the original `.md` file. Unsaved
 * content is never discarded when the node loses focus: it stays in the shared
 * document store, is autosaved, and has a recovery copy on disk.
 */

import { memo, useCallback, useEffect } from 'react';

import { MarkdownEditor } from '@/editor/MarkdownEditor';
import { useDocumentStore } from '@/editor/document-store';
import { sliceSubpath } from '@/editor/markdown-renderer';
import { useCanvasStore } from '@/canvas/canvas-store';
import { parentDirectory } from '@/workspace/workspace-store';

import { MarkdownPreview } from './MarkdownPreview';

interface Props {
  relativePath: string;
  subpath?: string;
  active: boolean;
  plain?: boolean;
}

const MarkdownFileViewComponent = ({ relativePath, subpath, active, plain }: Props) => {
  const doc = useDocumentStore((state) => state.docs[relativePath]);
  const open = useDocumentStore((state) => state.open);
  const setContents = useDocumentStore((state) => state.setContents);
  const save = useDocumentStore((state) => state.save);
  const resolveConflict = useDocumentStore((state) => state.resolveConflict);
  const setActiveNode = useCanvasStore((state) => state.setActiveNode);

  useEffect(() => {
    void open(relativePath);
  }, [open, relativePath]);

  const onChange = useCallback(
    (value: string) => setContents(relativePath, value),
    [relativePath, setContents],
  );

  if (!doc || doc.loading) return <div className="placeholder">Loading {relativePath}</div>;
  if (doc.error) return <div className="placeholder">{doc.error}</div>;

  if (doc.conflict) {
    return (
      <div className="placeholder">
        <div>
          <p>{relativePath} was changed outside the application.</p>
          <div className="row" style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button
              type="button"
              className="icon-button nodrag"
              style={{ width: 'auto', padding: '0 8px' }}
              onClick={() => void resolveConflict(relativePath, 'take-disk')}
            >
              Use the file on disk
            </button>
            <button
              type="button"
              className="icon-button nodrag"
              style={{ width: 'auto', padding: '0 8px' }}
              onClick={() => void resolveConflict(relativePath, 'keep-mine')}
            >
              Keep my version
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (active) {
    return (
      <MarkdownEditor
        value={doc.contents}
        onChange={onChange}
        onExit={() => setActiveNode(null)}
        onSave={() => void save(relativePath, { force: true })}
      />
    );
  }

  const visible = sliceSubpath(doc.contents, subpath);

  return plain ? (
    <div className="plain-text nowheel" style={{ alignItems: 'flex-start' }}>
      {visible}
    </div>
  ) : (
    <MarkdownPreview source={visible} baseDirectory={parentDirectory(relativePath)} />
  );
};

export const MarkdownFileView = memo(MarkdownFileViewComponent);
