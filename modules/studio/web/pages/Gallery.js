import { useGalleryCommon, TagTreePanel, OutNode, DetailTagNode, CardCtxMenu, tagKey } from './galleryCommon.js';
import { DeleteDialog } from './deleteConfirm.js';

export default {
  name: 'Gallery',
  components: { TagTreePanel, OutNode, DetailTagNode, CardCtxMenu, DeleteDialog },
  template: `
    <div class="page active gallery-page">
    <div class="zhg-toolbar">
      <input class="zhg-search" v-model="filters.q" placeholder="搜索文件名 / 模型 / 标签... " @keyup="onSearchKeyup">
      <div class="zhg-sort-box" data-tip="按时间排序">
        <button class="zhg-sort-arrow" @click="toggleSortDir"
                :data-tip="filters.sortDir === 'desc' ? '按时间倒序（新→旧），点击切换升序' : '按时间正序（旧→新），点击切换降序'">{{ filters.sortDir === 'desc' ? '▾' : '▴' }}</button>
      </div>
      <button class="btn zhg-layout-btn" :data-tip="isTopDown ? '切换到左右布局' : '切换到上下布局'" @click="toggleLayout">⧉</button>
      <button class="btn zhg-trash-btn" :class="{on: selected.size > 0}" :disabled="!selected.size"
              data-tip="删除选中的图片（拖动框选或 Ctrl+点击 多选）" @click="askBatchDelete">🗑</button>
      <button class="btn zhg-link-btn" :class="{on: selected.size > 0}" :disabled="!selected.size"
              data-tip="将选中的图片快捷导出到 zhule_link 文件夹：硬链接 = 给原图建分身入口，不复制图片数据、几乎不占额外空间（需与图库在同一磁盘分区），每次导出自动新建独立子文件夹" @click="batchLink">🔗</button>
      <button class="btn zhg-filters-toggle" :class="{on: filtersOpen}" :data-tip="filtersOpen ? '收起整个筛选区' : '展开整个筛选区'" @click="toggleFilters">{{ filtersOpen ? '▲ 收起筛选' : '▼ 展开筛选' }}</button>
      <button class="btn zhg-dice-btn" data-tip="随机拼页：从当前筛选命中的图片中随机抽出一页覆盖当前页，页码不变" @click="randomPage">🎲</button>
      <span class="zhg-sel-count" v-if="selected.size">已选 <b>{{ selected.size }}</b>
        <a class="zhg-sel-clear" @click="selected.clear()">清除</a></span>
      <span class="zhg-total">命中 <b>{{ total }}</b> / 共 <b>{{ meta.total }}</b> 张</span>
      <span class="zhg-page-ctl">
        <button class="zhg-pg-btn" @click="changePageSize(-10)" :disabled="pageSize <= 10" data-tip="每页减少10张">−</button>
        <b class="zhg-pg-val">{{ pageSize }}</b>
        <button class="zhg-pg-btn" @click="changePageSize(10)" :disabled="pageSize >= 200" data-tip="每页增加10张">＋</button>
      </span>
      <span class="zhg-grid-ctl">
        <button class="zhg-pg-btn" @click="changeGridCols(-1)" :disabled="gridCols <= 2" data-tip="每行减少1张">−</button>
        <b class="zhg-pg-val" data-tip="每行卡片数">{{ gridCols }}列</b>
        <button class="zhg-pg-btn" @click="changeGridCols(1)" :disabled="gridCols >= 10" data-tip="每行增加1张">＋</button>
      </span>
      <span class="zhg-pager" v-if="total > pageSize">
        <button class="zhg-pg-btn" @click="goPage(page - 1)" :disabled="page <= 1" data-tip="上一页">◀</button>
        <span class="zhg-pg-info" v-if="!pageEditing" :data-tip="'双击页码可直接输入跳转'" @dblclick="beginPageEdit">第 {{ page }} / {{ totalPages }} 页</span>
        <input v-else class="zhg-pg-input" v-model="pageEditVal" @keyup.enter="commitPageEdit" @keyup.esc="cancelPageEdit" @blur="commitPageEdit" @click.stop />
        <button class="zhg-pg-btn" @click="goPage(page + 1)" :disabled="page >= totalPages" data-tip="下一页">▶</button>
      </span>
      <span class="zhg-dirty" v-if="dirty">有新图片，索引已自动重建</span>
    </div>

    <tag-tree-panel :show="tagPanelOpen" :selected="tagList" :current-tags="detail ? detail.tags : []" :theme-cls="tagThemeClass" :color-of="editColorOf" :show-count="showTagCount"
                    @close="tagPanelOpen = false" @add="addTagFilter" @remove="removeTag" @clear="clearTagFilter" @toggle="toggleTagActive" @refresh="refreshAfterTagEdit"></tag-tree-panel>

    <div class="zhg-layout">
      <aside class="zhg-side" :class="{ 'zhg-side-lock': side.h > 0 }" :style="sideStyle" v-show="filtersOpen">
        <div class="zhg-side-inner">
          <div class="zhg-block" v-if="pref.gallery.showModelFilter !== false">
            <div class="zhg-block-head">
              <span class="zhg-block-title">模型</span>
            </div>
            <div class="zhg-block-body">
              <label class="zhg-opt" v-for="m in meta.models" :key="'m'+m.name">
                <input type="checkbox" :checked="filters.models.includes(m.name)" @change="toggleModel(m.name)">
                <span class="zhg-opt-name" :data-tip="m.name">{{ fmtModel(m.name) }}</span>
                <span class="zhg-opt-count">{{ m.count }}</span>
                <button class="btn zhg-mini zhg-rename-btn" data-tip="重命名模型，同步所有关联图片" @click.stop.prevent="openRename('model', m.name)">⚙</button>
              </label>
              <div class="zhg-none" v-if="!meta.models.length">暂无</div>
            </div>
          </div>

          <div class="zhg-block" v-if="pref.gallery.showLoraFilter !== false">
            <div class="zhg-block-head">
              <span class="zhg-block-title">LoRA</span>
            </div>
            <div class="zhg-block-body">
              <label class="zhg-opt" v-for="l in meta.loras" :key="'l'+l.name">
                <input type="checkbox" :checked="filters.loras.includes(l.name)" @change="toggleLora(l.name)">
                <span class="zhg-opt-name" :data-tip="l.name">{{ l.name }}</span>
                <span class="zhg-opt-count">{{ l.count }}</span>
                <button class="btn zhg-mini zhg-rename-btn" data-tip="重命名 LoRA，同步所有关联图片" @click.stop.prevent="openRename('lora', l.name)">⚙</button>
              </label>
              <div class="zhg-none" v-if="!meta.loras.length">暂无</div>
            </div>
          </div>

          <div class="zhg-block">
            <div class="zhg-block-head">
              <span class="zhg-block-title">标签 <span class="zhg-badge">{{ visibleTags.length }}</span></span>
              <button class="zhg-tag-mode-btn" :data-tip="'标签过滤模式：' + (filters.tagMode === 'and' ? '与（AND，满足全部已启用标签）' : '或（OR，满足任一已启用标签）') + '，点击切换'"
                      @click.stop="toggleTagMode()">{{ filters.tagMode === 'and' ? '与' : '或' }}</button>
              <span class="zhg-tag-gear" data-tip="编辑标签" @click.stop="tagPanelOpen = true">⚙</span>
            </div>
            <div class="zhg-block-body">
              <!-- 外部过滤区：俄罗斯套娃包裹式展开；左键切换启用（红虚线=待生效/实色=生效/斜纹+圆点=半选：分支内有生效子标签），右键展开子标签，Ctrl+右键逐级优先收起，✕暂时隐藏 -->
              <div class="zhg-sel-tags" v-if="visibleTags.length">
                <out-node v-for="t in visibleTags" :key="tagKey(t)" :node="t" :depth="0"
                          :in-filter="inTagFilter" :is-active="isTagActive" :is-hidden="isTagHidden" :sel-state="nodeSelState" :tree-kids-fn="treeKids" :theme-cls="tagThemeClass" :color-of="tagColorOf"
                          :show-count="showTagCount" :count-of="tagCount"
                          @toggle="toggleTagActive" @add="addTagFilter" @hide="hideTag"></out-node>
              </div>
            </div>
          </div>
        </div>
        <div class="zhg-side-resize-x" data-tip="拖拽调整筛选面板宽度" @mousedown.prevent="startSideDrag($event, 'w')"></div>
        <div class="zhg-side-resize-y" data-tip="拖拽调整筛选面板高度" @mousedown.prevent="startSideDrag($event, 'h')"></div>
      </aside>

      <div class="zhg-main" ref="mainEl">
        <div class="zhg-grid" ref="gridEl" :style="gridStyle" v-if="items.length" @pointerdown="onPointerDown">
          <div class="zhg-card" v-for="it in items" :key="it.key" :data-key="it.key"
               :class="{sel: isSel(it.key)}" @click="onCardClick(it, $event)"
               @contextmenu.prevent="openCardCtx($event, it)">
            <div class="zhg-thumb-wrap" :title="cardTip(it)">
              <img class="zhg-thumb" draggable="false" loading="lazy" :src="thumbUrl(it.key, it.mtime)" :alt="it.name">
              <!-- 右侧竖排操作：选择 / 放大 / 删除（悬停显现，永不挤压名字）；通用设置「隐藏卡片上的图标」开启后整组隐藏，改走右键菜单 -->
              <div class="zhg-card-actions" v-if="!hideCardIcons">
                <button class="zhg-sel-toggle" :class="{on: isSel(it.key)}"
                        :data-tip="isSel(it.key) ? '取消选中' : '选中这张图（也可 Ctrl+点击 / 拖动框选）'"
                        @click.stop="toggleSel(it.key)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1"
                       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M4.5 12.6l4.8 4.8L19.5 7.2"/>
                  </svg>
                </button>
                <button class="zhg-zoom-btn" data-tip="放大预览"
                        @click.stop="zoomView(imgUrl(it.key, it.mtime), it)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
                       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <circle cx="10.8" cy="10.8" r="6.8"/>
                    <path d="M16 16l4.4 4.4"/>
                    <path d="M10.8 7.9v5.8M7.9 10.8h5.8"/>
                  </svg>
                </button>
                <button class="zhg-del-btn" data-tip="删除这张图" @click.stop="askDelete(it)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
                       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M4 7h16"/>
                    <path d="M9.5 7V4.8h5V7"/>
                    <path d="M6.5 7l.9 12.2h9.2L17.5 7"/>
                    <path d="M10.4 10.6v5.8M13.6 10.6v5.8"/>
                  </svg>
                </button>
              </div>
              <!-- 底部压暗渐变 + 模型/标签 + 名字叠于图上（名字独占一行不被图标挤压） -->
              <div class="zhg-card-caption">
                <div class="zhg-card-meta"
                     v-if="(pref.gallery.showModel !== false && it.model) || (pref.gallery.showTags !== false && cardTags(it).length)">
                  <span class="zhg-card-chip model" v-if="pref.gallery.showModel !== false && it.model"
                        :data-tip="'模型：' + fmtModel(it.model)">{{ fmtModel(it.model) }}</span>
                  <template v-if="pref.gallery.showTags !== false">
                    <span class="zhg-card-chip" v-for="t in cardTags(it).slice(0, 9)" :key="'ct' + t"
                          :data-tip="'标签：' + t">{{ t }}</span>
                    <span class="zhg-card-chip more" v-if="cardTags(it).length > 9"
                          :data-tip="'标签：' + cardTags(it).join(' / ')">+{{ cardTags(it).length - 9 }}</span>
                  </template>
                </div>
                <div class="zhg-card-line">
                  <span class="zhg-card-name" v-if="pref.gallery.showName" :data-tip="it.name">{{ fmtModel(it.name) }}</span>
                  <span class="zhg-card-time" v-if="pref.gallery.showTime">{{ fmtTime(it.mtime, pref.gallery.timeFmt) }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="zhg-empty" v-else-if="!loading">
          <div v-if="total === 0 && !hasFilter">图库为空，快去用 Zhule Save Image 出图吧</div>
          <div v-else>没有符合筛选条件的图片</div>
        </div>
        <div class="zhg-foot" v-if="loadingMore">加载中…</div>
      </div>
    </div>

    <div class="zhg-mask" v-if="detail" @click.self="closeDetail">
      <div class="zhg-modal">
        <div class="zhg-modal-head">
          <span class="zhg-modal-title">{{ detail.name }}</span>
          <button class="btn zhg-mini" @click="closeDetail">✕ 关闭</button>
        </div>
        <div class="zhg-modal-body">
          <div class="zhg-modal-left">
            <div class="zhg-modal-imgwrap">
              <img class="zhg-modal-img" :src="imgUrl(detail.path, detail.mtime)" :alt="detail.name" @click="zoomView(imgUrl(detail.path, detail.mtime))">
              <div class="zhg-modal-nav" v-if="detail">
                <button class="zhg-nav-btn zhg-nav-prev" @click.stop="detailNav(-1)" data-tip="上一张：在当前命中池内向前翻">‹</button>
                <div class="zhg-nav-mid">
                  <button class="zhg-nav-btn zhg-nav-dice" @click.stop="detailNavRandom" :data-tip="'骰子：从当前命中池随机一张（共 ' + hitTotal + ' 张）'">🎲</button>
                  <span class="zhg-nav-count" v-if="hitTotal">{{ detailPos > 0 ? detailPos : '—' }} / {{ hitTotal }}</span>
                  <button class="zhg-nav-btn zhg-nav-del" data-tip="删除当前图片及其库内关联数据" @click.stop="askDelete(detail)">🗑</button>
                </div>
                <button class="zhg-nav-btn zhg-nav-next" @click.stop="detailNav(1)" data-tip="下一张：在当前命中池内向后翻">›</button>
              </div>
            </div>
            <div class="zhg-modal-actions">
              <button class="btn primary" :disabled="!detail.hasWF" @click="useWorkflow(detail)" :data-tip="detail.hasWF ? '跳转 ComfyUI 并导入该图工作流' : '该图片没有保存 workflow 元数据'">
                ⚡ 在 ComfyUI 中使用工作流
              </button>
            </div>
          </div>
          <div class="zhg-modal-right">
            <div class="zhg-detail-row"><span class="zhg-detail-k">文件</span><span class="zhg-detail-v zhg-file-cell" :data-tip="fileRenaming ? '' : '双击重命名（自动保留扩展名）'" @dblclick.stop="beginFileRename">
                <template v-if="!fileRenaming">{{ fileDisplayName(detail) }}</template>
                <input v-else class="zhg-file-input" ref="fileRenameInput" v-model="fileRenameVal"
                       @keyup.enter="commitFileRename" @keyup.esc="cancelFileRename"
                       @blur="commitFileRename" @click.stop @dblclick.stop>
              </span></div>
            <div class="zhg-detail-row"><span class="zhg-detail-k">时间</span><span class="zhg-detail-v">{{ fmtTime(detail.mtime) }}</span></div>
            <div class="zhg-detail-row"><span class="zhg-detail-k">大小</span><span class="zhg-detail-v">{{ fmtSize(detail.size) }}</span></div>
            <div class="zhg-detail-row"><span class="zhg-detail-k">模型</span>
              <span class="zhg-detail-v" :data-tip="detail.model || ''">{{ detail.model ? fmtModel(detail.model) : '—' }}</span></div>
            <div class="zhg-detail-row"><span class="zhg-detail-k">LoRA</span>
              <div class="zhg-detail-v zhg-detail-tags">
                <span class="zhg-lora" v-for="l in detail.loras" :key="'dl'+l">{{ l }}</span>
                <span v-if="!detail.loras.length">—</span>
              </div></div>

            <div class="zhg-detail-section">
              <div class="zhg-detail-section-title">标签 <span class="zhg-badge">{{ detail.tags.length }}</span></div>
              <div class="zhg-detail-row">
                <div class="zhg-detail-tags">
                  <!-- 提示词标签（词库词条）在前：只读，左键放入筛选区并启用、右键编辑词条 -->
                  <span class="zhg-tag readonly hl-prompt"
                        :class="tagThemeClass"
                        :style="tagStyle(t)"
                        v-for="t in promptDetailTags" :key="'dtp'+t.name"
                        @click.stop="addDetailTagToFilter(t)"
                        @contextmenu.prevent="editDetailTag(t)"
                        :data-tip="'提示词标签（运行时注入，只读）左键放入筛选区并启用，右键编辑词条'">
                    {{ t.name }}
                  </span>
                  <!-- 自定义标签（平铺叶子）：只显示叶子名（如 '喜欢'），父级分组不出现在展示层；左键编辑词条、右键删除 -->
                  <span class="zhg-tag hl-custom" :class="[tagThemeClass]"
                        :style="t.style || {}"
                        :data-tip="'自定义标签，左键编辑词条，右键删除'"
                        v-for="t in customFlatTags" :key="'dtc' + tagKey(t)"
                        @click.stop="editDetailTag(t)" @contextmenu.prevent="askDeleteTag(t)">
                    {{ t.display }}
                  </span>
                  <span v-if="!promptDetailTags.length && !customFlatTags.length" class="zhg-none">暂无标签，点击下方 ＋ 添加</span>
                </div>
              </div>
              <div class="zhg-detail-tag-add">
                <span class="zhg-tag-add" v-if="!tagInputing" @click="startTagInput">＋ 添加标签</span>
                <div class="zhg-new-row" v-else>
                  <input class="zhg-input" v-model="quickTag" ref="tagInputEl" placeholder="输入标签后回车…"
                         @keyup="onTagKeyup" @blur="onTagInputBlur">
                  <button class="btn zhg-mini" @click="quickCreateTag">确定</button>
                </div>
              </div>
            </div>

            <div class="zhg-detail-section" v-if="detail.hasPrompt">
              <div class="zhg-detail-section-title">提示词 <span class="zhg-detail-hint">（英文）</span>
                <button class="zhg-prompt-copy" @click="copyPrompt">复制</button>
              </div>
              <pre class="zhg-prompt"><template v-for="(s, i) in enSegments" :key="'en'+i"><span v-if="s.color" class="zhg-hl" :style="{ background: s.color }">{{ s.text }}</span><span v-else>{{ s.text }}</span></template></pre>
              <div class="zhg-prompt-more" v-if="detail.promptPreview.length >= 790">…（已截断）</div>
              <div class="zhg-detail-section-title zhg-cn-title">中文提示词 <span class="zhg-detail-hint">（由标签拼接）</span></div>
              <pre class="zhg-prompt zhg-prompt-cn"><template v-for="(s, i) in cnSegments" :key="'cn'+i"><span v-if="s.color" class="zhg-hl" :style="{ background: s.color }">{{ s.text }}</span><span v-else>{{ s.text }}</span></template><template v-if="!cnSegments.length">暂无中文提示词</template></pre>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 图库卡片右键菜单：卡片图标操作 + 进入详情的统一入口（隐藏图标后为唯一入口） -->
    <card-ctx-menu :state="cardCtx" @close="closeCardCtx"
                   @sel="onCtxSel" @zoom="onCtxZoom" @detail="onCtxDetail"
                   @del="onCtxDel" @batch-del="onCtxBatchDel"></card-ctx-menu>

    <!-- 全站唯一删除确认弹框：图片/批量/标签/词条共用，设置里开启「删除免确认」则不弹 -->
    <delete-dialog :state="del.state" @confirm="del.confirm" @cancel="del.cancel"></delete-dialog>

    <div class="edit-overlay" v-if="renameOpen" @click.self="cancelRename">
      <div class="edit-dialog">
        <div class="title">重命名{{ renameKind === 'model' ? '模型' : 'LoRA' }}</div>
        <div class="hint">重命名模型将同步所有关联图片</div>
        <div class="field">
          <label>新名称（不需要填写后缀，将自动保留原扩展名）</label>
          <input type="text" v-model="renameNew" :placeholder="fmtModel(renameOld)"
                 @keyup.enter="confirmRename" @keyup.esc="cancelRename" ref="renameInput">
        </div>
        <div class="actions">
          <button class="btn zhg-mini" @click="cancelRename">取消</button>
          <button class="btn zhg-mini zhg-rename-confirm" :disabled="!renameNew.trim() || renaming" @click="confirmRename">{{ renaming ? '提交中…' : '确认' }}</button>
        </div>
      </div>
    </div>

    <!-- 词库词条编辑弹窗：左键点击详情 tag 呼出，字段与保存逻辑与词库 Wordbank.js 完全一致 -->
    <div class="edit-overlay" v-if="editWbTarget" @click.self="cancelEditWb">
      <div class="edit-dialog">
        <div class="title">编辑：{{ editWbTarget.name }}</div>
        <div class="edit-body">
        <div class="field">
          <label>名字</label>
          <input type="text" v-model="editWbName" spellcheck="false"
                 @keydown.enter="submitEditWb" @keydown.esc="cancelEditWb">
        </div>
        <div class="field en">
          <div class="field-head">
            <label>提示词（英）</label>
            <span class="count">{{ (editWbContent || '').length }} 字</span>
          </div>
          <textarea v-model="editWbContent" rows="4" spellcheck="false"
                    @keydown.ctrl.enter="submitEditWb" @keydown.esc="cancelEditWb"></textarea>
        </div>
        <div class="sep"></div>
        <div class="field cn">
          <div class="field-head">
            <label>提示词（中）</label>
            <span class="count">{{ (editWbContentCn || '').length }} 字</span>
          </div>
          <textarea v-model="editWbContentCn" rows="3" spellcheck="false"
                    @keydown.ctrl.enter="submitEditWb" @keydown.esc="cancelEditWb"></textarea>
          <span v-if="editWbIsTxt" class="hint">散 txt 卡片暂不支持中文提示词</span>
        </div>
        </div>
        <div class="actions">
          <button class="btn danger zhg-mini" :disabled="editWbDeleting" @click="askDeleteEditWb">删除</button>
          <button class="btn zhg-mini" @click="cancelEditWb">取消</button>
          <button class="btn zhg-mini zhg-rename-confirm" :disabled="!editWbName.trim() || editWbEditing" @click="submitEditWb">{{ editWbEditing ? '提交中…' : '保存' }}</button>
        </div>
      </div>
    </div>

    <transition name="toast">
      <div v-if="toast" class="zhg-toast" :class="'toast-' + toastType" @click="toast = ''">
        <span class="zhg-toast-icon">{{ toastIcon[toastType] }}</span>
        <span class="zhg-toast-msg">{{ toast }}</span>
      </div>
    </transition>
  </div>
  `,
  setup() {
    return useGalleryCommon({
      side: { initW: 268, initH: 0, wMin: 140, wMax: 900, hMin: 200, hMax: 2000 },
    });
  },
};
