import { ref, reactive, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import TagTreePanel from './tagTreePanel.js';
import { useMarqueeSelect } from './marqueeSelect.js';

const API = {
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
};
const PAGE_SIZE = 60;

// 外部过滤区递归节点：俄罗斯套娃包裹式展开（与 tagTreePanel 视觉一致，尺寸随子树深度放大）
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
    function fwdAdd(name) { emit('add', name); }
    function fwdHide(name) { emit('hide', name); }
    return {
      expanded, kids, hasKids, chipStyle, boxStyle,
      onClick, onCtx, fwdToggle, fwdAdd, fwdHide,
    };
  },
  template: `
    <div class="zhg-out-wrap" :class="{ open: expanded }">
      <span class="zhg-sel-tag" v-if="!expanded" :class="{ on: isActive(node.name), off: !isActive(node.name), leaf: !hasKids() }" :style="chipStyle()"
            :data-tip="(isActive(node.name) ? '生效中，点击停用' : '待生效，点击启用') + ' / Ctrl+左键隐藏（移除） / 右键展开收起'"
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

async function jfetch(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error('请求失败 ' + res.status);
  return res.json();
}

const DEFAULT_PREF = {
  gallery: {
    showName: true, showTime: true, showModel: true, showTags: true, timeFmt: 'yyyy-MM-dd HH:mm',
    promptTagColor: '#2a9d8f', customTagColor: '#e07b39'
  },
  wordbank: {},
};
function loadPref() {
  try {
    const raw = JSON.parse(localStorage.getItem('zhule_ui_pref') || '{}');
    return {
      gallery: Object.assign({}, DEFAULT_PREF.gallery, (raw && raw.gallery) || {}),
      wordbank: Object.assign({}, DEFAULT_PREF.wordbank, (raw && raw.wordbank) || {}),
    };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_PREF));
  }
}

function fmtTime(ts, fmt) {
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

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// 展示模型名时去掉 .safetensors 等文件扩展名
function fmtModel(name) {
  if (!name) return '';
  return name.replace(/\.[^.\/\\]+$/, '');
}

export default {
  name: 'GalleryTopDown',
  components: { TagTreePanel, OutNode },
  template: `
  <div class="page active gallery-page gallery-td-page">
    <div class="zhg-toolbar">
      <input class="zhg-search" v-model="filters.q" placeholder="搜索文件名 / 模型 / 标签…" @keyup="onSearchKeyup">
      <div class="zhg-sort-box" data-tip="按时间排序">
        <button class="zhg-sort-arrow" @click="toggleSortDir"
                :data-tip="filters.sortDir === 'desc' ? '按时间倒序（新→旧），点击切换升序' : '按时间正序（旧→新），点击切换降序'">{{ filters.sortDir === 'desc' ? '▾' : '▴' }}</button>
      </div>
      <button class="btn zhg-layout-btn" :data-tip="isTopDown ? '切换到左右布局' : '切换到上下布局'" @click="toggleLayout">⧉</button>
      <button class="btn zhg-trash-btn" :class="{on: selected.size > 0}" :disabled="!selected.size"
              data-tip="删除选中的图片（拖动框选或 Ctrl+点击 多选）" @click="askBatchDelete">🗑</button>
      <button class="btn zhg-link-btn" :class="{on: selected.size > 0}" :disabled="!selected.size"
              data-tip="把选中的图片以硬链接方式导出到 zhule_link（同卷零拷贝，每次自动新建独立子文件夹）" @click="batchLink">🔗</button>
      <button class="btn zhg-filters-toggle" :class="{on: filtersOpen}" :data-tip="filtersOpen ? '收起整个筛选区' : '展开整个筛选区'" @click="toggleFilters">{{ filtersOpen ? '▲ 收起筛选' : '▼ 展开筛选' }}</button>
      <span class="zhg-sel-count" v-if="selected.size">已选 <b>{{ selected.size }}</b>
        <a class="zhg-sel-clear" @click="selected.clear()">清除</a></span>
      <span class="zhg-total">共 <b>{{ meta.total }}</b> 张 / 命中 <b>{{ total }}</b></span>
      <span class="zhg-page-ctl" data-tip="每页显示张数">
        <span class="zhg-ctl-ico">☰</span>
        <button class="zhg-pg-btn" @click="changePageSize(-10)" :disabled="pageSize <= 10" data-tip="每页减少10张">−</button>
        <b class="zhg-pg-val">{{ pageSize }}</b>
        <button class="zhg-pg-btn" @click="changePageSize(10)" :disabled="pageSize >= 200" data-tip="每页增加10张">＋</button>
      </span>
      <span class="zhg-grid-ctl" data-tip="每行卡片数">
        <span class="zhg-ctl-ico">⊞</span>
        <button class="zhg-pg-btn" @click="changeGridCols(-1)" :disabled="gridCols <= 2" data-tip="每行减少1张">−</button>
        <b class="zhg-pg-val">{{ gridCols }}</b>
        <button class="zhg-pg-btn" @click="changeGridCols(1)" :disabled="gridCols >= 10" data-tip="每行增加1张">＋</button>
      </span>
      <span class="zhg-pager" v-if="total > pageSize" data-tip="第 {{ page }} / {{ totalPages }} 页">
        <button class="zhg-pg-btn" @click="goPage(page - 1)" :disabled="page <= 1" data-tip="上一页">◀</button>
        <span class="zhg-pg-info">{{ page }} / {{ totalPages }}</span>
        <button class="zhg-pg-btn" @click="goPage(page + 1)" :disabled="page >= totalPages" data-tip="下一页">▶</button>
      </span>
      <span class="zhg-dirty" v-if="dirty">有新图片，索引已自动重建</span>
    </div>

    <tag-tree-panel :show="tagPanelOpen" :selected="filters.tags"
                    @close="tagPanelOpen = false" @add="addTagFilter" @remove="removeTag" @clear="clearTagFilter"></tag-tree-panel>

    <!-- 上下结构：筛选区置顶 -->
    <div class="zhg-td-filters" :style="sideStyle" v-show="filtersOpen">
      <!-- 模型（可选筛选列） -->
      <div class="zhg-td-block" data-name="model" v-if="pref.gallery.showModelFilter !== false" :style="blockStyle('model')">
        <div class="zhg-block-head">
          <span class="zhg-block-title">模型</span>
        </div>
        <div class="zhg-block-body">
          <label class="zhg-opt" v-for="m in meta.models" :key="'m'+m.name">
            <input type="checkbox" :checked="filters.models.includes(m.name)" @change="toggleModel(m.name)">
            <span class="zhg-opt-name" :data-tip="m.name">{{ fmtModel(m.name) }}</span>
            <span class="zhg-opt-count">{{ m.count }}</span>
            <button class="btn zhg-mini zhg-rename-btn" data-tip="重命名模型，同步所有关联图片" @click.stop.prevent="openRename('model', m.name)">⚙</button>
          </label>
          <div class="zhg-none" v-if="!meta.models.length">暂无</div>
        </div>
        <div class="zhg-block-resize-x" data-tip="拖拽调整此筛选块宽度" @mousedown.prevent="startBlockDrag($event, 'model')"></div>
      </div>

      <!-- LoRA（可选筛选列） -->
      <div class="zhg-td-block" data-name="lora" v-if="pref.gallery.showLoraFilter !== false" :style="blockStyle('lora')">
        <div class="zhg-block-head">
          <span class="zhg-block-title">LoRA</span>
        </div>
        <div class="zhg-block-body">
          <label class="zhg-opt" v-for="l in meta.loras" :key="'l'+l.name">
            <input type="checkbox" :checked="filters.loras.includes(l.name)" @change="toggleLora(l.name)">
            <span class="zhg-opt-name" :data-tip="l.name">{{ l.name }}</span>
            <span class="zhg-opt-count">{{ l.count }}</span>
            <button class="btn zhg-mini zhg-rename-btn" data-tip="重命名 LoRA，同步所有关联图片" @click.stop.prevent="openRename('lora', l.name)">⚙</button>
          </label>
          <div class="zhg-none" v-if="!meta.loras.length">暂无</div>
        </div>
        <div class="zhg-block-resize-x" data-tip="拖拽调整此筛选块宽度" @mousedown.prevent="startBlockDrag($event, 'lora')"></div>
      </div>

      <!-- 标签（层级浏览：齿轮弹大框） -->
      <div class="zhg-td-block" data-name="tag" :style="blockStyle('tag')">
        <div class="zhg-block-head">
          <span class="zhg-block-title">标签 <span class="zhg-badge">{{ visibleTags.length }}</span></span>
          <button class="zhg-tag-mode-btn" :data-tip="'标签过滤模式：' + (filters.tagMode === 'and' ? '与（AND，满足全部已启用标签）' : '或（OR，满足任一已启用标签）') + '，点击切换'"
                  @click.stop="toggleTagMode()">{{ filters.tagMode === 'and' ? '与' : '或' }}</button>
          <span class="zhg-tag-gear" data-tip="编辑标签" @click.stop="tagPanelOpen = true">⚙</span>
        </div>
        <div class="zhg-block-body">
          <!-- 外部过滤区：俄罗斯套娃包裹式展开；普通左键点击启用/禁用，Ctrl+左键隐藏（完全移除），普通右键展开/收起，Ctrl+右键展开还原（逐级收起） -->
          <div class="zhg-sel-tags" v-if="visibleTags.length">
            <out-node v-for="t in visibleTags" :key="'st'+t.name" :node="t" :depth="0"
                      :in-filter="inTagFilter" :is-active="isTagActive" :is-hidden="isTagHidden" :tree-kids-fn="treeKids"
                      @toggle="toggleTagActive" @add="addTagFilter" @hide="hideTag"></out-node>
          </div>
        </div>
        <div class="zhg-block-resize-x" data-tip="拖拽调整此筛选块宽度" @mousedown.prevent="startBlockDrag($event, 'tag')"></div>
      </div>
    </div>
    <div class="zhg-td-resize-x" data-tip="拖拽调整筛选区宽度" @mousedown.prevent="startSideDrag($event, 'w')"></div>
    <div class="zhg-td-resize-y" data-tip="拖拽调整筛选区高度" @mousedown.prevent="startSideDrag($event, 'h')"></div>

    <!-- 下方图片区 -->
    <div class="zhg-td-main" ref="mainEl">
      <div class="zhule-loader" v-if="loading && !items.length"><div class="loader"></div></div>
      <div class="zhg-grid" ref="gridEl" :style="gridStyle" v-if="items.length" @pointerdown="onPointerDown">
        <div class="zhg-card" v-for="it in items" :key="it.key" :data-key="it.key"
             :class="{sel: isSel(it.key)}" @click="onCardClick(it, $event)">
          <div class="zhg-thumb-wrap">
            <img class="zhg-thumb" loading="lazy" :src="thumbUrl(it.key, it.mtime)" :alt="it.name">
            <button class="zhg-del-btn" data-tip="删除图片" @click.stop="askDelete(it)">✕</button>
            <button class="zhg-zoom-btn" data-tip="全屏查看" @click.stop="zoomView(imgUrl(it.key, it.mtime))">🔍</button>
            <span class="zhg-sel-badge" v-if="isSel(it.key)">✓</span>
          </div>
          <div class="zhg-card-info">
            <div class="zhg-card-name" v-if="pref.gallery.showName" :data-tip="it.name">{{ it.name }}</div>
            <div class="zhg-card-time" v-if="pref.gallery.showTime">{{ fmtTime(it.mtime, pref.gallery.timeFmt) }}</div>
            <div class="zhg-card-model" v-if="pref.gallery.showModel && it.model" :data-tip="it.model">{{ fmtModel(it.model) }}</div>
            <div class="zhg-card-tags" v-if="pref.gallery.showTags && it.tags && it.tags.length">
              <span class="zhg-card-tag" v-for="t in it.tags.slice(0, 4)" :key="it.key+t">{{ t }}</span>
              <span class="zhg-card-tag-more" v-if="it.tags.length > 4">+{{ it.tags.length - 4 }}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="zhg-empty" v-else-if="!loading">
        <div v-if="total === 0 && !hasFilter">图库为空，快去用 Zhule Save Image 出图吧</div>
        <div v-else>没有符合筛选条件的图片</div>
      </div>
      <div class="zhg-foot" v-if="loadingMore">加载中…</div>
    </div>

    <!-- 详情弹层 -->
    <div class="zhg-mask" v-if="detail" @click.self="closeDetail">
      <div class="zhg-modal">
        <div class="zhg-modal-head">
          <span class="zhg-modal-title">{{ detail.name }}</span>
          <button class="btn zhg-mini" @click="closeDetail">✕ 关闭</button>
        </div>
        <div class="zhg-modal-body">
          <div class="zhg-modal-left">
            <img class="zhg-modal-img" :src="imgUrl(detail.path, detail.mtime)" :alt="detail.name" @click="zoomView(imgUrl(detail.path, detail.mtime))">
            <div class="zhg-modal-actions">
              <button class="btn primary" :disabled="!detail.hasWF" @click="useWorkflow(detail)" :data-tip="detail.hasWF ? '跳转 ComfyUI 并导入该图工作流' : '该图片没有保存 workflow 元数据'">
                ⚡ 在 ComfyUI 中使用工作流
              </button>
            </div>
          </div>
          <div class="zhg-modal-right">
            <div class="zhg-detail-row"><span class="zhg-detail-k">文件</span><span class="zhg-detail-v">{{ detail.name }}</span></div>
            <div class="zhg-detail-row"><span class="zhg-detail-k">时间</span><span class="zhg-detail-v">{{ fmtTime(detail.mtime) }}</span></div>
            <div class="zhg-detail-row"><span class="zhg-detail-k">大小</span><span class="zhg-detail-v">{{ fmtSize(detail.size) }}</span></div>
            <div class="zhg-detail-row"><span class="zhg-detail-k">模型</span>
              <span class="zhg-detail-v" :data-tip="detail.model || ''">{{ detail.model ? fmtModel(detail.model) : '—' }}</span></div>
            <div class="zhg-detail-row"><span class="zhg-detail-k">LoRA</span>
              <div class="zhg-detail-v zhg-detail-tags">
                <span class="zhg-lora" v-for="l in detail.loras" :key="'dl'+l">{{ l }}</span>
                <span v-if="!detail.loras.length">—</span>
              </div></div>

            <div class="zhg-detail-section">
              <div class="zhg-detail-section-title">标签 <span class="zhg-badge">{{ detail.tags.length }}</span></div>
              <div class="zhg-detail-row">
                <div class="zhg-detail-tags">
                  <span class="zhg-tag" :class="{ on: !t.prompt && !t.custom, readonly: t.prompt || t.custom, 'hl-prompt': t.prompt, 'hl-custom': t.custom }"
                        :style="tagStyle(t)"
                        v-for="t in uniqueDetailTags" :key="'dt'+t.name"
                        :data-tip="(t.prompt || t.custom) ? '来自提示词/工作流（只读）' : ''">
                    {{ t.name }}<span v-if="!t.prompt && !t.custom" class="zhg-tag-del" @click.stop="removeTagFromImage(t.name)"> ✕</span>
                  </span>
                  <span v-if="!uniqueDetailTags.length" class="zhg-none">暂无标签，点击下方 ＋ 添加</span>
                </div>
              </div>
              <div class="zhg-detail-tag-add">
                <span class="zhg-tag-add" v-if="!tagInputing" @click="startTagInput">＋ 添加标签</span>
                <div class="zhg-new-row" v-else>
                  <input class="zhg-input" v-model="quickTag" ref="tagInputEl" placeholder="输入标签后回车…"
                         @keyup="onTagKeyup" @blur="onTagInputBlur">
                  <button class="btn zhg-mini" @click="quickCreateTag">确定</button>
                </div>
              </div>
            </div>

            <div class="zhg-detail-section" v-if="detail.hasPrompt">
              <div class="zhg-detail-section-title">提示词</div>
              <pre class="zhg-prompt">{{ detail.promptPreview }}</pre>
              <div class="zhg-prompt-more" v-if="detail.promptPreview.length >= 790">…（已截断）</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 全屏查看：由公共模块 modules/common/zhule_fullviewer.js 命令式接管（非响应式） -->

    <div class="zhg-del-mask" v-if="delTarget" @click.self="cancelDelete">
      <div class="zhg-del-box">
        <div class="zhg-del-title">确认删除图片</div>
        <div class="zhg-del-msg">将删除该图片文件及其缩略图，此操作不可撤销。<br><b>{{ delTarget.name }}</b></div>
        <div class="zhg-del-actions">
          <button class="btn zhg-mini" @click="cancelDelete">取消</button>
          <button class="zhg-del-btn-danger" @click="confirmDelete">确认删除</button>
        </div>
      </div>
    </div>

    <div class="zhg-del-mask" v-if="delBatchOpen" @click.self="cancelBatchDelete">
      <div class="zhg-del-box">
        <div class="zhg-del-title">确认批量删除</div>
        <div class="zhg-del-msg">是否删除选中的 <b>{{ selected.size }}</b> 张图片？<br>将删除图片文件及其缩略图，此操作不可撤销。</div>
        <div class="zhg-del-actions">
          <button class="btn zhg-mini" @click="cancelBatchDelete">取消</button>
          <button class="zhg-del-btn-danger" @click="confirmBatchDelete">确认删除</button>
        </div>
      </div>
    </div>

    <div class="edit-overlay" v-if="renameOpen" @click.self="cancelRename">
      <div class="edit-dialog">
        <div class="title">重命名{{ renameKind === 'model' ? '模型' : 'LoRA' }}</div>
        <div class="hint">重命名模型将同步所有关联图片</div>
        <div class="field">
          <label>新名称（不需要填写后缀，将自动保留原扩展名）</label>
          <input type="text" v-model="renameNew" :placeholder="fmtModel(renameOld)"
                 @keyup.enter="confirmRename" @keyup.esc="cancelRename" ref="renameInput">
        </div>
        <div class="actions">
          <button class="btn zhg-mini" @click="cancelRename">取消</button>
          <button class="btn zhg-mini zhg-rename-confirm" :disabled="!renameNew.trim() || renaming" @click="confirmRename">{{ renaming ? '提交中…' : '确认' }}</button>
        </div>
      </div>
    </div>

    <transition name="toast">
      <div v-if="toast" class="zhg-toast" :class="'toast-' + toastType" @click="toast = ''">
        <span class="zhg-toast-icon">{{ toastIcon[toastType] }}</span>
        <span class="zhg-toast-msg">{{ toast }}</span>
      </div>
    </transition>
  </div>
  `,

  setup() {
    const route = useRoute();
    const router = useRouter();
    const pref = reactive(loadPref());
    function onPrefChanged(e) {
      const p = (e && e.detail) || loadPref();
      const oldModel = pref.gallery.showModelFilter;
      const oldLora = pref.gallery.showLoraFilter;
      Object.assign(pref, p);
      // 模型/LoRA 筛选列显隐变化：块数量变了，重新按容器可用宽等比分配，防止总宽超出撑出横向滚动条
      if (oldModel !== pref.gallery.showModelFilter || oldLora !== pref.gallery.showLoraFilter) {
        nextTick(normalizeBlockWidths);
      }
    }
    function onRebuilt() {
      loadMeta();
      applyFilter();
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
            .map((t) => ({ name: t.name, active: !!t.active, hidden: !!t.hidden, inner: !!t.inner }));
          if (valid.length) filters.tags = valid;
        }
      } catch (e) { /* ignore: 解析失败，保留空 tags */ }
    }
    loadTagPref();
    // 整体展开/收起筛选区
    const filtersOpen = ref(true);
    // 各筛选块宽度（默认 250px，可横向拖拽拉长，最多占满整行，不换行不撑高筛选区）
    const blockW = reactive({ model: 250, lora: 250, tag: 250 });
    function loadBlockPref() {
      try {
        const raw = JSON.parse(localStorage.getItem('zhule_gallery_block_w') || '{}');
        for (const k of ['model', 'lora', 'tag']) {
          const v = Number(raw[k]);
          if (v >= 250 && v <= 4000) blockW[k] = v;
        }
      } catch (e) { /* ignore */ }
    }
    loadBlockPref();
    try { filtersOpen.value = localStorage.getItem('zhule_gallery_filters_open') !== '0'; } catch (e) { /* ignore */ }
    function toggleFilters() {
      filtersOpen.value = !filtersOpen.value;
      try { localStorage.setItem('zhule_gallery_filters_open', filtersOpen.value ? '1' : '0'); } catch (e) { /* ignore */ }
    }
    function blockStyle(name) { return { width: (blockW[name] || 250) + 'px' }; }
    function startBlockDrag(e, name) {
      const startX = e.clientX;
      const startW = blockW[name] || 250;
      // 收集实际显示的块与容器可用宽度（扣除 padding 与 gap），保证总宽守恒、绝不换行
      let avail = 4000;
      const wrap = e.currentTarget.closest('.zhg-td-filters');
      const names = [name];
      if (wrap) {
        const cs = getComputedStyle(wrap);
        const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        const gap = parseFloat(cs.gap) || 10;
        const blocks = Array.from(wrap.querySelectorAll('.zhg-td-block'));
        blocks.forEach((el) => {
          const n = el.getAttribute('data-name');
          if (n && !names.includes(n)) names.push(n);
        });
        avail = Math.max(750, wrap.clientWidth - padX - Math.max(0, blocks.length - 1) * gap);
      }
      const onMove = (ev) => {
        // 以鼠标为准：目标块宽度直接跟随鼠标位移，多余空间自动压缩其它块（每块保底最小宽）
        distributeBlockWidth(name, startW + ev.clientX - startX, avail, names);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        try { localStorage.setItem('zhule_gallery_block_w', JSON.stringify({ model: blockW.model, lora: blockW.lora, tag: blockW.tag })); } catch (err) { /* ignore */ }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
    // 弹性宽度分配：总宽保持占满容器可用宽，其它块自动让出/接收空间，每块保底最小宽
    function distributeBlockWidth(targetName, targetW, avail, names) {
      const MIN = 250;
      const others = names.filter((n) => n !== targetName);
      const othersMin = others.length * MIN;
      const w = Math.max(MIN, Math.min(avail - othersMin, targetW));
      blockW[targetName] = w;
      if (!others.length) return;
      const targetOthersTotal = avail - w;
      const curTotal = others.reduce((s, n) => s + (blockW[n] || MIN), 0);
      if (curTotal <= 0) return;
      if (curTotal > targetOthersTotal) {
        // 其它块总宽超出：从可让空间大的块开始压缩，每块保底 MIN
        let need = Math.min(curTotal - targetOthersTotal,
          others.reduce((s, n) => s + ((blockW[n] || MIN) - MIN), 0));
        const order = others.slice().sort((a, b) => ((blockW[b] || MIN) - MIN) - ((blockW[a] || MIN) - MIN));
        for (const n of order) {
          if (need <= 0) break;
          const curW = blockW[n] || MIN;
          const room = curW - MIN;
          if (room <= 0) continue;
          const take = Math.min(room, need);
          blockW[n] = curW - take;
          need -= take;
        }
      } else if (curTotal < targetOthersTotal) {
        // 其它块总宽不足：按当前宽度比例接收释放的空间
        const give = targetOthersTotal - curTotal;
        for (const n of others) {
          const curW = blockW[n] || MIN;
          blockW[n] = Math.min(4000, curW + give * (curW / curTotal));
        }
      }
    }
    // 重新按容器可用宽等比分配当前可见块：用于块显隐变化（设置里勾选/取消筛选列）后收敛总宽，保证永不溢出、无横向滚动条
    function normalizeBlockWidths() {
      const wrap = document.querySelector('.zhg-td-filters');
      if (!wrap) return;
      const cs = getComputedStyle(wrap);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const gap = parseFloat(cs.gap) || 10;
      const els = Array.from(wrap.querySelectorAll('.zhg-td-block'));
      const names = [];
      els.forEach((el) => {
        const n = el.getAttribute('data-name');
        if (n && !names.includes(n)) names.push(n);
      });
      if (!names.length) return;
      const avail = Math.max(0, wrap.clientWidth - padX - Math.max(0, names.length - 1) * gap);
      if (avail <= 0) return;
      const MIN = 250;
      const minTotal = names.length * MIN;
      let total = names.reduce((s, n) => s + (blockW[n] || MIN), 0);
      if (total <= 0) total = minTotal;
      // 极端窄窗口（容器不足所有块最小宽之和）：等比压到容器宽，允许低于最小宽，优先保证不溢出
      if (avail < minTotal) {
        const ratio = avail / total;
        names.forEach((n) => { blockW[n] = Math.max(40, Math.round((blockW[n] || MIN) * ratio)); });
        try { localStorage.setItem('zhule_gallery_block_w', JSON.stringify({ model: blockW.model, lora: blockW.lora, tag: blockW.tag })); } catch (err) { /* ignore */ }
        return;
      }
      // 普通场景：等比缩放至总宽 = avail，且每块不低于 MIN
      const raw = {};
      names.forEach((n) => { raw[n] = Math.max(MIN, Math.round((blockW[n] || MIN) * (avail / total))); });
      const diff = avail - names.reduce((s, n) => s + raw[n], 0);
      if (diff !== 0) {
        // 取整偏差补给当前最宽的块，保证总宽恰好等于容器可用宽
        const maxN = names.slice().sort((a, b) => raw[b] - raw[a])[0];
        raw[maxN] = Math.max(MIN, raw[maxN] + diff);
      }
      names.forEach((n) => { blockW[n] = raw[n]; });
      try { localStorage.setItem('zhule_gallery_block_w', JSON.stringify({ model: blockW.model, lora: blockW.lora, tag: blockW.tag })); } catch (err) { /* ignore */ }
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
    const side = reactive({ w: 0, h: 0 });
    const sideStyle = computed(() => ({
      width: side.w > 0 ? side.w + 'px' : '',
      height: side.h > 0 ? side.h + 'px' : '',
    }));
    // 筛选区高度上限：不超过视口高度的 60%，避免过滤区占满屏幕把图片区挤出视口
    const sideMaxH = () => Math.max(240, Math.round(window.innerHeight * 0.6));
    function loadSidePref() {
      try {
        const raw = JSON.parse(localStorage.getItem('zhule_gallery_side') || '{}');
        if (raw.w > 300 && raw.w < 2400) side.w = raw.w;
        const maxH = sideMaxH();
        if (raw.h > 120 && raw.h < maxH) side.h = raw.h;
      } catch (e) { /* ignore */ }
      // 默认给筛选区一个固定基准高度，拖高把手才能按鼠标拉高并让块体随高度伸展
      if (!(side.h > 0)) side.h = 320;
    }
    loadSidePref();
    function startSideDrag(e, axis) {
      const startX = e.clientX, startY = e.clientY;
      const startW = side.w, startH = side.h;
      const maxH = sideMaxH();
      const onMove = (ev) => {
        if (axis === 'w') side.w = Math.max(300, Math.min(2400, startW + ev.clientX - startX));
        else side.h = Math.max(120, Math.min(maxH, startH + ev.clientY - startY));
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        try { localStorage.setItem('zhule_gallery_side', JSON.stringify({ w: side.w, h: side.h })); } catch (err) { /* ignore */ }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    }
    function addTagFilter(name) {
      if (!name) return;
      // 放到外部过滤区（编辑面板左键点击触发）：同名未隐藏则移除（toggle）；同名已隐藏=经编辑面板重新放置，
      // 清除隐藏标记恢复显示并置为启用（hidden=false, active=true，与"隐藏不可逆、恢复靠编辑面板重新放置"语义一致）；否则新增待生效（默认红）
      const i = filters.tags.findIndex((t) => t.name === name);
      if (i >= 0) {
        if (filters.tags[i].hidden) {
          filters.tags[i].hidden = false;
          filters.tags[i].active = true;
        } else {
          filters.tags.splice(i, 1);
        }
      } else {
        filters.tags.push({ name, active: false, hidden: false });
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
        filters.tags.push({ name, active: true, hidden: false, inner: true });
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
      else filters.tags.push({ name, active: false, hidden: true, inner: true });
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
    const expandedTags = ref(new Set());
    async function ensureTagTree() {
      if (Object.keys(tagTreeKidsMap.value).length) return;
      try {
        const r = await fetch('/zhule_studio/api/gallery/tagtree', { headers: { 'Cache-Control': 'no-cache' } });
        const d = await r.json();
        if (Array.isArray(d.tree)) {
          const map = {};
          (function walk(ns) {
            for (const n of ns) {
              map[n.name] = (n.children || []).map((c) => ({ name: c.name, children: c.children || [] }));
              walk(n.children || []);
            }
          })(d.tree);
          tagTreeKidsMap.value = map;
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
      isInteractive: (e) => !!(e.target && e.target.closest && e.target.closest('.zhg-del-btn, .zhg-zoom-btn, .zhg-sel-badge')),
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
    // 手动标签名列表（可增删部分）
    function manualTagNames() {
      return (detail.value.tags || [])
        .filter((t) => t && !t.prompt && !t.custom)
        .map((t) => t.name);
    }
    // 打标后重组详情 tags：保留只读来源 + 新的手动标签
    function mergeDetailTags(manualNames) {
      const src = detail.value.tags || [];
      const readonly = src.filter((t) => t && (t.prompt || t.custom));
      const seen = new Set(readonly.map((t) => t.name));
      const manual = [];
      for (const n of manualNames) {
        if (!seen.has(n)) {
          manual.push({ name: n, prompt: false, custom: false });
          seen.add(n);
        }
      }
      return [...readonly, ...manual];
    }

    // 带 mtime 时间戳防浏览器缓存旧图：同名文件重建后 URL 变化，强制拉取新缩略图/原图
    const thumbUrl = (key, t) => API.thumb + '?path=' + encodeURIComponent(key) + '&t=' + (t || '');
    const imgUrl = (key, t) => '/zhule_studio/api/gallery/image?path=' + encodeURIComponent(key) + '&t=' + (t || '');

    async function loadMeta() {
      try {
        const d = await jfetch(API.meta);
        Object.assign(meta, d);
        if (d.building) startBuildingPoll();
      } catch (e) {
        showToast('元数据加载失败', 'error');
      }
    }

    function buildQuery(reset) {
      const p = reset ? 1 : page.value;
      const params = new URLSearchParams({ page: p, pageSize: pageSize.value, sort: filters.sortField + '_' + filters.sortDir });
      if (filters.q) params.set('q', filters.q);
      const actTags = filters.tags.filter((t) => t.active && !t.hidden).map((t) => t.name);
      if (actTags.length) {
        params.set('tags', actTags.join(','));
        params.set('mode', filters.tagMode);
      }
      if (filters.models.length) params.set('models', filters.models.join(','));
      if (filters.loras.length) params.set('loras', filters.loras.join(','));
      return params;
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
        const d = await jfetch(API.list + '?' + buildQuery(reset).toString());
        total.value = d.total;
        if (reset) items.value = d.items;
        else items.value = items.value.concat(d.items);
        allLoaded.value = items.value.length >= d.total;
        if (d.builtAt && d.builtAt) dirty.value = false;
        if (d.building) startBuildingPoll();
      } catch (e) {
        showToast('加载失败', 'error');
      } finally {
        loading.value = false;
        loadingMore.value = false;
      }
    }

    function applyFilter() {
      loadItems(true);
    }

    // ===== 拖动框选（可复用模块 marqueeSelect.js）+ Ctrl 点击多选 =====
    function onCardClick(it, e) {
      if (e.ctrlKey || e.metaKey) {
        if (selected.has(it.key)) selected.delete(it.key); else selected.add(it.key);
        return; // Ctrl+点击只切换选中，不打开详情
      }
      if (Date.now() < suppressClickUntil) return;
      openDetail(it);
    }

    function onScroll() {
      const el = mainEl.value;
      if (!el) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 600) {
        if (!loadingMore.value && !allLoaded.value && !loading.value) loadItems(false);
      }
    }

    function removeTag(name) {
      const i = filters.tags.findIndex((t) => t.name === name);
      if (i >= 0) filters.tags.splice(i, 1);
      applyFilter();
      saveTagPref();
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

    // 索引后台重建轮询：后端 building=true 时每 2s 查一次 meta，完成即刷新列表
    let buildingTimer = null;
    function startBuildingPoll() {
      if (buildingTimer) return;
      buildingTimer = setInterval(async () => {
        try {
          const m = await jfetch(API.meta);
          if (!m.building) {
            clearInterval(buildingTimer);
            buildingTimer = null;
            showToast('索引已重建：' + (m.total || 0) + ' 张', 'success');
            await loadMeta();
            applyFilter();
          }
        } catch (e) {
          /* 单次轮询失败忽略，下轮再试 */
        }
      }, 2000);
    }

    async function rescan() {
      try {
        const d = await jfetch(API.rescan, { method: 'POST' });
        showToast('索引重建中，请稍候…');
        startBuildingPoll();
        void d;
      } catch (e) {
        showToast('重建失败', 'error');
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
      const names = manualTagNames();
      if (!names.includes(name)) {
        await annotate({ tags: [...names, name] });
      }
      quickTag.value = '';
      tagInputing.value = false;
    }

    async function openDetail(item) {
      try {
        const d = await jfetch(API.detail + '?path=' + encodeURIComponent(item.key));
        detail.value = d;
        quickTag.value = '';
        tagInputing.value = false;
      } catch (e) {
        showToast('详情加载失败', 'error');
      }
    }

    function closeDetail() { detail.value = null; }

    // 详情只读标签（提示词 / 自定义来源）高亮色，取自设置面板可配置项
    function tagStyle(t) {
      if (t.prompt) return { background: pref.gallery.promptTagColor };
      if (t.custom) return { background: pref.gallery.customTagColor };
      return null;
    }

    function askDelete(item) { delTarget.value = item; }
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

    function askBatchDelete() {
      if (!selected.size) { showToast('请先框选或 Ctrl+点击 选中要删除的图片', 'warn'); return; }
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
        if ('tags' in payload) d.tags = mergeDetailTags(payload.tags);
        // 同步卡片状态
        const item = items.value.find((x) => x.key === d.path);
        if (item) {
          if ('tags' in payload) item.tags = payload.tags;
        }
        await loadMeta();
      } catch (e) {
        showToast('保存失败', 'error');
      }
    }

    async function addTagToImage(name) {
      const d = detail.value;
      if (!d) return;
      const names = manualTagNames();
      if (names.includes(name)) return;
      await annotate({ tags: [...names, name] });
    }
    function removeTagFromImage(name) {
      const d = detail.value;
      if (!d) return;
      annotate({ tags: manualTagNames().filter((t) => t !== name) });
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

    async function onVisibility() {
      if (document.visibilityState === 'visible') {
        const res = await jfetch(API.list + '?page=1&pageSize=1').catch(() => null);
        if (res && res.total && res.total !== meta.total) {
          dirty.value = true;
          await loadMeta();
          if (!hasFilter.value) applyFilter();
        }
      }
    }

    onMounted(() => {
      window.addEventListener('zhule-pref-changed', onPrefChanged);
      window.addEventListener('zhule-gallery-rebuilt', onRebuilt);
      // 初始按容器宽收敛各筛选块总宽，避免 localStorage 中三块宽度合计超出容器宽
      nextTick(normalizeBlockWidths);
      // 支持从词库"进入详情页"跳转携带 tags 过滤条件（单选互斥：取首个）
      const q = route.query.tags;
      if (q) {
        const first = String(q).split(',').filter(Boolean)[0];
        if (first) filters.tags = [{ name: first, active: true, hidden: false }];
      }
      const qm = String(route.query.mode || 'and').toLowerCase();
      if (qm === 'or') filters.tagMode = 'or';
      loadMeta();
      loadItems(true);
      ensureTagTree();
      document.addEventListener('visibilitychange', onVisibility);
    });
    onBeforeUnmount(() => {
      window.removeEventListener('zhule-pref-changed', onPrefChanged);
      window.removeEventListener('zhule-gallery-rebuilt', onRebuilt);
      document.removeEventListener('visibilitychange', onVisibility);
      if (fullViewer) fullViewer.close();
      clearTimeout(toastTimer);
    });

    return {
      pref, filters, meta, items, total, page, pageSize, totalPages, loading, loadingMore, allLoaded,
      dirty, tagPanelOpen, detail, quickTag, toast, toastType, toastIcon, delTarget,
      mainEl, gridEl, hasFilter, uniqueDetailTags,
      thumbUrl, imgUrl,
      fmtTime, fmtSize, fmtModel, isTopDown, toggleLayout, setSortField, toggleSortDir, applyFilter, changePageSize, goPage, onScroll, removeTag, onSearchKeyup, onTagKeyup,
      toggleModel, toggleLora, openRename, cancelRename, confirmRename, rescan, quickCreateTag,
      renameOpen, renameKind, renameOld, renameNew, renaming, renameInput,
      filtersOpen, toggleFilters, blockStyle, startBlockDrag,
      gridCols, changeGridCols, gridStyle,
      sideStyle, startSideDrag, addTagFilter, clearTagFilter, toggleTagMode,
      visibleTags, toggleTagActive, hideTag, expandedTags, treeKids, toggleTagExpand, isTagActive, inTagFilter, isTagHidden,
      openDetail, closeDetail, zoomView,
      tagInputing, tagInputEl, startTagInput, cancelTagInput, onTagInputBlur,
      addTagToImage, removeTagFromImage,
      useWorkflow,
      tagStyle, askDelete, cancelDelete, confirmDelete,
      selected, selCount, isSel, onPointerDown, onCardClick,
      delBatchOpen, askBatchDelete, cancelBatchDelete, confirmBatchDelete,
      batchLink,
    };
  },
};