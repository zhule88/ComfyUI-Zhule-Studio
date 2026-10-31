import { createApp, ref, computed } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import Wordbank from './pages/Wordbank.js';
import Gallery from './pages/Gallery.js';
import GalleryTopDown from './pages/GalleryTopDown.js';

const PREF_KEY = 'zhule_ui_pref';
const DEFAULT_PREF = {
  gallery: { showName: true, showTime: true, showModel: true, showTags: true, timeFmt: 'yyyy-MM-dd HH:mm',
    tagTheme: 'light', tagRound: true,
    // 标签颜色种子：简单模式「全局异色」使用；所有标签颜色 = 该种子 + 标签名的确定性散列；改种子整套换色，同一标签恒定同色
    tagSeed: 'zhule',
    // 标签颜色配置（方案E）：level=simple 全局模式（所有标签一套规则）/ complex 分区模式（各区独立）
    // simple：globalMode=diff 全局异色（tagSeed 种子散列）/ same 全局同色（globalColor 统一色）
    // complex：areas 四区独立（detail 详情区 / filter 外部筛选区 / edit 编辑面板 / wordbank 词库分类）
    tagColor: {
      level: 'simple',
      globalMode: 'diff',
      globalColor: '#2a9d8f',
      areas: {
        detail: { mode: 'diff', color: '#2a9d8f', seed: '' },
        filter: { mode: 'diff', color: '#2a9d8f', seed: '' },
        edit: { mode: 'diff', color: '#2a9d8f', seed: '' },
        wordbank: { mode: 'diff', color: '#2a9d8f', seed: '' },
      },
    } },
  wordbank: { autoSelectParent: true },
  // 通用删除免确认：默认关闭；开启后图库/词库所有删除（图片、批量、标签、词条等）不再弹确认框
  // collapsedGroups：设置面板各大类的折叠状态（键为分组 key，值为 true 表示已收起），持久化保存
  common: { noDeleteConfirm: false, collapsedGroups: {} },
};
const TIME_FMTS = ['yyyy-MM-dd HH:mm', 'yyyy-MM-dd', 'MM-dd HH:mm', 'MM-dd', 'HH:mm', 'yyyy/MM/dd'];
// 标签颜色分区（方案E复杂模式）：四个区域独立配置
const TAG_COLOR_AREAS = [
  { key: 'detail', label: '详情区' },
  { key: 'filter', label: '筛选区' },
  { key: 'edit', label: '编辑面板' },
  { key: 'wordbank', label: '词库分类' },
];
// 标签主题（参考 Element Plus Tag 的 effect）：dark 深色实底 / light 浅色柔和底 / plain 描边透明底
const TAG_THEMES = [
  { key: 'dark', label: '深色' },
  { key: 'light', label: '浅色' },
  { key: 'plain', label: '描边' },
];

// 演示块颜色：与图库/词库同一 FNV-1a 散列算法（种子 + 固定名 'demo'），
// 随机颜色种子变化时，设置面板的主题/边角演示块联动换色，所见即所得
function seedColor(seed) {
  const s = String(seed || '') + '|demo';
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h >>>= 0;
  return 'hsl(' + (h % 360) + ', ' + (60 + (h % 4) * 6) + '%, ' + (38 + (h % 3) * 5) + '%)';
}

// 标签颜色配置归一化：兼容旧版存档（无 tagColor 字段）与残缺数据，保证四区字段齐全
function normalizeTagColor(tc) {
  const base = JSON.parse(JSON.stringify(DEFAULT_PREF.gallery.tagColor));
  if (!tc || typeof tc !== 'object') return base;
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
}

function loadPref() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    const g = Object.assign({}, DEFAULT_PREF.gallery, (raw && raw.gallery) || {});
    g.tagColor = normalizeTagColor(raw && raw.gallery && raw.gallery.tagColor);
    return {
      gallery: g,
      wordbank: Object.assign({}, DEFAULT_PREF.wordbank, (raw && raw.wordbank) || {}),
      common: Object.assign({}, DEFAULT_PREF.common, (raw && raw.common) || {}),
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
    function setTagTheme(theme) {
      pref.value.gallery.tagTheme = theme;
      savePref();
    }
    function setTagRound(round) {
      pref.value.gallery.tagRound = round;
      savePref();
    }
    function toggleNoDeleteConfirm() {
      pref.value.common.noDeleteConfirm = pref.value.common.noDeleteConfirm === false;
      savePref();
    }
    function setTagSeed(seed) {
      pref.value.gallery.tagSeed = (seed || '').trim();
      savePref();
    }
    // 标签颜色：仅简单模式「全局异色」使用随机种子
    function randomTagSeed() {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let s = '';
      for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
      pref.value.gallery.tagSeed = s;
      savePref();
      return s;
    }
    // 方案E 标签颜色弹窗：开关、模式切换、取色与种子编辑统一入口
    const colorPopupOpen = ref(false);
    const colorPopupArea = ref('detail');
    function colorPopupOpenFor(areaKey) {
      colorPopupArea.value = areaKey;
      colorPopupOpen.value = true;
    }
    function setTagColorLevel(level) {
      pref.value.gallery.tagColor.level = level;
      savePref();
    }
    function setGlobalTagColorMode(mode) {
      pref.value.gallery.tagColor.globalMode = mode;
      savePref();
    }
    function setGlobalTagColor(color) {
      pref.value.gallery.tagColor.globalColor = color;
      savePref();
    }
    function setAreaTagColorMode(mode) {
      pref.value.gallery.tagColor.areas[colorPopupArea.value].mode = mode;
      savePref();
    }
    function setAreaTagColor(color) {
      pref.value.gallery.tagColor.areas[colorPopupArea.value].color = color;
      savePref();
    }
    function setAreaTagSeed(seed) {
      pref.value.gallery.tagColor.areas[colorPopupArea.value].seed = (seed || '').trim();
      savePref();
    }
    // 分区异色种子：一键随机刷新（替代原清空式「重置」）
    function randomAreaSeed() {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let s = '';
      for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
      pref.value.gallery.tagColor.areas[colorPopupArea.value].seed = s;
      savePref();
      return s;
    }
    function randomHexColor() {
      const chars = '0123456789abcdef';
      let s = '#';
      for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return s;
    }
    // 方案E 弹窗「随机换色」：全局同色 / 分区同色各一键随机
    function randomGlobalColor() {
      pref.value.gallery.tagColor.globalColor = randomHexColor();
      savePref();
    }
    function randomAreaColor() {
      pref.value.gallery.tagColor.areas[colorPopupArea.value].color = randomHexColor();
      savePref();
    }
    // 设置面板大类折叠：状态写入 common.collapsedGroups，随 pref 持久化并广播
    function isCollapsed(key) {
      const c = pref.value.common.collapsedGroups;
      return !!(c && c[key]);
    }
    function toggleCollapse(key) {
      const c = pref.value.common.collapsedGroups || {};
      c[key] = !isCollapsed(key);
      pref.value.common.collapsedGroups = c;
      savePref();
    }
    // 词库单独配置：读取词库自身存档里的 autoSelectParent，并实时写入该存档
    // 优先读写独立 pref key（zhule_wordbank_pref_v1），与词库组件的整包 state 解耦，
    // 避免设置页读-改-写整包与 Wordbank.js 深度 watch saveState 互相覆盖（写竞态）。
    const wordbankAutoParent = ref(readWordbankAutoParent());
    function readWordbankAutoParent() {
      try {
        const p = JSON.parse(localStorage.getItem('zhule_wordbank_pref_v1') || 'null');
        if (p && typeof p.autoSelectParent === 'boolean') return p.autoSelectParent;
      } catch (e) { /* ignore */ }
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
        const p = JSON.parse(localStorage.getItem('zhule_wordbank_pref_v1') || 'null') || {};
        p.autoSelectParent = v;
        localStorage.setItem('zhule_wordbank_pref_v1', JSON.stringify(p));
      } catch (e) { console.warn('zhule: 设置页写词库偏好失败:', e); }
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
    return { showSettings, pref, TIME_FMTS, TAG_THEMES, TAG_COLOR_AREAS, toggleField, setTimeFmt, setTagTheme, setTagRound,
      toggleNoDeleteConfirm, setTagSeed, randomTagSeed, isCollapsed, toggleCollapse,
      colorPopupOpen, colorPopupArea, colorPopupOpenFor, setTagColorLevel, setGlobalTagColorMode, setGlobalTagColor,
      setAreaTagColorMode, setAreaTagColor, setAreaTagSeed, randomHexColor, randomGlobalColor, randomAreaColor,
      wordbankAutoParent, toggleWordbankAutoParent, rebuilding, rebuildNotice, rebuildDB,
      wordbankCleaningCn, wordbankCleanNotice, wordbankCleanCn };
  },
  computed: {
    // 演示块颜色：随机颜色种子联动，主题/边角演示块随种子换色
    demoTagBg() {
      return seedColor(this.pref.gallery.tagSeed);
    },
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
            <!-- 通用设置：对所有页面生效 -->
            <div class="settings-group" :class="{ 'collapsed': isCollapsed('common') }">
              <div class="settings-group-title" @click="toggleCollapse('common')">
                <span>通用设置</span>
                <svg class="settings-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
              </div>
              <div class="settings-group-body" v-show="!isCollapsed('common')">
                <div class="settings-row">
                  <span class="settings-label">删除时弹出确认框</span>
                  <button class="settings-text-toggle" :class="{ on: pref.common.noDeleteConfirm !== true }" @click="toggleNoDeleteConfirm">{{ pref.common.noDeleteConfirm !== true ? '开启' : '关闭' }}</button>
                </div>
                <div class="settings-subgroup-title"><span>标签</span></div>
                <div class="settings-row">
                  <span class="settings-label">主题</span>
                  <div class="settings-theme-pick">
                    <button v-for="th in TAG_THEMES" :key="th.key"
                            class="zhg-tag hl-prompt demo-tag"
                            :class="['zhg-tag-theme-' + th.key, (pref.gallery.tagRound === false ? 'zhg-tag-square' : ''), { 'demo-on': (pref.gallery.tagTheme || 'light') === th.key }]"
                            :style="{ '--tag-bg': demoTagBg }"
                            @click="setTagTheme(th.key)">{{ th.label }}</button>
                  </div>
                </div>
                <div class="settings-row">
                  <span class="settings-label">边角</span>
                  <div class="settings-theme-pick">
                    <button class="zhg-tag hl-prompt demo-tag"
                            :class="['zhg-tag-theme-' + (pref.gallery.tagTheme || 'light'), { 'demo-on': pref.gallery.tagRound !== false }]"
                            :style="{ '--tag-bg': demoTagBg }"
                            @click="setTagRound(true)">圆角</button>
                    <button class="zhg-tag hl-prompt demo-tag"
                            :class="['zhg-tag-theme-' + (pref.gallery.tagTheme || 'light'), 'zhg-tag-square', { 'demo-on': pref.gallery.tagRound === false }]"
                            :style="{ '--tag-bg': demoTagBg }"
                            @click="setTagRound(false)">方角</button>
                  </div>
                </div>
                <div class="settings-row">
                  <span class="settings-label">标签颜色</span>
                  <span class="settings-seed-box">
                    <button class="settings-seed-rnd" data-tip="设置标签颜色方案" @click="colorPopupOpenFor('detail')">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"></circle><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"></circle><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"></circle><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"></circle><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"></path></svg>
                    </button>
                  </span>
                </div>
              </div>
            </div>
            <template v-if="isGallery">
              <div class="settings-group" :class="{ 'collapsed': isCollapsed('gallery-fields') }">
                <div class="settings-group-title" @click="toggleCollapse('gallery-fields')">
                  <span>图库卡片显示字段</span>
                  <svg class="settings-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </div>
                <div class="settings-group-body" v-show="!isCollapsed('gallery-fields')">
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
              </div>
              <div class="settings-group" :class="{ 'collapsed': isCollapsed('gallery-filters') }">
                <div class="settings-group-title" @click="toggleCollapse('gallery-filters')">
                  <span>图库筛选条件开关</span>
                  <svg class="settings-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </div>
                <div class="settings-group-body" v-show="!isCollapsed('gallery-filters')">
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
              </div>
              <div class="settings-group" :class="{ 'collapsed': isCollapsed('gallery-timefmt') }">
                <div class="settings-group-title" @click="toggleCollapse('gallery-timefmt')">
                  <span>时间格式</span>
                  <svg class="settings-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </div>
                <div class="settings-group-body" v-show="!isCollapsed('gallery-timefmt')">
                <select class="settings-select" :value="pref.gallery.timeFmt" @change="setTimeFmt($event.target.value)">
                  <option v-for="f in TIME_FMTS" :key="f" :value="f">{{ f }}</option>
                </select>
                </div>
              </div>
              <div class="settings-group" :class="{ 'collapsed': isCollapsed('gallery-db') }">
                <div class="settings-group-title" @click="toggleCollapse('gallery-db')">
                  <span>数据库</span>
                  <svg class="settings-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </div>
                <div class="settings-group-body" v-show="!isCollapsed('gallery-db')">
                <div class="settings-row">
                  <button class="settings-danger-btn" :disabled="rebuilding" @click="rebuildDB">重建图库</button>
                </div>
                <div class="settings-hint rebuild-hint" :data-tip="'仅在图片索引异常时才需要重建，例如新增图片未显示、信息过期或索引文件损坏。系统正常运行时会自动维护索引，正常情况请勿点击。重建需重新扫描全部图片元数据，耗时数分钟，期间图库列表暂时不可用。'">⚠️ 正常情况用不到，请勿随意点击。</div>
                <div class="settings-hint" v-if="rebuildNotice">{{ rebuildNotice }}</div>
                </div>
              </div>
            </template>
            <template v-if="isWordbank">
              <div class="settings-group" :class="{ 'collapsed': isCollapsed('wordbank-main') }">
                <div class="settings-group-title" @click="toggleCollapse('wordbank-main')">
                  <span>词库设置</span>
                  <svg class="settings-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </div>
                <div class="settings-group-body" v-show="!isCollapsed('wordbank-main')">
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
              </div>
            </template>
            <div class="settings-none" v-if="!isGallery && !isWordbank">当前页面暂无设置项</div>
          </div>
        </div>
      </div>

      <!-- 标签颜色设置弹窗（方案E）：层级切换 + 模式/取色/种子 -->
      <div class="color-popup-mask" v-if="colorPopupOpen" @click.self="colorPopupOpen = false">
        <div class="color-popup">
          <div class="color-popup-head">
            <span class="color-popup-title">标签颜色</span>
            <button class="color-popup-close" @click="colorPopupOpen = false">✕</button>
          </div>
          <div class="color-popup-body">
            <div class="color-popup-seg">
              <button class="color-popup-seg-btn" :class="{ on: pref.gallery.tagColor.level === 'simple' }" @click="setTagColorLevel('simple')">全局</button>
              <button class="color-popup-seg-btn" :class="{ on: pref.gallery.tagColor.level === 'complex' }" @click="setTagColorLevel('complex')">分区</button>
            </div>
            <div class="color-popup-level-hint">全局：所有标签统一按下方规则配色；分区：详情区/编辑区/词库/过滤区各自独立配色。</div>
            <template v-if="pref.gallery.tagColor.level === 'simple'">
              <div class="color-popup-row">
                <span class="color-popup-label">模式</span>
                <div class="color-popup-seg">
                  <button class="color-popup-seg-btn" :class="{ on: pref.gallery.tagColor.globalMode === 'diff' }" @click="setGlobalTagColorMode('diff')">异色</button>
                  <button class="color-popup-seg-btn" :class="{ on: pref.gallery.tagColor.globalMode === 'same' }" @click="setGlobalTagColorMode('same')">同色</button>
                </div>
              </div>
              <div class="color-popup-row" v-if="pref.gallery.tagColor.globalMode === 'same'">
                <span class="color-popup-label">颜色</span>
                <div class="color-popup-pick">
                  <label class="color-popup-swatch" data-tip="点击取色" :style="{ '--swatch': pref.gallery.tagColor.globalColor }">
                    <input type="color" class="color-popup-input" :value="pref.gallery.tagColor.globalColor"
                           @input="setGlobalTagColor($event.target.value)" />
                  </label>
                  <button class="color-popup-rnd" data-tip="随机换色" @click="randomGlobalColor()">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                  </button>
                </div>
              </div>
              <div class="color-popup-row" v-if="pref.gallery.tagColor.globalMode === 'diff'">
                <span class="color-popup-label">种子</span>
                <div class="color-popup-pick">
                  <input class="settings-seed-input" :value="pref.gallery.tagSeed" @change="setTagSeed($event.target.value)" spellcheck="false" />
                  <button class="color-popup-btn" @click="randomTagSeed()">随机</button>
                </div>
              </div>
              <div class="color-popup-hint">异色：按种子给每个标签散列稳定颜色，换种子整套换色；同色：全部标签统一一色，点色块取色或点刷新随机换色。</div>
            </template>
            <template v-else>
              <div class="color-popup-seg color-popup-area-seg">
                <button v-for="a in TAG_COLOR_AREAS" :key="a.key"
                        class="color-popup-seg-btn" :class="{ on: colorPopupArea === a.key }"
                        @click="colorPopupArea = a.key">{{ a.label }}</button>
              </div>
              <div class="color-popup-row">
                <span class="color-popup-label">模式</span>
                <div class="color-popup-seg">
                  <button class="color-popup-seg-btn" :class="{ on: pref.gallery.tagColor.areas[colorPopupArea].mode === 'diff' }" @click="setAreaTagColorMode('diff')">异色</button>
                  <button class="color-popup-seg-btn" :class="{ on: pref.gallery.tagColor.areas[colorPopupArea].mode === 'same' }" @click="setAreaTagColorMode('same')">同色</button>
                </div>
              </div>
              <div class="color-popup-row" v-if="pref.gallery.tagColor.areas[colorPopupArea].mode === 'same'">
                <span class="color-popup-label">颜色</span>
                <div class="color-popup-pick">
                  <label class="color-popup-swatch" data-tip="点击取色" :style="{ '--swatch': pref.gallery.tagColor.areas[colorPopupArea].color }">
                    <input type="color" class="color-popup-input" :value="pref.gallery.tagColor.areas[colorPopupArea].color"
                           @input="setAreaTagColor($event.target.value)" />
                  </label>
                  <button class="color-popup-rnd" data-tip="随机换色" @click="randomAreaColor()">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                  </button>
                </div>
              </div>
              <div class="color-popup-row" v-if="pref.gallery.tagColor.areas[colorPopupArea].mode === 'diff'">
                <span class="color-popup-label">种子</span>
                <div class="color-popup-pick">
                  <input class="settings-seed-input" :value="pref.gallery.tagColor.areas[colorPopupArea].seed" @change="setAreaTagSeed($event.target.value)" spellcheck="false" />
                  <button class="color-popup-rnd" data-tip="随机刷新种子" @click="randomAreaSeed()">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
                  </button>
                </div>
              </div>
              <div class="color-popup-hint">四个区域分别配色，每区可选「异色（按种子散列）/ 同色（统一一色）」；区域种子留空时沿用全局种子。</div>
            </template>
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
