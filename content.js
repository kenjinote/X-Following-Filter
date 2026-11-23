(() => {
  let observer = null;
  let checkTimeout = null;
  let pumpInterval = null;
  let statusBadge = null;
  let anchorStyleEl = null;
  let paused = false;
  let lastStats = {
    removed: 0,
    kept: 0,
    batchKept: -1,
    reachedEnd: false,
    rateLimited: false,
    rateLimitResetAt: 0,
    ts: 0
  };

  function isFollowingPage() {
    return /^\/[^/]+\/following\/?$/.test(location.pathname);
  }

  function ensureAnchorStyle() {
    if (anchorStyleEl) return;
    const root = document.head || document.documentElement;
    if (!root) return;
    anchorStyleEl = document.createElement('style');
    anchorStyleEl.id = 'xff-anchor-style';
    anchorStyleEl.textContent = `
      [data-testid="primaryColumn"] [data-testid="cellInnerDiv"]:has([data-testid="userFollowIndicator"]) {
        opacity: 0 !important;
        pointer-events: none !important;
        overflow: hidden !important;
      }
    `;
    root.appendChild(anchorStyleEl);
  }

  function removeAnchorStyle() {
    if (anchorStyleEl) {
      anchorStyleEl.remove();
      anchorStyleEl = null;
    }
  }

  function formatResetTime(ms) {
    if (!ms) return '数分後';
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}頃`;
  }

  function ensureBadge() {
    if (statusBadge || !document.body) return statusBadge;
    statusBadge = document.createElement('div');
    statusBadge.id = 'xff-status-badge';
    Object.assign(statusBadge.style, {
      position: 'fixed',
      top: '12px',
      right: '16px',
      zIndex: '2147483647',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '7px 14px',
      borderRadius: '9999px',
      backgroundColor: 'rgba(15, 20, 25, 0.92)',
      color: '#e7e9ea',
      fontSize: '12px',
      fontWeight: '600',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      boxShadow: '0 3px 12px rgba(0, 0, 0, 0.45)',
      border: '1px solid rgba(29, 155, 240, 0.5)'
    });

    const textSpan = document.createElement('span');
    textSpan.id = 'xff-status-text';
    statusBadge.appendChild(textSpan);

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    Object.assign(toggleBtn.style, {
      padding: '2px 8px',
      borderRadius: '9999px',
      border: '1px solid rgba(255, 255, 255, 0.25)',
      backgroundColor: 'rgba(255, 255, 255, 0.1)',
      color: '#ffffff',
      fontSize: '11px',
      cursor: 'pointer'
    });
    toggleBtn.textContent = '一時停止';
    toggleBtn.addEventListener('click', () => {
      paused = !paused;
      toggleBtn.textContent = paused ? '再開' : '一時停止';
      updateBadge();
    });
    statusBadge.appendChild(toggleBtn);

    document.body.appendChild(statusBadge);
    return statusBadge;
  }

  function updateBadge() {
    if (!isFollowingPage()) {
      removeBadge();
      return;
    }
    const badge = ensureBadge();
    if (!badge) return;
    const textSpan = badge.querySelector('#xff-status-text');
    if (!textSpan) return;

    const { kept, removed, reachedEnd, rateLimited, rateLimitResetAt } = lastStats;

    if (rateLimited && Date.now() < rateLimitResetAt) {
      const timeStr = formatResetTime(rateLimitResetAt);
      textSpan.textContent = `⏳ XのAPI取得制限(429) ${timeStr}に自動再開 — 片思い: ${kept}件 / 除外: ${removed}件`;
    } else if (reachedEnd) {
      textSpan.textContent = `✅ 全件完了 — 片思い: ${kept}件 / 相互除外: ${removed}件`;
    } else if (paused) {
      textSpan.textContent = `⏸ 一時停止中 — 片思い: ${kept}件 / 相互除外: ${removed}件`;
    } else if (removed === 0 && kept === 0) {
      textSpan.textContent = '🔍 片思いフィルター待機中...';
    } else if (kept === 0) {
      textSpan.textContent = `🔍 片思い検索中... (相互除外済: ${removed}件)`;
    } else {
      textSpan.textContent = `🔍 片思い表示: ${kept}件 / 相互除外済: ${removed}件`;
    }
  }

  function removeBadge() {
    if (statusBadge) {
      statusBadge.remove();
      statusBadge = null;
    }
  }

  function shrinkAnchorCell(cell) {
    if (cell.dataset.xffShrunk === '1') return;
    cell.dataset.xffShrunk = '1';
    cell.style.height = '1px';
    cell.style.minHeight = '1px';
    cell.style.maxHeight = '1px';
    cell.style.overflow = 'hidden';
    const inner = cell.firstElementChild;
    if (inner) {
      inner.style.height = '1px';
      inner.style.minHeight = '0px';
      inner.style.maxHeight = '1px';
      inner.style.overflow = 'hidden';
    }
  }

  function restoreCellIfShrunk(cell) {
    if (cell.dataset.xffShrunk !== '1') return;
    delete cell.dataset.xffShrunk;
    cell.style.height = '';
    cell.style.minHeight = '';
    cell.style.maxHeight = '';
    cell.style.overflow = '';
    const inner = cell.firstElementChild;
    if (inner) {
      inner.style.height = '';
      inner.style.minHeight = '';
      inner.style.maxHeight = '';
      inner.style.overflow = '';
    }
  }

  function countVisibleOneWayCells(primaryColumn) {
    const cells = primaryColumn.querySelectorAll('[data-testid="cellInnerDiv"]');
    let visibleOneWayCount = 0;

    for (let i = 0, len = cells.length; i < len; i++) {
      const cell = cells[i];

      if (cell.dataset.xffHidden === '1') {
        continue;
      }

      // ページネーション維持用の相互フォローアンカーはマウント後に 1px へ縮小
      if (cell.querySelector('[data-testid="userFollowIndicator"]')) {
        shrinkAnchorCell(cell);
        continue;
      }

      // 万が一 DOM 再利用が発生していた場合は元の高さに復元
      restoreCellIfShrunk(cell);

      if (!cell.querySelector('[data-testid="UserCell"]')) {
        continue;
      }

      const buttons = cell.querySelectorAll('button, [role="button"]');
      let isUnfollowed = false;

      for (let b = 0, bLen = buttons.length; b < bLen; b++) {
        const btnText = (buttons[b].textContent || '').trim();
        if (btnText === 'フォロー' || btnText === 'Follow') {
          isUnfollowed = true;
          break;
        }
      }

      if (isUnfollowed) {
        cell.dataset.xffHidden = '1';
        cell.style.display = 'none';
        continue;
      }

      visibleOneWayCount++;
    }

    return visibleOneWayCount;
  }

  function scheduleCheck() {
    if (checkTimeout) return;
    checkTimeout = setTimeout(() => {
      checkTimeout = null;
      if (!isFollowingPage()) return;
      const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
      if (primaryColumn) {
        countVisibleOneWayCells(primaryColumn);
      }
    }, 80);
  }

  function runPaginationPump() {
    if (!isFollowingPage() || paused || lastStats.reachedEnd) {
      const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
      if (primaryColumn && primaryColumn.style.minHeight) {
        primaryColumn.style.minHeight = '';
      }
      return;
    }

    // X の API レート制限中はリセット時刻まで待機し、時刻を過ぎたら自動再開する
    if (lastStats.rateLimited) {
      if (Date.now() < lastStats.rateLimitResetAt) {
        updateBadge();
        return;
      }
      lastStats.rateLimited = false;
      updateBadge();
    }

    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    if (!primaryColumn) return;

    // レート制限解除後などに X の「やり直す / Retry」ボタンが出ていれば自動で押して再開
    const retryButtons = primaryColumn.querySelectorAll('button, [role="button"]');
    for (let i = 0; i < retryButtons.length; i++) {
      const txt = (retryButtons[i].textContent || '').trim();
      if (txt === 'やり直す' || txt === 'Retry' || txt === '再試行') {
        retryButtons[i].click();
        return;
      }
    }

    const visibleOneWay = countVisibleOneWayCells(primaryColumn);
    const nearBottom =
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 350;

    const needsMoreToFillScreen = visibleOneWay < 10;
    const emptyBatchNearBottom = nearBottom && lastStats.batchKept === 0;

    if (!needsMoreToFillScreen && !emptyBatchNearBottom) {
      if (primaryColumn.style.minHeight) {
        primaryColumn.style.minHeight = '';
      }
      return;
    }

    const minNeeded = `${window.innerHeight + 300}px`;
    if (primaryColumn.style.minHeight !== minNeeded) {
      primaryColumn.style.minHeight = minNeeded;
    }

    const baseY = window.scrollY;
    window.scrollTo(0, baseY + 60);
    window.dispatchEvent(new Event('resize'));
    setTimeout(() => {
      if (isFollowingPage()) {
        window.scrollTo(0, baseY);
      }
    }, 100);
  }

  function readStatsFromDom() {
    const raw = document.documentElement?.getAttribute('data-xff-stats');
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      lastStats = {
        kept: parsed.kept || 0,
        removed: parsed.removed || 0,
        batchKept: typeof parsed.batchKept === 'number' ? parsed.batchKept : -1,
        reachedEnd: Boolean(parsed.reachedEnd),
        rateLimited: Boolean(parsed.rateLimited),
        rateLimitResetAt: parsed.rateLimitResetAt || 0,
        ts: parsed.ts || 0
      };
    } catch {
      // ignore
    }
  }

  function cleanupPageEffects() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (checkTimeout) {
      clearTimeout(checkTimeout);
      checkTimeout = null;
    }
    if (pumpInterval) {
      clearInterval(pumpInterval);
      pumpInterval = null;
    }
    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    if (primaryColumn && primaryColumn.style.minHeight) {
      primaryColumn.style.minHeight = '';
    }
    removeAnchorStyle();
    removeBadge();
  }

  function manageObserver() {
    if (!document.body) return;

    if (isFollowingPage()) {
      ensureAnchorStyle();
      readStatsFromDom();
      updateBadge();

      if (!observer) {
        observer = new MutationObserver(scheduleCheck);
        observer.observe(document.body, { childList: true, subtree: true });
        scheduleCheck();
      }
      if (!pumpInterval) {
        pumpInterval = setInterval(runPaginationPump, 800);
      }
    } else {
      paused = false;
      lastStats = {
        removed: 0,
        kept: 0,
        batchKept: -1,
        reachedEnd: false,
        rateLimited: false,
        rateLimitResetAt: 0,
        ts: 0
      };
      cleanupPageEffects();
    }
  }

  window.addEventListener('xff-progress', () => {
    readStatsFromDom();
    updateBadge();
    scheduleCheck();
  });

  window.addEventListener('xff-locationchange', () => {
    setTimeout(manageObserver, 100);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', manageObserver);
  } else {
    manageObserver();
  }
})();
