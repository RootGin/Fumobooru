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

  const FAV_KEY = "fumobooru.favs";
  function loadFavs() {
    try { return new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]")); }
    catch { return new Set(); }
  }
  const saveFavs = () => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...state.favs])); } catch {} };

  const MUTE_KEY = "fumobooru.muted";
  const loadMuted = () => { try { return localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; } };
  const saveMuted = () => { try { localStorage.setItem(MUTE_KEY, state.muted ? "1" : "0"); } catch {} };

  const SUB_KEY = "fumobooru.subscribed";
  const loadSub = () => { try { return localStorage.getItem(SUB_KEY) === "1"; } catch { return false; } };
  const saveSub = () => { try { localStorage.setItem(SUB_KEY, state.subscribed ? "1" : "0"); } catch {} };

  const PITEM_KEY = "fumobooru.pitems";
  const PITEM_START = 12;
  function loadPitems() {
    try {
      const raw = localStorage.getItem(PITEM_KEY);
      if (raw === null) return PITEM_START;
      const n = JSON.parse(raw);
      return Number.isFinite(n) ? Math.max(0, Math.min(PITEM_START, Math.trunc(n))) : PITEM_START;
    } catch { return PITEM_START; }
  }
  const savePitems = () => { try { localStorage.setItem(PITEM_KEY, JSON.stringify(state.pitems)); } catch {} };

  // ── state ───────────────────────────────────────────────────────────
  const state = {
    terms: [],          // raw query terms, "-" prefixed for exclusion
    rating: "all",
    mode: "view",
    size: window.innerWidth < 780 ? 120 : 150, // finer grid on small screens
    showVotes: false,
    showTypes: new Set(TAG_TYPES),
    order: "id",
    shuffle: false,       // random ordering, cleared by any filter change
    shuffleOrder: null,   // stable across re-renders, so the grid doesn't jump
    votes: {},          // postId -> -1 | 0 | 1
    favs: loadFavs(),
    muted: loadMuted(),
    subscribed: loadSub(),
    pitems: loadPitems(),
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

  // Fisher-Yates. Used for "Random", which shuffles the result set rather than
  // jumping to a fixed page (a fixed page of a sorted feed isn't random at all).
  function shuffled(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function tagCounts(list) {
    const counts = {};
    for (const p of list) {
      for (const t of TAG_TYPES) {
        for (const tag of p.tags[t] || []) counts[tag] = (counts[tag] || 0) + 1;
      }
    }
    return counts;
  }
  const COUNTS = tagCounts(posts);
  const ALL_TAGS = Object.keys(COUNTS).sort((a, b) => COUNTS[b] - COUNTS[a] || a.localeCompare(b));

  const TAG_TYPE = {};
  for (const p of posts) {
    for (const t of TAG_TYPES) for (const tag of p.tags[t] || []) TAG_TYPE[tag] = t;
  }

  function typeCounts() {
    const c = {};
    for (const p of posts) for (const t of TAG_TYPES) c[t] = (c[t] || 0) + (p.tags[t] || []).length;
    return c;
  }
  const TYPE_COUNTS = typeCounts();

  // ── query ───────────────────────────────────────────────────────────
  // Everything a search term can mean, behind one interface. The secret
  // vocabulary lives here too, so "is this term special?" is answered in one
  // place instead of being smeared across the gallery and the renderers.
  const Query = (() => {
    // "+" is the URL-encoded space, so shared links using it must still split
    const parse = (source) =>
      source.split(/[\s+]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

    const GLOBS = new Map();
    const globOf = (pattern) => {
      let re = GLOBS.get(pattern);
      if (!re) {
        const body = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").split("*").join(".*");
        GLOBS.set(pattern, re = new RegExp("^" + body + "$"));
      }
      return re;
    };

    // A term matches a tag on whole underscore-segments only, so "bow" does not
    // hit "big_bow" but "reimu" does hit "reimu_hakurei".
    const termHitsTag = (term, tag) =>
      term.includes("*") ? globOf(term).test(tag)
        : tag === term || tag.startsWith(term + "_") || term.startsWith(tag + "_");

    // Does a post satisfy every search term? Supports "x -y rating:s order:score fav:me".
    const match = (post, terms) => {
      const tags = allTags(post).map((t) => t.toLowerCase());
      for (const term of terms) {
        if (term.startsWith("order:")) continue;
        if (term.startsWith("rating:")) {
          if (post.rating !== term.slice(7)) return false;
          continue;
        }
        if (term === "fav:me") {
          if (!state.favs.has(post.id)) return false;
          continue;
        }
        if (term.startsWith("-")) {
          if (tags.some((t) => termHitsTag(term.slice(1), t))) return false;
        } else if (!tags.some((t) => termHitsTag(term, t))) {
          return false;
        }
      }
      return true;
    };

    const sortKey = (terms) => {
      const order = terms.find((t) => t.startsWith("order:"));
      return order ? order.slice(6) : "id";
    };

    // Terms that match nothing on their own. A search emptied by a rating
    // filter has no typo to correct, so only plain terms are considered.
    const dead = (terms) => terms.filter(
      (t) => !t.startsWith("-") && !t.includes(":") && !posts.some((p) => match(p, [t])));

    // The secret vocabulary. `explicit` needs the rating actually in force, so
    // the caller passes it: picking S after typing rating:e should get the
    // generic message, not be told the shrine is still tame.
    const secrets = (terms, rating) => ({
      baka: terms.includes("order:baka"),
      explicit: rating === "e" || (rating === "all" && terms.includes("rating:e")),
      nine: terms.includes("cirno") || terms.includes("9"),
    });

    return { parse, match, sortKey, dead, secrets };
  })();

  function currentResults() {
    let list = posts.filter((p) => Query.match(p, state.terms));
    if (state.rating !== "all") list = list.filter((p) => p.rating === state.rating);

    const key = Query.sortKey(state.terms);
    const score = (p) => p.score + (state.votes[p.id] || 0) * 2 + (state.favs.has(p.id) ? 3 : 0);
    list = list.slice().sort((a, b) => {
      if (key === "score") return score(b) - score(a);
      if (key === "favs") return b.favs + (state.favs.has(b.id) ? 1 : 0) - a.favs - (state.favs.has(a.id) ? 1 : 0);
      if (key === "rank") return (b.views % 97) - (a.views % 97);
      return b.id - a.id;
    });
    if (state.shuffle && state.shuffleOrder) {
      const rank = new Map(state.shuffleOrder.map((id, i) => [id, i]));
      list.sort((a, b) => rank.get(a.id) - rank.get(b.id));
    }
    // order:baka sorts by nothing in particular, on purpose. It reuses the
    // same held permutation as Random, so a vote or a favourite doesn't
    // reshuffle the page under you; only a fresh search deals again.
    if (Query.secrets(state.terms, state.rating).baka) {
      if (!state.shuffleOrder) state.shuffleOrder = shuffled(posts.map((p) => p.id));
      const rank = new Map(state.shuffleOrder.map((id, i) => [id, i]));
      list.sort((a, b) => rank.get(a.id) - rank.get(b.id));
    }
    return list;
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) {
        row[j] = Math.min(
          prev[j] + 1,                                   // delete
          row[j - 1] + 1,                                // insert
          prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)  // substitute
        );
      }
      prev = row;
    }
    return prev[b.length];
  }

  function didYouMean(term) {
    if (term.length < 3) return [];
    const budget = term.length > 8 ? 3 : 2;
    return ALL_TAGS
      .map((t) => [levenshtein(term, t), t])
      .filter(([d]) => d > 0 && d <= budget)
      .sort((x, y) => x[0] - y[0] || COUNTS[y[1]] - COUNTS[x[1]])
      .slice(0, 3)
      .map(([, t]) => t);
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

  function spellCard(terms) {
    const signs = terms.filter((t) => !t.startsWith("-") && !t.includes(":"));
    const [head, ...rest] = signs;
    if (!head || !rest.length) return;
    // her name is the number, and the number is her name
    const name = head === "9" ? "⑨" : human(head);
    const n = el("div", "spell-card");
    // one at a time: they all sit in the same spot, so a fast series of
    // searches would otherwise pile semi-transparent cards on top of each other
    document.querySelectorAll(".spell-card").forEach((old) => old.remove());
    n.append(el("span", "sign", name + " Sign"),
             el("span", "quote", "「" + rest.map(human).join(" × ") + "」"));
    document.body.appendChild(n);
    n.addEventListener("animationend", () => n.remove());
  }

  // ── sidebar ─────────────────────────────────────────────────────────
  // Crawlers read p/<id>.html (make-thumbs.py writes one per post) because
  // they never see the hash, so the static tags in index.html only have to
  // cover the bare site. This keeps the live DOM honest for anything reading
  // it — and for a file:// copy, where nothing is absolute at all.
  function syncSocialMeta() {
    const web = location.protocol === "http:" || location.protocol === "https:";
    // off the web there's nothing to absolutise against, and overwriting the
    // static tags with relative paths would only make them less useful
    if (!web) return;
    // the hash is never sent to a server, so og:url is the canonical page
    const url = location.origin + location.pathname;
    const id = PostView.currentId();
    const post = id === null ? null : posts.find((p) => p.id === id);
    // the mid, not src: a copied link should not preview a 2.2MB PNG
    const img = location.origin + "/" + (post ? post.mid || site.socialImage : site.socialImage);
    if (!img) return;
    const set = (sel, val) => { const n = document.querySelector(sel); if (n) n.setAttribute("content", val); };
    set('meta[property="og:url"]', url);
    set('meta[property="og:image"]', img);
    set('meta[name="twitter:image"]', img);
  }

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

  function wireTag(node, tag, before) {
    node.addEventListener("click", (e) => {
      e.preventDefault();
      if (before) before();
      if (e.altKey) toggleTerm(tag, "-");
      else toggleTerm(tag);
    });
    return node;
  }

  function minusNode(tag) {
    const m = el("span", "minus", "−");
    m.title = `Exclude ${tag}`;
    m.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleTerm(tag, "-");
    });
    return m;
  }

  function renderTagList(results) {
    const box = $("#tag-list");
    box.textContent = "";
    const active = new Set(state.terms.filter((t) => !t.startsWith("-") && !t.includes(":")));
    const counts = tagCounts(results);
    $("#tag-box-title").textContent =
      state.terms.length || state.rating !== "all" ? "Related tags" : "Tags";

    for (const type of TAG_TYPES) {
      if (!state.showTypes.has(type)) continue;
      const tags = ALL_TAGS.filter((t) => counts[t] && TAG_TYPE[t] === type)
        .sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
      if (!tags.length) continue;

      const group = el("div", "tag-group");
      const h = el("h3", null, TYPE_LABEL[type]);
      h.append(el("span", "count", String(tags.length)));
      group.appendChild(h);

      const items = el("div", "tag-items");
      for (const tag of tags) {
        const a = el("a", `tag-list-item tag-type-${type}${active.has(tag) ? "" : " dim"}`, tag);
        a.href = "#";
        a.title = `Filter by ${tag} (alt-click to exclude)`;
        a.append(el("span", "n", String(counts[tag])), minusNode(tag));
        wireTag(a, tag);
        items.appendChild(a);
      }
      group.appendChild(items);
      box.appendChild(group);
    }
    if (!box.children.length) box.append(el("p", "sidebar-note", "No tags in this list."));
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

  function toggleTerm(tag, prefix = "") {
    const term = prefix + tag;
    const i = state.terms.indexOf(term);
    state.terms = i === -1 ? [...state.terms, term] : state.terms.filter((t) => t !== term);
    state.shuffle = false;
    state.page = 1;
    $("#tags").value = state.terms.join(" ");
    render();
  }

  function clearFilters() {
    state.terms = [];
    state.rating = "all";
    state.shuffle = false;
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
    fig.dataset.postId = String(post.id);
    fig.setAttribute("role", "button");
    fig.setAttribute("aria-label", `Post ${post.id}: ${allTags(post).slice(0, 3).join(", ")}`);

    const locked = isLocked(post);
    if (locked) {
      fig.classList.add("locked");
      fig.setAttribute("aria-label", `Post ${post.id}: subscribers only`);
    }

    if (post.type === "video") fig.append(el("span", "preview-badge", "▶ VIDEO"));
    if (state.favs.has(post.id)) fig.append(el("span", "preview-badge fav", "★ FAVED"));
    if (state.showVotes) {
      fig.append(el("span", "preview-score", `P-${post.score + (state.votes[post.id] || 0)}`));
    }
    if (locked) fig.append(el("span", "preview-badge lock", "🔒 Subscribers only"));

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
    if (locked) media.style.filter = `blur(${lockBlur(post)}px)`;
    fig.appendChild(media);

    const open = () => (locked ? openCheckout(fig) : PostView.open(post.id, { history: "push", from: fig }));
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
      if (Query.secrets(state.terms, state.rating).explicit) {
        empty.append(el("h3", null, "Nothing here rates E"));
        empty.append(el("p", null, "Every post in the archive is safe or questionable. This shrine is extremely tame."));
      } else {
        empty.append(el("h3", null, "No posts found"));
        empty.append(el("p", null, "The rumbling of the danmaku has stopped. Try fewer tags."));
      }
      for (const term of Query.dead(state.terms)) {
        const near = didYouMean(term);
        if (!near.length) continue;
        const line = el("p", "dym");
        line.append("Did you mean: ");
        for (const t of near) {
          const b = el("button", "linkish", t);
          b.addEventListener("click", () => {
            state.terms = state.terms.map((x) => (x === term ? t : x));
            $("#tags").value = state.terms.join(" ");
            render();
          });
          line.append(b, " ");
        }
        empty.appendChild(line);
      }
      const b = el("button", null, "Reset filters");
      b.addEventListener("click", clearFilters);
      empty.appendChild(b);
      bar.appendChild(empty);
    } else {
      const range = `${(state.page - 1) * perPage + 1}–${Math.min(state.page * perPage, total)}`;
      bar.append(el("span", null, "Showing "), Object.assign(el("b", null, range),
        {}), el("span", null, ` of ${total} posts`));
      if (state.terms.length) bar.append(el("span", null, `· filter: ${state.terms.join(" ")}`));
      if (state.shuffle) bar.append(el("span", null, "· random order"));
      if (Query.secrets(state.terms, state.rating).baka) bar.append(el("span", null, "· nothing in particular"));
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

    renderTagList(results);
    renderActiveTags();
    syncHash();
  }

// P-Item sparks, plus the noise of one being cast: se_item00 from Touhou
  // Eiyashou, 7KB, which is what the synthesised oscillator used to stand in for.
  const pItemAudio = new Audio("p-item.wav");
  pItemAudio.preload = "auto";
  function pItemSound(up) {
    if (state.muted) return;
    try {
      pItemAudio.currentTime = 0;
      // up and down differ in pitch, the way the oscillator's two ramps did
      pItemAudio.playbackRate = up ? 1.1 : 0.9;
      pItemAudio.play().catch(() => {});
    } catch {}
  }

  function pSparks(anchor, up) {
    const box = anchor.getBoundingClientRect();
    for (let i = 0; i < 3; i++) {
      const s = el("span", "p-spark", (up ? "+" : "−"));
      const icon = el("img", "p-spark-icon");
      icon.src = "p-item.svg";
      icon.alt = "";
      s.appendChild(icon);
      s.style.left = box.left + box.width / 2 + (i - 1) * 7 + "px";
      s.style.top = box.top + box.height / 2 + "px";
      s.style.animationDelay = i * 70 + "ms";
      s.addEventListener("animationend", () => s.remove());
      document.body.appendChild(s);
    }
  }

  const LOCK_PCT = 15;
  const isLocked = (post) => !state.subscribed && scramble(post.id ^ 0x10c4) % 100 < LOCK_PCT;
  const lockBlur = (post) => 7 + (scramble(post.id ^ 0xb10b) % 9);

  const UNLOCK_AUDIO = "p-item.wav";
  const unlockAudio = new Audio(UNLOCK_AUDIO);
  unlockAudio.preload = "auto";
  function unlockSound() {
    if (state.muted) return;
    try {
      unlockAudio.currentTime = 0;
      unlockAudio.playbackRate = 1.35;
      unlockAudio.play().catch(() => {});
    } catch {}
  }

  const CONFETTI = ["✦", "◆", "●", "▲", "■"];
  function confetti(box) {
    for (let i = 0; i < 15; i++) {
      const s = el("span", "confetti", CONFETTI[i % CONFETTI.length]);
      s.style.left = box.left + box.width / 2 + (i - 7) * 9 + "px";
      s.style.top = box.top + box.height / 2 + "px";
      s.style.setProperty("--dx", (i * 41) % 130 - 65 + "px");
      s.style.animationDelay = i * 40 + "ms";
      s.addEventListener("animationend", () => s.remove());
      document.body.appendChild(s);
    }
  }

  let checkout;
  function openCheckout(anchor) {
    if (!checkout) {
      checkout = el("dialog", "checkout");
      checkout.append(
        el("h2", null, "OnlyFumos"),
        el("p", "checkout-sub", "The internet's least exclusive club."),
        el("p", "checkout-price", "$0.00/month, cancel never"),
      );
      const perks = el("ul", "checkout-perks");
      for (const perk of ["Every blurred post, unlocked at once", "Unlimited P-Items to tip with", "A terms-of-service page we did not write"]) {
        perks.append(el("li", null, perk));
      }
      const go = el("button", "checkout-go", "Subscribe");
      const never = el("button", "checkout-no", "No thanks");
      go.addEventListener("click", () => {
        const box = go.getBoundingClientRect();
        state.subscribed = true;
        saveSub();
        checkout.close();
        confetti(box);
        unlockSound();
        toast("Unlocked. Every blurred post, permanently. Nothing was charged.", "🔓");
        render();
      });
      never.addEventListener("click", () => checkout.close());
      const row = el("div", "checkout-row");
      row.append(go, never);
      checkout.append(perks, row);
      document.body.appendChild(checkout);
    }
    checkout.showModal();
    if (anchor) anchor.focus();
  }
  const MOCK_COMMENTS = [
    ["spell_practice", "these danmaku don't even reach {character}'s seam"],
    ["aura_user", "the hat is doing all the work here"],
    ["th10_gremlin", "{character} looks smug. The hat approves."],
    ["bunny_cat", "bought {character} on a dare. regrets nothing."],
    ["mod_beacon", "nice framing, {character} reads well against the shrine"],
    ["ichiban_fan", "P-Items farming arc continues"],
    ["sakuya_maid", "the {general} carries this one, not the plush"],
    ["ran_yukkuri", "{character} again, {general} again. no complaints."],
    ["yuyuko_offer", "if the {general} is this good, {character} owes you a favour"],
    ["komachi_lamp", "put {second} next to {character} and tell me that isn't a set"],
    ["plush_hoarder", "a {general} plush is a genre and this is a strong entry"],
    ["seam_stresser", "stitch count on {character} could mean business"],
    ["tag_wrangler", "unclear if this is {character} or a very committed {general}"],
    ["danmaku_dan", "{character} would never. which is exactly why it works."],
    ["shrine_clerk", "offering box was full and I'm still not {character}"],
    ["hat_apologist", "the hat stays. the hat always stays."],
    ["button_bearer", "one button, one eye, zero complaints about {general}"],
    ["ribbon_coil", "{second} and {character} in the same frame. illegal."],
    ["pocket_pal", "this {general} is doing more for {character} than I am"],
    ["plushie_purist", "no hat. finally. a clean {character}"],
    ["sew_serene", "four hours in the {general} alone. worth it for {character}"],
    ["mochi_moth", "{character} under lamp light is a whole mood"],
    ["lantern_lore", "the {general} placement is historically accurate"],
    ["glass_eye", "that eye is doing more work than {character} is"],
    ["velour_vision", "velvet reads differently in every shot of {second}"],
    ["pnpm_wraith", "third {character} this week. the arc is consistent."],
    ["thumb_tester", "{general} is crisp here, softer on {second}"],
    ["archive_archivist", "this one's going in the {general} pile. top shelf."],
    ["fiber_fiend", "{character} survived the wash. legend."],
    ["cloud_9", "the {general} and {second} combo is unfair and I support it"],
  ];

  const gcd = (a, b) => (b ? gcd(b, a % b) : a);

  const COMMENT_STEPS = Array.from({ length: MOCK_COMMENTS.length - 1 }, (_, k) => k + 1)
    .filter((s) => gcd(s, MOCK_COMMENTS.length) === 1);

  const COMMENT_GAPS = [7, 41, 190, 640, 1500, 3100, 5200, 9000, 14400, 20100];

  const scramble = (n) => {
    let h = (n ^ 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
    return (h ^ (h >>> 15)) >>> 0;
  };

  const uploadedAt = (stamp) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(stamp || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
  };

  const clockOf = (d) =>
    `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, "0")}-${`${d.getDate()}`.padStart(2, "0")}` +
    ` ${`${d.getHours()}`.padStart(2, "0")}:${`${d.getMinutes()}`.padStart(2, "0")}`;

  const human = (tag) => tag.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  function commentVars(post) {
    const chars = (post.tags.character || []).map(human);
    const gen = (post.tags.general || []).filter((t) => t !== "plush" && t !== "photo" && t !== "tagme");
    return {
      character: chars[0] || "this plush",
      second: chars[1] || "a second plush",
      general: (gen[post.id % (gen.length || 1)] || "sewing").replace(/_/g, " "),
    };
  }

  function commentsFor(post) {
    if (!state.comments[post.id]) {
      const n = Math.min(post.comments, MOCK_COMMENTS.length);
      const vars = commentVars(post);
      const h = scramble(post.id);
      const start = h % MOCK_COMMENTS.length;
      const step = COMMENT_STEPS[(h >>> 9) % COMMENT_STEPS.length];
      let at = uploadedAt(post.date);
      state.comments[post.id] = Array.from({ length: n }, (_, i) => {
        const [who, body] = MOCK_COMMENTS[(start + i * step) % MOCK_COMMENTS.length];
        if (at) at = new Date(at.getTime() + COMMENT_GAPS[scramble(post.id * 131 + i) % COMMENT_GAPS.length] * 60000);
        return {
          who,
          body: body.replace(/\{(\w+)\}/g, (m, key) => vars[key] || m),
          when: at ? clockOf(at) : "just now",
        };
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
        a.title = `Filter by ${tag} (alt-click to exclude)`;
        wireTag(a, tag, () => { PostView.hide(); writeHash(postsHash()); });
        cloud.appendChild(a);
      }
    }
    return cloud;
  }


  // ── post view ───────────────────────────────────────────────────────
  // One module owns the post-view DOM and its lifecycle. The five module-level
  // variables that used to track it (modalId, missingId, lastFocus, focusPostId,
  // pendingFocusPostId) are now one internal record, and the 264-line openPost
  // is three builders composed by open().
  const PostView = (() => {
    const view = { id: null, missing: null, focus: null, focusId: null, pendingId: null };

    const isOpen = () => view.id !== null || view.missing !== null;
    const currentId = () => view.id;

    const consumePendingFocus = () => {
      const id = view.pendingId;
      view.pendingId = null;
      return id;
    };

    function header(post, idx) {
      const head = el("header");
      head.append(el("span", "title", `Post #${post.id}`));
      head.append(el("span", "spacer"));
      const nav = el("div", "nav-btns");
      if (idx > 0) {
        const p = el("button", null, "←");
        p.title = "Previous post (Left arrow)";
        p.addEventListener("click", () => step(-1));
        nav.appendChild(p);
      }
      if (idx > -1 && idx < currentResults().length - 1) {
        const n = el("button", null, "→");
        n.title = "Next post (Right arrow)";
        n.addEventListener("click", () => step(1));
        nav.appendChild(n);
      }
      head.appendChild(nav);

      const copy = el("button", "copy-link", "🔗 Copy link");
      copy.title = "Copy a direct link to this post";
      copy.addEventListener("click", async () => {
        // On the web, hand out p/<id>.html rather than the #post/<id> hash: a
        // crawler never receives the hash, so only the stub previews the right
        // image. It redirects to the real thing, so the link still opens the post.
        const link = /^https?:$/.test(location.protocol)
          ? location.origin + location.pathname.replace(/[^/]*$/, "") + `p/${post.id}.html`
          : location.href;
        const done = () => toast("Link copied. It points straight at this post.", "🔗");
        try {
          if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(link);
            done();
          } else {
            throw new Error("clipboard unavailable");
          }
        } catch {
          // file:// and other insecure contexts have no async clipboard, and the
          // async API rejects without a user gesture in some browsers
          const ta = el("textarea", "clipboard-shim");
          ta.value = link;
          ta.setAttribute("readonly", "");
          document.body.appendChild(ta);
          ta.select();
          let ok = false;
          try { ok = document.execCommand("copy"); } catch { ok = false; }
          ta.remove();
          if (ok) done();
          else toast("Could not copy. The link is in the address bar.", "…");
        }
      });
      head.appendChild(copy);

      const closeBtn = el("button", "close", "×");
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.addEventListener("click", close);
      head.appendChild(closeBtn);
      return { head, close: closeBtn };
    }

    function media(post) {
      const main = el("div", "post-main");
      const media = el("div", null, null);
      media.id = "post-media";
      main.append(media);

      if (post.type === "video") {
        // the browser shows the poster until the video is ready, so no spinner:
        // waiting on canplay can leave one stuck on screen indefinitely
        const v = el("video");
        v.src = post.src;
        v.poster = post.thumb || "";
        v.controls = true;
        v.loop = true;
        v.autoplay = true;
        media.appendChild(v);
      } else {
        media.classList.add("loading");
        // hold the box with the cached thumbnail, then cross-fade to full size
        if (post.thumb) {
          const ph = el("img", "media-ph");
          ph.src = post.thumb;
          ph.alt = "";
          ph.setAttribute("aria-hidden", "true");
          media.appendChild(ph);
        }
        const img = el("img", "post-full");
        img.alt = allTags(post).join(" ");
        // the placeholder stays, just hidden: .post-full is out of flow, so it is
        // the only thing giving #post-media a height
        const ready = () => {
          img.classList.add("ready");
          media.classList.remove("loading");
        };
        img.addEventListener("load", ready, { once: true });
        img.addEventListener("error", ready, { once: true });
        // the mid is a 1600px webp: full enough for the 76vh post view, small
        // enough that a phone photo does not cost 2MB to open
        img.src = post.mid || post.src;
        if (img.complete) ready();
        media.appendChild(img);
      }

      // the original, for anyone who wants it. Sits under the image, not over
      // it: over a video it would cover the controls.
      const orig = el("a", "orig-link", "View original");
      orig.href = post.src;
      orig.target = "_blank";
      orig.rel = "noopener";
      orig.title = `${post.width} × ${post.height} · ${post.fileSize}`;

      if (isLocked(post)) {
        media.classList.add("locked");
        for (const node of media.children) node.style.filter = `blur(${lockBlur(post) * 1.6}px)`;
        const cover = el("div", "lock-cover");
        cover.append(el("span", "lock-cta", "🔒 Subscribers only"));
        const cta = el("button", "lock-btn", `Unlock everything — $0.00/month`);
        cta.addEventListener("click", () => openCheckout(cta));
        cover.append(cta, el("p", "lock-fine", "One payment. Every blurred post. Cancel never, because there is nothing to cancel."));
        main.append(cover);
      }

      main.append(orig);

      // horizontal swipe to move between posts
      let sx = 0, sy = 0, swiping = false;
      media.addEventListener("pointerdown", (e) => {
        if (e.target.tagName === "VIDEO") return;
        sx = e.clientX; sy = e.clientY; swiping = true;
      });
      media.addEventListener("pointerup", (e) => {
        if (!swiping) return;
        swiping = false;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.4) step(dx < 0 ? 1 : -1);
      });
      media.addEventListener("pointercancel", () => { swiping = false; });

      return main;
    }

    function side(post) {
      const side = el("div", "post-side");

      // parody vote
      const vote = el("div", "vote-row");
      const up = el("button", "up" + (state.votes[post.id] === 1 ? " on" : ""), "▲");
      const count = el("span", "vote-count", String(post.score + (state.votes[post.id] || 0)));
      const down = el("button", "down" + (state.votes[post.id] === -1 ? " on" : ""), "▼");
      const cast = (dir, from) => {
        const prev = state.votes[post.id] || 0;
        state.votes[post.id] = prev === dir ? 0 : dir;
        up.classList.toggle("on", state.votes[post.id] === 1);
        down.classList.toggle("on", state.votes[post.id] === -1);
        count.textContent = String(post.score + state.votes[post.id]);
        if (state.votes[post.id] !== 0) {
          pSparks(from, dir === 1);
          pItemSound(dir === 1);
          toast("P-Item cast. It dissolves harmlessly.", "✦");
        }
      };
      up.addEventListener("click", (e) => cast(1, e.currentTarget));
      down.addEventListener("click", (e) => cast(-1, e.currentTarget));
      vote.append(up, count, down);
      side.appendChild(vote);
      side.append(el("p", "policy-note", "P-Items are imaginary currency. Casting one changes nothing but this number."));

      const tip = el("button", "tip-btn", `🔺 Tip the fumo — ${state.pitems} P-Item${state.pitems === 1 ? "" : "s"}`);
      const spent = () => {
        tip.textContent = `🔺 Tip the fumo — ${state.pitems} P-Item${state.pitems === 1 ? "" : "s"}`;
        tip.classList.toggle("off", state.pitems <= 0);
      };
      tip.addEventListener("click", (e) => {
        if (state.pitems <= 0) {
          toast("No P-Items left. The fumo is understanding.");
          return;
        }
        state.pitems--;
        savePitems();
        spent();
        confetti(e.currentTarget);
        unlockSound();
        toast("The fumo says thank you. It does not have a mouth.", "✦");
      });
      spent();
      side.appendChild(tip);

      // parody favourite
      const fav = el("button", "fav-btn" + (state.favs.has(post.id) ? " on" : ""),
        state.favs.has(post.id) ? "★ Fumo in the hat" : "☆ Put in the hat");
      fav.addEventListener("click", () => {
        if (state.favs.has(post.id)) { state.favs.delete(post.id); toast("Removed from the hat."); }
        else { state.favs.add(post.id); toast("Plush placed in the hat. It fits perfectly.", "🃏"); }
        saveFavs();
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
        const text = ta.value.trim();
        if (!text) { toast("Write something first.", "…"); return; }
        commentsFor(post).push({ who: "you", body: text, when: "just now" });
        ta.value = "";
        comSec.querySelector("h3").textContent = `Comments (${commentsFor(post).length})`;
        const li = el("li");
        li.append(el("span", "when", "just now"), el("span", "who", "you"), el("div", null, text));
        list.appendChild(li);
        ta.focus();
        toast("Comment posted. The shrine is unmoved.", "✎");
      });
      comSec.appendChild(form);
      side.appendChild(comSec);

      return side;
    }

    // Move through the current result set. Used by the header buttons, the arrow
    // keys and swipe, so all three behave identically.
    function step(delta) {
      const list = currentResults();
      const idx = list.findIndex((p) => p.id === view.id);
      const target = list[idx + delta];
      // "replace" keeps the URL honest about which post is on screen without
      // stacking a history entry per keystroke
      if (target) open(target.id, { history: "replace" });
    }

    // Warm the next post's mid-size image so → and swipe feel instant. Only
    // forward, and only the mid: preloading both neighbours meant two full
    // sources, one of which was a 2.2MB PNG.
    function preload() {
      const list = currentResults();
      const next = list[list.findIndex((p) => p.id === view.id) + 1];
      if (!next) return;
      const warm = () => {
        const img = new Image();
        img.src = next.mid || next.src;
        if (img.decode) img.decode().catch(() => {});
      };
      // don't compete with the image currently being shown
      if (window.requestIdleCallback) requestIdleCallback(warm, { timeout: 1500 });
      else setTimeout(warm, 250);
    }

    function open(id, { history: mode = "replace", from = null } = {}) {
      const idx = currentResults().findIndex((p) => p.id === id);
      const post = posts.find((p) => p.id === id);
      // #post/999 is a real URL, so it has to answer with a real state instead of
      // silently doing nothing
      if (!post) return openMissing(id);
      // already on this post: nothing to do. A missing post has view.id === null,
      // so re-opening the same dead link still re-renders, as it always has.
      if (view.id === id) return;
      // remember the thumbnail that opened this, so focus can go back to it.
      // taken from the click target rather than activeElement, because Safari
      // does not focus an element on click
      if (view.id === null) {
        view.focus = from || document.activeElement;
        view.focusId = id;
        view.pendingId = null;
      }

      const box = $("#post-container");
      box.textContent = "";
      const { head, close } = header(post, idx);
      const body = el("div", "post-body");
      body.append(media(post), side(post));
      box.append(head, body);

      $("#post-view").hidden = false;
      document.body.style.overflow = "hidden";
      view.id = id;
      if (mode === "push") writeHash("#post/" + id, "push", { post: id });
      // keep the post marker through a replace too, so close can still tell
      // that it pushed this entry and step back through history
      else if (mode === "replace") writeHash("#post/" + id, "replace", { post: id });
      syncSocialMeta();
      preload();
      close.focus();
    }

    function openMissing(id) {
      const box = $("#post-container");
      box.textContent = "";

      const head = el("header");
      head.append(el("span", "title", `Post #${id}`), el("span", "spacer"));
      const closeBtn = el("button", "close", "×");
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.addEventListener("click", close);
      head.appendChild(closeBtn);
      box.appendChild(head);

      const empty = el("div", "empty-state");
      empty.append(el("h3", null, "This post does not exist"));
      empty.append(el("p", null,
        `Nothing in the archive answers to #${id}. It may have been deleted, or the link may have been mistyped.`));
      const back = el("button", null, "Back to posts");
      back.addEventListener("click", close);
      empty.appendChild(back);
      box.appendChild(empty);

      $("#post-view").hidden = false;
      document.body.style.overflow = "hidden";
      view.id = null;
      view.missing = id;
      // replace, not push: nothing was opened, so Back shouldn't re-land here
      writeHash("#post/" + id, "replace", { post: id });
      syncSocialMeta();
      closeBtn.focus();
    }

    // hide without touching history — used when the location change already did
    function hide() {
      const v = document.querySelector("#post-media video");
      if (v) v.pause();
      const ph = document.querySelector("#post-media .media-ph");
      if (ph) ph.remove();
      $("#post-view").hidden = true;
      document.body.style.overflow = "";
      view.id = null;
      view.missing = null;
      syncSocialMeta();
      // Hand focus back to the thumbnail that opened this. Focus it now for the
      // paths that don't re-render, and remember the post id as well: closing via
      // history.back() re-renders the grid, which detaches the node we just
      // focused, so it has to be looked up again rather than reused.
      if (view.focus && document.contains(view.focus)) view.focus.focus();
      view.pendingId = view.focusId;
      view.focus = null;
      view.focusId = null;
    }

    // Close at the user's request. If we pushed the #post entry ourselves, step
    // back through history so Back/Forward stay coherent; if we arrived on a
    // shared post link there is nothing to go back to, so just replace the URL.
    function close() {
      if (view.id === null && view.missing === null) return;
      if (history.state && history.state.post) {
        hide();
        history.back();
      } else {
        hide();
        writeHash(postsHash());
      }
    }

    return { open, hide, close, step, preload, isOpen, currentId, consumePendingFocus };
  })();


  // ── routing ─────────────────────────────────────────────────────────
  // The post view is a real URL (#post/ID) so it can be shared, bookmarked and
  // closed with Back. PostView owns what is open; this module owns the URL.
  // popstate AND hashchange both fire for one history.back(), so the sync
  // handler must be idempotent per URL or the grid re-renders twice and the
  // second render detaches whatever the first one focused
  let handledHash = null;
  const writeHash = (url, mode = "replace", state = null) => {
    handledHash = url;
    if (mode === "push") history.pushState(state, "", url);
    else history.replaceState(state, "", url);
  };
  // the first render happens before the incoming URL is read, and would
  // otherwise rewrite a shared #post/ID link to #posts before we see it
  let booting = true;

  const postsHash = () => {
    const q = state.terms.join(" ");
    return q ? `#posts?${encodeURIComponent(q)}` : "#posts";
  };

  function syncHash() {
    // an open post owns the URL; don't let a re-render clobber it
    if (PostView.isOpen() || booting) return;
    if (location.hash !== postsHash()) writeHash(postsHash());
  }

  // Single entry point for both hashchange and popstate, so Back/Forward and a
  // shared link drive exactly the same code path.
  function syncFromLocation() {
    if (location.hash === handledHash) return; // already processed this URL
    // claim it up front, before the post/ branch returns early, so a later
    // traversal back to a URL we have seen before is still handled
    handledHash = location.hash;
    const h = location.hash.slice(1) || "posts";

    if (h.startsWith("post/")) {
      const id = Number(h.slice(5));
      PostView.open(id, { history: "none" });
      return;
    }

    // any non-post URL means the view should be closed
    if (PostView.isOpen()) PostView.hide();

    const [section, query] = h.split("?");
    if (section && section !== "posts") {
      toast(`${section[0].toUpperCase()}${section.slice(1)} is a beautiful lie. Showing posts.`, "※");
      writeHash("#posts" + (query ? "?" + query : ""));
    }
    state.terms = query ? Query.parse(decodeURIComponent(query)) : [];
    state.shuffle = false;
    $("#tags").value = state.terms.join(" ");
    render();
    // render() replaced the grid, so find the same thumbnail again by post id
    const pending = PostView.consumePendingFocus();
    if (pending != null) {
      const target = document.querySelector(`.post-preview[data-post-id="${pending}"]`);
      if (target) target.focus();
    }
  }

  // the grid is sized to the viewport, so a resize changes how many previews
  // fit per page. Re-render (debounced) instead of leaving a half-empty page.
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(reflow, 150);
  });

  window.addEventListener("hashchange", syncFromLocation);
  window.addEventListener("popstate", syncFromLocation);

  $("#post-view").addEventListener("click", (e) => { if (e.target.id === "post-view") PostView.close(); });

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), ' +
                    'select:not([disabled]), textarea:not([disabled]), video[controls], ' +
                    '[tabindex]:not([tabindex="-1"])';

  // The post view is aria-modal, so Tab has to stay inside it and arrow keys
  // should walk posts. One listener for the whole overlay; the contents are
  // rebuilt on every navigation.
  $("#post-view").addEventListener("keydown", (e) => {
    if (!PostView.isOpen()) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);

    if (e.key === "ArrowLeft" && !typing) { e.preventDefault(); PostView.step(-1); return; }
    if (e.key === "ArrowRight" && !typing) { e.preventDefault(); PostView.step(1); return; }

    if (e.key !== "Tab") return;
    const items = [...$("#post-container").querySelectorAll(FOCUSABLE)]
      .filter((n) => n.offsetWidth || n.offsetHeight || n.getClientRects().length);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !$("#post-container").contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#post-view").hidden) PostView.close();
    if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
      e.preventDefault(); $("#tags").focus(); renderSuggest();
    }
  });

  // ── wiring ──────────────────────────────────────────────────────────
  function commitSearch() {
    state.terms = Query.parse($("#tags").value);
    state.shuffle = false;
    state.page = 1;
    const { baka, nine } = Query.secrets(state.terms, state.rating);
    // a new search deals a new hand, even if the terms are identical
    if (baka) state.shuffleOrder = shuffled(posts.map((p) => p.id));
    render();
    spellCard(state.terms);
    if (nine) toast("Nine. She approves of your searching.", "⑨");
  }
  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    closeSuggest();
    commitSearch();
  });

  const $tags = $("#tags");
  let suggest = [];
  let suggestAt = -1;

  function lastToken() {
    const v = $tags.value;
    const i = v.search(/\S+$/);
    return i === -1 ? { word: "", at: v.length } : { word: v.slice(i).toLowerCase(), at: i };
  }

  function paintSuggest() {
    [...$("#tag-suggest").children].forEach((row, i) => row.classList.toggle("on", i === suggestAt));
    $tags.setAttribute("aria-activedescendant", suggestAt === -1 ? "" : "sug-" + suggestAt);
  }

  function closeSuggest() {
    suggest = [];
    suggestAt = -1;
    $("#tag-suggest").hidden = true;
    $("#tag-suggest").textContent = "";
    $tags.setAttribute("aria-expanded", "false");
  }

  function renderSuggest() {
    const { word } = lastToken();
    const bare = word.replace(/^-/, "");
    suggest = bare.length < 2 ? []
      : ALL_TAGS.filter((t) => t.includes(bare)).slice(0, 12);
    suggestAt = suggest.length ? 0 : -1;

    const box = $("#tag-suggest");
    box.textContent = "";
    box.hidden = !suggest.length;
    $tags.setAttribute("aria-expanded", String(!!suggest.length));
    for (const [i, tag] of suggest.entries()) {
      const row = el("li", "suggest-row");
      row.id = "sug-" + i;
      row.setAttribute("role", "option");
      row.append(el("span", "sw", tag), el("span", "n", String(COUNTS[tag])), minusNode(tag));
      row.addEventListener("mousedown", (e) => e.preventDefault());
      wireTag(row, tag);
      box.appendChild(row);
    }
    paintSuggest();
  }

  function pickSuggest(i) {
    const tag = suggest[i];
    if (!tag) return;
    const { word, at } = lastToken();
    $tags.value = $tags.value.slice(0, at) + (word.startsWith("-") ? "-" : "") + tag + " ";
    closeSuggest();
    commitSearch();
    $tags.focus();
  }

  $tags.addEventListener("input", renderSuggest);
  $tags.addEventListener("click", renderSuggest);
  $tags.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!suggest.length) return;
      e.preventDefault();
      suggestAt = (suggestAt + (e.key === "ArrowDown" ? 1 : suggest.length - 1)) % suggest.length;
      paintSuggest();
    } else if ((e.key === "Enter" || e.key === "Tab") && suggest.length) {
      e.preventDefault();
      pickSuggest(suggestAt);
    } else if (e.key === "Escape") {
      closeSuggest();
    }
  });
  $("#search-form").addEventListener("focusout", (e) => {
    if (!$("#search-form").contains(e.relatedTarget)) closeSuggest();
  });

  for (const b of document.querySelectorAll("#rating-row button")) {
    b.addEventListener("click", () => {
      state.rating = b.dataset.rating;
      state.shuffle = false;
      state.page = 1;
      render();
    });
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
    const n = currentResults().length;
    const labels = {
      edit: "Quick edit is a spell you have not learned. Nothing was changed.",
      "add-fav": `Bulk-favourite: all ${n} matching posts are in the hat, not just this page. (Locally.)`,
      "remove-fav": `Bulk-unfavourite: the hat is empty again. (All ${n} matching posts, in case that mattered.)`,
    };
    toast(labels[state.mode]);
    if (state.mode === "add-fav") currentResults().forEach((p) => state.favs.add(p.id));
    if (state.mode === "remove-fav") state.favs.clear();
    saveFavs();
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

  // Paint and persist are separate: the button shows the stored preference, but
  // nothing is written until it is actually pressed.
  const paintMute = () => {
    const b = $("#sound-toggle");
    b.textContent = state.muted ? "🔇" : "🔊";
    b.title = state.muted ? "Unmute P-Item sounds" : "Mute P-Item sounds";
    b.setAttribute("aria-pressed", String(state.muted));
  };
  paintMute();
  $("#sound-toggle").addEventListener("click", () => {
    state.muted = !state.muted;
    paintMute();
    saveMuted();
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
      if (kind === "hot") { state.terms = Query.parse("order:rank"); state.shuffle = false; }
      else if (kind === "popular") { state.terms = Query.parse("order:favs"); state.shuffle = false; }
      else if (kind === "random") { state.terms = []; state.shuffle = true; state.shuffleOrder = shuffled(posts.map((p) => p.id)); }
      else if (kind === "favs") { state.terms = Query.parse("fav:me"); state.shuffle = false; }
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
    // videos have no mid, and neither do the sources already smaller than one
    t("every mid is a relative path", posts.every((p) => p.mid === undefined || rel(p.mid, "mids/")));
    t("a post never views more bytes than its original", posts.every((p) =>
      p.mid === undefined || p.midBytes < p.srcBytes));

    // sharing contract: a link encodes tags or a post id, never the page, so it
    // still means the same thing on a phone as on a desktop
    t("share URL carries tags only, never the page",
      /^#posts(\?[^#]*)?$/.test(postsHash()) && !/[?&]page=/.test(postsHash()));
    t("post URL carries only an id", /^#post\/\d+$/.test("#post/901001"));

    // social crawlers read index.html without running JS, so these must exist
    // in the static markup and be absolute
    t("og:image is absolute", /^https?:\/\//.test(
      (document.querySelector('meta[property="og:image"]') || {}).content || ""));
    t("twitter:image is absolute", /^https?:\/\//.test(
      (document.querySelector('meta[name="twitter:image"]') || {}).content || ""));
    t("og:title and og:description present",
      !!(document.querySelector('meta[property="og:title"]') || {}).content &&
      !!(document.querySelector('meta[property="og:description"]') || {}).content);
    t("thumbs are webp and smaller than their source", posts.every((p) =>
      p.thumb.endsWith(".webp") && (p.thumbBytes || 0) < (p.srcBytes || 0)));
    t("empty query matches everything", posts.every((p) => Query.match(p, [])));
    t("AND semantics: unknown term excludes", !Query.match(posts[0], ["definitely_not_a_real_tag_xyz"]));
    t("rating: accepts matching, rejects other", Query.match(posts[0], [`rating:${posts[0].rating}`]) && !Query.match(posts[0], ["rating:zz"]));
    t("negation excludes a present tag", posts.every((p) => !Query.match(p, ["-" + allTags(p)[0]])));
    t("segment matching: bow does not hit big_bow", (() => {
      const p = posts.find((x) => allTags(x).includes("big_bow"));
      if (!p) return true;
      return Query.match(p, ["bow"]) === false && Query.match(p, ["big_bow"]) === true;
    })());
    t("segment matching: prefix still hits", (() => {
      const p = posts.find((x) => allTags(x).includes("reimu_hakurei"));
      return !p || Query.match(p, ["reimu"]);
    })());
    t("wildcards: *_hakurei hits only hakurei", (() => {
      const isHaku = (x) => x.endsWith("_hakurei");
      const hit = posts.filter((p) => Query.match(p, ["*_hakurei"]));
      const other = posts.find((p) => !allTags(p).some(isHaku));
      return hit.length > 0 && hit.every((p) => allTags(p).some(isHaku)) &&
        (!other || !Query.match(other, ["*_hakurei"]));
    })());
    t("wildcards: negated too", (() => {
      const isHaku = (x) => x.endsWith("_hakurei");
      return posts.every((p) => !Query.match(p, ["-*_hakurei"]) || !allTags(p).some(isHaku));
    })());
    t("fav:me keeps only the hat", (() => {
      const saved = [...state.favs];
      state.favs = new Set([posts[0].id, posts[1].id]);
      const hit = posts.filter((p) => Query.match(p, ["fav:me"]));
      state.favs = new Set(saved);
      return hit.length === 2 && hit.every((p) => p.id === posts[0].id || p.id === posts[1].id);
    })());
    t("levenshtein: known distances", levenshtein("abc", "abc") === 0 && levenshtein("abc", "abd") === 1 &&
      levenshtein("abc", "ab") === 1 && levenshtein("kitten", "sitting") === 3);
    t("did you mean finds the typo'd tag", didYouMean("remiu_hakurei").includes("reimu_hakurei") &&
      !didYouMean("reimu_hakurei").includes("reimu_hakurei"));
    t("sidebar shows related tags only, with local counts", (() => {
      const all = document.querySelectorAll("#tag-list .tag-list-item").length;
      const saved = state.terms;
      state.terms = ["reimu_hakurei"];
      render();
      const narrow = [...document.querySelectorAll("#tag-list .tag-list-item")];
      const ok = narrow.length > 0 && narrow.length < all &&
        narrow.every((n) => n.classList.contains("dim") || n.textContent.startsWith("reimu_hakurei")) &&
        narrow.every((n) => posts.filter((p) => Query.match(p, ["reimu_hakurei"]))
          .some((p) => allTags(p).includes(n.firstChild.textContent)));
      state.terms = saved;
      $("#tags").value = saved.join(" ");
      render();
      return ok;
    })());
    t("a bad post id opens a not-found state, not nothing", (() => {
      const was = location.hash;
      PostView.open(999999, { history: "none" });
      const shown = !$("#post-view").hidden && /does not exist/.test($("#post-container").textContent);
      PostView.hide();
      writeHash(was || "#posts", "replace", null);
      state.terms = [];
      $("#tags").value = "";
      render();
      return shown && $("#post-view").hidden;
    })());
    t("comment templates are filled in, never left as {placeholders}", (() => {
      const bodies = posts.flatMap((p) => commentsFor(p).map((c) => c.body));
      return bodies.length > 0 && !bodies.some((b) => /\{\w+\}/.test(b));
    })());
    t("locked posts are badged and blurred, and stay that way", (() => {
      const was = state.subscribed;
      state.subscribed = false;
      const locked = posts.filter(isLocked);
      const ok = locked.length > 0 && locked.length * 4 < posts.length &&
        locked.every((p) => {
          const fig = previewNode(p);
          return fig.classList.contains("locked") &&
            !!fig.querySelector(".preview-badge.lock") &&
            /blur\(\d+px\)/.test(fig.querySelector(".post-preview-image").style.filter);
        }) &&
        posts.map((p) => isLocked(p)).join() === posts.map((p) => isLocked(p)).join();
      state.subscribed = was;
      return ok;
    })());
    t("one subscription unlocks every locked post at once", (() => {
      const was = state.subscribed;
      state.subscribed = false;
      const before = posts.filter(isLocked).length;
      state.subscribed = true;
      const after = posts.filter(isLocked).length;
      state.subscribed = was;
      return before > 0 && after === 0;
    })());
    t("the checkout quotes $0.00/month, cancel never", (() => {
      openCheckout(null);
      const text = checkout.textContent;
      checkout.close();
      return /\$0\.00\/month, cancel never/.test(text);
    })());
    t("tipping spends a P-Item, and the wallet floors at zero", (() => {
      const wasP = state.pitems, wasHash = location.hash;
      try {
        state.pitems = 2;
        PostView.open(posts[0].id, { history: "none" });
        const tip = document.querySelector(".tip-btn");
        tip.click();
        tip.click();
        tip.click();
        return state.pitems === 0 && tip.classList.contains("off");
      } finally {
        state.pitems = wasP;
        PostView.hide();
        writeHash(wasHash || "#posts", "replace", null);
        render();
      }
    })());
    t("the P-Item wallet survives storage and refuses to go negative", (() => {
      const was = state.pitems;
      try {
        state.pitems = 5;
        savePitems();
        const back = loadPitems();
        localStorage.setItem(PITEM_KEY, "-9");
        return back === 5 && loadPitems() === 0;
      } finally {
        localStorage.removeItem(PITEM_KEY);
        state.pitems = was;
      }
    })());
    t("the unlock persists, so a reload does not re-lock anything", (() => {
      const was = state.subscribed;
      try {
        state.subscribed = true;
        saveSub();
        return localStorage.getItem(SUB_KEY) === "1" && loadSub() === true;
      } finally {
        localStorage.removeItem(SUB_KEY);
        state.subscribed = was;
      }
    })());
    t("the hat survives a round trip through storage", (() => {
      const saved = [...state.favs];
      try {
        state.favs = new Set([posts[0].id]);
        saveFavs();
        const back = loadFavs();
        return back.size === 1 && back.has(posts[0].id);
      } catch {
        return false;
      } finally {
        state.favs = new Set(saved);
        saveFavs();
      }
    })());
    t("a multi-tag search declares a spell card, a single tag does not", (() => {
      const value = $("#tags").value, terms = state.terms;
      $("#tags").value = "reimu_hakurei big_bow";
      commitSearch();
      const card = document.querySelector(".spell-card");
      const said = card && /Reimu Hakurei Sign/.test(card.textContent) && /「Big Bow」/.test(card.textContent);
      const clear = () => document.querySelectorAll(".spell-card").forEach((n) => n.remove());
      clear();
      spellCard(["reimu_hakurei", "-big_bow"]);
      const withExclusion = !!document.querySelector(".spell-card");
      clear();
      spellCard(["reimu_hakurei"]);
      const solo = !!document.querySelector(".spell-card");
      clear();
      state.terms = terms;
      $("#tags").value = value;
      render();
      return !!said && !withExclusion && !solo;
    })());
    t("order:baka deals a hand, and holds it across re-renders", (() => {
      const value = $("#tags").value, terms = state.terms, order = state.shuffleOrder;
      $("#tags").value = "order:baka";
      commitSearch();
      const first = currentResults().map((p) => p.id);
      const again = currentResults().map((p) => p.id);
      const byId = [...first].sort((a, b) => b - a);
      state.terms = terms;
      state.shuffleOrder = order;
      $("#tags").value = value;
      render();
      // every post exactly once, a different order than by id, and stable
      // until the next search re-deals
      return first.length === posts.length &&
        first.join() !== byId.join() && first.join() === again.join();
    })());
    t("cirno, or 9, gets the ⑨", (() => {
      const value = $("#tags").value, terms = state.terms;
      const said = (q) => {
        // the toast keeps its text after fading out, so clear it between probes
        $("#toast").textContent = "";
        $("#tags").value = q;
        commitSearch();
        return $("#toast").textContent;
      };
      const byName = said("cirno"), byNumber = said("9"), byOther = said("reimu_hakurei");
      state.terms = terms;
      $("#tags").value = value;
      $("#toast").classList.remove("show");
      render();
      return /⑨/.test(byName) && /⑨/.test(byNumber) && !/⑨/.test(byOther);
    })());
    t("rating:e gets its own empty state, not the generic one", (() => {
      const rating = state.rating;
      state.rating = "e";
      render();
      const byButton = $("#result-bar").textContent;
      state.rating = "all";
      state.terms = ["rating:e"];
      render();
      const byTerm = $("#result-bar").textContent;
      state.terms = [];
      state.rating = rating;
      render();
      return /rates E/.test(byButton) && /rates E/.test(byTerm) &&
        !/rates E/.test($("#result-bar").textContent);
    })());
    t("a vote throws P-Item sparks and a tone, and un-voting throws none", (() => {
      const was = location.hash, terms = state.terms;
      PostView.open(posts[0].id, { history: "none" });
      const up = document.querySelector(".vote-row .up");
      up.click();
      const cast = document.querySelectorAll(".p-spark").length;
      const tone = pItemAudio.getAttribute("src") === "p-item.wav";
      const said = document.querySelectorAll(".p-spark")[0];
      const icon = said.querySelector("img.p-spark-icon");
      const loaded = icon && icon.getAttribute("src") === "p-item.svg";
      up.click();
      const uncast = document.querySelectorAll(".p-spark").length;
      document.querySelectorAll(".p-spark").forEach((n) => n.remove());
      PostView.hide();
      writeHash(was || "#posts", "replace", null);
      state.terms = terms;
      $("#tags").value = terms.join(" ");
      render();
      return cast === 3 && uncast === cast && said.textContent === "+" && loaded && tone;
    })());
    t("mute silences the tone, and the setting survives a reload", (() => {
      const was = location.hash, terms = state.terms, muted = state.muted;
      const real = HTMLMediaElement.prototype.play;
      let started = 0;
      // the only way to see whether a sound was made: count the play() calls
      HTMLMediaElement.prototype.play = function () { started++; return real.call(this); };
      try {
        PostView.open(posts[0].id, { history: "none" });
        const up = document.querySelector(".vote-row .up");
        state.muted = true;
        up.click();
        const whileMuted = started;
        state.muted = false;
        state.votes[posts[0].id] = 0; // clear it, or the next click un-votes
        up.click();
        const whileLoud = started;
        // and the button persists the choice
        state.muted = true;
        $("#sound-toggle").click();
        const offLabel = $("#sound-toggle").textContent;
        const stored = localStorage.getItem(MUTE_KEY);
        state.muted = false;
        $("#sound-toggle").click();
        const onLabel = $("#sound-toggle").textContent;
        return whileMuted === 0 && whileLoud === 1 && stored === "0" &&
          offLabel !== onLabel;
      } finally {
        HTMLMediaElement.prototype.play = real;
        state.muted = muted;
        $("#sound-toggle").textContent = state.muted ? "🔇" : "🔊";
        $("#sound-toggle").setAttribute("aria-pressed", String(state.muted));
        PostView.hide();
        writeHash(was || "#posts", "replace", null);
        state.terms = terms;
        $("#tags").value = terms.join(" ");
        render();
      }
    })());
    t("AND semantics: unrelated term rejects the post", (() => {
      // pick a term sharing no underscore-segment prefix with anything the post has
      const related = (term, tag) => term === tag || tag.startsWith(term + "_") || term.startsWith(tag + "_");
      const global = [...new Set(posts.flatMap(allTags))];
      return posts.every((p) => {
        const mine = allTags(p);
        const unrelated = global.find((g) => !mine.some((t) => related(g, t)));
        return unrelated === undefined || Query.match(p, [unrelated]) === false;
      });
    })());
    t("two present terms both match", posts.every((p) => {
      const [a, b] = allTags(p);
      return Query.match(p, [a, b]);
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

    // and the mids, since that is what the post view and the preload now read
    const mids = posts.filter((p) => p.mid);
    const midResults = await Promise.all(mids.map((p) => new Promise((res) => {
      const img = new Image();
      img.onload = () => res(true);
      img.onerror = () => res(false);
      img.src = p.mid;
    })));
    const brokenMids = mids.filter((_, i) => !midResults[i]).map((p) => p.mid);
    t(`all ${mids.length} mids load (${brokenMids.length} broken)`, brokenMids.length === 0);
    if (brokenMids.length) out.append("  broken mids: " + brokenMids.join(", ") + "\n");

    out.append(`\n${failed ? failed + " FAILING" : "all checks passed"} (${posts.length} posts)\n`);
    document.title = failed ? `SELFTEST FAIL ${failed}` : "SELFTEST PASS";
  }

  // ── boot ────────────────────────────────────────────────────────────
  renderStats();
  renderCategoryToggles();
  for (const o of document.querySelectorAll("#size-picker button")) {
    o.classList.toggle("on", Number(o.dataset.size) === state.size);
  }
  perPage = capacity();
  reflow();
  // apply the incoming URL last, so a shared #post/ID or ?tags= link is honoured
  syncFromLocation();
  booting = false;
  syncSocialMeta();

  // self-test runs last, so it can assert against the real rendered layout
  if (location.search.includes("selftest") || window.FUMO_RUN_SELFTEST) {
    runSelfTest();
  }
})();
