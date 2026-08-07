/**
 * Transient UI state: the command palette, modal requests and toasts.
 *
 * Modals are requested imperatively from commands and node components and are
 * awaited as promises, which keeps callers linear and avoids scattering dialog
 * state through the component tree.
 */

import { create } from 'zustand';

import type { CanvasColor } from '@/shared/json-canvas';
import type { FileKind } from '@/shared/ipc-types';

export interface PromptRequest {
  kind: 'prompt';
  title: string;
  message?: string;
  value: string;
  confirmLabel?: string;
  resolve: (value: string | null) => void;
}

export interface ConfirmRequest {
  kind: 'confirm';
  title: string;
  message: string;
  confirmLabel?: string;
  resolve: (value: boolean) => void;
}

export interface ColorRequest {
  kind: 'color';
  title: string;
  /** `null` clears the colour; `undefined` means the user cancelled. */
  resolve: (value: CanvasColor | null | undefined) => void;
}

export interface FileRequest {
  kind: 'file';
  title: string;
  kinds: FileKind[];
  resolve: (relativePath: string | null) => void;
}

export interface InfoRow {
  label: string;
  value: string;
}

/** Read-only: a list of facts about the application, with nothing to answer. */
export interface InfoRequest {
  kind: 'info';
  title: string;
  rows: InfoRow[];
  resolve: (value: null) => void;
}

export type ModalRequest =
  | PromptRequest
  | ConfirmRequest
  | ColorRequest
  | FileRequest
  | InfoRequest;

export interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'error';
}

interface UiStore {
  paletteOpen: boolean;
  modal: ModalRequest | null;
  toasts: Toast[];
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  closeModal: () => void;
  pushToast: (message: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
  request: (modal: ModalRequest) => void;
}

let toastId = 0;

export const useUiStore = create<UiStore>((set, get) => ({
  paletteOpen: false,
  modal: null,
  toasts: [],

  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),

  closeModal: () => set({ modal: null }),

  pushToast: (message, tone = 'info') => {
    const id = (toastId += 1);
    set({ toasts: [...get().toasts, { id, message, tone }] });
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 6000 : 3000);
  },

  dismissToast: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),

  request: (modal) => set({ modal }),
}));

const ask = <T,>(build: (resolve: (value: T) => void) => ModalRequest): Promise<T> =>
  new Promise<T>((resolve) => {
    useUiStore.getState().request(
      build((value) => {
        useUiStore.getState().closeModal();
        resolve(value);
      }),
    );
  });

export const promptFor = (
  title: string,
  options: { value?: string; message?: string; confirmLabel?: string } = {},
): Promise<string | null> =>
  ask<string | null>((resolve) => ({
    kind: 'prompt',
    title,
    value: options.value ?? '',
    ...(options.message ? { message: options.message } : {}),
    ...(options.confirmLabel ? { confirmLabel: options.confirmLabel } : {}),
    resolve,
  }));

export const confirmWith = (
  title: string,
  message: string,
  confirmLabel = 'Continue',
): Promise<boolean> =>
  ask<boolean>((resolve) => ({ kind: 'confirm', title, message, confirmLabel, resolve }));

export const pickColor = (title = 'Colour'): Promise<CanvasColor | null | undefined> =>
  ask<CanvasColor | null | undefined>((resolve) => ({ kind: 'color', title, resolve }));

export const pickFile = (title: string, kinds: FileKind[]): Promise<string | null> =>
  ask<string | null>((resolve) => ({ kind: 'file', title, kinds, resolve }));

export const showInfo = (title: string, rows: InfoRow[]): Promise<null> =>
  ask<null>((resolve) => ({ kind: 'info', title, rows, resolve }));

export const toast = (message: string, tone: Toast['tone'] = 'info'): void =>
  useUiStore.getState().pushToast(message, tone);
