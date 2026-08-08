// @vitest-environment jsdom

import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { viLite, viMode } from "@/editor/vi-mode";

import { press } from "./support/render";

const views: EditorView[] = [];

const editor = (doc: string, line = 1): EditorView => {
	const state = EditorState.create({ doc, extensions: [viLite()] });
	const view = new EditorView({ state, parent: document.body });
	view.dispatch({
		selection: EditorSelection.cursor(view.state.doc.line(line).from),
	});
	views.push(view);
	return view;
};

const cursorLine = (view: EditorView): number =>
	view.state.doc.lineAt(view.state.selection.main.head).number;

/** Reproduce the separate modifier event sent by a physical Shift+G chord. */
const pressUppercaseG = async (view: EditorView): Promise<void> => {
	view.contentDOM.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "Shift",
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		}),
	);
	await press(view.contentDOM, "G", { shiftKey: true });
};

afterEach(() => {
	for (const view of views.splice(0)) view.destroy();
	document.body.innerHTML = "";
});

describe("Vi G motions", () => {
	it("moves bare uppercase G to the final line", async () => {
		const view = editor("one\ntwo\n  three");

		await pressUppercaseG(view);

		expect(cursorLine(view)).toBe(3);
		expect(view.state.selection.main.head).toBe(
			view.state.doc.line(3).from + 2,
		);
	});

	it("uses the number before uppercase G as a one-based line number", async () => {
		const doc = Array.from(
			{ length: 12 },
			(_, index) => `line ${index + 1}`,
		).join("\n");
		const view = editor(doc, 4);

		await press(view.contentDOM, "1");
		await pressUppercaseG(view);
		expect(cursorLine(view)).toBe(1);

		await press(view.contentDOM, "3");
		await pressUppercaseG(view);
		expect(cursorLine(view)).toBe(3);

		await press(view.contentDOM, "1");
		await press(view.contentDOM, "2");
		await pressUppercaseG(view);
		expect(cursorLine(view)).toBe(12);
	});

	it("does not treat lowercase g as the G motion", async () => {
		const view = editor("one\ntwo\nthree", 2);

		await press(view.contentDOM, "1");
		await press(view.contentDOM, "g");

		expect(cursorLine(view)).toBe(2);
	});
});

describe("Vi r", () => {
	it("writes the next key over the character under the cursor", async () => {
		const view = editor("cat");

		await press(view.contentDOM, "r");
		await press(view.contentDOM, "b");

		expect(view.state.doc.toString()).toBe("bat");
		// The cursor stays on the character it replaced, and the mode does not
		// change: `r` is a one-shot, not a way into insert mode.
		expect(view.state.selection.main.head).toBe(0);
		expect(viMode(view.state)).toBe("normal");
	});

	it("takes a command key as plain text", async () => {
		const view = editor("cat");

		await press(view.contentDOM, "r");
		await press(view.contentDOM, "i");

		expect(view.state.doc.toString()).toBe("iat");
		expect(viMode(view.state)).toBe("normal");
	});

	it("cancels on Escape and hands the next key back to normal mode", async () => {
		const view = editor("cat");

		await press(view.contentDOM, "r");
		await press(view.contentDOM, "Escape");
		expect(view.state.doc.toString()).toBe("cat");

		await press(view.contentDOM, "x");
		expect(view.state.doc.toString()).toBe("at");
	});

	it("replaces nothing at the end of a line", async () => {
		const view = editor("cat\ndog");
		view.dispatch({
			selection: EditorSelection.cursor(view.state.doc.line(1).to),
		});

		await press(view.contentDOM, "r");
		await press(view.contentDOM, "b");

		expect(view.state.doc.toString()).toBe("cat\ndog");
	});

	it("overwrites a visual selection but keeps its line breaks", async () => {
		const view = editor("cat\ndog");

		await press(view.contentDOM, "v");
		for (let index = 0; index < 5; index += 1) {
			await press(view.contentDOM, "l");
		}
		await press(view.contentDOM, "r");
		await press(view.contentDOM, "-");

		// The selection reaches up to the cursor and not past it, as it does for
		// visual `x` and `d`.
		expect(view.state.doc.toString()).toBe("---\n-og");
		expect(viMode(view.state)).toBe("normal");
	});
});
