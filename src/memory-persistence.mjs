import { SessionPersistence, SessionPersistenceNotFoundError, SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionHandleClosedError, SessionReadOnlyError, assertContiguous, materializeCreateHeader, materializeAppendBatch } from '@deepseek-ai/dsh-session-persistence';

/** A small provider-neutral in-memory store. Only explicitly reserved IDs enter it. */
export class TemporaryLogs {
  entries = new Map();
  reservations = new Set();

  reserve(id) { this.reservations.add(id); }
  owns(id) { return this.reservations.has(id); }
  forget(id) { this.entries.delete(id); this.reservations.delete(id); }

  async create(header, options) {
    options?.signal?.throwIfAborted();
    if (this.entries.has(header.id)) throw new SessionAlreadyExistsError(header.id);
    const entry = { header: materializeCreateHeader(header), inheritedEventCount: options?.inheritedEventCount ?? 0, events: [], writer: false, revision: 0 };
    this.entries.set(header.id, entry);
    return this.handle(entry, 'write');
  }

  async open(id, access, options) {
    options?.signal?.throwIfAborted();
    const entry = this.entries.get(id);
    if (!entry) throw new SessionPersistenceNotFoundError(id);
    return this.handle(entry, access);
  }

  snapshot(entry) { return { header: structuredClone(entry.header), revision: `side:${entry.revision}`, eventCount: entry.events.length, formatStatus: 'current' }; }
  async stat(id, options) { options?.signal?.throwIfAborted(); const entry = this.entries.get(id); return entry ? this.snapshot(entry) : undefined; }

  appendLive(session, event) {
    const entry = this.entries.get(session.id);
    if (!entry?.writer) return;
    assertContiguous(session.id, [event], entry.events.length);
    entry.events.push(structuredClone(event)); entry.revision++;
  }

  handle(entry, access) {
    const id = entry.header.id;
    if (access === 'write' && entry.writer) throw new SessionAlreadyOwnedError(id);
    if (!['read', 'write'].includes(access)) throw new TypeError('access must be read or write');
    if (access === 'write') entry.writer = true;
    let closed = false;
    const check = (operation, options, mutation = false) => {
      options?.signal?.throwIfAborted();
      if (closed) throw new SessionHandleClosedError(id, operation);
      if (mutation && access !== 'write') throw new SessionReadOnlyError(id, operation);
    };
    return {
      id, header: structuredClone(entry.header), access, inheritedEventCount: entry.inheritedEventCount,
      async read(offset = 0, length, options) {
        check('read', options);
        if (!Number.isSafeInteger(offset) || offset < 0 || (length !== undefined && (!Number.isSafeInteger(length) || length < 0))) throw new TypeError('invalid read window');
        return { eventState: 'detached', events: structuredClone(entry.events.slice(offset, length === undefined ? undefined : offset + length)) };
      },
      async append(events) { check('append', undefined, true); const batch = materializeAppendBatch(events); assertContiguous(id, batch, entry.events.length); entry.events.push(...batch); entry.revision++; },
      async flush(options) { check('flush', options, true); },
      async close() { if (closed) return; closed = true; if (access === 'write') entry.writer = false; },
    };
  }
}

/** Composition seam: ordinary sessions delegate unchanged; reserved sides never reach disk. */
export class SidechatPersistence extends SessionPersistence {
  constructor(ctx, durable, temporary) {
    super(ctx);
    this.backend = { api: durable };
    this.temporary = temporary;
    ctx.on('session/event', (session, event) => temporary.appendLive(session, event));
  }
  create(header, options) { return this.temporary.owns(header.id) ? this.temporary.create(header, options) : this.backend.api.create(header, options); }
  open(id, access, options) { return this.temporary.owns(id) ? this.temporary.open(id, access, options) : this.backend.api.open(id, access, options); }
  stat(id, options) { return this.temporary.owns(id) ? this.temporary.stat(id, options) : this.backend.api.stat(id, options); }
  list(options) { return this.backend.api.list(options); }
  flush() { return this.backend.api.flush(); }
}
