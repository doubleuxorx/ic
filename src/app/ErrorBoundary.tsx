/**
 * Stops a render error from emptying the window.
 *
 * Without a boundary React unmounts the entire tree when any component throws,
 * leaving nothing but the background colour and no way back except a reload.
 * The boundary reports the failure and keeps the reload within reach.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { describeError, reportFatal } from '@/shared/fatal';

interface Props {
  children: ReactNode;
}

interface State {
  message: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null };

  static getDerivedStateFromError(error: unknown): State {
    return { message: describeError(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    reportFatal(`${describeError(error)}\n\nComponent stack:${info.componentStack ?? ''}`);
  }

  render(): ReactNode {
    // `reportFatal` has already drawn the overlay; rendering nothing avoids
    // running the same failing tree again.
    return this.state.message === null ? this.props.children : null;
  }
}
