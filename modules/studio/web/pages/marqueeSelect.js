// marqueeSelect.js
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


  let marqueeEl = null;
  let active = false;
  let startX = 0, startY = 0;
  let curX = 0, curY = 0;
  let startScrollTop = 0, startScrollLeft = 0;
  let scrollEl = null;
  let clipEl = null;
  let rafLoopId = 0;

  // 视觉裁剪矩形（视口坐标）= 容器矩形 ∩ 滚动容器可视矩形。
  // 只裁到容器矩形不够：网格向上滚出视口后 container 的 top 变负，clamp 形同失效，
  // 选框会一路画到视口顶部盖住顶部导航（词库/图库 tab）、工具栏等未被遮挡的区域。
  // 因此必须再与滚动容器（.zhg-td-main 等）的可视矩形求交，保证选框永不越出图片区。
  function getClipRect() {
    const c = getContainer ? getContainer() : null;
    if (!c) return null;
    const cr = c.getBoundingClientRect();
    let l = cr.left, t = cr.top, r = cr.right, b = cr.bottom;
    if (clipEl && clipEl !== window) {
      const vr = clipEl.getBoundingClientRect();
      l = Math.max(l, vr.left);
      t = Math.max(t, vr.top);
      r = Math.min(r, vr.right);
      b = Math.min(b, vr.bottom);
    }
    if (r < l) r = l;
    if (b < t) b = t;
    return { left: l, top: t, right: r, bottom: b };
  }

  function findScrollEl(el) {
    if (!el || !el.parentElement) {
      return window;
    }
    let p = el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      try {
        const s = getComputedStyle(p);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll')
          && p.scrollHeight > p.clientHeight + 1) {
          return p;
        }
      } catch (e) { }
      p = p.parentElement;
    }
    return window;
  }

  function readScroll() {
    if (!scrollEl || scrollEl === window) {
      return { top: window.scrollY || 0, left: window.scrollX || 0 };
    }
    return { top: scrollEl.scrollTop, left: scrollEl.scrollLeft };
  }

  // 视觉框使用视口坐标系（position:fixed 挂 body）+ 滚动补偿：
  // 起点 = 按下时视口坐标减去滚动增量（滚动后仍钉在按下时的视口位置），终点 = 鼠标当前视口坐标。
  // 滚动时视觉框保持钉在起点/鼠标位置，不会随内容跑走（修复长按后滚动导致框错位、滚到底出现空白假区域）。
  // 框边界裁剪到「容器矩形 ∩ 滚动容器可视矩形」（getClipRect）；
  // 只裁容器矩形会在网格滚出视口（container.top 变负）时失效，框会一路画到视口顶部盖住导航。
  // 重叠部分另有 .zhg-td-filters / .zhg-toolbar（z-index 100）与 .navbar 兜底遮挡。
  // 该视口矩形与 computeHits 的容器内容矩形在数学上等价（都减去当前滚动偏移），视觉与命中保持一致。
  function draw() {
    if (!marqueeEl) return;
    const cur = readScroll();
    const vx0 = startX - (cur.left - startScrollLeft);
    const vy0 = startY - (cur.top - startScrollTop);
    let l = Math.min(vx0, curX);
    let t = Math.min(vy0, curY);
    let r = Math.max(vx0, curX);
    let b = Math.max(vy0, curY);
    const clip = getClipRect();
    if (clip) {
      l = Math.max(l, clip.left);
      t = Math.max(t, clip.top);
      r = Math.min(r, clip.right);
      b = Math.min(b, clip.bottom);
      if (r < l) r = l;
      if (b < t) b = t;
    }
    marqueeEl.style.left = l + 'px';
    marqueeEl.style.top = t + 'px';
    marqueeEl.style.width = (r - l) + 'px';
    marqueeEl.style.height = (b - t) + 'px';
  }

  function loop() {
    if (!active) return;
    draw();
    rafLoopId = requestAnimationFrame(loop);
  }

  // 命中判断统一使用内容坐标系：
  // - 命中框：起点内容坐标 = startX/startY + 按下时滚动偏移(startScroll*)，终点内容坐标 = curX/curY + 当前滚动(readScroll)。
  //   旧实现 startViewport()/endViewport() 对滚动量做相反方向的减法补偿，两者相减后滚动被抵消，
  //   命中框只剩鼠标位移大小；且命中框是内容坐标、却与 getBoundingClientRect() 的视口坐标矩形比较，坐标系不统一，
  //   导致拖动过程中滚动过的区域全部选不中。
  // - 卡片矩形：getBoundingClientRect() 返回视口坐标，统一加上当前滚动偏移转换为内容坐标后再比较。
  // - draw() 视觉框仍用视口投影坐标（内容坐标 - 当前滚动），与命中框（内容坐标）数学等价：
  //   视觉框视口范围 + 当前滚动 = 命中框内容范围，因此视觉与实际命中保持一致。
  function computeHits() {
    const c = getContainer ? getContainer() : null;
    const hits = new Set();
    if (!c) return hits;
    const cur = readScroll();
    const sx = startX + startScrollLeft;
    const sy = startY + startScrollTop;
    const ex = curX + cur.left;
    const ey = curY + cur.top;
    let l = Math.min(sx, ex);
    let t = Math.min(sy, ey);
    let r = Math.max(sx, ex);
    let b = Math.max(sy, ey);
    const _clip = getClipRect();
    if (_clip) {
      const cl = _clip.left + cur.left;
      const ct = _clip.top + cur.top;
      const crr = _clip.right + cur.left;
      const cbb = _clip.bottom + cur.top;
      l = Math.max(l, cl);
      t = Math.max(t, ct);
      r = Math.min(r, crr);
      b = Math.min(b, cbb);
      if (r < l) r = l;
      if (b < t) b = t;
    }
    c.querySelectorAll(selector).forEach((el) => {
      const rc = el.getBoundingClientRect();
      const k = getKey(el);
      // 卡片矩形转内容坐标后与命中框（同为内容坐标）比较
      const rl = rc.left + cur.left;
      const rt = rc.top + cur.top;
      const rr = rc.right + cur.left;
      const rb = rc.bottom + cur.top;
      const _hit = rl < r && rr > l && rt < b && rb > t;
      if (_hit) {
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

    if (e.button !== 0) { return; }
    if (isInteractive && isInteractive(e)) { return; }

    const gridEl = getContainer ? getContainer() : null;
    if (!gridEl) { return; }

    startX = e.clientX;
    startY = e.clientY;
    curX = startX;
    curY = startY;

    scrollEl = findScrollEl(gridEl);
    clipEl = (scrollEl && scrollEl !== window) ? scrollEl : null;
    const sc = readScroll();
    startScrollTop = sc.top;
    startScrollLeft = sc.left;

    let moved = false;
    let cancelled = false;
    let initialKeys = null;

    const onKeydown = (ev) => {
      if (ev.key === 'Escape' && active) {
        cancelled = true;
        active = false;
        clipEl = null;
        destroy();
      }
    };

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const dist = Math.hypot(dx, dy);
      if (!moved && dist < threshold) {
        return;
      }

      if (!moved) {
        moved = true;
        active = true;
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
        marqueeEl.style.zIndex = '50';
        marqueeEl.style.pointerEvents = 'none';
        // 挂在 body 上使用视口坐标：滚动时靠滚动补偿钉住起点位置，不随内容移动
        document.body.appendChild(marqueeEl);
        draw();
        rafLoopId = requestAnimationFrame(loop);
      }

      curX = ev.clientX;
      curY = ev.clientY;
      draw();
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (escCancel) document.removeEventListener('keydown', onKeydown);
      if (rafLoopId) { cancelAnimationFrame(rafLoopId); rafLoopId = 0; }

      if (moved) {
        const hits = computeHits();
        if (onUpdate) onUpdate(hits);
        if (onEnd) onEnd({
          hitKeys: hits,
          moved: true,
          cancelled,
          initialKeys: initialKeys || new Set(),
        });
      }
      active = false;
      clipEl = null;
      destroy();
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    if (escCancel) document.addEventListener('keydown', onKeydown);
  }

  return { onPointerDown };
}