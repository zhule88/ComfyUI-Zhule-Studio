import { createApp, ref } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import Wordbank from './pages/Wordbank.js';
import Gallery from './pages/Gallery.js';
import GalleryTopDown from './pages/GalleryTopDown.js';

const PREF_KEY = 'zhule_ui_pref';
const DEFAULT_PREF = {
  gallery: { showName: true, showTime: true, showModel: true, showTags: true, timeFmt: 'yyyy-MM-dd HH:mm',
    promptTagColor: '#2a9d8f', customTagColor: '#e07b39' },
  wordbank: { autoSelectParent: true },
};
const TIME_FMTS = ['yyyy-MM-dd HH:mm', 'yyyy-MM-dd', 'MM-dd HH:mm', 'MM-dd', 'HH:mm', 'yyyy/MM/dd'];

function loadPref() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    return {
      gallery: Object.assign({}, DEFAULT_PREF.gallery, (raw && raw.gallery) || {}),
      wordbank: Object.assign({}, DEFAULT_PREF.wordbank, (raw && raw.wordbank) || {}),
    };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_PREF));
  }
}

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/wordbank' },
    { path: '/wordbank', name: 'wordbank', component: Wordbank },
    { path: '/gallery', name: 'gallery', component: GalleryTopDown },
    { path: '/gallery-side', name: 'gallery-side', component: Gallery },
  ],
});

const App = {
  name: 'App',
  setup() {
    const showSettings = ref(false);
    const pref = ref(loadPref());
    function savePref() {
      localStorage.setItem(PREF_KEY, JSON.stringify(pref.value));
      window.dispatchEvent(new CustomEvent('zhule-pref-changed', { detail: pref.value }));
    }
    function toggleField(key) {
      pref.value.gallery[key] = !pref.value.gallery[key];
      savePref();
    }
    function setTimeFmt(fmt) {
      pref.value.gallery.timeFmt = fmt;
      savePref();
    }
    function setTagColor(kind, color) {
      pref.value.gallery[kind] = color;
      savePref();
    }
    // 词库单独配置：读取词库自身存档里的 autoSelectParent，并实时写入该存档
    const wordbankAutoParent = ref(readWordbankAutoParent());
    function readWordbankAutoParent() {
      try {
        const raw = JSON.parse(localStorage.getItem('zhule_wordbank_state_v2') || 'null');
        if (raw && raw.pref && typeof raw.pref.autoSelectParent === 'boolean') return raw.pref.autoSelectParent;
      } catch (e) { /* ignore */ }
      return true;
    }
    function toggleWordbankAutoParent() {
      const v = !wordbankAutoParent.value;
      wordbankAutoParent.value = v;
      try {
        const raw = JSON.parse(localStorage.getItem('zhule_wordbank_state_v2') || 'null') || {};
        if (!raw.pref || typeof raw.pref !== 'object') raw.pref = {};
        raw.pref.autoSelectParent = v;
        localStorage.setItem('zhule_wordbank_state_v2', JSON.stringify(raw));
      } catch (e) { /* ignore */ }
      window.dispatchEvent(new CustomEvent('zhule-wordbank-pref', { detail: { autoSelectParent: v } }));
    }
    // 数据库重建：仅设置页保留入口，正常使用不需要触发
    const rebuilding = ref(false);
    const rebuildNotice = ref('');
    function rebuildDB() {
      if (rebuilding.value) return;
      rebuilding.value = true;
      rebuildNotice.value = '正在重建索引，请耐心等待…';
      fetch('/zhule_studio/api/gallery/rescan', { method: 'POST' })
        .then((r) => r.json())
        .then((d) => {
          if (!d || d.ok === false) {
            rebuildNotice.value = '重建失败，请查看后端日志';
            rebuilding.value = false;
            return;
          }
          const timer = setInterval(() => {
            fetch('/zhule_studio/api/gallery/meta')
              .then((r) => r.json())
              .then((m) => {
                if (!m.building) {
                  clearInterval(timer);
                  rebuilding.value = false;
                  rebuildNotice.value = '图库已重建完成（' + (m.total != null ? m.total + ' 张' : '') + '）';
                  window.dispatchEvent(new CustomEvent('zhule-gallery-rebuilt'));
                  setTimeout(() => { rebuildNotice.value = ''; }, 6000);
                }
              })
              .catch(() => { /* 单次轮询失败忽略，下轮再试 */ });
          }, 2000);
        })
        .catch(() => {
          rebuildNotice.value = '重建失败：无法连接后端接口';
          rebuilding.value = false;
        });
    }
    // 词库去中文清理：扫描英文 prompt.txt，删除混入的中文字符（中文提示词文件跳过），仅设置面板保留入口
    const wordbankCleaningCn = ref(false);
    const wordbankCleanNotice = ref('');
    function wordbankCleanCn() {
      if (wordbankCleaningCn.value) return;
      wordbankCleaningCn.value = true;
      wordbankCleanNotice.value = '正在扫描英文提示词文件…';
      fetch('/zhule_studio/api/wordbank/clean-cn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
        .then(async (resp) => {
          const d = await resp.json();
          if (!resp.ok) {
            wordbankCleanNotice.value = (d && d.error) || '清理失败，请查看后端日志';
            return;
          }
          const s = (d && d.stats) || {};
          wordbankCleanNotice.value = '扫描 ' + (s.scanned || 0) + ' 个：清理 ' + (s.cleaned || 0)
            + '，中文文件跳过 ' + (s.chinese_files || 0) + '，无中文 ' + (s.no_cn || 0)
            + '，未变跳过 ' + (s.skipped_unchanged || 0);
          setTimeout(() => { wordbankCleanNotice.value = ''; }, 8000);
        })
        .catch(() => {
          wordbankCleanNotice.value = '清理失败：无法连接后端接口';
        })
        .finally(() => {
          wordbankCleaningCn.value = false;
        });
    }
    return { showSettings, pref, TIME_FMTS, toggleField, setTimeFmt, setTagColor,
      wordbankAutoParent, toggleWordbankAutoParent, rebuilding, rebuildNotice, rebuildDB,
      wordbankCleaningCn, wordbankCleanNotice, wordbankCleanCn };
  },
  computed: {
    bindQuery() {
      const b = this.$route.query.bind;
      return b ? { bind: b } : {};
    },
    galleryLink() {
      const p = ['/gallery', '/gallery-side'].includes(this.$route.path) ? this.$route.path : '/gallery';
      return { path: p, query: this.bindQuery };
    },
    isWordbank() {
      return this.$route.path === '/wordbank';
    },
    isGallery() {
      return ['/gallery', '/gallery-side'].includes(this.$route.path);
    },
  },
  template: `
    <div class="app">
      <div class="navbar">
        <span class="logo">Zhule Studio</span>
        <div class="nav-tabs">
          <router-link :to="{ path: '/wordbank', query: bindQuery }" class="nav-tab" active-class="active">词库</router-link>
          <router-link :to="galleryLink" class="nav-tab" active-class="active">图库</router-link>
        </div>
        <button class="nav-gear" data-tip="设置" @click="showSettings = true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
      </div>
      <router-view></router-view>

      <div class="settings-mask" v-if="showSettings" @click.self="showSettings = false">
        <div class="settings-panel">
          <div class="settings-head">
            <span class="settings-title">设置</span>
            <button class="settings-close" @click="showSettings = false">✕</button>
          </div>
          <div class="settings-body">
            <template v-if="isGallery">
              <div class="settings-group">
                <div class="settings-group-title">图库卡片显示字段</div>
                <div class="settings-row" v-for="opt in [
                  { key: 'showName', label: '文件名' },
                  { key: 'showTime', label: '时间' },
                  { key: 'showModel', label: '模型名' },
                  { key: 'showTags', label: '标签' }]" :key="opt.key">
                  <span class="settings-label">{{ opt.label }}</span>
                  <label class="settings-switch">
                    <input type="checkbox" :checked="pref.gallery[opt.key]" @change="toggleField(opt.key)">
                    <span class="settings-switch-slider"></span>
                  </label>
                </div>
              </div>
              <div class="settings-group">
                <div class="settings-group-title">图库筛选条件开关</div>
                <div class="settings-hint">关闭后对应筛选列在筛选面板中隐藏，已选条件仍生效。</div>
                <div class="settings-row" v-for="opt in [
                  { key: 'showModelFilter', label: '模型筛选列' },
                  { key: 'showLoraFilter', label: 'LoRA 筛选列' },
                  { key: 'showTagsFilter', label: '标签筛选列' }]" :key="opt.key">
                  <span class="settings-label">{{ opt.label }}</span>
                  <label class="settings-switch">
                    <input type="checkbox" :checked="pref.gallery[opt.key] !== false" @change="toggleField(opt.key)">
                    <span class="settings-switch-slider"></span>
                  </label>
                </div>
              </div>
              <div class="settings-group">
                <div class="settings-group-title">时间格式</div>
                <select class="settings-select" :value="pref.gallery.timeFmt" @change="setTimeFmt($event.target.value)">
                  <option v-for="f in TIME_FMTS" :key="f" :value="f">{{ f }}</option>
                </select>
              </div>
              <div class="settings-group">
                <div class="settings-group-title">标签高亮颜色</div>
                <div class="settings-row">
                  <span class="settings-label">提示词标签</span>
                  <input type="color" class="settings-color" :value="pref.gallery.promptTagColor"
                         @input="setTagColor('promptTagColor', $event.target.value)">
                </div>
                <div class="settings-row">
                  <span class="settings-label">自定义标签</span>
                  <input type="color" class="settings-color" :value="pref.gallery.customTagColor"
                         @input="setTagColor('customTagColor', $event.target.value)">
                </div>
                <div class="settings-hint">高亮色即时生效，仅作用于图库详情的只读标签（提示词 / 工作流来源）。</div>
              </div>
              <div class="settings-group">
                <div class="settings-group-title">数据库</div>
                <div class="settings-row">
                  <button class="settings-danger-btn" :disabled="rebuilding" @click="rebuildDB">重建图库</button>
                </div>
                <div class="settings-hint rebuild-hint" :data-tip="'仅在图片索引异常时才需要重建，例如新增图片未显示、信息过期或索引文件损坏。系统正常运行时会自动维护索引，正常情况请勿点击。重建需重新扫描全部图片元数据，耗时数分钟，期间图库列表暂时不可用。'">⚠️ 正常情况用不到，请勿随意点击。</div>
                <div class="settings-hint" v-if="rebuildNotice">{{ rebuildNotice }}</div>
              </div>
            </template>
            <template v-if="isWordbank">
              <div class="settings-group">
                <div class="settings-group-title">词库设置</div>
                <div class="settings-row">
                  <span class="settings-label">选中子类自动关联父类</span>
                  <label class="settings-switch">
                    <input type="checkbox" :checked="wordbankAutoParent" @change="toggleWordbankAutoParent">
                    <span class="settings-switch-slider"></span>
                  </label>
                </div>
                <div class="settings-hint">开启后，在词库点击某个子分类会自动把整条父链一并选中；本项仅对词库生效。</div>
                <div class="settings-row">
                  <span class="settings-label">去中文清理</span>
                  <button class="btn" :disabled="wordbankCleaningCn" @click="wordbankCleanCn">{{ wordbankCleaningCn ? '清理中…' : '开始清理' }}</button>
                </div>
                <div class="settings-hint">扫描英文 prompt.txt，删除混入的中文字符；中文提示词文件自动跳过。</div>
                <div class="settings-hint" v-if="wordbankCleanNotice">{{ wordbankCleanNotice }}</div>
              </div>
            </template>
            <div class="settings-none" v-if="!isGallery && !isWordbank">当前页面暂无设置项</div>
          </div>
        </div>
      </div>
    </div>
  `,
};

createApp(App).use(router).mount('#app');

// ===== 全局 tooltip：fixed 顶层气泡，替代 CSS 伪元素方案 =====
// 伪元素 ::after 的 z-index 只在自身 stacking context 内有效：若组件位于低层级上下文
// （侧栏/面板/遮罩等），气泡即使 z-index 极高也会被更高层组件盖住。
// 这里改为 body 下的 fixed 气泡，任何组件上悬停都浮在视口最顶层，永不被遮挡。
(function () {
  let tipEl = null;
  let tipTimer = null;
  let tipW = 0;
  let tipH = 0;
  function ensureTip() {
    if (tipEl) return tipEl;
    tipEl = document.createElement('div');
    tipEl.className = 'zh-global-tip';
    document.body.appendChild(tipEl);
    return tipEl;
  }
  function positionTip(cx, cy) {
    const el = ensureTip();
    const pad = 12;
    let left = cx + 14;
    let top = cy + 16;
    if (left + tipW > window.innerWidth - pad) left = cx - tipW - 14;
    if (top + tipH > window.innerHeight - pad) top = cy - tipH - 16;
    if (left < pad) left = pad;
    if (top < pad) top = pad;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }
  function showTip(text, cx, cy) {
    const el = ensureTip();
    el.textContent = text;
    el.style.display = 'block';
    const r = el.getBoundingClientRect();
    tipW = r.width;
    tipH = r.height;
    positionTip(cx, cy);
  }
  function hideTip() {
    if (tipTimer) { clearTimeout(tipTimer); tipTimer = null; }
    if (tipEl) tipEl.style.display = 'none';
  }
  document.addEventListener('mouseover', (e) => {
    const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    if (!t) return;
    const text = t.getAttribute('data-tip');
    if (!text) return;
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => showTip(text, e.clientX, e.clientY), 220);
  }, true);
  document.addEventListener('mousemove', (e) => {
    if (tipEl && tipEl.style.display === 'block') positionTip(e.clientX, e.clientY);
  }, true);
  document.addEventListener('mouseout', (e) => {
    if (e.target instanceof Element && e.target.closest('[data-tip]')) hideTip();
  }, true);
  document.addEventListener('scroll', hideTip, true);
  document.body.classList.add('zh-js-tip');
})();
