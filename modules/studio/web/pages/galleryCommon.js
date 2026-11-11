// galleryCommon.js —— 图库双布局公共逻辑（方案A：抽取 composable）
// 说明：GalleryTopDown.js（/gallery 上下布局）与 Gallery.js（/gallery-side 侧边布局）
// 除布局模板与筛选区拖拽参数外完全一致，公共逻辑统一收拢到本模块：
// 列表加载/筛选/删除/导出、详情弹层（tag 随机色 + 提示词高亮 + 左键入筛选/右键编辑词条）、
// 框选多选、外部过滤区（隐藏=完全移除，不可逆语义统一）、标签状态持久化。
// 布局差异通过 useGalleryCommon(opts) 参数化：
//   opts.side = { initW, initH, wMin, wMax, hMin, hMax }  侧边/筛选区尺寸初始值与拖拽范围
//   opts.onPrefChangedExtra(p, prev)  设置变化后的布局独有回调（如上下布局筛选块重排）
//   opts.onMountedExtra()             挂载后布局独有回调
import { ref, reactive, computed, nextTick, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import TagTreePanel from './tagTreePanel.js';
import { useMarqueeSelect } from './marqueeSelect.js';
// 全站统一删除确认（图片/批量/标签/词条共用同一弹框与设置判断）
import { useDeleteConfirm } from './deleteConfirm.js';

export { TagTreePanel, OutNode, DetailTagNode };

// 显示工具：完整路径只取叶子段（'测试/喜欢' → '喜欢'；词条名无分隔符时原样返回）。
// 分隔符支持 / \ - : 四种（/ 与 \ 转义、- 转义保证字面匹配）。
const TAG_PATH_SEPS = /[\/\\:\-]/;
export function leafName(n) {
  const s = String(n || '');
  const parts = s.split(TAG_PATH_SEPS);
  let i = parts.length - 1;
  while (i >= 0 && !parts[i]) i--;
  return i >= 0 ? parts[i] : s;
}
// 标签唯一键：有 id 优先用 id（custom/prompt 加前缀区分域），无 id 的老状态回退 name|rel。
// 全链路匹配（外部过滤区去重/激活/删除）一律以本键为准，禁止再按裸 name 匹配。
export function tagKey(t) {
  if (!t) return '';
  const raw = (t.id != null && t.id !== '') ? String(t.id) : '';
  if (raw) {
    const kind = t.kind || (t.isCustom ? 'custom' : '');
    return (kind === 'custom' ? 'c:' : 'p:') + raw;
  }
  return 'n:' + String(t.name || '') + '|' + String(t.rel || '');
}
export function cardTags(it) {
  const all = (it && it.tags) ? it.tags : [];
  const cs = (it && Array.isArray(it.customTags)) ? it.customTags : [];
  // String 归一化：后端 JSON 若把纯数字自定义标签序列化成数值类型，与字符串标签比对会 miss，
  // 导致该标签被误判为提示词标签而重复展示/覆盖；统一转字符串后按叶子名归类。
  const csSet = new Set(cs.map((c) => String(c)));
  const prompt = all.filter((t) => t && !csSet.has(String(t)));
  return [...prompt, ...cs.map((c) => leafName(c))];
}

export const API = {
  list: '/zhule_studio/api/gallery',
  meta: '/zhule_studio/api/gallery/meta',
  detail: '/zhule_studio/api/gallery/detail',
  ids: '/zhule_studio/api/gallery/ids',
  random: '/zhule_studio/api/gallery/random',
  workflow: '/zhule_studio/api/gallery/workflow',
  thumb: '/zhule_studio/api/gallery/thumb',
  annotate: '/zhule_studio/api/gallery/annotate',
  rename: '/zhule_studio/api/gallery/rename',
  renameFile: '/zhule_studio/api/gallery/rename-file',
  rescan: '/zhule_studio/api/gallery/rescan',
  del: '/zhule_studio/api/gallery/delete',
  batchDel: '/zhule_studio/api/gallery/batch-delete',
  link: '/zhule_studio/api/gallery/batch-link',
};
export const PAGE_SIZE = 60;

// 外部过滤区递归节点：俄罗斯套娃包裹式展开（与 tagTreePanel 视觉一致，尺寸随子树深度放大）
// 隐藏语义统一：Ctrl+左键 = 完全移除（不可逆，恢复靠编辑面板 tagTreePanel 重新左键点击放置）
const OutNode = {
  name: 'OutNode',
  props: {
    node: { type: Object, required: true },
    depth: { type: Number, default: 0 },
    inFilter: { type: Function, required: true },
    isActive: { type: Function, required: true },
    isHidden: { type: Function, default: null },
    // 勾选态上卷（父组件传入 nodeSelState）：'on' 自身启用 / 'part' 子树内有启用项 / '' 无。
    // 缺失时退化为原来的 isActive 二态，保持组件单独可用
    selState: { type: Function, default: null },
    treeKidsFn: { type: Function, default: null },
    // 全局标签主题类（zhg-tag-theme-* / zhg-tag-square），由父组件传入，复用详情标签样式
    themeCls: { type: String, default: '' },
    // 标签颜色函数（输入完整标签名 → 颜色字符串，同详情区散列配色）；缺失时 CSS 走默认色
    colorOf: { type: Function, default: null },
    // 关联图数角标：显示开关 + 取数函数（父组件传入，入参为节点对象；返回 null 表示不展示）
    showCount: { type: Boolean, default: true },
    countOf: { type: Function, default: null },
  },
  emits: ['toggle', 'add', 'hide'],
  setup(props, { emit }) {
    const expanded = ref(false);
    // 子节点取自树数据（tagTreeKidsMap），与 tagTreePanel 共用同一棵树；无树数据时退回 node.children
    // 隐藏 = 完全移除：树内递归渲染同样过滤掉 hidden 项（等价 v-if=false），隐藏大标签时整棵子树随之消失
    const kids = () => {
      const all = props.treeKidsFn ? props.treeKidsFn(props.node) : (props.node.children || []);
      return props.isHidden ? all.filter((c) => !props.isHidden(c)) : all;
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
    const boxStyle = () => ({ ...chipStyle() });
    function onClick(e) {
      // Ctrl+左键：隐藏（完全移除，不可逆；恢复靠编辑面板 tagTreePanel 重新左键点击放置）
      if (e.ctrlKey) { e.preventDefault(); emit('hide', props.node); return; }
      // 普通左键：直接启用/禁用该标签过滤，不产生外部独立标签
      emit('toggle', props.node);
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
    function fwdAdd(node) { emit('add', node); }
    function fwdHide(name) { emit('hide', name); }
    // 当前节点的勾选态：on（自身启用）/ part（仅子树内有启用）/ ''（无）
    const st = () => (props.selState ? (props.selState(props.node) || '') : (props.isActive(props.node) ? 'on' : ''));
    // 半选提示：说明子树内已有生效的子标签，点父级可整支启用（命中范围相同）
    const partTip = () => (st() === 'part' ? '子树内有子标签生效中，点击启用父级（命中同样的图）' : '');
    return {
      expanded, kids, hasKids, chipStyle, boxStyle, leafName, st, partTip,
      onClick, onCtx, fwdToggle, fwdAdd, fwdHide,
    };
  },
  template: `
    <div class="zhg-out-wrap" :class="{ open: expanded }">
      <span class="zhg-sel-tag zhg-out-tag" v-if="!expanded" :class="[themeCls, { on: st() === 'on', part: st() === 'part', off: !st(), leaf: !hasKids() }]" :style="chipStyle()"
            :data-tip="(st() === 'on' ? '生效中，点击停用' : (st() === 'part' ? partTip() : '待生效，点击启用')) + ' / Ctrl+左键隐藏（完全移除） / 右键展开收起'"
            @click="onClick" @contextmenu.prevent="onCtx">
        {{ leafName(node.name) }}<span class="zhg-ttp-count" v-if="showCount && countOf && countOf(node) != null">{{ countOf(node) }}</span>
      </span>
      <div class="zhg-out-open" v-else :class="{ part: st() === 'part' }" :style="boxStyle()" :data-tip="partTip()" @contextmenu.prevent="onCtx">
        <out-node v-for="c in kids()" :key="c.rel || c.name" :node="c" :depth="depth + 1"
                  :in-filter="inFilter" :is-active="isActive" :is-hidden="isHidden" :sel-state="selState" :tree-kids-fn="treeKidsFn" :theme-cls="themeCls" :color-of="colorOf"
                  :show-count="showCount" :count-of="countOf"
                  @toggle="fwdToggle" @add="fwdAdd" @hide="fwdHide"></out-node>
      </div>
    </div>
  `,
};

// 图库卡片右键菜单（左右布局 / 上下布局共用同一份模板与状态）。
// 卡片右侧竖排的选择/放大/删除图标在此完整复制一份，另加「进入详情」；
// 开启通用设置「隐藏卡片上的图标」后，这里成为唯一入口（与词库卡片右键菜单同构）。
export const CardCtxMenu = {
  name: 'CardCtxMenu',
  props: {
    // { open, x, y, title, picked, selCount }
    state: { type: Object, required: true },
  },
  emits: ['close', 'sel', 'zoom', 'detail', 'del', 'batch-del'],
  // 模板里不能直接写 emit('x')：Vue 3 模板上下文不暴露 emit 标识符，运行时为 undefined，
  // 每次点击都会抛「TypeError: emit is not a function」——事件处理器中断导致 state.open 卡在 true，
  // 全屏透明 .ctx-layer 永不消失，整页点击/滚轮全被它吃掉（表现为「页面卡死，只能刷新」）。
  // 因此统一经 setup 导出的方法转发动作（与同文件 DetailTagNode 的写法对齐）。
  setup(props, { emit }) {
    const onClose = () => emit('close');
    const onSel = () => emit('sel');
    const onZoom = () => emit('zoom');
    const onDetail = () => emit('detail');
    const onDel = () => emit('del');
    const onBatchDel = () => emit('batch-del');
    // Esc 兜底：即使某个动作抛错导致遮罩残留，也能一键救回（与词库右键菜单行为一致）
    const onKeydown = (e) => { if (e.key === 'Escape' && props.state && props.state.open) onClose(); };
    onMounted(() => document.addEventListener('keydown', onKeydown));
    onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
    return { onClose, onSel, onZoom, onDetail, onDel, onBatchDel };
  },
  template: `
    <div v-if="state.open" class="ctx-layer" @pointerdown.self="onClose" @contextmenu.prevent.self="onClose">
      <div class="ctx-menu" :style="{ left: state.x + 'px', top: state.y + 'px' }" @pointerdown.stop>
        <div class="ctx-title">{{ state.title }}</div>
        <button type="button" class="ctx-item" @click="onSel">{{ state.picked ? '✓ 取消选中' : '✓ 选中这张图' }}</button>
        <button type="button" class="ctx-item" @click="onZoom">🔍 放大预览</button>
        <button type="button" class="ctx-item" @click="onDetail">→ 进入详情</button>
        <div class="ctx-sep"></div>
        <button type="button" class="ctx-item danger" @click="onDel">🗑 删除这张图</button>
        <button type="button" class="ctx-item danger" v-if="state.selCount > 1" @click="onBatchDel">🗑 删除选中的 {{ state.selCount }} 张</button>
      </div>
    </div>
  `,
};

// 详情自定义标签层级树节点（递归）：custom_tag 按 parent_id 层级还原展示。
// 叶子/带标签节点渲染为可交互 chip（左键编辑词条、右键删除，删除确认遵循 pref.common.noDeleteConfirm）；
// 纯容器节点（仅路径中的中间层级）渲染分组标题，点击展开/收起。
const DetailTagNode = {
  name: 'DetailTagNode',
  props: {
    node: { type: Object, required: true },
    depth: { type: Number, default: 0 },
    themeCls: { type: String, default: '' },
  },
  emits: ['edit', 'delete'],
  setup(props, { emit }) {
    const expanded = ref(false);
    const hasKids = () => props.node.children && props.node.children.length;
    return { expanded, hasKids, emit };
  },
  template: `
    <div class="zhg-dtag-wrap" :class="{ open: expanded }">
      <span v-if="node.isGroup && !node.tag" class="zhg-dtag-group" @click.stop="expanded = !expanded">
        {{ node.name }}<span class="zhg-dtag-arrow">{{ expanded ? '▾' : '▸' }}</span>
      </span>
      <span v-else class="zhg-tag hl-custom" :class="[themeCls]"
            :style="node.style || {}"
            :data-tip="'自定义标签，左键编辑词条，右键删除（遵循删除确认设置）'"
            @click.stop="emit('edit', node.tag)" @contextmenu.prevent="emit('delete', node.tag)">
        {{ node.name }}
        <span v-if="hasKids()" class="zhg-dtag-arrow" @click.stop="expanded = !expanded">{{ expanded ? '▾' : '▸' }}</span>
      </span>
      <div class="zhg-dtag-kids" v-if="expanded" :style="{ marginLeft: (depth + 1) * 12 + 'px' }">
        <detail-tag-node v-for="c in node.children" :key="c.path" :node="c" :depth="depth + 1" :theme-cls="themeCls"
                         @edit="emit('edit', $event)" @delete="emit('delete', $event)"></detail-tag-node>
      </div>
    </div>
  `,
};

// 通用 fetch：自动携带 JSON / 表单请求体
export async function jfetch(url, opts) {
  const res = await fetch(url, opts || {});
  let data = null;
  try { data = await res.json(); } catch (e) { /* 非 JSON 响应 */ }
  if (!res.ok || (data && data.error)) {
    throw new Error((data && data.error) || res.statusText || '请求失败');
  }
  return data;
}

const DEFAULT_PREF = {
  gallery: {
    showName: true,
    showTime: true,
    showModel: true,
    showTags: true,
    // 详情界面标签右侧的关联图数角标（提示词标签 / 自定义标签通用），默认开启
    showTagCount: true,
    showModelFilter: true,
    showLoraFilter: true,
    timeFmt: 'yyyy-MM-dd HH:mm',
    tagTheme: 'light',
    tagRound: true,
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
    // 链接相关（与 main.js 设置面板同构）：dir 目标根目录 / nameMode 子文件夹命名方式
    // timeFmt：按时间命名时的目录名格式（预设键，见 LINK_TIME_PRESETS）
    // sep 标签隔离符号 / custom 分层模板（{type:'tag'|'text', value, rel, cat}，cat=整类分类层）
    // hideGear：隐藏图库页「自定义分层」呼出齿轮（别人用图库时不必看到这个入口）
    link: { dir: '', nameMode: 'time', timeFmt: 'ymd_hms', sep: '@', custom: [], hideGear: false },
  },
  common: {
    noDeleteConfirm: false,
  },
};

// 标签树瘦身：只保留选择器需要的字段（名字/完整路径/图数/子节点）
// 「整类可选」的判定就靠 children 是否为空：有子节点 = 分类节点
export function normalizeTree(ns) {
  if (!Array.isArray(ns)) return [];
  return ns.map((n) => ({
    name: String((n && n.name) || ''),
    rel: String((n && n.rel) || (n && n.name) || ''),
    count: (n && typeof n.count === 'number') ? n.count : null,
    children: normalizeTree(n && n.children),
  })).filter((n) => n.name);
}

// 快捷导出「按时间」命名的时间格式预设：key 存进 pref
// label 统一写成字母格式串（与图库「时间格式」一致的 yyyy/MM/dd 风格），不再拿具体时刻当选项名，
// 实际目录名仍由 linkTimeName 按 key 现场生成
export const LINK_TIME_PRESETS = [
  { key: 'ymd_hms', label: 'yyyyMMdd_HHmmss', tip: '日期_时分秒（最不容易重名）' },
  { key: 'ymd-hms', label: 'yyyy-MM-dd_HH-mm-ss', tip: '日期带横线，再接时分秒' },
  { key: 'ymd', label: 'yyyyMMdd', tip: '只到日期（同一天多次导出自动加 _1/_2）' },
  { key: 'ymd-dash', label: 'yyyy-MM-dd', tip: '只到日期，日期带横线' },
];
// 按预设生成这次的目录名：只用本地时间，纯字符串（不含 / \ 等会被后端清洗的字符）
export function linkTimeName(key, d) {
  const t = (d instanceof Date) ? d : new Date();
  const p = (n) => String(n).padStart(2, '0');
  const y = String(t.getFullYear());
  const m = p(t.getMonth() + 1);
  const dd = p(t.getDate());
  const H = p(t.getHours());
  const M = p(t.getMinutes());
  const S = p(t.getSeconds());
  switch (key) {
    case 'ymd-hms': return y + '-' + m + '-' + dd + '_' + H + '-' + M + '-' + S;
    case 'ymd': return y + m + dd;
    case 'ymd-dash': return y + '-' + m + '-' + dd;
    default: return y + m + dd + '_' + H + M + S;
  }
}

// 链接配置归一化：设置面板写盘的结构在旧存档里可能缺失，这里补齐默认值
function normalizeLink(lk) {
  const out = Object.assign({ dir: '', nameMode: 'time', timeFmt: 'ymd_hms', sep: '@', custom: [], hideGear: false },
    (lk && typeof lk === 'object') ? lk : {});
  if (typeof out.dir !== 'string') out.dir = '';
  if (!['time', 'tags', 'custom'].includes(out.nameMode)) out.nameMode = 'time';
  if (!LINK_TIME_PRESETS.some((p) => p.key === out.timeFmt)) out.timeFmt = 'ymd_hms';
  if (typeof out.sep !== 'string' || !out.sep) out.sep = '@';
  if (!Array.isArray(out.custom)) out.custom = [];
  out.hideGear = out.hideGear === true;
  return out;
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
    const raw = localStorage.getItem('zhule_ui_pref');
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_PREF));
    const p = JSON.parse(raw);
    const out = JSON.parse(JSON.stringify(DEFAULT_PREF));
    if (p && p.gallery) Object.assign(out.gallery, p.gallery);
    if (p && p.common) Object.assign(out.common, p.common);
    out.gallery.tagColor = normalizeTagColor(p && p.gallery && p.gallery.tagColor);
    out.gallery.link = normalizeLink(p && p.gallery && p.gallery.link);
    return out;
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULT_PREF));
  }
}

export function fmtTime(ts, fmt) {
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

export function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// 展示模型名时去掉 .safetensors 等文件扩展名
export function fmtModel(name) {
  if (!name) return '';
  return name.replace(/\.[^.\/\\]+$/, '');
}

// 图库卡片原生悬停提示：卡片改为「图片为主角 + 名字叠图」后，
// 模型 / 标签等次要信息收进 title，鼠标悬停即可查看，不占用卡片版面
export function cardTip(it) {
  if (!it) return '';
  const parts = [];
  if (it.name) parts.push(it.name);
  if (it.model) parts.push('模型：' + fmtModel(it.model));
  const tags = cardTags(it);
  if (tags && tags.length) parts.push('标签：' + tags.join(' / '));
  return parts.join('\n');
}

export function useGalleryCommon(opts = {}) {
  const route = useRoute();
  const router = useRouter();
  // 慢操作节流日志：仅记录 >=30ms 的计算，同一标签 5 秒内最多一条，避免渲染期刷屏
  const pref = reactive(loadPref());
  function onPrefChanged(e) {
    const p = (e && e.detail) || loadPref();
    const prev = JSON.parse(JSON.stringify(pref));
    Object.assign(pref, p);
    // 标签颜色配置变化（种子/模式/颜色）：即时重算已打开详情的标签色
    if (prev.gallery.tagSeed !== pref.gallery.tagSeed
      || JSON.stringify(prev.gallery.tagColor || null) !== JSON.stringify(pref.gallery.tagColor || null)) refreshTagColors();
    if (opts.onPrefChangedExtra) opts.onPrefChangedExtra(p, prev);
  }
  const filters = reactive({ q: '', sortField: 'time', sortDir: 'desc', models: [], loras: [], tagMode: 'and' });
  const meta = reactive({ tags: [], models: [], loras: [], total: 0 });

  // ── 外部过滤区标签：唯一真源 ─────────────────────────────────────────────
  // tagMap: Map<tagKey, item>，key 由 tagKey() 统一计算（有 id 用 p:/c: 前缀，无 id 用 name|rel）。
  // 用 Map 而不是数组的原因：结构上同一标签只可能占一个 key，重复入列在数据模型层面就不可能发生，
  // 因此不再需要「入列前查重」「load 后按 name 兜底」「dedupeTagFilters 合并」这类补丁式逻辑。
  // 各组件/模板只读 tagList（computed 展开数组），任何写入都必须走下面的 upsertTag / patchTag / dropTag。
  const tagMap = reactive(new Map());
  const tagList = computed(() => Array.from(tagMap.values()));

  // 入参归一化：树节点（isCustom）、筛选区条目（kind）、裸名字字符串三种形态 → {name, rel, id, kind}。
  // kind 双形态兼容是必需的：条目带 kind、树节点带 isCustom，缺了这层树节点会被误判成 prompt 域，
  // tagKey 前缀算错（c:5 → p:5）就会匹配不上已有条目。
  function tagInfo(item) {
    if (typeof item === 'string') return { name: item, rel: '', id: '', kind: 'prompt' };
    if (!item) return { name: '', rel: '', id: '', kind: 'prompt' };
    return {
      name: item.name || '',
      rel: item.rel || '',
      id: (item.id != null && item.id !== '') ? String(item.id) : '',
      kind: item.kind || (item.isCustom ? 'custom' : 'prompt'),
    };
  }

  // 按唯一键查条目。key 未命中时按同名反查一次：「树内渲染」只传裸名字（拿不到 id），
  // 算出的键是 n:name|''，命中不了已带 id 的条目，这一路兜底不可省。
  // 注意不做「跨域同 id」兜底：prompt#5 与 custom#5 是两条不同标签，混为一谈会串标签。
  function findTagEntry(item) {
    const info = tagInfo(item);
    const k = tagKey(info);
    const hit = k ? tagMap.get(k) : null;
    if (hit) return hit;
    if (!info.name) return null;
    for (const t of tagMap.values()) {
      if (String(t.name || '') !== info.name) continue;
      if (info.rel && String(t.rel || '') !== info.rel) continue;
      return t;
    }
    return null;
  }

  // 写入原语一：新键则建条目，旧键则只补空字段 + 打状态补丁。绝不产生第二条。
  function upsertTag(item, patch) {
    const info = tagInfo(item);
    const k = tagKey(info);
    if (!k) return null;
    const cur = tagMap.get(k);
    if (cur) {
      // 只补空字段：调用方可能只有裸名字（树内渲染），拿它的默认值覆盖已有 id / 域会串标签
      const fill = {};
      if (!cur.name && info.name) fill.name = info.name;
      if (!cur.rel && info.rel) fill.rel = info.rel;
      if (!cur.id && info.id) fill.id = info.id;
      if (!cur.kind && info.kind) fill.kind = info.kind;
      return patchTag(cur, Object.assign(fill, patch));
    }
    const entry = {
      name: info.name, rel: info.rel, id: info.id, kind: info.kind,
      active: false, hidden: false, inner: false,
    };
    if (patch) Object.assign(entry, patch);
    tagMap.set(tagKey(entry), entry);
    // 必须把代理对象交还调用方：后续改它（或 patchTag 里 Object.assign）才会触发响应式更新
    return tagMap.get(tagKey(entry));
  }

  // 写入原语二：修改已存在条目。id / kind / name / rel 参与计算唯一键，
  // 一旦改动就让条目换了 key，所以这里必须同步把 Map 的键迁过去（rekey），
  // 否则旧键残留、新键查不到 → 又建一条 → 回到重复入列。迁移后若撞上已存在的同键条目（老状态里
  // 「无 id 一条 + 有 id 一条」回填后指向同一标签），就地合并状态并返回幸存条目。
  function patchTag(entry, patch) {
    if (!entry) return null;
    const oldKey = tagKey(entry);
    // 已被合并丢弃的条目不在 Map 里：忽略写入，避免留下幽灵对象
    if (tagMap.get(oldKey) !== entry) return entry;
    if (!patch) return entry;
    const keyTouched = ('id' in patch) || ('kind' in patch) || ('name' in patch) || ('rel' in patch);
    Object.assign(entry, patch);
    if (!keyTouched) return entry;
    const newKey = tagKey(entry);
    if (newKey === oldKey) return entry;
    tagMap.delete(oldKey);
    const dup = tagMap.get(newKey);
    if (!dup) {
      tagMap.set(newKey, entry);
      return entry;
    }
    dup.active = !!(dup.active || entry.active);
    dup.hidden = !!(dup.hidden && entry.hidden);
    dup.inner = !!(dup.inner && entry.inner);
    if (!dup.rel && entry.rel) dup.rel = entry.rel;
    return dup;
  }

  // 写入原语三：删除条目
  function dropTag(entry) {
    if (!entry) return;
    const k = tagKey(entry);
    if (k && tagMap.get(k) === entry) tagMap.delete(k);
  }

  // 外部过滤区标签状态持久化：整表（含 hidden 项）序列化到 localStorage；
  // localStorage 不可用 / 解析失败时静默降级为纯内存（不崩溃、不抛错）
  const TAG_STORAGE_KEY = 'zhule_gallery_tags';
  function saveTagPref() {
    try {
      localStorage.setItem(TAG_STORAGE_KEY, JSON.stringify({ version: 2, tags: tagList.value }));
    } catch (e) { /* ignore: 降级为纯内存 */ }
  }
  function loadTagPref() {
    try {
      const raw = JSON.parse(localStorage.getItem(TAG_STORAGE_KEY) || 'null');
      // version 1 为历史数组格式，结构相同，一并兼容；重复项由 upsertTag 按键自然合并
      if (raw && (raw.version === 1 || raw.version === 2) && Array.isArray(raw.tags)) {
        for (const t of raw.tags) {
          if (!t || typeof t.name !== 'string') continue;
          upsertTag({
            name: t.name, rel: t.rel || '', id: t.id || '', kind: t.kind || '',
          }, { active: !!t.active, hidden: !!t.hidden, inner: !!t.inner });
        }
      }
    } catch (e) { /* ignore: 解析失败，保留空 tags */ }
  }
  loadTagPref();
  // 整体展开/收起筛选区
  const filtersOpen = ref(false);
  try {
    const saved = localStorage.getItem('zhule_gallery_filters_open');
    if (saved !== null) filtersOpen.value = saved === '1';
  } catch (e) { /* ignore */ }
  function toggleFilters() {
    filtersOpen.value = !filtersOpen.value;
    try { localStorage.setItem('zhule_gallery_filters_open', filtersOpen.value ? '1' : '0'); } catch (e) { /* ignore */ }
    // 筛选区由收起转展开：等 DOM 可见后回调布局（上下布局需按容器可用宽重新分配筛选块宽度；
    // 否则挂载时容器处于隐藏态，块宽分配失效，展开后筛选块仍停留在初始窄宽）
    if (filtersOpen.value && opts.onFiltersOpen) opts.onFiltersOpen();
  }

  const items = ref([]);
  const total = ref(0);
  const page = ref(1);
  const pageSize = ref(PAGE_SIZE);
  // 页码双击编辑：直接输入目标页码回车/失焦跳转（页码栏语义不变）
  const pageEditing = ref(false);
  const pageEditVal = ref('');
  function beginPageEdit() {
    pageEditing.value = true;
    pageEditVal.value = String(page.value);
    nextTick(() => {
      const el = document.querySelector('.zhg-pg-input');
      if (el) { el.focus(); el.select(); }
    });
  }
  function commitPageEdit() {
    if (!pageEditing.value) return;
    pageEditing.value = false;
    const n = parseInt(pageEditVal.value, 10);
    if (!Number.isNaN(n)) goPage(n);
  }
  function cancelPageEdit() {
    pageEditing.value = false;
  }
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
  // 随机拼页：骰子是单次使用的——从当前筛选命中池随机抽出一页数量的图片覆盖当前页展示，
  // 不改页码/总数/分页状态，不进任何"随机模式"；翻页按钮仍按原页码正常走
  async function randomPage() {
    if (loading.value) return;
    await ensureHitIds();
    if (!hitIds.value.length) { showToast('当前筛选下没有图片，无法随机拼页', 'warn'); return; }
    loading.value = true;
    try {
      const q = buildQuery(true);
      const d = await jfetch(API.random + '?' + q.toString());
      if (!d.items || !d.items.length) { showToast('随机拼页失败', 'warn'); return; }
      items.value = d.items;
      // 保持 total/page 不变（页码栏仍显示原「第 x / N 页」）
      // allLoaded 置 true 仅用于禁止触底追加，避免普通列表下一页混进随机结果
      allLoaded.value = true;
      if (d.builtAt && d.builtAt) dirty.value = false;
    } catch (e) {
      showToast('随机拼页失败', 'error');
    } finally {
      loading.value = false;
    }
  }
  const loading = ref(true);
  const loadingMore = ref(false);
  const allLoaded = ref(false);
  const dirty = ref(false);
  const tagPanelOpen = ref(false);
  // 筛选区（侧边/上下）尺寸：初始值与拖拽范围由布局传入
  const sideOpt = opts.side || {};
  const side = reactive({ w: sideOpt.initW || 0, h: sideOpt.initH || 0 });
  const sideStyle = computed(() => ({
    width: side.w > 0 ? side.w + 'px' : '',
    height: side.h > 0 ? side.h + 'px' : '',
  }));
  function maxSideH() {
    const v = sideOpt.hMax;
    return typeof v === 'function' ? v() : (v || 2000);
  }
  function loadSidePref() {
    try {
      const raw = JSON.parse(localStorage.getItem('zhule_gallery_side') || '{}');
      // 上下布局（ignoreW）恒为 100% 宽：忽略历史残留的 w（旧版左右布局写入的宽度值），
      // 否则筛选区容器被锁成窄条（如 375px 约占屏宽 1/3），拖拽把手也只放大块宽、容器不跟随，表现为"无法拉宽"
      if (!sideOpt.ignoreW && raw.w > (sideOpt.wMin || 140) && raw.w < (sideOpt.wMax || 2400)) side.w = raw.w;
      if (raw.h > (sideOpt.hMin || 120) && raw.h < maxSideH()) side.h = raw.h;
    } catch (e) { /* ignore */ }
    // 默认给筛选区一个固定基准高度（仅布局配置了 initH 时生效），拖高把手才能按鼠标拉高并让块体随高度伸展
    if (!(side.h > 0) && (sideOpt.initH || 0) > 0) side.h = sideOpt.initH;
  }
  loadSidePref();
  function startSideDrag(e, axis) {
    const startX = e.clientX, startY = e.clientY;
    // 基线取面板**实际渲染尺寸**：side.w / side.h 为 0 表示「没拖过、用 CSS 默认值」，
    // 若直接拿 0 当基线，第一次拖动会先跳到最小值（表现为拉不动、越拉越窄）
    const _el = e.currentTarget && e.currentTarget.parentElement;
    const _r = _el ? _el.getBoundingClientRect() : null;
    const startW = side.w > 0 ? side.w : (_r ? _r.width : 0);
    const startH = side.h > 0 ? side.h : (_r ? _r.height : 0);
    const wMin = sideOpt.wMin || 140, wMax = sideOpt.wMax || 2400;
    const hMin = sideOpt.hMin || 120, hMaxV = maxSideH();
    const onMove = (ev) => {
      if (axis === 'w') side.w = Math.max(wMin, Math.min(wMax, startW + ev.clientX - startX));
      else side.h = Math.max(hMin, Math.min(hMaxV, startH + ev.clientY - startY));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      try { localStorage.setItem('zhule_gallery_side', JSON.stringify({ w: side.w, h: side.h })); } catch (err) { /* ignore */ }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }
  // 条目被移除/隐藏时同步清掉其 inner 后代（套娃内点击产生的自动启用项）：
  // 父条目没了之后，inner 后代在顶层不可见、也没有任何入口能关掉它，留着只会静默参与过滤。
  // 判定同 tagAncestorOf：同域 + rel 严格前缀；无 rel 的老状态不参与层级，不动。
  function pruneInnerDescendants(entry) {
    const er = String((entry && entry.rel) || '');
    if (!er) return;
    const ek = entry.kind || '';
    for (const t of [...tagMap.values()]) {
      if (!t.inner) continue;
      if ((t.kind || '') !== ek) continue;
      const tr = String(t.rel || '');
      if (tr && tr !== er && tr.startsWith(er + '/')) dropTag(t);
    }
  }
  // 编辑面板左键点击：未入列则放入（红色待启用），已入列则移除；此前被隐藏过的条目转为显式启用。
  // 入参是树节点 / 筛选区条目 / 裸名字，统一交给 tagInfo 归一化，不再手写 name/rel/id/kind 提取。
  function addTagFilter(item) {
    const info = tagInfo(item);
    if (!info.name) return;
    // 同名但 id 不同（如 '测试/喜欢' 与顶层 '喜欢'）键不同，各自独立、互不覆盖
    const existed = findTagEntry(info);
    if (!existed) {
      upsertTag(info, { active: false, hidden: false });
    } else if (existed.hidden) {
      patchTag(existed, {
        hidden: false, active: true, inner: false,
        rel: info.rel || existed.rel, id: info.id || existed.id, kind: info.kind || existed.kind,
      });
    } else {
      pruneInnerDescendants(existed);
      dropTag(existed);
    }
    applyFilter();
    saveTagPref();
  }
  // 详情页提示词标签左键：放入外部过滤区并立即启用（与编辑面板「放入后待点蓝」不同，这里一步到位生效）。
  // 语义为幂等放置：已入列则强制 active=true、取消 hidden/inner，不会像 addTagFilter 那样再点一次就移除，
  // 避免"点一下就消失"的误操作；移除/停用仍由筛选区自身的左键/✕ 负责。
  // rel 缺失：详情标签只带叶子名（自定义带完整 path），用树元信息按 id + 域回填 rel，
  // 保证套娃层级、父子取代（visibleTags 的 tagAncestorOf）与编辑面板放入的条目完全一致。
  async function addDetailTagToFilter(item) {
    if (!item || !item.name) return;
    const name = item.name;
    const kind = item.custom ? 'custom' : 'prompt';
    const id = (item.id != null && item.id !== '') ? String(item.id) : '';
    await ensureTagTree(); // 已有缓存直接返回，仅首点拉一次树
    let rel = '';
    if (item.custom && item.path) rel = String(item.path);
    if (!rel && id) {
      for (const k of Object.keys(tagKidMeta.value)) {
        const m = tagKidMeta.value[k];
        if (m && String(m.id) === id && (!!m.isCustom) === (kind === 'custom')) { rel = m.rel || ''; break; }
      }
    }
    // 幂等放置：已入列则复用同一条并强制启用（补 id/rel 会让键迁移，由 patchTag 自动换键合并），
    // 绝不会像 addTagFilter 那样再点一次就移除
    const info = { name, rel, id, kind };
    const target = findTagEntry(info) || upsertTag(info);
    patchTag(target, {
      hidden: false, inner: false, active: true, // 提升为显式条目，才能在顶层筛选区看到并可停用
      rel: rel || target.rel,
      id: id || target.id,
      kind,
    });
    applyFilter();
    saveTagPref();
    showToast('已加入筛选并启用：' + name, 'success');
  }
  // 外部过滤区：左键点击直接启用/禁用（红=待生效 / 蓝=生效）
  // 未入列（套娃内子标签首次点击）：直接启用并以 inner 标记入列，顶层 visibleTags 过滤 inner 不产生外部独立标签
  // 隐藏不可逆（Ctrl+左键完全移除），恢复靠编辑面板重新放置，故这里不再处理 hidden
  // 匹配一律按唯一键（id 优先），同名不同 id（'测试/喜欢' vs '喜欢'）各自独立启停
  function toggleTagActive(item) {
    const info = tagInfo(item);
    if (!info.name) return;
    let t = findTagEntry(info);
    if (!t) {
      // 首次放置（套娃内子标签）：节点没带 id 时按树元信息补齐；入列即启用并标记 inner，顶层不单独占位
      const meta = tagKidMeta.value[info.rel || info.name] || {};
      upsertTag({
        name: info.name,
        rel: info.rel,
        id: info.id || meta.id || '',
        kind: info.kind || (meta.isCustom ? 'custom' : 'prompt'),
      }, { active: true, hidden: false, inner: true });
      applyFilter();
      saveTagPref();
      return;
    }
    // 老状态条目缺 id（老 localStorage / URL 直达）：按树元信息补齐后走 SQL。
    // 补 id 会改变唯一键，patchTag 负责把键迁过去，迁移撞车时顺带与「已有 id」的同名条目合并。
    if (!t.id) {
      const meta = tagKidMeta.value[t.rel || t.name];
      if (meta && meta.id) t = patchTag(t, { id: meta.id, kind: meta.isCustom ? 'custom' : 'prompt' }) || t;
    }
    patchTag(t, { active: !t.active });
    applyFilter();
    saveTagPref();
  }
  // 外部过滤区：Ctrl+左键隐藏（完全移除，不可逆）——扁平列表项标记 hidden 并清除 active，
  // 渲染层统一按 hidden 过滤后标签彻底消失不占位（隐藏大标签时整棵子树随之消失）；无任何恢复入口
  function hideTag(item) {
    const info = tagInfo(item);
    if (!info.name) return;
    const t = findTagEntry(info);
    if (t) {
      patchTag(t, { hidden: true, active: false });
      pruneInnerDescendants(t);
    } else {
      upsertTag(info, { active: false, hidden: true, inner: true });
    }
    applyFilter();
    saveTagPref();
  }
  // 祖先判定（同域 + rel 路径前缀）：kind/isCustom 双兼容，无 rel 的老状态不参与层级判定
  function tagAncestorOf(a, b) {
    if ((a.kind || (a.isCustom ? 'custom' : '')) !== (b.kind || (b.isCustom ? 'custom' : ''))) return false;
    const ar = String(a.rel || ''), br = String(b.rel || '');
    return !!ar && !!br && br !== ar && br.startsWith(ar + '/');
  }
  // 外部过滤区可见标签（顶层大标签）：只展示「显式放置」的条目——inner（套娃内点击产生的启用项）
  // 永远不占顶层位，只在展开容器里高亮反馈；否则在筛选区启用"璃月"会把大标签从"角色"顶成"璃月"且回不去。
  // 显式条目之间仍按最深选中链取代：选"角色"显示角色；编辑面板再放入"璃月"后只显示璃月；删掉璃月角色自动回归。
  // 隐藏 = 完全移除（等价 v-if=false）
  const visibleTags = computed(() => {
    // tagMap 天然按唯一键去重，这里只需处理「显式条目之间按最长路径取代」一件事
    const base = tagList.value.filter((t) => !t.hidden && !t.inner);
    return base.filter((t) => !base.some((u) => u !== t && tagAncestorOf(t, u)));
  });
  // 树内递归渲染判断隐藏态：隐藏 = 完全移除，渲染时按此过滤（等价 v-if=false），隐藏大标签时整棵子树随之消失
  function isTagHidden(name) {
    const t = findTagEntry(name);
    return !!(t && t.hidden);
  }
  // 外部过滤区：右键展开子标签需要的树数据（name -> children）
  const tagTreeKidsMap = ref({});
  // 树节点元信息（name -> {id, isCustom}）：外部区点击/老状态回填时按名字找回 id，供 SQL 过滤
  const tagKidMeta = ref({});
  // 标签树原始层级（整棵）：给「自定义分层」浮层选择器用，能按「角色 → 胡桃」逐级钻取、也能整类选取
  const tagTreeRoots = ref([]);
  // 词条 id -> 显示名：URL 带 id 筛选时（词库跳转）用它把数字回显成词条名
  const tagIdNameMap = ref({});
  const expandedTags = ref(new Set());
  async function ensureTagTree() {
    if (Object.keys(tagTreeKidsMap.value).length) return;
    try {
      const r = await fetch('/zhule_studio/api/gallery/tagtree', { headers: { 'Cache-Control': 'no-cache' } });
      const d = await r.json();
      if (Array.isArray(d.tree)) {
        const map = {};
        const idMap = {};
        const kidMeta = {};
        (function walk(ns) {
          for (const n of ns) {
            // map/kidMeta 键用 rel（完整路径）保证重名节点（'测试/喜欢' vs '喜欢'）不互相覆盖
            const key = n.rel || n.name;
            map[key] = (n.children || []).map((c) => ({
              id: (c.id != null && c.id !== '') ? String(c.id) : '',
              name: c.name,
              rel: c.rel,
              isCustom: !!c.isCustom,
              children: c.children || [],
              count: (typeof c.count === 'number') ? c.count : null,
            }));
            if (n.id != null && n.id !== '') idMap[String(n.id)] = n.name;
            // count：该标签的关联图数（外部过滤区标签角标的数据源，详情页不显示）
            kidMeta[key] = {
              id: (n.id != null && n.id !== '') ? String(n.id) : '',
              isCustom: !!n.isCustom,
              rel: n.rel || '',
              name: n.name,
              count: (typeof n.count === 'number') ? n.count : null,
            };
            walk(n.children || []);
          }
        })(d.tree);
        tagTreeKidsMap.value = map;
        tagIdNameMap.value = idMap;
        tagKidMeta.value = kidMeta;
        // 只挑整层选择器需要的字段，避免把后端整包数据挂在响应式里
        tagTreeRoots.value = normalizeTree(d.tree);
        backfillTagIds();
      }
    } catch (e) { /* 静默失败，右键展开无子标签可显示 */ }
  }
  // 老 localStorage 状态 / URL 直达只有名字没有 id：树加载后用 rel|name 找回 id/kind，让过滤走 SQL；
  // 有 id 但 kind 缺失的更老状态同样按树元信息补域，否则自定义 id 会带 p: 前缀查错域（筛选失效/高亮失配）
  function backfillTagIds() {
    let changed = false;
    // 迭代快照：补 id 会把条目搬到新键（rekey），撞车时当前条目还会被合并丢弃，
    // 直接遍历 Map 会在迭代过程中改动结构
    for (const t of [...tagMap.values()]) {
      const meta = tagKidMeta.value[t.rel || t.name];
      if (!meta) continue;
      const id = t.id || meta.id;
      if (!id) continue;
      // kind 一律以树元信息为准：旧状态可能缺 kind 或存错域（custom id 带 prompt 域），
      // 域错则 tagKey 前缀错——高亮匹配不上、buildQuery 把自定义 id 发去提示词域查空
      const kind = meta.isCustom ? 'custom' : 'prompt';
      if (t.id === id && t.kind === kind) continue;
      patchTag(t, { id, kind });
      changed = true;
    }
    // 回填会改变唯一键（n:name|rel → p:id）；与既有「有 id」条目撞键时 patchTag 在迁移时已合并，
    // 所以这里只剩落盘一件事
    if (changed) saveTagPref();
  }
  function treeKids(item) {
    const key = (typeof item === 'object' && item) ? (item.rel || item.name) : String(item || '');
    return tagTreeKidsMap.value[key] || [];
  }
  function toggleTagExpand(name) {
    ensureTagTree();
    const s = new Set(expandedTags.value);
    if (s.has(name)) s.delete(name); else s.add(name);
    expandedTags.value = s;
  }
  function isTagActive(name) {
    const t = findTagEntry(name);
    return !!(t && t.active);
  }
  // 外部过滤区节点的「勾选态」上卷：on = 自身已启用；part = 自身未启用但子树内有启用的后代。
  // 起因：右键展开只选子标签（璃月）后收起，外层大标签（角色）看不出里面已选好，误以为没生效。
  // 判定按 rel 前缀（同域 + 路径前缀）层层递归，父链上每一层都会返回 part；
  // 只影响显示，不改查询语义——后端 _tag_hit 选父级时本就会展开整个子树命中，而选子级只命中该子树。
  function nodeSelState(node) {
    const info = tagInfo(node);
    if (!info.name) return '';
    const self = findTagEntry(info);
    if (self && self.active && !self.hidden) return 'on';
    const rel = String(info.rel || self && self.rel || '');
    if (!rel) return '';
    const prefix = rel + '/';
    const isCustom = info.kind === 'custom';
    for (const t of tagMap.values()) {
      if (!t.active || t.hidden) continue;
      // 域不同的同名路径是另一棵树的标签（prompt#5 与 custom#5），不能互相点亮
      if ((t.kind === 'custom') !== isCustom) continue;
      const tr = String(t.rel || '');
      if (tr && tr.startsWith(prefix)) return 'part';
    }
    return '';
  }
  function inTagFilter(name) {
    return !!findTagEntry(name);
  }
  function clearTagFilter() {
    if (tagMap.size) {
      tagMap.clear();
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

  // ── 通用设置「隐藏卡片上的图标」：图库与词库读同一份 zhule_ui_pref.common ──────────
  // 开启后卡片右侧竖排的 选择/放大/删除 图标整体隐藏，全部操作改走右键菜单（与词库卡片同构）
  const hideCardIcons = computed(() => !!(pref.common && pref.common.hideCardIcons === true));

  // ── 卡片右键菜单：左右布局与上下布局共用同一份状态 ───────────────────────────────
  const cardCtx = reactive({ open: false, x: 0, y: 0, item: null, title: '', picked: false, selCount: 0 });
  const closeCardCtx = () => { cardCtx.open = false; };
  const openCardCtx = (evt, it) => {
    if (!it) return;
    cardCtx.item = it;
    cardCtx.title = it.name || '';
    cardCtx.picked = isSel(it.key);
    cardCtx.selCount = selected.size;
    // 贴边翻转，避免菜单跑出窗口（宽约 200 / 高约 250）
    cardCtx.x = Math.max(8, Math.min(evt.clientX, window.innerWidth - 210));
    cardCtx.y = Math.max(8, Math.min(evt.clientY, window.innerHeight - 250));
    cardCtx.open = true;
  };
  // 菜单项统一「先收菜单再执行」，避免遮罩层挡住后续弹窗与框选
  const onCtxSel = () => { const it = cardCtx.item; closeCardCtx(); if (it) toggleSel(it.key); };
  const onCtxZoom = () => { const it = cardCtx.item; closeCardCtx(); if (it) zoomView(imgUrl(it.key, it.mtime), it); };
  const onCtxDetail = () => { const it = cardCtx.item; closeCardCtx(); if (it) openDetail(it); };
  const onCtxDel = () => { const it = cardCtx.item; closeCardCtx(); if (it) askDelete(it); };
  const onCtxBatchDel = () => { closeCardCtx(); askBatchDelete(); };

  // 详情弹层导航：命中池（当前筛选条件下的全部图）key 列表，用于图片两侧的上一张/下一张/骰子随机
  const hitIds = ref([]);
  const hitTotal = ref(0);
  const hitIdsKey = ref('');
  const detailPos = ref(0); // 当前图在命中池中的位置（1 起），未知为 0
  const quickTag = ref('');
  const tagInputing = ref(false);
  const tagInputEl = ref(null);
  let tagBlurTimer = null;
  const toast = ref('');
  const toastType = ref('info');
  const toastIcon = { info: '\u2139\ufe0f', success: '\u2705', error: '\u274c', warn: '\u26a0\ufe0f' };
  // 统一删除确认：图片 / 批量 / 标签 / 词条四种删除共用同一个弹框实例
  const del = useDeleteConfirm();
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
    isInteractive: (e) => !!(e.target && e.target.closest && e.target.closest('.zhg-del-btn, .zhg-zoom-btn, .zhg-sel-toggle')),
    onUpdate: (hits, ctx) => {
      // 不按 Ctrl：替换式框选（清空后写入本次命中）
      // 按住 Ctrl：并集追加（只 add 不 clear，Set 天然去重，已在选中里的不会重复加）
      if (!(ctx && ctx.additive)) selected.clear();
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
    filters.q || tagList.value.some((t) => t.active && !t.hidden) ||
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

  // 把自定义标签（完整路径 name，如 '测试/喜欢'）按分隔符拆分构建层级树。
  // 同一图片若同时关联 '测试' 与 '测试/喜欢'，'测试' 节点既携带标签也可展开子节点。
  function buildCustomTagTree(tags, colorMap) {
    const roots = [];
    for (const t of tags) {
      if (!t || !t.custom) continue;
      const parts = String(t.name || '').split(TAG_PATH_SEPS).filter((s) => s);
      if (!parts.length) continue;
      let level = roots;
      let prefix = '';
      parts.forEach((p, i) => {
        prefix = prefix ? prefix + '/' + p : p;
        let node = level.find((x) => x.name === p);
        if (!node) {
          node = { name: p, path: prefix, isGroup: true, tag: null, style: '' };
          level.push(node);
        }
        node.path = prefix;
        if (i === parts.length - 1) {
          node.isGroup = false;
          node.tag = t;
          node.style = colorMap[t.name] || '';
        }
        level = node.children || (node.children = []);
      });
    }
    return roots;
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
  // 提示词标签（词库词条）：先展示，平铺
  const promptDetailTags = computed(() => {
    const d = detail.value;
    if (!d) return [];
    const seen = new Set();
    return (d.tags || []).filter((t) => {
      if (!t || !t.prompt) return false;
      const n = t.name;
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  });
  // 自定义标签：按 '测试/喜欢' 完整路径还原为层级树（父'测试'下挂子'喜欢'），置于提示词标签之后。
  // 树节点复用详情标签对象：叶子携带 tag/style，中间层级为纯容器（isGroup）。
  const customDetailTree = computed(() => {
    const d = detail.value;
    if (!d) return [];
    return buildCustomTagTree(d.tags || [], tagColorMap.value);
  });
  // 自定义标签平铺叶子（定稿：叶子才是标签，父级仅分组容器，展示界面一律直接平铺叶子名）。
  // 返回原始标签对象 + display 叶子名 + 临时色，保留左键入筛选/右键编辑/✕取消关联所需的完整字段。
  const customFlatTags = computed(() => {
    const d = detail.value;
    if (!d) return [];
    return (d.tags || [])
      .filter((t) => t && t.custom)
      .map((t) => ({ ...t, display: leafName(t.name), style: tagStyle(t) }));
  });
  // ---- 标签颜色（基于全局种子 + 标签名的确定性散列）：同一标签恒定同色，
  // 设置页「随机颜色种子」换种子整套换色；不再支持单标签手动改色 ----
  const tagColorMap = ref({});
  function seedHash(name, seed) {
    const s = String(seed || pref.gallery.tagSeed || '') + '|' + String(name);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h >>>= 0;
    const hue = h % 360;
    const sat = 60 + (h % 4) * 6; // 60/66/72/78 微调饱和度
    const lit = 38 + (h % 3) * 5; // 38/43/48 微调明度
    return 'hsl(' + hue + ', ' + sat + '%, ' + lit + '%)';
  }
  // 标签区域配色统一入口（方案E）：按级别与模式决定某个区域的标签颜色。
  // simple：全局异色 = 全局种子散列（同一标签恒定同色，换种子整套换色）；全局同色 = 统一一色。
  // complex：按区域配置；异色 = 区域种子散列（区域种子留空回退全局种子）；同色 = 区域统一色。
  function colorFor(areaKey, name) {
    const tc = pref.gallery.tagColor;
    if (!tc || tc.level !== 'complex') {
      return (tc && tc.globalMode === 'same') ? tc.globalColor : seedHash(name);
    }
    const a = tc.areas && tc.areas[areaKey];
    if (!a || a.mode === 'diff') return seedHash(name, a && a.seed);
    return a.color;
  }
  function refreshTagColors() {
    const map = {};
    uniqueDetailTags.value.forEach((t) => { map[t.name] = colorFor('detail', t.name); });
    tagColorMap.value = map;
  }
  // 注：详情标签的「右键选颜色」入口已移除（改色只走设置页标签配色分区），
  // tagColorMap 仅保留为全局规则算色的缓存，不再接受手动覆盖。
  // 英文提示词高亮：按 tag 的英文词条文本在提示词原文中做不区分大小写的整体子串匹配（带词边界）。
  // 词条名是中文目录名（zhule_prompt_tags 存中文名），中文名匹配英文提示词永不命中；
  // 后端 detail 已为每个 tag 附带 en 字段（词库词条目录 prompt.txt 全文），按 en 匹配即可整段着色。
  // 手动英文标签（无 en 字段）回退用 tag 名本身匹配；中文手动标签不参与英文匹配。
  const enSegments = computed(() => {
    const d = detail.value;
    const map = tagColorMap.value;
    if (!d || !d.promptPreview) return [];
    const text = d.promptPreview;
    const matches = (d.tags || []).filter((t) => !(t && t.custom)).map((t) => {
      const en = t && t.en ? String(t.en).trim() : '';
      const name = t && t.name ? String(t.name).trim() : '';
      const pat = en || (name && !/[\u4e00-\u9fff]/.test(name) ? name : '');
      const color = map[name] || '';
      return { pat, color };
    }).filter((m) => m.pat && m.color);
    if (!matches.length) return [{ text, color: '' }];
    matches.sort((a, b) => b.pat.length - a.pat.length); // 长词条优先，避免短词条抢先占位
    const lower = text.toLowerCase();
    const hits = [];
    for (const m of matches) {
      const key = m.pat.toLowerCase();
      let idx = 0;
      while (true) {
        const pos = lower.indexOf(key, idx);
        if (pos < 0) break;
        const before = pos > 0 ? lower[pos - 1] : '';
        const after = pos + key.length < lower.length ? lower[pos + key.length] : '';
        // 词边界：两侧不能是字母/数字，避免把 girl 着色到 1girl 之类内部
        if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
          hits.push({ start: pos, end: pos + key.length, color: m.color });
        }
        idx = pos + key.length;
      }
    }
    hits.sort((a, b) => a.start - b.start || b.end - a.end);
    const segs = [];
    let pos = 0;
    for (const h of hits) {
      if (h.start < pos) continue; // 已被更早/更长的命中覆盖
      if (h.start > pos) segs.push({ text: text.slice(pos, h.start), color: '' });
      segs.push({ text: text.slice(h.start, h.end), color: h.color });
      pos = h.end;
    }
    if (pos < text.length) segs.push({ text: text.slice(pos), color: '' });
    return segs;
  });
  // 中文提示词：按标签逐段着色，与 tag 色一一对应（逗号连接，行为与原 cnPrompt 一致）
  const cnSegments = computed(() => {
    const d = detail.value;
    const map = tagColorMap.value;
    if (!d || !d.tags) return [];
    const segs = [];
    let first = true;
    (d.tags || []).forEach((t) => {
      const cn = t && t.cn ? String(t.cn).trim() : '';
      if (!cn) return;
      segs.push({ text: (first ? '' : '，') + cn, color: map[t.name] || '' });
      first = false;
    });
    return segs;
  });
  // 详情标签样式：只注入 CSS 变量 --tag-bg（随机色优先），背景/描边/文字由主题类在 CSS 中统一处理。
  // 新增未着色标签回退统一色（自定义标签与提示词标签同色，不再单独橙色区分）。
  const TAG_FALLBACK = { prompt: '#2a9d8f', custom: '#2a9d8f' };
  function tagStyle(t) {
    const c = tagColorMap.value[t.name] || colorFor('detail', t.name) || TAG_FALLBACK[t.prompt ? 'prompt' : 'custom'] || '';
    return c ? { '--tag-bg': c } : null;
  }
  // 标签「关联图数」角标：**只在外部过滤区与编辑面板的标签上显示**（图片详情里的标签不显示）。
  // 数据来自 /gallery/tagtree 每个节点的 count（后端一次统计 gallery_tag，按 id 分域命中）；
  // 设置页「标签关联图数」开关关闭时整体不渲染。
  const showTagCount = computed(() => pref.gallery.showTagCount !== false);
  // 取数：先认节点自带 count（树节点/点击放入的条目），再按 rel|name 查树元信息兜底
  // （老 localStorage 状态、URL 直达只有名字没有 id 的情况）。
  function tagCount(t) {
    if (t == null) return null;
    const item = (typeof t === 'object') ? t : { name: String(t) };
    if (typeof item.count === 'number') return item.count;
    const key = item.rel || item.name;
    const meta = key ? tagKidMeta.value[key] : null;
    return (meta && typeof meta.count === 'number') ? meta.count : null;
  }
  // 外部过滤区标签配色（filter 区域）：内存缓存色优先（保留给详情算色复用的旧映射）；
  // 其余按该区域配置取色（简单模式=全局规则，分区模式=filter 区域规则）。
  function tagColorOf(name) {
    return tagColorMap.value[name] || colorFor('filter', name);
  }
  // 编辑面板标签配色（edit 区域）：与外部过滤区同规则，但分区模式下独立取色。
  function editColorOf(name) {
    return tagColorMap.value[name] || colorFor('edit', name);
  }
  // 标签主题类（设置页 tagTheme/tagRound，zhule-pref-changed 即时生效）：
  // zhg-tag-theme-dark|light|plain + 圆角关闭时追加 zhg-tag-square（近直角）
  const tagThemeClass = computed(() => {
    const th = pref.gallery.tagTheme || 'light';
    return 'zhg-tag-theme-' + th + (pref.gallery.tagRound === false ? ' zhg-tag-square' : '');
  });

  // 带 mtime 时间戳防浏览器缓存旧图：同名文件重建后 URL 变化，强制拉取新缩略图/原图
  const thumbUrl = (key, t) => API.thumb + '?path=' + encodeURIComponent(key) + '&t=' + (t || '');
  const imgUrl = (key, t) => '/zhule_studio/api/gallery/image?path=' + encodeURIComponent(key) + '&t=' + (t || '');
  function onCardClick(it, e) {
    if (e.ctrlKey || e.metaKey) {
      if (selected.has(it.key)) selected.delete(it.key); else selected.add(it.key);
      return; // Ctrl+点击只切换选中，不打开详情
    }
    if (Date.now() < suppressClickUntil) return;
    openDetail(it);
  }
  // 卡片左上角选中图标：点击直接选中/取消选中（无需 Ctrl）
  function toggleSel(key) {
    if (selected.has(key)) selected.delete(key); else selected.add(key);
  }
  // ============ 全屏查看器（公共模块，命令式，非响应式） ============
  // 与词库 Wordbank.js 共用 zhule_fullviewer.js：actions 配置差异（词库=提示词/参考图，
  // 图库=命中池上一张/下一张/随机/删除）。导航状态统一走下方 hitIds/detailNav，天然一套逻辑。
  let fullViewer = null;
  let createFullViewerFn = null;
  let zoomCtxItem = null; // 全屏当前上下文：detail 或列表项（卡片🔍打开时 detail 可能为空）

  // 全屏打开时若详情已在导航，同步刷新全屏图片与标题
  function refreshFullViewer() {
    const d = detail.value;
    if (!fullViewer || !fullViewer.isOpen) return;
    if (d && d.path) fullViewer.open(imgUrl(d.path, d.mtime), d.name);
    else if (zoomCtxItem) fullViewer.open(imgUrl(zoomCtxItem.key || zoomCtxItem.path, zoomCtxItem.mtime), zoomCtxItem.name);
  }
  // 全屏上一张/下一张：与详情弹层共用 detailNav（当前筛选命中池），并同步全屏画面
  async function fullNav(dir) {
    if (!detail.value && zoomCtxItem) await openDetailByPath(zoomCtxItem.key || zoomCtxItem.path);
    await detailNav(dir);
    refreshFullViewer();
  }
  // 全屏随机：与详情弹层共用 detailNavRandom
  async function fullRandom() {
    if (!detail.value && zoomCtxItem) await openDetailByPath(zoomCtxItem.key || zoomCtxItem.path);
    await detailNavRandom();
    refreshFullViewer();
  }
  // 全屏删除：走统一删除确认（设置里开启免确认则不弹），删除文件+缩略图+库内记录
  function fullDelete() {
    const t = detail.value || zoomCtxItem;
    if (t) askDelete(t);
  }
  async function zoomView(src, item) {
    zoomCtxItem = item || detail.value || null;
    if (!createFullViewerFn) {
      const mod = await import('/zhule_modules/common/zhule_fullviewer.js');
      createFullViewerFn = mod.createFullViewer;
      fullViewer = createFullViewerFn({
        tip: '',
        actions: [
          { label: '‹', tip: '上一张（当前命中池）', size: 'lg', onClick: () => fullNav(-1) },
          { label: '🎲', tip: '随机一张（当前命中池）', dice: true, onClick: fullRandom },
          { label: '›', tip: '下一张（当前命中池）', size: 'lg', onClick: () => fullNav(1) },
          { sep: true },
          { label: '🗑', tip: '删除当前图片及其库内关联数据', onClick: fullDelete },
        ],
      });
    }
    const ctx = item || detail.value || null;
    if (fullViewer) fullViewer.open(src, ctx ? ctx.name : '');
  }
  let _detailReqSeq = 0;
  let _hitIdsPromise = null;
  let _hitIdsPromiseKey = '';
  let _hitIdsSeq = 0;
  let _posRepairKey = '';
  async function openDetail(item) {
    // 顺手预载命中池 ids（不阻塞详情打开），位置与导航后续即用
    ensureHitIds();
    await openDetailByPath(item.key);
  }
  async function openDetailByPath(path) {
    const seq = ++_detailReqSeq;
    try {
      const d = await jfetch(API.detail + '?path=' + encodeURIComponent(path));
      if (seq !== _detailReqSeq) {
        return; // 已有更新的点击，丢弃过期响应
      }
      detail.value = d;
      quickTag.value = '';
      tagInputing.value = false;
      refreshTagColors();
      updateDetailPos();
    } catch (e) {
      showToast('详情加载失败', 'error');
    }
  }
  function updateDetailPos() {
    const d = detail.value;
    if (!d || !d.path) { detailPos.value = 0; return; }
    const i = hitIds.value.indexOf(d.path);
    detailPos.value = i >= 0 ? i + 1 : 0;
    if (i >= 0) { _posRepairKey = ''; return; }
    // 池与当前图不匹配（页面显示「— / N」）：多为筛选刚变更、池还是上一套筛选的结果。
    // 同一「池版本 + 图片」只自愈一次，避免反复请求；修复后位置与左右键导航恢复正常。
    const rk = hitIdsKey.value + '|' + d.path;
    if (hitIds.value.length && _posRepairKey !== rk) {
      _posRepairKey = rk;
      ensureHitIds(true);
    }
  }
  // 命中池（当前筛选下全部图的 key 列表）：force=true 强制重拉。
  // 关键点：请求发出时不改动 hitIds/hitIdsKey（旧池在新结果回来前仍然可用），
  // 结果按请求序号落地 —— 期间又有新的筛选请求，则丢弃本次结果，绝不让旧池覆盖新池。
  async function ensureHitIds(force) {
    const key = buildQuery(true).toString();
    if (!force && hitIdsKey.value === key && hitIds.value.length) return;
    if (!force && _hitIdsPromise && _hitIdsPromiseKey === key) return _hitIdsPromise;
    const seq = ++_hitIdsSeq;
    _hitIdsPromiseKey = key;
    _hitIdsPromise = (async () => {
      try {
        const d = await jfetch(API.ids + '?' + key);
        if (seq !== _hitIdsSeq) return; // 已有更新的请求，丢弃过期结果
        hitIds.value = d.ids || [];
        hitTotal.value = d.total || 0;
        hitIdsKey.value = key;
        updateDetailPos();
      } catch (e) {
        if (seq !== _hitIdsSeq) return;
        hitIdsKey.value = ''; // 失败不落地无效池，下次调用会重试
        updateDetailPos();
      } finally {
        if (seq === _hitIdsSeq) _hitIdsPromise = null;
      }
    })();
    return _hitIdsPromise;
  }
  async function detailNav(delta) {
    const cur = detail.value ? detail.value.path : null;
    if (!cur) return;
    let arr = hitIds.value;
    let idx = arr.indexOf(cur);
    if (idx < 0) {
      // 位置未知（池缺失 / 筛选刚变更 / 图不在池内）：先强刷一次再定位。
      // 绝不能按方向盲跳到首尾 —— 历史 bug：左箭头跳最末图、右箭头跳第一张。
      await ensureHitIds(true);
      arr = hitIds.value;
      idx = arr.indexOf(cur);
    }
    if (!arr.length) { showToast('命中池为空', 'warning'); return; }
    if (idx < 0) { showToast('当前图片不在筛选结果内，无法按筛选翻页', 'info'); return; }
    const ni = idx + delta;
    if (ni < 0) { showToast('已是第一张', 'info'); return; }
    if (ni >= arr.length) { showToast('已是最后一张', 'info'); return; }
    await openDetailByPath(arr[ni]);
  }
  async function detailNavRandom() {
    await ensureHitIds();
    const arr = hitIds.value;
    if (!arr.length) { showToast('命中池为空', 'warning'); return; }
    const idx = Math.floor(Math.random() * arr.length);
    await openDetailByPath(arr[idx]);
  }
  function closeDetail() { detail.value = null; }
  function copyPrompt() {
    const d = detail.value;
    if (!d || !d.promptPreview) return;
    const done = () => showToast('提示词已复制', 'success');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(d.promptPreview).then(done).catch(() => fallbackCopy(d.promptPreview, done));
    } else {
      fallbackCopy(d.promptPreview, done);
    }
  }
  function fallbackCopy(text, done) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      done();
    } catch (e) {
      showToast('复制失败', 'error');
    }
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
  function askDelete(it) {
    // 统一删除模块：免确认直接删，否则弹确认框（设置由 deleteConfirm 统一读取）
    del.ask({
      title: '确认删除图片',
      message: '将删除该图片文件、缩略图及其库内关联数据，此操作不可撤销。',
      name: (it && (it.name || it.key)) || '',
      run: () => deleteImageNow(it),
    });
  }
  async function deleteImageNow(item) {
    if (!item) return;
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

      // 详情/全屏联动：删除的是当前详情图时，从命中池移除并跳到下一张（无则关闭）
      const dp = detail.value && (detail.value.path || detail.value.key);
      if (dp && dp === p) {
        const hi = hitIds.value.indexOf(p);
        if (hi >= 0) {
          hitIds.value.splice(hi, 1);
          hitTotal.value = Math.max(0, hitTotal.value - 1);
          updateDetailPos();
        }
        if (hitIds.value.length) {
          const nextPath = hitIds.value[Math.min(hi >= 0 ? hi : 0, hitIds.value.length - 1)];
          await openDetailByPath(nextPath);
          refreshFullViewer();
        } else {
          closeDetail();
          if (fullViewer && fullViewer.isOpen) fullViewer.close();
        }
      } else if (fullViewer && fullViewer.isOpen && zoomCtxItem && (zoomCtxItem.path || zoomCtxItem.key) === p) {
        // 从列表卡片🔍全屏删除了当前展示图：关闭全屏
        fullViewer.close();
      }
    } catch (e) {
      showToast('删除失败：' + (e.message || ''), 'error');
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
    const names = customTagNames();
    if (!names.includes(name)) {
      await annotate({ tags: [...names, name] });
    }
    quickTag.value = '';
    tagInputing.value = false;
  }
  // 自定义标签名列表（唯一可增删部分；zhule_tags 已并入 zhule_custom_tags）。
  // String 归一化：后端 JSON 若把纯数字自定义标签序列化为数值类型，统一转字符串比对，避免覆盖提示词标签。
  function customTagNames() {
    return (detail.value.tags || [])
      .filter((t) => t && !t.prompt && t.name != null)
      .map((t) => String(t.name));
  }
  // 打标后重组详情 tags：只读的提示词标签在前，自定义标签在后
  function mergeDetailTags(customNames) {
    const src = detail.value.tags || [];
    const readonly = src.filter((t) => t && t.prompt);
    const seen = new Set(readonly.map((t) => (t.name != null ? String(t.name) : '')));
    const custom = [];
    for (const n of customNames) {
      const key = n != null ? String(n) : '';
      if (!seen.has(key)) {
        custom.push({ name: key, prompt: false, custom: true });
        seen.add(key);
      }
    }
    return [...readonly, ...custom];
  }
  function removeTagFromImage(name) {
    const d = detail.value;
    if (!d) return;
    annotate({ remove_custom: [name] });
  }
  // ============ 标签删除（详情自定义标签右键） ============
  // 统一删除模块负责弹框/免确认；这里只描述“删哪个标签、删的具体动作”。
  function askDeleteTag(t) {
    if (!t || !t.name) return;
    del.ask({
      title: t.prompt ? '确认删除提示词标签' : '确认删除自定义标签',
      message: '是否移除当前图片上的该标签？',
      // 弹框展示名：自定义标签只显示叶子名（'测试/喜欢' 只显示 '喜欢'）
      name: t.display || leafName(t.name),
      run: () => deleteDetailTag(t),
    });
  }
  // 真正执行删除：只改这一张图的 PNG 元数据。
  // 提示词标签一律走 remove_prompt_ids（词条 id）——同名节点（「默认」有 25 个）只删当前这一条；
  // 无 id 的存量/自由文本标签才退回 remove_prompt（名字），后端遇到重名会拒绝按名删。
  async function deleteDetailTag(t) {
    if (!t) return;
    if (t.prompt) {
      if (t.id != null && t.id !== '') {
        await annotate({ remove_prompt_ids: [String(t.id)] });
        return;
      }
      if (!t.name) return;
      await annotate({ remove_prompt: [t.name] });
      return;
    }
    if (!t.name) return;
    // 自定义标签删除：优先 id（唯一标识）；无 id 的存量/自由文本标签退回完整路径，
    // 再退回叶子名（后端 remove_custom 兼容 id/路径/叶子名三种匹配，不查数据库）。
    const key = (t.id != null && t.id !== '') ? String(t.id) : (t.path || t.name);
    if (!key) return;
    await annotate({ remove_custom: [key] });
  }
  // ============ 词库词条编辑（左键点击详情 tag 呼出，逻辑与词库 Wordbank.js 完全一致） ============
  // tag 与词库词条对应方式：图库 tag.name = 词库卡片显示名（后端 parse_folder 后的 name），
  // 前端按 name 精确匹配词库扫描结果的卡片，取得 relPath/content/content_cn 后复用词库编辑弹窗；
  // 词库未收录该 tag（如纯手动标签）时给出兜底提示，不打开弹窗。
  const editWbTarget = ref(null);
  const editWbName = ref('');
  const editWbContent = ref('');
  const editWbContentCn = ref('');
  const editWbEditing = ref(false);
  // 编辑弹窗删除（与词库一致）：弹框/免确认统一由 deleteConfirm 处理
  const editWbDeleting = ref(false);
  // 散 txt 卡片（rawName 以 .txt 结尾）：后端不支持中文提示词（与词库 editIsTxt 语义一致）
  const editWbIsTxt = computed(() => {
    const raw = editWbTarget.value ? (editWbTarget.value.rawName || '') : '';
    return raw.toLowerCase().endsWith('.txt');
  });
  // 词库卡片 name -> 卡片 映射缓存：用 /zhule_studio/api/wordbank?refresh=1 全量拉取并建映射
  let wbMapData = null;
  let wbMapTs = 0;
  const WB_MAP_TTL = 30 * 1000; // 30s 内复用，保存成功后强制刷新
  async function ensureWordBankMap(force) {
    const now = Date.now();
    if (!force && wbMapData && (now - wbMapTs) < WB_MAP_TTL) return wbMapData;
    try {
      const resp = await fetch('/zhule_studio/api/wordbank' + (force ? '?refresh=1' : ''));
      if (!resp.ok) return wbMapData || {};
      const json = await resp.json();
      if (json.error) return wbMapData || {};
      const map = {};
      const data = json.data || {};
      for (const tab of Object.keys(data)) {
        for (const card of data[tab] || []) {
          const n = card && card.name ? String(card.name) : '';
          // 先到先得，与后端词条索引 _tag_en_index 去重语义一致
          if (n && !(n in map)) map[n] = card;
        }
      }
      wbMapData = map;
      wbMapTs = now;
      return map;
    } catch (e) {
      return wbMapData || {};
    }
  }
  // 左键点击详情 tag：词条 tag 按词条名匹配词库源文件，命中则呼出与词库一致的编辑弹窗；
  // 自定义标签（层级路径）不做词库联动，直接静默返回（红叉 ✕ 负责取消关联）
  async function editDetailTag(t) {
    if (!t || !t.name) return;
    if (t.custom) return; // 自定义标签不呼出提示词、不与下方提示词联动
    // 必须强制 refresh=1 全量拉取：不带 refresh 时后端只返回已缓存 tab（首屏仅首个 tab），
    // 若目标词条属于其它 tab，按 name 匹配会落空导致左键无反应/只 toast。
    const map = await ensureWordBankMap(true);
    const card = map[t.name];
    if (!card) {
      showToast('「' + t.name + '」不在词库中，无法编辑', 'warn');
      return;
    }
    editWbTarget.value = card;
    editWbName.value = card.name || '';
    editWbContent.value = card.content || '';
    editWbContentCn.value = card.content_cn || '';
  }
  function cancelEditWb() {
    editWbTarget.value = null;
    editWbEditing.value = false;
  }
  // 编辑弹窗删除入口：与词库 askDeleteWord 一致，统一走 deleteConfirm
  function askDeleteEditWb() {
    const t = editWbTarget.value;
    if (!t) return;
    del.ask({
      title: '确认删除词条',
      message: '将删除词库词条及其提示词文件，此操作不可撤销。'
        + '该词条已上传的参考图会一并归档到 zhule_reference/_trash。',
      name: t.name || '',
      run: () => deleteWordEntryNow(t),
    });
  }
  async function deleteWordEntryNow(t) {
    if (!t || editWbDeleting.value) return;
    editWbDeleting.value = true;
    try {
      const resp = await fetch('/zhule_studio/api/wordbank/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: t.id }),
      });
      const json = await resp.json();
      if (json.error) {
        showToast('删除失败：' + json.error, 'error');
      } else {
        showToast('已删除：' + t.name
          + (json.refDirsPurged ? '（参考图已归档 ' + json.refDirsPurged + ' 个目录）' : ''),
          'success');
        editWbTarget.value = null;
        editWbEditing.value = false;
        await ensureWordBankMap(true);
        window.dispatchEvent(new CustomEvent('zhule:wordbank-changed'));
        await refreshDetail();
      }
    } catch (e) {
      showToast('请求失败：' + e.message, 'error');
    } finally {
      editWbDeleting.value = false;
    }
  }
  // 保存：与词库 Wordbank.js submitEdit 完全一致（非空校验 / 条件写回 / 失败保留弹窗 / 成功刷新）
  async function submitEditWb() {
    if (!editWbTarget.value || editWbEditing.value) return;
    const nm = (editWbName.value || '').trim();
    if (!nm) return showToast('名字不能为空', 'warn');

    editWbEditing.value = true;
    try {
      const body = {
        id: editWbTarget.value.id,
        name: nm,
      };
      // 仅当输入框非空或原本就有内容时才写回，避免误清空
      if (editWbContent.value || editWbTarget.value.content) body.content = editWbContent.value;
      // 散 txt 卡片后端不支持中文；仅文件夹卡片提交
      if (!editWbIsTxt.value && (editWbContentCn.value || editWbTarget.value.content_cn)) {
        body.content_cn = editWbContentCn.value;
      }
      const resp = await fetch('/zhule_studio/api/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await resp.json();
      if (json.error) {
        showToast('保存失败：' + json.error, 'error');
        editWbEditing.value = false;
        return; // 失败保留弹窗
      }
      editWbTarget.value = null;
      editWbEditing.value = false;
      // 同步：词库映射强制刷新 + 通知已挂载的词库页刷新卡片列表 + 重拉图库详情
      await ensureWordBankMap(true);
      window.dispatchEvent(new CustomEvent('zhule:wordbank-changed'));
      await refreshDetail();
      showToast('已保存，图库详情与词库已同步', 'success');
    } catch (e) {
      showToast('请求失败：' + e.message, 'error');
      editWbEditing.value = false;
    }
  }
  // 保存成功后重拉当前详情，同步刷新图库详情展示（tag 名 / en / cn 与颜色）
  async function refreshDetail() {
    const d = detail.value;
    if (!d || !d.path) return;
    try {
      const nd = await jfetch(API.detail + '?path=' + encodeURIComponent(d.path));
      detail.value = nd;
      refreshTagColors();
    } catch (e) { /* 详情刷新失败不打断保存结果 */ }
  }
  async function addTagToImage(name) {
    const d = detail.value;
    if (!d) return;
    const names = customTagNames();
    if (names.includes(name)) return;
    await annotate({ tags: [...names, name] });
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
      // 删除后本地移除必须按「id / 完整路径 / 叶子名」三态匹配：
      // 此前只比 x.name，而自定义标签传的是 id（或路径）→ 详情 chip 不消失，看起来像没删掉
      const gone = ('remove_prompt_ids' in payload || 'remove_prompt' in payload || 'remove_custom' in payload)
        ? new Set((payload.remove_prompt_ids || []).map(String)
          .concat(payload.remove_prompt || []).concat(payload.remove_custom || [])) : null;
      if ('tags' in payload) d.tags = mergeDetailTags(payload.tags);
      if (gone) {
        const isGone = (x) => {
          if (typeof x === 'string') return gone.has(x) || gone.has(leafName(x));
          if (!x) return false;
          return [x.id, x.path, x.name].some((v) => v != null && v !== '' && gone.has(String(v)));
        };
        d.tags = (d.tags || []).filter((x) => !isGone(x));
        // 不再整块重拉详情：重拉会替换 detail 对象、把标签行销毁重建（视觉上「闪一下」），
        // 且若服务端详情缓存尚未失效还会把刚删的标签带回来，表现为「要右键第二次才删掉」。
        // 本地三态移除已与后端 same-key 匹配，直接同步卡片即可。
        const item = items.value.find((x) => x.key === d.path);
        if (item) {
          item.tags = (d.tags || []).filter((t) => t && t.prompt).map((t) => t.name);
          item.customTags = (d.tags || []).filter((t) => t && t.custom).map((t) => t.path || t.name);
        }
      }
      // 新增标签（tags 全量重写）：卡片标签同步为写入值
      if ('tags' in payload) {
        const item = items.value.find((x) => x.key === d.path);
        if (item) item.tags = payload.tags;
      }
      await loadMeta();
    } catch (e) {
      showToast('保存失败', 'error');
    }
  }
  // 重命名模型/LoRA：居中弹框
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
  // 图片文件「原地重命名」：双击详情「文件」值变输入框，Enter 确认 / Esc 取消 / 失焦确认。
  // 只改名字不动扩展名（后端自动补回），因此不需要触碰文件内容。
  const fileRenaming = ref(false);
  const fileRenameVal = ref('');
  const fileRenameInput = ref(null);
  const renamingFile = ref(false);

  // 展示名去扩展名（与模型名展示口径一致）
  function fileDisplayName(d) {
    return fmtModel((d && d.name) || '');
  }
  function beginFileRename() {
    if (!detail.value || !detail.value.path) return;
    fileRenameVal.value = fileDisplayName(detail.value);
    fileRenaming.value = true;
    nextTick(() => {
      const el = fileRenameInput.value;
      if (el) { el.focus(); if (el.select) el.select(); }
    });
  }
  function cancelFileRename() {
    // 先置 false：输入框卸载时若触发 blur，commit 会因这个标志直接返回
    fileRenaming.value = false;
  }
  async function commitFileRename() {
    if (!fileRenaming.value || renamingFile.value) return;
    const v = (fileRenameVal.value || '').trim();
    fileRenaming.value = false;
    if (!v) { showToast('文件名不能为空', 'warn'); return; }
    if (v === fileDisplayName(detail.value)) return;
    renamingFile.value = true;
    try {
      const d = await jfetch(API.renameFile, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: detail.value.path, new: v }),
      });
      if (!d.ok) throw new Error(d.error || '改名失败');
      const oldPath = detail.value.path;
      // key 是详情、列表、选中集合三者的唯一关联依据，改名后必须全部同步
      if (detail.value) {
        detail.value.path = d.path;
        detail.value.name = d.name;
        detail.value.mtime = d.mtime;
        detail.value.size = d.size;
      }
      const it = items.value.find((x) => x.key === oldPath);
      if (it) { it.key = d.path; it.name = d.name; it.mtime = d.mtime; }
      if (selected.has(oldPath)) { selected.delete(oldPath); selected.add(d.path); }
      showToast('已重命名为 ' + d.name, 'success');
    } catch (e) {
      showToast('改名失败：' + (e.message || ''), 'error');
    } finally {
      renamingFile.value = false;
    }
  }
  async function rescan() {
    try {
      const d = await jfetch(API.rescan, { method: 'POST' });
      showToast('索引重建中，完成后手动刷新页面查看最新列表');
      void d;
    } catch (e) {
      showToast('重建失败', 'error');
    }
  }
  // 自定义标签增删改后（标签层级面板内联维护）：树已由面板自行刷新，
  // 这里把图库侧受影响的数据重新拉一遍——筛选元数据、当前页列表、已打开的详情。
  async function refreshAfterTagEdit() {
    try {
      await loadMeta();
      await applyFilter();
      refreshTagColors();
      if (detail.value) await refreshDetail();
    } catch (e) { /* 单次刷新失败不影响面板操作结果 */ }
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
  function removeTag(item) {
    const removed = findTagEntry(item);
    if (removed) {
      // 同步清掉其 inner 后代：父条目移除后它们顶层不可见、无入口关闭，只能静默参与过滤
      pruneInnerDescendants(removed);
      dropTag(removed);
    }
    applyFilter();
    saveTagPref();
  }
  function onScroll() {
    const el = mainEl.value;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 600) {
      if (!loadingMore.value && !allLoaded.value && !loading.value) loadItems(false);
    }
  }
  function buildQuery(reset) {
    const p = reset ? 1 : page.value;
    const params = new URLSearchParams({ page: p, pageSize: pageSize.value, sort: filters.sortField + '_' + filters.sortDir });
    if (filters.q) params.set('q', filters.q);
    const actTags = tagList.value.filter((t) => t.active && !t.hidden);
    if (actTags.length) {
      // SQL 优先：有 id 的标签按 id 直查 gallery_tag（词条 id -> tags，自定义 id -> ctags），
      // 后端命中后仅加载候选图记录，不再全量遍历内存索引；无 id 的老状态按 name|rel 走 ltags 兼容路径
      const pid = actTags.filter((t) => t.id && t.kind !== 'custom').map((t) => String(t.id));
      const cid = actTags.filter((t) => t.id && t.kind === 'custom').map((t) => String(t.id));
      const legacy = actTags.filter((t) => !t.id);
      if (pid.length) params.set('tags', pid.join(','));
      if (cid.length) params.set('ctags', cid.join(','));
      if (legacy.length) params.set('ltags', legacy.map((t) => (t.rel ? t.name + '|' + t.rel : t.name)).join(','));
      params.set('mode', filters.tagMode);
    }
    if (filters.models.length) params.set('models', filters.models.join(','));
    if (filters.loras.length) params.set('loras', filters.loras.join(','));
    return params;
  }
  async function applyFilter() {
    // 筛选变更即让命中池失效：否则详情弹层仍拿上一套筛选的池做定位，出现「— / N」
    // 并在左右键时跳到旧池的首/末图；顺带后台预热，打开详情即可直接显示位置
    hitIdsKey.value = '';
    loadItems(true);
    ensureHitIds();
  }
  async function loadMeta() {
    try {
      const d = await jfetch(API.meta);
      Object.assign(meta, d);
    } catch (e) {
      showToast('元数据加载失败', 'error');
    }
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
    } catch (e) {
      showToast('加载失败', 'error');
    } finally {
      loading.value = false;
      loadingMore.value = false;
    }
  }
  // 批量操作
  function askBatchDelete() {
    if (!selected.size) { showToast('请先框选或 Ctrl+点击 选中要删除的图片', 'warn'); return; }
    const n = selected.size;
    del.ask({
      title: '确认批量删除',
      message: `是否删除选中的 ${n} 张图片？将删除图片文件、缩略图及其库内关联数据，此操作不可撤销。`,
      run: deleteBatchNow,
    });
  }
  async function deleteBatchNow() {
    // 快照确认时的选中项：弹框期间列表/选中不会变，保持与原逻辑一致
    const keys = [...selected];
    if (!keys.length) return;
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
  // 快捷导出（硬链接）子文件夹命名：当前启用的过滤标签名（按筛选区顺序）
  function activeTagNames() {
    return tagList.value
      .filter((t) => t && t.active && !t.hidden)
      .map((t) => String(t.name || '').trim())
      .filter(Boolean);
  }
  // 计算导出子文件夹层级：返回空数组 = 交给后端按时间戳命名
  //   time   按时间：用设置里的时间格式拼一段（只此一层）
  //   tags   按过滤标签：启用标签用隔离符号连成一段（凌乱发@璃月）
  //   custom 自定义分层：模板每项一层（text 文本层 / tag 标签层 / cat 整类分类层）
  function linkNameSegments() {
    const lk = (pref.gallery && pref.gallery.link) || {};
    const sep = lk.sep || '@';
    const actives = activeTagNames();
    if (lk.nameMode === 'time') {
      return [linkTimeName(lk.timeFmt)];
    }
    if (lk.nameMode === 'tags') {
      return actives.length ? [actives.join(sep)] : [];
    }
    if (lk.nameMode === 'custom' && Array.isArray(lk.custom) && lk.custom.length) {
      const known = knownTagNames.value;
      const segs = [];
      for (const it of lk.custom) {
        const v = String((it && it.value) || '').trim();
        if (!v) continue;
        // 整类分类层是结构层，不跟启用标签走，永远输出
        if (it.type === 'tag' && it.cat) { segs.push(v); continue; }
        // 本应是标签层、该标签也确实在标签库里、但现在没启用 → 缺这一段，跳过（导出前已被 pending 拦下）
        if (it.type === 'tag' && !actives.includes(v) && known.includes(v)) continue;
        segs.push(v);
      }
      return segs;
    }
    return [];
  }

  // ── 快捷导出 · 自定义分层弹框（v3：默认直下，配置/拦截双入口）──────────────
  // 两个入口共用同一个弹框组件：cfg = 只改配置（随时可开，不受 pending 影响）；
  // export = 下载时发现自定义层依赖的标签已被停用，拦下这次导出、让用户先修分层。
  const linkDlgOpen = ref(false);
  const linkDlgMode = ref('cfg');
  const activeTags = computed(() => activeTagNames());
  // 标签库里出现过的标签名（含被停用/隐藏的）：用来区分「标签被停用」和「用户自己敲的固定目录名」。
  // 只有前者才算失效层；后者只是随手写的文件夹名，不该拦导出，否则用户填个新名字就永远导不出去。
  // 名字来源取并集：筛选区现有条目 + 标签树里的全库标签（tagKidMeta，含从筛选区被移除的）。
  // 只用筛选区会漏判——用户把失效标签从筛选区整个删掉后，那层会被当成手写目录名静默跳过；
  // 用全库标签才能保证「库里有的标签现在没启用」一定被拦下来。
  const knownTagNames = computed(() => {
    const set = new Set();
    for (const t of tagList.value) {
      const n = String((t && t.name) || '').trim();
      if (n) set.add(n);
    }
    for (const k in tagKidMeta.value) {
      const n = String((tagKidMeta.value[k] || {}).name || '').trim();
      if (n) set.add(n);
    }
    return Array.from(set);
  });
  // pending 层数：自定义分层里 type=tag、标签在库里但现在没启用的层（这些层导出时缺目录，必须先修）
  // 整类分类层（cat）是结构层，不随启用标签变化，永远不算失效
  const linkPending = computed(() => {
    const lk = (pref.gallery && pref.gallery.link) || {};
    if (lk.nameMode !== 'custom' || !Array.isArray(lk.custom)) return 0;
    const act = activeTagNames();
    const known = knownTagNames.value;
    return lk.custom.filter((it) => {
      if (!it || it.type !== 'tag' || it.cat) return false;
      const v = String(it.value || '').trim();
      if (!v) return false;
      return known.includes(v) && !act.includes(v);
    }).length;
  });
  // 图库页是否隐藏「自定义分层」呼出齿轮：别人借用图库时不希望工具栏多这个入口，可在设置里关掉
  const hideLinkGear = computed(() => !!((pref.gallery && pref.gallery.link) || {}).hideGear);
  async function openLinkDialog(mode) {
    linkDlgMode.value = mode === 'export' ? 'export' : 'cfg';
    linkDlgOpen.value = true;
    // 标签树没加载过就先拉一次，否则全库标签集合是空的，弹框里标不出「需重选」
    if (!Object.keys(tagKidMeta.value).length) { try { await ensureTagTree(); } catch (e) { /* 静默 */ } }
  }
  function closeLinkDialog() { linkDlgOpen.value = false; }
  // 弹框保存：目录 / 连接符 / 分层模板写回 pref；命名方式一并切成 custom，
  // 否则用户改了层却仍按时间命名，会以为没生效（要回按时间就去设置页改回）。
  function onLinkSaved(cfg) {
    const lk = pref.gallery.link;
    // 目录与隔离符号属于「一次性配置」，统一归设置页管；弹框只负责分层内容，不再回写这两项
    lk.custom = (cfg && Array.isArray(cfg.custom)) ? cfg.custom : [];
    lk.nameMode = 'custom';
    try {
      localStorage.setItem('zhule_ui_pref', JSON.stringify(pref));
    } catch (e) {
      showToast('保存导出配置失败：' + (e.message || ''), 'error');
      return;
    }
    // 广播给设置页等其它视图，保持两处显示一致
    window.dispatchEvent(new CustomEvent('zhule-pref-changed', { detail: JSON.parse(JSON.stringify(pref)) }));
    showToast('导出分层已保存', 'success');
  }

  async function batchLink() {
    const keys = [...selected];
    if (!keys.length) { showToast('请先框选或 Ctrl+点击 选中要导出的图片', 'warn'); return; }
    const paths = [];
    for (const k of keys) {
      const item = items.value.find((x) => x.key === k);
      paths.push(item ? (item.path || item.key) : k);
    }
    const lk = (pref.gallery && pref.gallery.link) || {};
    // 判断是否需要拦之前，先确保全库标签集合可用（首次点击才拉树，之后走缓存）
    if (lk.nameMode === 'custom' && !Object.keys(tagKidMeta.value).length) {
      try { await ensureTagTree(); } catch (e) { /* 静默，退回只用筛选区条目判断 */ }
    }
    // 自定义分层里有标签层失效：先弹框修，修好后由弹框的「保存并导出」再回到这里
    if (lk.nameMode === 'custom' && linkPending.value > 0) {
      openLinkDialog('export');
      showToast('有 ' + linkPending.value + ' 层标签已停用，先修分层再导出', 'warn');
      return;
    }
    try {
      const d = await jfetch(API.link, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths, dir: lk.dir || '', segments: linkNameSegments() }),
      });
      if (!d.ok) throw new Error(d.error || '导出失败');
      // 提示只说结果，不再回显保存位置（目录在设置 → 链接相关 里配，用户自己心里有数）
      const failN = (d.failed && d.failed.length) || 0;
      showToast(d.count
        ? ('链接成功 ' + d.count + ' 张' + (failN ? '，失败 ' + failN + ' 张' : ''))
        : '没有可导出的图片', d.count ? 'success' : 'warn');
      // 导出完成后清空已选中，方便继续下一次挑选
      if (d.count) selected.clear();
    } catch (e) {
      showToast('批量导出失败：' + (e.message || ''), 'error');
    }
  }


  onMounted(() => {
    window.addEventListener('zhule-pref-changed', onPrefChanged);
    if (opts.onMountedExtra) opts.onMountedExtra();
    const q = route.query.tags;
    let pendingTagId = null;
    if (q) {
      const first = String(q).split(',').filter(Boolean)[0];
      if (first) {
        // 词库跳转：不覆盖已有标签，新标签生效并取消其它标签的选中状态（仅新标签生效）。
        // 纯数字 = 词条 id（词库箭头跳转）：先按 id 筛选，显示名等标签树加载后再回显
        for (const t of tagMap.values()) patchTag(t, { active: false });
        const isId = /^\d+$/.test(first);
        if (isId) pendingTagId = first;
        const info = isId
          ? { id: first, name: first, rel: '', kind: 'prompt' }
          : { name: first, rel: '', kind: 'prompt' };
        // 命中已有条目就复用并激活（本地点过、再被词库跳转带进来时不会再多出一条），取不到才新建
        const exist = findTagEntry(info) || upsertTag(info);
        patchTag(exist, { active: true, hidden: false, inner: false });
      }
    }
    const qm = String(route.query.mode || 'and').toLowerCase();
    if (qm === 'or') filters.tagMode = 'or';
    ensureTagTree().then(() => {
      if (!pendingTagId) return;
      const nm = tagIdNameMap.value[pendingTagId];
      // 按 id 反查（此时条目的键可能已被 backfill 迁移过），限定提示词域避免与自定义 id 撞号
      const t = tagList.value.find((x) => String(x.id || '') === pendingTagId && x.kind !== 'custom');
      if (!t) return;
      // 跳转只带 id，rel/域信息缺失：用标签树 meta 补齐，否则父子祖先判断（tagAncestorOf）对这条失效
      const m = tagKidMeta.value[t.rel || t.name || nm] || (nm ? tagKidMeta.value[nm] : null);
      const patch = {};
      if (nm && t.name !== nm) patch.name = nm;
      if (!t.rel && m && m.rel) patch.rel = m.rel;
      if (!t.kind && m) patch.kind = m.isCustom ? 'custom' : 'prompt';
      if (Object.keys(patch).length) patchTag(t, patch);
    });
    // 首次进入立即加载列表与元数据；不做自动探活/自动刷新，需要最新数据时手动刷新页面
    loadMeta();
    applyFilter();
  });
  onBeforeUnmount(() => {
    window.removeEventListener('zhule-pref-changed', onPrefChanged);
    if (fullViewer) fullViewer.close();
    clearTimeout(toastTimer);
  });

  return {
    pref, filters, meta, items, total, page, pageSize, totalPages,
    loading, loadingMore, allLoaded, dirty, tagPanelOpen, detail,
    quickTag, toast, toastType, toastIcon, del, mainEl, gridEl,
    leafName, cardTags,
    tagKey, tagList,
    hasFilter, uniqueDetailTags, promptDetailTags, customDetailTree, customFlatTags, enSegments, cnSegments, tagThemeClass, addDetailTagToFilter,
    copyPrompt, thumbUrl, imgUrl, fmtTime, fmtSize, fmtModel,
    isTopDown, toggleLayout, setSortField, toggleSortDir,
    applyFilter, changePageSize, goPage, onScroll, removeTag,
    randomPage,
    pageEditing, pageEditVal, beginPageEdit, commitPageEdit, cancelPageEdit,
    onSearchKeyup, onTagKeyup, toggleModel, toggleLora,
    openRename, cancelRename, confirmRename, rescan, quickCreateTag,
    refreshAfterTagEdit,
    fileRenaming, fileRenameVal, fileRenameInput, renamingFile,
    fileDisplayName, beginFileRename, cancelFileRename, commitFileRename,
    renameOpen, renameKind, renameOld, renameNew, renaming, renameInput,
    filtersOpen, toggleFilters, gridCols, changeGridCols, gridStyle,
    side, sideStyle, startSideDrag,
    addTagFilter, clearTagFilter, toggleTagMode, visibleTags,
    toggleTagActive, hideTag, expandedTags, treeKids, toggleTagExpand,
    isTagActive, inTagFilter, isTagHidden, nodeSelState,
    openDetail, closeDetail, zoomView, tagStyle, tagColorOf, editColorOf, showTagCount, tagCount,
    hitIds, hitTotal, detailPos, ensureHitIds, detailNav, detailNavRandom,
    askDelete, toggleSel,
    hideCardIcons, cardCtx, openCardCtx, closeCardCtx,
    onCtxSel, onCtxZoom, onCtxDetail, onCtxDel, onCtxBatchDel,
    cardTip,
    tagInputing, tagInputEl, startTagInput, cancelTagInput, onTagInputBlur,
    addTagToImage, removeTagFromImage,
    askDeleteTag,
    useWorkflow,
    editWbTarget, editWbName, editWbContent, editWbContentCn, editWbIsTxt, editWbEditing,
    editDetailTag, cancelEditWb, submitEditWb, askDeleteEditWb, editWbDeleting,
    selected, selCount, isSel, onPointerDown, onCardClick,
    askBatchDelete, batchLink,
    linkDlgOpen, linkDlgMode, activeTags, knownTagNames, linkPending,
    tagTreeRoots, hideLinkGear,
    openLinkDialog, closeLinkDialog, onLinkSaved,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 快捷导出 · 自定义分层弹框（v4 落地：浮层气泡版标签选择器）
// 与原型 v3 的差别：
//   1. 标签层不再用原生下拉框，改成点 chip 弹出浮层：支持面包屑逐级钻取、搜索、
//      整类选取（选「胡桃」这一层时可以直接用「凌乱发」这种父级分类作一层目录）。
//   2. 链接目录 / 标签隔离符号已挪到设置页，弹框只管「层级怎么拼」，不再回写这两项。
// 层顺序仍是按住 ⠿ 拖动（插入式移动，不是两两交换）。
// mode=cfg 只改配置；mode=export 是导出被拦后进来修标签失效层。
// ─────────────────────────────────────────────────────────────────────────────
export const LinkDialog = {
  name: 'ZhgLinkDialog',
  props: {
    open: { type: Boolean, default: false },
    mode: { type: String, default: 'cfg' },
    activeTags: { type: Array, default: () => [] },
    knownTags: { type: Array, default: () => [] },
    // 标签树（整棵，从 tagtree 接口瘦身而来）：浮层选择器靠它钻取分类 / 选整类
    tree: { type: Array, default: () => [] },
    link: { type: Object, default: () => ({}) },
  },
  emits: ['close', 'saved', 'export'],
  setup(props, { emit }) {
    const draft = reactive({ custom: [] });
    const err = ref('');
    const dragFrom = ref(-1);
    const dragTo = ref(-1);
    let uidSeq = 0;

    // ── 浮层选择器状态 ──────────────────────────────────────────────────────
    const popRef = ref(null);
    const pk = reactive({ open: false, idx: -1, q: '', hi: 0, top: 0, left: 0, crumbs: [] });

    // 树叶兜底：万一树没拉到（首次进图库直接点齿轮），用当前启用标签铺一层，至少能选
    const roots = computed(() => {
      const t = Array.isArray(props.tree) ? props.tree : [];
      if (t.length) return t;
      if (!props.activeTags.length) return [];
      return [{
        name: '启用标签', rel: '', count: props.activeTags.length,
        children: props.activeTags.map((n) => ({ name: n, rel: n, count: null, children: [] })),
      }];
    });
    function nodeOf(crumbs) {
      let list = roots.value;
      let cur = null;
      for (const c of crumbs) {
        cur = (list || []).find((n) => (n.rel || n.name) === (c.rel || c.name)) || null;
        if (!cur) return null;
        list = cur.children || [];
      }
      return cur;
    }
    // 搜索：整树拍平后按名字/路径模糊匹配，最多 50 条
    function flatMatch(q) {
      const lq = String(q).toLowerCase();
      const out = [];
      (function walk(ns) {
        for (const n of ns || []) {
          if (String(n.name || '').toLowerCase().includes(lq)
            || String(n.rel || '').toLowerCase().includes(lq)) out.push(n);
          if (n.children && n.children.length) walk(n.children);
        }
      })(roots.value);
      return out.slice(0, 50);
    }
    const pkKids = computed(() => {
      if (String(pk.q || '').trim()) return flatMatch(pk.q.trim());
      const cur = nodeOf(pk.crumbs);
      return cur ? (cur.children || []) : roots.value;
    });
    const pkCurName = computed(() => {
      const last = pk.crumbs[pk.crumbs.length - 1];
      return last ? last.name : '';
    });
    function closePicker() {
      pk.open = false;
      pk.idx = -1;
      pk.q = '';
      pk.hi = 0;
      pk.crumbs = [];
    }
    // 打开浮层：定位到当前行 chip 的正下方；下方放不下就翻到上方
    function openPicker(i, ev) {
      if (pk.open && pk.idx === i) { closePicker(); return; }
      pk.idx = i;
      pk.open = true;
      pk.q = '';
      pk.hi = 0;
      pk.crumbs = [];
      const it = draft.custom[i];
      // 该层已经选过：把面包屑还原到它的父级，方便顺着原路径改
      if (it && it.type === 'tag' && it.rel) {
        const segs = String(it.rel).split('/').filter(Boolean);
        let list = roots.value;
        const acc = [];
        for (let k = 0; k < segs.length - 1; k++) {
          const hit = (list || []).find((n) => n.name === segs[k]);
          if (!hit) break;
          acc.push({ name: hit.name, rel: hit.rel || hit.name });
          list = hit.children || [];
        }
        pk.crumbs = acc;
      }
      const el = ev && (ev.currentTarget || ev.target);
      if (el && el.getBoundingClientRect) {
        const r = el.getBoundingClientRect();
        const W = 440;
        const H = 336;
        pk.left = Math.max(8, Math.min(r.left, window.innerWidth - W - 12));
        let top = r.bottom + 6;
        if (top + H > window.innerHeight - 12) top = Math.max(12, r.top - H - 6);
        pk.top = top;
      }
    }
    // 选中一项：有子节点 = 分类，落成「整类层」（目录名就是这个分类名）
    function applyPick(node) {
      if (!node) return;
      const it = draft.custom[pk.idx];
      if (it) {
        it.type = 'tag';
        it.value = node.name;
        it.rel = node.rel || node.name;
        it.cat = !!(node.children && node.children.length);
      }
      closePicker();
    }
    function applyWhole() { applyPick(nodeOf(pk.crumbs)); }
    function enterNode(node) {
      if (!node || !(node.children && node.children.length)) return;
      pk.crumbs = pk.crumbs.concat([{ name: node.name, rel: node.rel || node.name }]);
      pk.q = '';
      pk.hi = 0;
    }
    function scrollHi() {
      nextTick(() => {
        const box = popRef.value && popRef.value.querySelector('.zhg-lkd-pop-list');
        const row = box && box.querySelectorAll('.zhg-lkd-pop-item')[pk.hi];
        if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
      });
    }
    function onDocDown(e) {
      if (!pk.open) return;
      const pop = popRef.value;
      if (pop && pop.contains(e.target)) return;
      // 点别的层的 chip 交给它自己的 click 去切换，不在这里先关
      if (e.target && e.target.closest && e.target.closest('.zhg-lkd-chip')) return;
      closePicker();
    }
    function onDocKey(e) {
      if (!pk.open) return;
      if (e.key === 'Escape') { e.stopPropagation(); closePicker(); return; }
      const n = pkKids.value.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); pk.hi = n ? (pk.hi + 1) % n : 0; scrollHi(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); pk.hi = n ? (pk.hi - 1 + n) % n : 0; scrollHi(); }
      else if (e.key === 'Enter') { e.preventDefault(); applyPick(pkKids.value[pk.hi]); }
      else if (e.key === 'Backspace' && !pk.q && pk.crumbs.length) { e.preventDefault(); pk.crumbs.pop(); }
    }
    onMounted(() => {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onDocKey, true);
    });
    onBeforeUnmount(() => {
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onDocKey, true);
    });

    // 每次打开都从 pref 深拷贝一份草稿，取消即丢弃；uid 只用于 v-for key，保存时剔除
    function reset() {
      draft.custom = (Array.isArray(props.link.custom) ? props.link.custom : []).map((it) => ({
        uid: 'L' + (++uidSeq),
        type: it && it.type === 'tag' ? 'tag' : 'text',
        value: String((it && it.value) || ''),
        rel: String((it && it.rel) || ''),
        cat: !!(it && it.cat),
      }));
      err.value = '';
      dragFrom.value = -1;
      dragTo.value = -1;
      closePicker();
    }
    watch(() => props.open, (v) => { if (v) reset(); });

    // 失效 = 这层是普通标签层、该标签确实存在于标签库、但现在没启用。
    // 整类层（cat）是结构层，不随启用标签变化，永远有效；
    // 手输一个库里没有的名字也不算失效，保存时会被规范化成文字层，当固定目录名用。
    function isBad(it) {
      if (!it || it.type !== 'tag' || it.cat) return false;
      const v = String(it.value || '').trim();
      if (!v) return false;
      return props.knownTags.includes(v) && !props.activeTags.includes(v);
    }
    const badCount = computed(() => draft.custom.filter(isBad).length);
    const preview = computed(() => {
      const segs = draft.custom.map((it) => String(it.value || '').trim()).filter(Boolean);
      if (!segs.length) return '（按时间戳自动命名）';
      return 'zhule_link / ' + segs.join(' / ');
    });

    function addLayer(type) {
      draft.custom.push({
        uid: 'L' + (++uidSeq), type: type === 'tag' ? 'tag' : 'text', value: '', rel: '', cat: false,
      });
    }
    function removeLayer(i) {
      if (pk.open && pk.idx === i) closePicker();
      draft.custom.splice(i, 1);
    }
    // 切类型：切到文字层就丢掉标签身份（不再是整类层），切回标签层则重选
    function toggleType(i) {
      const it = draft.custom[i];
      if (!it) return;
      it.type = it.type === 'tag' ? 'text' : 'tag';
      if (it.type === 'text') { it.cat = false; it.rel = ''; }
      if (pk.open && pk.idx === i) closePicker();
    }

    // ── 拖拽排序 ────────────────────────────────────────────────────────────
    function onDragStart(i, e) {
      dragFrom.value = i;
      dragTo.value = i;
      if (e && e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        try { e.dataTransfer.setData('text/plain', String(i)); } catch (_) { /* 老浏览器忽略 */ }
      }
    }
    function onDragOver(i) {
      if (dragFrom.value < 0) return;
      dragTo.value = i;
    }
    function onDragLeave(i) {
      if (dragTo.value === i) dragTo.value = -1;
    }
    function onDrop(i) {
      const from = dragFrom.value;
      dragFrom.value = -1;
      dragTo.value = -1;
      if (from < 0 || from === i) return;
      if (i < 0 || i >= draft.custom.length) return;
      const moved = draft.custom.splice(from, 1)[0];
      draft.custom.splice(i, 0, moved);
    }
    function onDragEnd() {
      dragFrom.value = -1;
      dragTo.value = -1;
    }

    function save(doExport) {
      err.value = '';
      const custom = draft.custom
        .map((it) => {
          const value = String(it.value || '').trim();
          let type = it.type === 'tag' ? 'tag' : 'text';
          let cat = false;
          if (type === 'tag' && value) {
            if (it.cat) cat = true;
            // 标签层填的却是个库里没有的名字：落盘时降级成文字层，它就只是个固定目录名
            else if (!props.activeTags.includes(value) && !props.knownTags.includes(value)) type = 'text';
          }
          return { type, value, rel: cat || type === 'tag' ? String(it.rel || '') : '', cat };
        })
        .filter((it) => it.value)
        .slice(0, 12);
      if (badCount.value > 0) {
        err.value = '还有 ' + badCount.value + ' 层标签已停用：换个标签 / 改成整类 / 改成文字层或删掉这一层';
        return;
      }
      if (doExport && !custom.length) {
        err.value = '至少要留一层，或者去设置页改成按时间 / 按过滤标签命名';
        return;
      }
      // 只交分层模板：目录与隔离符号在设置页配置，不经这里改动
      emit('saved', { custom });
      if (doExport) emit('export');
      emit('close');
    }

    return {
      draft, err, dragFrom, dragTo, badCount, preview, pk, popRef, pkKids, pkCurName,
      isBad, addLayer, removeLayer, toggleType, openPicker, closePicker,
      applyPick, applyWhole, enterNode, save,
      onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd,
    };
  },
  template: `
    <div v-if="open" class="zhg-lkd-mask" @mousedown.self="$emit('close')">
      <div class="zhg-lkd">
        <div class="zhg-lkd-head">
          <span class="zhg-lkd-title">{{ mode === 'export' ? '标签失效，先修分层再导出' : '导出子文件夹 · 自定义分层' }}</span>
          <button class="zhg-lkd-x" data-tip="关闭" @click="$emit('close')">✕</button>
        </div>
        <div class="zhg-lkd-body">
          <div class="zhg-lkd-lh">分层顺序（从上到下 = 由外到内，按住 ⠿ 拖动换顺序）</div>
          <div class="zhg-lkd-layers">
            <div v-for="(it, i) in draft.custom" :key="it.uid" class="zhg-lkd-layer"
                 :class="{ dragging: dragFrom === i, 'drag-over': dragTo === i && dragFrom !== i && dragFrom >= 0, bad: isBad(it) }"
                 @dragover.prevent="onDragOver(i)" @dragleave="onDragLeave(i)"
                 @drop.prevent="onDrop(i)">
              <span class="zhg-lkd-grip" draggable="true" data-tip="按住拖动换顺序"
                    @dragstart="onDragStart(i, $event)" @dragend="onDragEnd">⠿</span>
              <span class="zhg-lkd-idx">{{ i + 1 }}</span>
              <button class="zhg-lkd-type" :class="{ tag: it.type === 'tag' }"
                      data-tip="点击切换：标签层跟着启用的过滤标签走 / 文字层就是固定目录名"
                      @click="toggleType(i)">{{ it.type === 'tag' ? '标签' : '文字' }}</button>
              <button v-if="it.type === 'tag'" class="zhg-lkd-chip" :class="{ empty: !it.value }"
                      data-tip="点击选标签或整类分类（可逐级钻取、可搜索）" @click="openPicker(i, $event)">
                <span class="zhg-lkd-chip-nm">{{ it.value || '点这里选标签 / 整类…' }}</span>
                <span v-if="it.cat" class="zhg-lkd-chip-tag">整类</span>
                <span class="zhg-lkd-chip-cv">▾</span>
              </button>
              <input v-else class="zhg-lkd-input" v-model="it.value" spellcheck="false"
                     placeholder="固定目录名，如 出图">
              <span v-if="isBad(it)" class="zhg-lkd-bad">已停用</span>
              <button class="zhg-lkd-del" data-tip="删除这一层" @click="removeLayer(i)">✕</button>
            </div>
            <div v-if="!draft.custom.length" class="zhg-lkd-empty">还没有层：点下面加一层，第一层就是最外层文件夹</div>
          </div>
          <div class="zhg-lkd-add">
            <button class="btn zhg-mini" @click="addLayer('tag')">+ 标签层</button>
            <button class="btn zhg-mini" @click="addLayer('text')">+ 文字层</button>
            <span class="zhg-lkd-note">最多 12 层，空层保存时自动丢掉</span>
          </div>
          <div class="zhg-lkd-prev"><span class="zhg-lkd-k">预览</span><code>{{ preview }}</code></div>
          <div v-if="err" class="zhg-lkd-err">{{ err }}</div>
          <div v-else-if="badCount" class="zhg-lkd-err">{{ badCount }} 层标签已停用：换个标签 / 改成整类 / 改成文字层或删掉，否则这次不导出</div>
        </div>
        <div class="zhg-lkd-foot">
          <button class="btn zhg-mini" @click="$emit('close')">取消</button>
          <button class="btn zhg-mini" v-if="mode === 'cfg'" @click="save(false)">保存</button>
          <button class="btn zhg-mini zhg-rename-confirm" v-if="mode === 'export'"
                  :disabled="badCount > 0" @click="save(true)">保存并导出</button>
        </div>
      </div>

      <!-- 浮层气泡：点 chip 现建，定位在那一行正下方；点外部 / Esc 关闭 -->
      <div v-if="pk.open" ref="popRef" class="zhg-lkd-pop" :style="{ left: pk.left + 'px', top: pk.top + 'px' }"
           @mousedown.stop>
        <div class="zhg-lkd-pop-search">
          <input class="zhg-lkd-pop-input" v-model="pk.q" spellcheck="false"
                 placeholder="搜标签 / 分类名…（↑↓ 选，回车确定，Esc 关闭）" @input="pk.hi = 0">
          <span class="zhg-lkd-pop-esc">Esc</span>
        </div>
        <div v-if="!pk.q" class="zhg-lkd-pop-crumbs">
          <button class="zhg-lkd-crumb" @click="pk.crumbs = []">全部</button>
          <template v-for="(c, ci) in pk.crumbs" :key="c.rel + '_' + ci">
            <span class="zhg-lkd-crumbsep">/</span>
            <button class="zhg-lkd-crumb" :class="{ cur: ci === pk.crumbs.length - 1 }"
                    @click="pk.crumbs = pk.crumbs.slice(0, ci + 1)">{{ c.name }}</button>
          </template>
        </div>
        <div v-if="!pk.q && pk.crumbs.length" class="zhg-lkd-pop-whole" @click="applyWhole">
          <span class="ok">✓</span> 就用这一层：<b>{{ pkCurName }}</b>
          <span class="hint">整类（子分类全算进来）</span>
        </div>
        <div class="zhg-lkd-pop-list">
          <div v-for="(n, ni) in pkKids" :key="(n.rel || n.name) + '_' + ni" class="zhg-lkd-pop-item"
               :class="{ hi: ni === pk.hi }" @mouseenter="pk.hi = ni" @click="applyPick(n)">
            <span class="ic">{{ n.children && n.children.length ? '▸' : '·' }}</span>
            <span class="nm">
              <b>{{ n.name }}</b>
              <i v-if="n.children && n.children.length">{{ n.children.length }} 个子分类</i>
            </span>
            <span v-if="n.count !== null && n.count !== undefined" class="cnt">{{ n.count }}</span>
            <button v-if="n.children && n.children.length" class="enter" data-tip="往下钻一层"
                    @click.stop="enterNode(n)">›</button>
          </div>
          <div v-if="!pkKids.length" class="zhg-lkd-pop-empty">没有匹配的标签 / 分类</div>
        </div>
        <div class="zhg-lkd-pop-foot">
          <span>点整行 = 直接选这一项</span>
          <span>行右侧 › = 往下钻</span>
        </div>
      </div>
    </div>
  `,
};
