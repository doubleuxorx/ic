/**
 * Video view.
 *
 * An ordinary HTML media element streams the file, byte range by byte range, so
 * seeking never buffers the whole of it. Where that comes from is Rust's to say
 * — `mediaUrl` follows whichever transport this webview can actually decode
 * from — and nothing else here depends on the answer. Nothing autoplays, only
 * one node plays at a time, and playback stops when the node unmounts.
 *
 * Container support is probed in Rust; codec support is asked of the webview
 * itself rather than inferred from the extension. A webview that refuses the
 * source says so through the element's own error event, and the node then offers
 * the system player.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';

import { errorMessage } from '@/shared/errors';
import { ipc, type MediaProbe } from '@/shared/ipc-types';
import { mediaUrl } from '@/workspace/workspace-store';

import { Icon } from '@/canvas/node-types/NodeShell';
import { formatDuration, useMediaStore } from './media-view-store';

export interface MediaProps {
  nodeId: string;
  relativePath: string;
  active: boolean;
  audioOnly?: boolean;
}

/** Shared by video and audio nodes; only the element and layout differ. */
export const MediaPlayer = ({ nodeId, relativePath, active, audioOnly = false }: MediaProps) => {
  const element = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  const [probe, setProbe] = useState<MediaProbe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  /** Set when the element itself rejected the source it was given. */
  const [refused, setRefused] = useState(false);

  const playingNodeId = useMediaStore((state) => state.playingNodeId);
  const claim = useMediaStore((state) => state.claimPlayback);
  const release = useMediaStore((state) => state.releasePlayback);

  useEffect(() => {
    let cancelled = false;
    setRefused(false);
    ipc
      .mediaProbe(relativePath)
      .then((result) => {
        if (!cancelled) setProbe(result);
      })
      .catch((probeError) => {
        if (!cancelled) setError(errorMessage(probeError));
      });
    return () => {
      cancelled = true;
    };
  }, [relativePath]);

  // Another node taking over playback pauses this one.
  useEffect(() => {
    if (playingNodeId !== nodeId && playing) {
      element.current?.pause();
    }
  }, [playingNodeId, nodeId, playing]);

  // Removing or deselecting the node must never leave audio running.
  useEffect(
    () => () => {
      element.current?.pause();
      release(nodeId);
    },
    [nodeId, release],
  );

  const toggle = useCallback(() => {
    const media = element.current;
    if (!media) return;
    if (media.paused) {
      claim(nodeId);
      void media.play().catch((playError) => setError(errorMessage(playError)));
    } else {
      media.pause();
    }
  }, [claim, nodeId]);

  if (error && !probe) {
    return <div className="placeholder">{error}</div>;
  }

  // Either Rust knows the container will not play, or the element has just said
  // so about this file. Both end in the same offer.
  const unplayable =
    refused || probe?.strategy === 'external-player'
      ? `${(probe?.container ?? '').toUpperCase() || 'This file'} is not playable in this window yet.`
      : null;

  if (unplayable) {
    return (
      <div className="placeholder">
        <div>
          <div>{unplayable}</div>
          <button
            type="button"
            className="icon-button nodrag"
            title="Open in the system player"
            style={{ marginTop: 8, width: 'auto', padding: '0 8px' }}
            onClick={() => void ipc.openPath(relativePath).catch(() => undefined)}
          >
            Open externally
          </button>
        </div>
      </div>
    );
  }

  const MediaTag = (audioOnly ? 'audio' : 'video') as 'video';

  return (
    <>
      <MediaTag
        ref={element as React.RefObject<HTMLVideoElement>}
        className="media-fill nodrag"
        src={mediaUrl(relativePath)}
        // Metadata only: a canvas full of videos must not preload their content.
        preload="metadata"
        playsInline
        controls={false}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onPlay={() => {
          setPlaying(true);
          claim(nodeId);
        }}
        onPause={() => {
          setPlaying(false);
          release(nodeId);
        }}
        onEnded={() => {
          setPlaying(false);
          release(nodeId);
        }}
        onError={() => setRefused(true)}
        onDoubleClick={(event) => {
          event.stopPropagation();
          if (!audioOnly) void event.currentTarget.requestFullscreen?.().catch(() => undefined);
        }}
        style={audioOnly ? { height: 0, display: 'block' } : undefined}
      />
      {audioOnly ? (
        <div className="placeholder">{error ?? formatDuration(duration)}</div>
      ) : null}
      <div className="media-controls nodrag nopan">
        <button
          type="button"
          className="icon-button"
          title={playing ? 'Pause' : 'Play'}
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={toggle}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Icon name={playing ? 'pause' : 'play'} />
        </button>
        <span className="time">{formatDuration(position)}</span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step={0.1}
          value={position}
          aria-label="Seek"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            const media = element.current;
            if (!media) return;
            media.currentTime = Number(event.target.value);
            setPosition(media.currentTime);
          }}
        />
        <span className="time">{formatDuration(duration)}</span>
        <button
          type="button"
          className="icon-button"
          title={muted ? 'Unmute' : 'Mute'}
          aria-label={muted ? 'Unmute' : 'Mute'}
          onClick={() => {
            const media = element.current;
            if (!media) return;
            media.muted = !media.muted;
            setMuted(media.muted);
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Icon name={muted ? 'minus' : 'plus'} />
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.02}
          value={volume}
          aria-label="Volume"
          style={{ maxWidth: 64 }}
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            const media = element.current;
            if (!media) return;
            media.volume = Number(event.target.value);
            setVolume(media.volume);
          }}
        />
      </div>
      {error && active ? <div className="vi-indicator">{error}</div> : null}
    </>
  );
};

export const VideoNode = memo(MediaPlayer);
