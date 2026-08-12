import type { Env } from "./types";

// Kept in lockstep with public/showcase/hormuz-share.json by the focused
// frozen-showcase test. The Worker must not read storage to serve this state.
const showcase = {
  generatedAt: "2026-07-07T14:00:00.000Z",
  title: "Has Hormuz reopened enough for the gas market to normalize?",
  reviewedAnswer: {
    answer: "No. Hormuz traffic is recovering, but LNG supply has not normalized. The bottleneck has moved from the Strait to damaged Qatari export capacity: replacement supply has contained most of the loss, while the Ras Laffan repair schedule sets a multi-year recovery clock.",
    keyJudgments: [
      {
        text: "Replacement supply narrowed the gap: From March through June, Qatar and UAE loadings were about 35 bcm lower than a year earlier while production elsewhere rose about 27 bcm; global LNG output still fell 4%. Substitution prevented a deeper loss without restoring pre-shock supply.",
        citationUrls: ["https://www.iea.org/reports/gas-market-report-q3-2026/executive-summary"],
      },
      {
        text: "Damage outlasts reopening: Reopening cannot restore output from two damaged Ras Laffan trains that removed 17% of Qatar's export capacity. With repairs expected to take up to five years, plant capacity now sets part of the recovery clock.",
        citationUrls: ["https://www.eia.gov/todayinenergy/detail.php?id=67484"],
      },
      {
        text: "Asia's premium redirected flexible cargoes: Weaker demand and cargo diversion helped lower prices while supply stayed impaired. Asia's $2.1 per MBtu premium pulled flexible cargoes east, showing how prices can normalize before physical supply; the IEA still estimates 140 bcm of cumulative LNG losses through 2030.",
        citationUrls: ["https://www.iea.org/reports/gas-market-report-q3-2026/executive-summary"],
      },
    ],
    alternativeCase: {
      text: "New non-Gulf capacity could normalize the wider market before Qatar repairs its damaged trains. The IEA expects close to 50 bcm from new projects and more than 10 bcm from existing producers; if the Strait fully reopens in Q3 and undamaged facilities return in Q4, global supply could hold flat in 2026 despite Qatar’s outage.",
      citationUrls: ["https://www.iea.org/reports/gas-market-report-q3-2026/executive-summary"],
    },
    signposts: [
      {
        text: "Normalization test: carrier traffic and Qatar and UAE cargo loadings recover together for several weeks.",
        citationUrls: [
          "https://www.iea.org/reports/gas-market-report-q3-2026/executive-summary",
          "https://www.eia.gov/international/content/analysis/special_topics/World_Oil_Transit_Chokepoints/",
        ],
      },
      {
        text: "Damaged liquefaction trains return to production and the IEA cuts its cumulative loss estimate.",
        citationUrls: [
          "https://www.iea.org/reports/gas-market-report-q3-2026/executive-summary",
          "https://www.eia.gov/todayinenergy/detail.php?id=67484",
        ],
      },
    ],
    reviewedAt: "2026-07-07T13:00:00.000Z",
  },
  stories: [{
    id: "hormuz-lng-normalization",
    title: "Shipping is recovering faster than LNG supply",
    summary: "From March through June, Qatar and UAE loadings were about 35 bcm lower than a year earlier. Production elsewhere was about 27 bcm higher, offsetting roughly three quarters of the decline, but global LNG output was still about 4% lower year on year.",
    evidenceCount: 3,
    sourceCount: 3,
    independentFamilyCount: 2,
    echoCount: 0,
    changedAt: "2026-07-07T10:00:00.000Z",
    evidence: [
      {
        source: "International Energy Agency",
        title: "Gas Market Report, Q3-2026",
        url: "https://www.iea.org/reports/gas-market-report-q3-2026/executive-summary",
        publishedAt: null,
        excerpt: "From March through June, Qatar and UAE LNG loadings were about 35 bcm lower than a year earlier, production elsewhere was about 27 bcm higher, and global LNG production was still about 4% lower year on year.",
      },
      {
        source: "U.S. Energy Information Administration",
        title: "U.S. natural gas exports to grow nearly 30% by 2027 as LNG facilities ramp up",
        url: "https://www.eia.gov/todayinenergy/detail.php?id=67484",
        publishedAt: "2026-04-16T00:00:00.000Z",
        excerpt: "Damage to two Ras Laffan liquefaction trains removed 17% of Qatar's export capacity; QatarEnergy estimated repairs could take up to five years.",
      },
      {
        source: "U.S. Energy Information Administration",
        title: "World Oil Transit Chokepoints",
        url: "https://www.eia.gov/international/content/analysis/special_topics/World_Oil_Transit_Chokepoints/",
        publishedAt: "2026-03-03T00:00:00.000Z",
        excerpt: "Hormuz carried 20.9 million barrels per day of oil and 11.4 billion cubic feet per day of LNG in the first half of 2025; bypass capacity was much smaller.",
      },
    ],
  }],
} as const;

const SHOWCASE_MODE = "frozen";
const SHOWCASE_MISSION_ID = "hormuz-gas-normalization";
const SHOWCASE_RECEIPT_ID = "showcase-hormuz-share-receipt";
const SHOWCASE_RUN_ID = "showcase-hormuz-reviewed-run";
const FIXED_NOW = "2026-08-11T18:00:00.000Z";
const showcaseStory = showcase.stories[0]!;
const reviewedAnswer = showcase.reviewedAnswer;

const FROZEN_SHOWCASE_SCRIPT = String.raw`(() => {
  "use strict";

  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init = {}) => {
    const rawUrl = typeof input === "string" || input instanceof URL ? input : input.url;
    const url = new URL(rawUrl, location.origin);
    if (url.origin === location.origin && url.pathname.startsWith("/api/")) {
      url.searchParams.set("frozen", "20260811");
      return nativeFetch(url.href, { ...init, cache: "no-store" });
    }
    return nativeFetch(input, init);
  };

  const readOnlyButtons = [
    ".nav",
    ".story-open",
    ".mission-open",
    ".jump-missions",
    ".mission-story",
    ".mission-computer",
    ".judgment-open-receipt",
    "[data-computer-file]",
    ".dialog-close",
    "#close-reasoning-result",
  ].join(",");
  const unavailableTitle = "Unavailable in this read-only example";

  function descendants(root, selector) {
    return [
      ...(root instanceof Element && root.matches(selector) ? [root] : []),
      ...root.querySelectorAll(selector),
    ];
  }

  function setText(selector, value) {
    const node = document.querySelector(selector);
    if (node && node.textContent !== value) node.textContent = value;
  }

  function shortenDisplayTime(node) {
    if (!(node instanceof HTMLElement) || node.dataset.frozenTime === "true") return;
    const original = String(node.textContent || "");
    if (original) node.title = original;
    node.textContent = original
      .replace(/,\s+\d{1,2}:\d{2}\s+(?:AM|PM)/g, "")
      .replace(/\s+at\s+\d{1,2}:\d{2}\s+(?:AM|PM)/g, "");
    node.dataset.frozenTime = "true";
    node.classList.add("frozen-timestamp");
  }

  function freezeControls(root = document) {
    const buttons = [
      ...(root instanceof Element && root.matches("button") ? [root] : []),
      ...root.querySelectorAll("button"),
    ];
    for (const button of buttons) {
      if (button.matches(readOnlyButtons)) continue;
      if (!button.disabled) button.disabled = true;
      if (button.title !== unavailableTitle) button.title = unavailableTitle;
    }
    const fields = [
      ...(root instanceof Element && root.matches("input, select, textarea") ? [root] : []),
      ...root.querySelectorAll("input, select, textarea"),
    ];
    for (const field of fields) {
      if (!field.disabled) field.disabled = true;
      if (field.title !== unavailableTitle) field.title = unavailableTitle;
    }
  }

  async function retireServiceWorker() {
    const cleanup = [];
    if ("serviceWorker" in navigator) {
      cleanup.push(navigator.serviceWorker.getRegistrations().then((registrations) => (
        Promise.all(registrations.map((registration) => registration.unregister()))
      )));
    }
    if ("caches" in globalThis) {
      cleanup.push(caches.keys().then((keys) => Promise.all(
        keys.filter((key) => key.startsWith("driftglass-shell-")).map((key) => caches.delete(key)),
      )));
    }
    await Promise.allSettled(cleanup);
  }

  if ("serviceWorker" in navigator) {
    try {
      Object.defineProperty(navigator.serviceWorker, "register", {
        configurable: true,
        value: () => Promise.reject(new DOMException("Disabled in the public example", "NotAllowedError")),
      });
    } catch {
      // A second cleanup after the application starts catches a concurrent registration.
    }
  }
  retireServiceWorker().catch(() => undefined);

  function removeInstallStatus() {
    document.querySelector("#health-label")?.closest(".sidebar-foot")?.remove();
  }

  function enhanceDialogs(root = document) {
    const dialogs = new Set(descendants(root, "dialog"));
    if (root instanceof Element) {
      const ancestor = root.closest("dialog");
      if (ancestor) dialogs.add(ancestor);
    }
    for (const dialog of dialogs) {
      const close = dialog.querySelector(".dialog-close");
      if (close instanceof HTMLButtonElement) {
        close.type = "button";
        close.setAttribute("aria-label", "Close dialog");
      }
      const title = dialog.querySelector("h2");
      if (title) {
        if (!title.id) title.id = "frozen-" + (dialog.id || "dialog") + "-title";
        dialog.setAttribute("aria-labelledby", title.id);
        dialog.removeAttribute("aria-label");
      } else if (!dialog.hasAttribute("aria-labelledby")) {
        dialog.setAttribute("aria-label", "Driftglass details");
      }
      const summary = dialog.querySelector(".dialog-summary");
      if (summary) {
        if (!summary.id) summary.id = "frozen-" + (dialog.id || "dialog") + "-summary";
        dialog.setAttribute("aria-describedby", summary.id);
      } else {
        dialog.removeAttribute("aria-describedby");
      }
    }
  }

  function structureMissionCards(root = document) {
    for (const card of descendants(root, ".mission-card")) {
      if (!card.classList.contains("frozen-structured")) {
        const header = document.createElement("div");
        const title = document.createElement("div");
        header.className = "frozen-mission-header";
        title.className = "frozen-mission-title";
        for (const node of [card.querySelector(":scope > .story-kicker"), card.querySelector(":scope > h3"), card.querySelector(":scope > p")]) {
          if (node) title.append(node);
        }
        header.append(title);
        const workspace = card.querySelector(".mission-computer");
        if (workspace) header.append(workspace);
        card.prepend(header);
        const matchList = card.querySelector(".mission-match-list");
        if (matchList) {
          const label = document.createElement("p");
          label.className = "frozen-section-label";
          label.textContent = "Recent updates";
          matchList.before(label);
        }
        card.classList.add("frozen-structured");
      }
      for (const node of card.querySelectorAll(".mission-next small,.research-baseline small,.mission-run small,.mission-story small,.mission-ledger-summary")) shortenDisplayTime(node);
    }
    for (const node of descendants(root, ".story-meta span,.evidence-head time,.computer-stats span,.timeline-item small,.memory-node small,.memory-edge small,.judgment-item small,#source-list-standalone td:nth-child(5)")) shortenDisplayTime(node);
  }

  function structureTodayStories(root = document) {
    for (const story of descendants(root, "#today .story")) {
      if (story.querySelector(":scope > .frozen-story-rail")) continue;
      const body = story.querySelector(":scope > .story-body");
      const meta = body?.querySelector(":scope > .story-meta");
      const open = story.querySelector(":scope > .story-open");
      if (!body || !meta || !open) continue;
      const rail = document.createElement("div");
      rail.className = "frozen-story-rail";
      rail.append(meta, open);
      story.append(rail);
    }
  }

  function polishFrozenCopy() {
    const activeView = document.querySelector(".view.active-view")?.id || "today";
    const titles = {
      today: ["Questions you follow", "Today"],
      missions: ["Persistent questions", "Missions"],
      memory: ["What the answers depend on", "Memory"],
      sources: ["Sources behind the answers", "Sources"],
      capture: ["Bring material in", "Capture"],
      companion: ["Optional signed-in collection", "Companion"],
      browser: ["Public page reading", "Page reading"],
      integrations: ["Model-ready context", "Reasoning"],
    };
    const title = titles[activeView];
    if (title) {
      setText("#view-eyebrow", title[0]);
      setText("#view-title", title[1]);
    }
    setText("#memory .memory-hero h3", "What the current answers depend on");
    setText("#memory .memory-hero p:not(.eyebrow)", "Three standing questions, nine tracked changes, and the evidence behind each conclusion.");
    setText("#memory > .split-grid > .panel:first-child .eyebrow", "Current context");
    setText("#memory > .split-grid > .panel:first-child h3", "Standing questions and conclusions");
    setText("#capture .capture-hero h3", "Save pages, newsletters, and imports");
    setText("#capture .capture-hero p:not(.eyebrow)", "Your own install can add public pages, forwarded newsletters, and portable setup files.");
    setText("#companion .companion-hero h3", "Collect signed-in sources from your own browser");
    setText("#companion .companion-hero p:not(.eyebrow)", "The optional Companion can follow Reddit, X, and other signed-in sources without putting those sessions in the cloud.");
    setText("#browser .split-grid > .panel:first-child h3", "Read pages that block simple fetches");
    setText("#browser .split-grid > .panel:nth-child(2) h3", "Remember what works for each site");
    setText("#integrations .chatgpt-hero h3", "Use Driftglass in ChatGPT");
    setText("#integrations .chatgpt-hero p:not(.eyebrow)", "Bring a Mission's sources and prior answer into ChatGPT, then save the cited result for the next review.");
    setText("#integrations .judgment-panel > .section-heading h3", "Saved answers");
    setText('.nav[data-view="sources"]', "Sources");
    setText('.nav[data-view="browser"]', "Page reading");
    for (const [selector, label] of [[".mission-open", "Open"], [".mission-computer", "Workspace"], [".jump-missions", "All Missions"]]) {
      for (const button of document.querySelectorAll(selector)) {
        if (button.textContent !== label) button.textContent = label;
      }
    }
  }

  function ensureFrozenSummaries() {
    const sources = document.querySelector("#sources");
    if (sources && !sources.querySelector(".frozen-source-overview")) {
      sources.insertAdjacentHTML("afterbegin", '<section class="frozen-overview frozen-source-overview"><div><p class="eyebrow">Current source set</p><h3>13 publishers across three active Missions</h3><p>Twenty-seven source items from official releases, research, infrastructure data, and market reporting remain available below.</p></div><div class="frozen-overview-metrics"><span><strong>13</strong> publishers</span><span><strong>27</strong> source items</span><span><strong>3</strong> Missions</span></div></section>');
    }
    const memoryStats = document.querySelector("#memory-stats");
    if (memoryStats && !memoryStats.querySelector(".frozen-metric")) {
      memoryStats.innerHTML = '<article class="stat frozen-metric"><span>Missions</span><strong>3</strong><small>standing questions</small></article><article class="stat frozen-metric"><span>Changes</span><strong>9</strong><small>tracked updates</small></article><article class="stat frozen-metric"><span>Source items</span><strong>27</strong><small>saved evidence</small></article>';
    }
    const companionCopy = document.querySelector("#companion .companion-hero > div:first-child");
    if (companionCopy && !companionCopy.querySelector(".frozen-platforms")) companionCopy.insertAdjacentHTML("beforeend", '<p class="frozen-platforms">Available for macOS, Windows, and Linux.</p>');
    const renderHealth = document.querySelector("#render-health");
    if (renderHealth && !renderHealth.querySelector(".frozen-reader-paths")) renderHealth.innerHTML = '<div class="frozen-reader-paths"><span><strong>Direct read</strong><small>First for public pages</small></span><span><strong>Rendered fallback</strong><small>Only when the page needs it</small></span></div>';
  }

  function trimFrozenUi(root = document) {
    for (const form of descendants(root, "#mission-form")) form.closest(".panel")?.classList.add("frozen-write-panel");
    for (const form of descendants(root, "#reasoning-form")) form.closest(".panel")?.classList.add("frozen-write-panel");
    for (const search of descendants(root, "#catalog-search")) search.closest(".section-heading")?.classList.add("frozen-write-panel");
    const actionCenter = document.querySelector("#action-center");
    actionCenter?.closest(".action-center-section")?.classList.toggle(
      "frozen-empty-section",
      Boolean(actionCenter.querySelector(".empty-state")),
    );
    const standingContext = document.querySelector("#memory .memory-focus-note span");
    if (standingContext && standingContext.textContent !== "Active Missions, conclusions, and open questions stay together with their source trail.") {
      standingContext.textContent = "Active Missions, conclusions, and open questions stay together with their source trail.";
    }
    structureMissionCards(root);
    structureTodayStories(root);
    enhanceDialogs(root);
    polishFrozenCopy();
    ensureFrozenSummaries();
  }

  function resetRouteScroll() {
    requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "auto" }));
  }

  function revealFrozenShowcase() {
    const missionsReady = document.querySelectorAll("#mission-ribbon .list-card").length >= 3;
    const updatesReady = document.querySelectorAll("#today .story").length >= 9;
    if (missionsReady && updatesReady) document.body.classList.add("frozen-showcase-ready");
  }

  function boot() {
    document.body.classList.add("frozen-showcase");
    const brandImage = document.querySelector(".brand img");
    if (brandImage instanceof HTMLImageElement) brandImage.alt = "Driftglass";
    const main = document.querySelector("#app > main");
    if (main && !document.querySelector("#frozen-showcase-note")) {
      main.insertAdjacentHTML(
        "afterbegin",
        '<aside id="frozen-showcase-note" class="frozen-showcase-note"><strong>Frozen example</strong><span>Source checks are paused.</span></aside>',
      );
    }

    const form = document.querySelector("#login-form");
    const secret = document.querySelector("#secret");
    if (form instanceof HTMLFormElement && secret instanceof HTMLInputElement) {
      secret.value = "public-read-only-example";
      form.addEventListener("submit", (event) => event.preventDefault(), { once: true });
      form.requestSubmit();
    }

    freezeControls();
    removeInstallStatus();
    trimFrozenUi();
    revealFrozenShowcase();
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.target instanceof Element) freezeControls(record.target);
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          freezeControls(node);
          trimFrozenUi(node);
        }
      }
      removeInstallStatus();
      trimFrozenUi();
      revealFrozenShowcase();
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });

    document.addEventListener("click", (event) => {
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      if (button?.matches(".nav, .jump-missions, .mission-open")) resetRouteScroll();
      if (button && !button.matches(readOnlyButtons)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
    document.addEventListener("click", (event) => {
      const dialog = event.target instanceof HTMLDialogElement ? event.target : null;
      if (!dialog?.open) return;
      const bounds = dialog.getBoundingClientRect();
      const outside = event.clientX < bounds.left || event.clientX > bounds.right
        || event.clientY < bounds.top || event.clientY > bounds.bottom;
      if (outside) dialog.close();
    });
    document.addEventListener("submit", (event) => {
      if (event.target !== form) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);

    window.addEventListener("hashchange", resetRouteScroll);
    resetRouteScroll();

    retireServiceWorker().catch(() => undefined);
    setTimeout(() => retireServiceWorker().catch(() => undefined), 1000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();`;

const FROZEN_SHOWCASE_STYLES = String.raw`html[data-driftglass-mode="frozen"],html[data-driftglass-mode="frozen"] body{max-width:100%;overflow-x:clip}
html[data-driftglass-mode="frozen"] body:not(.frozen-showcase-ready) #app{visibility:hidden}
.frozen-showcase{--frozen-radius:12px;--frozen-radius-small:8px;-webkit-font-smoothing:antialiased}
.frozen-showcase,.frozen-showcase .app-shell,.frozen-showcase main{min-width:0;max-width:100%}
.frozen-showcase .app-shell{grid-template-columns:220px minmax(0,1fr)}
.frozen-showcase .sidebar{padding:24px 14px}
.frozen-showcase .brand{padding:0 8px 24px}
.frozen-showcase .brand picture{display:block;width:148px}
.frozen-showcase .brand-lockup{display:block;width:148px;height:auto;filter:brightness(0) invert(1)}
.frozen-showcase .nav{border-radius:7px;padding:9px 12px}
.frozen-showcase main{position:relative;padding-bottom:64px}
.frozen-showcase .topbar{min-height:102px;align-items:flex-end;padding-bottom:22px}
.frozen-showcase .topbar h2{font-size:40px;line-height:1;letter-spacing:-.055em}
.frozen-showcase .view{padding-top:28px}
.frozen-showcase .section-heading{margin:36px 0 14px}
.frozen-showcase .section-heading.compact{margin:0 0 16px}
.frozen-showcase .eyebrow{font-size:9px;letter-spacing:.15em}
.frozen-showcase-note{position:absolute;z-index:2;top:23px;right:38px;display:flex;min-width:0;align-items:center;gap:7px;margin:0;padding:6px 9px;border:1px solid var(--line);border-radius:5px;background:var(--panel);color:var(--muted);font-size:9px;line-height:1.35;overflow-wrap:anywhere}
.frozen-showcase-note strong{color:var(--ink)}
.frozen-showcase button:disabled,.frozen-showcase input:disabled,.frozen-showcase select:disabled,.frozen-showcase textarea:disabled{cursor:not-allowed;opacity:.44}
.frozen-showcase .nav:disabled{opacity:1}
.frozen-showcase .sidebar-foot{display:none!important}
.frozen-showcase .panel,.frozen-showcase .hero-panel,.frozen-showcase .smart-add{border-radius:var(--frozen-radius);box-shadow:none}
.frozen-showcase .stat,.frozen-showcase .list-card,.frozen-showcase .story,.frozen-showcase .pack,.frozen-showcase .provider-card,.frozen-showcase .judgment-item,.frozen-showcase .memory-node,.frozen-showcase .memory-edge,.frozen-showcase .timeline-item,.frozen-showcase .empty-state{border-radius:var(--frozen-radius-small);box-shadow:none}
.frozen-showcase .badge,.frozen-showcase .feature-list span,.frozen-showcase .story-kicker span,.frozen-showcase .pack-metrics span{border-radius:4px}
.frozen-showcase .topbar>.top-actions,.frozen-showcase #story-search,.frozen-showcase .frozen-write-panel,.frozen-showcase .feedback-row,.frozen-showcase .computer-toolbar,.frozen-showcase #computer-search-form,.frozen-showcase #computer-search-result,.frozen-showcase #computer-note-form,.frozen-showcase .frozen-empty-section,.frozen-showcase .nav[data-view="system"],.frozen-showcase .nav[data-view="capture"],.frozen-showcase .nav[data-view="companion"],.frozen-showcase .nav[data-view="browser"],.frozen-showcase .mission-card>.feature-list,.frozen-showcase .mission-card>.mission-autopilot,.frozen-showcase .mission-card>.mission-run,.frozen-showcase .mission-card>.mission-ledger-summary,.frozen-showcase .mission-actions,.frozen-showcase #memory-search-form,.frozen-showcase #memory-run-status,.frozen-showcase #memory-audit,.frozen-showcase .memory-checkpoint-panel,.frozen-showcase #memory-proposals,.frozen-showcase #memory-proposal-count{display:none!important}
.frozen-showcase .frozen-timestamp,.frozen-showcase time{font-variant-numeric:tabular-nums;white-space:nowrap}

/* Today */
.frozen-showcase #today>.stats{display:none}
.frozen-showcase #mission-ribbon{gap:0;border-top:1px solid var(--line)}
.frozen-showcase #mission-ribbon .list-card{display:grid;grid-template-columns:minmax(0,1fr) 92px;gap:22px;align-items:center;border:0;border-bottom:1px solid var(--line);padding:15px 16px;background:transparent}
.frozen-showcase #mission-ribbon .list-card:hover{background:rgba(255,255,255,.52)}
.frozen-showcase #mission-ribbon .list-card>div:first-child{display:block}
.frozen-showcase #mission-ribbon .mission-open,.frozen-showcase #today .story-open{justify-self:end;border:0;background:transparent;color:var(--ink);font-size:12px;font-weight:780;box-shadow:none}
.frozen-showcase #mission-ribbon .mission-open:after,.frozen-showcase #today .story-open:after{content:"  →";color:var(--accent)}
.frozen-showcase #mission-ribbon .jump-missions{border:0;border-radius:0;padding:4px 0;background:transparent;box-shadow:none;color:var(--ink);font-size:12px;font-weight:780}
.frozen-showcase #mission-ribbon .jump-missions:after{content:"  →";color:var(--accent)}
.frozen-showcase #today .story-list{gap:0;border-top:1px solid var(--line)}
.frozen-showcase #today .story{border:0;border-bottom:1px solid var(--line);border-radius:0;padding:18px 14px;background:transparent}
.frozen-showcase #today .story:hover{transform:none;box-shadow:none;background:rgba(255,255,255,.52)}
.frozen-showcase #today .story{grid-template-columns:minmax(0,1fr) 92px;gap:22px}
.frozen-showcase #today .story-body{display:block;min-width:0}
.frozen-showcase #today .frozen-story-rail{display:flex;min-height:54px;flex-direction:column;align-items:flex-end;justify-content:space-between;gap:10px;padding-top:1px;text-align:right}
.frozen-showcase #today .story-meta{justify-content:flex-end;margin:0;text-align:right}
.frozen-showcase #today .story-open{padding:0}

/* Missions */
.frozen-showcase #missions>.split-grid{grid-template-columns:minmax(0,1fr);max-width:none}
.frozen-showcase #missions>.split-grid>div>.section-heading.compact{display:none}
.frozen-showcase #mission-list{gap:0;border-top:1px solid var(--line)}
.frozen-showcase .mission-card{padding:28px 0;overflow:hidden;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent}
.frozen-showcase .frozen-mission-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}
.frozen-showcase .frozen-mission-title{min-width:0;max-width:74ch}
.frozen-showcase .frozen-mission-title>.story-kicker{display:none}
.frozen-showcase .frozen-mission-title h3{margin:0 0 8px;font-size:28px;line-height:1.12}
.frozen-showcase .frozen-mission-title>p{margin:0;color:var(--ink-soft);font-size:14px;line-height:1.55}
.frozen-showcase .frozen-mission-header>.mission-computer{flex:0 0 auto;margin-top:0;padding:5px 0;border:0;border-radius:0;background:transparent;color:var(--ink);box-shadow:none;font-size:12px}
.frozen-showcase .frozen-mission-header>.mission-computer:after{content:"  →";color:var(--accent)}
.frozen-showcase .mission-next,.frozen-showcase .research-baseline{display:grid;grid-template-columns:minmax(0,1fr) 118px;gap:6px 20px;margin-top:18px;padding:15px 0 0;border:0;border-top:1px solid var(--line);border-radius:0;background:transparent}
.frozen-showcase .mission-next>span,.frozen-showcase .research-baseline>span{grid-column:1;margin:0;color:var(--muted);font-size:9px}
.frozen-showcase .mission-next>small,.frozen-showcase .research-baseline>small{grid-column:2;grid-row:1;margin:0;align-self:start;color:var(--muted);font-size:10px;text-align:right}
.frozen-showcase .mission-next>strong,.frozen-showcase .research-baseline>p{grid-column:1/-1;margin:0;color:var(--ink-soft);font-size:13px;line-height:1.55}
.frozen-showcase .mission-card .research-baseline p{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:4;line-clamp:4}
.frozen-showcase .frozen-section-label{margin:18px 0 0;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);text-transform:uppercase;letter-spacing:.12em;font-size:9px;font-weight:800}
.frozen-showcase .mission-match-list{gap:0;margin-top:5px}
.frozen-showcase .mission-match-list .list-card{border:0;border-bottom:1px solid color-mix(in srgb,var(--line) 72%,transparent);border-radius:0;padding:11px 0;background:transparent;text-align:left}
.frozen-showcase .mission-match-list .list-card:last-child{border-bottom:0}
.frozen-showcase .mission-match-list .list-card>div{display:block;width:100%}
.frozen-showcase .mission-match-list .list-card>div>div{display:grid;grid-template-columns:minmax(0,1fr) 118px;gap:18px;align-items:baseline;width:100%}
.frozen-showcase .mission-match-list h4{margin:0;font-size:13px;font-weight:720}
.frozen-showcase .mission-match-list small{grid-column:2;color:var(--muted);text-align:right}

/* Memory */
.frozen-showcase .memory-hero{padding:0 0 25px;border:0;border-radius:0;background:transparent}
.frozen-showcase .memory-hero h3{margin-bottom:7px}
.frozen-showcase .memory-hero p:not(.eyebrow){margin:0}
.frozen-showcase #memory-stats{grid-template-columns:repeat(3,minmax(0,1fr));gap:0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);border-radius:0;overflow:hidden}
.frozen-showcase #memory-stats .stat{border:0;border-right:1px solid var(--line);border-radius:0;padding:15px 18px;background:var(--panel)}
.frozen-showcase #memory-stats .stat:last-child{border-right:0}
.frozen-showcase #memory .split-grid{grid-template-columns:minmax(0,1fr);gap:16px}
.frozen-showcase #memory .panel{padding:24px 0;border:0;border-radius:0;background:transparent}
.frozen-showcase #memory .top-actions{display:none!important}
.frozen-showcase .memory-node-list,.frozen-showcase .memory-edge-list,.frozen-showcase .timeline-list{gap:0;margin-top:10px}
.frozen-showcase .memory-node,.frozen-showcase .memory-edge,.frozen-showcase .timeline-item{border:0;border-top:1px solid var(--line);border-radius:0;padding:13px 0;background:transparent}
.frozen-showcase .memory-focus-note{border:0;border-left:2px solid var(--accent);border-radius:0;padding:8px 0 8px 12px;background:transparent}
.frozen-showcase #memory>.split-grid:last-of-type>div:last-child{display:none}
.frozen-showcase #memory>.split-grid:last-of-type{grid-template-columns:minmax(0,1fr)}

/* Sources */
.frozen-showcase #sources>.smart-add,.frozen-showcase #sources>.section-heading,.frozen-showcase #intelligence-pack-grid,.frozen-showcase .community-lens-panel,.frozen-showcase .legacy-lenses,.frozen-showcase .source-value-panel,.frozen-showcase #source-form-panel{display:none!important}
.frozen-showcase .frozen-overview{display:flex;align-items:flex-end;justify-content:space-between;gap:32px;margin-bottom:20px;padding:0 0 24px;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent}
.frozen-showcase .frozen-overview h3{max-width:680px;margin:5px 0 8px}
.frozen-showcase .frozen-overview p:not(.eyebrow){max-width:680px;margin:0;color:var(--muted);font-size:13px}
.frozen-showcase .frozen-overview-metrics{display:flex;flex:0 0 auto;gap:22px}
.frozen-showcase .frozen-overview-metrics span{display:grid;gap:2px;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.08em}
.frozen-showcase .frozen-overview-metrics strong{color:var(--ink);font-size:22px;letter-spacing:-.04em}
.frozen-showcase #source-list-standalone{border:0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);border-radius:0}
.frozen-showcase #source-list-standalone th{padding-top:11px;padding-bottom:11px}
.frozen-showcase #source-list-standalone td{padding-top:12px;padding-bottom:12px}
.frozen-showcase #source-list-standalone td:nth-child(3) .micro{display:none}
.frozen-showcase #source-list-standalone th:nth-child(6),.frozen-showcase #source-list-standalone td:nth-child(6),.frozen-showcase #source-list-standalone th:last-child,.frozen-showcase #source-list-standalone td:last-child{display:none}

/* Read-only capability pages */
.frozen-showcase #capture .capture-hero,.frozen-showcase #companion .companion-hero,.frozen-showcase #integrations .chatgpt-hero{padding:34px 38px}
.frozen-showcase #capture .capture-form,.frozen-showcase #capture .capture-tools,.frozen-showcase #capture>.split-grid .top-actions,.frozen-showcase #companion #pair,.frozen-showcase #companion #pair-output,.frozen-showcase #companion #catalog-search,.frozen-showcase #companion #catalog-list,.frozen-showcase #companion>.section-heading:last-of-type,.frozen-showcase #browser form,.frozen-showcase #browser #browser-result,.frozen-showcase #integrations #reasoning-providers,.frozen-showcase #integrations .dossier-panel,.frozen-showcase #integrations .reasoning-advanced,.frozen-showcase #integrations .semantic-memory-panel,.frozen-showcase #integrations .pulse-panel{display:none!important}
.frozen-showcase #capture>.split-grid,.frozen-showcase #browser>.split-grid{gap:16px}
.frozen-showcase #capture>.split-grid .panel,.frozen-showcase #browser>.split-grid .panel{padding:22px}
.frozen-showcase #companion .steps{gap:0;margin:22px 0 0;border-top:1px solid var(--line)}
.frozen-showcase #companion .steps>div{border:0;border-right:1px solid var(--line);border-radius:0;padding:15px 18px;background:transparent}
.frozen-showcase #companion .steps>div:last-child{border-right:0}
.frozen-showcase #companion .steps span{border-radius:6px}
.frozen-showcase #companion>.section-heading{margin-top:30px}
.frozen-showcase #companion .platform-cloud{display:none!important}
.frozen-showcase .frozen-platforms{margin:14px 0 0;color:var(--muted);font-size:12px}
.frozen-showcase #browser>.panel.space-top{padding:22px}
.frozen-showcase #browser>.split-grid>.panel:first-child:after{content:"Driftglass starts with a direct read, then uses a rendered-page reader only when the page requires it.";display:block;margin-top:12px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:12px;line-height:1.55}
.frozen-showcase #browser #render-health .render-cards,.frozen-showcase #browser #render-health>p{display:none!important}
.frozen-showcase .frozen-reader-paths{display:grid;gap:0;margin-top:16px;border-top:1px solid var(--line)}
.frozen-showcase .frozen-reader-paths>span{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}
.frozen-showcase .frozen-reader-paths strong{font-size:12px}.frozen-showcase .frozen-reader-paths small{color:var(--muted);font-size:11px;text-align:right}
.frozen-showcase #integrations .chatgpt-hero{padding:0 0 28px;border:0;border-radius:0;background:transparent}
.frozen-showcase #integrations .judgment-panel{padding:24px 0;border:0;border-top:1px solid var(--line);border-radius:0;background:transparent}
.frozen-showcase #integrations .chatgpt-hero .feature-list{display:none}
.frozen-showcase #integrations .judgment-panel>.section-heading{margin-top:0}
.frozen-showcase #integrations .judgment-panel>p,.frozen-showcase #integrations .judgment-panel>.section-heading .top-actions,.frozen-showcase #integrations .judgment-summary,.frozen-showcase #integrations .judgment-grid>section:nth-child(1),.frozen-showcase #integrations .judgment-grid>section:nth-child(3),.frozen-showcase #integrations .judgment-grid>section:nth-child(4){display:none!important}
.frozen-showcase #integrations .judgment-grid{grid-template-columns:minmax(0,1fr)}
.frozen-showcase #integrations .judgment-grid>section{padding:0;border:0;border-radius:0;background:transparent}
.frozen-showcase #integrations .judgment-grid>section>.section-heading{margin-top:0}
.frozen-showcase #integrations .judgment-grid>section:nth-child(2)>.section-heading{display:none}
.frozen-showcase #integrations #judgment-receipts{gap:0;border-top:1px solid var(--line)}
.frozen-showcase #integrations #judgment-receipts>.list-card{grid-template-columns:minmax(0,1fr) 120px;gap:18px;padding:15px 0;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;box-shadow:none;text-align:left}
.frozen-showcase #integrations #judgment-receipts>.list-card>span{justify-self:end;align-self:start}
.frozen-showcase #integrations .judgment-item{display:grid;grid-template-columns:minmax(0,1fr) 96px;gap:4px 18px;padding:16px 0;border:0;border-top:1px solid var(--line);border-radius:0;background:transparent}
.frozen-showcase #integrations .judgment-item h5,.frozen-showcase #integrations .judgment-item p{grid-column:1;margin:0}
.frozen-showcase #integrations .judgment-item .story-kicker{grid-column:2;grid-row:1/4;align-self:start;justify-content:flex-end;margin:2px 0 0}
.frozen-showcase #integrations .judgment-item .story-kicker span:not(:last-child){display:none}

/* Dialogs */
.frozen-showcase dialog{overscroll-behavior:contain;border-radius:16px}
.frozen-showcase dialog::backdrop{background:rgba(10,13,18,.68);backdrop-filter:blur(8px)}
.frozen-showcase dialog .dialog-close{z-index:2;display:grid;min-width:58px;min-height:44px;place-items:center;border:1px solid var(--line);border-radius:8px;padding:8px 12px;background:color-mix(in srgb,var(--panel) 94%,transparent);box-shadow:0 4px 16px rgba(21,25,32,.06);color:var(--ink-soft)}
.frozen-showcase dialog .dialog-close:hover{border-color:var(--line-strong);background:var(--panel)}
.frozen-showcase dialog .dialog-close:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 38%,transparent);outline-offset:3px}
.frozen-showcase #story-detail>h2,.frozen-showcase dialog .adapter-dialog-head>h2{padding-right:76px}
.frozen-showcase .evidence{border-radius:8px}

@media(max-width:900px){
  .frozen-showcase .app-shell{grid-template-columns:1fr}
  .frozen-showcase .sidebar{width:100%;max-width:100vw}
  .frozen-showcase .sidebar nav{display:flex;min-width:0;flex:1;justify-content:space-between;gap:1px}
  .frozen-showcase .nav{padding:9px 7px;font-size:13px}
  .frozen-showcase .brand{padding:0 10px 0 0}
  .frozen-showcase .brand picture{width:32px}
  .frozen-showcase .brand-lockup{width:32px;height:32px;object-fit:contain}
  .frozen-showcase .sidebar-foot{display:none}
  .frozen-showcase-note{position:static;align-items:flex-start;justify-content:flex-start;flex-wrap:wrap;margin:0 -20px;padding:7px 20px;border-width:0 0 1px;border-radius:0;background:transparent}
  .frozen-showcase #memory .split-grid{grid-template-columns:1fr}
  .frozen-showcase .frozen-overview{align-items:flex-start;flex-direction:column}
}
@media(max-width:680px){
  .frozen-showcase .topbar{min-height:84px;padding-bottom:17px}
  .frozen-showcase .topbar h2{font-size:34px}
  .frozen-showcase-note{flex-direction:column;gap:2px}
  .frozen-showcase .view{padding-top:20px}
  .frozen-showcase #mission-ribbon .list-card{grid-template-columns:minmax(0,1fr) 62px;gap:12px;padding:15px 0}
  .frozen-showcase #mission-ribbon>.section-heading{align-items:flex-end}
  .frozen-showcase #mission-ribbon .jump-missions{width:auto;padding:4px 0}
  .frozen-showcase #today .story{grid-template-columns:minmax(0,1fr) 52px;gap:12px;padding:17px 0}
  .frozen-showcase #today .frozen-story-rail{min-height:48px;gap:8px}
  .frozen-showcase #today .story-meta{justify-content:flex-end;text-align:right}
  .frozen-showcase .mission-card{padding:22px 0}
  .frozen-showcase .frozen-mission-header{flex-direction:column;gap:15px}
  .frozen-showcase .frozen-mission-header>.mission-computer{width:100%}
  .frozen-showcase .mission-next,.frozen-showcase .research-baseline{grid-template-columns:1fr}
  .frozen-showcase .mission-next>small,.frozen-showcase .research-baseline>small{grid-column:1;grid-row:auto;text-align:left}
  .frozen-showcase .mission-match-list .list-card>div>div{grid-template-columns:1fr;gap:4px}
  .frozen-showcase .mission-match-list small{grid-column:1;text-align:left}
  .frozen-showcase #memory-stats{grid-template-columns:1fr}
  .frozen-showcase #memory-stats .stat{border-right:0;border-bottom:1px solid var(--line)}
  .frozen-showcase #memory-stats .stat:last-child{border-bottom:0}
  .frozen-showcase .frozen-overview-metrics{width:100%;justify-content:space-between;gap:12px}
  .frozen-showcase #integrations #judgment-receipts>.list-card{grid-template-columns:minmax(0,1fr) auto;gap:10px}
  .frozen-showcase #capture .capture-hero,.frozen-showcase #companion .companion-hero,.frozen-showcase #integrations .chatgpt-hero{padding:26px 20px}
  .frozen-showcase #companion .steps{grid-template-columns:1fr}
  .frozen-showcase #companion .steps>div{border-right:0;border-bottom:1px solid var(--line);padding:14px 0}
  .frozen-showcase #companion .steps>div:last-child{border-bottom:0}
  .frozen-showcase dialog{width:calc(100vw - 16px);max-height:calc(100dvh - 16px);border-radius:12px;padding:24px 16px 20px}
  .frozen-showcase dialog .dialog-close{top:8px;right:8px;min-width:54px}
  .frozen-showcase #story-detail>h2,.frozen-showcase dialog .adapter-dialog-head>h2{padding-right:62px}
  .frozen-showcase .computer-tree{max-height:none}
}
@media(max-width:520px){
  .frozen-showcase .brand{padding-right:5px}
}`;

type FrozenEvidence = {
  id: string;
  source_name: string;
  title: string;
  url: string;
  published_at: string;
  text: string;
};

type FrozenStory = {
  story: {
    id: string;
    title: string;
    summary: string;
    source_count: number;
    last_changed_at: string;
  };
  evidence: FrozenEvidence[];
  independentFamilyCount: number;
  echoCount: number;
};

type FrozenWorkspaceFile = {
  path: string;
  name: string;
  depth: number;
  directory: boolean;
};

type FrozenAnswer = {
  answer: string;
  keyJudgments: string[];
  alternativeCase: string;
  signposts: string[];
  citations: string[];
};

type FrozenMissionSeed = {
  id: string;
  name: string;
  question: string;
  terms: string[];
  priority: number;
  storyIds: string[];
  event: { occurred_at: string; title: string; detail: string; event_type: string };
  expectedNextEvent: string;
  expectedBy: string;
  confidence: number;
  reviewedAt: string;
  answer: FrozenAnswer;
  independentFamilyCount: number;
  workspaceFiles: FrozenWorkspaceFile[];
  workspaceContent: Record<string, string>;
  receiptId?: string;
  runId?: string;
};

function evidenceForStory(
  storyId: string,
  items: Array<Omit<FrozenEvidence, "id">>,
): FrozenEvidence[] {
  return items.map((item, index) => ({ ...item, id: `${storyId}-evidence-${index + 1}` }));
}

const hormuzDashboardStory = {
  id: showcaseStory.id,
  title: showcaseStory.title,
  summary: showcaseStory.summary,
  source_count: showcaseStory.sourceCount,
  last_changed_at: showcaseStory.changedAt,
};

const hormuzStory: FrozenStory = {
  story: hormuzDashboardStory,
  evidence: evidenceForStory(showcaseStory.id, showcaseStory.evidence.map((item) => ({
    source_name: item.source,
    title: item.title,
    url: item.url,
    published_at: item.publishedAt ?? FIXED_NOW,
    text: item.excerpt,
  }))),
  independentFamilyCount: showcaseStory.independentFamilyCount,
  echoCount: showcaseStory.echoCount,
};

const cloudflareStorySeeds = [
  {
    id: "cloudflare-ga-execution-primitives",
    title: "The execution primitives have crossed different readiness thresholds",
    summary: "Sandboxes and Containers are generally available, Workflows provides durable retryable steps, and Browser Run supplies an observable browser. They form useful execution lanes, but each should be selected for the job it uniquely handles.",
    lastChangedAt: "2026-04-15T18:00:00.000Z",
    independentFamilyCount: 1,
    evidence: [
      {
        source_name: "Cloudflare Blog",
        title: "Agents have their own computers with Sandboxes GA",
        url: "https://blog.cloudflare.com/sandbox-ga/",
        published_at: "2026-04-13T00:00:00.000Z",
        text: "Cloudflare announced Sandboxes and Containers as generally available for isolated agent workloads that need a full computer, filesystem, commands, state restoration, and controlled lifecycle.",
      },
      {
        source_name: "Cloudflare Blog",
        title: "Rearchitecting the Workflows control plane for the agentic era",
        url: "https://blog.cloudflare.com/workflows-v2/",
        published_at: "2026-04-15T00:00:00.000Z",
        text: "Workflows gives long-running agent work independently retryable steps, failure survival, waits, and human approval. Cloudflare raised its control-plane capacity for machine-triggered workloads.",
      },
      {
        source_name: "Cloudflare Blog",
        title: "Browser Run: give your agents a browser",
        url: "https://blog.cloudflare.com/browser-run-for-ai-agents/",
        published_at: "2026-04-15T00:00:00.000Z",
        text: "Browser Run provides on-demand Chrome, Playwright and CDP control, Live View, session recordings, human intervention, and higher concurrency for agent workloads.",
      },
    ],
  },
  {
    id: "cloudflare-cohesive-agent-runtime",
    title: "Agents SDK and Think are converging on a cohesive runtime",
    summary: "The Agents SDK owns durable identity and state; Project Think composes longer-running execution, sub-agents, workspaces, and tools. June recovery work made the runtime more resilient, but the opinionated layer should remain replaceable.",
    lastChangedAt: "2026-06-16T12:00:00.000Z",
    independentFamilyCount: 1,
    evidence: [
      {
        source_name: "Cloudflare Blog",
        title: "Welcome to Agents Week",
        url: "https://blog.cloudflare.com/welcome-to-agents-week/",
        published_at: "2026-04-12T00:00:00.000Z",
        text: "Cloudflare framed agents as one-to-one workloads whose execution path, tools, and persistence vary by user and task, unlike a traditional one-application-to-many-users service.",
      },
      {
        source_name: "Cloudflare Blog",
        title: "Project Think: building the next generation of AI agents on Cloudflare",
        url: "https://blog.cloudflare.com/project-think/",
        published_at: "2026-04-15T00:00:00.000Z",
        text: "Project Think introduced primitives for persistent workspaces, sandboxed code execution, durable long-running tasks, persistent sessions, and sub-agent coordination, plus an opinionated base class that composes them.",
      },
      {
        source_name: "Cloudflare Agents changelog",
        title: "Agents SDK improves browser automation, code execution, and recovery",
        url: "https://developers.cloudflare.com/changelog/post/2026-06-16-agents-sdk-v0.16.1/",
        published_at: "2026-06-16T00:00:00.000Z",
        text: "Agents SDK v0.16.1 added durable Browser Run and Code Mode integration, approval resumption, and more reliable recovery from deploys, Durable Object evictions, and connection churn.",
      },
    ],
  },
  {
    id: "cloudflare-durable-workspace-layers",
    title: "Workspace, artifact, and memory layers preserve different things",
    summary: "Artifacts stores Git-compatible versions, Agent Memory recalls session knowledge, and Cloudflare Computer exposes bounded durable files. Keeping these layers distinct preserves replacement options and avoids treating every form of state as the same database.",
    lastChangedAt: "2026-08-11T17:00:00.000Z",
    independentFamilyCount: 1,
    evidence: [
      {
        source_name: "Cloudflare Blog",
        title: "Artifacts: versioned storage that speaks Git",
        url: "https://blog.cloudflare.com/artifacts-git-for-agents-beta/",
        published_at: "2026-04-16T00:00:00.000Z",
        text: "Artifacts was introduced as a distributed, versioned filesystem that speaks Git and can create repositories, credentials, commits, imports, and forks programmatically. The launch described it as private beta.",
      },
      {
        source_name: "Cloudflare Blog",
        title: "Agents that remember: introducing Agent Memory",
        url: "https://blog.cloudflare.com/introducing-agent-memory/",
        published_at: "2026-04-17T00:00:00.000Z",
        text: "Agent Memory was introduced as a managed retrieval-based service for preserving and recalling information from sessions without filling the active context window. The launch described it as private beta and exportable.",
      },
      {
        source_name: "Cloudflare Computer on GitHub",
        title: "Cloudflare Computer 0.2.0",
        url: "https://github.com/cloudflare/computer/releases/tag/%40cloudflare/computer%400.2.0",
        published_at: "2026-08-11T16:52:00.000Z",
        text: "Cloudflare Computer 0.2.0 added bounded workspace byte reads, paginated directory listings with metadata, broader file tools, unified egress configuration, and lower peak memory during sync pulls.",
      },
    ],
  },
  {
    id: "cloudflare-agent-stack-maturity",
    title: "One launch week still contains several maturity classes",
    summary: "The portfolio ranges from generally available compute to private-beta storage and memory, an opinionated harness, and a rapidly changing Computer package. The adoption decision should be component-by-component, with the whole source set treated as one vendor family.",
    lastChangedAt: "2026-08-11T17:00:00.000Z",
    independentFamilyCount: 1,
    evidence: [
      {
        source_name: "Cloudflare Blog",
        title: "Building the agentic cloud: everything launched during Agents Week 2026",
        url: "https://blog.cloudflare.com/agents-week-in-review/",
        published_at: "2026-04-20T00:00:00.000Z",
        text: "The Agents Week review spans compute, security, agent tools, production tooling, and the agentic web. It is a portfolio map, not evidence that every component has the same stability or adoption boundary.",
      },
      {
        source_name: "Cloudflare Blog",
        title: "Agents that remember: introducing Agent Memory",
        url: "https://blog.cloudflare.com/introducing-agent-memory/",
        published_at: "2026-04-17T00:00:00.000Z",
        text: "Agent Memory's launch status was private beta, so its architecture can inform a boundary without forcing production dependence on the service.",
      },
      {
        source_name: "Cloudflare Computer on GitHub",
        title: "Cloudflare Computer 0.2.0",
        url: "https://github.com/cloudflare/computer/releases/tag/%40cloudflare/computer%400.2.0",
        published_at: "2026-08-11T16:52:00.000Z",
        text: "The Computer package is still moving through early releases; 0.2.0 expanded bounded file and directory operations and changed execution-backend behavior.",
      },
    ],
  },
] as const;

const infrastructureStorySeeds = [
  {
    id: "ai-realized-adoption-signal",
    title: "Realized usage is beginning to justify the buildout",
    summary: "Cloud capacity remains constrained while customer consumption, chips deployed, Bedrock usage, and accelerator revenue are rising. These are realized commercial signals, though provider disclosures should still be read as related rather than independent demand estimates.",
    lastChangedAt: "2026-05-20T12:00:00.000Z",
    independentFamilyCount: 3,
    evidence: [
      {
        source_name: "Microsoft Investor Relations",
        title: "Microsoft fiscal year 2026 third-quarter earnings",
        url: "https://www.microsoft.com/en-us/investor/events/fy-2026/earnings-fy-2026-q3",
        published_at: "2026-04-29T00:00:00.000Z",
        text: "Microsoft said Azure demand continued to exceed available capacity, reported adding another gigawatt during the quarter, and linked continued capital spending to usage and customer demand while expecting capacity constraints through 2026.",
      },
      {
        source_name: "Amazon Investor Relations",
        title: "Amazon first-quarter 2026 results",
        url: "https://ir.aboutamazon.com/news-release/news-release-details/2026/Amazon-com-Announces-First-Quarter-Results/",
        published_at: "2026-04-30T00:00:00.000Z",
        text: "Amazon reported more than 2.1 million AI chips landed over the prior 12 months and said Bedrock processed more tokens in the quarter than in all prior years combined, alongside 170% quarter-over-quarter customer-spend growth.",
      },
      {
        source_name: "NVIDIA Newsroom",
        title: "NVIDIA first-quarter fiscal 2027 results",
        url: "https://nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-first-quarter-fiscal-2027",
        published_at: "2026-05-20T00:00:00.000Z",
        text: "NVIDIA reported record first-quarter Data Center revenue of $75.2 billion, up 92% year over year, with both compute and networking contributing to the expansion.",
      },
    ],
  },
  {
    id: "ai-power-grid-local-bottleneck",
    title: "Power and grid integration are binding locally",
    summary: "National demand growth is large, but the binding constraint appears in regional forecasts, service studies, tariffs, and speed-to-power. Announced load should count only as confidence rises through contracts, construction commitments, and energized capacity.",
    lastChangedAt: "2026-06-18T12:00:00.000Z",
    independentFamilyCount: 3,
    evidence: [
      {
        source_name: "U.S. Department of Energy",
        title: "DOE report evaluates rising electricity demand from data centers",
        url: "https://www.energy.gov/articles/doe-releases-new-report-evaluating-increase-electricity-demand-data-centers",
        published_at: "2024-12-20T00:00:00.000Z",
        text: "DOE reported that U.S. data centers used about 4.4% of electricity in 2023 and could use approximately 6.7% to 12% by 2028, with flexibility, onsite supply, transmission, and efficiency all part of the response.",
      },
      {
        source_name: "PJM Interconnection",
        title: "2026 PJM Load Forecast Report",
        url: "https://www.pjm.com/-/media/DotCom/library/reports-notices/load-forecast/2026-load-report.pdf",
        published_at: "2026-01-14T00:00:00.000Z",
        text: "PJM adjusted many zones for data-center load growth while lowering its near-term forecast from 2025. It requires firmer commitments for near-term large-load adjustments and derates less certain longer-term projects.",
      },
      {
        source_name: "Federal Energy Regulatory Commission",
        title: "FERC launches action to speed large-load integration",
        url: "https://www.ferc.gov/news-events/news/ferc-launches-aggressive-targeted-action-speed-large-load-integration",
        published_at: "2026-06-18T00:00:00.000Z",
        text: "FERC ordered six regional grid operators to justify or reform tariffs for data centers and other large loads, addressing studies, cost shifting, co-location, flexible loads, and adequate generation.",
      },
    ],
  },
  {
    id: "ai-forecast-and-dynamic-load-credibility",
    title: "Forecast credibility now depends on load behavior as well as size",
    summary: "The buildout forecast is more credible when it distinguishes contracted from speculative load and models rapid AI power swings. Efficiency improves per task, but broader use and synchronized training can still raise total demand and new reliability requirements.",
    lastChangedAt: "2026-05-28T12:00:00.000Z",
    independentFamilyCount: 3,
    evidence: [
      {
        source_name: "International Energy Agency",
        title: "Data-centre electricity use surged in 2025",
        url: "https://www.iea.org/news/data-centre-electricity-use-surged-in-2025-even-with-tightening-bottlenecks-driving-a-scramble-for-solutions",
        published_at: "2026-04-16T00:00:00.000Z",
        text: "The IEA reported 17% growth in data-center electricity demand in 2025. Per-task efficiency improved rapidly, but usage and energy-intensive agent workloads rose while grid, transformer, turbine, chip, and approval bottlenecks tightened.",
      },
      {
        source_name: "U.S. Department of Energy Office of Electricity",
        title: "Monitoring Oscillations from Large Data Centers",
        url: "https://www.energy.gov/oe/articles/monitoring-oscillations-large-data-centers",
        published_at: "2026-05-28T00:00:00.000Z",
        text: "DOE described synchronized AI training as a source of repetitive load oscillations across a wide frequency range and recommended combining phasor and high-resolution point-on-wave measurements to monitor them.",
      },
      {
        source_name: "PJM Interconnection",
        title: "2026 PJM Load Forecast Report",
        url: "https://www.pjm.com/-/media/DotCom/library/reports-notices/load-forecast/2026-load-report.pdf",
        published_at: "2026-01-14T00:00:00.000Z",
        text: "PJM's methodology separates firm near-term large-load commitments from uncertain projects and derates the latter, demonstrating why headline requested load is not the same as realized demand.",
      },
    ],
  },
  {
    id: "ai-vertical-integration-buildout",
    title: "Chips, data centers, and energy are being integrated vertically",
    summary: "The buildout is no longer a sequence of independent purchases. Providers are pairing silicon, network capacity, data-center construction, and energy development, which can speed delivery but concentrates execution and financing risk.",
    lastChangedAt: "2026-05-20T16:00:00.000Z",
    independentFamilyCount: 3,
    evidence: [
      {
        source_name: "Alphabet Investor Relations",
        title: "Alphabet agreement to acquire Intersect",
        url: "https://abc.xyz/investor/news/news-details/2025/Alphabet-Announces-Agreement-to-Acquire-Intersect-to-Advance-U-S--Energy-Innovation-2025-DVIuVDM9wW/default.aspx",
        published_at: "2025-12-22T00:00:00.000Z",
        text: "Alphabet agreed to acquire data-center and energy infrastructure developer Intersect for $4.75 billion plus assumed debt, explicitly linking the transaction to bringing generation and data-center capacity online together.",
      },
      {
        source_name: "NVIDIA Newsroom",
        title: "NVIDIA first-quarter fiscal 2027 results",
        url: "https://nvidianews.nvidia.com/news/nvidia-announces-financial-results-for-first-quarter-fiscal-2027",
        published_at: "2026-05-20T00:00:00.000Z",
        text: "NVIDIA's Data Center results separate compute and networking growth and describe a platform spanning processors, storage infrastructure, open software, optics, clouds, and purpose-built AI factories.",
      },
      {
        source_name: "Microsoft Investor Relations",
        title: "Microsoft fiscal year 2026 third-quarter earnings",
        url: "https://www.microsoft.com/en-us/investor/events/fy-2026/earnings-fy-2026-q3",
        published_at: "2026-04-29T00:00:00.000Z",
        text: "Microsoft tied capacity additions to GPU, CPU, storage, data-center leases, and first-party silicon, illustrating how utilization, hardware supply, and physical capacity must arrive together.",
      },
    ],
  },
] as const;

function makeStory(seed: {
  id: string;
  title: string;
  summary: string;
  lastChangedAt: string;
  independentFamilyCount: number;
  evidence: ReadonlyArray<Omit<FrozenEvidence, "id">>;
}): FrozenStory {
  return {
    story: {
      id: seed.id,
      title: seed.title,
      summary: seed.summary,
      source_count: new Set(seed.evidence.map((item) => item.url)).size,
      last_changed_at: seed.lastChangedAt,
    },
    evidence: evidenceForStory(seed.id, [...seed.evidence]),
    independentFamilyCount: seed.independentFamilyCount,
    echoCount: 0,
  };
}

const frozenStories = [
  hormuzStory,
  ...cloudflareStorySeeds.map(makeStory),
  ...infrastructureStorySeeds.map(makeStory),
];
const storyById = new Map(frozenStories.map((entry) => [entry.story.id, entry]));

const standardWorkspaceFiles = (notesPath: string, notesName: string): FrozenWorkspaceFile[] => [
  { path: "mission.md", name: "mission.md", depth: 0, directory: false },
  { path: "memory/context.md", name: "context.md", depth: 1, directory: false },
  { path: "memory/timeline.md", name: "timeline.md", depth: 1, directory: false },
  { path: "handoffs/deep-research.md", name: "deep-research.md", depth: 1, directory: false },
  { path: "results/", name: "results", depth: 0, directory: true },
  { path: "results/Current-answer.md", name: "Current answer", depth: 1, directory: false },
  { path: "notes/", name: "notes", depth: 0, directory: true },
  { path: notesPath, name: notesName, depth: 1, directory: false },
];

const hormuzAnswer: FrozenAnswer = {
  answer: reviewedAnswer.answer,
  keyJudgments: reviewedAnswer.keyJudgments.map((item) => item.text),
  alternativeCase: reviewedAnswer.alternativeCase.text,
  signposts: reviewedAnswer.signposts.map((item) => item.text),
  citations: [...new Set([
    ...reviewedAnswer.keyJudgments.flatMap((item) => item.citationUrls),
    ...reviewedAnswer.alternativeCase.citationUrls,
    ...reviewedAnswer.signposts.flatMap((item) => item.citationUrls),
  ])],
};

const cloudflareAnswer: FrozenAnswer = {
  answer: "Adopt the Agents SDK core and Workflows now. Use Browser Run only when direct HTTP cannot recover the rendered or interactive state, and use Sandboxes when the task genuinely needs a full operating system. Keep Project Think, Cloudflare Computer, Artifacts, and Agent Memory behind replaceable boundaries until their contracts and availability stabilize. The evidence set contains ten public items but is almost entirely one vendor family, so it establishes product direction and stated maturity rather than independent market validation.",
  keyJudgments: [
    "Agents SDK and Workflows provide the most durable adoption boundary: persistent state and communication stay separate from bounded, retryable, long-running execution.",
    "Browser Run and Sandboxes are escalation lanes, not defaults. Browser Run earns its cost for rendered interaction; Sandboxes earn theirs for a real operating system, packages, terminals, or long-lived processes.",
    "Computer, Artifacts, Agent Memory, and Think preserve different forms of state and sit at different maturity levels, so each should remain replaceable rather than becoming one inseparable platform commitment.",
  ],
  alternativeCase: "Workers, Durable Objects, D1 or R2, and Workflows may remain the more durable long-term core if the newer workspace, artifact, memory, and harness layers keep changing or if their integration benefit does not outweigh extra platform coupling.",
  signposts: [
    "Computer, Artifacts, Agent Memory, and Think publish stable availability, migration, export, and compatibility contracts.",
    "Browser Run or Sandboxes materially improve a measured workflow after the direct Worker path has been tried.",
    "Independent production evidence appears beyond Cloudflare's own launch posts, changelog, and repository releases.",
  ],
  citations: [...new Set(cloudflareStorySeeds.flatMap((story) => story.evidence.map((item) => item.url)))],
};

const infrastructureAnswer: FrozenAnswer = {
  answer: "Realized adoption is strong enough to justify continued buildout, but power delivery and large-load integration are becoming the binding constraints region by region. Revenue, usage, chip deployment, and capacity disclosures show demand beyond announcements. Still, announced megawatts do not count as delivered infrastructure until they are contracted, permitted, connected, energized, and used.",
  keyJudgments: [
    "Realized demand is visible in constrained cloud capacity, accelerated-compute deployment, Bedrock usage, and Data Center revenue, which is stronger evidence than capital plans alone.",
    "The power constraint is local: PJM now distinguishes firm from speculative large loads, FERC is forcing tariff and study changes, and DOE sees both rapidly rising demand and new operational behavior.",
    "Vertical integration across chips, networking, data centers, and energy can speed projects, but it concentrates delivery, financing, and utilization risk in the same buildout decision.",
  ],
  alternativeCase: "Faster model and hardware efficiency, double-counted load forecasts, permitting delays, or weaker workload economics could leave generation, data centers, or accelerators underused and strand projects that looked necessary when announced.",
  signposts: [
    "Track large loads through contract, permit, interconnection study, construction, energization, and utilization instead of counting the requested capacity once.",
    "Watch whether grid operators add workable flexible-load and co-location tariffs without shifting project risk to other ratepayers.",
    "Compare realized cloud consumption and accelerator utilization with provider capacity additions and energy commitments each quarter.",
  ],
  citations: [...new Set(infrastructureStorySeeds.flatMap((story) => story.evidence.map((item) => item.url)))],
};

const missionSeeds: FrozenMissionSeed[] = [
  {
    id: SHOWCASE_MISSION_ID,
    name: showcase.title,
    question: "Have carrier traffic, Gulf loadings, and damaged liquefaction capacity recovered together for several weeks?",
    terms: ["Hormuz LNG", "Qatar loadings", "UAE loadings", "liquefaction trains"],
    priority: 2.5,
    storyIds: [showcaseStory.id],
    event: {
      occurred_at: showcaseStory.changedAt,
      title: "The bottleneck moved to production",
      detail: "Carrier traffic began to recover while damaged export capacity kept LNG supply below its previous path.",
      event_type: "signal",
    },
    expectedNextEvent: "Carrier traffic, Gulf loadings, and damaged trains recover together for several weeks",
    expectedBy: "2026-10-01T12:00:00.000Z",
    confidence: 0.82,
    reviewedAt: reviewedAnswer.reviewedAt,
    answer: hormuzAnswer,
    independentFamilyCount: showcaseStory.independentFamilyCount,
    workspaceFiles: standardWorkspaceFiles("notes/Normalization-signals.md", "Normalization signals"),
    workspaceContent: {
      "/mission.md": `# Hormuz and the gas shock\n\n## Current answer\n\n${reviewedAnswer.answer}\n\n## Next test\n\n${reviewedAnswer.signposts[0]?.text ?? "Watch carrier traffic, Gulf loadings, and damaged liquefaction capacity together."}\n`,
      "/memory/context.md": "# Background\n\nThe Strait carried almost one fifth of global LNG trade before the disruption. Passage, export capacity, and market balance now recover on different clocks.\n",
      "/memory/timeline.md": `# How this changed\n\n- March through June: Qatar and UAE loadings fell about 35 bcm year on year.\n- Other producers added about 27 bcm, replacing roughly three quarters of the decline.\n- ${showcaseStory.changedAt.slice(0, 10)}: carrier traffic was recovering while damaged liquefaction trains kept production below its previous path.\n`,
      "/handoffs/deep-research.md": `# Research plan\n\n- Verify carrier traffic, Qatar and UAE loadings, and damaged-train repair progress together.\n- Separate market-price normalization from physical LNG supply normalization.\n`,
      "/results/Current-answer.md": `# Current answer\n\n${reviewedAnswer.answer}\n\n## Alternative case\n\n${reviewedAnswer.alternativeCase.text}\n`,
      "/notes/Normalization-signals.md": `# Normalization signals\n\n${reviewedAnswer.signposts.map((item) => `- ${item.text}`).join("\n")}\n`,
    },
    receiptId: SHOWCASE_RECEIPT_ID,
    runId: SHOWCASE_RUN_ID,
  },
  {
    id: "cloudflare-agent-adoption",
    name: "Cloudflare platform and Agent Week adoption",
    question: "Which Cloudflare agent launch creates a practical workflow worth adopting now, and what evidence would change that judgment?",
    terms: ["Cloudflare Computer", "Agents SDK", "Workflows", "Browser Run", "Sandboxes", "Artifacts", "Agent Memory", "Project Think"],
    priority: 2.3,
    storyIds: cloudflareStorySeeds.map((story) => story.id),
    event: {
      occurred_at: "2026-08-11T16:52:00.000Z",
      title: "The stack exposed its maturity boundaries",
      detail: "Generally available compute and durable execution now sit beside beta storage, memory, harness, and workspace layers that should remain replaceable.",
      event_type: "finding",
    },
    expectedNextEvent: "Cloudflare Computer publishes a stable production contract or one optional Agent Week layer proves necessary in a real workflow",
    expectedBy: "2026-10-31T12:00:00.000Z",
    confidence: 0.79,
    reviewedAt: "2026-08-11T17:00:00.000Z",
    answer: cloudflareAnswer,
    independentFamilyCount: 1,
    workspaceFiles: standardWorkspaceFiles("notes/Adoption-boundaries.md", "Adoption boundaries"),
    workspaceContent: {
      "/mission.md": `# Cloudflare platform and Agent Week adoption\n\n## Current answer\n\n${cloudflareAnswer.answer}\n\n## Next test\n\n${cloudflareAnswer.signposts[0]}\n`,
      "/memory/context.md": "# Background\n\nThe source set separates durable agent state, filesystem state, long-running execution, rendered-page interaction, versioned artifacts, and session memory. All ten source items remain almost entirely one Cloudflare-origin family, so channel variety is not treated as independent validation.\n",
      "/memory/timeline.md": "# How this changed\n\n- April 12-20: Agent Week laid out Sandboxes, Workflows, Browser Run, Project Think, Artifacts, Agent Memory, and the broader platform.\n- June 16: the Agents SDK strengthened durable browser, code, approval, and recovery paths.\n- August 11: Cloudflare Computer 0.2.0 expanded bounded file operations while the package continued to evolve.\n",
      "/handoffs/deep-research.md": "# Research plan\n\n- Test the backend-free Computer filesystem before adding any runtime.\n- Measure direct page reading against Browser Run on a page that requires rendering.\n- Evaluate Agent Memory and AI Search separately using recall and file-retrieval tasks.\n",
      "/results/Current-answer.md": `# Current answer\n\n${cloudflareAnswer.answer}\n\n## Alternative case\n\n${cloudflareAnswer.alternativeCase}\n`,
      "/notes/Adoption-boundaries.md": `# Adoption boundaries\n\n${cloudflareAnswer.signposts.map((item) => `- ${item}`).join("\n")}\n`,
    },
  },
  {
    id: "ai-infrastructure-bottlenecks",
    name: "AI infrastructure and adoption",
    question: "Which power, grid, chip, siting, or financing constraint is becoming more binding for AI infrastructure, and does realized adoption justify the buildout?",
    terms: ["data center power", "large-load integration", "grid interconnection", "AI capex", "GPU capacity", "siting", "realized adoption", "utilization"],
    priority: 2.4,
    storyIds: infrastructureStorySeeds.map((story) => story.id),
    event: {
      occurred_at: "2026-06-30T12:00:00.000Z",
      title: "Power and delivery moved ahead of model access",
      detail: "Demand forecasts, queue delays, and provider capital plans now point to regional delivery risk while adoption continues to widen unevenly.",
      event_type: "finding",
    },
    expectedNextEvent: "Large-load connection delays or relocations appear alongside deeper production use across more business functions",
    expectedBy: "2026-12-31T12:00:00.000Z",
    confidence: 0.8,
    reviewedAt: "2026-07-07T12:45:00.000Z",
    answer: infrastructureAnswer,
    independentFamilyCount: 8,
    workspaceFiles: standardWorkspaceFiles("notes/Grid-and-adoption-signals.md", "Grid and adoption signals"),
    workspaceContent: {
      "/mission.md": `# AI infrastructure and adoption\n\n## Current answer\n\n${infrastructureAnswer.answer}\n\n## Next test\n\n${infrastructureAnswer.signposts[0]}\n`,
      "/memory/context.md": "# Background\n\nThis Mission keeps announced load, firm grid commitments, energized capacity, provider usage, accelerator revenue, and operational grid behavior separate. Capacity is not counted as delivered until the evidence moves through the project chain.\n",
      "/memory/timeline.md": "# How this changed\n\n- 2024: DOE documented the range of projected U.S. data-center electricity demand.\n- 2025: Alphabet moved to combine data-center and energy development through Intersect.\n- 2026: PJM tightened forecast treatment, providers reported realized usage and capacity pressure, and DOE and FERC focused on large-load behavior and integration.\n",
      "/handoffs/deep-research.md": "# Research plan\n\n- Track named data-center projects from announced load through energized capacity.\n- Compare queue entry, interconnection agreement, construction, and commercial-operation dates.\n- Measure AI use by business function and production workflow, not headline adoption alone.\n",
      "/results/Current-answer.md": `# Current answer\n\n${infrastructureAnswer.answer}\n\n## Alternative case\n\n${infrastructureAnswer.alternativeCase}\n`,
      "/notes/Grid-and-adoption-signals.md": `# Grid and adoption signals\n\n${infrastructureAnswer.signposts.map((item) => `- ${item}`).join("\n")}\n`,
    },
  },
];

const missionRecords = missionSeeds.map((seed) => {
  const stories = seed.storyIds.map((storyId) => storyById.get(storyId)).filter((entry): entry is FrozenStory => Boolean(entry));
  const evidenceCount = stories.reduce((total, entry) => total + entry.evidence.length, 0);
  const sourceCount = new Set(stories.flatMap((entry) => entry.evidence.map((item) => item.url))).size;
  const echoCount = evidenceCount - sourceCount;
  const receiptId = seed.receiptId ?? `showcase-${seed.id}-receipt`;
  const runId = seed.runId ?? `showcase-${seed.id}-reviewed-run`;
  const mission = {
    id: seed.id,
    name: seed.name,
    question: seed.question,
    terms: seed.terms,
    status: "active",
    cadence_minutes: 1440,
    priority: seed.priority,
    matches: stories.map((entry) => ({
      story_id: entry.story.id,
      title: entry.story.title,
      last_changed_at: entry.story.last_changed_at,
    })),
    pendingResearchResults: [],
    events: [seed.event],
    operator: {
      mode: "watch",
      sprint_policy: "manual",
      next_sprint_at: null,
      expected_next_event: seed.expectedNextEvent,
      expected_event_status: "pending",
      expected_by: seed.expectedBy,
      alert_threshold: 0.65,
      outcome_status: "open",
    },
    researchState: {
      current_thesis: seed.answer.answer,
      confidence: seed.confidence,
      last_research_at: seed.reviewedAt,
    },
  };
  const receipt = {
    id: receiptId,
    title: seed.name,
    target: "chatgpt",
    task: "investigate",
    scope_kind: "mission",
    scope_id: seed.id,
    evidence_count: evidenceCount,
    independent_family_count: seed.independentFamilyCount,
    quality_json: JSON.stringify({ grade: "strong" }),
    created_at: seed.reviewedAt,
  };
  const reasoningRun = {
    id: runId,
    receipt_id: receiptId,
    provider: "ChatGPT",
    model: "",
    status: "reviewed",
    confidence: seed.confidence,
    summary: seed.answer.answer,
    structured_result_json: JSON.stringify(seed.answer),
    completed_at: seed.reviewedAt,
  };
  return { seed, stories, evidenceCount, sourceCount, echoCount, mission, receipt, reasoningRun };
});

const missionById = new Map(missionRecords.map((record) => [record.mission.id, record]));
const receiptById = new Map(missionRecords.map((record) => [record.receipt.id, record]));
const dashboardStories = frozenStories.map((entry) => entry.story);
const totalEvidenceCount = missionRecords.reduce((total, record) => total + record.evidenceCount, 0);
const independentLineageCount = missionRecords.reduce((total, record) => total + record.seed.independentFamilyCount, 0);
const echoLineageCount = missionRecords.reduce((total, record) => total + record.echoCount, 0);
const sameFamilyLineageCount = totalEvidenceCount - independentLineageCount - echoLineageCount;
const dashboardSources = [...new Map(frozenStories.flatMap((entry) => entry.evidence).map((item) => [item.source_name, {
  id: `showcase-source-${item.source_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
  name: item.source_name,
  kind: "web",
  enabled: 1,
  schedule_minutes: 1440,
  health_score: 1,
  last_success_at: FIXED_NOW,
  last_run_at: FIXED_NOW,
}])).values()];

const frozenMemoryNodes = [
  ...missionRecords.map((record) => ({
    id: `memory-mission-${record.mission.id}`,
    node_type: "mission",
    label: record.mission.name,
    summary: record.mission.question,
    status: "active",
    importance: record.seed.priority,
    source_ref: `mission:${record.mission.id}`,
    updated_at: record.seed.reviewedAt,
    metadata: { status: "active", missionId: record.mission.id },
  })),
  ...frozenStories.map((entry) => ({
    id: `memory-story-${entry.story.id}`,
    node_type: "story",
    label: entry.story.title,
    summary: entry.story.summary,
    status: "active",
    importance: Math.min(1, .55 + entry.independentFamilyCount * .08),
    source_ref: `story:${entry.story.id}`,
    updated_at: entry.story.last_changed_at,
    metadata: {
      storyId: entry.story.id,
      sourceCount: entry.evidence.length,
      independentFamilyCount: entry.independentFamilyCount,
    },
  })),
  ...missionRecords.map((record) => ({
    id: `memory-finding-${record.mission.id}`,
    node_type: "finding",
    label: record.seed.answer.keyJudgments[0] ?? record.seed.answer.answer,
    summary: record.seed.answer.answer,
    status: "confirmed",
    importance: record.seed.confidence,
    source_ref: `mission:${record.mission.id}`,
    updated_at: record.seed.reviewedAt,
    metadata: {
      missionId: record.mission.id,
      sourceCount: record.evidenceCount,
      independentFamilyCount: record.seed.independentFamilyCount,
    },
  })),
];

const frozenMemoryEdges = missionRecords.flatMap((record) => [
  {
    id: `memory-edge-answer-${record.mission.id}`,
    from_node_id: `memory-mission-${record.mission.id}`,
    to_node_id: `memory-finding-${record.mission.id}`,
    relation: "answers",
    rationale: "The saved answer is the current conclusion for this Mission.",
    evidence: [`mission:${record.mission.id}`],
  },
  ...record.stories.flatMap((entry) => [
    {
      id: `memory-edge-track-${record.mission.id}-${entry.story.id}`,
      from_node_id: `memory-mission-${record.mission.id}`,
      to_node_id: `memory-story-${entry.story.id}`,
      relation: "tracks",
      rationale: "This update is part of the Mission's current source state.",
      evidence: [`story:${entry.story.id}`],
    },
    {
      id: `memory-edge-support-${record.mission.id}-${entry.story.id}`,
      from_node_id: `memory-story-${entry.story.id}`,
      to_node_id: `memory-finding-${record.mission.id}`,
      relation: "evidence_for",
      rationale: "The Story contributes to the saved conclusion.",
      evidence: entry.evidence.map((item) => item.url),
      metadata: { independentFamilyCount: entry.independentFamilyCount },
    },
  ]),
]);

const frozenMemoryTimeline = missionRecords.flatMap((record) => [
  {
    type: "finding",
    label: record.seed.event.title,
    summary: record.seed.event.detail,
    status: "confirmed",
    at: record.seed.event.occurred_at,
  },
  ...record.stories.map((entry) => ({
    type: "story",
    label: entry.story.title,
    summary: entry.story.summary,
    status: "active",
    at: entry.story.last_changed_at,
  })),
]);

const frozenLimits = {
  browser_ms_day: 0,
  workflow_steps_day: 0,
  ai_search_queries_month: 0,
  memory_writes_day: 0,
  source_runs_day: 0,
  queue_messages_day: 0,
  computer_sync_bytes_day: 0,
  r2_class_a_ops_day: 0,
  r2_class_b_ops_day: 0,
  r2_write_bytes_day: 0,
};

const budget = {
  profile: "free",
  executionCapacity: "free-ceiling",
  effectiveLimits: frozenLimits,
  plannedLimits: frozenLimits,
  daily: {},
  monthly: { ai_search_queries: 0 },
  remaining: {},
  utilization: {},
};

const commonResponses: Record<string, unknown> = {
  "/api/session": {},
  "/api/overview": {
    stories: dashboardStories,
    packInstalls: [],
    sources: dashboardSources,
    collectors: [],
    renderStats: { totals: [], profiles: [] },
  },
  "/api/packs": { packs: [] },
  "/api/missions": { missions: missionRecords.map((record) => record.mission) },
  "/api/mission-runs": {
    runs: missionRecords.map((record) => ({
      mission_id: record.mission.id,
      status: "success",
      started_at: record.seed.reviewedAt,
      result: { collectedItems: record.evidenceCount, matchedStories: record.stories.length },
    })),
  },
  "/api/integrations": {
    scheduledTaskPrompt: "",
    mcpUrl: "",
    operationsMcpUrl: "",
    packetUrl: "",
    pulsePacketUrl: "",
    pulseTaskPrompt: "",
    aiSearchCorpusUrl: "",
    missions: [],
    semanticMemory: { available: false, enabled: false, configured: false },
    deepDiveLab: { configured: false },
  },
  "/api/settings/interests": {
    terms: ["Hormuz LNG", "Cloudflare agents", "durable execution", "AI infrastructure", "data-center power", "realized AI adoption"],
  },
  "/api/capabilities": { fixed: [], catalog: [] },
  "/api/email/receipts": { receipts: [] },
  "/api/shares": { shares: [] },
  "/api/taste": { profile: { positiveTerms: [], negativeTerms: [], preferredSources: [], downweightedSources: [] } },
  "/api/action-center": { actions: [] },
  "/api/readiness": {
    score: 100,
    releaseBlocked: false,
    checks: [{ id: "public-example", label: "Public example", detail: "Fixed source-backed content; collection and changes are paused", status: "ready" }],
  },
  "/api/ingest/dead-letters": { deadLetters: [] },
  "/api/autopilot": { missions: [] },
  "/api/research-results": { imports: [] },
  "/api/intelligence/overview": {
    graph: {
      dirty: false,
      stats: { "type:mission": missionRecords.length, "type:story": frozenStories.length, "type:finding": missionRecords.length },
      recentRuns: [],
    },
    nodes: frozenMemoryNodes,
    edges: frozenMemoryEdges,
    timeline: frozenMemoryTimeline,
    proposals: [],
    runs: [],
    playbooks: [],
    packs: [],
    catalog: [],
    budget,
  },
  "/api/reasoning/providers": { providers: { chatgpt: {}, claude: {}, generic: {} }, mcpUrl: "", operationsMcpUrl: "" },
  "/api/reasoning/connections": { available: false, connections: [] },
  "/api/judgment": {
    summary: { readyReasoningTasks: 0, dueDecisionReviews: 0 },
    lineage: [
      { relation: "origin", independent: 1, count: independentLineageCount },
      { relation: "same-family", independent: 0, count: sameFamilyLineageCount },
      { relation: "echo", independent: 0, count: echoLineageCount },
    ],
    reasoningInbox: [],
    receipts: missionRecords.map((record) => record.receipt),
    reasoningRuns: missionRecords.map((record) => record.reasoningRun),
    decisions: [],
    calibration: { reviewedCount: 0 },
    routines: [],
    sourceScorecards: [],
    cadence: [],
    overlays: [],
  },
  "/api/runtime": {
    context: {
      profile: "cloudflare",
      browserAvailable: false,
      computerAvailable: true,
      computerPowerAvailable: false,
      companionOnline: false,
      budgetProfile: "free",
      policy: { mode: "paused" },
    },
    capabilities: [
      { runtime: "worker", available: true, bestFor: ["public example"] },
      { runtime: "kitesurf", available: false, bestFor: ["rendered public pages"] },
      { runtime: "chromium", available: false, bestFor: ["compatibility fallback"] },
      { runtime: "computer", available: true, bestFor: ["Mission files"] },
      { runtime: "workflow", available: false, bestFor: ["bounded research steps"] },
      { runtime: "companion", available: false, bestFor: ["optional signed-in sources"] },
    ],
  },
  "/api/memory/checkpoints": { checkpoints: [] },
};

function routeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function storyGraph(storyId: string): unknown {
  const record = missionRecords.find((candidate) => candidate.seed.storyIds.includes(storyId));
  if (!record || record.stories.length < 2) return null;
  return {
    nodes: record.stories.map((entry) => ({
      id: entry.story.id,
      title: entry.story.title,
      changedAt: entry.story.last_changed_at,
    })),
    edges: record.stories
      .filter((entry) => entry.story.id !== storyId)
      .map((entry) => ({
        from: storyId,
        to: entry.story.id,
        relation: "same-mission",
        reasons: [record.mission.name],
      })),
  };
}

function showcaseApiPayload(url: URL): unknown | undefined {
  const common = commonResponses[url.pathname];
  if (common !== undefined) return common;

  const storyRoute = url.pathname.match(/^\/api\/stories\/([^/]+?)(?:\/(explain|graph))?$/);
  if (storyRoute) {
    const storyId = routeSegment(storyRoute[1] ?? "");
    const entry = storyById.get(storyId);
    if (!entry) return undefined;
    if (storyRoute[2] === "explain") {
      return {
        explanation: {
          muted: false,
          components: [{
            label: "Source coverage",
            explanation: `${entry.evidence.length} fixed public source item${entry.evidence.length === 1 ? "" : "s"} attached to this Story`,
          }],
          reasons: ["Matched an active frozen Mission", "Evidence links remain available for inspection"],
          taste: { matchedPositive: [], matchedNegative: [] },
        },
      };
    }
    if (storyRoute[2] === "graph") return { graph: storyGraph(storyId) };
    return { story: entry.story, evidence: entry.evidence };
  }

  const computerRoute = url.pathname.match(/^\/api\/missions\/([^/]+?)\/computer(?:\/(file))?$/);
  if (computerRoute) {
    const missionId = routeSegment(computerRoute[1] ?? "");
    const record = missionById.get(missionId);
    if (!record) return undefined;
    if (computerRoute[2] === "file") {
      const requestedPath = `/${String(url.searchParams.get("path") ?? "mission.md").replace(/^\/+/, "")}`;
      const content = record.seed.workspaceContent[requestedPath];
      return content === undefined ? undefined : { path: requestedPath, content };
    }
    return {
      computer: {
        syncedAt: record.seed.reviewedAt,
        fileCount: record.seed.workspaceFiles.filter((file) => !file.directory).length,
        storyCount: record.stories.length,
        evidenceCount: record.evidenceCount,
        files: record.seed.workspaceFiles,
      },
    };
  }

  const receiptRoute = url.pathname.match(/^\/api\/reasoning\/receipts\/([^/]+?)(?:\/(compare))?$/);
  if (receiptRoute) {
    const receiptId = routeSegment(receiptRoute[1] ?? "");
    const record = receiptById.get(receiptId);
    if (!record) return undefined;
    if (receiptRoute[2] === "compare") {
      return {
        comparison: {
          runCount: 1,
          providerCount: 1,
          averageAgreement: 1,
          divergentPairs: [],
          needsAdjudication: false,
          runs: [record.reasoningRun],
        },
      };
    }
    return {
      receipt: record.receipt,
      runs: [record.reasoningRun],
      markdown: "",
      bundle: {
        quality: { grade: "strong", blockers: [], recommendations: [] },
        coverage: {
          evidenceCount: record.evidenceCount,
          independentFamilyCount: record.seed.independentFamilyCount,
          echoCount: record.echoCount,
        },
      },
    };
  }
  return undefined;
}

function jsonResponse(request: Request, payload: unknown, status = 200): Response {
  return new Response(request.method === "HEAD" ? null : `${JSON.stringify(payload)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-driftglass-mode": SHOWCASE_MODE,
    },
  });
}

function frozenAssetResponse(request: Request, body: string, contentType: string): Response {
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-driftglass-mode": SHOWCASE_MODE,
    },
  });
}

function frozenIndex(source: string): string {
  return source
    .replace("<html lang=\"en\">", `<html lang="en" data-driftglass-mode="${SHOWCASE_MODE}">`)
    .replace("</head>", '    <link rel="stylesheet" href="/frozen-showcase.css" />\n  </head>')
    .replace('<div id="login" class="login-shell">', '<div id="login" class="login-shell" hidden>')
    .replace('<div id="app" class="app-shell" hidden>', '<div id="app" class="app-shell">')
    .replace(
      /(\s*<script type="module" src="\/app\.js[^\"]*"><\/script>)/,
      (appScript) => `\n    <script src="/frozen-showcase.js"></script>${appScript}`,
    )
    .replace(/\s*<script type="module" src="\/webmcp\.js[^\"]*"><\/script>/, "");
}

export function frozenShowcaseEnabled(env: Pick<Env, "PUBLIC_SHOWCASE_MODE">): boolean {
  return env.PUBLIC_SHOWCASE_MODE === SHOWCASE_MODE;
}

export async function handleFrozenShowcaseRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (!frozenShowcaseEnabled(env)) return jsonResponse(request, { ok: false, error: "Not found" }, 404);

  if (url.pathname === "/frozen-showcase.js" && ["GET", "HEAD"].includes(method)) {
    return frozenAssetResponse(request, FROZEN_SHOWCASE_SCRIPT, "text/javascript; charset=utf-8");
  }
  if (url.pathname === "/frozen-showcase.css" && ["GET", "HEAD"].includes(method)) {
    return frozenAssetResponse(request, FROZEN_SHOWCASE_STYLES, "text/css; charset=utf-8");
  }

  if (url.pathname === "/health" && ["GET", "HEAD"].includes(method)) {
    return jsonResponse(request, { ok: true, app: "Driftglass", version: "0.9.0", mode: SHOWCASE_MODE, now: FIXED_NOW });
  }

  if (url.pathname.startsWith("/api/")) {
    if (!["GET", "HEAD"].includes(method)) {
      const response = jsonResponse(request, { ok: false, error: "This public example is read-only" }, 405);
      response.headers.set("allow", "GET, HEAD");
      return response;
    }
    const payload = showcaseApiPayload(url);
    return payload === undefined
      ? jsonResponse(request, { ok: false, error: "Not found" }, 404)
      : jsonResponse(request, payload);
  }

  const hiddenPath = url.pathname.split("/").some((segment) => segment.startsWith("."));
  const privatePath = hiddenPath
    || url.pathname === "/mcp"
    || url.pathname === "/authorize"
    || url.pathname === "/.well-known/oauth-authorization-server"
    || url.pathname === "/.well-known/oauth-protected-resource"
    || url.pathname === "/.well-known/oauth-protected-resource/mcp"
    || url.pathname.startsWith("/mcp/")
    || url.pathname.startsWith("/oauth/")
    || url.pathname.startsWith("/collector/")
    || url.pathname.startsWith("/packet/")
    || url.pathname.startsWith("/corpus/")
    || url.pathname.startsWith("/feedback/")
    || url.pathname.startsWith("/share/");
  if (privatePath) return jsonResponse(request, { ok: false, error: "Not available in the public example" }, 404);

  if (!["GET", "HEAD"].includes(method)) {
    const response = jsonResponse(request, { ok: false, error: "This public example is read-only" }, 405);
    response.headers.set("allow", "GET, HEAD");
    return response;
  }

  const assetResponse = await env.ASSETS.fetch(request);
  if (url.pathname === "/showcase/" || url.pathname.startsWith("/showcase/")) return assetResponse;
  const spaPath = url.pathname === "/" || url.pathname === "/index.html" || !url.pathname.split("/").at(-1)?.includes(".");
  const htmlFallback = assetResponse.ok && assetResponse.headers.get("content-type")?.includes("text/html");
  if (!spaPath && htmlFallback) return jsonResponse(request, { ok: false, error: "Not found" }, 404);
  const frozenHtml = spaPath && htmlFallback;
  if (method === "HEAD" && frozenHtml) {
    const headers = new Headers(assetResponse.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-driftglass-mode", SHOWCASE_MODE);
    headers.delete("content-length");
    headers.delete("etag");
    return new Response(null, { status: assetResponse.status, headers });
  }
  if (!frozenHtml) {
    return assetResponse;
  }
  const headers = new Headers(assetResponse.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-driftglass-mode", SHOWCASE_MODE);
  headers.delete("content-length");
  headers.delete("etag");
  return new Response(frozenIndex(await assetResponse.text()), { status: assetResponse.status, headers });
}
