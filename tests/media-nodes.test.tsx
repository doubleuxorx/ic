// @vitest-environment jsdom
/**
 * Audio and video nodes: where the bytes come from, and what happens when the
 * webview will not take them.
 *
 * jsdom has no codecs, so nothing here plays. What it can say is which URL the
 * element was given, which is the whole of the Linux transport decision, and what
 * the node does with an element that refuses its source — the failure that drew a
 * crash overlay reading "undefined" over a working application.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/ipc-types', async () => {
  const { fakeIpc } = await import('./support/fake-ipc');
  return { ipc: fakeIpc, isDesktop: () => true };
});

import { useCanvasStore } from '@/canvas/canvas-store';
import { AudioNode } from '@/media/AudioNode';
import { useMediaStore } from '@/media/media-view-store';
import { VideoNode } from '@/media/VideoNode';
import { useWorkspaceStore } from '@/workspace/workspace-store';

import { backend, openFixtureWorkspace } from './support/fake-ipc';
import { button, cleanup, click, fire, render, settle } from './support/render';
import { resetStores } from './support/stores';

const media = (host: ParentNode) =>
  host.querySelector<HTMLMediaElement>('video, audio') ?? undefined;

/** What Rust reported about where media is fetched from. */
const facts = (mediaOrigin: string | null) => {
  backend.facts = { ...backend.facts, mediaOrigin };
  useWorkspaceStore.setState({ facts: backend.facts });
};

beforeEach(async () => {
  resetStores();
  backend.reset();
  await openFixtureWorkspace();
  facts(null);
});

afterEach(async () => {
  await cleanup();
});

describe('where the bytes come from', () => {
  it('streams from the custom scheme when the webview can decode it', async () => {
    const node = await render(
      <VideoNode nodeId="n1" relativePath="Attachments/tiny.mp4" active />,
    );
    await settle();

    expect(node.find<HTMLVideoElement>('video').getAttribute('src')).toBe(
      'ic://localhost/Attachments/tiny.mp4',
    );
  });

  /**
   * WebKitGTK decodes through GStreamer, which fetches only the schemes it
   * knows, so on Linux the same file is served over loopback HTTP instead. The
   * node must follow whatever Rust says without knowing why.
   */
  it('streams from the loopback server when Rust reports one', async () => {
    facts('http://127.0.0.1:45678/0f9a');
    const node = await render(
      <VideoNode nodeId="n1" relativePath="Attachments/tiny.mp4" active />,
    );
    await settle();

    expect(node.find<HTMLVideoElement>('video').getAttribute('src')).toBe(
      'http://127.0.0.1:45678/0f9a/Attachments/tiny.mp4',
    );
  });

  it('encodes every segment of an awkward path', async () => {
    backend.write('Attachments/a b & c.mp4', 'pretend video');
    const node = await render(
      <VideoNode nodeId="n1" relativePath="Attachments/a b & c.mp4" active />,
    );
    await settle();

    expect(node.find<HTMLVideoElement>('video').getAttribute('src')).toBe(
      'ic://localhost/Attachments/a%20b%20%26%20c.mp4',
    );
  });
});

describe('a source the webview will not take', () => {
  it('offers the system player instead of failing silently', async () => {
    const node = await render(
      <VideoNode nodeId="n1" relativePath="Attachments/tiny.mp4" active />,
    );
    await settle();

    await fire(node.find('video'), new Event('error'));

    expect(node.text()).toContain('not playable in this window');
    // The offer is the way out, and it opens the file rather than a URL.
    await click(button(node.host, 'Open externally'));
    expect(backend.callsTo('external_open_path')).toEqual([
      { relativePath: 'Attachments/tiny.mp4' },
    ]);
  });

  /**
   * The element's `error` event is not an application failure, and the guard that
   * decides so is loaded before anything else. Reporting it covered a working
   * window with an overlay whose only text was "undefined".
   */
  it('is not reported as a crash', async () => {
    await import('@/boot-guard');
    const node = await render(
      <VideoNode nodeId="n1" relativePath="Attachments/tiny.mp4" active />,
    );
    await settle();

    await fire(node.find('video'), new Event('error'));

    expect(document.getElementById('fatal')).toBeNull();
  });

  it('offers the player for a container Rust already knows about', async () => {
    const node = await render(
      <VideoNode nodeId="n1" relativePath="Attachments/tiny.mkv" active />,
    );
    await settle();

    // No element is mounted at all: there is nothing to try.
    expect(node.query('video')).toBeNull();
    expect(node.text()).toContain('MKV is not playable');
  });

  it('shows what a refused probe said', async () => {
    backend.refuse.set('Attachments/tiny.mp4', 'file type is not supported: Attachments/tiny.mp4');
    const node = await render(
      <VideoNode nodeId="n1" relativePath="Attachments/tiny.mp4" active />,
    );
    await settle();

    expect(node.text()).toContain('not supported');
    expect(node.query('video')).toBeNull();
  });

  it('tries again when the node is pointed at another file', async () => {
    const node = await render(
      <VideoNode nodeId="n1" relativePath="Attachments/tiny.mp4" active />,
    );
    await settle();
    await fire(node.find('video'), new Event('error'));
    expect(node.query('video')).toBeNull();

    await node.update(<VideoNode nodeId="n1" relativePath="Attachments/tiny.webm" active />);
    backend.write('Attachments/tiny.webm', 'pretend video');
    await settle();

    expect(node.query('video')).not.toBeNull();
  });
});

describe('one node plays at a time', () => {
  it('claims playback when it starts and releases it when it stops', async () => {
    const node = await render(
      <AudioNode nodeId="n1" relativePath="Attachments/tiny.mp3" active />,
    );
    await settle();

    await fire(media(node.host)!, new Event('play'));
    expect(useMediaStore.getState().playingNodeId).toBe('n1');

    await fire(media(node.host)!, new Event('pause'));
    expect(useMediaStore.getState().playingNodeId).toBeNull();
  });

  it('stops when another node takes over', async () => {
    const first = await render(
      <AudioNode nodeId="n1" relativePath="Attachments/tiny.mp3" active />,
    );
    await settle();
    const element = media(first.host)!;
    const paused = vi.spyOn(element, 'pause').mockImplementation(() => undefined);

    await fire(element, new Event('play'));
    expect(useMediaStore.getState().playingNodeId).toBe('n1');

    // A second node starting is what the store hears; the first must stop.
    useMediaStore.getState().claimPlayback('n2');
    await settle();

    expect(paused).toHaveBeenCalled();
  });

  /**
   * The element itself is what stops when the node goes: React detaches the ref
   * before the cleanup runs, so the pause there cannot be what saves it. What
   * must not survive is the claim, or the next node to play would find playback
   * already taken by something that no longer exists.
   */
  it('never leaves a claim behind after the node is gone', async () => {
    const node = await render(
      <AudioNode nodeId="n1" relativePath="Attachments/tiny.mp3" active />,
    );
    await settle();
    await fire(media(node.host)!, new Event('play'));
    expect(useMediaStore.getState().playingNodeId).toBe('n1');

    await node.unmount();

    expect(useMediaStore.getState().playingNodeId).toBeNull();
    expect(document.querySelector('audio')).toBeNull();
  });
});

describe('the controls', () => {
  it('reports the duration the element found and follows the position', async () => {
    const node = await render(
      <VideoNode nodeId="n1" relativePath="Attachments/tiny.mp4" active />,
    );
    await settle();
    const element = node.find<HTMLVideoElement>('video');

    Object.defineProperty(element, 'duration', { value: 83, configurable: true });
    await fire(element, new Event('loadedmetadata'));
    expect(node.text()).toContain('1:23');

    Object.defineProperty(element, 'currentTime', { value: 5, configurable: true });
    await fire(element, new Event('timeupdate'));
    expect(node.text()).toContain('0:05');
  });

  it('mutes and unmutes the element itself', async () => {
    const node = await render(
      <VideoNode nodeId="n1" relativePath="Attachments/tiny.mp4" active />,
    );
    await settle();
    const element = node.find<HTMLVideoElement>('video');

    await click(node.find('[aria-label="Mute"]'));
    expect(element.muted).toBe(true);
    await click(node.find('[aria-label="Unmute"]'));
    expect(element.muted).toBe(false);
  });

  it('does not autoplay, and asks for metadata only', async () => {
    const node = await render(
      <VideoNode nodeId="n1" relativePath="Attachments/tiny.mp4" active />,
    );
    await settle();
    const element = node.find<HTMLVideoElement>('video');

    expect(element.autoplay).toBe(false);
    expect(element.getAttribute('preload')).toBe('metadata');
    expect(useMediaStore.getState().playingNodeId).toBeNull();
  });
});

describe('the canvas is not touched by playback', () => {
  it('leaves the document alone while a node plays', async () => {
    useCanvasStore.setState({ path: 'Canvases/Main.canvas', dirty: false });
    const node = await render(
      <AudioNode nodeId="n1" relativePath="Attachments/tiny.mp3" active />,
    );
    await settle();
    await fire(media(node.host)!, new Event('play'));

    // Playback is interaction state: nothing about it is ever persisted.
    expect(useCanvasStore.getState().dirty).toBe(false);
    expect(backend.callsTo('document_write')).toEqual([]);
  });
});
