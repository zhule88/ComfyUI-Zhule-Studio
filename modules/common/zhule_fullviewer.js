/**
 * ZhuleFullViewer —— 图片全屏查看器（公共模块）
 *
 * 设计依据：纯 HTML 验证版 test_zoom.html 的 5 条规则（详见用户说明）。
 *   1. 缩放/拖动状态用普通 let 变量，直接命令式写 element.style.transform，
 *      不经过 Vue 响应式系统（响应式驱动 transform 会在 pointermove 高频下卡顿丢帧）；
 *   2. wheel 用原生 addEventListener + { passive: false }，保证 preventDefault 生效；
 *   3. 所有事件挂在容器 overlay 上，img 设 pointer-events:none / user-drag:none，
 *      不拦截任何事件，滚轮与拖动不会被 img 吃掉；
 *   4. 元素全部由本模块创建并持有引用，宿主只需调用 open/close API，
 *      无需 querySelector（避免 Vue 异步渲染拿空）；
 *   5. 缩放公式与验证版一字不改：factor = deltaY<0 ? 1.15 : 1/1.15，
 *      clamp(scale*factor, 0.1, 40)，以光标相对容器左上角为缩放中心。
 *
 * 兼容性兜底：wheel 除挂载 overlay 容器外，同时在 document 以 capture 阶段
 * 挂一份（opened 时才生效），防止外层滚动容器在冒泡路径上拦截 preventDefault。
 *
 * 用法：
 *   const viewer = createFullViewer({ tip: '滚轮缩放 · 左键拖拽 · 双击复位' });
 *   viewer.open('/path/image.png', '可选标题栏文案');
 *   viewer.close();
 */
let cssInjected = false;

const VIEWER_CSS = `
.zfv-overlay {
  position: fixed; inset: 0; z-index: 999999;
  overflow: hidden; background: rgba(6, 8, 13, 0.95);
  display: flex; align-items: center; justify-content: center;
  cursor: grab; touch-action: none; user-select: none;
}
.zfv-overlay.zfv-dragging { cursor: grabbing; }
.zfv-img {
  position: absolute; left: 0; top: 0; width: 100%; height: 100%;
  object-fit: contain; transform-origin: 0 0;
  pointer-events: none; -webkit-user-drag: none; user-drag: none;
  will-change: transform;
}
.zfv-tip {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
  padding: 6px 14px; border-radius: 16px; font-size: 12px;
  color: #8fa0b3; background: rgba(20, 24, 33, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.12);
  pointer-events: none; white-space: nowrap; z-index: 1;
}
.zfv-close {
  position: fixed; top: 16px; right: 16px; width: 40px; height: 40px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(20, 24, 33, 0.85); color: #eef2f9;
  border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 50%;
  font-size: 18px; cursor: pointer; z-index: 2;
}
.zfv-close:hover { background: #d64545; border-color: #d64545; }
.zfv-cap {
  position: fixed; top: 16px; left: 16px; max-width: calc(100vw - 80px);
  padding: 6px 14px; border-radius: 14px; font-size: 13px;
  color: #c7d2e0; background: rgba(20, 24, 33, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.12);
  pointer-events: none; z-index: 2;
}
`;

function ensureCss() {
  if (cssInjected) return;
  cssInjected = true;
  const style = document.createElement('style');
  style.textContent = VIEWER_CSS;
  document.head.appendChild(style);
}

/**
 * 创建全屏图片查看器实例。
 * @param {object} options
 * @param {string} [options.tip] 底部提示文案
 * @param {Function} [options.onClose] 关闭后的回调（可空）
 * @returns {{ open: Function, close: Function, isOpen: boolean }}
 */
export function createFullViewer(options = {}) {
  const tip = options.tip || '滚轮缩放 · 左键拖拽 · 双击复位 · 点击或 ✕ 退出';
  const onClose = typeof options.onClose === 'function' ? options.onClose : null;

  ensureCss();

  const overlay = document.createElement('div');
  overlay.className = 'zfv-overlay';
  overlay.style.display = 'none';

  const img = document.createElement('img');
  img.className = 'zfv-img';
  img.draggable = false;
  img.alt = '';

  const tipEl = document.createElement('div');
  tipEl.className = 'zfv-tip';
  tipEl.textContent = tip;

  const closeBtn = document.createElement('div');
  closeBtn.className = 'zfv-close';
  closeBtn.textContent = '✕';

  const capEl = document.createElement('div');
  capEl.className = 'zfv-cap';
  capEl.style.display = 'none';

  overlay.appendChild(img);
  overlay.appendChild(tipEl);
  overlay.appendChild(closeBtn);
  overlay.appendChild(capEl);
  document.body.appendChild(overlay);

  // 命令式状态：普通变量，不经过任何响应式系统
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let dragging = false;
  let moved = false;
  let sx = 0;
  let sy = 0;
  let stx = 0;
  let sty = 0;
  let opened = false;
  let lastClickAt = 0;

  function apply() {
    img.style.transform = `translate3d(${tx}px,${ty}px,0) scale(${scale})`;
  }

  function reset() {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  }

  // ---- 缩放：公式与 test_zoom.html 一字不改 ----
  function onWheel(e) {
    if (!opened) return;
    e.preventDefault();
    const r = overlay.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const my = e.clientY - r.top;
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    let ns = scale * f;
    if (ns < 0.1) ns = 0.1;
    if (ns > 40) ns = 40;
    const ratio = ns / scale;
    tx = mx - (mx - tx) * ratio;
    ty = my - (my - ty) * ratio;
    scale = ns;
    apply();
  }

  // ---- 拖动：左键 + pointer capture ----
  function onPointerDown(e) {
    if (!opened || e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    moved = false;
    overlay.classList.add('zfv-dragging');
    sx = e.clientX;
    sy = e.clientY;
    stx = tx;
    sty = ty;
    overlay.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!opened || !dragging) return;
    e.preventDefault();
    if (Math.abs(e.clientX - sx) > 3 || Math.abs(e.clientY - sy) > 3) moved = true;
    tx = stx + (e.clientX - sx);
    ty = sty + (e.clientY - sy);
    apply();
  }

  function onPointerUp(e) {
    if (!opened || !dragging) return;
    dragging = false;
    overlay.classList.remove('zfv-dragging');
    if (overlay.hasPointerCapture(e.pointerId)) {
      overlay.releasePointerCapture(e.pointerId);
    }
  }

  // ---- 单击关闭 / 双击复位（用 300ms 间隔区分双击，避免冲突） ----
  function onOverlayClick() {
    if (!opened) return;
    const now = Date.now();
    if (now - lastClickAt < 300) {
      // 双击的第一击：等待 dblclick 触发复位
      lastClickAt = now;
      return;
    }
    lastClickAt = now;
    if (moved) {
      // 拖动结束后的 click 不算点击
      moved = false;
      return;
    }
    close();
  }

  function onDblClick(e) {
    if (!opened) return;
    e.preventDefault();
    lastClickAt = 0;
    reset();
  }

  function onKeyDown(e) {
    if (!opened) return;
    if (e.key === 'Escape') close();
  }

  // document 级 capture 兜底：防外层滚动容器拦截 wheel；未打开时直接返回，无副作用
  function onDocWheel(e) {
    if (opened) onWheel(e);
  }

  function bind() {
    overlay.addEventListener('wheel', onWheel, { passive: false });
    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('pointercancel', onPointerUp);
    overlay.addEventListener('click', onOverlayClick);
    overlay.addEventListener('dblclick', onDblClick);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('wheel', onDocWheel, { passive: false, capture: true });
  }

  function unbind() {
    overlay.removeEventListener('wheel', onWheel, { passive: false });
    overlay.removeEventListener('pointerdown', onPointerDown);
    overlay.removeEventListener('pointermove', onPointerMove);
    overlay.removeEventListener('pointerup', onPointerUp);
    overlay.removeEventListener('pointercancel', onPointerUp);
    overlay.removeEventListener('click', onOverlayClick);
    overlay.removeEventListener('dblclick', onDblClick);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('wheel', onDocWheel, { capture: true });
  }

  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    close();
  });

  function open(url, caption) {
    if (!url) return;
    img.src = url;
    img.alt = '';
    if (caption) {
      capEl.textContent = caption;
      capEl.style.display = 'block';
    } else {
      capEl.textContent = '';
      capEl.style.display = 'none';
    }
    opened = true;
    dragging = false;
    moved = false;
    lastClickAt = 0;
    overlay.classList.remove('zfv-dragging');
    overlay.style.display = 'flex';
    reset();
    bind();
  }

  function close() {
    if (!opened) return;
    opened = false;
    unbind();
    overlay.style.display = 'none';
    img.removeAttribute('src');
    if (onClose) onClose();
  }

  return {
    open,
    close,
    get isOpen() {
      return opened;
    },
  };
}
