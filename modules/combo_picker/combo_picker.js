import { app } from "../../scripts/app.js";

console.log("%c[ZhuleComboPicker] LOADED (rel-path)", "color:#0f0;font-weight:bold");

const NODE_TYPE = "ZhuleComboPicker";

const FOLDER_ICONS = [
    "🍎", "🍊", "🍋", "🍇", "🍓",
    "🍌", "🍉", "🍍", "🥝", "🥥",
    "🥕", "🌽", "🍄", "🥦", "🍆",
    "🍞", "🍕", "🍔", "🍣", "🍦",
];

let fullscreenOverlay = null;
let fullscreenState = null;

function ensureFullscreenStyles() {
    if (document.getElementById("zhule-fs-styles")) return;
    const style = document.createElement("style");
    style.id = "zhule-fs-styles";
    style.textContent = `
        .zhule-fs-overlay { position: fixed; inset: 0; z-index: 1000000; background: rgba(0,0,0,0.95); display: flex; align-items: center; justify-content: center; user-select: none; }
        .zhule-fs-img { max-width: 95vw; max-height: 92vh; object-fit: contain; box-shadow: 0 0 40px rgba(0,0,0,0.8); }
        .zhule-fs-close { position: absolute; top: 20px; right: 30px; color: #fff; font-size: 32px; cursor: pointer; padding: 8px 16px; border-radius: 6px; background: rgba(255,255,255,0.1); line-height: 1; }
        .zhule-fs-close:hover { background: rgba(255,255,255,0.25); }
        .zhule-fs-nav { position: absolute; top: 50%; transform: translateY(-50%); color: #fff; font-size: 48px; cursor: pointer; padding: 20px 30px; border-radius: 8px; background: rgba(255,255,255,0.08); line-height: 1; }
        .zhule-fs-nav:hover { background: rgba(255,255,255,0.2); }
        .zhule-fs-prev { left: 30px; }
        .zhule-fs-next { right: 30px; }
        .zhule-fs-counter { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); color: #fff; font-size: 16px; padding: 8px 20px; border-radius: 20px; background: rgba(0,0,0,0.6); }
        .zhule-fs-name { position: absolute; top: 24px; left: 30px; color: #ccc; font-size: 14px; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    `;
    document.head.appendChild(style);
}

function openFullscreen(images, idx, basePath) {
    ensureFullscreenStyles();
    if (fullscreenOverlay) closeFullscreen();

    fullscreenOverlay = document.createElement("div");
    fullscreenOverlay.className = "zhule-fs-overlay";

    const img = document.createElement("img");
    img.className = "zhule-fs-img";
    const closeBtn = document.createElement("div");
    closeBtn.className = "zhule-fs-close"; closeBtn.textContent = "✕";
    const prevBtn = document.createElement("div");
    prevBtn.className = "zhule-fs-nav zhule-fs-prev"; prevBtn.textContent = "‹";
    const nextBtn = document.createElement("div");
    nextBtn.className = "zhule-fs-nav zhule-fs-next"; nextBtn.textContent = "›";
    const counter = document.createElement("div");
    counter.className = "zhule-fs-counter";
    const name = document.createElement("div");
    name.className = "zhule-fs-name";

    function render() {
        const realIdx = ((fullscreenState.idx % images.length) + images.length) % images.length;
        fullscreenState.idx = realIdx;
        const imgName = images[realIdx];
        const absPath = basePath.replace(/\\/g, "/").replace(/\/$/, "") + "/" + imgName;
        img.src = `/zhule/image?path=${encodeURIComponent(absPath)}`;
        counter.textContent = `${realIdx + 1} / ${images.length}`;
        name.textContent = imgName;
    }

    fullscreenState = { images, idx, render };

    closeBtn.onclick = closeFullscreen;
    prevBtn.onclick = (e) => { e.stopPropagation(); fullscreenState.idx -= 1; render(); };
    nextBtn.onclick = (e) => { e.stopPropagation(); fullscreenState.idx += 1; render(); };
    fullscreenOverlay.onclick = (e) => { if (e.target === fullscreenOverlay) closeFullscreen(); };

    fullscreenOverlay.appendChild(img);
    fullscreenOverlay.appendChild(closeBtn);
    fullscreenOverlay.appendChild(prevBtn);
    fullscreenOverlay.appendChild(nextBtn);
    fullscreenOverlay.appendChild(counter);
    fullscreenOverlay.appendChild(name);
    document.body.appendChild(fullscreenOverlay);

    const keyHandler = (e) => {
        if (!fullscreenOverlay) return;
        if (e.key === "Escape") closeFullscreen();
        else if (e.key === "ArrowLeft") { fullscreenState.idx -= 1; fullscreenState.render(); }
        else if (e.key === "ArrowRight") { fullscreenState.idx += 1; fullscreenState.render(); }
    };
    document.addEventListener("keydown", keyHandler);
    fullscreenOverlay._keyHandler = keyHandler;
    render();
}

function closeFullscreen() {
    if (!fullscreenOverlay) return;
    if (fullscreenOverlay._keyHandler) document.removeEventListener("keydown", fullscreenOverlay._keyHandler);
    fullscreenOverlay.remove();
    fullscreenOverlay = null;
    fullscreenState = null;
}

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

function refreshComboUI(node) {
    const getW = (name) => node.widgets?.find(w => w.name === name);
    const pickModeW = getW("pick_mode");
    const modeW = getW("mode");
    const filterW = getW("filter");
    const excludeW = getW("exclude");
    const weightsW = getW("weights");
    const conditionW = getW("condition");
    const elseTextW = getW("else_text");
    const probW = getW("probability");
    if (!pickModeW || !modeW) return;

    const pickMode = pickModeW.value;
    const isRandom = pickMode === "random";
    const isFixed = pickMode === "fixed";
    const isProb = modeW.value === "probability";

    setWidgetVisible(filterW, !isFixed);
    setWidgetVisible(excludeW, !isFixed);
    setWidgetVisible(weightsW, isRandom);
    setWidgetVisible(probW, isProb);
    setWidgetVisible(conditionW, !isProb);
    setWidgetVisible(elseTextW, !isProb);
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
    name: "Zhule.ComboPicker",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            const node = this;

            let firstConfigureDone = false;

            const HEADER_H = 44;
            const SEARCH_H = 38;
            const NAV_H = 40;

            setTimeout(() => {
                for (const name of ["_current_dir", "_locked_file"]) {
                    hideWidgetCompletely(node.widgets?.find(w => w.name === name));
                }
                for (const name of ["pick_mode", "mode"]) {
                    const w = node.widgets?.find(x => x.name === name);
                    if (!w) continue;
                    const orig = w.callback;
                    w.callback = function (value, ...args) {
                        const r = orig?.apply(this, [value, ...args]);
                        refreshComboUI(node);
                        return r;
                    };
                }
                refreshComboUI(node);
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
            const nextBtn = makeButton("下一文件夹 ▶", 13);

            const deleteFolderBtn = makeButton("🗑", 15);
            deleteFolderBtn.title = "删除当前文件夹（含所有内容）";
            deleteFolderBtn.style.background = "#5a2828";
            deleteFolderBtn.style.borderColor = "#8b3a3a";
            deleteFolderBtn.onmouseenter = () => { if (!deleteFolderBtn.disabled) deleteFolderBtn.style.background = "#7a3838"; };
            deleteFolderBtn.onmouseleave = () => { if (!deleteFolderBtn.disabled) deleteFolderBtn.style.background = "#5a2828"; };

            header.appendChild(backBtn);
            header.appendChild(pathLabel);
            header.appendChild(nextBtn);
            header.appendChild(deleteFolderBtn);

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

            const previewSection = makeSectionHeader("🖼 预览", true);

            const preview = document.createElement("div");
            preview.style.cssText = `
                background:#0f0f0f; border-radius:5px; padding:8px;
                flex-direction:column; align-items:center;
                gap:6px; overflow:hidden;
                flex:1 1 0; min-height:80px;
            `;
            preview.style.display = "flex";

            const imgWrap = document.createElement("div");
            imgWrap.style.cssText = `
                flex:1 1 0; min-height:0; width:100%;
                display:flex; align-items:center; justify-content:center;
                overflow:hidden;
                position:relative;
            `;

            const previewImg = document.createElement("img");
            previewImg.style.cssText = `
                max-width:100%; max-height:100%;
                width:auto; height:auto;
                display:none; border-radius:5px;
                object-fit:contain; cursor:zoom-in;
            `;

            const noImage = document.createElement("div");
            noImage.textContent = "无参考图";
            noImage.style.cssText = "color:#666; padding:20px;";

            imgWrap.appendChild(previewImg);
            imgWrap.appendChild(noImage);

            const deleteImgBtn = document.createElement("div");
            deleteImgBtn.textContent = "✕";
            deleteImgBtn.title = "删除这张图（含所有硬链接）";
            deleteImgBtn.style.cssText = `
                position:absolute; top:6px; right:6px;
                width:28px; height:28px; line-height:26px;
                text-align:center; cursor:pointer;
                background:rgba(200,40,40,0.85); color:#fff;
                border:1px solid rgba(255,255,255,0.3);
                border-radius:50%; font-size:14px; user-select:none;
                opacity:0; transition:opacity 0.15s;
                z-index:10; display:none;
            `;
            imgWrap.appendChild(deleteImgBtn);

            imgWrap.onmouseenter = () => { if (deleteImgBtn.style.display !== "none") deleteImgBtn.style.opacity = "1"; };
            imgWrap.onmouseleave = () => { deleteImgBtn.style.opacity = "0"; };

            const navRow = document.createElement("div");
            navRow.style.cssText = `display:flex; gap:8px; align-items:center; height:${NAV_H}px; flex-shrink:0; justify-content:center;`;

            const prevFolderBtn = makeButton("⏮", 16);
            const prevImgBtn = makeButton("◀");
            const imgCounter = document.createElement("span");
            imgCounter.style.cssText = "color:#aaa; min-width:70px; text-align:center;";
            imgCounter.textContent = "0/0";
            const nextImgBtn = makeButton("▶");
            const nextFolderBtn = makeButton("⏭", 16);

            navRow.appendChild(prevFolderBtn);
            navRow.appendChild(prevImgBtn);
            navRow.appendChild(imgCounter);
            navRow.appendChild(nextImgBtn);
            navRow.appendChild(nextFolderBtn);

            preview.appendChild(imgWrap);
            preview.appendChild(navRow);

            root.appendChild(header);
            root.appendChild(searchRow);
            root.appendChild(listSection.bar);
            root.appendChild(list);
            root.appendChild(previewSection.bar);
            root.appendChild(preview);

            const state = {
                currentDir: null,
                relPath: "",
                parent: null, siblings: [],
                folders: [], files: [], images: [],
                imageIdx: 0, loading: false, searchQuery: "",
                listCollapsed: false,
                previewCollapsed: false,
                browsingOnly: false,
            };

            function getWidgetValue(n, name) { return n.widgets?.find(w => w.name === name)?.value; }

            function setWidgetValue(n, name, value) {
                const w = n.widgets?.find(w => w.name === name);
                if (!w) return;
                w.value = value;
                if (w.inputEl) w.inputEl.value = value;
                n.graph?.setDirtyCanvas(true, true);
            }

            // ★★★ 判断本节点是否连了 dir_path 输入
            function hasDirPathLink() {
                const inp = node.inputs?.find(i => i.name === "dir_path");
                return !!(inp && inp.link != null);
            }

            // 接收 DirPicker 广播
            window.addEventListener("zhule-sync", async (e) => {
                // ★ 没连线的节点忽略广播
                if (!hasDirPathLink()) return;

                const path = e.detail?.path;
                const relPath = e.detail?.relPath;
                if (!path) return;
                console.log(`[ZhuleComboPicker] #${node.id} 收到浏览广播 → ${relPath || path}`);
                try {
                    await navigateTo(path, true, relPath);
                    state.browsingOnly = true;
                    updateHeader();
                } catch (err) { console.error(err); }
            });

            function renderList() {
                list.innerHTML = "";
                if (state.loading) {
                    list.innerHTML = '<div style="color:#888;padding:14px;">加载中…</div>';
                    listSection.setLabel(`📁 文件夹`);
                    return;
                }
                if (state.currentDir === "__empty__") {
                    listSection.setLabel(`📁 文件夹`);
                    list.innerHTML = '<div style="color:#666;padding:14px;">（空）</div>';
                    return;
                }

                const q = state.searchQuery.trim().toLowerCase();
                const visibleFolders = [];
                state.folders.forEach((name, idx) => {
                    if (q && !name.toLowerCase().includes(q)) return;
                    visibleFolders.push({ name, idx });
                });
                const showFiles = q ? state.files.filter(n => n.toLowerCase().includes(q)) : state.files;

                listSection.setLabel(`📁 文件夹 (${visibleFolders.length})  📄 (${showFiles.length})`);

                if (!visibleFolders.length && !showFiles.length) {
                    list.innerHTML = q
                        ? '<div style="color:#666;padding:14px;">无匹配项</div>'
                        : '<div style="color:#666;padding:14px;">（空）</div>';
                    return;
                }

                const locked = getWidgetValue(node, "_locked_file") || "";
                const pickMode = getWidgetValue(node, "pick_mode") || "random";

                for (const { name, idx } of visibleFolders) {
                    const icon = FOLDER_ICONS[idx % FOLDER_ICONS.length];
                    const row = document.createElement("div");
                    row.textContent = icon + " " + name;
                    row.style.cssText = `padding:12px 14px; cursor:pointer; border-radius:4px; color:#e0c080; line-height:1.5; min-height:28px; display:flex; align-items:center;`;
                    row.onmouseenter = () => row.style.background = "#252525";
                    row.onmouseleave = () => row.style.background = "";
                    row.onclick = () => {
                        state.browsingOnly = false;
                        const abs = state.currentDir.replace(/\\/g, "/").replace(/\/$/, "") + "/" + name;
                        state.searchQuery = ""; searchInput.value = ""; clearSearchBtn.style.display = "none";
                        navigateTo(abs);
                    };
                    list.appendChild(row);
                }

                for (const name of showFiles) {
                    const row = document.createElement("div");
                    const absPath = state.currentDir.replace(/\\/g, "/").replace(/\/$/, "") + "/" + name;
                    const isLocked = locked === absPath;
                    row.textContent = (isLocked ? "🔒 " : "📄 ") + name;
                    row.style.cssText = `padding:12px 14px; cursor:pointer; border-radius:4px; color:${isLocked ? "#8fffa0" : "#ccc"}; background:${isLocked ? "#1a3a1a" : ""}; line-height:1.5; min-height:28px; display:flex; align-items:center;`;
                    row.onmouseenter = () => { if (!isLocked) row.style.background = "#252525"; };
                    row.onmouseleave = () => { if (!isLocked) row.style.background = ""; };
                    row.onclick = () => {
                        if (pickMode !== "fixed") return;
                        if (isLocked) setWidgetValue(node, "_locked_file", "");
                        else setWidgetValue(node, "_locked_file", absPath);
                        renderList();
                    };
                    list.appendChild(row);
                }
            }

            function renderPreview() {
                if (state.currentDir === "__empty__" || !state.images.length) {
                    previewImg.style.display = "none";
                    noImage.style.display = "block";
                    imgCounter.textContent = "0/0";
                    previewSection.setLabel(`🖼 预览 (0)`);
                    deleteImgBtn.style.display = "none";
                    return;
                }
                previewImg.style.display = "block";
                noImage.style.display = "none";
                deleteImgBtn.style.display = "block";
                state.imageIdx = ((state.imageIdx % state.images.length) + state.images.length) % state.images.length;
                const imgName = state.images[state.imageIdx];
                const absPath = state.currentDir.replace(/\\/g, "/").replace(/\/$/, "") + "/" + imgName;
                previewImg.src = `/zhule/image?path=${encodeURIComponent(absPath)}`;
                imgCounter.textContent = `${state.imageIdx + 1} / ${state.images.length}`;
                previewSection.setLabel(`🖼 预览 (${state.imageIdx + 1}/${state.images.length})`);
            }

            function updateHeader() {
                if (state.currentDir === "__empty__") {
                    pathLabel.textContent = "（空）";
                    pathLabel.style.color = "#8fc8ff";
                } else if (state.browsingOnly) {
                    pathLabel.textContent = "👁 " + (state.relPath || "（input 根）");
                    pathLabel.style.color = "#ffcc80";
                } else {
                    pathLabel.textContent = state.relPath || "（input 根）";
                    pathLabel.style.color = "#8fc8ff";
                }
                pathLabel.title = state.relPath || "";

                backBtn.disabled = !state.parent || state.currentDir === "__empty__";
                backBtn.style.opacity = (!state.parent || state.currentDir === "__empty__") ? "0.4" : "1";
                backBtn.style.cursor = (!state.parent || state.currentDir === "__empty__") ? "not-allowed" : "pointer";

                const canSwitchSibling = state.siblings.length > 1 && state.currentDir !== "__empty__";
                [nextBtn, prevFolderBtn, nextFolderBtn].forEach(btn => {
                    btn.disabled = !canSwitchSibling;
                    btn.style.opacity = canSwitchSibling ? "1" : "0.4";
                    btn.style.cursor = canSwitchSibling ? "pointer" : "not-allowed";
                });

                const canDeleteFolder = !!state.currentDir && state.currentDir !== "__empty__";
                deleteFolderBtn.disabled = !canDeleteFolder;
                deleteFolderBtn.style.opacity = canDeleteFolder ? "1" : "0.4";
                deleteFolderBtn.style.cursor = canDeleteFolder ? "pointer" : "not-allowed";
            }

            function renderAll() { updateHeader(); renderList(); renderPreview(); }

            async function navigateTo(absPath, skipWidgetUpdate = false, forceRelPath = null) {
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
                    state.relPath = forceRelPath || data.rel_path || "";
                    state.parent = data.parent;
                    state.siblings = data.siblings || [];
                    state.folders = data.folders || [];
                    state.files = data.files || [];
                    state.images = data.images || [];
                    state.imageIdx = 0;
                    if (!skipWidgetUpdate) {
                        setWidgetValue(node, "_current_dir", data.path || "");
                    }
                } catch (e) {
                    list.innerHTML = `<div style="color:#f66;padding:14px;">请求失败: ${e.message}</div>`;
                } finally {
                    state.loading = false;
                    renderAll();
                }
            }

            function navigateSibling(delta) {
                const siblings = state.siblings || [];
                if (siblings.length <= 1) return;
                const curName = (state.currentDir || "").split(/[\\/]/).pop();
                const idx = siblings.indexOf(curName);
                if (idx < 0) return;
                const nextIdx = (idx + delta + siblings.length) % siblings.length;
                const nextName = siblings[nextIdx];
                const baseDir = state.currentDir.replace(/\\/g, "/").replace(/\/[^/]+$/, "");
                const abs = baseDir.replace(/\/$/, "") + "/" + nextName;
                state.browsingOnly = false;
                state.searchQuery = ""; searchInput.value = "";
                clearSearchBtn.style.display = "none";
                navigateTo(abs);
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
                if (state.parent && state.currentDir !== "__empty__") {
                    state.browsingOnly = false;
                    state.searchQuery = ""; searchInput.value = "";
                    clearSearchBtn.style.display = "none";
                    navigateTo(state.parent);
                }
            };

            nextBtn.onclick = () => navigateSibling(1);
            prevFolderBtn.onclick = () => navigateSibling(-1);
            nextFolderBtn.onclick = () => navigateSibling(1);

            async function deleteCurrentFolder() {
                if (!state.currentDir || state.currentDir === "__empty__") return;
                const folderName = state.currentDir.split(/[\\/]/).pop();
                if (!confirm(`⚠️ 删除整个文件夹？\n\n${folderName}\n\n里面所有文件（含子文件夹）都会删除，不可恢复。`)) return;
                if (!confirm(`再次确认：真的要删除「${folderName}」吗？`)) return;
                try {
                    const resp = await fetch("/zhule/delete", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ path: state.currentDir }),
                    });
                    const data = await resp.json();
                    if (data.error) { alert("删除失败: " + data.error); return; }
                } catch (e) { alert("请求失败: " + e.message); return; }
                state.browsingOnly = false;
                navigateTo(state.parent || "");
            }

            async function deleteCurrentImage() {
                if (!state.images.length || state.currentDir === "__empty__") return;
                const imgName = state.images[state.imageIdx];
                const absPath = state.currentDir.replace(/\\/g, "/").replace(/\/$/, "") + "/" + imgName;
                if (!confirm(`确定删除这张图？\n\n${imgName}\n\n将同时删除所有硬链接副本，不可恢复。`)) return;
                try {
                    const resp = await fetch("/zhule/delete", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ path: absPath }),
                    });
                    const data = await resp.json();
                    if (data.error) { alert("删除失败: " + data.error); return; }
                } catch (e) { alert("请求失败: " + e.message); return; }
                state.images.splice(state.imageIdx, 1);
                if (state.imageIdx >= state.images.length) state.imageIdx = Math.max(0, state.images.length - 1);
                renderPreview();
            }

            deleteFolderBtn.onclick = deleteCurrentFolder;
            deleteImgBtn.onclick = (e) => { e.stopPropagation(); deleteCurrentImage(); };
            prevImgBtn.onclick = () => { if (!state.images.length) return; state.imageIdx -= 1; renderPreview(); };
            nextImgBtn.onclick = () => { if (!state.images.length) return; state.imageIdx += 1; renderPreview(); };
            previewImg.onclick = () => { if (!state.images.length || state.currentDir === "__empty__") return; openFullscreen(state.images, state.imageIdx, state.currentDir); };

            const domWidget = node.addDOMWidget("combo_ui", "div", root, { serialize: false, hideOnZoom: false });

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
                return [width, Math.max(200, node.size[1] - nonDomH)];
            };

            function applyFontSize() {
                const fontS = parseInt(getWidgetValue(node, "font_size")) || 15;
                root.style.fontSize = fontS + "px";
                pathLabel.style.fontSize = Math.max(11, fontS - 1) + "px";
                searchInput.style.fontSize = Math.max(11, fontS - 1) + "px";
                imgCounter.style.fontSize = Math.max(11, fontS - 1) + "px";
                [backBtn, nextBtn, prevImgBtn, nextImgBtn, clearSearchBtn, prevFolderBtn, nextFolderBtn, deleteFolderBtn].forEach(b => {
                    if (b) b.style.fontSize = Math.max(11, fontS - 1) + "px";
                });
                listSection.bar.style.fontSize = Math.max(11, fontS - 1) + "px";
                previewSection.bar.style.fontSize = Math.max(11, fontS - 1) + "px";
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
                        const targetH = savedNodeHeight || Math.max(900, node.size[1]);
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

            previewSection.bar.onclick = () => {
                state.previewCollapsed = !state.previewCollapsed;
                previewSection.setOpen(!state.previewCollapsed);
                preview.style.display = state.previewCollapsed ? "none" : "flex";
            };

            const wheelHandler = (e) => {
                if (root.contains(e.target)) e.stopImmediatePropagation();
            };
            document.addEventListener("wheel", wheelHandler, { capture: true });

            const middleHandler = (e) => {
                if (e.button === 1 && root.contains(e.target)) {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    if (list.contains(e.target) || e.target === list) {
                        const startY = e.clientY;
                        const startScroll = list.scrollTop;
                        const onMove = (ev) => { list.scrollTop = startScroll - (ev.clientY - startY); };
                        const onUp = () => {
                            document.removeEventListener("pointermove", onMove, true);
                            document.removeEventListener("pointerup", onUp, true);
                        };
                        document.addEventListener("pointermove", onMove, true);
                        document.addEventListener("pointerup", onUp, true);
                    }
                }
            };
            document.addEventListener("pointerdown", middleHandler, { capture: true });

            const origOnRemoved = node.onRemoved;
            node.onRemoved = function () {
                document.removeEventListener("wheel", wheelHandler, { capture: true });
                document.removeEventListener("pointerdown", middleHandler, { capture: true });
                return origOnRemoved?.apply(this, arguments);
            };

            setTimeout(() => {
                if (!firstConfigureDone) navigateTo("");
            }, 100);

            const origOnConfigure = node.onConfigure;
            node.onConfigure = function () {
                firstConfigureDone = true;
                const r = origOnConfigure?.apply(this, arguments);
                setTimeout(() => {
                    const cur = getWidgetValue(node, "_current_dir");
                    if (cur === "__empty__") {
                        state.currentDir = "__empty__";
                        state.relPath = "";
                        state.parent = null;
                        state.siblings = [];
                        state.folders = [];
                        state.files = [];
                        state.images = [];
                        state.imageIdx = 0;
                        updateHeader();
                        renderList();
                        renderPreview();
                    } else {
                        navigateTo(cur || "");
                    }
                    refreshComboUI(node);

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