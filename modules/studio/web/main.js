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
    return { showSettings, pref, TIME_FMTS, toggleField, setTimeFmt, setTagColor,
      wordbankAutoParent, toggleWordbankAutoParent };
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
        <button class="nav-gear" title="设置" @click="showSettings = true">
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
