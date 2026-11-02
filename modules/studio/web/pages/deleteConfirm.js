// deleteConfirm.js —— 全站唯一删除确认模块（图库图片/批量/标签/词条、词库词条共用）
//
// 用法（调用方只需描述“删什么”，不再重复写弹框和设置判断）：
//   const del = useDeleteConfirm();
//   del.ask({ title: '确认删除图片', message: '将删除该图片文件及其缩略图，此操作不可撤销。',
//             name: it.name, run: () => 真正执行删除的异步函数 });
// 模板挂一个共用弹框：
//   <delete-dialog :state="del.state" @confirm="del.confirm" @cancel="del.cancel"></delete-dialog>
//
// 设置来源：与设置面板同一份 localStorage（zhule_ui_pref.common.noDeleteConfirm）。
// 「删除免确认」已开启 → ask 直接执行 run，不弹框；未开启 → 弹框，确认后执行。
// 设置改动通过 zhule-pref-changed 广播即时同步，并在各组件 onMounted 时重读一次兜底。
import { reactive, onMounted, onBeforeUnmount } from 'vue';

const PREF_KEY = 'zhule_ui_pref';

// 读取「删除免确认」开关；读取失败按未开启处理（保留确认框，安全优先）
function readNoDeleteConfirm() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
    const v = raw && raw.common && raw.common.noDeleteConfirm;
    return v === true;
  } catch (e) {
    return false;
  }
}

// 模块级缓存：多个调用方共读同一个开关值（监听器在各实例 onMounted 注册）
let noDeleteConfirm = readNoDeleteConfirm();

export function useDeleteConfirm() {
  // 弹框状态：title 标题 / message 说明 / name 被删对象名 / busy 删除中
  const state = reactive({ show: false, busy: false, title: '确认删除', message: '', name: '' });
  let run = null;       // 待执行的删除动作
  let resolveAsk = null; // ask() 返回 Promise 的结算函数

  function syncPref() { noDeleteConfirm = readNoDeleteConfirm(); }
  function onPrefChanged(e) {
    const v = e && e.detail && e.detail.common && e.detail.common.noDeleteConfirm;
    noDeleteConfirm = (typeof v === 'boolean') ? v : readNoDeleteConfirm();
  }

  // 设置读取放在挂载阶段（与设置面板同一时刻对齐），并监听运行时改动
  onMounted(() => {
    syncPref();
    window.addEventListener('zhule-pref-changed', onPrefChanged);
  });
  onBeforeUnmount(() => {
    window.removeEventListener('zhule-pref-changed', onPrefChanged);
  });

  // 请求删除：免确认直接执行；否则弹框等待确认。返回 Promise<boolean>（是否执行成功）
  function ask(opts) {
    const o = opts || {};
    const fn = o.run;
    if (typeof fn !== 'function') return Promise.resolve(false);
    if (noDeleteConfirm) {
      return Promise.resolve().then(() => fn()).then(() => true, () => false);
    }
    state.title = o.title || '确认删除';
    state.message = o.message || '';
    state.name = o.name || '';
    state.busy = false;
    state.show = true;
    run = fn;
    return new Promise((res) => { resolveAsk = res; });
  }

  // 确认删除：执行 run，期间按钮显示“删除中…”并禁用
  async function confirm() {
    if (state.busy) return;
    state.busy = true;
    try {
      if (run) await run();
    } finally {
      state.busy = false;
      state.show = false;
      run = null;
      if (resolveAsk) { resolveAsk(true); resolveAsk = null; }
    }
  }

  // 取消：关闭弹框，不执行任何动作
  function cancel() {
    if (state.busy) return; // 删除进行中不允许中途取消（避免状态错乱）
    state.show = false;
    run = null;
    if (resolveAsk) { resolveAsk(false); resolveAsk = null; }
  }

  return { state, ask, confirm, cancel };
}

// 共用删除确认弹框：所有页面挂同一个组件、同一套样式与按钮状态
export const DeleteDialog = {
  name: 'DeleteDialog',
  props: { state: { type: Object, required: true } },
  emits: ['confirm', 'cancel'],
  template: `
    <div class="zhg-del-mask" v-if="state.show" @click.self="$emit('cancel')">
      <div class="zhg-del-box">
        <div class="zhg-del-title">{{ state.title }}</div>
        <div class="zhg-del-msg">
          {{ state.message }}
          <template v-if="state.name"><br><b>{{ state.name }}</b></template>
        </div>
        <div class="zhg-del-actions">
          <button class="btn zhg-mini" :disabled="state.busy" @click="$emit('cancel')">取消</button>
          <button class="zhg-del-btn-danger" :disabled="state.busy" @click="$emit('confirm')">{{ state.busy ? '删除中…' : '确认删除' }}</button>
        </div>
      </div>
    </div>
  `,
};
