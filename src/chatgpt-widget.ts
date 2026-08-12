export const BRIEFING_WIDGET_URI = "ui://driftglass/briefing-v2.html";

export const BRIEFING_WIDGET_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root { color-scheme: light dark; --bg:#f7f5ee; --card:#fffdf7; --ink:#1d2428; --muted:#667076; --line:#d9d7cf; --accent:#3156d3; --new:#147a53; --changed:#a55d08; }
  @media (prefers-color-scheme: dark) { :root { --bg:#141719; --card:#1d2225; --ink:#f4f1e8; --muted:#a9b0b4; --line:#353c40; --accent:#8ca6ff; --new:#65d6a1; --changed:#ffbe6b; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  .shell { padding:16px; max-width:860px; margin:auto; }
  .top { display:flex; gap:16px; align-items:flex-start; justify-content:space-between; margin-bottom:14px; }
  .eyebrow { margin:0 0 4px; text-transform:uppercase; letter-spacing:.14em; font-size:10px; color:var(--muted); }
  h1 { margin:0; font-size:22px; letter-spacing:-.03em; }
  .meta { color:var(--muted); font-size:12px; text-align:right; }
  .coverage { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0 14px; }
  .pill { border:1px solid var(--line); border-radius:999px; padding:4px 8px; font-size:11px; color:var(--muted); background:var(--card); }
  .action-list { display:grid; gap:7px; margin:8px 0 14px; }
  .action-item { display:grid; grid-template-columns:auto 1fr; gap:9px; padding:9px 10px; border:1px solid var(--line); border-radius:11px; background:var(--card); }
  .action-mark { width:8px; height:8px; margin-top:5px; border-radius:50%; background:var(--muted); }
  .action-mark.attention { background:var(--changed); }
  .action-mark.urgent { background:#c43c3c; }
  .action-item strong { display:block; font-size:12px; }
  .action-item span { color:var(--muted); font-size:11px; }
  .mission { border-left:3px solid var(--accent); padding:8px 10px; margin:8px 0; background:color-mix(in srgb,var(--card) 92%,var(--accent)); border-radius:0 10px 10px 0; }
  .mission strong { display:block; }
  .mission span { color:var(--muted); font-size:12px; }
  .resolved { padding:9px 10px; border:1px solid var(--line); border-radius:11px; margin:7px 0; background:color-mix(in srgb,var(--card) 92%,var(--new)); }
  .resolved strong { display:block; font-size:12px; }
  .resolved span { color:var(--muted); font-size:11px; }
  .grid { display:grid; gap:10px; margin-top:12px; }
  .story { border:1px solid var(--line); border-radius:14px; background:var(--card); padding:13px; }
  .story-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
  .story h2 { font-size:15px; line-height:1.3; margin:0; }
  .badge { border-radius:999px; padding:3px 7px; font-size:9px; font-weight:700; letter-spacing:.1em; text-transform:uppercase; white-space:nowrap; border:1px solid currentColor; }
  .badge.new { color:var(--new); }
  .badge.changed { color:var(--changed); }
  .badge.recurring { color:var(--muted); }
  .summary { color:var(--muted); margin:8px 0; }
  .stats { display:flex; flex-wrap:wrap; gap:9px; color:var(--muted); font-size:11px; }
  .actions { display:flex; gap:8px; margin-top:10px; }
  button { appearance:none; border:1px solid var(--line); background:transparent; color:var(--ink); border-radius:9px; padding:7px 9px; cursor:pointer; font:inherit; font-size:12px; }
  button.primary { background:var(--ink); color:var(--bg); border-color:var(--ink); }
  .empty { padding:24px; text-align:center; color:var(--muted); border:1px dashed var(--line); border-radius:14px; }
</style>
</head>
<body>
<div class="shell"><div id="root" class="empty">Loading Driftglass…</div></div>
<script>
(() => {
  const root = document.getElementById('root');
  const esc = (value='') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let current = null;

  async function sendPrompt(prompt) {
    if (window.openai?.sendFollowUpMessage) {
      await window.openai.sendFollowUpMessage({ prompt, scrollToBottom: true });
      return;
    }
    window.parent.postMessage({ jsonrpc:'2.0', id:'driftglass-'+Date.now(), method:'ui/message', params:{ role:'user', content:[{type:'text', text:prompt}] } }, '*');
  }

  function render(data) {
    current = data || {};
    const stories = Array.isArray(current.stories) ? current.stories : [];
    const missions = Array.isArray(current.missions) ? current.missions : [];
    const actions = Array.isArray(current.actions) ? current.actions : [];
    const resolvedMissions = Array.isArray(current.resolvedMissions) ? current.resolvedMissions : [];
    const coverage = current.coverage || {};
    const actionHtml = actions.length
      ? '<p class="eyebrow">Needs your attention</p><div class="action-list">' + actions.slice(0, 6).map(function (action) {
          return '<div class="action-item"><span class="action-mark ' + esc(action.severity || 'info') + '"></span><div><strong>' + esc(action.title) + '</strong><span>' + esc(action.detail || '') + (action.dueAt ? ' · ' + esc(action.dueAt) : '') + '</span></div></div>';
        }).join('') + '</div>'
      : '';
    const missionHtml = missions.length
      ? '<p class="eyebrow">Research Missions</p>' + missions.map(function (mission) {
          return '<div class="mission"><strong>' + esc(mission.name) + '</strong><span>' + esc(mission.question || '') + '</span></div>';
        }).join('')
      : '';
    const resolvedHtml = resolvedMissions.length
      ? '<p class="eyebrow">Recently resolved</p>' + resolvedMissions.slice(0, 4).map(function (mission) {
          return '<div class="resolved"><strong>' + esc(mission.name) + ' · ' + esc(mission.outcomeStatus) + '</strong><span>' + esc(mission.outcomeSummary || 'Outcome recorded.') + '</span></div>';
        }).join('')
      : '';
    const storyHtml = stories.length
      ? stories.map(function (story, index) {
          const kind = esc(story.changeKind || 'recurring');
          const sourceCount = Number(story.sourceCount || 0);
          const kindLabel = kind === 'new' ? 'New' : kind === 'changed' ? 'Changed' : 'Seen before';
          const sourceLabel = sourceCount > 1 ? 'More than one source' : 'One source so far';
          const changeLabel = Number(story.newEvidenceCount || 0) > 0 ? 'New evidence added' : 'Context changed';
          return '<article class="story">' +
            '<div class="story-head"><h2>' + (index + 1) + '. ' + esc(story.title) + '</h2><span class="badge ' + kind + '">' + kindLabel + '</span></div>' +
            '<p class="summary">' + esc(story.summary || 'No extractive summary available.') + '</p>' +
            '<div class="stats"><span>' + sourceLabel + '</span><span>' + changeLabel + '</span></div>' +
            '<div class="actions"><button class="primary" data-investigate="' + esc(story.id) + '">Read with sources</button><button data-compare="' + esc(story.id) + '">Compare with last check</button></div>' +
          '</article>';
        }).join('')
      : '<div class="empty">No story cleared the current window. A quiet day is a valid result.</div>';

    root.className = '';
    root.innerHTML =
      '<div class="top">' +
        '<div><p class="eyebrow">Driftglass</p><h1>Today</h1></div>' +
        '<div class="meta">' + esc(current.generatedAt ? new Date(current.generatedAt).toLocaleString() : '') + '<br>' + (current.previousBriefingAt ? 'Compared with the prior briefing' : 'First briefing') + '</div>' +
      '</div>' +
      '<div class="coverage">' +
        '<span class="pill">' + (Number(coverage.degradedSources || 0) ? 'Collection needs attention' : 'Collection healthy') + '</span>' +
        (Number(coverage.offlineCollectors || 0) ? '<span class="pill">Optional Companion offline</span>' : '') +
        (actions.length ? '<span class="pill">Something needs your attention</span>' : '<span class="pill">Nothing needs your attention</span>') +
      '</div>' + actionHtml + missionHtml + resolvedHtml + '<div class="grid">' + storyHtml + '</div>';

    root.querySelectorAll('[data-investigate]').forEach(function (button) {
      button.addEventListener('click', function () {
        const story = stories.find(function (item) { return item.id === button.dataset.investigate; });
        sendPrompt('Investigate “' + (story?.title || '') + '” in Driftglass. Search for the Story, fetch its source trail, distinguish fact from source claims and inference, and tell me what matters.');
      });
    });
    root.querySelectorAll('[data-compare]').forEach(function (button) {
      button.addEventListener('click', function () {
        const story = stories.find(function (item) { return item.id === button.dataset.compare; });
        sendPrompt('For “' + (story?.title || '') + '” in Driftglass, compare it with the last check and explain only what changed, why that change matters, and what remains uncertain.');
      });
    });
    window.openai?.notifyIntrinsicHeight?.();
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message?.method === 'ui/notifications/tool-result') render(message.params?.structuredContent);
  }, { passive:true });

  if (window.openai?.toolOutput) render(window.openai.toolOutput);
})();
</script>
</body>
</html>`;
