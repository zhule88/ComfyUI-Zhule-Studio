// 图片详情弹层（图库 / 词库共用）
// 模板取自图库原版详情弹层，一字未改结构；所有数据与方法统一通过 props.g 取：
//   - 图库页（Gallery.js / GalleryTopDown.js）传 setup 代理，即 useGalleryCommon 的整套状态与方法；
//   - 词库页传 createDetailHost() 生成的适配对象（数据仍走图库详情接口，界面与图库完全一致）。
import { computed, reactive, ref } from 'vue';
import { fmtTime, fmtSize, fmtModel, tagKey, leafName, jfetch, API } from './galleryCommon.js';

const TAG_FALLBACK = '#2a9d8f';
const API_IMAGE = '/zhule_studio/api/gallery/image';

function readGalleryPref() {
  try {
    const raw = localStorage.getItem('zhule_ui_pref');
    const p = raw ? JSON.parse(raw) : {};
    return (p && p.gallery) || {};
  } catch (e) {
    return {};
  }
}
// 标签配色：与图库同一套规则（全局种子散列 / 统一色 / 分区配置）
function seedHash(name, seed) {
  const s = String(seed || readGalleryPref().tagSeed || '') + '|' + String(name);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h >>>= 0;
  const hue = h % 360;
  const sat = 60 + (h % 4) * 6;
  const lit = 38 + (h % 3) * 5;
  return 'hsl(' + hue + ', ' + sat + '%, ' + lit + '%)';
}
// 详情标签配色：统一跟随图库设置里的「图片详情区颜色」（areas.detail）。
// 词库复用的也是这同一个弹层，所以词库打开的图片详情同样跟随图库这一项，不另设开关。
function detailColor(name) {
  const gp = readGalleryPref();
  const tc = gp.tagColor;
  const area = tc && tc.areas && tc.areas.detail;
  if (!area) {
    // 旧存档兜底：没有 detail 分区时按旧的全局规则取色
    if (tc && tc.globalMode === 'same') return tc.globalColor || TAG_FALLBACK;
    return seedHash(name, gp.tagSeed);
  }
  if (area.mode === 'same') return area.color || TAG_FALLBACK;
  return seedHash(name, area.seed ? area.seed : gp.tagSeed);
}

// 词库侧适配器：把「图库详情」需要的全部成员装成一份 reactive 对象，
// 数据通过图库详情接口按 path 拉取，展示与原图库详情弹层同一模板。
export function createDetailHost(opts = {}) {
  const onClose = typeof opts.onClose === 'function' ? opts.onClose : () => {};
  const onZoom = typeof opts.onZoom === 'function' ? opts.onZoom : null;
  const onCopied = typeof opts.onCopied === 'function' ? opts.onCopied : null;
  const onError = typeof opts.onError === 'function' ? opts.onError : null;
  // 导航池回调：词库侧传入「在该词条参考图内翻」，图库侧不传则保持 noop
  const onNav = typeof opts.onNav === 'function' ? opts.onNav : null;
  const onNavRandom = typeof opts.onNavRandom === 'function' ? opts.onNavRandom : null;
  const onDelete = typeof opts.onDelete === 'function' ? opts.onDelete : null;
  // 文案可按场景覆写（词库的垃圾桶删的是参考图，不是图库原图记录）
  const tips = opts.tips || {};
  const deleteTip = tips.delete || '删除当前图片及其库内关联数据';
  const renameTip = tips.rename || '双击重命名（自动保留扩展名）';
  const emptyTagTip = tips.emptyTag || '暂无标签，点击下方 ＋ 添加';
  const poolTip = tips.pool || '当前命中池';
  // 图片来源可覆写：图库用 gallery/image（zhule_img 区），词库参考图走 api/image，
  // 否则词库图在 gallery/image 下必然 404，弹层打开也是空白。
  const imgUrlFn = typeof opts.imgUrl === 'function' ? opts.imgUrl : null;
  const detailRef = ref(null);
  const fileRenameInput = ref(null);
  const tagInputEl = ref(null);

  const colorMap = computed(() => {
    const m = {};
    ((detailRef.value && detailRef.value.tags) || []).forEach((t) => { if (t && t.name) m[t.name] = detailColor(t.name); });
    return m;
  });
  const promptDetailTags = computed(() => {
    const d = detailRef.value;
    if (!d) return [];
    const seen = new Set();
    return (d.tags || []).filter((t) => {
      if (!t || !t.prompt) return false;
      const n = t.name;
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  });
  const customFlatTags = computed(() => {
    const d = detailRef.value;
    if (!d) return [];
    return (d.tags || [])
      .filter((t) => t && t.custom)
      .map((t) => ({ ...t, display: leafName(t.name), style: tagStyle(t) }));
  });
  const enSegments = computed(() => {
    const d = detailRef.value;
    const map = colorMap.value;
    if (!d || !d.promptPreview) return [];
    const text = d.promptPreview;
    const matches = (d.tags || []).filter((t) => !(t && t.custom)).map((t) => {
      const en = t && t.en ? String(t.en).trim() : '';
      const name = t && t.name ? String(t.name).trim() : '';
      const pat = en || (name && !/[\u4e00-\u9fff]/.test(name) ? name : '');
      return { pat, color: map[name] || '' };
    }).filter((m) => m.pat && m.color);
    if (!matches.length) return [{ text, color: '' }];
    matches.sort((a, b) => b.pat.length - a.pat.length);
    const lower = text.toLowerCase();
    const hits = [];
    for (const m of matches) {
      const key = m.pat.toLowerCase();
      let idx = 0;
      while (true) {
        const pos = lower.indexOf(key, idx);
        if (pos < 0) break;
        const before = pos > 0 ? lower[pos - 1] : '';
        const after = pos + key.length < lower.length ? lower[pos + key.length] : '';
        if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
          hits.push({ start: pos, end: pos + key.length, color: m.color });
        }
        idx = pos + key.length;
      }
    }
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    const segs = [];
    let pos = 0;
    for (const h of hits) {
      if (h.start < pos) continue;
      if (h.start > pos) segs.push({ text: text.slice(pos, h.start), color: '' });
      segs.push({ text: text.slice(h.start, h.end), color: h.color });
      pos = h.end;
    }
    if (pos < text.length) segs.push({ text: text.slice(pos), color: '' });
    return segs;
  });
  const cnSegments = computed(() => {
    const d = detailRef.value;
    const map = colorMap.value;
    if (!d || !d.tags) return [];
    const segs = [];
    let first = true;
    (d.tags || []).forEach((t) => {
      const cn = t && t.cn ? String(t.cn).trim() : '';
      if (!cn) return;
      segs.push({ text: (first ? '' : '，') + cn, color: map[t.name] || '' });
      first = false;
    });
    return segs;
  });
  // 主题（深色/浅色/描边）已废弃，固定浅色；圆角跟随图库「边角」，质感跟随图库「主题」（胶囊时不挂类）
  const tagThemeClass = computed(() => {
  const st = gp.tagStyle || 'capsule';
  const stCls = (st && st !== 'capsule') ? ' zhg-theme-' + st : '';
  return 'zhg-tag-theme-light' + (gp.tagRound === false ? ' zhg-tag-square' : '') + stCls;
});
  function tagStyle(t) {
    if (!t || !t.name) return null;
    const c = colorMap.value[t.name] || detailColor(t.name) || TAG_FALLBACK;
    return c ? { '--tag-bg': c } : null;
  }
  const noop = () => {};

  // 打开详情（正式入口）：按图库 id 取，gallery_image 主键是唯一寻址方式，
  // 词库参考图经卡片的 imageGids 拿到 id 后走这里；接口取不到时用调用方 fallback() 造同结构数据。
  async function openById(gid, fallback) {
    const g = String(gid == null ? '' : gid).trim();
    if (!/^\d+$/.test(g) || g === '0') return openByPath(null, fallback);
    try {
      const d = await jfetch(API.detail + '?id=' + encodeURIComponent(g));
      // 接口 200 但数据不指向具体图片时同样视为失败，避免 detail 被置空、弹层不出现
      if (d && (d.path || d.name)) { detailRef.value = d; return d; }
      throw new Error('详情数据为空');
    } catch (e) {
      if (typeof fallback === 'function') {
        const d2 = fallback();
        if (d2) { detailRef.value = d2; return d2; }
      }
      if (onError) onError(e);
      return null;
    }
  }
  // 打开详情（仅存量路径入口）：图库页自身只用相对路径的旧数据走这里，不做名字反查
  async function openByPath(path, fallback) {
    if (!path) {
      if (typeof fallback === 'function') {
        const d0 = fallback();
        if (d0) { detailRef.value = d0; return d0; }
      }
      return null;
    }
    try {
      const d = await jfetch(API.detail + '?path=' + encodeURIComponent(path));
      // 接口 200 但数据不指向具体图片时同样视为失败，避免 detail 被置空、弹层不出现
      if (d && (d.path || d.name)) { detailRef.value = d; return d; }
      throw new Error('详情数据为空');
    } catch (e) {
      if (typeof fallback === 'function') {
        const d2 = fallback();
        if (d2) { detailRef.value = d2; return d2; }
      }
      if (onError) onError(e);
      return null;
    }
  }
  // 直接喂一份同结构数据打开弹层（词库参考图不在图库索引里，无需再问接口）
  function setDetail(d) {
    if (!d) return null;
    detailRef.value = d;
    return d;
  }

  const host = reactive({
    detail: detailRef,
    fileRenaming: false,
    fileRenameVal: '',
    fileRenameInput,
    tagInputing: false,
    quickTag: '',
    tagInputEl,
    hitTotal: 0,
    detailPos: 0,
    colorMap,
    promptDetailTags,
    customFlatTags,
    enSegments,
    cnSegments,
    tagThemeClass,
    tagStyle,
    tagKey,
    fmtTime: (ts) => fmtTime(ts),
    fmtSize: (n) => fmtSize(n),
    fmtModel: (n) => fmtModel(n),
    imgUrl: (key, t) => (imgUrlFn ? imgUrlFn(key, t) : API_IMAGE + '?path=' + encodeURIComponent(key) + '&t=' + (t || '')),
    fileDisplayName: (d) => (d && d.name) || '',
    closeDetail: () => { detailRef.value = null; onClose(); },
    zoomView: (url, caption) => { if (onZoom) onZoom(url, caption); },
    copyPrompt: async () => {
      const d = detailRef.value;
      if (!d || !d.promptPreview) return;
      try {
        await navigator.clipboard.writeText(d.promptPreview);
        if (onCopied) onCopied();
      } catch (e) { /* 剪贴板不可用时静默 */ }
    },
    openById,
    openByPath,
    setDetail,
    askDelete: (d) => { if (onDelete) onDelete(d); },
    useWorkflow: noop,
    gotoWordbank: noop,
    addDetailTagToFilter: noop,
    editDetailTag: noop,
    askDeleteTag: noop,
    startTagInput: noop,
    onTagKeyup: noop,
    onTagInputBlur: noop,
    quickCreateTag: noop,
    detailNav: (dir) => { if (onNav) onNav(dir); },
    detailNavRandom: () => { if (onNavRandom) onNavRandom(); },
    deleteTip,
    renameTip,
    emptyTagTip,
    poolTip,
    beginFileRename: noop,
    commitFileRename: noop,
    cancelFileRename: noop,
  });
  return host;
}

// 详情弹层组件：readonly = 词库只读（隐藏「→ 词库」与标签编辑区），showNav = 图库命中池导航/删除/工作流
export const GalleryDetailModal = {
  name: 'GalleryDetailModal',
  props: {
    g: { type: Object, required: true },
    readonly: { type: Boolean, default: false },
    showNav: { type: Boolean, default: true },
    // 标签编辑区（＋添加标签）是否展示；图库默认开，词库侧未接图库标注链路时显式关掉
    tagEdit: { type: Boolean, default: true },
  },
  setup(props) {
    // 模板里的输入框 ref 要落回调用方（图库实例）自己的 ref 变量，自动聚焦/重命名逻辑才照旧生效
    function setEl(key, el) {
      // 图库实例：setupState 是 proxyRefs，赋值会自动落到原 ref 上
      const inst = props.g && props.g.$;
      const state = inst && inst.setupState;
      if (state && key in state) { state[key] = el; return; }
      // 词库适配对象：reactive 里的 ref 同样自动解包
      if (props.g && key in props.g) props.g[key] = el;
    }
    // 模板统一用 G.xxx 访问调用方传入的适配对象（props.g），这里补别名，否则 G 未定义会让弹层渲染静默失败、点了没反应
    return { setEl, G: props.g };
  },
  template: `
    <div class="zhg-mask" v-if="G.detail" @click.self="G.closeDetail">
      <div class="zhg-modal">
        <div class="zhg-modal-head">
          <span class="zhg-modal-title">{{ G.detail.name }}</span>
          <button class="btn zhg-mini" @click="G.closeDetail">✕ 关闭</button>
        </div>
        <div class="zhg-modal-body">
          <div class="zhg-modal-left">
            <div class="zhg-modal-imgwrap">
              <img class="zhg-modal-img" :src="G.imgUrl(G.detail.path, G.detail.mtime)" :alt="G.detail.name" @click="G.zoomView(G.imgUrl(G.detail.path, G.detail.mtime))">
              <div class="zhg-modal-nav" v-if="G.detail && showNav">
                <button class="zhg-nav-btn zhg-nav-prev" @click.stop="G.detailNav(-1)" :data-tip="'上一张：在' + (G.poolTip || '当前命中池') + '内向前翻'">‹</button>
                <div class="zhg-nav-mid">
                  <button class="zhg-nav-btn zhg-nav-dice" @click.stop="G.detailNavRandom" :data-tip="'骰子：从' + (G.poolTip || '当前命中池') + '随机一张（共 ' + G.hitTotal + ' 张）'">🎲</button>
                  <span class="zhg-nav-count" v-if="G.hitTotal">{{ G.detailPos > 0 ? G.detailPos : '—' }} / {{ G.hitTotal }}</span>
                  <button class="zhg-nav-btn zhg-nav-del" :data-tip="G.deleteTip || '删除当前图片及其库内关联数据'" @click.stop="G.askDelete(G.detail)">🗑</button>
                </div>
                <button class="zhg-nav-btn zhg-nav-next" @click.stop="G.detailNav(1)" :data-tip="'下一张：在' + (G.poolTip || '当前命中池') + '内向后翻'">›</button>
              </div>
            </div>
            <div class="zhg-modal-actions" v-if="showNav">
              <button class="btn primary" :disabled="!G.detail.hasWF" @click="G.useWorkflow(G.detail)" :data-tip="G.detail.hasWF ? '跳转 ComfyUI 并导入该图工作流' : '该图片没有保存 workflow 元数据'">
                ⚡ 在 ComfyUI 中使用工作流
              </button>
            </div>
          </div>
          <div class="zhg-modal-right">
            <div class="zhg-detail-row"><span class="zhg-detail-k">文件</span><span class="zhg-detail-v zhg-file-cell" :data-tip="G.fileRenaming ? '' : (G.renameTip || '双击重命名（自动保留扩展名）')" @dblclick.stop="G.beginFileRename">
                <template v-if="!G.fileRenaming">{{ G.fileDisplayName(G.detail) }}</template>
                <input v-else class="zhg-file-input" :ref="(el) => setEl('fileRenameInput', el)" v-model="G.fileRenameVal"
                       @keyup.enter="G.commitFileRename" @keyup.esc="G.cancelFileRename"
                       @blur="G.commitFileRename" @click.stop @dblclick.stop>
              </span></div>
            <div class="zhg-detail-row" v-if="G.detail.mtime"><span class="zhg-detail-k">时间</span><span class="zhg-detail-v">{{ G.fmtTime(G.detail.mtime) }}</span></div>
            <div class="zhg-detail-row" v-if="G.detail.size"><span class="zhg-detail-k">大小</span><span class="zhg-detail-v">{{ G.fmtSize(G.detail.size) }}</span></div>
            <div class="zhg-detail-row" v-if="G.detail.model"><span class="zhg-detail-k">模型</span>
              <span class="zhg-detail-v" :data-tip="G.detail.model || ''">{{ G.detail.model ? G.fmtModel(G.detail.model) : '—' }}</span></div>
            <div class="zhg-detail-row"><span class="zhg-detail-k">LoRA</span>
              <div class="zhg-detail-v zhg-detail-tags">
                <span class="zhg-lora" v-for="l in G.detail.loras" :key="'dl'+l">{{ l }}</span>
                <span v-if="!G.detail.loras.length">—</span>
              </div></div>

            <div class="zhg-detail-section">
              <div class="zhg-detail-section-title">标签 <span class="zhg-badge">{{ G.detail.tags.length }}</span>
                <!-- 图库 → 词库：把这张图的提示词标签按 id 带过去填入「已选」，bind 沿用本页 URL 上的节点 ID -->
                <button v-if="!readonly" class="zhg-detail-btn" @click.stop="G.gotoWordbank"
                        data-tip="把这张图的提示词标签带入词库「已选」（按词条 ID 定位，同标签页打开）">→ 词库</button>
              </div>
              <div class="zhg-detail-row">
                <div class="zhg-detail-tags">
                  <!-- 提示词标签（词库词条）在前：只读，左键放入筛选区并启用、右键编辑词条 -->
                  <span class="zhg-tag readonly hl-prompt"
                        :class="G.tagThemeClass"
                        :style="G.tagStyle(t)"
                        v-for="t in G.promptDetailTags" :key="'dtp'+t.name"
                        @click.stop="G.addDetailTagToFilter(t)"
                        @contextmenu.prevent="G.editDetailTag(t)"
                        :data-tip="'提示词标签（运行时注入，只读）左键放入筛选区并启用，右键编辑词条'">
                    {{ t.name }}
                  </span>
                  <!-- 自定义标签（平铺叶子）：只显示叶子名（如 '喜欢'），父级分组不出现在展示层；左键编辑词条、右键删除 -->
                  <span class="zhg-tag hl-custom" :class="[G.tagThemeClass]"
                        :style="t.style || {}"
                        :data-tip="'自定义标签，左键编辑词条，右键删除'"
                        v-for="t in G.customFlatTags" :key="'dtc' + G.tagKey(t)"
                        @click.stop="G.editDetailTag(t)" @contextmenu.prevent="G.askDeleteTag(t)">
                    {{ t.display }}
                  </span>
                  <span v-if="!G.promptDetailTags.length && !G.customFlatTags.length" class="zhg-none">{{ G.emptyTagTip || '暂无标签，点击下方 ＋ 添加' }}</span>
                </div>
              </div>
              <div class="zhg-detail-tag-add" v-if="tagEdit">
                <span class="zhg-tag-add" v-if="!G.tagInputing" @click="G.startTagInput">＋ 添加标签</span>
                <div class="zhg-new-row" v-else>
                  <input class="zhg-input" v-model="G.quickTag" :ref="(el) => setEl('tagInputEl', el)" placeholder="输入标签后回车…"
                         @keyup="G.onTagKeyup" @blur="G.onTagInputBlur">
                  <button class="btn zhg-mini" @click="G.quickCreateTag">确定</button>
                </div>
              </div>
            </div>

            <div class="zhg-detail-section" v-if="G.detail.hasPrompt">
              <div class="zhg-detail-section-title">提示词 <span class="zhg-detail-hint">（英文）</span>
                <button class="zhg-prompt-copy" @click="G.copyPrompt">复制</button>
              </div>
              <pre class="zhg-prompt"><template v-for="(s, i) in G.enSegments" :key="'en'+i"><span v-if="s.color" class="zhg-hl" :style="{ background: s.color }">{{ s.text }}</span><span v-else>{{ s.text }}</span></template></pre>
              <div class="zhg-prompt-more" v-if="G.detail.promptPreview.length >= 790">…（已截断）</div>
              <div class="zhg-detail-section-title zhg-cn-title">中文提示词 <span class="zhg-detail-hint">（由标签拼接）</span></div>
              <pre class="zhg-prompt zhg-prompt-cn"><template v-for="(s, i) in G.cnSegments" :key="'cn'+i"><span v-if="s.color" class="zhg-hl" :style="{ background: s.color }">{{ s.text }}</span><span v-else>{{ s.text }}</span></template><template v-if="!G.cnSegments.length">暂无中文提示词</template></pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
