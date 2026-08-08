/**
 * File node — a JSON Canvas `file` node referencing a workspace file.
 *
 * The kind is taken from verified facts (content sniffing in Rust), not from
 * the extension, and decides which view is mounted. Text files enter an editor
 * when active, while PDFs expose their page and zoom controls.
 */

import { memo } from "react";
import type { NodeProps } from "@xyflow/react";

import { toast } from "@/app/ui-store";
import type { FlowNode } from "@/canvas/canvas-adapter";
import { useCanvasStore } from "@/canvas/canvas-store";
import { AudioNode } from "@/media/AudioNode";
import { PdfNode } from "@/media/PdfNode";
import { ImageNode } from "@/media/ImageNode";
import { VideoNode } from "@/media/VideoNode";
import {
	canActivateFileKind,
	formatBytes,
	useFileFacts,
} from "@/media/media-view-store";
import { errorMessage } from "@/shared/errors";
import { ipc } from "@/shared/ipc-types";
import {
	contentScale,
	type FileNode as FileCanvasNode,
} from "@/shared/json-canvas";
import { baseName, parentDirectory } from "@/workspace/workspace-store";

import { MarkdownFileView } from "./MarkdownFileView";
import { NodeAction, NodeShell } from "./NodeShell";
import { useNodeCommon } from "./use-node-common";

const FileNodeComponent = ({ id, data, selected }: NodeProps<FlowNode>) => {
	const node = data.node as FileCanvasNode;
	const active = data.active;
	const setActiveNode = useCanvasStore((state) => state.setActiveNode);
	const { onResizeEnd, remove, chooseColor } = useNodeCommon(id);
	const { facts, error } = useFileFacts(node.file);

	const kind = facts?.kind ?? "unsupported";
	const canActivate = canActivateFileKind(facts?.kind);
	const interactiveActive = active && canActivate;
	const name = baseName(node.file);

	const body = (() => {
		if (error) return <div className="placeholder">{error}</div>;
		if (!facts) return <div className="placeholder">Reading file</div>;
		switch (kind) {
			case "markdown":
			case "text":
				return (
					<MarkdownFileView
						relativePath={node.file}
						subpath={node.subpath}
						active={interactiveActive}
						selected={selected === true}
						plain={kind === "text"}
					/>
				);
			case "image":
				return <ImageNode nodeId={id} relativePath={node.file} alt={name} />;
			case "pdf":
				return (
					<PdfNode
						relativePath={node.file}
						active={interactiveActive}
						width={node.width}
						height={node.height}
						scale={contentScale(node)}
					/>
				);
			case "video":
				return <VideoNode nodeId={id} relativePath={node.file} />;
			case "audio":
				return <AudioNode nodeId={id} relativePath={node.file} />;
			default:
				return (
					<div className="placeholder">
						{name}
						<br />
						{formatBytes(facts.size)} — no in-canvas view for this type
					</div>
				);
		}
	})();

	const openExternally = () => {
		void ipc
			.openPath(node.file)
			.catch((openError) => toast(errorMessage(openError), "error"));
	};

	return (
		<NodeShell
			node={node}
			selected={selected === true}
			active={interactiveActive}
			className={`file ${kind}`}
			onResizeEnd={onResizeEnd}
			header={
				<>
					<span className="name" title={node.file}>
						{name}
						{node.subpath ? (
							<span style={{ opacity: 0.7 }}> {node.subpath}</span>
						) : null}
					</span>
					<span style={{ marginLeft: "auto", opacity: 0.7 }}>
						{parentDirectory(node.file)}
					</span>
				</>
			}
			actions={
				interactiveActive ? null : (
					<>
						{kind === "markdown" || kind === "text" ? (
							<NodeAction
								icon="edit"
								title="Edit (Enter)"
								onClick={() => setActiveNode(id)}
							/>
						) : null}
						{kind === "pdf" ? (
							<NodeAction
								icon="eye"
								title="Show controls (Enter)"
								onClick={() => setActiveNode(id)}
							/>
						) : null}
						<NodeAction
							icon="external"
							title="Open externally"
							onClick={openExternally}
						/>
						<NodeAction icon="palette" title="Colour" onClick={chooseColor} />
						<NodeAction
							icon="close"
							title="Remove from canvas"
							onClick={remove}
						/>
					</>
				)
			}
		>
			<div
				style={{ height: "100%" }}
				onDoubleClick={() => {
					if (canActivate) setActiveNode(id);
				}}
			>
				{body}
			</div>
		</NodeShell>
	);
};

export const FileNode = memo(FileNodeComponent);
