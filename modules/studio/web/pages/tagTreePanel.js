import { ref, watch, computed } from 'vue';

const API = {
  tagtree: '/zhule_studio/api/gallery/tagtree',
};

// 显示工具：完整路径只取叶子段（'测试/喜欢' → '喜欢'；词条名无 '/' 时原样返回）
function leafName(n) {
  const s = String(n || '');
  const parts = s.split('/');
  let i = parts.length - 1;
  while (i >= 0 && !parts[i]) i--;
  return i >= 0 ? parts[i] : s;
}
// 递归收集树中所有叶子节点（自定义标签只平铺叶子，父级仅分组容器不展示）。
// 叶子 name 统一为完整路径（'测试/喜欢'），展示时由 leafName 取末段，保证过滤/移除逻辑与
// currentTags 分支一致（外部过滤区与存储关联均以完整路径为准）。
function collectLeaves(ns) {
  const out = [];
  for (const n of ns || []) {
    if (n.children && n.children.length) out.push(...collectLeaves(n.children));
    else out.push({ ...n, name: n.rel || n.name });
  }
  return out;
}

// 递归节点：chip 样式与外部 zhg-sel-tag 一致；尺寸随自身子树深度放大（叶子=基准，子树越深越大）；
// 左键 = 放置到外部过滤区（待生效），右键 = 包裹式展开/收起子标签，Ctrl+右键 = 逐级优先收起。
const TagNode = {
  name: 'TagNode',
  props: {
    node: { type: Object, required: true },
    depth: { type: Number, default: 0 },
    themeCls: { type: String, default: '' },
  },
  emits: ['add', 'remove'],
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
      return {
        fontSize: Math.round(12 * scale) + 'px',
        padding: Math.round(5 * scale) + 'px ' + Math.round(12 * scale) + 'px',
      };
    };
    function onLeft() { emit('add', props.node); }
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
    return { expanded, hasKids, chipStyle, leafName, onLeft, onCtx };
  },
  template: `
  <div class="zhg-ttp-wrap" :class="{ open: expanded }">
    <span class="zhg-ttp-chip" v-if="!expanded" :class="[themeCls, { leaf: !hasKids(), 'hl-custom': node.isCustom }]" :style="chipStyle()"
          :data-tip="node.isCustom
            ? (hasKids() ? '自定义标签，左键：放到外部过滤区 / 右键：展开 / Ctrl+右键：收起' : '自定义标签，左键：放到外部过滤区')
            : (hasKids() ? '左键：放到外部过滤区 / 右键：展开 / Ctrl+右键：收起' : '左键：放到外部过滤区')"
          @click="onLeft" @contextmenu.prevent="onCtx">
      {{ leafName(node.name) }}<span class="zhg-ttp-count" v-if="node.count != null">{{ node.count }}</span>
      <span class="zhg-ttp-arrow" v-if="hasKids()">▸</span>
    </span>
    <div class="zhg-ttp-open" v-else :style="chipStyle()" @contextmenu.prevent="onCtx">
      <tag-node v-for="c in node.children" :key="c.rel" :node="c" :depth="depth + 1" :theme-cls="themeCls"
                @add="$emit('add', $event)" @remove="$emit('remove', $event)"></tag-node>
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
  },
  emits: ['close', 'add', 'remove', 'clear'],
  setup(props, { emit }) {
    const tree = ref([]);
    const loading = ref(false);
    const err = ref('');

    async function loadTree(force = false) {
      if (tree.value.length && !force) return;
      loading.value = true;
      err.value = '';
      try {
        const r = await fetch(API.tagtree, { headers: { 'Cache-Control': 'no-cache' } });
        const d = await r.json();
        if (Array.isArray(d.tree)) tree.value = d.tree;
        else err.value = d.error || '加载失败';
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
      (v) => { if (v) open(); }
    );

    // 左键：放置到外部过滤区（待生效），父组件决定新增/恢复/移除
    function setFilter(node) { emit('add', node); }
    // 面板内已放置标签：点击移除
    function removeFilter(name) {
      const t = props.selected.find((x) => x.name === name);
      if (t) emit('remove', name);
    }
    function clearAll() {
      if (props.selected.length) emit('clear');
    }
    function close() { emit('close'); }

    // 展示树：词库部分（非自定义，保留原有树形）+ 自定义部分（一律平铺叶子，不出现可点击父级）。
    // 当前图片有标签时按 detail.tags 平铺实际挂载的叶子；否则用全量自定义树收集叶子。
    const displayTree = computed(() => {
      const all = tree.value || [];
      const wb = all.filter((n) => !n.isCustom);
      const cs = props.currentTags && props.currentTags.length
        ? props.currentTags.filter((t) => t && t.custom).map((t) => ({
            name: t.name, rel: t.name, leaf: true, isCustom: true, children: [],
          }))
        : collectLeaves(all.filter((n) => n.isCustom));
      return [...wb, ...cs];
    });

    return {
      tree, displayTree, leafName, loading, err, setFilter, removeFilter, clearAll, close,
    };
  },
  template: `
  <div class="zhg-ttp-mask" v-if="show" @mousedown.self="close">
    <div class="zhg-ttp">
      <div class="zhg-ttp-head">
        <span class="zhg-ttp-title">标签层级</span>
        <span class="zhg-ttp-hint">左键：放到外部过滤区 / 右键：展开 / Ctrl+右键：收起</span>
        <button class="zhg-ttp-close" data-tip="关闭" @click="close">✕</button>
      </div>
      <div class="zhg-ttp-body" v-if="!loading && !err">
        <div class="zhg-ttp-selected" v-if="selected.length">
          <span class="zhg-ttp-sel-label">外部过滤区：</span>
          <span class="zhg-sel-tag" :class="[themeCls, { on: t.active, off: !t.active, hid: t.hidden }]"
                v-for="t in selected" :key="'st'+t.name" @click="removeFilter(t.name)">
            {{ leafName(t.name) }}<span class="zhg-sel-tag-x">✕</span>
          </span>
          <a class="zhg-ttp-reset" @click="clearAll">清空</a>
        </div>
        <div class="zhg-ttp-tree">
          <tag-node v-for="n in displayTree" :key="n.rel" :node="n" :depth="0" :theme-cls="themeCls"
                    @add="setFilter($event)" @remove="removeFilter($event)"></tag-node>
        </div>
      </div>
      <div class="zhg-ttp-loading" v-else-if="loading">加载中…</div>
      <div class="zhg-ttp-err" v-else>{{ err }}</div>
    </div>
  </div>
  `,
};
