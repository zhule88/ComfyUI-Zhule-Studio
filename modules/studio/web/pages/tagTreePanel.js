import { ref, watch, computed, nextTick } from 'vue';

const API = {
  tagtree: '/zhule_studio/api/gallery/tagtree',
  customTag: '/zhule_studio/api/gallery/custom-tag',
};

// 显示工具：完整路径只取叶子段（'测试/喜欢' → '喜欢'；词条名无分隔符时原样返回）。
// 分隔符支持 / \ - : 四种。
const TAG_PATH_SEPS = /[\/\\:\-]/;
function leafName(n) {
  const s = String(n || '');
  const parts = s.split(TAG_PATH_SEPS);
  let i = parts.length - 1;
  while (i >= 0 && !parts[i]) i--;
  return i >= 0 ? parts[i] : s;
}
// 标签唯一键：有 id 优先用 id（custom/prompt 加前缀区分域），无 id 的老状态回退 name|rel。
// 与 galleryCommon.tagKey 保持一致（本文件独立实现，避免循环 import）。
function tagKey(t) {
  if (!t) return '';
  const raw = (t.id != null && t.id !== '') ? String(t.id) : '';
  if (raw) {
    const kind = t.kind || (t.isCustom ? 'custom' : '');
    return (kind === 'custom' ? 'c:' : 'p:') + raw;
  }
  return 'n:' + String(t.name || '') + '|' + String(t.rel || '');
}
// 递归构建自定义标签层级树（完整路径 '测试/喜欢' → 父'测试'分组 + 子'喜欢'叶子）。
// 节点与全量自定义树同构 {name, rel, leaf, isCustom, id, children}；叶子携带原始标签对象 tag（含 id）。
// 父级为可展开分组容器，仅叶子可作为标签放置/关联（与详情页 DetailTagNode 层级语义一致）。
function buildPathTree(tags) {
  const roots = [];
  const map = {};
  for (const t of tags || []) {
    const parts = String(t.name || '').split(TAG_PATH_SEPS).filter((s) => s);
    if (!parts.length) continue;
    let prefix = '';
    let cur = null;
    for (let i = 0; i < parts.length; i++) {
      prefix = prefix ? prefix + '/' + parts[i] : parts[i];
      if (!map[prefix]) {
        map[prefix] = { name: parts[i], rel: prefix, leaf: true, isCustom: true, children: [] };
        if (cur) cur.children.push(map[prefix]);
        else roots.push(map[prefix]);
      }
      cur = map[prefix];
    }
    if (cur) {
      if (t.id != null && t.id !== '') cur.id = String(t.id);
      cur.tag = t;
    }
  }
  return roots;
}
// 树节点总数（含子级），用于区域标题后的计数徽章
function countNodes(ns) {
  let n = 0;
  for (const x of ns || []) {
    n += 1;
    if (x.children && x.children.length) n += countNodes(x.children);
  }
  return n;
}

// 递归节点：chip 样式与外部 zhg-sel-tag 一致；尺寸随自身子树深度放大（叶子=基准，子树越深越大）；
// 左键 = 放置到外部过滤区（待生效）；右键 = 包裹式展开/收起子标签，Ctrl+右键 = 逐级优先收起。
// 若节点祖先已在外部过滤区（selected 含其上级路径），左键不再新增顶层，改为启用/停用筛选（由父级 setFilter 拦截）。
// manage=true（仅自定义标签区）时，chip 右侧出现 ⋯ 按钮，点开该标签的管理菜单（新建子级/重命名/删除）。
const TagNode = {
  name: 'TagNode',
  props: {
    node: { type: Object, required: true },
    depth: { type: Number, default: 0 },
    themeCls: { type: String, default: '' },
    // 标签颜色函数（输入完整标签名 → 颜色字符串，同图库详情区散列配色）
    colorOf: { type: Function, default: null },
    // 是否显示管理按钮（自定义标签区专用）
    manage: { type: Boolean, default: false },
    // 关联图数角标：显示开关（设置页可关）+ 取数函数（rel|name → 图数，由树数据带下来）
    showCount: { type: Boolean, default: true },
    countOf: { type: Function, default: null },
  },
  emits: ['add', 'remove', 'toggle', 'menu'],
  setup(props, { emit }) {
    const expanded = ref(false);
    const hasKids = () => props.node.children && props.node.children.length;
    // 子树深度：到最深叶子的层数（children 递归），叶子为 0
    function subtreeDepth(n) {
      if (!n.children || !n.children.length) return 0;
      let m = 0;
      for (const c of n.children) m = Math.max(m, subtreeDepth(c));
      return 1 + m;
    }
    // 尺寸随子树深度放大：叶子保持基准 12px（1.0 倍），每深一层 +0.3 倍，整体放大保证展开后清晰
    const chipStyle = () => {
      const scale = 1 + subtreeDepth(props.node) * 0.3;
      const style = {
        fontSize: Math.round(12 * scale) + 'px',
        padding: Math.round(5 * scale) + 'px ' + Math.round(12 * scale) + 'px',
      };
      if (props.colorOf) {
        const c = props.colorOf(props.node.name);
        if (c) style['--tag-bg'] = c;
      }
      return style;
    };
    // 管理按钮只在有真实 id 时出现：currentTags 路径重建出的中间分组没有 id，无法定位到库里的行
    const canManage = computed(() => props.manage && props.node.id != null && props.node.id !== '');
    function onLeft() { emit('add', props.node); }
    function onMore(e) {
      e.preventDefault();
      e.stopPropagation();
      emit('menu', { node: props.node, x: e.clientX, y: e.clientY });
    }
    function onCtx(e) {
      e.preventDefault();
      if (e.ctrlKey) {
        // Ctrl+右键：逐级优先收起——展开容器（含内部任意子标签冒泡）收起自己并拦截；
        // chip（已收起）不拦截，继续冒泡给父级展开容器向上逐级收起
        if (expanded.value) {
          expanded.value = false;
          e.stopPropagation();
        }
        return;
      }
      // 普通右键：展开容器上一律忽略不做任何动作；chip 上展开/收起切换
      if (expanded.value) { e.stopPropagation(); return; }
      if (hasKids()) expanded.value = true;
      e.stopPropagation();
    }
    return { expanded, hasKids, chipStyle, leafName, onLeft, onCtx, onMore, canManage };
  },
  template: `
  <div class="zhg-ttp-wrap" :class="{ open: expanded }">
    <span class="zhg-ttp-chip" v-if="!expanded" :class="[themeCls, { leaf: !hasKids(), mgr: canManage }]" :style="chipStyle()"
          :data-tip="hasKids() ? '左键：放到外部过滤区 / 右键：展开 / Ctrl+右键：收起' : '左键：放到外部过滤区'"
          @click="onLeft" @contextmenu.prevent="onCtx">
      {{ leafName(node.name) }}<span class="zhg-ttp-count" v-if="showCount && countOf && countOf(node) != null">{{ countOf(node) }}</span>
      <span class="zhg-ttp-arrow" v-if="hasKids()">▸</span>
      <i class="zhg-ttp-more" v-if="canManage" data-tip="管理这个标签" @click.stop="onMore">⋯</i>
    </span>
    <div class="zhg-ttp-open" v-else :style="chipStyle()" @contextmenu.prevent="onCtx">
      <tag-node v-for="c in node.children" :key="c.rel" :node="c" :depth="depth + 1" :theme-cls="themeCls" :color-of="colorOf"
                :manage="manage" :show-count="showCount" :count-of="countOf"
                @add="$emit('add', $event)" @remove="$emit('remove', $event)" @toggle="$emit('toggle', $event)"
                @menu="$emit('menu', $event)"></tag-node>
    </div>
  </div>
  `,
};

export default {
  name: 'TagTreePanel',
  components: { TagNode },
  props: {
    show: { type: Boolean, default: false },
    // 外部过滤区标签：[{name, active, hidden}]
    selected: { type: Array, default: () => [] },
    // 当前图片实际挂载的标签（[{name, prompt, custom}]）；非空时自定义区按它构建（编辑界面按实际标签展示）
    currentTags: { type: Array, default: () => [] },
    // 全局标签主题类（zhg-tag-theme-* + zhg-tag-square），与图库详情标签一致
    themeCls: { type: String, default: '' },
    // 标签颜色函数（与详情区同套散列配色，用于外部过滤区条与面板 chip 随机色）
    colorOf: { type: Function, default: null },
    // 关联图数角标开关（设置页「标签关联图数」关闭后不渲染数字）
    showCount: { type: Boolean, default: true },
  },
  emits: ['close', 'add', 'remove', 'clear', 'toggle', 'refresh'],
  setup(props, { emit }) {
    const tree = ref([]);
    const loading = ref(false);
    const err = ref('');
    const toast = ref('');
    let toastTimer = 0;

    function flash(msg) {
      toast.value = msg;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.value = ''; }, 2400);
    }

    // 关联图数：/gallery/tagtree 每个节点已带 count，这里按 rel|name 建表，
    // 供 chip 取数——含按当前图片路径重建出的中间分组节点（它们没有 id/count）。
    const countMap = ref({});
    function countOf(n) {
      if (!n) return null;
      if (typeof n.count === 'number') return n.count;
      const k = n.rel || n.name;
      const v = k ? countMap.value[k] : null;
      return (typeof v === 'number') ? v : null;
    }

    async function loadTree(force = false) {
      if (tree.value.length && !force) return;
      loading.value = !tree.value.length;
      err.value = '';
      try {
        const r = await fetch(API.tagtree, { headers: { 'Cache-Control': 'no-cache' } });
        const d = await r.json();
        if (Array.isArray(d.tree)) {
          tree.value = d.tree;
          const cm = {};
          (function walk(ns) {
            for (const n of ns) {
              const k = n.rel || n.name;
              if (k && typeof n.count === 'number') cm[k] = n.count;
              walk(n.children || []);
            }
          })(d.tree);
          countMap.value = cm;
        } else err.value = d.error || '加载失败';
      } catch (e) {
        err.value = '加载失败：' + (e.message || e);
      } finally {
        loading.value = false;
      }
    }

    function open() {
      loadTree();
    }
    watch(
      () => props.show,
      (v) => { if (v) open(); else { closeMenu(); dlg.value.open = false; } }
    );

    // 左键：放置到外部过滤区（待生效），父组件决定新增/恢复/移除。
    // 若节点祖先已在外部过滤区（大标签已入列、在其内部展开到子标签），点击子标签不再新增顶层条目，
    // 只切换筛选启用状态——保证外部过滤区只展示顶层标签。
    function ancestorInSelected(node) {
      const rel = String(node.rel || node.name || '');
      const segs = rel.split(TAG_PATH_SEPS).filter(Boolean);
      segs.pop(); // 去掉自身
      if (!segs.length) return false;
      return segs.some((s) => props.selected.some((t) => t.name === s || t.rel === s));
    }
    function setFilter(node) {
      if (ancestorInSelected(node)) { emit('toggle', node); return; }
      emit('add', node);
    }
    // 面板内已放置标签：点击移除（按 id 唯一键匹配，同名不同 id 互不干扰）
    function removeFilter(item) {
      const name = typeof item === 'string' ? item : (item && item.name);
      if (!name) return;
      const rel = typeof item === 'string' ? '' : ((item && item.rel) || '');
      const id = (typeof item !== 'string' && item && item.id != null && item.id !== '') ? String(item.id) : '';
      // 双形态兼容：selected 项带 kind、树节点带 isCustom——优先 kind，否则按 isCustom 推导，
      // 否则外部过滤区条点击移除自定义标签时 key 失配（c:5→p:5），删不掉
      const kind = (typeof item !== 'string' && item) ? (item.kind || (item.isCustom ? 'custom' : 'prompt')) : 'prompt';
      const k = tagKey({ name, rel, id, kind });
      const t = k ? props.selected.find((x) => tagKey(x) === k) : null;
      if (t) emit('remove', t);
    }
    function clearAll() {
      if (props.selected.length) emit('clear');
    }
    function close() { emit('close'); }
    // 面板顶部“外部过滤区”已放置标签条配色：与详情区同套散列色
    function selTagStyle(name) {
      if (!props.colorOf) return null;
      const c = props.colorOf(name);
      return c ? { '--tag-bg': c } : null;
    }
    // 外部过滤区条可见项：与 galleryCommon.visibleTags 同规则——未隐藏 + 排除 inner + 只展示最深选中链
    // （祖先存在可见后代时被取代：选"角色"显示角色，编辑面板再放入"璃月"后只显示璃月）。
    // inner（套娃内点击产生）项不占条：它只是启用状态，反馈体现在展开容器内的高亮上，不能提升为大标签。
    function isAncestorOf(a, b) {
      if ((a.kind || (a.isCustom ? 'custom' : '')) !== (b.kind || (b.isCustom ? 'custom' : ''))) return false;
      const ar = String(a.rel || ''), br = String(b.rel || '');
      return !!ar && !!br && br !== ar && br.startsWith(ar + '/');
    }
    const visibleSelected = computed(() => {
      const list = (props.selected || []).filter((t) => t && !t.hidden && !t.inner);
      return list.filter((t) => !list.some((u) => u !== t && isAncestorOf(t, u)));
    });

    // 展示树分区：提示词标签（词库，非自定义，保留原有树形）+ 自定义标签（保留层级树：父级为可展开分组容器，叶子才是标签）。
    // 当前图片有标签时按完整路径（'测试/喜欢'）重建挂载树；否则直接用全量自定义树（后端已按 parent_id 组织层级）。
    const wbTree = computed(() => (tree.value || []).filter((n) => !n.isCustom));
    const csTree = computed(() => {
      const all = tree.value || [];
      return props.currentTags && props.currentTags.length
        ? buildPathTree(props.currentTags.filter((t) => t && t.custom))
        : all.filter((n) => n.isCustom);
    });
    const wbCount = computed(() => countNodes(wbTree.value));
    const csCount = computed(() => countNodes(csTree.value));

    // ---------------- 自定义标签增删改 ----------------
    const menu = ref({ open: false, x: 0, y: 0, node: null, confirm: false, busy: false });
    const dlg = ref({ open: false, mode: 'create', parentId: null, parentName: '', targetId: null, value: '', err: '', busy: false });
    const dlgInput = ref(null);

    function onDocDown() { closeMenu(); }
    function openMenu(payload) {
      const node = payload && payload.node;
      if (!node) return;
      const w = 176, h = 150;
      const x = Math.max(8, Math.min(payload.x, window.innerWidth - w - 8));
      const y = Math.max(8, Math.min(payload.y, window.innerHeight - h - 8));
      menu.value = { open: true, x, y, node, confirm: false, busy: false };
      document.addEventListener('mousedown', onDocDown);
    }
    function closeMenu() {
      if (menu.value.open) menu.value = { open: false, x: 0, y: 0, node: null, confirm: false, busy: false };
      document.removeEventListener('mousedown', onDocDown);
    }
    function startCreate(parentNode) {
      closeMenu();
      dlg.value = {
        open: true, mode: 'create',
        parentId: parentNode && parentNode.id != null ? parentNode.id : null,
        parentName: parentNode ? leafName(parentNode.name) : '',
        targetId: null, value: '', err: '', busy: false,
      };
      focusDlg();
    }
    function startRename(node) {
      closeMenu();
      if (!node || node.id == null) return;
      dlg.value = {
        open: true, mode: 'rename', parentId: null, parentName: '',
        targetId: node.id, value: leafName(node.name), err: '', busy: false,
      };
      focusDlg();
    }
    function focusDlg() {
      nextTick(() => {
        const el = dlgInput.value;
        if (el) { el.focus(); el.select(); }
      });
    }
    function closeDlg() {
      if (dlg.value.busy) return;
      dlg.value.open = false;
    }

    async function postCustomTag(payload) {
      const r = await fetch(API.customTag, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let d = {};
      try { d = await r.json(); } catch (e) { d = {}; }
      if (!r.ok || d.error) throw new Error(d.error || ('请求失败（' + r.status + '）'));
      return d;
    }

    async function submitDlg() {
      const name = String(dlg.value.value || '').trim();
      if (!name) { dlg.value.err = '名称不能为空'; return; }
      if (TAG_PATH_SEPS.test(name)) { dlg.value.err = '名称不能包含 / \\ : - 等层级分隔符'; return; }
      dlg.value.busy = true;
      dlg.value.err = '';
      try {
        const d = dlg.value.mode === 'create'
          ? await postCustomTag({ op: 'create', parent_id: dlg.value.parentId, name })
          : await postCustomTag({ op: 'rename', id: dlg.value.targetId, name });
        dlg.value.open = false;
        await loadTree(true);
        emit('refresh');
        flash(dlg.value.mode === 'create'
          ? (d && d.existed ? '同名标签已存在，已复用' : '已新建「' + name + '」')
          : '已重命名为「' + name + '」');
      } catch (e) {
        dlg.value.err = e.message || '操作失败';
      } finally {
        dlg.value.busy = false;
      }
    }

    async function doDelete() {
      const node = menu.value.node;
      if (!node || node.id == null) return;
      menu.value.busy = true;
      try {
        const d = await postCustomTag({ op: 'delete', id: node.id });
        // 该标签若已放入外部过滤区，一并移除，避免残留一个查不到数据的筛选项
        emit('remove', { name: node.rel || node.name, rel: node.rel || '', id: node.id, isCustom: true, kind: 'custom' });
        closeMenu();
        await loadTree(true);
        emit('refresh');
        const n = (d && d.removed) || 1;
        const u = (d && d.unlinked) || 0;
        flash('已删除「' + leafName(node.name) + '」' + (n > 1 ? '及其 ' + (n - 1) + ' 个子标签' : '') + (u ? '，已解除 ' + u + ' 张图的关联' : ''));
      } catch (e) {
        menu.value.busy = false;
        closeMenu();
        flash('删除失败：' + (e.message || e));
      }
    }

    // 上下分区：提示词标签在上、自定义标签在下，中间分隔线可拖拽调整区域大小（百分比持久化）
    const wbPct = ref(55);
    (function loadSplitPref() {
      try {
        const v = parseFloat(localStorage.getItem('zhule_gallery_ttp_wb') || '');
        if (v >= 12 && v <= 88) wbPct.value = v;
      } catch (e) { /* ignore */ }
    })();
    function zoneStyle(name) {
      return name === 'wb' ? { flexBasis: wbPct.value + '%' } : {};
    }
    function startSplitDrag(e) {
      const split = e.currentTarget.parentElement;
      if (!split) return;
      const rect = split.getBoundingClientRect();
      if (rect.height <= 0) return;
      const onMove = (ev) => {
        const pct = Math.max(12, Math.min(88, ((ev.clientY - rect.top) / rect.height) * 100));
        wbPct.value = pct;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        try { localStorage.setItem('zhule_gallery_ttp_wb', String(Math.round(wbPct.value))); } catch (err) { /* ignore */ }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }

    return {
      tree, wbTree, csTree, wbCount, csCount, countOf, leafName, tagKey, loading, err, setFilter, removeFilter, clearAll, close,
      selTagStyle, visibleSelected, wbPct, zoneStyle, startSplitDrag,
      toast, menu, dlg, dlgInput, openMenu, closeMenu, startCreate, startRename, closeDlg, submitDlg, doDelete,
    };
  },
  template: `
  <div class="zhg-ttp-mask" v-if="show" @mousedown.self="close">
    <div class="zhg-ttp">
      <div class="zhg-ttp-head">
        <span class="zhg-ttp-title">标签层级</span>
        <span class="zhg-ttp-hint">左键：放到外部过滤区 / 右键：展开 / Ctrl+右键：收起</span>
        <span class="zhg-ttp-flash" v-if="toast">{{ toast }}</span>
        <button class="zhg-ttp-close" data-tip="关闭" @click="close">✕</button>
      </div>
      <div class="zhg-ttp-body" v-if="!loading && !err">
        <div class="zhg-ttp-selected" v-if="visibleSelected.length">
          <span class="zhg-ttp-sel-label">外部过滤区：</span>
          <span class="zhg-sel-tag zhg-out-tag" :class="[themeCls, { on: t.active, off: !t.active, hid: t.hidden }]"
                :style="selTagStyle(t.name)"
                v-for="t in visibleSelected" :key="tagKey(t)" @click="removeFilter(t)">
            {{ leafName(t.name) }}<span class="zhg-ttp-count" v-if="showCount && countOf(t) != null">{{ countOf(t) }}</span><span class="zhg-sel-tag-x">✕</span>
          </span>
          <a class="zhg-ttp-reset" @click="clearAll">清空</a>
        </div>
        <div class="zhg-ttp-split">
          <div class="zhg-ttp-zone zhg-ttp-zone-wb" :style="zoneStyle('wb')">
            <div class="zhg-ttp-zone-head">
              <span class="zhg-ttp-zone-title">提示词标签</span>
              <span class="zhg-ttp-zone-badge">{{ wbCount }}</span>
            </div>
            <div class="zhg-ttp-tree">
              <tag-node v-for="n in wbTree" :key="n.rel" :node="n" :depth="0" :theme-cls="themeCls" :color-of="colorOf"
                        :show-count="showCount" :count-of="countOf"
                        @add="setFilter($event)" @remove="removeFilter($event)" @toggle="setFilter($event)"></tag-node>
            </div>
          </div>
          <div class="zhg-ttp-divider" title="拖拽调整区域大小" @mousedown.prevent="startSplitDrag"></div>
          <div class="zhg-ttp-zone zhg-ttp-zone-cs" :style="zoneStyle('cs')">
            <div class="zhg-ttp-zone-head">
              <span class="zhg-ttp-zone-title">自定义标签</span>
              <span class="zhg-ttp-zone-badge">{{ csCount }}</span>
              <span class="zhg-ttp-zone-gap"></span>
              <a class="zhg-ttp-add" data-tip="新建一个顶层自定义标签" @click="startCreate(null)">＋ 新建</a>
            </div>
            <div class="zhg-ttp-tree">
              <tag-node v-for="n in csTree" :key="n.rel" :node="n" :depth="0" :theme-cls="themeCls" :color-of="colorOf" :manage="true"
                        :show-count="showCount" :count-of="countOf"
                        @add="setFilter($event)" @remove="removeFilter($event)" @toggle="setFilter($event)"
                        @menu="openMenu"></tag-node>
            </div>
            <div class="zhg-ttp-empty" v-if="!csTree.length">
              还没有自定义标签，点右上「＋ 新建」加一个，比如「喜欢」。
            </div>
          </div>
        </div>
      </div>
      <div class="zhg-ttp-loading" v-else-if="loading">加载中…</div>
      <div class="zhg-ttp-err" v-else>{{ err }}</div>

      <div class="zhg-ttp-menu" v-if="menu.open" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @mousedown.stop @contextmenu.prevent>
        <template v-if="!menu.confirm">
          <div class="zhg-ttp-menu-head">{{ leafName(menu.node && menu.node.name) }}</div>
          <div class="zhg-ttp-menu-item" @click="startCreate(menu.node)">＋ 新建子标签</div>
          <div class="zhg-ttp-menu-item" @click="startRename(menu.node)">✎ 重命名</div>
          <div class="zhg-ttp-menu-item danger" @click="menu.confirm = true">🗑 删除</div>
        </template>
        <div class="zhg-ttp-menu-confirm" v-else>
          <div class="zhg-ttp-menu-warn">
            删除「{{ leafName(menu.node && menu.node.name) }}」及其全部子标签？
            图片上挂着的该标签会一并解除。
          </div>
          <div class="zhg-ttp-menu-btns">
            <button class="zhg-ttp-btn danger" :disabled="menu.busy" @click="doDelete">{{ menu.busy ? '删除中…' : '确认删除' }}</button>
            <button class="zhg-ttp-btn" @click="menu.confirm = false">取消</button>
          </div>
        </div>
      </div>

      <div class="zhg-ttp-dlg-mask" v-if="dlg.open" @mousedown.self="closeDlg">
        <div class="zhg-ttp-dlg">
          <div class="zhg-ttp-dlg-title">
            {{ dlg.mode === 'create' ? (dlg.parentName ? '在「' + dlg.parentName + '」下新建标签' : '新建自定义标签') : '重命名标签' }}
          </div>
          <input class="zhg-ttp-dlg-input" ref="dlgInput" v-model="dlg.value" maxlength="40"
                 placeholder="标签名，例如 喜欢" @keydown.enter="submitDlg" @keydown.esc="closeDlg">
          <div class="zhg-ttp-dlg-err" v-if="dlg.err">{{ dlg.err }}</div>
          <div class="zhg-ttp-dlg-btns">
            <button class="zhg-ttp-btn primary" :disabled="dlg.busy" @click="submitDlg">{{ dlg.busy ? '保存中…' : '确定' }}</button>
            <button class="zhg-ttp-btn" @click="closeDlg">取消</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  `,
};
