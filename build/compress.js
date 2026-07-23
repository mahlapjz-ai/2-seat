// ============================================================
// 压缩构建脚本 - 使用 Terser 压缩 JS 文件，输出到 dist/
// 用法：
//   - 本地测试：node build/compress.js
//   - CI 环境：GITHUB_SHA 环境变量存在时，自动注入 commit SHA 到 sw.js 的 CACHE_NAME
//
// 策略：
//   - 保持文件名不变（index.html / login.html / admin.html 无需修改引用路径）
//   - mangle.toplevel = false：保留全局函数/变量名，保证跨文件引用安全
//   - 保留 console.log（用户选择保留，便于线上调试）
//   - 注入 commit SHA 到 CACHE_NAME，确保每次部署 SW 都更新缓存
// ============================================================

const fs = require('fs');
const path = require('path');
const Terser = require('terser');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// 需要压缩的 JS 文件
const JS_FILES = ['scripts.js', 'auth.js', 'data-layer.js', 'sw.js'];

// 需要原样复制的静态资源（不压缩）
const COPY_ITEMS = [
  'index.html',
  'login.html',
  'admin.html',
  'styles.css',
  'login.css',
  'manifest.json',
  'seat-icon.png',
  'seat-icon-192.png',
  'seat-report-template.xlsx'
];

// Terser 压缩配置
// 关键：mangle.toplevel = false，保留顶层全局变量（_sb, currentUser, showToast 等）
// 这些全局变量被 HTML 的 onclick 或其他 JS 文件引用，混淆会导致引用失败
const TERSER_OPTIONS = {
  compress: {
    drop_console: false,   // 保留 console.log（用户选择保留，便于线上诊断）
    drop_debugger: true,   // 删除 debugger 语句
    passes: 2,             // 多次优化，提升压缩率
    unused: true,          // 删除未引用的局部函数/变量
    dead_code: true        // 删除不可达代码
  },
  mangle: {
    toplevel: false,       // 关键：不混淆顶层变量，保证跨文件引用安全
    eval: false
  },
  format: {
    comments: false,       // 删除注释
    beautify: false,
    preserve_annotations: false
  },
  sourceMap: false
};

async function ensureDir(dir) {
  await fs.promises.mkdir(dir, { recursive: true });
}

async function cleanDir(dir) {
  // 清空 dist 目录（保留目录本身）
  if (fs.existsSync(dir)) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await fs.promises.rm(target, { recursive: true, force: true });
      } else {
        await fs.promises.unlink(target);
      }
    }
  } else {
    await ensureDir(dir);
  }
}

async function copyItem(name) {
  const src = path.join(ROOT, name);
  if (!fs.existsSync(src)) {
    console.warn(`[copy][skip] ${name} 不存在`);
    return;
  }
  const dst = path.join(DIST, name);
  const stat = await fs.promises.stat(src);
  if (stat.isDirectory()) {
    await ensureDir(dst);
    await fs.promises.cp(src, dst, { recursive: true });
  } else {
    await fs.promises.copyFile(src, dst);
  }
  console.log(`[copy] ${name} (${(stat.size / 1024).toFixed(1)}KB)`);
}

async function compressJs(file) {
  const srcPath = path.join(ROOT, file);
  const code = await fs.promises.readFile(srcPath, 'utf8');
  const result = await Terser.minify({ [file]: code }, TERSER_OPTIONS);
  if (result.error) {
    throw new Error(`压缩 ${file} 失败: ${result.error}`);
  }
  if (result.warnings && result.warnings.length > 0) {
    console.warn(`[warn] ${file} 压缩警告:`, result.warnings);
  }
  const dstPath = path.join(DIST, file);
  await fs.promises.writeFile(dstPath, result.code, 'utf8');
  const srcSize = Buffer.byteLength(code, 'utf8');
  const dstSize = Buffer.byteLength(result.code, 'utf8');
  const ratio = ((1 - dstSize / srcSize) * 100).toFixed(1);
  console.log(
    `[compress] ${file}: ${(srcSize / 1024).toFixed(1)}KB → ${(dstSize / 1024).toFixed(1)}KB (-${ratio}%)`
  );
}

async function injectCacheBusting() {
  // 将 commit SHA 注入 sw.js 的 CACHE_NAME，确保每次部署 SW 都更新缓存
  // 原：const CACHE_NAME = 'seat-cache-v173';
  // 后：const CACHE_NAME = 'seat-cache-v173-abc1234';
  const sha = process.env.GITHUB_SHA;
  if (!sha) {
    console.log('[cache-bust] 无 GITHUB_SHA 环境变量，跳过 CACHE_NAME 注入（本地测试模式）');
    return;
  }
  const shortSha = sha.slice(0, 7);
  const swPath = path.join(DIST, 'sw.js');
  let swCode = await fs.promises.readFile(swPath, 'utf8');

  // 匹配 CACHE_NAME = 'seat-cache-vXXX'（支持单双引号）
  const cacheNamePattern = /(CACHE_NAME\s*=\s*['"])seat-cache-v(\d+)(['"])/;
  if (!cacheNamePattern.test(swCode)) {
    console.warn('[cache-bust] 未匹配到 CACHE_NAME，跳过注入');
    return;
  }
  swCode = swCode.replace(
    cacheNamePattern,
    `$1seat-cache-v$2-${shortSha}$3`
  );
  await fs.promises.writeFile(swPath, swCode, 'utf8');
  console.log(`[cache-bust] sw.js CACHE_NAME 注入 commit SHA: ${shortSha}`);
}

async function main() {
  const startTime = Date.now();
  console.log('=== 开始压缩构建 ===\n');

  // 1. 清空 dist 目录
  await cleanDir(DIST);
  console.log(`[init] 清空 dist/ 目录\n`);

  // 2. 压缩 JS 文件
  console.log('--- 压缩 JS ---');
  for (const file of JS_FILES) {
    await compressJs(file);
  }

  // 3. 注入缓存破坏（CI 环境）
  console.log('\n--- 缓存破坏 ---');
  await injectCacheBusting();

  // 4. 复制静态资源
  console.log('\n--- 复制静态资源 ---');
  for (const item of COPY_ITEMS) {
    await copyItem(item);
  }

  // 5. 添加 .nojekyll（禁用 GitHub Pages 的 Jekyll 处理，避免下划线开头的文件被忽略）
  await fs.promises.writeFile(path.join(DIST, '.nojekyll'), '');
  console.log('[create] .nojekyll');

  // 6. 统计输出
  console.log('\n=== 构建完成 ===');
  const totalSize = await getDirSize(DIST);
  console.log(`dist/ 总大小: ${(totalSize / 1024).toFixed(1)}KB`);
  console.log(`构建耗时: ${((Date.now() - startTime) / 1000).toFixed(2)}秒`);
}

async function getDirSize(dir) {
  let total = 0;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await getDirSize(fullPath);
    } else {
      const stat = await fs.promises.stat(fullPath);
      total += stat.size;
    }
  }
  return total;
}

main().catch(err => {
  console.error('\n=== 构建失败 ===');
  console.error(err);
  process.exit(1);
});
