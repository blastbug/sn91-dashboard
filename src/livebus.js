import { createHash } from 'node:crypto';

const digest = (str) => createHash('sha1').update(str).digest('hex').slice(0, 16);

/**
 * Server-sent events for the free Cascade sources.
 *
 * Every browser polling on its own multiplied the upstream reads by the number
 * of open tabs and still left each tab up to a full interval behind. One poller
 * here fans a single read out to every connection, so the refresh window can be
 * tightened to seconds without the upstream cost growing with the audience.
 *
 * The snapshot is split into independently hashed parts because they move at
 * wildly different rates: the block height changes every 12s while the 230-row
 * commit list is unchanged for an hour. Sending the whole payload on every tick
 * meant ~98KB per client per interval to deliver a block number, so only the
 * parts that actually differ are pushed and the client merges them in.
 */
export function createLiveBus({ snapshot, intervalMs = 10_000, heartbeatMs = 25_000, maxClients = 250 }) {
  const clients = new Set();
  let poller = null;
  let beat = null;
  let inFlight = null;
  let parts = null; // { name: { json, hash } }
  let at = 0;
  let seq = 0;

  function write(res, frame) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }

  function frame(id, event, data) {
    return `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;
  }

  function broadcast(event, data) {
    const f = frame(++seq, event, data);
    for (const res of clients) write(res, f);
  }

  /** `{a: {json}, b: {json}}` → `{"at":…,"parts":{"a":<json>,"b":<json>}}` without re-encoding. */
  function encode(selected, full) {
    const body = Object.entries(selected)
      .map(([name, p]) => `${JSON.stringify(name)}:${p.json}`)
      .join(',');
    return `{"at":${at},"full":${full},"parts":{${body}}}`;
  }

  /**
   * A page subscribes to the sections it renders. The 45KB commit list matters
   * only to the miner roster, so every other page opts out of carrying it.
   */
  function sendParts(res, selected, full) {
    const want = res.locals?.wantParts;
    const chosen = want ? Object.fromEntries(Object.entries(selected).filter(([k]) => want.has(k))) : selected;
    if (!Object.keys(chosen).length) return;
    write(res, frame(++seq, 'update', encode(chosen, full)));
  }

  /**
   * Refresh the snapshot. Concurrent callers share the one read rather than
   * skipping it — a connecting client that "returned early" here would be sent
   * nothing at all and sit empty until the next tick.
   */
  function poll() {
    if (inFlight) return inFlight;
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function refresh() {
    try {
      const next = await snapshot();
      at = Date.now();
      const changed = {};
      const merged = {};
      for (const [name, value] of Object.entries(next)) {
        const json = JSON.stringify(value ?? null);
        const hash = digest(json);
        merged[name] = { json, hash };
        if (parts?.[name]?.hash !== hash) changed[name] = merged[name];
      }
      // A section missing from this poll (its upstream read failed) keeps its
      // last good value, so a new client never connects to a half snapshot.
      parts = { ...(parts ?? {}), ...merged };
      if (Object.keys(changed).length) {
        for (const res of clients) sendParts(res, changed, false);
      }
    } catch (err) {
      // A failed upstream read is not a failed stream: the client keeps the
      // last good frame on screen and is told the data behind it has aged.
      broadcast('degraded', JSON.stringify({ error: err.message, at: Date.now() }));
    }
  }

  function start() {
    if (poller) return;
    poller = setInterval(poll, intervalMs);
    // Proxies and load balancers close a connection that goes quiet; a comment
    // frame keeps it open without the client seeing anything.
    beat = setInterval(() => broadcast('ping', String(Date.now())), heartbeatMs);
    poller.unref?.();
    beat.unref?.();
  }

  function stop() {
    clearInterval(poller);
    clearInterval(beat);
    poller = null;
    beat = null;
  }

  return {
    async handler(req, res) {
      if (clients.size >= maxClients) {
        res.status(503).json({ error: 'stream at capacity' });
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        // Render and most nginx front-ends buffer responses by default, which
        // holds every frame until the connection closes.
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();
      res.write(`retry: 4000\n\n`);

      const asked = String(req.query.parts ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      res.locals = { ...res.locals, wantParts: asked.length ? new Set(asked) : null };

      start();

      // A tab that opens mid-interval should not stare at an empty page until
      // the next tick, so it is served the standing snapshot straight away —
      // in full, since it has nothing to merge changed parts into. Waiting for a
      // fresh read first would put the whole cold-start latency in front of the
      // first paint; a slightly stale frame now and the update seconds later is
      // strictly better. It joins the broadcast list only afterwards, or that
      // refresh would deliver the same payload twice.
      if (parts) {
        sendParts(res, parts, true);
        clients.add(res);
        if (Date.now() - at > intervalMs) poll();
      } else {
        await poll();
        if (parts) sendParts(res, parts, true);
        clients.add(res);
      }

      req.on('close', () => {
        clients.delete(res);
        if (!clients.size) stop();
      });
    },
    /** Take the cold read at boot so the first visitor never pays for it. */
    warm: () => poll(),
    stats: () => ({
      clients: clients.size,
      parts: parts ? Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.json.length])) : null,
      at: at || null,
    }),
  };
}
