/**
 * What the running application knows about the build it came from.
 *
 * The values are substituted by vite (see `define` in `vite.config.ts`), so
 * they cost nothing at runtime and are correct for a browser build too, where
 * there is no Rust side to ask. On the desktop the installed application's own
 * version is authoritative and comes from `AppFacts`; this is the fallback and
 * the only source of the commit.
 */

declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILD_TIME__: string;

/** Missing defines mean an unbundled run, not a broken one. */
const defined = (value: string, fallback: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback;

export interface BuildInfo {
  version: string;
  /** Short commit hash, `-dirty` when the tree had uncommitted changes. */
  commit: string;
  /** ISO 8601, in UTC. */
  buildTime: string;
}

export const BUILD: BuildInfo = {
  version: defined(typeof __APP_VERSION__ === 'undefined' ? '' : __APP_VERSION__, '0.0.0-dev'),
  commit: defined(typeof __APP_COMMIT__ === 'undefined' ? '' : __APP_COMMIT__, 'unknown'),
  buildTime: defined(typeof __APP_BUILD_TIME__ === 'undefined' ? '' : __APP_BUILD_TIME__, 'unknown'),
};

/** `0.4.0+ab12cd3`, for the one line the status bar has room for. */
export const versionLabel = (version = BUILD.version): string =>
  BUILD.commit === 'unknown' ? version : `${version}+${BUILD.commit}`;
