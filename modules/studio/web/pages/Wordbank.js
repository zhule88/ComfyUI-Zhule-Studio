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
          <button class="btn" @click="singleRandom" data-tip="点一下把每个池子的当前答案摇定：随机池各抽 1 条填入黄色标签（可再点重抽）">🎲</button>
          <button class="btn" :class="{active: data.fillMode}" @click="toggleFillMode" data-tip="填充模式：遍历池内每条提示词的参考图补到同一数量（以最多的为基准，设 0 补到基准、设 N 补到基准+N），集中倒满一桶再下一桶；随机池照常每组现抽 1 条">⏩</button>
          <button class="btn" :class="{active: data.traverseMode}" @click="toggleTraverseMode" data-tip="遍历模式：遍历池 ∞ 的词条做全组合各跑一遍，随机池 🎲 每个组合现抽 1 条；次数 = 整套组合重复几轮">🔁</button>
          <button class="btn icon-btn" @click="clearRandomPools" data-tip="清空所有池子">🗑</button>
          <div class="col-ctrl">
            <label>每行</label>
            <button class="col-btn" @click="changeColumns(-1)">−</button>
            <span class="col-num">{{ pref.columns }}</span>
            <button class="col-btn" @click="changeColumns(1)">+</button>
          </div>
          <button class="btn" @click="saveBankOrder" :disabled="bankSaving"
                  data-tip="按当前展示顺序（层级深度优先）把编号写回并覆盖文件夹">💾 排序保存</button>
          <button class="btn icon-btn" @click.stop="bankPrefOpen = !bankPrefOpen" data-tip="词库专属设置">⚙</button>
          <!-- 词库专属设置（不是通用设置，只作用于本页） -->
          <div v-if="bankPrefOpen" class="bank-pref">
            <div class="bp-title">词库设置</div>
            <label class="bp-row" @click.stop>
              <input type="checkbox" v-model="pref.showNegPreview">
              <span>预览框显示负面提示词</span>
            </label>
            <div class="bp-hint">关闭后预览框只留正向结果，运行不受影响。</div>
          </div>
        </div>

        <div class="tabs">
          <button class="tab-add" data-tip="新增分类" @click="openAddTab">＋</button>
          <div v-for="name in tabs" :key="name"
               class="tab"
               :class="{active: data.activeTab === name, 'in-pool': isTabTraversePool(name), 'in-pool-random': isTabInPool(name) && !isTabTraversePool(name), 'has-selected': tabHasSelected(name)}"
               draggable="true"
               @click="switchTab(name)"
               @contextmenu.prevent="openCatMenu($event, 'tab', name)"
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
              <div class="chip-depth" :data-tip="depth === 0 ? '一级分类（右键分类可新建 / 编辑）' : '第 ' + (depth + 1) + ' 级分类'">{{ depth === 0 ? '大类' : (depth + 1) + '级' }}</div>
              <div v-if="line.length" class="chip clear" :class="{active: !getSelections()[depth].length}"
                   @click="clearChip(depth)">全部</div>
              <div v-else-if="canAddChip(depth)" class="chip chip-void"
                   data-tip="这一层还没有分类，右键在此新建子分类"
                   @contextmenu.prevent="openAddChip(depth)">（空）右键新建</div>
              <div v-for="name in line" :key="name"
                   class="chip"
                   :class="[chipThemeClass, {active: getSelections()[depth].includes(name), 'in-pool': isChipTraversePool(depth, name), 'in-pool-random': isChipInPool(depth, name) && !isChipTraversePool(depth, name)}]"
                   :style="chipStyle(name)"
                   draggable="true"
                   @click="toggleChip(depth, name)"
                   @contextmenu.prevent="openCatMenu($event, 'chip', name, depth)"
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
            <div v-if="!filteredFiles.length" class="empty">没有匹配的提示词 —— 右键分类可新建词条 / 子分类</div>
            <div v-for="file in visibleFiles" :key="file.relPath"
                 class="card image" :data-rel="file.relPath"
                 :class="{
                   selected: isFileSelected(file),
                   muted: !!file.mute,
                   'zhule-source': drag.active && drag.sourceType === 'card' && drag.sourceRelPath === file.relPath,
                   'drop-target': drag.hoverCardRelPath === file.relPath
                 }"
                 @pointerdown="onCardPointerDown($event, file)"
                 @contextmenu.prevent="openCardMenu($event, file)">
              <div class="card-thumb-wrap">
                <div class="thumb-badge ov" v-if="(file.override || '').trim()" data-tip="已配置排除词：只删「别的词条」里命中的提示词段，不删自己">排除</div>
                <div class="thumb-badge ng" v-if="(file.neg || '').trim()" data-tip="已配置负面提示词：该词条被选中时并入负面输出">负面</div>
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
                <div class="thumb-nav" @pointerdown.stop v-if="file.images && file.images.length > 1">
                  <button @click.stop="prevImage(file)">‹</button>
                  <button class="dice" @click.stop="randomImage(file)">🎲</button>
                  <button @click.stop="nextImage(file)">›</button>
                </div>
                <!-- 左侧竖排操作：静音 / 删除 / 编辑 / 上传参考图（悬停显现，永不挤压名字） -->
                <div class="card-actions" v-if="!hideCardIcons">
                  <button class="card-act act-mute" :class="{on: !!file.mute}"
                          :data-tip="file.mute ? '已静音（Mute）：自动选词跳过它，手动点选仍可用（点击恢复）' : '静音（Mute）：不参与随机、填充与遍历等自动选词，仅手动点选时可用'"
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
                <!-- 底部压暗渐变 + 名字叠于图上 -->
                <div class="card-caption">
                  <span class="card-name" :data-tip="file.name">{{ file.name }}</span>
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
            <span style="color:var(--text-3);font-size:12px;">第 {{ pageIndex + 1 }}/{{ pageCount }} 页 · 共 {{ filteredFiles.length }} 张</span>
          </div>
        </div>
        </div>

        <div class="bottom">
          <div class="selected-header">
            <span>已选 <span class="selected-count">{{ data.selected.length }}</span> 项</span>
            <span style="color:var(--text-3);font-size:11px;">右键 tab / chip 循环切换：🎲 随机池 → ∞ 遍历池 → 移出 ｜ 拖动 tab / chip / 已选标签排序</span>
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
          <!-- 预览：展示拼接后的最终结果（含父级分类继承），负面提示词一键展开（词库设置里可永久关闭） -->
          <div class="preview" v-show="!selectedCollapsed" :class="{'random-mode': data.fillMode || data.traverseMode}">
            <span class="pv-label">正向</span>
            <span class="pv-text">{{ previewText }}</span>
            <button type="button" class="pv-neg-toggle" :class="{on: pref.showNegPreview}" @click="toggleNegPreview"
                    :data-tip="pref.showNegPreview ? '收起负面提示词预览（词库设置里可永久关闭）' : '展开负面提示词预览'">负面 {{ pref.showNegPreview ? '⏶' : '⏷' }}</button>
          </div>
          <div class="preview neg" v-show="!selectedCollapsed && pref.showNegPreview"
               :class="{'random-mode': data.fillMode || data.traverseMode}">
            <span class="pv-label neg">负向</span>
            <span class="pv-text">{{ previewNegText || '（无）' }}</span>
          </div>
        </div>
      </template>

      <!-- 分类右键菜单：首项「编辑分类」，其余为池三态与新建 -->
      <div v-if="catMenu.open" class="ctx-layer" @pointerdown.self="closeCatMenu" @contextmenu.prevent.self="closeCatMenu">
        <div class="ctx-menu" :style="{ left: catMenu.x + 'px', top: catMenu.y + 'px' }">
          <div class="ctx-title">{{ catMenu.title }}</div>
          <button type="button" class="ctx-item primary" @pointerdown.stop @click="onCtxEditCategory">✎ 编辑分类</button>
          <div class="ctx-sep"></div>
          <button type="button" class="ctx-item" :class="{ on: catMenu.pool === 'all' }"
                  @pointerdown.stop @click="onCtxPool('all')">🚫 不进池</button>
          <button type="button" class="ctx-item" :class="{ on: catMenu.pool === 'random' }"
                  @pointerdown.stop @click="onCtxPool('random')">🎲 随机池</button>
          <button type="button" class="ctx-item" :class="{ on: catMenu.pool === 'traverse' }"
                  @pointerdown.stop @click="onCtxPool('traverse')">∞ 遍历池</button>
          <div class="ctx-sep"></div>
          <button type="button" class="ctx-item" @pointerdown.stop @click="onCtxAddChild">＋ 新建子分类</button>
          <button type="button" class="ctx-item" @pointerdown.stop @click="onCtxAddCard">＋ 新建提示词</button>
          <button type="button" class="ctx-item" v-if="catMenu.kind === 'tab'"
                  @pointerdown.stop @click="onCtxAddTab">＋ 新建大类</button>
        </div>
      </div>

      <!-- 词库卡片右键菜单：卡片原图标功能的完整复制（左右切换与骰子仍留在卡片上） -->
      <div v-if="cardMenu.open" class="ctx-layer" @pointerdown.self="closeCardMenu" @contextmenu.prevent.self="closeCardMenu">
        <div class="ctx-menu" :style="{ left: cardMenu.x + 'px', top: cardMenu.y + 'px' }">
          <div class="ctx-title">{{ cardMenu.title }}</div>
          <button type="button" class="ctx-item primary" @pointerdown.stop @click="onCardEdit">✎ 编辑词条</button>
          <button type="button" class="ctx-item" @pointerdown.stop @click="onCardMute">
            {{ cardMenu.muted ? '🔊 恢复（取消静音）' : '🔇 静音（不参与自动选词）' }}
          </button>
          <button type="button" class="ctx-item" @pointerdown.stop @click="onCardUpload">🖼 上传参考图（优先展示）</button>
          <button type="button" class="ctx-item" @pointerdown.stop @click="onCardDeleteWord">🗑 删除词条</button>
          <div class="ctx-sep"></div>
          <button type="button" class="ctx-item" @pointerdown.stop @click="onCardGallery">→ 进入详情页</button>
          <button type="button" class="ctx-item" @pointerdown.stop @click="onCardZoom">🔍 放大预览</button>
          <button type="button" class="ctx-item" v-if="cardMenu.hasImages"
                  @pointerdown.stop @click="onCardDeleteRef">🗑 删除当前参考图</button>
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
          <div class="title">增加词条</div>
          <div class="field">
            <label>名字</label>
            <input ref="addCardInput" type="text" v-model="addCardName"
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
            <span class="title-text">编辑：{{ editTarget.name }}</span>
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

      <!-- 全站唯一删除确认弹框：与图库删除共用（设置里开启「删除免确认」则不弹） -->
      <delete-dialog :state="del.state" @confirm="del.confirm" @cancel="del.cancel"></delete-dialog>

      <!-- 全屏查看 -->
      <div v-if="viewer.open" class="viewer-overlay" @click.self="closeViewer">
        <div class="viewer-dialog">
          <div class="viewer-head">
            <span class="viewer-title">{{ viewer.file.name }}</span>
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
      // randomMode 仅为旧存档兼容字段，不再有界面入口，读档时会被迁移成池类型
      randomMode: false,
      // fillMode：填充模式（结果平等，把遍历池提示词的参考图补到统一目标数量，集中倒满一桶再下一桶）
      fillMode: false,
      // traverseMode：遍历模式（单次平等，遍历池所有词条做笛卡尔积全跑，「次数」是最外层大 for，整套组合重复几轮）
      traverseMode: false,
    });

    // pref 单独持久化：整包 state 的 JSON.stringify 一旦因数据异常失败会被静默吞掉，
    // 连带偏好失效；这里让 pref 走自己的 key，与整包存档互不牵连。
    const PREF_KEY = 'zhule_wordbank_pref_v1';
    // 词库专属设置面板开关（只作用于本页，不写进通用设置）
    const bankPrefOpen = ref(false);

    function loadPref() {
      // showNegPreview 为词库专属设置（非通用设置）：预览框是否展开「负面提示词」一行，默认展开。
      const p = { columns: 4, translate: false, genCount: 1, autoSelectParent: true, showNegPreview: true };
      try {
        const raw = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
        if (raw && typeof raw === 'object') {
          if (typeof raw.columns === 'number' && raw.columns >= 1 && raw.columns <= 20) p.columns = raw.columns;
          if (typeof raw.translate === 'boolean') p.translate = raw.translate;
          if (typeof raw.genCount === 'number' && raw.genCount >= 0 && raw.genCount <= 99) p.genCount = raw.genCount;
          if (typeof raw.autoSelectParent === 'boolean') p.autoSelectParent = raw.autoSelectParent;
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
        selected: data.selected.map(s => s._ph ? { _ph: true, _poolKey: s._poolKey, tab: s.tab, name: s.name, _filled: !!s._filled, relPath: s.relPath || undefined, id: s.id || undefined, content: s.content || undefined, content_cn: s.content_cn || undefined, neg: s.neg || undefined, override: s.override || undefined } : { tab: s.tab, relPath: s.relPath, id: s.id || undefined, name: s.name, _poolKey: s._poolKey || undefined }),
        randomPools: data.randomPools,
        // 模式存档版本：3 起「随机」是池类型（每个池的 traverse 字段）而非全局模式；
        // 2 起区分 fillMode（填充）/traverseMode（遍历）；旧存档无 modeVer。
        // 其 traverseMode 字段是旧的「填充」语义，恢复时需迁移到 fillMode
        modeVer: 3,
        fillMode: data.fillMode,
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
        // 池类型：旧存档的池没有 traverse 字段 → 一律视为随机池 🎲（与旧行为一致）
        data.randomPools.forEach(it => { it.traverse = !!it.traverse; });
        if (typeof state.randomMode === 'boolean') data.randomMode = state.randomMode;
        if (state.modeVer >= 2) {
          if (typeof state.fillMode === 'boolean') data.fillMode = state.fillMode;
          if (typeof state.traverseMode === 'boolean') data.traverseMode = state.traverseMode;
        } else if (typeof state.traverseMode === 'boolean') {
          // 旧存档（modeVer < 2）：traverseMode 是旧的「填充」语义，迁移为 fillMode
          data.fillMode = state.traverseMode;
        }
        // modeVer < 3 迁移：旧「随机模式 🔄」= 各池各抽一条逐条出图，
        // 在新模型里等价于「所有池都是随机池 🎲 + 遍历跑法（没有遍历池时每轮各抽一条）」。
        if (!(state.modeVer >= 3) && data.randomMode) {
          data.randomMode = false;
          data.fillMode = false;
          data.traverseMode = true;
          data.randomPools.forEach(it => { it.traverse = false; });
        }
        data.randomMode = false;
        // 两模式互斥兜底：旧存档或手改存档可能同时为 true，填充优先
        if (data.fillMode) data.traverseMode = false;
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
              rebuilt.push({ _ph: true, _poolKey: s._poolKey || '', tab: s.tab || '', name: s.name || '', _filled: !!s._filled, relPath: s.relPath || '', id: s.id || '', content: s.content || '', content_cn: s.content_cn || '', neg: s.neg || '', override: s.override || '' });
              return;
            }
            if (!s.tab || !s.relPath) return;
            const cards = bankData.value[s.tab] || [];
            const card = cards.find(c => c.relPath === s.relPath);
            if (card) rebuilt.push({ tab: s.tab, relPath: card.relPath, id: card.id || '', name: card.name, content: card.content, content_cn: card.content_cn, neg: card.neg || '', override: card.override || '', _poolKey: s._poolKey || undefined });
            else rebuilt.push({ tab: s.tab, relPath: s.relPath, id: s.id || '', name: s.name || '', content: s.content || '', content_cn: s.content_cn || '', neg: s.neg || '', override: s.override || '', _poolKey: s._poolKey || undefined });
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
      return !!chipParentPath(depth);
    };

    // 注：词条/分类的新增入口已统一收到「分类右键菜单」，不再有加号卡片

    const addCardIsTxt = computed(() => (addCardName.value || '').trim().toLowerCase().endsWith('.txt'));

    // 父分类显示名链（用于加号按钮 title）
    const chipParentLabel = (depth) => {
      if (depth <= 0) return tabLabel(data.activeTab);
      const parentKey = chipParentPath(depth);
      return parentKey ? parentKey.split('/').map(dispKey).join('/') : '';
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

    // ============ 静音开关（mute） ============
    // 语义：mute=1（静音）的词条在随机模式、填充模式、遍历模式、单次随机等自动选词流程被跳过，
    // 只有用户手动点选卡片时才参与。与删除（isdel）不同：卡片照常显示、参考图不动，
    // 随时可一键恢复；已选区里已手选的标签也不受影响。
    const muteBusy = ref(false);
    const toggleMute = async (file) => {
      if (!file || !file.id || muteBusy.value) return;
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
        showToast((json.mute ? '已静音：' : '已取消静音：') + file.name
          + (json.mute ? '（自动选词跳过它，手动点选仍可用）' : ''), 'success', 2600);
      } catch (e) {
        showToast('请求失败：' + e.message, 'error');
      } finally {
        muteBusy.value = false;
      }
    };

    const openEdit = (file) => {
      editTarget.value = file;
      editName.value = file.name || '';
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
          name: nm,
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
        tabs.value = json.tabs || [];
        tabIds.value = json.tab_ids || {};
        if (json.nodes && typeof json.nodes === 'object') bankNodes.value = json.nodes;
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
      // 小分类 chip 同样遵循「隐藏被静音的提示词」：静音词条不参与 chip 生成，避免出现点进去空空的分组
      const files = (bankData.value[data.activeTab] || []).filter(f => !(hideMuted.value && f.mute));
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
        // 通用设置开启时隐藏已静音词条（仅影响列表展示，不影响词库数据与手动编辑）
        if (hideMuted.value && f.mute) return false;
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
      if (data.fillMode || data.traverseMode) {
        const modeName = data.traverseMode ? '遍历' : '填充';
        const filled = data.selected.filter(s => !s._ph || s._filled);
        if (filled.length) {
          return modeName + '抽取：' + withRemoved(composePreview(filled));
        }
        if (data.randomPools.length) {
          const lab = (p) => (p.kind === 'tab' ? tabLabel(p.tab) + '(全部)' : p.display);
          const trav = data.randomPools.filter(it => it.traverse).map(lab);
          const rnd = data.randomPools.filter(it => !it.traverse).map(lab);
          const parts = [];
          if (trav.length) parts.push('∞ 遍历池 ' + trav.length + ' 个 [' + trav.join(' | ') + ']');
          if (rnd.length) parts.push('🎲 随机池 ' + rnd.length + ' 个 [' + rnd.join(' | ') + ']');
          const rndNote = rnd.length ? '；随机池每组合现抽 1 条' : '';
          let extra = '';
          if (data.traverseMode) {
            // 遍历模式：次数是最外层大 for —— 整套遍历组合重复跑 rounds 轮
            const rounds = Math.max(1, Number(pref.genCount) || 0);
            extra = (trav.length ? '；遍历池做全组合，次数 ' + rounds + ' = 整套组合重复 ' + rounds + ' 轮' : '；无遍历池，次数 ' + rounds + ' = 每轮各抽 1 条') + rndNote;
          } else {
            extra = '；目标 = 遍历池当前最多参考图数 + ' + pref.genCount + '（设 0 则补到最多那个的数量），集中填充' + rndNote;
          }
          return modeName + '模式：' + parts.join(' → ') + extra;
        }
        return modeName + '模式已开，但池子为空。右键 tab / chip 加入随机池，再右键可改成遍历池 ∞';
      }
      const picked = data.selected.filter(s => !s._ph || s._filled);
      if (!picked.length) return '（空）';
      return withRemoved(composePreview(picked));
    });

    // 负面预览：同样是「自身 + 父级分类」拼完的最终结果，与正向一一对应
    const previewNegText = computed(() => {
      if (data.fillMode || data.traverseMode) {
        const hasNeg = data.selected.some(s => String(s.neg || '').trim())
          || data.randomPools.length > 0;
        return hasNeg ? '（运行期按实际抽中的提示词拼接 自身 + 父级 负面）' : '';
      }
      const picked = data.selected.filter(s => !s._ph || s._filled);
      if (!picked.length) return '';
      return joinInherit(expandItems(picked).map(s => s.neg));
    });
    // 预览框上的快捷开关，与词库设置里的开关共用同一个 pref 字段
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
    const isChipInPool = (depth, name) => {
      const tab = data.activeTab;
      const chipId = chipIdFor(tab, depth, name);
      return data.randomPools.some(it => it.kind === 'chip' && it.tab === tab && (it.chipId ? it.chipId === chipId : samePath(it.path, chipPathFor(depth, name))));
    };
    const isChipTraversePool = (depth, name) => {
      const tab = data.activeTab;
      const chipId = chipIdFor(tab, depth, name);
      return data.randomPools.some(it => it.kind === 'chip' && it.tab === tab && !!it.traverse && (it.chipId ? it.chipId === chipId : samePath(it.path, chipPathFor(depth, name))));
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
    const catMenu = reactive({ open: false, x: 0, y: 0, kind: 'tab', key: '', depth: 0, title: '', pool: 'all' });

    // 路径（带编号的原始目录名链路，与 chips key 同口径）→ 节点属性：
    // 空分类目录还没生成任何词条卡片时，也能靠它精确定位分类节点。
    const nodeByPath = computed(() => {
      const m = {};
      const all = bankNodes.value || {};
      Object.keys(all).forEach(id => {
        const n = all[id];
        if (n && n.path) m[n.path] = n;
      });
      return m;
    });
    const nodeOfCat = (kind, key) => (kind === 'tab'
      ? (bankNodes.value[tabIds.value[key] || ''] || null)
      : (nodeByPath.value[key] || null));
    const poolKindOf = (kind, key, depth) => {
      const tab = data.activeTab;
      if (kind === 'tab') {
        const it = data.randomPools.find(p => p.kind === 'tab' && p.tab === key);
        return it ? (it.traverse ? 'traverse' : 'random') : 'all';
      }
      const chipId = chipIdFor(tab, depth, key);
      const path = chipPathFor(depth, key);
      const it = data.randomPools.find(p => p.kind === 'chip' && p.tab === tab
        && (p.chipId ? p.chipId === chipId : samePath(p.path, path)));
      return it ? (it.traverse ? 'traverse' : 'random') : 'all';
    };
    const openCatMenu = (evt, kind, key, depth) => {
      if (!data.activeTab) return;
      catMenu.open = true;
      catMenu.kind = kind;
      catMenu.key = key;
      catMenu.depth = depth;
      catMenu.title = kind === 'tab' ? tabLabel(key) : String(key).split('/').slice(1).map(dispKey).join(' / ');
      catMenu.pool = poolKindOf(kind, key, depth);
      // 贴边翻转，避免菜单跑出窗口
      catMenu.x = Math.max(8, Math.min(evt.clientX, window.innerWidth - 210));
      catMenu.y = Math.max(8, Math.min(evt.clientY, window.innerHeight - 320));
    };
    const closeCatMenu = () => { catMenu.open = false; };

    // ============ 词库卡片右键菜单 ============
    // 卡片上原有的图标操作（编辑/静音/上传参考图/删除词条/进入详情/放大/删除参考图）全部在此复制一遍，
    // 左右切换与 🎲 骰子属于高频操作，始终保留在卡片上；开启「隐藏卡片上的图标」后右键菜单成为唯一入口。
    const cardMenu = reactive({ open: false, x: 0, y: 0, file: null, title: '', muted: false, hasImages: false });
    const openCardMenu = (evt, file) => {
      if (!file) return;
      closeCatMenu();
      cardMenu.file = file;
      cardMenu.title = file.name || '';
      cardMenu.muted = !!file.mute;
      cardMenu.hasImages = !!(file.images && file.images.length);
      cardMenu.x = Math.max(8, Math.min(evt.clientX, window.innerWidth - 230));
      cardMenu.y = Math.max(8, Math.min(evt.clientY, window.innerHeight - 330));
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
    // 池三态：直接复用原有 toggle 逐级推进，校验（父子链冲突提示）与三态循环完全一致
    const setPoolBy = (kind, key, depth, want) => {
      for (let i = 0; i < 4; i++) {
        const cur = poolKindOf(kind, key, depth);
        if (cur === want) return;
        if (kind === 'tab') togglePoolForTab(key);
        else togglePoolForChip(depth, key);
        if (poolKindOf(kind, key, depth) === cur) return; // 被冲突拦住，别空转
      }
    };
    const onCtxPool = (want) => {
      const m = { kind: catMenu.kind, key: catMenu.key, depth: catMenu.depth };
      closeCatMenu();
      setPoolBy(m.kind, m.key, m.depth, want);
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
        : String(key).split('/').slice(1).map(dispKey).join(' / ');
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

    // ---- 菜单里的新建入口 ----
    const onCtxEditCategory = () => {
      const m = { kind: catMenu.kind, key: catMenu.key };
      closeCatMenu();
      openCatEdit(m.kind, m.key);
    };
    const onCtxAddChild = () => {
      const m = { kind: catMenu.kind, depth: catMenu.depth };
      closeCatMenu();
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
        for (let i = 0; i < maxDepth.value; i++) sel[i] = [];
      }
      openAddCard();
    };
    const onCtxAddTab = () => { closeCatMenu(); openAddTab(); };
    // 把选区设成某条分类链（新建词条的父目录由选区推导）
    const selectChipChain = (key, depth) => {
      const sel = getSelections();
      for (let i = 0; i < maxDepth.value; i++) sel[i] = [];
      const parts = String(key).split('/');
      for (let i = 0; i <= depth && i < parts.length - 1; i++) {
        sel[i] = [parts.slice(0, i + 2).join('/')];
      }
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
      data.randomPools.push({ kind: 'tab', tab, path: [], display: tab, traverse: false });
      zhuleLog('togglePoolForTab: 加入随机池', { kind: 'tab', tab }, 'selected=', selSummary());
      syncPlaceholders();
      showToast('「' + tabLabel(tab) + '」加入随机池 🎲：每次现抽 1 条（再右键改遍历池）', 'success', 2600);
    };
    const togglePoolForChip = (depth, name) => {
      const path = chipPathFor(depth, name);
      const tab = data.activeTab;
      const chipId = chipIdFor(tab, depth, name);
      const idx = data.randomPools.findIndex(it => it.kind === 'chip' && it.tab === tab && (it.chipId ? it.chipId === chipId : samePath(it.path, path)));
      const label = path.map(dispKey).join('/');
      if (idx >= 0) {
        const cur = data.randomPools[idx];
        if (!cur.traverse) {
          cur.traverse = true;
          zhuleLog('togglePoolForChip: 🎲→∞ 改为遍历池', { kind: 'chip', tab, chipId, display: label }, 'selected=', selSummary());
          refreshPoolPlaceholder(cur);
          syncPlaceholders();
          return showToast('「' + label + '」改为遍历池 ∞：所有词条参与全组合', 'success', 2400);
        }
        data.randomPools.splice(idx, 1);
        zhuleLog('togglePoolForChip: 移出池', cur, 'selected=', selSummary());
        syncPlaceholders();
        return showToast('「' + label + '」已移出池', 'warn', 2000);
      }
      const chk = hasPoolConflict(tab, chipId);
      if (chk.conflict) return showToast('无法加入：' + chk.msg, 'warn');
      data.randomPools.push({ kind: 'chip', tab, path, chipId, display: label, traverse: false });
      zhuleLog('togglePoolForChip: 加入随机池', { kind: 'chip', tab, path, chipId, display: label }, 'selected=', selSummary());
      syncPlaceholders();
      showToast('「' + label + '」加入随机池 🎲：每次现抽 1 条（再右键改遍历池）', 'success', 2600);
    };
    const clearRandomPools = () => { data.randomPools.splice(0, data.randomPools.length); zhuleLog('clearRandomPools', 'selected=', selSummary()); syncPlaceholders(); };

    // ============ 占位符（右键 tab / chip 进池时同步出现在已选列表，类名即占位名；遍历/随机出词后填充该位置） ============
    const poolKeyFor = (item) => item.kind === 'tab' ? 'tab:' + item.tab : 'chip:' + item.tab + '|' + (item.path || []).join('/');
    const placeholderFor = (item) => ({
      _ph: true,
      _poolKey: poolKeyFor(item),
      tab: item.tab,
      name: (item.traverse ? '∞ ' : '🎲 ') + (item.kind === 'tab' ? tabLabel(item.tab) : dispKey(item.display || (item.path || []).map(dispKey).join('/') || '')),
    });
    // 从占位符 _poolKey 解析分类显示名（tab:xxx / chip:tab|逐层路径），用于「分类：抽中词条名」拼接
    const placeholderBaseName = (s) => {
      if (!s || !s._poolKey) return '';
      const k = s._poolKey;
      if (k.startsWith('tab:')) return tabLabel(k.slice(4));
      const bar = k.indexOf('|');
      if (bar < 0) return '';
      const parts = k.slice(bar + 1).split('/');
      return dispKey(parts[parts.length - 1]);
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
    // 池子跑法只有两种，互斥：遍历 🔁（单次平等，每个词条增量相同）与填充 ⏩（结果平等，追平图数）；
    // 「随机」不再是模式，而是池子类型（🎲 随机池每次现抽一条），可融入以上任一种跑法。
    // 关闭任一「批量跑池」模式（填充 ⏩ / 遍历 🔁）时，立即掐断正在运行的队列，避免「取消后又补上」
    const stopPoolRun = (label) => {
      if (!runBusy && traverseTarget <= 0 && !runQueue.length) return;
      resetTraverseTarget();
      runBusy = false;
      runQueue = [];
      showToast('已停止' + label + '，本轮共提交 ' + runTotal + ' 条任务', 'warn', 3000);
    };
    // 填充模式：结果平等——遍历池内每条提示词的参考图补到统一目标数量
    const toggleFillMode = () => {
      data.fillMode = !data.fillMode;
      if (data.fillMode) {
        stopPoolRun('上一批任务');
        data.traverseMode = false;
        const trav = data.randomPools.filter(it => it.traverse).length;
        if (data.randomPools.length && !trav) showToast('当前没有遍历池 ∞：填充需要至少一个遍历池，右键可把池子从 🎲 改成 ∞', 'warn', 4200);
        return;
      }
      stopPoolRun('填充');
    };
    // 遍历模式：单次平等——遍历池 ∞ 的词条做全组合各跑一遍，随机池 🎲 每个组合现抽 1 条，「次数」为整套组合重复轮数
    const toggleTraverseMode = () => {
      data.traverseMode = !data.traverseMode;
      if (data.traverseMode) {
        stopPoolRun('上一批任务');
        data.fillMode = false;
        return;
      }
      stopPoolRun('遍历');
    };

    // 随机池语义：每个右键选中的 tab / chip 各为一个独立子池。
    // 随机/遍历时从每个子池各取 1 条再组合（如角色/神态/身材/姿势各抽一）。
    // 静音（mute=1）：被标记的词条不进入任何自动选词流程——单次随机、随机模式、
    // 遍历模式全部跳过；用户手动点选卡片时走 data.selected，不经过本函数，故不受影响。
    const poolCandidates = (item) => {
      const files = bankData.value[item.tab] || [];
      if (!files.length && tabs.value.includes(item.tab)) {
        // 懒加载下该分类尚未加载：异步补拉数据，返回 null 让调用方提示稍候
        load(false, item.tab);
        zhuleLog('poolCandidates: 懒加载补拉', item.kind, 'tab=', item.tab, 'path=', item.path || []);
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
      if (!id) { zhuleLog('poolCandidates: chip池缺chipId（旧存档未迁移，请重新右键加入随机池）', 'tab=', item.tab, 'path=', item.path || []); return []; }
      const out = alive.filter(f => Array.isArray(f.chipIds) && f.chipIds.includes(id));
      zhuleLog('poolCandidates: chip池', 'tab=', item.tab, 'chipId=', id, 'count=', out.length, 'total=', files.length, 'sampleChipIds=', files.slice(0, 3).map(f => f.chipIds));
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
    // 遍历模式（全跑）的单次组合上限：比填充模式更宽松，因为它的语义就是把所有组合跑一遍；
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
    // 池条目统一补 _pool:true，供填充模式的达标判定复用。
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
        if (!c || !c.length) { zhuleLog('pickFromPools: 候选为空', item.kind, 'tab=', item.tab, 'path=', item.path || []); return null; }
        const file = c[Math.floor(Math.random() * c.length)];
        zhuleLog('pickFromPools: 抽中', item.kind, 'tab=', item.tab, 'name=', file.name, '候选数=', c.length);
        picks.push({ tab: item.tab, relPath: file.relPath, id: file.id || '', name: file.name, content: file.content, content_cn: file.content_cn, neg: file.neg || '', override: file.override || '', anc: file.anc || [], _poolKey: poolKeyFor(item), _pool: true });
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

    // 遍历组合列表（遍历 🔁 与填充 ⏩ 共用）：只对遍历池 ∞ 做笛卡尔积，
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
        // 用户拖拽排序一致）。绝不能在这里按 name 拼音重排，否则遍历/填充会以「拼音顺序」
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
      return combos.map(combo => combo.map(e => ({ tab: e.tab, relPath: e.file.relPath, id: e.file.id || '', name: e.file.name, content: e.file.content, content_cn: e.file.content_cn, neg: e.file.neg || '', override: e.file.override || '', _pool: true, _poolKey: e._poolKey })));
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
      // 补拉完仍为空 = 该 tab 真的没有词条；有词条但全被静音同样视为不可用（自动选词取不到）
      const alive = (it) => (bankData.value[it.tab] || []).filter(f => !f.mute);
      const ready = data.randomPools.every(it => alive(it).length > 0);
      zhuleLog('ensurePoolData: ready=', ready,
        '各池可用词条数=', data.randomPools.map(p => p.tab + ':' + alive(p).length + '/' + (bankData.value[p.tab] || []).length));
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
    // 填充目标数量模式：自动逐轮补跑，每轮每个参考图不足目标数量的组合各补 1 次，直到全部达标
    let traverseTarget = 0;
    let extraRuns = new Map();
    // 启动填充时对每个池条目已收录参考图数的快照；轮间不再依赖 index 实时刷新，
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
          // 填充模式：后台静默补跑（集中填充：先满一桶再下一桶）。不再轮间刷新词库 index
          //（避免下方标签不断变化），达标判定仅用「启动快照 + 累计提交次数」，提交次数达到目标
          // 即停，杜绝 index 收录延迟导致 got 恒 0 的无限循环；用户关闭填充模式（⏩）即停止。
          if (!data.fillMode) {
            resetTraverseTarget();
            runBusy = false;
            showToast('已停止填充，共提交 ' + runTotal + ' 条任务', 'warn', 3000);
            return;
          }
          const built = buildTraverseCombos();
          if (built && !built.tooMany) {
            const pending = filterTraversePending(built, traverseTarget);
            if (pending.length) {
              // 遍历组合只含遍历池条目，提交前给每条补上随机池 🎲 的现抽结果
              const arr = [];
              let pickFail = false;
              for (const combo of pending) {
                const full = withRandomPick(combo);
                if (!full) { pickFail = true; break; }
                arr.push(arrangeBySelection(full));
              }
              if (pickFail) {
                resetTraverseTarget();
                runBusy = false;
                runQueue = [];
                showToast('随机池 🎲 抽不出词条（该分类下暂无可用词条），已停止填充', 'warn', 4000);
                return;
              }
              runQueue = arr;
              runTotal += arr.length;
              runBusy = true;
              runNextInQueue();
              return;
            }
          }
          const t = traverseTarget;
          resetTraverseTarget();
          runBusy = false;
          showToast('已提交 ' + runTotal + ' 条任务：填充池提示词参考图均已达到目标数量 ' + t, 'success', 3500);
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
        items: expandItems(items).map(s => ({ id: s.id || '', name: s.name, content: s.content, neg: s.neg || '', override: s.override || '' })),
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
      if (data.fillMode || data.traverseMode) {
        if (!data.randomPools.length) return showToast('池子为空，右键 tab / chip 加入随机池（再右键可改成遍历池）', 'warn');
        const ready = await ensurePoolData();
        if (!ready) return showToast('池子含空分类（该 tab 下暂无词条，或词条已全部静音），请检查池子', 'warn');
      if (runBusy) return showToast('正在逐条运行中，请稍候', 'warn');
        if (!linkParams.bind) return showToast('当前网页未绑定节点，请从画布节点「词库」按钮打开本页', 'warn', 4000);
        let combos;
        let traverseInfo = null;
        if (data.traverseMode) {
          // 遍历模式（单次平等）：遍历池 ∞ 的词条做笛卡尔积各跑一遍，随机池 🎲 每个组合现抽 1 条；
          // 「次数」= 最外层大 for —— 整套组合重复跑 rounds 轮（0 按 1 轮）。
          // 必须至少有一个 ∞ 遍历池：否则单轮只有一条空组合，等效于「每轮把随机池各抽一条」，
          // 跑起来就是完全乱序（与用户「先做完这一类再下一类」的预期相反），这里直接拦截说明。
          if (!traversePoolItems().length) {
            return showToast('遍历模式需要至少一个遍历池 ∞：右键池子把 🎲 改成 ∞ 才会按顺序穷举，否则每条都是现抽、顺序会全乱', 'warn', 4600);
          }
          const built = buildTraverseCombos(TRAVERSE_ALL_MAX_COMBOS);
          if (!built) return showToast('遍历池含空分类或数据未加载，请检查池子', 'warn');
          if (built.tooMany) return showToast('遍历组合数过多（' + built.tooMany + '），请精简遍历池（上限 ' + TRAVERSE_ALL_MAX_COMBOS + '）', 'warn', 4000);
          const rounds = Math.max(1, count || 0);
          combos = [];
          for (let r = 0; r < rounds; r++) {
            for (const combo of built) {
              const full = withRandomPick(combo);
              if (!full) return showToast('随机池 🎲 抽不出词条：该分类下暂无可用词条（或已全部静音），请检查池子', 'warn', 4000);
              combos.push(arrangeBySelection(full));
            }
          }
          traverseInfo = { rounds, oneRound: built.length };
          zhuleLog('runGenerate: 遍历模式全组合', '遍历池=', traversePoolItems().map(p => p.tab),
            '随机池=', randomPoolItems().map(p => p.tab),
            '单轮组合数=', built.length, '次数(外层轮数)=', rounds, '总任务数=', combos.length);
          // 顺序自检：打印单轮前 10 条组合的词条名，方便一眼核对是否按池内顺序推进
          zhuleLog('runGenerate: 遍历顺序抽样', built.slice(0, 10).map(c => c.map(e => e.name || e.relPath).join(' + ')));
        } else {
          if (!traversePoolItems().length) return showToast('填充模式需要至少一个遍历池 ∞：右键可把随机池 🎲 改成遍历池', 'warn', 4200);
          const built = buildTraverseCombos();
          if (!built) return showToast('遍历池含空分类或数据未加载，请检查池子', 'warn');
          if (built.tooMany) return showToast('遍历组合数过多（' + built.tooMany + '），请精简遍历池（上限 ' + TRAVERSE_MAX_COMBOS + '）', 'warn', 4000);
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
            return showToast('填充池提示词参考图均已达到目标数量 ' + traverseTarget + '，无需补跑', 'success', 3000);
          }
          combos = [];
          for (const combo of pending) {
            const full = withRandomPick(combo);
            if (!full) { resetTraverseTarget(); return showToast('随机池 🎲 抽不出词条：该分类下暂无可用词条（或已全部静音），请检查池子', 'warn', 4000); }
            combos.push(arrangeBySelection(full));
          }
        }
        // 遍历模式不做目标数量补跑，清掉可能残留的填充目标，避免队列跑完后又进入补跑循环
        if (data.traverseMode) resetTraverseTarget();
        runQueue = combos;
        runTotal = combos.length;
        runBusy = true;
        if (data.traverseMode) {
          const info = traverseInfo || { rounds: 1, oneRound: runTotal };
          // 池名一律打出来：跑之前一眼看清哪个池被当成「穷举」、哪个被当成「随机」，
          // 避免"我以为角色是 ∞ 实际却是 🎲"的误判（角色随机出图就是这里错了）。
          const poolName = (p) => (p.display || p.tab) + (p.kind === 'chip' && p.path && p.path.length ? '/' + p.path[p.path.length - 1] : '');
          const tNames = traversePoolItems().map(poolName);
          const rNames = randomPoolItems().map(poolName);
          showToast('遍历模式｜穷举池 ∞：' + (tNames.join('、') || '（无）')
            + '｜随机池 🎲：' + (rNames.join('、') || '（无）')
            + '｜单轮 ' + info.oneRound + ' 组合 × ' + info.rounds + ' 轮 = ' + runTotal + ' 条', 'success', 6000);
        }
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
      // 运行前统一展开继承：分类链上的 en/cn/neg/override 逐层拼到词条自己身上
      const expanded = expandItems(readyItems);
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
      if (e.target.closest('.thumb-zoom') || e.target.closest('.thumb-nav') || e.target.closest('.card-act') || e.target.closest('.thumb-enter') || e.target.closest('.thumb-del')) return;
      if (pDrag.pending) {
        if (performance.now() - pDrag.pendingTime > 3000) cleanupDrag(); else return;
      }
      e.preventDefault();
      const existIdx = data.selected.findIndex(s => s.relPath === file.relPath);
      pDrag.pending = {
        x: e.clientX, y: e.clientY,
        sourceType: 'card',
        item: { tab: data.activeTab, relPath: file.relPath, name: file.name, content: file.content, content_cn: file.content_cn, neg: file.neg || '', override: file.override || '', anc: file.anc || [] },
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
          const item = { tab: p.item.tab, relPath: p.item.relPath, id: p.item.id || '', name: p.item.name, content: p.item.content, content_cn: p.item.content_cn, neg: p.item.neg || '', override: p.item.override || '', anc: p.item.anc || [] };
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
          const item = { tab: p.item.tab, relPath: p.item.relPath, id: p.item.id || '', name: p.item.name, content: p.item.content, content_cn: p.item.content_cn, neg: p.item.neg || '', override: p.item.override || '', anc: p.item.anc || [] };
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
        const item = { tab: p.item.tab, relPath: p.item.relPath, name: p.item.name, content: p.item.content, content_cn: p.item.content_cn, neg: p.item.neg || '', override: p.item.override || '', anc: p.item.anc || [] };
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
        neg: file.neg || '', override: file.override || '',
        // 父级分类属性链随选区一起存快照：运行/预览都按它递归继承，历史选区也能自解释
        anc: file.anc || [],
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
      // 右键菜单 / 词库设置面板：点空白、Esc、滚动、改变窗口大小都收起，避免残留
      document.addEventListener('keydown', onBankKeydown);
      document.addEventListener('click', onBankDismiss, true);
      document.addEventListener('scroll', onBankDismiss, true);
      window.addEventListener('resize', onBankDismiss);
      load(); // 首屏加载数据（加载遮罩已移除）
    });
    const onBankKeydown = (e) => {
      if (e.key !== 'Escape') return;
      if (cardMenu.open) { closeCardMenu(); return; }
      if (catMenu.open) { closeCatMenu(); return; }
      if (catEdit.open) { closeCatEdit(); return; }
      if (bankPrefOpen.value) bankPrefOpen.value = false;
    };
    const onBankDismiss = (e) => {
      if (catMenu.open && !(e && e.target && e.target.closest && e.target.closest('.ctx-menu'))) closeCatMenu();
      if (cardMenu.open && !(e && e.target && e.target.closest && e.target.closest('.ctx-menu'))) closeCardMenu();
      if (bankPrefOpen.value && e && e.target && e.target.closest
        && !e.target.closest('.bank-pref') && !e.target.closest('[data-tip="词库专属设置"]')) {
        bankPrefOpen.value = false;
      }
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
      pageIndex, pageCount, pageNumbers, visibleFiles, goPrevPage, goNextPage, goPage,
      getSelections,
      chipsCollapsed, chipsHeightCss, toggleChips, onChipsResizeDown,
      selectedCollapsed, toggleSelectedCollapsed,
      imageUrl, getImgIdx, displayContent, isFileSelected,
      defaultImageUrl,
      isTabInPool, isChipInPool, isTabTraversePool, isChipTraversePool, tabHasSelected,
      switchTab, toggleChip, clearChip, togglePoolForTab, togglePoolForChip, clearRandomPools,
      addTabOpen, addTabName, addingTab, openAddTab, closeAddTab, submitAddTab,
      // 分类右键菜单 / 编辑分类
      catMenu, openCatMenu, closeCatMenu, onCtxEditCategory, onCtxPool, onCtxAddChild, onCtxAddCard, onCtxAddTab,
      // 卡片右键菜单（复制卡片图标功能）+ 通用设置「隐藏卡片上的图标」
      cardMenu, openCardMenu, closeCardMenu, hideCardIcons,
      onCardEdit, onCardMute, onCardUpload, onCardDeleteWord, onCardGallery, onCardZoom, onCardDeleteRef,
      catEdit, catSaving, openCatEdit, closeCatEdit, submitCatEdit,
      previewNegText, toggleNegPreview, bankNodes, nodeOfCat, bankPrefOpen,
      canAddChip, chipParentLabel, addCardIsTxt,
      chipThemeClass, chipStyle,
      addChipOpen, addChipName, addChipDepth, addChipInput, addingChip, openAddChip, closeAddChip, submitAddChip,
      addCardOpen, addCardName, addCardContent, addCardContentCn, addCardInput, addingCard, openAddCard, closeAddCard, submitAddCard,
      toggleTranslate, changeColumns, changeCount, onCountInput, fixCount,
      prevImage, nextImage, randomImage, goToGallery,
      viewer, closeViewer, viewerPrev, viewerNext, viewerRandom, zoomView, zoomCardImage,
      removeSelected, clearAll, toggleFillMode, toggleTraverseMode, singleRandom, runGenerate,
      onTabDragStart, onTabDragOver, onTabDrop, onTabDragEnd,
      tabLabel,
      onChipDragStart, onChipDragOver, onChipDragEnd,
      dispKey, bankSaving, saveBankOrder,
      onCardPointerDown, onTagPointerDown, onSelListPointerDown,
      toast, toastIcon, dismissToast,
    };
  },
};
