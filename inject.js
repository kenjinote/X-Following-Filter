(() => {
  if (window.__X_FOLLOWING_FILTER_INJECTED__) return;
  window.__X_FOLLOWING_FILTER_INJECTED__ = true;

  // /i/api/graphql/<queryId>/Following のみを厳密に判定
  function isFollowingGraphQL(url) {
    if (!url) return false;
    const str =
      typeof url === 'string'
        ? url
        : url instanceof URL
          ? url.href
          : url.url || String(url);
    return /\/graphql\/[^/?#]+\/Following(?:[/?#]|$)/.test(str);
  }

  // 直列スロットリング・セッション状態管理
  let nextAllowedTime = 0;
  let lastKeptCount = 10;
  let interceptedCount = 0;
  let totalRemovedUsers = 0;
  let totalKeptUsers = 0;
  let activeAnchorIds = [];
  let reachedEnd = false;
  let rateLimited = false;
  let rateLimitResetAt = 0;
  let wasOnFollowing = /^\/[^/]+\/following\/?$/.test(location.pathname);

  function publishStats(batchKept = -1) {
    if (document.documentElement) {
      document.documentElement.setAttribute(
        'data-xff-stats',
        JSON.stringify({
          kept: totalKeptUsers,
          removed: totalRemovedUsers,
          batchKept,
          reachedEnd,
          rateLimited,
          rateLimitResetAt,
          ts: Date.now()
        })
      );
    }
    window.dispatchEvent(new Event('xff-progress'));
  }

  function resetSessionStats() {
    totalRemovedUsers = 0;
    totalKeptUsers = 0;
    lastKeptCount = 10;
    activeAnchorIds = [];
    reachedEnd = false;
    rateLimited = false;
    rateLimitResetAt = 0;
    document.documentElement?.removeAttribute('data-xff-stats');
  }

  function reserveSlotDelay() {
    const now = Date.now();
    const scheduled = Math.max(now, nextAllowedTime);
    const interval = lastKeptCount === 0 ? 650 : lastKeptCount < 4 ? 350 : 150;
    nextAllowedTime = scheduled + interval;
    return scheduled - now;
  }

  function extractUser(entry) {
    const raw = entry?.content?.itemContent?.user_results?.result;
    if (!raw || typeof raw !== 'object') return null;
    if (raw.__typename === 'UserWithVisibilityResults' && raw.user) {
      return raw.user;
    }
    return raw;
  }

  // 凍結・削除済み（UserUnavailable）等の画面に描画されないゴースト要素を判定
  function isUnavailableUser(entry) {
    const raw = entry?.content?.itemContent?.user_results?.result;
    if (!raw || typeof raw !== 'object') return true;
    if (raw.__typename === 'UserUnavailable') return true;
    const user = extractUser(entry);
    if (!user || user.__typename === 'UserUnavailable') return true;
    if (!user.legacy && !user.core) return true;
    return false;
  }

  function isCursorEntry(entry) {
    const entryId = entry?.entryId || '';
    if (entryId.startsWith('cursor-')) return true;
    const entryType = entry?.content?.entryType || entry?.content?.__typename;
    return entryType === 'TimelineTimelineCursor';
  }

  function isBottomCursorEntry(entry) {
    const entryId = entry?.entryId || '';
    if (entryId.startsWith('cursor-bottom-')) return true;
    return entry?.content?.cursorType === 'Bottom';
  }

  function isExtraModuleEntry(entry) {
    const entryId = entry?.entryId || '';
    return entryId.startsWith('who-to-follow-') || entryId.startsWith('promoted-');
  }

  // 相手からフォローされている（相互フォロー）かどうかを判定
  function isMutualFollow(entry) {
    const user = extractUser(entry);
    if (!user) return false;

    if (
      user.relationship_perspectives?.followed_by === true ||
      user.legacy?.followed_by === true
    ) {
      return true;
    }

    if (
      typeof user.relationship_perspectives?.followed_by === 'boolean' ||
      typeof user.legacy?.followed_by === 'boolean'
    ) {
      return false;
    }

    return /"followed_by"\s*:\s*true/.test(JSON.stringify(user));
  }

  // instructions 配列だけを浅く高速に探索
  function findInstructionArrays(obj, out = [], depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 8) return out;
    if (Array.isArray(obj.instructions)) {
      out.push(obj.instructions);
      return out;
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        findInstructionArrays(obj[i], out, depth + 1);
      }
    } else {
      const keys = Object.keys(obj);
      for (let i = 0; i < keys.length; i++) {
        findInstructionArrays(obj[keys[i]], out, depth + 1);
      }
    }
    return out;
  }

  function processFollowingPayload(data) {
    const instructionLists = findInstructionArrays(data);

    // GraphQL エラー応答（レート制限 code:88 等）で instructions が無い場合
    if (instructionLists.length === 0 && Array.isArray(data?.errors) && data.errors.length > 0) {
      rateLimited = true;
      rateLimitResetAt = Date.now() + 5 * 60 * 1000;
      publishStats(-1);
      return { modified: false, removedInBatch: 0, keptInBatch: 0 };
    }

    rateLimited = false;
    rateLimitResetAt = 0;
    let modified = false;
    let removedInBatch = 0;
    let keptInBatch = 0;
    let rawUserCount = 0;
    let bottomCursorVal = null;
    let terminatedBottom = false;

    for (let l = 0; l < instructionLists.length; l++) {
      const instructions = instructionLists[l];
      const idsToEvict = [];

      for (let i = 0; i < instructions.length; i++) {
        const inst = instructions[i];
        const instType = inst?.type || inst?.__typename;

        if (instType === 'TimelineTerminateTimeline' && inst?.direction === 'Bottom') {
          terminatedBottom = true;
        }

        if (instType === 'TimelineAddEntries' && Array.isArray(inst.entries)) {
          let firstMutualAnchor = null;
          let batchUserKept = 0;

          const filtered = inst.entries.filter(entry => {
            if (isCursorEntry(entry)) {
              if (isBottomCursorEntry(entry)) {
                bottomCursorVal = entry?.content?.value ?? null;
              }
              return true;
            }

            if (isExtraModuleEntry(entry)) {
              modified = true;
              return false;
            }

            rawUserCount++;

            // 凍結・削除済みアカウントは画面に描画されないため除外し、片思い件数にも含めない
            if (isUnavailableUser(entry)) {
              modified = true;
              return false;
            }

            if (isMutualFollow(entry)) {
              if (!firstMutualAnchor) {
                firstMutualAnchor = entry;
              }
              modified = true;
              removedInBatch++;
              return false;
            }

            batchUserKept++;
            keptInBatch++;
            return true;
          });

          // X 側の2つの内部制限を同時に回避するアンカー管理:
          // 1) 同一 entryId を返し続けると「新規追加 0件が5回連続（100人）」で X が自動取得を停止する
          // 2) 新規アンカーを増やし続けると「先頭40枠上限（800人）」で VirtualScroller が埋まり停止する
          // → 毎回「新しい entryId」のアンカーを1件追加しつつ、アンカーが15件溜まるごとに古い12件を
          //   X 純正の TimelineRemoveEntries 命令で正規アンマウント（メモリ解放）させます。
          if (batchUserKept === 0 && firstMutualAnchor) {
            if (activeAnchorIds.length >= 15) {
              if (totalKeptUsers === 0) {
                // まだ片思いユーザーが0件の間は TimelineClearCache で確実に全アンカーを一掃可能
                idsToEvict.push(...activeAnchorIds.splice(0, activeAnchorIds.length));
              } else {
                idsToEvict.push(...activeAnchorIds.splice(0, 12));
              }
            }
            if (firstMutualAnchor.entryId) {
              activeAnchorIds.push(firstMutualAnchor.entryId);
            }

            const cursorIdx = filtered.findIndex(isCursorEntry);
            if (cursorIdx >= 0) {
              filtered.splice(cursorIdx, 0, firstMutualAnchor);
            } else {
              filtered.unshift(firstMutualAnchor);
            }
          } else if (batchUserKept > 0 && activeAnchorIds.length >= 10) {
            idsToEvict.push(...activeAnchorIds.splice(0, activeAnchorIds.length - 2));
          }

          inst.entries = filtered;
        }
      }

      if (idsToEvict.length > 0) {
        modified = true;
        instructions.unshift({
          type: 'TimelineRemoveEntries',
          __typename: 'TimelineRemoveEntries',
          entryIds: idsToEvict,
          entry_ids: idsToEvict
        });
        // 片思いユーザーがまだ表示されていない段階では、/Following 純正の TimelineClearCache も併用して確実にリセット
        if (totalKeptUsers === 0 && keptInBatch === 0) {
          instructions.unshift({
            type: 'TimelineClearCache',
            __typename: 'TimelineClearCache'
          });
        }
      }
    }

    if (
      terminatedBottom ||
      (instructionLists.length > 0 && rawUserCount === 0) ||
      (typeof bottomCursorVal === 'string' && bottomCursorVal.startsWith('0|'))
    ) {
      reachedEnd = true;
    }

    lastKeptCount = keptInBatch;
    if (keptInBatch === 0 && !reachedEnd) {
      nextAllowedTime = Math.max(nextAllowedTime, Date.now() + 650);
    }

    totalRemovedUsers += removedInBatch;
    totalKeptUsers += keptInBatch;
    interceptedCount++;

    if (interceptedCount % 15 === 0 && typeof performance?.clearResourceTimings === 'function') {
      performance.clearResourceTimings();
    }

    publishStats(keptInBatch);

    return { modified, removedInBatch, keptInBatch };
  }

  function handleRateLimitHeader(resetHeaderVal) {
    const sec = Number(resetHeaderVal);
    rateLimitResetAt =
      sec && Number.isFinite(sec) ? sec * 1000 + 3000 : Date.now() + 5 * 60 * 1000;
    rateLimited = true;
    publishStats(-1);
  }

  // MAIN world で SPA の URL 遷移を検知して content.js 側へ通知
  function notifyRouteChange() {
    const nowOnFollowing = /^\/[^/]+\/following\/?$/.test(location.pathname);
    if (wasOnFollowing && !nowOnFollowing) {
      resetSessionStats();
    }
    wasOnFollowing = nowOnFollowing;
    window.dispatchEvent(new Event('xff-locationchange'));
  }

  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState = function (...args) {
    const ret = origPushState.apply(this, args);
    notifyRouteChange();
    return ret;
  };
  history.replaceState = function (...args) {
    const ret = origReplaceState.apply(this, args);
    notifyRouteChange();
    return ret;
  };
  window.addEventListener('popstate', notifyRouteChange);

  /* =========================================================
   * 1. XMLHttpRequest フック（X Web版のメイン通信経路）
   * ========================================================= */
  const XHRProto = XMLHttpRequest.prototype;
  const origOpen = XHRProto.open;
  const origSend = XHRProto.send;
  const origAbort = XHRProto.abort;
  const nativeResponseTextGetter = Object.getOwnPropertyDescriptor(XHRProto, 'responseText')?.get;
  const nativeResponseGetter = Object.getOwnPropertyDescriptor(XHRProto, 'response')?.get;

  function installLazyResponseFilter(xhr) {
    let processed = false;

    xhr.addEventListener('loadend', () => {
      if (xhr.status === 429) {
        handleRateLimitHeader(xhr.getResponseHeader('x-rate-limit-reset'));
      }
    });

    function processIfReady() {
      if (processed || xhr.readyState !== 4) {
        return false;
      }
      if (xhr.status === 429) {
        processed = true;
        handleRateLimitHeader(xhr.getResponseHeader('x-rate-limit-reset'));
        return false;
      }
      if (xhr.status !== 200) {
        return false;
      }
      processed = true;

      try {
        const respType = xhr.responseType;
        if (respType === '' || respType === 'text') {
          const rawText = nativeResponseTextGetter.call(xhr);
          if (!rawText) return false;
          const data = JSON.parse(rawText);
          const { modified } = processFollowingPayload(data);
          const finalText = modified ? JSON.stringify(data) : rawText;

          Object.defineProperty(xhr, 'responseText', {
            value: finalText,
            writable: false,
            configurable: true
          });
          Object.defineProperty(xhr, 'response', {
            value: finalText,
            writable: false,
            configurable: true
          });
          return true;
        } else if (respType === 'json') {
          const rawJson = nativeResponseGetter.call(xhr);
          if (!rawJson || typeof rawJson !== 'object') return false;
          processFollowingPayload(rawJson);
          Object.defineProperty(xhr, 'response', {
            value: rawJson,
            writable: false,
            configurable: true
          });
          return true;
        }
      } catch (err) {
        console.error('[X-Following-Filter] XHR filter error:', err);
        delete xhr.responseText;
        delete xhr.response;
      }
      return false;
    }

    Object.defineProperty(xhr, 'responseText', {
      get() {
        if (processIfReady() && Object.prototype.hasOwnProperty.call(xhr, 'responseText')) {
          return xhr.responseText;
        }
        return nativeResponseTextGetter.call(xhr);
      },
      configurable: true
    });

    Object.defineProperty(xhr, 'response', {
      get() {
        if (processIfReady() && Object.prototype.hasOwnProperty.call(xhr, 'response')) {
          return xhr.response;
        }
        return nativeResponseGetter.call(xhr);
      },
      configurable: true
    });
  }

  XHRProto.open = function (method, url, asyncArg) {
    if (Object.prototype.hasOwnProperty.call(this, 'responseText')) {
      delete this.responseText;
    }
    if (Object.prototype.hasOwnProperty.call(this, 'response')) {
      delete this.response;
    }
    if (this._xffTimer) {
      clearTimeout(this._xffTimer);
      this._xffTimer = null;
    }

    this._xffFollowing = isFollowingGraphQL(url);
    this._xffAsync = asyncArg !== false;
    this._xffAborted = false;

    if (this._xffFollowing && nativeResponseTextGetter && nativeResponseGetter) {
      installLazyResponseFilter(this);
    }

    return origOpen.apply(this, arguments);
  };

  XHRProto.send = function (...args) {
    if (this._xffFollowing && this._xffAsync !== false) {
      const waitMs = reserveSlotDelay();
      if (waitMs > 0) {
        this._xffTimer = setTimeout(() => {
          this._xffTimer = null;
          if (!this._xffAborted) {
            origSend.apply(this, args);
          }
        }, waitMs);
        return;
      }
    }
    return origSend.apply(this, args);
  };

  XHRProto.abort = function (...args) {
    this._xffAborted = true;
    if (this._xffTimer) {
      clearTimeout(this._xffTimer);
      this._xffTimer = null;
    }
    return origAbort.apply(this, args);
  };

  /* =========================================================
   * 2. window.fetch フック（フォールバック対応）
   * ========================================================= */
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (...args) {
      if (!isFollowingGraphQL(args[0])) {
        return origFetch.apply(this, args);
      }

      const waitMs = reserveSlotDelay();
      if (waitMs > 0) {
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }

      const response = await origFetch.apply(this, args);
      if (!response) return response;

      if (response.status === 429) {
        handleRateLimitHeader(response.headers?.get('x-rate-limit-reset'));
        return response;
      }
      if (response.status !== 200) {
        return response;
      }

      let rawText;
      try {
        rawText = await response.text();
      } catch {
        return response;
      }

      const newHeaders = new Headers(response.headers);
      newHeaders.delete('content-encoding');
      newHeaders.delete('content-length');

      try {
        const data = JSON.parse(rawText);
        const { modified } = processFollowingPayload(data);
        const finalBody = modified ? JSON.stringify(data) : rawText;

        return new Response(finalBody, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      } catch (err) {
        console.error('[X-Following-Filter] fetch filter error:', err);
        return new Response(rawText, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      }
    };
  }
})();
