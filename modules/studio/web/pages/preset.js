/**
 * 保存方案（preset）数据层：词库运行时状态 ↔ 落库 slots 单序列。
 *
 * 设计要点：
 * - 运行时仍是 data.selected（占位符+词条混排）+ data.randomPools（旁挂池）双数组，本文件不碰运行时；
 * - 落库形态是 slots 单序列，只在「保存 / 载入」两个瞬间跑 toPayload / applyPayload；
 * - 词条只存 id，不存名字：名字留在词库里查，词条被删则方案里该槽位失效（计数提示，不静默吞）；
 * - 池的 chip 存 chipId（有 id），整个大类池只能存 tab 名——现有 randomPools 就是这么记的，
 *   tab 是分类壳不是词条身份，不值得为它单开一套 id 反查。
 *
 * payload 结构：
 * {
 *   slots: [
 *     { t:'item', src:'p', id, chance, lock },              // 词库词条
 *     { t:'item', src:'c', id, chance, lock },              // 图库自定义标签（custom_tag.id，与 prompt.id 不同空间）
 *     { t:'pool', tab:'发型', mode:'random', chance },       // 整个大类
 *     { t:'pool', tab:'发型', chip:91, mode:'traverse', chance }, // 子分类
 *     { t:'pool', list:[1295, 1283], mode:'traverse', chance }    // 凝结池
 *   ],
 *   ref: { path: '发型/zhule_2061.png' } | null             // 图库来源方案的参考图（只存路径，不复制文件）
 * }
 */

export const PRESET_KEY = 'zhule_preset_v1';

/** 概率归一：非法值按 100（必出）算，与词库侧 normalizeChance 的口径一致 */
export const clampChance = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, Math.round(n)));
};

/**
 * 构建 id -> { tab, relPath, name, id } 索引，供载入时按 id 还原词条显示信息。
 * @param {Object} bankData 词库全量数据 { tab: [card, ...] }
 */
export const buildBankIndex = (bankData) => {
  const idx = new Map();
  Object.keys(bankData || {}).forEach((tab) => {
    (bankData[tab] || []).forEach((card) => {
      if (!card || card.id === undefined || card.id === null || card.id === '') return;
      const key = String(card.id);
      if (idx.has(key)) return; // 同名不同类撞 id 时不覆盖先到的
      idx.set(key, { tab: card.tab || tab, relPath: card.relPath || '', name: card.name || '', id: card.id });
    });
  });
  return idx;
};

/**
 * 运行时状态 → payload。
 * @returns {{ slots: Array, dropped: number }} dropped = 因缺 id 而没存进去的项数
 */
export const toPayload = (selected, randomPools) => {
  const slots = [];
  let dropped = 0;

  (selected || []).forEach((s) => {
    if (!s) return;
    if (s._ph) return; // 占位符由 pools 里的 pool 槽位表达，不重复落库
    const id = s.id;
    if (id === undefined || id === null || id === '') { dropped += 1; return; }
    slots.push({
      t: 'item',
      src: s.src === 'c' ? 'c' : 'p',
      id,
      chance: clampChance(s.chance),
      lock: s.lock ? 1 : 0,
    });
  });

  (randomPools || []).forEach((p) => {
    if (!p) return;
    const mode = p.traverse ? 'traverse' : 'random';
    const chance = clampChance(p.chance);
    if (p.kind === 'list') {
      const list = (p.items || [])
        .map((it) => (it ? it.id : null))
        .filter((id) => id !== undefined && id !== null && id !== '');
      if (!list.length) { dropped += 1; return; }
      slots.push({ t: 'pool', list, mode, chance });
      return;
    }
    if (p.kind === 'chip') {
      if (p.chipId === undefined || p.chipId === null || p.chipId === '') { dropped += 1; return; }
      slots.push({ t: 'pool', tab: p.tab || '', chip: p.chipId, mode, chance });
      return;
    }
    if (!p.tab) { dropped += 1; return; }
    slots.push({ t: 'pool', tab: p.tab, mode, chance });
  });

  return { slots, dropped };
};

/**
 * payload → 运行时状态（整体替换，绝不往当前状态里合并）。
 * @param {Object} payload { slots, ref }
 * @param {Object} ctx { bankIndex, chipName }
 * @returns {{ selected: Array, randomPools: Array, missing: number }}
 *          missing = 因词条/分类已不存在而被跳过的槽位数
 */
export const applyPayload = (payload, ctx) => {
  const bankIndex = (ctx && ctx.bankIndex) || new Map();
  const chipName = (ctx && ctx.chipName) || (() => '');
  const slots = (payload && Array.isArray(payload.slots)) ? payload.slots : [];
  const selected = [];
  const randomPools = [];
  let missing = 0;
  const seenItem = new Set();

  const hitOf = (id) => bankIndex.get(String(id));

  slots.forEach((sl) => {
    if (!sl || !sl.t) return;

    if (sl.t === 'item') {
      const hit = hitOf(sl.id);
      if (!hit) { missing += 1; return; }
      const key = String(sl.id);
      if (seenItem.has(key)) return; // 同一条词条只保留一次
      seenItem.add(key);
      selected.push({
        tab: hit.tab,
        relPath: hit.relPath,
        id: hit.id,
        name: hit.name,
        chance: clampChance(sl.chance),
        lock: !!sl.lock,
      });
      return;
    }

    if (sl.t !== 'pool') return; // 未知类型直接跳过，向后兼容新增槽位
    const traverse = sl.mode === 'traverse';
    const chance = clampChance(sl.chance);

    // 凝结池：成员按 id 还原
    if (Array.isArray(sl.list)) {
      const items = [];
      sl.list.forEach((id) => {
        const hit = hitOf(id);
        if (!hit) { missing += 1; return; }
        items.push({ tab: hit.tab, relPath: hit.relPath, id: hit.id, name: hit.name });
      });
      if (!items.length) return;
      randomPools.push({
        kind: 'list',
        poolId: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        tab: '',
        path: [],
        display: '凝结' + items.length + '项',
        items,
        traverse,
        chance,
      });
      return;
    }

    // 子分类池：chipId 有 id，显示名回查
    if (sl.chip !== undefined && sl.chip !== null && sl.chip !== '') {
      randomPools.push({
        kind: 'chip',
        tab: sl.tab || '',
        chipId: sl.chip,
        display: chipName(sl.chip) || '',
        traverse,
        chance,
      });
      return;
    }

    // 整个大类池：只有 tab 名
    if (!sl.tab) { missing += 1; return; }
    randomPools.push({ kind: 'tab', tab: sl.tab, display: sl.tab, traverse, chance });
  });

  return { selected, randomPools, missing };
};

/** 方案自身字段（id 用字典序即时间序，省掉 created_at） */
export const newPresetId = () => 'P' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

export const loadPresets = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESET_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((p) => p && p.id && p.payload) : [];
  } catch (e) {
    console.warn('zhule: 方案读取失败，按空列表处理', e);
    return [];
  }
};

export const savePresets = (list) => {
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(list || []));
    return true;
  } catch (e) {
    console.warn('zhule: 方案保存失败（localStorage/序列化）:', e);
    return false;
  }
};

/** 新增或按 id 覆盖，返回新的完整列表 */
export const upsertPreset = (preset) => {
  const list = loadPresets();
  const i = list.findIndex((p) => p.id === preset.id);
  if (i >= 0) list[i] = preset; else list.push(preset);
  savePresets(list);
  return list;
};

export const removePreset = (id) => {
  const list = loadPresets().filter((p) => p.id !== id);
  savePresets(list);
  return list;
};

/** 方案摘要文案：给列表行用，避免每次渲染都去遍历 payload */
export const presetSummary = (preset) => {
  const slots = (preset && preset.payload && preset.payload.slots) || [];
  const items = slots.filter((s) => s && s.t === 'item').length;
  const pools = slots.filter((s) => s && s.t === 'pool').length;
  const parts = [];
  if (items) parts.push(items + ' 标签');
  if (pools) parts.push(pools + ' 池');
  return parts.join(' + ') || '空方案';
};
