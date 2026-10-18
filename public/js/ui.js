// DOM side of the game: HUD, agent trace, toasts and the final report.

const $ = (id) => document.getElementById(id);
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const sources = new Map();
export function rememberSources(list) {
  for (const s of list ?? []) if (s) sources.set(s.id, { ...sources.get(s.id), ...s });
}

const srcLink = (id) => {
  const s = sources.get(id);
  return s ? `<a class="cite" href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.title)}">[${id}]</a>` : `[${id}]`;
};

export function toast(html, color) {
  const el = document.createElement('div');
  el.className = 'toast';
  if (color) el.style.borderColor = color;
  el.innerHTML = html;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 4200);
}

export function setStatus(text, busy = true) {
  $('status-text').textContent = text;
  $('status').classList.toggle('idle', !busy);
}

export function setScore(pct, counts) {
  $('score').textContent = `${pct.toFixed(pct < 10 ? 1 : 0)}% DESTROYED`;
  if (!counts.total) {
    $('claims-hud').innerHTML = '';
    return;
  }
  $('claims-hud').innerHTML = [
    `<div>CLAIMS ${counts.total}</div>`,
    `<div style="color:var(--upheld)">UPHELD ${counts.upheld}</div>`,
    `<div style="color:var(--weakened)">WEAKENED ${counts.weakened}</div>`,
    `<div style="color:var(--refuted)">REFUTED ${counts.refuted}</div>`,
    `<div style="color:var(--dim)">UNTESTED ${counts.standing + counts.checking}</div>`,
  ].join('');
}

export function setWeapons(weapons, active, fuel) {
  $('weapons').innerHTML =
    weapons.map((w, i) => `<div class="${i === active ? 'on' : ''}">${i + 1} ${w.name}</div>`).join('') +
    `<div>RMB GRENADE</div><div class="fuel"><i style="transform:scaleX(${fuel.toFixed(2)})"></i><span>JET</span></div>`;
}

export function toggleTrace(force) {
  const el = $('trace');
  el.hidden = force === undefined ? !el.hidden : !force;
}

const ICON = {
  plan: ['plan', 'PLAN'],
  search: ['search', 'SEARCH'],
  results: ['search', 'FOUND'],
  read: ['read', 'READ'],
  page: ['read', 'GOT'],
  read_failed: ['error', 'FAIL'],
  thinking: ['think', 'THINK'],
  thought: ['think', 'SAY'],
  decision: ['decide', 'DECIDE'],
  report: ['write', 'DRAFT'],
  challenge: ['attack', 'YOU'],
  attack: ['attack', 'CHECK'],
  attack_results: ['attack', 'FOUND'],
  tool_error: ['error', 'ERROR'],
  fail: ['error', 'ERROR'],
};

function traceHtml(type, d) {
  const ids = (list) => `<span class="srcs">${list.map((s) => srcLink(s.id ?? s)).join('')}</span>`;
  switch (type) {
    case 'run':
      $('trace-model').textContent = d.mode === 'demo' ? 'offline demo replay' : d.model;
      return `<span class="tag write">RUN</span>${esc(d.question)}`;
    case 'status':
      return d.phase === 'writing' ? `<span class="tag write">WRITE</span>${esc(d.text)}` : null;
    case 'plan':
      return `${d.subquestions.map((q, i) => `<div>${i + 1}. ${esc(q)}</div>`).join('')}${d.strategy ? `<span class="why">${esc(d.strategy)}</span>` : ''}${d.thinking ? `<span class="why thinking">${esc(d.thinking)}</span>` : ''}`;
    case 'thinking':
      return `<span class="thinking">${esc(d.text)}</span>`;
    case 'thought':
      return esc(d.text);
    case 'search':
      return `“${esc(d.query)}”<span class="why">why: ${esc(d.reason)}</span>`;
    case 'results':
      return `${d.results.length} results ${ids(d.results)}`;
    case 'read':
      return `${ids(d.ids)}<span class="why">why: ${esc(d.reason)}</span>`;
    case 'page':
      return `${srcLink(d.id)} ${esc(d.title)}`;
    case 'read_failed':
      return `could not read ${ids(d.ids)}`;
    case 'decision':
      return `${d.enough ? 'Enough evidence' : 'Stopping'} after ${d.searches} searches, ${d.reads} reads.<span class="why">${esc(d.reason)}</span>${d.gaps ? `<span class="why">gaps: ${esc(d.gaps)}</span>` : ''}`;
    case 'report': {
      const ok = d.claims.filter((c) => c.quoteVerified).length;
      return `${d.claims.length} claims, ${ok}/${d.claims.length} quotes found verbatim in fetched sources`;
    }
    case 'challenge':
      return `shot ${esc(d.claimId)} apart: fact-checker deployed`;
    case 'attack':
      return `${esc(d.claimId)}: “${esc(d.query)}”<span class="why">angle: ${esc(d.angle)}</span>`;
    case 'attack_results':
      return `${d.results.length} results ${ids(d.results)}`;
    case 'verdict':
      return `<span class="tag ${d.verdict}">${d.verdict.toUpperCase()}</span>${esc(d.claimId)}: ${esc(d.reasoning)}`;
    case 'tool_error':
      return `${esc(d.tool)}: ${esc(d.message)}`;
    case 'fail':
      return esc(d.message);
    default:
      return null;
  }
}

export function trace(type, d) {
  if (type === 'results' || type === 'attack_results') rememberSources(d.results);
  if (type === 'report') rememberSources(d.sources);
  if (type === 'verdict') rememberSources(d.sourceInfo);
  const body = traceHtml(type, d);
  if (body == null) return;
  const [cls, label] = ICON[type] ?? [];
  const li = document.createElement('li');
  li.innerHTML = `${label ? `<span class="tag ${cls}">${label}</span>` : ''}${body}`;
  const list = $('trace-list');
  const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
  list.append(li);
  if (stick) list.scrollTop = list.scrollHeight;
}

export function setPoints(total) {
  $('points-hud').textContent = total ? `${total} PTS` : '';
}

const MEDAL = ['🥇', '🥈', '🥉'];

export function renderLeaderboard(data, { demo } = {}) {
  const row = (p) => `<tr class="${p.you ? 'you' : ''}">
      <td class="rank">${MEDAL[p.rank - 1] ? `<span class="medal">${MEDAL[p.rank - 1]}</span>` : `#${p.rank}`}</td>
      <td><span class="name">${esc(p.name)}</span>${p.lastTakedown ? `<div class="last">last takedown: “${esc(p.lastTakedown)}”</div>` : ''}</td>
      <td class="pts">${p.refuted}</td>
      <td class="pts">${p.points}</td>
    </tr>`;
  const youOutside = data.you && !data.top.some((p) => p.you);
  $('leaderboard-body').innerHTML = `
    <h2>🏆 LEADERBOARD</h2>
    <div class="report-meta">+${data.pointsPerRefute} points for every claim the fact-checker refutes after you shoot it apart. ${data.players} player${data.players === 1 ? '' : 's'} so far.${demo ? '<br/>Offline demo runs are practice and do not score.' : ''}</div>
    ${data.top.length ? `<table class="board">
      <thead><tr><th>RANK</th><th>PLAYER</th><th class="pts">REFUTED</th><th class="pts">POINTS</th></tr></thead>
      <tbody>${data.top.map(row).join('')}${youOutside ? `<tr class="gap"><td colspan="4">…</td></tr>${row(data.you)}` : ''}</tbody>
    </table>` : '<p>No points yet. Be the first to break a claim.</p>'}`;
}

const VERDICT_COLOR = { upheld: 'var(--upheld)', weakened: 'var(--weakened)', refuted: 'var(--refuted)' };

export function renderReport(run) {
  const { report, claims, runId, question, mode, model } = run;
  if (!report) {
    $('report-body').innerHTML = '<h2>NO REPORT YET</h2><p>The agent is still researching. Keep shooting.</p>';
    return;
  }
  const claimHtml = claims
    .map((c) => {
      const status = c.status ?? 'standing';
      const color = VERDICT_COLOR[status] ?? `var(--${c.confidence})`;
      const check = c.check
        ? `<div class="check"><b style="color:${color}">Fact-check: ${status.toUpperCase()}</b> ${esc(c.check.reasoning)}
           ${c.check.correctedClaim ? `<p><b>Corrected:</b> ${esc(c.check.correctedClaim)}</p>` : ''}
           ${c.check.evidence
             .map(
               (e) =>
                 `<blockquote>${e.stance === 'contradicts' ? '<span class="bad">contradicts</span>' : '<span class="ok">supports</span>'} ${srcLink(e.source)} “${esc(e.quote)}” <a href="${esc(e.link)}" target="_blank" rel="noopener">jump ↗</a>${e.quoteVerified ? '' : ' <span class="bad">(quote not found)</span>'}</blockquote>`,
             )
             .join('')}</div>`
        : status === 'checking'
          ? '<div class="check">Fact-checker is working on it…</div>'
          : '<div class="check" style="color:var(--dim)">Untested. Shoot it in the game to send the fact-checker after it.</div>';
      return `<div class="claim" style="--c:${color}">
        <h3><span>${esc(c.id)}</span><span class="badge" style="color:var(--${c.confidence})">${c.confidence.toUpperCase()} CONFIDENCE</span>
          <span class="badge" style="color:${color}">${status.toUpperCase()}</span></h3>
        <p class="text">${esc(c.text)} ${c.sources.map(srcLink).join('')}</p>
        <blockquote>“${esc(c.quote)}” ${c.link ? `<a href="${esc(c.link)}" target="_blank" rel="noopener">jump to quote ↗</a>` : ''}
          ${c.quoteVerified ? `<span class="ok">✓ quote found in ${srcLink(c.quoteSource)}</span>` : '<span class="bad">✗ quote not found in fetched text: confidence lowered</span>'}</blockquote>
        ${check}
      </div>`;
    })
    .join('');
  const cited = new Set(claims.flatMap((c) => [...c.sources, ...(c.check?.evidence ?? []).map((e) => e.source)]));
  const sourceHtml = [...sources.values()]
    .sort((a, b) => a.id - b.id)
    .map(
      (s) =>
        `<li value="${s.id}"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a> <span style="color:var(--dim)">${esc(s.domain)}${s.read ? ' · read in full' : ''}${cited.has(s.id) ? ' · cited' : ''}</span></li>`,
    )
    .join('');
  $('report-body').innerHTML = `
    <h2>${esc(report.title)}</h2>
    <div class="report-meta">Q: ${esc(question)}<br/>${mode === 'demo' ? 'Offline demo replay (real Wikipedia text, scripted agent)' : `Model: ${esc(model)} on Nebius Token Factory · Search: Tavily`}</div>
    <p class="answer">${esc(report.answer)}</p>
    ${claimHtml}
    ${report.openQuestions?.length ? `<h3>Open questions</h3><ul>${report.openQuestions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
    <div class="sources"><h3>Sources</h3><ol>${sourceHtml}</ol></div>
    <div class="report-actions">
      <button data-action="new">NEW SEARCH</button>
      <a href="/api/run/${runId}.md" target="_blank">MARKDOWN + TRACE</a>
      <a href="/api/run/${runId}" target="_blank">JSON</a>
    </div>`;
}
