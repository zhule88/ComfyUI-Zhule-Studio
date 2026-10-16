import { app } from "../../scripts/app.js";

console.log("%c[ZhuleStudio] LOADED (links)", "color:#0ff;font-weight:bold");

const NODE_TYPE = "ZhuleStudio";
const CHANNEL_NAME = "zhule-studio";
const BIND_WIDGET = "ID";

// 同源标签页间的通信通道：词库页发选词 → 各画布页在自己的工作流里按ID认领
const channel = new BroadcastChannel(CHANNEL_NAME);

// 多标签页去重：同一 bindId 且同一运行轮次（seq）的 zhule:run 在窗口期内只允许一个页面处理。
// 若用户开着多个画布标签页且含相同ID，每个页面都会收到广播并各自 queuePrompt，
// 一次运行会生成多份图。认领窗口 + claimed 广播能挡住绝大多数重复（毫秒级竞态不可完全消除）。
// seq 缺失（旧词库页）时按 0 处理，仍走窗口去重；新词库页每次运行 seq 递增，不会误伤连续运行。
const RUN_CLAIM_WINDOW_MS = 3000;
const claimedRuns = new Map(); // bindId -> { t: lastClaimAt, seq: runSeq }

function makeLinkButton(text, bg, border) {
  const b = document.createElement("button");
  b.textContent = text;
  b.style.cssText = `
        flex:1; padding:7px 0; font-size:14px; cursor:pointer;
        background:${bg}; color:#fff;
        border:1px solid ${border}; border-radius:5px;
        line-height:1.2; text-align:center;
        font-family: -apple-system, BlinkMacSystemFont, "Microsoft YaHei", sans-serif;
    `;
  b.onmouseenter = () => { b.style.filter = "brightness(1.15)"; };
  b.onmouseleave = () => { b.style.filter = ""; };
  return b;
}

function getBindValue(node) {
  const w = (node.widgets || []).find((x) => x.name === BIND_WIDGET);
  return w ? String(w.value || "") : "";
}

// 兜底确保节点上有可序列化的 _selected widget：
// 前端新版不会为 hidden 输入生成 widget（node.widgets 里查不到），
// 这里显式创建一个隐藏 widget，值随 graphToPrompt 写入 prompt（后端 hidden 输入原样接收）。
function ensureSelectedWidget(node) {
  let w = (node.widgets || []).find((x) => x.name === "_selected");
  if (!w) {
    w = node.addWidget("text", "_selected", "[]", () => {}, { serialize: true });
    if (w) {
      if (!w.options) w.options = {};
      w.options.serialize = true;
      w.options.hidden = true;
      w.hidden = true; // 不参与节点布局/绘制，但仍会进 prompt
      w.computeSize = () => [0, -4];
    }
  }
  return w;
}

function ack(bindId, ok, error) {
  channel.postMessage({ type: "zhule:ack", bindId, ok, error });
}

async function handleRunMessage(msg) {
  if (!msg || msg.type !== "zhule:run") return;
  const bindId = String(msg.bindId || "");
  if (!bindId) return;

  // 多标签页去重：同一轮次（bindId+seq）在窗口期内已被处理过则跳过，避免多个画布页同时 queuePrompt 生成多份图
  const now = Date.now();
  const seq = Number(msg.seq) || 0;
  const prev = claimedRuns.get(bindId);
  if (prev && prev.seq === seq && now - prev.t < RUN_CLAIM_WINDOW_MS) return;
  claimedRuns.set(bindId, { t: now, seq });

  // 广播认领声明：其他标签页收到后会在窗口期内跳过同一轮次的 run（异步竞态下仍可能有毫秒级重复，已大幅收敛）
  try { channel.postMessage({ type: "zhule:claimed", bindId, seq }); } catch (e) { /* 忽略 */ }

  // 在自己的工作流里找ID匹配的节点（用户保证全局唯一，因此只有目标工作流会认领）
  const nodes = app.graph?._nodes || [];
  const node = nodes.find((n) => n.type === NODE_TYPE && getBindValue(n) === bindId);
  if (!node) return; // 本工作流没有这个ID，忽略（不打扰其他工作流）

  const w = ensureSelectedWidget(node);
  if (!w) {
    ack(bindId, false, "节点缺少 _selected 字段");
    return;
  }

  // 写入网页选词；显式保证前端序列化进 prompt（勿依赖 hidden 默认行为）
  // 对象格式 {name, content}：name=词条名（节点 tags 输出 / SaveImage 提取标签用），content=提示词文本
  const items = Array.isArray(msg.items) ? msg.items.map((s) => {
    if (s && typeof s === 'object' && !Array.isArray(s)) {
      return { name: String(s.name || ''), content: String(s.content || '') };
    }
    // 兼容纯字符串消息：无 name 时节点 tags 输出为空，SaveImage 回退存原字符串
    return { name: '', content: String(s) };
  }) : [];
  w.value = JSON.stringify(items);
  if (!w.options) w.options = {};
  w.options.serialize = true;
  w.callback?.(w.value);

  try {
    const count = Math.max(1, Math.min(99, Number(msg.count) || 1));
    // 走前端当前画布实时状态，与手动点 Run 等价（内部会重新 graphToPrompt）
    await app.queuePrompt(count);
    ack(bindId, true);
  } catch (e) {
    ack(bindId, false, String(e?.message || e));
  }
}

channel.onmessage = (ev) => {
  const d = ev.data;
  if (!d) return;
  // 其他标签页的认领声明：窗口期内跳过同一轮次的 run，防止重复 queuePrompt
  if (d.type === "zhule:claimed") {
    const bid = String(d.bindId || "");
    if (bid) claimedRuns.set(bid, { t: Date.now(), seq: Number(d.seq) || 0 });
    return;
  }
  void handleRunMessage(d);
};

app.registerExtension({
  name: "Zhule.StudioLinks",

  async setup() {
    // 图库页「在 ComfyUI 中使用工作流」：localStorage 暂存 workflow JSON → 首页导入
    try {
      const wf = localStorage.getItem("zhule_import_workflow");
      if (wf) {
        localStorage.removeItem("zhule_import_workflow");
        const graph = JSON.parse(wf);
        if (graph && typeof app.loadGraphData === "function") {
          await app.loadGraphData(graph, true);
          setTimeout(() => alert("已从图库导入工作流，可点击 Run 重新生成。"), 300);
        }
      }
    } catch (e) {
      console.error("[ZhuleStudio] 导入工作流失败", e);
    }
  },

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const result = onNodeCreated?.apply(this, arguments);
      const node = this;

      const root = document.createElement("div");
      root.style.cssText = "display:flex; gap:8px; padding:6px 8px; width:100%; box-sizing:border-box;";

      const wordBtn = makeLinkButton("词库", "#1f6feb", "#4c8ff0");
      wordBtn.title = "打开词库页（按ID定位本节点）";
      wordBtn.addEventListener("click", () => {
        const bind = getBindValue(node);
        if (!bind) {
          alert("请先在本节点的「ID」字段填写全局ID");
          return;
        }
        const url = "/zhule_studio#/wordbank?bind=" + encodeURIComponent(bind);
        window.open(url, "_blank");
      });

      const galleryBtn = makeLinkButton("图库", "#1a7f37", "#3fb950");
      galleryBtn.title = "打开图库页（按节点ID过滤）";
      galleryBtn.addEventListener("click", () => {
        const bind = getBindValue(node);
        const url = bind ? "/zhule_studio#/gallery?bind=" + encodeURIComponent(bind) : "/zhule_studio#/gallery";
        window.open(url, "_blank");
      });

      root.appendChild(wordBtn);
      root.appendChild(galleryBtn);

      setTimeout(() => {
        // 兜底创建隐藏的 _selected widget（新节点创建即具备，并随工作流持久化）
        ensureSelectedWidget(node);

        const w = node.addDOMWidget("studio_links", "div", root, {
          serialize: false,
          hideOnZoom: false,
        });
        if (w) {
          w.computeSize = () => [Math.max(node.size?.[0] || 260, 220) - 20, 40];
        }
      }, 60);

      return result;
    };
  },
});
