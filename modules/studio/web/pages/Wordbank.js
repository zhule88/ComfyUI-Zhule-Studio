import { reactive, computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue';

export default {
  name: 'Wordbank',
  template: `
    <div class="page active">
      <div v-if="!loaded" class="zhule-loader">
        <div class="loader"></div>
      </div>
      <div v-else-if="error" class="empty" style="padding:60px;text-align:center;color:#ff8fa8;">
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
          <button class="btn" @click="singleRandom">🎲</button>
          <button class="btn" :class="{active: data.randomMode}" @click="toggleRandomMode">🔄</button>
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
                   :class="{active: getSelections()[depth].includes(name), 'in-pool': isChipInPool(depth, name)}"
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
                  <button class="card-edit file-zoom" data-tip="放大预览" @pointerdown.stop @click.stop="openFileDetail(file)">🔍</button>
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
        <div v-if="tabLoading" class="zhule-loader" style="background:rgba(26,29,35,0.88);z-index:40;">
          <div class="loader"></div>
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
                <input type="number" class="count-input" min="1" max="99"
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
                   'zhule-source': drag.active && drag.sourceType === 'tag' && drag.sourceIdx === idx,
                   'drag-over-insert': drag.hoverTagIdx === idx && drag.hoverSide === 'left',
                   'drag-over-insert-right': drag.hoverTagIdx === idx && drag.hoverSide === 'right'
                 }"
                 @pointerdown.stop="onTagPointerDown($event, idx)">
              <span>{{ item.name }}</span>
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
            <button class="btn" @click="cancelEdit">取消</button>
            <button class="btn primary" @click="submitEdit" :disabled="editing">保存</button>
          </div>
        </div>
      </div>

      <!-- 删除词条确认框 -->
      <div v-if="delConfirm" class="confirm-overlay" @click.self="delConfirm = null">
        <div class="confirm-dialog">
          <div class="confirm-title">确认删除</div>
          <div class="confirm-msg">
            是否确认删除当前提示词「{{ delConfirm.name }}」，此操作不可恢复。
          </div>
          <div class="confirm-actions">
            <button class="btn" @click="delConfirm = null">取消</button>
            <button class="btn danger" @click="confirmDeleteWord">确认删除</button>
          </div>
        </div>
      </div>

      <!-- 全屏查看 -->
      <div v-if="viewer.open" class="viewer-overlay" @click.self="closeViewer">
        <div class="viewer-dialog">
          <div class="viewer-head">
            <span class="viewer-title">{{ viewer.file.name }}</span>
            <button class="btn icon-btn" @click="closeViewer" data-tip="关闭">✕</button>
          </div>
          <div v-if="viewer.file.images && viewer.file.images.length" class="viewer-media">
            <img :src="imageUrl(viewer.file.images[viewer.idx])" :alt="viewer.file.name"
                 @dblclick="zoomView(imageUrl(viewer.file.images[viewer.idx]))"
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
    });

    const pref = reactive({
      cardMode: 'image',
      columns: 4,
      translate: false,
      genCount: 1,
      autoSelectParent: true,
    });

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
      const exact = t[depth + '|' + parentPath];
      if (Array.isArray(exact)) return exact;
      // 兼容旧存档：整层全局顺序（无父路径）作为兜底
      const legacy = t[depth + '|'];
      if (Array.isArray(legacy)) return legacy;
      return [];
    };

    const saveState = () => {
      const state = {
        pref: { ...pref },
        activeTab: data.activeTab,
        selections: data.selections,
        selected: data.selected.map(s => ({ tab: s.tab, relPath: s.relPath, name: s.name })),
        randomPools: data.randomPools,
        randomMode: data.randomMode,
        imgIndices: data.imgIndices,
        chipsCollapsed: chipsCollapsed.value,
        chipsHeight: chipsHeight.value,
        selectedCollapsed: selectedCollapsed.value,
        tabOrder: [...tabOrder.value],
        chipOrder: JSON.parse(JSON.stringify(chipOrder)),
      };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* 存储失败忽略 */ }
      scheduleRemoteSave();
    };

    // ---------- 远程保存：选词防抖写入后端 state 文件（节点运行兜底读取，画布手动 Run 也读最新） ----------
    let remoteSaveTimer = null;
    const flushRemoteSave = () => {
      clearTimeout(remoteSaveTimer);
      if (!linkParams.bind) return;
      const payload = {
        bindId: linkParams.bind,
        data: {
          selected: data.selected.map(s => ({ tab: s.tab, relPath: s.relPath, name: s.name, content: s.content })),
        },
      };
      fetch('/zhule_state/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => { /* 保存失败静默，不影响本地使用 */ });
    };
    const scheduleRemoteSave = () => {
      if (!linkParams.bind) return;
      clearTimeout(remoteSaveTimer);
      remoteSaveTimer = setTimeout(flushRemoteSave, 300);
    };

    const restoreState = () => {
      // 存档可能来自旧版本或手工修改，任何单点异常都不应阻断词库页加载
      try {
        let state = null;
        try { state = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch (e) { state = null; }
        if (!state) return;
        if (state.pref && typeof state.pref === 'object') {
          if (state.pref.cardMode === 'image' || state.pref.cardMode === 'file') pref.cardMode = state.pref.cardMode;
          if (typeof state.pref.columns === 'number' && state.pref.columns >= 1 && state.pref.columns <= 20) pref.columns = state.pref.columns;
          if (typeof state.pref.translate === 'boolean') pref.translate = state.pref.translate;
          if (typeof state.pref.genCount === 'number' && state.pref.genCount >= 1 && state.pref.genCount <= 99) pref.genCount = state.pref.genCount;
          if (typeof state.pref.autoSelectParent === 'boolean') pref.autoSelectParent = state.pref.autoSelectParent;
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
            if (!s || !s.tab || !s.relPath) return;
            const cards = bankData.value[s.tab] || [];
            const card = cards.find(c => c.relPath === s.relPath);
            if (card) rebuilt.push({ tab: s.tab, relPath: card.relPath, name: card.name, content: card.content, content_cn: card.content_cn });
            else rebuilt.push({ tab: s.tab, relPath: s.relPath, name: s.name || '', content: s.content || '', content_cn: s.content_cn || '' });
          });
          data.selected = rebuilt;
        }
      } catch (e) {
        // 存档损坏时仅放弃恢复，不阻断页面加载
        console.warn('词库状态恢复失败，已忽略：', e);
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
    const addCardContentCn = ref('');
    const addCardInput = ref(null);
    const addingCard = ref(false);

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

    // 父文件夹相对 tab 的路径（供后端创建词条），如 'A/B'
    const addCardParentRel = () => {
      const sel = getSelections();
      let key = '';
      for (let i = 0; i < maxDepth.value; i++) {
        if (Array.isArray(sel[i]) && sel[i].length) key = sel[i][0];
      }
      return key ? key.split('/').slice(1).join('/') : '';
    };

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
        const parent = parentKey ? parentKey.split('/').slice(1).join('/') : '';
        const resp = await fetch('/zhule_studio/api/wordbank/chip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tab: data.activeTab, parent, name }),
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
        const parent = addCardParentRel();
        const body = { tab: data.activeTab, parent, name };
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
          path: editTarget.value.relPath,
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

    // ============ 删除词条 ============
    const delConfirm = ref(null);
    const deleting = ref(false);

    const askDeleteWord = (file) => { delConfirm.value = file; };

    const confirmDeleteWord = async () => {
      if (!delConfirm.value || deleting.value) return;
      deleting.value = true;
      try {
        const resp = await fetch('/zhule_studio/api/wordbank/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: delConfirm.value.relPath }),
        });
        const json = await resp.json();
        if (json.error) {
          showToast('删除失败：' + json.error, 'error');
        } else {
          showToast('已删除：' + delConfirm.value.name, 'success');
        }
        delConfirm.value = null;
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
      fd.append('path', file.relPath);
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
        if (c) { s.name = c.name; s.content = c.content; s.content_cn = c.content_cn; dirty = true; }
      });
      if (dirty) saveState();
    };

    const load = async (force, tabName) => {
      try {
        // 非强制刷新且未指定 tab：页面已初始化时只局部刷新当前 tab；首屏时优先只拉保存的 activeTab
        if (!force && !tabName) {
          if (tabs.value.length && data.activeTab) { await load(false, data.activeTab); return; }
          if (!tabs.value.length) {
            const saved = readSavedActiveTab();
            if (saved) { await load(false, saved); return; }
          }
        }
        const params = [];
        if (force) params.push('refresh=1');
        if (tabName) params.push('tab=' + encodeURIComponent(tabName));
        const qs = params.length ? '?' + params.join('&') : '';
        const resp = await fetch('/zhule_studio/api/wordbank' + qs);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const json = await resp.json();
        if (json.error) throw new Error(json.error);
        tabs.value = json.tabs || [];
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
      return files.filter(f => {
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
      if (data.randomMode) {
        if (data.randomPools.length) {
          const display = data.randomPools.map(p => (p.kind === 'tab' ? tabLabel(p.tab) + '(全部)' : p.display));
          return '🔄 持续随机模式：池内 ' + display.length + ' 项 [' + display.join(' | ') + ']，每次随机抽 1 项';
        }
        return '🔄 持续随机模式已开，但随机池为空。右键 tab 或 chip 加入 ♻';
      }
      const text = data.selected.map(s => {
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

    // ============ 随机池（全局单池，互不包含规则） ============
    const samePath = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const containsPath = (a, b) => a.length <= b.length && a.every((v, i) => v === b[i]);

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
    const hasPoolConflict = (tab, path) => {
      const items = data.randomPools.filter(it => it.tab === tab);
      for (const it of items) {
        if (it.kind === 'tab') {
          if (path.length === 0) return { conflict: false };
          return { conflict: true, msg: `「${tabLabel(tab)}」(全部) 已进池，不能再加入其下的分类` };
        }
        if (it.kind === 'chip') {
          if (path.length === 0) return { conflict: true, msg: `「${it.display}」已进池，不能再加入整个「${tab}」` };
          if (containsPath(it.path, path)) return { conflict: true, msg: `「${it.display}」已进池，它包含「${path[path.length - 1]}」，父子不能同时进池` };
          if (containsPath(path, it.path)) return { conflict: true, msg: `「${path[path.length - 1]}」包含已进池的「${it.display}」，父子不能同时进池` };
        }
      }
      return { conflict: false };
    };

    const isTabInPool = (tab) => data.randomPools.some(it => it.kind === 'tab' && it.tab === tab);
    // 大类下有任意提示词被选中时高亮该 tab
    const tabHasSelected = (name) => {
      const cards = bankData.value[name] || [];
      if (!cards.length) return false;
      const rels = new Set(cards.map(c => c.relPath));
      return data.selected.some(s => rels.has(s.relPath));
    };
    const isChipInPool = (depth, name) => {
      const path = chipPathFor(depth, name);
      return data.randomPools.some(it => it.kind === 'chip' && it.tab === data.activeTab && samePath(it.path, path));
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
      if (idx >= 0) { data.randomPools.splice(idx, 1); return; }
      const chk = hasPoolConflict(tab, []);
      if (chk.conflict) return showToast('无法加入：' + chk.msg, 'warn');
      data.randomPools.push({ kind: 'tab', tab, path: [], display: tab });
    };
    const togglePoolForChip = (depth, name) => {
      const path = chipPathFor(depth, name);
      const tab = data.activeTab;
      const idx = data.randomPools.findIndex(it => it.kind === 'chip' && it.tab === tab && samePath(it.path, path));
      if (idx >= 0) { data.randomPools.splice(idx, 1); return; }
      const chk = hasPoolConflict(tab, path);
      if (chk.conflict) return showToast('无法加入：' + chk.msg, 'warn');
      data.randomPools.push({ kind: 'chip', tab, path, display: path.map(dispKey).join('/') });
    };
    const clearRandomPools = () => { data.randomPools.splice(0, data.randomPools.length); };

    const setCardMode = (m) => { pref.cardMode = m; };
    const toggleTranslate = () => { pref.translate = !pref.translate; };
    const changeColumns = (d) => {
      const v = pref.columns + d;
      if (v >= 1 && v <= 20) pref.columns = v;
    };

    const changeCount = (d) => {
      const v = pref.genCount + d;
      pref.genCount = Math.max(1, Math.min(99, v));
    };
    const onCountInput = (e) => {
      let v = parseInt(e.target.value, 10);
      if (isNaN(v)) return;
      if (v > 99) v = 99;
      pref.genCount = v;
    };
    const fixCount = (e) => {
      let v = parseInt(e.target.value, 10);
      if (isNaN(v) || v < 1) v = 1;
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

    const openModal = (file) => { viewer.open = true; viewer.file = file; viewer.idx = getImgIdx(file); };
    const openFileDetail = (file) => { viewer.open = true; viewer.file = file; viewer.idx = getImgIdx(file); };
    const zoomCardImage = (file) => {
      if (file.images && file.images.length) zoomView(imageUrl(file.images[getImgIdx(file)]));
      else zoomView(defaultImageUrl, (file.name || '') + '（暂无参考图）');
    };
    // 进入详情页：新建标签页跳转图库，并按当前词条名作为 tag 自动过滤
    const goToGallery = (file) => {
      const tag = file.name || file.rawName || '';
      const url = '/zhule_studio#/gallery?tags=' + encodeURIComponent(tag);
      window.open(url, '_blank');
    };
    const closeViewer = () => { viewer.open = false; viewer.file = null; };

    // ============ 全屏查看器（公共模块，命令式，非响应式） ============
    let fullViewer = null;
    let createFullViewerFn = null;
    async function zoomView(url, caption) {
      if (!createFullViewerFn) {
        const mod = await import('/zhule_modules/common/zhule_fullviewer.js');
        createFullViewerFn = mod.createFullViewer;
        fullViewer = createFullViewerFn({
          tip: '滚轮缩放 · 左键拖拽 · 双击复位 · 点击或 ✕ 退出',
        });
      }
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

    const removeSelected = (idx) => { data.selected.splice(idx, 1); };
    const clearAll = () => { data.selected = []; };
    const toggleRandomMode = () => { data.randomMode = !data.randomMode; };

    const pickRandomFromPool = () => {
      if (!data.randomPools.length) return [];
      const item = data.randomPools[Math.floor(Math.random() * data.randomPools.length)];
      if (!item || (item.kind !== 'tab' && item.kind !== 'chip')) return [];
      const files = bankData.value[item.tab] || [];
      if (!files.length && tabs.value.includes(item.tab)) {
        // 懒加载下该分类尚未加载：异步补拉数据，提示用户稍后再试
        load(false, item.tab);
        return [];
      }
      let candidates;
      if (item.kind === 'tab') candidates = files;
      else candidates = files.filter(f => containsPath(item.path, f.chipKeys) || containsPath(item.path, f.chips));
      if (!candidates.length) return [];
      const file = candidates[Math.floor(Math.random() * candidates.length)];
      return [{ tab: item.tab, relPath: file.relPath, name: file.name, content: file.content, content_cn: file.content_cn }];
    };

    const singleRandom = () => {
      const picked = pickRandomFromPool();
      if (!picked.length) return showToast('随机池为空，右键 tab 或 chip 加入随机池', 'warn');
      data.selected = picked;
    };

    const runGenerate = () => {
      const count = pref.genCount || 1;
      if (data.randomMode) {
        const lines = [];
        for (let i = 0; i < count; i++) {
          const picked = pickRandomFromPool();
          if (!picked.length) return showToast('持续模式已开，但随机池为空', 'warn');
          lines.push('#' + (i + 1) + ': ' + picked.map(s => s.content).join(', '));
        }
        return showToast('持续模式（' + count + ' 次随机结果）：' + lines.join(' ｜ '), 'info', 5000);
      }
      if (!data.selected.length) return showToast('还没选任何提示词', 'warn');
      if (!linkParams.bind) {
        return showToast('当前网页未绑定节点，请从画布节点「词库」按钮打开本页', 'warn', 4000);
      }
      const text = data.selected.map(s => s.content).join(', ');
      // 先把最新选词落盘，节点运行读 state 文件兜底；再通过 BroadcastChannel 广播运行指令。
      flushRemoteSave();
      ensureRunChannel();
      runChannel.postMessage({
        type: 'zhule:run',
        bindId: linkParams.bind,
        seq: ++runSeq,
        // 带 name（词条名）与 content（提示词文本）：节点 tags 输出与 SaveImage 提取都用 name
        items: data.selected.map(s => ({ name: s.name, content: s.content })),
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
          // 按「层级+父路径」隔离记录显示名顺序（本地），写回文件夹由「排序保存」统一完成
          const parentPath = chipParentPath(depth);
          chipOrder[data.activeTab] = { ...chipOrder[data.activeTab], [depth + '|' + parentPath]: ordered.map(dispKey) };
          showToast('分类顺序已调整，点击「排序保存」写回文件夹', 'info', 2200);
        }
      }
      chipDrag = { depth: -1, name: null, overName: null };
    };

    // ============ 手动「排序保存」：把当前完整数据顺序写回文件夹 ============
    const bankSaving = ref(false);

    // 从当前完整数据重建「父路径 -> 直接子项原始名」的有序映射：
    // 基底 = 后端层级深度优先顺序（卡片按 relPath 逐段排序），chipOrder（显示名）覆盖中间层顺序
    const buildBankOrder = () => {
      const order = {};
      const seen = new Set();
      const pushChild = (parent, child) => {
        const key = parent + '/' + child;
        if (seen.has(key)) return;
        seen.add(key);
        if (!order[parent]) order[parent] = [];
        order[parent].push(child);
      };
      // 顶层 tab：当前展示顺序
      tabs.value.forEach(t => pushChild('', t));
      tabs.value.forEach(tab => {
        const cards = bankData.value[tab] || [];
        cards.forEach(card => {
          // chip 中间层：chipKeys 每级是完整相对路径（tab/层1/层2...），父=去掉最后一段
          const keys = Array.isArray(card.chipKeys) ? card.chipKeys : [];
          keys.forEach(k => {
            const idx = k.lastIndexOf('/');
            if (idx > 0) pushChild(k.slice(0, idx), k.slice(idx + 1));
            else pushChild(tab, k);
          });
          // 卡片层：relPath 最后一段（目录原始名或 txt 文件名），父=去掉最后一段
          const rp = card.relPath || '';
          const idx = rp.lastIndexOf('/');
          if (idx >= 0) pushChild(rp.slice(0, idx), rp.slice(idx + 1));
        });
      });
      // 应用 chipOrder：对每个 tab 的每层，把对应父路径下的直接子项按显示名顺序重排
      tabs.value.forEach(tab => {
        const tOrder = chipOrder[tab] || {};
        Object.keys(tOrder).forEach(dStr => {
          const sep = dStr.indexOf('|');
          const d = parseInt(sep >= 0 ? dStr.slice(0, sep) : dStr, 10);
          const parentPath = sep >= 0 ? dStr.slice(sep + 1) : '';
          const names = tOrder[dStr];
          if (!Array.isArray(names) || !names.length) return;
          // 新格式：只重排指定父路径下的直接子项；旧格式（parentPath=''）整层全局应用
          let parents;
          if (sep >= 0 && parentPath) {
            parents = order[parentPath] ? [parentPath] : [];
          } else {
            parents = Object.keys(order).filter(p => (p === tab || p.startsWith(tab + '/')) && p.split('/').length === d + 1);
          }
          parents.forEach(p => {
            const items = order[p];
            if (!items || items.length < 2) return;
            const byDisp = new Map();
            items.forEach(raw => {
              const disp = dispKey(raw);
              if (!byDisp.has(disp)) byDisp.set(disp, []);
              byDisp.get(disp).push(raw);
            });
            const reordered = [];
            const used = new Set();
            names.forEach(disp => {
              (byDisp.get(disp) || []).forEach(raw => { if (!used.has(raw)) { reordered.push(raw); used.add(raw); } });
            });
            items.forEach(raw => { if (!used.has(raw)) { reordered.push(raw); used.add(raw); } });
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
          showToast('排序已保存：重命名 ' + (json.renamed || 0) + ' 项', 'success', 3000);
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
          const item = { tab: p.item.tab, relPath: p.item.relPath, name: p.item.name, content: p.item.content, content_cn: p.item.content_cn };
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
          const item = { tab: p.item.tab, relPath: p.item.relPath, name: p.item.name, content: p.item.content, content_cn: p.item.content_cn };
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
        tab: data.activeTab, relPath: file.relPath, name: file.name,
        content: file.content, content_cn: file.content_cn,
      });
    };

    // ============ 生命周期 ============
    watch([data, pref, chipsCollapsed, chipsHeight, selectedCollapsed, tabOrder, chipOrder], saveState, { deep: true });
    let clickBlocker;
    onMounted(() => {
      clickBlocker = (e) => {
        if (performance.now() < pDrag.suppressClickUntil) {
          e.preventDefault(); e.stopPropagation();
        }
      };
      document.addEventListener('click', clickBlocker, true);
      window.addEventListener('zhule-wordbank-pref', onWordbankPref);
      load();
    });
    onBeforeUnmount(() => {
      if (clickBlocker) document.removeEventListener('click', clickBlocker, true);
      window.removeEventListener('zhule-wordbank-pref', onWordbankPref);
      if (fullViewer) fullViewer.close();
      window.removeEventListener('paste', onUploadRefPaste);
      window.removeEventListener('dragover', preventDropDefault);
      window.removeEventListener('drop', preventDropDefault);
    });

    return {
      loaded, tabLoading, error, tabs, data, pref, drag, load,
      editTarget, editName, editContent, editContentCn, editIsTxt, editing,
      openEdit, cancelEdit, submitEdit,
      delConfirm, askDeleteWord, confirmDeleteWord,
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
      addChipOpen, addChipName, addChipDepth, addChipInput, addingChip, openAddChip, closeAddChip, submitAddChip,
      addCardOpen, addCardName, addCardContent, addCardContentCn, addCardInput, addingCard, openAddCard, closeAddCard, submitAddCard,
      setCardMode, toggleTranslate, changeColumns, changeCount, onCountInput, fixCount,
      prevImage, nextImage, randomImage, openModal, openFileDetail, goToGallery,
      viewer, closeViewer, viewerPrev, viewerNext, viewerRandom, zoomView, zoomCardImage,
      removeSelected, clearAll, toggleRandomMode, singleRandom, runGenerate,
      onTabDragStart, onTabDragOver, onTabDrop, onTabDragEnd,
      tabLabel,
      onChipDragStart, onChipDragOver, onChipDragEnd,
      dispKey, bankSaving, saveBankOrder,
      onCardPointerDown, onTagPointerDown, onSelListPointerDown,
      toast, toastIcon, dismissToast,
    };
  },
};
