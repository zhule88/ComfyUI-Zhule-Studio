import { app } from "../../scripts/app.js";

console.log("%c[ZhuleDirPicker] LOADED (rel-path)", "color:#0f0;font-weight:bold");

const NODE_TYPE = "ZhuleDirPicker";

const FOLDER_ICONS = [
  "🍎", "🍊", "🍋", "🍇", "🍓",
  "🍌", "🍉", "🍍", "🥝", "🥥",
  "🥕", "🌽", "🍄", "🥦", "🍆",
  "🍞", "🍕", "🍔", "🍣", "🍦",
];

const _origComputeSize = new WeakMap();
const _origDraw = new WeakMap();

function setWidgetVisible(widget, visible) {
  if (!widget) return;
  if (visible) {
    widget.hidden = false;
    if (widget.options) widget.options.hidden = false;
    if (_origComputeSize.has(widget)) {
      widget.computeSize = _origComputeSize.get(widget);
      _origComputeSize.delete(widget);
    } else delete widget.computeSize;
    if (_origDraw.has(widget)) {
      widget.draw = _origDraw.get(widget);
      _origDraw.delete(widget);
    } else delete widget.draw;
    if (widget.inputEl) widget.inputEl.style.display = "";
    if (widget.element) widget.element.style.display = "";
  } else {
    widget.hidden = true;
    widget.options ||= {};
    widget.options.hidden = true;
    if (!_origComputeSize.has(widget) && widget.computeSize) _origComputeSize.set(widget, widget.computeSize);
    if (!_origDraw.has(widget) && widget.draw) _origDraw.set(widget, widget.draw);
    widget.computeSize = () => [0, 0];
    widget.draw = () => { };
    if (widget.inputEl) widget.inputEl.style.display = "none";
    if (widget.element) widget.element.style.display = "none";
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

async function fetchList(path) {
  const resp = await fetch(`/zhule/list_dir?path=${encodeURIComponent(path || "")}`);
  return await resp.json();
}

function makeButton(text, fontSize = 15) {
  const b = document.createElement("button");
  b.textContent = text;
  b.style.cssText = `
        padding:8px 14px; font-size:${fontSize}px; cursor:pointer;
        background:#343b44; color:#eaf0f6;
        border:1px solid #4b5563; border-radius:5px;
        line-height:1.2; flex-shrink:0;
    `;
  b.onmouseenter = () => { if (!b.disabled) b.style.background = "#46515e"; };
  b.onmouseleave = () => { if (!b.disabled) b.style.background = "#343b44"; };
  return b;
}

function makeSectionHeader(labelText, defaultOpen = true) {
  const bar = document.createElement("div");
  bar.style.cssText = `
        display:flex; align-items:center; gap:8px;
        padding:8px 12px; cursor:pointer; user-select:none;
        background:#252525; border-radius:5px;
        color:#e0c080; font-weight:600;
        flex-shrink:0;
    `;
  const arrow = document.createElement("span");
  arrow.textContent = defaultOpen ? "▼" : "▶";
  arrow.style.cssText = "font-size:11px; width:12px; display:inline-block; text-align:center;";
  const label = document.createElement("span");
  label.textContent = labelText;
  bar.appendChild(arrow);
  bar.appendChild(label);
  bar.onmouseenter = () => bar.style.background = "#303030";
  bar.onmouseleave = () => bar.style.background = "#252525";
  return {
    bar, arrow, label,
    setOpen(open) { arrow.textContent = open ? "▼" : "▶"; },
    setLabel(text) { label.textContent = text; },
  };
}

app.registerExtension({
  name: "Zhule.DirPicker",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      const node = this;

      let firstConfigureDone = false;

      const HEADER_H = 44;
      const SEARCH_H = 38;

      setTimeout(() => {
        hideWidgetCompletely(node.widgets?.find(w => w.name === "_current_dir"));
      }, 100);

      const root = document.createElement("div");
      root.style.cssText = `
                flex-direction:column; gap:6px;
                padding:8px; background:#1a1a1a; border-radius:6px;
                font-family: -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif;
                color:#ddd;
                width:100%; box-sizing:border-box;
                overflow:hidden;
            `;
      root.style.display = "flex";
      root.style.flex = "1 1 0";

      const header = document.createElement("div");
      header.style.cssText = `display:flex; gap:6px; align-items:center; height:${HEADER_H}px; flex-shrink:0;`;

      const backBtn = makeButton("◀");
      const pathLabel = document.createElement("div");
      pathLabel.style.cssText = `
                flex:1; overflow:hidden; text-overflow:ellipsis;
                white-space:nowrap; color:#8fc8ff;
                padding:8px 10px; background:#0f0f0f; border-radius:5px;
                font-family: Consolas, Monaco, monospace;
            `;

      const randomBtn = makeButton("🎲", 15);
      randomBtn.title = "随机跳到一个主题";
      randomBtn.style.background = "#4a3a2a";
      randomBtn.style.borderColor = "#7a5a3a";
      randomBtn.onmouseenter = () => { if (!randomBtn.disabled) randomBtn.style.background = "#6a4a3a"; };
      randomBtn.onmouseleave = () => { if (!randomBtn.disabled) randomBtn.style.background = "#4a3a2a"; };

      const broadcastBtn = makeButton("📢", 15);
      broadcastBtn.title = "广播给下游 ComboPicker（仅浏览显示）";
      broadcastBtn.style.background = "#2a4a6a";
      broadcastBtn.style.borderColor = "#3a6a8a";
      broadcastBtn.onmouseenter = () => { if (!broadcastBtn.disabled) broadcastBtn.style.background = "#3a5a7a"; };
      broadcastBtn.onmouseleave = () => { if (!broadcastBtn.disabled) broadcastBtn.style.background = "#2a4a6a"; };

      header.appendChild(backBtn);
      header.appendChild(pathLabel);
      header.appendChild(randomBtn);
      header.appendChild(broadcastBtn);

      const searchRow = document.createElement("div");
      searchRow.style.cssText = `display:flex; gap:8px; align-items:center; height:${SEARCH_H}px; flex-shrink:0;`;

      const searchInput = document.createElement("input");
      searchInput.type = "text";
      searchInput.placeholder = "🔍 搜索当前目录...";
      searchInput.style.cssText = `
                flex:1; padding:8px 12px;
                background:#0f0f0f; color:#ddd;
                border:1px solid #4b5563; border-radius:5px;
                outline:none; box-sizing:border-box; height:100%;
            `;
      searchInput.onfocus = () => searchInput.style.borderColor = "#75b9ff";
      searchInput.onblur = () => searchInput.style.borderColor = "#4b5563";

      const clearSearchBtn = makeButton("✕", 14);
      clearSearchBtn.style.display = "none";
      clearSearchBtn.style.padding = "8px 12px";

      searchRow.appendChild(searchInput);
      searchRow.appendChild(clearSearchBtn);

      const listSection = makeSectionHeader("📁 文件夹", true);

      const list = document.createElement("div");
      list.style.cssText = `
                background:#0f0f0f; border-radius:5px;
                overflow-y: auto; padding:6px;
                flex:1 1 0; min-height:60px;
            `;

      root.appendChild(header);
      root.appendChild(searchRow);
      root.appendChild(listSection.bar);
      root.appendChild(list);

      const state = {
        currentDir: null,
        relPath: "",
        parent: null, siblings: [],
        folders: [], loading: false, searchQuery: "",
        listCollapsed: false,
      };

      function getWidgetValue(n, name) { return n.widgets?.find(w => w.name === name)?.value; }

      function setWidgetValue(n, name, value) {
        const w = n.widgets?.find(w => w.name === name);
        if (!w) return;
        w.value = value;
        if (w.inputEl) w.inputEl.value = value;
        n.graph?.setDirtyCanvas(true, true);
      }

      function renderList() {
        list.innerHTML = "";
        if (state.loading) {
          list.innerHTML = '<div style="color:#888;padding:14px;">加载中…</div>';
          listSection.setLabel(`📁 文件夹`);
          return;
        }

        const q = state.searchQuery.trim().toLowerCase();
        const visibleFolders = [];
        state.folders.forEach((name, idx) => {
          if (q && !name.toLowerCase().includes(q)) return;
          visibleFolders.push({ name, idx });
        });

        listSection.setLabel(`📁 文件夹 (${visibleFolders.length})`);

        if (!visibleFolders.length) {
          list.innerHTML = q
            ? '<div style="color:#666;padding:14px;">无匹配项</div>'
            : '<div style="color:#666;padding:14px;">（空）</div>';
          return;
        }

        for (const { name, idx } of visibleFolders) {
          const icon = FOLDER_ICONS[idx % FOLDER_ICONS.length];
          const absPath = state.currentDir.replace(/\\/g, "/").replace(/\/$/, "") + "/" + name;

          const row = document.createElement("div");
          row.textContent = icon + " " + name;
          row.style.cssText = `padding:12px 14px; cursor:pointer; border-radius:4px; color:#e0c080; line-height:1.5; min-height:28px; display:flex; align-items:center;`;
          row.onmouseenter = () => row.style.background = "#252525";
          row.onmouseleave = () => row.style.background = "";
          row.onclick = () => {
            state.searchQuery = ""; searchInput.value = ""; clearSearchBtn.style.display = "none";
            navigateTo(absPath);
          };
          list.appendChild(row);
        }
      }

      function updateHeader() {
        // ★ 显示相对路径
        pathLabel.textContent = state.relPath || "（input 根）";
        pathLabel.title = state.relPath || "";

        backBtn.disabled = !state.parent;
        backBtn.style.opacity = state.parent ? "1" : "0.4";
        backBtn.style.cursor = state.parent ? "pointer" : "not-allowed";

        randomBtn.disabled = false;
        randomBtn.style.opacity = "1";
        randomBtn.style.cursor = "pointer";

        const canBroadcast = !!state.currentDir;
        broadcastBtn.disabled = !canBroadcast;
        broadcastBtn.style.opacity = canBroadcast ? "1" : "0.4";
        broadcastBtn.style.cursor = canBroadcast ? "pointer" : "not-allowed";
      }

      function renderAll() { updateHeader(); renderList(); }

      async function navigateTo(absPath) {
        state.loading = true;
        renderList();
        try {
          const data = await fetchList(absPath);
          if (data.error) {
            state.loading = false;
            list.innerHTML = `<div style="color:#f66;padding:14px;">${data.error}</div>`;
            return;
          }
          state.currentDir = data.path;
          state.relPath = data.rel_path || "";
          state.parent = data.parent;
          state.siblings = data.siblings || [];
          state.folders = data.folders || [];
          setWidgetValue(node, "_current_dir", data.path || "");
        } catch (e) {
          list.innerHTML = `<div style="color:#f66;padding:14px;">请求失败: ${e.message}</div>`;
        } finally {
          state.loading = false;
          renderAll();
        }
      }

      function broadcastNav() {
        const cur = state.currentDir;
        if (!cur) return;
        window.dispatchEvent(new CustomEvent("zhule-sync", {
          detail: { path: cur, relPath: state.relPath, from: node.id }
        }));
        console.log(`[ZhuleDirPicker] #${node.id} 📢 广播 path=${state.relPath}`);
      }

      async function doRandom() {
        const keywords = (getWidgetValue(node, "keywords") || "").trim();

        try {
          const params = new URLSearchParams({ root: "", keywords });
          const resp = await fetch(`/zhule/scan_themes?${params}`);
          const data = await resp.json();

          if (data.error) { alert("扫描失败: " + data.error); return; }
          if (!data.themes || !data.themes.length) { alert("未找到候选目录"); return; }

          const chosen = data.themes[Math.floor(Math.random() * data.themes.length)];
          console.log(`[ZhuleDirPicker] 🎲 随机到: ${chosen}`);
          // chosen 是相对路径，需要转绝对
          await navigateTo(chosen);
        } catch (e) {
          alert("请求失败: " + e.message);
        }
      }

      searchInput.oninput = () => {
        state.searchQuery = searchInput.value;
        clearSearchBtn.style.display = searchInput.value ? "block" : "none";
        renderList();
      };
      searchInput.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          searchInput.value = ""; state.searchQuery = "";
          clearSearchBtn.style.display = "none";
          renderList(); searchInput.blur();
        }
      };
      clearSearchBtn.onclick = () => {
        searchInput.value = ""; state.searchQuery = "";
        clearSearchBtn.style.display = "none";
        renderList(); searchInput.focus();
      };

      backBtn.onclick = () => {
        if (state.parent) {
          state.searchQuery = ""; searchInput.value = "";
          clearSearchBtn.style.display = "none";
          navigateTo(state.parent);
        }
      };

      randomBtn.onclick = doRandom;
      broadcastBtn.onclick = broadcastNav;

      const domWidget = node.addDOMWidget("dir_picker_ui", "div", root, { serialize: false, hideOnZoom: false });

      let panelVisible = true;
      let savedNodeHeight = null;

      function calcNonDomHeight() {
        let h = 30;
        for (const w of (node.widgets || [])) {
          if (w === domWidget) continue;
          const sz = w.computeSize ? w.computeSize(node.size[0]) : null;
          let wh = 20;
          if (sz && Array.isArray(sz) && sz[1] > 0) wh = sz[1];
          h += wh;
        }
        return h + 10;
      }

      domWidget.computeSize = (width) => {
        if (!panelVisible) return [width, 0];
        const nonDomH = calcNonDomHeight();
        return [width, Math.max(150, node.size[1] - nonDomH)];
      };

      function applyFontSize() {
        const fontS = parseInt(getWidgetValue(node, "font_size")) || 15;
        root.style.fontSize = fontS + "px";
        pathLabel.style.fontSize = Math.max(11, fontS - 1) + "px";
        searchInput.style.fontSize = Math.max(11, fontS - 1) + "px";
        [backBtn, randomBtn, broadcastBtn, clearSearchBtn].forEach(b => {
          if (b) b.style.fontSize = Math.max(11, fontS - 1) + "px";
        });
        listSection.bar.style.fontSize = Math.max(11, fontS - 1) + "px";
      }

      requestAnimationFrame(() => {
        applyFontSize();
        const [w, h] = node.computeSize();
        node.setSize([Math.max(w, 520), h]);
      });

      const fontSizeW = node.widgets?.find(x => x.name === "font_size");
      if (fontSizeW) {
        const orig = fontSizeW.callback;
        fontSizeW.callback = function (value, ...args) {
          const r = orig?.apply(this, [value, ...args]);
          requestAnimationFrame(() => applyFontSize());
          return r;
        };
      }

      setTimeout(() => {
        const showW = node.widgets?.find(x => x.name === "show_panel");
        if (!showW) return;
        const orig = showW.callback;
        showW.callback = function (value, ...args) {
          const r = orig?.apply(this, [value, ...args]);
          const willShow = (value !== false);
          if (willShow === panelVisible) return r;
          panelVisible = willShow;
          if (panelVisible) {
            if (domWidget.element) domWidget.element.style.display = "flex";
            root.style.display = "flex";
            const targetH = savedNodeHeight || Math.max(700, node.size[1]);
            savedNodeHeight = null;
            node.setSize([node.size[0], targetH]);
          } else {
            savedNodeHeight = node.size[1];
            if (domWidget.element) domWidget.element.style.display = "none";
            root.style.display = "none";
            const [, h] = node.computeSize();
            node.setSize([node.size[0], h]);
          }
          app.graph?.setDirtyCanvas(true, true);
          return r;
        };
      }, 100);

      listSection.bar.onclick = () => {
        state.listCollapsed = !state.listCollapsed;
        listSection.setOpen(!state.listCollapsed);
        list.style.display = state.listCollapsed ? "none" : "block";
      };

      const wheelHandler = (e) => {
        if (root.contains(e.target)) e.stopImmediatePropagation();
      };
      document.addEventListener("wheel", wheelHandler, { capture: true });

      const origOnRemoved = node.onRemoved;
      node.onRemoved = function () {
        document.removeEventListener("wheel", wheelHandler, { capture: true });
        return origOnRemoved?.apply(this, arguments);
      };

      setTimeout(() => {
        if (!firstConfigureDone) {
          const cur = getWidgetValue(node, "_current_dir");
          navigateTo(cur || "");
        }
      }, 100);

      const origOnConfigure = node.onConfigure;
      node.onConfigure = function () {
        firstConfigureDone = true;
        const r = origOnConfigure?.apply(this, arguments);
        setTimeout(() => {
          const cur = getWidgetValue(node, "_current_dir");
          navigateTo(cur || "");

          const show = getWidgetValue(node, "show_panel");
          panelVisible = (show !== false);
          if (panelVisible) {
            if (domWidget.element) domWidget.element.style.display = "flex";
            root.style.display = "flex";
          } else {
            if (domWidget.element) domWidget.element.style.display = "none";
            root.style.display = "none";
            const [, h] = node.computeSize();
            node.setSize([node.size[0], h]);
          }

          requestAnimationFrame(() => applyFontSize());
        }, 300);
        return r;
      };

      return result;
    };
  },
});