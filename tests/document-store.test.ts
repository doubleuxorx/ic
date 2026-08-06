// @vitest-environment jsdom
/**
 * Open Markdown documents: autosave, the crash-recovery copy, and disagreement
 * with disk.
 *
 * One entry per path, shared by every node that references it, which is why a
 * second node opening the same file must not reset what the first one typed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/ipc-types', async () => {
  const { fakeIpc } = await import('./support/fake-ipc');
  return { ipc: fakeIpc, isDesktop: () => true };
});

import { DOCUMENT_AUTOSAVE_MS, useDocumentStore } from '@/editor/document-store';
import { useWorkspaceStore } from '@/workspace/workspace-store';

import { backend, openFixtureWorkspace } from './support/fake-ipc';
import { resetStores } from './support/stores';

const documents = () => useDocumentStore.getState();
const note = () => documents().docs['Notes/note.md'];

beforeEach(async () => {
  resetStores();
  backend.reset();
  await openFixtureWorkspace();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('opening', () => {
  it('reads the file and its revision', async () => {
    await documents().open('Notes/note.md');

    expect(note()?.contents).toBe('# Note\n\nA paragraph.\n');
    expect(note()?.revision).toBe(backend.revision('Notes/note.md'));
    expect(note()?.dirty).toBe(false);
    expect(note()?.loading).toBe(false);
  });

  it('does not re-read a file that is already open with unsaved edits', async () => {
    await documents().open('Notes/note.md');
    documents().setContents('Notes/note.md', '# Mine\n');

    await documents().open('Notes/note.md');

    expect(note()?.contents).toBe('# Mine\n');
  });

  it('keeps the failure on the document rather than throwing', async () => {
    backend.refuse.set('Notes/note.md', 'path does not exist');

    await documents().open('Notes/note.md');

    expect(note()?.error).toBe('path does not exist');
    expect(note()?.loading).toBe(false);
  });
});

describe('saving', () => {
  it('writes by itself shortly after typing stops', async () => {
    await documents().open('Notes/note.md');

    documents().setContents('Notes/note.md', '# Edited\n');
    expect(note()?.dirty).toBe(true);

    await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSAVE_MS + 50);

    expect(backend.contents('Notes/note.md')).toBe('# Edited\n');
    expect(note()?.dirty).toBe(false);
  });

  it('writes once for a burst of keystrokes', async () => {
    await documents().open('Notes/note.md');

    for (const value of ['#', '# E', '# Ed', '# Edited']) {
      documents().setContents('Notes/note.md', value);
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSAVE_MS);

    expect(backend.callsTo('document_write')).toHaveLength(1);
    expect(backend.contents('Notes/note.md')).toBe('# Edited');
  });

  it('saves every dirty document at once, and only the dirty ones', async () => {
    await documents().open('Notes/note.md');
    await documents().open('notes.txt');
    documents().setContents('Notes/note.md', '# Edited\n');

    expect(documents().dirtyPaths()).toEqual(['Notes/note.md']);
    await documents().saveAll();

    expect(backend.callsTo('document_write')).toHaveLength(1);
  });

  it('presents the revision it last saw', async () => {
    await documents().open('Notes/note.md');
    const first = note()?.revision;

    documents().setContents('Notes/note.md', '# One\n');
    await documents().save('Notes/note.md');
    documents().setContents('Notes/note.md', '# Two\n');
    await documents().save('Notes/note.md');

    const writes = backend.callsTo('document_write') as Array<{ expectedRevision: string }>;
    expect(writes[0]?.expectedRevision).toBe(first);
    expect(writes[1]?.expectedRevision).not.toBe(first);
    expect(backend.contents('Notes/note.md')).toBe('# Two\n');
  });

  it('reports a failure that is not a conflict', async () => {
    await documents().open('Notes/note.md');
    backend.refuse.set('Notes/note.md', 'io error: read-only file system');

    documents().setContents('Notes/note.md', '# Edited\n');
    await documents().save('Notes/note.md');

    expect(note()?.error).toContain('read-only');
    expect(note()?.dirty).toBe(true);
  });
});

describe('the recovery copy', () => {
  /**
   * A draft is kept for the case autosave cannot cover: the document is still
   * dirty when the recovery timer comes round, because the write failed or the
   * file is refused. When a save succeeds there is nothing left to recover, and
   * no copy is made.
   */
  it('is written when a document is still unsaved after a save should have run', async () => {
    await documents().open('Notes/note.md');
    const revision = note()?.revision;
    backend.refuse.set('Notes/note.md', 'io error: read-only file system');

    documents().setContents('Notes/note.md', '# Half typed\n');
    await vi.advanceTimersByTimeAsync(3000);

    expect(note()?.dirty).toBe(true);
    expect(backend.recovery.get('Notes/note.md')).toMatchObject({
      relativePath: 'Notes/note.md',
      contents: '# Half typed\n',
      baseRevision: revision,
    });
  });

  it('is not written when the document reached disk', async () => {
    await documents().open('Notes/note.md');

    documents().setContents('Notes/note.md', '# Saved fine\n');
    await vi.advanceTimersByTimeAsync(3000);

    expect(backend.recovery.get('Notes/note.md')).toBeUndefined();
  });

  it('is cleared once the document is safely on disk', async () => {
    await documents().open('Notes/note.md');
    documents().setContents('Notes/note.md', '# Edited\n');
    await vi.advanceTimersByTimeAsync(3000);

    await documents().save('Notes/note.md', { force: true });

    expect(backend.callsTo('recovery_clear')).toContainEqual({ relativePath: 'Notes/note.md' });
  });

  it('is adopted as unsaved content rather than written to the file', async () => {
    await documents().open('Notes/note.md');

    documents().adoptRecovery('Notes/note.md', '# Recovered\n', note()?.revision ?? '');

    expect(note()?.contents).toBe('# Recovered\n');
    expect(note()?.dirty).toBe(true);
    // Restoring a draft is not the same as deciding to keep it.
    expect(backend.contents('Notes/note.md')).toBe('# Note\n\nA paragraph.\n');
  });
});

describe('when the file changed underneath', () => {
  it('adopts the new text when nothing local would be lost', async () => {
    await documents().open('Notes/note.md');
    backend.write('Notes/note.md', '# Changed elsewhere\n');

    await documents().reload('Notes/note.md');

    expect(note()?.contents).toBe('# Changed elsewhere\n');
    expect(note()?.conflict).toBeNull();
  });

  it('asks instead of choosing when both sides changed', async () => {
    await documents().open('Notes/note.md');
    documents().setContents('Notes/note.md', '# Mine\n');
    backend.write('Notes/note.md', '# Theirs\n');

    await documents().reload('Notes/note.md');

    expect(note()?.conflict?.diskContents).toBe('# Theirs\n');
    expect(note()?.contents).toBe('# Mine\n');
  });

  it('surfaces a conflict a write ran into, and stops autosaving into it', async () => {
    await documents().open('Notes/note.md');
    backend.write('Notes/note.md', '# Theirs\n');

    documents().setContents('Notes/note.md', '# Mine\n');
    await documents().save('Notes/note.md');
    expect(note()?.conflict?.diskContents).toBe('# Theirs\n');

    backend.calls = [];
    documents().setContents('Notes/note.md', '# Mine again\n');
    await vi.advanceTimersByTimeAsync(DOCUMENT_AUTOSAVE_MS * 2);
    expect(backend.callsTo('document_write')).toEqual([]);
  });

  it('keeps mine by writing over the file when asked', async () => {
    await documents().open('Notes/note.md');
    backend.write('Notes/note.md', '# Theirs\n');
    documents().setContents('Notes/note.md', '# Mine\n');
    await documents().save('Notes/note.md');

    await documents().resolveConflict('Notes/note.md', 'keep-mine');

    expect(backend.contents('Notes/note.md')).toBe('# Mine\n');
    expect(note()?.conflict).toBeNull();
    expect(note()?.dirty).toBe(false);
  });

  it('takes the file when asked, and drops the draft with it', async () => {
    await documents().open('Notes/note.md');
    backend.write('Notes/note.md', '# Theirs\n');
    documents().setContents('Notes/note.md', '# Mine\n');
    await documents().save('Notes/note.md');

    await documents().resolveConflict('Notes/note.md', 'take-disk');

    expect(note()?.contents).toBe('# Theirs\n');
    expect(note()?.dirty).toBe(false);
    expect(backend.callsTo('recovery_clear')).toContainEqual({ relativePath: 'Notes/note.md' });
  });

  it('says nothing about a file it never opened', async () => {
    await documents().reload('Notes/never-opened.md');
    expect(documents().docs['Notes/never-opened.md']).toBeUndefined();
  });
});

describe('without a workspace', () => {
  it('reports the refusal instead of failing silently', async () => {
    await useWorkspaceStore.getState().close();
    await documents().open('Notes/note.md');
    expect(note()?.error).toBe('no workspace is open');
  });
});
