/**
 * The application testing itself, in a real webview.
 *
 * Every other test in this repository runs without a browser, which is exactly
 * why this one exists: no amount of jsdom can tell you whether WebKitGTK will
 * decode an MP3, whether PDF.js painted anything, or whether the content security
 * policy silently blocked a request. Those failures live inside the webview, and
 * one of them shipped — media served from `ic://` never reached a decoder on
 * Linux, and the window said nothing at all.
 *
 * So this drives the real nodes over real fixtures and asks the browser for its
 * own numbers: `naturalWidth`, `readyState`, `currentTime`, the pixels on a
 * canvas. No screenshots, no synthetic input, nothing to compare by eye.
 *
 * It reports by writing a text file into the scratch workspace through the
 * ordinary `document_create` command, so nothing is added to the privileged
 * surface for testing's sake. `scripts/self-test.sh` waits for that file.
 *
 * This module is only imported when the frontend is built with `--mode selftest`,
 * so a release bundle does not contain it.
 */

import { useUiStore } from '@/app/ui-store';
import { useCanvasStore } from '@/canvas/canvas-store';
import { errorMessage } from '@/shared/errors';
import { ipc } from '@/shared/ipc-types';
import { createId, type CanvasNode } from '@/shared/json-canvas';
import { useWorkspaceStore } from '@/workspace/workspace-store';

const REPORT_FILE = 'self-test-report.txt';
/** Long enough for a cold decoder on a busy machine, short enough to fail. */
const PATIENCE_MS = 12_000;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
const violations: string[] = [];

/** Anything the policy blocked, whether or not the application noticed. */
document.addEventListener('securitypolicyviolation', (event) => {
  violations.push(`${event.violatedDirective} blocked ${event.blockedURI}`);
});

const record = (name: string, ok: boolean, detail = ''): void => {
  checks.push({ name, ok, detail });
  // Also on stdout of the process, so a failure is readable in a CI log even if
  // the report never gets written.
  console.log(`${ok ? 'ok' : 'FAILED'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const check = async (name: string, run: () => Promise<string>): Promise<void> => {
  try {
    record(name, true, await run());
  } catch (error) {
    // Through `errorMessage`, because a refusal from Rust is an object and a
    // report that says "[object Object]" explains nothing.
    record(name, false, errorMessage(error));
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Write a file whether or not an earlier page load left one behind.
 *
 * `document_create` refuses a file that exists, and a window can be reloaded in
 * the middle of a run — the dev server does exactly that the first time it
 * pre-bundles a dependency. The reloaded window starts the whole run again, so
 * the results are still a run's worth; only the file is already there, and
 * refusing it reported a conflict that explained nothing. Nothing privileged is
 * added for this: it is the two ordinary commands the editor uses.
 */
const writeFile = async (relativePath: string, contents: string): Promise<string> => {
  try {
    await ipc.documentCreate(relativePath, contents);
    return 'created';
  } catch {
    const existing = await ipc.documentRead(relativePath);
    await ipc.documentWrite(relativePath, existing.revision, contents);
    return 'replaced one from an earlier page load';
  }
};

/** Wait for something to become true, or say what it still was. */
const until = async <T>(
  what: string,
  probe: () => T | null | undefined | false,
  timeout = PATIENCE_MS,
): Promise<T> => {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
};

/** Answer any question the application asks, so nothing blocks on a dialog. */
const answerModals = (): void => {
  useUiStore.subscribe((state) => {
    const modal = state.modal;
    if (!modal) return;
    if (modal.kind === 'confirm') modal.resolve(false);
    else if (modal.kind === 'prompt') modal.resolve(null);
    else if (modal.kind === 'file') modal.resolve(null);
    else modal.resolve(undefined);
  });
};

/**
 * Nodes laid out to fit the window at zoom 1, all four at once.
 *
 * The canvas renders only what is in view, so a node parked off screen never
 * mounts its viewer and a check on it would be waiting for something that was
 * never asked to exist.
 */
const fileNode = (path: string, index: number): CanvasNode =>
  ({
    id: createId(),
    type: 'file',
    file: path,
    x: (index % 2) * 620,
    y: Math.floor(index / 2) * 380,
    width: 560,
    height: 320,
  }) as CanvasNode;

/** Whatever the node put on screen, for a failure that has to explain itself. */
const shown = (node: CanvasNode): string => {
  const element = document.querySelector(`[data-id="${node.id}"]`);
  const text = element?.textContent?.replace(/\s+/g, ' ').trim();
  return text ? `the node shows "${text}"` : 'the node rendered nothing';
};

/** Mount one node as the active one, which is what loads a real viewer. */
const activate = async (node: CanvasNode, selector: string): Promise<Element> => {
  const file = (node as { file: string }).file;
  useCanvasStore.getState().setSelection([node.id]);
  useCanvasStore.getState().setActiveNode(node.id);
  try {
    return await until(`${selector} for ${file}`, () =>
      document.querySelector(`[data-id="${node.id}"] ${selector}`) ??
      document.querySelector(selector),
    );
  } catch {
    throw new Error(`no ${selector} for ${file}: ${shown(node)}`);
  }
};

const decoded = async (image: HTMLImageElement): Promise<string> => {
  await until('the image to load', () => image.complete && image.naturalWidth > 0);
  if (typeof image.decode === 'function') await image.decode();
  return `${image.naturalWidth}x${image.naturalHeight} from ${image.getAttribute('src')}`;
};

/** A canvas that painted something has more than one colour in it. */
const painted = (canvas: HTMLCanvasElement): boolean => {
  const context = canvas.getContext('2d');
  if (!context || canvas.width === 0) return false;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const first = [data[0], data[1], data[2], data[3]].join();
  for (let index = 4; index < data.length; index += 4) {
    if ([data[index], data[index + 1], data[index + 2], data[index + 3]].join() !== first) {
      return true;
    }
  }
  return false;
};

/**
 * Playback, asked of the element rather than assumed.
 *
 * `duration` proves the container and codec were understood; `currentTime`
 * advancing proves frames or samples are actually being produced. The second is
 * the one that was false for every media file on Linux while every other signal
 * looked healthy.
 */
const plays = async (element: HTMLMediaElement, what: string): Promise<string> => {
  const failure = () =>
    element.error ? ` (${what} error ${element.error.code}: ${element.error.message})` : '';

  const duration = await until(
    `${what} metadata${failure()}`,
    () => Number.isFinite(element.duration) && element.duration > 0 && element.duration,
  );

  // No audio device exists under a virtual display, and a muted element does not
  // need one.
  element.muted = true;
  await element.play();
  const from = element.currentTime;
  const reached = await until(
    `${what} to advance past ${from.toFixed(2)}s${failure()}`,
    () => element.currentTime > from + 0.05 && element.currentTime,
  );
  element.pause();
  // The token in a loopback URL is a secret for this run; the report is an
  // artifact, so it says where the bytes came from without handing it over.
  const source = (element.getAttribute('src') ?? '').replace(/\/[0-9a-f]{64}\//, '/<token>/');
  return `${what} ${duration.toFixed(2)}s long, played to ${reached.toFixed(2)}s from ${source}`;
};

const run = async (): Promise<void> => {
  answerModals();

  await check('startup: the window is the application, not a crash overlay', async () => {
    await until('the application to mount', () => document.querySelector('.app'));
    const overlay = document.getElementById('fatal');
    if (overlay) throw new Error(`the crash overlay is showing: ${overlay.textContent}`);
    return 'mounted';
  });

  await check('startup: the workspace named on the command line is open', async () => {
    const workspace = await until(
      'the workspace to open',
      () => useWorkspaceStore.getState().workspace,
    );
    // Separately, and not just read once: the store publishes the workspace
    // before the listing it then asks Rust for, so the tree arrives later.
    const tree = await until('the workspace to list its files', () => {
      const entries = useWorkspaceStore.getState().tree;
      return entries.length > 0 && entries;
    });
    return `${workspace.root} with ${tree.length} entries`;
  });

  const facts = useWorkspaceStore.getState().facts;
  await check('media: Rust decided where media is fetched from', async () =>
    facts?.mediaOrigin
      ? `over loopback from ${facts.mediaOrigin.replace(/\/[0-9a-f]{64}$/, '/<token>')}`
      : `from the ${facts?.protocolScheme} scheme`,
  );

  const nodes = [
    'Attachments/sample.png',
    'Attachments/sample.pdf',
    'Attachments/tiny.mp3',
    'Attachments/tiny.mp4',
  ].map(fileNode);

  await check('canvas: a canvas of every kind of attachment opens', async () => {
    const written = await writeFile(
      'Canvases/Self-test.canvas',
      JSON.stringify({ nodes, edges: [] }, null, 2),
    );
    await useCanvasStore.getState().load('Canvases/Self-test.canvas');
    await until('the canvas to hold the nodes', () =>
      useCanvasStore.getState().document.nodes.length === nodes.length,
    );
    return `${nodes.length} nodes, ${written}`;
  });

  await check('image: the webview decoded a PNG served by the protocol handler', async () => {
    const image = await activate(nodes[0] as CanvasNode, 'img.media-fill');
    return decoded(image as HTMLImageElement);
  });

  await check('pdf: PDF.js painted a page', async () => {
    const node = nodes[1] as CanvasNode;
    await activate(node, 'canvas');
    const canvases = () => [...document.querySelectorAll<HTMLCanvasElement>('canvas')];
    try {
      const canvas = await until('a painted PDF canvas', () => canvases().find(painted));
      return `${canvas.width}x${canvas.height} pixels drawn`;
    } catch {
      const sizes = canvases().map((canvas) => `${canvas.width}x${canvas.height}`).join(', ');
      throw new Error(`nothing was painted; canvases: ${sizes || 'none'}; ${shown(node)}`);
    }
  });

  await check('audio: the webview played an MP3', async () => {
    const element = await activate(nodes[2] as CanvasNode, 'audio');
    return plays(element as HTMLMediaElement, 'audio');
  });

  await check('video: the webview played an MP4', async () => {
    const element = await activate(nodes[3] as CanvasNode, 'video');
    return plays(element as HTMLMediaElement, 'video');
  });

  await check('policy: nothing was blocked by the content security policy', async () => {
    if (violations.length > 0) throw new Error(violations.join('; '));
    return 'no violations';
  });

  await check('startup: still no crash overlay after all of that', async () => {
    const overlay = document.getElementById('fatal');
    if (overlay) throw new Error(`the crash overlay appeared: ${overlay.textContent}`);
    return 'clean';
  });
};

export const start = async (): Promise<void> => {
  let fatal: string | null = null;
  try {
    await run();
  } catch (error) {
    fatal = error instanceof Error ? error.message : String(error);
  }

  const failed = checks.filter((entry) => !entry.ok);
  const report = {
    ok: failed.length === 0 && fatal === null,
    platform: useWorkspaceStore.getState().facts?.platform ?? 'unknown',
    userAgent: navigator.userAgent,
    ...(fatal ? { fatal } : {}),
    checks,
  };

  // Written through the same validated commands the editor uses; there is no
  // command that exists only for testing.
  await writeFile(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`).catch((error: unknown) => {
    console.log(`the report could not be written: ${errorMessage(error)}`);
  });
  console.log(`self-test ${report.ok ? 'passed' : 'FAILED'}`);
};
