/**
 * Application shell.
 *
 * The window is the canvas. Everything else — palette, modals, toasts — is
 * transient and appears only when asked for. This component owns keyboard
 * routing, workspace lifecycle, external-change handling and crash recovery.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { CanvasView } from "@/canvas/CanvasView";
import { useCanvasStore } from "@/canvas/canvas-store";
import { setFlowInstance } from "@/canvas/flow-bridge";
import type { FlowEdge, FlowNode } from "@/canvas/canvas-adapter";
import { CommandPalette } from "@/command-palette/CommandPalette";
import {
	commandForEvent,
	displayShortcut,
	normalizeShortcut,
	runCommand,
	shortcutConflicts,
	type CommandContext,
} from "@/command-palette/command-registry";
import { useDocumentStore } from "@/editor/document-store";
import { useEditorSettings } from "@/editor/editor-settings";
import {
	cachedFileKind,
	canActivateFileKind,
	invalidateFacts,
} from "@/media/media-view-store";
import { errorMessage } from "@/shared/errors";
import { ipc, isDesktop, type ChangeEvent } from "@/shared/ipc-types";
import {
	useWorkspaceStore,
	DEFAULT_DIRECTORIES,
} from "@/workspace/workspace-store";

import { addFileNode, registerAppCommands } from "./commands";
import { ModalHost } from "./ModalHost";
import { confirmWith, toast, useUiStore } from "./ui-store";

/** Shortcuts that still work while an editor has focus. */
const EDITOR_SAFE_COMMANDS = new Set([
	"canvas.save",
	"canvas.saveAll",
	"view.toggleFullscreen",
	"palette.open",
]);

/** The configurable alternative to the palette's default shortcut. */
const ALTERNATIVE_PALETTE_SHORTCUT = "Mod+Shift+P";

const REMEMBER_KEY = "ic.rememberedWorkspace";

const isTextEntry = (target: EventTarget | null): boolean => {
	if (!(target instanceof HTMLElement)) return false;
	if (target.isContentEditable) return true;
	if (target.closest(".cm-editor")) return true;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

const AppInner = () => {
	const flow = useReactFlow<FlowNode, FlowEdge>();
	const workspace = useWorkspaceStore((state) => state.workspace);
	const settings = useWorkspaceStore((state) => state.settings);
	const canvasPath = useCanvasStore((state) => state.path);
	const selectionIds = useCanvasStore((state) => state.selection);
	const selectedEdgeIds = useCanvasStore((state) => state.selectedEdges);
	const activeNodeId = useCanvasStore((state) => state.activeNodeId);
	const document = useCanvasStore((state) => state.document);
	const dirty = useCanvasStore((state) => state.dirty);
	const saving = useCanvasStore((state) => state.saving);
	const conflict = useCanvasStore((state) => state.conflict);
	const lastError = useCanvasStore((state) => state.lastError);
	const viEnabled = useEditorSettings((state) => state.viEnabled);
	const toasts = useUiStore((state) => state.toasts);
	const paletteOpen = useUiStore((state) => state.paletteOpen);
	const modal = useUiStore((state) => state.modal);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		setFlowInstance(flow);
		return () => setFlowInstance(null);
	}, [flow]);

	const context: CommandContext = useMemo(() => {
		const ids = new Set(selectionIds);
		return {
			workspaceRoot: workspace?.root ?? null,
			canvasPath,
			selection: document.nodes.filter((node) => ids.has(node.id)),
			selectedEdgeIds,
			activeNodeId,
			isEditing: activeNodeId !== null,
		};
	}, [
		workspace,
		canvasPath,
		document,
		selectionIds,
		selectedEdgeIds,
		activeNodeId,
	]);

	const contextRef = useRef(context);
	contextRef.current = context;

	/* ------------------------------------------------------------- startup */

	useEffect(() => {
		registerAppCommands();
		for (const conflictText of shortcutConflicts()) {
			console.warn(`shortcut conflict — ${conflictText}`);
		}
		void (async () => {
			await useWorkspaceStore.getState().loadFacts();
			// A directory named on the command line wins; otherwise the last
			// workspace is reopened only when the user approved remembering it.
			const fromArguments =
				useWorkspaceStore.getState().facts?.initialWorkspace ?? null;
			const remembered = fromArguments ?? localStorage.getItem(REMEMBER_KEY);
			if (remembered && isDesktop()) {
				try {
					await useWorkspaceStore.getState().open(remembered);
					const last = useWorkspaceStore.getState().settings.lastCanvas;
					if (last)
						await useCanvasStore
							.getState()
							.load(last)
							.catch(() => undefined);
				} catch {
					if (!fromArguments) localStorage.removeItem(REMEMBER_KEY);
				}
			}
			setReady(true);
		})();
	}, []);

	/* ---------------------------------------------- remember and recovery */

	const askedRef = useRef<string | null>(null);
	useEffect(() => {
		if (!workspace || !ready) return;
		if (askedRef.current === workspace.root) return;
		askedRef.current = workspace.root;

		void (async () => {
			if (localStorage.getItem(REMEMBER_KEY) !== workspace.root) {
				const remember = await confirmWith(
					"Reopen this workspace next time?",
					`${workspace.root} would be stored locally so it opens on start. Nothing is sent anywhere.`,
					"Remember",
				);
				if (remember) localStorage.setItem(REMEMBER_KEY, workspace.root);
			}

			// Offer any unsaved editor content left behind by a crash.
			const records = await ipc.recoveryList().catch(() => []);
			for (const record of records) {
				const restore = await confirmWith(
					"Unsaved changes were recovered",
					`${record.relativePath} has content that was never saved. Restore it into the editor?`,
					"Restore",
				);
				if (restore) {
					useDocumentStore
						.getState()
						.adoptRecovery(
							record.relativePath,
							record.contents,
							record.baseRevision,
						);
				} else {
					await ipc.recoveryClear(record.relativePath).catch(() => undefined);
				}
			}
		})();
	}, [workspace, ready]);

	/* ------------------------------------------------- external file events */

	useEffect(() => {
		if (!isDesktop()) return undefined;
		const unlisten = listen<ChangeEvent>("workspace:changed", (event) => {
			const paths = event.payload.paths;
			void useWorkspaceStore.getState().refreshTree();
			void useCanvasStore.getState().onExternalChange(paths);
			for (const path of paths) {
				invalidateFacts(path);
				void useDocumentStore.getState().reload(path);
			}
		});
		return () => {
			void unlisten.then((off) => off());
		};
	}, []);

	/* ------------------------------------------- files dropped on the window */

	useEffect(() => {
		if (!isDesktop()) return undefined;
		const unlisten = listen<{ paths?: string[] }>(
			"tauri://drag-drop",
			(event) => {
				const paths = event.payload?.paths ?? [];
				if (paths.length === 0) return;
				void (async () => {
					for (const path of paths) {
						try {
							const facts = await ipc.attachmentImport(
								path,
								DEFAULT_DIRECTORIES.attachments,
							);
							if (useCanvasStore.getState().path)
								addFileNode(facts.relativePath);
							toast(`Imported ${facts.relativePath}`);
						} catch (error) {
							toast(errorMessage(error), "error");
						}
					}
					await useWorkspaceStore.getState().refreshTree();
				})();
			},
		);
		return () => {
			void unlisten.then((off) => off());
		};
	}, []);

	/* ------------------------------------------------------ save on leaving */

	useEffect(() => {
		const flush = () => {
			void useCanvasStore.getState().save();
			void useDocumentStore.getState().saveAll();
		};
		window.addEventListener("blur", flush);
		window.addEventListener("beforeunload", flush);
		return () => {
			window.removeEventListener("blur", flush);
			window.removeEventListener("beforeunload", flush);
		};
	}, []);

	// Closing the window waits for pending writes instead of dropping them.
	useEffect(() => {
		if (!isDesktop()) return undefined;
		const appWindow = getCurrentWindow();
		const unlisten = appWindow.onCloseRequested(async (event) => {
			event.preventDefault();
			await useCanvasStore.getState().save({ force: true });
			await useDocumentStore.getState().saveAll();
			await appWindow.destroy();
		});
		return () => {
			void unlisten.then((off) => off());
		};
	}, []);

	/* --------------------------------------------------- keyboard routing */

	const onKeyDown = useCallback((event: KeyboardEvent) => {
		// 1. Modals and the palette handle their own keys.
		if (useUiStore.getState().modal || useUiStore.getState().paletteOpen) {
			return;
		}

		const editing = isTextEntry(event.target);
		const current = contextRef.current;

		// The alternative palette shortcut is accepted alongside the default.
		if (
			normalizeShortcut(ALTERNATIVE_PALETTE_SHORTCUT) ===
			normalizeShortcut(
				`${event.ctrlKey ? "ctrl+" : ""}${event.metaKey ? "meta+" : ""}${
					event.altKey ? "alt+" : ""
				}${event.shiftKey ? "shift+" : ""}${event.key.toLowerCase()}`,
			)
		) {
			event.preventDefault();
			void runCommand("palette.open", current);
			return;
		}

		const command = commandForEvent(event, current);
		if (command) {
			// 2. An active editor keeps its keys, except for a small safe set.
			if (editing && !EDITOR_SAFE_COMMANDS.has(command.id)) return;
			event.preventDefault();
			void command.execute(current);
			return;
		}

		if (editing) return;

		// 3. Canvas-level keys.
		if (event.key === "Backspace") {
			event.preventDefault();
			void runCommand("edit.delete", current);
			return;
		}
		if (
			event.key === "Enter" &&
			current.selection.length === 1 &&
			!current.isEditing
		) {
			const node = current.selection[0];
			if (node && node.type !== "group") {
				if (
					node.type === "file" &&
					!canActivateFileKind(cachedFileKind(node.file))
				)
					return;
				event.preventDefault();
				useCanvasStore.getState().setActiveNode(node.id);
			}
			return;
		}
		if (event.key === "Escape") {
			const store = useCanvasStore.getState();
			if (store.activeNodeId) store.setActiveNode(null);
			else store.setSelection([]);
		}
	}, []);

	useEffect(() => {
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onKeyDown]);

	const showMinimap = settings.ui.minimap === true;

	return (
		<div className="app">
			<CanvasView showMinimap={showMinimap} />

			{!canvasPath ? (
				<div className="hint">
					<div>
						{workspace
							? `${workspace.name} — no canvas open`
							: "No workspace open"}
					</div>
					<div>
						Press <kbd>{displayShortcut("Mod+P")}</kbd> for commands
					</div>
				</div>
			) : null}

			<div className="status-bar">
				<span>{canvasPath ?? workspace?.name ?? "ic"}</span>
				{saving ? (
					<span>saving</span>
				) : dirty ? (
					<span className="dirty">unsaved</span>
				) : null}
				{viEnabled ? <span>vi</span> : null}
				{selectionIds.length > 0 ? (
					<span>{selectionIds.length} selected</span>
				) : null}
			</div>

			{conflict ? (
				<div className="toast error">
					<span>{conflict.relativePath} changed on disk.</span>
					<button
						type="button"
						className="icon-button"
						style={{ width: "auto", padding: "0 8px" }}
						onClick={() =>
							void useCanvasStore.getState().resolveConflict("take-disk")
						}
					>
						Use disk version
					</button>
					<button
						type="button"
						className="icon-button"
						style={{ width: "auto", padding: "0 8px" }}
						onClick={() =>
							void useCanvasStore.getState().resolveConflict("keep-mine")
						}
					>
						Keep mine
					</button>
				</div>
			) : null}

			{lastError ? (
				<div className="toast error">
					<span>{lastError}</span>
					<button
						type="button"
						className="icon-button"
						style={{ width: "auto", padding: "0 8px" }}
						onClick={() => useCanvasStore.getState().clearError()}
					>
						Dismiss
					</button>
				</div>
			) : null}

			{toasts.map((entry) => (
				<div
					key={entry.id}
					className={`toast ${entry.tone === "error" ? "error" : ""}`}
				>
					{entry.message}
				</div>
			))}

			{paletteOpen ? <CommandPalette context={context} /> : null}
			{modal ? <ModalHost /> : null}
		</div>
	);
};

export const App = () => (
	<ReactFlowProvider>
		<AppInner />
	</ReactFlowProvider>
);
