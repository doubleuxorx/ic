/**
 * Audio view.
 *
 * Shares the player used by video nodes. Waveforms, cover art and track
 * metadata for formats the webview cannot open belong to the media phase and
 * are deliberately absent here.
 */

import { memo } from 'react';

import { MediaPlayer, type MediaProps } from './VideoNode';

const AudioNodeComponent = (props: Omit<MediaProps, 'audioOnly'>) => (
  <MediaPlayer {...props} audioOnly />
);

export const AudioNode = memo(AudioNodeComponent);
