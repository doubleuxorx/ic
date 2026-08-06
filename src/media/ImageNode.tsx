/**
 * Image view.
 *
 * Large images render from a cached thumbnail so a distant node never decodes a
 * full-resolution file. The original is loaded only when the image is shown at
 * original size.
 */

import { memo, useEffect, useState } from 'react';

import { errorMessage } from '@/shared/errors';
import { ipc } from '@/shared/ipc-types';
import { fileUrl } from '@/workspace/workspace-store';

import { useFactsVersion, useMediaStore, type FitMode } from './media-view-store';

interface Props {
  nodeId: string;
  relativePath: string;
  alt: string;
}

const ImageNodeComponent = ({ nodeId, relativePath, alt }: Props) => {
  const fit: FitMode = useMediaStore((state) => state.fit[nodeId] ?? 'fit');
  const version = useFactsVersion(relativePath);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Original size needs the real file; every other mode is happy with a
    // thumbnail, which is also what keeps large canvases cheap.
    if (fit === 'original') {
      setSource(fileUrl(relativePath));
      return () => {
        cancelled = true;
      };
    }
    ipc
      .thumbnailRequest(relativePath)
      .then((thumbnail) => {
        if (!cancelled) setSource(fileUrl(thumbnail.relativePath));
      })
      .catch((thumbnailError) => {
        if (cancelled) return;
        // Thumbnailing can fail for exotic formats the webview still displays.
        setSource(fileUrl(relativePath));
        setError(errorMessage(thumbnailError));
      });
    return () => {
      cancelled = true;
    };
  }, [relativePath, fit, version]);

  if (!source) {
    return <div className="placeholder">{error ?? 'Loading image'}</div>;
  }

  return (
    <img
      className={`media-fill ${fit}`}
      src={source}
      alt={alt}
      draggable={false}
      // Dropping the source puts the reason on the node, where a failure that
      // used to be reported nowhere is now visible.
      onError={() => {
        setError('image could not be displayed');
        setSource(null);
      }}
    />
  );
};

export const ImageNode = memo(ImageNodeComponent);
