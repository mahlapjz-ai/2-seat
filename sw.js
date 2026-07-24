// 图书馆座位图片管理 - Service Worker
// 策略说明：
//   index.html / styles.css / scripts.js / auth.js / data-layer.js → Network-First（网络优先，保证每次打开都是最新版）
//   manifest.json → Network-First（网络优先，确保图标等配置更新及时生效）
//   seat-icon.png → Cache-First（缓存优先，不常变，省流量）
//   外部 CDN（jszip）→ Network-First（网络优先，离线回退缓存）

// 【v2.0.1】更新缓存版本号（每次发布新版本时必须递增，否则浏览器不会检测到 SW 更新）
// 【v2.7.67】回滚 v2.7.66 压缩部署，恢复原始资源路径，升级缓存版本强制刷新
// 【v2.7.75】从预缓存清单移除 HTML/CSS/JS（带版本号文件预缓存会导致旧版本长期驻留，
//           即使发版后 SW 仍可能返回缓存的旧 index.html + 新 styles.css，造成"裸体"页面）。
//           仅保留图标和 manifest.json 预缓存。所有 HTML/CSS/JS 走 Network-First。
const CACHE_NAME = 'seat-cache-v176';

// 预缓存资源列表（仅保留不常变且无版本号的小文件，避免缓存不一致）
const PRECACHE_ASSETS = [
  './manifest.json',
  './seat-icon.png',
  './seat-icon-192.png'
];

// Cache-First 资源：不常变，优先从缓存读取
const CACHE_FIRST_URLS = [
  './seat-icon.png',
  './seat-icon-192.png'
];

// ===== 安装事件 =====
// 预缓存核心资源，立即激活新版本（skipWaiting）
self.addEventListener('install', e => {
  console.log('[SW] 安装新版本:', CACHE_NAME);
  self.skipWaiting(); // 立即激活，不等待旧 SW 释放
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(PRECACHE_ASSETS)).catch(err => {
      console.warn('SW 预缓存失败（iOS 可能限制），继续安装:', err);
    })
  );
});

// ===== 消息事件 =====
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ===== 激活事件 =====
// 清理旧版本缓存，保留缩略图缓存，立即接管所有页面
self.addEventListener('activate', e => {
  console.log('[SW] 激活新版本:', CACHE_NAME);
  const cacheWhitelist = [CACHE_NAME, 'seat-thumbnails-v1']; // 保留当前SW缓存和缩略图缓存
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => !cacheWhitelist.includes(k)).map(k => {
        console.log('[SW] 删除旧缓存:', k);
        return caches.delete(k);
      }))
    ).then(() => self.clients.claim())
  );
});

// ===== 请求拦截 =====
self.addEventListener('fetch', e => {
  // 只处理 GET 请求
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // --- Supabase Storage 文件下载（xlsx 报表等）：强制 Network-Only ---
  // 修复：同 origin 的 storage download 请求会走 Stale-While-Revalidate，
  // 导致 admin.html "手动生成报表"后下载到 SW 缓存的旧 xlsx。
  // upsert 覆盖后 URL 不变但内容变了，必须每次走网络。
  if (url.pathname.includes('/storage/v1/object/')) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // --- 图片请求（原图/缩略图）：仅网络，不缓存到 SW Cache Storage ---
  // 缩略图由 data-layer.js 单独缓存到 seat-thumbnails-v1，原图不缓存
  if (url.pathname.includes('/object/public/') || url.pathname.match(/\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|$)/i)) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // --- 外部 CDN 资源（如 jszip）：网络优先，离线回退缓存 ---
  if (url.origin !== self.location.origin) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          // 立即 clone，避免 body 被消费后 clone 失败
          if (resp.ok && resp.type !== 'opaque') {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // 【v2.7.75】HTML 文件（document 类型）强制走网络，绝不返回缓存
  // 这是修复"裸体页面"的关键：避免 SW 返回缓存的旧 HTML 与新版 CSS/JS 组合
  // 仅在离线时（fetch 抛异常）才回退缓存，保证可离线打开
  if (e.request.destination === 'document' || url.pathname.endsWith('/') || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/admin.html') || url.pathname.endsWith('/login.html')) {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          // 网络成功：更新缓存并返回最新内容
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(c => c.put(e.request, clone)).catch(() => {});
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

  // --- *.css / *.js / manifest.json：Network-First（网络优先）---
  // 每次打开都优先请求网络，确保拿到最新版；网络失败时才用缓存
  if (url.pathname.endsWith('/manifest.json') || url.pathname.endsWith('/styles.css') || url.pathname.endsWith('/scripts.js') || url.pathname.endsWith('/auth.js') || url.pathname.endsWith('/data-layer.js')) {
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
            if (resp.ok) {
              const clone = resp.clone();
              cache.put(e.request, clone).catch(() => {});
            }
            return resp;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    )
  );
});
