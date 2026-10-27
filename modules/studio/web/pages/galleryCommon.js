// galleryCommon.js —— 图库双布局公共逻辑（方案A：抽取 composable）
// 说明：GalleryTopDown.js（/gallery 上下布局）与 Gallery.js（/gallery-side 侧边布局）
// 除布局模板与筛选区拖拽参数外完全一致，公共逻辑统一收拢到本模块：
// 列表加载/筛选/删除/导出、详情弹层（tag 随机色 + 提示词高亮 + 右键改色）、
// 框选多选、外部过滤区（隐藏=完全移除，不可逆语义统一）、标签状态持久化。
// 布局差异通过 useGalleryCommon(opts) 参数化：
//   opts.side = { initW, initH, wMin, wMax, hMin, hMax }  侧边/筛选区尺寸初始值与拖拽范围
//   opts.onPrefChangedExtra(p, prev)  设置变化后的布局独有回调（如上下布局筛选块重排）
//   opts.onMountedExtra()             挂载后布局独有回调
import { ref, reactive, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import TagTreePanel from './tagTreePanel.js';
import { useMarqueeSelect } from './marqueeSelect.js';

export { TagTreePanel, OutNode };

export const API = {
  list: '/zhule_studio/api/gallery',
  meta: '/zhule_studio/api/gallery/meta',
  detail: '/zhule_studio/api/gallery/detail',
  workflow: '/zhule_studio/api/gallery/workflow',
  thumb: '/zhule_studio/api/gallery/thumb',
  tag: '/zhule_studio/api/gallery/tag',
  annotate: '/zhule_studio/api/gallery/annotate',
  rename: '/zhule_studio/api/gallery/rename',
  rescan: '/zhule_studio/api/gallery/rescan',
  del: '/zhule_studio/api/gallery/delete',
  batchDel: '/zhule_studio/api/gallery/batch-delete',
  link: '/zhule_studio/api/gallery/batch-link',
};
export const PAGE_SIZE = 60;

// 外部过滤区递归节点：俄罗斯套娃包裹式展开（与 tagTreePanel 视觉一致，尺寸随子树深度放大）
// 隐藏语义统一：Ctrl+左键 = 完全移除（不可逆，恢复靠编辑面板 tagTreePanel 重新左键点击放置）
const OutNode = {
  name: 'OutNode',
  props: {
    node: { type: Object, required: true },
    depth: { type: Number, default: 0 },
    inFilter: { type: Function, required: true },
    isActive: { type: Function, required: true },
    isHidden: { type: Function, default: null },
    treeKidsFn: { type: Function, default: null },
  },
  emits: ['toggle', 'add', 'hide'],
  setup(props, { emit }) {
    const expanded = ref(false);
    // 子节点取自树数据（tagTreeKidsMap），与 tagTreePanel 共用同一棵树；无树数据时退回 node.children
    // 隐藏 = 完全移除：树内递归渲染同样过滤掉 hidden 项（等价 v-if=false），隐藏大标签时整棵子树随之消失
    const kids = () => {
      const all = props.treeKidsFn ? props.treeKidsFn(props.node.name) : (props.node.children || []);
      return props.isHidden ? all.filter((c) => !props.isHidden(c.name)) : all;
    };
    const hasKids = () => kids().length > 0;
    // 子树深度：叶子 0；与 tagTreePanel 相同缩放规则 scale=1+depth*0.3，基准 12px
    function subtreeDepth(n) {
      if (!n || !n.children || !n.children.length) return 0;
      let m = 0;
      for (const c of n.children) m = Math.max(m, subtreeDepth(c));
      return 1 + m;
    }
    // 尺寸随子树深度放大（与 TagNode 完全一致）：最外层最大、越内越小
    const chipStyle = () => {
      const scale = 1 + subtreeDepth({ name: props.node.name, children: kids() }) * 0.3;
      return {
        fontSize: Math.round(12 * scale) + 'px',
        padding: Math.round(5 * scale) + 'px ' + Math.round(12 * scale) + 'px',
      };
    };
    const boxStyle = () => ({ ...chipStyle() });
    function onClick(e) {
      // Ctrl+左键：隐藏（完全移除，不可逆；恢复靠编辑面板 tagTreePanel 重新左键点击放置）
      if (e.ctrlKey) { e.preventDefault(); emit('hide', props.node.name); return; }
      // 普通左键：直接启用/禁用该标签过滤，不产生外部独立标签
      emit('toggle', props.node.name);
    }
    // 右键行为（与 tagTreePanel 编辑面板 Ctrl+右键语义完全一致）：
    // Ctrl+右键：展开还原——已展开则收起自身并拦截；未展开则不拦截、冒泡给父级展开容器逐级向上收起
    // 普通右键：切换展开/收起——chip（未展开）展开子标签，展开容器收起自身并拦截，叶子无动作
    function onCtx(e) {
      e.preventDefault();
      if (e.ctrlKey) {
        if (expanded.value) { expanded.value = false; e.stopPropagation(); }
        return;
      }
      if (expanded.value) {
        expanded.value = false;
        e.stopPropagation();
        return;
      }
      if (hasKids()) expanded.value = true;
      e.stopPropagation();
    }
    function fwdToggle(name) { emit('toggle', name); }
    function fwdAdd(node) { emit('add', node); }
    function fwdHide(name) { emit('hide', name); }
    return {
      expanded, kids, hasKids, chipStyle, boxStyle,
      onClick, onCtx, fwdToggle, fwdAdd, fwdHide,
    };
  },
  template: `
    <div class="zhg-out-wrap" :class="{ open: expanded }">
      <span class="zhg-sel-tag" v-if="!expanded" :class="{ on: isActive(node.name), off: !isActive(node.name), leaf: !hasKids() }" :style="chipStyle()"
            :data-tip="(isActive(node.name) ? '生效中，点击停用' : '待生效，点击启用') + ' / Ctrl+左键隐藏（完全移除） / 右键展开收起'"
            @click="onClick" @contextmenu.prevent="onCtx">
        {{ node.name }}<span v-if="hasKids()" class="zhg-out-arrow">▸</span>
      </span>
      <div class="zhg-out-open" v-else :style="boxStyle()" @contextmenu.prevent="onCtx">
        <out-node v-for="c in kids()" :key="c.name" :node="c" :depth="depth + 1"
                  :in-filter="inFilter" :is-active="isActive" :is-hidden="isHidden" :tree-kids-fn="treeKidsFn"
                  @toggle="fwdToggle" @add="fwdAdd" @hide="fwdHide"></out-node>
      </div>
    </div>
  `,
};

// 通用 fetch：自动携带 JSON / 表单请求体
export async function jfetch(url, opts) {
  const res = await fetch(url, opts || {});
  let data = null;
  try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
  if (!res.ok || (data && data.error)) {
    throw new Error((data && data.error) || res.statusText || '请求失败');
  }
  return data;
}

const DEFAULT_PREF = {
  gallery: {
    showName: true,
    showTime: true,
    showModel: true,
    showTags: true,
    showModelFilter: true,
    showLoraFilter: true,
    timeFmt: 'yyyy-MM-dd HH:mm',
    promptTagColor: '#2a9d8f',
    customTagColor: '#e07b39',
  },
};

function loadPref() {
  try {
    const raw = localStorage.getItem('zhule_ui_pref');
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_PREF));
    const p = JSON.parse(raw);
    const out = JSON.parse(JSON.stringify(DEFAULT_PREF));
    if (p && p.gallery) Object.assign(out.gallery, p.gallery);
    return out;
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_PREF));
  }
}

export function fmtTime(ts, fmt) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const map = {
    yyyy: String(d.getFullYear()),
    MM: p(d.getMonth() + 1),
    dd: p(d.getDate()),
    HH: p(d.getHours()),
    mm: p(d.getMinutes()),
  };
  return (fmt || 'yyyy-MM-dd HH:mm').replace(/yyyy|MM|dd|HH|mm/g, (k) => map[k]);
}

export function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// 展示模型名时去掉 .safetensors 等文件扩展名
export function fmtModel(name) {
  if (!name) return '';
  return name.replace(/\.[^.\/\\]+$/, '');
}

export function useGalleryCommon(opts = {}) {
  const route = useRoute();
  const router = useRouter();
  // ===== [TEST] 图库加载耗时测试：记录进入/刷新页面到列表渲染完成的耗时，定位后删除 =====
  const _GL_T0 = performance.now();
  const _GL_NO_THUMB = false;  // [TEST] 禁缩略图调试开关：true 时所有卡片 img src 置空、不请求缩略图，验证缩略图是否拖慢加载；定位后删除
  function _glPush(lines) {
    try {
      fetch('/zhule_studio/api/log/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub: 'gallery_load_test', lines }),
      }).catch(() => {});
    } catch (e) {}
  }
  // 慢操作节流日志：仅记录 >=30ms 的计算，同一标签 5 秒内最多一条，避免渲染期刷屏
  const pref = reactive(loadPref());
  function onPrefChanged(e) {
    const p = (e && e.detail) || loadPref();
    const prev = JSON.parse(JSON.stringify(pref));
    Object.assign(pref, p);
    if (opts.onPrefChangedExtra) opts.onPrefChangedExtra(p, prev);
  }
  const filters = reactive({ q: '', sortField: 'time', sortDir: 'desc', tags: [], models: [], loras: [], tagMode: 'and' });
  const meta = reactive({ tags: [], models: [], loras: [], total: 0 });
  // 外部过滤区标签状态持久化：filters.tags 完整数组（含 hidden 项）序列化到 localStorage；
  // localStorage 不可用 / 解析失败时静默降级为纯内存（不崩溃、不抛错）
  const TAG_STORAGE_KEY = 'zhule_gallery_tags';
  function saveTagPref() {
    try {
      localStorage.setItem(TAG_STORAGE_KEY, JSON.stringify({ version: 1, tags: filters.tags }));
    } catch (e) { /* ignore: 降级为纯内存 */ }
  }
  function loadTagPref() {
    try {
      const raw = JSON.parse(localStorage.getItem(TAG_STORAGE_KEY) || 'null');
      if (raw && raw.version === 1 && Array.isArray(raw.tags)) {
        const valid = raw.tags
          .filter((t) => t && typeof t.name === 'string')
          .map((t) => ({ name: t.name, rel: t.rel || '', active: !!t.active, hidden: !!t.hidden, inner: !!t.inner }));
        if (valid.length) filters.tags = valid;
      }
    } catch (e) { /* ignore: 解析失败，保留空 tags */ }
  }
  loadTagPref();
  // 整体展开/收起筛选区
  const filtersOpen = ref(false);
  try {
    const saved = localStorage.getItem('zhule_gallery_filters_open');
    if (saved !== null) filtersOpen.value = saved === '1';
  } catch (e) { /* ignore */ }
  function toggleFilters() {
    filtersOpen.value = !filtersOpen.value;
    try { localStorage.setItem('zhule_gallery_filters_open', filtersOpen.value ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  const items = ref([]);
  const total = ref(0);
  const page = ref(1);
  const pageSize = ref(PAGE_SIZE);
  const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
  // 每行卡片数（2~10，步进1），localStorage 持久化；gridStyle 覆盖 .zhg-grid 的 auto-fill 自适应列
  const gridCols = ref(loadGridColsPref());
  function loadGridColsPref() {
    try {
      const v = parseInt(localStorage.getItem('zhule_gallery_grid_cols'), 10);
      if (v >= 2 && v <= 10) return v;
    } catch (e) { /* ignore */ }
    return 5;
  }
  function changeGridCols(delta) {
    const next = Math.min(10, Math.max(2, gridCols.value + delta));
    if (next === gridCols.value) return;
    gridCols.value = next;
    try { localStorage.setItem('zhule_gallery_grid_cols', String(next)); } catch (e) { /* ignore */ }
  }
  const gridStyle = computed(() => ({ gridTemplateColumns: 'repeat(' + gridCols.value + ', minmax(0, 1fr))' }));
  function changePageSize(delta) {
    const next = Math.min(200, Math.max(10, pageSize.value + delta));
    if (next === pageSize.value) return;
    pageSize.value = next;
    loadItems(true);
  }
  async function goPage(n) {
    if (n < 1 || n > totalPages.value || n === page.value) return;
    page.value = n;
    loading.value = true;
    try {
      const d = await jfetch(API.list + '?' + buildQuery(false).toString());
      total.value = d.total;
      items.value = d.items;
      allLoaded.value = items.value.length >= d.total;
      if (d.builtAt && d.builtAt) dirty.value = false;
    } catch (e) {
      showToast('加载失败', 'error');
    } finally {
      loading.value = false;
    }
  }
  const loading = ref(true);
  const loadingMore = ref(false);
  const allLoaded = ref(false);
  const dirty = ref(false);
  const tagPanelOpen = ref(false);
  // 筛选区（侧边/上下）尺寸：初始值与拖拽范围由布局传入
  const sideOpt = opts.side || {};
  const side = reactive({ w: sideOpt.initW || 0, h: sideOpt.initH || 0 });
  const sideStyle = computed(() => ({
    width: side.w > 0 ? side.w + 'px' : '',
    height: side.h > 0 ? side.h + 'px' : '',
  }));
  function maxSideH() {
    const v = sideOpt.hMax;
    return typeof v === 'function' ? v() : (v || 2000);
  }
  function loadSidePref() {
    try {
      const raw = JSON.parse(localStorage.getItem('zhule_gallery_side') || '{}');
      if (raw.w > (sideOpt.wMin || 140) && raw.w < (sideOpt.wMax || 2400)) side.w = raw.w;
      if (raw.h > (sideOpt.hMin || 120) && raw.h < maxSideH()) side.h = raw.h;
    } catch (e) { /* ignore */ }
    // 默认给筛选区一个固定基准高度（仅布局配置了 initH 时生效），拖高把手才能按鼠标拉高并让块体随高度伸展
    if (!(side.h > 0) && (sideOpt.initH || 0) > 0) side.h = sideOpt.initH;
  }
  loadSidePref();
  function startSideDrag(e, axis) {
    const startX = e.clientX, startY = e.clientY;
    const startW = side.w, startH = side.h;
    const wMin = sideOpt.wMin || 140, wMax = sideOpt.wMax || 2400;
    const hMin = sideOpt.hMin || 120, hMaxV = maxSideH();
    const onMove = (ev) => {
      if (axis === 'w') side.w = Math.max(wMin, Math.min(wMax, startW + ev.clientX - startX));
      else side.h = Math.max(hMin, Math.min(hMaxV, startH + ev.clientY - startY));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try { localStorage.setItem('zhule_gallery_side', JSON.stringify({ w: side.w, h: side.h })); } catch (err) { /* ignore */ }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
  function addTagFilter(item) {
    // 编辑面板左键点击 emit 的是完整 node 对象（tagTreePanel setFilter emit('add', node)），
    // 这里统一提取 name 字符串：避免把整个 node 对象当 name 存入外部过滤区，
    // 否则渲染 {{ node.name }} 会把整段 JSON 数据打出来（此前 bug）
    const name = typeof item === 'string' ? item : (item && item.name);
    if (!name) return;
    const rel = typeof item === 'string' ? '' : ((item && item.rel) || '');
    // 放到外部过滤区（编辑面板左键点击触发）：同名未隐藏则移除（toggle）；同名已隐藏=经编辑面板重新放置，
    // 清除隐藏标记恢复显示并置为启用（hidden=false, active=true，与"隐藏不可逆、恢复靠编辑面板重新放置"语义一致）；否则新增待生效（默认红）
    const i = filters.tags.findIndex((t) => t.name === name);
    if (i >= 0) {
      if (filters.tags[i].hidden) {
        filters.tags[i].hidden = false;
        filters.tags[i].active = true;
        filters.tags[i].rel = rel;
      } else {
        filters.tags.splice(i, 1);
      }
    } else {
      filters.tags.push({ name, rel, active: false, hidden: false });
    }
    applyFilter();
    saveTagPref();
  }
  // 外部过滤区：左键点击直接启用/禁用（红=待生效 / 蓝=生效）
  // 未入列（套娃内子标签首次点击）：直接启用并以 inner 标记入列，顶层 visibleTags 过滤 inner 不产生外部独立标签
  // 隐藏不可逆（Ctrl+左键完全移除），恢复靠编辑面板重新放置，故这里不再处理 hidden
  function toggleTagActive(name) {
    const t = filters.tags.find((x) => x.name === name);
    if (!t) {
      filters.tags.push({ name, rel: '', active: true, hidden: false, inner: true });
      applyFilter();
      saveTagPref();
      return;
    }
    t.active = !t.active;
    applyFilter();
    saveTagPref();
  }
  // 外部过滤区：Ctrl+左键隐藏（完全移除，不可逆）——扁平列表项标记 hidden 并清除 active，
  // 渲染层统一按 hidden 过滤后标签彻底消失不占位（隐藏大标签时整棵子树随之消失）；无任何恢复入口
  function hideTag(name) {
    const t = filters.tags.find((x) => x.name === name);
    if (t) { t.hidden = true; t.active = false; }
    else filters.tags.push({ name, rel: '', active: false, hidden: true, inner: true });
    applyFilter();
    saveTagPref();
  }
  // 外部过滤区可见标签（未隐藏且非套娃内产生的 inner 项）——隐藏 = 完全移除（等价 v-if=false）
  const visibleTags = computed(() => filters.tags.filter((t) => !t.hidden && !t.inner));
  // 树内递归渲染判断隐藏态：隐藏 = 完全移除，渲染时按此过滤（等价 v-if=false），隐藏大标签时整棵子树随之消失
  function isTagHidden(name) {
    const t = filters.tags.find((x) => x.name === name);
    return !!(t && t.hidden);
  }
  // 外部过滤区：右键展开子标签需要的树数据（name -> children）
  const tagTreeKidsMap = ref({});
  // 词条 id -> 显示名：URL 带 id 筛选时（词库跳转）用它把数字回显成词条名
  const tagIdNameMap = ref({});
  const expandedTags = ref(new Set());
  async function ensureTagTree() {
    if (Object.keys(tagTreeKidsMap.value).length) return;
    try {
      const r = await fetch('/zhule_studio/api/gallery/tagtree', { headers: { 'Cache-Control': 'no-cache' } });
      const d = await r.json();
      if (Array.isArray(d.tree)) {
        const map = {};
        const idMap = {};
        (function walk(ns) {
          for (const n of ns) {
            map[n.name] = (n.children || []).map((c) => ({ name: c.name, rel: c.rel, children: c.children || [] }));
            if (n.id != null && n.id !== '') idMap[String(n.id)] = n.name;
            walk(n.children || []);
          }
        })(d.tree);
        tagTreeKidsMap.value = map;
        tagIdNameMap.value = idMap;
      }
    } catch (e) { /* 静默失败，右键展开无子标签可显示 */ }
  }
  function treeKids(name) { return tagTreeKidsMap.value[name] || []; }
  function toggleTagExpand(name) {
    ensureTagTree();
    const s = new Set(expandedTags.value);
    if (s.has(name)) s.delete(name); else s.add(name);
    expandedTags.value = s;
  }
  function isTagActive(name) {
    const t = filters.tags.find((x) => x.name === name);
    return !!(t && t.active);
  }
  function inTagFilter(name) {
    return filters.tags.some((x) => x.name === name);
  }
  function clearTagFilter() {
    if (filters.tags.length) {
      filters.tags = [];
      applyFilter();
      saveTagPref();
    }
  }
  // 切换 tag 过滤模式：与（AND，满足所有）/ 或（OR，满足任一）
  function toggleTagMode() {
    filters.tagMode = filters.tagMode === 'and' ? 'or' : 'and';
    applyFilter();
  }
  const detail = ref(null);
  // 全屏查看器：由公共模块 zhule_fullviewer.js 命令式接管（非响应式）
  let fullViewer = null;
  let createFullViewerFn = null;
  const quickTag = ref('');
  const tagInputing = ref(false);
  const tagInputEl = ref(null);
  let tagBlurTimer = null;
  const toast = ref('');
  const toastType = ref('info');
  const toastIcon = { info: '\u2139\ufe0f', success: '\u2705', error: '\u274c', warn: '\u26a0\ufe0f' };
  const delTarget = ref(null);
  const delBatchOpen = ref(false);
  // 「以后不再询问」删除免确认开关：sessionStorage 持久化——刷新界面不会重置，
  // 只有重启程序（关闭页面/浏览器重新打开）后才恢复确认。
  // 勾选后无论单图红叉删除还是批量删除选中图片，都直接执行、跳过确认弹窗。
  const deleteNoAsk = ref(sessionStorage.getItem('zhule_gallery_noask') === '1');
  watch(deleteNoAsk, (v) => {
    try { sessionStorage.setItem('zhule_gallery_noask', v ? '1' : '0'); } catch (e) { /* ignore */ }
  });
  // 重命名模型/LoRA：居中弹框（非浏览器 prompt）
  const renameOpen = ref(false);
  const renameKind = ref('model');
  const renameOld = ref('');
  const renameNew = ref('');
  const renaming = ref(false);
  const renameInput = ref(null);
  const mainEl = ref(null);
  const gridEl = ref(null);
  // 批量选择：reactive Set（拖动框选 / Ctrl+点击）
  const selected = reactive(new Set());
  let suppressClickUntil = 0;
  const selCount = computed(() => selected.size);
  function isSel(key) { return selected.has(key); }
  // 可复用拖拽框选（命令式，视口坐标方案，实现见 marqueeSelect.js）
  const { onPointerDown } = useMarqueeSelect({
    getContainer: () => gridEl.value,
    selector: '.zhg-card',
    getKey: (el) => el.getAttribute('data-key'),
    isInteractive: (e) => !!(e.target && e.target.closest && e.target.closest('.zhg-del-btn, .zhg-zoom-btn, .zhg-sel-toggle')),
    onUpdate: (hits) => {
      selected.clear();
      for (const k of hits) selected.add(k);
    },
    onEnd: ({ moved, cancelled, initialKeys }) => {
      if (moved) suppressClickUntil = Date.now() + 400;
      if (cancelled) {
        selected.clear();
        for (const k of initialKeys) selected.add(k);
      }
    },
  });

  function onSearchKeyup(e) {
    if (e.key === 'Enter') applyFilter();
  }
  function onTagKeyup(e) {
    if (e.key === 'Enter') quickCreateTag();
    else if (e.key === 'Escape') cancelTagInput();
  }

  let toastTimer = null;
  function showToast(msg, type = 'info') {
    toast.value = msg;
    toastType.value = type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.value = ''), 2600);
  }

  const hasFilter = computed(() =>
    filters.q || filters.tags.some((t) => t.active && !t.hidden) ||
    filters.models.length || filters.loras.length);

  // 当前是否为上下布局（/gallery）；GalleryTopDown.js 挂在 /gallery，故此处恒为 true
  const isTopDown = computed(() => route.path === '/gallery');
  function toggleLayout() {
    const target = isTopDown.value ? '/gallery-side' : '/gallery';
    router.push({ path: target, query: { ...route.query } });
  }
  function setSortField(f) {
    if (filters.sortField === f) return;
    filters.sortField = f;
    applyFilter();
  }
  function toggleSortDir() {
    filters.sortDir = filters.sortDir === 'desc' ? 'asc' : 'desc';
    applyFilter();
  }

  // 详情页已选标签（对象数组，按 name 去重；prompt/custom 为只读来源）
  const uniqueDetailTags = computed(() => {
    const d = detail.value;
    if (!d) return [];
    const seen = new Set();
    return (d.tags || []).filter((t) => {
      const n = t && t.name;
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  });
  // ---- 临时 tag 颜色（仅本次查看，不保存）：打开详情时每个标签随机着色，用于提示词高亮定位 ----
  const tagColorMap = ref({});
  function randColor(i) {
    // 黄金角散列，保证相邻标签颜色有明显区分
    const hue = (i * 137.508 + 180) % 360;
    return 'hsl(' + hue.toFixed(0) + ', 70%, 42%)';
  }
  function refreshTagColors() {
    const map = {};
    uniqueDetailTags.value.forEach((t, i) => { map[t.name] = randColor(i); });
    tagColorMap.value = map;
  }
  // 右键临时改色：弹系统取色器，仅改内存映射，不落盘
  function pickTagColor(t, ev) {
    const input = document.createElement('input');
    input.type = 'color';
    input.value = tagColorMap.value[t.name] || '#2a9d8f';
    input.style.position = 'fixed';
    input.style.opacity = '0';
    input.style.pointerEvents = 'none';
    document.body.appendChild(input);
    input.addEventListener('input', () => {
      tagColorMap.value = Object.assign({}, tagColorMap.value, { [t.name]: input.value });
    });
    const done = () => { input.remove(); };
    input.addEventListener('change', done);
    input.addEventListener('blur', done);
    input.click();
  }
  // 英文提示词高亮：按 tag 的英文词条文本在提示词原文中做不区分大小写的整体子串匹配（带词边界）。
  // 词条名是中文目录名（zhule_prompt_tags 存中文名），中文名匹配英文提示词永不命中；
  // 后端 detail 已为每个 tag 附带 en 字段（词库词条目录 prompt.txt 全文），按 en 匹配即可整段着色。
  // 手动英文标签（无 en 字段）回退用 tag 名本身匹配；中文手动标签不参与英文匹配。
  const enSegments = computed(() => {
    const d = detail.value;
    const map = tagColorMap.value;
    if (!d || !d.promptPreview) return [];
    const text = d.promptPreview;
    const matches = (d.tags || []).filter((t) => !(t && t.custom)).map((t) => {
      const en = t && t.en ? String(t.en).trim() : '';
      const name = t && t.name ? String(t.name).trim() : '';
      const pat = en || (name && !/[\u4e00-\u9fff]/.test(name) ? name : '');
      const color = map[name] || '';
      return { pat, color };
    }).filter((m) => m.pat && m.color);
    if (!matches.length) return [{ text, color: '' }];
    matches.sort((a, b) => b.pat.length - a.pat.length); // 长词条优先，避免短词条抢先占位
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
        // 词边界：两侧不能是字母/数字，避免把 girl 着色到 1girl 之类内部
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
      if (h.start < pos) continue; // 已被更早/更长的命中覆盖
      if (h.start > pos) segs.push({ text: text.slice(pos, h.start), color: '' });
      segs.push({ text: text.slice(h.start, h.end), color: h.color });
      pos = h.end;
    }
    if (pos < text.length) segs.push({ text: text.slice(pos), color: '' });
    return segs;
  });
  // 中文提示词：按标签逐段着色，与 tag 色一一对应（逗号连接，行为与原 cnPrompt 一致）
  const cnSegments = computed(() => {
    const d = detail.value;
    const map = tagColorMap.value;
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
  // 详情标签样式：优先临时随机色（打开详情生成）；新增未着色标签回退来源色
  function tagStyle(t) {
    const c = tagColorMap.value[t.name];
    if (c) return { background: c };
    if (t.prompt) return { background: pref.gallery.promptTagColor };
    if (t.custom) return { background: pref.gallery.customTagColor };
    return null;
  }

  // 带 mtime 时间戳防浏览器缓存旧图：同名文件重建后 URL 变化，强制拉取新缩略图/原图
  const thumbUrl = (key, t) => _GL_NO_THUMB ? '' : API.thumb + '?path=' + encodeURIComponent(key) + '&t=' + (t || '');
  const imgUrl = (key, t) => '/zhule_studio/api/gallery/image?path=' + encodeURIComponent(key) + '&t=' + (t || '');
  function onCardClick(it, e) {
    if (e.ctrlKey || e.metaKey) {
      if (selected.has(it.key)) selected.delete(it.key); else selected.add(it.key);
      return; // Ctrl+点击只切换选中，不打开详情
    }
    if (Date.now() < suppressClickUntil) return;
    openDetail(it);
  }
  // 卡片左上角选中图标：点击直接选中/取消选中（无需 Ctrl）
  function toggleSel(key) {
    if (selected.has(key)) selected.delete(key); else selected.add(key);
  }
  async function zoomView(url) {
    if (!createFullViewerFn) {
      const mod = await import('/zhule_modules/common/zhule_fullviewer.js');
      createFullViewerFn = mod.createFullViewer;
      fullViewer = createFullViewerFn({
        tip: '滚轮缩放 · 左键拖拽 · 双击复位 · 点击或 ✕ 退出',
      });
    }
    if (fullViewer) fullViewer.open(url);
  }
  let _detailReqSeq = 0;
  // ===== [TEST] 首次点击延迟诊断日志：定位进入图库后第一次点开详情慢，定位后删除 =====
  const _FCT_LAST = { at: 0, count: 0 };
  function _fctPush(lines) {
    try {
      fetch('/zhule_studio/api/log/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sub: 'first_click_test', lines }),
      }).catch(() => {});
    } catch (e) {}
  }
  // ===== [TEST] end =====
  async function openDetail(item) {
    const seq = ++_detailReqSeq;
    const t0 = performance.now();
    const now = Date.now();
    _FCT_LAST.count = (now - _FCT_LAST.at < 5000) ? _FCT_LAST.count + 1 : 1;
    _FCT_LAST.at = now;
    try {
      const d = await jfetch(API.detail + '?path=' + encodeURIComponent(item.key));
      const t1 = performance.now();
      if (seq !== _detailReqSeq) {
        _fctPush(['seq=' + seq + ' 过期丢弃 key=' + item.key + ' 耗时=' + (t1 - t0).toFixed(1) + 'ms']);
        return; // 已有更新的点击，丢弃过期响应
      }
      detail.value = d;
      quickTag.value = '';
      tagInputing.value = false;
      refreshTagColors();
      const t2 = performance.now();
      _fctPush([
        '进入图库后第' + _FCT_LAST.count + '次点击 key=' + item.key,
        '  请求耗时=' + (t1 - t0).toFixed(1) + 'ms  渲染耗时=' + (t2 - t1).toFixed(1) + 'ms  总计=' + (t2 - t0).toFixed(1) + 'ms',
        '  detail 返回 keys=' + Object.keys(d).join(',') + ' tags=' + (d.tags ? d.tags.length : -1) + ' promptPreviewLen=' + (d.promptPreview || '').length,
      ]);
    } catch (e) {
      _fctPush(['seq=' + seq + ' 详情加载失败 key=' + item.key + ' err=' + String(e && e.message || e)]);
      showToast('详情加载失败', 'error');
    }
  }
  function closeDetail() { detail.value = null; }
  function copyPrompt() {
    const d = detail.value;
    if (!d || !d.promptPreview) return;
    const done = () => showToast('提示词已复制', 'success');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(d.promptPreview).then(done).catch(() => fallbackCopy(d.promptPreview, done));
    } else {
      fallbackCopy(d.promptPreview, done);
    }
  }
  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) {
      showToast('复制失败', 'error');
    }
  }
  async function useWorkflow(item) {
    try {
      const res = await fetch(API.workflow + '?path=' + encodeURIComponent(item.path));
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        showToast(e.error || '没有可用工作流', e.error ? 'error' : 'warn');
        return;
      }
      const wf = await res.text();
      try {
        JSON.parse(wf);
      } catch (e) {
        showToast('工作流数据异常', 'error');
        return;
      }
      localStorage.setItem('zhule_import_workflow', wf);
      showToast('正在新标签页打开 ComfyUI 导入工作流…');
      setTimeout(() => { window.open('/', '_blank'); }, 400);
    } catch (e) {
      showToast('工作流获取失败', 'error');
    }
  }
  function askDelete(it) {
    // 已勾选「以后不再询问」：单图删除跳过确认弹窗直接执行
    if (deleteNoAsk.value) { delTarget.value = it; confirmDelete(); return; }
    delTarget.value = it;
  }
  function cancelDelete() { delTarget.value = null; }
  async function confirmDelete() {
    const item = delTarget.value;
    if (!item) return;
    delTarget.value = null;
    try {
      const p = item.path || item.key;
      const d = await jfetch(API.del, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      if (!d.ok) throw new Error(d.error || '删除失败');
      const i = items.value.findIndex((x) => x.key === item.key);
      if (i >= 0) items.value.splice(i, 1);
      total.value = Math.max(0, total.value - 1);
      showToast('已删除：' + item.name, 'success');
      await loadMeta();
      if (!items.value.length && hasFilter.value) applyFilter();
    } catch (e) {
      showToast('删除失败：' + (e.message || ''), 'error');
    }
  }
  function startTagInput() {
    tagInputing.value = true;
    clearTimeout(tagBlurTimer);
    nextTick(() => {
      if (tagInputEl.value) tagInputEl.value.focus();
    });
  }
  function cancelTagInput() {
    clearTimeout(tagBlurTimer);
    tagInputing.value = false;
    quickTag.value = '';
  }
  function onTagInputBlur() {
    // 失焦延迟收起，避免与“确定”按钮点击竞争
    clearTimeout(tagBlurTimer);
    tagBlurTimer = setTimeout(() => {
      if (tagInputing.value) cancelTagInput();
    }, 200);
  }
  async function quickCreateTag() {
    clearTimeout(tagBlurTimer);
    const name = quickTag.value.trim();
    if (!name) { cancelTagInput(); return; }
    const d = detail.value;
    if (!d) return;
    const names = customTagNames();
    if (!names.includes(name)) {
      await annotate({ tags: [...names, name] });
    }
    quickTag.value = '';
    tagInputing.value = false;
  }
  // 自定义标签名列表（唯一可增删部分；zhule_tags 已并入 zhule_custom_tags）
  function customTagNames() {
    return (detail.value.tags || [])
      .filter((t) => t && !t.prompt)
      .map((t) => t.name);
  }
  // 打标后重组详情 tags：新的自定义标签在前，只读的提示词标签在后
  function mergeDetailTags(customNames) {
    const src = detail.value.tags || [];
    const readonly = src.filter((t) => t && t.prompt);
    const seen = new Set(readonly.map((t) => t.name));
    const custom = [];
    for (const n of customNames) {
      if (!seen.has(n)) {
        custom.push({ name: n, prompt: false, custom: true });
        seen.add(n);
      }
    }
    return [...custom, ...readonly];
  }
  function removeTagFromImage(name) {
    const d = detail.value;
    if (!d) return;
    annotate({ remove_custom: [name] });
  }
  // ============ 标签删除（详情 tag ✕：确认弹窗 → 按类型写回 PNG 元数据/图库索引） ============
  // 两源：提示词标签走 remove_prompt；自定义标签走 remove_custom
  // （后端读 PNG 对应键过滤写回，详情缓存失效由 post_gallery_annotate 统一 drop）。
  const tagDeleteTarget = ref(null);
  function askDeleteTag(t) {
    if (!t || !t.name) return;
    tagDeleteTarget.value = t;
  }
  function cancelDeleteTag() { tagDeleteTarget.value = null; }
  const tagDeleteLabel = computed(() => {
    const t = tagDeleteTarget.value;
    if (!t) return '';
    return t.prompt ? '提示词标签' : '自定义标签';
  });
  async function confirmDeleteTag() {
    const t = tagDeleteTarget.value;
    if (!t) return;
    tagDeleteTarget.value = null;
    if (t.prompt) {
      await annotate({ remove_prompt: [t.name] });
    } else {
      await annotate({ remove_custom: [t.name] });
    }
  }
  // ============ 词库词条编辑（左键点击详情 tag 呼出，逻辑与词库 Wordbank.js 完全一致） ============
  // tag 与词库词条对应方式：图库 tag.name = 词库卡片显示名（后端 parse_folder 后的 name），
  // 前端按 name 精确匹配词库扫描结果的卡片，取得 relPath/content/content_cn 后复用词库编辑弹窗；
  // 词库未收录该 tag（如纯手动标签）时给出兜底提示，不打开弹窗。
  const editWbTarget = ref(null);
  const editWbName = ref('');
  const editWbContent = ref('');
  const editWbContentCn = ref('');
  const editWbEditing = ref(false);
  // 散 txt 卡片（rawName 以 .txt 结尾）：后端不支持中文提示词（与词库 editIsTxt 语义一致）
  const editWbIsTxt = computed(() => {
    const raw = editWbTarget.value ? (editWbTarget.value.rawName || '') : '';
    return raw.toLowerCase().endsWith('.txt');
  });
  // 词库卡片 name -> 卡片 映射缓存：用 /zhule_studio/api/wordbank?refresh=1 全量拉取并建映射
  let wbMapData = null;
  let wbMapTs = 0;
  const WB_MAP_TTL = 30 * 1000; // 30s 内复用，保存成功后强制刷新
  async function ensureWordBankMap(force) {
    const now = Date.now();
    if (!force && wbMapData && (now - wbMapTs) < WB_MAP_TTL) return wbMapData;
    try {
      const resp = await fetch('/zhule_studio/api/wordbank' + (force ? '?refresh=1' : ''));
      if (!resp.ok) return wbMapData || {};
      const json = await resp.json();
      if (json.error) return wbMapData || {};
      const map = {};
      const data = json.data || {};
      for (const tab of Object.keys(data)) {
        for (const card of data[tab] || []) {
          const n = card && card.name ? String(card.name) : '';
          // 先到先得，与后端词条索引 _tag_en_index 去重语义一致
          if (n && !(n in map)) map[n] = card;
        }
      }
      wbMapData = map;
      wbMapTs = now;
      return map;
    } catch (e) {
      return wbMapData || {};
    }
  }
  // 左键点击详情 tag：按词条名匹配词库源文件，命中则呼出与词库一致的编辑弹窗
  async function editDetailTag(t) {
    if (!t || !t.name) return;
    // 必须强制 refresh=1 全量拉取：不带 refresh 时后端只返回已缓存 tab（首屏仅首个 tab），
    // 若目标词条属于其它 tab，按 name 匹配会落空导致左键无反应/只 toast。
    const map = await ensureWordBankMap(true);
    const card = map[t.name];
    if (!card) {
      showToast('「' + t.name + '」不在词库中，无法编辑', 'warn');
      return;
    }
    editWbTarget.value = card;
    editWbName.value = card.name || '';
    editWbContent.value = card.content || '';
    editWbContentCn.value = card.content_cn || '';
  }
  function cancelEditWb() {
    editWbTarget.value = null;
    editWbEditing.value = false;
  }
  // 保存：与词库 Wordbank.js submitEdit 完全一致（非空校验 / 条件写回 / 失败保留弹窗 / 成功刷新）
  async function submitEditWb() {
    if (!editWbTarget.value || editWbEditing.value) return;
    const nm = (editWbName.value || '').trim();
    if (!nm) return showToast('名字不能为空', 'warn');

    editWbEditing.value = true;
    try {
      const body = {
        path: editWbTarget.value.relPath,
        name: nm,
      };
      // 仅当输入框非空或原本就有内容时才写回，避免误清空
      if (editWbContent.value || editWbTarget.value.content) body.content = editWbContent.value;
      // 散 txt 卡片后端不支持中文；仅文件夹卡片提交
      if (!editWbIsTxt.value && (editWbContentCn.value || editWbTarget.value.content_cn)) {
        body.content_cn = editWbContentCn.value;
      }
      const resp = await fetch('/zhule_studio/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await resp.json();
      if (json.error) {
        showToast('保存失败：' + json.error, 'error');
        editWbEditing.value = false;
        return; // 失败保留弹窗
      }
      editWbTarget.value = null;
      editWbEditing.value = false;
      // 同步：词库映射强制刷新 + 通知已挂载的词库页刷新卡片列表 + 重拉图库详情
      await ensureWordBankMap(true);
      window.dispatchEvent(new CustomEvent('zhule:wordbank-changed'));
      await refreshDetail();
      showToast('已保存，图库详情与词库已同步', 'success');
    } catch (e) {
      showToast('请求失败：' + e.message, 'error');
      editWbEditing.value = false;
    }
  }
  // 保存成功后重拉当前详情，同步刷新图库详情展示（tag 名 / en / cn 与颜色）
  async function refreshDetail() {
    const d = detail.value;
    if (!d || !d.path) return;
    try {
      const nd = await jfetch(API.detail + '?path=' + encodeURIComponent(d.path));
      detail.value = nd;
      refreshTagColors();
    } catch (e) { /* 详情刷新失败不打断保存结果 */ }
  }
  async function addTagToImage(name) {
    const d = detail.value;
    if (!d) return;
    const names = customTagNames();
    if (names.includes(name)) return;
    await annotate({ tags: [...names, name] });
  }
  async function annotate(payload) {
    const d = detail.value;
    if (!d) return;
    const body = { path: d.path, ...payload };
    try {
      await jfetch(API.annotate, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const gone = ('remove_prompt' in payload || 'remove_custom' in payload)
        ? new Set((payload.remove_prompt || []).concat(payload.remove_custom || [])) : null;
      if ('tags' in payload) d.tags = mergeDetailTags(payload.tags);
      if (gone) d.tags = (d.tags || []).filter((x) => x && !gone.has(x.name));
      // 同步卡片状态
      const item = items.value.find((x) => x.key === d.path);
      if (item) {
        if ('tags' in payload) item.tags = payload.tags;
        if (gone && item.tags) {
          item.tags = item.tags.filter((x) => !gone.has(typeof x === 'string' ? x : (x && x.name)));
        }
      }
      await loadMeta();
    } catch (e) {
      showToast('保存失败', 'error');
    }
  }
  // 重命名模型/LoRA：居中弹框
  function openRename(kind, oldName) {
    renameKind.value = kind;
    renameOld.value = oldName;
    renameNew.value = fmtModel(oldName);
    renameOpen.value = true;
    nextTick(() => {
      const el = renameInput.value;
      if (el) { el.focus(); if (el.select) el.select(); }
    });
  }
  function cancelRename() { renameOpen.value = false; }
  async function confirmRename() {
    const v = renameNew.value.trim();
    if (!v) { showToast('新名称不能为空', 'warn'); return; }
    if (v === fmtModel(renameOld.value)) { showToast('名称未变化', 'warn'); return; }
    renaming.value = true;
    try {
      const d = await jfetch(API.rename, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: renameKind.value, old: renameOld.value, new: v }),
      });
      if (!d.ok) throw new Error(d.error || '改名失败');
      renameOpen.value = false;
      showToast('已提交后台重命名，正在批量更新所有引用该' + (renameKind.value === 'model' ? '模型' : 'LoRA') + '的图片元数据', 'success');
      await loadMeta();
      applyFilter();
    } catch (e) {
      showToast('改名失败：' + (e.message || ''), 'error');
    } finally {
      renaming.value = false;
    }
  }
  async function rescan() {
    try {
      const d = await jfetch(API.rescan, { method: 'POST' });
      showToast('索引重建中，完成后手动刷新页面查看最新列表');
      void d;
    } catch (e) {
      showToast('重建失败', 'error');
    }
  }
  function toggleModel(name) {
    const i = filters.models.indexOf(name);
    if (i >= 0) filters.models.splice(i, 1); else filters.models.push(name);
    applyFilter();
  }
  function toggleLora(name) {
    const i = filters.loras.indexOf(name);
    if (i >= 0) filters.loras.splice(i, 1); else filters.loras.push(name);
    applyFilter();
  }
  function removeTag(name) {
    const i = filters.tags.findIndex((t) => t.name === name);
    if (i >= 0) filters.tags.splice(i, 1);
    applyFilter();
    saveTagPref();
  }
  function onScroll() {
    const el = mainEl.value;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 600) {
      if (!loadingMore.value && !allLoaded.value && !loading.value) loadItems(false);
    }
  }
  function buildQuery(reset) {
    const p = reset ? 1 : page.value;
    const params = new URLSearchParams({ page: p, pageSize: pageSize.value, sort: filters.sortField + '_' + filters.sortDir });
    if (filters.q) params.set('q', filters.q);
    const actTags = filters.tags.filter((t) => t.active && !t.hidden);
    if (actTags.length) {
      // 优先级：id（词条改名后仍命中）> name|rel（同名标签按层级精确过滤）> name
      params.set('tags', actTags.map((t) => (
        t.id ? String(t.id) : (t.rel ? t.name + '|' + t.rel : t.name)
      )).join(','));
      params.set('mode', filters.tagMode);
    }
    if (filters.models.length) params.set('models', filters.models.join(','));
    if (filters.loras.length) params.set('loras', filters.loras.join(','));
    return params;
  }
  async function applyFilter() {
    loadItems(true);
  }
  async function loadMeta() {
    try {
      const d = await jfetch(API.meta);
      Object.assign(meta, d);
    } catch (e) {
      showToast('元数据加载失败', 'error');
    }
  }
  async function loadItems(reset) {
    if (reset) {
      loading.value = true;
      page.value = 1;
      allLoaded.value = false;
    } else {
      loadingMore.value = true;
    }
    try {
      const _reqT0 = performance.now();
      const d = await jfetch(API.list + '?' + buildQuery(reset).toString());
      if (reset) _glPush(['列表请求返回 网络耗时=' + (performance.now() - _reqT0).toFixed(1) + 'ms 距挂载=' + (performance.now() - _GL_T0).toFixed(1) + 'ms total=' + d.total]);
      total.value = d.total;
      if (reset) items.value = d.items;
      else items.value = items.value.concat(d.items);
      allLoaded.value = items.value.length >= d.total;
      if (d.builtAt && d.builtAt) dirty.value = false;
      // ===== [TEST] 图库加载耗时：记录列表数据就绪 / 首帧渲染完成 耗时 =====
      if (reset) {
        _glPush(['列表数据就绪 items=' + items.value.length + ' total=' + total.value + ' 耗时=' + (performance.now() - _GL_T0).toFixed(1) + 'ms']);
        await nextTick();
        _glPush(['首帧渲染完成 耗时=' + (performance.now() - _GL_T0).toFixed(1) + 'ms']);
      }
      // ===== [TEST] end =====
    } catch (e) {
      showToast('加载失败', 'error');
    } finally {
      loading.value = false;
      loadingMore.value = false;
    }
  }
  // 批量操作
  function askBatchDelete() {
    if (!selected.size) { showToast('请先框选或 Ctrl+点击 选中要删除的图片', 'warn'); return; }
    // 已勾选「以后不再询问」：批量删除跳过确认弹窗直接执行
    if (deleteNoAsk.value) { confirmBatchDelete(); return; }
    delBatchOpen.value = true;
  }
  function cancelBatchDelete() { delBatchOpen.value = false; }
  async function confirmBatchDelete() {
    const keys = [...selected];
    if (!keys.length) return;
    delBatchOpen.value = false;
    const paths = [];
    for (const k of keys) {
      const item = items.value.find((x) => x.key === k);
      paths.push(item ? (item.path || item.key) : k);
    }
    try {
      const d = await jfetch(API.batchDel, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      if (!d.ok) throw new Error(d.error || '删除失败');
      const failedSet = new Set((d.failed || []).map((f) => f.path));
      const okSet = new Set(paths.filter((p) => !failedSet.has(p)));
      items.value = items.value.filter((x) => !okSet.has(x.key) && !okSet.has(x.path));
      total.value = Math.max(0, total.value - (d.count || okSet.size));
      selected.clear();
      showToast(d.failed && d.failed.length
        ? `已删除 ${d.count} 张，失败 ${d.failed.length} 张`
        : `已删除 ${d.count} 张`);
      await loadMeta();
      if (!items.value.length && hasFilter.value) applyFilter();
    } catch (e) {
      showToast('批量删除失败：' + (e.message || ''), 'error');
    }
  }
  async function batchLink() {
    const keys = [...selected];
    if (!keys.length) { showToast('请先框选或 Ctrl+点击 选中要导出的图片', 'warn'); return; }
    const paths = [];
    for (const k of keys) {
      const item = items.value.find((x) => x.key === k);
      paths.push(item ? (item.path || item.key) : k);
    }
    try {
      const d = await jfetch(API.link, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      if (!d.ok) throw new Error(d.error || '导出失败');
      const cop = d.copied && d.copied.length ? `，复制 ${d.copied.length}` : '';
      showToast(d.count
        ? `已导出 ${d.count} 张（硬链接 ${d.created.length}${cop}） -> ${d.target}`
        : '没有可导出的图片');
    } catch (e) {
      showToast('批量导出失败：' + (e.message || ''), 'error');
    }
  }


  onMounted(() => {
    // ===== [TEST] 图库加载耗时：记录组件挂载时刻 =====
    _glPush(['onMounted 耗时=' + (performance.now() - _GL_T0).toFixed(1) + 'ms 路径=' + route.path]);
    // ===== [TEST] end =====
    window.addEventListener('zhule-pref-changed', onPrefChanged);
    if (opts.onMountedExtra) opts.onMountedExtra();
    const q = route.query.tags;
    let pendingTagId = null;
    if (q) {
      const first = String(q).split(',').filter(Boolean)[0];
      if (first) {
        // 纯数字 = 词条 id（词库箭头跳转）：按 id 筛选；名字待标签树加载后回显
        if (/^\d+$/.test(first)) {
          pendingTagId = first;
          filters.tags = [{ id: first, name: first, rel: '', active: true, hidden: false }];
        } else {
          filters.tags = [{ name: first, rel: '', active: true, hidden: false }];
        }
      }
    }
    const qm = String(route.query.mode || 'and').toLowerCase();
    if (qm === 'or') filters.tagMode = 'or';
    ensureTagTree();
    if (pendingTagId) {
      ensureTagTree().then(() => {
        const nm = tagIdNameMap.value[pendingTagId];
        const t = filters.tags.find((x) => x.id === pendingTagId);
        if (nm && t) t.name = nm;
      });
    }
    // 首次进入立即加载列表与元数据；不做自动探活/自动刷新，需要最新数据时手动刷新页面
    loadMeta();
    applyFilter();
  });
  onBeforeUnmount(() => {
    window.removeEventListener('zhule-pref-changed', onPrefChanged);
    if (fullViewer) fullViewer.close();
    clearTimeout(toastTimer);
  });

  return {
    pref, filters, meta, items, total, page, pageSize, totalPages,
    loading, loadingMore, allLoaded, dirty, tagPanelOpen, detail,
    quickTag, toast, toastType, toastIcon, delTarget, mainEl, gridEl,
    hasFilter, uniqueDetailTags, enSegments, cnSegments, pickTagColor,
    copyPrompt, thumbUrl, imgUrl, fmtTime, fmtSize, fmtModel,
    isTopDown, toggleLayout, setSortField, toggleSortDir,
    applyFilter, changePageSize, goPage, onScroll, removeTag,
    onSearchKeyup, onTagKeyup, toggleModel, toggleLora,
    openRename, cancelRename, confirmRename, rescan, quickCreateTag,
    renameOpen, renameKind, renameOld, renameNew, renaming, renameInput,
    filtersOpen, toggleFilters, gridCols, changeGridCols, gridStyle,
    side, sideStyle, startSideDrag,
    addTagFilter, clearTagFilter, toggleTagMode, visibleTags,
    toggleTagActive, hideTag, expandedTags, treeKids, toggleTagExpand,
    isTagActive, inTagFilter, isTagHidden,
    openDetail, closeDetail, zoomView, tagStyle,
    askDelete, cancelDelete, confirmDelete, deleteNoAsk, toggleSel,
    tagInputing, tagInputEl, startTagInput, cancelTagInput, onTagInputBlur,
    addTagToImage, removeTagFromImage,
    tagDeleteTarget, askDeleteTag, cancelDeleteTag, confirmDeleteTag, tagDeleteLabel,
    useWorkflow,
    editWbTarget, editWbName, editWbContent, editWbContentCn, editWbIsTxt, editWbEditing,
    editDetailTag, cancelEditWb, submitEditWb,
    selected, selCount, isSel, onPointerDown, onCardClick,
    delBatchOpen, askBatchDelete, cancelBatchDelete, confirmBatchDelete, batchLink,
  };
}
