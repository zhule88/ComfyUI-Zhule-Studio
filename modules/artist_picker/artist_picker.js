import { app } from "../../scripts/app.js";

console.log("%c[ZhuleArtistPicker] LOADED", "color:#0f0;font-weight:bold");

const NODE_TYPE = "ZhuleArtistPicker";
const FAV_URL = "/zhule_artists/favs";
const EMBED_HEIGHT = 480;

const CSS = `
.zhule-artist-embed {
  width: 100%; height: 100%;
  background: #12151c;
  display: flex; flex-direction: column;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif;
  color: #ddd; user-select: none;
}
.zhule-artist-toolbar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px; border-bottom: 1px solid #242b38;
  flex-wrap: wrap; flex-shrink: 0;
}
.zhule-artist-search {
  flex: 1; min-width: 100px;
  padding: 6px 10px; font-size: 13px;
  background: #0b0e13; color: #e6ecf4;
  border: 1px solid #303a4a; border-radius: 6px; outline: none;
}
.zhule-artist-search:focus { border-color: #4f8ff7; }
.zhule-artist-sort {
  padding: 6px 8px; font-size: 12px;
  background: #1b202b; color: #dde4ee;
  border: 1px solid #303a4a; border-radius: 6px; outline: none; cursor: pointer;
}
.zhule-artist-favbtn {
  padding: 6px 10px; font-size: 13px; cursor: pointer;
  background: #1b202b; color: #aab4c2;
  border: 1px solid #303a4a; border-radius: 6px; line-height: 1.2;
}
.zhule-artist-favbtn.active { background: #3a2434; color: #ff7b9d; border-color: #a34a68; }
.zhule-artist-sizewrap {
  display: flex; align-items: center; gap: 4px;
}
.zhule-artist-sizebtn {
  width: 26px; height: 26px; padding: 0;
  font-size: 16px; line-height: 1;
  background: #1b202b; color: #c3cdda;
  border: 1px solid #303a4a; border-radius: 6px;
  cursor: pointer;
}
.zhule-artist-sizebtn:disabled { opacity: 0.35; cursor: not-allowed; }
.zhule-artist-sizeinput {
  width: 54px; padding: 5px 6px; font-size: 12px;
  text-align: center;
  background: #0b0e13; color: #e6ecf4;
  border: 1px solid #303a4a; border-radius: 6px; outline: none;
}
.zhule-artist-sizeinput:focus { border-color: #4f8ff7; }
.zhule-artist-sizeinput::-webkit-inner-spin-button,
.zhule-artist-sizeinput::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.zhule-artist-grid {
  flex: 1 1 0; min-height: 0; overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--card-size, 140px), 1fr));
  gap: 10px; padding: 10px;
  align-content: start;
}
.zhule-artist-card {
  background: #181d27; border: 2px solid transparent; border-radius: 10px;
  overflow: hidden; cursor: pointer; position: relative;
  display: flex; flex-direction: column;
  transition: border-color 0.12s, background 0.12s;
}
.zhule-artist-card:hover { background: #202837; border-color: #3a4a63; }
.zhule-artist-card.selected { border-color: #4f8ff7; background: #16233a; box-shadow: 0 0 0 1px #4f8ff7; }
.zhule-artist-thumb {
  width: 100%; aspect-ratio: 3 / 4; object-fit: cover;
  background: #0b0e13; display: block; flex-shrink: 0;
}
.zhule-artist-info {
  flex-shrink: 0; padding: 6px 8px;
  background: rgba(0,0,0,0.18); border-top: 1px solid rgba(255,255,255,0.05);
  display: flex; flex-direction: column; gap: 2px;
}
.zhule-artist-name {
  font-size: 13px; color: #e6ecf4; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  line-height: 1.3;
}
.zhule-artist-count { font-size: 12px; color: #8fa0b8; line-height: 1.3; }
.zhule-artist-heart {
  position: absolute; top: 6px; right: 6px;
  width: 26px; height: 26px; line-height: 24px; text-align: center;
  font-size: 14px; cursor: pointer; border-radius: 50%;
  background: rgba(0,0,0,0.55); color: #666; z-index: 5;
  border: 1px solid rgba(255,255,255,0.15);
  transition: color 0.12s, background 0.12s;
}
.zhule-artist-heart.faved { color: #ff5c8a; background: rgba(40,10,20,0.7); }
.zhule-artist-heart:hover { color: #ff5c8a; }
.zhule-artist-zoom {
  position: absolute; top: 6px; left: 6px;
  width: 26px; height: 26px; line-height: 24px; text-align: center;
  font-size: 14px; cursor: pointer; border-radius: 50%;
  background: rgba(0,0,0,0.55); color: #666; z-index: 5;
  border: 1px solid rgba(255,255,255,0.15);
  transition: color 0.12s, background 0.12s;
}
.zhule-artist-zoom:hover { color: #8fc1ff; }
.zhule-lightbox {
  position: fixed; inset: 0; z-index: 99999;
  background: rgba(8,10,14,0.92);
  display: flex; align-items: center; justify-content: center;
  cursor: zoom-out;
}
.zhule-lightbox img {
  max-width: 92vw; max-height: 92vh;
  border-radius: 8px; box-shadow: 0 8px 40px rgba(0,0,0,0.6);
  cursor: default; user-select: none;
}
.zhule-lightbox-cap {
  position: absolute; bottom: 18px; left: 0; right: 0;
  text-align: center; color: #c7d2e0; font-size: 14px;
  font-family: -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif;
}
.zhule-artist-randwrap {
  position: relative; display: flex; align-items: center;
}
.zhule-artist-randbtn {
  width: 28px; height: 28px; padding: 0;
  font-size: 15px; line-height: 1; cursor: pointer;
  background: #1b202b; color: #8fa0b8;
  border: 1px solid #303a4a; border-radius: 6px;
  transition: color 0.12s, background 0.12s, border-color 0.12s;
}
.zhule-artist-randbtn:hover { color: #e6ecf4; border-color: #4a5a73; }
.zhule-artist-randbtn.active { background: #2a4a7a; color: #fff; border-color: #4f8ff7; }
.zhule-artist-tip {
  position: absolute; bottom: calc(100% + 8px); left: 50%;
  transform: translateX(-50%);
  background: #0b0e13; color: #dde4ee;
  border: 1px solid #303a4a; border-radius: 6px;
  padding: 6px 10px; font-size: 12px; white-space: nowrap;
  pointer-events: none; opacity: 0; visibility: hidden;
  transition: opacity 0.12s, visibility 0.12s;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  z-index: 10;
}
.zhule-artist-tip::after {
  content: ""; position: absolute; top: 100%; left: 50%;
  transform: translateX(-50%);
  border: 5px solid transparent; border-top-color: #303a4a;
}
.zhule-artist-randwrap:hover .zhule-artist-tip {
  opacity: 1; visibility: visible;
}
.zhule-artist-pager {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 8px 10px; border-top: 1px solid #242b38; flex-shrink: 0;
  flex-wrap: wrap;
}
.zhule-artist-pager button {
  padding: 5px 10px; font-size: 12px; cursor: pointer;
  background: #1b202b; color: #c3cdda;
  border: 1px solid #303a4a; border-radius: 6px; line-height: 1.2;
}
.zhule-artist-pager button:disabled { opacity: 0.35; cursor: not-allowed; }
.zhule-artist-pager button.active { background: #2a4a7a; color: #fff; border-color: #4f8ff7; }
.zhule-artist-pageinfo { color: #7d8aa0; font-size: 12px; min-width: 80px; text-align: center; }
.zhule-artist-selectedbar {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border-top: 1px solid #242b38; flex-shrink: 0;
  background: #10141b;
}
.zhule-artist-selectedinfo {
  flex: 1; font-size: 12px; color: #9fd0ff;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.zhule-artist-clear {
  padding: 5px 10px; font-size: 12px; cursor: pointer;
  background: #3a2222; color: #ffb3b3;
  border: 1px solid #6a3434; border-radius: 6px; line-height: 1.2;
}
.zhule-artist-clear:hover { background: #523030; }
.zhule-artist-empty {
  grid-column: 1 / -1; text-align: center; color: #77829a;
  padding: 40px 16px; font-size: 13px;
}
`;

let cssInjected = false;
function ensureStyles() {
  if (cssInjected) return;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  cssInjected = true;
}

function fmtCount(n) {
  n = Number(n) || 0;
  if (n >= 1000) return Math.round(n / 1000) + "k";
  return String(n);
}

async function fetchFavs() {
  try {
    const resp = await fetch(FAV_URL, { cache: "no-store" });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const arr = await resp.json();
    return Array.isArray(arr) ? arr.filter(x => typeof x === "string" && x) : [];
  } catch (e) {
    console.warn("[ZhuleArtistPicker] 读取收藏失败", e);
    return [];
  }
}

async function pushFavs(arr) {
  try {
    await fetch(FAV_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favs: arr }),
    });
  } catch (e) {
    console.warn("[ZhuleArtistPicker] 保存收藏失败", e);
  }
}

function hideWidgetCompletely(widget) {
  if (!widget) return;
  widget.hidden = true;
  widget.options ||= {};
  widget.options.hidden = true;
  widget.type = "hidden";
  widget.computeSize = () => [0, 0];
  widget.draw = () => { };
  if (widget.inputEl) {
    widget.inputEl.style.cssText += "; display:none !important; visibility:hidden; position:absolute; left:-9999px; width:0; height:0; padding:0; margin:0; border:0;";
  }
  if (widget.element) {
    widget.element.style.cssText += "; display:none !important; position:absolute; left:-9999px; width:0; height:0; padding:0; margin:0;";
  }
}

function getSelectedSlugs(node) {
  try {
    const w = node.widgets?.find(x => x.name === "_selected");
    const raw = w ? w.value : "[]";
    if (raw == null) return [];
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.filter(x => typeof x === "string" && x) : [];
  } catch (e) {
    return [];
  }
}

function setSelectedSlugs(node, slugs) {
  const w = node.widgets?.find(x => x.name === "_selected");
  if (!w) return;
  w.value = JSON.stringify(slugs);
  if (w.inputEl) w.inputEl.value = w.value;
  node.graph?.setDirtyCanvas(true, true);
}

// 随机模式：所有面板实例登记在此。Queue 前为开启随机模式的面板
// 从"当前筛选后的展示集合（state.filtered）"随机挑一个 slug 写入 _selected。
// 随机逻辑不感知任何具体筛选条件（收藏/搜索/未来的 post 等），只关心当前展示池。
const artistPanels = [];

function installQueueHook() {
  if (window.__zhuleArtistQueueWrapped) return;
  window.__zhuleArtistQueueWrapped = true;
  const origQueue = app.queuePrompt.bind(app);
  app.queuePrompt = async function (...args) {
    for (const panel of artistPanels) {
      const st = panel.state;
      if (st && st.randomMode && st.filtered && st.filtered.length) {
        const pick = st.filtered[Math.floor(Math.random() * st.filtered.length)];
        if (pick && pick.slug) {
          setSelectedSlugs(st.node, [pick.slug]);
          if (panel.api) panel.api.setSelected([pick.slug]);
        }
      }
    }
    return origQueue(...args);
  };
}

function buildPager(totalPages, current, onGo) {
  const wrap = document.createElement("div");
  wrap.className = "zhule-artist-pager";

  const mk = (label, page, opts = {}) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.disabled = !!opts.disabled;
    if (opts.active) b.classList.add("active");
    b.onclick = () => onGo(page);
    return b;
  };

  const info = document.createElement("span");
  info.className = "zhule-artist-pageinfo";
  info.textContent = `${current + 1} / ${totalPages}`;

  wrap.appendChild(mk("←", current - 1, { disabled: current <= 0 }));

  const MAX = 7;
  let pages = [];
  if (totalPages <= MAX) {
    pages = Array.from({ length: totalPages }, (_, i) => i);
  } else {
    pages.push(0);
    let lo = Math.max(1, current - 2);
    let hi = Math.min(totalPages - 2, current + 2);
    if (current <= 2) hi = 4;
    if (current >= totalPages - 3) lo = totalPages - 5;
    if (lo > 1) pages.push(-1);
    for (let i = lo; i <= hi; i++) pages.push(i);
    if (hi < totalPages - 2) pages.push(-2);
    pages.push(totalPages - 1);
  }
  for (const p of pages) {
    if (p < 0) {
      const ell = document.createElement("button");
      ell.textContent = "…";
      ell.disabled = true;
      wrap.appendChild(ell);
    } else {
      wrap.appendChild(mk(String(p + 1), p, { active: p === current }));
    }
  }

  wrap.appendChild(mk("→", current + 1, { disabled: current >= totalPages - 1 }));
  wrap.appendChild(info);
  return wrap;
}

// ==================== 内嵌面板 ====================

function buildEmbedPanel(node, container) {
  ensureStyles();

  // ---- 工具栏 ----
  const toolbar = document.createElement("div");
  toolbar.className = "zhule-artist-toolbar";

  // 随机输出开关（可 toggle，hover 显示气泡提示）
  const randWrap = document.createElement("div");
  randWrap.className = "zhule-artist-randwrap";
  const randBtn = document.createElement("button");
  randBtn.type = "button";
  randBtn.className = "zhule-artist-randbtn";
  randBtn.textContent = "🎲";
  const tip = document.createElement("div");
  tip.className = "zhule-artist-tip";
  tip.textContent = "随机输出：从符合当前筛选的画师中随机挑一个（当前筛选：收藏）";
  randWrap.appendChild(randBtn);
  randWrap.appendChild(tip);

  const search = document.createElement("input");
  search.type = "text";
  search.className = "zhule-artist-search";
  search.placeholder = "搜索画师（tag / slug）…";

  const sortSel = document.createElement("select");
  sortSel.className = "zhule-artist-sort";
  sortSel.innerHTML =
    '<option value="hot">热门</option>' +
    '<option value="name">名字</option>' +
    '<option value="random">随机</option>';

  // 图片尺寸步进控件
  const sizeWrap = document.createElement("div");
  sizeWrap.className = "zhule-artist-sizewrap";

  const minusBtn = document.createElement("button");
  minusBtn.className = "zhule-artist-sizebtn";
  minusBtn.textContent = "−";
  minusBtn.type = "button";

  const sizeInput = document.createElement("input");
  sizeInput.type = "number";
  sizeInput.className = "zhule-artist-sizeinput";
  sizeInput.min = 80;
  sizeInput.max = 300;
  sizeInput.step = 10;
  sizeInput.value = 140;

  const plusBtn = document.createElement("button");
  plusBtn.className = "zhule-artist-sizebtn";
  plusBtn.textContent = "+";
  plusBtn.type = "button";

  sizeWrap.appendChild(minusBtn);
  sizeWrap.appendChild(sizeInput);
  sizeWrap.appendChild(plusBtn);

  const favBtn = document.createElement("button");
  favBtn.className = "zhule-artist-favbtn";
  favBtn.textContent = "❤ 收藏夹";

  toolbar.appendChild(search);
  toolbar.appendChild(sortSel);
  toolbar.appendChild(randWrap);
  toolbar.appendChild(sizeWrap);
  toolbar.appendChild(favBtn);

  // ---- 网格 ----
  const grid = document.createElement("div");
  grid.className = "zhule-artist-grid";

  // ---- 已选区 ----
  const bar = document.createElement("div");
  bar.className = "zhule-artist-selectedbar";
  const info = document.createElement("div");
  info.className = "zhule-artist-selectedinfo";
  const clearBtn = document.createElement("button");
  clearBtn.className = "zhule-artist-clear";
  clearBtn.textContent = "清空";
  bar.appendChild(info);
  bar.appendChild(clearBtn);

  container.appendChild(toolbar);
  container.appendChild(grid);
  container.appendChild(bar);

  const state = {
    node,
    artists: [],
    loaded: false,
    query: "",
    sort: "hot",
    page: 0,
    pageSize: 20,
    cardSize: 140,
    onlyFav: false,
    randomMode: false,
    favs: [],
    selected: new Set(getSelectedSlugs(node)),
    filtered: [],
  };

  // ---- 根据网格尺寸计算每页数量 ----
  function computePageSize() {
    const w = grid.clientWidth - 20;   // 减去左右 padding
    const h = grid.clientHeight - 20;  // 减去上下 padding
    if (w <= 0 || h <= 0) return 1;
    const gap = 10;
    const cardH = state.cardSize * 4 / 3 + 48;  // 缩略图 + 信息区
    const cols = Math.max(1, Math.floor((w + gap) / (state.cardSize + gap)));
    const rows = Math.max(1, Math.floor((h + gap) / (cardH + gap)));
    return cols * rows;
  }

  function updatePageSize() {
    if (!state.loaded) return;
    const n = computePageSize();
    if (n > 0 && n !== state.pageSize) {
      state.pageSize = n;
      state.page = 0;
      refresh();
    }
  }

  // ---- 数据 ----
  async function load() {
    grid.innerHTML = '<div class="zhule-artist-empty">加载画师数据…</div>';
    try {
      const resp = await fetch("/zhule_artists/data");
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (!Array.isArray(data)) throw new Error("数据格式异常");
      state.artists = data.filter(a => a && typeof a.slug === "string" && a.slug);
    } catch (e) {
      console.error("[ZhuleArtistPicker] 加载画师数据失败", e);
      grid.innerHTML = '<div class="zhule-artist-empty">画师数据加载失败，请检查插件路由是否注册</div>';
      return;
    }
    state.favs = await fetchFavs();
    state.loaded = true;
    state.pageSize = computePageSize();
    refresh();
  }

  // ---- 过滤 / 排序 ----
  function computeFiltered() {
    const q = state.query.trim().toLowerCase();
    let list = state.artists;
    if (state.onlyFav) {
      const favSet = new Set(state.favs);
      list = list.filter(a => favSet.has(a.slug));
    }
    if (q) {
      list = list.filter(a =>
        (a.tag && a.tag.toLowerCase().includes(q)) ||
        (a.slug && a.slug.toLowerCase().includes(q))
      );
    }
    if (state.sort === "hot") {
      list = [...list].sort((a, b) => (b.postCount || 0) - (a.postCount || 0));
    } else if (state.sort === "name") {
      list = [...list].sort((a, b) => {
        const ta = String(a.tag || "").replace(/^@/, "").toLowerCase();
        const tb = String(b.tag || "").replace(/^@/, "").toLowerCase();
        return ta.localeCompare(tb);
      });
    } else if (state.sort === "random") {
      list = [...list].sort(() => Math.random() - 0.5);
    }
    state.filtered = list;
  }

  function refresh() {
    computeFiltered();
    const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    if (state.page >= totalPages) state.page = totalPages - 1;
    renderGrid();
    renderBar();
    renderPager();
  }

  // ---- 渲染卡片 ----
  function renderGrid() {
    grid.innerHTML = "";
    if (!state.loaded) {
      grid.innerHTML = '<div class="zhule-artist-empty">加载画师数据…</div>';
      return;
    }
    if (!state.filtered.length) {
      grid.innerHTML = '<div class="zhule-artist-empty">没有匹配的画师</div>';
      return;
    }
    const start = state.page * state.pageSize;
    const slice = state.filtered.slice(start, start + state.pageSize);

    for (const a of slice) {
      const card = document.createElement("div");
      card.className = "zhule-artist-card";
      if (state.selected.has(a.slug)) card.classList.add("selected");

      const img = document.createElement("img");
      img.className = "zhule-artist-thumb";
      img.loading = "lazy";
      img.alt = a.tag || a.slug;
      img.src = a.imageId
        ? `/zhule_artists/image?id=${encodeURIComponent(a.imageId)}`
        : "";

      const heart = document.createElement("div");
      heart.className = "zhule-artist-heart";
      heart.textContent = "❤";
      if (state.favs.includes(a.slug)) heart.classList.add("faved");
      heart.onclick = (e) => {
        e.stopPropagation();
        toggleFav(a.slug);
      };

      // 左侧图标：点击后图片全屏预览
      const zoom = document.createElement("div");
      zoom.className = "zhule-artist-zoom";
      zoom.textContent = "🔍";
      zoom.title = "全屏预览";
      zoom.onclick = (e) => {
        e.stopPropagation();
        openLightbox(a);
      };

      const infoWrap = document.createElement("div");
      infoWrap.className = "zhule-artist-info";
      const name = document.createElement("div");
      name.className = "zhule-artist-name";
      name.textContent = a.tag || a.slug;
      name.title = a.tag || a.slug;
      const count = document.createElement("div");
      count.className = "zhule-artist-count";
      count.textContent = "作品 " + fmtCount(a.postCount);
      infoWrap.appendChild(name);
      infoWrap.appendChild(count);

      card.appendChild(img);
      card.appendChild(zoom);
      card.appendChild(heart);
      card.appendChild(infoWrap);

      card.onclick = () => toggleSelect(a.slug);
      grid.appendChild(card);
    }
  }

  function renderBar() {
    const randPrefix = state.randomMode
      ? `🎲 随机模式（当前筛选结果）· `
      : "";
    const slugs = [...state.selected];
    const tagList = slugs.map(s => {
      const a = state.artists.find(x => x.slug === s);
      return a && a.tag ? a.tag : "@" + s;
    });
    const shown = tagList.join(", ");
    info.textContent = randPrefix + (slugs.length
      ? `已选 ${slugs.length} 个：${shown}`
      : "已选 0 个");
    info.title = shown;
  }

  function renderPager() {
    const oldPager = container.querySelector(".zhule-artist-pager");
    if (oldPager) oldPager.remove();
    const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    const pager = buildPager(totalPages, state.page, (p) => {
      if (p < 0 || p >= totalPages) return;
      state.page = p;
      refresh();
    });
    container.insertBefore(pager, bar);
  }

  function toggleSelect(slug) {
    if (state.selected.has(slug)) state.selected.delete(slug);
    else state.selected.add(slug);
    setSelectedSlugs(state.node, [...state.selected]);
    renderGrid();
    renderBar();
  }

  function toggleFav(slug) {
    const idx = state.favs.indexOf(slug);
    if (idx >= 0) state.favs.splice(idx, 1);
    else state.favs.push(slug);
    pushFavs(state.favs);
    refresh();
  }

  // ---- 全屏预览 ----
  function openLightbox(a) {
    const overlay = document.createElement("div");
    overlay.className = "zhule-lightbox";

    const img = document.createElement("img");
    img.src = a.imageId
      ? `/zhule_artists/image?id=${encodeURIComponent(a.imageId)}`
      : "";
    img.alt = a.tag || a.slug;

    const cap = document.createElement("div");
    cap.className = "zhule-lightbox-cap";
    cap.textContent = (a.tag || a.slug) + "  ·  作品 " + fmtCount(a.postCount);

    overlay.appendChild(img);
    overlay.appendChild(cap);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.onclick = close;
    const onKey = (e) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey, { once: true });
    // 等监听注册后再移除，防止图片加载事件误触
    img.onerror = () => {
      img.alt = (a.tag || a.slug) + "（图片加载失败）";
      img.style.opacity = "0.4";
    };
  }

  // ---- 图片尺寸 ----
  function applySize(px) {
    px = Math.max(80, Math.min(300, px));
    px = Math.round(px / 10) * 10;
    sizeInput.value = px;
    grid.style.setProperty("--card-size", px + "px");
    state.cardSize = px;
    minusBtn.disabled = px <= 80;
    plusBtn.disabled = px >= 300;
    updatePageSize();
  }

  // ---- 事件 ----
  search.oninput = () => { state.query = search.value; state.page = 0; refresh(); };
  sortSel.onchange = () => { state.sort = sortSel.value; state.page = 0; refresh(); };
  favBtn.onclick = () => {
    state.onlyFav = !state.onlyFav;
    favBtn.classList.toggle("active", state.onlyFav);
    state.page = 0;
    refresh();
  };

  // 随机输出开关：点击切换；Queue 时从当前筛选结果随机挑一个写入 _selected
  randBtn.onclick = () => {
    state.randomMode = !state.randomMode;
    randBtn.classList.toggle("active", state.randomMode);
    refresh();
  };
  // 初始化按钮高亮
  if (state.randomMode) randBtn.classList.add("active");
  clearBtn.onclick = () => {
    state.selected.clear();
    setSelectedSlugs(state.node, []);
    renderGrid();
    renderBar();
  };
  minusBtn.onclick = () => applySize(state.cardSize - 10);
  plusBtn.onclick = () => applySize(state.cardSize + 10);
  sizeInput.onchange = () => applySize(parseInt(sizeInput.value, 10) || 140);

  // ---- 监听网格尺寸变化 ----
  const ro = new ResizeObserver(() => updatePageSize());
  ro.observe(grid);

  // 注册实例：供 Queue 钩子在随机模式下从当前筛选结果抽选
  const panelApi = {
    setSelected(slugs) {
      state.selected = new Set(slugs);
      renderGrid();
      renderBar();
    },
  };
  artistPanels.push({ node, state, api: panelApi });
  installQueueHook();

  // 初始化
  applySize(140);
  load();
}

app.registerExtension({
  name: "Zhule.ArtistPicker",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      const node = this;

      setTimeout(() => {
        hideWidgetCompletely(node.widgets?.find(w => w.name === "_selected"));

        const el = document.createElement("div");
        el.className = "zhule-artist-embed";
        const w = node.addDOMWidget("artistPanel", "div", el, { serialize: false });
        w.computeSize = function (width) {
          return [width, EMBED_HEIGHT];
        };

        buildEmbedPanel(node, el);

        if (node.size) {
          node.size[0] = Math.max(node.size[0], 520);
          node.size[1] = Math.max(node.size[1], 680);
        } else {
          node.size = [520, 680];
        }

        app.graph?.setDirtyCanvas(true, true);
      }, 100);

      return result;
    };
  },
});
