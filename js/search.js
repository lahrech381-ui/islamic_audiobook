/* =========================================================
   أدوات تطبيع عربي + بحث مرن + Archive.org API
   ========================================================= */

const ArchiveSearch = (() => {
  const FAV_KEY = "islamic_favorites_v1";

  // إزالة التشكيل وتوحيد الألف وإزالة "ال" وبعض التطبيع
  function normalizeArabic(input = "") {
    if (!input) return "";
    let s = String(input);

    // حذف التشكيل
    s = s.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "");
    // توحيد الألف
    s = s.replace(/[أإآ]/g, "ا");
    // توحيد الياء/الألف المقصورة
    s = s.replace(/[ى]/g, "ي");
    // توحيد الهمزة على الواو/الياء (اختياري)
    s = s.replace(/[ؤ]/g, "و").replace(/[ئ]/g, "ي");
    // إزالة التطويل
    s = s.replace(/ـ/g, "");
    // إزالة رموز
    s = s.replace(/[^\u0600-\u06FF0-9\s]/g, " ");
    // مسافات
    s = s.replace(/\s+/g, " ").trim();

    // حذف "ال" كبادئة لكل كلمة
    s = s.split(" ").map(w => w.startsWith("ال") && w.length > 2 ? w.slice(2) : w).join(" ");

    return s.trim();
  }

  function tokenizeQuery(q) {
    const n = normalizeArabic(q);
    if (!n) return [];
    // حذف كلمات قصيرة جداً
    return n.split(" ").map(x => x.trim()).filter(x => x && x.length >= 2);
  }

  function docHaystack(doc) {
    const title = doc?.title ?? "";
    const creator = doc?.creator ?? "";
    const subject = Array.isArray(doc?.subject) ? doc.subject.join(" ") : (doc?.subject ?? "");
    return normalizeArabic(`${title} ${creator} ${subject}`);
  }

  // شرط: النتائج يجب أن تحتوي على الأقل كلمة من كلمات البحث
  function matchAtLeastOneToken(doc, tokens) {
    if (!tokens.length) return true;
    const hay = docHaystack(doc);
    return tokens.some(t => hay.includes(t));
  }

  function buildAdvancedQuery({ type, userQueryTokens }) {
    // نبني استعلاماً مرناً: (title:(t1 t2) OR creator:(...) OR subject:(...))
    const joined = userQueryTokens.join(" ");
    const fields = `(title:(${joined}) OR creator:(${joined}) OR subject:(${joined}))`;

    if (type === "audio") {
      // نُفضّل audio
      return `(mediatype:(audio) AND ${fields})`;
    }
    if (type === "books") {
      // نصوص (غالباً الكتب)
      return `(mediatype:(texts) AND ${fields})`;
    }
    return fields;
  }

  async function advancedSearch({ type, userQuery, page = 1, rows = 12 }) {
    const tokens = tokenizeQuery(userQuery);
    if (!tokens.length) {
      return { ok: false, error: "الرجاء إدخال كلمات بحث." };
    }

    const q = buildAdvancedQuery({ type, userQueryTokens: tokens });

    const url = new URL("https://archive.org/advancedsearch.php");
    url.searchParams.set("q", q);
    url.searchParams.append("fl[]", "identifier");
    url.searchParams.append("fl[]", "title");
    url.searchParams.append("fl[]", "creator");
    url.searchParams.append("fl[]", "subject");
    url.searchParams.append("fl[]", "mediatype");
    url.searchParams.append("sort[]", "downloads desc");
    url.searchParams.set("rows", String(rows));
    url.searchParams.set("page", String(page));
    url.searchParams.set("output", "json");

    const res = await fetch(url.toString(), { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error("تعذر الاتصال بخدمة البحث.");
    const data = await res.json();

    const docs = (data?.response?.docs || [])
      .filter(d => d && d.identifier && d.title) // تجاهل الفارغ/null
      .filter(d => matchAtLeastOneToken(d, tokens)); // شرط "على الأقل كلمة"

    return {
      ok: true,
      tokens,
      q,
      docs,
      total: data?.response?.numFound ?? docs.length,
      page,
      rows
    };
  }

  async function fetchMetadata(identifier) {
    const url = `https://archive.org/metadata/${encodeURIComponent(identifier)}`;
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error("تعذر جلب بيانات العنصر.");
    return res.json();
  }

  function mp3FilesFromMetadata(meta) {
    const files = meta?.files || [];
    // تجاهل غير MP3 وتجاهل الفارغ
    return files
      .filter(f => f && f.name && typeof f.name === "string")
      .filter(f => /\.mp3$/i.test(f.name))
      .map(f => ({
        name: f.name,
        title: f.title || f.name,
        length: f.length || null
      }));
  }

  function pdfFilesFromMetadata(meta) {
    const files = meta?.files || [];
    return files
      .filter(f => f && f.name && typeof f.name === "string")
      .filter(f => /\.pdf$/i.test(f.name))
      .map(f => ({ name: f.name, title: f.title || f.name }));
  }

  function downloadUrl(identifier, fileName) {
    return `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(fileName)}`;
  }

  function itemUrl(identifier) {
    return `https://archive.org/details/${encodeURIComponent(identifier)}`;
  }

  /* ==========================
     المفضلة LocalStorage
     ========================== */
  function loadFavs() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY) || "[]"); }
    catch { return []; }
  }
  function saveFavs(list) {
    localStorage.setItem(FAV_KEY, JSON.stringify(list));
  }
  function favIdOf(f) {
    // معرف ثابت لتفادي التكرار
    if (f.type === "audioTrack") return `audio:${f.identifier}:${f.file}`;
    if (f.type === "book") return `book:${f.identifier}:${f.file}`;
    return `${f.type}:${f.identifier || ""}`;
  }
  function isFav(fav) {
    const id = favIdOf(fav);
    return loadFavs().some(x => x._id === id);
  }
  function toggleFav(fav) {
    const list = loadFavs();
    const id = favIdOf(fav);
    const idx = list.findIndex(x => x._id === id);
    if (idx >= 0) {
      list.splice(idx, 1);
      saveFavs(list);
      return { added: false };
    }
    list.unshift({ ...fav, _id: id, savedAt: Date.now() });
    saveFavs(list);
    return { added: true };
  }

  /* ==========================
     مشاركة / نسخ رابط
     ========================== */
  async function shareOrCopy({ title, url }) {
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
        return { ok: true, mode: "share" };
      }
    } catch {}
    await navigator.clipboard.writeText(url);
    return { ok: true, mode: "copy" };
  }

  return {
    normalizeArabic,
    tokenizeQuery,
    advancedSearch,
    fetchMetadata,
    mp3FilesFromMetadata,
    pdfFilesFromMetadata,
    downloadUrl,
    itemUrl,
    loadFavs,
    isFav,
    toggleFav,
    shareOrCopy
  };
})();

/* =========================================================
   صفحة الصوتيات: بحث + playlist modal + مشغل ثابت
   ========================================================= */

const AudioPage = (() => {
  let state = {
    page: 1,
    rows: 10,
    lastQuery: "",
    lastDocs: [],
    queue: [],
    queueIndex: -1,
    currentItem: null, // {identifier, title, creator}
    currentTrack: null // {file, title, url}
  };

  let audioEl;

  function qs(sel) { return document.querySelector(sel); }
  function qsa(sel) { return Array.from(document.querySelectorAll(sel)); }

  function showLoader(show) {
    const w = qs("#loaderWrap");
    if (!w) return;
    w.classList.toggle("show", !!show);
  }

  function setStatus(msg, type = "info") {
    const el = qs("#status");
    if (!el) return;
    el.innerHTML = msg ? `<div class="alert alert-${type} mb-0">${msg}</div>` : "";
  }

  function renderResults(docs, tokens) {
    const list = qs("#results");
    if (!list) return;
    list.innerHTML = "";

    if (!docs.length) {
      list.innerHTML = `<div class="cardx"><div class="cardx-body">لا توجد نتائج مطابقة. جرّب كلمات أخرى.</div></div>`;
      return;
    }

    docs.forEach(doc => {
      const subject = Array.isArray(doc.subject) ? doc.subject : (doc.subject ? [doc.subject] : []);
      const creator = doc.creator || "غير معروف";

      const el = document.createElement("article");
      el.className = "cardx result-item fade-in mb-3";
      el.innerHTML = `
        <div class="cardx-body">
          <div class="d-flex justify-content-between align-items-start gap-3">
            <div class="flex-grow-1">
              <div class="result-title">${escapeHtml(doc.title)}</div>
              <div class="small-muted">
                <span><i class="fa-solid fa-user"></i> الشيخ/المحاضر: ${escapeHtml(creator)}</span>
                <span class="mx-2">•</span>
                <a href="${ArchiveSearch.itemUrl(doc.identifier)}" target="_blank" rel="noopener">عرض في Archive.org</a>
              </div>
              <div class="mt-2">
                ${(subject.slice(0, 6)).map(s => `<span class="badge rounded-pill badge-subject">${escapeHtml(String(s))}</span>`).join("")}
              </div>
              <div class="small-muted mt-2">معايير مطابقة: ${escapeHtml(tokens.join("، "))}</div>
            </div>

            <div class="d-flex flex-column gap-2" style="min-width: 180px;">
              <button class="btn btn-gold w-100" data-open-playlist="${doc.identifier}" data-title="${escapeAttr(doc.title)}" data-creator="${escapeAttr(creator)}">
                <i class="fa-solid fa-list-music"></i> قائمة المقاطع
              </button>
              <button class="btn btn-outline-gold w-100" data-play-first="${doc.identifier}" data-title="${escapeAttr(doc.title)}" data-creator="${escapeAttr(creator)}">
                <i class="fa-solid fa-play"></i> تشغيل أول مقطع
              </button>
            </div>
          </div>
        </div>
      `;
      list.appendChild(el);
    });

    // events
    qsa("[data-open-playlist]").forEach(btn => {
      btn.addEventListener("click", () => openPlaylist(btn.dataset.openPlaylist, btn.dataset.title, btn.dataset.creator));
    });
    qsa("[data-play-first]").forEach(btn => {
      btn.addEventListener("click", () => playFirst(btn.dataset.playFirst, btn.dataset.title, btn.dataset.creator));
    });
  }

  function renderPagination({ page, rows, total }) {
    const el = qs("#pagination");
    if (!el) return;

    const totalPages = Math.max(1, Math.ceil(total / rows));
    const prevDisabled = page <= 1;
    const nextDisabled = page >= totalPages;

    el.innerHTML = `
      <nav aria-label="pagination">
        <ul class="pagination justify-content-center mb-0">
          <li class="page-item ${prevDisabled ? "disabled" : ""}">
            <button class="page-link" data-page="${page - 1}">السابق</button>
          </li>
          <li class="page-item disabled">
            <span class="page-link">صفحة ${page} من ${totalPages}</span>
          </li>
          <li class="page-item ${nextDisabled ? "disabled" : ""}">
            <button class="page-link" data-page="${page + 1}">التالي</button>
          </li>
        </ul>
      </nav>
    `;

    qsa("#pagination [data-page]").forEach(b => {
      b.addEventListener("click", async () => {
        const p = Number(b.dataset.page);
        if (!p || p < 1) return;
        state.page = p;
        await doSearch(state.lastQuery);
      });
    });
  }

  async function doSearch(query) {
    state.lastQuery = query;
    setStatus("");
    showLoader(true);

    try {
      const res = await ArchiveSearch.advancedSearch({
        type: "audio",
        userQuery: query,
        page: state.page,
        rows: state.rows
      });

      if (!res.ok) {
        setStatus(res.error, "warning");
        return;
      }
      state.lastDocs = res.docs;
      renderResults(res.docs, res.tokens);
      renderPagination({ page: res.page, rows: res.rows, total: res.total });

    } catch (e) {
      setStatus("حدث خطأ أثناء البحث. حاول لاحقاً.", "danger");
    } finally {
      showLoader(false);
    }
  }

  async function openPlaylist(identifier, title, creator) {
    setStatus("");
    showLoader(true);
    try {
      const meta = await ArchiveSearch.fetchMetadata(identifier);
      const tracks = ArchiveSearch.mp3FilesFromMetadata(meta);
      if (!tracks.length) {
        setStatus("لا توجد ملفات MP3 قابلة للتشغيل في هذا العنصر.", "warning");
        return;
      }

      state.queue = tracks.map(t => ({
        identifier,
        itemTitle: title,
        creator,
        file: t.name,
        title: t.title || t.name,
        url: ArchiveSearch.downloadUrl(identifier, t.name)
      }));
      state.queueIndex = 0;
      state.currentItem = { identifier, title, creator };

      // fill modal
      const modalBody = qs("#playlistBody");
      modalBody.innerHTML = state.queue.map((t, idx) => {
        const favObj = favPayloadFromTrack(t);
        const favActive = ArchiveSearch.isFav(favObj);
        return `
          <div class="d-flex align-items-center justify-content-between gap-2 py-2 border-bottom" dir="rtl">
            <div class="text-truncate">
              <div class="fw-bold text-truncate">${escapeHtml(t.title)}</div>
              <div class="small-muted text-truncate">${escapeHtml(creator)} • <a href="${ArchiveSearch.itemUrl(identifier)}" target="_blank" rel="noopener">المصدر</a></div>
            </div>
            <div class="d-flex gap-2 flex-shrink-0">
              <button class="btn btn-sm btn-gold" data-play-track="${idx}"><i class="fa-solid fa-play"></i></button>
              <a class="btn btn-sm btn-outline-gold" href="${t.url}" download><i class="fa-solid fa-download"></i></a>
              <button class="btn btn-sm btn-outline-gold" data-fav-track="${idx}" title="مفضلة">
                <i class="fa-solid fa-heart ${favActive ? "" : ""}" style="color:${favActive ? "#ff6b6b" : "inherit"}"></i>
              </button>
            </div>
          </div>
        `;
      }).join("");

      // attach
      qsa("[data-play-track]").forEach(b => b.addEventListener("click", () => {
        const idx = Number(b.dataset.playTrack);
        playQueueIndex(idx);
      }));
      qsa("[data-fav-track]").forEach(b => b.addEventListener("click", () => {
        const idx = Number(b.dataset.favTrack);
        const t = state.queue[idx];
        const fav = favPayloadFromTrack(t);
        ArchiveSearch.toggleFav(fav);
        // تحديث سريع: إعادة فتح القائمة (بسيط)
        openPlaylist(identifier, title, creator);
      }));

      const modal = bootstrap.Modal.getOrCreateInstance(qs("#playlistModal"));
      modal.show();
    } catch {
      setStatus("تعذر جلب قائمة التشغيل.", "danger");
    } finally {
      showLoader(false);
    }
  }

  async function playFirst(identifier, title, creator) {
    await openPlaylist(identifier, title, creator);
    playQueueIndex(0);
  }

  function favPayloadFromTrack(t) {
    return {
      type: "audioTrack",
      identifier: t.identifier,
      file: t.file,
      title: t.title,
      itemTitle: t.itemTitle,
      creator: t.creator,
      url: t.url
    };
  }

  function ensurePlayer() {
    audioEl = qs("#audioEl");
    if (!audioEl) return;

    audioEl.addEventListener("ended", () => nextTrack());
  }

  function updatePlayerUI() {
    const bar = qs("#playerBar");
    if (!bar) return;

    const title = qs("#playerTitle");
    const sub = qs("#playerSub");
    const favBtn = qs("#btnFav");

    const ct = state.currentTrack;
    if (!ct) {
      bar.classList.remove("show");
      return;
    }

    bar.classList.add("show");
    title.textContent = ct.title || "تشغيل";
    sub.textContent = `${state.currentItem?.creator || ""} • ${state.currentItem?.title || ""}`.trim();

    // fav
    const favActive = ArchiveSearch.isFav(favPayloadFromTrack(ct));
    favBtn.classList.toggle("active-fav", favActive);
  }

  function playQueueIndex(idx) {
    if (!state.queue.length) return;
    if (idx < 0 || idx >= state.queue.length) return;

    state.queueIndex = idx;
    const t = state.queue[idx];
    state.currentTrack = t;

    audioEl.src = t.url;
    audioEl.play().catch(() => {});
    updatePlayerUI();
  }

  function nextTrack() {
    if (!state.queue.length) return;
    const next = Math.min(state.queueIndex + 1, state.queue.length - 1);
    playQueueIndex(next);
  }

  function prevTrack() {
    if (!state.queue.length) return;
    const prev = Math.max(state.queueIndex - 1, 0);
    playQueueIndex(prev);
  }

  function bindPlayerControls() {
    const playBtn = qs("#btnPlay");
    const nextBtn = qs("#btnNext");
    const prevBtn = qs("#btnPrev");
    const vol = qs("#volRange");
    const favBtn = qs("#btnFav");
    const dlBtn = qs("#btnDownload");
    const shBtn = qs("#btnShare");
    const favModalBtn = qs("#btnFavModal");

    if (playBtn) playBtn.addEventListener("click", () => {
      if (!audioEl) return;
      if (audioEl.paused) audioEl.play().catch(()=>{});
      else audioEl.pause();
    });
    if (nextBtn) nextBtn.addEventListener("click", nextTrack);
    if (prevBtn) prevBtn.addEventListener("click", prevTrack);

    if (vol) {
      vol.addEventListener("input", () => {
        if (!audioEl) return;
        audioEl.volume = Number(vol.value);
      });
    }

    if (favBtn) favBtn.addEventListener("click", () => {
      const ct = state.currentTrack;
      if (!ct) return;
      ArchiveSearch.toggleFav(favPayloadFromTrack(ct));
      updatePlayerUI();
    });

    if (dlBtn) dlBtn.addEventListener("click", () => {
      const ct = state.currentTrack;
      if (!ct) return;
      window.open(ct.url, "_blank", "noopener");
    });

    if (shBtn) shBtn.addEventListener("click", async () => {
      const ct = state.currentTrack;
      if (!ct) return;
      const result = await ArchiveSearch.shareOrCopy({ title: ct.title, url: ct.url });
      setStatus(result.mode === "copy" ? "تم نسخ رابط المقطع." : "تمت المشاركة.", "success");
      setTimeout(() => setStatus(""), 1800);
    });

    if (favModalBtn) favModalBtn.addEventListener("click", () => {
      renderFavoritesModal();
      bootstrap.Modal.getOrCreateInstance(qs("#favoritesModal")).show();
    });
  }

  function renderFavoritesModal() {
    const body = qs("#favoritesBody");
    const favs = ArchiveSearch.loadFavs().filter(f => f.type === "audioTrack");
    if (!body) return;

    if (!favs.length) {
      body.innerHTML = `<div class="small-muted">لا توجد مفضلة بعد.</div>`;
      return;
    }

    body.innerHTML = favs.map((f, idx) => `
      <div class="d-flex justify-content-between align-items-center gap-2 py-2 border-bottom">
        <div class="text-truncate">
          <div class="fw-bold text-truncate">${escapeHtml(f.title)}</div>
          <div class="small-muted text-truncate">${escapeHtml(f.creator || "")} • ${escapeHtml(f.itemTitle || "")}</div>
        </div>
        <div class="d-flex gap-2 flex-shrink-0">
          <button class="btn btn-sm btn-gold" data-play-fav="${idx}"><i class="fa-solid fa-play"></i></button>
          <button class="btn btn-sm btn-outline-gold" data-remove-fav="${idx}"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
    `).join("");

    qsa("[data-play-fav]").forEach(b => b.addEventListener("click", () => {
      const idx = Number(b.dataset.playFav);
      const fav = favs[idx];
      // إعداد queue من عنصر واحد
      state.queue = [{
        identifier: fav.identifier,
        itemTitle: fav.itemTitle,
        creator: fav.creator,
        file: fav.file,
        title: fav.title,
        url: fav.url
      }];
      state.queueIndex = 0;
      state.currentItem = { identifier: fav.identifier, title: fav.itemTitle, creator: fav.creator };
      playQueueIndex(0);
    }));

    qsa("[data-remove-fav]").forEach(b => b.addEventListener("click", () => {
      const idx = Number(b.dataset.removeFav);
      const fav = favs[idx];
      ArchiveSearch.toggleFav(fav); // toggle removes
      renderFavoritesModal();
      updatePlayerUI();
    }));
  }

  function bindSearchForm() {
    const form = qs("#searchForm");
    const input = qs("#q");
    if (!form || !input) return;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      state.page = 1;
      await doSearch(input.value);
    });

    // بحث سريع عند Enter فقط (submit). لا نُنفّذ auto search لتقليل طلبات API.
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, m => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    }[m]));
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, "&quot;");
  }

  function init() {
    if (!document.querySelector("[data-page='audio']")) return;
    ensurePlayer();
    bindPlayerControls();
    bindSearchForm();

    // اقتراح افتراضي
    const preset = document.querySelector("[data-preset]");
    if (preset) {
      preset.addEventListener("click", async () => {
        const input = qs("#q");
        input.value = preset.dataset.preset;
        state.page = 1;
        await doSearch(input.value);
      });
    }
  }

  return { init };
})();

/* =========================================================
   صفحة الكتب: بحث + تحميل PDF عند الطلب
   ========================================================= */

const BooksPage = (() => {
  let state = { page: 1, rows: 12, lastQuery: "", lastDocs: [] };

  function qs(sel){ return document.querySelector(sel); }
  function qsa(sel){ return Array.from(document.querySelectorAll(sel)); }

  function showLoader(show) {
    const w = qs("#loaderWrap");
    if (!w) return;
    w.classList.toggle("show", !!show);
  }

  function setStatus(msg, type="info"){
    const el = qs("#status");
    if (!el) return;
    el.innerHTML = msg ? `<div class="alert alert-${type} mb-0">${msg}</div>` : "";
  }

  async function doSearch(query) {
    state.lastQuery = query;
    setStatus("");
    showLoader(true);

    try {
      const res = await ArchiveSearch.advancedSearch({
        type: "books",
        userQuery: query,
        page: state.page,
        rows: state.rows
      });

      if (!res.ok) {
        setStatus(res.error, "warning");
        return;
      }
      state.lastDocs = res.docs;
      renderResults(res.docs, res.tokens);
      renderPagination({ page: res.page, rows: res.rows, total: res.total });
    } catch {
      setStatus("حدث خطأ أثناء البحث. حاول لاحقاً.", "danger");
    } finally {
      showLoader(false);
    }
  }

  function renderResults(docs, tokens) {
    const list = qs("#results");
    list.innerHTML = "";

    if (!docs.length) {
      list.innerHTML = `<div class="cardx"><div class="cardx-body">لا توجد نتائج مطابقة. جرّب كلمات أخرى.</div></div>`;
      return;
    }

    docs.forEach(doc => {
      const subject = Array.isArray(doc.subject) ? doc.subject : (doc.subject ? [doc.subject] : []);
      const creator = doc.creator || "غير معروف";

      const el = document.createElement("article");
      el.className = "cardx result-item fade-in mb-3";
      el.innerHTML = `
        <div class="cardx-body">
          <div class="d-flex justify-content-between align-items-start gap-3">
            <div class="flex-grow-1">
              <div class="result-title">${escapeHtml(doc.title)}</div>
              <div class="small-muted">
                <span><i class="fa-solid fa-pen-nib"></i> المؤلف: ${escapeHtml(creator)}</span>
                <span class="mx-2">•</span>
                <a href="${ArchiveSearch.itemUrl(doc.identifier)}" target="_blank" rel="noopener">عرض في Archive.org</a>
              </div>
              <div class="mt-2">
                ${(subject.slice(0, 6)).map(s => `<span class="badge rounded-pill badge-subject">${escapeHtml(String(s))}</span>`).join("")}
              </div>
              <div class="small-muted mt-2">معايير مطابقة: ${escapeHtml(tokens.join("، "))}</div>
            </div>

            <div class="d-flex flex-column gap-2" style="min-width: 180px;">
              <button class="btn btn-gold w-100" data-download-pdf="${doc.identifier}" data-title="${escapeAttr(doc.title)}" data-creator="${escapeAttr(creator)}">
                <i class="fa-solid fa-download"></i> تحميل PDF
              </button>
              <button class="btn btn-outline-gold w-100" data-share-item="${doc.identifier}" data-title="${escapeAttr(doc.title)}">
                <i class="fa-solid fa-share-nodes"></i> مشاركة
              </button>
            </div>
          </div>
        </div>
      `;
      list.appendChild(el);
    });

    qsa("[data-download-pdf]").forEach(btn => btn.addEventListener("click", () => downloadPdf(btn.dataset.downloadPdf, btn.dataset.title, btn.dataset.creator)));
    qsa("[data-share-item]").forEach(btn => btn.addEventListener("click", async () => {
      const url = ArchiveSearch.itemUrl(btn.dataset.shareItem);
      const r = await ArchiveSearch.shareOrCopy({ title: btn.dataset.title, url });
      setStatus(r.mode === "copy" ? "تم نسخ رابط الكتاب." : "تمت المشاركة.", "success");
      setTimeout(() => setStatus(""), 1800);
    }));
  }

  async function downloadPdf(identifier, title, creator) {
    setStatus("جاري البحث عن ملف PDF داخل العنصر...", "info");
    showLoader(true);
    try {
      const meta = await ArchiveSearch.fetchMetadata(identifier);
      const pdfs = ArchiveSearch.pdfFilesFromMetadata(meta);
      if (!pdfs.length) {
        setStatus("لم يتم العثور على ملف PDF ضمن هذا العنصر.", "warning");
        return;
      }
      // نختار أول PDF
      const file = pdfs[0].name;
      const url = ArchiveSearch.downloadUrl(identifier, file);

      // حفظ كمفضلة (كتاب)
      const fav = { type:"book", identifier, file, title, creator, url };
      // لا نجبر الحفظ، لكن يمكن تفعيل ذلك عند الحاجة:
      // ArchiveSearch.toggleFav(fav);

      window.open(url, "_blank", "noopener");
      setStatus("تم فتح رابط التحميل.", "success");
      setTimeout(() => setStatus(""), 1500);
    } catch {
      setStatus("تعذر جلب بيانات الكتاب.", "danger");
    } finally {
      showLoader(false);
    }
  }

  function renderPagination({ page, rows, total }) {
    const el = qs("#pagination");
    if (!el) return;

    const totalPages = Math.max(1, Math.ceil(total / rows));
    const prevDisabled = page <= 1;
    const nextDisabled = page >= totalPages;

    el.innerHTML = `
      <nav aria-label="pagination">
        <ul class="pagination justify-content-center mb-0">
          <li class="page-item ${prevDisabled ? "disabled" : ""}">
            <button class="page-link" data-page="${page - 1}">السابق</button>
          </li>
          <li class="page-item disabled">
            <span class="page-link">صفحة ${page} من ${totalPages}</span>
          </li>
          <li class="page-item ${nextDisabled ? "disabled" : ""}">
            <button class="page-link" data-page="${page + 1}">التالي</button>
          </li>
        </ul>
      </nav>
    `;

    qsa("#pagination [data-page]").forEach(b => {
      b.addEventListener("click", async () => {
        const p = Number(b.dataset.page);
        if (!p || p < 1) return;
        state.page = p;
        await doSearch(state.lastQuery);
      });
    });
  }

  function bindSearchForm() {
    const form = qs("#searchForm");
    const input = qs("#q");
    if (!form || !input) return;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      state.page = 1;
      await doSearch(input.value);
    });

    const preset = document.querySelector("[data-preset]");
    if (preset) {
      preset.addEventListener("click", async () => {
        input.value = preset.dataset.preset;
        state.page = 1;
        await doSearch(input.value);
      });
    }
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, m => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
    }[m]));
  }
  function escapeAttr(s){ return escapeHtml(s).replace(/"/g, "&quot;"); }

  function init() {
    if (!document.querySelector("[data-page='books']")) return;
    bindSearchForm();
  }

  return { init };
})();

document.addEventListener("DOMContentLoaded", () => {
  AudioPage.init();
  BooksPage.init();
});