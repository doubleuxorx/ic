/**
 * Read-only Markdown preview.
 *
 * The HTML is sanitized in `markdown-renderer`; this component only wires up
 * deliberate link activation. A link click asks for confirmation and shows the
 * full URL before anything is handed to the operating system.
 */

import { memo, useMemo } from 'react';

import { confirmWith, toast } from '@/app/ui-store';
import { renderMarkdown } from '@/editor/markdown-renderer';
import { errorMessage } from '@/shared/errors';
import { ipc } from '@/shared/ipc-types';

interface Props {
  source: string;
  /** Workspace-relative directory used to resolve relative image paths. */
  baseDirectory?: string;
}

export const openLinkDeliberately = async (url: string): Promise<void> => {
  const ok = await confirmWith('Open external link', url, 'Open');
  if (!ok) return;
  try {
    await ipc.openUrl(url);
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
};

const MarkdownPreviewComponent = ({ source, baseDirectory = '' }: Props) => {
  const html = useMemo(() => renderMarkdown(source, baseDirectory), [source, baseDirectory]);

  return (
    <div
      className="markdown nowheel"
      // Sanitized above; raw HTML in the source was never parsed.
      dangerouslySetInnerHTML={{ __html: html }}
      onClickCapture={(event) => {
        const target = (event.target as HTMLElement).closest('[data-href]');
        if (!target) return;
        // A link click must not also drag or select the node.
        event.preventDefault();
        event.stopPropagation();
        void openLinkDeliberately(target.getAttribute('data-href') ?? '');
      }}
      onPointerDownCapture={(event) => {
        if ((event.target as HTMLElement).closest('[data-href]')) event.stopPropagation();
      }}
    />
  );
};

export const MarkdownPreview = memo(MarkdownPreviewComponent);
