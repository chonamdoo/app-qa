// Server-sent events fan-out with a bounded replay ring keyed by the bus sequence number.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventBus, QaEvent } from '../core/events.ts';

/** A slow client whose unsent backlog exceeds this is disconnected (it reconnects and replays via Last-Event-ID). */
const MAX_CLIENT_BACKLOG = 8 * 1024 * 1024;

export class EventRing {
  readonly capacity: number;
  private readonly slots: (QaEvent | undefined)[];
  private pushed = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.slots = new Array<QaEvent | undefined>(capacity);
  }

  push(event: QaEvent): void {
    this.slots[this.pushed % this.capacity] = event;
    this.pushed++;
  }

  /** Buffered events, oldest first. */
  events(): QaEvent[] {
    const out: QaEvent[] = [];
    for (let i = Math.max(0, this.pushed - this.capacity); i < this.pushed; i++) out.push(this.slots[i % this.capacity]!);
    return out;
  }

  get latestSeq(): number {
    return this.pushed === 0 ? 0 : this.slots[(this.pushed - 1) % this.capacity]!.seq;
  }
}

export class SseHub {
  private readonly ring: EventRing;
  private readonly clients = new Set<ServerResponse>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly unsubscribe: () => void;

  constructor(bus: EventBus, opts: { capacity: number; heartbeatMs: number }) {
    this.ring = new EventRing(opts.capacity);
    this.unsubscribe = bus.subscribe((event) => {
      this.ring.push(event);
      const text = `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const client of this.clients) this.send(client, text);
    });
    this.heartbeat = setInterval(() => {
      for (const client of this.clients) this.send(client, ': ping\n\n');
    }, opts.heartbeatMs);
    this.heartbeat.unref();
  }

  /**
   * Streams live events. With `Last-Event-ID: n`, first replays buffered events with seq > n.
   * `event: gap` = some requested events already left the ring; `event: reset` = the id belongs to another
   * server instance (seq restarted), so everything buffered is replayed from the start.
   */
  attach(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 1000\n\n');
    const header = req.headers['last-event-id'];
    const lastId = typeof header === 'string' && /^\d+$/.test(header.trim()) ? Number(header.trim()) : null;
    if (lastId !== null) {
      const buffered = this.ring.events();
      const latest = this.ring.latestSeq;
      let from = lastId;
      if (lastId > latest) {
        res.write(`event: reset\ndata: ${JSON.stringify({ latestSeq: latest })}\n\n`);
        from = 0;
      } else if (buffered.length > 0 && buffered[0]!.seq > lastId + 1) {
        res.write(`event: gap\ndata: ${JSON.stringify({ requested: lastId, oldestSeq: buffered[0]!.seq })}\n\n`);
      }
      for (const event of buffered) if (event.seq > from) res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    this.clients.add(res);
    const drop = () => this.clients.delete(res);
    req.on('close', drop);
    res.on('close', drop);
  }

  close(): void {
    clearInterval(this.heartbeat);
    this.unsubscribe();
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  private send(client: ServerResponse, text: string): void {
    if (client.writableLength > MAX_CLIENT_BACKLOG) {
      this.clients.delete(client);
      client.destroy();
      return;
    }
    client.write(text);
  }
}
