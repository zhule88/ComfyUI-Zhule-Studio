import { createApp, ref, computed, watch, onBeforeUnmount } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import Wordbank from './pages/Wordbank.js';
import Gallery from './pages/Gallery.js';
import GalleryTopDown from './pages/GalleryTopDown.js';
// 分层弹框与图库页共用同一份组件 + 时间格式预设，设置页调用时视觉与图库完全一致
import { LinkDialog, LINK_TIME_PRESETS, linkTimeName, normalizeTree, fmtTime } from './pages/galleryCommon.js';

const PREF_KEY = 'zhule_ui_pref';
const DEFAULT_PREF = {
  gallery: { showName: true, showTime: true, showModel: true, showTags: true, timeFmt: 'yyyy-MM-dd HH:mm',
    // 外部过滤区与标签编辑面板标签右侧的关联图数角标（图片详情不显示），默认开启，可在设置里关掉
    showTagCount: true,
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
    },
    // 链接相关：图库工具栏下载按钮（硬链接快捷导出）的目标目录与子文件夹命名方式
    // dir：文件链接地址，留空 = output/zhule_studio/zhule_link；只接受绝对路径（D:\xxx 或 \\nas\share）
    // nameMode：time 按时间（时间戳子文件夹）/ tags 按过滤标签（启用的标签用 sep 连成一段，如 凌乱发@璃月）
    //           / custom 自定义分层（多层目录，模板见 custom）
    // timeFmt：按时间命名时的目录名格式（预设键，见 LINK_TIME_PRESETS）
    // sep：按过滤标签命名时标签之间的隔离符号
    // custom：自定义分层模板，元素 { type: 'text' | 'tag', value: '凌乱发', rel, cat }，
    //         数组顺序即目录层级；cat=true 表示整类分类层（目录名就是分类名，不随启用标签变化）
    // hideGear：隐藏图库页「自定义分层」呼出齿轮，别人用图库时不会看到这个入口
    link: { dir: '', nameMode: 'time', timeFmt: 'ymd_hms', sep: '@', custom: [], hideGear: false },
  },
  wordbank: { autoSelectParent: true },
  // 通用删除免确认：默认关闭；开启后图库/词库所有删除（图片、批量、标签、词条等）不再弹确认框
  // iconSize：图库/词库卡片「图片左上竖排图标」的尺寸（按钮边长 px），写入 :root 的 --zh-act-size 供 CSS 取用
  // hideMuted：默认关闭；开启后被静音（mute=1）的提示词在词库卡片与标签编辑面板中隐藏不展示
  // hideCardIcons：默认关闭；开启后词库卡片不再渲染操作图标（进入详情/放大/删除图/静音/删除/编辑/上传），
  //   全部改由右键菜单承担；卡片上的左右切换与骰子属于高频操作，始终保留
  // hideHints：默认关闭；开启后设置面板里所有解释性说明行（.settings-hint）全部隐藏，只留设置项本身
  // panelWidth：设置面板宽度（百分比，相对窗口总宽，上限 80）；左右两侧握把均可拖动调宽（高度仍按内容自适应），拖完宽度持久化
  // collapsedGroups：设置面板各大类的折叠状态（键为分组 key，值为 true 表示已收起），持久化保存
  common: { noDeleteConfirm: false, iconSize: 26, hideMuted: false, hideCardIcons: false,
    hideHints: false, panelWidth: 30, collapsedGroups: {} },
};
const TIME_FMTS = ['yyyy-MM-dd HH:mm', 'yyyy-MM-dd', 'MM-dd HH:mm', 'MM-dd', 'HH:mm', 'yyyy/MM/dd'];
// 卡片图标尺寸档位：图片左上竖排操作图标（选择/放大/删除/静音/编辑/上传）的按钮边长（px），
// 统一写入 :root 的 --zh-act-size，CSS 按 0.54 比例换算内部 SVG 大小；档位外的手工值按 MIN/MAX 夹取
const ICON_SIZES = [
  { size: 22, label: '小' },
  { size: 26, label: '中' },
  { size: 32, label: '大' },
  { size: 38, label: '特大' },
];
const ICON_SIZE_MIN = 18;
const ICON_SIZE_MAX = 48;
// 设置面板宽度档位：单位为「占窗口总宽的百分比」，左右握把拖动时按 MIN/MAX 夹取，上限 80%，宽度仅调宽不调高
const PANEL_PCT_MIN = 22;
const PANEL_PCT_MAX = 80;
// 标签颜色分区（方案E复杂模式）：四个区域独立配置
const TAG_COLOR_AREAS = [
  { key: 'detail', label: '图片详情' },
  { key: 'filter', label: '筛选区域' },
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

// 链接相关配置归一化：兼容旧存档（无 link 字段）与残缺数据，
// dir 只保留字符串、nameMode 非法回落 time、timeFmt 非法回落 ymd_hms、
// sep 空则用 @、custom 必须是数组、hideGear 只认 true
function normalizeLink(lk) {
  const out = Object.assign({}, DEFAULT_PREF.gallery.link, (lk && typeof lk === 'object') ? lk : {});
  if (typeof out.dir !== 'string') out.dir = '';
  if (!['time', 'tags', 'custom'].includes(out.nameMode)) out.nameMode = 'time';
  if (!LINK_TIME_PRESETS.some((p) => p.key === out.timeFmt)) out.timeFmt = 'ymd_hms';
  if (typeof out.sep !== 'string' || !out.sep) out.sep = '@';
  if (!Array.isArray(out.custom)) out.custom = [];
  out.hideGear = out.hideGear === true;
  return out;
}

// 读图库外部过滤区当前「启用」的标签名（与图库页共用同一份 localStorage 存档）。
// 设置页要用它判断自定义分层里哪一层标签已经失效（在库里但现在没启用）。
function readGalleryActiveTags() {
  try {
    const raw = JSON.parse(localStorage.getItem('zhule_gallery_tags') || 'null');
    const list = (raw && Array.isArray(raw.tags)) ? raw.tags : [];
    const out = [];
    for (const t of list) {
      if (!t || typeof t.name !== 'string' || !t.name.trim()) continue;
      if (t.active === true && !t.hidden && out.indexOf(t.name) < 0) out.push(t.name);
    }
    return out;
  } catch (e) { return []; }
}

function loadPref() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    const g = Object.assign({}, DEFAULT_PREF.gallery, (raw && raw.gallery) || {});
    g.tagColor = normalizeTagColor(raw && raw.gallery && raw.gallery.tagColor);
    g.link = normalizeLink(raw && raw.gallery && raw.gallery.link);
    const c = Object.assign({}, DEFAULT_PREF.common, (raw && raw.common) || {});
    // 图标尺寸兜底：旧存档无该字段或数值非法时回落默认 26px，越界按 MIN/MAX 夹取
    const sz = Number(c.iconSize);
    c.iconSize = Number.isFinite(sz) && sz > 0
      ? Math.min(ICON_SIZE_MAX, Math.max(ICON_SIZE_MIN, Math.round(sz)))
      : DEFAULT_PREF.common.iconSize;
    c.hideMuted = c.hideMuted === true;
    c.hideCardIcons = c.hideCardIcons === true;
    c.hideHints = c.hideHints === true;
    // 面板宽度兜底：单位为百分比。旧存档存的是 px（>100 视为旧值），按当时窗口宽换算成百分比后再夹取
    const rawPw = Number(c.panelWidth);
    let pct = Number.isFinite(rawPw) && rawPw > 0 ? rawPw : DEFAULT_PREF.common.panelWidth;
    if (pct > PANEL_PCT_MAX) pct = (pct / (window.innerWidth || 1280)) * 100;
    c.panelWidth = Math.round(Math.min(PANEL_PCT_MAX, Math.max(PANEL_PCT_MIN, pct)) * 10) / 10;
    return {
      gallery: g,
      wordbank: Object.assign({}, DEFAULT_PREF.wordbank, (raw && raw.wordbank) || {}),
      common: c,
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
  // 设置页的「自定义分层」弹框直接复用图库那份组件（视觉/交互/拖拽全部一致）
  components: {ZhgLinkDialog: LinkDialog},
  setup() {
    const showSettings = ref(false);
    const pref = ref(loadPref());
    // 设置页里的「自定义分层」弹框：与图库复用同一组件，故这里也备一份树与标签集合
    const linkDlgOpen = ref(false);
    const linkTree = ref([]);
    const linkActiveTags = ref([]);
    function savePref() {
      localStorage.setItem(PREF_KEY, JSON.stringify(pref.value));
      window.dispatchEvent(new CustomEvent('zhule-pref-changed', { detail: pref.value }));
    }
    // 图库里的齿轮弹框保存导出配置时也会写盘并广播，这里跟着刷新，避免设置页显示的是旧值
    window.addEventListener('zhule-pref-changed', (e) => {
      if (e && e.detail) pref.value = JSON.parse(JSON.stringify(e.detail));
    });
    function toggleField(key) {
      pref.value.gallery[key] = !pref.value.gallery[key];
      savePref();
    }
    // 点一下展开的选择器：同一时刻只开一个（'linkTime' / 'galleryTime'），点别处或选中即收起
    const pickOpen = ref('');
    function togglePick(key) {
      pickOpen.value = pickOpen.value === key ? '' : key;
    }
    function closePick() {
      pickOpen.value = '';
    }
    function setTimeFmt(fmt) {
      pref.value.gallery.timeFmt = fmt;
      pickOpen.value = '';
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
    // 文件链接地址：留空 = 默认 output/zhule_studio/zhule_link；非绝对路径当场提示并保留原值，
    // 真正的路径合法性（系统目录、磁盘根）由后端 _resolve_link_root 兜底校验
    function setLinkDir(v) {
      const s = String(v == null ? '' : v).trim();
      if (s && !/^[A-Za-z]:[\\/]/.test(s) && !s.startsWith('\\\\')) {
        window.alert('请填写绝对路径，例如 D:\\zhule_link 或 \\\\nas\\share\\link；留空则使用默认目录。');
        return;
      }
      pref.value.gallery.link.dir = s;
      savePref();
    }
    function setLinkNameMode(mode) {
      if (!['time', 'tags', 'custom'].includes(mode)) return;
      pref.value.gallery.link.nameMode = mode;
      savePref();
    }
    // 按时间命名的时间格式：切换后同一设置页里的样例即时跟着变
    function setLinkTimeFmt(key) {
      if (!LINK_TIME_PRESETS.some((p) => p.key === key)) return;
      pref.value.gallery.link.timeFmt = key;
      pickOpen.value = '';
      savePref();
    }
    // 标签隔离符号：最多 2 个字符，清空回落 @
    function setLinkSep(v) {
      pref.value.gallery.link.sep = String(v == null ? '' : v).trim().slice(0, 2) || '@';
      savePref();
    }
    // 图库页齿轮开关：关掉 = 图库工具栏不再出现自定义分层入口（存档里记 hideGear）
    function toggleHideLinkGear() {
      pref.value.gallery.link.hideGear = pref.value.gallery.link.hideGear !== true;
      savePref();
    }
    // 设置页里「自定义分层」的编辑入口：直接复用图库那套弹框组件，
    // 只改分层模板本身（目录与隔离符号是上面两项各自的设置，不由弹框回写）
    function openLinkDlg() {
      // 每次打开都重新读一次启用标签：图库那边刚改过也能反映到失效判定里
      linkActiveTags.value = readGalleryActiveTags();
      linkDlgOpen.value = true;
      if (!linkTree.value.length) loadLinkTree();
    }
    function closeLinkDlg() { linkDlgOpen.value = false; }
    // 标签树：设置页独立于图库页，自己拉一份（与图库同接口，结构瘦身规则也共用）
    async function loadLinkTree() {
      try {
        const r = await fetch('/zhule_studio/api/gallery/tagtree', { headers: { 'Cache-Control': 'no-cache' } });
        const d = await r.json();
        if (d && d.ok) linkTree.value = normalizeTree(d.tree);
      } catch (e) { linkTree.value = []; }
    }
    function onLinkDlgSaved(cfg) {
      pref.value.gallery.link.custom = Array.isArray(cfg && cfg.custom) ? cfg.custom : [];
      // 在设置页保存分层，就意味着想用自定义分层，顺手把模式切过去
      pref.value.gallery.link.nameMode = 'custom';
      savePref();
    }
    // 全库标签名（把树拍平）：只用于区分「标签被停用」和「手填的固定目录名」
    const linkKnownTags = computed(() => {
      const out = [];
      (function walk(ns) {
        for (const n of ns || []) {
          if (n && n.name && out.indexOf(n.name) < 0) out.push(n.name);
          if (n && n.children && n.children.length) walk(n.children);
        }
      })(linkTree.value);
      return out;
    });
    // 已配置的层数（只数有内容的层，空层保存时本来就会丢）
    const linkLayerCount = computed(() => (pref.value.gallery.link.custom || [])
      .filter((it) => it && String(it.value || '').trim()).length);
    // 时间格式样例：切换格式后当场能看到这次的目录长什么样
    const linkTimeSample = computed(() => linkTimeName(pref.value.gallery.link.timeFmt, new Date()));
    // 触发按钮上显示的当前预设（样例串 + 说明），点开才看到全部预设
    // 每个格式给一条真实样例（fmtTime 吃的是秒级时间戳）
    function timeFmtSample(f) {
      return fmtTime(Math.floor(Date.now() / 1000), f);
    }
    const linkTimePresetLabel = computed(() => {
      const hit = LINK_TIME_PRESETS.find((p) => p.key === pref.value.gallery.link.timeFmt);
      return hit ? hit.label : pref.value.gallery.link.timeFmt;
    });
    // 图片上的图标大小：写 :root 的 --zh-act-size，图库/词库卡片操作图标即时跟随（无需刷新页面）
    function applyIconSize(px) {
      const raw = Number(px);
      const n = Math.min(ICON_SIZE_MAX, Math.max(ICON_SIZE_MIN,
        Math.round(Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PREF.common.iconSize)));
      document.documentElement.style.setProperty('--zh-act-size', n + 'px');
      return n;
    }
    function setIconSize(px) {
      pref.value.common.iconSize = applyIconSize(px);
      savePref();
    }
    // 静音提示词隐藏：开启后词库卡片列表与标签编辑面板都不再展示 mute=1 的词条
    function toggleHideMuted() {
      pref.value.common.hideMuted = pref.value.common.hideMuted !== true;
      savePref();
    }
    // 隐藏卡片上的图标：开启后词库卡片只剩左右切换 + 骰子，其余操作全部走右键菜单
    function toggleHideCardIcons() {
      pref.value.common.hideCardIcons = pref.value.common.hideCardIcons !== true;
      savePref();
    }
    // 隐藏设置注释：开启后设置面板内所有解释性说明行不再展示，只留设置项本身
    function toggleHideHints() {
      pref.value.common.hideHints = pref.value.common.hideHints !== true;
      savePref();
    }
    // 设置面板宽度：左右握把拖动调宽（高度仍由内容自适应），松手写盘持久化
    // 数值含义为「占窗口总宽的百分比」，窗口缩放时面板随之等比变化，最大 80%
    const panelWidth = ref(pref.value.common.panelWidth);
    function applyPanelWidth(pct) {
      const v = Number(pct);
      const n = Math.min(PANEL_PCT_MAX, Math.max(PANEL_PCT_MIN, Number.isFinite(v) ? v : DEFAULT_PREF.common.panelWidth));
      panelWidth.value = Math.round(n * 10) / 10;
      return panelWidth.value;
    }
    let resizing = false;
    let resizeStartX = 0;
    let resizeStartW = 0;
    // dir=1 拖右缘（往右变宽）；dir=-1 拖左缘（往右变窄）。两条边整高都是热区。
    let resizeDir = 1;
    function onPanelResizeMove(e) {
      if (!resizing) return;
      // 面板在遮罩里水平居中：单侧边缘的位移只有宽度增量的一半，故按 2 倍让握把跟手；
      // 位移 px 换算成「占窗口宽百分比」后再叠加
      const dPct = ((e.clientX - resizeStartX) * 2 * resizeDir * 100) / (window.innerWidth || 1280);
      applyPanelWidth(resizeStartW + dPct);
    }
    function onPanelResizeUp() {
      if (!resizing) return;
      resizing = false;
      document.removeEventListener('mousemove', onPanelResizeMove);
      document.removeEventListener('mouseup', onPanelResizeUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      pref.value.common.panelWidth = panelWidth.value;
      savePref();
    }
    function startPanelResize(e, dir) {
      resizing = true;
      resizeDir = Number(dir) < 0 ? -1 : 1;
      resizeStartX = e.clientX;
      resizeStartW = panelWidth.value;
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
      document.addEventListener('mousemove', onPanelResizeMove);
      document.addEventListener('mouseup', onPanelResizeUp);
    }
    // 组件卸载时解绑，避免拖动中途切路由留下全局监听
    onBeforeUnmount(() => {
      document.removeEventListener('mousemove', onPanelResizeMove);
      document.removeEventListener('mouseup', onPanelResizeUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    });
    watch(() => pref.value.common.iconSize, (v) => applyIconSize(v), { immediate: true });
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
    // 词库设置「搜索是否对分类生效」：默认关闭，即搜索只匹配词条名，不看父级分类；
    // 开启后词条名或分类路径（tab / 各级分类）任一命中即算命中。存储与下发方式同 autoSelectParent。
    const wordbankSearchByPath = ref(readWordbankSearchByPath());
    function readWordbankSearchByPath() {
      try {
        const p = JSON.parse(localStorage.getItem('zhule_wordbank_pref_v1') || 'null');
        if (p && typeof p.searchByPath === 'boolean') return p.searchByPath;
      } catch (e) { /* ignore */ }
      try {
        const raw = JSON.parse(localStorage.getItem('zhule_wordbank_state_v2') || 'null');
        if (raw && raw.pref && typeof raw.pref.searchByPath === 'boolean') return raw.pref.searchByPath;
      } catch (e) { /* ignore */ }
      return false;
    }
    function toggleWordbankSearchByPath() {
      const v = !wordbankSearchByPath.value;
      wordbankSearchByPath.value = v;
      try {
        const p = JSON.parse(localStorage.getItem('zhule_wordbank_pref_v1') || 'null') || {};
        p.searchByPath = v;
        localStorage.setItem('zhule_wordbank_pref_v1', JSON.stringify(p));
      } catch (e) { console.warn('zhule: 设置页写词库偏好失败:', e); }
      window.dispatchEvent(new CustomEvent('zhule-wordbank-pref', { detail: { searchByPath: v } }));
    }
    // 词库设置「隐藏版本切换框」：默认关闭。开启后版本组卡片右上角不再显示「‹ 1/3 ›」，
    // 卡面与参考图翻页条不再抢位；版本切换改走卡片右键「版本胶片条」。存储与下发方式同上。
    const wordbankHideVgNav = ref(readWordbankHideVgNav());
    function readWordbankHideVgNav() {
      try {
        const p = JSON.parse(localStorage.getItem('zhule_wordbank_pref_v1') || 'null');
        if (p && typeof p.hideVgNav === 'boolean') return p.hideVgNav;
      } catch (e) { /* ignore */ }
      try {
        const raw = JSON.parse(localStorage.getItem('zhule_wordbank_state_v2') || 'null');
        if (raw && raw.pref && typeof raw.pref.hideVgNav === 'boolean') return raw.pref.hideVgNav;
      } catch (e) { /* ignore */ }
      return false;
    }
    function toggleWordbankHideVgNav() {
      const v = !wordbankHideVgNav.value;
      wordbankHideVgNav.value = v;
      try {
        const p = JSON.parse(localStorage.getItem('zhule_wordbank_pref_v1') || 'null') || {};
        p.hideVgNav = v;
        localStorage.setItem('zhule_wordbank_pref_v1', JSON.stringify(p));
      } catch (e) { console.warn('zhule: 设置页写词库偏好失败:', e); }
      window.dispatchEvent(new CustomEvent('zhule-wordbank-pref', { detail: { hideVgNav: v } }));
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
    return { showSettings, pref, TIME_FMTS, TAG_THEMES, TAG_COLOR_AREAS, ICON_SIZES, toggleField, setTimeFmt, setTagTheme, setTagRound,
      toggleNoDeleteConfirm, setIconSize, toggleHideMuted, toggleHideCardIcons, toggleHideHints,
      panelWidth, startPanelResize, setTagSeed, randomTagSeed, isCollapsed, toggleCollapse,
      pickOpen, togglePick, closePick, linkTimePresetLabel, timeFmtSample,
      setLinkDir, setLinkNameMode, DEFAULT_LINK_DIR: 'output/zhule_studio/zhule_link',
      LINK_TIME_PRESETS, setLinkTimeFmt, setLinkSep, toggleHideLinkGear, linkTimeSample,
      linkDlgOpen, linkTree, linkActiveTags, linkKnownTags, linkLayerCount, openLinkDlg, closeLinkDlg, onLinkDlgSaved,
      colorPopupOpen, colorPopupArea, colorPopupOpenFor, setTagColorLevel, setGlobalTagColorMode, setGlobalTagColor,
      setAreaTagColorMode, setAreaTagColor, setAreaTagSeed, randomAreaSeed, randomHexColor, randomGlobalColor, randomAreaColor,
      wordbankAutoParent, toggleWordbankAutoParent, wordbankSearchByPath, toggleWordbankSearchByPath,
      wordbankHideVgNav, toggleWordbankHideVgNav, rebuilding, rebuildNotice, rebuildDB };
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
        <div class="settings-shell" :style="{ width: panelWidth + '%' }">
        <div class="settings-panel" :class="{ 'hide-hints': pref.common.hideHints === true }">
          <div class="settings-head">
            <span class="settings-title">设置</span>
            <button class="settings-close" @click="showSettings = false">✕</button>
          </div>
          <div class="settings-body" @click="closePick">
            <!-- 通用设置：对所有页面生效 -->
            <div class="settings-group" :class="{ 'collapsed': isCollapsed('common') }">
              <div class="settings-group-title" @click="toggleCollapse('common')">
                <span>通用设置</span>
                <svg class="settings-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
              </div>
              <div class="settings-group-body" v-show="!isCollapsed('common')">
                <div class="settings-row">
                  <span class="settings-label">删除时弹出确认框</span>
                  <label class="settings-switch">
                    <input type="checkbox" :checked="pref.common.noDeleteConfirm !== true" @change="toggleNoDeleteConfirm">
                    <span class="settings-switch-slider"></span>
                  </label>
                </div>
                <div class="settings-row">
                  <span class="settings-label">图片上的图标大小</span>
                  <div class="settings-seg">
                    <button v-for="opt in ICON_SIZES" :key="opt.size"
                            class="settings-seg-btn"
                            :class="{ on: pref.common.iconSize === opt.size }"
                            @click="setIconSize(opt.size)">{{ opt.label }}</button>
                  </div>
                </div>
                <div class="settings-row">
                  <span class="settings-label">隐藏被静音的提示词</span>
                  <label class="settings-switch">
                    <input type="checkbox" :checked="pref.common.hideMuted === true" @change="toggleHideMuted">
                    <span class="settings-switch-slider"></span>
                  </label>
                </div>
                <div class="settings-row">
                  <span class="settings-label">隐藏卡片上的图标</span>
                  <label class="settings-switch">
                    <input type="checkbox" :checked="pref.common.hideCardIcons === true" @change="toggleHideCardIcons">
                    <span class="settings-switch-slider"></span>
                  </label>
                </div>
                <div class="settings-row">
                  <span class="settings-label">隐藏设置注释</span>
                  <label class="settings-switch">
                    <input type="checkbox" :checked="pref.common.hideHints === true" @change="toggleHideHints">
                    <span class="settings-switch-slider"></span>
                  </label>
                </div>
                <!-- 通用设置下的子类：标签（可折叠，折叠状态与其它分组一起持久化） -->
                <div class="settings-subgroup" :class="{ 'collapsed': isCollapsed('common-tag') }">
                  <div class="settings-group-title settings-subgroup-head" @click="toggleCollapse('common-tag')">
                    <span>标签</span>
                    <svg class="settings-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                  </div>
                  <div class="settings-subgroup-body" v-show="!isCollapsed('common-tag')">
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
              <div class="settings-group" :class="{ 'collapsed': isCollapsed('gallery-detail-tags') }">
                <div class="settings-group-title" @click="toggleCollapse('gallery-detail-tags')">
                  <span>图库详情标签</span>
                  <svg class="settings-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </div>
                <div class="settings-group-body" v-show="!isCollapsed('gallery-detail-tags')">
                <div class="settings-row">
                  <span class="settings-label">标签关联图数角标</span>
                  <label class="settings-switch">
                    <input type="checkbox" :checked="pref.gallery.showTagCount !== false" @change="toggleField('showTagCount')">
                    <span class="settings-switch-slider"></span>
                  </label>
                </div>
                <div class="settings-hint">开启后，外部过滤区与标签编辑面板里的标签右侧显示「关联图数量」（该标签一共挂了多少张图）；图片详情里的标签不显示数字，关闭开关则筛选区也不显示。</div>
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
              <div class="settings-group" :class="{ 'collapsed': isCollapsed('gallery-link') }">
                <div class="settings-group-title" @click="toggleCollapse('gallery-link')">
                  <span>链接相关</span>
                  <svg class="settings-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </div>
                <div class="settings-group-body" v-show="!isCollapsed('gallery-link')">
                <div class="settings-hint">图库工具栏的下载按钮 = 快捷导出：给选中的图片建硬链接（给原图建分身入口，不复制图片数据、几乎不占额外空间），每次导出自动新建独立子文件夹。</div>
                <div class="settings-row settings-row-stack">
                  <span class="settings-label">文件链接地址</span>
                  <input class="settings-seed-input settings-link-dir" :value="pref.gallery.link.dir"
                         :placeholder="'留空 = ' + DEFAULT_LINK_DIR"
                         data-tip="导出的目标根目录。可填绝对路径（如 D:\\zhule_link 或 \\\\nas\\share\\link）；留空则用默认目录 output/zhule_studio/zhule_link。只能填绝对路径，且不能是磁盘根或系统目录。"
                         @change="setLinkDir($event.target.value)" spellcheck="false">
                </div>
                <div class="settings-row settings-row-stack">
                  <span class="settings-label">多选子文件夹命名</span>
                  <div class="settings-seg settings-seg-fill">
                    <button class="settings-seg-btn" :class="{ on: pref.gallery.link.nameMode === 'time' }" @click="setLinkNameMode('time')">按时间</button>
                    <button class="settings-seg-btn" :class="{ on: pref.gallery.link.nameMode === 'tags' }" @click="setLinkNameMode('tags')">按过滤标签</button>
                    <button class="settings-seg-btn" :class="{ on: pref.gallery.link.nameMode === 'custom' }" @click="setLinkNameMode('custom')">自定义分层</button>
                  </div>
                </div>

                <!-- 通用项（三种模式都显示）：图库页下载按钮旁的呼出图标要不要露出来 -->
                <div class="settings-row">
                  <span class="settings-label">显示呼出图标</span>
                  <label class="settings-switch" data-tip="关掉后图库工具栏不再出现齿轮入口，别人用这台电脑的图库时看不到、也不会误改分层">
                    <input type="checkbox" :checked="pref.gallery.link.hideGear !== true" @change="toggleHideLinkGear">
                    <span class="settings-switch-slider"></span>
                  </label>
                </div>
                <div class="settings-hint">呼出图标 = 图库页下载按钮旁的齿轮，点开就能现场改分层。别人可能有自己的用法、不需要一直改，关掉后图库页只留下载按钮；要改时回来打开即可，已保存的分层不受影响。</div>

                <!-- 按时间：下面只多一个「时间格式」，切格式当场给样例 -->
                <template v-if="pref.gallery.link.nameMode === 'time'">
                  <div class="settings-row settings-row-stack">
                    <span class="settings-label">时间格式</span>
                    <div class="settings-pick-wrap" @click.stop>
                      <button class="settings-pick" :class="{ open: pickOpen === 'linkTime' }" @click="togglePick('linkTime')">
                        <span class="settings-pick-val">{{ linkTimePresetLabel }}</span>
                        <span class="settings-pick-caret">▼</span>
                      </button>
                      <div class="settings-pick-pop" v-if="pickOpen === 'linkTime'">
                        <div v-for="p in LINK_TIME_PRESETS" :key="p.key" class="settings-pick-item"
                             :class="{ on: pref.gallery.link.timeFmt === p.key }" @click="setLinkTimeFmt(p.key)">
                          <span class="settings-pick-item-val">{{ p.label }}</span>
                          <span class="settings-pick-item-tip">{{ p.tip }}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div class="settings-hint">这次的子文件夹名会像 <b>{{ linkTimeSample }}</b>。同一天多次导出时后端会自动加 _1 / _2 区分，不会覆盖上一次。</div>
                </template>

                <!-- 按过滤标签：下面只多一个「标签隔离符号」 -->
                <template v-else-if="pref.gallery.link.nameMode === 'tags'">
                  <div class="settings-row">
                    <span class="settings-label">标签隔离符号</span>
                    <input class="settings-seed-input settings-link-sep" :value="pref.gallery.link.sep"
                           maxlength="2" spellcheck="false" placeholder="@"
                           data-tip="多个启用标签拼成一段文件夹名时的分隔符，例如 凌乱发@璃月；最多 2 个字符，留空回退 @"
                           @change="setLinkSep($event.target.value)">
                  </div>
                  <div class="settings-hint">把当前启用的过滤标签用「{{ pref.gallery.link.sep }}」连成一段文件夹名，例如标签「凌乱发」+「璃月」→ 凌乱发{{ pref.gallery.link.sep }}璃月；没有启用标签时自动回退按时间。</div>
                </template>

                <!-- 自定义分层：分层内容编辑入口（呼出图标开关是上面的通用项） -->
                <template v-else>
                  <div class="settings-row">
                    <span class="settings-label">分层内容</span>
                    <button class="settings-seg-btn on settings-link-edit" @click="openLinkDlg">
                      编辑分层<span v-if="linkLayerCount"> · 当前 {{ linkLayerCount }} 层</span>
                    </button>
                  </div>
                  <div class="settings-hint">分层内容：多层目录（凌乱发/璃月/出图 这样一层层往下）。可点上面按钮编辑，图库页下载按钮旁的齿轮也能打开同一个弹框；支持拖动排序、整类选取（直接拿「凌乱发」这种分类当一层目录）。</div>
                </template>
                <div class="settings-hint">某层普通标签在过滤区被停用时，下载会被拦下并弹框让你先修（改成整类 / 换标签 / 转文字层）。</div>
                </div>
              </div>
              <div class="settings-group" :class="{ 'collapsed': isCollapsed('gallery-timefmt') }">
                <div class="settings-group-title" @click="toggleCollapse('gallery-timefmt')">
                  <span>时间格式</span>
                  <svg class="settings-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                </div>
                <div class="settings-group-body" v-show="!isCollapsed('gallery-timefmt')">
                <div class="settings-pick-wrap" @click.stop>
                  <button class="settings-pick" :class="{ open: pickOpen === 'galleryTime' }" @click="togglePick('galleryTime')">
                    <span class="settings-pick-val">{{ pref.gallery.timeFmt }}</span>
                    <span class="settings-pick-caret">▼</span>
                  </button>
                  <div class="settings-pick-pop" v-if="pickOpen === 'galleryTime'">
                    <div v-for="f in TIME_FMTS" :key="f" class="settings-pick-item"
                         :class="{ on: pref.gallery.timeFmt === f }" @click="setTimeFmt(f)">
                      <span class="settings-pick-item-val">{{ f }}</span>
                      <span class="settings-pick-item-tip">样例 {{ timeFmtSample(f) }}</span>
                    </div>
                  </div>
                </div>
                <div class="settings-hint">卡片上显示的时间就用这个格式，点一下选一个，选完立刻生效。</div>
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
                <div class="settings-hint keep-hint" v-if="rebuildNotice">{{ rebuildNotice }}</div>
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
                  <span class="settings-label">搜索对分类生效</span>
                  <label class="settings-switch">
                    <input type="checkbox" :checked="wordbankSearchByPath" @change="toggleWordbankSearchByPath">
                    <span class="settings-switch-slider"></span>
                  </label>
                </div>
                <div class="settings-hint">关闭时搜索只匹配词条名；开启后词条名或所在分类路径（含 tab 与各级分类）任一命中即算命中。</div>
                <div class="settings-row">
                  <span class="settings-label">隐藏版本切换框</span>
                  <label class="settings-switch">
                    <input type="checkbox" :checked="wordbankHideVgNav" @change="toggleWordbankHideVgNav">
                    <span class="settings-switch-slider"></span>
                  </label>
                </div>
                <div class="settings-hint">开启后版本组卡片不再显示右上角「‹ 序号/总数 ›」翻页框，避免与参考图翻页条挤在一起；版本切换改在卡片上右键，用版本胶片条切换。</div>
                </div>
              </div>
            </template>
            <div class="settings-none" v-if="!isGallery && !isWordbank">当前页面暂无设置项</div>
          </div>
        </div>
        <div class="settings-resizer is-left" @mousedown.prevent="startPanelResize($event, -1)"></div>
        <div class="settings-resizer" @mousedown.prevent="startPanelResize($event, 1)"></div>
        </div>
      </div>

      <!-- 标签颜色设置弹窗（方案E）：层级切换 + 模式/取色/种子 -->
      <div class="color-popup-mask" v-if="colorPopupOpen" @click.self="colorPopupOpen = false">
        <div class="color-popup" :class="{ 'hide-hints': pref.common.hideHints === true }">
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

      <!-- 设置页调起的「自定义分层」弹框：与图库页共用同一组件，改完就地写盘 -->
      <ZhgLinkDialog :open="linkDlgOpen" mode="cfg" :active-tags="linkActiveTags" :known-tags="linkKnownTags"
                     :tree="linkTree" :link="pref.gallery.link"
                     @close="closeLinkDlg" @saved="onLinkDlgSaved" />
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
  // 右键/按下即收起气泡：右键删除标签后光标停在同一位置，若不收起会留下旧提示文字残影
  document.addEventListener('mousedown', hideTip, true);
  document.addEventListener('contextmenu', hideTip, true);
  document.body.classList.add('zh-js-tip');
})();
