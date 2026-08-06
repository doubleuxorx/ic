/**
 * Image view.
 *
 * Large images render from a cached thumbnail so a distant node never decodes a
 * full-resolution file. The original is loaded when the image is shown at
 * original size, and when the canvas is zoomed in far enough that the thumbnail
 * would be enlarged past its own resolution: a node made small keeps all of its
 * detail, the file behind it is simply not read until something can see it.
 */

import { memo, useEffect, useState } from "react";

import { useCanvasStore } from "@/canvas/canvas-store";
import { screenPixels } from "@/canvas/zoom";
import { errorMessage } from "@/shared/errors";
import { ipc, type Thumbnail } from "@/shared/ipc-types";
import { nodeById } from "@/shared/json-canvas";
import { fileUrl } from "@/workspace/workspace-store";

import {
	useFactsVersion,
	useMediaStore,
	type FitMode,
} from "./media-view-store";

interface Props {
	nodeId: string;
	relativePath: string;
	alt: string;
}

/**
 * Device pixels the node covers across, or null when it is not on a canvas: a
 * view rendered outside one has nothing to measure against and keeps the
 * cheaper source.
 */
const useScreenWidth = (nodeId: string): number | null => {
	const width = useCanvasStore(
		(state) => nodeById(state.document, nodeId)?.width ?? null,
	);
	const zoom = useCanvasStore((state) => state.viewport.zoom);
	return width === null ? null : screenPixels(width, zoom);
};

/** A thumbnail with fewer pixels than the node covers is being enlarged. */
const isEnlarged = (
	thumbnail: Thumbnail,
	screenWidth: number | null,
): boolean => screenWidth !== null && thumbnail.width < screenWidth;

const ImageNodeComponent = ({ nodeId, relativePath, alt }: Props) => {
	const fit: FitMode = useMediaStore((state) => state.fit[nodeId] ?? "fit");
	const version = useFactsVersion(relativePath);
	const screenWidth = useScreenWidth(nodeId);
	const [thumbnail, setThumbnail] = useState<Thumbnail | null>(null);
	const [thumbnailFailed, setThumbnailFailed] = useState(false);
	const [broken, setBroken] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setThumbnail(null);
		setThumbnailFailed(false);
		setBroken(false);
		setError(null);
		// Original size needs the real file; every other mode starts from a
		// thumbnail, which is also what keeps large canvases cheap.
		if (fit === "original") {
			return () => {
				cancelled = true;
			};
		}
		ipc
			.thumbnailRequest(relativePath)
			.then((generated) => {
				if (!cancelled) setThumbnail(generated);
			})
			.catch((thumbnailError) => {
				if (cancelled) return;
				// Thumbnailing can fail for exotic formats the webview still displays.
				setThumbnailFailed(true);
				setError(errorMessage(thumbnailError));
			});
		return () => {
			cancelled = true;
		};
	}, [relativePath, fit, version]);

	// Which file to show is decided on every render rather than stored, so that
	// zooming in swaps the thumbnail for the original without asking the backend
	// for the thumbnail again.
	const source = (() => {
		if (broken) return null;
		if (fit === "original" || thumbnailFailed) return fileUrl(relativePath);
		if (!thumbnail) return null;
		return fileUrl(
			isEnlarged(thumbnail, screenWidth)
				? relativePath
				: thumbnail.relativePath,
		);
	})();

	if (!source) {
		return <div className="placeholder">{error ?? "Loading image"}</div>;
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
				setError("image could not be displayed");
				setBroken(true);
			}}
		/>
	);
};

export const ImageNode = memo(ImageNodeComponent);
