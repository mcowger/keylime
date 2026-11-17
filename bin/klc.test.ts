import { describe, expect, test } from 'bun:test';
import { Api, inventory, isPickerExit, matches, serverUrl, terminalCleanup, terminalFrameOutput, terminalStatus } from '../runner/src/klc';

describe('klc', () => {
  test('requires explicit opt-in for remote plaintext and rejects credential-bearing origins', () => {
    expect(serverUrl('http://127.0.0.1:30177', false).hostname).toBe('127.0.0.1');
    expect(() => serverUrl('http://example.com', false)).toThrow('--insecure');
    expect(serverUrl('http://example.com', true).hostname).toBe('example.com');
    expect(() => serverUrl('https://user:password@example.com', true)).toThrow();
    expect(() => serverUrl('https://example.com/prefix', false)).toThrow();
  });

  test('searches all metadata terms case-insensitively', () => {
    const entry = { target: { id: 'id', hostId: 'local' }, title: 'Title', detail: 'detail', search: 'Title Remote /workspace branch' };
    expect(matches(entry, 'REMOTE branch')).toBe(true);
    expect(matches(entry, 'remote missing')).toBe(false);
  });

  test('Ctrl-] exits the picker rather than entering search', () => {
    expect(isPickerExit('\x1d')).toBe(true);
    expect(isPickerExit(']')).toBe(false);
    expect(isPickerExit('n')).toBe(false);
  });
  test('shows a sanitized status without moving the terminal cursor', () => {
    const status = terminalStatus('Use Ctrl-] to detach\x1b[2J', 80, 24);
    expect(status).toStartWith('\x1b7\x1b[24;1H');
    expect(status).toEndWith('\x1b[0m\x1b8');
    expect(status).toContain('Use Ctrl-] to detach');
    expect(status).not.toContain('\x1b[2J');
  });

  test('keeps notices out of the mirrored terminal and only renders output after a snapshot', () => {
    expect(terminalFrameOutput({ type: 'notice' }, true)).toBeUndefined();
    expect(terminalFrameOutput({ type: 'output', data: 'partial' }, false)).toBeUndefined();
    expect(terminalFrameOutput({ type: 'snapshot', data: 'screen' }, false)).toEndWith('screen');
    expect(terminalFrameOutput({ type: 'output', data: 'update' }, true)).toBe('update');
  });

  test('restores terminal input modes before leaving the alternate screen', () => {
    for (const mode of [1000, 1002, 1003, 1005, 1006, 1007, 1015, 1016, 1004, 2004, 1, 6]) {
      expect(terminalCleanup).toContain(`\x1b[?${mode}l`);
    }
    expect(terminalCleanup).toContain('\x1b[4l');
    expect(terminalCleanup).toContain('\x1b[r');
    expect(terminalCleanup).toContain('\x1b[?25h');
    expect(terminalCleanup).toEndWith('\x1b[?1049l');
  });

  test('lists idle live runtimes and reports unavailable host inventories', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === '/api/sessions') return Response.json({ sessions: [{ id: 'idle', hostId: 'local', path: '/x', cwd: '/repo', created: '2026', modified: '2026', messageCount: 0, firstMessage: '' }], runningSessionIds: [] });
        if (path === '/api/sessions/archive') return Response.json({ archives: [], unavailableHosts: [] });
        if (path === '/api/hierarchy' && new URL(request.url).searchParams.get('host') === 'local') return Response.json({ projects: [{ id: 'p', name: 'Project', path: '/repo', workspaces: [{ id: 'default', projectId: 'p', path: '/repo', name: 'main', isDefault: true, sessionIds: [] }, { id: 'feature', projectId: 'p', path: '/worktrees/feature', name: 'feature', branch: 'feature', isDefault: false, sessionIds: [] }] }] });
        if (path === '/api/hosts') return Response.json({ hosts: [{ id: 'local', label: 'Local' }, { id: 'remote', label: 'Remote' }] });
        if (path === '/api/hosts/local/terminal-sessions') return Response.json({ sessionIds: ['idle', 'unsaved'] });
        return Response.json({ error: 'offline' }, { status: 503 });
      },
    });
    try {
      const result = await inventory(new Api(new URL(server.url)));
      expect(result.entries.running.map(entry => entry.target.id)).toEqual(['idle', 'unsaved']);
      expect(result.entries.workspaces.map(entry => entry.workspace?.path)).toEqual(['/repo', '/worktrees/feature']);
      expect(result.entries.workspaces[1]?.target.hostId).toBe('local');
      expect(result.entries.workspaces[1]?.search).toContain('feature');
      expect(result.notice).toContain('Remote');
      expect(result.notice).toContain('Workspaces unavailable');
    } finally { server.stop(true); }
  });
});
