import type { Response } from 'express';
import type { ActiveTurnSnapshot } from '../../src/types/study.js';

interface ActiveTurnEntry {
  workspaceId: string;
  sessionId?: string;
  streamingText: string;
  statusMessage: string;
  startedAt: string;
  subscribers: Set<Response>;
}

export function makeTurnKey(workspaceId: string, sessionId?: string): string {
  return sessionId ? `${workspaceId}:${sessionId}` : workspaceId;
}

export function writeSseEvent(res: Response, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    // Client socket closed mid-write; safely ignore so background turn continues
  }
}

export class ActiveTurnManager {
  private readonly turns = new Map<string, ActiveTurnEntry>();

  private resolveEntry(workspaceId: string, sessionId?: string): ActiveTurnEntry | undefined {
    if (sessionId) {
      const exact = this.turns.get(makeTurnKey(workspaceId, sessionId));
      if (exact) return exact;
    }
    const wsExact = this.turns.get(workspaceId);
    if (wsExact) return wsExact;
    if (!sessionId) {
      for (const entry of this.turns.values()) {
        if (entry.workspaceId === workspaceId) return entry;
      }
    }
    return undefined;
  }

  isActive(workspaceId: string, sessionId?: string): boolean {
    if (sessionId) {
      return this.turns.has(makeTurnKey(workspaceId, sessionId));
    }
    return Boolean(this.resolveEntry(workspaceId));
  }

  getActiveSessionIds(workspaceId: string): string[] {
    const ids: string[] = [];
    for (const entry of this.turns.values()) {
      if (entry.workspaceId === workspaceId && entry.sessionId) {
        ids.push(entry.sessionId);
      }
    }
    return ids;
  }

  getSnapshot(
    workspaceId: string,
    sessionId?: string,
    exactSessionOnly = false,
  ): ActiveTurnSnapshot | null {
    const entry =
      exactSessionOnly && sessionId
        ? this.turns.get(makeTurnKey(workspaceId, sessionId))
        : this.resolveEntry(workspaceId, sessionId);
    if (!entry) return null;
    return {
      sessionId: entry.sessionId,
      streamingText: entry.streamingText,
      statusMessage: entry.statusMessage,
      startedAt: entry.startedAt,
    };
  }

  getStreamingText(workspaceId: string, sessionId?: string): string {
    return this.resolveEntry(workspaceId, sessionId)?.streamingText ?? '';
  }

  startTurn(
    workspaceId: string,
    initialStatus = 'Antigravity (agy) bağlanıyor...',
    sessionId?: string,
  ): void {
    const key = makeTurnKey(workspaceId, sessionId);
    this.turns.set(key, {
      workspaceId,
      sessionId,
      streamingText: '',
      statusMessage: initialStatus,
      startedAt: new Date().toISOString(),
      subscribers: new Set<Response>(),
    });
  }

  subscribe(
    workspaceId: string,
    res: Response,
    sendInitialSnapshot = false,
    sessionId?: string,
  ): boolean {
    const entry = this.resolveEntry(workspaceId, sessionId);
    if (!entry) return false;

    entry.subscribers.add(res);
    const cleanup = () => {
      entry.subscribers.delete(res);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);

    if (sendInitialSnapshot) {
      writeSseEvent(res, 'snapshot', {
        sessionId: entry.sessionId,
        streamingText: entry.streamingText,
        statusMessage: entry.statusMessage,
        startedAt: entry.startedAt,
      });
    }
    return true;
  }

  appendDelta(workspaceId: string, delta: string, sessionId?: string): void {
    const entry = this.resolveEntry(workspaceId, sessionId);
    if (!entry || !delta) return;
    entry.streamingText += delta;
    this.broadcastEntry(entry, 'delta', { text: delta });
  }

  setStatus(workspaceId: string, statusMessage: string, sessionId?: string): void {
    const entry = this.resolveEntry(workspaceId, sessionId);
    if (!entry) return;
    entry.statusMessage = statusMessage;
    this.broadcastEntry(entry, 'status', { message: statusMessage });
  }

  private broadcastEntry(entry: ActiveTurnEntry, event: string, data: unknown): void {
    for (const res of Array.from(entry.subscribers)) {
      if (res.writableEnded || res.destroyed) {
        entry.subscribers.delete(res);
        continue;
      }
      writeSseEvent(res, event, data);
    }
  }

  finishTurn(
    workspaceId: string,
    event: 'done' | 'error',
    data: unknown,
    sessionId?: string,
  ): void {
    const entry = this.resolveEntry(workspaceId, sessionId);
    if (!entry) return;
    const key = makeTurnKey(entry.workspaceId, entry.sessionId);
    this.turns.delete(key);
    for (const res of Array.from(entry.subscribers)) {
      if (!res.writableEnded && !res.destroyed) {
        writeSseEvent(res, event, data);
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    }
    entry.subscribers.clear();
  }
}

export const activeTurnManager = new ActiveTurnManager();
