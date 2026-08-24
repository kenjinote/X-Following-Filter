// 非表示にしたいキーワードをここに列挙
const keywords = ["フォローされています"];
let observer = null; // グローバルでオブザーバーを管理

// /<id>/following だけを許可（末尾スラッシュも可）
function isFollowingPage() {
  return /^\/[^/]+\/following\/?$/.test(location.pathname);
}

// 実際に要素を隠す処理
function hideElements() {
  // まだチェックしていない要素だけを取得する（data-scanned属性を活用）
  const containers = document.querySelectorAll("div[data-testid='cellInnerDiv']:not([data-scanned='true'])");
  
  // 高速化のため、forEachやsomeではなくforループを使用
  for (let i = 0, len = containers.length; i < len; i++) {
    const container = containers[i];
    
    // 処理済みマークをつける（次回以降のquerySelectorAllから除外される）
    container.setAttribute("data-scanned", "true");

    // .innerTextではなく、圧倒的に軽い.textContentを使用（trim処理も省略して高速化）
    const text = container.textContent || "";
    
    for (let j = 0, kLen = keywords.length; j < kLen; j++) {
      if (text.includes(keywords[j])) {
        // メモリが増大しないように該当タグを完全に削除
        container.remove();
        break;
      }
    }
  }
}

/* ------- 防御的な仕組み（SPA対応 / 過負荷防止） ------- */

// 単発の多重実行を抑えるデバウンス
let hideTimeout = null;
function scheduleHide(delay = 150) {
  if (hideTimeout) clearTimeout(hideTimeout);
  hideTimeout = setTimeout(() => {
    hideElements();
    hideTimeout = null;
  }, delay);
}

// ★改善点3: 必要なページでのみ監視を行い、それ以外では完全に監視を停止する
function manageObserver() {
  if (isFollowingPage()) {
    if (!observer) {
      // 対象ページに入ったら監視開始
      observer = new MutationObserver(() => scheduleHide(150));
      observer.observe(document.body, { childList: true, subtree: true });
      scheduleHide(0); // 初回チェック
    }
  } else {
    if (observer) {
      // 対象ページから離れたら監視を完全に停止してメモリを解放
      observer.disconnect();
      observer = null;
    }
  }
}

// SPA の履歴操作（pushState/replaceState/popstate）をフックして URL 変化を検出
(function hookHistory() {
  const origPush = history.pushState;
  const origReplace = history.replaceState;

  history.pushState = function() {
    const ret = origPush.apply(this, arguments);
    window.dispatchEvent(new Event('locationchange'));
    return ret;
  };
  history.replaceState = function() {
    const ret = origReplace.apply(this, arguments);
    window.dispatchEvent(new Event('locationchange'));
    return ret;
  };
  window.addEventListener('popstate', () => window.dispatchEvent(new Event('locationchange')));
})();

// URL が変わったらオブザーバーのON/OFFを管理
window.addEventListener('locationchange', () => {
  // SPAのDOM書き換えが落ち着くのを少し待ってから判定
  setTimeout(manageObserver, 200);
});

// 初回ロード時に一度実行
document.readyState === "loading"
  ? document.addEventListener("DOMContentLoaded", manageObserver)
  : manageObserver();