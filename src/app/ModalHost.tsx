/**
 * Renders whichever modal a command or node asked for.
 *
 * Modals are the only chrome besides the palette, and each one resolves the
 * promise its caller is awaiting.
 */

import { useEffect, useRef, useState } from 'react';

import { PRESET_COLORS, normalizeColor } from '@/shared/json-canvas';
import { FileTree } from '@/workspace/FileTree';

import { useUiStore } from './ui-store';

const PresetSwatches = ({ onPick }: { onPick: (value: string | null) => void }) => (
  <div className="color-grid">
    <button
      type="button"
      className="color-swatch none"
      title="No colour"
      aria-label="No colour"
      onClick={() => onPick(null)}
    />
    {PRESET_COLORS.map((preset) => (
      <button
        key={preset}
        type="button"
        className="color-swatch"
        style={{ background: `var(--canvas-color-${preset})` }}
        title={`Preset ${preset}`}
        aria-label={`Preset ${preset}`}
        onClick={() => onPick(preset)}
      />
    ))}
  </div>
);

export const ModalHost = () => {
  const modal = useUiStore((state) => state.modal);
  const [value, setValue] = useState('');
  const [custom, setCustom] = useState('#');
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (modal?.kind === 'prompt') setValue(modal.value);
    if (modal?.kind === 'color') setCustom('#');
    const id = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [modal]);

  const dismiss = () => {
    if (!modal) return;
    if (modal.kind === 'prompt') modal.resolve(null);
    else if (modal.kind === 'confirm') modal.resolve(false);
    else if (modal.kind === 'color') modal.resolve(undefined);
    else modal.resolve(null);
  };

  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  // Escape closes the modal wherever focus happens to be.
  useEffect(() => {
    if (!modal) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      dismissRef.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [modal]);

  if (!modal) return null;

  return (
    <div
      className="overlay"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      {modal.kind === 'file' ? (
        <FileTree title={modal.title} kinds={modal.kinds} onPick={modal.resolve} />
      ) : (
        <div className="dialog" role="dialog" aria-label={modal.title}>
          <h2>{modal.title}</h2>
          {modal.kind === 'prompt' && modal.message ? <p>{modal.message}</p> : null}
          {modal.kind === 'confirm' ? <p>{modal.message}</p> : null}

          {modal.kind === 'prompt' ? (
            <input
              ref={input}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') modal.resolve(value);
                if (event.key === 'Escape') modal.resolve(null);
              }}
            />
          ) : null}

          {modal.kind === 'color' ? (
            <>
              <PresetSwatches onPick={(preset) => modal.resolve(preset)} />
              <input
                ref={input}
                value={custom}
                placeholder="#rrggbb"
                aria-label="Custom colour"
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') {
                    const parsed = normalizeColor(custom);
                    if (parsed) modal.resolve(parsed);
                  }
                  if (event.key === 'Escape') modal.resolve(undefined);
                }}
              />
            </>
          ) : null}

          <div className="row">
            <button type="button" onClick={dismiss}>
              Cancel
            </button>
            {modal.kind === 'prompt' ? (
              <button type="button" className="primary" onClick={() => modal.resolve(value)}>
                {modal.confirmLabel ?? 'OK'}
              </button>
            ) : null}
            {modal.kind === 'confirm' ? (
              <button type="button" className="primary" onClick={() => modal.resolve(true)}>
                {modal.confirmLabel ?? 'Continue'}
              </button>
            ) : null}
            {modal.kind === 'color' ? (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const parsed = normalizeColor(custom);
                  modal.resolve(parsed ?? undefined);
                }}
              >
                Use custom
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
};
