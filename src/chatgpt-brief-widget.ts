export const EDITORIAL_BRIEF_WIDGET_URI = "ui://driftglass/editorial-brief-v9.html";
export const LEGACY_EDITORIAL_BRIEF_WIDGET_URI = "ui://driftglass/editorial-brief-v8.html";

export const EDITORIAL_BRIEF_WIDGET_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<style>
  :root { color-scheme:light dark; --bg:#f6f4ed; --card:#fffdf8; --ink:#1c2428; --muted:#60696e; --line:#d8d6cf; --accent:#3858c9; --accent-soft:#eef0ff; --watch:#f3ecdc; }
  @media (prefers-color-scheme:dark) { :root { --bg:#141719; --card:#1d2225; --ink:#f4f1e8; --muted:#a9b0b4; --line:#353c40; --accent:#aebcff; --accent-soft:#252b45; --watch:#302b20; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  a { color:inherit; }
  .shell { max-width:760px; margin:auto; padding:16px; }
  .brief { overflow:hidden; border:1px solid var(--line); border-radius:18px; background:var(--card); box-shadow:0 10px 32px rgba(24,30,34,.06); }
  .masthead { padding:15px 18px 12px; border-bottom:1px solid var(--line); }
  .eyebrow { margin:0 0 5px; color:var(--accent); font-size:11px; font-weight:780; letter-spacing:.12em; text-transform:uppercase; }
  h1 { margin:0; font-size:23px; line-height:1.18; letter-spacing:-.03em; overflow-wrap:anywhere; }
  .context { max-width:620px; margin:7px 0 0; color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
  .sections { padding:2px 18px 6px; }
  .section { padding:13px 0; border-top:1px solid var(--line); }
  .section:first-child { border-top:0; }
  .section.watch { margin:2px 0 12px; padding:13px 14px; border:0; border-radius:13px; background:var(--watch); }
  h2 { margin:0 0 5px; color:var(--muted); font-size:11px; font-weight:780; letter-spacing:.1em; text-transform:uppercase; }
  .copy { margin:0; font-size:15px; line-height:1.54; overflow-wrap:anywhere; }
  .synthesis { padding:0 18px 8px; }
  .synthesis-lead { padding:18px 0 17px; border-bottom:1px solid var(--line); }
  .synthesis-thesis { margin:0; font-size:17px; font-weight:610; line-height:1.55; letter-spacing:-.01em; overflow-wrap:anywhere; }
  .judgments { padding:17px 0 5px; }
  .judgment-list { display:grid; gap:14px; margin-top:11px; }
  .judgment { padding-left:13px; border-left:2px solid color-mix(in srgb,var(--accent) 45%,var(--line)); }
  .judgment h3 { margin:0 0 4px; font-size:14px; line-height:1.35; overflow-wrap:anywhere; }
  .judgment-copy,.synthesis-copy { margin:0; font-size:14px; line-height:1.57; overflow-wrap:anywhere; }
  .competing { margin:14px 0 5px; padding:13px 14px; border:1px solid var(--line); border-radius:13px; background:color-mix(in srgb,var(--bg) 72%,var(--card)); }
  .watch-list { margin:14px 0 10px; padding:14px; border-radius:13px; background:var(--watch); }
  .watch-items { display:grid; gap:11px; margin-top:8px; }
  .watch-item + .watch-item { padding-top:10px; border-top:1px solid color-mix(in srgb,var(--ink) 10%,transparent); }
  .citation-refs { display:flex; flex-wrap:wrap; gap:5px; margin-top:7px; }
  .citation-ref { display:inline-flex; align-items:center; justify-content:center; min-width:28px; min-height:28px; padding:3px 7px; border:1px solid var(--line); border-radius:999px; background:var(--card); color:var(--accent); text-decoration:none; font-size:11px; font-weight:800; }
  .citation-ref:hover,.citation-ref:focus-visible { border-color:var(--accent); background:var(--accent-soft); }
  .citation-ref:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .citations { display:flex; flex-wrap:wrap; gap:6px; margin-top:7px; }
  .citation { display:inline-flex; align-items:center; min-width:0; min-height:34px; max-width:min(100%,260px); padding:5px 9px; border:1px solid var(--line); border-radius:999px; background:var(--bg); color:var(--muted); text-decoration:none; font-size:11px; font-weight:680; line-height:1.2; }
  .citation:hover,.citation:focus-visible { border-color:var(--accent); color:var(--accent); }
  .citation:focus-visible,summary:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .citation-number { margin-right:5px; color:var(--accent); }
  .citation-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .citation-date { flex:0 0 auto; margin-left:6px; color:var(--muted); font-weight:560; white-space:nowrap; }
  .decision { margin:2px 0 12px; padding:9px 12px 7px; border:1px solid color-mix(in srgb,var(--accent) 24%,var(--line)); border-radius:13px; background:var(--accent-soft); }
  .decision-heading { display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 8px; margin-bottom:1px; }
  .decision-heading h2 { margin:0; color:var(--accent); }
  .decision-row { display:grid; grid-template-columns:74px minmax(0,1fr) minmax(140px,190px); gap:8px; align-items:start; padding:6px 0; border-top:1px solid color-mix(in srgb,var(--accent) 15%,var(--line)); }
  .decision-heading + .decision-row { border-top:0; }
  .decision-label { padding-top:3px; color:var(--muted); font-size:10px; font-weight:800; letter-spacing:.07em; text-transform:uppercase; }
  .decision-copy { margin:0; font-size:12.5px; line-height:1.35; overflow-wrap:anywhere; }
  .decision-citations { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:4px; }
  .decision .citation { flex:1 1 84px; min-height:32px; max-width:190px; padding:4px 8px; font-size:11px; }
  .decision .citation-date { display:none; }
  .evidence { border-top:1px solid var(--line); background:color-mix(in srgb,var(--bg) 68%,var(--card)); }
  .evidence summary { min-height:48px; padding:14px 18px; color:var(--muted); cursor:pointer; font-size:12px; font-weight:720; }
  .evidence summary:hover,.evidence summary:focus-visible { color:var(--accent); }
  .evidence summary:focus-visible { border-radius:8px; }
  .evidence-body { padding:0 18px 17px; }
  .provenance-note,.boundary,.limit { margin:0; color:var(--muted); font-size:12px; }
  .boundary { margin-top:7px; }
  .source-list { display:grid; gap:8px; margin-top:13px; }
  .source { padding:10px 11px; border:1px solid var(--line); border-radius:11px; background:var(--card); }
  .source-head { display:flex; align-items:baseline; gap:8px; }
  .source-number { flex:0 0 auto; color:var(--accent); font-size:11px; font-weight:800; }
  .source-title { min-width:0; font-size:12px; font-weight:730; overflow-wrap:anywhere; }
  .source-meta { margin:3px 0 0; color:var(--muted); font-size:11px; }
  .source-excerpt { margin:6px 0 0; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
  .source-open { display:inline-block; margin-top:7px; color:var(--accent); font-size:11px; font-weight:700; }
  .limits { margin-top:12px; padding-top:10px; border-top:1px solid var(--line); }
  .limit + .limit { margin-top:4px; }
  .invalid { padding:22px 18px; border:1px dashed var(--line); border-radius:14px; background:var(--card); text-align:center; }
  .invalid h2 { margin-bottom:6px; color:var(--ink); font-size:16px; letter-spacing:0; text-transform:none; }
  .invalid p { margin:0; color:var(--muted); }
  @media (max-width:620px) { .decision-row { grid-template-columns:70px minmax(0,1fr); gap:5px 8px; } .decision-citations { grid-column:2; justify-content:flex-start; } }
  @media (max-width:520px) { .shell { padding:10px; } .masthead,.sections,.synthesis { padding-left:14px; padding-right:14px; } h1 { font-size:21px; } .copy { font-size:14px; } .synthesis-thesis { font-size:16px; } .citation { max-width:100%; } .evidence summary,.evidence-body { padding-left:14px; padding-right:14px; } }
</style>
</head>
<body>
<main class="shell"><div id="root" class="invalid"><p>Loading Driftglass…</p></div></main>
<script>
(() => {
  const root = document.getElementById('root');
  const MAIN_TEXT_LIMIT = 300;
  const DECISION_ROW_TEXT_LIMIT = 240;
  const WATCH_TEXT_LIMIT = 240;
  const SYNTHESIS_THESIS_TEXT_LIMIT = 900;
  const SYNTHESIS_JUDGMENT_TEXT_LIMIT = 600;
  const SYNTHESIS_COMPETING_TEXT_LIMIT = 600;
  const SYNTHESIS_WATCH_TEXT_LIMIT = 360;
  const SYNTHESIS_JUDGMENT_TITLE_LIMIT = 100;
  const bridge = {
    initializeId: 'driftglass-ui-initialize',
    initialized: false,
    lastSize: '',
    resizeObserver: null,
    resizeScheduled: false,
  };
  const esc = (value='') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clip = (value, limit) => {
    const text = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)).trimEnd() + '…';
  };
  const safeUrl = value => {
    try {
      const url = new URL(String(value || ''));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
      return url.href;
    } catch { return ''; }
  };
  const host = value => {
    try { return new URL(value).hostname.replace(/^www\./, ''); } catch { return ''; }
  };
  const date = value => {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.valueOf())) return clip(value, 60);
    return parsed.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });
  };
  let lastResultSignature = '';

  function postMessage(message) {
    window.parent.postMessage(message, '*');
  }

  function measuredSize() {
    const html = document.documentElement;
    const body = document.body;
    let width = Number(window.innerWidth) || 0;
    let height = 0;
    if (html?.getBoundingClientRect) {
      const previousHeight = html.style?.height;
      if (html.style) html.style.height = 'max-content';
      const rect = html.getBoundingClientRect();
      if (html.style) html.style.height = previousHeight || '';
      width ||= Number(rect?.width) || 0;
      height = Math.max(height, Number(rect?.height) || 0);
    }
    if (body?.getBoundingClientRect) {
      const rect = body.getBoundingClientRect();
      width ||= Number(rect?.width) || 0;
      height = Math.max(height, Number(rect?.height) || 0);
    }
    height = Math.max(height, Number(html?.scrollHeight) || 0, Number(body?.scrollHeight) || 0);
    return {
      ...(width > 0 ? { width: Math.ceil(width) } : {}),
      ...(height > 0 ? { height: Math.ceil(height) } : {}),
    };
  }

  function notifyBridgeSize() {
    if (!bridge.initialized) return;
    const params = measuredSize();
    if (!params.width && !params.height) return;
    const signature = String(params.width || '') + 'x' + String(params.height || '');
    if (signature === bridge.lastSize) return;
    bridge.lastSize = signature;
    postMessage({ jsonrpc:'2.0', method:'ui/notifications/size-changed', params });
  }

  function scheduleBridgeSize() {
    if (!bridge.initialized || bridge.resizeScheduled) return;
    bridge.resizeScheduled = true;
    const send = () => {
      bridge.resizeScheduled = false;
      notifyBridgeSize();
    };
    if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(send);
    else send();
  }

  function reportIntrinsicSize() {
    window.openai?.notifyIntrinsicHeight?.();
    scheduleBridgeSize();
  }

  function startBridgeSizing() {
    scheduleBridgeSize();
    const ResizeObserver = window.ResizeObserver;
    if (typeof ResizeObserver !== 'function' || bridge.resizeObserver) return;
    bridge.resizeObserver = new ResizeObserver(scheduleBridgeSize);
    if (document.documentElement) bridge.resizeObserver.observe(document.documentElement);
    if (document.body) bridge.resizeObserver.observe(document.body);
  }

  function resultSignature(data) {
    try { return JSON.stringify(data ?? null); } catch { return data; }
  }

  function validInitializeResult(result) {
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    return object(result) &&
      typeof result.protocolVersion === 'string' &&
      object(result.hostInfo) &&
      typeof result.hostInfo.name === 'string' &&
      typeof result.hostInfo.version === 'string' &&
      object(result.hostCapabilities) &&
      object(result.hostContext);
  }

  function validSection(section, allowedUrls, textLimit=MAIN_TEXT_LIMIT) {
    const text = section ? clip(section.text, textLimit + 1) : '';
    if (!text || text.length > textLimit) return false;
    if (!Array.isArray(section.citationUrls) || !section.citationUrls.length || section.citationUrls.length > 3) return false;
    return section.citationUrls.every(url => allowedUrls.has(safeUrl(url)));
  }

  function validDecision(decision, allowedUrls) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return false;
    const rows = ['testNow', 'deferUntil', 'rollbackIf'].filter(key => decision[key] !== undefined && decision[key] !== null);
    return rows.length > 0 && rows.every(key =>
      validSection(decision[key], allowedUrls, DECISION_ROW_TEXT_LIMIT) && Boolean(decisionCopy(decision[key].text))
    );
  }

  function validSynthesis(data, allowedUrls) {
    const judgments = data?.keyJudgments;
    const watchFor = data?.watchFor;
    const validJudgments = judgments === undefined || (
      Array.isArray(judgments) &&
      judgments.length >= 1 && judgments.length <= 4 &&
      judgments.every(judgment => {
        const title = clip(judgment?.title, SYNTHESIS_JUDGMENT_TITLE_LIMIT + 1);
        return title.length > 0 && title.length <= SYNTHESIS_JUDGMENT_TITLE_LIMIT &&
          validSection(judgment, allowedUrls, SYNTHESIS_JUDGMENT_TEXT_LIMIT);
      })
    );
    const validWatch = watchFor === undefined || (
      Array.isArray(watchFor) &&
      watchFor.length <= 2 &&
      watchFor.every(section => validSection(section, allowedUrls, SYNTHESIS_WATCH_TEXT_LIMIT))
    );
    const noLegacyFields = !data?.whatChanged && !data?.whyItMatters && !data?.decision && !data?.watchNext;
    return noLegacyFields &&
      validSection(data?.thesis, allowedUrls, SYNTHESIS_THESIS_TEXT_LIMIT) &&
      validJudgments &&
      (!data?.competingExplanation || validSection(data.competingExplanation, allowedUrls, SYNTHESIS_COMPETING_TEXT_LIMIT)) &&
      validWatch;
  }

  function validCompactAnswer(data, allowedUrls) {
    const hasDecision = data?.decision !== undefined && data?.decision !== null;
    const explicitDecision = data?.answerMode === 'decision';
    const legacy = data?.answerMode === undefined || data?.answerMode === null;
    const noSynthesisFields = !data?.thesis && !data?.keyJudgments && !data?.competingExplanation && !data?.watchFor;
    return (legacy || explicitDecision) && noSynthesisFields &&
      validSection(data?.whatChanged, allowedUrls, MAIN_TEXT_LIMIT) &&
      validSection(data?.whyItMatters, allowedUrls, MAIN_TEXT_LIMIT) &&
      (!hasDecision || validDecision(data.decision, allowedUrls)) &&
      (!explicitDecision || hasDecision) &&
      !(hasDecision && data?.watchNext) &&
      (!data?.watchNext || validSection(data.watchNext, allowedUrls, WATCH_TEXT_LIMIT));
  }

  function decisionCopy(value) {
    return clip(value, DECISION_ROW_TEXT_LIMIT)
      .replace(/^ChatGPT judgment(?::(?:\s+|$)|\s+[-–—]\s+)/i, '')
      .trim();
  }

  function citationHtml(url, sourceIndex) {
    const safe = safeUrl(url);
    const entry = sourceIndex.get(safe);
    if (!safe || !entry) return '';
    const publisher = clip(entry.source.publisher || host(safe), 120);
    const title = clip(entry.source.title || publisher || host(safe), 260);
    const published = date(entry.source.publishedAt);
    const accessible = ['Open citation ' + entry.number + ': ' + title, publisher, published].filter(Boolean).join(', ');
    return '<a class="citation" href="' + esc(safe) + '" target="_blank" rel="noopener noreferrer" aria-label="' + esc(accessible) + '" title="' + esc([title, publisher, published].filter(Boolean).join(' · ')) + '">' +
      '<span class="citation-number">[' + entry.number + ']</span><span class="citation-title">' + esc(title) + '</span>' +
      (published ? '<span class="citation-date">' + esc(published) + '</span>' : '') + '</a>';
  }

  function citationRefHtml(url, sourceIndex) {
    const safe = safeUrl(url);
    const entry = sourceIndex.get(safe);
    if (!safe || !entry) return '';
    return '<a class="citation-ref" href="' + esc(safe) + '" target="_blank" rel="noopener noreferrer" aria-label="Open citation ' + entry.number + '">[' + entry.number + ']</a>';
  }

  function citationRefsHtml(section, sourceIndex, label) {
    return '<nav class="citation-refs" aria-label="Citations for ' + esc(label) + '">' +
      section.citationUrls.map(url => citationRefHtml(url, sourceIndex)).join('') + '</nav>';
  }

  function sectionHtml(label, section, sourceIndex, className='', textLimit=MAIN_TEXT_LIMIT) {
    return '<section class="section ' + className + '"><h2>' + esc(label) + '</h2><p class="copy">' + esc(clip(section.text, textLimit)) + '</p>' +
      '<nav class="citations" aria-label="Citations for ' + esc(label) + '">' + section.citationUrls.map(url => citationHtml(url, sourceIndex)).join('') + '</nav></section>';
  }

  function decisionRowHtml(label, section, sourceIndex) {
    return '<div class="decision-row"><span class="decision-label">' + esc(label) + '</span><p class="decision-copy">' + esc(decisionCopy(section.text)) + '</p>' +
      '<nav class="decision-citations" aria-label="Citations for ' + esc(label) + '">' + section.citationUrls.map(url => citationHtml(url, sourceIndex)).join('') + '</nav></div>';
  }

  function decisionHtml(decision, sourceIndex) {
    const rows = [
      ['Test now', decision.testNow],
      ['Defer until', decision.deferUntil],
      ['Roll back if', decision.rollbackIf],
    ].filter(([, section]) => section);
    return '<section class="decision" aria-labelledby="recommended-move"><div class="decision-heading"><h2 id="recommended-move">Recommendation</h2></div>' +
      rows.map(([label, section]) => decisionRowHtml(label, section, sourceIndex)).join('') + '</section>';
  }

  function synthesisHtml(data, sourceIndex) {
    const judgments = (Array.isArray(data.keyJudgments) ? data.keyJudgments : []).map((judgment, index) => (
      '<article class="judgment"><h3>' + esc(clip(judgment.title, SYNTHESIS_JUDGMENT_TITLE_LIMIT)) + '</h3>' +
      '<p class="judgment-copy">' + esc(clip(judgment.text, SYNTHESIS_JUDGMENT_TEXT_LIMIT)) + '</p>' +
      citationRefsHtml(judgment, sourceIndex, 'judgment ' + (index + 1)) + '</article>'
    )).join('');
    const judgmentSection = judgments
      ? '<section class="judgments" aria-labelledby="causal-judgments"><h2 id="causal-judgments">Why this is happening</h2><div class="judgment-list">' + judgments + '</div></section>'
      : '';
    const competing = data.competingExplanation
      ? '<section class="competing"><h2>Alternative case</h2><p class="synthesis-copy">' + esc(clip(data.competingExplanation.text, SYNTHESIS_COMPETING_TEXT_LIMIT)) + '</p>' +
        citationRefsHtml(data.competingExplanation, sourceIndex, 'competing explanation') + '</section>'
      : '';
    const watch = (Array.isArray(data.watchFor) ? data.watchFor : []).map((section, index) => (
      '<article class="watch-item"><p class="synthesis-copy">' + esc(clip(section.text, SYNTHESIS_WATCH_TEXT_LIMIT)) + '</p>' +
      citationRefsHtml(section, sourceIndex, 'watch signal ' + (index + 1)) + '</article>'
    )).join('');
    const watchSection = watch
      ? '<section class="watch-list" aria-labelledby="watch-signals"><h2 id="watch-signals">What to watch</h2><div class="watch-items">' + watch + '</div></section>'
      : '';
    return '<div class="synthesis"><section class="synthesis-lead" aria-labelledby="direct-answer"><h2 id="direct-answer">Answer</h2>' +
      '<p class="synthesis-thesis">' + esc(clip(data.thesis.text, SYNTHESIS_THESIS_TEXT_LIMIT)) + '</p>' +
      citationRefsHtml(data.thesis, sourceIndex, 'answer') + '</section>' +
      judgmentSection + competing + watchSection + '</div>';
  }

  function sourceHtml(source, number) {
    const url = safeUrl(source.url);
    if (!url) return '';
    const publisher = clip(source.publisher || host(url), 120);
    const title = clip(source.title || publisher, 260);
    const published = date(source.publishedAt);
    const meta = [publisher, published].filter(Boolean).join(' · ');
    const accessible = ['Open source ' + number + ': ' + title, publisher, published].filter(Boolean).join(', ');
    return '<article class="source"><div class="source-head"><span class="source-number">[' + number + ']</span><span class="source-title">' + esc(title) + '</span></div>' +
      (meta ? '<p class="source-meta">' + esc(meta) + '</p>' : '') +
      (source.excerpt ? '<p class="source-excerpt">' + esc(clip(source.excerpt, 420)) + '</p>' : '') +
      '<a class="source-open" href="' + esc(url) + '" target="_blank" rel="noopener noreferrer" aria-label="' + esc(accessible) + '">Open source</a></article>';
  }

  function render(data) {
    const sources = Array.isArray(data?.evidence?.sources) ? data.evidence.sources : [];
    const safeSources = sources.filter(source => safeUrl(source?.url));
    const sourceIndex = new Map(safeSources.map((source, index) => [safeUrl(source.url), { source, number:index + 1 }]));
    const allowedUrls = new Set(sourceIndex.keys());
    const hasDecision = data?.decision !== undefined && data?.decision !== null;
    const isSynthesis = data?.answerMode === 'synthesis';
    const valid = data?.schemaVersion === '1' &&
      data?.interpretationLabel === 'ChatGPT interpretation' &&
      ['today', 'mission'].includes(data?.briefKind) &&
      safeSources.length > 0 &&
      (isSynthesis ? validSynthesis(data, allowedUrls) : validCompactAnswer(data, allowedUrls));
    if (!valid) {
      root.className = 'invalid';
      root.innerHTML = '<h2>Some source links are missing.</h2><p>Add a public source for each section.</p>';
      reportIntrinsicSize();
      return;
    }
    const limitations = Array.isArray(data.evidence.limitations) ? data.evidence.limitations.slice(0, 4).map(item => clip(item, 420)).filter(Boolean) : [];
    const title = clip(data.title, 180) || (data.briefKind === 'today' ? 'Today' : 'Mission brief');
    const context = clip(data.context, 500);
    const answerLabel = isSynthesis ? 'Analysis' : hasDecision ? 'Recommendation' : 'Answer';
    root.className = '';
    root.innerHTML = '<article class="brief"><header class="masthead"><p class="eyebrow">' + answerLabel + '</p><h1>' + esc(title) + '</h1>' +
      (context ? '<p class="context">' + esc(context) + '</p>' : '') + '</header>' +
      (isSynthesis ? synthesisHtml(data, sourceIndex) : '<div class="sections">' +
        sectionHtml('Bottom line', data.whatChanged, sourceIndex, '', MAIN_TEXT_LIMIT) +
        sectionHtml('What this means', data.whyItMatters, sourceIndex, '', MAIN_TEXT_LIMIT) +
        (hasDecision ? decisionHtml(data.decision, sourceIndex) : '') +
        (data.watchNext ? sectionHtml('Watch for', data.watchNext, sourceIndex, 'watch', WATCH_TEXT_LIMIT) : '') + '</div>') +
      '<details class="evidence"><summary>Sources (' + safeSources.length + ')</summary><div class="evidence-body">' +
      (data.evidence.boundary ? '<p class="boundary">Time covered: ' + esc(clip(data.evidence.boundary, 220)) + '</p>' : '') +
      '<div class="source-list">' + safeSources.map((source, index) => sourceHtml(source, index + 1)).join('') + '</div>' +
      (limitations.length ? '<div class="limits">' + limitations.map(item => '<p class="limit">' + esc(item) + '</p>').join('') + '</div>' : '') +
      '</div></details></article>';
    root.querySelector('details.evidence')?.addEventListener('toggle', reportIntrinsicSize);
    reportIntrinsicSize();
  }

  function renderResult(data) {
    const signature = resultSignature(data);
    if (signature === lastResultSignature) return;
    lastResultSignature = signature;
    render(data);
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id === bridge.initializeId) {
      if (bridge.initialized || message.error || !validInitializeResult(message.result)) return;
      bridge.initialized = true;
      postMessage({ jsonrpc:'2.0', method:'ui/notifications/initialized' });
      startBridgeSizing();
      return;
    }
    if (message.method === 'ui/notifications/tool-result') {
      renderResult(message.params?.structuredContent);
    }
  }, { passive:true });

  postMessage({
    jsonrpc:'2.0',
    id:bridge.initializeId,
    method:'ui/initialize',
    params:{
      appInfo:{ name:'driftglass-editorial-brief', version:'9.0.0' },
      appCapabilities:{ availableDisplayModes:['inline'] },
      protocolVersion:'2026-01-26',
    },
  });
  if (window.openai?.toolOutput) renderResult(window.openai.toolOutput);
})();
</script>
</body>
</html>`;
