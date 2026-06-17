// 图书馆座位图片管理 - Service Worker
// 策略说明：
//   index.html → Network-First（网络优先，保证每次打开都是最新版）
//   manifest.json → Network-First（网络优先，确保图标等配置更新及时生效）
//   seat-icon.png → Cache-First（缓存优先，不常变，省流量）
//   外部 CDN（jszip）→ Network-First（网络优先，离线回退缓存）
//   其他同源资源 → Stale-While-Revalidate（先返回缓存，后台静默更新）

// 【v1.3.5】更新缓存版本号
const CACHE_NAME = 'seat-cache-v12';

// 预缓存资源列表（安装时一次性缓存）
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './seat-icon.png',
  './seat-icon-192.png',
  './shenyelogo.png'
];

// Cache-First 资源：不常变，优先从缓存读取
const CACHE_FIRST_URLS = [
  './seat-icon.png',
  './seat-icon-192.png',
  './shenyelogo.png'
];

// ===== 安装事件 =====
// 预缓存核心资源，不自动 skipWaiting（等用户确认更新提示后再激活）
// 【v1.2.0 iOS兼容】添加 try-catch 防止 iOS 缓存失败导致 SW 安装中断
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(PRECACHE_ASSETS)).catch(err => {
      console.warn('SW 预缓存失败（iOS 可能限制），继续安装:', err);
    })
  );
});

// ===== 消息事件 =====
// 用户点击"有新版本可用，点击刷新"后，新 SW 立即激活
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ===== 激活事件 =====
// 清理旧版本缓存，立即接管所有客户端
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ===== 请求拦截 =====
self.addEventListener('fetch', e => {
  // 只处理 GET 请求
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // --- 外部 CDN 资源（如 jszip）：网络优先，离线回退缓存 ---
  if (url.origin !== self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          if (resp.ok) {
            caches.open(CACHE_NAME).then(c => c.put(e.request, resp.clone()));
          }
          return resp;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // --- index.html / manifest.json：Network-First（网络优先）---
  // 每次打开都优先请求网络，确保拿到最新版；网络失败时才用缓存
  if (url.pathname.endsWith('/') || url.pathname.endsWith('/index.html') || url.pathname === '/' || url.pathname.endsWith('/manifest.json')) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          // 网络成功：更新缓存并返回最新内容
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => {
          // 网络失败（离线）：回退缓存
          return caches.match(e.request).then(cached => cached || new Response('离线', { status: 503 }));
        })
    );
    return;
  }

  // --- Cache-First 资源：seat-icon.png 等 ---
  // 不常变，优先从缓存读取，缓存没有才请求网络
  if (CACHE_FIRST_URLS.some(u => url.pathname.endsWith(u.replace('./', '')))) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
          }
          return resp;
        });
      })
    );
    return;
  }

  // --- 其他同源资源：Stale-While-Revalidate ---
  // 先返回缓存（秒开），后台静默更新缓存（下次访问生效）
  e.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(e.request).then(cached => {
        const fetchPromise = fetch(e.request)
          .then(resp => {
            if (resp.ok) cache.put(e.request, resp.clone());
            return resp;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    )
  );
});
