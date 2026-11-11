import { reactive, computed, onMounted, onBeforeUnmount, ref, watch, nextTick } from 'vue';
import { useDeleteConfirm, DeleteDialog } from './deleteConfirm.js';
import { useMarqueeSelect } from './marqueeSelect.js';

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
          <button class="btn" @click="singleRandom" data-tip="点一下把每个池子的当前答案摇定：随机池各抽 1 条填入黄色标签（可再点重抽）">🎲</button>
          <button class="btn icon-btn" @click="clearRandomPools" data-tip="清空所有池子">🗑</button>
          <div class="col-ctrl">
            <label>每行</label>
            <button class="col-btn" @click="changeColumns(-1)">−</button>
            <span class="col-num">{{ pref.columns }}</span>
            <button class="col-btn" @click="changeColumns(1)">+</button>
          </div>
        </div>

        <div class="bank-tabs-row">
        <div class="tabs">
          <!-- 新建大类统一走右键菜单；仅在没有大类时留一个兜底占位，避免无处右键 -->
          <div v-if="!tabs.length" class="tab tab-void"
               data-tip="还没有大类，右键新建" @contextmenu.prevent="openAddTab">（无大类）右键新建</div>
          <div v-for="name in tabs" :key="name"
               class="tab"
               :class="{active: data.activeTab === name, 'in-pool': isTabTraversePool(name), 'in-pool-random': isTabInPool(name) && !isTabTraversePool(name), 'cat-picked': isTabCatPicked(name), 'has-selected': tabHasSelected(name)}"
               draggable="true"
               :data-tip="'左键：切到此大类　Ctrl/⌘+左键：把整个大类下的词条整类选中（可连续点多选，再点一次取消）'"
               @click="onTabClick($event, name)"
               @contextmenu.prevent="openCatMenu($event, 'tab', name)"
               @dragstart="onTabDragStart($event, name)"
               @dragover="onTabDragOver($event, name)"
               @drop.prevent="onTabDrop"
               @dragend="onTabDragEnd">{{ tabLabel(name) }}<span v-if="isCatMuted('tab', name)" class="chip-mute">🔇</span></div>
        </div>
          <!-- 方案A · 分类栏右侧放大镜：平时只有一个图标，点一下才在原位展开成搜索框；筛选档 / 全库档开关放在框内右侧 -->
          <div class="wb-search" :class="{ 'is-open': searchOpen, 'is-search': searching }">
            <button v-if="!searchOpen" class="wb-search-trigger" :data-tip="searchTip"
                    @click="openSearch">🔍</button>
            <div v-else class="wb-search-box" :class="{ 'is-search': searching, 'closing': searchClosing }">
              <span class="wb-search-ico">🔍</span>
              <input ref="searchInputEl" class="wb-search-input" v-model="searchText"
                     :placeholder="searchPh"
                     @keydown.esc.stop.prevent="onSearchEsc"
                     @blur="onSearchBlur" />
              <!-- × 与输入的字平级，紧跟在词尾；范围开关贴框的右端 -->
              <button v-if="searchText" class="wb-search-x" data-tip="清空搜索词"
                      @click="clearSearch">×</button>
              <button class="wb-scope-btn" :class="{ all: searchScope === 'all' }"
                      :data-tip="searchScope === 'all' ? '全库：忽略 tab 与分类筛选，点此切回「筛选」' : '筛选：只在当前 tab + 已选分类里搜，点此切到「全库」'"
                      @click="toggleSearchScope">{{ searchScope === 'all' ? '全库' : '筛选' }}</button>
            </div>
          </div>
        </div>

        <div class="bank-body">
        <div class="chips-wrap">
          <div class="chips-head">
            <span class="chips-title">筛选分类</span>
            <button class="chips-toggle" @click="toggleChips"
                    :data-tip="chipsCollapsed ? '展开分类区' : '收起分类区'">
              {{ chipsCollapsed ? '⏷ 展开' : '⏶ 收起' }}
            </button>
            <span class="chips-count">{{ listCountLabel }}</span>
          </div>
          <div class="chips-container" :style="{ height: chipsHeightCss }">
            <div v-for="(line, depth) in chipLines" :key="depth" class="chips-line">
              <div class="chip-depth" :data-tip="depth === 0 ? '一级分类（右键分类可新建 / 编辑）' : '第 ' + (depth + 1) + ' 级分类'">{{ depth === 0 ? '大类' : (depth + 1) + '级' }}</div>
              <div v-if="line.length" class="chip clear" :class="{active: !getSelections()[depth].length}"
                   @click="clearChip(depth)">全部</div>
              <!-- 分类 chip 自带 { id, parentId, name }：选中/拖拽/池/右键全按节点 id，不再有路径 key -->
              <div v-for="chip in line" :key="chip.id"
                   class="chip"
                   :class="[chipThemeClass, {active: getSelections()[depth].includes(chip.id), 'in-pool': isChipTraversePool(chip), 'in-pool-random': isChipInPool(chip) && !isChipTraversePool(chip), 'cat-picked': isChipCatPicked(chip)}]"
                   :style="chipStyle(chip.name)"
                   draggable="true"
                   :data-tip="'左键：筛选此分类　Ctrl/⌘+左键：把整个分类（含子分类）的词条整类选中（可连续点多选，再点一次取消）'"
                   @click="onChipClick($event, depth, chip)"
                   @contextmenu.prevent="openCatMenu($event, 'chip', chip, depth)"
                   @dragstart="onChipDragStart($event, depth, chip)"
                   @dragover="onChipDragOver($event, depth, chip)"
                   @drop.prevent
                   @dragend="onChipDragEnd">{{ chip.name }}<span v-if="isCatMuted('chip', chip.id)" class="chip-mute">🔇</span></div>
            </div>
          </div>
          <div v-show="!chipsCollapsed" class="chips-resize" data-tip="拖拽调整高度"
               @pointerdown="onChipsResizeDown"></div>
        </div>

        <div class="main">
          <!-- 框选状态条：只在有框选时出现，给计数与取消入口（凝结按钮统一在卡片右键菜单里） -->
          <div class="pick-bar" v-if="pickSel.size">
            <span class="pick-count">已选 <b>{{ pickSel.size }}</b> 项<span v-if="catPickSel.size" class="pick-cat">（含 {{ catPickSel.size }} 个整类分类）</span></span>
            <span class="pick-tip">Ctrl+左键点分类＝整类全选，点卡片＝单条增删；选完凝结成池</span>
            <button class="btn pick-condense" @click="onCardCondense(true)">∞ 凝结为遍历池</button>
            <button class="btn pick-condense" @click="onCardCondense(false)">🎲 凝结为随机池</button>
            <button class="btn pick-clear" @click="clearPick">取消选择</button>
          </div>
          <div class="grid" ref="gridEl" :style="{ gridTemplateColumns: 'repeat(' + pref.columns + ', 1fr)' }"
               @pointerdown="onGridPointerDown">
            <div v-if="!listFiles.length" class="empty">{{ emptyText }}</div>
            <div v-for="file in visibleFiles" :key="(file.tab || '') + '/' + file.relPath"
                 class="card image" :data-rel="file.relPath" :data-tab="file.tab || ''"
                 :class="{
                   selected: isFileSelected(file),
                   'pick-sel': isPicked(file),
                   muted: !!file.mute,
                   'zhule-source': drag.active && drag.sourceType === 'card' && drag.sourceRelPath === file.relPath,
                   'drop-target': drag.hoverCardRelPath === file.relPath
                 }"
                 @pointerdown="onCardPointerDown($event, file)"
                 @contextmenu.prevent="openCardMenu($event, file)">
              <div class="card-thumb-wrap">
                <!-- 变体组角标：整组只出这一张卡，卡面只留 ‹ 序号/总数 › 做翻页。
                     组名、新建变体都挪进右键菜单，避免卡面挤成一条工具栏。
                     单条（_vgCount<=1）什么角标都不出现，退化成普通卡片。 -->
                <div class="vg-nav" v-if="file._vgCount > 1 && !pref.hideVgNav" @pointerdown.stop
                     :data-tip="(file._vgTitle ? '变体组「' + file._vgTitle + '」· ' : '') + '同一提示词的 ' + file._vgCount + ' 个变体（' + (file._vgIdx + 1) + '/' + file._vgCount + '）· 右键可呼出胶片条'">
                  <button class="vg-prev" @click.stop="vgStep(file, -1)">‹</button>
                  <span class="vg-num">{{ file._vgIdx + 1 }}/{{ file._vgCount }}</span>
                  <button class="vg-next" @click.stop="vgStep(file, 1)">›</button>
                </div>
                <!-- 左上角徽标栈：排除/负面按需出现。
                     多变体不做额外标记——卡名本身已按「组名#变体名」分两段着色，足以识别。 -->
                <div class="thumb-badges">
                  <div class="thumb-badge ov" v-if="(file.override || '').trim()" data-tip="已配置排除词：只删「别的词条」里命中的提示词段，不删自己">排除</div>
                  <div class="thumb-badge ng" v-if="(file.neg || '').trim()" data-tip="已配置负面提示词：该词条被选中时并入负面输出">负面</div>
                </div>
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
                <div class="thumb-enter" v-if="!hideCardIcons" data-tip="进入详情页" @click.stop="goToGallery(file)">→</div>
                <div class="thumb-zoom" v-if="!hideCardIcons" data-tip="放大预览" @click.stop="zoomCardImage(file)">🔍</div>
                <div class="thumb-del" data-tip="删除当前参考图" @click.stop="askDeleteRef(file)" v-if="!hideCardIcons && file.images && file.images.length">🗑</div>
                <!-- 参考图翻页条：默认压在最下面的 42px。
                     若这张卡同时有变体切换框（vg-nav 在下），则整体上移一档，两者各占一层不打架；
                     隐藏变体切换框时自动落回原位。 -->
                <div class="thumb-nav" :class="{ 'thumb-nav-up': file._vgCount > 1 && !pref.hideVgNav }"
                     @pointerdown.stop v-if="file.images && file.images.length > 1">
                  <button @click.stop="prevImage(file)">‹</button>
                  <button class="dice" @click.stop="randomImage(file)">🎲</button>
                  <button @click.stop="nextImage(file)">›</button>
                </div>
                <!-- 左侧竖排操作：静音 / 删除 / 编辑 / 上传参考图（悬停显现，永不挤压名字） -->
                <div class="card-actions" v-if="!hideCardIcons">
                  <button class="card-act act-mute" :class="{on: !!file.mute}"
                          :data-tip="file.mute ? '已静音（Mute）：自动选词跳过它，手动点选仍可用（点击恢复）' : '静音（Mute）：不参与随机池抽词与遍历穷举等自动选词，仅手动点选时可用'"
                          @pointerdown.stop @click.stop="toggleMute(file)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
                         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M3 3l18 18"/>
                      <path d="M10.6 5.2A10.6 10.6 0 0 1 12 5c5 0 9 4.4 9 7 0 .9-.8 2.3-2.2 3.6"/>
                      <path d="M6.2 6.9C3.9 8.4 3 10.3 3 12c0 2.6 4 7 9 7 1.6 0 3-.5 4.2-1.2"/>
                      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>
                    </svg>
                  </button>
                  <button class="card-act act-del" data-tip="删除词条"
                          @pointerdown.stop @click.stop="askDeleteWord(file)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
                         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M4 7h16"/>
                      <path d="M9.5 7V4.8h5V7"/>
                      <path d="M6.5 7l.9 12.2h9.2L17.5 7"/>
                      <path d="M10.4 10.6v5.8M13.6 10.6v5.8"/>
                    </svg>
                  </button>
                  <button class="card-act act-edit" data-tip="编辑词条"
                          @pointerdown.stop @click.stop="openEdit(file)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
                         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M4 20h4.2L19 9.2a1.6 1.6 0 0 0 0-2.3l-1.9-1.9a1.6 1.6 0 0 0-2.3 0L4 15.8V20z"/>
                      <path d="M13.9 6.1l4 4"/>
                    </svg>
                  </button>
                  <button class="card-act act-img" data-tip="上传参考图（优先展示）"
                          @pointerdown.stop @click.stop="openUploadRef(file)">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
                         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <rect x="3" y="4.5" width="18" height="15" rx="2.5"/>
                      <path d="M12 15.6V9"/>
                      <path d="M9.1 11.9L12 9l2.9 2.9"/>
                    </svg>
                  </button>
                </div>
                <!-- 底部压暗渐变 + 名字叠于图上；全库搜索时名字上方多一行真实分类链路 -->
                <span class="card-vg" v-if="cardGroupBadge(file)"
                      :data-tip="'这张是变体卡，属于「' + cardGroupBadge(file) + '」组'">{{ cardGroupBadge(file) }}</span>
                <div class="card-caption" :class="{ 'has-path': showCardTab(file) }">
                  <span class="card-path" v-if="showCardTab(file)"
                        :data-tip="'所在分类：' + cardTabLabel(file)">{{ cardTabLabel(file) }}</span>
                  <span class="card-name" :data-tip="fullNameOf(file)">{{ cardDisplayName(file) }}</span>
                  <span class="thumb-count" v-if="file.images && file.images.length">{{ getImgIdx(file) + 1 }}/{{ file.images.length }}</span>
                </div>
              </div>
            </div>
          </div>
          <div v-if="pageCount > 1" class="pager"
               style="display:flex;align-items:center;justify-content:center;gap:6px;padding:12px 0;">
            <button class="btn" :disabled="pageIndex <= 0" @click="goPrevPage">‹ 上一页</button>
            <button v-for="(p, i) in pageNumbers" :key="i" class="btn pager-num"
                    :class="{active: p === pageIndex}" :disabled="p < 0"
                    @click="goPage(p)">{{ p < 0 ? '…' : p + 1 }}</button>
            <button class="btn" :disabled="pageIndex >= pageCount - 1" @click="goNextPage">下一页 ›</button>
            <span style="color:var(--text-3);font-size:12px;">第 {{ pageIndex + 1 }}/{{ pageCount }} 页 · 共 {{ viewCards.length }} 张</span>
          </div>
        </div>
        </div>

        <div class="bottom">
          <div class="selected-header">
            <span class="sel-title">已选 <span class="selected-count">{{ data.selected.length }}</span> 项</span>
            <!-- 已选标签直接排在这一行：右侧的收起/清空/次数/运行永远固定可见，不被标签挤走 -->
            <div class="selected-list"
                 :class="{'drag-active': drag.hoverSide === 'selList', 'is-collapsed': selectedCollapsed}"
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
                <span>{{ selDisplayName(item) }}</span>
                <span v-if="item._ph" class="ph-badge" title="黄色分类标签：随机抽取结果绑定显示在本标签内">♻</span>
                <!-- 变体组标签徽标：🔒 锁当前变体 / 🎲 每次随机 / ∞ 轮着遍历；点一下循环切换 -->
                <span v-if="vgStateOf(item)"
                      class="vg-tag"
                      :class="'mode-' + vgStateOf(item).mode"
                      :title="vgTagTip(item)"
                      @pointerdown.stop
                      @click.stop="vgCycleMode(item)">{{ vgTagLabel(item) }}</span>
                <span class="close" @pointerdown.stop="removeSelected(idx)">×</span>
              </div>
            </div>
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
          <!-- 预览：展示拼接后的最终结果（含父级分类继承），负面提示词一键折叠/展开 -->
          <div class="preview" v-show="!selectedCollapsed" :class="{'random-mode': data.randomPools.length > 0}">
            <span class="pv-text">{{ previewText }}</span>
            <button type="button" class="pv-neg-toggle" :class="{on: pref.showNegPreview}" @click="toggleNegPreview"
                    :data-tip="pref.showNegPreview ? '收起负面提示词预览' : '展开负面提示词预览'">负面 {{ pref.showNegPreview ? '⏶' : '⏷' }}</button>
          </div>
          <div class="preview neg" v-show="!selectedCollapsed && pref.showNegPreview"
               :class="{'random-mode': data.randomPools.length > 0}">
            <span class="pv-text">{{ previewNegText || '（无）' }}</span>
          </div>
        </div>
      </template>

      <!-- 分类右键菜单：首项「编辑分类」，其余为池三态与新建 -->
      <div v-if="catMenu.open" class="ctx-layer" @pointerdown.self="closeCatMenu" @contextmenu.prevent.self="closeCatMenu">
        <div class="ctx-menu" :style="{ left: catMenu.x + 'px', top: catMenu.y + 'px' }">
          <!-- 标题行右侧挂数量角标：分类项数从菜单项里提出来，菜单项只留纯动词，避免每项尾巴都拖一串括号 -->
          <div class="ctx-title">
            <span class="ctx-title-text">{{ catMenu.title }}</span>
            <span class="ctx-count" :class="{ empty: catMenu.fileCount <= 0 }" v-if="catMenu.fileCount !== -1">{{ catMenu.fileCount }} 项</span>
            <span class="ctx-count empty" v-else>未加载</span>
          </div>
          <button type="button" class="ctx-item primary" @pointerdown.stop @click="onCtxEditCategory">✎ 编辑分类</button>
          <button type="button" class="ctx-item" :class="{ on: catMenu.muted }" @pointerdown.stop @click="toggleCatMute">
            {{ catMenu.muted ? '🔊 恢复（取消静音）' : '🔇 静音（含其下全部词条）' }}
          </button>
          <div class="ctx-sep"></div>
          <button type="button" class="ctx-item" :class="{ on: catMenu.pool === 'all' }"
                  @pointerdown.stop @click="onCtxPool('all')">🚫 不进池</button>
          <button type="button" class="ctx-item" :class="{ on: catMenu.pool === 'random' }"
                  @pointerdown.stop @click="onCtxPool('random')">🎲 随机池</button>
          <button type="button" class="ctx-item" :class="{ on: catMenu.pool === 'traverse' }"
                  @pointerdown.stop @click="onCtxPool('traverse')">∞ 遍历池</button>
          <div class="ctx-sep"></div>
          <!-- 池四态：项数统一显示在标题右上角角标里，这里只留动词。
               「选中」等价于 Ctrl/⌘+左键点该分类（整类、含子分类），与卡片框选共用 pickSel 可叠加多选，
               想成池再走状态条的 🎲/∞ 凝结按钮——与下面的「遍历池/随机池」不重复：
               那三项是「这个分类整体作为一个池」的常驻设定，「选中」是一次性取词条进已选集合。 -->
          <button type="button" class="ctx-item" :class="{ on: catMenu.catPicked }"
                  :data-tip="catMenu.catPicked
                    ? '把该分类（含全部子分类）从已选集合里整类剔除，与 Ctrl/⌘+左键再点一次等价'
                    : '等价于按住 Ctrl/⌘ 左键点这个分类：把它连同所有子分类的词条整批加入已选，之后还能继续多选别的分类，最后统一凝结'"
                  @pointerdown.stop @click="onCtxCatPick">
            {{ catMenu.catPicked ? '☑ 取消选中' : '☑ 选中' }}
          </button>
          <div class="ctx-sep"></div>
          <!-- 分类 ⇄ 变体 互转：两者本质同构，只差 type 一位。
               聚拢后该分类自己变成 type=entry 的变体组节点（它就是组名），其下词条成为各变体；
                卡片右键「转为分类」可原路拆回（type 改回 category，各变体平铺）。 -->
          <button type="button" class="ctx-item" :class="{ disabled: !catMenu.canToVg }" v-if="catMenu.toVgShown"
                  :disabled="!catMenu.canToVg"
                  :data-tip="catMenu.canToVg ? ('把「' + catMenu.name + '」整个分类聚拢成一张变体卡：分类从左侧树里消失、自己当组名，其下词条成为同组的各变体（之后可在卡片右键原路拆回分类）') : catMenu.toVgWhy"
                  @pointerdown.stop @click="catMenu.canToVg && onCtxToVg()">
            🗂 聚拢成变体卡（分类 → 变体）
          </button>
          <div class="ctx-sep"></div>
          <button type="button" class="ctx-item" @pointerdown.stop @click="onCtxAddChild">＋ 新建子分类</button>
          <button type="button" class="ctx-item" @pointerdown.stop @click="onCtxAddCard">＋ 新建提示词</button>
          <button type="button" class="ctx-item" v-if="catMenu.kind === 'tab'"
                  @pointerdown.stop @click="onCtxAddTab">＋ 新建大类</button>
          <div class="ctx-sep"></div>
          <!-- 删除分类：连同其下所有子分类与词条（软删，可恢复）。大类 Tab 根不提供删除（后端保护，防止误删整库） -->
          <button type="button" class="ctx-item danger" :class="{ disabled: catMenu.kind === 'tab' }"
                  :disabled="catMenu.kind === 'tab'"
                  :data-tip="catMenu.kind === 'tab' ? '大类（Tab 根）不可删除' : '连同其下所有子分类与词条一并删除（可恢复）'"
                  @pointerdown.stop @click="onCtxDeleteCategory">🗑 删除该分类</button>
        </div>
      </div>

      <!-- 词库卡片右键菜单：卡片原图标功能的完整复制（左右切换与骰子仍留在卡片上） -->
      <div v-if="cardMenu.open" class="ctx-layer" @pointerdown.self="closeCardMenu" @contextmenu.prevent.self="closeCardMenu">
        <div class="ctx-menu" :style="{ left: cardMenu.x + 'px', top: cardMenu.y + 'px' }">
          <div class="ctx-title">
            <span class="ctx-title-text">{{ cardMenu.title }}</span>
            <!-- 多选态（框选/多张选中）右击时把选中张数挂到标题右侧，菜单项里就不再各自拖一串「N 项」 -->
            <span class="ctx-count" v-if="cardMenu.picked && cardMenu.pickCount > 1">{{ cardMenu.pickCount }} 项</span>
          </div>
          <!-- 变体组卡片：右键即可把该卡的全部变体摊成一条胶片条（方案 B），点哪一帧就切到哪一版 -->
          <button type="button" class="ctx-item vg-strip-entry" v-if="cardMenu.vgCount > 1"
                  @pointerdown.stop @click="onCardVgStrip">
            🎞 变体胶片条（{{ cardMenu.vgCount }} 版）
          </button>
          <!-- 变体组卡片：就地新建一个变体（落在同一分类下，自动成为组里的最新一版） -->
          <button type="button" class="ctx-item vg-add-entry" v-if="cardMenu.isVg"
                  @pointerdown.stop @click="onCardNewVersion">
            ＋ 新建变体（并入本组）
          </button>
          <!-- 变体组卡片：改组名 = 改这个变体组节点自己的 name；各变体只存短名，显示前缀自动跟着变 -->
          <button type="button" class="ctx-item vg-rename-entry" v-if="cardMenu.isVg"
                  @pointerdown.stop @click="onCardVgRename">
            ✎ 改变体组名（{{ cardMenu.vgTitle || '本组' }}）
          </button>
          <!-- 变体组 ⇄ 分类只差 type 一位：转过去后组名当分类名，各变体成为该分类下的独立卡片。
               各变体库里存的一直是短名，「组名#」前缀由渲染层拼，所以转换不需要动任何名字 -->
          <button type="button" class="ctx-item vg-to-cat-entry" v-if="cardMenu.canToCategory"
                  :data-tip="'把这张变体卡还原成分类：组名当分类名，组内各变体平铺成独立卡片（名字本来只存短名，无需摘前缀）'"
                  @pointerdown.stop @click="onCardToCategory">
            🗂 转为分类（变体 → 分类）
          </button>
          <div class="ctx-sep" v-if="cardMenu.vgCount > 1 || cardMenu.isVg"></div>
          <!-- 该卡片在框选集合里时，先把「凝结」两项摆在最前（Ctrl+左键单独补选也能触发） -->
          <template v-if="cardMenu.picked">
            <button type="button" class="ctx-item" @pointerdown.stop @click="onCardCondense(true)">
              ∞ 凝结为遍历池
            </button>
            <button type="button" class="ctx-item" @pointerdown.stop @click="onCardCondense(false)">
              🎲 凝结为随机池
            </button>
            <!-- 多选态：新建一个变体组（独立组头），把这批提示词整批挂上去；父级不一致会被拦下 -->
            <button type="button" class="ctx-item" @pointerdown.stop @click="onCardVgJoin">
              🗂 聚拢成变体组…
            </button>
            <div class="ctx-sep"></div>
          </template>
          <button type="button" class="ctx-item primary" @pointerdown.stop @click="onCardEdit">✎ 编辑词条</button>
          <button type="button" class="ctx-item" @pointerdown.stop @click="onCardMute">
            {{ cardMenu.muted ? '🔊 恢复（取消静音）' : '🔇 静音（不参与自动选词）' }}
          </button>
          <!-- 提示词卡片：新建一个独立组头，再把自己挂到这个新组头下（不借用自己当组头）；多选时整批一起挂 -->
          <button type="button" class="ctx-item" v-if="!cardMenu.isVg && cardMenu.canVg && !cardMenu.picked"
                  @pointerdown.stop @click="onCardVgJoin">
            🗂 聚拢成变体组…（弹框输组名）
          </button>
          <button type="button" class="ctx-item" @pointerdown.stop @click="onCardUpload">🖼 上传参考图（优先展示）</button>
          <button type="button" class="ctx-item danger" @pointerdown.stop @click="onCardDeleteWord">🗑 删除词条</button>
          <div class="ctx-sep"></div>
          <button type="button" class="ctx-item" @pointerdown.stop @click="onCardGallery">→ 进入详情页</button>
          <button type="button" class="ctx-item" @pointerdown.stop @click="onCardZoom">🔍 放大预览</button>
          <button type="button" class="ctx-item danger" v-if="cardMenu.hasImages"
                  @pointerdown.stop @click="onCardDeleteRef">🗑 删除当前参考图</button>
        </div>
      </div>

      <!-- 变体胶片条（方案 B）：从卡片右键菜单呼出，把该变体组全部变体横向摊开，
           点一帧 = 把卡片切到该变体（与卡内 ‹ › 翻页改的是同一个游标，两处始终同步）。 -->
      <div v-if="vgStrip.open" class="vg-strip-layer" @pointerdown.self="closeVgStrip">
        <div class="vg-strip">
          <div class="vg-strip-head">
            <span class="vg-strip-title">{{ vgStrip.title }}</span>
            <span class="vg-strip-count">{{ vgStrip.idx + 1 }} / {{ vgStrip.versions.length }}</span>
            <button type="button" class="vg-strip-close" @click="closeVgStrip">×</button>
          </div>
          <div class="vg-strip-body">
            <div v-for="(v, i) in vgStrip.versions" :key="v.relPath + '#' + i"
                 class="vg-frame" :class="{ active: i === vgStrip.idx, muted: v.mute }"
                 :data-tip="fullNameOf(v)" @click="pickVgStrip(i)">
              <div class="vg-frame-img">
                <img v-if="v.images && v.images.length" :src="imageUrl(v.images[0])" :alt="v.name">
                <div v-else class="vg-frame-ph"><img :src="defaultImageUrl" alt=""></div>
                <span class="vg-frame-num">{{ i + 1 }}</span>
              </div>
              <div class="vg-frame-name">{{ vgStripName(v) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 编辑分类弹窗：分类自己的 en/cn/neg/override，子级词条自动继承（前端临时拼接，不落库） -->
      <div v-if="catEdit.open" class="edit-overlay">
        <div class="edit-dialog">
          <div class="title"><span class="title-text">编辑分类：{{ catEdit.pathLabel }}</span></div>
          <div class="edit-body">
            <div class="field">
              <div class="field-head"><label>名字</label></div>
              <input type="text" v-model="catEdit.name" @keydown.enter="submitCatEdit">
            </div>
            <div class="field en">
              <div class="field-head">
                <label>提示词（英）</label>
                <span class="count">{{ (catEdit.en || '').length }} 字</span>
              </div>
              <textarea v-model="catEdit.en" rows="3" spellcheck="false" placeholder="填了就会继承给它下面的所有词条" @keydown.ctrl.enter="submitCatEdit"></textarea>
            </div>
            <div class="field cn">
              <div class="field-head">
                <label>提示词（中）</label>
                <span class="count">{{ (catEdit.cn || '').length }} 字</span>
              </div>
              <textarea v-model="catEdit.cn" rows="2" spellcheck="false" @keydown.ctrl.enter="submitCatEdit"></textarea>
            </div>
            <div class="field neg" :class="{ filled: (catEdit.neg || '').trim() }">
              <div class="field-head">
                <label>负面提示词</label>
                <span class="count">{{ (catEdit.neg || '').length }} 字</span>
              </div>
              <textarea v-model="catEdit.neg" rows="2" spellcheck="false" placeholder="该分类下任一提示词被选中时并入负面" @keydown.ctrl.enter="submitCatEdit"></textarea>
            </div>
            <div class="field override" :class="{ filled: (catEdit.override || '').trim() }">
              <div class="field-head">
                <label>排除</label>
                <span class="count">{{ (catEdit.override || '').length }} 字</span>
              </div>
              <textarea v-model="catEdit.override" rows="2" spellcheck="false" placeholder="命中别的词条里的逗号段即删除该段（含子级）。多条用逗号分隔" @keydown.ctrl.enter="submitCatEdit"></textarea>
            </div>
            <label class="cat-provide" :class="{ on: catEdit.provide }">
              <input type="checkbox" v-model="catEdit.provide">
              <span>属性向下继承给这一层下面的所有词条</span>
            </label>
          </div>
          <div class="actions">
            <button class="btn danger" @click="askDeleteCatFromEdit" :disabled="catSaving || catEdit.kind === 'tab'"
                    :data-tip="catEdit.kind === 'tab' ? '大类（Tab 根）不可删除' : '连同其下所有子分类与词条一并删除（可恢复）'">删除</button>
            <button class="btn" @click="closeCatEdit">取消</button>
            <button class="btn primary" @click="submitCatEdit" :disabled="catSaving">保存</button>
          </div>
        </div>
      </div>

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
          <div class="title">{{ addCardLock ? '新建变体' : '增加词条' }}</div>
          <div class="hint" v-if="addCardLock" style="margin:-4px 0 10px">
            将并入变体组：<b>{{ addCardLock.label }}</b>（与组内其它词条合并成 1 张卡，可翻页切换）
          </div>
          <div class="field">
            <label>名字</label>
            <div class="name-with-prefix" v-if="addCardLock && addCardLock.label">
              <span class="name-prefix" data-tip="前缀是所属变体组名，显示时自动拼、不入库；要改组名请右键该卡「改变体组名」">{{ addCardLock.label }}#</span>
              <input ref="addCardInput" type="text" v-model="addCardName"
                     placeholder="变体名" spellcheck="false"
                     @keydown.enter="submitAddCard" @keydown.esc="closeAddCard">
            </div>
            <input v-else ref="addCardInput" type="text" v-model="addCardName"
                   placeholder="请输入词条名称" spellcheck="false"
                   @keydown.enter="submitAddCard" @keydown.esc="closeAddCard">
          </div>
          <div class="field en">
            <div class="field-head">
              <label>提示词（英）</label>
              <span class="count">{{ (addCardContent || '').length }} 字</span>
            </div>
            <textarea v-model="addCardContent" rows="4" spellcheck="false" @keydown.ctrl.enter="submitAddCard"></textarea>
          </div>
          <div class="sep"></div>
          <div class="field cn">
            <div class="field-head">
              <label>提示词（中）</label>
              <span class="count">{{ (addCardContentCn || '').length }} 字</span>
            </div>
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

      <!-- 编辑弹窗（不响应外部点击关闭，只能点「取消」关闭，避免拖选复制文字时误关） -->
      <div v-if="editTarget" class="edit-overlay">
        <div class="edit-dialog">
          <div class="title">
            <span class="title-text">编辑：{{ cardDisplayName(editTarget) }}</span>
            <button type="button" class="acc-all" @click="toggleAllAcc"
                    :data-tip="allAccOpen ? '收起全部字段' : '展开全部字段'">{{ allAccOpen ? '全部收起' : '全部展开' }}</button>
          </div>
          <!-- 字段区可滚动：全展开也不会把底部按钮顶出屏幕 -->
          <div class="edit-body">
          <!-- 每个字段都是抽屉：点标题条即收起/展开，开合状态写 localStorage 持久化 -->
          <div class="field acc" :class="{ open: acc.name }">
            <div class="field-head acc-head" @click="toggleAcc('name')">
              <label>名字</label>
              <span class="acc-meta acc-val" v-if="(editName || '').trim()">{{ editName }}</span>
              <span class="acc-meta" v-else>空</span>
              <span class="acc-arrow"></span>
            </div>
            <div v-show="acc.name" class="acc-body">
              <!-- 变体条目也只有一个输入框：这里显示的就是这条词自己的完整名，
                   与卡片标题、变体浮层、已选标签完全同一口径，不再拆「组名#」前缀 -->
              <input type="text" v-model="editName" @keydown.enter="submitEdit">
            </div>
          </div>
          <div class="field en acc" :class="{ open: acc.en }">
            <div class="field-head acc-head" @click="toggleAcc('en')">
              <label>提示词（英）</label>
              <span class="acc-meta">{{ (editContent || '').length }} 字</span>
              <span class="acc-arrow"></span>
            </div>
            <div v-show="acc.en" class="acc-body">
              <textarea v-model="editContent" rows="4" spellcheck="false" @keydown.ctrl.enter="submitEdit"></textarea>
            </div>
          </div>
          <div class="field cn acc" :class="{ open: acc.cn }">
            <div class="field-head acc-head" @click="toggleAcc('cn')">
              <label>提示词（中）</label>
              <span class="acc-meta">{{ (editContentCn || '').length }} 字</span>
              <span class="acc-arrow"></span>
            </div>
            <div v-show="acc.cn" class="acc-body">
              <textarea v-model="editContentCn" rows="3" spellcheck="false" @keydown.ctrl.enter="submitEdit"></textarea>
              <span v-if="editIsTxt" class="hint">散 txt 卡片暂不支持中文提示词</span>
            </div>
          </div>
          <div class="field neg acc" :class="{ open: acc.neg, filled: (editNeg || '').trim() }">
            <div class="field-head acc-head" @click="toggleAcc('neg')">
              <label>负面提示词</label>
              <span class="acc-meta" v-if="!(editNeg || '').trim()">未填</span>
              <span class="acc-meta" v-else>{{ (editNeg || '').length }} 字</span>
              <span class="acc-arrow"></span>
            </div>
            <div v-show="acc.neg" class="acc-body">
              <textarea v-model="editNeg" rows="2" spellcheck="false" placeholder="该词条被选中时并入负面提示词；多条用逗号分隔" @keydown.ctrl.enter="submitEdit"></textarea>
            </div>
          </div>
          <div class="field override acc" :class="{ open: acc.override, filled: (editOverride || '').trim() }">
            <div class="field-head acc-head" @click="toggleAcc('override')">
              <label>排除</label>
              <span class="acc-meta" v-if="!(editOverride || '').trim()">未填</span>
              <span class="acc-meta" v-else>{{ (editOverride || '').length }} 字</span>
              <span class="acc-arrow"></span>
            </div>
            <div v-show="acc.override" class="acc-body">
              <textarea v-model="editOverride" rows="2" spellcheck="false" placeholder="只删「别的词条」里命中的逗号段，不删自己。多条用逗号分隔；段内任一词命中即排除" @keydown.ctrl.enter="submitEdit"></textarea>
            </div>
          </div>
          </div>
          <div class="actions">
            <button class="btn danger" @click="askDeleteWord(editTarget)">删除</button>
            <button class="btn" @click="cancelEdit">取消</button>
            <button class="btn primary" @click="submitEdit" :disabled="editing">保存</button>
          </div>
        </div>
      </div>

      <!-- 修改变体组名：组名就是这个变体组节点自己的 name。
           各变体库里只存短名，「组名#短名」是渲染时拼的，所以改完这一个名字，全组显示名自动跟着变。 -->
      <div v-if="vgRenameOpen" class="edit-overlay">
        <div class="edit-dialog vg-rename-dialog">
          <div class="title"><span class="title-text">修改变体组名</span></div>
          <div class="edit-body">
            <div class="hint" style="margin:0 0 10px">
              改完组下 <b>{{ vgRenameCount }}</b> 个变体的显示名会自动变成「新组名#变体名」（库里只改这一个名字，各变体存的仍是自己那截短名）。
            </div>
            <div class="field">
              <label>组名</label>
              <input type="text" v-model="vgRenameName" placeholder="如 居家生活" spellcheck="false"
                     @keydown.enter="submitVgRename">
            </div>
            <div class="hint" v-if="vgRenamePreview" style="margin-top:8px">
              变体名示例：<b>{{ vgRenamePreview }}</b>
            </div>
          </div>
          <div class="actions">
            <button class="btn" @click="closeVgRename">取消</button>
            <button class="btn primary" @click="submitVgRename" :disabled="vgRenaming">保存</button>
          </div>
        </div>
      </div>

      <!-- 聚拢成变体组（提示词入口）：先新建一条空组头，再把这批提示词整批挂到它下面。
           组头是「新建的独立数据」，不借用选中的任何一张卡当组头，所以跟谁先被选中无关；
           这批提示词必须同属一个分类（父级完全一致），否则前端直接拦下，不跨分类搬词条。 -->
      <div v-if="vgJoin.open" class="edit-overlay">
        <div class="edit-dialog vg-rename-dialog">
          <div class="title"><span class="title-text">聚拢成变体组</span></div>
          <div class="edit-body">
            <div class="hint" style="margin:0 0 10px">
              将新建一个变体组（独立的组头数据），挂在分类 <b>{{ vgJoin.parentName || '—' }}</b> 下；
              下面 <b>{{ vgJoin.items.length }}</b> 条提示词全部挂到这个新组头上，各自成为它的一个变体，
              名字保留现在的短名，显示时自动拼成「组名#短名」，之后在同一张卡里翻页切换。
            </div>
            <div class="field">
              <label>组名</label>
              <input type="text" v-model="vgJoin.name" :placeholder="vgJoin.suggest || '如 居家生活'" spellcheck="false"
                     @keydown.enter="submitVgJoin">
            </div>
            <div class="hint" v-if="vgJoinPreview" style="margin-top:8px">
              变体名示例：<b>{{ vgJoinPreview }}</b>
            </div>
            <div class="hint" v-if="vgJoin.items.length > 1" style="margin-top:8px">
              本次并入的变体名：{{ vgJoinNames }}
            </div>
          </div>
          <div class="actions">
            <button class="btn" @click="closeVgJoin">取消</button>
            <button class="btn primary" @click="submitVgJoin" :disabled="vgJoin.busy">聚拢</button>
          </div>
        </div>
      </div>

      <delete-dialog :state="del.state" @confirm="del.confirm" @cancel="del.cancel"></delete-dialog>

      <!-- 全屏查看 -->
      <div v-if="viewer.open" class="viewer-overlay" @click.self="closeViewer">
        <div class="viewer-dialog">
          <div class="viewer-head">
            <span class="viewer-title">{{ cardDisplayName(viewer.file) }}</span>
            <button class="btn icon-btn danger" data-tip="删除词条" @click="askDeleteWord(viewer.file)">🗑</button>
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
    // 全树节点属性索引（后端 nodes）：分类/词条一律带 en/cn/neg/override，
    // 供「编辑分类」弹层回填，以及继承展开时按 id 取节点属性。
    const bankNodes = ref({});
    const maxDepth = ref(2);
    // 左栏可能铺出的行数（分类树全展开后行数会超过 maxDepth），
    // 选区数组必须补齐到这么长，否则模板 getSelections()[depth] 读到 undefined 会炸
    const minSelDepth = ref(2);
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
      // 池子只有两种类型（由每个池自己的 traverse 字段标记，不再是全局模式）：
      // 🎲 随机池：traverse=false，每次现抽 1 条；∞ 遍历池：traverse=true，所有词条参与全组合。
      // 跑法不再有全局开关：遍历是默认跑法（∞ 遍历池做全组合各跑一次，🎲 随机池每组现抽 1 条），
      // 填充模式（按参考图数补跑）已移除。
    });

    // ============ 卡片框选（多选 → 凝结成池）============
    // 选中语义与图库一致：框选 = 一次性覆盖写入命中集合；Ctrl/⌘ + 左键点卡片 = 单项增删。
    // 词库的特殊性：左键长按卡片是「把卡片拖成标签」的起手动作，不能占用，
    // 所以这里的长按框选改成**右键**起手（图库仍是左键）。
    // 框选结果只是"待凝结的候选"，不进入 data.selected，不影响已选区与预览。
    const pickSel = reactive(new Set());
    const gridEl = ref(null);
    // key 与卡片 DOM 上的 data-tab + data-rel 严格同构，composable 拿到的 key 可直接回喂本集合
    const pickKey = (file) => (file.tab || '') + '||' + (file.relPath || '');
    const isPicked = (file) => pickSel.has(pickKey(file));
    const clearPick = () => { pickSel.clear(); catPickSel.clear(); };
    const togglePick = (file) => {
      const k = pickKey(file);
      if (pickSel.has(k)) pickSel.delete(k); else pickSel.add(k);
      // 手工增删卡片后回校整类选中态：某分类不再被完整覆盖时，自动摘掉它的✓标记
      // （剩下的词条照旧保留在已选里，用户可以继续挑，最后一起凝结）
      pruneCatPick();
    };
    // key 反查卡片对象：已选集合可能来自其它大类（分类整类选中 / 跨大类挑卡片），
    // 不能只查当前可见网格，否则切过大类后凝结会丢项。这里按「已加载的全部大类数据」建索引，
    // 当前可见列表兜底（承载变体组折叠等临时字段）。
    const pickedFiles = () => {
      const byKey = new Map();
      const all = bankData.value || {};
      Object.keys(all).forEach(t => {
        (all[t] || []).forEach(f => {
          if (!f || !f.relPath) return;
          byKey.set(pickKey({ tab: f.tab || t, relPath: f.relPath }), f);
        });
      });
      (visibleFiles.value || []).forEach(f => {
        const k = pickKey(f);
        if (!byKey.has(k)) byKey.set(k, f);
      });
      const out = [];
      pickSel.forEach(k => { const f = byKey.get(k); if (f) out.push(f); });
      return out;
    };

    // ============ 分类整类选中（Ctrl/⌘ + 左键点大类 tab 或分类 chip）============
    // 语义：等价于「把该分类（含全部子分类）下的每条提示词都手动 Ctrl 点成已选中」，
    // 与卡片框选/Ctrl 点多选共用同一个 pickSel，所以二者完全互通：
    //   · 整类选中后，仍可 Ctrl+左键点单张卡片把它剔掉；
    //   · 仍可去别的分类/别的大类继续整类选中或单独挑几张；
    //   · 最后统一走同一个出口「凝结为池」（卡片右键，或已选状态条上的按钮）。
    // 注意：这里**不**产生 tab 池 / chip 池，也不涉及 ∞ / 🎲，池类型只在凝结那一刻决定。
    // catPickSel 只记录「哪些分类正处于整类选中态」，用于 chip 高亮与再点一次整体取消。
    const catPickSel = reactive(new Set());
    const catPickKey = (tab, id) => String(tab || '') + '||' + String(id || '');
    // 某分类下的全部词条：id 为空 = 整个大类；否则按 chipIds 祖先链命中（含所有后代子分类）
    const catFilesOf = (tab, id) => {
      const files = (bankData.value || {})[tab] || [];
      if (!id) return files.slice();
      const sid = String(id);
      return files.filter(f => Array.isArray(f.chipIds) && f.chipIds.includes(sid));
    };
    const isTabCatPicked = (name) => catPickSel.has(catPickKey(name, ''));
    const isChipCatPicked = (chip) => catPickSel.has(catPickKey(data.activeTab, (chip && chip.id) || ''));
    const toggleCatPick = (kind, key, name) => {
      const tab = kind === 'tab' ? key : data.activeTab;
      const id = kind === 'tab' ? '' : String(key || '');
      const ck = catPickKey(tab, id);
      const label = name || (kind === 'tab' ? tabLabel(tab) : '');
      // 大类数据是懒加载的：Ctrl 点一个没打开过的大类先补拉一次，拉完再点即可
      if (!Array.isArray((bankData.value || {})[tab])) {
        load(false, tab);
        return showToast(`正在加载「${label}」的词条，稍等再点一次即可整类选中`, 'warn', 2600);
      }
      const files = catFilesOf(tab, id);
      if (catPickSel.has(ck)) {
        let n = 0;
        files.forEach(f => { if (pickSel.delete(pickKey({ tab: f.tab || tab, relPath: f.relPath }))) n++; });
        catPickSel.delete(ck);
        zhuleLog('toggleCatPick: 取消整类选中', { kind, tab, id, removed: n }, 'picked=', pickSel.size);
        showToast(`「${label}」已取消整类选中（-${n}），当前已选 ${pickSel.size} 项`, 'warn', 2600);
        return;
      }
      if (!files.length) return showToast(`「${label}」下还没有词条，无法整类选中`, 'warn');
      files.forEach(f => pickSel.add(pickKey({ tab: f.tab || tab, relPath: f.relPath })));
      catPickSel.add(ck);
      zhuleLog('toggleCatPick: 整类选中', { kind, tab, id, added: files.length }, 'picked=', pickSel.size);
      showToast(`「${label}」整类已选中 +${files.length}，共 ${pickSel.size} 项（Ctrl 再点可整类取消，也可 Ctrl 点单张剔除）`, 'success', 2800);
    };
    // 整类选中态的实时回校：只在「该分类仍被已选集合完整覆盖」时才保留 ✓ 标记，
    // 一旦用户手工 Ctrl 剔掉其中某张卡片，分类高亮自动降级（已选的其余词条照旧保留）。
    const pruneCatPick = () => {
      if (!catPickSel.size) return;
      const drop = [];
      catPickSel.forEach(ck => {
        const p = ck.indexOf('||');
        const tab = ck.slice(0, p);
        const id = ck.slice(p + 2);
        const files = catFilesOf(tab, id);
        if (!files.length) { drop.push(ck); return; }
        const partial = files.some(f => !pickSel.has(pickKey({ tab: f.tab || tab, relPath: f.relPath })));
        if (partial) drop.push(ck);
      });
      drop.forEach(ck => catPickSel.delete(ck));
    };
    const { onPointerDown: onPickPointerDown } = useMarqueeSelect({
      getContainer: () => gridEl.value,
      selector: '.card',
      getKey: (el) => (el.getAttribute('data-tab') || '') + '||' + (el.getAttribute('data-rel') || ''),
      // 右键长按起手框选：左键留给「拖成标签」
      button: 2,
      selectedClass: 'pick-sel',
      // 拖动成立后拦掉松手时补发的 contextmenu，避免框完立刻弹出卡片菜单
      maskContextMenu: true,
      marqueeClass: 'zhg-marquee',
      isInteractive: (ev) => {
        const tg = ev.target;
        return !!(tg && tg.closest && tg.closest('.card-actions, .thumb-nav, .thumb-enter, .thumb-zoom, .thumb-del'));
      },
      onUpdate: (hits, ctx) => {
        // 不按 Ctrl：替换式框选；按住 Ctrl：并集追加（Set 去重，不重复添加）
        if (!(ctx && ctx.additive)) { pickSel.clear(); catPickSel.clear(); }
        hits.forEach(k => pickSel.add(k));
        pruneCatPick();
      },
      onEnd: ({ cancelled, initialKeys }) => {
        if (!cancelled) return;
        pickSel.clear();
        (initialKeys || new Set()).forEach(k => pickSel.add(k));
      },
    });
    // 网格按下统一入口：空白处左键仍走「退出搜索」，右键则只当框选起手；
    // 框选本身由 composable 判键（button:2），左键按下在这里被它直接忽略，不影响拖拽打标。
    const onGridPointerDown = (e) => {
      if (e.target === gridEl.value) onBoardBlankDown(e);
      onPickPointerDown(e);
    };

    // pref 单独持久化：整包 state 的 JSON.stringify 一旦因数据异常失败会被静默吞掉，
    // 连带偏好失效；这里让 pref 走自己的 key，与整包存档互不牵连。
    const PREF_KEY = 'zhule_wordbank_pref_v1';
    function loadPref() {
      // showNegPreview：预览框是否展开「负面提示词」一行，默认展开。开关只在预览框上（pv-neg-toggle），不设独立设置面板。
      // searchByPath：搜索是否对分类生效，默认关闭（只匹配词条名）；
      // 开启后词条名或所在分类路径（tab / 各级分类）任一命中即算命中。设置入口在导航栏设置面板「词库设置」。
      // hideVgNav：隐藏卡片右上角的变体切换框（‹ 1/3 ›），默认关闭；
      // 开启后卡面只剩参考图翻页，变体切换改走右键「变体胶片条」。设置入口在导航栏设置面板「词库设置」。
      const p = { columns: 4, translate: false, genCount: 1, autoSelectParent: true, showNegPreview: true, searchByPath: false, hideVgNav: false };
      try {
        const raw = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
        if (raw && typeof raw === 'object') {
          if (typeof raw.columns === 'number' && raw.columns >= 1 && raw.columns <= 20) p.columns = raw.columns;
          if (typeof raw.translate === 'boolean') p.translate = raw.translate;
          if (typeof raw.genCount === 'number' && raw.genCount >= 0 && raw.genCount <= 99) p.genCount = raw.genCount;
          if (typeof raw.autoSelectParent === 'boolean') p.autoSelectParent = raw.autoSelectParent;
          if (typeof raw.searchByPath === 'boolean') p.searchByPath = raw.searchByPath;
          if (typeof raw.hideVgNav === 'boolean') p.hideVgNav = raw.hideVgNav;
          if (typeof raw.showNegPreview === 'boolean') p.showNegPreview = raw.showNegPreview;
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

    // 排序键统一为「层级|父节点id」（第 0 层的父 = 大类 Tab 根 id）
    const getChipOrder = (tab, depth, parentId) => {
      const t = chipOrder[tab];
      if (!t) return [];
      const exact = t[depth + '|' + String(parentId || '')];
      if (Array.isArray(exact)) return exact;
      // 兼容早期存档：整层全局顺序（无父级）作为兜底
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
        selected: data.selected.map(s => s._ph ? { _ph: true, _poolKey: s._poolKey, tab: s.tab, name: s.name, _filled: !!s._filled, relPath: s.relPath || undefined, id: s.id || undefined, content: s.content || undefined, content_cn: s.content_cn || undefined, neg: s.neg || undefined, override: s.override || undefined } : { tab: s.tab, relPath: s.relPath, id: s.id || undefined, name: s.name, _poolKey: s._poolKey || undefined, _vgKey: s._vgKey || undefined, _vgTitle: s._vgTitle || undefined }),
        randomPools: data.randomPools,
        // 模式存档版本：3 起「随机」是池类型（每个池的 traverse 字段）而非全局模式；
        // 4 起移除填充模式与遍历开关，遍历恒为默认跑法（旧存档的 fillMode/traverseMode 读档时忽略）。
        modeVer: 4,
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

    // imgIndices 收敛：卡片参考图下标按 relPath 存存档，但图库删图不会回写这里，
    // 剩下的越界下标就是黑图与 "4/1" 的源头。每次数据加载完成后按当前 images
    // 实际长度重算一次，有变化才回写存档（避免跨会话反复带病）。
    // pruneOrphans 仅在全量加载时开启：局部加载只持有部分 tab，此时按已加载范围
    // 删下标会误伤其它 tab 的存档。
    const normalizeImgIndices = (pruneOrphans) => {
      const bank = bankData.value || {};
      const map = (data.imgIndices && typeof data.imgIndices === 'object')
        ? data.imgIndices
        : (data.imgIndices = {});
      let changed = false;
      const alive = new Set();
      Object.keys(bank).forEach(t => {
        (bank[t] || []).forEach(card => {
          if (!card || !card.relPath) return;
          alive.add(card.relPath);
          const cur = map[card.relPath];
          if (cur === undefined || cur === null) return;
          const n = (card.images || []).length;
          const num = Number(cur);
          const want = n
            ? Math.min(Math.max(Number.isFinite(num) ? Math.trunc(num) : 0, 0), n - 1)
            : 0;
          if (want !== cur) {
            map[card.relPath] = want;
            changed = true;
          }
        });
      });
      if (pruneOrphans) {
        Object.keys(map).forEach(k => {
          if (!alive.has(k)) {
            delete map[k];
            changed = true;
          }
        });
      }
      if (changed) saveState();
      return changed;
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
          if (typeof srcPref.columns === 'number' && srcPref.columns >= 1 && srcPref.columns <= 20) pref.columns = srcPref.columns;
          if (typeof srcPref.translate === 'boolean') pref.translate = srcPref.translate;
          if (typeof srcPref.genCount === 'number' && srcPref.genCount >= 0 && srcPref.genCount <= 99) pref.genCount = srcPref.genCount;
          if (typeof srcPref.autoSelectParent === 'boolean') pref.autoSelectParent = srcPref.autoSelectParent;
          if (typeof srcPref.searchByPath === 'boolean') pref.searchByPath = srcPref.searchByPath;
          if (typeof srcPref.showNegPreview === 'boolean') pref.showNegPreview = srcPref.showNegPreview;
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
            clean.push(...state.randomPools.filter(it => it && (it.kind === 'tab' || it.kind === 'chip' || it.kind === 'list') && typeof it.tab === 'string'
              && (it.kind !== 'chip' || it.chipId)));
          } else if (typeof state.randomPools === 'object') {
            // 兼容旧版按 tab 分桶的存档
            Object.keys(state.randomPools).forEach(t => {
              const arr = state.randomPools[t];
              if (!Array.isArray(arr)) return;
              arr.forEach(it => {
                if (it && (it.kind === 'tab' || it.kind === 'chip') && Array.isArray(it.path)) {
                  clean.push({ kind: it.kind, tab: t, path: it.path, display: it.display || '' });
                }
              });
            });
          }
          clean.forEach(it => {
            // 池的 chip 身份即节点 id（后端已不再下发 path，路径存档早于本版即作废）
            delete it.path;
            if (it.kind !== 'chip') return;
            if (!it.chipId) it.dead = true;
            else it.display = nodeNameOf(it.chipId) || it.display || String(it.chipId);
          });
          // 凝结池（kind:'list'）校验：items 必须是有 tab + relPath 的数组，池子空了就丢弃
          data.randomPools = clean.filter(it => {
            if (it.kind === 'chip' && it.dead) return false;
            if (it.kind !== 'list') return true;
            it.items = (Array.isArray(it.items) ? it.items : []).filter(e => e && typeof e.tab === 'string' && typeof e.relPath === 'string');
            if (!it.poolId) it.poolId = 'L' + Math.random().toString(36).slice(2, 10);
            if (!it.display) it.display = '凝结' + it.items.length + '项';
            return it.items.length > 0;
          });
        }
        // 池类型：旧存档的池没有 traverse 字段 → 一律视为随机池 🎲（与旧行为一致）
        data.randomPools.forEach(it => { it.traverse = !!it.traverse; });
        // 旧存档迁移：modeVer < 3 时旧「随机模式 🔄」= 各池各抽一条逐条出图，等价于「所有池都是 🎲 随机池」。
        // 填充模式（fillMode）与遍历开关（traverseMode）已移除：遍历恒为默认跑法，旧字段读档时一律忽略。
        if (!(state.modeVer >= 3) && state.randomMode) {
          data.randomPools.forEach(it => { it.traverse = false; });
        }
        if (state.imgIndices && typeof state.imgIndices === 'object') data.imgIndices = state.imgIndices;
        if (state.selections && typeof state.selections === 'object') {
          Object.keys(state.selections).forEach(t => {
            const arr = state.selections[t] || [];
            data.selections[t] = new Array(maxDepth.value).fill(null).map(() => []);
            for (let i = 0; i < Math.min(arr.length, maxDepth.value); i++) {
              const v = arr[i];
              const one = Array.isArray(v) ? v.filter(x => x)[0] : v;   // 互斥单选：旧多选只保留首个
              if (!one) continue;
              // 选区身份即节点 id，非 id 值（旧路径 key）直接丢弃
              const id = String(one);
              if ((bankNodes.value || {})[id]) data.selections[t][i] = [id];
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
              rebuilt.push({ _ph: true, _poolKey: s._poolKey || '', tab: s.tab || '', name: s.name || '', _filled: !!s._filled, relPath: s.relPath || '', id: s.id || '', content: s.content || '', content_cn: s.content_cn || '', neg: s.neg || '', override: s.override || '' });
              return;
            }
            if (!s.tab || !s.relPath) return;
            const cards = bankData.value[s.tab] || [];
            const card = cards.find(c => c.relPath === s.relPath);
            if (card) rebuilt.push({ tab: s.tab, relPath: card.relPath, id: card.id || '', name: card.name, content: card.content, content_cn: card.content_cn, neg: card.neg || '', override: card.override || '', _poolKey: s._poolKey || undefined, _vgKey: s._vgKey || '', _vgTitle: s._vgTitle || '' });
            else rebuilt.push({ tab: s.tab, relPath: s.relPath, id: s.id || '', name: s.name || '', content: s.content || '', content_cn: s.content_cn || '', neg: s.neg || '', override: s.override || '', _poolKey: s._poolKey || undefined, _vgKey: s._vgKey || '', _vgTitle: s._vgTitle || '' });
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
    const editNeg = ref('');       // 负面提示词（选中该词条时并入负面）
    const editOverride = ref('');  // 排除词（只删别的词条产出的提示词段，不删自己）
    const editing = ref(false);

    // 字段抽屉开合：名字/中英默认展开，负面/排除默认收起；任意开合写 localStorage 持久化
    const ACC_KEY = 'zhule_wordbank_edit_acc';
    const ACC_DEFAULT = { name: true, en: true, cn: true, neg: false, override: false };
    const acc = reactive({ ...ACC_DEFAULT });
    (() => {
      try {
        const raw = JSON.parse(localStorage.getItem(ACC_KEY) || 'null');
        if (raw && typeof raw === 'object') {
          Object.keys(ACC_DEFAULT).forEach((k) => {
            if (k in raw) acc[k] = !!raw[k];
          });
        }
      } catch (e) { /* localStorage 不可用：保持默认 */ }
    })();
    const allAccOpen = computed(() => Object.keys(ACC_DEFAULT).every((k) => acc[k]));
    const toggleAllAcc = () => {
      const next = !allAccOpen.value;
      Object.keys(ACC_DEFAULT).forEach((k) => { acc[k] = next; });
      try { localStorage.setItem(ACC_KEY, JSON.stringify({ ...acc })); }
      catch (e) { /* 忽略 */ }
    };
    const toggleAcc = (k) => {
      if (!(k in ACC_DEFAULT)) return;
      acc[k] = !acc[k];
      try { localStorage.setItem(ACC_KEY, JSON.stringify({ ...acc })); }
      catch (e) { /* 忽略 */ }
    };

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
      const sp = e && e.detail && e.detail.searchByPath;
      if (typeof sp === 'boolean') pref.searchByPath = sp;
      const hv = e && e.detail && e.detail.hideVgNav;
      if (typeof hv === 'boolean') pref.hideVgNav = hv;
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
    // 通用设置「隐藏被静音的提示词」：默认关闭；开启后卡片列表不展示 mute=1 的词条（数据仍在，关掉开关即回来）
    function readCommonHideMuted() {
      try {
        const raw = JSON.parse(localStorage.getItem('zhule_ui_pref') || '{}');
        return !!(raw && raw.common && raw.common.hideMuted === true);
      } catch (e) { return false; }
    }
    const hideMuted = ref(readCommonHideMuted());
    // 通用设置「隐藏卡片上的图标」：默认关闭；开启后卡片只留左右切换 + 骰子，
    // 其余操作（详情/放大/删除图/静音/删除/编辑/上传）全部由右键菜单承担
    function readCommonHideCardIcons() {
      try {
        const raw = JSON.parse(localStorage.getItem('zhule_ui_pref') || '{}');
        return !!(raw && raw.common && raw.common.hideCardIcons === true);
      } catch (e) { return false; }
    }
    const hideCardIcons = ref(readCommonHideCardIcons());
    function onGlobalPrefChanged(e) {
      const g = e && e.detail && e.detail.gallery;
      const cm = e && e.detail && e.detail.common;
      if (cm && typeof cm.hideMuted === 'boolean') hideMuted.value = cm.hideMuted;
      if (cm && typeof cm.hideCardIcons === 'boolean') hideCardIcons.value = cm.hideCardIcons;
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
      return !!chipParentId(depth);
    };

    // 注：词条/分类的新增入口已统一收到「分类右键菜单」，不再有加号卡片

    const addCardIsTxt = computed(() => (addCardName.value || '').trim().toLowerCase().endsWith('.txt'));

    // 父分类显示名链（用于加号按钮 title）：按 parentId 上溯现算
    const chipParentLabel = (depth) => {
      if (depth <= 0) return tabLabel(data.activeTab);
      return nodePathOf(chipParentId(depth));
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
        // 父级 id 直接取选中链：depth 0 落当前大类 Tab 根，更深层取上一层选中节点
        const parentId = chipParentId(addChipDepth.value) || tabIds.value[data.activeTab] || '';
        if (!parentId) {
          showToast('没找到父级：请先在左侧选中一个分类（或某个大类）再新建', 'warn', 3200);
          return;
        }
        const resp = await fetch('/zhule_studio/api/wordbank/chip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parentId, name }),
        });
        const json = await resp.json();
        if (!resp.ok) { showToast(json.error || '创建失败', 'error'); return; }
        addChipOpen.value = false;
        addChipName.value = '';
        // 新分类暂无词条，后端扫描看不到 → 本地补位；身份直接用后端返回的节点 id
        const newId = String(json.id || '');
        if (newId && !pendingChips.value.some(p => String(p.id) === newId)) {
          pendingChips.value.push({ id: newId, parentId: String(parentId), name, depth: addChipDepth.value });
        }
        showToast('分类已创建', 'success');
      } finally {
        addingChip.value = false;
      }
    };

    // 新建变体模式：{ parentId, label } —— parentId 锁死为变体组所在分类，忽略左侧选区
    const addCardLock = ref(null);
    const openAddCard = (lock) => {
      addCardLock.value = (lock && lock.parentId)
        ? { parentId: String(lock.parentId), label: lock.label || '' }
        : null;
      addCardName.value = '';
      addCardContent.value = '';
      addCardContentCn.value = '';
      addCardOpen.value = true;
      nextTick(() => { if (addCardInput.value) addCardInput.value.focus(); });
    };
    const closeAddCard = () => {
      addCardOpen.value = false;
      addCardLock.value = null;
      addCardName.value = '';
      addCardContent.value = '';
      addCardContentCn.value = '';
    };
    const submitAddCard = async () => {
      const name = addCardName.value.trim();
      if (!name) { showToast(addCardLock.value ? '请输入变体名' : '请输入词条名', 'warn'); return; }
      // 库里只存短名，组名前缀是渲染层拼的、不入库。
      // 输入框只收 # 后那段；用户手打了「组名#」也照样剥掉，避免库里出现重复前缀。
      const pre = (addCardLock.value && addCardLock.value.label || '').trim();
      let shortName = name;
      if (pre && shortName.startsWith(pre + '#')) shortName = shortName.slice(pre.length + 1).trim();
      if (!shortName) { showToast('请输入变体名', 'warn'); return; }
      // 只校验用户真正敲进去的这一段：组名前缀是库里既有名字（可能自带 /），不该连累它报错
      if (/[\\/:*?"<>|]/.test(shortName)) {
        showToast('名字不能包含 \\ / : * ? " < > |', 'warn', 3600);
        return;
      }
      addingCard.value = true;
      try {
        const sel = getSelections();
        let selId = '';
        for (let i = 0; i < Math.max(maxDepth.value, sel.length); i++) {
          if (Array.isArray(sel[i]) && sel[i].length) selId = String(sel[i][0] || '');
        }
        // 父级 id：① 变体组锁定的锚点 id；② 选中的分类节点 id（左栏自带 id，不再反查）；
        // ③ 整层没选分类时落到当前 tab 根。
        const parentId = addCardLock.value
          ? addCardLock.value.parentId
          : (selId || tabIds.value[data.activeTab] || '');
        if (!parentId) {
          addingCard.value = false;
          showToast('没找到父级：请先在左侧选中一个分类（或某个大类）再新建', 'warn', 3200);
          return;
        }
        const body = { parentId, name: shortName };
        if (addCardContent.value) body.content = addCardContent.value;
        if (!addCardIsTxt.value && addCardContentCn.value) body.content_cn = addCardContentCn.value;
        const resp = await fetch('/zhule_studio/api/wordbank/card', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await resp.json();
        if (!resp.ok) { showToast(json.error || '创建失败', 'error'); return; }
        const lock = addCardLock.value;
        addCardOpen.value = false;
        addCardName.value = '';
        addCardContent.value = '';
        addCardContentCn.value = '';
        showToast(lock ? '变体已创建（已并入该变体组）' : '词条已创建', 'success');
        addCardLock.value = null;
        await load(true);
        // 新建的变体自动翻到它，免得用户再一页页找
        if (lock) {
          const vkey = String(data.activeTab || '') + '|' + lock.parentId;
          const grp = vgRealMap.value[vkey] || { real: [] };
          const vi = (grp.real || []).findIndex(c => String(c.id) === String(json.id));
          if (vi >= 0) vgStateEnsure(vkey).idx = vi;
        }
      } finally {
        addingCard.value = false;
      }
    };

    // ============ 静音开关（mute） ============
    // 语义：mute=1（静音）的词条在随机池抽词、遍历穷举、单次随机等自动选词流程被跳过，
    // 只有用户手动点选卡片时才参与。与删除（isdel）不同：卡片照常显示、参考图不动，
    // 随时可一键恢复；已选区里已手选的标签也不受影响。
    const muteBusy = ref(false);
    const toggleMute = async (file) => {
      if (!file || !file.id || muteBusy.value) return;
      if (file.muteFromCat) {
        showToast('该词条所属分类已被静音，请先在分类右键菜单里取消该分类的静音', 'warn', 3400);
        return;
      }
      const target = !file.mute;
      muteBusy.value = true;
      try {
        const resp = await fetch('/zhule_studio/api/wordbank/mute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: file.id, mute: target }),
        });
        const json = await resp.json();
        if (json.error) {
          showToast('设置失败：' + json.error, 'error');
          return;
        }
        // 原地改：bankData 是 ref，深层对象为响应式代理，卡片样式立即刷新
        file.mute = json.mute;
        patchSearchAll(file.id, { mute: json.mute });
        showToast((json.mute ? '已静音：' : '已取消静音：') + file.name
          + (json.mute ? '（自动选词跳过它，手动点选仍可用）' : ''), 'success', 2600);
      } catch (e) {
        showToast('请求失败：' + e.message, 'error');
      } finally {
        muteBusy.value = false;
      }
    };

    // 编辑弹窗里这条词所属的组名（只用来剥「组名#xxx」这种手打前缀，不再显示成只读标签）。
    // 组名走和卡片标题同一套三级兜底，_vgTitle 丢了也能按 id 顺着树找回来。
    // 普通词条不在变体组下，返回空串。
    const editNamePrefix = computed(() => {
      const t = editTarget.value;
      if (!t) return '';
      return String(vgTitleFor(t) || '').trim();
    });


    const openEdit = (file) => {
      editTarget.value = file;
      // 输入框直接显示这条词的完整名：与卡片标题、变体浮层、已选标签同一口径。
      // 名字没改动时按原样写回（默认版写回的就是组名，从此库里也是完整名，不再出现「默认」）。
      editName.value = cardDisplayName(file);

      editContent.value = file.content || '';
      editContentCn.value = file.content_cn || '';
      editNeg.value = file.neg || '';
      editOverride.value = file.override || '';
      // 有内容就临时展开露出，避免藏着看不见；不改用户持久化偏好
      if ((editNeg.value || '').trim()) acc.neg = true;
      if ((editOverride.value || '').trim()) acc.override = true;
    };

    const cancelEdit = () => {
      editTarget.value = null;
      editing.value = false;
    };

    const submitEdit = async () => {
      if (!editTarget.value || editing.value) return;
      const nm = (editName.value || '').trim();
      if (!nm) return showToast('名字不能为空', 'warn');
      // 回写只写短名：组名前缀是渲染层拼的、不入库（用户手打「组名#xxx」照样剥掉）。
      const pre = (editNamePrefix.value || '').trim();
      let tail = nm;
      if (pre && tail.startsWith(pre + '#')) tail = tail.slice(pre.length + 1).trim();
      if (!tail) return showToast('变体名不能为空', 'warn');
      // 名字没动过就别改库：输入框显示的是完整名（默认版显示组名），照着写回去会把库里的
      // 「默认」改成组名，凭空制造出跟组头同名的条目。这里原样提交原值，等于什么都没改。
      const untouched = nm === cardDisplayName(editTarget.value);
      const fullName = untouched ? (editTarget.value.name || tail) : tail;

      editing.value = true;
      try {
        const body = {
          id: editTarget.value.id,
          name: fullName,
        };
        // 仅当输入框非空或原本就有内容时才写回，避免误清空
        if (editContent.value || editTarget.value.content) body.content = editContent.value;
        // 散 txt 卡片后端不支持中文；仅文件夹卡片提交
        if (!editIsTxt.value && (editContentCn.value || editTarget.value.content_cn)) {
          body.content_cn = editContentCn.value;
        }
        // 负面提示词 / 排除词：同样只在有值时写回，避免误清空
        if (editNeg.value || editTarget.value.neg) body.neg = editNeg.value;
        if (editOverride.value || editTarget.value.override) body.override = editOverride.value;
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
        const saved = {
          id: editTarget.value.id,
          relPath: editTarget.value.relPath,
          name: fullName,
          content: ('content' in body) ? body.content : editTarget.value.content,
          content_cn: ('content_cn' in body) ? body.content_cn : editTarget.value.content_cn,
          neg: ('neg' in body) ? body.neg : (editTarget.value.neg || ''),
          override: ('override' in body) ? body.override : (editTarget.value.override || ''),
        };
        editTarget.value = null;
        editing.value = false;
        // 已选列表里若有该词条，同步刷新快照（运行/预览取的是快照，不刷新会用到旧的排除词）
        data.selected.forEach(sl => {
          const sameId = saved.id && sl.id && String(sl.id) === String(saved.id);
          if (sameId || sl.relPath === saved.relPath) {
            sl.name = saved.name;
            sl.content = saved.content;
            sl.content_cn = saved.content_cn;
            sl.neg = saved.neg;
            sl.override = saved.override;
          }
        });
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
        message: '是否确认删除当前提示词？删除后不再显示（数据仍保留在库中，可后续恢复）。'
          + '该词条已上传的参考图会一并归档到 zhule_reference/_trash，可在需要时找回。',
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
          showToast('已删除：' + file.name
            + (json.refDirsPurged ? '（参考图已归档 ' + json.refDirsPurged + ' 个目录）' : ''),
            'success');
          // 若删除来源是编辑弹窗，同步关闭编辑面板
          if (editTarget.value && editTarget.value.id === file.id) {
            editTarget.value = null;
            editing.value = false;
          }
          // 若删除来源是详情弹层，同步关闭详情
          if (viewer.open && viewer.file && viewer.file.id === file.id) {
            viewer.open = false;
            viewer.file = null;
          }
        }
        await load();
      } catch (e) {
        showToast('请求失败：' + e.message, 'error');
      } finally {
        deleting.value = false;
      }
    };

    // ============ 删除参考图（当前展示的那一张：物理删除 + 词条 images 同步） ============
    const delRefBusy = ref(false);
    const askDeleteRef = (file) => {
      if (!file || !file.images || !file.images.length) return;
      const img = file.images[getImgIdx(file)] || '';
      // 图库反查图（zhule_img/）删的是图库原图本体，所有引用该图的词条都会失去它，文案须说明影响
      const isGalleryRef = img.startsWith('zhule_img/');
      del.ask({
        title: '确认删除',
        message: isGalleryRef
          ? '该图来自图库反查（zhule_img）。确认后将物理删除图库原图、缩略图与对应数据库记录，所有引用这张图的词条都会失去它，且不可恢复。'
          : '是否确认删除当前参考图？删除后不可恢复。',
        name: img.split('/').pop() || '',
        run: () => deleteRefNow(file),
      });
    };
    const deleteRefNow = async (file) => {
      if (!file || delRefBusy.value) return;
      delRefBusy.value = true;
      try {
        const idx = getImgIdx(file);
        const image = file.images[idx];
        if (!image) return;
        const resp = await fetch('/zhule_studio/api/wordbank/image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: file.id, image, action: 'delete' }),
        });
        const json = await resp.json();
        if (json.error) {
          showToast('删除失败：' + json.error, 'error');
          return;
        }
        file.images = json.images || [];
        patchSearchAll(file.id, { images: file.images });
        const n = file.images.length;
        setImgIdx(file, n ? Math.min(idx, n - 1) : 0);
        // 若删除发生在详情弹层，同步修正弹层索引
        if (viewer.open && viewer.file && viewer.file.id === file.id) {
          if (viewer.idx >= n) viewer.idx = n ? n - 1 : 0;
        }
        // 若删除发生在全屏查看器：保持全屏不中断，直接接续显示同一词条接上来的那张图
        // （imgIdx 已收到同位置，删末张则退到前一张；该词条已无参考图则回退默认图并标注）
        if (fullViewer && fullViewer.isOpen && zoomCtx.file && zoomCtx.file.id === file.id) {
          openZoomedFile(zoomCtx.file);
        }
        showToast('已删除参考图', 'success');
      } catch (e) {
        showToast('请求失败：' + e.message, 'error');
      } finally {
        delRefBusy.value = false;
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
        patchSearchAll(file.id, { images: file.images });
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

    // 动态算最大 chips 层数：卡片层数 与 分类树实际层级 取大（空分类也算，保证空小类可展开）
    const recalcMaxDepth = () => {
      let max = 0;
      Object.values(bankData.value).forEach(cards => {
        cards.forEach(c => {
          // chips 只装分类层，变体组的组名不再进 chips（组名只活在组节点 name 里），
          // 所以这里直接用 chips 长度，不需要再减掉组名那一层
          const n = (c.chips && c.chips.length) || 0;

          if (n > max) max = n;
        });
      });
      // 分类节点树本身的最大深度（与卡片无关，空目录也贡献层级）
      const idx = bankNodes.value || {};
      Object.keys(idx).forEach(id => {
        const n = idx[id];
        if (!n) return;
        if ((n.type || 'category') !== 'category') return;
        const len = nodeIdChainById(id).length;
        if (len > max) max = len;
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
        if (c) { s.id = c.id || s.id; s.name = c.name; s.content = c.content; s.content_cn = c.content_cn; s.neg = c.neg || ''; s.override = c.override || ''; dirty = true; }
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
        // 重新取数即代表数据变了（新建 / 删除 / 编辑 / 手动刷新），让「全库搜索快照」过期，
        // 下次在全库档搜索时重新整包取一次；放在 await 之后，避免 setup 同步阶段访问 searchAll
        searchAll.value = null;
        searchAllError.value = '';
        tabs.value = json.tabs || [];
        tabIds.value = json.tab_ids || {};
        if (json.nodes && typeof json.nodes === 'object') bankNodes.value = json.nodes;
        // 已落库的空分类会出现在节点索引里，本地补位缓存清掉同名 id，避免重复与陈旧项
        if (pendingChips.value.length && bankNodes.value) {
          pendingChips.value = pendingChips.value.filter(p => !(p && p.id && bankNodes.value[String(p.id)]));
        }
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
        // 数据就绪后统一收敛参考图下标（图库删图造成的越界下标在此修正并回写存档）。
        // 必须在 restoreState 之后，否则会被存档里的旧越界值覆盖回去。
        normalizeImgIndices(!!force && !tabName);
        // 选区 id 自愈：修掉历史存档里 id 为空的条目（否则出图 tag 不带角色）
        healSelectedIds();
        // 分类静音向下继承（必须在数据赋值之后、渲染之前）
        inheritCategoryMute();
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
      const need = Math.max(maxDepth.value, minSelDepth.value);
      while (sel.length < need) sel.push([]);
      return sel;
    };

    // 层级 chip 显示名（去掉编号前缀）；name 入参为完整唯一键
    const dispKey = (k) => {
      const s = (k || '').toString();
      const i = s.lastIndexOf('/');
      const base = i >= 0 ? s.slice(i + 1) : s;
      return base.replace(/^\d+[_ ]+/, '');
    };

    // parentId -> 子分类；跳过 Tab 根、词条节点（空壳锚点/变体条目的 type 不是 category，天然过滤）。
    // 注意：分类级 vg（末级分类标了变体组）**仍然是分类层**，必须照常出现在左栏，
    // 它只影响「其下词条合并成一张卡」，不能连分类一起隐藏，否则用户会以为分类丢了。
    // 抽成 computed：左栏渲染、排序落库、唯一链下钻共用同一份分类树。
    const catKids = computed(() => {
      const tab = data.activeTab;
      const rootId = String(tabIds.value[tab] || '');
      const idx = bankNodes.value || {};
      const kids = new Map();
      Object.keys(idx).forEach(id => {
        const n = idx[id];
        if (!n) return;
        if (String(id) === rootId) return;
        if ((n.type || 'category') !== 'category') return; // 词条 / 空壳锚点不进分类栏
        const p = String(n.parentId || '');
        if (!p) return;
        if (!kids.has(p)) kids.set(p, []);
        kids.get(p).push({ id: String(id), parentId: p, name: n.name || '' });
      });
      return kids;
    });

    // 当前 tab 分类树的实际层数（全展开视图要按真实层数铺行，不能再按固定 2 层截断）
    const catTreeDepth = computed(() => {
      const tab = data.activeTab;
      const rootId = String(tabIds.value[tab] || '');
      if (!rootId) return 1;
      const kids = catKids.value;
      const seen = new Set();
      const walk = (id) => {
        if (seen.has(id)) return 0;   // 防环
        seen.add(id);
        const arr = kids.get(id) || [];
        let best = 0;
        for (let i = 0; i < arr.length; i++) {
          const d = walk(String(arr[i].id || ''));
          if (d > best) best = d;
        }
        return arr.length ? best + 1 : 0;
      };
      return Math.max(1, walk(rootId));
    });

    const chipLines = computed(() => {
      // 左栏 = 分类节点树的全展开视图（与卡片无关，空分类也能显示）。
      // 每一层显示「上一层所有父分类的子分类合集」：某层未被选中时整层摊开，
      // 选中后该层收敛成被选中的分类、下一层只展开它们的子分类。
      // —— 这样「全部」状态下依然能一路看到最深层分类，不会因为没选就断掉后代。
      const tab = data.activeTab;
      const rootId = String(tabIds.value[tab] || '');
      const sel = data.selections[tab] || [];
      const lines = [];
      if (!rootId) return lines;
      const kids = catKids.value;
      let maxSelDepth = -1;
      for (let i = 0; i < (sel || []).length; i++) {
        if (Array.isArray(sel[i]) && sel[i].length) maxSelDepth = i;
      }
      // 循环上限取三者最大值：
      //  ① 分类树真实层数（全展开：不选中也要能一路看到最底层）
      //  ② 选中链深度+2（选中 depth d 的空分类时还需渲染 d+1 层，提供「＋」/「全部」继续建子分类）
      //  ③ maxDepth（历史布局下限）
      const loopDepth = Math.max(maxDepth.value, catTreeDepth.value + 1, maxSelDepth + 2);
      let parents = [rootId];
      for (let depth = 0; depth < loopDepth; depth++) {
        if (!parents.length) break;
        const used = new Set();
        const options = [];
        parents.forEach(pid => {
          let group = (kids.get(pid) || []).slice();
          // 顺序：按该父节点自己记的顺序排（多个父混排时，父间顺序 = 上一层顺序，父内 = 各自顺序）
          const order = getChipOrder(tab, depth, pid);
          if (order.length) {
            const byId = new Map(group.map(o => [o.id, o]));
            const byName = new Map();
            group.forEach(o => { if (!byName.has(o.name)) byName.set(o.name, []); byName.get(o.name).push(o); });
            const ordered = [];
            const seen = new Set();
            order.forEach(k => {
              const key = String(k == null ? '' : k);
              const hit = byId.get(key);
              if (hit && !seen.has(hit.id)) { ordered.push(hit); seen.add(hit.id); return; }
              (byName.get(key) || []).forEach(o => { if (!seen.has(o.id)) { ordered.push(o); seen.add(o.id); } });
            });
            group = ordered.concat(group.filter(o => !seen.has(o.id)));
          }
          group.forEach(o => { if (!used.has(o.id)) { used.add(o.id); options.push(o); } });
        });
        // 合并刚创建、尚未落盘为词条的空小类（避免空目录未刷新时不可见）
        pendingChips.value.forEach(pc => {
          const pid = String(pc.parentId || '');
          if (!parents.includes(pid)) return;
          if (!pc.name && !pc.id) return;
          const nid = String(pc.id || '');
          if (nid && used.has(nid)) return;
          if (options.some(o => String(o.parentId) === pid && o.name === (pc.name || ''))) return;
          if (nid) used.add(nid);
          options.push({ id: nid, parentId: pid, name: pc.name || '' });
        });
        if (!options.length) break;
        lines.push(options);
        // 下一层要展开的父：本层选中了 → 只展开选中项；没选中 → 整层继续摊开
        const picks = sel[depth];
        parents = (Array.isArray(picks) && picks.length)
          ? picks.map(x => String(x || '')).filter(Boolean)
          : options.map(o => String(o.id || '')).filter(Boolean);
      }
      // 行数变化时同步抬高选区数组下限（无需 trigger 额外渲染：本就随本 computed 一起重算）
      if (minSelDepth.value !== lines.length) minSelDepth.value = lines.length;
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
      // 每层的已选分类预先转成字符串 Set：下面每张卡片都要比对，避免反复 map
      const pickSets = (sel || []).map(a => (Array.isArray(a) && a.length) ? new Set(a.map(String)) : null);
      const result = files.filter(f => {
        // 通用设置开启时隐藏已静音词条（仅影响列表展示，不影响词库数据与手动编辑）
        if (hideMuted.value && f.mute) return false;
        const ids = f.chipIds || [];
        for (let i = 0; i < maxDepth.value; i++) {
          const set = pickSets[i];
          if (!set) continue;
          const id = ids[i];
          // 该层有筛选时，词条必须在这一层有自己的分类归属才可能命中：
          // 只挂在大类下、没归到任何子分类的词条（chipIds 更短 / 该层为空）不属于所筛分类，
          // 一律排除。早期这里写的是 continue，导致这类"直挂大类"的词条在任何子分类筛选下常驻不消失。
          if (!id) return false;
          if (!set.has(String(id))) return false;
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

    // ============ 搜索（同一个控件，两档范围）============
    // 档「筛选」：只在当前 tab + 已选 chips 的 filteredFiles 里过滤 —— 纯内存，零请求
    // 档「全库」：忽略 tab / chips，走一次性拉取的全库快照。
    //   前端是懒加载的，没点开过的 tab 根本没有数据，所以全库档必须先整包取一次，
    //   取完缓存住，之后都在这份快照上过滤；快照只读，绝不写回 bankData。
    // 两档取数路径天然不同：筛选档即时、全库档只拉一次，所以分开处理。
    const searchText = ref('');
    const searchScope = ref('filter');   // 'filter' | 'all'
    // 方案A：搜索槽默认收起成放大镜图标，点开才展开
    const searchOpen = ref(false);
    const searchClosing = ref(false);   // 收回动画进行中（动画跑完才真正卸载输入框）
    const searchInputEl = ref(null);
    const searchAll = ref(null);         // 全库快照
    const searchAllLoading = ref(false);
    const searchAllError = ref('');
    const searchQ = computed(() => String(searchText.value || '').trim().toLowerCase());
    // 匹配范围 = 词条名 + 所在分类路径（tab / 各级分类）：
    // 搜「扎发」既命中名字含扎发的词条，也命中 发型/扎发/编发 整条线上分类下的全部词条；
    // 提示词正文仍然不参与匹配。
    // 分类名里全角／、反斜杠等分隔符混用是常态，统一折成 "/" 再比，且忽略大小写
    const normSep = (s) => String(s == null ? '' : s).replace(/[／＼\\]/g, '/').toLowerCase();
    const cardPathText = (c) => {
      const chips = Array.isArray(c && c.chips) ? c.chips : [];
      return normSep([c && c.tab].concat(chips).filter(Boolean).join('/'));
    };
    // searchByPath（设置项「搜索是否对分类生效」）默认关闭：关闭时只比词条名，
    // 开启后词条名或所在分类路径（tab / 各级分类）任一命中即算命中
    // 搜索命中：库里存的是短名，但用户心里的名字是「组名#短名」，
    // 所以两个都拿来回撞 —— 搜短名（默认）、搜组名（把整组捞出来）都该命中。
    const hitSearch = (c, q) => {
      if (!q) return true;
      const nq = normSep(q);
      const short = String((c && c.name) || '');
      if (normSep(short).includes(nq)) return true;
      const gn = (() => {
        const n = vgNodeOf(c);
        return n ? String(n.name || '').trim() : '';
      })();
      if (gn && gn !== short && normSep(gn + '#' + short).includes(nq)) return true;
      if (pref.searchByPath !== true) return false;
      return cardPathText(c).includes(nq);
    };
    const ensureSearchAll = async () => {
      if (searchAll.value || searchAllLoading.value) return;
      searchAllLoading.value = true;
      searchAllError.value = '';
      try {
        // 不带 tab 参数 = 后端返回全部 tab 的全量树
        const resp = await fetch('/zhule_studio/api/wordbank');
        const json = await resp.json();
        if (!resp.ok || !json || json.error) throw new Error((json && json.error) || ('HTTP ' + resp.status));
        const all = [];
        const d = (json && json.data) || {};
        for (const t of Object.keys(d)) {
          for (const c of (d[t] || [])) {
            // 归属 tab 以分组键为准（后端卡片本身也带 tab 字段，这里兜一道）
            if (!c.tab) c.tab = t;
            all.push(c);
          }
        }
        // 分类静音只在内存里按 id 祖先链向下继承、不写库，bankData 那份已被 inheritCategoryMute
        // 打过派生标记；全库快照是另一次请求拿到的独立对象，不会自动带上，所以这里按同一套
        // 规则补一遍：全库搜索的「隐藏静音」过滤与卡片静音图标才能和当前分类视图同口径。
        all.forEach(c => {
          if (c.mute) return;                    // 词条自身已静音，保留原状
          const hit = mutedByCat(c.id, c.tab);   // tab 根 / 任一祖先分类静音都覆盖
          if (hit) { c.mute = 1; c.muteFromCat = hit; }
        });
        searchAll.value = all;
        zhuleLog('ensureSearchAll: 全库快照就绪', all.length);
      } catch (e) {
        searchAllError.value = e.message || String(e);
      } finally {
        searchAllLoading.value = false;
      }
    };
    // 全库快照里的同一词条跟上本地已改的字段（参考图 / 静音态），
    // 避免全库搜索结果点开详情时看到过期数据；赋新数组才能触发重算
    const patchSearchAll = (id, patch) => {
      if (!searchAll.value || !id) return;
      searchAll.value = searchAll.value.map(x => (x.id === id ? Object.assign({}, x, patch) : x));
    };
    const searchHits = computed(() => {
      const q = searchQ.value;
      if (!q) return null;   // 没有搜索词 = 不在搜索态，列表交回分类浏览
      const src = searchScope.value === 'all' ? (searchAll.value || []) : filteredFiles.value;
      // 静音词条在搜索里是否出现，统一跟随通用设置「隐藏被静音的提示词」（hideMuted）：
      // 开启 = 搜索也不展示；关闭 = 照常命中，卡片上仍显示静音标记。与浏览态口径保持一致
      return src.filter(c => hitSearch(c, q) && (!hideMuted.value || !c.mute));
    });
    // 列表唯一出口：有词 → 搜索结果；无词 → 原分类浏览结果
    const listFiles = computed(() => searchHits.value || filteredFiles.value);
    // 全库搜索的卡片可能压根不在当前 tab 里，右上角标出它的真实归属（tab / 父类 / 子类）
    const showCardTab = (file) => searching.value && searchScope.value === 'all' && !!(file && file.tab);
    const cardTabLabel = (file) => {
      if (!file) return '';
      const chips = Array.isArray(file.chips) ? file.chips : [];
      return [file.tab].concat(chips).filter(Boolean).join(' / ');
    };
    const searching = computed(() => !!searchQ.value);
    const searchLoading = computed(() => !!searchQ.value && searchScope.value === 'all' && searchAllLoading.value);
    const searchFailed = computed(() => (searchQ.value && searchScope.value === 'all') ? searchAllError.value : '');
    const listCountLabel = computed(() => (searching.value ? '命中 ' : '数量 ') + listFiles.value.length);
    const emptyText = computed(() => {
      if (!searching.value) return '没有匹配的提示词 —— 右键分类可新建词条 / 子分类';
      if (searchLoading.value) return '正在取全库词条…';
      if (searchFailed.value) return '全库取数失败：' + searchFailed.value;
      return pref.searchByPath === true
        ? '没有名字或分类路径含「' + String(searchText.value || '').trim() + '」的词条'
        : '没有名字含「' + String(searchText.value || '').trim() + '」的词条';
    });
    // 搜索框提示随「搜索是否对分类生效」设置联动：关闭时只提示搜词条名；静音提示随 hideMuted 联动
    const searchPh = computed(() => (pref.searchByPath === true ? '搜词条 / 分类' : '搜词条名'));
    const searchTip = computed(() => {
      const base = pref.searchByPath === true ? '搜词条名或分类路径（Ctrl+F）' : '搜词条名（Ctrl+F）';
      return base + (hideMuted.value ? '｜静音词条已隐藏' : '');
    });
    const toggleSearchScope = () => {
      searchScope.value = searchScope.value === 'all' ? 'filter' : 'all';
      if (searchScope.value === 'all') ensureSearchAll();
    };
    // 方案A：图标 -> 展开成框并聚焦；Ctrl+F 也走这里
    const openSearch = () => {
      searchOpen.value = true;
      nextTick(() => {
        const el = searchInputEl.value;
        if (el && el.focus) { el.focus(); if (el.select) el.select(); }
      });
    };
    // 收回成图标：先播 240ms 的收缩动画，动画结束再卸载，收起不会「啪」一下没了
    const closeSearchBox = () => {
      if (!searchOpen.value || searchClosing.value) return;
      searchClosing.value = true;
      setTimeout(() => {
        searchOpen.value = false;
        searchClosing.value = false;
      }, 240);
    };
    // 失焦即收回成图标，但绝不删掉框里的字：下次点开还是原来那串词，结果也照旧按它过滤
    // （清词只由框内 × 按钮或卡片区空白点击触发）
    const onSearchBlur = () => {
      setTimeout(() => {
        const box = document.querySelector('.wb-search');
        if (box && box.contains(document.activeElement)) return;
        closeSearchBox();
      }, 120);
    };
    // 只清搜索词、不动分类选中：清完列表自动回填到当前分类浏览（纯内存，零请求）
    const clearSearch = () => { searchText.value = ''; };
    // 点卡片区空白（非卡片本身）= 退出搜索回到当前分类浏览；滚动查看结果不会触发清词
    // 右键按下是框选起手，不能顺手把搜索词清掉，只认左键
    const onBoardBlankDown = (e) => { if (e && e.button !== 0) return; if (searchQ.value) clearSearch(); };
    const onSearchEsc = (e) => {
      // Esc 只收回成图标、不动框里的字（要清词点 × ）
      if (e && e.target && e.target.blur) e.target.blur();
      closeSearchBox();
    };
    // 切到全库档后才懒取一次全量；切回筛选档不丢快照
    watch([searchQ, searchScope], () => {
      if (searchQ.value && searchScope.value === 'all') ensureSearchAll();
    });

    // ============ 变体组（同一提示词的多变体） ============
    // 数据侧：分类节点 prompt.vg=1 → 该分类下所有词条视为「同一提示词的多个变体」。
    // 前端三种用法共用同一个游标 vgState[key].idx，互不打架：
    //   A 常规：整组只出 1 张卡，卡面 ‹ › 翻页换变体（不用翻页器找"同一张脸"）
    //   B 右键：卡片右键「变体胶片条」，把全部变体横向摊开，点哪帧切哪版
    //   C 已选：标签上挂三态徽标 —— 🔒 锁定当前版（默认）/ 🎲 每次随机 / ∞ 顺序轮转
    const vgState = reactive({});   // { [vgKey]: { mode: 'locked'|'random'|'traverse', idx: 0, cursor: 0 } }
    // 三态独立存档：不能塞进 saveState —— saveState 在 setup 早期就会被调用，
    // 那时 vgState 尚未初始化（const 暂时性死区），引用会直接抛错。这里用独立 key + watch 落盘。
    const VG_STORE_KEY = 'zhule_wb_vg_state';
    try {
      const sv = JSON.parse(localStorage.getItem(VG_STORE_KEY) || '{}');
      Object.keys(sv || {}).forEach((k) => {
        const v = sv[k];
        if (!v || typeof v !== 'object') return;
        vgState[k] = {
          mode: ['locked', 'random', 'traverse'].includes(v.mode) ? v.mode : 'locked',
          idx: Number(v.idx) || 0,
          cursor: Number(v.cursor) || 0,
        };
      });
    } catch (e) { /* 存档损坏：忽略，回到默认锁定 */ }
    watch(vgState, () => {
      try { localStorage.setItem(VG_STORE_KEY, JSON.stringify(vgState)); } catch (e) { /* 忽略 */ }
    }, { deep: true });
    const VG_MODE_NEXT = { locked: 'random', random: 'traverse', traverse: 'locked' };
    // ---- 名字两段展示：库里只存短名，组名由渲染层沿祖先动态拼 ----
    // 变体组 = type 为 entry、且其下有 entry 子节点的那个节点（它自己就是组名，不入 name）。
    // 其下每条子提示词是同一组里的一个变体，name 只存短名；显示成「组名#变体名」时，前缀是拼的、永不入库。
    // 这样改建组名只改这一个节点的 name（零级联），分类 ⇄ 变体互转也只改 type 一位，名字完全不动。
    const vgShortName = (name, group) => {
      const s = String(name || '');
      const g = String(group || '').trim();
      if (!g) return s;
      const pre = g + '#';
      return s.startsWith(pre) ? s.slice(pre.length) : s;
    };
    // 按组键现查组名（已选标签只带 _vgKey，历史选区也能自解释）
    const vgGroupTitleOf = (key) => {
      const s = String(key || '');
      if (!s) return '';
      const g = vgRealMap.value[s];
      return (g && g.title) || '';
    };
    // 卡片标题用名 = 这一版自己的完整名：库里只存短名，显示时补上组名，
    // 让卡片脱离左栏/词库单独看（复制、截图、拖到别的分类）也读得懂是谁。
    //   组名「刘海」+ 短名「单眼」 → 「单眼刘海」
    //   短名本身就是「默认」或是组名本身 → 只显示组名（它本来就是完整名）
    //   短名里已经带了组名 → 原样显示，避免「刘海刘海」
    const vgFullName = (name, group) => {
      const g = String(group || '').trim();
      const short = vgShortName(name, g).trim();
      if (!g) return short;
      if (!short || short === '默认' || short === g) return g;
      if (short.includes(g)) return short;
      return short + g;
    };
    // 这条词所在变体组的组名：三种来源依次兜底，保证任何出口都能拼出完整名
    //   1. 卡片/已选项上带的 _vgTitle（跨 tab、存档恢复、随机池都随项传递）
    //   2. 按组键回查（vgRealMap，全库索引）
    //   3. 按 id 顺着 bankNodes 的 parentId 找父节点是不是组头（历史存档只存了 id 的场景）
    const vgGroupTitleById = (id) => {
      const nodes = bankNodes.value || {};
      const me = id ? nodes[String(id)] : null;
      const pid = String((me && me.parentId) || '');
      if (!pid || !vgGroupIds.value.has(pid)) return '';
      const pn = nodes[pid];
      return String((pn && pn.name) || '').trim();
    };
    const vgTitleFor = (file) => {
      if (!file) return '';
      const byField = String(file._vgTitle || '').trim();
      if (byField) return byField;
      const byKey = file._vgKey ? String(vgGroupTitleOf(file._vgKey) || '').trim() : '';
      if (byKey) return byKey;
      return vgGroupTitleById(file.id);
    };
    const cardDisplayName = (file) => {
      if (!file) return '';
      const g = vgTitleFor(file);
      return vgFullName(file.name, g);
    };
    // 变体身份牌：只要这张卡是某个变体组里的成员就挂（组头自己那张不挂）。
    // 文案就是组名本身（不再加「变体 · 」前缀，卡名已含组名，不需要额外解释）。
    const cardGroupBadge = (file) => {
      if (!file) return '';
      if (vgGroupIds.value.has(String(file.id || ''))) return '';
      return vgTitleFor(file);
    };
    // 兼容旧调用点：现在等于卡片上的变体身份牌文案（组名）
    const cardNamePrefix = cardGroupBadge;
    // 悬浮提示就是这张卡自己的名字，不再拼「组名#」
    const fullNameOf = (file) => cardDisplayName(file);
    // 已选标签显示名：与卡片标题同一口径（默认版显示组名，其余显示自身完整名）
    const selDisplayName = (item) => {
      if (!item) return '';
      if (item._ph) return item.name || '';
      return cardDisplayName(item);
    };
    // 变体组节点集合：自己 type=entry，且其下有 type=entry 的子节点
    const vgGroupIds = computed(() => {
      const set = new Set();
      const nodes = bankNodes.value || {};
      for (const id of Object.keys(nodes)) {
        const n = nodes[id];
        if (!n || String(n.type || '') !== 'entry') continue;
        const pid = String(n.parentId || '');
        if (!pid) continue;
        const p = nodes[pid];
        if (p && String(p.type || '') === 'entry') set.add(pid);
      }
      return set;
    });
    // 空壳组头：组节点自己的内容全空 —— 只当组名与分组关系，不出词、不进翻页编号
    const vgIsShellCard = (card) => {
      if (!card || !vgGroupIds.value.has(String(card.id || ''))) return false;
      return !String(card.content || '').trim()
        && !String(card.content_cn || '').trim()
        && !String(card.neg || '').trim();
    };
    // 卡片所属的变体组节点：卡片自己就是组节点时取自己；否则看库里真实的父节点是不是变体组。
    // 注意不能拿 chipIds 反推 —— chips 只装分类节点（组名那一层不入 chips），
    // 子变体往上找只能靠 bankNodes 的 parentId 链。
    const vgNodeOf = (card) => {
      if (!card) return null;
      const nodes = bankNodes.value || {};
      const own = String(card.id || '');
      if (own && vgGroupIds.value.has(own)) return nodes[own] || { id: own, name: card.name || '' };
      const me = own ? nodes[own] : null;
      const pid = String((me && me.parentId) || '');
      if (pid && vgGroupIds.value.has(pid)) {
        const pn = nodes[pid];
        if (pn) return pn;
      }
      const ids = Array.isArray(card.chipIds) ? card.chipIds : [];
      if (!ids.length) return null;
      const last = String(ids[ids.length - 1]);
      return vgGroupIds.value.has(last) ? (nodes[last] || null) : null;
    };
    // 变体组键 = tab + 组节点 id：跨 tab 同 id 不撞车，改组名/改路径都不影响已选标签挂靠
    const vgKeyOf = (card) => {
      const n = vgNodeOf(card);
      return n ? String(card.tab || '') + '|' + String(n.id) : '';
    };
    const vgStateEnsure = (key) => {
      if (!vgState[key]) vgState[key] = { mode: 'locked', idx: 0, cursor: 0 };
      return vgState[key];
    };
    // 全量变体索引（不受当前筛选/搜索影响）：已选标签的变体池要能自解释，不能因切了筛选就失效
    const vgGroupMap = computed(() => {
      const map = {};
      for (const t of Object.keys(bankData.value)) {
        for (const raw of (bankData.value[t] || [])) {
          const c = raw.tab ? raw : Object.assign({ tab: t }, raw);
          const k = vgKeyOf(c);
          if (!k) continue;
          (map[k] || (map[k] = [])).push(c);
        }
      }
      // 排序口径：空壳组头永远排最前（它只是组名，不参与翻页编号）；
      // 组节点自己那张卡（有内容时也算一版，名字就是组名）紧随其后当 version 1；
      // 剩下「默认」条目当第二，其余动作变体按库里原顺序（sort 稳定）。
      Object.keys(map).forEach((k) => {
        map[k].sort((a, b) => {
          const rank = (c) => {
            if (vgIsShellCard(c)) return 0;
            if (vgGroupIds.value.has(String(c.id || ''))) return 1;
            return vgShortName(c && c.name).trim() === '默认' ? 2 : 3;
          };
          return rank(a) - rank(b);
        });
      });
      return map;
    });
    // 组内「真实变体」= 全量里剔除空壳组头。组头只提供组名与分组关系，
    // 因此翻页编号、出词、随机/遍历池一律只看 real，组头天然被跳过（不需要额外的 mute 特判）。
    const vgRealMap = computed(() => {
      const m = {};
      Object.keys(vgGroupMap.value).forEach((k) => {
        const all = vgGroupMap.value[k] || [];
        const head = all.find(c => vgIsShellCard(c)) || all.find(c => vgGroupIds.value.has(String(c.id || ''))) || null;
        const real = all.filter(c => !vgIsShellCard(c));
        // 组名就是组节点自己的 name（不再是名字里的 # 前段，也不再兜底分类名）
        const s = String(k);
        const bar = s.indexOf('|');
        const gid = bar >= 0 ? s.slice(bar + 1) : '';
        const gnode = gid ? ((bankNodes.value || {})[gid] || null) : null;
        const title = String((gnode && gnode.name) || (head && head.name) || '');
        m[k] = { head, real, title };
      });
      return m;
    });
    const vgVersionsOf = (item) => {
      const key = item && item._vgKey;
      if (!key) return null;
      const g = vgRealMap.value[key];
      const vs = (g && g.real) || [];
      return (vs.length > 1) ? vs : null;
    };
    // 变体组归并内核：把一组多变体压成一张代表卡（空壳组头自身永不出卡）。
    // 所有「会看到卡片」的出口——列表、左侧分类、层级深度、随机池、遍历池——都必须走它。
    // 只要哪个出口漏了归并，组名就会以「分类」的身份冒出来（左树凭空多一行「山间凉亭」）。
    function vgMergeCards(list) {
      const src = list || [];
      const groups = new Map();
      for (const c of src) {
        const k = vgKeyOf(c);
        if (!k) continue;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c);
      }
      const out = [];
      const done = new Set();
      for (const c of src) {
        const k = vgKeyOf(c);
        if (!k) { if (!vgIsShellCard(c)) out.push(c); continue; }  // 非变体组：原样输出
        if (done.has(k)) continue;
        done.add(k);
        // 变体池取「真实变体」全量索引（已剔除空壳组头、已把「默认」排到 version 1），
        // 不受当前筛选/搜索影响：同一提示词的动作变体被筛选条件滤掉时，卡内翻变体仍应能翻到它。
        const grp = vgRealMap.value[k] || { head: null, real: [], title: '' };
        const vs = (grp.real && grp.real.length) ? grp.real : (groups.get(k) || []).filter(c => !vgIsShellCard(c));
        if (!vs.length) continue;                 // 组里只剩空壳组头：没有任何词可出，整组不出卡
        const st = vgState[k];
        const raw = st ? Number(st.idx) || 0 : 0;
        const idx = Math.min(Math.max(raw, 0), vs.length - 1);
        if (st && st.idx !== idx) st.idx = idx;
        const base = vs[idx];
        const head = grp.head;
        out.push(Object.assign({}, base, {
          _vgKey: k, _vgVersions: vs, _vgIdx: idx, _vgCount: vs.length,
          // 组名取组节点自己的 name（已在 vgRealMap 里解析好）
          _vgTitle: grp.title || '',
          // 变体条目在库里的链路比组节点多一层（组名），合并成一张卡后统一用组节点的链路，
          // 这样左侧筛选、全库搜索的「所在分类」与合并后的卡一致，不会露出组名这一层
          chips: head ? head.chips : base.chips,
          chipKeys: head ? head.chipKeys : base.chipKeys,
          chipIds: head ? head.chipIds : base.chipIds,
        }));
      }
      return out;
    }

    // 当前可见卡片按变体组归并：组内只保留一张代表卡，其余变体挂在 _vgVersions 上随卡走
    const viewCards = computed(() => vgMergeCards(listFiles.value || []));
    // 手动翻页：只挪游标（不改用户设的三态模式，避免静默推翻他的设置）
    const vgStep = (file, d) => {
      const key = file && file._vgKey;
      const vs = (file && file._vgVersions) || [];
      if (!key || vs.length < 2) return;
      const st = vgStateEnsure(key);
      const cur = Math.min(Math.max(Number(st.idx) || 0, 0), vs.length - 1);
      st.idx = ((cur + d) % vs.length + vs.length) % vs.length;
    };
    const vgGroupTitle = (file) => {
      // 卡片级变体组：组名就是空壳锚点（组头节点）的名字，如「进气口刘海」。
      // 一律走 vgTitleFor 的三级兜底；绝不能拿分类 chips 拼路径当组名（那不是组名，
      // 画到卡面/胶片条上会变成「刘海／侧发」这种长串，看起来就像认错了人）。
      return vgTitleFor(file);
    };
    // 新建变体时的组名提示：只用于弹窗里给用户看，名字本身仍只存短名、不拼前缀
    const vgNewVersionPrefix = (file) => {
      if (!file) return '';
      return String(vgGroupTitle(file) || '').trim();
    };

    // ---- B：胶片条 ----
    const vgStrip = reactive({ open: false, key: '', title: '', idx: 0, versions: [] });
    const openVgStrip = (file) => {
      if (!file || !file._vgKey) return;
      const vs = file._vgVersions || [];
      if (vs.length < 2) return;
      const st = vgStateEnsure(file._vgKey);
      vgStrip.open = true;
      vgStrip.key = file._vgKey;
      vgStrip.title = vgGroupTitle(file);
      vgStrip.versions = vs;
      vgStrip.idx = Math.min(Math.max(Number(st.idx) || 0, 0), vs.length - 1);
    };
    const closeVgStrip = () => { vgStrip.open = false; };
    // 胶片条帧名：与卡片标题同一口径（该版叫「默认」就直接显示组名，不显示占位词）；
    // 帧里的对象是库里的原始卡，没有 _vgKey，所以组名一律取 vgStrip.title
    // 变体切换浮层里也显示完整名（「单眼刘海」），与卡片标题同一口径
    const vgStripName = (v) => vgFullName((v && v.name) || '', String(vgStrip.title || '').trim());
    const pickVgStrip = (i) => {
      if (!vgStrip.versions[i]) return;
      vgStateEnsure(vgStrip.key).idx = i;
      vgStrip.idx = i;
    };
    // ---- C：已选标签三态 ----
    const vgStateOf = (item) => {
      const key = item && item._vgKey;
      if (!key) return null;
      const vs = vgVersionsOf(item);
      if (!vs) return null;
      return vgStateEnsure(key);
    };
    const vgCurIdxOf = (item) => {
      const vs = vgVersionsOf(item) || [];
      const st = item && item._vgKey ? vgState[item._vgKey] : null;
      if (!vs.length) return 0;
      return Math.min(Math.max(st ? Number(st.idx) || 0 : 0, 0), vs.length - 1);
    };
    const vgTagLabel = (item) => {
      const st = vgStateOf(item);
      if (!st) return '';
      const vs = vgVersionsOf(item) || [];
      if (st.mode === 'random') return '🎲';
      if (st.mode === 'traverse') return '∞';
      return '🔒' + (vgCurIdxOf(item) + 1) + '/' + vs.length;
    };
    const vgTagTip = (item) => {
      const st = vgStateOf(item);
      return vgTagTip_text(st);
    };
    const vgTagTip_text = (st) => {
      if (!st) return '';
      if (st.mode === 'random') return '随机变体：预览/运行时每次从这一组里随机取一版（点击 → 切换为顺序轮转）';
      if (st.mode === 'traverse') return '轮转变体：预览/运行时按顺序一版一版轮着走（点击 → 切回锁定）';
      return '锁定变体：固定用卡片当前这一版（点击 → 切换为随机）';
    };
    const vgCycleMode = (item) => {
      const st = vgStateOf(item);
      if (!st) return;
      st.mode = VG_MODE_NEXT[st.mode] || 'locked';
      if (st.mode === 'locked') st.cursor = 0;
    };
    // 运行出口取变体：locked 用当前版；random 每次随机；traverse 顺序轮转并推进游标。
    // 自动模式下一律跳过已静音的变体（整组都静音则不过滤，保证总有变体可用）。
    const resolveVgForRun = (item) => {
      const vs = vgVersionsOf(item);
      if (!vs) return item;
      const st = vgStateEnsure(item._vgKey);
      const n = vs.length;
      let idx;
      if (st.mode === 'locked') {
        idx = Math.min(Math.max(Number(st.idx) || 0, 0), n - 1);
      } else {
        let pool = [];
        for (let i = 0; i < n; i++) { if (!vs[i].mute) pool.push(i); }
        if (!pool.length) { for (let i = 0; i < n; i++) pool.push(i); }
        if (st.mode === 'random') {
          idx = pool[Math.floor(Math.random() * pool.length)];
        } else {
          let cursor = ((Number(st.cursor) || 0) % pool.length + pool.length) % pool.length;
          idx = pool[cursor];
          st.cursor = (cursor + 1) % pool.length;
        }
        st.idx = idx;   // 让卡片与标签上的编号跟着跑，所见即所用
      }
      return Object.assign({}, vs[idx], {
        _vgKey: item._vgKey, _vgIdx: idx, _vgCount: n, _vgVersions: vs,
        _vgTitle: (vgRealMap.value[item._vgKey] || {}).title || item._vgTitle || '',
      });
    };
    // 预览出口取变体：随机模式下也不抖 —— 只按当前游标展示，不推进游标
    const resolveVgForPreview = (item) => {
      const vs = vgVersionsOf(item);
      if (!vs) return item;
      const idx = vgCurIdxOf(item);
      return Object.assign({}, vs[idx], {
        _vgKey: item._vgKey, _vgIdx: idx, _vgCount: vs.length, _vgVersions: vs,
        _vgTitle: (vgRealMap.value[item._vgKey] || {}).title || item._vgTitle || '',
      });
    };
    // 提交前统一过一遍：锁定的换成那一版，随机的每次抽一版，轮转的顺序推进一格
    const applyVgToItems = (list) => (Array.isArray(list) ? list.map(s => resolveVgForRun(s)) : list);

    // ============ 卡片分页（懒渲染）：每页固定数量，避免全量 DOM 膨胀 ============
    const PAGE_SIZE = 80;
    const pageIndex = ref(0);
    const pageCount = computed(() => Math.max(1, Math.ceil(viewCards.value.length / PAGE_SIZE)));
    const visibleFiles = computed(() => {
      const start = pageIndex.value * PAGE_SIZE;
      return viewCards.value.slice(start, start + PAGE_SIZE);
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
    // 筛选/排序/搜索词变化时回到第一页，避免停留在无效页码
    watch(listFiles, () => { pageIndex.value = 0; });

    // ============ 排除词引擎（与节点 modules/studio/node.py::build_prompt 同一套规则）============
    // 段分隔：中英逗号 / 顿号 / 分号 / 换行；段内按空白分词；段内任一命中（OR）即排除。
    // 语义：排除词只删「别的词条」产出的段，永远不删自己；粒度是逗号段（不是整条词条）。
    const splitSegments = (text) => String(text || '').split(/[,，、;；\n\r]+/).map(t => t.trim()).filter(Boolean);
    const parseFilters = (override) => {
      const groups = [];
      splitSegments(override).forEach((raw) => {
        const words = raw.toLowerCase().split(/[\s\u3000]+/).map(w => w.replace(/^\++/, '')).filter(Boolean);
        if (words.length) groups.push(words);
      });
      return groups;
    };
    // list: [{ id, content, override }] → { segments: 保留的段文本, removed: 被删段数 }
    const filterSegments = (list) => {
      const segs = [];
      (list || []).forEach(it => {
        const src = String(it.id || '');
        splitSegments(it.content).forEach(t => segs.push({ src, text: t }));
      });
      const filters = [];
      (list || []).forEach(it => {
        const src = String(it.id || '');
        parseFilters(it.override).forEach(words => filters.push({ src, words }));
      });
      let removed = 0;
      const kept = [];
      segs.forEach((seg) => {
        const low = seg.text.toLowerCase();
        const hit = filters.some(f => {
          if (f.src === seg.src) return false;   // 不删自己
          return f.words.some(w => low.includes(w));
        });
        if (hit) removed++;
        else kept.push(seg.text);
      });
      return { segments: kept, removed };
    };
    // ============ 分类继承（沿 parent_id 向上，只在前端临时展开，不落库） ============
    // 语义：子类自身属性照常生效；父类填了属性就继承下来一起拼接。
    // 顺序 = 根 → 近 → 自身（父级修饰在前、子级内容在后），空值跳过，按小写去重。
    const joinInherit = (vals) => {
      const out = [];
      const seen = new Set();
      vals.forEach(v => {
        const s = String(v == null ? '' : v).trim();
        if (!s) return;
        const k = s.toLowerCase();
        if (seen.has(k)) return;
        seen.add(k);
        out.push(s);
      });
      return out.join(', ');
    };
    // 取卡片的祖先属性链：优先用卡片自带的 anc（后端已按 Tab 根 → 父级顺序给好），
    // 快照里没有时按 relPath 回查当前已加载的卡片。
    const ancOf = (item) => {
      if (item && Array.isArray(item.anc) && item.anc.length) return item.anc;
      const rel = item && item.relPath;
      if (!rel) return [];
      const own = (item.tab && bankData.value[item.tab]) || [];
      let f = own.find(c => c.relPath === rel);
      if (!f) {
        for (const t of Object.keys(bankData.value)) {
          f = (bankData.value[t] || []).find(c => c.relPath === rel);
          if (f) break;
        }
      }
      return (f && Array.isArray(f.anc) && f.anc) || [];
    };
    const expandInherit = (item) => {
      const chain = ancOf(item).concat([{
        en: item.content || '',
        cn: item.content_cn || '',
        neg: item.neg || '',
        override: item.override || '',
      }]);
      return {
        // 中文缺省回落同一层的英文，保证父分类只填英文时中文预览也不会漏段
        content: joinInherit(chain.map(n => n.en)),
        content_cn: joinInherit(chain.map(n => n.cn || n.en)),
        neg: joinInherit(chain.map(n => n.neg)),
        override: joinInherit(chain.map(n => n.override)),
      };
    };
    // 空 id 自愈：历史存档或老拖拽路径可能丢掉词条 id。id 为空时 SaveImage 不写提示词标签，
    // 表现为「这张图的 tag 里没有我选的角色」。这里按 tab + relPath 回查卡片把 id 补回来。
    const healSelectedIds = () => {
      let fixed = 0;
      for (const s of data.selected) {
        if (s.id) continue;
        const cards = bankData.value[s.tab] || [];
        const f = cards.find(x => x.relPath === s.relPath);
        if (f && f.id) { s.id = f.id; fixed++; }
      }
      if (fixed) zhuleLog('healSelectedIds: 补回词条 id 数量', fixed);
      return fixed;
    };

    // 把选中项展开成「已继承」的最终字段（预览与运行出口共用同一套规则）
    const expandItems = (items) => (items || []).map(it => {
      const ex = expandInherit(it);
      return {
        id: it.id || '',
        name: it.name || '',
        relPath: it.relPath || '',
        tab: it.tab || '',
        content: ex.content,
        content_cn: ex.content_cn,
        neg: ex.neg,
        override: ex.override,
      };
    });

    // 预览用：中文模式显示中文段，但删除判定与英文一致性各自独立计算
    const composePreview = (items) => {
      const list = expandItems(items);
      const src = list.map(s => ({ id: s.id || '', content: s.content || '', override: s.override || '' }));
      const en = filterSegments(src);
      if (!pref.translate) return { text: en.segments.join(', '), removed: en.removed };
      const cn = filterSegments(list.map(s => ({
        id: s.id || '',
        content: (s.content_cn && s.content_cn.trim()) ? s.content_cn : s.content,
        override: s.override || '',
      })));
      return { text: cn.segments.join(', '), removed: en.removed };
    };
    const withRemoved = (ph) => (ph.removed ? '（排除 ' + ph.removed + ' 段）' + (ph.text || '（空）') : (ph.text || '（空）'));

    const previewText = computed(() => {
      if (data.randomPools.length) {
        const filled = data.selected.filter(s => !s._ph || s._filled).map(resolveVgForPreview);
        if (filled.length) {
          return '遍历抽取：' + withRemoved(composePreview(filled));
        }
        const lab = (p) => (p.kind === 'tab' ? tabLabel(p.tab) + '(全部)' : p.display);
        const trav = data.randomPools.filter(it => it.traverse).map(lab);
        const rnd = data.randomPools.filter(it => !it.traverse).map(lab);
        const parts = [];
        if (trav.length) parts.push('∞ 遍历池 ' + trav.length + ' 个 [' + trav.join(' | ') + ']');
        if (rnd.length) parts.push('🎲 随机池 ' + rnd.length + ' 个 [' + rnd.join(' | ') + ']');
        const rounds = Math.max(1, Number(pref.genCount) || 0);
        const extra = trav.length
          ? '；遍历池做全组合，次数 ' + rounds + ' = 整套组合重复 ' + rounds + ' 轮'
          : '；无遍历池 ∞，按普通模式逐条运行（每轮各抽 1 条）';
        return parts.join(' → ') + extra;
      }
      const picked = data.selected.filter(s => !s._ph || s._filled).map(resolveVgForPreview);
      if (!picked.length) return '（空）';
      return withRemoved(composePreview(picked));
    });

    // 负面预览：同样是「自身 + 父级分类」拼完的最终结果，与正向一一对应
    const previewNegText = computed(() => {
      if (data.randomPools.length) {
        return '（运行期按实际抽中的提示词拼接 自身 + 父级 负面）';
      }
      const picked = data.selected.filter(s => !s._ph || s._filled).map(resolveVgForPreview);
      if (!picked.length) return '';
      return joinInherit(expandItems(picked).map(s => s.neg));
    });
    // 预览框上的负面提示词折叠开关（唯一入口，直接写回 pref 并持久化）
    const toggleNegPreview = () => { pref.showNegPreview = !pref.showNegPreview; };

    // ============ 工具 ============
    const defaultImageUrl = '/zhule_studio/默认图.png';
    const imageUrl = (path) => {
      if (!path) return '';
      return '/zhule_studio/api/image?path=' + encodeURIComponent(path);
    };
    // 参考图下标：一律按当前 images 实际长度钳制后再取。
    // 存档里的下标是按 relPath 持久化的，图库删图后不会同步回写，
    // 越界下标会让 images[idx] 为 undefined → 卡片黑图、页码显示成 "4/1"。
    const getImgIdx = (file) => {
      const list = (file && file.images) || [];
      const n = list.length;
      if (!n) return 0;
      const raw = Number((data.imgIndices || {})[file.relPath]);
      const i = Number.isFinite(raw) ? Math.trunc(raw) : 0;
      return Math.min(Math.max(i, 0), n - 1);
    };
    const setImgIdx = (file, idx) => {
      if (!file || !file.relPath) return;
      const n = ((file.images) || []).length;
      const i = Number.isFinite(Number(idx)) ? Math.trunc(Number(idx)) : 0;
      data.imgIndices[file.relPath] = n ? Math.min(Math.max(i, 0), n - 1) : 0;
    };
    const displayContent = (file) => (pref.translate && file.content_cn) ? file.content_cn : file.content;
    // 同一张卡片 = tab + relPath 都一致。relPath 从 tab 根开始、不含 tab 名，
    // 全库搜索时不同 tab 下可能存在完全相同的 relPath，只比 relPath 会把两张卡误判成一张。
    // 任一方缺 tab（历史存档）时退回只比路径，保证老存档的选中态照常显示。
    const sameCard = (a, b) => {
      if (!a || !b || a.relPath !== b.relPath) return false;
      const ta = String(a.tab || ''), tb = String(b.tab || '');
      if (!ta || !tb) return true;
      return ta === tb;
    };
    const isFileSelected = (file) => data.selected.some(s => sameCard(s, file));

    // ============ 随机池（多项独立子池：每个右键选中的 tab / chip 各为一池，随机/遍历时各抽一组合；父子互不包含） ============
    // ============ 分类节点即身份：左栏 chip 自带 { id, parentId, name }，路径 key 已废弃 ============
    // 节点显示名：后端 nodes 索引里的 name 本身已是无编号显示名
    const nodeNameOf = (id) => {
      const n = bankNodes.value[String(id || '')];
      return n && n.name ? n.name : '';
    };
    // 由节点 id 上溯祖先 id 链（从顶层到自身，不含大类 Tab 根）：与卡片 chipIds 同口径
    const nodeIdChainById = (id) => {
      const idx = bankNodes.value || {};
      const out = [];
      let cur = String(id || '');
      let guard = 0;
      while (cur && guard++ < 64) {
        const n = idx[cur];
        if (!n) break;
        const p = String(n.parentId || '');
        if (!p) break;            // 无父 = 大类 Tab 根，不属于分类层级
        out.unshift(cur);
        cur = p;
      }
      return out;
    };
    // 分类显示路径（顶层 / … / 自身）：只用于菜单标题、弹层与提示文案，不再当逻辑键
    const nodePathOf = (id) => nodeIdChainById(id).map(x => nodeNameOf(x)).filter(Boolean).join(' / ');

    // 当前选中链上第 depth 层的父节点 id（depth 0 的父 = 当前大类 Tab 根）
    const chipParentId = (depth) => {
      if (depth <= 0) return String(tabIds.value[data.activeTab] || '');
      const sel = getSelections();
      const p = sel[depth - 1];
      return Array.isArray(p) && p.length ? String(p[0] || '') : '';
    };
    // 第 depth 行展开时用到的父节点集合：与 chipLines 同一套规则（选中收敛 / 未选中整层摊开）
    const chipLineParents = (depth) => {
      const tab = data.activeTab;
      let parents = [String(tabIds.value[tab] || '')].filter(Boolean);
      const kids = catKids.value;
      const sel = data.selections[tab] || [];
      for (let d = 0; d < depth; d++) {
        if (!parents.length) return [];
        const used = new Set();
        const opts = [];
        parents.forEach(pid => (kids.get(pid) || []).forEach(o => {
          if (used.has(o.id)) return;
          used.add(o.id); opts.push(o);
        }));
        const picks = sel[d];
        parents = (Array.isArray(picks) && picks.length)
          ? picks.map(x => String(x || '')).filter(Boolean)
          : opts.map(o => String(o.id || '')).filter(Boolean);
      }
      return parents;
    };
    // 该行只有一个父分类时才拿得到唯一父 id（排序落库要求父唯一：多父混排时顺序无从归属）
    const chipParentIdOf = (depth) => {
      const ps = chipLineParents(depth);
      return ps.length === 1 ? ps[0] : '';
    };
    // 同层兄弟节点 id：拖拽排序落库时补齐未展示的节点（保持旧行为「没出现的补末尾」）
    const siblingIdsOf = (parentId, skip) => {
      const idx = bankNodes.value || {};
      const out = [];
      Object.keys(idx).forEach(id => {
        const n = idx[id];
        if (!n) return;
        if (String(n.parentId || '') !== String(parentId || '')) return;
        // 只算「分类层」的兄弟节点：词条节点、空壳锚点不参与分类排序；
        // 分类级 vg 仍是分类层，照常参与排序，否则它会被漏写进 order 而游标错位
        if ((n.type || 'category') !== 'category') return;
        if (skip && skip.has(String(id))) return;
        out.push(String(id));
      });
      return out;
    };
    // 由节点 id 取祖先 id 链（与卡片 chipIds 同口径：不含大类 Tab 根），供池父子冲突判断
    const chipIdChain = (tab, id) => nodeIdChainById(id);
    const chipDisplayFor = (tab, id) => nodeNameOf(id) || String(id || '');
    // 随机池父子冲突按 DB id 链判断：同链上谁浅谁包含谁，提示一律用无编号显示名
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
          if (!it.chipId) continue;
          if (myChain.length === 0) return { conflict: true, msg: `「${theirName}」已进池，不能再加入整个「${tabLabel(tab)}」` };
          if (myChain.includes(String(it.chipId))) return { conflict: true, msg: `「${theirName}」已进池，它包含「${chipDisplayFor(tab, chipId)}」，父子不能同时进池` };
          if (chipIdChain(tab, it.chipId).includes(String(chipId))) return { conflict: true, msg: `「${chipDisplayFor(tab, chipId)}」包含已进池的「${theirName}」，父子不能同时进池` };
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
    // 池类型（池级标记）：traverse=true 为遍历池 ∞（参与笛卡尔积全量穷举），
    // traverse=false 为随机池 🎲（每个组合现抽 1 条）。右键在「无 → 随机 → 遍历 → 无」三态间循环
    const isTabTraversePool = (tab) => data.randomPools.some(it => it.kind === 'tab' && it.tab === tab && !!it.traverse);
    // 大类下有任意提示词被选中时高亮该 tab
    const tabHasSelected = (name) => {
      const cards = bankData.value[name] || [];
      if (!cards.length) return false;
      const rels = new Set(cards.map(c => c.relPath));
      return data.selected.some(s => rels.has(s.relPath));
    };
    // 左栏 chip 是 { id, parentId, name } 对象：入池判断、高亮全部按节点 id 比对
    const isChipInPool = (chip) => {
      const tab = data.activeTab;
      const id = String((chip && chip.id) || '');
      if (!id) return false;
      return data.randomPools.some(it => it.kind === 'chip' && it.tab === tab && String(it.chipId || '') === id);
    };
    const isChipTraversePool = (chip) => {
      const tab = data.activeTab;
      const id = String((chip && chip.id) || '');
      if (!id) return false;
      return data.randomPools.some(it => it.kind === 'chip' && it.tab === tab && !!it.traverse && String(it.chipId || '') === id);
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
    // 新分类排到末尾：把顶层顺序落一次库（不再有手动保存按钮）
    await saveTabOrder('');
  } finally {
    addingTab.value = false;
  }
};
    const switchTab = (name) => {
      // 搜索态下点任意 tab = 退出搜索，回到该 tab 的分类浏览（词条都在内存里，零请求）
      if (searchQ.value) clearSearch();
      if (data.activeTab === name) return;
      data.activeTab = name;
      // 切大类一律回到「全部」：清掉该 tab 下残留/存档恢复的分类选中。
      // 不清的话切过去就像「还没加载」，必须再点一次分类才出词条（旧行为是切换即全量）。
      const sel = data.selections && data.selections[name];
      if (Array.isArray(sel) && sel.some(a => Array.isArray(a) && a.length)) {
        data.selections[name] = new Array(maxDepth.value).fill(null).map(() => []);
        saveState();
      }
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
    const toggleChip = (depth, chip) => {
      const id = String((chip && chip.id) || '');
      if (!id) return;
      const sel = getSelections();
      if (!Array.isArray(sel[depth])) sel[depth] = [];
      if (sel[depth].length === 1 && String(sel[depth][0]) === id) {
        // 搜索态下点「已选中的同一个分类」= 用内存里已有的分类数据回填、覆盖搜索结果，
        // 选中态保持不变（不取消），也不发任何请求
        if (searchQ.value) { clearSearch(); return; }
        sel[depth] = [];
      } else {
        sel[depth] = [id];
        // 设置项开启时，点击分类自动把整条父链选中（父链直接由 parentId 上溯，无需解析路径）
        if (pref.autoSelectParent) {
          const chain = nodeIdChainById(id);
          for (let i = 0; i < depth && i < chain.length - 1; i++) {
            if (!Array.isArray(sel[i])) sel[i] = [];
            sel[i] = [chain[i]];
          }
        }
      }
      for (let i = depth + 1; i < Math.max(maxDepth.value, sel.length); i++) sel[i] = [];
    };
    const clearChip = (depth) => {
      const sel = getSelections();
      sel[depth] = [];
      for (let i = depth + 1; i < Math.max(maxDepth.value, sel.length); i++) sel[i] = [];
    };
    // 池类型变了（🎲↔∞）之后：该池占位符的名字前缀要跟着换，
    // 之前的「已抽定」结果同步作废（池语义已变，旧抽定不再代表这个池），回到未填充占位符
    const refreshPoolPlaceholder = (item) => {
      const k = poolKeyFor(item);
      const want = placeholderFor(item).name;
      for (const s of data.selected) {
        if (!s._ph || s._poolKey !== k) continue;
        if (s.name === want && !s._filled) continue;
        s.name = want;
        s._filled = false;
        delete s.relPath; delete s.id; delete s.content; delete s.content_cn;
        delete s.neg; delete s.override;
      }
    };

    // ============ 分类右键菜单 + 编辑分类（统一入口） ============
    // 大类 tab / 小类 chip / 空层占位右键都出同一个菜单：第一项固定「编辑分类」，
    // 之后才是原有池三态与新建入口，原有肌肉记忆不打乱。
    // fileCount：该分类（含子分类）下的词条数，-1 = 大类数据还没加载；catPicked：该分类是否正处在整类选中态。
    const catMenu = reactive({ open: false, x: 0, y: 0, kind: 'tab', key: '', id: '', name: '', depth: 0, title: '', pool: 'all', muted: false, hasChildCat: false, hasVgChild: false, toVgShown: false, canToVg: false, toVgWhy: '', fileCount: -1, catPicked: false });

    // 分类节点定位：tab 用大类名换 Tab 根 id；chip 传进来的就是节点 id 本身，无需任何反查
    const nodeOfCat = (kind, keyOrId) => (kind === 'tab'
      ? (bankNodes.value[String(tabIds.value[keyOrId] || '')] || null)
      : (bankNodes.value[String(keyOrId || '')] || null));
    // 该分类下是否还挂着子分类：变体组的分类级形态只允许落在「末级分类」。
    // 分类下还有子分类时，把它标成变体组会把整棵子树的词条都压进一张卡，语义和入口全乱，
    // 所以菜单项直接不给点（后端 post_wordbank_vg 也会再拦一次，前端只是提前告知）。
    const catHasChildCat = (id) => {
      const key = String(id || '');
      if (!key) return false;
      const idx = bankNodes.value || {};
      return Object.keys(idx).some((k) => {
        const n = idx[k];
        return n && String(n.parentId || '') === key && String(n.type || 'category') === 'category';
      });
    };
    // 该分类下是否已经挂着词条：空分类聚拢成变体组只会得到一个「没有任何变体的组」，
    // 菜单项直接不给点（后端 post_wordbank_convert 也会再拦一次，前端只是提前告知）。
    const catHasEntry = (id) => {
      const key = String(id || '');
      if (!key) return false;
      const idx = bankNodes.value || {};
      return Object.keys(idx).some((k) => {
        const n = idx[k];
        return n && String(n.parentId || '') === key && String(n.type || 'category') === 'entry';
      });
    };
    // 该分类下是否已经挂着「变体卡」（= 子项是 entry 且自己还有子条目）。
    // 这种子项本身就是变体组，再往上聚拢就会变成「变体组里套变体组」，前端渲染时组头渲染成组头、
    // 内层组头又被当成普通卡片，结果就是分类部件消失但提示词看起来没变化。所以这种情况不给聚拢。
    const catHasVgChild = (id) => {
      const key = String(id || '');
      if (!key) return false;
      const idx = bankNodes.value || {};
      const withKids = new Set();
      Object.keys(idx).forEach((k) => {
        const n = idx[k];
        if (n && String(n.parentId || '')) withKids.add(String(n.parentId));
      });
      return Object.keys(idx).some((k) => {
        const n = idx[k];
        return n
          && String(n.parentId || '') === key
          && String(n.type || 'category') === 'entry'
          && withKids.has(String(n.id));
      });
    };
    // 池三态：tab 传入大类名，chip 传入节点 id
    const poolKindOf = (kind, keyOrId) => {
      const tab = data.activeTab;
      if (kind === 'tab') {
        const it = data.randomPools.find(p => p.kind === 'tab' && p.tab === keyOrId);
        return it ? (it.traverse ? 'traverse' : 'random') : 'all';
      }
      const id = String(keyOrId || '');
      if (!id) return 'all';
      const it = data.randomPools.find(p => p.kind === 'chip' && p.tab === tab && String(p.chipId || '') === id);
      return it ? (it.traverse ? 'traverse' : 'random') : 'all';
    };
    const openCatMenu = (evt, kind, keyOrNode, depth) => {
      if (!data.activeTab) return;
      const isChip = kind === 'chip';
      const node = isChip ? (keyOrNode || null) : null;
      const id = isChip ? String((node && node.id) || '') : String(tabIds.value[keyOrNode] || '');
      catMenu.open = true;
      catMenu.kind = kind;
      catMenu.key = isChip ? id : keyOrNode;   // tab：大类名；chip：分类节点 id
      catMenu.id = id;
      catMenu.name = isChip ? ((node && node.name) || '') : tabLabel(keyOrNode);
      catMenu.depth = isChip ? depth : 0;
      catMenu.title = isChip ? (nodePathOf(id) || catMenu.name) : tabLabel(keyOrNode);
      catMenu.pool = poolKindOf(kind, isChip ? id : keyOrNode);
      catMenu.muted = !!((nodeOfCat(kind, isChip ? id : keyOrNode) || {}).mute);

      // 该分类下是否还挂着子分类：变体组的分类级形态只允许落在「末级分类」上
      catMenu.hasChildCat = isChip ? catHasChildCat(id) : false;
      // 该分类下是否已经挂着变体卡：变体卡自己就是一个组，再往上聚拢会变成组套组
      catMenu.hasVgChild = isChip ? catHasVgChild(id) : false;
      // 「分类 → 变体」互转是否可用：非 Tab、真分类、末级（无子分类）、有父级、且其下已有词条。
      // chip 视图对象只带 {id,parentId,name}（没有 type/vg），所以类型一律回 bankNodes 里查全量节点。
      const catNode = isChip ? ((bankNodes.value || {})[id] || null) : null;
      // 是真分类（非 Tab 根、非变体卡/组头）就一直显示这一项，不满足条件时置灰并说明原因，
      // 避免「菜单里莫名其妙没有这一项」。
      catMenu.toVgShown = isChip && !!catNode
        && String(catNode.type || '') === 'category'
        && !!String(catNode.parentId || '');
      catMenu.canToVg = catMenu.toVgShown
        && !catMenu.hasChildCat
        && !catMenu.hasVgChild
        && catHasEntry(id);
      catMenu.toVgWhy = !catMenu.toVgShown ? ''
        : (catMenu.hasVgChild
          ? '该分类下已经是变体卡，再聚拢会变成「变体组里套变体组」；先把它们转回分类再聚拢'
          : (catMenu.hasChildCat
            ? '该分类下还有子分类，只能对末级分类聚拢成变体卡'
            : (!catHasEntry(id) ? '该分类下还没有词条，聚拢只会得到一个空组' : '')));
      // 分类项数：只喂给标题右上角的数量角标（大类是懒加载的，没拉过给 -1，角标显示「未加载」）。
      const pickTab = isChip ? data.activeTab : keyOrNode;
      const pickId = isChip ? id : '';
      catMenu.fileCount = Array.isArray((bankData.value || {})[pickTab])
        ? catFilesOf(pickTab, pickId).length
        : -1;
      catMenu.catPicked = catPickSel.has(catPickKey(pickTab, pickId));
      // 贴边翻转，避免菜单跑出窗口
      catMenu.x = Math.max(8, Math.min(evt.clientX, window.innerWidth - 240));
      catMenu.y = Math.max(8, Math.min(evt.clientY, window.innerHeight - 430));
    };
    const closeCatMenu = () => { catMenu.open = false; };

    // ============ 分类静音（自动继承到其下全部词条） ============
    // 语义：分类节点 mute=1 → 其下所有词条在本页等效静音：不进随机池抽词/遍历穷举等自动选词，
    // 开启「隐藏静音」时整组从卡片区与分类标签里消失。只在内存里向下传播、不写库，
    // 每次 load 重算，取消分类静音后自然恢复；词条自身的 mute 字段不受破坏。
    const catMuteBusy = ref(false);
    const isCatMuted = (kind, key) => !!((nodeOfCat(kind, key) || {}).mute);
    const catMuteIds = computed(() => {
      const set = new Set();
      const all = bankNodes.value || {};
      Object.keys(all).forEach(id => {
        const n = all[id];
        if (n && n.mute) set.add(String(n.id || id));
      });
      return set;
    });
    // 分类静音按 id 祖先链判定：词条 id 上溯链路命中任一静音分类即视为被分类静音，
    // 静音顶层 tab 也自然覆盖其下全部词条（与旧的路径前缀判定等价，但不再依赖 path 字段）。
    const mutedByCat = (id, tab) => {
      const ids = catMuteIds.value;
      if (!ids.size) return '';
      // 大类 Tab 根不在 id 祖先链里（链路遇到无父即止），单独按卡片所属 tab 判一次
      const rootId = tab ? String(tabIds.value[tab] || '') : '';
      if (rootId && ids.has(rootId)) return rootId;
      if (!id) return '';
      const chain = nodeIdChainById(id);
      for (const x of chain) if (ids.has(String(x))) return String(x);
      return '';
    };
    const inheritCategoryMute = () => {
      if (!catMuteIds.value.size) return;
      Object.keys(bankData.value || {}).forEach(tab => {
        const list = bankData.value[tab];
        if (!Array.isArray(list)) return;
        list.forEach(f => {
          if (f.mute) return;   // 词条自身已静音，保留原状
          const hit = mutedByCat(f.id, f.tab);
          if (hit) { f.mute = 1; f.muteFromCat = hit; }
        });
      });
    };
    const toggleCatMute = async () => {
      const kind = catMenu.kind;
      const key = catMenu.key;
      const title = catMenu.title;
      const n = nodeOfCat(kind, key);
      closeCatMenu();
      if (!n || !n.id) { showToast('没找到该分类节点，刷新一下再试', 'warn'); return; }
      if (catMuteBusy.value) return;
      const target = !n.mute;
      catMuteBusy.value = true;
      try {
        const resp = await fetch('/zhule_studio/api/wordbank/mute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: n.id, mute: target }),
        });
        const json = await resp.json();
        if (json.error) { showToast('设置失败：' + json.error, 'error'); return; }
        showToast((json.mute ? '已静音该分类：' : '已取消静音：') + title
          + (json.mute ? '（其下全部词条都不再参与自动选词，手动点选仍可用）' : ''), 'success', 3000);
        await load(true);
      } catch (e) {
        showToast('请求失败：' + e.message, 'error');
      } finally {
        catMuteBusy.value = false;
      }
    };

    // ============ 词库卡片右键菜单 ============
    // 卡片上原有的图标操作（编辑/静音/上传参考图/删除词条/进入详情/放大/删除参考图）全部在此复制一遍，
    // 左右切换与 🎲 骰子属于高频操作，始终保留在卡片上；开启「隐藏卡片上的图标」后右键菜单成为唯一入口。
    const cardMenu = reactive({ open: false, x: 0, y: 0, file: null, title: '', muted: false, hasImages: false, picked: false, pickCount: 0, vgCount: 0, isVg: false, vgTitle: '', canVg: false, canToCategory: false });
    const openCardMenu = (evt, file) => {
      if (!file) return;
      closeCatMenu();
      cardMenu.file = file;
      // 菜单抬头也显示完整名（与卡片标题一致），否则编辑弹窗里叫「进气口刘海」、右键抬头还叫「默认」
      cardMenu.title = cardDisplayName(file);
      cardMenu.muted = !!file.mute && !file.muteFromCat;
      cardMenu.hasImages = !!(file.images && file.images.length);
      // 该卡片是否在框选集合里 → 决定右键菜单是否多出「凝结为池」两项
      cardMenu.picked = isPicked(file);
      cardMenu.pickCount = pickSel.size;
      // 变体组卡片才有「变体胶片条」入口；单条/非变体组恒为 0，菜单项自动隐藏
      cardMenu.vgCount = (file._vgVersions && file._vgVersions.length) || 0;
      cardMenu.isVg = !!file._vgKey;
      cardMenu.vgTitle = vgGroupTitle(file) || '';
      // 「变体 → 分类」：只要是变体组（组节点是 entry）就能拆回分类，改的只是 type 一位，
      // 各变体库里存的一直是短名，不需要摘任何前缀。
      const aid = vgAnchorIdOf(file);
      const anode = aid ? ((bankNodes.value || {})[String(aid)] || null) : null;
      cardMenu.canToCategory = !!(cardMenu.isVg && anode && String(anode.type || '') === 'entry');

      cardMenu.canVg = !!cardCatIdOf(file);
      cardMenu.x = Math.max(8, Math.min(evt.clientX, window.innerWidth - 230));
      cardMenu.y = Math.max(8, Math.min(evt.clientY, window.innerHeight - 380));
      cardMenu.open = true;
    };
    const closeCardMenu = () => { cardMenu.open = false; };
    // 菜单项：先收起菜单再触发动作，避免遮罩层挡住后续弹窗与拖拽
    const onCardEdit = () => { const f = cardMenu.file; closeCardMenu(); if (f) openEdit(f); };
    const onCardMute = () => { const f = cardMenu.file; closeCardMenu(); if (f) toggleMute(f); };
    const onCardUpload = () => { const f = cardMenu.file; closeCardMenu(); if (f) openUploadRef(f); };
    const onCardDeleteWord = () => { const f = cardMenu.file; closeCardMenu(); if (f) askDeleteWord(f); };
    const onCardGallery = () => { const f = cardMenu.file; closeCardMenu(); if (f) goToGallery(f); };
    const onCardZoom = () => { const f = cardMenu.file; closeCardMenu(); if (f) zoomCardImage(f); };
    const onCardDeleteRef = () => { const f = cardMenu.file; closeCardMenu(); if (f) askDeleteRef(f); };
    const onCardVgStrip = () => { const f = cardMenu.file; closeCardMenu(); if (f) openVgStrip(f); };
    const onCardVgRename = () => { const f = cardMenu.file; closeCardMenu(); if (f) openVgRename(f); };

    // ---- 框选凝结成池 ----
    // 与 tab / chip 池完全同构的自定义池（kind:'list'）：同样有 traverse 区分 🎲 随机池 / ∞ 遍历池，
    // 同样在已选区生成黄色占位符，同样参与单次随机与遍历穷举。差别只在候选来源：
    // 不是某个分类下的词条，而是框选时点名的这批卡片（按 tab + relPath 存，取用时实时回查，
    // 词条改名/移动不影响，被删则自动跳过）。
    const condenseSig = (items) => (items || []).map(e => e.tab + '/' + e.relPath).sort().join('\n');
    const onCardCondense = (traverse) => {
      closeCardMenu();
      const files = pickedFiles();
      if (!files.length) { showToast('已选项已失效，请重新选择', 'warn'); return; }
      const items = files.map(f => ({ tab: f.tab || data.activeTab, relPath: f.relPath, id: f.id || '', name: f.name }));
      const sig = condenseSig(items);
      const label = traverse ? '遍历池 ∞' : '随机池 🎲';
      let pool = data.randomPools.find(it => it.kind === 'list' && condenseSig(it.items) === sig);
      if (pool) {
        const same = !!pool.traverse === !!traverse;
        pool.traverse = !!traverse;
        syncPlaceholders();
        showToast(same
          ? `这 ${items.length} 项已经是「${label}」了`
          : `「${pool.display}」已改为${label}`, same ? 'success' : 'success', 2400);
      } else {
        pool = {
          kind: 'list', poolId: 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          tab: '', path: [], display: '凝结' + items.length + '项', items, traverse: !!traverse,
        };
        data.randomPools.push(pool);
        syncPlaceholders();
        showToast(`${items.length} 项已凝结为${label}，已加入下方池子`, 'success', 2600);
      }
      zhuleLog('onCardCondense', { kind: 'list', poolId: pool.poolId, count: items.length, traverse: !!traverse }, 'selected=', selSummary());
      clearPick();
    };
    // 池三态：直接复用原有 toggle 逐级推进，校验（父子链冲突提示）与三态循环完全一致
    // tab 传入大类名，chip 传入分类节点 id
    const setPoolBy = (kind, keyOrId, want) => {
      for (let i = 0; i < 4; i++) {
        const cur = poolKindOf(kind, keyOrId);
        if (cur === want) return;
        if (kind === 'tab') togglePoolForTab(keyOrId);
        else togglePoolForChip(keyOrId);
        if (poolKindOf(kind, keyOrId) === cur) return; // 被冲突拦住，别空转
      }
    };
    const onCtxPool = (want) => {
      const m = { kind: catMenu.kind, key: catMenu.key, name: catMenu.name };
      closeCatMenu();
      setPoolBy(m.kind, m.key, want);
    };

    // ---- 分类右键「选中」 ----
    // 与 Ctrl/⌘+左键点分类用的是同一套数据（pickSel + catPickSel），只是入口从「左键+修饰键」挪到右键：
    // 只负责整类加入/剔除已选，可叠加多选；要成池走状态条的 🎲/∞ 凝结按钮（不在本菜单里再开一条重复入口）。
    const onCtxCatPick = () => {
      const kind = catMenu.kind;
      // tab 传入大类名；chip 传入分类节点 id（catMenu.id 对两者都是真实节点 id，但 tab 走的是类名键）
      const key = kind === 'tab' ? catMenu.key : catMenu.id;
      const name = catMenu.name;
      closeCatMenu();
      toggleCatPick(kind, key, name);
    };


    // ============ 分类 ⇄ 变体 互转（两者本质同构，只差 type 一位） ============
    // 同一件事的两个方向，走同一个后端接口，只差 to：
    //   to='vg'       末级分类 → 变体组（该分类自己变成 type=entry 的组节点，其下词条成为各变体）
    //   to='category' 变体组 → 分类（组名当分类名，各变体平铺成该分类下的独立卡片）
    // 名字一律只存短名、组名靠渲染层拼，所以转换只动 type 一位，一个字的名字都不用改。

    const convertBusy = ref(false);
    const doConvert = async (id, to) => {
      const nid = String(id || '');
      if (!nid || convertBusy.value) return;
      convertBusy.value = true;
      try {
        const resp = await fetch('/zhule_studio/api/wordbank/convert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: nid, to }),
        });
        const json = await resp.json();
        if (json.error) { showToast('转换失败：' + json.error, 'error', 3600); return; }
        const moved = Number(json.children || json.moved || 0);

        showToast(to === 'category'
          ? '已把变体组「' + (json.name || '') + '」还原成分类'
            + (moved ? '（' + moved + ' 个变体平铺成该分类下的独立卡片）' : '')
          : '已把分类「' + (json.name || '') + '」聚拢成变体卡'
            + (moved ? '（' + moved + ' 条提示词成为组内各变体，合并成 1 张卡翻页）' : ''),

          'success', 3800);
        await load(true);
      } catch (e) {
        showToast('请求失败：' + e.message, 'error');
      } finally {
        convertBusy.value = false;
      }
    };
    const onCtxToVg = () => {
      const id = catMenu.id;
      closeCatMenu();
      doConvert(id, 'vg');
    };
    const onCardToCategory = () => {
      const id = cardMenu.file ? vgAnchorIdOf(cardMenu.file) : '';
      closeCardMenu();
      doConvert(id, 'category');
    };

    // ---- 从卡片直接管变体：新建变体 / 一键标为变体组（不必再回左侧分类树右键） ----
    // 卡片所属的最末级分类 id（必须真是分类节点，Tab 根与散卡返回空）
    const cardCatIdOf = (card) => {
      const ids = Array.isArray(card && card.chipIds) ? card.chipIds : [];
      if (!ids.length) return '';
      const id = ids[ids.length - 1];
      const n = bankNodes.value[id];
      if (!n || String(n.type || '') !== 'category') return '';
      return String(id);
    };
    // 变体组锚点 id：_vgKey 形如 tab|锚点id。新变体一律挂到锚点下面（变体之间平等，无母体继承）
    const vgAnchorIdOf = (f) => {
      const k = f && f._vgKey;
      if (!k) return '';
      const s = String(k);
      const i = s.indexOf('|');
      return i >= 0 ? s.slice(i + 1) : '';
    };
    const openNewVersionFor = (f) => {
      if (!f) return;
      const anchorId = vgAnchorIdOf(f) || cardCatIdOf(f);
      if (!anchorId) { showToast('这张卡不在分类或变体组下，先把它放进分类再建变体', 'warn'); return; }
      openAddCard({ parentId: anchorId, label: vgNewVersionPrefix(f) });
    };

    // ============ 修改变体组名（只改组节点自己的 name，零级联） ============
    // 组名就是这个变体组节点自己的 name；各变体库里只存短名，「组名#短名」是渲染时拼的，
    // 所以改完这一个名字，全组显示名自动跟着变，不需要刷新任何子条目。

    const vgRenameOpen = ref(false);
    const vgRenaming = ref(false);
    const vgRenameName = ref('');
    const vgRenameTargetId = ref('');
    const vgRenameKey = ref('');
    const vgRenameCount = computed(() => {
      const g = vgRenameKey.value ? vgRealMap.value[vgRenameKey.value] : null;
      return g ? (g.real || []).length : 0;
    });
    // 改名前给个示例：组名改完，卡片上方那枚标志、以及「默认」版的标题会一起变成新名字，
    // 其余版本仍是「新组名 · 自身名」
    const vgRenamePreview = computed(() => {
      const nm = (vgRenameName.value || '').trim();
      const key = vgRenameKey.value;
      const g = key ? vgRealMap.value[key] : null;
      if (!nm || !g) return '';
      const v = (g.real || [])[0];
      if (!v) return nm;
      const short = vgShortName(v.name, String(g.title || '')).trim();
      return (!short || short === '默认') ? nm : (nm + ' · ' + short);
    });

    const openVgRename = (file) => {
      if (!file) return;
      const anchorId = vgAnchorIdOf(file) || cardCatIdOf(file);
      if (!anchorId) { showToast('这一组没有可改名的锚点', 'warn'); return; }
      const gn = (bankNodes.value || {})[String(anchorId)] || null;
      const title = String((gn && gn.name) || vgGroupTitle(file) || '').trim();

      if (!title) { showToast('读不到组名，先刷新一下', 'warn'); return; }
      vgRenameTargetId.value = String(anchorId);
      vgRenameKey.value = file._vgKey || '';
      vgRenameName.value = title;
      vgRenameOpen.value = true;
    };
    const closeVgRename = () => {
      vgRenameOpen.value = false;
      vgRenaming.value = false;
      vgRenameName.value = '';
      vgRenameTargetId.value = '';
      vgRenameKey.value = '';
    };
    const submitVgRename = async () => {
      const nm = (vgRenameName.value || '').trim();
      if (!nm) { showToast('组名不能为空', 'warn'); return; }
      if (vgRenaming.value || !vgRenameTargetId.value) return;
      vgRenaming.value = true;
      try {
        const resp = await fetch('/zhule_studio/api/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: vgRenameTargetId.value, name: nm }),
        });
        const json = await resp.json();
        if (json.error) { showToast('改名失败：' + json.error, 'error'); return; }
        showToast('组名已改：' + nm + '（卡片上方的组名标志自动跟着变）', 'success');

        closeVgRename();
        await load(true);
      } catch (e) {
        showToast('改名请求失败：' + e.message, 'error', 3600);
      } finally {
        vgRenaming.value = false;
      }
    };
    const onCardNewVersion = () => {
      const f = cardMenu.file;
      closeCardMenu();
      openNewVersionFor(f);
    };
    // ============ 聚拢成变体组（提示词入口，单个 / 多选共用） ============
    // 组头一律新建：后端在建组时插一条空 entry 当组头，再把这批卡改挂到它下面，
    // 所以不存在「借第一张卡当组头」这种由点击顺序决定的结构，也没有随机的挂载父级。
    // 前提是这批卡父级完全一致（同一个分类），否则没法确定组头挂哪儿，直接拒绝。

    const vgJoin = reactive({ open: false, name: '', suggest: '', parentName: '', busy: false, items: [] });
    // 变体名：只留短名那段；老库里残留的「旧组#名」前缀在这里现剥，避免拼出「新组#旧组#变体」套娃
    const vgJoinTail = (f) => vgShortName((f && f.name) || '').trim();

    const vgJoinPreview = computed(() => {
      const nm = (vgJoin.name || '').trim();
      const first = vgJoin.items[0];
      if (!nm || !first) return '';
      const tail = vgJoinTail(first);
      return (!tail || tail === '默认') ? nm : (nm + ' · ' + tail);
    });
    const vgJoinNames = computed(() => vgJoin.items.map(it => vgJoinTail(it)).join('、'));
    const closeVgJoin = () => {
      vgJoin.open = false;
      vgJoin.name = '';
      vgJoin.suggest = '';
      vgJoin.parentName = '';
      vgJoin.busy = false;
      vgJoin.items = [];
    };
    const openVgJoin = (f, fromPick) => {
      const list = fromPick ? pickedFiles() : (f ? [f] : []);
      const items = list.filter(x => x && x.id);
      if (!items.length) { showToast('这几张卡还没有库内 id，刷新一下再试', 'warn'); return; }
      // 一个组只能有一个组头：选中的卡里若横跨了两个以上已有的组，先让他自己拆开
      const keys = new Set();
      items.forEach((x) => {
        const k = x._vgKey || '';
        if (k) keys.add(String(k));
      });
      if (keys.size > 1) {
        showToast('选中的卡片分属 ' + keys.size + ' 个不同变体组，一次只能并入同一个组', 'warn', 3600);
        return;
      }
      // 新组头挂到哪个父级下，由这批卡在库里的「真实父节点」唯一决定（不是点击先后）。
      // 父级必须全部相等：跨分类聚拢会把词条从原分类里搬走，组头也无处安放，直接拦下。
      const pids = new Set();
      let orphan = 0;
      items.forEach((x) => {
        const pid = String(((bankNodes.value || {})[String(x.id)] || {}).parentId || '');
        if (!pid) { orphan += 1; return; }
        pids.add(pid);
      });
      if (orphan || pids.size !== 1) {
        showToast('选中的这批提示词不在同一个分类下（父级必须完全一致），无法聚拢成一个变体组', 'warn', 4400);
        return;
      }
      const parentNode = bankNodes.value[[...pids][0]] || {};
      vgJoin.items = items;
      vgJoin.name = '';
      vgJoin.suggest = String(parentNode.name || '');
      vgJoin.parentName = String(parentNode.name || '');
      vgJoin.busy = false;
      vgJoin.open = true;
    };
    const submitVgJoin = async () => {
      const nm = (vgJoin.name || '').trim();
      if (!nm) { showToast('组名不能为空', 'warn'); return; }
      if (nm.startsWith('.')) { showToast('组名不能以点开头', 'warn'); return; }
      if (/[\\/:*?"<>|]/.test(nm) || nm.indexOf('#') >= 0) {
        showToast('组名不能包含 \\ / : * ? " < > | # 这些字符', 'warn', 3800);
        return;
      }
      if (vgJoin.busy || !vgJoin.items.length) return;
      vgJoin.busy = true;
      try {
        const resp = await fetch('/zhule_studio/api/wordbank/vg-join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: vgJoin.items.map(x => String(x.id)), name: nm }),
        });
        const json = await resp.json();
        if (json.error) { showToast('聚拢失败：' + json.error, 'error', 4400); return; }
        const n = Number(json.count || 0);
        const gname = String(json.group || nm);
        showToast('已新建变体组「' + gname + '」，' + n + ' 条提示词挂到该组下', 'success', 3600);

        closeVgJoin();
        clearPick();
        await load(true);
      } catch (e) {
        showToast('并入请求失败：' + e.message, 'error', 3600);
      } finally {
        vgJoin.busy = false;
      }
    };
    const onCardVgJoin = () => {
      const f = cardMenu.file;
      const fromPick = !!(f && isPicked(f));
      closeCardMenu();
      if (!f) return;
      openVgJoin(f, fromPick);
    };

    // ---- 编辑分类弹层：分类自己的 en / cn / neg / 排除，子级词条自动继承 ----
    const catEdit = reactive({
      open: false, kind: 'tab', key: '', id: '', origName: '', pathLabel: '',
      name: '', en: '', cn: '', neg: '', override: '', provide: true,
    });
    const catSaving = ref(false);
    const openCatEdit = (kind, key) => {
      const n = nodeOfCat(kind, key);
      if (!n) { showToast('没找到该分类节点，刷新一下再试', 'warn'); return; }
      catEdit.open = true;
      catEdit.kind = kind;
      catEdit.key = key;
      catEdit.id = n.id;
      catEdit.origName = n.name || '';
      catEdit.name = n.name || '';
      catEdit.en = n.en || '';
      catEdit.cn = n.cn || '';
      catEdit.neg = n.neg || '';
      catEdit.override = n.override || '';
      // provide 缺省视为可继承（后端默认 1，只有显式 0 才断链）
      catEdit.provide = n.provide !== 0;
      catEdit.pathLabel = kind === 'tab'
        ? tabLabel(key)
        : (nodePathOf(n.id) || n.name || '');
    };
    const closeCatEdit = () => { if (!catSaving.value) catEdit.open = false; };
    const submitCatEdit = async () => {
      if (catSaving.value) return;
      const name = (catEdit.name || '').trim();
      if (!name) { showToast('分类名不能为空', 'warn'); return; }
      catSaving.value = true;
      try {
        // 改名与属性一次提交（后端 post_rename 已放宽到分类节点）
        const resp = await fetch('/zhule_studio/api/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: catEdit.id,
            name,
            content: catEdit.en || '',
            content_cn: catEdit.cn || '',
            neg: catEdit.neg || '',
            override: catEdit.override || '',
            provide: catEdit.provide ? 1 : 0,
          }),
        });
        const json = await resp.json();
        if (!resp.ok) { showToast(json.error || '保存失败', 'error'); return; }
        const nid = catEdit.id;
        if (bankNodes.value[nid]) {
          Object.assign(bankNodes.value[nid], {
            name,
            en: catEdit.en || '',
            cn: catEdit.cn || '',
            neg: catEdit.neg || '',
            override: catEdit.override || '',
            provide: catEdit.provide ? 1 : 0,
          });
        }
        catEdit.open = false;
        showToast('分类已保存', 'success');
        // 分类属性会影响其下所有词条的继承结果，强刷当前词库
        await load(true);
      } finally {
        catSaving.value = false;
      }
    };

    // ---- 删除分类：连同其下所有子分类与词条（后端 delete_subtree 软删，isdel=1 可恢复） ----
    // 入口两处：分类右键菜单的「🗑 删除该分类」与编辑分类弹层的「删除」按钮。
    // 大类 Tab 根不提供删除（后端 post_wordbank_delete 明确拒绝，防止误删整库）。
    const deletingCat = ref(false);
    const askDeleteCat = (kind, key) => {
      const n = nodeOfCat(kind, key);
      if (!n) { showToast('没找到该分类节点，刷新一下再试', 'warn'); return; }
      if (kind === 'tab') { showToast('大类（Tab 根）不可删除', 'warn', 2600); return; }
      const label = nodePathOf(n.id) || n.name || String(n.id);
      del.ask({
        title: '确认删除分类',
        message: '是否确认删除该分类「' + label + '」？它下面的所有子分类与词条会一并删除'
          + '（数据仍保留在库中，可后续恢复）。相关参考图会归档到 zhule_reference/_trash，可在需要时找回。',
        name: label,
        run: () => deleteCatNow(n.id, label),
      });
    };
    const deleteCatNow = async (id, label) => {
      if (deletingCat.value) return;
      deletingCat.value = true;
      try {
        const resp = await fetch('/zhule_studio/api/wordbank/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: String(id) }),
        });
        const json = await resp.json();
        if (!resp.ok || json.error) { showToast('删除失败：' + (json.error || resp.status), 'error'); return; }
        // 编辑弹层若正停在被删分类上，直接关掉
        if (catEdit.open && String(catEdit.id) === String(id)) catEdit.open = false;
        // 被删分类可能正处在左侧选区链上 → 逐层清空选区，避免停留在已失效目录
        const sel = getSelections();
        for (let i = 0; i < Math.max(maxDepth.value, sel.length); i++) sel[i] = [];
        pageIndex.value = 0;
        showToast('已删除分类：' + label + '（共 ' + (json.deleted || 0) + ' 项）'
          + (json.refDirsPurged ? '，参考图已归档 ' + json.refDirsPurged + ' 个目录' : ''), 'success', 3000);
        await load(true);
      } catch (e) {
        showToast('请求失败：' + e.message, 'error');
      } finally {
        deletingCat.value = false;
      }
    };
    const onCtxDeleteCategory = () => {
      const m = { kind: catMenu.kind, key: catMenu.key };
      closeCatMenu();
      askDeleteCat(m.kind, m.key);
    };
    const askDeleteCatFromEdit = () => askDeleteCat(catEdit.kind, catEdit.key);

    // ---- 菜单里的新建入口 ----
    const onCtxEditCategory = () => {
      const m = { kind: catMenu.kind, key: catMenu.key };
      closeCatMenu();
      openCatEdit(m.kind, m.key);
    };
    const onCtxAddChild = () => {
      const m = { kind: catMenu.kind, key: catMenu.key, depth: catMenu.depth };
      closeCatMenu();
      // 先把选区切到该分类：新建子分类的父级是按选中链推的，不选中会落成大类下的同级
      if (m.kind === 'chip') selectChipChain(m.key, m.depth);
      // tab 右键 → 建一级分类（depth 0）；chip 右键 → 建它的下一级
      openAddChip(m.kind === 'tab' ? 0 : m.depth + 1);
    };
    const onCtxAddCard = () => {
      const m = { kind: catMenu.kind, key: catMenu.key, depth: catMenu.depth };
      closeCatMenu();
      // 先把选区切到该分类，新建词条才会落在它下面
      if (m.kind === 'chip') selectChipChain(m.key, m.depth);
      else {
        const sel = getSelections();
        for (let i = 0; i < Math.max(maxDepth.value, sel.length); i++) sel[i] = [];
      }
      openAddCard();
    };
    const onCtxAddTab = () => { closeCatMenu(); openAddTab(); };
    // 把选区设成某条分类链（新建词条的父目录由选区推导）：父链直接由 parentId 上溯
    const selectChipChain = (id, depth) => {
      const sel = getSelections();
      for (let i = 0; i < Math.max(maxDepth.value, sel.length); i++) sel[i] = [];
      const chain = nodeIdChainById(id);
      for (let i = 0; i <= depth && i < chain.length; i++) sel[i] = [chain[i]];
      pageIndex.value = 0;
    };

    // 右键 = 池类型三态循环：不在池 → 🎲 随机池 → ∞ 遍历池 → 移出池
    const togglePoolForTab = (tab) => {
      const idx = data.randomPools.findIndex(it => it.kind === 'tab' && it.tab === tab);
      if (idx >= 0) {
        const cur = data.randomPools[idx];
        if (!cur.traverse) {
          cur.traverse = true;
          zhuleLog('togglePoolForTab: 🎲→∞ 改为遍历池', { kind: 'tab', tab }, 'selected=', selSummary());
          refreshPoolPlaceholder(cur);
          syncPlaceholders();
          return showToast('「' + tabLabel(tab) + '」改为遍历池 ∞：所有词条参与全组合', 'success', 2400);
        }
        data.randomPools.splice(idx, 1);
        zhuleLog('togglePoolForTab: 移出池', cur, 'selected=', selSummary());
        syncPlaceholders();
        return showToast('「' + tabLabel(tab) + '」已移出池', 'warn', 2000);
      }
      const chk = hasPoolConflict(tab, '');
      if (chk.conflict) return showToast('无法加入：' + chk.msg, 'warn');
      data.randomPools.push({ kind: 'tab', tab, display: tab, traverse: false });
      zhuleLog('togglePoolForTab: 加入随机池', { kind: 'tab', tab }, 'selected=', selSummary());
      syncPlaceholders();
      showToast('「' + tabLabel(tab) + '」加入随机池 🎲：每次现抽 1 条（再右键改遍历池）', 'success', 2600);
    };
    const togglePoolForChip = (chipId, label) => {
      const tab = data.activeTab;
      const id = String(chipId || '');
      if (!id) return;
      const idx = data.randomPools.findIndex(it => it.kind === 'chip' && it.tab === tab && String(it.chipId || '') === id);
      const disp = label || nodeNameOf(id) || id;
      if (idx >= 0) {
        const cur = data.randomPools[idx];
        if (!cur.traverse) {
          cur.traverse = true;
          zhuleLog('togglePoolForChip: 🎲→∞ 改为遍历池', { kind: 'chip', tab, chipId: id, display: disp }, 'selected=', selSummary());
          refreshPoolPlaceholder(cur);
          syncPlaceholders();
          return showToast('「' + disp + '」改为遍历池 ∞：所有词条参与全组合', 'success', 2400);
        }
        data.randomPools.splice(idx, 1);
        zhuleLog('togglePoolForChip: 移出池', cur, 'selected=', selSummary());
        syncPlaceholders();
        return showToast('「' + disp + '」已移出池', 'warn', 2000);
      }
      const chk = hasPoolConflict(tab, id);
      if (chk.conflict) return showToast('无法加入：' + chk.msg, 'warn');
      data.randomPools.push({ kind: 'chip', tab, chipId: id, display: disp, traverse: false });
      zhuleLog('togglePoolForChip: 加入随机池', { kind: 'chip', tab, chipId: id, display: disp }, 'selected=', selSummary());
      syncPlaceholders();
      showToast('「' + disp + '」加入随机池 🎲：每次现抽 1 条（再右键改遍历池）', 'success', 2600);
    };
    const clearRandomPools = () => { data.randomPools.splice(0, data.randomPools.length); zhuleLog('clearRandomPools', 'selected=', selSummary()); syncPlaceholders(); };

    // ============ Ctrl/⌘ + 左键点分类：整类批量选中（不是入池）============
    // 与右键三态池（🎲 随机池 → ∞ 遍历池 → 移出池）完全解耦：Ctrl+左键只改「已选集合」，
    // 把该分类下所有词条等价地置为被选中状态，池子由后续「凝结」一步生成（类型那时再定）。
    // 普通左键的筛选语义完全不变。
    // 大类 / 分类 chip 的统一左键入口：Ctrl（或 Mac 的 ⌘）按下即整类选中/取消，否则走原来的筛选
    const onTabClick = (e, name) => {
      if (e && (e.ctrlKey || e.metaKey)) {
        if (e.preventDefault) e.preventDefault();
        return toggleCatPick('tab', name, tabLabel(name));
      }
      switchTab(name);
    };
    const onChipClick = (e, depth, chip) => {
      if (e && (e.ctrlKey || e.metaKey)) {
        if (e.preventDefault) e.preventDefault();
        return toggleCatPick('chip', (chip && chip.id) || '', (chip && chip.name) || '');
      }
      toggleChip(depth, chip);
    };

    // ============ 占位符（右键 tab / chip 进池时同步出现在已选列表，类名即占位名；遍历/随机出词后填充该位置） ============
    // 池的唯一键：tab:大类名 / list:池id / chip:大类名|分类节点id（分类身份即节点 id，已无路径概念）
    const poolKeyFor = (item) => item.kind === 'tab' ? 'tab:' + item.tab
      : item.kind === 'list' ? 'list:' + (item.poolId || '')
      : 'chip:' + item.tab + '|' + String(item.chipId || '');
    const placeholderFor = (item) => ({
      _ph: true,
      _poolKey: poolKeyFor(item),
      tab: item.tab,
      name: (item.traverse ? '∞ ' : '🎲 ') + (item.kind === 'tab' ? tabLabel(item.tab)
        : item.kind === 'list' ? (item.display || ('凝结' + (item.items || []).length + '项'))
        : (nodeNameOf(item.chipId) || item.display || String(item.chipId || ''))),
    });
    // 从占位符 _poolKey 解析分类显示名（tab:xxx / chip:大类名|节点id），用于「分类：抽中词条名」拼接
    const placeholderBaseName = (s) => {
      if (!s || !s._poolKey) return '';
      const k = s._poolKey;
      if (k.startsWith('tab:')) return tabLabel(k.slice(4));
      if (k.startsWith('list:')) {
        const it = data.randomPools.find(p => p.kind === 'list' && ('list:' + (p.poolId || '')) === k);
        return it ? (it.display || '凝结池') : '';
      }
      const bar = k.indexOf('|');
      if (bar < 0) return '';
      const rest = k.slice(bar + 1);
      const n = bankNodes.value[rest];
      return n && n.name ? n.name : '';    // 键里就是节点 id，直接读节点名
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
        const want = placeholderFor(item).name;
        const existed = data.selected.find(s => s._ph && s._poolKey === k);
        if (!existed) data.selected.push(placeholderFor(item));
        // 未填充的占位符名字始终跟着池类型走（旧存档里的 ♻ / 无前缀名在这里被纠正）
        else if (!existed._filled && existed.name !== want) existed.name = want;
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
        ph.content = e.content; ph.content_cn = e.content_cn; ph.neg = e.neg || ''; ph.override = e.override || '';
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

    // 全屏底部「删除」按钮：删的是当前正在看的那一张参考图，而不是整条词条。
    // 语义必须跟随所见图：全屏里只显示一张图，删它就该删这张图；
    // 删整条词条的入口保留在卡片左侧竖排 🗑 与详情弹层右上角 🗑（各自标注「删除词条」），三处语义不混用。
    const zoomAskDeleteRef = () => {
      const file = zoomCtx.file;
      if (!file || !file.images || !file.images.length) return;
      askDeleteRef(file);
    };

    // 在放大查看器中展示某词条的当前参考图；无参考图时回退默认图
    const openZoomedFile = (file) => {
      if (file.images && file.images.length) fullViewer.open(imageUrl(file.images[getImgIdx(file)]), file.name || '');
      else fullViewer.open(defaultImageUrl, (file.name || '') + '（暂无参考图）');
    };
    // 切换提示词：以当前可见卡片（分类浏览结果或搜索结果，已按变体组归并）为范围，dir=±1 上下一条
    const zoomWordAt = (dir) => {
      const cur = zoomCtx.file;
      const list = viewCards.value;
      if (!cur || !list.length) return;
      let idx = list.findIndex(f => f.relPath === cur.relPath);
      if (idx < 0) idx = 0;
      const target = list[(idx + dir + list.length) % list.length];
      zoomCtx.file = target;
      openZoomedFile(target);
    };
    // 随机参考图：随机范围 = **当前提示词自己的参考图**，绝不跨提示词。
    // 跨提示词切换只保留给大图标左右箭头（zoomWordAt），骰子不再换词条。
    // 抽法：n 张里取 (n-1) 张均匀随机，跳过当前索引 —— 保证必然换一张且分布均匀。
    const zoomRandomRef = () => {
      const file = zoomCtx.file;
      const imgs = (file && file.images) || [];
      const n = imgs.length;
      if (!n) return;
      if (n === 1) { openZoomedFile(file); return; }
      const cur = getImgIdx(file);
      let i = Math.floor(Math.random() * (n - 1));
      if (i >= cur) i += 1;
      setImgIdx(file, i);
      if (fullViewer) fullViewer.open(imageUrl(imgs[i]), file.name || '');
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
            { label: '🎲', tip: '随机参考图（当前提示词）', dice: true, onClick: zoomRandomRef },
            { label: '›', tip: '下一张参考图', size: 'sm', onClick: () => zoomRefAt(1) },
            { label: '›', tip: '下一提示词', size: 'lg', onClick: () => zoomWordAt(1) },
            // 分隔线右侧放破坏性操作：删除「当前正在看的这张参考图」（不是整条词条）
            { sep: true },
            { label: '🗑', tip: '删除当前参考图', onClick: () => zoomAskDeleteRef() },
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
      const f = viewer.file;
      const n = (f && f.images && f.images.length) || 0;
      if (!n) return;
      if (n === 1) { viewer.idx = 0; setImgIdx(f, 0); return; }
      // 真随机且必然换一张（旧实现 n>1 时只是 +1，等于「下一张」）
      const cur = viewer.idx;
      let i = Math.floor(Math.random() * (n - 1));
      if (i >= cur) i += 1;
      viewer.idx = i;
      setImgIdx(f, i);
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
    // 「清空」= 一键复位：已选提示词清空 + 随机池清空（否则上方 tab/chip 仍留着 in-pool 选中样式）
    // + 运行次数归零（次数输入框同步回 0，pref 走 watch 自动落 localStorage）
    const clearAll = () => {
      data.selected = [];
      data.randomPools.splice(0, data.randomPools.length);
      pref.genCount = 0;
      zhuleLog('clearAll', '已清空已选 + 随机池，次数归零');
    };

    // 随机池语义：每个右键选中的 tab / chip 各为一个独立子池。
    // 随机/遍历时从每个子池各取 1 条再组合（如角色/神态/身材/姿势各抽一）。
    // 静音（mute=1）：被标记的词条不进入任何自动选词流程——单次随机、随机模式、
    // 遍历模式全部跳过；用户手动点选卡片时走 data.selected，不经过本函数，故不受影响。
    const poolCandidatesRaw = (item) => {
      // 凝结池（框选生成）：候选就是框选时点名的这批卡片，按 tab + relPath 实时回查，
      // 词条改名/移动不影响，被删或被静音则自动跳过（与 tab 池的静音语义一致）
      if (item.kind === 'list') {
        const out = [];
        for (const e of (item.items || [])) {
          const f = (bankData.value[e.tab] || []).find(x => x.relPath === e.relPath && !x.mute);
          if (f) out.push(f);
        }
        zhuleLog('poolCandidates: 凝结池', item.poolId, 'count=', out.length, 'total=', (item.items || []).length);
        return out;
      }
      const files = bankData.value[item.tab] || [];
      if (!files.length && tabs.value.includes(item.tab)) {
        // 懒加载下该分类尚未加载：异步补拉数据，返回 null 让调用方提示稍候
        load(false, item.tab);
        zhuleLog('poolCandidates: 懒加载补拉', item.kind, 'tab=', item.tab, 'chipId=', item.chipId || '');
        return null;
      }
      const alive = files.filter(f => !f.mute);
      if (alive.length !== files.length) {
        zhuleLog('poolCandidates: 静音过滤', item.tab, '静音跳过=', files.length - alive.length, '可用=', alive.length);
      }
      if (item.kind === 'tab') { zhuleLog('poolCandidates: tab池候选', item.tab, 'count=', alive.length); return alive; }
      // chip 池候选 = 按节点 DB id 递归收集：该 chip 下所有后代卡片（chipIds 祖先链含本 id 的叶子）即为候选，
      // 与路径/前后缀匹配完全无关；词条改名、移动、换父级后 id 不变，候选恒稳定。
      const id = item.chipId;
      if (!id) { zhuleLog('poolCandidates: chip池缺 chipId（请重新右键该分类加入随机池）', 'tab=', item.tab); return []; }
      const out = alive.filter(f => Array.isArray(f.chipIds) && f.chipIds.includes(id));
      zhuleLog('poolCandidates: chip池', 'tab=', item.tab, 'chipId=', id, 'count=', out.length, 'total=', files.length, 'sampleChipIds=', files.slice(0, 3).map(f => f.chipIds));
      return out;
    };
    // 变体组在池子里只算「一个可抽项」：同组多变体折叠成 1 条代表（带上 _vgKey），
    // 抽中后由该组的三态（锁定当前版 / 每次随机 / 顺序轮转）决定最终用哪一版。
    // 不折叠的话，一个 6 变体分类会在随机池里被当成 6 条不同提示词，抽重率被放大 6 倍。
    const poolCandidates = (item) => {
      const raw = poolCandidatesRaw(item);
      if (!raw || !raw.length) return raw;
      const seen = new Set();
      const out = [];
      for (const f of raw) {
        if (!f) continue;
        const k = vgKeyOf(f);
        if (!k) {
          // 非变体组：空壳节点（组头自己没内容）不能进池，否则会抽出空词条
          if (!vgIsShellCard(f)) out.push(f);
          continue;
        }
        if (seen.has(k)) continue;
        seen.add(k);
        // 抽到的是「组」而不是「某一条」：代表固定取真实变体里的当前游标那一版，
        // 与卡片上看到的变体一致；最终用哪一版仍由三态在出词时决定。
        const grp = vgRealMap.value[k] || { head: null, real: [], title: '' };
        const vs = grp.real || [];
        if (!vs.length) continue;
        const st = vgState[k];
        const idx = Math.min(Math.max(st ? Number(st.idx) || 0 : 0, 0), vs.length - 1);
        out.push(Object.assign({}, vs[idx], {
          _vgKey: k, _vgVersions: vs, _vgIdx: idx, _vgCount: vs.length,
          _vgTitle: grp.title || '',
        }));
      }
      return out;
    };

    // 骰子 🎲：把每个随机池 🎲 的当前答案抽定（遍历池 ∞ 本来就是全跑，不需要抽取）
    const pickFromEachPool = () => {
      const rnd = data.randomPools.filter(it => !it.traverse);
      if (!rnd.length) { zhuleLog('pickFromEachPool: 没有随机池（可能全被改成遍历池）'); return null; }
      return pickFromPools(rnd);
    };

    // 遍历组合数上限：超出时提示精简随机池，避免一次生成过多
    const TRAVERSE_MAX_COMBOS = 500;
    // 遍历（全跑）的单次组合上限：语义就是把遍历池的所有组合都跑一遍，所以给得比单轮上限宽松；
    // 仍设硬上限，防止误选大池后一次排出上万条任务
    const TRAVERSE_ALL_MAX_COMBOS = 2000;

    // 在已加载词库中按 tab + relPath 定位卡片（参考图数量 = file.images.length）
    const findWordFile = (tab, relPath) => {
      const cards = bankData.value[tab] || [];
      return cards.find(f => f.relPath === relPath) || null;
    };
    const wordImageCount = (file) => (file && Array.isArray(file.images) ? file.images.length : 0);

    // 按「标签栏 data.selected 的原顺序」组装一条完整提示词：
    // 占位符（_ph）是随机池的槽位，用本次该池抽中的词条原位替换；手选条目（如角色「宵宫」）原位保留。
    // 顺序完全由用户在标签栏拖好的次序决定，随机项可夹在任意位置，不再一律拼成前缀/后缀。
    // 池条目统一补 _pool:true，供遍历组合的随机池现抽与顺序整理复用。
    const arrangeBySelection = (picked) => {
      const byKey = new Map();
      for (const e of picked) {
        if (!e || e._poolKey === undefined || e._poolKey === null) continue;
        if (!byKey.has(e._poolKey)) byKey.set(e._poolKey, e);
      }
      const out = [];
      const used = new Set();
      for (const s of data.selected) {
        if (s._ph) {
          const e = byKey.get(s._poolKey);
          if (e) { out.push({ ...e, _pool: true }); used.add(s._poolKey); }
          continue;
        }
        out.push(s);
      }
      // 兜底：抽中了但标签栏没有对应占位符（旧存档 / 池刚加入尚未同步）的条目追加到末尾，避免丢失
      for (const [k, e] of byKey) if (!used.has(k)) out.push({ ...e, _pool: true });
      return out;
    };

    // 池子按类型拆分：遍历池 ∞ 参与笛卡尔积穷举，随机池 🎲 每个组合现抽 1 条（不放大组合数）。
    const traversePoolItems = () => data.randomPools.filter(it => !!it.traverse);
    const randomPoolItems = () => data.randomPools.filter(it => !it.traverse);

    // 从给定的一批池子里各抽 1 条（随机池专用）；任一池候选为空返回 null
    const pickFromPools = (pools) => {
      const picks = [];
      for (const item of pools) {
        const c = poolCandidates(item);
        if (!c || !c.length) { zhuleLog('pickFromPools: 候选为空', item.kind, 'tab=', item.tab, 'chipId=', item.chipId || ''); return null; }
        const file = c[Math.floor(Math.random() * c.length)];
        zhuleLog('pickFromPools: 抽中', item.kind, 'tab=', item.tab, 'name=', file.name, '候选数=', c.length);
        picks.push({ tab: item.tab, relPath: file.relPath, id: file.id || '', name: file.name, content: file.content, content_cn: file.content_cn, neg: file.neg || '', override: file.override || '', anc: file.anc || [], _poolKey: poolKeyFor(item), _pool: true, _vgKey: file._vgKey || '', _vgTitle: file._vgTitle || '' });
      }
      return picks;
    };
    // 给一条「遍历池组合」补上随机池的现抽结果；没有随机池则原样返回，随机池抽空返回 null
    const withRandomPick = (combo) => {
      const rnd = randomPoolItems();
      if (!rnd.length) return combo;
      const picks = pickFromPools(rnd);
      if (!picks) return null;
      return combo.concat(picks);
    };

    // 遍历组合列表：只对遍历池 ∞ 做笛卡尔积，
    // 组合按「第一个池变化最慢、最后一个最快」排列——即 randomPools 里靠前的遍历池做外层大 for；
    // 随机池 🎲 不参与乘积，由 withRandomPick 在提交前现抽。
    // 没有任何遍历池时返回 [[]]（单个空组合），整套跑法退化为「每轮各抽一条」。
    const buildTraverseCombos = (limit = TRAVERSE_MAX_COMBOS) => {
      if (!data.randomPools.length) return null;
      const pools = traversePoolItems();
      if (!pools.length) return [[]];
      const lists = [];
      for (const item of pools) {
        const c = poolCandidates(item);
        if (!c || !c.length) return null;
        // 顺序一律沿用池内原始顺序（后端 ORDER BY sort_order, name, id，与词库卡片顺序、
        // 用户拖拽排序一致）。绝不能在这里按 name 拼音重排，否则遍历会以「拼音顺序」
        // 而非池子可见顺序推进，表现为「不按分类顺序、跳来跳去」。
        lists.push(c.map(file => ({ tab: item.tab, file, _poolKey: poolKeyFor(item) })));
      }
      const total = lists.reduce((n, l) => n * l.length, 1);
      if (total > limit) return { tooMany: total };
      let combos = [[]];
      for (const l of lists) {
        const next = [];
        for (const pre of combos) {
          for (const entry of l) next.push([...pre, entry]);
        }
        combos = next;
      }
      return combos.map(combo => combo.map(e => ({ tab: e.tab, relPath: e.file.relPath, id: e.file.id || '', name: e.file.name, content: e.file.content, content_cn: e.file.content_cn, neg: e.file.neg || '', override: e.file.override || '', _pool: true, _poolKey: e._poolKey, _vgKey: e.file._vgKey || '', _vgTitle: e.file._vgTitle || '' })));
    };

    // 池身份已统一为分类节点 id（旧存档的路径在 restoreState 里就迁完了），
    // 这里只保留一个「占位符对齐」出口，供抽词前统一调用。
    const normalizePoolIds = () => {
      syncPlaceholders();
    };

    // 随机池里所有 tab 的数据是否都已加载；没加载的先补齐（懒加载下未打开过的分类会被误判为空）
    const ensurePoolData = async () => {
      // 凝结池一个池可能横跨多个分类，需把它名下所有 tab 一并纳入补拉范围
      const needTabs = new Set();
      for (const it of data.randomPools) {
        const tabsOf = it.kind === 'list' ? (it.items || []).map(e => e.tab) : [it.tab];
        for (const tb of tabsOf) {
          if (!(bankData.value[tb] || []).length && tabs.value.includes(tb)) needTabs.add(tb);
        }
      }
      const missing = [...needTabs];
      zhuleLog('ensurePoolData: 池=', data.randomPools.map(p => p.kind + ':' + (p.kind === 'list' ? (p.display + '(' + (p.items || []).length + ')') : p.tab + (p.chipId ? '/id:' + p.chipId : ''))), 'missing=', missing);
      if (missing.length) {
        // 并行补拉缺失的 tab，补齐后再抽
        await Promise.all(missing.map(tb => load(false, tb)));
      }
      // 补拉后把旧存档 chip 池补上 DB id，再统一判断是否真空
      normalizePoolIds();
      // 补拉完仍为空 = 该 tab 真的没有词条；有词条但全被静音同样视为不可用（自动选词取不到）
      const alive = (it) => it.kind === 'list' ? (poolCandidates(it) || []) : (bankData.value[it.tab] || []).filter(f => !f.mute);
      const ready = data.randomPools.every(it => alive(it).length > 0);
      zhuleLog('ensurePoolData: ready=', ready,
        '各池可用词条数=', data.randomPools.map(p => (p.kind === 'list' ? p.display : p.tab) + ':' + alive(p).length));
      return ready;
    };

    const singleRandom = async () => {
      const ready = await ensurePoolData();
      if (!ready) return showToast('池子含空分类（该 tab 下暂无词条，或词条已全部静音），请检查池子', 'warn');
      if (!data.randomPools.filter(it => !it.traverse).length) {
        return showToast('没有随机池 🎲 可抽：遍历池 ∞ 本来就是全跑，右键池子可在 🎲/∞ 切换', 'warn', 3600);
      }
      const picked = pickFromEachPool();
      if (!picked) return showToast('随机池含空分类（该 tab 下暂无词条，或已全部静音），请检查池子', 'warn');
      updateRandomResults(picked);
      showToast('已抽定：' + picked.map(s => s.name || s.content).join(' / ') + '，已填入黄色分类标签（再点重抽）', 'success', 3200);
    };

    // ============ 池子模式逐条出图：驱动画布逐条运行，等 ack 再下一条 ============
    let runQueue = [];
    let runBusy = false;
    let runTotal = 0;

    const runNextInQueue = async () => {
      if (runQueue.length === 0) {
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
        items: expandItems(applyVgToItems(items)).map(s => ({ id: s.id || '', name: s.name, content: s.content, neg: s.neg || '', override: s.override || '' })),
        count: 1,
      });
      let done = false;
      const timer = setTimeout(() => {
        if (!done) {
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
          runBusy = false;
          runQueue = [];
          showToast('运行失败：' + (m.error || '未知错误') + '，已停止', 'error', 4000);
        }
      };
    };

    const runGenerate = async () => {
      const count = pref.genCount;
      // 运行前统一自愈选区 id（遍历分支与普通模式两条出口都依赖 selected 里的词条 id）
      healSelectedIds();
      // 默认跑法 = 遍历：有 ∞ 遍历池时，遍历池词条做笛卡尔积各跑一遍，随机池 🎲 每个组合现抽 1 条，
      // 「次数」= 整套组合重复几轮（0 按 1 轮）。没有 ∞ 遍历池时退回普通模式（手选词条 / 随机池各抽一条），
      // 填充模式已移除，也不再有模式开关。
      if (traversePoolItems().length) {
        if (!data.randomPools.length) return showToast('池子为空，右键 tab / chip 加入随机池（再右键可改成遍历池）', 'warn');
        const ready = await ensurePoolData();
        if (!ready) return showToast('池子含空分类（该 tab 下暂无词条，或词条已全部静音），请检查池子', 'warn');
        if (runBusy) return showToast('正在逐条运行中，请稍候', 'warn');
        if (!linkParams.bind) return showToast('当前网页未绑定节点，请从画布节点「词库」按钮打开本页', 'warn', 4000);
        const built = buildTraverseCombos(TRAVERSE_ALL_MAX_COMBOS);
        if (!built) return showToast('遍历池含空分类或数据未加载，请检查池子', 'warn');
        if (built.tooMany) return showToast('遍历组合数过多（' + built.tooMany + '），请精简遍历池（上限 ' + TRAVERSE_ALL_MAX_COMBOS + '）', 'warn', 4000);
        const rounds = Math.max(1, count || 0);
        const combos = [];
        for (let r = 0; r < rounds; r++) {
          for (const combo of built) {
            const full = withRandomPick(combo);
            if (!full) return showToast('随机池 🎲 抽不出词条：该分类下暂无可用词条（或已全部静音），请检查池子', 'warn', 4000);
            combos.push(arrangeBySelection(full));
          }
        }
        zhuleLog('runGenerate: 遍历全组合', '遍历池=', traversePoolItems().map(p => p.tab),
          '随机池=', randomPoolItems().map(p => p.tab),
          '单轮组合数=', built.length, '次数(外层轮数)=', rounds, '总任务数=', combos.length);
        // 顺序自检：打印单轮前 10 条组合的词条名，方便一眼核对是否按池内顺序推进
        zhuleLog('runGenerate: 遍历顺序抽样', built.slice(0, 10).map(c => c.map(e => e.name || e.relPath).join(' + ')));
        runQueue = combos;
        runTotal = combos.length;
        runBusy = true;
        // 池名一律打出来：跑之前一眼看清哪个池被当成「穷举」、哪个被当成「随机」
        const poolName = (p) => p.display || p.tab;
        const tNames = traversePoolItems().map(poolName);
        const rNames = randomPoolItems().map(poolName);
        showToast('遍历｜穷举池 ∞：' + (tNames.join('、') || '（无）')
          + '｜随机池 🎲：' + (rNames.join('、') || '（无）')
          + '｜单轮 ' + built.length + ' 组合 × ' + rounds + ' 轮 = ' + runTotal + ' 条', 'success', 6000);
        runNextInQueue();
        return;
      }
      // 普通模式：占位符已填充（绑定抽中词条）时参与运行；未抽取的占位符跳过。
      // 但「只加了随机池、没点骰子」时整组会被静默跳过（看起来像随机池被忽略），
      // 因此这里先自动补抽一次（等价于点一下 🎲）；已抽定的占位符保持不动，
      // 想固定某个结果仍可先点骰子再运行。
      healSelectedIds();
      if (data.randomPools.filter(it => !it.traverse).length
          && data.selected.some(s => s._ph && !s._filled)) {
        const ok = await ensurePoolData();
        const autoPicked = ok ? pickFromEachPool() : null;
        if (autoPicked) updateRandomResults(autoPicked);
        else {
          const dead = data.randomPools.filter(it => !it.traverse && !(poolCandidates(it) || []).length);
          showToast('随机池 🎲 有 ' + dead.length + ' 个池抽不出词条（该分类下暂无词条或已全部静音），已跳过：'
            + dead.map(it => it.display || it.tab).join('、'), 'warn', 4600);
        }
      }
      const readyItems = data.selected.filter(s => !s._ph || s._filled);
      if (!readyItems.length) return showToast('还没选任何提示词', 'warn');
      if (runBusy) return showToast('正在逐条运行中，请稍候', 'warn');
      if (!linkParams.bind) {
        return showToast('当前网页未绑定节点，请从画布节点「词库」按钮打开本页', 'warn', 4000);
      }
      // 运行前统一展开继承：分类链上的 en/cn/neg/override 逐层拼到词条自己身上
      // 变体组在这里定版：锁定=当前版、随机=这次抽一版、轮转=顺序推进一格（一次点运行定一次）
      const expanded = expandItems(applyVgToItems(readyItems));
      const text = expanded.map(s => s.content).join(', ');
      // 通过 BroadcastChannel 广播运行指令，节点 _selected 直接承载词条。
      ensureRunChannel();
      runChannel.postMessage({
        type: 'zhule:run',
        bindId: linkParams.bind,
        seq: ++runSeq,
        // 带 id（词条 id，提示词标签按 id 传递，词条改名/移动不脱钩）、name（词条名）与 content（提示词文本）
        items: expanded.map(s => ({ id: s.id || '', name: s.name, content: s.content, neg: s.neg || '', override: s.override || '' })),
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
        if (m.ok) showToast('开始执行 ' + Math.max(1, count) + ' 次', 'success', 3000);
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
      const prev = [...tabOrder.value];
      tabDrag = { name: null };
      const changed = prev.length !== ordered.length || ordered.some((n, i) => n !== prev[i]);
      tabOrder.value = ordered;
      saveState();
      if (!prev.length || !changed) return;   // 首次加载或没挪动就不打扰后端
      // 拖完即落库：只提交顶层这一层顺序
      await saveTabOrder('tab 顺序已保存');
    };

    let chipDrag = { depth: -1, id: null, overId: null };
    const onChipDragStart = (e, depth, chip) => {
      chipDrag = { depth, id: chip ? String(chip.id) : null, overId: null };
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', chip ? String(chip.id) : ''); }
    };
    const onChipDragOver = (e, depth, chip) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      if (chipDrag.depth !== depth) return;
      chipDrag.overId = chip ? String(chip.id) : null;
    };
    const onChipDragEnd = () => {
      const { depth, id, overId } = chipDrag;
      if (depth >= 0 && id && overId && overId !== id) {
        const line = chipLines.value[depth] || [];
        const from = line.findIndex(c => String(c.id) === id);
        const to = line.findIndex(c => String(c.id) === overId);
        if (from >= 0 && to >= 0 && from !== to) {
          const ordered = [...line];
          const [moved] = ordered.splice(from, 1);
          ordered.splice(to, 0, moved);
          // 按「层级+父节点id」隔离记录顺序，再把这层的 id 新顺序直接落库
          const parentId = chipParentIdOf(depth) || '';
          if (!parentId) {
            // 这一行是多个父分类的子项合并显示的，顺序没有唯一归属 → 先让用户选中父分类
            showToast('这一行混了多个父分类，先选中父分类再拖拽排序', 'warn', 2800);
          } else {
          const orderedIds = ordered.map(c => String(c.id));
          chipOrder[data.activeTab] = { ...chipOrder[data.activeTab], [depth + '|' + parentId]: orderedIds };
          const ids = childLayerIds(data.activeTab, depth, parentId, orderedIds);
          if (ids.length) postSortOrder({ [String(parentId)]: ids }, '分类顺序已保存');
          else showToast('分类顺序已调整（未取到该层节点 id，仅本地生效）', 'warn', 2600);
          }
        }
      }
      chipDrag = { depth: -1, id: null, overId: null };
    };

    // ============ 排序落库：拖拽/交换即存，不再有单独的「排序保存」按钮 ============
    // 早先词库顺序写本地文件、一次落盘开销大，才需要手动攒一批再写；
    // 现在顺序就存在 DB 的 sort_order 上，拖完直接把这一层的新顺序发给后端即可。
    const sortSaving = ref(false);

    // 串行化：连拖多下时按先后顺序逐条落库，避免并发写互相覆盖
    let sortChain = Promise.resolve();
    const doPostSort = async (order, okMsg) => {
      const resp = await fetch('/zhule_studio/api/wordbank/sort-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      });
      const json = await resp.json();
      if (!json || json.error || json.ok === false) {
        showToast('排序保存失败：' + ((json && (json.error || json.message)) || '未知错误'), 'error', 3600);
        return false;
      }
      if (Array.isArray(json.errors) && json.errors.length) {
        showToast('排序保存部分失败：' + json.errors.join('；'), 'warn', 4000);
        return false;
      }
      if (okMsg) showToast(okMsg, 'success', 1500);
      return true;
    };
    const postSortOrder = (order, okMsg) => {
      if (!order || !Object.keys(order).length) return Promise.resolve(false);
      sortSaving.value = true;
      sortChain = sortChain
        .then(() => doPostSort(order, okMsg))
        .catch(e => { showToast('排序保存请求失败：' + e.message, 'error', 3600); return false; })
        .finally(() => { sortSaving.value = false; });
      return sortChain;
    };

    // 顶层 tab 顺序 -> id 序列：用 tab_ids 全量映射，不依赖各 tab 卡片是否已懒加载
    const tabLayerIds = () => tabs.value.map(t => tabIds.value[t]).filter(Boolean).map(String);

    // 某父节点下的子分类新顺序 -> id 序列：直接采用拖拽后的节点 id 顺序，
    // 本层里没出现在左栏的节点（空分类等）从节点索引补在末尾
    const childLayerIds = (tab, depth, parentId, orderedIds) => {
      const out = [];
      const used = new Set();
      (orderedIds || []).forEach(raw => {
        const id = String(raw || '');
        if (id && !used.has(id)) { out.push(id); used.add(id); }
      });
      siblingIdsOf(parentId, used).forEach(id => { out.push(id); used.add(id); });
      return out;
    };

    // 只落顶层顺序（新建 tab 排末尾 / tab 拖拽后）
    const saveTabOrder = (okMsg) => {
      const ids = tabLayerIds();
      if (!ids.length) return Promise.resolve(false);
      return postSortOrder({ '': ids }, okMsg);
    };

    // ============ 拖拽 ============
    let pDrag = { pending: null, pendingTime: 0, active: false, ghostEl: null, suppressClickUntil: 0 };

    const onCardPointerDown = (e, file) => {
      if (e.button !== 0) return;
      // Ctrl/⌘ + 左键 = 框选的单项增删：不启动拖拽打标，也不进已选区
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        togglePick(file);
        return;
      }
      if (e.target.closest('.thumb-zoom') || e.target.closest('.thumb-nav') || e.target.closest('.card-act') || e.target.closest('.thumb-enter') || e.target.closest('.thumb-del') || e.target.closest('.vg-nav')) return;
      if (pDrag.pending) {
        if (performance.now() - pDrag.pendingTime > 3000) cleanupDrag(); else return;
      }
      e.preventDefault();
      const existIdx = data.selected.findIndex(s => sameCard(s, file));
      pDrag.pending = {
        x: e.clientX, y: e.clientY,
        sourceType: 'card',
        // tab 以卡片自带的为准（全库搜索结果里卡片可能不属于当前 activeTab）
        // _vgKey：变体组键，随已选项一起带走，标签三态与运行取变体都靠它回查变体池
        item: { tab: file.tab || data.activeTab, relPath: file.relPath, id: file.id || '', name: file.name, content: file.content, content_cn: file.content_cn, neg: file.neg || '', override: file.override || '', anc: file.anc || [], _vgKey: file._vgKey || '', _vgTitle: file._vgTitle || '' },
        noDrag: existIdx >= 0,
      };
      pDrag.pendingTime = performance.now();
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      document.addEventListener('pointercancel', onPointerCancel);
    };

    const onTagPointerDown = (e, idx) => {
      // .vg-tag 是标签上的变体三态徽标，点它切模式，不能触发标签拖拽
      if (e.button !== 0 || e.target.closest('.close') || e.target.closest('.vg-tag')) return;
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
        ghost.textContent = selDisplayName(p.item);
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
        // 通过 data-rel 定位卡片（分页渲染下 DOM 索引与列表不再一一对应，且要排除 card-add）
        const rel = card.getAttribute('data-rel');
        const f = rel ? listFiles.value.find(x => x.relPath === rel) : null;
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
          const item = { tab: p.item.tab, relPath: p.item.relPath, id: p.item.id || '', name: p.item.name, content: p.item.content, content_cn: p.item.content_cn, neg: p.item.neg || '', override: p.item.override || '', anc: p.item.anc || [], _vgKey: p.item._vgKey || '', _vgTitle: p.item._vgTitle || '' };
          const existIdx = data.selected.findIndex(s => sameCard(s, item));
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
          const item = { tab: p.item.tab, relPath: p.item.relPath, id: p.item.id || '', name: p.item.name, content: p.item.content, content_cn: p.item.content_cn, neg: p.item.neg || '', override: p.item.override || '', anc: p.item.anc || [], _vgKey: p.item._vgKey || '', _vgTitle: p.item._vgTitle || '' };
          if (data.selected.some(s => sameCard(s, item))) return;
          data.selected.push(item);
        }
        return;
      }

      if (card && p.sourceType === 'card') {
        // 通过 data-rel 定位目标卡片（分页渲染下 DOM 索引与列表不再一一对应，且排除 card-add）
        // 搜索态下卡片可能来自搜索结果，所以按 listFiles 找；relPath 跨 tab 会重名，再用 data-tab 收窄
        const rel = card.getAttribute('data-rel');
        const tabAttr = card.getAttribute('data-tab') || '';
        const target = rel ? listFiles.value.find(x => x.relPath === rel && (!tabAttr || String(x.tab || '') === tabAttr)) : null;
        if (!target) return;
        const targetIdx = data.selected.findIndex(s => sameCard(s, target));
        const item = { tab: p.item.tab, relPath: p.item.relPath, id: p.item.id || '', name: p.item.name, content: p.item.content, content_cn: p.item.content_cn, neg: p.item.neg || '', override: p.item.override || '', anc: p.item.anc || [], _vgKey: p.item._vgKey || '', _vgTitle: p.item._vgTitle || '' };
        if (targetIdx >= 0) {
          data.selected.splice(targetIdx, 1, item);
        } else {
          if (data.selected.some(s => sameCard(s, item))) return;
          data.selected.push(item);
        }
      }
    };

    const toggleFile = (file) => {
      const idx = data.selected.findIndex(s => sameCard(s, file));
      if (idx >= 0) data.selected.splice(idx, 1);
      else data.selected.push({
        tab: file.tab || data.activeTab, relPath: file.relPath, id: file.id || '', name: file.name,
        content: file.content, content_cn: file.content_cn,
        neg: file.neg || '', override: file.override || '',
        // 父级分类属性链随选区一起存快照：运行/预览都按它递归继承，历史选区也能自解释
        anc: file.anc || [],
        // 变体组键：标签三态与运行时取变体靠它回查变体池（非变体组为空串，逻辑全跳过）
        _vgKey: file._vgKey || '', _vgTitle: file._vgTitle || '',
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
      // 右键菜单：点空白、Esc、滚动、改变窗口大小都收起，避免残留
      document.addEventListener('keydown', onBankKeydown);
      document.addEventListener('click', onBankDismiss, true);
      document.addEventListener('scroll', onBankDismiss, true);
      window.addEventListener('resize', onBankDismiss);
      load(); // 首屏加载数据（加载遮罩已移除）
    });
    const onBankKeydown = (e) => {
      // Ctrl+F / Cmd+F：唤起词库搜索（页面不在前台时不抢键）
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        const anchor = document.querySelector('.wb-search');
        if (!anchor || !anchor.offsetParent) return;
        e.preventDefault();
        openSearch();
        return;
      }
      if (e.key !== 'Escape') return;
      if (cardMenu.open) { closeCardMenu(); return; }
      if (catMenu.open) { closeCatMenu(); return; }
      if (catEdit.open) { closeCatEdit(); return; }
    };
    const onBankDismiss = (e) => {
      if (catMenu.open && !(e && e.target && e.target.closest && e.target.closest('.ctx-menu'))) closeCatMenu();
      if (cardMenu.open && !(e && e.target && e.target.closest && e.target.closest('.ctx-menu'))) closeCardMenu();
    };
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
      editTarget, editName, editContent, editContentCn, editNeg, editOverride, editIsTxt, editing, acc, toggleAcc, allAccOpen, toggleAllAcc,
      openEdit, cancelEdit, submitEdit, toggleMute,
      del, askDeleteWord, askDeleteRef,
      uploadRefOpen, closeUploadRef, pickUploadRef, onUploadRefInput,
      onUploadRefDragEnter, onUploadRefDragLeave, onUploadRefDrop, onUploadRefPaste,
      uploadRefDrag, uploadRefPreview, uploadRefFileName, uploadRefBusy, submitUploadRef, openUploadRef,
      chipLines, filteredFiles, previewText,
      // 搜索：listFiles = 列表唯一出口（有搜索词走搜索结果，无词走分类浏览）
      listFiles, searchText, searchScope, searchQ, searching, searchOpen, searchClosing, searchInputEl, openSearch, onSearchBlur, closeSearchBox, searchAllLoading, searchLoading, searchFailed,
      showCardTab, cardTabLabel,
      listCountLabel, emptyText, searchPh, searchTip, toggleSearchScope, clearSearch, onSearchEsc, onBoardBlankDown,
      pageIndex, pageCount, pageNumbers, visibleFiles, goPrevPage, goNextPage, goPage,
      // 变体组（同一提示词的多变体）：A 卡片翻页 / B 右键胶片条 / C 已选标签三态
      viewCards, vgStep, vgState, vgStateOf, vgTagLabel, vgTagTip, vgCycleMode,
      vgStrip, openVgStrip, closeVgStrip, pickVgStrip, onCardVgStrip, onCardVgRename,
      getSelections,
      chipsCollapsed, chipsHeightCss, toggleChips, onChipsResizeDown,
      selectedCollapsed, toggleSelectedCollapsed,
      imageUrl, getImgIdx, displayContent, isFileSelected,
      // 卡片框选（右键长按）+ Ctrl 左键多选，凝结成池
      pickSel, gridEl, isPicked, clearPick, togglePick, onGridPointerDown, onCardCondense,
      // 分类整类选中（Ctrl+左键）：与卡片已选集合共用同一出口，可供模板高亮
      catPickSel, isTabCatPicked, isChipCatPicked,
      defaultImageUrl,
      isTabInPool, isChipInPool, isTabTraversePool, isChipTraversePool, tabHasSelected,
      switchTab, toggleChip, clearChip, togglePoolForTab, togglePoolForChip, clearRandomPools,
      onTabClick, onChipClick,
      addTabOpen, addTabName, addingTab, openAddTab, closeAddTab, submitAddTab,
      // 分类右键菜单 / 编辑分类
      catMenu, openCatMenu, closeCatMenu, onCtxEditCategory, onCtxPool, onCtxCatPick, onCtxAddChild, onCtxAddCard, onCtxAddTab, onCtxToVg,

    deletingCat, askDeleteCat, onCtxDeleteCategory, askDeleteCatFromEdit,
    isCatMuted, toggleCatMute,
      // 卡片右键菜单（复制卡片图标功能）+ 通用设置「隐藏卡片上的图标」
      cardMenu, openCardMenu, closeCardMenu, hideCardIcons,
      onCardEdit, onCardMute, onCardUpload, onCardDeleteWord, onCardGallery, onCardZoom, onCardDeleteRef, onCardToCategory,
      catEdit, catSaving, openCatEdit, closeCatEdit, submitCatEdit,
      previewNegText, toggleNegPreview, bankNodes, nodeOfCat,
      canAddChip, chipParentLabel, addCardIsTxt,
      chipThemeClass, chipStyle,
      addChipOpen, addChipName, addChipDepth, addChipInput, addingChip, openAddChip, closeAddChip, submitAddChip,
      addCardOpen, addCardName, addCardContent, addCardContentCn, addCardInput, addingCard, openAddCard, closeAddCard, submitAddCard, addCardLock,
      onCardNewVersion, onCardVgJoin, openNewVersionFor,
      // 并入变体组（提示词入口，单卡 / 多选共用）：弹框输总名，现名退到 # 后当变体名
      vgJoin, vgJoinPreview, vgJoinNames, openVgJoin, closeVgJoin, submitVgJoin,
      // 名字显示口径：标题只放这一版自己的名字（「默认」版放组名），组名单独作为卡片上方的标志
      vgShortName, vgFullName, vgStripName, fullNameOf, selDisplayName, vgGroupTitleOf, cardDisplayName, cardGroupBadge, cardNamePrefix, editNamePrefix,

      vgRenameOpen, vgRenaming, vgRenameName, vgRenameCount, vgRenamePreview,
      openVgRename, closeVgRename, submitVgRename,
      toggleTranslate, changeColumns, changeCount, onCountInput, fixCount,
      prevImage, nextImage, randomImage, goToGallery,
      viewer, closeViewer, viewerPrev, viewerNext, viewerRandom, zoomView, zoomCardImage,
      removeSelected, clearAll, singleRandom, runGenerate,
      onTabDragStart, onTabDragOver, onTabDrop, onTabDragEnd,
      tabLabel,
      onChipDragStart, onChipDragOver, onChipDragEnd,
      dispKey, sortSaving, saveTabOrder,
      onCardPointerDown, onTagPointerDown, onSelListPointerDown,
      toast, toastIcon, dismissToast,
    };
  },
};
