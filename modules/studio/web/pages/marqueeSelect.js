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
    // 启动框选的鼠标键：0=左键（图库）；2=右键（词库——左键长按在词库里是"把卡片拖成标签"，
    // 框选不能占用左键，否则与打标拖拽互相抢指针）
    button = 0,
    // 页面自己的选中类名：结算前用它在 DOM 上读"框选前的选中集"，Esc 取消时据此回滚
    selectedClass = 'sel',
    // 右键框选：拖动成立后浏览器会在松手时补发 contextmenu，不拦就会在框选结束瞬间弹出右键菜单
    maskContextMenu = false,
  } = options;


  let marqueeEl = null;
  let active = false;
  let startX = 0, startY = 0;
  let curX = 0, curY = 0;
  let startScrollTop = 0, startScrollLeft = 0;
  let scrollEl = null;
  let clipEl = null;
  let rafLoopId = 0;
  // 框选代际号：每次按下自增。异常中断（系统手势接管、页面切换、组件卸载）可能让上一次
  // 的 document 级监听器残留，其闭包里的坐标早已过期；靠代际号让陈旧会话的结算直接失效。
  let gen = 0;

  // ============ 调试日志（排查"框住三行只选中两行"） ============
  // 控制台前缀 [Marquee]，同时批量上报后端：log/wordbank_debug_YYYYMMDD.log
  // 关闭：控制台执行 window.__zhuleMarqueeLog = false
  // 打开：window.__zhuleMarqueeLog = true
  let _logBuf = [];
  const logOn = () => window.__zhuleMarqueeLog !== false;
  const flushLog = () => {
    if (!_logBuf.length) return;
    const lines = _logBuf.splice(0, _logBuf.length);
    try {
      fetch('/zhule_studio/api/debug_log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lines }),
      }).catch(() => {});
    } catch (e) { /* 日志失败不影响框选 */ }
  };
  const mqLog = (...args) => {
    if (!logOn()) return;
    const ts = new Date().toLocaleTimeString('zh-Hans-CN', { hour12: false })
      + '.' + String(Date.now() % 1000).padStart(3, '0');
    const line = '[Marquee] ' + ts + ' ' + args.map((a) => {
      if (a instanceof Error) return a.stack || String(a);
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
      return String(a);
    }).join(' | ');
    console.log(line);
    _logBuf.push(line);
  };

  // 右键框选的收尾守卫：Windows/Chrome 在右键松手时补发 contextmenu，
  // 此时本次拖拽已结算，但菜单会立刻盖在刚框好的卡片上。settle 成功时开一个很短的窗口，
  // 窗口内捕获阶段的 contextmenu 一律吞掉（stopPropagation 让卡片上的 @contextmenu 收不到）。
  let ctxGuardUntil = 0;
  const onCtxGuard = (ev) => {
    if (Date.now() < ctxGuardUntil) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('contextmenu', onCtxGuard, true);
  }

  // 最近一次命中框（内容坐标），供结算后统计每行命中情况
  let lastRect = null;
  // 原生拖拽拦截次数：若该值 > 0，说明确实有元素在被拖（旧版图片未禁拖时就是它掐断了指针序列）
  let dragBlocked = 0;

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
  // 命中容差（px）：卡片矩形向外膨胀后再与框做相交判断。
  // 严格相交（rt < b 且 rb > t）在以下情形会把整行判为未命中，与"视觉上框明明盖住了"相矛盾：
  //   1) 行间隙（gap 12px）正好被框的起止边压住 —— 起点/终点落在两张卡片之间时，两行都可能只"擦边"；
  //   2) 浮点子像素误差：getBoundingClientRect 与鼠标坐标都是小数，边缘重合时相减可能为 0 而非正数；
  //   3) 卡片 hover 的 translateY(-2px) 让矩形比布局位置偏移 2px。
  // 取 6px = 行间隙一半：贴着卡片边缘即算命中，又不会越过整条间隙误选邻行。
  const HIT_PAD = 6;

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
    // 命中框不做「可视区裁剪」（不取 getClipRect）。
    // clip 是给视觉框用的：它让选框不越出图片区、不盖住顶部导航，那是纯显示问题；
    // 但把它套到命中框上会带来功能回归 —— 拖动途中滚动过（滚轮/滚动条）时，
    // 起点所在内容早已滚出可视区，clip 会把框的起点直接抬到当前视口顶部，
    // 于是"从 A 拖到 B 划过的所有行"只剩松手时可见的那一小段被选中，
    // 表现为框了一大片、结果只选中最底下两行。
    // 因此命中框保持纯粹的内容坐标区间 [min(sx,ex), max(sy,ey)]：划过的都算命中。
    lastRect = { l, t, r, b, scrollTop: cur.top, scrollLeft: cur.left, clip: getClipRect() };
    c.querySelectorAll(selector).forEach((el) => {
      const rc = el.getBoundingClientRect();
      const k = getKey(el);
      // 卡片矩形转内容坐标后与命中框（同为内容坐标）比较
      const rl = rc.left + cur.left;
      const rt = rc.top + cur.top;
      const rr = rc.right + cur.left;
      const rb = rc.bottom + cur.top;
      const _hit = (rl - HIT_PAD) < r && (rr + HIT_PAD) > l
        && (rt - HIT_PAD) < b && (rb + HIT_PAD) > t;
      if (_hit) {
        if (k != null && k !== '') hits.add(k);
      }
    });
    return hits;
  }

  // 结算后统计"每一行被选中几张/共几张"，并给出该行与命中框的最近垂直间距。
  // gap > 0 表示该行整体落在框外 gap 像素处 —— 用来判断漏选到底是"只差几个像素没够到"
  // 还是"根本没框到"，二者修法完全不同。
  // 行聚类容差 10px：卡片 hover 有 translateY(-2px)，同一行的 top 会差 2px，精确分桶会拆行。
  function rowReport() {
    const c = getContainer ? getContainer() : null;
    if (!c) return [];
    const cur = readScroll();
    const items = [...c.querySelectorAll(selector)].map((el) => {
      const rc = el.getBoundingClientRect();
      return {
        el,
        t: rc.top + cur.top,
        b: rc.bottom + cur.top,
        l: rc.left + cur.left,
        r: rc.right + cur.left,
      };
    });
    items.sort((a, b) => a.t - b.t);
    const rows = [];
    for (const it of items) {
      let g = rows.find((x) => Math.abs(x.top - it.t) < 10);
      if (!g) { g = { top: it.t, items: [] }; rows.push(g); }
      g.items.push(it);
    }
    const R = lastRect;
    return rows.map((g, i) => {
      let hit = 0;
      let gap = 9999; // 该行与框在垂直方向的最近距离：<=0 表示有重叠
      for (const it of g.items) {
        const h = R && (it.l - HIT_PAD) < R.r && (it.r + HIT_PAD) > R.l
          && (it.t - HIT_PAD) < R.b && (it.b + HIT_PAD) > R.t;
        if (h) hit += 1;
        const d = R ? (R.b < it.t ? R.b - it.t : (it.b < R.t ? R.t - it.b : 0)) : 9999;
        if (d < gap) gap = d;
      }
      return {
        row: i,
        top: Math.round(g.top),
        hit: hit + '/' + g.items.length,
        sel: g.items.filter((x) => x.el.classList.contains('sel')).length,
        gap: Math.round(gap),
      };
    });
  }

  function destroy() {
    if (marqueeEl && marqueeEl.parentNode) marqueeEl.parentNode.removeChild(marqueeEl);
    marqueeEl = null;
  }

  function onPointerDown(e) {

    if (e.button !== button) { return; }
    if (isInteractive && isInteractive(e)) { return; }

    const gridEl = getContainer ? getContainer() : null;
    if (!gridEl) { return; }

    // 进入新一次框选：递增代际号让上一次可能残留的会话失效，并清掉残留选框与动画帧。
    const myGen = ++gen;
    active = false;
    if (rafLoopId) { cancelAnimationFrame(rafLoopId); rafLoopId = 0; }
    destroy();

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
    // 最后一次 pointermove 的坐标：与 pointerup 的真实坐标比对，
    // 差值大说明拖动途中丢帧（move 被节流/合并），正是"终点那一行整行判空"的元凶。
    let lastMoveX = startX;
    let lastMoveY = startY;

    mqLog('down', 'xy=' + Math.round(startX) + ',' + Math.round(startY),
      'target=' + (e.target ? e.target.tagName : '?')
        + (e.target && typeof e.target.className === 'string' && e.target.className ? '.' + e.target.className.trim().split(/\s+/)[0] : ''),
      'draggable=' + (e.target ? !!e.target.draggable : '?'),
      'scrollEl=' + (scrollEl ? (scrollEl === window ? 'window' : (scrollEl.className || scrollEl.tagName)) : 'none'),
      'scroll=' + startScrollTop + ',' + startScrollLeft,
      'gen=' + myGen);

    const onMove = (ev) => {
      if (myGen !== gen) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const dist = Math.hypot(dx, dy);
      if (!moved && dist < threshold) {
        return;
      }

      lastMoveX = ev.clientX;
      lastMoveY = ev.clientY;

      if (!moved) {
        moved = true;
        active = true;
        initialKeys = new Set();
        gridEl.querySelectorAll(selector).forEach((el) => {
          if (el.classList && el.classList.contains(selectedClass)) {
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

    // 阻止按下期间的原生 HTML5 拖拽（图片、链接、文本默认都可拖）。
    // 一旦浏览器把这次按下接管为原生 drag，指针序列会被 pointercancel 直接掐断：
    // pointerup 永远不会来，命中结算丢失、选框停在半路，表现正是"视觉上框盖住了三行、
    // 实际只选中其中两行"，且方向反过来时漏的是另一端那一行。
    // 只在网格内按下期间挂载：词库的标签 chip / tab 拖拽起点在网格之外，卡片是它们的 drop 目标，
    // 因此不会误伤既有的拖拽打标功能。
    const blockDrag = (ev) => {
      dragBlocked += 1;
      mqLog('dragstart 被拦截', 'tag=' + (ev.target ? ev.target.tagName : '?'),
        'draggable=' + (ev.target ? !!ev.target.draggable : '?'),
        'count=' + dragBlocked);
      ev.preventDefault();
    };

    // 结算：把当前命中写回选中态。
    // 必须在 clipEl 置空之前调用 —— getClipRect 依赖 clipEl 裁掉滚出可视区的部分。
    const settle = () => {
      if (myGen !== gen) return;
      if (!moved) return;
      // 拖动成立才开窗口：仅仅是"右键单击卡片"时 moved=false，右键菜单照常弹出
      if (maskContextMenu) ctxGuardUntil = Date.now() + 300;
      const hits = computeHits();
      if (logOn()) {
        const R = lastRect;
        mqLog('settle', 'cancelled=' + cancelled,
          'up=' + Math.round(curX) + ',' + Math.round(curY),
          'rect=' + (R ? [R.l, R.t, R.r, R.b].map((v) => Math.round(v)).join(',') : 'null'),
          'scroll=' + (R ? R.scrollTop + ',' + R.scrollLeft : '?')
            + '(start ' + startScrollTop + ',' + startScrollLeft + ')',
          'dragBlocked=' + dragBlocked,
          'hits=' + hits.size,
          'rows=' + JSON.stringify(rowReport()));
      }
      if (onUpdate) onUpdate(hits);
      // 回写后的核对打点：rowReport 里的 sel 是结算瞬间读的 DOM，
      // 此时 Vue 还没把 selected 渲染成 .sel 类，恒为 0，不能用来判断"到底选没选中"。
      // 这里延后一拍再数一次 .zhg-card.sel，才能区分「命中算错」和「命中对了但没写进选中态」。
      if (logOn()) {
        setTimeout(() => {
          const c2 = getContainer ? getContainer() : null;
          const domSel = c2 ? c2.querySelectorAll(selector + '.' + selectedClass).length : -1;
          mqLog('after', 'hits=' + hits.size, 'domSel=' + domSel);
          flushLog();
        }, 80);
      }
      if (onEnd) {
        onEnd({
          hitKeys: hits,
          moved: true,
          cancelled,
          initialKeys: initialKeys || new Set(),
        });
      }
      flushLog();
    };

    const detach = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onCancel);
      document.removeEventListener('dragstart', blockDrag, true);
      if (escCancel) document.removeEventListener('keydown', onKeydown);
      if (rafLoopId) { cancelAnimationFrame(rafLoopId); rafLoopId = 0; }
    };

    const teardown = () => {
      active = false;
      clipEl = null;
      destroy();
    };

    // 松手位置以 pointerup 的真实坐标为准。
    // 拖动途中 pointermove 会被节流/合并（快速甩动、高刷屏、主线程忙于重排），
    // 最后一次 move 的坐标可能落后于实际松手点若干像素，令框的下边界（或反向时的上边界）
    // 少算一段，终点所在那一行整行判空。
    const onUp = (ev) => {
      const rawX = ev ? ev.clientX : NaN;
      const rawY = ev ? ev.clientY : NaN;
      if (ev && Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY)
        && (ev.clientX || ev.clientY)) {
        curX = ev.clientX;
        curY = ev.clientY;
      }
      mqLog('up', 'raw=' + Math.round(rawX) + ',' + Math.round(rawY),
        'lastMove=' + Math.round(lastMoveX) + ',' + Math.round(lastMoveY),
        'moveGap=' + (Number.isFinite(rawX)
          ? Math.round(Math.hypot(rawX - lastMoveX, rawY - lastMoveY)) : 'NaN'));
      detach();
      settle();
      teardown();
    };

    // pointercancel 不再被忽略：系统手势或原生拖拽接管时浏览器会取消指针序列，
    // 旧实现只监听 pointerup，于是这次框选既不结算也不清理，选框残留在页面上、
    // 选中态停留在上一次的结果。此处按最后一次已知位置结算后统一回收。
    // cancel 事件的坐标常为 0,0 或不可靠值，故不采用事件坐标。
    const onCancel = () => {
      mqLog('pointercancel', '末次坐标=' + Math.round(curX) + ',' + Math.round(curY),
        'lastMove=' + Math.round(lastMoveX) + ',' + Math.round(lastMoveY),
        'moved=' + moved, 'dragBlocked=' + dragBlocked);
      detach();
      settle();
      teardown();
    };

    // Esc 取消本次框选：恢复按下前的选中集，并注销全部监听。
    // 旧实现只 destroy 选框而没解绑 pointermove/pointerup，残留的 onUp 会在用户
    // 后续任意一次松手时用陈旧坐标再结算一遍，越框越乱。
    const onKeydown = (ev) => {
      if (ev.key === 'Escape' && active) {
        cancelled = true;
        detach();
        if (moved && onEnd) {
          onEnd({
            hitKeys: new Set(),
            moved: true,
            cancelled: true,
            initialKeys: initialKeys || new Set(),
          });
        }
        teardown();
      }
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onCancel);
    document.addEventListener('dragstart', blockDrag, true);
    if (escCancel) document.addEventListener('keydown', onKeydown);
  }

  // 控制台手动导出：__zhuleMarqueeDump() 立刻打印当前行统计并上报后端。
  // 用于"框完发现漏了，但已经松手"的场景 —— 补救一次现场快照。
  if (typeof window !== 'undefined') {
    window.__zhuleMarqueeDump = () => {
      const R = lastRect;
      mqLog('dump', 'rect=' + (R ? [R.l, R.t, R.r, R.b].map((v) => Math.round(v)).join(',') : 'null'),
        'rows=' + JSON.stringify(rowReport()));
      flushLog();
    };
    window.__zhuleMarqueeLogFlush = flushLog;
  }

  return { onPointerDown };
}