import {
  mountChrome,
  setStatus,
  markUpdated,
  fetchJSON,
  esc,
  fmtNum,
  fmtFixed,
  fmtPct,
  fmtRao,
  fmtDuration,
  shortAddr,
  shortGenRef,
  timeAgo,
  epochProgress,
  stepper,
  sparkline,
  ring,
  showError,
  checkCredits,
  barCell,
  paint,
  projectedBlock,
  lcbBar,
} from './common.js';
import { mountLive } from './live.js';

mountChrome();
checkCredits();

const STATE_BADGE = {
  advanced: '<span class="badge good">✓ advanced</span>',
  // A duel-only round has no screen to advance out of — entrants are seated
  // straight into the duel in reveal order.
  seated: '<span class="badge accent">▸ seated</span>',
  screened: '<span class="badge plain">○ screened</span>',
  rejected: '<span class="badge critical">✕ rejected</span>',
};

/** Oldest → newest slice of the round history, so sparklines read left-to-right in time. */
function series(rounds, n, pick) {
  return rounds
    .slice(0, n)
    .reverse()
    .map(pick)
    .filter((v) => Number.isFinite(v));
}

function trend(values) {
  if (values.length < 2) return { dir: 'flat', pct: null };
  const first = values[0];
  const last = values[values.length - 1];
  if (!first) return { dir: 'flat', pct: null };
  const pct = ((last - first) / Math.abs(first)) * 100;
  return { dir: pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat', pct };
}

function trendLabel(t, { invert = false, digits = 1 } = {}) {
  if (t.pct === null) return '<span class="kpi-trend flat">flat</span>';
  const good = invert ? t.dir === 'down' : t.dir === 'up';
  const cls = t.dir === 'flat' ? 'flat' : good ? 'up' : 'down';
  const arrow = t.dir === 'up' ? '↗' : t.dir === 'down' ? '↘' : '→';
  return `<span class="kpi-trend ${cls}">${arrow} ${Math.abs(t.pct).toFixed(digits)}%</span>`;
}

function kpiCard({ label, value, unit, sub, spark, trendHtml }) {
  return `<div class="kpi-card">
    <div class="kpi-label">${esc(label)}</div>
    <div class="kpi-value">${value}${unit ? `<span class="unit">${esc(unit)}</span>` : ''}</div>
    <div class="kpi-foot">
      ${trendHtml ?? `<span class="kpi-trend flat">${esc(sub ?? '')}</span>`}
      ${spark ? `<span class="kpi-spark">${spark}</span>` : ''}
    </div>
  </div>`;
}

function renderKpis({ live, latest, rewards, metagraph, rounds: roundsHist }) {
  const rounds = roundsHist?.rounds ?? [];
  const reigns = roundsHist?.reigns ?? [];
  const round = latest?.round ?? null;
  const reign = latest?.reign ?? null;
  const top = rewards?.ranks?.[0] ?? null;

  // 1. King geomean — lower is better, so an "up" trend in the number is bad.
  const geomeanSeries = series(rounds, 20, (r) => r.king_geomean);
  const geomeanTrend = trend(geomeanSeries);

  // 2. Network participation — committed generators per round.
  const partSeries = series(rounds, 20, (r) => r.n_participants);
  const partTrend = trend(partSeries);

  // 3. King's share of the reward pool — no time series (weights aren't stored
  //    historically), so this card shows the current split instead of a trend.
  const shareVal = top ? fmtPct(top.share, 1) : '—';

  // 4. Total stake across the subnet, summed from the live metagraph snapshot.
  const totalStakeAlpha = (metagraph ?? []).reduce((a, n) => a + Number(n.total_alpha_stake ?? 0), 0) / 1e9;

  // 5. Finalists — how many generators are actually duelling the king now. In a
  //    duel-only round every revealed entrant is seated, so this is the field
  //    size, and `cohort` says how many of the last field cleared the margin.
  const cohort = latest?.cohort ?? null;
  const finalists = live?.finalists ?? (live?.heat?.is_current ? live.heat.finalists : null) ?? null;
  const finalistSeries = series(rounds, 20, (r) => r.heat?.finalists ?? r.cohort_k);

  // 6. Reign length — how many rounds the current king has held, vs. past reigns.
  const reignSeries = reigns.slice(-12).map((r) => r.rounds);
  const reignTrend = trend(reignSeries);

  // 6. Validator certification — fraction of receipts scored per round, historically.
  const certSeries = series(rounds, 20, (r) => (r.n_receipts ? r.n_scored / r.n_receipts : null));
  const certNow = live?.validators?.length
    ? live.validators.filter((v) => v.published).length / live.validators.length
    : null;

  const cards = [
    kpiCard({
      label: 'King Geomean',
      value: fmtFixed(round?.king_geomean, 4),
      sub: 'CRPS+MASE loss',
      spark: sparkline(geomeanSeries, { color: 'var(--series-1)' }),
      trendHtml: trendLabel(geomeanTrend, { invert: true, digits: 2 }),
    }),
    kpiCard({
      label: 'Committed Miners',
      value: fmtNum(round?.n_participants),
      sub: 'per round',
      spark: sparkline(partSeries, { color: 'var(--series-3)' }),
      trendHtml: trendLabel(partTrend),
    }),
    kpiCard({
      label: "King's Reward Share",
      value: shareVal,
      unit: '',
      spark: null,
      trendHtml: `<span class="kpi-trend flat">weight ${fmtFixed(top?.weight, 3)}</span>`,
    }),
    kpiCard({
      label: 'Finalists in Duel',
      value: fmtNum(finalists),
      sub: 'seated this round',
      spark: sparkline(finalistSeries, { color: 'var(--series-2)' }),
      trendHtml: `<span class="kpi-trend flat">${
        cohort ? `${fmtNum(cohort.n_clears)}/${fmtNum(cohort.k)} cleared last round` : `${fmtNum(totalStakeAlpha, 0)} α staked`
      }</span>`,
    }),
    kpiCard({
      label: 'Reigning King',
      value: reign?.uid != null ? `uid ${esc(reign.uid)}` : '—',
      spark: sparkline(reignSeries, { color: 'var(--series-2)' }),
      trendHtml: `<span class="kpi-trend flat">${fmtNum(reign?.rounds)} round${
        reign?.rounds === 1 ? '' : 's'
      } held${live?.warm_start?.generation != null ? ` · gen ${fmtNum(live.warm_start.generation)}` : ''}</span>`,
    }),
    kpiCard({
      label: 'Validator Certification',
      value: certNow != null ? fmtPct(certNow, 0) : '—',
      sub: 'this round',
      spark: sparkline(certSeries, { color: 'var(--good)' }),
      trendHtml: `<span class="kpi-trend flat">${(live?.validators ?? []).filter((v) => v.published).length}/${
        (live?.validators ?? []).length
      } reported</span>`,
    }),
  ];

  paint('kpis', `<div class="kpi-grid">${cards.join('')}</div>`);
}

/**
 * The duel, as it is actually run now.
 *
 * It is no longer one challenger against the incumbent: a cohort of `k`
 * finalists is scored against the king in the same round. Each gets its own
 * bootstrap lower confidence bound on how much it improves on the king, and
 * `alpha` is the per-comparison significance level after correcting for testing
 * k of them at once — so the more finalists enter, the harder each one's bar.
 * A finalist only takes the crown if its LCB clears the win margin outright;
 * simply scoring better than the king is not enough.
 */
/**
 * The four upstream documents have independent publishers, and the trainer's
 * stage and heat feeds have stopped before while the chain carried on. A page
 * that renders a six-day-old round exactly like a live one is worse than one
 * that says nothing — so when a feed goes quiet, say which one, how long ago,
 * and what is still trustworthy.
 */
function renderFeedNotice(live) {
  const f = live?.feeds;
  if (!f) {
    paint('feedNotice', '');
    return;
  }

  const stopped = [
    !f.round?.live && { key: 'round', label: 'round stage', feed: f.round },
    !f.heat?.live && { key: 'heat', label: 'heat standings', feed: f.heat },
  ].filter(Boolean);

  if (!stopped.length) {
    paint('feedNotice', '');
    return;
  }

  const oldest = stopped.reduce((a, b) => ((a.feed.age_s ?? 0) > (b.feed.age_s ?? 0) ? a : b));
  const behind =
    oldest.feed.epoch_start_block != null && live.epoch_start_block != null && live.epoch_blocks
      ? Math.round((live.epoch_start_block - oldest.feed.epoch_start_block) / live.epoch_blocks)
      : null;

  paint('feedNotice', `
    <div class="notice warn">
      <span>◷</span>
      <div>
        <strong>The trainer's ${stopped.map((s) => s.label).join(' and ')} feed
        ${stopped.length > 1 ? 'have' : 'has'} not published for ${esc(timeAgo(oldest.feed.as_of).replace(' ago', ''))}.</strong>
        It last described epoch ${fmtNum(oldest.feed.epoch_start_block)}${
    behind ? `, ${fmtNum(behind)} rounds ago` : ''
  } — the chain is on ${fmtNum(live.epoch_start_block)}.
        Block height, on-chain commits and published receipts are unaffected and still live; the round
        stage is derived from the chain instead, and per-miner heat scores stay blank until the feed resumes.
      </div>
    </div>`);
}

function renderCohort(latest, live) {
  const c = latest?.cohort;
  const round = latest?.round;

  if (!c) {
    paint('cohort', `<div class="panel">
      <div class="panel-header"><h2>The Duel</h2></div>
      <div class="empty">The last published round carries no verdict — it was ${esc(
        round?.status ?? 'not scored'
      )}${round?.reject_reason ? `: ${esc(round.reject_reason)}` : ''}.</div>
    </div>`);
    return;
  }

  const range = Math.max(
    Math.abs(c.margin ?? 0),
    ...c.entries.map((e) => Math.abs(e.lcb ?? 0))
  ) * 1.15 || 0.01;

  const verdict = c.dethroned
    ? '<span class="badge good">👑 crown changed</span>'
    : c.inconclusive
    ? '<span class="badge warning">◷ inconclusive</span>'
    : '<span class="badge plain">king held</span>';

  const rows = c.entries
    .map((e) => {
      const cls = e.clears_margin ? 'role-advanced' : e.is_leader ? 'role-challenger' : '';
      return `<tr class="stripe ${cls}">
        <td><span class="rank-cell">#${e.rank}</span></td>
        <td><strong>${e.uid != null ? esc(e.uid) : '<span class="dim">?</span>'}</strong></td>
        <td class="mono cell-clip" title="${esc(e.hotkey)}">${esc(e.label ?? shortAddr(e.hotkey))}</td>
        <td class="num ${e.delta > 0 ? 'good' : ''}" title="geomean ${fmtFixed(e.geomean, 6)}">${
          e.delta != null ? `${e.delta >= 0 ? '+' : ''}${e.delta.toFixed(5)}` : '—'
        }</td>
        <td>${lcbBar(e.lcb, c.margin, range)}</td>
      </tr>`;
    })
    .join('');

  paint('cohort', `
    <div class="panel">
      <div class="panel-header">
        <h2>${
          c.is_cohort ? `Duel Cohort — ${fmtNum(c.k)} vs the king` : 'The Duel — challenger vs the king'
        }</h2>
        ${verdict}
      </div>
      <p class="panel-note">
        ${c.is_cohort ? 'Every finalist is' : 'The challenger is'} scored against king
        <strong>uid ${esc(c.king.uid ?? '—')}</strong> over the same windows. <strong>Δ</strong> is how much
        better its raw score was; <strong>LCB</strong> is the 95% lower bound on that improvement, and the
        crown only moves if the LCB clears the win margin (the green mark) — beating the king on raw score is
        not enough.${
          c.is_cohort
            ? ` Testing ${fmtNum(c.k)} challengers at once tightens each one's significance level to
               α = ${fmtFixed(c.alpha, 4)}.`
            : ''
        }
      </p>
      <div class="stat-grid quad" style="margin-bottom:14px">
        <div class="stat-tile"><div class="stat-label">King geomean</div><div class="stat-value">${fmtFixed(
          c.king.geomean,
          5
        )}</div><div class="stat-sub">uid ${esc(c.king.uid ?? '—')}</div></div>
        <div class="stat-tile"><div class="stat-label">Win margin</div><div class="stat-value">${fmtFixed(
          c.margin,
          4
        )}</div><div class="stat-sub">LCB must exceed</div></div>
        <div class="stat-tile"><div class="stat-label">Cleared it</div><div class="stat-value ${
          c.n_clears ? 'good' : ''
        }">${fmtNum(c.n_clears)}${
    c.is_cohort ? `<span class="unit">of ${fmtNum(c.k)}</span>` : ''
  }</div><div class="stat-sub">${c.dethroned ? 'crown changed hands' : 'king defended'}</div></div>
        <div class="stat-tile"><div class="stat-label">Warm start</div><div class="stat-value">${
          live?.warm_start?.generation != null ? `gen ${fmtNum(live.warm_start.generation)}` : c.warm_start ? 'on' : 'cold'
        }</div><div class="stat-sub">${esc(live?.heat?.screen_size ?? round?.sizes?.[0] ?? '—')}</div></div>
      </div>
      <div class="table-wrap">
        <table class="data-table cohort-table">
          <thead><tr>
            <th>#</th><th>UID</th><th>Generator</th><th>Δ vs king</th>
            <th class="lcb-head">LCB vs win margin</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="dim tiny" style="margin-top:10px">
        Round ${esc(round?.round_id ?? '—')} · epoch ${fmtNum(round?.epoch_start_block)} ·
        ${fmtNum(round?.n_windows)} windows over ${fmtNum(round?.n_clusters)} clusters ·
        certified by ${fmtNum(round?.n_scored)} of ${fmtNum(round?.n_receipts)} validators
      </div>
    </div>`);
}

/**
 * Consensus changes are not shipped, they are voted in. Validators sign a
 * feature and the tally is weighted by stake, so a handful of large holders
 * decide when the rules of the tournament change — which is worth watching if
 * you are mining against those rules.
 */
function renderGovernance(live) {
  const a = live?.activation;
  if (!a || a.ratio == null) {
    paint('govStrip', '');
    return;
  }
  const pct = a.ratio * 100;
  const threshold = (a.threshold ?? 0.51) * 100;
  const passed = a.locked || pct >= threshold;

  paint('govStrip', `
    <div class="panel gov-panel">
      <div class="panel-header">
        <h2>Consensus vote — <span class="mono">${esc(a.feature ?? 'feature')}</span></h2>
        ${
          passed
            ? `<span class="badge good">✓ locked in${a.activation_block ? ` at block ${fmtNum(a.activation_block)}` : ''}</span>`
            : '<span class="badge warning">◷ voting</span>'
        }
      </div>
      <p class="panel-note">
        Validators sign consensus changes by stake. This one needs
        <strong>${threshold.toFixed(0)}%</strong> of staked weight before it activates and changes how rounds are scored.
      </p>
      <div class="gov-bar">
        <span class="gov-fill ${passed ? 'passed' : ''}" style="width:${Math.min(100, pct).toFixed(1)}%"></span>
        <span class="gov-threshold" style="left:${threshold.toFixed(1)}%" title="threshold ${threshold.toFixed(0)}%"></span>
      </div>
      <div class="gov-legend">
        <span class="num"><strong>${pct.toFixed(1)}%</strong> of stake signed</span>
        <span class="dim">${fmtNum(a.n_signed)} of ${fmtNum(a.n_eligible)} validators · ${fmtNum(
    a.signed_stake,
    0
  )} / ${fmtNum(a.total_stake, 0)} α</span>
        <span class="dim">threshold ${threshold.toFixed(0)}%</span>
      </div>
    </div>`);
}

function renderRankings(metagraph, latest) {
  const round = latest?.round;
  // `king_uid` is who held the crown ENTERING the round; after a dethrone the
  // current king is the challenger who won. Use the post-round holder, falling
  // back only when the round was not scored.
  const kingUid = round?.post_round_king_uid ?? round?.king_uid;
  const chalUid = round?.chal_uid;

  const miners = [...(metagraph ?? [])]
    .filter((n) => !n.validator_permit)
    .sort((a, b) => Number(b.incentive) - Number(a.incentive));
  const ranked = miners.slice(0, 8);
  const maxIncentive = Math.max(...miners.map((n) => Number(n.incentive) || 0), 1e-9);

  const medal = (i) => (i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null);

  paint('rankings', `
    <div class="panel">
      <div class="panel-header">
        <h2>Miner Rankings</h2>
        <a class="small" href="/miners">View all →</a>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Rank</th><th>UID</th><th>Hotkey</th><th>Role</th><th>Incentive</th><th>Emission (α/day)</th></tr></thead>
          <tbody>
            ${!ranked.length ? '<tr><td colspan="6" class="empty">Chain data unavailable — miner rankings need the metagraph.</td></tr>' : ''}
            ${ranked
              .map((n, i) => {
                const m = medal(i);
                const role = n.uid === kingUid ? 'role-king' : n.uid === chalUid ? 'role-challenger' : '';
                return `<tr class="stripe ${role}">
                  <td><span class="rank-cell">${m ? `<span class="rank-medal">${m}</span>` : `#${i + 1}`}</span></td>
                  <td><strong>${esc(n.uid)}</strong></td>
                  <td class="mono" title="${esc(n.hotkey?.ss58 ?? '')}">${esc(shortAddr(n.hotkey?.ss58))}</td>
                  <td>${
                    n.uid === kingUid
                      ? '<span class="badge good">king</span>'
                      : n.uid === chalUid
                      ? '<span class="badge accent">challenger</span>'
                      : '<span class="dim tiny">miner</span>'
                  }</td>
                  <td>${barCell(Number(n.incentive), maxIncentive, { label: fmtFixed(n.incentive, 4) })}</td>
                  <td class="num">${fmtRao(n.daily_reward, 2)}</td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    </div>`);
}

let chartRange = 20;
let chartRoundsCache = [];

function lineChart(values, { width = 560, height = 150, color = 'var(--accent)' } = {}) {
  const vals = values.filter((v) => Number.isFinite(v));
  if (vals.length < 2) return `<div class="empty">Not enough history yet.</div>`;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const padL = 6;
  const padR = 6;
  const padT = 10;
  const padB = 10;
  const w = width - padL - padR;
  const h = height - padT - padB;
  const step = w / (vals.length - 1);
  const pts = vals.map((v, i) => [padL + i * step, padT + (1 - (v - lo) / span) * h]);
  const line = pts.map((p) => p.join(',')).join(' ');
  const area = `${padL},${padT + h} ${line} ${padL + w},${padT + h}`;
  const grid = [0.25, 0.5, 0.75].map((f) => padT + h * f);
  const uid = `lc${Math.random().toString(36).slice(2, 8)}`;
  return `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" class="chart-svg-wrap">
    <defs><linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid.map((y) => `<line x1="${padL}" y1="${y}" x2="${padL + w}" y2="${y}" stroke="var(--line)" stroke-width="1"/>`).join('')}
    <polygon points="${area}" fill="url(#${uid})" stroke="none"/>
    <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${pts[pts.length - 1][0]}" cy="${pts[pts.length - 1][1]}" r="3.2" fill="${color}"/>
  </svg>`;
}

function renderPerformance(roundsHist) {
  const all = roundsHist?.rounds ?? [];
  const el = document.getElementById('performance');
  chartRoundsCache = all;

  const draw = () => {
    const window_ = chartRoundsCache.slice(0, chartRange).reverse();
    const vals = window_.map((r) => r.king_geomean).filter((v) => Number.isFinite(v));
    paint('perfChart', lineChart(vals, { color: 'var(--accent)' }));

    const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    const best = vals.length ? Math.min(...vals) : null;
    const worst = vals.length ? Math.max(...vals) : null;
    const std = vals.length
      ? Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length)
      : null;

    paint('perfQuads', `
      <div class="chart-quad"><div class="stat-label">Average</div><div class="stat-value">${fmtFixed(mean, 4)}</div></div>
      <div class="chart-quad"><div class="stat-label">Best</div><div class="stat-value">${fmtFixed(best, 4)}</div></div>
      <div class="chart-quad"><div class="stat-label">Worst</div><div class="stat-value">${fmtFixed(worst, 4)}</div></div>
      <div class="chart-quad"><div class="stat-label">Std dev</div><div class="stat-value">${fmtFixed(std, 4)}</div></div>`);

    document.querySelectorAll('.chart-tab').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.range) === chartRange);
    });
  };

  const repainted = paint(el, `
    <div class="panel">
      <div class="panel-header">
        <h2>King Geomean — Performance</h2>
        <div class="chart-toolbar">
          <button class="chart-tab" data-range="10" type="button">10 Rounds</button>
          <button class="chart-tab" data-range="20" type="button">20 Rounds</button>
          <button class="chart-tab" data-range="${all.length}" type="button">All (${all.length})</button>
        </div>
      </div>
      <p class="panel-note">The king's combined CRPS + MASE loss at the end of each round. Lower is better —
        a falling line means the reigning generator keeps getting harder to beat.</p>
      <div id="perfChart"></div>
      <div class="chart-quads" id="perfQuads"></div>
    </div>`);

  // Only wire the toolbar when paint() actually rebuilt it; on a repaint that
  // changed nothing the old buttons — and their listeners — are still there.
  if (repainted) {
    el.querySelectorAll('.chart-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        chartRange = Number(btn.dataset.range);
        draw();
      });
    });
  }
  draw();
}

/**
 * What miners have actually put on chain for this round.
 *
 * The heat mirror is the richer source — it carries CRPS, MASE and p(best) —
 * but it is a trainer-published document that has gone quiet for days at a
 * time. The chain's own commit list never does, so when the heat feed is not
 * describing the round in flight this falls back to it: fewer columns, but
 * about the round actually happening rather than about one from last week.
 */
function renderVerification(live) {
  const heat = live?.heat;
  const current = heat?.is_current;

  if (!current) {
    const commits = (live?.recent_commits ?? []).slice(0, 6);
    const block = projectedBlock(live?.chain);
    const secs = (b) => (block != null && b != null ? (block - b) * (live?.block_time_s ?? 12) : null);

    paint('verifyList', `
      <div class="panel">
        <div class="panel-header">
          <h2>Latest Submissions</h2>
          <span class="badge accent">● on chain</span>
        </div>
        <p class="panel-note">
          Generators revealed on chain, newest first. The heat feed that carries CRPS and p(best) has not
          published for ${esc(timeAgo(heat?.as_of).replace(' ago', ''))}, so scores are unavailable — these
          are the commits themselves. <a href="/#submissions" onclick="document.getElementById('submissions').scrollIntoView({behavior:'smooth'})">All ${fmtNum(
            live?.committed_now_count
          )} ↓</a>
        </p>
        <div class="verify-list">
          ${
            commits.length
              ? commits
                  .map(
                    (c) => `<div class="verify-item">
                      ${ring(100, { size: 46, stroke: 5, color: c.this_round ? 'var(--good)' : 'var(--line-2)', label: `${esc(c.uid)}` })}
                      <div class="verify-meta">
                        <div class="vm-top">UID ${esc(c.uid)} ${
                      c.this_round
                        ? '<span class="badge good">this round</span>'
                        : '<span class="badge plain">standing</span>'
                    }</div>
                        <div class="vm-sub">block ${fmtNum(c.commit_block)}${
                      secs(c.commit_block) != null ? ` · ${fmtDuration(secs(c.commit_block))} ago` : ''
                    }</div>
                        <div class="vm-detail" title="${esc(c.gen_ref ?? '')}">${esc(shortAddr(c.hotkey))}</div>
                      </div>
                    </div>`
                  )
                  .join('')
              : '<div class="verify-item"><div class="empty">No generators committed on chain.</div></div>'
          }
        </div>
      </div>`);
    return;
  }

  // This panel is built around the p(best) ring, so it must lead with entrants
  // that actually have a score. Rejected submissions carry no rank or p(best);
  // sorting on rank alone let them fill the panel with empty rings whenever the
  // heat hasn't screened anything yet.
  const scored = (live?.submissions ?? []).filter((s) => s.state !== 'rejected');
  const subs = [...scored].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9)).slice(0, 5);
  const rejectedOnly = (live?.submissions ?? []).length > 0 && scored.length === 0;

  paint('verifyList', `
    <div class="panel">
      <div class="panel-header">
        <h2>Miners Under Verification</h2>
        <span class="badge good">● this round</span>
      </div>
      <p class="panel-note">
        ${
          heat?.duel_only
            ? `<strong>Duel-only</strong> round — seated in reveal order, no CRPS screen.`
            : `Ring shows each entrant's bootstrap <strong>p(best)</strong>.`
        } <a href="/#submissions" onclick="document.getElementById('submissions').scrollIntoView({behavior:'smooth'})">All ${fmtNum(
    live?.submission_counts?.submitted
  )} submissions ↓</a>
      </p>
      <div class="verify-list">
        ${
          subs.length
            ? subs
                .map(
                  (s) => `<div class="verify-item">
                    ${ring(s.p_best != null ? s.p_best * 100 : 100, {
                      size: 46,
                      stroke: 5,
                      color:
                        s.p_best != null
                          ? s.state === 'advanced'
                            ? 'var(--good)'
                            : 'var(--accent)'
                          : 'var(--line-2)',
                      // Nothing has been scored yet in a duel-only round, so the
                      // ring carries the seat number rather than a fake 0%.
                      label: s.p_best != null ? `${Math.round(s.p_best * 100)}%` : s.rank != null ? `#${s.rank}` : '—',
                    })}
                    <div class="verify-meta">
                      <div class="vm-top">UID ${esc(s.uid ?? '—')} ${STATE_BADGE[s.state] ?? ''}</div>
                      <div class="vm-sub">rank ${s.rank ?? '—'} · CRPS ${
                    s.crps != null ? Number(s.crps).toFixed(6) : '—'
                  }</div>
                      <div class="vm-detail" title="${esc(s.hotkey ?? '')}">${
                    s.label ? `<span class="gen-label">${esc(s.label)}</span>` : esc(shortAddr(s.hotkey))
                  }</div>
                    </div>
                  </div>`
                )
                .join('')
            : `<div class="verify-item"><div class="empty">${
                rejectedOnly
                  ? `The heat has not screened any generator yet this round — all ${fmtNum(
                      live?.submission_counts?.submitted
                    )} submissions so far were filtered before screening.`
                  : 'No screening results published yet.'
              }</div></div>`
        }
      </div>
    </div>`);
}

function renderPipeline(live) {
  // epochProgress needs the CURRENT chain height, not the epoch's own start
  // block — passing the latter always yields elapsed=0, i.e. a permanent "0%
  // complete" regardless of true progress.
  const p = epochProgress(projectedBlock(live?.chain) ?? live?.epoch_start_block, live?.epoch_blocks ?? 3600);
  const ws = live?.warm_start;
  const windows = live?.chain?.stage_windows;
  paint('pipelineCard', `
    <div class="panel">
      <div class="panel-header"><h2>Round Pipeline</h2><span class="badge accent">epoch ${fmtNum(
        live?.epoch_start_block
      )}</span></div>
      ${
        live?.stage_source === 'chain'
          ? `<p class="panel-note" style="margin-bottom:10px">Stage derived from the epoch's position on
             chain — the trainer's own stage feed is not publishing.</p>`
          : ''
      }
      ${stepper(live, { vertical: true })}
      ${
        p
          ? `<div class="meter" style="margin-top:4px"><span class="meter-fill" style="width:${(p.progress * 100).toFixed(
              1
            )}%"></span></div>
             <div class="meter-row"><span class="num">${fmtPct(p.progress, 0)} complete</span><span class="num">~${fmtDuration(
              p.remaining * (live?.block_time_s ?? 12)
            )} left</span></div>`
          : ''
      }
      <dl class="kv tight" style="margin-top:14px">
        <dt>Field</dt><dd>${
          live?.finalists != null || live?.heat?.is_current
            ? `${fmtNum(live?.finalists ?? live?.heat?.finalists)}${
                live?.heat?.duel_only ? ' · duel-only' : ' finalists'
              }`
            : '<span class="dim">not published</span>'
        }</dd>
        <dt>Generation</dt><dd>${
          ws?.generation != null ? fmtNum(ws.generation) : ws?.active ? 'warm' : '<span class="dim">—</span>'
        }</dd>
        <dt>Heat window</dt><dd>${windows ? fmtDuration(windows.heat_seconds) : '—'}</dd>
        <dt>Duel window</dt><dd>${windows ? fmtDuration(windows.duel_seconds) : '—'}</dd>
      </dl>
    </div>`);
}

function renderChainHealth(subnet, live) {
  const keysPct = subnet ? (subnet.active_keys / subnet.max_neurons) * 100 : 0;
  const c = live?.submission_counts;
  const fillPct = c?.submitted ? (c.screened / c.submitted) * 100 : 0;
  // Validator certification moved here when the Verification Queue panel went:
  // it is the same fact, and this card is where the other health gauges live.
  const validators = live?.validators ?? [];
  const reported = validators.filter((v) => v.published).length;
  const certPct = validators.length ? (reported / validators.length) * 100 : 0;

  paint('chainHealth', `
    <div class="panel">
      <div class="panel-header"><h2>Chain Health</h2></div>
      <div class="health-rings">
        <div class="health-ring">
          ${ring(keysPct, { size: 68, stroke: 7, color: 'var(--series-1)' })}
          <div class="dim tiny">Keys used<br>${fmtNum(subnet?.active_keys)}/${fmtNum(subnet?.max_neurons)}</div>
        </div>
        <div class="health-ring">
          ${ring(fillPct, { size: 68, stroke: 7, color: 'var(--series-4)' })}
          <div class="dim tiny">Screened<br>${fmtNum(c?.screened)}/${fmtNum(c?.submitted)}</div>
        </div>
        <div class="health-ring">
          ${ring(certPct, { size: 68, stroke: 7, color: 'var(--good)' })}
          <div class="dim tiny">Certified<br>${fmtNum(reported)} / ${fmtNum(validators.length)}</div>
        </div>
      </div>
      <dl class="kv tight" style="margin-top:14px">
        <dt>Immunity</dt><dd>${fmtNum(subnet?.immunity_period)} blk</dd>
        <dt>Min burn</dt><dd>${fmtRao(subnet?.min_burn, 3)} τ</dd>
        <dt>Alpha</dt><dd>${
          live?.chain?.alpha_price_tao != null ? `${live.chain.alpha_price_tao.toFixed(6)} τ` : '—'
        }</dd>
      </dl>
    </div>`);
}

const STATE_ROW_BADGE = STATE_BADGE;

function renderSubmissionsTable(live) {
  const el = document.getElementById('submissions');
  const heat = live?.heat;
  const current = heat?.is_current;

  // Without a current heat document there are no per-miner scores to show, but
  // the chain still says who has revealed a generator. That is the honest
  // version of this panel: what is on chain, not what was screened last week.
  if (!current) {
    const commits = live?.recent_commits ?? [];
    const block = projectedBlock(live?.chain);
    const ago = (b) =>
      block != null && b != null ? fmtDuration((block - b) * (live?.block_time_s ?? 12)) : null;

    paint(el, `
      <div class="panel">
        <div class="panel-header">
          <h2>On-chain Submissions — ${fmtNum(live?.committed_now_count)} generators</h2>
          <span class="badge accent">● live</span>
        </div>
        <p class="panel-note" style="margin-bottom:12px">
          Every generator currently revealed on chain, newest first. Per-miner CRPS, MASE and p(best) come
          from the trainer's heat document, which has not published for ${esc(
            timeAgo(heat?.as_of).replace(' ago', '')
          )} — those columns stay blank until it resumes. Commits, rounds and receipts are unaffected.
        </p>
        <div class="stat-grid" style="margin-bottom:14px">
          <div class="stat-tile"><div class="stat-label">Revealed on chain</div><div class="stat-value">${fmtNum(
            live?.committed_now_count
          )}</div><div class="stat-sub">generators standing</div></div>
          <div class="stat-tile"><div class="stat-label">This round</div><div class="stat-value ${
            live?.committed_this_round ? 'good' : ''
          }">${fmtNum(live?.committed_this_round)}</div><div class="stat-sub">committed since epoch ${fmtNum(
      live?.epoch_start_block
    )}</div></div>
          <div class="stat-tile"><div class="stat-label">Listed below</div><div class="stat-value">${fmtNum(
            commits.length
          )}</div><div class="stat-sub">newest commits</div></div>
          <div class="stat-tile"><div class="stat-label">Full roster</div><div class="stat-value"><a href="/miners">Miners →</a></div><div class="stat-sub">with chain state</div></div>
        </div>
        <div class="table-wrap scroll-cap">
          <table class="data-table">
            <thead><tr><th>UID</th><th>Hotkey</th><th>Generator</th><th>Committed</th><th>Age</th><th>Round</th></tr></thead>
            <tbody>
              ${
                commits.length
                  ? commits
                      .map(
                        (c) => `<tr class="stripe ${c.this_round ? 'role-advanced' : ''}">
                          <td><strong>${esc(c.uid)}</strong></td>
                          <td class="mono" title="${esc(c.hotkey ?? '')}">${esc(shortAddr(c.hotkey))}</td>
                          <td class="mono tiny dim" title="${esc(c.gen_ref ?? '')}">${esc(
                          shortGenRef(c.gen_ref)
                        )}</td>
                          <td class="num">${fmtNum(c.commit_block)}</td>
                          <td class="dim tiny">${ago(c.commit_block) ?? '—'}</td>
                          <td>${
                            c.this_round
                              ? '<span class="badge good">this round</span>'
                              : '<span class="dim tiny">standing</span>'
                          }</td>
                        </tr>`
                      )
                      .join('')
                  : '<tr><td colspan="6" class="empty">No generators revealed on chain.</td></tr>'
              }
            </tbody>
          </table>
        </div>
      </div>`);
    return;
  }

  const subs = live?.submissions ?? [];
  const c = live?.submission_counts;

  if (!subs.length || !c) {
    paint(el, `<div class="panel"><div class="panel-header"><h2>Submission Verification</h2></div>
      <div class="empty">No screening results published yet.</div></div>`);
    return;
  }

  const order = { advanced: 0, screened: 1, rejected: 2 };
  const rows = [...subs].sort(
    (a, b) => (order[a.state] - order[b.state]) || (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.uid - b.uid
  );

  paint(el, `
    <div class="panel">
      <div class="panel-header">
        <h2>Submission Verification — ${fmtNum(c.submitted)} miners</h2>
        <span class="badge ${current ? 'good' : 'warning'}" title="${
    current ? '' : `heat feed last published ${esc(timeAgo(heat?.as_of))}`
  }">${current ? '● this round' : `◷ ${esc(timeAgo(heat?.as_of))}`}</span>
      </div>
      <p class="panel-note" style="margin-bottom:12px">
        ${
          current
            ? 'Every generator submitted for the round in flight, and how far each one got.'
            : `The round in flight is still screening, so per-miner results are not published for it yet.
               These are the last settled results, from epoch ${fmtNum(heat?.epoch_start_block)}.`
        }
      </p>
      <div class="stat-grid" style="margin-bottom:14px">
        <div class="stat-tile"><div class="stat-label">Submitted</div><div class="stat-value">${fmtNum(
          c.submitted
        )}</div></div>
        <div class="stat-tile"><div class="stat-label">Screened</div><div class="stat-value">${fmtNum(
          c.screened
        )}</div></div>
        <div class="stat-tile"><div class="stat-label">Advanced</div><div class="stat-value">${fmtNum(
          c.advanced
        )}</div></div>
        <div class="stat-tile"><div class="stat-label">Rejected</div><div class="stat-value">${fmtNum(
          c.rejected
        )}</div><div class="stat-sub">${Object.keys(c.by_reason ?? {}).join(', ') || 'before screening'}</div></div>
      </div>
      <div class="table-wrap scroll-cap">
        <table class="data-table">
          <thead><tr><th>UID</th><th>Generator</th><th>Hotkey</th><th>Verification</th><th>Rank</th><th>CRPS</th><th>Detail</th></tr></thead>
          <tbody>
            ${rows
              .map(
                (s) => `<tr class="stripe ${
                  s.state === 'advanced' ? 'role-advanced' : s.state === 'rejected' ? 'role-alert' : ''
                }">
                  <td><strong>${esc(s.uid ?? '—')}</strong></td>
                  <td class="cell-clip">${
                    s.label ? `<span class="gen-label">${esc(s.label)}</span>` : '<span class="dim tiny">unnamed</span>'
                  }</td>
                  <td class="mono" title="${esc(s.hotkey ?? '')}">${esc(shortAddr(s.hotkey))}</td>
                  <td>${STATE_ROW_BADGE[s.state] ?? esc(s.state)}</td>
                  <td class="num">${s.rank ?? '<span class="dim">—</span>'}</td>
                  <td class="num">${s.crps != null ? Number(s.crps).toFixed(6) : '<span class="dim">—</span>'}</td>
                  <td class="tiny dim">${s.reason ? esc(s.reason) : s.gen_ref ? esc(shortGenRef(s.gen_ref)) : ''}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
      ${
        c.rejected_truncated
          ? `<div class="dim tiny" style="margin-top:10px">
               Showing ${fmtNum(c.rejected_listed)} of ${fmtNum(c.rejected)} rejections — the published
               heat document truncates the list, so the remaining ${fmtNum(
                 c.rejected - c.rejected_listed
               )} are counted but not named.
             </div>`
          : ''
      }
    </div>`);
}

/** What the metered tier last found missing, so the live tier does not clear it. */
let missingSources = [];

/** Feeds that are answering but no longer describing the round in flight. */
function feedStaleness(live) {
  const f = live?.feeds;
  if (!f) return [];
  return [
    !f.round?.live && `round stage (${timeAgo(f.round?.as_of)})`,
    !f.heat?.live && `heat standings (${timeAgo(f.heat?.as_of)})`,
    !f.chain?.live && 'chain mirror',
  ].filter(Boolean);
}

/** Resolves to {ok, value} instead of rejecting, so one dead call can't sink the page. */
const attempt = (url) =>
  fetchJSON(url).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error })
  );

/**
 * Public-benchmark standing. The round's own scoring only says who beat the
 * incumbent; these third-party suites (GIFT-Eval, BOOM, "time") say whether the
 * model is good in absolute terms, against the official Datadog Toto-2 at the
 * same size and against the subnet's own starting point.
 */
function renderBenchmarks(b) {
  const el = document.getElementById('benchmarks');
  if (!b?.available || !b.entries?.length) {
    paint(el, '');
    return;
  }
  const ref = b.reference?.geomean ?? null;
  const gen = b.genesis?.geomean ?? null;
  const best = b.best;

  // Position the three markers on a shared scale so the bar reads as distance travelled.
  const lo = Math.min(ref ?? Infinity, best?.geomean ?? Infinity) * 0.97;
  const hi = Math.max(gen ?? 0, best?.geomean ?? 0) * 1.01;
  const pos = (v) => (v == null || hi === lo ? null : ((hi - v) / (hi - lo)) * 100);

  paint(el, `
    <div class="panel">
      <div class="panel-header">
        <h2>Public Benchmarks — chasing the official model</h2>
        <span class="badge plain">${esc(b.preset)}${
    b.rounds_back ? ` · ${b.rounds_back} round${b.rounds_back === 1 ? '' : 's'} back` : ''
  }</span>
      </div>
      <p class="panel-note">
        Scored on third-party suites (GIFT-Eval, BOOM, time) rather than the round's own held-out
        windows, so this is the absolute-quality question: is the subnet's model actually catching
        <strong>Datadog's official Toto-2</strong>? Lower geomean is better.
      </p>

      <div class="stat-grid" style="margin-bottom:14px">
        <div class="stat-tile"><div class="stat-label">Gap closed</div><div class="stat-value">${fmtPct(
          best?.gap_closed,
          1
        )}</div><div class="stat-sub">from genesis toward official</div></div>
        <div class="stat-tile"><div class="stat-label">Best subnet model</div><div class="stat-value">${fmtFixed(
          best?.geomean,
          4
        )}</div><div class="stat-sub">uid ${esc(best?.uid)} · ${esc(best?.role)}</div></div>
        <div class="stat-tile"><div class="stat-label">Official Toto-2</div><div class="stat-value">${fmtFixed(
          ref,
          4
        )}</div><div class="stat-sub">${best?.beats_reference ? 'subnet ahead' : `behind by ${fmtFixed((best?.geomean ?? 0) - (ref ?? 0), 4)}`}</div></div>
        <div class="stat-tile"><div class="stat-label">Genesis baseline</div><div class="stat-value">${fmtFixed(
          gen,
          4
        )}</div><div class="stat-sub">where the subnet started</div></div>
      </div>

      <div class="meter" style="height:12px;position:relative">
        <span class="meter-fill" style="width:${(best?.gap_closed ?? 0) * 100}%"></span>
      </div>
      <div class="meter-row">
        <span>genesis ${fmtFixed(gen, 3)}</span>
        <span class="num">best ${fmtFixed(best?.geomean, 4)}</span>
        <span>official ${fmtFixed(ref, 3)}</span>
      </div>

      <div class="table-wrap scroll-cap" style="margin-top:14px">
        <table class="data-table">
          <thead><tr>
            <th>UID</th><th>Role</th><th>Geomean</th><th>Gap closed</th>
            <th>GIFT-Eval CRPS</th><th>BOOM CRPS</th><th>Time CRPS</th>
          </tr></thead>
          <tbody>
            ${b.entries
              .map(
                (e) => `<tr class="stripe ${e.role === 'king' ? 'role-king' : ''}">
                  <td><strong>${esc(e.uid)}</strong></td>
                  <td>${e.role === 'king' ? '<span class="badge good">king</span>' : '<span class="badge plain">challenger</span>'}</td>
                  <td class="num">${fmtFixed(e.geomean, 4)}</td>
                  <td class="num">${fmtPct(e.gap_closed, 1)}</td>
                  <td class="num">${fmtFixed(e.scores?.gifteval_crps, 4)}</td>
                  <td class="num">${fmtFixed(e.scores?.boom_crps, 4)}</td>
                  <td class="num">${fmtFixed(e.scores?.time_crps, 4)}</td>
                </tr>`
              )
              .join('')}
          </tbody>
        </table>
      </div>
      <div class="dim tiny" style="margin-top:8px">
        ${
          b.rounds_back
            ? `Benchmark runs lag the round they score, so these are the newest published results —
               epoch ${fmtNum(b.epoch_start_block)}. `
            : ''
        }Reference: ${esc(b.reference?.source ?? '—')}
      </div>
    </div>`);
}

/**
 * Everything the page has been told so far. The two tiers below write into it
 * independently and each render reads the whole thing, so a panel that needs
 * both a streamed round and a metered metagraph draws correctly whichever one
 * lands first — and redraws when the other arrives.
 */
const state = {
  live: null,
  latest: null,
  rounds: null,
  rewards: null,
  subnet: null,
  metagraph: null,
  bench: null,
};

/**
 * Pushed from the receipt store, which is free and unmetered. These are the
 * panels that actually move during a round, so they redraw within seconds of
 * anything changing upstream.
 */
function renderLiveTier() {
  const { live, latest } = state;
  if (!live) return;
  renderFeedNotice(live);
  renderGovernance(live);
  renderCohort(latest, live);
  renderVerification(live);
  renderPipeline(live);
  renderSubmissionsTable(live);
  renderKpis(state);
}

/**
 * Backed by Taostats, which bills per call. Nothing here changes on a round
 * boundary, so it is fetched once on load and then only every few minutes.
 */
async function loadMeteredTier() {
  const [rr, rwr, sr, mr, br] = await Promise.all([
    attempt('/api/cascade/rounds'),
    attempt('/api/rewards'),
    attempt('/api/subnet'),
    attempt('/api/metagraph'),
    attempt('/api/cascade/benchmarks'),
  ]);
  const val = (r) => (r.ok ? r.value : null);

  state.rounds = val(rr) ?? state.rounds;
  state.rewards = val(rwr) ?? state.rewards;
  state.subnet = val(sr)?.data ?? state.subnet;
  state.metagraph = val(mr)?.data ?? state.metagraph;
  state.bench = val(br) ?? state.bench;

  if (state.rounds) renderPerformance(state.rounds);
  renderRankings(state.metagraph ?? [], state.latest);
  renderChainHealth(state.subnet, state.live);
  renderBenchmarks(state.bench);
  renderKpis(state);

  missingSources = [!sr.ok && 'subnet', !mr.ok && 'metagraph'].filter(Boolean);
  setStatus({ stale: feedStaleness(state.live), missing: missingSources });
}

mountLive({
  parts: ['chain', 'round', 'board'],
  onData: ({ live, latest }) => {
    state.live = live;
    state.latest = latest;
    renderLiveTier();
    // Chain Health and the rankings read the live round too, so they follow.
    renderChainHealth(state.subnet, live);
    renderRankings(state.metagraph ?? [], latest);
    setStatus({ stale: feedStaleness(live), missing: missingSources });
    markUpdated();
  },
  onMode: (mode, detail) => {
    if (mode === 'offline' && !state.live) {
      showError(document.getElementById('main'), new Error(detail ?? 'no round data available'));
    }
  },
});

loadMeteredTier();
setInterval(loadMeteredTier, 5 * 60_000);
