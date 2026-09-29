/* Fumobooru — all behaviour runs against the static window.FUMO_DATA array.
   Nothing here touches the network or storage. */
(() => {
  "use strict";

  const { site, posts } = window.FUMO_DATA;

  const TAG_TYPES = ["character", "copyright", "artist", "general", "meta"];
  const TYPE_LABEL = {
    character: "Characters", copyright: "Copyright", artist: "Artist",
    general: "General", meta: "Meta",
  };
  const TYPE_COLOR = {
    character: "var(--tag-character)", copyright: "var(--tag-copyright)",
    artist: "var(--tag-artist)", general: "var(--tag-general)", meta: "var(--tag-meta)",
  };
  const RATING_LABEL = { s: "Safe", q: "Questionable", e: "Explicit" };

  // headroom for the pager under the grid, so filling the viewport never
  // pushes a scrollbar into view
  const PAGER_RESERVE = 56;

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // ── state ───────────────────────────────────────────────────────────
  const state = {
    terms: [],          // raw query terms, "-" prefixed for exclusion
    rating: "all",
    mode: "view",
    size: window.innerWidth < 780 ? 120 : 150, // finer grid on small screens
    showVotes: false,
    showTypes: new Set(TAG_TYPES),
    order: "id",
    votes: {},          // postId -> -1 | 0 | 1
    favs: new Set(),
    comments: {},       // postId -> [{who, when, body}]
    page: 1,
  };

  // How many previews fill the visible grid area? Derived from the real column
  // count and the space left under the grid, so a page always fills the screen
  // instead of leaving a big empty band underneath.
  function capacity() {
    const grid = $("#grid");
    const size = parseFloat(getComputedStyle(grid).getPropertyValue("--size")) || state.size;
    const cols = Math.max(1, Math.floor(grid.clientWidth / size));
    const top = grid.getBoundingClientRect().top; // relative to viewport
    const avail = window.innerHeight - top - PAGER_RESERVE;
    const rows = Math.max(1, Math.floor(avail / size));
    return cols * rows;
  }

  let perPage = 1;

  // Measure on the next frame, once scrollbars and the sidebar have settled,
  // then redraw only if the answer actually changed. Without this settle pass
  // the first read lands before layout finishes and the page comes out short.
  function reflow() {
    render();
    requestAnimationFrame(() => {
      const next = capacity();
      if (next !== perPage) {
        perPage = next;
        render();
      }
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────
  const allTags = (post) => TAG_TYPES.flatMap((t) => post.tags[t] || []);

  function tagCounts() {
    const counts = {};
    for (const p of posts) {
      for (const t of TAG_TYPES) {
        for (const tag of p.tags[t] || []) counts[tag] = (counts[tag] || 0) + 1;
      }
    }
    return counts;
  }
  const COUNTS = tagCounts();

  function typeCounts() {
    const c = {};
    for (const p of posts) for (const t of TAG_TYPES) c[t] = (c[t] || 0) + (p.tags[t] || []).length;
    return c;
  }
  const TYPE_COUNTS = typeCounts();

  // "+" is the URL-encoded space, so shared links using it must still split
  const parseTags = (raw) =>
    raw.split(/[\s+]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

  // A term matches a tag on whole underscore-segments only, so "bow" does not
  // hit "big_bow" but "reimu" does hit "reimu_hakurei".
  const termHitsTag = (term, tag) =>
    tag === term || tag.startsWith(term + "_") || term.startsWith(tag + "_");

  // Does a post satisfy every search term? Supports "x -y rating:s order:score".
  function matches(post, terms) {
    const tags = allTags(post).map((t) => t.toLowerCase());
    for (const term of terms) {
      if (term.startsWith("order:")) continue;
      if (term.startsWith("rating:")) {
        if (post.rating !== term.slice(7)) return false;
        continue;
      }
      if (term.startsWith("-")) {
        if (tags.some((t) => termHitsTag(term.slice(1), t))) return false;
      } else if (!tags.some((t) => termHitsTag(term, t))) {
        return false;
      }
    }
    return true;
  }

  function currentResults() {
    let list = posts.filter((p) => matches(p, state.terms));
    if (state.rating !== "all") list = list.filter((p) => p.rating === state.rating);

    const order = state.terms.find((t) => t.startsWith("order:"));
    const key = order ? order.slice(6) : "id";
    const score = (p) => p.score + (state.votes[p.id] || 0) * 2 + (state.favs.has(p.id) ? 3 : 0);
    list = list.slice().sort((a, b) => {
      if (key === "score") return score(b) - score(a);
      if (key === "favs") return b.favs + (state.favs.has(b.id) ? 1 : 0) - a.favs - (state.favs.has(a.id) ? 1 : 0);
      if (key === "rank") return (b.views % 97) - (a.views % 97);
      return b.id - a.id;
    });
    return list;
  }

  // ── parody toast ────────────────────────────────────────────────────
  let toastTimer;
  function toast(msg, spell) {
    const t = $("#toast");
    t.textContent = "";
    if (spell) t.appendChild(el("span", "spell", spell + " "));
    t.appendChild(document.createTextNode(msg));
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ── sidebar ─────────────────────────────────────────────────────────
  function renderStats() {
    const dl = $("#site-stats");
    dl.textContent = "";
    const rows = [
      ["Posts", site.posts.toLocaleString()],
      ["Tags", site.tags.toLocaleString()],
      ["Artists", site.artists],
      ["Uploads today", "0"],
    ];
    for (const [k, v] of rows) {
      dl.append(el("dt", null, k), el("dd", null, v));
    }
    $("#tagline").textContent = site.tagline;
  }

  function renderCategoryToggles() {
    const box = $("#category-toggles");
    box.textContent = "";
    for (const type of TAG_TYPES) {
      const label = el("label");
      const input = el("input");
      input.type = "checkbox";
      input.checked = state.showTypes.has(type);
      input.addEventListener("change", () => {
        if (input.checked) state.showTypes.add(type);
        else state.showTypes.delete(type);
        render();
      });
      const sw = el("span", "swatch");
      sw.style.background = TYPE_COLOR[type];
      label.append(input, sw, el("span", null, TYPE_LABEL[type]), el("span", "n", TYPE_COUNTS[type] || 0));
      box.appendChild(label);
    }
  }

  function renderTagList() {
    const box = $("#tag-list");
    box.textContent = "";
    const active = new Set(state.terms.filter((t) => !t.startsWith("-") && !t.includes(":")));

    for (const type of TAG_TYPES) {
      const tags = [...new Set(posts.flatMap((p) => p.tags[type] || []))]
        .filter((t) => COUNTS[t] > 0)
        .sort((a, b) => COUNTS[b] - COUNTS[a] || a.localeCompare(b));
      if (!tags.length) continue;

      const group = el("div", "tag-group");
      const h = el("h3", null, TYPE_LABEL[type]);
      h.append(el("span", "count", String(tags.length)));
      group.appendChild(h);

      const items = el("div", "tag-items");
      for (const tag of tags) {
        const a = el("a", `tag-type-${type}${active.has(tag) ? "" : " dim"}`, tag);
        a.href = "#";
        a.append(el("span", "n", String(COUNTS[tag])));
        a.addEventListener("click", (e) => { e.preventDefault(); toggleTerm(tag); });
        items.appendChild(a);
      }
      group.appendChild(items);
      box.appendChild(group);
    }
  }

  function renderActiveTags() {
    const box = $("#active-tags");
    box.textContent = "";
    for (const term of state.terms) {
      const chip = el("span", "chip");
      chip.append(el("span", null, term));
      chip.append(el("span", "x", "×"));
      chip.addEventListener("click", () => {
        state.terms = state.terms.filter((t) => t !== term);
        $("#tags").value = state.terms.join(" ");
        render();
      });
      box.appendChild(chip);
    }
    if (state.terms.length) {
      const clear = el("button", null, "Clear");
      clear.addEventListener("click", clearFilters);
      box.appendChild(clear);
    }
  }

  function toggleTerm(tag) {
    const i = state.terms.indexOf(tag);
    state.terms = i === -1 ? [...state.terms, tag] : state.terms.filter((t) => t !== tag);
    state.page = 1;
    $("#tags").value = state.terms.join(" ");
    render();
  }

  function clearFilters() {
    state.terms = [];
    state.rating = "all";
    state.page = 1;
    $("#tags").value = "";
    syncRatingButtons();
    render();
  }

  function syncRatingButtons() {
    for (const b of document.querySelectorAll("#rating-row button")) {
      b.classList.toggle("on", b.dataset.rating === state.rating);
    }
  }

  // ── gallery ─────────────────────────────────────────────────────────
  function previewNode(post) {
    const fig = el("article", `post-preview rating-${post.rating}${state.favs.has(post.id) ? " faved" : ""}`);
    fig.tabIndex = 0;
    fig.setAttribute("role", "button");
    fig.setAttribute("aria-label", `Post ${post.id}: ${allTags(post).slice(0, 3).join(", ")}`);

    if (post.type === "video") fig.append(el("span", "preview-badge", "▶ VIDEO"));
    if (state.favs.has(post.id)) fig.append(el("span", "preview-badge fav", "★ FAVED"));
    if (state.showVotes) {
      fig.append(el("span", "preview-score", `P-${post.score + (state.votes[post.id] || 0)}`));
    }

    // the grid draws the small webp; the post view still uses the full `src`
    const isVideo = post.type === "video";
    const media = el(isVideo ? "video" : "img", "post-preview-image");
    if (isVideo) {
      // poster frame means the grid never has to decode video, and
      // preload="metadata" keeps it from pulling the file down
      media.poster = post.thumb || post.src;
      media.preload = "metadata";
      media.playsInline = true;
      media.muted = true;
      media.loop = true;
      media.setAttribute("aria-label", `Video: ${allTags(post).slice(0, 3).join(", ")}`);
    } else {
      media.src = post.thumb || post.src;
      media.alt = `Fumo of ${allTags(post).filter((t) => t.includes("_")).join(", ")}`;
      media.loading = "lazy";
      media.decoding = "async";
    }
    fig.appendChild(media);

    const open = () => openPost(post.id);
    fig.addEventListener("click", open);
    fig.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
    return fig;
  }

  function render() {
    const results = currentResults();
    const total = results.length;

    const grid = $("#grid");
    grid.style.setProperty("--size", state.size + "px");

    const pages = Math.max(1, Math.ceil(total / perPage));
    state.page = Math.min(state.page, pages);
    const slice = results.slice((state.page - 1) * perPage, state.page * perPage);

    grid.textContent = "";
    for (const post of slice) {
      const cell = el("div", "post-preview-container");
      cell.appendChild(previewNode(post));
      grid.appendChild(cell);
    }

    const bar = $("#result-bar");
    bar.textContent = "";
    if (!total) {
      const empty = el("div", "empty-state");
      empty.append(el("h3", null, "No posts found"));
      empty.append(el("p", null, "The rumbling of the danmaku has stopped. Try fewer tags."));
      const b = el("button", null, "Reset filters");
      b.addEventListener("click", clearFilters);
      empty.appendChild(b);
      bar.appendChild(empty);
    } else {
      const range = `${(state.page - 1) * perPage + 1}–${Math.min(state.page * perPage, total)}`;
      bar.append(el("span", null, "Showing "), Object.assign(el("b", null, range),
        {}), el("span", null, ` of ${total} posts`));
      if (state.terms.length) bar.append(el("span", null, `· filter: ${state.terms.join(" ")}`));
    }

    const pager = $("#pager");
    pager.textContent = "";
    if (pages > 1) {
      const go = (i) => { state.page = i; render(); scrollTo(0, 0); };
      const prev = el("button", null, "← Prev");
      prev.disabled = state.page === 1;
      prev.addEventListener("click", () => go(state.page - 1));
      pager.appendChild(prev);

      // a window of pages around the current one, with first/last reachable —
      // one button per page overflows the row on narrow screens
      const W = 2;
      const nums = new Set([1, pages, state.page]);
      for (let i = state.page - W; i <= state.page + W; i++) if (i >= 1 && i <= pages) nums.add(i);
      const shown = [...nums].sort((a, b) => a - b);
      let prevNum = 0;
      for (const i of shown) {
        if (i - prevNum > 1) pager.append(el("span", "gap", "…"));
        const b = el("button", i === state.page ? "on" : null, String(i));
        b.addEventListener("click", () => go(i));
        pager.appendChild(b);
        prevNum = i;
      }

      const next = el("button", null, "Next →");
      next.disabled = state.page === pages;
      next.addEventListener("click", () => go(state.page + 1));
      pager.appendChild(next);
    }

    renderTagList();
    renderActiveTags();
    syncHash();
  }

  // ── post view ───────────────────────────────────────────────────────
  const MOCK_COMMENTS = [
    ["spell_practice", "these danmaku don't even reach the plush"],
    ["aura_user", "the hat is doing all the work here"],
    ["th10_gremlin", "post-q quality, would stack again"],
    ["bunny_cat", "bought one of these on a dare. regrets nothing."],
    ["mod_beacon", "nice framing, the shrine reads well"],
    ["ichiban_fan", "P-Items farming arc continues"],
  ];

  function commentsFor(post) {
    if (!state.comments[post.id]) {
      const n = Math.min(post.comments, MOCK_COMMENTS.length);
      state.comments[post.id] = Array.from({ length: n }, (_, i) => {
        const [who, body] = MOCK_COMMENTS[(post.id + i * 5) % MOCK_COMMENTS.length];
        return { who, body, when: `2026-0${1 + i}-1${i + 2} 0${i}:1${i}` };
      });
    }
    return state.comments[post.id];
  }

  function tagCloud(post) {
    const cloud = el("div", "tag-cloud");
    for (const type of TAG_TYPES) {
      for (const tag of post.tags[type] || []) {
        const a = el("a", `tag-type-${type}${tag === "tagme" ? " tagme" : ""}`, tag);
        a.href = "#";
        a.title = `Filter by ${tag}`;
        a.addEventListener("click", (e) => { e.preventDefault(); closePost(); toggleTerm(tag); });
        cloud.appendChild(a);
      }
    }
    return cloud;
  }

  function openPost(id) {
    const idx = currentResults().findIndex((p) => p.id === id);
    const post = posts.find((p) => p.id === id);
    if (!post) return;
    const box = $("#post-container");
    box.textContent = "";

    // header
    const head = el("header");
    head.append(el("span", "title", `Post #${post.id}`));
    head.append(el("span", "spacer"));
    const nav = el("div", "nav-btns");
    if (idx > 0) {
      const p = el("button", null, "←");
      p.title = "Previous post";
      p.addEventListener("click", () => openPost(currentResults()[idx - 1].id));
      nav.appendChild(p);
    }
    if (idx > -1 && idx < currentResults().length - 1) {
      const n = el("button", null, "→");
      n.title = "Next post";
      n.addEventListener("click", () => openPost(currentResults()[idx + 1].id));
      nav.appendChild(n);
    }
    head.appendChild(nav);
    const close = el("button", "close", "×");
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closePost);
    head.appendChild(close);
    box.appendChild(head);

    // media + sidebar
    const body = el("div", "post-body");
    const media = el("div", null, null);
    media.id = "post-media";
    if (post.type === "video") {
      const v = el("video");
      v.src = post.src; v.controls = true; v.loop = true; v.autoplay = true;
      media.appendChild(v);
    } else {
      const img = el("img");
      img.src = post.src;
      img.alt = allTags(post).join(" ");
      media.appendChild(img);
    }
    body.appendChild(media);

    const side = el("div", "post-side");

    // parody vote
    const vote = el("div", "vote-row");
    const up = el("button", "up" + (state.votes[post.id] === 1 ? " on" : ""), "▲");
    const count = el("span", "vote-count", String(post.score + (state.votes[post.id] || 0)));
    const down = el("button", "down" + (state.votes[post.id] === -1 ? " on" : ""), "▼");
    const cast = (dir) => {
      const prev = state.votes[post.id] || 0;
      state.votes[post.id] = prev === dir ? 0 : dir;
      up.classList.toggle("on", state.votes[post.id] === 1);
      down.classList.toggle("on", state.votes[post.id] === -1);
      count.textContent = String(post.score + state.votes[post.id]);
      if (state.votes[post.id] !== 0) toast("P-Item cast. It dissolves harmlessly.", "✦");
    };
    up.addEventListener("click", () => cast(1));
    down.addEventListener("click", () => cast(-1));
    vote.append(up, count, down);
    side.appendChild(vote);
    side.append(el("p", "policy-note", "P-Items are imaginary currency. Casting one changes nothing but this number."));

    // parody favourite
    const fav = el("button", "fav-btn" + (state.favs.has(post.id) ? " on" : ""),
      state.favs.has(post.id) ? "★ Fumo in the hat" : "☆ Put in the hat");
    fav.addEventListener("click", () => {
      if (state.favs.has(post.id)) { state.favs.delete(post.id); toast("Removed from the hat."); }
      else { state.favs.add(post.id); toast("Plush placed in the hat. It fits perfectly.", "🃏"); }
      fav.textContent = state.favs.has(post.id) ? "★ Fumo in the hat" : "☆ Put in the hat";
      fav.classList.toggle("on", state.favs.has(post.id));
      render();
    });
    side.appendChild(fav);

    // metadata
    const meta = el("dl", "meta-table");
    const mp = post.width * post.height;
    const mpLabel = mp >= 1e6 ? `${(mp / 1e6).toFixed(1)} megapixels` : `${Math.round(mp / 1e3)} kilopixels`;
    const rows = [
      ["File", post.fileSize],
      ["Dimensions", `${post.width} × ${post.height}`],
      ["Resolution", `${post.width} × ${post.height}`],
      ["Area", mpLabel],
      ["Format", post.type === "video" ? "MP4 (HTML5)" : "Image"],
      ["Rating", RATING_LABEL[post.rating]],
      ["Uploaded", post.date],
      ["Favs", post.favs + (state.favs.has(post.id) ? 1 : 0)],
      ["Views", post.views.toLocaleString()],
      ["Source", post.source],
    ];
    for (const [k, v] of rows) {
      meta.append(el("dt", null, k), el("dd", null, v));
    }
    side.appendChild(meta);

    // tags
    const tagSec = el("div", "side-section");
    tagSec.append(el("h3", null, "Tags"), tagCloud(post));
    side.appendChild(tagSec);

    // comments
    const comSec = el("div", "side-section");
    comSec.append(el("h3", null, `Comments (${commentsFor(post).length})`));
    const list = el("ul");
    list.id = "comment-list";
    for (const c of commentsFor(post)) {
      const li = el("li");
      const when = el("span", "when", c.when);
      const who = el("span", "who", c.who);
      const bodyText = el("div", null, c.body);
      li.append(when, who, bodyText);
      list.appendChild(li);
    }
    comSec.appendChild(list);

    const form = el("form");
    form.id = "comment-form";
    const ta = el("textarea");
    ta.placeholder = "Say something to the shrine…";
    const row = el("div", "row");
    const grow = el("div", "grow");
    grow.style.flex = "1";
    const submit = el("button", "primary", "Add comment");
    row.append(grow, submit);
    grow.appendChild(ta);
    form.append(row);
    form.append(el("p", "policy", "Comments live only in this tab. Refreshing the page forgets everything."));
    submit.addEventListener("click", (e) => {
      e.preventDefault();
      if (!ta.value.trim()) { toast("Write something first.", "…"); return; }
      commentsFor(post).push({ who: "you", body: ta.value.trim(), when: "just now" });
      ta.value = "";
      comSec.querySelector("h3").textContent = `Comments (${commentsFor(post).length})`;
      const li = el("li");
      li.append(el("span", "when", "just now"), el("span", "who", "you"), el("div", null, ta.value || ""));
      list.appendChild(li);
      toast("Comment posted. The shrine is unmoved.", "✎");
    });
    comSec.appendChild(form);
    side.appendChild(comSec);

    body.appendChild(side);
    box.appendChild(body);

    $("#post-view").hidden = false;
    document.body.style.overflow = "hidden";
    close.focus();
  }

  function closePost() {
    const v = document.querySelector("#post-media video");
    if (v) v.pause();
    $("#post-view").hidden = true;
    document.body.style.overflow = "";
  }

  // ── hash routing (so Back closes the post view) ─────────────────────
  function syncHash() {
    const q = state.terms.join(" ");
    const hash = q ? `#posts?${encodeURIComponent(q)}` : "#posts";
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }

  function readHash() {
    const h = location.hash.slice(1) || "posts";
    if (h.startsWith("post/")) {
      state.terms = [];
      openPost(Number(h.slice(5)));
      return true;
    }
    const [section, query] = h.split("?");
    if (section && section !== "posts") {
      toast(`${section[0].toUpperCase()}${section.slice(1)} is a beautiful lie. Showing posts.`, "※");
      history.replaceState(null, "", "#posts" + (query ? "?" + query : ""));
    }
    state.terms = query ? parseTags(decodeURIComponent(query)) : [];
    return false;
  }

  // the grid is sized to the viewport, so a resize changes how many previews
  // fit per page. Re-render (debounced) instead of leaving a half-empty page.
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(reflow, 150);
  });

  window.addEventListener("hashchange", () => {
    if (!readHash()) { $("#tags").value = state.terms.join(" "); render(); }
  });

  $("#post-view").addEventListener("click", (e) => { if (e.target.id === "post-view") closePost(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#post-view").hidden) closePost();
    if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
      e.preventDefault(); $("#tags").focus();
    }
  });

  // ── wiring ──────────────────────────────────────────────────────────
  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    state.terms = parseTags($("#tags").value);
    state.page = 1;
    render();
  });

  for (const b of document.querySelectorAll("#rating-row button")) {
    b.addEventListener("click", () => { state.rating = b.dataset.rating; state.page = 1; render(); });
  }

  for (const b of document.querySelectorAll("#size-picker button")) {
    b.addEventListener("click", () => {
      state.size = Number(b.dataset.size);
      for (const o of document.querySelectorAll("#size-picker button")) o.classList.toggle("on", o === b);
      perPage = capacity();
      render();
    });
  }

  $("#votes-toggle").addEventListener("click", (e) => {
    state.showVotes = !state.showVotes;
    e.target.textContent = state.showVotes ? "Hide scores" : "Show scores";
    render();
  });

  $("#mode-select").addEventListener("change", (e) => {
    state.mode = e.target.value;
    if (state.mode === "view") return;
    const labels = {
      edit: "Quick edit is a spell you have not learned. Nothing was changed.",
      "add-fav": "Bulk-favourite: every visible plush is now in the hat. (Locally.)",
      "remove-fav": "Bulk-unfavourite: the hat is empty again.",
    };
    toast(labels[state.mode]);
    if (state.mode === "add-fav") currentResults().forEach((p) => state.favs.add(p.id));
    if (state.mode === "remove-fav") state.favs.clear();
    if (state.mode === "view") return render();
    e.target.value = "view";
    render();
  });

  // theme: follow the OS by default; the navbar button overrides for this session
  const prefersLight = matchMedia("(prefers-color-scheme: light)").matches;
  const setTheme = (dark) => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    $("#theme-toggle").textContent = dark ? "☾" : "☀";
  };
  setTheme(!prefersLight);
  $("#theme-toggle").addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme !== "dark");
  });

  $("#login-btn").addEventListener("click", () =>
    toast("Login is a rumour. You are already a ghost in a shrine.", "※"));
  $("#upload-btn").addEventListener("click", () =>
    toast("Upload declined: the danmaku is too crowded today. (No server was contacted.)", "※"));

  for (const a of document.querySelectorAll(".nav-item")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const messages = {
        comments: "Comments live inside each post. Open one and speak your mind.",
        wiki: "The wiki is being written by a fox. Please check back after the festival.",
        forum: "Forum offline. The threads are tangled beyond mortal recall.",
        posts: "",
      };
      if (messages[a.dataset.section]) toast(messages[a.dataset.section]);
      for (const n of document.querySelectorAll(".nav-item")) n.classList.toggle("active", n === a);
    });
  }

  for (const a of document.querySelectorAll("#related-box a")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const kind = a.getAttribute("href").slice(1);
      if (kind === "hot") { state.terms = parseTags("order:rank"); }
      else if (kind === "popular") { state.terms = parseTags("order:favs"); }
      else if (kind === "random") { state.terms = []; state.page = 1 + Math.floor(Math.random() * 3); }
      else if (kind === "count") { toast(`${currentResults().length} posts match. That is the count.`, "Σ"); return; }
      state.page = 1;
      $("#tags").value = state.terms.join(" ");
      render();
    });
  }

  // ── self-check: the filtering contract + asset reachability ─────────
  // Runs when the page is loaded with ?selftest, or FUMO_RUN_SELFTEST is set.
  // Results land in #selftest so they can be read from a headless DOM dump.
  async function runSelfTest() {
    const out = document.createElement("pre");
    out.id = "selftest";
    out.style.cssText = "position:fixed;top:0;left:0;z-index:99;margin:0;padding:.75em;" +
                        "max-height:90vh;overflow:auto;background:#111;color:#eee;" +
                        "font:12px monospace;white-space:pre-wrap";
    document.body.appendChild(out); // overlay, so it cannot shift the layout it measures
    // the boot reflow() settles on the next frame; let that land before measuring
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    let failed = 0;
    const t = (name, cond) => {
      if (!cond) failed++;
      const line = `${cond ? "ok  " : "FAIL"} ${name}`;
      console[cond ? "log" : "error"](line);
      out.append(line + "\n");
    };

    t("dataset loads", posts.length > 0);
    t("every post has tags", posts.every((p) => allTags(p).length > 0));
    // relative paths only: the site must work from file:// and from any Vercel subpath
    const rel = (s, dir) => typeof s === "string" && s.startsWith(dir) && !s.startsWith("/");
    t("every post has a relative src", posts.every((p) => rel(p.src, "fumos/")));
    t("every post has a relative thumb", posts.every((p) => rel(p.thumb, "thumbs/")));
    t("thumbs are webp and smaller than their source", posts.every((p) =>
      p.thumb.endsWith(".webp") && (p.thumbBytes || 0) < (p.srcBytes || 0)));
    t("empty query matches everything", posts.every((p) => matches(p, [])));
    t("AND semantics: unknown term excludes", !matches(posts[0], ["definitely_not_a_real_tag_xyz"]));
    t("rating: accepts matching, rejects other", matches(posts[0], [`rating:${posts[0].rating}`]) && !matches(posts[0], ["rating:zz"]));
    t("negation excludes a present tag", posts.every((p) => !matches(p, ["-" + allTags(p)[0]])));
    t("segment matching: bow does not hit big_bow", (() => {
      const p = posts.find((x) => allTags(x).includes("big_bow"));
      if (!p) return true;
      return matches(p, ["bow"]) === false && matches(p, ["big_bow"]) === true;
    })());
    t("segment matching: prefix still hits", (() => {
      const p = posts.find((x) => allTags(x).includes("reimu_hakurei"));
      return !p || matches(p, ["reimu"]);
    })());
    t("AND semantics: unrelated term rejects the post", (() => {
      // pick a term sharing no underscore-segment prefix with anything the post has
      const related = (term, tag) => term === tag || tag.startsWith(term + "_") || term.startsWith(tag + "_");
      const global = [...new Set(posts.flatMap(allTags))];
      return posts.every((p) => {
        const mine = allTags(p);
        const unrelated = global.find((g) => !mine.some((t) => related(g, t)));
        return unrelated === undefined || matches(p, [unrelated]) === false;
      });
    })());
    t("two present terms both match", posts.every((p) => {
      const [a, b] = allTags(p);
      return matches(p, [a, b]);
    }));
    t("pagination stays in range", (() => {
      const pages = Math.max(1, Math.ceil(currentResults().length / perPage));
      return state.page >= 1 && state.page <= pages;
    })());
    t("a page fills the viewport (no empty band)", (() => {
      // the reported bug: a fixed page size left a large gap under the grid
      const grid = $("#grid");
      const size = parseFloat(getComputedStyle(grid).getPropertyValue("--size"));
      const cols = Math.max(1, Math.floor(grid.clientWidth / size));
      const rows = Math.ceil(grid.children.length / cols);
      const used = rows * size;
      const top = grid.getBoundingClientRect().top;
      const avail = window.innerHeight - top - PAGER_RESERVE;
      const total = currentResults().length;
      out.append(`  [geo] size=${size} gridW=${grid.clientWidth} cols=${cols} ` +
                 `shown=${grid.children.length} rows=${rows} top=${top.toFixed(0)} ` +
                 `avail=${avail.toFixed(0)} used=${used} vh=${window.innerHeight} ` +
                 `gap=${(window.innerHeight - top - used).toFixed(0)}` +
                 ` | iw=${window.innerWidth} body=${document.body.scrollWidth}` +
                 ` page=${$("#page").clientWidth} sb=${$("#sidebar").clientWidth}` +
                 ` content=${$("#content").clientWidth} mq780=${matchMedia("(max-width: 780px)").matches}\n`);
      // either the page is full, or we ran out of posts to show
      return total <= perPage || used >= avail - size;
    })());

    // every referenced asset actually loads (images via Image, video via a loaded <video>)
    const loadOne = (p) => new Promise((res) => {
      if (p.type === "video") {
        const v = document.createElement("video");
        v.preload = "auto";
        const done = (ok) => { v.removeAttribute("src"); v.load(); res(ok); };
        v.addEventListener("loadeddata", () => done(true), { once: true });
        v.addEventListener("error", () => done(false), { once: true });
        v.src = p.src;
      } else {
        const img = new Image();
        img.onload = () => res(true);
        img.onerror = () => res(false);
        img.src = p.src;
      }
    });
    const results = await Promise.all(posts.map(loadOne));
    const broken = posts.filter((_, i) => !results[i]).map((p) => p.src);
    t(`all ${posts.length} source assets load (${broken.length} broken)`, broken.length === 0);
    if (broken.length) out.append("  broken: " + broken.join(", ") + "\n");

    // every grid thumbnail must load too, or previews silently fall back
    const thumbResults = await Promise.all(posts.map((p) => new Promise((res) => {
      const img = new Image();
      img.onload = () => res(true);
      img.onerror = () => res(false);
      img.src = p.thumb;
    })));
    const brokenThumbs = posts.filter((_, i) => !thumbResults[i]).map((p) => p.thumb);
    t(`all ${posts.length} thumbs load (${brokenThumbs.length} broken)`, brokenThumbs.length === 0);
    if (brokenThumbs.length) out.append("  broken thumbs: " + brokenThumbs.join(", ") + "\n");

    out.append(`\n${failed ? failed + " FAILING" : "all checks passed"} (${posts.length} posts)\n`);
    document.title = failed ? `SELFTEST FAIL ${failed}` : "SELFTEST PASS";
  }

  // ── boot ────────────────────────────────────────────────────────────
  renderStats();
  renderCategoryToggles();
  readHash();
  $("#tags").value = state.terms.join(" ");
  for (const o of document.querySelectorAll("#size-picker button")) {
    o.classList.toggle("on", Number(o.dataset.size) === state.size);
  }
  perPage = capacity();
  reflow();

  // self-test runs last, so it can assert against the real rendered layout
  if (location.search.includes("selftest") || window.FUMO_RUN_SELFTEST) {
    runSelfTest();
  }
})();
