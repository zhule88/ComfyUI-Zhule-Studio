import { ref, watch } from 'vue';

const API = {
  tagtree: '/zhule_studio/api/gallery/tagtree',
};

// 递归节点：chip 样式与外部 zhg-sel-tag 一致；尺寸随自身子树深度放大（叶子=基准，子树越深越大）；
// 左键 = 放置到外部过滤区（待生效），右键 = 包裹式展开/收起子标签，Ctrl+右键 = 逐级优先收起。
const TagNode = {
  name: 'TagNode',
  props: {
    node: { type: Object, required: true },
    depth: { type: Number, default: 0 },
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
    function onLeft() { emit('add', props.node.name); }
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
    return { expanded, hasKids, chipStyle, onLeft, onCtx };
  },
  template: `
  <div class="zhg-ttp-wrap" :class="{ open: expanded }">
    <span class="zhg-ttp-chip" v-if="!expanded" :class="{ leaf: !hasKids() }" :style="chipStyle()"
          :data-tip="hasKids() ? '左键：放到外部过滤区 / 右键：展开 / Ctrl+右键：收起' : '左键：放到外部过滤区'"
          @click="onLeft" @contextmenu.prevent="onCtx">
      {{ node.name }}<span class="zhg-ttp-count" v-if="node.count != null">{{ node.count }}</span>
      <span class="zhg-ttp-arrow" v-if="hasKids()">▸</span>
    </span>
    <div class="zhg-ttp-open" v-else :style="chipStyle()" @contextmenu.prevent="onCtx">
      <tag-node v-for="c in node.children" :key="c.rel" :node="c" :depth="depth + 1"
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
    function setFilter(name) { emit('add', name); }
    // 面板内已放置标签：点击移除
    function removeFilter(name) {
      const t = props.selected.find((x) => x.name === name);
      if (t) emit('remove', name);
    }
    function clearAll() {
      if (props.selected.length) emit('clear');
    }
    function close() { emit('close'); }

    return {
      tree, loading, err, setFilter, removeFilter, clearAll, close,
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
          <span class="zhg-sel-tag" :class="{ on: t.active, off: !t.active, hid: t.hidden }"
                v-for="t in selected" :key="'st'+t.name" @click="removeFilter(t.name)">
            {{ t.name }}<span class="zhg-sel-tag-x">✕</span>
          </span>
          <a class="zhg-ttp-reset" @click="clearAll">清空</a>
        </div>
        <div class="zhg-ttp-tree">
          <tag-node v-for="n in tree" :key="n.rel" :node="n" :depth="0"
                    @add="setFilter($event)" @remove="removeFilter($event)"></tag-node>
        </div>
      </div>
      <div class="zhg-ttp-loading" v-else-if="loading">加载中…</div>
      <div class="zhg-ttp-err" v-else>{{ err }}</div>
    </div>
  </div>
  `,
};
