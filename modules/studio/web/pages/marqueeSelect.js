// marqueeSelect.js — 带诊断日志的临时版本
export function useMarqueeSelect(options = {}) {
  const {
    getContainer = null,
    selector = '.zhg-card',
    getKey = (el) => el.getAttribute('data-key'),
    isInteractive = null,
    threshold = 5,
    onUpdate = null,
    onEnd = null,
    escCancel = true,
    marqueeClass = 'zhg-marquee',
  } = options;

  const LOG = (...args) => console.log('[MARQUEE]', ...args);

  let marqueeEl = null;
  let active = false;
  let startX = 0, startY = 0;
  let curX = 0, curY = 0;
  let startScrollTop = 0, startScrollLeft = 0;
  let scrollEl = null;
  let rafLoopId = 0;

  function findScrollEl(el) {
    if (!el || !el.parentElement) {
      LOG('findScrollEl: el 或 parentElement 为空，返回 window');
      return window;
    }
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      try {
        const s = getComputedStyle(p);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll')
          && p.scrollHeight > p.clientHeight + 1) {
          LOG('findScrollEl: 找到滚动容器', p.className, 'scrollTop=' + p.scrollTop);
          return p;
        }
      } catch (e) { }
      p = p.parentElement;
    }
    LOG('findScrollEl: 没找到滚动容器，返回 window');
    return window;
  }

  function readScroll() {
    if (!scrollEl || scrollEl === window) {
      return { top: window.scrollY || 0, left: window.scrollX || 0 };
    }
    return { top: scrollEl.scrollTop, left: scrollEl.scrollLeft };
  }

  function startViewport() {
    const cur = readScroll();
    return {
      x: startX - (cur.left - startScrollLeft),
      y: startY - (cur.top - startScrollTop),
    };
  }

  function draw() {
    if (!marqueeEl) return;
    const s = startViewport();
    marqueeEl.style.left = Math.min(s.x, curX) + 'px';
    marqueeEl.style.top = Math.min(s.y, curY) + 'px';
    marqueeEl.style.width = Math.abs(curX - s.x) + 'px';
    marqueeEl.style.height = Math.abs(curY - s.y) + 'px';
  }

  function loop() {
    if (!active) return;
    draw();
    rafLoopId = requestAnimationFrame(loop);
  }

  function computeHits() {
    const c = getContainer ? getContainer() : null;
    const hits = new Set();
    if (!c) return hits;
    const s = startViewport();
    const l = Math.min(s.x, curX);
    const t = Math.min(s.y, curY);
    const r = Math.max(s.x, curX);
    const b = Math.max(s.y, curY);
    c.querySelectorAll(selector).forEach((el) => {
      const rc = el.getBoundingClientRect();
      if (rc.left < r && rc.right > l && rc.top < b && rc.bottom > t) {
        const k = getKey(el);
        if (k != null && k !== '') hits.add(k);
      }
    });
    return hits;
  }

  function destroy() {
    if (marqueeEl && marqueeEl.parentNode) marqueeEl.parentNode.removeChild(marqueeEl);
    marqueeEl = null;
  }

  function onPointerDown(e) {
    LOG('=== pointerdown 触发 ===');
    LOG('button=' + e.button + ' (应该=0)');
    LOG('clientX=' + e.clientX + ' clientY=' + e.clientY);
    LOG('target=', e.target && e.target.className);
    LOG('target.closest(.zhg-card)=', !!(e.target && e.target.closest && e.target.closest('.zhg-card')));

    if (e.button !== 0) { LOG('✗ 不是左键，放弃'); return; }
    if (isInteractive && isInteractive(e)) { LOG('✗ 命中 isInteractive，放弃'); return; }

    const gridEl = getContainer ? getContainer() : null;
    LOG('gridEl 存在:', !!gridEl);
    if (!gridEl) { LOG('✗ gridEl 为空，放弃'); return; }
    LOG('gridEl.className:', gridEl.className);
    LOG('gridEl 内 .zhg-card 数:', gridEl.querySelectorAll(selector).length);
    LOG('gridEl.getBoundingClientRect:', gridEl.getBoundingClientRect().top, gridEl.getBoundingClientRect().left);

    startX = e.clientX;
    startY = e.clientY;
    curX = startX;
    curY = startY;

    scrollEl = findScrollEl(gridEl);
    const sc = readScroll();
    startScrollTop = sc.top;
    startScrollLeft = sc.left;
    LOG('起始滚动:', sc);

    let moved = false;
    let cancelled = false;
    let initialKeys = null;

    const onKeydown = (ev) => {
      if (ev.key === 'Escape' && active) {
        cancelled = true;
        active = false;
        destroy();
      }
    };

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const dist = Math.hypot(dx, dy);
      if (!moved && dist < threshold) {
        LOG('onMove: 距离=' + dist.toFixed(1) + ' < 阈值 ' + threshold + '，忽略');
        return;
      }

      if (!moved) {
        moved = true;
        active = true;
        LOG('✓ 进入拖拽模式，开始创建框');
        initialKeys = new Set();
        gridEl.querySelectorAll(selector).forEach((el) => {
          if (el.classList && el.classList.contains('sel')) {
            const k = getKey(el);
            if (k != null) initialKeys.add(k);
          }
        });
        marqueeEl = document.createElement('div');
        marqueeEl.className = marqueeClass;
        marqueeEl.style.position = 'fixed';
        marqueeEl.style.zIndex = '9999';
        marqueeEl.style.pointerEvents = 'none';
        document.body.appendChild(marqueeEl);
        LOG('✓ 框元素已 append 到 body，className=' + marqueeEl.className);
        draw();
        LOG('✓ 首次 draw 完成，style=', marqueeEl.style.cssText);
        rafLoopId = requestAnimationFrame(loop);
      }

      curX = ev.clientX;
      curY = ev.clientY;
      draw();
    };

    const onUp = () => {
      LOG('=== pointerup ===');
      LOG('moved=' + moved);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (escCancel) document.removeEventListener('keydown', onKeydown);
      if (rafLoopId) { cancelAnimationFrame(rafLoopId); rafLoopId = 0; }

      if (moved) {
        const hits = computeHits();
        LOG('✓ 命中卡片数:', hits.size, Array.from(hits).slice(0, 5));
        if (onUpdate) onUpdate(hits);
        if (onEnd) onEnd({
          hitKeys: hits,
          moved: true,
          cancelled,
          initialKeys: initialKeys || new Set(),
        });
      }
      active = false;
      destroy();
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    if (escCancel) document.addEventListener('keydown', onKeydown);
  }

  return { onPointerDown };
}