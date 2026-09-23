import { fetchJSON, updateChrome, renderRail } from './common.js';

/**
 * The page's connection to the round in flight.
 *
 * Server-sent events are the primary transport: the server polls the receipt
 * store once and pushes only the sections that changed, so a tab sees a new
 * block within seconds instead of at the next full reload. EventSource is not
 * always reachable — a proxy that buffers, a corporate filter — so a failed
 * stream degrades to plain polling rather than to a frozen page.
 *
 * A hidden tab stays subscribed to nothing at all: there is no point holding a
 * connection open and repainting a dashboard nobody is looking at.
 */

const MODES = { STREAM: 'stream', POLLING: 'polling', OFFLINE: 'offline' };

// How long to wait for the first frame before giving up on the stream. A proxy
// that buffers the response sends headers immediately and then nothing, so
// `onopen` is not evidence that anything will ever arrive.
const FIRST_FRAME_MS = 12_000;
// The server pings every 25s; three missed pings means the connection is gone
// in a way that did not raise an error on this side.
const SILENCE_MS = 80_000;

export function connectLive({ parts = ['chain', 'round', 'board'], onData, onMode, pollMs = 20_000 } = {}) {
  let source = null;
  let timer = null;
  let watchdog = null;
  let mode = null;
  let errors = 0;
  let stopped = false;
  const state = { live: {}, latest: null, at: 0 };

  function setMode(next, detail) {
    if (mode === next) return;
    mode = next;
    onMode?.(next, detail);
  }

  /** Stream frames carry partials of the same tree, so they merge rather than replace. */
  function merge(frame) {
    const p = frame.parts ?? {};
    if (p.chain) Object.assign(state.live, p.chain);
    if (p.round) Object.assign(state.live, p.round);
    if (p.commits) Object.assign(state.live, p.commits);
    if (p.board !== undefined) state.latest = p.board;
    state.at = frame.at ?? Date.now();
    onData({ live: state.live, latest: state.latest, at: state.at });
  }

  /** Restart the silence watchdog; any frame at all counts as a sign of life. */
  function heard() {
    if (watchdog) clearTimeout(watchdog);
    if (stopped || !source) return;
    watchdog = setTimeout(() => {
      source?.close();
      source = null;
      startPolling();
    }, SILENCE_MS);
  }

  function startStream() {
    stopTimer();
    const qs = parts.length ? `?parts=${encodeURIComponent(parts.join(','))}` : '';
    source = new EventSource(`/api/stream${qs}`);

    source.addEventListener('ping', heard);

    source.addEventListener('update', (ev) => {
      errors = 0;
      heard();
      setMode(MODES.STREAM);
      let frame;
      try {
        frame = JSON.parse(ev.data);
      } catch {
        // A malformed frame is not worth tearing the connection down for, but
        // a render that throws is a real bug and must not be swallowed here.
        return;
      }
      merge(frame);
    });

    source.addEventListener('degraded', (ev) => {
      // The upstream read failed but the stream itself is alive.
      heard();
      let detail = null;
      try {
        detail = JSON.parse(ev.data).error;
      } catch {
        /* no detail */
      }
      onMode?.(mode ?? MODES.STREAM, detail);
    });

    source.onopen = () => {
      errors = 0;
    };

    // Nothing has arrived yet, so this is the deadline for the stream to prove
    // itself rather than the silence timer proper.
    if (watchdog) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      source?.close();
      source = null;
      startPolling();
    }, FIRST_FRAME_MS);

    // EventSource reconnects on its own; only a run of failures means the
    // transport itself is unavailable and polling should take over.
    source.onerror = () => {
      errors += 1;
      if (errors >= 3) {
        source.close();
        source = null;
        startPolling();
      }
    };
  }

  async function pollOnce() {
    try {
      const [live, latest] = await Promise.all([
        fetchJSON('/api/cascade/live'),
        fetchJSON('/api/cascade/latest'),
      ]);
      setMode(MODES.POLLING);
      state.live = live;
      state.latest = latest;
      state.at = Date.now();
      onData({ ...state });
    } catch (err) {
      setMode(MODES.OFFLINE, err.message);
    }
  }

  function startPolling() {
    stopTimer();
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    pollOnce();
    timer = setInterval(pollOnce, pollMs);
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function close() {
    source?.close();
    source = null;
    stopTimer();
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  }

  function open() {
    if (stopped) return;
    if (typeof EventSource === 'function') startStream();
    else startPolling();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) close();
    else open();
  });

  open();

  return {
    get state() {
      return state;
    },
    refresh: () => (source ? null : pollOnce()),
    stop() {
      stopped = true;
      close();
    },
  };
}

/**
 * The one line a page needs to be live: it keeps the topbar, the sidebar status
 * and the context rail in step with the round in flight, and hands the frame on
 * so the page can redraw whatever else it owns.
 */
export function mountLive({ parts, onData, onMode } = {}) {
  return connectLive({
    parts,
    onData: (snap) => {
      updateChrome({ live: snap.live });
      renderRail(snap.live);
      onData?.(snap);
    },
    onMode: (mode, detail) => {
      updateChrome({ mode, detail });
      onMode?.(mode, detail);
    },
  });
}

export { MODES };
