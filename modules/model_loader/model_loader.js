import { app } from "../../scripts/app.js";

console.log("%c[ZhuleLoaderArch] LOADED", "color:#0f0;font-weight:bold");

const ARCH_COLORS = [
    ["illustrious", "#8fffa0"],
    ["noobai", "#b0ffcc"],
    ["anima", "#c0ff80"],
    ["pony", "#ffb0d0"],
    ["sdxl", "#8fc8ff"],
    ["sd 1.5", "#ffcc80"],
    ["sd1.5", "#ffcc80"],
    ["sd 1", "#ffcc80"],
    ["flux", "#ffd080"],
];

function colorFor(arch) {
    if (!arch) return "#888";
    const low = arch.toLowerCase();
    for (const [key, color] of ARCH_COLORS) {
        if (low.includes(key)) return color;
    }
    if (low.includes("?")) return "#aa9";
    if (low === "unknown") return "#666";
    return "#888";
}

function fmtRange(v) {
    if (Array.isArray(v)) return v.length === 2 ? `${v[0]}-${v[1]}` : v.join("/");
    return v === undefined || v === null ? "" : String(v);
}

const hasVal = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

// 竖排推荐参数：每行一项「标签: 数据」
function recLines(rec, isLora, weight) {
    const out = [];
    if (isLora) {
        // LoRA 不展示 cfg，优先展示 weight
        if (hasVal(weight)) out.push(`weight: ${weight}`);
    } else {
        if (hasVal(rec.cfg)) out.push(`cfg: ${fmtRange(rec.cfg)}`);
    }
    if (hasVal(rec.steps)) out.push(`steps: ${fmtRange(rec.steps)}`);

    const ss = Array.isArray(rec.sampler) ? rec.sampler : (hasVal(rec.sampler) ? [rec.sampler] : []);
    const tt = Array.isArray(rec.scheduler) ? rec.scheduler : (hasVal(rec.scheduler) ? [rec.scheduler] : []);
    const n = Math.min(ss.length, tt.length);
    for (let i = 0; i < n; i++) {
        out.push(`${i === 0 ? "sampler: " : "         "}${ss[i]}/${tt[i]}`);
    }
    return out;
}

function setupNode(node, nodeData) {
    const isCkpt = nodeData.name === "ZhuleCheckpointLoader";
    const isLora = nodeData.name === "ZhuleLoraLoader";
    if (!isCkpt && !isLora) return;

    const widgetName = isCkpt ? "ckpt_name" : "lora_name";
    const apiType = isCkpt ? "checkpoint" : "lora";

    // 容器
    const wrap = document.createElement("div");
    wrap.style.cssText = `
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: 4px 8px;
        background: #0f0f0f;
        border-radius: 4px;
        margin: 2px 0;
        font-family: Consolas, Monaco, monospace;
        font-size: 12px;
        box-sizing: border-box;
        overflow: hidden;
    `;

    const archLine = document.createElement("div");
    archLine.textContent = "📌 …";
    archLine.style.cssText = `
        color: #888;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        line-height: 1.4;
    `;
    wrap.appendChild(archLine);

    let wordsLine = null;
    if (isLora) {
        wordsLine = document.createElement("div");
        wordsLine.textContent = "🏷 …";
        wordsLine.style.cssText = `
            color: #888;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            line-height: 1.4;
        `;
        wrap.appendChild(wordsLine);
    }

    const recLine = document.createElement("div");
    recLine.textContent = "⚙ …";
    recLine.style.cssText = `
        color: #8a8;
        white-space: pre-line;
        overflow: hidden;
        line-height: 1.4;
        word-break: break-all;
    `;
    wrap.appendChild(recLine);

    const domWidget = node.addDOMWidget(
        "arch_info_display", "div", wrap,
        { serialize: false, hideOnZoom: false }
    );

    // 动态高度：arch(1) + [words(1)] + 推荐行数(recRows)
    let recRows = 1;
    domWidget.computeSize = (width) => [width, Math.round(17 * (1 + (isLora ? 1 : 0) + recRows) + 6)];

    let lastQuery = null;
    let lastWeight = null;

    function setRecLines(lines) {
        if (!lines || lines.length === 0) {
            recLine.textContent = "⚙ 无推荐参数";
            recLine.style.color = "#666";
            recLine.title = "";
            recRows = 1;
            return;
        }
        recLine.textContent = "⚙ " + lines.join("\n");
        recLine.style.color = "#8a8";
        recLine.title = lines.join("  ");
        recRows = lines.length;
    }

    // 切换模型后：manual_* widget 自动同步为配置的默认数据（Checkpoint）
    function syncManualDefaults(rec) {
        if (!isCkpt || !rec) return;
        // 数值取值：单值直接用；二元 [min,max] 视为范围取中值；档位列表取第一档
        const pickNum = (v) => {
            if (Array.isArray(v)) {
                const nums = v.filter(x => typeof x === "number");
                if (nums.length === 0) return null;
                if (nums.length === 1) return nums[0];
                if (nums.length === 2) return (nums[0] + nums[1]) / 2;
                return nums[0];
            }
            return (typeof v === "number" && Number.isFinite(v)) ? v : null;
        };

        const cfg = pickNum(rec.cfg);
        if (cfg !== null) {
            const w = node.widgets?.find(x => x.name === "manual_cfg");
            if (w) w.value = Number(cfg) || 0;
        }
        const steps = pickNum(rec.steps);
        if (steps !== null) {
            const w = node.widgets?.find(x => x.name === "manual_steps");
            if (w) w.value = Number.parseInt(steps, 10) || 0;
        }

        // 下拉框选项收窄：只从配置里有的选，并重置为该模型第一个默认值
        const apply = (wName, values) => {
            if (!Array.isArray(values) || values.length === 0) return;
            const uniq = [...new Set(values.map(String))];
            if (uniq.length === 0) return;
            const w = node.widgets?.find(x => x.name === wName);
            if (!w) return;
            if (Array.isArray(w.options)) {
                w.options = uniq;
            } else {
                w.options = w.options || {};
                w.options.values = uniq;
            }
            w.value = uniq[0];
        };
        apply("manual_sampler", rec.sampler);
        apply("manual_scheduler", rec.scheduler);
    }

    // LoRA auto 模式：把 strength_model widget 同步为 JSON weight
    function syncLoraWeight(weight) {
        if (!isLora || weight === undefined || weight === null) return;
        lastWeight = weight;
        const sm = node.widgets?.find(x => x.name === "strength_model");
        if (sm && sm.value !== weight) sm.value = weight;
    }

    async function updateArch(filename) {
        if (filename === lastQuery) return;
        lastQuery = filename;

        if (!filename || filename === "<none>") {
            archLine.textContent = "📌 未选择";
            archLine.style.color = "#888";
            if (wordsLine) {
                wordsLine.textContent = "🏷 —";
                wordsLine.style.color = "#888";
            }
            recLine.textContent = "⚙ —";
            recLine.style.color = "#888";
            return;
        }

        archLine.textContent = "📌 查询中…";
        archLine.style.color = "#888";
        if (wordsLine) {
            wordsLine.textContent = "🏷 查询中…";
            wordsLine.style.color = "#888";
        }
        recLine.textContent = "⚙ 查询中…";
        recLine.style.color = "#888";

        try {
            const params = new URLSearchParams({ type: apiType, name: filename });
            const resp = await fetch(`/zhule/model_arch?${params}`);
            const data = await resp.json();
            const arch = data.arch || "Unknown";
            const words = data.trained_words || "";
            const rec = data.recommended || {};

            archLine.textContent = `📌 ${arch}`;
            archLine.style.color = colorFor(arch);

            if (wordsLine) {
                if (words) {
                    wordsLine.textContent = `🏷 ${words}`;
                    wordsLine.style.color = "#c8a8ff";
                    wordsLine.title = words;
                } else {
                    wordsLine.textContent = "🏷 无触发词";
                    wordsLine.style.color = "#666";
                    wordsLine.title = "";
                }
            }

            setRecLines(recLines(rec, isLora, data.weight));
            syncManualDefaults(rec);
            syncLoraWeight(data.weight);

            console.log(`[ZhuleLoaderArch] ${filename} → arch=${arch} words=${words} rec=${JSON.stringify(rec)} weight=${data.weight}`);
        } catch (e) {
            archLine.textContent = "📌 查询失败";
            archLine.style.color = "#f66";
            if (wordsLine) {
                wordsLine.textContent = "🏷 —";
                wordsLine.style.color = "#f66";
            }
            recLine.textContent = "⚙ —";
            recLine.style.color = "#f66";
            console.error("[ZhuleLoaderArch]", e);
        }
    }

    setTimeout(() => {
        const w = node.widgets?.find(x => x.name === widgetName);
        if (!w) {
            console.log(`[ZhuleLoaderArch] 未找到 widget: ${widgetName}`);
            return;
        }
        const orig = w.callback;
        w.callback = function (value, ...args) {
            const r = orig?.apply(this, [value, ...args]);
            updateArch(value);
            return r;
        };
        if (w.value) updateArch(w.value);

    }, 100);

    const origOnConfigure = node.onConfigure;
    node.onConfigure = function () {
        const r = origOnConfigure?.apply(this, arguments);
        setTimeout(() => {
            const w = node.widgets?.find(x => x.name === widgetName);
            if (w?.value) {
                lastQuery = null;
                updateArch(w.value);
            }
        }, 300);
        return r;
    };
}

app.registerExtension({
    name: "Zhule.LoaderArch",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        const isCkpt = nodeData.name === "ZhuleCheckpointLoader";
        const isLora = nodeData.name === "ZhuleLoraLoader";
        if (!isCkpt && !isLora) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = onNodeCreated?.apply(this, arguments);
            setupNode(this, nodeData);
            return result;
        };
    },
});
