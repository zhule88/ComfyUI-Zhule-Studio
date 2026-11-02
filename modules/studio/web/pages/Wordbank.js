import { reactive, computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue';
import { useDeleteConfirm, DeleteDialog } from './deleteConfirm.js';

export default {
  name: 'Wordbank',
  components: { DeleteDialog },
  template: `
    <div class="page active">
      <div v-if="error" class="empty" style="padding:60px;text-align:center;color:#ff8fa8;">
        {{ error }}
      </div>

      <template v-else>
        <div class="toolbar">
          <button class="btn" :class="{active: pref.translate}" @click="toggleTranslate">
            {{ pref.translate ? '🌐 英文' : '🌐 中文' }}
          </button>
          <div class="mode-switch">
            <button class="btn mode" :class="{active: pref.cardMode==='image'}" @click="setCardMode('image')">🖼 图片</button>
            <button class="btn mode" :class="{active: pref.cardMode==='file'}" @click="setCardMode('file')">📄 文件</button>
          </div>
          <button class="btn" @click="singleRandom" data-tip="从每个随机池各抽一条">🎲</button>
          <button class="btn" :class="{active: data.randomMode}" @click="toggleRandomMode" data-tip="随机模式：每个池子各抽一条，逐条出图">🔄</button>
          <button class="btn" :class="{active: data.traverseMode}" @click="toggleTraverseMode" data-tip="遍历模式：以当前参考图最多的提示词为基准，设置0把不足的补到基准数，设置N补到（基准+N）；集中填充倒满一桶再下一桶，直到全部达标">⏩</button>
          <button class="btn icon-btn" @click="clearRandomPools" data-tip="清空随机池">🗑</button>
          <div class="col-ctrl">
            <label>每行</label>
            <button class="col-btn" @click="changeColumns(-1)">−</button>
            <span class="col-num">{{ pref.columns }}</span>
            <button class="col-btn" @click="changeColumns(1)">+</button>
          </div>
          <button class="btn" @click="saveBankOrder" :disabled="bankSaving"
                  data-tip="按当前展示顺序（层级深度优先）把编号写回并覆盖文件夹">💾 排序保存</button>
        </div>

        <div class="tabs">
          <button class="tab-add" data-tip="新增分类" @click="openAddTab">＋</button>
          <div v-for="name in tabs" :key="name"
               class="tab"
               :class="{active: data.activeTab === name, 'in-pool': isTabInPool(name), 'has-selected': tabHasSelected(name)}"
               draggable="true"
               @click="switchTab(name)"
               @contextmenu.prevent="togglePoolForTab(name)"
               @dragstart="onTabDragStart($event, name)"
               @dragover="onTabDragOver($event, name)"
               @drop.prevent="onTabDrop"
               @dragend="onTabDragEnd">{{ tabLabel(name) }}</div>
        </div>

        <div class="bank-body">
        <div class="chips-wrap">
          <div class="chips-head">
            <span class="chips-title">筛选分类</span>
            <button class="chips-toggle" @click="toggleChips"
                    :data-tip="chipsCollapsed ? '展开分类区' : '收起分类区'">
              {{ chipsCollapsed ? '⏷ 展开' : '⏶ 收起' }}
            </button>
            <span class="chips-count">数量 {{ filteredFiles.length }}</span>
          </div>
          <div class="chips-container" :style="{ height: chipsHeightCss }">
            <div v-for="(line, depth) in chipLines" :key="depth" class="chips-line">
              <div class="chip-add-slot">
                <button v-show="canAddChip(depth)" class="chip-add" :data-tip="'在「' + (depth > 0 ? chipParentLabel(depth) : tabLabel(data.activeTab)) + '」下新增分类'" @click="openAddChip(depth)">＋</button>
              </div>
              <div v-if="line.length" class="chip clear" :class="{active: !getSelections()[depth].length}"
                   @click="clearChip(depth)">全部</div>
              <div v-for="name in line" :key="name"
                   class="chip"
                   :class="[chipThemeClass, {active: getSelections()[depth].includes(name), 'in-pool': isChipInPool(depth, name)}]"
                   :style="chipStyle(name)"
                   draggable="true"
                   @click="toggleChip(depth, name)"
                   @contextmenu.prevent="togglePoolForChip(depth, name)"
                   @dragstart="onChipDragStart($event, depth, name)"
                   @dragover="onChipDragOver($event, depth, name)"
                   @drop.prevent
                   @dragend="onChipDragEnd">{{ dispKey(name) }}</div>
            </div>
          </div>
          <div v-show="!chipsCollapsed" class="chips-resize" data-tip="拖拽调整高度"
               @pointerdown="onChipsResizeDown"></div>
        </div>

        <div class="main">
          <div class="grid" :style="{ gridTemplateColumns: 'repeat(' + pref.columns + ', 1fr)' }">
            <div v-if="canAddCard" class="card card-add" data-tip="在「{{ addCardParentLabel }}」下新增词条"
                 @click="openAddCard">＋</div>
            <div v-if="!filteredFiles.length && !canAddCard" class="empty">没有匹配的提示词</div>
            <div v-for="file in visibleFiles" :key="file.relPath"
                 class="card" :data-rel="file.relPath"
                 :class="{
                   image: pref.cardMode === 'image',
                   file: pref.cardMode === 'file',
                   selected: isFileSelected(file),
                   'zhule-source': drag.active && drag.sourceType === 'card' && drag.sourceRelPath === file.relPath,
                   'drop-target': drag.hoverCardRelPath === file.relPath
                 }"
                 @pointerdown="onCardPointerDown($event, file)">
              <template v-if="pref.cardMode === 'image'">
                <div class="card-thumb-wrap">
                  <img v-if="file.images && file.images.length"
                       class="card-thumb" draggable="false" loading="lazy" decoding="async"
                       :src="imageUrl(file.images[getImgIdx(file)])"
                       :alt="file.name">
                  <div v-else class="card-thumb"
                       style="display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1a2332 0%,#2a3040 100%)">
                    <img class="card-thumb-img" draggable="false" loading="lazy" decoding="async"
                         :src="defaultImageUrl"
                         alt="">
                  </div>
                  <div class="thumb-count" v-if="file.images && file.images.length">
                    {{ getImgIdx(file) + 1 }}/{{ file.images.length }}
                  </div>
                  <div class="thumb-enter" data-tip="进入详情页" @click.stop="goToGallery(file)">→</div>
                  <div class="thumb-zoom" data-tip="放大预览" @click.stop="zoomCardImage(file)">🔍</div>
                  <div class="thumb-nav" @pointerdown.stop v-if="file.images && file.images.length > 1">
                    <button @click.stop="prevImage(file)">‹</button>
                    <button class="dice" @click.stop="randomImage(file)">🎲</button>
                    <button @click.stop="nextImage(file)">›</button>
                  </div>
                </div>
                <div class="card-name-row">
                  <span class="card-name">{{ file.name }}</span>
                  <button class="card-img-btn" data-tip="上传参考图（优先展示）" @pointerdown.stop @click.stop="openUploadRef(file)">🖼</button>
                  <button class="card-edit" data-tip="编辑" @pointerdown.stop @click.stop="openEdit(file)">⚙</button>
                  <button class="card-del-btn" data-tip="删除词条" @pointerdown.stop @click.stop="askDeleteWord(file)">✕</button>
                </div>
              </template>
              <template v-else>
                <div class="file-name-row">
                  <div class="card-title">{{ file.name }}</div>
                  <button class="card-img-btn" data-tip="上传参考图（优先展示）" @pointerdown.stop @click.stop="openUploadRef(file)">🖼</button>
                  <button class="card-edit file-zoom" data-tip="放大预览" @pointerdown.stop @click.stop="zoomCardImage(file)">🔍</button>
                  <button class="card-edit" data-tip="编辑" @pointerdown.stop @click.stop="openEdit(file)">⚙</button>
                  <button class="card-del-btn" data-tip="删除词条" @pointerdown.stop @click.stop="askDeleteWord(file)">✕</button>
                </div>
                <div class="card-body">{{ displayContent(file) }}</div>
              </template>
            </div>
          </div>
          <div v-if="pageCount > 1" class="pager"
               style="display:flex;align-items:center;justify-content:center;gap:6px;padding:12px 0;">
            <button class="btn" :disabled="pageIndex <= 0" @click="goPrevPage">‹ 上一页</button>
            <button v-for="(p, i) in pageNumbers" :key="i" class="btn pager-num"
                    :class="{active: p === pageIndex}" :disabled="p < 0"
                    @click="goPage(p)">{{ p < 0 ? '…' : p + 1 }}</button>
            <button class="btn" :disabled="pageIndex >= pageCount - 1" @click="goNextPage">下一页 ›</button>
            <span style="color:var(--text-3);font-size:12px;">第 {{ pageIndex + 1 }}/{{ pageCount }} 页 · 共 {{ filteredFiles.length }} 张</span>
          </div>
        </div>
        </div>

        <div class="bottom">
          <div class="selected-header">
            <span>已选 <span class="selected-count">{{ data.selected.length }}</span> 项</span>
            <span style="color:var(--text-3);font-size:11px;">右键 tab 或 chip 加入随机池 ♻ ｜ 拖动 tab / chip / 已选标签排序</span>
            <div class="header-actions">
              <button class="btn" style="padding:4px 10px;font-size:12px;"
                      :data-tip="selectedCollapsed ? '展开已选区' : '收起已选区'"
                      @click="toggleSelectedCollapsed">{{ selectedCollapsed ? '⏷ 展开' : '⏶ 收起' }}</button>
              <button class="btn danger" style="padding:4px 10px;font-size:12px;"
                      @click="clearAll">清空</button>
              <div class="count-ctrl">
                <label>次数</label>
                <button class="count-btn" @click="changeCount(-1)">−</button>
                <input type="number" class="count-input" min="0" max="99"
                       :value="pref.genCount"
                       @input="onCountInput"
                       @blur="fixCount">
                <button class="count-btn" @click="changeCount(1)">+</button>
              </div>
              <button class="btn primary" @click="runGenerate" data-tip="把已选词发送到画布节点，与前置提示词拼接后运行">运行 ▶</button>
            </div>
          </div>
          <div class="selected-list" v-show="!selectedCollapsed"
               :class="{'drag-active': drag.hoverSide === 'selList'}"
               @pointerdown="onSelListPointerDown">
            <span v-if="!data.selected.length" class="empty-tip">点击卡片加入已选，或拖动卡片直接拖入</span>
            <div v-for="(item, idx) in data.selected" :key="idx"
                 class="tag"
                 :class="{
                   'placeholder': item._ph,
                   'zhule-source': drag.active && drag.sourceType === 'tag' && drag.sourceIdx === idx,
                   'drag-over-insert': drag.hoverTagIdx === idx && drag.hoverSide === 'left',
                   'drag-over-insert-right': drag.hoverTagIdx === idx && drag.hoverSide === 'right'
                 }"
                 @pointerdown.stop="onTagPointerDown($event, idx)">
              <span>{{ item.name }}</span>
              <span v-if="item._ph" class="ph-badge" title="黄色分类标签：随机抽取结果绑定显示在本标签内">♻</span>
              <span class="close" @pointerdown.stop="removeSelected(idx)">×</span>
            </div>
          </div>
          <div class="preview" v-show="!selectedCollapsed" :class="{'random-mode': data.randomMode}">{{ previewText }}</div>
        </div>
      </template>

      <!-- 新增分类弹窗 -->
      <div v-if="addTabOpen" class="edit-overlay" @click.self="closeAddTab">
        <div class="edit-dialog">
          <div class="title">增加分类</div>
          <div class="field">
            <label>分类名</label>
            <input ref="addTabInput" type="text" v-model="addTabName"
                   placeholder="请输入新分类名称" spellcheck="false"
                   @keydown.enter="submitAddTab" @keydown.esc="closeAddTab">
          </div>
          <div class="actions">
            <button class="btn" @click="closeAddTab">取消</button>
            <button class="btn primary" @click="submitAddTab" :disabled="addingTab">确认</button>
          </div>
        </div>
      </div>

      <!-- 新增小类弹窗 -->
      <div v-if="addChipOpen" class="edit-overlay" @click.self="closeAddChip">
        <div class="edit-dialog">
          <div class="title">增加分类</div>
          <div class="field">
            <label>分类名</label>
            <input ref="addChipInput" type="text" v-model="addChipName"
                   placeholder="请输入新分类名称" spellcheck="false"
                   @keydown.enter="submitAddChip" @keydown.esc="closeAddChip">
          </div>
          <div class="actions">
            <button class="btn" @click="closeAddChip">取消</button>
            <button class="btn primary" @click="submitAddChip" :disabled="addingChip">确认</button>
          </div>
        </div>
      </div>

      <!-- 新增词条弹窗 -->
      <div v-if="addCardOpen" class="edit-overlay" @click.self="closeAddCard">
        <div class="edit-dialog">
          <div class="title">增加词条</div>
          <div class="field">
            <label>名字</label>
            <input ref="addCardInput" type="text" v-model="addCardName"
                   placeholder="请输入词条名称" spellcheck="false"
                   @keydown.enter="submitAddCard" @keydown.esc="closeAddCard">
          </div>
          <div class="field">
            <label>提示词（英）</label>
            <textarea v-model="addCardContent" rows="4" spellcheck="false" @keydown.ctrl.enter="submitAddCard"></textarea>
          </div>
          <div class="field">
            <label>提示词（中）</label>
            <textarea v-model="addCardContentCn" rows="3" spellcheck="false" @keydown.ctrl.enter="submitAddCard"></textarea>
            <span v-if="addCardIsTxt" class="hint">散 txt 卡片暂不支持中文提示词</span>
          </div>
          <div class="actions">
            <button class="btn" @click="closeAddCard">取消</button>
            <button class="btn primary" @click="submitAddCard" :disabled="addingCard">确认</button>
          </div>
        </div>
      </div>

      <!-- 上传参考图弹窗 -->
      <div v-if="uploadRefOpen" class="edit-overlay upload-overlay" @click.self="closeUploadRef">
        <div class="edit-dialog upload-dialog">
          <div class="title">上传参考图（优先展示）</div>
          <div class="upload-drop" :class="{drag: uploadRefDrag}"
               @click="pickUploadRef"
               @dragenter.prevent="onUploadRefDragEnter"
               @dragover.prevent
               @dragleave.prevent="onUploadRefDragLeave"
               @drop.prevent="onUploadRefDrop">
            <div class="upload-drop-icon">🖼</div>
            <div class="upload-drop-text">拖入图片 / 点击选择 / Ctrl+V 粘贴</div>
            <div class="upload-drop-hint">仅支持图片：png / jpg / webp / gif / bmp / avif</div>
          </div>
          <input ref="uploadRefInput" type="file" accept="image/*" class="upload-hidden-input"
                 @change="onUploadRefInput">
          <div v-if="uploadRefPreview" class="upload-preview">
            <img :src="uploadRefPreview" alt="预览">
            <div class="upload-preview-name">{{ uploadRefFileName }}</div>
          </div>
          <div class="actions">
            <button class="btn" @click="closeUploadRef" :disabled="uploadRefBusy">取消</button>
            <button class="btn primary" @click="submitUploadRef" :disabled="uploadRefBusy || !uploadRefPreview">上传</button>
          </div>
        </div>
      </div>

      <!-- 编辑弹窗 -->
      <div v-if="editTarget" class="edit-overlay" @click.self="cancelEdit">
        <div class="edit-dialog">
          <div class="title">编辑：{{ editTarget.name }}</div>
          <div class="field">
            <label>名字</label>
            <input type="text" v-model="editName" @keydown.enter="submitEdit">
          </div>
          <div class="field">
            <label>提示词（英）</label>
            <textarea v-model="editContent" rows="4" spellcheck="false" @keydown.ctrl.enter="submitEdit"></textarea>
          </div>
          <div class="field">
            <label>提示词（中）</label>
            <textarea v-model="editContentCn" rows="3" spellcheck="false" @keydown.ctrl.enter="submitEdit"></textarea>
            <span v-if="editIsTxt" class="hint">散 txt 卡片暂不支持中文提示词</span>
          </div>
          <div class="actions">
            <button class="btn danger" @click="askDeleteWord(editTarget)">删除</button>
            <button class="btn" @click="cancelEdit">取消</button>
            <button class="btn primary" @click="submitEdit" :disabled="editing">保存</button>
          </div>
        </div>
      </div>

      <!-- 全站唯一删除确认弹框：与图库删除共用（设置里开启「删除免确认」则不弹） -->
      <delete-dialog :state="del.state" @confirm="del.confirm" @cancel="del.cancel"></delete-dialog>

      <!-- 全屏查看 -->
      <div v-if="viewer.open" class="viewer-overlay" @click.self="closeViewer">
        <div class="viewer-dialog">
          <div class="viewer-head">
            <span class="viewer-title">{{ viewer.file.name }}</span>
            <button class="btn icon-btn" @click="closeViewer" data-tip="关闭">✕</button>
          </div>
          <div v-if="viewer.file.images && viewer.file.images.length" class="viewer-media">
            <img :src="imageUrl(viewer.file.images[viewer.idx])" :alt="viewer.file.name"
                 @dblclick="zoomView(imageUrl(viewer.file.images[viewer.idx]), viewer.file.name || '', viewer.file)"
                 data-tip="双击全屏缩放查看">
            <div class="viewer-nav" v-if="viewer.file.images.length > 1">
              <button @click="viewerPrev">‹</button>
              <span class="viewer-count">{{ viewer.idx + 1 }}/{{ viewer.file.images.length }}</span>
              <button class="dice" @click="viewerRandom">🎲</button>
              <button @click="viewerNext">›</button>
            </div>
          </div>
          <div class="viewer-body">
            <textarea class="viewer-content" readonly spellcheck="false" :value="displayContent(viewer.file)"></textarea>
          </div>
        </div>
      </div>
    </div>
    <transition name="toast">
      <div v-if="toast.show" class="zhule-toast" :class="'toast-' + toast.type" @click="dismissToast">
        <span class="zhule-toast-icon">{{ toastIcon[toast.type] }}</span>
        <span class="zhule-toast-msg">{{ toast.msg }}</span>
      </div>
    </transition>
  `,
  setup() {
    // ---------- 持久化竞态守卫 ----------
    // 首屏初始化期间，深度 watch([data,pref,...], saveState) 可能被早期状态变更提前触发
    // （如首次渲染 getSelections() 创建空 selections 写入 data，或 restoreState 前其它赋值），
    // 若此时写盘会把默认/半初始化状态覆盖已保存存档，导致 restoreState 读到被污染的存档而静默跳过。
    // 因此引入 stateRestored：恢复完成前 saveState 一律 return；restoreState 完成后才放行写盘。
    let stateRestored = false;

    // ---------- 轻量 Toast（3 秒自动消失，替代原生 alert） ----------
    const toast = reactive({ show: false, type: 'info', msg: '' });
    let toastTimer = null;
    const toastIcon = { info: '\u2139\ufe0f', success: '\u2705', error: '\u274c', warn: '\u26a0\ufe0f' };
    const showToast = (msg, type = 'info', duration = 3000) => {
      toast.msg = msg;
      toast.type = type;
      toast.show = true;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.show = false; }, duration);
    };
    const dismissToast = () => { toast.show = false; clearTimeout(toastTimer); };

    // 从 URL 解析ID：#/wordbank?bind=<节点上的ID>（持久化，刷新画布页不失效）
    const linkParams = (() => {
      const h = location.hash || '';
      const qIdx = h.indexOf('?');
      if (qIdx < 0) return { bind: '' };
      const params = new URLSearchParams(h.slice(qIdx + 1));
      return { bind: params.get('bind') || '' };
    })();
    let runChannel = new BroadcastChannel('zhule-studio');
    // 运行轮次：每次点「运行」递增，供画布端区分广播轮次（多标签页去重用，避免误伤连续运行）
    let runSeq = 0;
    // 通道关闭后 postMessage 会抛 InvalidStateError，且无法直接查询关闭状态。
    // 页面内不再主动 close（收到回执/超时均保留实例复用），此函数仅在实例被标记关闭时重建兜底。
    const ensureRunChannel = () => {
      if (runChannel.__zhuleClosed) {
        runChannel = new BroadcastChannel('zhule-studio');
        delete runChannel.__zhuleClosed;
      }
    };

    const loaded = ref(false);
    const tabLoading = ref(false);
    const error = ref(null);
    const tabs = ref([]);
    // tab 目录名 -> .zhule_id 映射（切 tab 用 id 定位请求，展示/本地存储仍用目录名；旧目录名回退兼容）
    const tabIds = ref({});
    const bankData = ref({});
    const maxDepth = ref(2);
    const addTabOpen = ref(false);
    const addTabName = ref('');
    const addingTab = ref(false);
    const addTabInput = ref(null);

    const data = reactive({
      activeTab: '',
      selections: {},
      selected: [],
      imgIndices: {},
      randomPools: [],
      randomMode: false,
      traverseMode: false,
    });

    // pref 单独持久化：整包 state 的 JSON.stringify 一旦因数据异常失败会被静默吞掉，
    // 连带偏好失效；这里让 pref 走自己的 key，与整包存档互不牵连。
    const PREF_KEY = 'zhule_wordbank_pref_v1';
    function loadPref() {
      const p = { cardMode: 'image', columns: 4, translate: false, genCount: 1, autoSelectParent: true };
      try {
        const raw = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
        if (raw && typeof raw === 'object') {
          if (raw.cardMode === 'image' || raw.cardMode === 'file') p.cardMode = raw.cardMode;
          if (typeof raw.columns === 'number' && raw.columns >= 1 && raw.columns <= 20) p.columns = raw.columns;
          if (typeof raw.translate === 'boolean') p.translate = raw.translate;
          if (typeof raw.genCount === 'number' && raw.genCount >= 0 && raw.genCount <= 99) p.genCount = raw.genCount;
          if (typeof raw.autoSelectParent === 'boolean') p.autoSelectParent = raw.autoSelectParent;
        }
      } catch (e) { /* 存档损坏则用默认值 */ }
      return p;
    }
    const pref = reactive(loadPref());
    watch(pref, () => {
      try { localStorage.setItem(PREF_KEY, JSON.stringify({ ...pref })); }
      catch (e) { console.warn('zhule: 词库偏好保存失败（PREF_KEY）:', e); }
    }, { deep: true });

    const viewer = reactive({ open: false, file: null, idx: 0 });

    // ============ 持久化与排序状态 ============
    const STORAGE_KEY = 'zhule_wordbank_state_v2';
    const tabOrder = ref([]);
    const chipOrder = reactive({});

    // 排序固定为「深度」= 层级深度优先（完整路径逐段编号转数字比较），不做手动选择
    const DEFAULT_TAB_SORT = { field: 'path', dir: 'asc' };

    const getChipOrder = (tab, depth, parentPath) => {
      const t = chipOrder[tab];
      if (!t) return [];
      // 旧路径键优先（存量存档）
      const exact = t[depth + '|' + parentPath];
      if (Array.isArray(exact)) return exact;
      // 新格式：键为「层级|父节点id」（拖拽排序已按 id 记录），父 id = 路径反查
      if (parentPath) {
        const pid = chipIdFor(tab, parentPath.split('/').length - 2, parentPath);
        if (pid) {
          const byId = t[depth + '|' + pid];
          if (Array.isArray(byId)) return byId;
        }
      } else {
        const tid = tabIds.value[tab];
        if (tid) {
          const byId = t[depth + '|' + tid];
          if (Array.isArray(byId)) return byId;
        }
      }
      // 兼容旧存档：整层全局顺序（无父路径）作为兜底
      const legacy = t[depth + '|'];
      if (Array.isArray(legacy)) return legacy;
      return [];
    };

    const saveState = () => {
      // 恢复完成前禁止写入：初始化竞态期间的中间状态不得覆盖已保存存档
      if (!stateRestored) return;
      const state = {
        pref: { ...pref },
        activeTab: data.activeTab,
        selections: data.selections,
        selected: data.selected.map(s => s._ph ? { _ph: true, _poolKey: s._poolKey, tab: s.tab, name: s.name, _filled: !!s._filled, relPath: s.relPath || undefined, id: s.id || undefined, content: s.content || undefined, content_cn: s.content_cn || undefined } : { tab: s.tab, relPath: s.relPath, id: s.id || undefined, name: s.name, _poolKey: s._poolKey || undefined }),
        randomPools: data.randomPools,
        randomMode: data.randomMode,
        traverseMode: data.traverseMode,
        imgIndices: data.imgIndices,
        chipsCollapsed: chipsCollapsed.value,
        chipsHeight: chipsHeight.value,
        selectedCollapsed: selectedCollapsed.value,
        tabOrder: [...tabOrder.value],
        chipOrder: JSON.parse(JSON.stringify(chipOrder)),
      };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
      catch (e) { console.warn('zhule: 词库状态保存失败（localStorage/序列化）:', e); }
    };

    const restoreState = () => {
      // 存档可能来自旧版本或手工修改，任何单点异常都不应阻断词库页加载
      try {
        let state = null;
        try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { state = null; }
        // 明确判定无可恢复：同样视为恢复流程完成，放行后续写盘
        if (!state) { stateRestored = true; return; }
        // pref 恢复优先读独立 key（pref 每次变化实时写 PREF_KEY，比整包快照更新；
        // 整包 JSON.stringify 失败时 PREF_KEY 仍有效，避免旧快照覆盖新偏好）。
        // 旧存档无 PREF_KEY 时回退到整包里的 pref 快照，保证升级不丢配置。
        const freshPref = loadPref();
        let prefKeyFresh = false;
        try { prefKeyFresh = localStorage.getItem(PREF_KEY) != null; } catch (e) { prefKeyFresh = false; }
        const srcPref = (prefKeyFresh || !(state.pref && typeof state.pref === 'object')) ? freshPref : state.pref;
        if (srcPref && typeof srcPref === 'object') {
          if (srcPref.cardMode === 'image' || srcPref.cardMode === 'file') pref.cardMode = srcPref.cardMode;
          if (typeof srcPref.columns === 'number' && srcPref.columns >= 1 && srcPref.columns <= 20) pref.columns = srcPref.columns;
          if (typeof srcPref.translate === 'boolean') pref.translate = srcPref.translate;
          if (typeof srcPref.genCount === 'number' && srcPref.genCount >= 0 && srcPref.genCount <= 99) pref.genCount = srcPref.genCount;
          if (typeof srcPref.autoSelectParent === 'boolean') pref.autoSelectParent = srcPref.autoSelectParent;
        }
        if (Array.isArray(state.tabOrder)) tabOrder.value = state.tabOrder.filter(n => typeof n === 'string');
        if (state.chipOrder && typeof state.chipOrder === 'object') {
          Object.keys(state.chipOrder).forEach(t => {
            const depths = state.chipOrder[t];
            if (!depths || typeof depths !== 'object') return;
            // 必须先初始化该 tab 的层级对象，否则 chipOrder[t][d] 赋值会抛
            // "Cannot set properties of undefined (setting '0')"（旧存档含 chipOrder 时偶发）
            if (!chipOrder[t] || typeof chipOrder[t] !== 'object') chipOrder[t] = {};
            Object.keys(depths).forEach(k => {
              if (!k.includes('|')) return; // 丢弃旧格式整层全局顺序，避免污染各父级深层
              const arr = depths[k];
              if (!Array.isArray(arr)) return;
              chipOrder[t][k] = arr.filter(n => typeof n === 'string');
            });
          });
        }
        if (typeof state.chipsCollapsed === 'boolean') chipsCollapsed.value = state.chipsCollapsed;
        if (typeof state.chipsHeight === 'number') chipsHeight.value = Math.min(420, Math.max(40, state.chipsHeight));
        if (typeof state.selectedCollapsed === 'boolean') selectedCollapsed.value = state.selectedCollapsed;
        if (state.randomPools) {
          const clean = [];
          if (Array.isArray(state.randomPools)) {
            clean.push(...state.randomPools.filter(it => it && (it.kind === 'tab' || it.kind === 'chip') && typeof it.tab === 'string' && Array.isArray(it.path)));
          } else if (typeof state.randomPools === 'object') {
            // 兼容旧版按 tab 分桶的存档
            Object.keys(state.randomPools).forEach(t => {
              const arr = state.randomPools[t];
              if (!Array.isArray(arr)) return;
              arr.forEach(it => {
                if (it && (it.kind === 'tab' || it.kind === 'chip') && Array.isArray(it.path)) {
                  clean.push({ kind: it.kind, tab: t, path: it.path, display: it.display || (it.kind === 'tab' ? '(全部)' : (it.path || []).join('/')) });
                }
              });
            });
          }
          data.randomPools = clean;
        }
        if (typeof state.randomMode === 'boolean') data.randomMode = state.randomMode;
        if (typeof state.traverseMode === 'boolean') data.traverseMode = state.traverseMode;
        if (state.imgIndices && typeof state.imgIndices === 'object') data.imgIndices = state.imgIndices;
        if (state.selections && typeof state.selections === 'object') {
          Object.keys(state.selections).forEach(t => {
            const arr = state.selections[t] || [];
            data.selections[t] = new Array(maxDepth.value).fill(null).map(() => []);
            for (let i = 0; i < Math.min(arr.length, maxDepth.value); i++) {
              const v = arr[i];
              if (Array.isArray(v)) data.selections[t][i] = v.filter(x => x).slice(0, 1); // 互斥单选：旧多选只保留首个
              else if (v) data.selections[t][i] = [v];
            }
          });
        }
        if (state.activeTab && tabs.value.includes(state.activeTab)) data.activeTab = state.activeTab;
        // 忽略历史存档中的 tabSortSettings：排序已固定为「深度（目录序）」，不做手动选择
        if (Array.isArray(state.selected)) {
          const rebuilt = [];
          state.selected.forEach(s => {
            if (!s) return;
            if (s._ph) {
              // 占位符：直接还原（类名即占位名，随机池恢复后 sync 兜底补齐）；
              // 已抽取（_filled）的占位符带绑定词条信息，普通模式运行直接可用
              rebuilt.push({ _ph: true, _poolKey: s._poolKey || '', tab: s.tab || '', name: s.name || '', _filled: !!s._filled, relPath: s.relPath || '', id: s.id || '', content: s.content || '', content_cn: s.content_cn || '' });
              return;
            }
            if (!s.tab || !s.relPath) return;
            const cards = bankData.value[s.tab] || [];
            const card = cards.find(c => c.relPath === s.relPath);
            if (card) rebuilt.push({ tab: s.tab, relPath: card.relPath, id: card.id || '', name: card.name, content: card.content, content_cn: card.content_cn, _poolKey: s._poolKey || undefined });
            else rebuilt.push({ tab: s.tab, relPath: s.relPath, id: s.id || '', name: s.name || '', content: s.content || '', content_cn: s.content_cn || '', _poolKey: s._poolKey || undefined });
          });
          data.selected = rebuilt;
          // 恢复完成后以池为准校准占位符（旧存档占位符缺 poolKey 等场景兜底）
          syncPlaceholders();
        }
        // 恢复流程正常完成：标记守卫放行，此后状态变更才允许写盘
        stateRestored = true;
      } catch (e) {
        // 存档损坏时仅放弃恢复，不阻断页面加载；损坏同样视为"已尝试恢复"，放行后续写盘
        console.warn('词库状态恢复失败，已忽略：', e);
        stateRestored = true;
      }
    };

    const orderTabs = () => {
      const known = tabOrder.value.filter(n => tabs.value.includes(n));
      const rest = tabs.value.filter(n => !known.includes(n));
      if (known.length) tabs.value = [...known, ...rest];
    };

    // ============ 分类区折叠与高度 ============
    const chipsCollapsed = ref(false);
    const chipsHeight = ref(140);
    const chipsHeightCss = computed(() => chipsCollapsed.value ? '0px' : chipsHeight.value + 'px');
    const toggleChips = () => { chipsCollapsed.value = !chipsCollapsed.value; };

    // ============ 已选区折叠 ============
    const selectedCollapsed = ref(true);
    const toggleSelectedCollapsed = () => { selectedCollapsed.value = !selectedCollapsed.value; };
    const onChipsResizeDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startY = e.clientY;
      const startH = chipsHeight.value;
      const move = (ev) => {
        const dh = ev.clientY - startY;
        chipsHeight.value = Math.min(420, Math.max(40, startH + dh));
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    };

    const drag = reactive({
      active: false,
      sourceType: null,
      sourceIdx: -1,
      sourceRelPath: null,
      hoverTagIdx: -1,
      hoverSide: null,
      hoverCardRelPath: null,
    });

    // ============ 编辑弹窗 ============
    const editTarget = ref(null);
    const editName = ref('');
    const editContent = ref('');
    const editContentCn = ref('');
    const editing = ref(false);

    // 散 txt 卡片（多 txt / 含子目录目录中的单个 txt）：后端不支持中文提示词
    const editIsTxt = computed(() => {
      const raw = editTarget.value ? (editTarget.value.rawName || '') : '';
      return raw.toLowerCase().endsWith('.txt');
    });

    // ============ 新增小类 / 新增词条 ============
    // 新小类目录暂无词条文件，后端扫描不会展示；pendingChips 本地补位使其立即可见可选
    const pendingChips = ref([]);
    const addChipOpen = ref(false);
    const addChipName = ref('');
    const addChipDepth = ref(0);
    const addChipInput = ref(null);
    const addingChip = ref(false);

    const addCardOpen = ref(false);
    const addCardName = ref('');
    const addCardContent = ref('');
    // 词库单独配置由导航栏全局设置面板（main.js 词库设置分组）下发
    function onWordbankPref(e) {
      const v = e && e.detail && e.detail.autoSelectParent;
      if (typeof v === 'boolean') pref.autoSelectParent = v;
    }
    // 通用删除免确认由 deleteConfirm.js 统一处理（onMounted 读取设置并监听广播）
    // 全局标签主题/圆角/颜色种子（与图库标签样式一致，作用于词库小分类 chip）
    const tagTheme = ref(readTagTheme());
    const tagRound = ref(readTagRound());
    const tagSeed = ref(readTagSeed());
    const tagColor = ref(readTagColor());
    function readTagTheme() {
      try {
        const raw = JSON.parse(localStorage.getItem('zhule_ui_pref') || 'null');
        if (raw && raw.gallery && ['dark', 'light', 'plain'].includes(raw.gallery.tagTheme)) return raw.gallery.tagTheme;
      } catch (e) { /* ignore */ }
      return 'dark';
    }
    function readTagRound() {
      try {
        const raw = JSON.parse(localStorage.getItem('zhule_ui_pref') || 'null');
        if (raw && raw.gallery && typeof raw.gallery.tagRound === 'boolean') return raw.gallery.tagRound;
      } catch (e) { /* ignore */ }
      return true;
    }
    function readTagSeed() {
      try {
        const raw = JSON.parse(localStorage.getItem('zhule_ui_pref') || 'null');
        if (raw && raw.gallery && typeof raw.gallery.tagSeed === 'string' && raw.gallery.tagSeed) return raw.gallery.tagSeed;
      } catch (e) { /* ignore */ }
      return 'zhule';
    }
    function readTagColor() {
      try {
        const raw = JSON.parse(localStorage.getItem('zhule_ui_pref') || 'null');
        const tc = raw && raw.gallery && raw.gallery.tagColor;
        if (!tc || typeof tc !== 'object') return null;
        const base = { level: 'simple', globalMode: 'diff', globalColor: '#2a9d8f',
          areas: { detail: { mode: 'diff', color: '#2a9d8f', seed: '' }, filter: { mode: 'diff', color: '#2a9d8f', seed: '' }, edit: { mode: 'diff', color: '#2a9d8f', seed: '' }, wordbank: { mode: 'diff', color: '#2a9d8f', seed: '' } } };
        const out = Object.assign({}, base, tc);
        if (!['simple', 'complex'].includes(out.level)) out.level = 'simple';
        if (!['diff', 'same'].includes(out.globalMode)) out.globalMode = 'diff';
        if (typeof out.globalColor !== 'string' || !out.globalColor) out.globalColor = '#2a9d8f';
        out.areas = {};
        ['detail', 'filter', 'edit', 'wordbank'].forEach((k) => {
          const a = (tc.areas && tc.areas[k]) || {};
          out.areas[k] = Object.assign({ mode: 'diff', color: '#2a9d8f', seed: '' }, a);
          if (!['diff', 'same'].includes(out.areas[k].mode)) out.areas[k].mode = 'diff';
          if (typeof out.areas[k].color !== 'string' || !out.areas[k].color) out.areas[k].color = '#2a9d8f';
          if (typeof out.areas[k].seed !== 'string') out.areas[k].seed = '';
        });
        return out;
      } catch (e) { /* ignore */ }
      return null;
    }
    function onGlobalPrefChanged(e) {
      const g = e && e.detail && e.detail.gallery;
      if (g) {
        if (['dark', 'light', 'plain'].includes(g.tagTheme)) tagTheme.value = g.tagTheme;
        if (typeof g.tagRound === 'boolean') tagRound.value = g.tagRound;
        if (typeof g.tagSeed === 'string') tagSeed.value = g.tagSeed || '';
        tagColor.value = readTagColor();
      }
    }
    const addCardContentCn = ref('');
    const addCardInput = ref(null);
    const addingCard = ref(false);

    // 词库小分类 chip 复用全局标签主题类（颜色仅由 --tag-bg 注入，主题/圆角走 CSS 类）
    const chipThemeClass = computed(() => {
      let c = 'zhg-tag-theme-' + tagTheme.value;
      if (tagRound.value === false) c += ' zhg-tag-square';
      return c;
    });
    // 词库小分类 chip 颜色：复用设置页「标签颜色」方案（wordbank 区域）
    // - 无配置或简单「全局异色」：种子散列色（同一分类名恒定同色，换种子整套换色）
    // - 简单「全局同色」：统一一色
    // - 分区模式：按 wordbank 区域配置（同色=区域统一色 / 异色=区域种子散列，区域种子留空沿用全局种子）
    function chipStyle(name) {
      const hashColor = (seed) => {
        const s = String(seed || '') + '|' + String(name);
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        h >>>= 0;
        return 'hsl(' + (h % 360) + ', 55%, 42%)';
      };
      const tc = tagColor.value;
      if (tc && tc.level === 'complex') {
        const a = tc.areas && tc.areas.wordbank;
        if (a && a.mode === 'same') return { '--tag-bg': a.color || '#2a9d8f' };
        return hashColor((a && a.seed) || tagSeed.value);
      }
      if (tc && tc.globalMode === 'same') return { '--tag-bg': tc.globalColor || '#2a9d8f' };
      return hashColor(tagSeed.value);
    }

    // 父列明确（非"全部"）时才显示小类加号：depth 0 的父列是 tab（恒选定），更深层需上层有选中
    const canAddChip = (depth) => {
      if (!data.activeTab) return false;
      if (depth === 0) return true;
      return !!chipParentPath(depth);
    };

    // 词条加号卡片：有活动 tab 即显示（tab 根或任意筛选层级下均可新增词条）
    const canAddCard = computed(() => !!data.activeTab);

    const addCardIsTxt = computed(() => (addCardName.value || '').trim().toLowerCase().endsWith('.txt'));

    // 父分类显示名链（用于加号按钮 title）
    const chipParentLabel = (depth) => {
      if (depth <= 0) return tabLabel(data.activeTab);
      const parentKey = chipParentPath(depth);
      return parentKey ? parentKey.split('/').map(dispKey).join('/') : '';
    };

    // 词条加号卡片的父文件夹显示名
    const addCardParentLabel = computed(() => {
      const sel = getSelections();
      const keys = [];
      for (let i = 0; i < maxDepth.value; i++) {
        if (Array.isArray(sel[i]) && sel[i].length) keys.push(sel[i][0]);
      }
      if (!keys.length) return tabLabel(data.activeTab);
      return keys.map(k => k.split('/').map(dispKey).join('/')).join('/');
    });

    const openAddChip = (depth) => {
      addChipDepth.value = depth;
      addChipName.value = '';
      addChipOpen.value = true;
      nextTick(() => { if (addChipInput.value) addChipInput.value.focus(); });
    };
    const closeAddChip = () => {
      addChipOpen.value = false;
      addChipName.value = '';
    };
    const submitAddChip = async () => {
      const name = addChipName.value.trim();
      if (!name) { showToast('请输入分类名', 'warn'); return; }
      addingChip.value = true;
      try {
        const parentKey = chipParentPath(addChipDepth.value);
        const parentId = parentKey
          ? (chipIdFor(data.activeTab, parentKey.split('/').length - 2, parentKey) || '')
          : (tabIds.value[data.activeTab] || '');
        const resp = await fetch('/zhule_studio/api/wordbank/chip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parentId, name }),
        });
        const json = await resp.json();
        if (!resp.ok) { showToast(json.error || '创建失败', 'error'); return; }
        addChipOpen.value = false;
        addChipName.value = '';
        const key = (parentKey ? parentKey + '/' : data.activeTab + '/') + name;
        if (!pendingChips.value.some(p => p.depth === addChipDepth.value && p.key === key)) {
          pendingChips.value.push({ depth: addChipDepth.value, key });
        }
        showToast('分类已创建', 'success');
      } finally {
        addingChip.value = false;
      }
    };

    const openAddCard = () => {
      addCardName.value = '';
      addCardContent.value = '';
      addCardContentCn.value = '';
      addCardOpen.value = true;
      nextTick(() => { if (addCardInput.value) addCardInput.value.focus(); });
    };
    const closeAddCard = () => {
      addCardOpen.value = false;
      addCardName.value = '';
      addCardContent.value = '';
      addCardContentCn.value = '';
    };
    const submitAddCard = async () => {
      const name = addCardName.value.trim();
      if (!name) { showToast('请输入词条名', 'warn'); return; }
      addingCard.value = true;
      try {
        const sel = getSelections();
        let parentKey = '';
        for (let i = 0; i < maxDepth.value; i++) {
          if (Array.isArray(sel[i]) && sel[i].length) parentKey = sel[i][0];
        }
        const parentId = parentKey
          ? (chipIdFor(data.activeTab, parentKey.split('/').length - 2, parentKey) || '')
          : (tabIds.value[data.activeTab] || '');
        const body = { parentId, name };
        if (addCardContent.value) body.content = addCardContent.value;
        if (!addCardIsTxt.value && addCardContentCn.value) body.content_cn = addCardContentCn.value;
        const resp = await fetch('/zhule_studio/api/wordbank/card', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await resp.json();
        if (!resp.ok) { showToast(json.error || '创建失败', 'error'); return; }
        addCardOpen.value = false;
        addCardName.value = '';
        addCardContent.value = '';
        addCardContentCn.value = '';
        showToast('词条已创建', 'success');
        await load(true);
      } finally {
        addingCard.value = false;
      }
    };

    const openEdit = (file) => {
      editTarget.value = file;
      editName.value = file.name || '';
      editContent.value = file.content || '';
      editContentCn.value = file.content_cn || '';
    };

    const cancelEdit = () => {
      editTarget.value = null;
      editing.value = false;
    };

    const submitEdit = async () => {
      if (!editTarget.value || editing.value) return;
      const nm = (editName.value || '').trim();
      if (!nm) return showToast('名字不能为空', 'warn');

      editing.value = true;
      try {
        const body = {
          id: editTarget.value.id,
          name: nm,
        };
        // 仅当输入框非空或原本就有内容时才写回，避免误清空
        if (editContent.value || editTarget.value.content) body.content = editContent.value;
        // 散 txt 卡片后端不支持中文；仅文件夹卡片提交
        if (!editIsTxt.value && (editContentCn.value || editTarget.value.content_cn)) {
          body.content_cn = editContentCn.value;
        }
        const resp = await fetch('/zhule_studio/api/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await resp.json();
        if (json.error) {
          showToast('保存失败：' + json.error, 'error');
          editing.value = false;
          return;
        }
        editTarget.value = null;
        editing.value = false;
        await load();
      } catch (e) {
        showToast('请求失败：' + e.message, 'error');
        editing.value = false;
      }
    };

    // ============ 删除词条（弹框/免确认统一由 deleteConfirm.js 处理） ============
    const del = useDeleteConfirm();
    const deleting = ref(false);

    const askDeleteWord = (file) => {
      if (!file) return;
      del.ask({
        title: '确认删除',
        message: '是否确认删除当前提示词？删除后不再显示（数据仍保留在库中，可后续恢复）。',
        name: file.name || '',
        run: () => deleteWordNow(file),
      });
    };

    const deleteWordNow = async (file) => {
      if (!file || deleting.value) return;
      deleting.value = true;
      try {
        const resp = await fetch('/zhule_studio/api/wordbank/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: file.id }),
        });
        const json = await resp.json();
        if (json.error) {
          showToast('删除失败：' + json.error, 'error');
        } else {
          showToast('已删除：' + file.name, 'success');
          // 若删除来源是编辑弹窗，同步关闭编辑面板
          if (editTarget.value && editTarget.value.id === file.id) {
            editTarget.value = null;
            editing.value = false;
          }
        }
        await load();
      } catch (e) {
        showToast('请求失败：' + e.message, 'error');
      } finally {
        deleting.value = false;
      }
    };

    // ============ 上传参考图（弹窗式：点击 / 拖拽 / 粘贴，过滤非图片） ============
    const uploadRefOpen = ref(false);
    const uploadRefTarget = ref(null);
    const uploadRefFile = ref(null);
    const uploadRefPreview = ref('');
    const uploadRefFileName = ref('');
    const uploadRefBusy = ref(false);
    const uploadRefDrag = ref(false);
    const uploadRefInput = ref(null);
    let uploadRefDragCounter = 0;

    const IMG_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
    const isImageFile = (f) => {
      if (!f) return false;
      if (f.type && f.type.startsWith('image/')) return true;
      return IMG_EXT_RE.test(f.name || '');
    };

    const preventDropDefault = (e) => e.preventDefault();

    const openUploadRef = (file) => {
      uploadRefTarget.value = file;
      uploadRefOpen.value = true;
      window.addEventListener('paste', onUploadRefPaste);
      window.addEventListener('dragover', preventDropDefault);
      window.addEventListener('drop', preventDropDefault);
    };

    const closeUploadRef = () => {
      uploadRefOpen.value = false;
      uploadRefTarget.value = null;
      window.removeEventListener('paste', onUploadRefPaste);
      window.removeEventListener('dragover', preventDropDefault);
      window.removeEventListener('drop', preventDropDefault);
      if (uploadRefPreview.value) URL.revokeObjectURL(uploadRefPreview.value);
      uploadRefPreview.value = '';
      uploadRefFileName.value = '';
      uploadRefFile.value = null;
    };

    const pickUploadRef = () => {
      if (uploadRefInput.value) uploadRefInput.value.click();
    };

    const onUploadRefInput = (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) setUploadRefFile(f);
    };

    const onUploadRefDragEnter = (e) => {
      uploadRefDragCounter++;
      uploadRefDrag.value = true;
    };

    const onUploadRefDragLeave = (e) => {
      uploadRefDragCounter--;
      if (uploadRefDragCounter <= 0) {
        uploadRefDragCounter = 0;
        uploadRefDrag.value = false;
      }
    };

    const onUploadRefDrop = (e) => {
      uploadRefDragCounter = 0;
      uploadRefDrag.value = false;
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        setUploadRefFile(e.dataTransfer.files[0]);
      }
    };

    const onUploadRefPaste = (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const f = item.getAsFile();
          if (f) {
            e.preventDefault();
            setUploadRefFile(f);
            return;
          }
        }
      }
    };

    const setUploadRefFile = (f) => {
      if (!isImageFile(f)) {
        showToast('只能上传图片文件', 'warn');
        return;
      }
      uploadRefFile.value = f;
      if (uploadRefPreview.value) URL.revokeObjectURL(uploadRefPreview.value);
      uploadRefPreview.value = URL.createObjectURL(f);
      uploadRefFileName.value = f.name;
    };

    const submitUploadRef = async () => {
      const file = uploadRefTarget.value;
      const f = uploadRefFile.value;
      if (!file || !f) return;
      uploadRefBusy.value = true;
      const fd = new FormData();
      fd.append('id', file.id);
      fd.append('file', f);
      try {
        const resp = await fetch('/zhule_studio/api/wordbank/image-upload', {
          method: 'POST',
          body: fd,
        });
        const json = await resp.json();
        if (json.error) {
          showToast('上传失败：' + json.error, 'error');
          return;
        }
        file.images = json.images || [];
        showToast('参考图已上传', 'success');
        closeUploadRef();
      } catch (e) {
        showToast('请求失败：' + e.message, 'error');
      } finally {
        uploadRefBusy.value = false;
      }
    };

    // ============ 数据加载 ============
    // 首屏候选 tab：优先使用上次保存的 activeTab（只拉单 tab），无存档时走全量再裁剪
    const readSavedActiveTab = () => {
      try {
        const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        return (state && typeof state.activeTab === 'string') ? state.activeTab : '';
      } catch (e) { return ''; }
    };

    // 动态算最大 chips 层数：遍历当前已加载的所有 tab 卡片
    const recalcMaxDepth = () => {
      let max = 0;
      Object.values(bankData.value).forEach(cards => {
        cards.forEach(c => { if (c.chips && c.chips.length > max) max = c.chips.length; });
      });
      maxDepth.value = Math.max(1, max);
    };

    // 局部加载某 tab 后，回填已选列表中该 tab 的骨架项（restoreState 时可能因数据未加载而缺 content）
    const backfillSelected = (tabName) => {
      if (!tabName) return;
      const cards = bankData.value[tabName] || [];
      if (!cards.length) return;
      let dirty = false;
      data.selected.forEach(s => {
        if (s.tab !== tabName || s.content) return;
        const c = cards.find(x => x.relPath === s.relPath);
        if (c) { s.id = c.id || s.id; s.name = c.name; s.content = c.content; s.content_cn = c.content_cn; dirty = true; }
      });
      if (dirty) saveState();
    };

    // 慢操作节流日志：仅记录 >=30ms 的计算，同一标签 5 秒内最多一条，避免渲染期刷屏

    const load = async (force, tabName) => {
      try {
        // tab 参数归一化：旧版带编号目录名（"01_角色"）或旧 id → 当前纯显示名
        if (tabName && tabs.value.length) {
          if (!tabs.value.includes(tabName)) {
            const byId = Object.entries(tabIds.value).find(([, id]) => id === tabName);
            if (byId) tabName = byId[0];
            else {
              const pure = tabs.value.find(n => tabLabel(n) === tabLabel(tabName));
              if (pure) tabName = pure;
            }
          }
        }
        // 非强制刷新且未指定 tab：页面已初始化时只局部刷新当前 tab；首屏时优先只拉保存的 activeTab
        if (!force && !tabName) {
          if (tabs.value.length && data.activeTab) {
            await load(false, data.activeTab);
            return;
          }
          if (!tabs.value.length) {
            const saved = readSavedActiveTab();
            if (saved) {
              await load(false, saved);
              return;
            }
          }
        }
        const params = [];
        if (force) params.push('refresh=1');
        if (tabName) params.push('tab=' + encodeURIComponent(tabIds.value[tabName] || tabName));
        const qs = params.length ? '?' + params.join('&') : '';
        const resp = await fetch('/zhule_studio/api/wordbank' + qs);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const json = await resp.json();
        if (json.error) throw new Error(json.error);
        tabs.value = json.tabs || [];
        tabIds.value = json.tab_ids || {};
        orderTabs();
        if (tabName) {
          // 局部加载：只替换该 tab 数据，保留其它已加载 tab（切 tab 懒加载路径）
          bankData.value[tabName] = (json.data && json.data[tabName]) || [];
          backfillSelected(tabName);
        } else {
          bankData.value = json.data || {};
          if (!force && !tabName) {
            // 首屏只保留当前 tab 数据，其余 tab 在切换时局部拉取，避免全量驻留
            const keep = (data.activeTab && tabs.value.includes(data.activeTab)) ? data.activeTab : (tabs.value[0] || '');
            if (keep) {
              const kept = bankData.value[keep] || [];
              bankData.value = { [keep]: kept };
            }
          }
        }
        recalcMaxDepth();
        if (force || !tabs.value.includes(data.activeTab)) {
          // 全量刷新 / activeTab 失效时恢复存档并落到合法 tab
          restoreState();
          // restoreState 已恢复 tabOrder.value；但本函数早前（fetch 后）已用初始空 tabOrder
          // 执行过一次 orderTabs()，必须在此重新应用一次，否则刷新后 tab 顺序不会按存档恢复
          orderTabs();
          if (tabs.value.length && !tabs.value.includes(data.activeTab)) data.activeTab = tabs.value[0];
        }
        loaded.value = true;
        // 已选列表中若含尚未加载的 tab，补拉数据以恢复完整内容（fire-and-forget）
        const need = new Set();
        data.selected.forEach(s => { if (s.tab && !bankData.value[s.tab] && tabs.value.includes(s.tab)) need.add(s.tab); });
        need.forEach(t => load(false, t));
      } catch (e) {
        error.value = '加载词库失败：' + e.message;
        loaded.value = true;
        // 首屏加载失败时 restoreState 未执行，放行守卫避免词库页后续交互永不落盘
        stateRestored = true;
      }
    };

    // ============ 计算 ============
    // 返回当前 tab 的选择数组。懒加载下 maxDepth 会随已加载 tab 动态变大，
    // 而旧 tab 的选择数组是早前按当时的 maxDepth 建的、长度可能不足，
    // 这里每次调用按需补齐，避免模板 getSelections()[depth].length 读到 undefined 崩溃（切换深层 tab 时偶发）
    const getSelections = () => {
      let sel = data.selections[data.activeTab];
      if (!Array.isArray(sel)) {
        sel = [];
        data.selections[data.activeTab] = sel;
      }
      while (sel.length < maxDepth.value) sel.push([]);
      return sel;
    };

    // 层级 chip 显示名（去掉编号前缀）；name 入参为完整唯一键
    const dispKey = (k) => {
      const s = (k || '').toString();
      const i = s.lastIndexOf('/');
      const base = i >= 0 ? s.slice(i + 1) : s;
      return base.replace(/^\d+[_ ]+/, '');
    };

    const chipLines = computed(() => {
      const files = bankData.value[data.activeTab] || [];
      const sel = data.selections[data.activeTab] || [];
      const lines = [];
      // 循环上限 = 词条最大层级 与 选中链深度+2 取大：选中 depth d 的空分类时需渲染 d+1 层，提供「＋」/「全部」以继续创建子分类
      let maxSelDepth = -1;
      for (let i = 0; i < (sel || []).length; i++) {
        if (Array.isArray(sel[i]) && sel[i].length) maxSelDepth = i;
      }
      const loopDepth = Math.max(maxDepth.value, maxSelDepth + 2);
      for (let depth = 0; depth < loopDepth; depth++) {
        const filtered = files.filter(f => {
          for (let i = 0; i < depth; i++) {
            const picks = sel[i];
            if (!Array.isArray(picks) || !picks.length) continue;
            if (!f.chipKeys[i]) continue;
            if (!picks.includes(f.chipKeys[i])) return false;
          }
          return true;
        });
        // 用唯一键（完整相对路径）去重，同名不同父级各自独立展示
        const set = new Set();
        filtered.forEach(f => { if (f.chipKeys[depth]) set.add(f.chipKeys[depth]); });
        const options = [...set];
        const parentPath = chipParentPath(depth);
        const order = getChipOrder(data.activeTab, depth, parentPath);
        if (order.length) {
          const byDisp = new Map();
          options.forEach(k => { const d = dispKey(k); if (!byDisp.has(d)) byDisp.set(d, []); byDisp.get(d).push(k); });
          const ordered = [];
          const used = new Set();
          order.forEach(d => { (byDisp.get(d) || []).forEach(k => { if (!used.has(k)) { ordered.push(k); used.add(k); } }); });
          const rest = options.filter(k => !used.has(k));
          options.splice(0, options.length, ...ordered, ...rest);
        }
        // 无 chipOrder 时保持后端层级深度优先顺序（不再按名称 sort，避免破坏父级优先）
        // 合并刚创建、尚未落盘为词条的空小类（避免空目录被后端扫描忽略而不可见）
        const pending = pendingChips.value.filter(p => p.depth === depth);
        pending.forEach(p => { if (!options.includes(p.key)) options.push(p.key); });
        if (!options.length) {
          // 空层：depth 0 为 tab 根，恒保留占位行（渲染「＋」与「全部」），以便在空大类下新建一级分类；
          // 更深层仅当上层有明确选中的父分类时保留占位行，否则终止后续层
          if (depth === 0 || (depth > 0 && chipParentPath(depth))) {
            lines.push([]);
            continue;
          }
          break;
        }
        lines.push(options);
      }
      return lines;
    });

    // 层级深度优先排序 key：完整相对路径逐段「编号转数字 + 名称」比较；无编号段排在后面
    const segKeyOf = (s) => {
      const str = (s == null ? '' : String(s));
      const m = /^(\d+)[_ ]+(.+)$/.exec(str);
      if (m) return [0, parseInt(m[1], 10), m[2].toLowerCase(), str];
      return [1, 0, str.toLowerCase(), str];
    };
    const pathKeyOf = (rel) => (rel || '').split('/').map(segKeyOf);
    const cmpPathKey = (a, b) => {
      const n = Math.min(a.length, b.length);
      for (let i = 0; i < n; i++) {
        const x = a[i], y = b[i];
        if (x[0] !== y[0]) return x[0] - y[0];
        if (x[1] !== y[1]) return x[1] - y[1];
        const c = String(x[2]).localeCompare(String(y[2]), 'zh-Hans-CN');
        if (c) return c;
        const d = String(x[3]).localeCompare(String(y[3]), 'zh-Hans-CN');
        if (d) return d;
      }
      return a.length - b.length;
    };

    const filteredFiles = computed(() => {
      const files = bankData.value[data.activeTab] || [];
      const sel = data.selections[data.activeTab] || [];
      const cur = DEFAULT_TAB_SORT;
      const mul = cur.dir === 'desc' ? -1 : 1;
      const result = files.filter(f => {
        for (let i = 0; i < maxDepth.value; i++) {
          const picks = sel[i];
          if (!Array.isArray(picks) || !picks.length) continue;
          if (!f.chipKeys[i]) continue;
          if (!picks.includes(f.chipKeys[i])) return false;
        }
        return true;
      }).sort((a, b) => {
        if (cur.field === 'name') {
          return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN') * mul;
        }
        if (cur.field === 'path') {
          return cmpPathKey(pathKeyOf(a.relPath), pathKeyOf(b.relPath)) * mul;
        }
        const ta = a.mtime || 0;
        const tb = b.mtime || 0;
        return (ta - tb) * mul || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN') * mul;
      });
      return result;
    });

    // ============ 卡片分页（懒渲染）：每页固定数量，避免全量 DOM 膨胀 ============
    const PAGE_SIZE = 80;
    const pageIndex = ref(0);
    const pageCount = computed(() => Math.max(1, Math.ceil(filteredFiles.value.length / PAGE_SIZE)));
    const visibleFiles = computed(() => {
      const start = pageIndex.value * PAGE_SIZE;
      return filteredFiles.value.slice(start, start + PAGE_SIZE);
    });
    const pageNumbers = computed(() => {
      const total = pageCount.value;
      const cur = pageIndex.value;
      if (total <= 7) return Array.from({ length: total }, (_, i) => i);
      const set = new Set([0, total - 1, cur - 1, cur, cur + 1]);
      const arr = [...set].filter(i => i >= 0 && i < total).sort((a, b) => a - b);
      const out = [];
      let prev = -10;
      arr.forEach(i => { if (i - prev > 1) out.push(-1); out.push(i); prev = i; });
      return out;
    });
    const goPrevPage = () => { pageIndex.value = Math.max(0, pageIndex.value - 1); };
    const goNextPage = () => { pageIndex.value = Math.min(pageCount.value - 1, pageIndex.value + 1); };
    const goPage = (i) => { if (i >= 0 && i < pageCount.value) pageIndex.value = i; };
    // 筛选/排序结果变化时回到第一页，避免停留在无效页码
    watch(filteredFiles, () => { pageIndex.value = 0; });

    const previewText = computed(() => {
      if (data.randomMode || data.traverseMode) {
        const modeName = data.traverseMode ? '遍历' : '随机';
        const filled = data.selected.filter(s => !s._ph || s._filled);
        if (filled.length) {
          const texts = filled.map(s => (pref.translate && s.content_cn && s.content_cn.trim()) ? s.content_cn : s.content);
          return modeName + '抽取：' + texts.join(', ');
        }
        if (data.randomPools.length) {
          const display = data.randomPools.map(p => (p.kind === 'tab' ? tabLabel(p.tab) + '(全部)' : p.display));
          return modeName + '模式：' + display.length + ' 个池子 [' + display.join(' | ') + ']，每池抽 1 条'
            + (data.traverseMode ? '，目标 = 当前最多数量 + ' + pref.genCount + '（0 则补到最多数量），集中填充' : '');
        }
        return modeName + '模式已开，但随机池为空。右键 tab 或 chip 加入';
      }
      const text = data.selected.filter(s => !s._ph || s._filled).map(s => {
        if (pref.translate && s.content_cn && s.content_cn.trim()) return s.content_cn;
        return s.content;
      }).join(', ');
      return text || '（空）';
    });

    // ============ 工具 ============
    const defaultImageUrl = '/zhule_studio/默认图.png';
    const imageUrl = (path) => {
      if (!path) return '';
      return '/zhule_studio/api/image?path=' + encodeURIComponent(path);
    };
    const getImgIdx = (file) => data.imgIndices[file.relPath] || 0;
    const setImgIdx = (file, idx) => { data.imgIndices[file.relPath] = idx; };
    const displayContent = (file) => (pref.translate && file.content_cn) ? file.content_cn : file.content;
    const isFileSelected = (file) => data.selected.some(s => s.relPath === file.relPath);

    // ============ 随机池（多项独立子池：每个右键选中的 tab / chip 各为一池，随机/遍历时各抽一组合；父子互不包含） ============
    const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    // 从已加载卡片反查 chip 节点的 DB id：右键 chip = 当前筛选分支下 chipKeys[depth] 对应的节点，
    // 取该节点在卡片 chipIds 链中同层的 id（同一 chip 下所有卡片该层 id 一致）。
    const chipIdFor = (tab, depth, name) => {
      const files = bankData.value[tab] || [];
      const sel = data.selections[tab] || [];
      const f = files.find(c => {
        const keys = c.chipKeys || [];
        if (keys[depth] !== name) return false;
        for (let i = 0; i < depth; i++) {
          const picks = sel[i];
          if (!Array.isArray(picks) || !picks.length) continue;
          if (!keys[i] || !picks.includes(keys[i])) return false;
        }
        return true;
      });
      if (!f) return '';
      const ids = f.chipIds || [];
      return ids[depth] || '';
    };

    const chipParentPath = (depth) => {
      if (depth <= 0) return '';
      const sel = getSelections();
      const p = sel[depth - 1];
      return Array.isArray(p) && p.length ? p[0] : '';
    };
    const chipPathFor = (depth, name) => {
      const sel = data.selections[data.activeTab] || [];
      const path = [];
      for (let i = 0; i < depth; i++) {
        const picks = Array.isArray(sel[i]) ? sel[i] : (sel[i] ? [sel[i]] : []);
        if (picks.length) path.push(picks[0]);
      }
      path.push(name);
      return path;
    };
    // 由 chipId 反查该节点所在卡片链：chipIds 为不含 tab 根的祖先 id 链，chips 为同构的无编号显示名链
    const chipIdChain = (tab, id) => {
      if (!id) return [];
      const files = bankData.value[tab] || [];
      const f = files.find(c => (c.chipIds || []).includes(id));
      if (!f) return [];
      const idx = (f.chipIds || []).indexOf(id);
      return idx >= 0 ? (f.chipIds || []).slice(0, idx + 1) : [];
    };
    const chipDisplayFor = (tab, id) => {
      if (!id) return '';
      const files = bankData.value[tab] || [];
      const f = files.find(c => (c.chipIds || []).includes(id));
      if (!f) return '';
      const idx = (f.chipIds || []).indexOf(id);
      return ((f.chips || [])[idx] || '') || '';
    };
    // 随机池父子冲突按 DB id 链判断（路径逻辑已废弃）：同链上谁浅谁包含谁，提示一律用无编号显示名
    const hasPoolConflict = (tab, chipId) => {
      const items = data.randomPools.filter(it => it.tab === tab);
      const myChain = chipIdChain(tab, chipId);
      for (const it of items) {
        if (it.kind === 'tab') {
          if (myChain.length === 0) return { conflict: false };
          return { conflict: true, msg: `「${tabLabel(tab)}」(全部) 已进池，不能再加入其下的分类` };
        }
        if (it.kind === 'chip') {
          const theirName = chipDisplayFor(tab, it.chipId) || it.display || '';
          if (myChain.length === 0) return { conflict: true, msg: `「${theirName}」已进池，不能再加入整个「${tabLabel(tab)}」` };
          if (myChain.includes(it.chipId)) return { conflict: true, msg: `「${theirName}」已进池，它包含「${chipDisplayFor(tab, chipId)}」，父子不能同时进池` };
          if (chipIdChain(tab, it.chipId).includes(chipId)) return { conflict: true, msg: `「${chipDisplayFor(tab, chipId)}」包含已进池的「${theirName}」，父子不能同时进池` };
        }
      }
      return { conflict: false };
    };

    // ===== 调试日志：console + 后端 log/wordbank_debug_*.log（排查随机池用） =====
    let _logBuf = [];
    const zhuleLog = (...args) => {
      const ts = new Date().toLocaleTimeString('zh-Hans-CN', { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0');
      const line = '[Wordbank] ' + ts + ' ' + args.map(a => {
        if (a instanceof Error) return a.stack || String(a);
        if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
        return String(a);
      }).join(' | ');
      console.log(line);
      _logBuf.push(line);
      if (_logBuf.length >= 30) flushZhuleLog();
    };
    const flushZhuleLog = () => {
      if (!_logBuf.length) return;
      const lines = _logBuf.splice(0, _logBuf.length);
      fetch('/zhule_studio/api/debug_log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines }) }).catch(() => {});
    };
    window.addEventListener('beforeunload', flushZhuleLog);
    const selSummary = () => data.selected.map(s => (s._ph ? 'PH[' + s._poolKey + ']' : (s._poolKey ? 'R[' + s._poolKey + ']' + s.name : s.name)));

    const isTabInPool = (tab) => data.randomPools.some(it => it.kind === 'tab' && it.tab === tab);
    // 大类下有任意提示词被选中时高亮该 tab
    const tabHasSelected = (name) => {
      const cards = bankData.value[name] || [];
      if (!cards.length) return false;
      const rels = new Set(cards.map(c => c.relPath));
      return data.selected.some(s => rels.has(s.relPath));
    };
    const isChipInPool = (depth, name) => {
      const tab = data.activeTab;
      const chipId = chipIdFor(tab, depth, name);
      return data.randomPools.some(it => it.kind === 'chip' && it.tab === tab && (it.chipId ? it.chipId === chipId : samePath(it.path, chipPathFor(depth, name))));
    };

    // ============ 交互 ============
    const openAddTab = () => {
  addTabName.value = '';
  addTabOpen.value = true;
  nextTick(() => { if (addTabInput.value) addTabInput.value.focus(); });
};
const closeAddTab = () => {
  addTabOpen.value = false;
  addTabName.value = '';
};
const submitAddTab = async () => {
  const name = addTabName.value.trim();
  if (!name) { showToast('请输入分类名', 'warn'); return; }
  addingTab.value = true;
  try {
    const resp = await fetch('/zhule_studio/api/wordbank/tab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const json = await resp.json();
    if (!resp.ok) { showToast(json.error || '创建失败', 'error'); return; }
    addTabOpen.value = false;
    addTabName.value = '';
    showToast('分类已创建', 'success');
    // 刷新词库数据，确保拿到新目录；新分类固定排到末尾（不含编号、不在 tabOrder 中）
    await load(true);
    if (json.tab) {
      tabs.value = tabs.value.filter(n => n !== json.tab);
      tabs.value.push(json.tab);
    }
    await saveBankOrder();
  } finally {
    addingTab.value = false;
  }
};
    const switchTab = (name) => {
      if (data.activeTab === name) return;
      data.activeTab = name;
      pageIndex.value = 0;
      // 该 tab 数据尚未加载时按分类局部拉取（首屏/懒加载路径）
      // 加载期间用遮罩覆盖「筛选分类区 + 卡片区」，避免闪现「数量 0」与空分类
      if (!bankData.value[name]) {
        tabLoading.value = true;
        load(false, name).finally(() => {
          if (data.activeTab === name) tabLoading.value = false;
        });
      } else {
      }
    };
    const toggleChip = (depth, name) => {
      const sel = getSelections();
      if (!Array.isArray(sel[depth])) sel[depth] = [];
      if (sel[depth].length === 1 && sel[depth][0] === name) {
        sel[depth] = [];
      } else {
        sel[depth] = [name];
        // 设置项开启时，点击分类自动把整条父链选中（name 为从词库根开始的完整相对路径 key）
        if (pref.autoSelectParent) {
          const parts = String(name).split('/');
          // 第 i 级父链 = 取到第 i+1 层，恰好等于上一层的完整 key
          for (let i = 0; i < depth && i < parts.length - 1; i++) {
            if (!Array.isArray(sel[i])) sel[i] = [];
            sel[i] = [parts.slice(0, i + 2).join('/')];
          }
        }
      }
      for (let i = depth + 1; i < maxDepth.value; i++) sel[i] = [];
    };
    const clearChip = (depth) => {
      const sel = getSelections();
      sel[depth] = [];
      for (let i = depth + 1; i < maxDepth.value; i++) sel[i] = [];
    };
    const togglePoolForTab = (tab) => {
      const idx = data.randomPools.findIndex(it => it.kind === 'tab' && it.tab === tab);
      if (idx >= 0) { const rm = data.randomPools[idx]; data.randomPools.splice(idx, 1); zhuleLog('togglePoolForTab: 移出池', rm, 'selected=', selSummary()); syncPlaceholders(); return; }
      const chk = hasPoolConflict(tab, '');
      if (chk.conflict) return showToast('无法加入：' + chk.msg, 'warn');
      data.randomPools.push({ kind: 'tab', tab, path: [], display: tab });
      zhuleLog('togglePoolForTab: 加入池', { kind: 'tab', tab }, 'selected=', selSummary());
      syncPlaceholders();
    };
    const togglePoolForChip = (depth, name) => {
      const path = chipPathFor(depth, name);
      const tab = data.activeTab;
      const chipId = chipIdFor(tab, depth, name);
      const idx = data.randomPools.findIndex(it => it.kind === 'chip' && it.tab === tab && (it.chipId ? it.chipId === chipId : samePath(it.path, path)));
      if (idx >= 0) { const rm = data.randomPools[idx]; data.randomPools.splice(idx, 1); zhuleLog('togglePoolForChip: 移出池', rm, 'selected=', selSummary()); syncPlaceholders(); return; }
      const chk = hasPoolConflict(tab, chipId);
      if (chk.conflict) return showToast('无法加入：' + chk.msg, 'warn');
      data.randomPools.push({ kind: 'chip', tab, path, chipId, display: path.map(dispKey).join('/') });
      zhuleLog('togglePoolForChip: 加入池', { kind: 'chip', tab, path, chipId, display: path.map(dispKey).join('/') }, 'selected=', selSummary());
      syncPlaceholders();
    };
    const clearRandomPools = () => { data.randomPools.splice(0, data.randomPools.length); zhuleLog('clearRandomPools', 'selected=', selSummary()); syncPlaceholders(); };

    // ============ 占位符（右键 tab / chip 进池时同步出现在已选列表，类名即占位名；遍历/随机出词后填充该位置） ============
    const poolKeyFor = (item) => item.kind === 'tab' ? 'tab:' + item.tab : 'chip:' + item.tab + '|' + (item.path || []).join('/');
    const placeholderFor = (item) => ({
      _ph: true,
      _poolKey: poolKeyFor(item),
      tab: item.tab,
      name: item.kind === 'tab' ? tabLabel(item.tab) : (item.display || (item.path || []).map(dispKey).join('/')),
    });
    // 从占位符 _poolKey 解析分类显示名（tab:xxx / chip:tab|逐层路径），用于「分类：抽中词条名」拼接
    const placeholderBaseName = (s) => {
      if (!s || !s._poolKey) return '';
      const k = s._poolKey;
      if (k.startsWith('tab:')) return tabLabel(k.slice(4));
      const bar = k.indexOf('|');
      if (bar < 0) return '';
      return k.slice(bar + 1).split('/').map(dispKey).join('/');
    };
    // 以随机池为基准同步占位符与随机结果标签：
    // 池在 → 占位符（黄色分类标签）恒保留；池移除 → 该池的占位符与结果标签一并删除；
    // 旧版独立结果标签（带 _poolKey 的普通标签）不再保留，抽取结果统一绑定在占位符内部。
    const syncPlaceholders = () => {
      const keys = data.randomPools.map(poolKeyFor);
      data.selected = data.selected.filter(s => {
        if (s._ph) return keys.includes(s._poolKey);
        if (s._poolKey !== undefined && s._poolKey !== null) return false;
        return true;
      });
      for (const item of data.randomPools) {
        const k = poolKeyFor(item);
        if (!data.selected.some(s => s._ph && s._poolKey === k)) data.selected.push(placeholderFor(item));
      }
      zhuleLog('syncPlaceholders', 'poolKeys=', keys, 'selected=', selSummary());
    };
    // 点🎲后：把抽中词条写入对应的黄色占位符内部（绑定关系，标签显示「分类：抽中词条名」）。
    // 占位符恒保留；再点🎲原位更新；不新增独立结果标签。
    const updateRandomResults = (picked) => {
      const map = {};
      for (const e of picked) {
        if (!e || e._poolKey === undefined || e._poolKey === null) continue;
        if (!map[e._poolKey]) map[e._poolKey] = e;
      }
      const fillPh = (ph, e) => {
        ph._filled = true;
        ph.tab = e.tab; ph.relPath = e.relPath; ph.id = e.id || '';
        ph.name = placeholderBaseName(ph) + '：' + e.name;
        ph.content = e.content; ph.content_cn = e.content_cn;
      };
      // 1) 已存在的占位符原位填充/更新
      for (const s of data.selected) {
        if (!s._ph || !map[s._poolKey]) continue;
        fillPh(s, map[s._poolKey]);
      }
      // 2) 异常兜底：池在但占位符缺失时补建并填充（正常流程 syncPlaceholders 已保证占位符存在）
      for (const k of Object.keys(map)) {
        if (data.selected.some(s => s._ph && s._poolKey === k)) continue;
        const item = data.randomPools.find(it => poolKeyFor(it) === k);
        if (!item) continue;
        const ph = placeholderFor(item);
        data.selected.push(ph);
        fillPh(ph, map[k]);
      }
      zhuleLog('updateRandomResults', 'picked=', picked.map(p => p.name + '@' + p._poolKey), 'selected=', selSummary());
    };

    const setCardMode = (m) => { pref.cardMode = m; };
    const toggleTranslate = () => { pref.translate = !pref.translate; };
    const changeColumns = (d) => {
      const v = pref.columns + d;
      if (v >= 1 && v <= 20) pref.columns = v;
    };

    const changeCount = (d) => {
      const v = pref.genCount + d;
      pref.genCount = Math.max(0, Math.min(99, v));
    };
    const onCountInput = (e) => {
      let v = parseInt(e.target.value, 10);
      if (isNaN(v)) return;
      if (v < 0) v = 0;
      if (v > 99) v = 99;
      pref.genCount = v;
    };
    const fixCount = (e) => {
      let v = parseInt(e.target.value, 10);
      if (isNaN(v) || v < 0) v = 0;
      if (v > 99) v = 99;
      pref.genCount = v;
      e.target.value = v;
    };

    const prevImage = (file) => {
      const n = file.images.length;
      if (!n) return;
      setImgIdx(file, (getImgIdx(file) - 1 + n) % n);
    };
    const nextImage = (file) => {
      const n = file.images.length;
      if (!n) return;
      setImgIdx(file, (getImgIdx(file) + 1) % n);
    };
    const randomImage = (file) => {
      const n = file.images.length;
      if (!n) return;
      let i = Math.floor(Math.random() * n);
      if (n > 1 && i === getImgIdx(file)) i = (i + 1) % n;
      setImgIdx(file, i);
    };

    const zoomCardImage = (file) => {
      if (file.images && file.images.length) zoomView(imageUrl(file.images[getImgIdx(file)]), file.name || '', file);
      else zoomView(defaultImageUrl, (file.name || '') + '（暂无参考图）', file);
    };
    // 跳转图库：优先传词条 id（纯数字，服务端按 promptIds 匹配），词条改名后筛选不失效；
    // 取不到 id（如散 txt 卡片未入库）时才退回名字
    const goToGallery = (file) => {
      const tid = (file.id != null && file.id !== '') ? String(file.id) : '';
      const tag = tid || file.name || file.rawName || '';
      const url = '/zhule_studio#/gallery?tags=' + encodeURIComponent(tag);
      window.open(url, '_blank');
    };
    const closeViewer = () => { viewer.open = false; viewer.file = null; };

    // ============ 全屏查看器（公共模块，命令式，非响应式） ============
    let fullViewer = null;
    let createFullViewerFn = null;
    // 放大查看器当前展示的词条（供底部按钮回调读取）
    let zoomCtx = { file: null };

    // 在放大查看器中展示某词条的当前参考图；无参考图时回退默认图
    const openZoomedFile = (file) => {
      if (file.images && file.images.length) fullViewer.open(imageUrl(file.images[getImgIdx(file)]), file.name || '');
      else fullViewer.open(defaultImageUrl, (file.name || '') + '（暂无参考图）');
    };
    // 切换提示词：以当前筛选结果（filteredFiles）为范围，dir=±1 上下一条
    const zoomWordAt = (dir) => {
      const cur = zoomCtx.file;
      const list = filteredFiles.value;
      if (!cur || !list.length) return;
      let idx = list.findIndex(f => f.relPath === cur.relPath);
      if (idx < 0) idx = 0;
      const target = list[(idx + dir + list.length) % list.length];
      zoomCtx.file = target;
      openZoomedFile(target);
    };
    // 随机提示词：随机范围 = 当前提示词所在的筛选结果集合（非全部词条）
    const zoomRandomWord = () => {
      const cur = zoomCtx.file;
      const list = filteredFiles.value;
      if (!list.length) return;
      let i = Math.floor(Math.random() * list.length);
      if (list.length > 1 && list[i] === cur) i = (i + 1) % list.length;
      const target = list[i];
      zoomCtx.file = target;
      openZoomedFile(target);
    };
    // 切换参考图：基于当前词条 file.images，dir=±1 上一张/下一张
    const zoomRefAt = (dir) => {
      const file = zoomCtx.file;
      if (!file || !file.images || !file.images.length) return;
      const n = file.images.length;
      setImgIdx(file, (getImgIdx(file) + dir + n) % n);
      fullViewer.open(imageUrl(file.images[getImgIdx(file)]), file.name || '');
    };

    async function zoomView(url, caption, file) {
      if (!createFullViewerFn) {
        const mod = await import('/zhule_modules/common/zhule_fullviewer.js');
        createFullViewerFn = mod.createFullViewer;
        fullViewer = createFullViewerFn({
          // 词库放大界面不再显示操作提示（空 tip 隐藏提示条）
          tip: '',
          actions: [
            // 对称图标栏：大图标（外圈）切换提示词，小图标（内圈）切换参考图，骰子随机居中
            { label: '‹', tip: '上一提示词', size: 'lg', onClick: () => zoomWordAt(-1) },
            { label: '‹', tip: '上一张参考图', size: 'sm', onClick: () => zoomRefAt(-1) },
            { label: '🎲', tip: '随机提示词（当前范围）', dice: true, onClick: zoomRandomWord },
            { label: '›', tip: '下一张参考图', size: 'sm', onClick: () => zoomRefAt(1) },
            { label: '›', tip: '下一提示词', size: 'lg', onClick: () => zoomWordAt(1) },
          ],
        });
      }
      if (file) zoomCtx.file = file;
      if (fullViewer) fullViewer.open(url, caption);
    }
    const viewerPrev = () => {
      if (!viewer.file || !viewer.file.images || !viewer.file.images.length) return;
      const n = viewer.file.images.length;
      viewer.idx = (viewer.idx - 1 + n) % n;
      setImgIdx(viewer.file, viewer.idx);
    };
    const viewerNext = () => {
      if (!viewer.file || !viewer.file.images || !viewer.file.images.length) return;
      const n = viewer.file.images.length;
      viewer.idx = (viewer.idx + 1) % n;
      setImgIdx(viewer.file, viewer.idx);
    };
    const viewerRandom = () => {
      if (!viewer.file || !viewer.file.images || !viewer.file.images.length) return;
      const n = viewer.file.images.length;
      if (n > 1 && viewer.idx === getImgIdx(viewer.file)) viewer.idx = (viewer.idx + 1) % n;
      else viewer.idx = getImgIdx(viewer.file);
      setImgIdx(viewer.file, viewer.idx);
    };

    const removeSelected = (idx) => {
      const s = data.selected[idx];
      if (s && (s._ph || s._poolKey)) {
        // 移除占位符或已填充的池槽位词条时，同步移出对应随机池，保持池与槽位一一对应
        const k = s._poolKey;
        const pi = data.randomPools.findIndex(it => poolKeyFor(it) === k);
        if (pi >= 0) {
          const rm = data.randomPools[pi];
          data.randomPools.splice(pi, 1);
          zhuleLog('removeSelected: 移出池', rm, 'idx=', idx, 'selected=', selSummary());
        }
      }
      data.selected.splice(idx, 1);
      // 同步占位符，确保剩余池与占位符一一对应（补缺失/删多余）
      syncPlaceholders();
    };
    const clearAll = () => { data.selected = []; };
    const toggleRandomMode = () => {
      data.randomMode = !data.randomMode;
      if (data.randomMode) data.traverseMode = false;
    };
    const toggleTraverseMode = () => {
      data.traverseMode = !data.traverseMode;
      if (data.traverseMode) data.randomMode = false;
      // 关闭遍历模式（⏩ 取消）时，立即停止正在运行的遍历队列，避免「取消后又补上」
      if (!data.traverseMode && (traverseTarget > 0 || runBusy)) {
        resetTraverseTarget();
        runBusy = false;
        runQueue = [];
        showToast('已停止遍历，本轮共提交 ' + runTotal + ' 条任务', 'warn', 3000);
      }
    };

    // 随机池语义：每个右键选中的 tab / chip 各为一个独立子池。
    // 随机/遍历时从每个子池各取 1 条再组合（如角色/神态/身材/姿势各抽一）。
    const poolCandidates = (item) => {
      const files = bankData.value[item.tab] || [];
      if (!files.length && tabs.value.includes(item.tab)) {
        // 懒加载下该分类尚未加载：异步补拉数据，返回 null 让调用方提示稍候
        load(false, item.tab);
        zhuleLog('poolCandidates: 懒加载补拉', item.kind, 'tab=', item.tab, 'path=', item.path || []);
        return null;
      }
      if (item.kind === 'tab') { zhuleLog('poolCandidates: tab池候选', item.tab, 'count=', files.length); return files; }
      // chip 池候选 = 按节点 DB id 递归收集：该 chip 下所有后代卡片（chipIds 祖先链含本 id 的叶子）即为候选，
      // 与路径/前后缀匹配完全无关；词条改名、移动、换父级后 id 不变，候选恒稳定。
      const id = item.chipId;
      if (!id) { zhuleLog('poolCandidates: chip池缺chipId（旧存档未迁移，请重新右键加入随机池）', 'tab=', item.tab, 'path=', item.path || []); return []; }
      const out = files.filter(f => Array.isArray(f.chipIds) && f.chipIds.includes(id));
      zhuleLog('poolCandidates: chip池', 'tab=', item.tab, 'chipId=', id, 'count=', out.length, 'total=', files.length, 'sampleChipIds=', files.slice(0, 3).map(f => f.chipIds));
      return out;
    };

    // 每个池子各抽一条，返回组合（随机模式用）
    const pickFromEachPool = () => {
      if (!data.randomPools.length) { zhuleLog('pickFromEachPool: 随机池为空'); return null; }
      const picks = [];
      for (const item of data.randomPools) {
        const c = poolCandidates(item);
        if (!c || !c.length) { zhuleLog('pickFromEachPool: 候选为空返回null', item.kind, 'tab=', item.tab, 'path=', item.path || []); return null; }
        const file = c[Math.floor(Math.random() * c.length)];
        zhuleLog('pickFromEachPool: 抽中', item.kind, 'tab=', item.tab, 'name=', file.name, 'relPath=', file.relPath, '候选数=', c.length);
        picks.push({ tab: item.tab, relPath: file.relPath, id: file.id || '', name: file.name, content: file.content, content_cn: file.content_cn, _poolKey: poolKeyFor(item) });
      }
      return picks;
    };

    // 遍历组合数上限：超出时提示精简随机池，避免一次生成过多
    const TRAVERSE_MAX_COMBOS = 500;

    // 在已加载词库中按 tab + relPath 定位卡片（参考图数量 = file.images.length）
    const findWordFile = (tab, relPath) => {
      const cards = bankData.value[tab] || [];
      return cards.find(f => f.relPath === relPath) || null;
    };
    const wordImageCount = (file) => (file && Array.isArray(file.images) ? file.images.length : 0);

    // 手动选中项里「不属于任何随机池候选」的条目（如已选角色）：构建遍历组合时作为前缀保留，
    // 避免遍历动作等其它池时被组合完全覆盖丢失。返回 null 表示有池数据尚未加载。
    const selectedKeepItems = () => {
      if (!data.selected.length) return [];
      if (!data.randomPools.length) return data.selected.slice();
      const poolRels = new Set();
      for (const item of data.randomPools) {
        const c = poolCandidates(item);
        if (!c) return null;
        for (const f of c) poolRels.add(f.relPath);
      }
      return data.selected.filter(s => !s._ph && !poolRels.has(s.relPath));
    };

    // 遍历模式组合列表：各池候选按名称排序，组合按「第一个池子变化最慢、最后一个最快」依次排列；
    // 组合前自动拼接保留项（selectedKeepItems），池条目带 _pool 标记供目标数量判定
    const buildTraverseCombos = () => {
      if (!data.randomPools.length) return null;
      const kept = selectedKeepItems();
      if (kept === null) return null;
      const lists = [];
      for (const item of data.randomPools) {
        const c = poolCandidates(item);
        if (!c || !c.length) return null;
        lists.push([...c].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')).map(file => ({ tab: item.tab, file, _poolKey: poolKeyFor(item) })));
      }
      const total = lists.reduce((n, l) => n * l.length, 1);
      if (total > TRAVERSE_MAX_COMBOS) return { tooMany: total };
      let combos = [[]];
      for (const l of lists) {
        const next = [];
        for (const pre of combos) {
          for (const entry of l) next.push([...pre, entry]);
        }
        combos = next;
      }
      return combos.map(combo => [...kept, ...combo.map(e => ({ tab: e.tab, relPath: e.file.relPath, id: e.file.id || '', name: e.file.name, content: e.file.content, content_cn: e.file.content_cn, _pool: true, _poolKey: e._poolKey }))]);
    };

    // 旧存档 chip 池一次性补 DB id（不再归一化路径）：按 path（完整键链或显示名链）反查
    // 该 chip 节点的 id，补上 chipId 后候选匹配一律走 id 递归，路径逻辑彻底废弃。
    const normalizePoolIds = () => {
      for (const it of data.randomPools) {
        if (it.kind !== 'chip' || it.chipId) continue;
        const files = bankData.value[it.tab] || [];
        if (!files.length) continue;
        const keyPath = it.path || [];
        if (!keyPath.length) continue;
        const dispPath = keyPath.map(dispKey);
        let hit = null;
        let hitLen = 0;
        for (const v of [{ arr: keyPath, prop: 'chipKeys' }, { arr: dispPath, prop: 'chips' }, ...(dispPath.length > 1 ? [{ arr: dispPath.slice(1), prop: 'chips' }] : [])]) {
          if (hit || !v.arr.length) continue;
          const f = files.find(c => v.arr.every((s, i) => (c[v.prop] || [])[i] === s));
          if (f) { hit = f; hitLen = v.arr.length; }
        }
        if (!hit) continue;
        const ids = hit.chipIds || [];
        if (ids.length >= hitLen) it.chipId = ids[hitLen - 1];
      }
      syncPlaceholders();
    };

    // 随机池里所有 tab 的数据是否都已加载；没加载的先补齐（懒加载下未打开过的分类会被误判为空）
    const ensurePoolData = async () => {
      const missing = data.randomPools.filter(it => {
        const files = bankData.value[it.tab] || [];
        return !files.length && tabs.value.includes(it.tab);
      });
      zhuleLog('ensurePoolData: 池=', data.randomPools.map(p => p.kind + ':' + p.tab + (p.chipId ? '/id:' + p.chipId : (p.path ? '/' + p.path.join('/') : ''))), 'missing=', missing.map(m => m.tab));
      if (missing.length) {
        // 并行补拉缺失的 tab，补齐后再抽
        await Promise.all(missing.map(it => load(false, it.tab)));
      }
      // 补拉后把旧存档 chip 池补上 DB id，再统一判断是否真空
      normalizePoolIds();
      // 补拉完仍为空 = 该 tab 真的没有词条
      const ready = data.randomPools.every(it => (bankData.value[it.tab] || []).length > 0);
      zhuleLog('ensurePoolData: ready=', ready, '各池词条数=', data.randomPools.map(p => p.tab + ':' + (bankData.value[p.tab] || []).length));
      return ready;
    };

    const singleRandom = async () => {
      const ready = await ensurePoolData();
      if (!ready) return showToast('随机池含空分类（该 tab 下暂无词条），请检查随机池', 'warn');
      const picked = pickFromEachPool();
      if (!picked) return showToast('随机池为空或含空分类，右键 tab 或 chip 加入随机池', 'warn');
      updateRandomResults(picked);
      showToast('已抽取：' + picked.map(s => s.name || s.content).join(' / ') + '，已填入黄色分类标签', 'success', 3200);
    };

    // ============ 池子模式逐条出图：驱动画布逐条运行，等 ack 再下一条 ============
    let runQueue = [];
    let runBusy = false;
    let runTotal = 0;
    // 遍历目标数量模式：自动逐轮补跑，每轮每个参考图不足目标数量的组合各补 1 次，直到全部达标
    let traverseTarget = 0;
    let extraRuns = new Map();
    // 启动遍历时对每个池条目已收录参考图数的快照；轮间不再依赖 index 实时刷新，
    // 判定仅用「快照 + 累计提交次数」，杜绝收录延迟导致 got 恒 0 的无限补跑
    let initialGot = new Map();
    const resetTraverseTarget = () => { traverseTarget = 0; extraRuns = new Map(); initialGot = new Map(); };

    // 组合是否需要本轮补跑：其随机池条目中任一「启动快照参考图数 + 已累计提交次数」< 目标数量即补跑 1 次
    const traverseNeedRun = (combo, target) => {
      let need = false;
      for (const e of combo) {
        if (!e._pool) continue;
        const got = (initialGot.get(e.relPath) || 0) + (extraRuns.get(e.relPath) || 0);
        if (got < target) { need = true; break; }
      }
      return need;
    };

    // 集中填充：不再每轮给所有不足组合各补 1 次（均匀增长），而是只取第一个未达标组合，
    // 持续提交到它达到目标数量（第一个桶倒满）后，才进入下一个未达标组合
    const filterTraversePending = (combos, target) => {
      for (const combo of combos) {
        if (!traverseNeedRun(combo, target)) continue;
        for (const e of combo) {
          if (e._pool) extraRuns.set(e.relPath, (extraRuns.get(e.relPath) || 0) + 1);
        }
        return [combo];
      }
      return [];
    };

    const runNextInQueue = async () => {
      if (runQueue.length === 0) {
        if (traverseTarget > 0) {
          // 遍历目标模式：后台静默补跑（集中填充：先满一桶再下一桶）。不再轮间刷新词库 index
          //（避免下方标签不断变化），达标判定仅用「启动快照 + 累计提交次数」，提交次数达到目标
          // 即停，杜绝 index 收录延迟导致 got 恒 0 的无限循环；用户关闭遍历模式（⏩）即停止。
          if (!data.traverseMode) {
            resetTraverseTarget();
            runBusy = false;
            showToast('已停止遍历，共提交 ' + runTotal + ' 条任务', 'warn', 3000);
            return;
          }
          const built = buildTraverseCombos();
          if (built && !built.tooMany) {
            const pending = filterTraversePending(built, traverseTarget);
            if (pending.length) {
              runQueue = pending;
              runTotal += pending.length;
              runBusy = true;
              runNextInQueue();
              return;
            }
          }
          const t = traverseTarget;
          resetTraverseTarget();
          runBusy = false;
          showToast('已提交 ' + runTotal + ' 条任务：遍历池提示词参考图均已达到目标数量 ' + t, 'success', 3500);
          return;
        }
        runBusy = false;
        showToast('已全部完成 ' + runTotal + ' 条', 'success', 3000);
        return;
      }
      // 占位符始终保留在 selected 中（与普通提示词标签一致），不再用 fillPlaceholders 替换占位符，
      // 避免下方标签飞速切换、占位符被换成最后一条提示词
      const items = runQueue.shift();
      ensureRunChannel();
      runChannel.postMessage({
        type: 'zhule:run',
        bindId: linkParams.bind,
        seq: ++runSeq,
        items: items.map(s => ({ id: s.id || '', name: s.name, content: s.content })),
        count: 1,
      });
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          resetTraverseTarget();
          runBusy = false;
          runQueue = [];
          showToast('未收到画布回执，已停止（请确认画布页已打开、工作流已加载且ID一致）', 'error', 4000);
        }
      }, 8000);
      runChannel.onmessage = (ev) => {
        const m = ev.data;
        if (!m || m.type !== 'zhule:ack' || m.bindId !== linkParams.bind) return;
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (m.ok) runNextInQueue();
        else {
          resetTraverseTarget();
          runBusy = false;
          runQueue = [];
          showToast('运行失败：' + (m.error || '未知错误') + '，已停止', 'error', 4000);
        }
      };
    };

    const runGenerate = async () => {
      const count = pref.genCount;
      if (data.randomMode || data.traverseMode) {
        if (!data.randomPools.length) return showToast('随机池为空，右键 tab 或 chip 加入随机池', 'warn');
        const ready = await ensurePoolData();
        if (!ready) return showToast('随机池含空分类（该 tab 下暂无词条），请检查随机池', 'warn');
        if (runBusy) return showToast('正在逐条运行中，请稍候', 'warn');
        if (!linkParams.bind) return showToast('当前网页未绑定节点，请从画布节点「词库」按钮打开本页', 'warn', 4000);
        let combos;
        if (data.randomMode) {
          combos = [];
          const rndCount = count || 1;
          for (let i = 0; i < rndCount; i++) {
            const picked = pickFromEachPool();
            if (!picked) return showToast('随机池含空分类或数据未加载，请检查随机池', 'warn');
            combos.push(picked);
          }
        } else {
          const built = buildTraverseCombos();
          if (!built) return showToast('遍历池含空分类或数据未加载，请检查随机池', 'warn');
          if (built.tooMany) return showToast('组合数过多（' + built.tooMany + '），请精简随机池（上限 ' + TRAVERSE_MAX_COMBOS + '）', 'warn', 4000);
          // 目标数量：以当前池条目参考图数最多的为基准（maxGot），
          // 设置 0 时目标 = 基准，把不足的提示词全部补到当前最多那个的数量；
          // 设置自然数 N 时目标 = 基准 + N，所有提示词补到（最多数量 + N）。
          // 集中填充：不追求均匀，先从第一个不足目标数量的组合开始持续提交到达标，
          // 倒满一桶再下一桶；轮间自动循环直至全部达标。
          // 启动时对每个池条目已收录参考图数做一次快照，此后仅按「快照 + 累计提交次数」判定，
          // 不再依赖轮间 index 刷新（避免下方标签反复变化，也杜绝收录延迟导致的无限循环）。
          extraRuns = new Map();
          initialGot = new Map();
          for (const combo of built) {
            for (const e of combo) {
              if (e._pool && !initialGot.has(e.relPath)) {
                initialGot.set(e.relPath, wordImageCount(findWordFile(e.tab, e.relPath)) || 0);
              }
            }
          }
          let maxGot = 0;
          for (const got of initialGot.values()) if (got > maxGot) maxGot = got;
          traverseTarget = maxGot + count;
          const pending = filterTraversePending(built, traverseTarget);
          if (!pending.length) {
            resetTraverseTarget();
            return showToast('遍历池提示词参考图均已达到目标数量 ' + traverseTarget + '，无需补跑', 'success', 3000);
          }
          combos = pending;
        }
        runQueue = combos;
        runTotal = combos.length;
        runBusy = true;
        runNextInQueue();
        return;
      }
      // 普通模式：占位符已填充（绑定抽中词条）时参与运行；未抽取的占位符跳过
      const readyItems = data.selected.filter(s => !s._ph || s._filled);
      if (!readyItems.length) return showToast('还没选任何提示词', 'warn');
      if (runBusy) return showToast('正在逐条运行中，请稍候', 'warn');
      if (!linkParams.bind) {
        return showToast('当前网页未绑定节点，请从画布节点「词库」按钮打开本页', 'warn', 4000);
      }
      const text = readyItems.map(s => s.content).join(', ');
      // 通过 BroadcastChannel 广播运行指令，节点 _selected 直接承载词条。
      ensureRunChannel();
      runChannel.postMessage({
        type: 'zhule:run',
        bindId: linkParams.bind,
        seq: ++runSeq,
        // 带 id（词条 id，提示词标签按 id 传递，词条改名/移动不脱钩）、name（词条名）与 content（提示词文本）
        items: readyItems.map(s => ({ id: s.id || '', name: s.name, content: s.content })),
        count,
      });
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
          showToast('未收到画布回执，请确认画布页已打开、工作流已加载且ID一致', 'error', 4000);
        }
      }, 5000);
      runChannel.onmessage = (ev) => {
        const m = ev.data;
        if (!m || m.type !== 'zhule:ack' || m.bindId !== linkParams.bind) return;
        done = true;
        clearTimeout(timer);
        if (m.ok) showToast('开始执行 ' + count + ' 次', 'success', 3000);
        else showToast('运行失败：' + (m.error || '未知错误'), 'error', 4000);
      };
    };

    // ============ 去中文清理已移入导航栏设置面板（main.js 词库设置分组），本页不再保留按钮与逻辑 ============

    // ============ Tab / Chip 拖动排序（HTML5 DnD） ============
    const tabLabel = (n) => (n || '').replace(/^\d+[_ ]+/, '');
    let tabDrag = { name: null };
    const onTabDragStart = (e, name) => {
      tabDrag.name = name;
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', name); }
    };
    const onTabDragOver = (e, name) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const from = tabs.value.indexOf(tabDrag.name);
      const to = tabs.value.indexOf(name);
      if (from >= 0 && to >= 0 && from !== to) {
        const [moved] = tabs.value.splice(from, 1);
        tabs.value.splice(to, 0, moved);
      }
    };
    const onTabDrop = () => { tabDrag = { name: null }; };
    const onTabDragEnd = async () => {
      const ordered = [...tabs.value];
      tabDrag = { name: null };
      // 不再自动写回文件夹：仅更新本地顺序并提示手动「排序保存」
      tabOrder.value = ordered;
      saveState();
      showToast('tab 顺序已调整，点击「排序保存」写回文件夹', 'info', 2600);
    };

    let chipDrag = { depth: -1, name: null, overName: null };
    const onChipDragStart = (e, depth, name) => {
      chipDrag = { depth, name, overName: null };
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', name); }
    };
    const onChipDragOver = (e, depth, name) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      if (chipDrag.depth !== depth) return;
      chipDrag.overName = name;
    };
    const onChipDragEnd = () => {
      const { depth, name, overName } = chipDrag;
      if (depth >= 0 && name && overName && overName !== name) {
        const line = chipLines.value[depth] || [];
        const from = line.indexOf(name);
        const to = line.indexOf(overName);
        if (from >= 0 && to >= 0 && from !== to) {
          const ordered = [...line];
          const [moved] = ordered.splice(from, 1);
          ordered.splice(to, 0, moved);
          // 按「层级+父节点id」隔离记录显示名顺序（本地），写回文件夹由「排序保存」统一完成
          const parentPath = chipParentPath(depth);
          const parentId = parentPath
            ? (chipIdFor(data.activeTab, parentPath.split('/').length - 2, parentPath) || parentPath)
            : (tabIds.value[data.activeTab] || '');
          chipOrder[data.activeTab] = { ...chipOrder[data.activeTab], [depth + '|' + parentId]: ordered.map(dispKey) };
          showToast('分类顺序已调整，点击「排序保存」写回文件夹', 'info', 2200);
        }
      }
      chipDrag = { depth: -1, name: null, overName: null };
    };

    // ============ 手动「排序保存」：把当前完整数据顺序写回文件夹 ============
    const bankSaving = ref(false);

    // 从当前完整数据重建「父节点 id -> 直接子节点 id」的有序映射：
    // 基底 = 后端层级深度优先顺序（卡片按 relPath 逐段排序），chipOrder（显示名）覆盖中间层顺序
    const buildBankOrder = () => {
      const order = {};
      const nameById = {};
      const seen = new Set();
      const pushChild = (parentId, childId) => {
        const key = parentId + '/' + childId;
        if (seen.has(key)) return;
        seen.add(key);
        if (!order[parentId]) order[parentId] = [];
        order[parentId].push(childId);
      };
      const tabIdOf = (tab) => tabIds.value[tab] || '';
      // 顶层 tab：当前展示顺序
      tabs.value.forEach(t => {
        const tid = tabIdOf(t);
        if (!tid) return;
        pushChild('', tid);
        nameById[tid] = t;
      });
      tabs.value.forEach(tab => {
        const tid = tabIdOf(tab);
        if (!tid) return;
        const cards = bankData.value[tab] || [];
        cards.forEach(card => {
          // chip 中间层：chipKeys 每级完整相对路径，chipIds 每级 DB id（不含 tab 根）
          const keys = Array.isArray(card.chipKeys) ? card.chipKeys : [];
          const ids = Array.isArray(card.chipIds) ? card.chipIds : [];
          keys.forEach((k, i) => {
            const pid = i === 0 ? tid : ids[i - 1];
            const cid = ids[i];
            if (!pid || !cid) return;
            pushChild(String(pid), String(cid));
            nameById[String(cid)] = dispKey(k);
          });
          // 卡片层：父 = 最后一级 chip id（无 chip 则 tab id）
          const pid = ids.length ? String(ids[ids.length - 1]) : tid;
          if (pid && card.id) {
            pushChild(String(pid), String(card.id));
            nameById[String(card.id)] = card.name || dispKey(card.relPath || '');
          }
        });
      });
      // 应用 chipOrder：对每个 tab 的每层，把对应父节点下的直接子项按显示名顺序重排
      tabs.value.forEach(tab => {
        const tOrder = chipOrder[tab] || {};
        Object.keys(tOrder).forEach(dStr => {
          const sep = dStr.indexOf('|');
          const d = parseInt(sep >= 0 ? dStr.slice(0, sep) : dStr, 10);
          const parentKey = sep >= 0 ? dStr.slice(sep + 1) : '';
          const names = tOrder[dStr];
          if (!Array.isArray(names) || !names.length) return;
          // 新格式：parentKey 为父节点 id；旧格式：为完整路径（反查 id）
          let parents = [];
          if (parentKey) {
            if (/^\d+$/.test(parentKey)) {
              if (order[parentKey]) parents = [parentKey];
            } else {
              const byPath = new Map();
              const cards = bankData.value[tab] || [];
              cards.forEach(c => {
                const keys = Array.isArray(c.chipKeys) ? c.chipKeys : [];
                const ids = Array.isArray(c.chipIds) ? c.chipIds : [];
                keys.forEach((k, i) => { if (ids[i]) byPath.set(k, String(ids[i])); });
              });
              const pid = byPath.get(parentKey);
              if (pid && order[pid]) parents = [pid];
            }
          }
          if (!parents.length) return;
          parents.forEach(p => {
            const items = order[p];
            if (!items || items.length < 2) return;
            const byDisp = new Map();
            items.forEach(cid => {
              const disp = String(nameById[cid] != null ? nameById[cid] : cid);
              if (!byDisp.has(disp)) byDisp.set(disp, []);
              byDisp.get(disp).push(cid);
            });
            const reordered = [];
            const used = new Set();
            names.forEach(n => {
              const disp = /^\d+$/.test(String(n)) ? String(n) : String(dispKey(n));
              (byDisp.get(disp) || []).forEach(cid => { if (!used.has(cid)) { reordered.push(cid); used.add(cid); } });
            });
            items.forEach(cid => { if (!used.has(cid)) { reordered.push(cid); used.add(cid); } });
            order[p] = reordered;
          });
        });
      });
      return order;
    };

    const saveBankOrder = async () => {
      if (bankSaving.value) return;
      bankSaving.value = true;
      try {
        // 确保所有 tab 数据已加载：懒加载下未访问过的分类不在 bankData，避免排序重建遗漏
        const missing = tabs.value.filter(t => !bankData.value[t]);
        if (missing.length) await load(true);
        const order = buildBankOrder();
        const resp = await fetch('/zhule_studio/api/wordbank/sort-save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order }),
        });
        const json = await resp.json();
        if (!json || json.error) {
          showToast('排序保存失败：' + ((json && json.error) || '未知错误'), 'error', 4000);
          return;
        }
        if (json.ok) {
          showToast('排序已保存：更新 ' + (json.total || 0) + ' 项', 'success', 3000);
          await load(true);
        } else {
          showToast('排序保存失败：' + (json.message || '未知错误'), 'error', 4000);
        }
      } catch (e) {
        showToast('排序保存请求失败：' + e.message, 'error', 4000);
      } finally {
        bankSaving.value = false;
      }
    };

    // ============ 拖拽 ============
    let pDrag = { pending: null, pendingTime: 0, active: false, ghostEl: null, suppressClickUntil: 0 };

    const onCardPointerDown = (e, file) => {
      if (e.button !== 0) return;
      if (e.target.closest('.thumb-zoom') || e.target.closest('.thumb-nav') || e.target.closest('.file-zoom') || e.target.closest('.card-edit') || e.target.closest('.card-del-btn')) return;
      if (pDrag.pending) {
        if (performance.now() - pDrag.pendingTime > 3000) cleanupDrag(); else return;
      }
      e.preventDefault();
      const existIdx = data.selected.findIndex(s => s.relPath === file.relPath);
      pDrag.pending = {
        x: e.clientX, y: e.clientY,
        sourceType: 'card',
        item: { tab: data.activeTab, relPath: file.relPath, name: file.name, content: file.content, content_cn: file.content_cn },
        noDrag: existIdx >= 0,
      };
      pDrag.pendingTime = performance.now();
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerCancel);
    };

    const onTagPointerDown = (e, idx) => {
      if (e.button !== 0 || e.target.closest('.close')) return;
      if (pDrag.pending) {
        if (performance.now() - pDrag.pendingTime > 3000) cleanupDrag(); else return;
      }
      e.preventDefault();
      const item = data.selected[idx];
      if (!item) return;
      pDrag.pending = {
        x: e.clientX, y: e.clientY,
        sourceType: 'tag',
        sourceIdx: idx,
        item: { ...item },
        noDrag: false,
      };
      pDrag.pendingTime = performance.now();
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerCancel);
    };

    const onSelListPointerDown = () => { };

    const onPointerMove = (e) => {
      const p = pDrag.pending;
      if (!p) return;
      if (!pDrag.active) {
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        if (Math.hypot(dx, dy) < 6) return;
        if (p.noDrag) { cleanupDrag(); return; }

        pDrag.active = true;
        drag.active = true;
        drag.sourceType = p.sourceType;
        drag.sourceIdx = p.sourceIdx ?? -1;
        drag.sourceRelPath = p.item.relPath;

        document.body.classList.add('zhule-dragging');
        const ghost = document.createElement('div');
        ghost.className = 'drag-ghost';
        ghost.textContent = p.item.name;
        document.body.appendChild(ghost);
        pDrag.ghostEl = ghost;
      }
      if (pDrag.ghostEl) {
        pDrag.ghostEl.style.transform = 'translate3d(' + e.clientX + 'px,' + e.clientY + 'px,0) translate(-50%,-50%)';
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      updateHover(el, e.clientX, e.clientY);
    };

    const updateHover = (el, x, y) => {
      if (!el) {
        drag.hoverTagIdx = -1; drag.hoverSide = null; drag.hoverCardRelPath = null;
        return;
      }
      const tag = el.closest('.tag');
      if (tag) {
        const tags = [...document.querySelectorAll('.selected-list .tag')];
        const idx = tags.indexOf(tag);
        if (idx < 0) { drag.hoverTagIdx = -1; drag.hoverSide = null; return; }
        const rect = tag.getBoundingClientRect();
        drag.hoverTagIdx = idx;
        drag.hoverSide = (x - rect.left) < rect.width / 2 ? 'left' : 'right';
        drag.hoverCardRelPath = null;
        return;
      }
      const selList = el.closest('.selected-list');
      if (selList) {
        drag.hoverTagIdx = -1; drag.hoverSide = 'selList'; drag.hoverCardRelPath = null;
        return;
      }
      const card = el.closest('.card');
      if (card && pDrag.pending && pDrag.pending.sourceType === 'card') {
        // 通过 data-rel 定位卡片（分页渲染下 DOM 索引与 filteredFiles 不再一一对应，且要排除 card-add）
        const rel = card.getAttribute('data-rel');
        const f = rel ? filteredFiles.value.find(x => x.relPath === rel) : null;
        if (f) {
          drag.hoverTagIdx = -1; drag.hoverSide = null; drag.hoverCardRelPath = f.relPath;
          return;
        }
      }
      drag.hoverTagIdx = -1; drag.hoverSide = null; drag.hoverCardRelPath = null;
    };

    const onPointerUp = (e) => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      const p = pDrag.pending;
      if (!p) return;

      if (!pDrag.active) {
        pDrag.pending = null; pDrag.pendingTime = 0;
        if (p.sourceType === 'card') {
          const file = (bankData.value[p.item.tab] || []).find(f => f.relPath === p.item.relPath);
          if (file) toggleFile(file);
        }
        return;
      }
      pDrag.suppressClickUntil = performance.now() + 200;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      updateHover(el, e.clientX, e.clientY);
      applyDrop(e.clientX, e.clientY, p);
      cleanupDrag();
    };

    const onPointerCancel = () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      cleanupDrag();
    };

    const cleanupDrag = () => {
      if (pDrag.ghostEl) { pDrag.ghostEl.remove(); pDrag.ghostEl = null; }
      document.body.classList.remove('zhule-dragging');
      drag.active = false; drag.sourceType = null; drag.sourceIdx = -1; drag.sourceRelPath = null;
      drag.hoverTagIdx = -1; drag.hoverSide = null; drag.hoverCardRelPath = null;
      pDrag.pending = null; pDrag.pendingTime = 0; pDrag.active = false;
    };

    const applyDrop = (x, y, p) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return;
      const tag = el.closest('.tag');
      const selList = el.closest('.selected-list');
      const card = el.closest('.card');

      if (tag) {
        const tags = [...document.querySelectorAll('.selected-list .tag')];
        const idx = tags.indexOf(tag);
        if (idx < 0) return;
        const rect = tag.getBoundingClientRect();
        const isLeft = (x - rect.left) < rect.width / 2;
        if (p.sourceType === 'tag') {
          const fromIdx = p.sourceIdx;
          if (fromIdx === idx) return;
          const [moved] = data.selected.splice(fromIdx, 1);
          let t;
          if (isLeft) t = fromIdx < idx ? idx - 1 : idx;
          else t = fromIdx < idx ? idx : idx + 1;
          data.selected.splice(t, 0, moved);
        } else {
          const item = { tab: p.item.tab, relPath: p.item.relPath, id: p.item.id || '', name: p.item.name, content: p.item.content, content_cn: p.item.content_cn };
          const existIdx = data.selected.findIndex(s => s.relPath === item.relPath);
          let targetIdx = idx;
          if (existIdx >= 0) {
            data.selected.splice(existIdx, 1);
            if (existIdx < targetIdx) targetIdx--;
          }
          if (isLeft) data.selected.splice(targetIdx, 0, item);
          else data.selected.splice(targetIdx + 1, 0, item);
        }
        return;
      }

      if (selList) {
        if (p.sourceType === 'tag') {
          const [moved] = data.selected.splice(p.sourceIdx, 1);
          data.selected.push(moved);
        } else {
          const item = { tab: p.item.tab, relPath: p.item.relPath, id: p.item.id || '', name: p.item.name, content: p.item.content, content_cn: p.item.content_cn };
          if (data.selected.some(s => s.relPath === item.relPath)) return;
          data.selected.push(item);
        }
        return;
      }

      if (card && p.sourceType === 'card') {
        // 通过 data-rel 定位目标卡片（分页渲染下 DOM 索引与 filteredFiles 不再一一对应，且排除 card-add）
        const rel = card.getAttribute('data-rel');
        const target = rel ? filteredFiles.value.find(x => x.relPath === rel) : null;
        if (!target) return;
        const targetIdx = data.selected.findIndex(s => s.relPath === target.relPath);
        const item = { tab: p.item.tab, relPath: p.item.relPath, name: p.item.name, content: p.item.content, content_cn: p.item.content_cn };
        if (targetIdx >= 0) {
          data.selected.splice(targetIdx, 1, item);
        } else {
          if (data.selected.some(s => s.relPath === item.relPath)) return;
          data.selected.push(item);
        }
      }
    };

    const toggleFile = (file) => {
      const idx = data.selected.findIndex(s => s.relPath === file.relPath);
      if (idx >= 0) data.selected.splice(idx, 1);
      else data.selected.push({
        tab: data.activeTab, relPath: file.relPath, id: file.id || '', name: file.name,
        content: file.content, content_cn: file.content_cn,
      });
    };

    // ============ 生命周期 ============
    watch([data, pref, chipsCollapsed, chipsHeight, selectedCollapsed, tabOrder, chipOrder], saveState, { deep: true });
    let clickBlocker;
    // 图库详情 tag 保存词条后触发，同步刷新词库卡片列表
    const onWordbankChanged = () => { load(false); };
    onMounted(() => {
      clickBlocker = (e) => {
        if (performance.now() < pDrag.suppressClickUntil) {
          e.preventDefault(); e.stopPropagation();
        }
      };
      document.addEventListener('click', clickBlocker, true);
      window.addEventListener('zhule-wordbank-pref', onWordbankPref);
      window.addEventListener('zhule-pref-changed', onGlobalPrefChanged);
      window.addEventListener('zhule:wordbank-changed', onWordbankChanged);
      load(); // 首屏加载数据（加载遮罩已移除）
    });
    onBeforeUnmount(() => {
      if (clickBlocker) document.removeEventListener('click', clickBlocker, true);
      window.removeEventListener('zhule-wordbank-pref', onWordbankPref);
      window.removeEventListener('zhule-pref-changed', onGlobalPrefChanged);
      window.removeEventListener('zhule:wordbank-changed', onWordbankChanged);
      if (fullViewer) fullViewer.close();
      window.removeEventListener('paste', onUploadRefPaste);
      window.removeEventListener('dragover', preventDropDefault);
      window.removeEventListener('drop', preventDropDefault);
    });

    return {
      loaded, tabLoading, error, tabs, data, pref, drag, load,
      editTarget, editName, editContent, editContentCn, editIsTxt, editing,
      openEdit, cancelEdit, submitEdit,
      del, askDeleteWord,
      uploadRefOpen, closeUploadRef, pickUploadRef, onUploadRefInput,
      onUploadRefDragEnter, onUploadRefDragLeave, onUploadRefDrop, onUploadRefPaste,
      uploadRefDrag, uploadRefPreview, uploadRefFileName, uploadRefBusy, submitUploadRef, openUploadRef,
      chipLines, filteredFiles, previewText,
      pageIndex, pageCount, pageNumbers, visibleFiles, goPrevPage, goNextPage, goPage,
      getSelections,
      chipsCollapsed, chipsHeightCss, toggleChips, onChipsResizeDown,
      selectedCollapsed, toggleSelectedCollapsed,
      imageUrl, getImgIdx, displayContent, isFileSelected,
      defaultImageUrl,
      isTabInPool, isChipInPool, tabHasSelected,
      switchTab, toggleChip, clearChip, togglePoolForTab, togglePoolForChip, clearRandomPools,
      addTabOpen, addTabName, addingTab, openAddTab, closeAddTab, submitAddTab,
      canAddChip, chipParentLabel, canAddCard, addCardParentLabel, addCardIsTxt,
      chipThemeClass, chipStyle,
      addChipOpen, addChipName, addChipDepth, addChipInput, addingChip, openAddChip, closeAddChip, submitAddChip,
      addCardOpen, addCardName, addCardContent, addCardContentCn, addCardInput, addingCard, openAddCard, closeAddCard, submitAddCard,
      setCardMode, toggleTranslate, changeColumns, changeCount, onCountInput, fixCount,
      prevImage, nextImage, randomImage, goToGallery,
      viewer, closeViewer, viewerPrev, viewerNext, viewerRandom, zoomView, zoomCardImage,
      removeSelected, clearAll, toggleRandomMode, toggleTraverseMode, singleRandom, runGenerate,
      onTabDragStart, onTabDragOver, onTabDrop, onTabDragEnd,
      tabLabel,
      onChipDragStart, onChipDragOver, onChipDragEnd,
      dispKey, bankSaving, saveBankOrder,
      onCardPointerDown, onTagPointerDown, onSelListPointerDown,
      toast, toastIcon, dismissToast,
    };
  },
};
