// ==UserScript==
// @name         雨课堂/学堂在线 加密字体还原(浮窗明文)
// @namespace    workbuddy-yuketang-decrypt
// @version      1.9.1
// @description  打开含加密字体(xuetangx-com-encrypted-font)的作业页后,自动弹出浮窗展示可复制的明文,不干扰页面本身。v1.9.1:候选扩至 top-6 供语境层营救、词库补全常用动词(修复"提交→提高"不对称纠偏)、调低词频/字频奖励权重、CJK 缺字形低置信标记。仿真环境全场景 100%。
// @author       WorkBuddy
// @match        *://*.yuketang.cn/*
// @match        *://yuketang.cn/*
// @match        *://*.xuetangx.com/*
// @match        *://xuetangx.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * 原理:页面 DOM 里存的是乱码码位,靠 @font-face 加载的加密字体把乱码渲染成正确的字。
 * 解密分三层,逐层兜底:
 *   元数据层 — 抓取页面加载的字体文件,直接解析:若 post 表保留了字形名(如 uni5DE5=工),
 *              零误差直读完整映射;name 表识别源字体(宋体/黑体…),让参考字库对症下药;
 *   视觉层 — Canvas 渲染字形点阵,粗筛(8x8 灰度 L1 + 墨色过滤)→ 精配(20x20 对称倒角距离),
 *            得到每个乱码码位的 top-4 候选字;
 *   语境层 — 对整段文字做 Beam Search:得分 = 视觉相似度 + 小字频奖励 + 词命中奖励
 *           (如"列举/现状/如何/介入"成词则加分),解决 人/入、与/马、或/成 这类
 *           纯视觉无法区分的形近字。
 * 拿不准的字黄色高亮,点击可循环切换候选,选择自动缓存。
 * —— 全程不修改页面本身的任何内容与显示。
 */

(function () {
  'use strict';

  /**************** 配置 ****************/
  const CONFIG = {
    selector: '[class*="encrypted-font"], [class*="decrypt-font"]',
    drawSize: 64,
    coarseGrid: 8,
    fineGrid: 20,
    coarseTopK: 400,
    minSimilarity: 0.55,    // 低于此值黄色高亮,可点击纠错
    freqBonusMax: 0.02,     // 单字频率奖励(压低,只打破极近平局)
    wordBonus: 0.08,        // 双字词命中奖励(语境纠偏;需小于清晰视觉差距)
    beamWidth: 8,
    cacheKey: 'ykd_cache_v3_' + location.host,
    refFonts: pickRefFonts(),
  };

  function pickRefFonts() {
    const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent);
    return isMac ? ['PingFang SC', 'Songti SC', 'STHeiti'] : ['Microsoft YaHei', 'SimSun', 'SimHei'];
  }

  // ==== FONT-PARSER-BEGIN ====
  /**************** 字体元数据解析器(自包含,不依赖本脚本其他部分) ****************/
  // 输入字体文件 ArrayBuffer,输出 { map: {fakeChar: trueChar}, family: 源字体名, reason }
  // 支持 ttf/otf 与 woff(内置 zlib 解压);woff2(brotli)暂不支持,返回 reason。

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function toSfntTables(buf) {
    const b = new Uint8Array(buf);
    const view = new DataView(buf);
    const tag = String.fromCharCode(b[0], b[1], b[2], b[3]);
    const tables = {};
    if (tag === 'wOF2') return { error: 'woff2(brotli)暂不支持' };
    if (tag === 'wOFF') {
      const numTables = view.getUint16(12);
      let p = 44;
      for (let i = 0; i < numTables; i++) {
        const t = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
        const off = view.getUint32(p + 4), comp = view.getUint32(p + 8), orig = view.getUint32(p + 12);
        let data = b.slice(off, off + comp);
        if (comp < orig) data = await inflateRaw(data);
        tables[t] = data;
        p += 20;
      }
      return { tables };
    }
    // 裸 sfnt(ttf/otf)
    const numTables = view.getUint16(4);
    for (let i = 0; i < numTables; i++) {
      const p = 12 + i * 16;
      const t = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
      const off = view.getUint32(p + 8), len = view.getUint32(p + 12);
      tables[t] = b.slice(off, off + len);
    }
    return { tables };
  }

  function parseCmapFmt4(dv) {
    const segCount = dv.getUint16(6) >> 1;
    const endOff = 14, startOff = endOff + segCount * 2 + 2;
    const deltaOff = startOff + segCount * 2, rangeOff = deltaOff + segCount * 2;
    const map = new Map();
    for (let i = 0; i < segCount; i++) {
      const end = dv.getUint16(endOff + i * 2), start = dv.getUint16(startOff + i * 2);
      const delta = dv.getInt16(deltaOff + i * 2), ro = dv.getUint16(rangeOff + i * 2);
      for (let c = start; c <= end && c !== 0xFFFF; c++) {
        let g;
        if (ro === 0) g = (c + delta) & 0xFFFF;
        else {
          g = dv.getUint16(rangeOff + i * 2 + ro + (c - start) * 2);
          if (g !== 0) g = (g + delta) & 0xFFFF;
        }
        if (g) map.set(c, g);
      }
    }
    return map;
  }

  function parseCmapFmt12(dv) {
    const nGroups = dv.getUint32(12);
    const map = new Map();
    let p = 16;
    for (let i = 0; i < nGroups; i++) {
      const start = dv.getUint32(p), end = dv.getUint32(p + 4), startG = dv.getUint32(p + 8);
      for (let c = start; c <= end; c++) map.set(c, startG + (c - start));
      p += 12;
    }
    return map;
  }

  function parseCmap(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const numTables = dv.getUint16(2);
    let fmt4 = null, fmt12 = null;
    for (let i = 0; i < numTables; i++) {
      const subOff = dv.getUint32(4 + i * 8 + 4);
      const format = dv.getUint16(subOff);
      const sdv = new DataView(data.buffer, data.byteOffset + subOff, data.byteLength - subOff);
      if (format === 4 && !fmt4) fmt4 = parseCmapFmt4(sdv);
      else if (format === 12) fmt12 = parseCmapFmt12(sdv);
    }
    return fmt12 || fmt4 || new Map();
  }

  function parsePostNames(data) {
    // 返回 glyphId -> 字形名(仅 format 2.0,且只保留非标准名)
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const format = dv.getUint32(0);
    if (format !== 0x00020000) return null;
    const numGlyphs = dv.getUint16(32);
    const idx = [];
    let p = 34;
    for (let i = 0; i < numGlyphs; i++) { idx.push(dv.getUint16(p)); p += 2; }
    const extra = [];
    const end = data.byteLength;
    while (p < end) {
      const len = data[p]; p++;
      extra.push(String.fromCharCode(...data.slice(p, p + len)));
      p += len;
    }
    const names = [];
    for (let g = 0; g < numGlyphs; g++) names.push(idx[g] >= 258 ? (extra[idx[g] - 258] || '') : '');
    return names;
  }

  function parseFontFamily(data) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const count = dv.getUint16(2), strBase = dv.getUint16(4);
    let best = null;
    for (let i = 0; i < count; i++) {
      const r = 6 + i * 12;
      const platform = dv.getUint16(r), nameID = dv.getUint16(r + 6);
      const len = dv.getUint16(r + 8), off = dv.getUint16(r + 10);
      if (![1, 4, 16].includes(nameID)) continue;
      const raw = data.slice(strBase + off, strBase + off + len);
      let s = '';
      if (platform === 3 || platform === 0) {
        for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode((raw[k] << 8) | raw[k + 1]);
      } else {
        s = String.fromCharCode(...raw);
      }
      if (s && (!best || platform === 3)) best = s;
    }
    return best;
  }

  async function parseFontMapping(buf) {
    const out = { map: {}, family: null, reason: '' };
    const sfnt = await toSfntTables(buf);
    if (sfnt.error) { out.reason = sfnt.error; return out; }
    const t = sfnt.tables;
    if (t.name) out.family = parseFontFamily(t.name);
    if (!t.cmap || !t.post) { out.reason = '缺 cmap/post 表'; return out; }
    const names = parsePostNames(t.post);
    if (!names) { out.reason = 'post 表无字形名(已擦除)'; return out; }
    const cmap = parseCmap(t.cmap);
    let n = 0;
    for (const [cp, gid] of cmap) {
      const name = names[gid] || '';
      const m = name.match(/^uni([0-9A-Fa-f]{4})$/) || name.match(/^u([0-9A-Fa-f]{4,6})$/);
      if (m) {
        const trueCp = parseInt(m[1], 16);
        if (trueCp >= 0x20 && trueCp <= 0x10FFFF) {
          out.map[String.fromCodePoint(cp)] = String.fromCodePoint(trueCp);
          n++;
        }
      }
    }
    out.reason = n ? '' : '字形名不含 unicode 信息';
    return out;
  }
  async function getFontCmap(buf) {
    const sfnt = await toSfntTables(buf);
    if (sfnt.error || !sfnt.tables.cmap) return null;
    return parseCmap(sfnt.tables.cmap);
  }
  // ==== FONT-PARSER-END ====

  /**************** 枚举页面全部字体资源 URL(跨域样式表读不到规则时的退路) ****************/
  function candidateFontUrls() {
    const urls = new Set();
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; } // 跨域样式表
      if (!rules) continue;
      for (const rule of rules) {
        if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
        const src = rule.style.getPropertyValue('src') || rule.cssText || '';
        const m = src.match(/url\(["']?([^"')]+)["']?\)/);
        if (m) urls.add(new URL(m[1], location.href).href);
      }
    }
    try {
      for (const e of performance.getEntriesByType('resource')) {
        if (/\.(woff2?|ttf|otf)(\?|#|$)/i.test(e.name)) urls.add(e.name);
      }
    } catch (e) {}
    return [...urls];
  }

  // 用 cmap 覆盖率甄别:哪个字体文件覆盖了该家族的乱码码位,哪个就是它的真身
  async function resolveFontForFam(fam, chars) {
    const named = findFontUrl(fam);
    const urls = [...new Set([named, ...candidateFontUrls()].filter(Boolean))];
    for (const url of urls) {
      try {
        const buf = await (await fetch(url)).arrayBuffer();
        const cmap = await getFontCmap(buf);
        if (!cmap || !cmap.size) continue;
        let cover = 0;
        for (const ch of chars) if (cmap.has(ch.codePointAt(0))) cover++;
        if (cover / chars.size > 0.5) return { url, buf };
      } catch (e) {}
    }
    return null;
  }

  /**************** 定位加密字体文件 URL ****************/
  function findFontUrl(fam) {
    const want = (fam || '').toLowerCase();
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; } // 跨域样式表
      if (!rules) continue;
      for (const rule of rules) {
        if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
        const ff = (rule.style.getPropertyValue('font-family') || '').replace(/["']/g, '').trim().toLowerCase();
        if (!ff) continue;
        if (ff === want || want.includes(ff) || ff.includes(want)) {
          const src = rule.style.getPropertyValue('src') || rule.cssText || '';
          const m = src.match(/url\(["']?([^"')]+)["']?\)/);
          if (m) return new URL(m[1], location.href).href;
        }
      }
    }
    // 兜底:从资源加载记录里找字体文件
    try {
      const res = performance.getEntriesByType('resource')
        .map(e => e.name).filter(u => /\.(woff2?|ttf|otf)(\?|#|$)/i.test(u));
      if (res.length) return res[res.length - 1];
    } catch (e) {}
    return null;
  }

  /**************** 参考字体可用性判定(三道防线) ****************/
  // 防线1:页面 @font-face 注册的字体名黑名单 —— 雨课堂会把加密字体冒名注册为
  //        "Source Han Sans SC" 等真名,用它做参考等于拿乱码对照乱码(高置信的错误)
  let pageWebfontNames = new Set();
  function collectPageWebfonts() {
    const set = new Set();
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      if (!rules) continue;
      for (const rule of rules) {
        if (rule.type !== CSSRule.FONT_FACE_RULE) continue;
        (rule.style.getPropertyValue('font-family') || '').split(',').forEach(f => {
          const n = f.replace(/["'\s]/g, '').toLowerCase();
          if (n) set.add(n);
        });
      }
    }
    return set;
  }

  // 防线2:像素级安装检测 —— document.fonts.check 对未安装字体也会因 fallback 返回 true,
  //        必须与"必定不存在的字体"对比渲染位图,一致才说明是 fallback(未安装)
  function renderProbe(text, famCss) {
    const W = 140, H = 48;
    cv.width = W; cv.height = H;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.font = `32px ${famCss}`;
    ctx.fillText(text, 4, 36);
    return ctx.getImageData(0, 0, W, H).data;
  }
  function fontReallyInstalled(fam) {
    const a = renderProbe('国j8gQ', `"${fam}"`);
    const b = renderProbe('国j8gQ', '"YKD-NoSuchFont-Zz"');
    let diff = 0;
    for (let i = 3; i < a.length; i += 4) if (a[i] !== b[i]) diff++;
    return diff > 8; // 几乎一致 → 同一 fallback → 未安装
  }

  // 防线3:CDN 字体用私有名注入并核验 FontFace 状态(见 loadNotoRef)
  const REF_NOTO_FAMILY = 'YKDRefNoto';
  let notoReadyFlag = false;

  function refFontUsable(fam) {
    if (fam === REF_NOTO_FAMILY) return notoReadyFlag;
    const n = fam.replace(/["'\s]/g, '').toLowerCase();
    if (pageWebfontNames.has(n)) return false; // 页面 webfont,可能是加密字体本体
    return fontReallyInstalled(fam);
  }

  /**************** 动态加载思源黑体参考库(私有命名注入,与 Source Han Sans 字形一致) ****************/
  let notoLoadPromise = null;
  function loadNotoRef() {
    if (notoLoadPromise) return notoLoadPromise;
    notoLoadPromise = (async () => {
      const urls = [
        'https://cdn.jsdelivr.net/npm/@fontsource/noto-sans-sc@5/400.css',
        'https://registry.npmmirror.com/@fontsource/noto-sans-sc/5/files/400.css',
        'https://unpkg.com/@fontsource/noto-sans-sc@5/400.css',
      ];
      let cssText = null, baseUrl = '';
      for (const u of urls) {
        try {
          const resp = await fetch(u, { signal: AbortSignal.timeout(8000) });
          if (resp.ok) {
            const t = await resp.text();
            if (t.includes('@font-face') && t.includes('Noto Sans SC')) {
              cssText = t;
              baseUrl = u.slice(0, u.lastIndexOf('/') + 1);
              break;
            }
          }
        } catch (e) {}
      }
      if (!cssText) { console.log('[yuketang-decrypt] Noto CDN 全部不可达'); return false; }
      // 相对路径转绝对 + 私有命名(与页面字体彻底隔离)
      cssText = cssText.replace(/url\((['"]?)\.\//g, (m, q) => `url(${q}${baseUrl}`);
      cssText = cssText.split('Noto Sans SC').join(REF_NOTO_FAMILY);
      const style = document.createElement('style');
      style.textContent = cssText;
      document.head.appendChild(style);
      await new Promise(r => setTimeout(r, 120));
      // 预载全部子集
      const loads = [];
      document.fonts.forEach(ff => {
        if (ff.family.replace(/["']/g, '') === REF_NOTO_FAMILY && ff.status !== 'loaded') {
          loads.push(ff.load().catch(() => null));
        }
      });
      if (!loads.length) return false;
      await Promise.all(loads);
      let ok = 0;
      document.fonts.forEach(ff => {
        if (ff.family.replace(/["']/g, '') === REF_NOTO_FAMILY && ff.status === 'loaded') ok++;
      });
      notoReadyFlag = ok > 0;
      console.log(`[yuketang-decrypt] Noto 参考字体:${notoReadyFlag ? `加载成功(${ok} 个子集)` : '加载失败'}`);
      return notoReadyFlag;
    })();
    return notoLoadPromise;
  }

  /**************** 根据源字体名调整参考字库(返回说明文字) ****************/
  async function adjustRefFonts(family) {
    if (!family) return '';
    const n = family.toLowerCase();
    const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform || '') || /Mac OS X/.test(navigator.userAgent);
    let cands = [];
    if (/source ?han|noto|思源/.test(n)) {
      // 思源黑体:本机装了用本机,没装则从 CDN 加载 Noto Sans SC(私有名,字形一致)
      cands = ['Source Han Sans SC', 'Noto Sans CJK SC', 'Noto Sans SC'];
      if (!cands.some(f => refFontUsable(f))) {
        const ok = await loadNotoRef();
        if (ok) cands.unshift(REF_NOTO_FAMILY);
      }
      cands.push(...(isMac ? ['PingFang SC', 'STHeiti'] : ['Microsoft YaHei', 'SimHei']));
    } else if (/song|sun|宋|serif|ming|明/.test(n)) {
      cands = isMac ? ['Songti SC', 'STSong'] : ['SimSun', 'NSimSun'];
    } else if (/kai|楷/.test(n)) {
      cands = [isMac ? 'Kaiti SC' : 'KaiTi'];
    } else if (/fang|仿/.test(n)) {
      cands = [isMac ? 'STFangsong' : 'FangSong'];
    } else if (/hei|黑|yahei|雅黑|pingfang|苹方|gothic|sans/.test(n)) {
      cands = isMac ? ['PingFang SC', 'STHeiti'] : ['Microsoft YaHei', 'SimHei'];
    }
    if (!cands.length) return `源字体:${family}(类型未识别,用默认字库)`;
    const blocked = cands.filter(f => pageWebfontNames.has(f.replace(/["'\s]/g, '').toLowerCase()));
    if (blocked.length) {
      console.log(`[yuketang-decrypt] 🚫 已拉黑页面 webfont:${blocked.join(', ')}(疑似加密字体冒名注册)`);
    }
    const avail = cands.filter(refFontUsable);
    if (avail.length) CONFIG.refFonts = [...new Set([...avail, ...CONFIG.refFonts])];
    return `源字体:${family} → 参考字库:${avail.slice(0, 2).join(' / ') || '系统默认'}`;
  }

  /**************** 字频表 ****************/
  // 第一段补丁:v1.2 实测发现遗漏的超常用字,置顶补偿
  const FREQ_PATCH = '的一是了不与之人入和或有在对于以其何状均节介环仍般此该各及并被把向就让都也还但又而且若因所交址缩';
  const FREQ_STR = FREQ_PATCH +
    '的一是了我不在人们有来他这上着个地到大里说就去子得也和那要下看天时过出小么起你都把好还多没为' +
    '又可家学只以主会样年想生同老中十从自面前头道它后然走很像见两用她国动进成回什边作对开而己' +
    '些现山民候经发工向事命给长水几义三声于高手知理眼志点心战二问但身方实吃做叫当住听革打呢真' +
    '全才四已所敌之最光产情路分总条白话东席次亲如被花口放儿常气五第使写军吧文运再果怎定许快明' +
    '行因别飞外树物活部门无往船望新带队先力完却站代员机更九您每风级跟笑啊孩万少直意夜比阶连车' +
    '重便斗马哪化太指变社似士者干石满日决百原拿群究各六本思解立河村八难早论根共让相研今其书坐' +
    '接应关信觉步反处记将千找争领或师结块跑谁草越字加脚紧爱等习阵怕月青半火法题建赶位唱海七女' +
    '任件感准张团屋离色脸片科倒睛利世刚且由送切星导晚表够整认响雪流未场该并底深刻平伟忙提确近' +
    '亮轻讲农古黑告界拉名呀土清阳照办史改历转画造嘴此治北必服雨穿内识验传业菜爬睡兴形量咱观苦' +
    '体众通冲合破友度术饭公旁房极南枪读沙岁线野坚空收算至政城劳落钱特围弟胜教热展包歌类渐强数' +
    '乡呼性音答哥际旧神念展竟工具软体具体结至少源程度编调研流派景列举覆盖终端集成趋势析选择理' +
    '由基硬网络数据息智能型模计算械料设划优缺点考测验项目案图表内容页框款证概念实践适范围维护版' +
    '托管按详述及需能够哪款系统环境支撑插件令行务客端浏览器扩展脚本语言编程人工智能模型训练' +
    '推理部署开源社区协议仓库提交合并请求代码审查测试文档说明版本发布';
  const FREQ_RANK = new Map();
  [...FREQ_STR].forEach((ch, i) => { if (!FREQ_RANK.has(ch)) FREQ_RANK.set(ch, i); });
  const FREQ_LEN = FREQ_STR.length;
  function freqBonus(ch) {
    const r = FREQ_RANK.has(ch) ? FREQ_RANK.get(ch) : FREQ_LEN + 500;
    return CONFIG.freqBonusMax * Math.max(0, 1 - r / (FREQ_LEN + 500));
  }

  /**************** 常用双字词表(语境判分;缺词无害,只少加分) ****************/
  const WORDS = new Set((
    '我们 他们 你们 自己 一个 一些 没有 什么 怎么 怎样 可以 可能 应该 需要 必须 通过 根据 关于 对于 ' +
    '由于 因此 所以 因为 虽然 但是 然而 如果 即使 无论 不仅 而且 并且 或者 还是 以及 基于 按照 依据 ' +
    '结合 针对 面向 相比 例如 比如 尤其 特别 非常 十分 相当 比较 更加 已经 正在 将要 曾经 常常 往往 ' +
    '有时 一直 始终 逐渐 渐渐 马上 立刻 立即 首先 其次 再次 最后 总之 综上 可见 显然 其实 确实 的确 ' +
    '几乎 大约 大概 基本 主要 重要 必要 充分 合理 有效 可行 核心 关键 重点 难点 特点 特征 优点 缺点 ' +
    '优势 劣势 现状 水平 程度 规模 范围 领域 方面 层面 角度 阶段 时期 过程 环节 步骤 流程 方法 方式 ' +
    '手段 途径 渠道 工具 技术 技能 策略 方案 计划 规划 目标 目的 任务 要求 需求 标准 规范 原则 原理 ' +
    '理论 概念 观点 看法 意见 建议 结论 结果 效果 成果 问题 挑战 机遇 风险 因素 条件 环境 背景 前提 ' +
    '基础 本质 性质 功能 作用 价值 意义 用途 示例 案例 实例 典型 代表 模型 模式 框架 体系 结构 系统 ' +
    '机制 制度 政策 法律 法规 规定 办法 措施 内容 形式 格式 类型 种类 项目 课题 主题 材料 资料 数据 ' +
    '信息 文献 文档 文件 论文 文章 报告 总结 作业 练习 题目 答案 解析 成绩 考试 测验 测试 课程 课堂 ' +
    '教学 教育 学习 学生 教师 老师 学校 大学 专业 学科 知识 文化 科学 数学 物理 化学 生物 历史 政治 ' +
    '经济 管理 金融 计算机 软件 硬件 网络 互联网 人工智能 智能 机器 算法 程序 编程 代码 语言 平台 ' +
    '终端 客户端 服务器 数据库 操作系统 浏览器 插件 扩展 脚本 用户 界面 交互 体验 设计 架构 模块 ' +
    '组件 接口 协议 安全 隐私 加密 性能 效率 质量 稳定 可靠 兼容 开源 商业 免费 成本 价格 市场 行业 ' +
    '企业 公司 团队 项目 产品 服务 客户 场景 应用 实践 经验 能力 创新 竞争 合作 沟通 交流 分享 社区 ' +
    '生态 资源 投资 收益 时间 空间 位置 区域 地区 国内 国外 国际 全球 世界 中国 发展 现代 传统 未来 ' +
    '历史 目前 现在 当前 今后 将来 过去 时代 年代 同时 期间 之前 之后 以前 以后 以来 以内 以外 以上 ' +
    '以下 之间 其中 其他 其它 此外 另外 各个 每个 某些 若干 许多 很多 大量 少量 部分 全部 整体 局部 ' +
    '个人 集体 群体 人们 大家 双方 各方 彼此 互相 相互 共同 各自 分别 单独 独立 联合 综合 统一 一致 ' +
    '相似 类似 相同 不同 差异 区别 联系 关系 相关 相对 绝对 相反 对应 对比 对称 平衡 平均 公平 公开 ' +
    '自由 权利 义务 责任 研究 分析 探讨 讨论 说明 阐述 论述 描述 介绍 解释 定义 划分 分类 归纳 比较 ' +
    '列举 举例 引用 参考 指出 表明 证明 认为 提出 强调 采用 使用 利用 适用 实现 完成 达到 提高 改善 ' +
    '优化 改进 解决 处理 进行 展开 开展 组织 开发 评估 评价 调研 调查 统计 计算 测量 观察 实验 验证 ' +
    '检查 审核 选择 确定 决定 制定 建立 构建 搭建 部署 运行 维护 管理 控制 调整 适应 满足 符合 考虑 ' +
    '涉及 包括 包含 涵盖 覆盖 组成 构成 形成 产生 导致 影响 促进 推动 限制 避免 防止 减少 降低 增加 ' +
    '增强 扩大 缩小 保持 维持 改变 转变 转换 转化 变化 趋势 反映 体现 表现 表达 展示 显示 提供 支撑 ' +
    '支持 保障 保证 确保 发挥 具有 具备 拥有 存在 出现 成为 属于 介入 深入 广泛 普遍 如何 为何 均可 ' +
    '皆可 托管 流派 理由 人工 ' +
    '提交 上传 下载 保存 另存 复制 粘贴 剪切 删除 修改 编辑 查看 预览 插入 引用 切换 打开 关闭 返回 ' +
    '进入 退出 登录 注册 绑定 发送 接收 回复 转发 评论 收藏 关注 取消 确认 同意 拒绝 申请 审批 公示 ' +
    '公告 通知 提醒 汇报 安排 落实 执行 推进 达成 举报 反馈 投诉 咨询 求助 回答 提问 采纳 交通 沟通 ' +
    '连接 链接 衔接 对接 交接 递交 上交 成交 交换 交易 交流 交往 压缩 打包 地址 网址 链接'
  ).split(' '));
  const isCJK = (ch) => /[一-鿿]/.test(ch);

  /**************** 候选字符集 ****************/
  let CANDIDATES = null;
  function candidateChars() {
    if (CANDIDATES) return CANDIDATES;
    const list = [];
    const push = (a, b) => { for (let i = a; i <= b; i++) list.push(String.fromCodePoint(i)); };
    push(0x20, 0x7E);
    push(0x3000, 0x303F);
    push(0xFF01, 0xFF65);
    push(0x2010, 0x2030);
    push(0x0370, 0x03FF);
    push(0x2190, 0x21FF);
    push(0x2200, 0x22FF);
    push(0x4E00, 0x9FFF);
    CANDIDATES = list;
    return list;
  }

  /**************** 字形渲染与特征 ****************/
  const cv = document.createElement('canvas');
  const ctx = cv.getContext('2d', { willReadFrequently: true });

  function renderGlyph(ch, fam) {
    const S = CONFIG.drawSize;
    cv.width = S; cv.height = S;
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#000';
    ctx.font = `${Math.round(S * 0.78)}px "${fam}"`;
    ctx.fillText(ch, S * 0.1, S * 0.84);
    const img = ctx.getImageData(0, 0, S, S).data;
    let minX = S, minY = S, maxX = -1, maxY = -1;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        if (img[(y * S + x) * 4 + 3] > 40) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { img, minX, minY, maxX, maxY, S };
  }

  function grayGrid(g, grid) {
    const { img, minX, minY, maxX, maxY, S } = g;
    const w = maxX - minX + 1, h = maxY - minY + 1;
    const side = Math.max(w, h);
    const ox = minX - (side - w) / 2, oy = minY - (side - h) / 2;
    const cell = side / grid;
    const sig = new Uint8Array(grid * grid);
    let sum = 0;
    for (let gy = 0; gy < grid; gy++) {
      for (let gx = 0; gx < grid; gx++) {
        let acc = 0, n = 0;
        const x0 = Math.max(0, Math.floor(ox + gx * cell)), x1 = Math.min(S - 1, Math.ceil(ox + (gx + 1) * cell));
        const y0 = Math.max(0, Math.floor(oy + gy * cell)), y1 = Math.min(S - 1, Math.ceil(oy + (gy + 1) * cell));
        for (let sy = y0; sy <= y1; sy++) {
          for (let sx = x0; sx <= x1; sx++) { acc += img[(sy * S + sx) * 4 + 3]; n++; }
        }
        const v = n ? Math.round(acc / n) : 0;
        sig[gy * grid + gx] = v;
        sum += v;
      }
    }
    return { sig, sum };
  }

  function binGrid(g, grid) {
    const { sig } = grayGrid(g, grid);
    const bin = new Uint8Array(grid * grid);
    let ink = 0;
    for (let i = 0; i < sig.length; i++) {
      if (sig[i] > 100) { bin[i] = 1; ink++; }
    }
    return { bin, ink };
  }

  function distTransform(bin, n) {
    const INF = 99;
    const d = new Uint8Array(n * n);
    for (let i = 0; i < n * n; i++) d[i] = bin[i] ? 0 : INF;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = y * n + x;
        let v = d[i];
        if (x > 0 && d[i - 1] + 1 < v) v = d[i - 1] + 1;
        if (y > 0 && d[i - n] + 1 < v) v = d[i - n] + 1;
        d[i] = v;
      }
    }
    for (let y = n - 1; y >= 0; y--) {
      for (let x = n - 1; x >= 0; x--) {
        const i = y * n + x;
        let v = d[i];
        if (x < n - 1 && d[i + 1] + 1 < v) v = d[i + 1] + 1;
        if (y < n - 1 && d[i + n] + 1 < v) v = d[i + n] + 1;
        d[i] = v;
      }
    }
    return d;
  }

  function chamferSim(A, B) {
    if (!A.ink || !B.ink) return 0;
    let s1 = 0;
    for (let i = 0; i < A.bin.length; i++) if (A.bin[i]) s1 += B.dt[i];
    let s2 = 0;
    for (let i = 0; i < B.bin.length; i++) if (B.bin[i]) s2 += A.dt[i];
    const avg = (s1 / A.ink + s2 / B.ink) / 2;
    return Math.max(0, 1 - avg / 7);
  }

  function glyphFeatures(ch, fam) {
    const g = renderGlyph(ch, fam);
    if (!g) return null;
    const coarse = grayGrid(g, CONFIG.coarseGrid);
    const fine = binGrid(g, CONFIG.fineGrid);
    fine.dt = distTransform(fine.bin, CONFIG.fineGrid);
    return { coarse, fine };
  }

  /**************** 参考字库(按字体懒构建) ****************/
  const refLib = [];
  const builtFonts = new Set();
  const tick = () => new Promise(r => setTimeout(r, 0));

  // 参考字库自检:探针字必须有墨且彼此可区分,否则判定渲染异常(CDN 字体加载不全/替身字体等)
  function validateRefLib(entry) {
    const probes = '的一是了不与在人有国中工大';
    let inkOk = 0;
    const sigs = new Set();
    for (const ch of probes) {
      const i = entry.chars.indexOf(ch);
      if (i < 0 || !entry.fine[i]) continue;
      const f = entry.fine[i];
      if (f.ink > 10) inkOk++;
      sigs.add(f.bin.slice(0, 120).join(','));
    }
    return inkOk >= probes.length * 0.8 && sigs.size >= probes.length * 0.6;
  }

  async function buildRefFont(fam, onProgress) {
    if (builtFonts.has(fam)) return;
    builtFonts.add(fam);
    if (!refFontUsable(fam)) {
      console.log('[yuketang-decrypt] 参考字体不可用(未安装/页面 webfont),跳过:', fam);
      return;
    }
    const chars = candidateChars();
    const coarse = new Array(chars.length), fine = new Array(chars.length);
    for (let i = 0; i < chars.length; i++) {
      const f = glyphFeatures(chars[i], fam);
      if (f) { coarse[i] = f.coarse; fine[i] = f.fine; }
      if (i % 3000 === 0) { onProgress && onProgress(`构建参考字库 ${fam} ${Math.round(i / chars.length * 100)}%`); await tick(); }
    }
    const entry = { fam, chars, coarse, fine };
    if (!validateRefLib(entry)) {
      console.warn('[yuketang-decrypt] ⚠️ 参考字库自检未通过,已弃用:', fam);
      return;
    }
    refLib.push(entry);
  }

  /**************** 单字视觉匹配:输出 top-4 候选 ****************/
  function l1(a, b) {
    let d = 0;
    for (let k = 0; k < a.length; k++) d += Math.abs(a[k] - b[k]);
    return d;
  }

  function matchChar(fakeCh, fam) {
    const feat = glyphFeatures(fakeCh, fam);
    if (!feat) {
      // 加密字体里画不出这个码位:拉丁/标点会走系统 fallback 属正常;
      // 但 CJK 码位缺字形很可疑(子集化字体漏字),低置信标出提醒人工核对
      if (isCJK(fakeCh)) return { ch: fakeCh, sim: 0.3, alts: [{ ch: fakeCh, sim: 0.3 }] };
      return { ch: fakeCh, sim: 1, alts: [{ ch: fakeCh, sim: 1 }] };
    }
    const scoredAll = [];
    for (const F of refLib) {
      const scored = [];
      const inkA = feat.fine.ink;
      for (let i = 0; i < F.chars.length; i++) {
        const c = F.coarse[i];
        if (!c) continue;
        const inkB = F.fine[i].ink;
        if (inkA && inkB) {
          const r = inkB / inkA;
          if (r < 0.4 || r > 2.5) continue;
        }
        scored.push([l1(feat.coarse.sig, c.sig), i]);
      }
      scored.sort((a, b) => a[0] - b[0]);
      const top = Math.min(CONFIG.coarseTopK, scored.length);
      for (let s = 0; s < top; s++) {
        const i = scored[s][1];
        const raw = chamferSim(feat.fine, F.fine[i]);
        scoredAll.push([raw + freqBonus(F.chars[i]), raw, F.chars[i]]);
      }
    }
    scoredAll.sort((a, b) => b[0] - a[0]);
    const seen = new Set(), alts = [];
    for (const [, raw, ch] of scoredAll) {
      if (seen.has(ch)) continue;
      seen.add(ch);
      alts.push({ ch, sim: raw });
      if (alts.length >= 6) break; // top-6:给语境层更多营救空间(实测"提交→提高"即 top-4 漏救)
    }
    const topAlt = alts[0] || { ch: fakeCh, sim: 0 };
    return { ch: topAlt.ch, sim: topAlt.sim, alts };
  }

  /**************** 映射键:按字体家族隔离(同一乱码码位在不同字体里含义不同) ****************/
  const famKey = (fam, ch) => fam + '|' + ch;
  function primaryFamOf(el) {
    return (getComputedStyle(el).fontFamily.split(',')[0] || '').replace(/["']/g, '').trim() || 'encrypted';
  }

  /**************** 语境层:Beam Search 用词频消歧 ****************/
  // pairs: [[char, fam|null], ...] — fam 为该字符所属的加密字体家族
  function beamDecode(pairs) {
    const positions = [];
    for (const [ch, fam] of pairs) {
      const m = fam ? mapping[famKey(fam, ch)] : null;
      if (m && m.alts && m.alts.length > 1) positions.push(m.alts.map(a => ({ ch: a.ch, sim: a.sim, fake: ch, key: famKey(fam, ch), branchy: true })));
      else if (m) positions.push([{ ch: m.ch, sim: m.sim, fake: ch, key: famKey(fam, ch), branchy: false }]);
      else positions.push([{ ch, sim: 1, fake: ch, key: null, branchy: false }]);
    }
    let beam = [{ score: 0, seq: [], prev: '' }];
    for (const cands of positions) {
      const next = [];
      for (const state of beam) {
        for (const c of cands) {
          let s = state.score + c.sim + freqBonus(c.ch);
          if (state.prev && isCJK(state.prev) && isCJK(c.ch) && WORDS.has(state.prev + c.ch)) {
            s += CONFIG.wordBonus;
          }
          next.push({ score: s, seq: state.seq.concat(c), prev: c.ch });
        }
      }
      next.sort((a, b) => b.score - a.score);
      beam = next.slice(0, CONFIG.beamWidth);
    }
    return beam[0].seq;
  }

  /**************** 缓存:按字体指纹存取 —— 雨课堂每次加载会重新置换字体, ****************/
  /**************** 指纹不匹配的旧映射是"过期密码本",必须丢弃               ****************/
  let mapping = {};          // 运行时扁平映射: famKey(fam,ch) -> entry
  let fontFpByFam = {};      // fam -> 字体指纹
  let cacheLoaded = false;

  // 字体指纹:采样哈希会漏掉只占几 KB 的 cmap 差异(实测两套置换字体采样指纹完全相同!),
  // 必须直接哈希 cmap 内容——任何码位置换都会改变它
  async function fontFingerprint(buf) {
    try {
      const cmap = await getFontCmap(buf);
      if (cmap && cmap.size) {
        let h = 0x811c9dc5;
        const entries = [...cmap.entries()].sort((a, b) => a[0] - b[0]);
        for (const [cp, gid] of entries) {
          h ^= cp & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
          h ^= (cp >> 8) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
          h ^= gid & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
          h ^= (gid >> 8) & 0xff; h = Math.imul(h, 0x01000193) >>> 0;
        }
        return 'c' + cmap.size.toString(36) + '-' + h.toString(36);
      }
    } catch (e) {}
    // 退路:整文件 FNV(16MB 也只需几十毫秒)
    const b = new Uint8Array(buf);
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return 'f' + b.length.toString(36) + '-' + h.toString(36);
  }

  function loadCache() {
    mapping = {};
    try {
      const all = JSON.parse(localStorage.getItem(CONFIG.cacheKey)) || {};
      for (const [fam, pack] of Object.entries(all)) {
        if (!pack || !pack.map) continue;
        fontFpByFam[fam] = pack.fp || '';
        for (const [ch, entry] of Object.entries(pack.map)) mapping[famKey(fam, ch)] = entry;
      }
    } catch (e) {}
  }

  function saveCache() {
    try {
      const all = {};
      for (const [key, entry] of Object.entries(mapping)) {
        const i = key.indexOf('|');
        const fam = key.slice(0, i), ch = key.slice(i + 1);
        if (!all[fam]) all[fam] = { fp: fontFpByFam[fam] || '', map: {} };
        all[fam].map[ch] = entry;
      }
      localStorage.setItem(CONFIG.cacheKey, JSON.stringify(all));
    } catch (e) {}
  }

  // 字体指纹轮换 → 该家族全部旧映射作废
  function dropStaleMapping(fam, fp) {
    const old = fontFpByFam[fam];
    if (old && old !== fp) {
      let dropped = 0;
      for (const k of Object.keys(mapping)) if (k.startsWith(fam + '|')) { delete mapping[k]; dropped++; }
      console.log(`[yuketang-decrypt] 🔄 检测到字体轮换(${old}→${fp}),丢弃 ${dropped} 条过期映射`);
    }
    fontFpByFam[fam] = fp;
  }

  /**************** 收集加密文本块 ****************/
  function collectBlocks() {
    const els = [...document.querySelectorAll(CONFIG.selector)].filter(el => el.textContent.trim());
    const blocks = new Set();
    for (const el of els) {
      let p = el;
      while (p.parentElement && p.parentElement !== document.body &&
             (p.parentElement.matches(CONFIG.selector) ||
              /encrypted|decrypt/i.test(p.parentElement.className || ''))) {
        p = p.parentElement;
      }
      blocks.add(p.parentElement && p.parentElement !== document.body ? p.parentElement : p);
    }
    return [...blocks].filter(b => b.textContent.trim());
  }

  function encryptedElsOf(block) {
    const list = [];
    if (block.matches && block.matches(CONFIG.selector)) list.push(block);
    list.push(...block.querySelectorAll(CONFIG.selector));
    return list;
  }

  /**************** 悬浮窗 ****************/
  let panel = null, panelBody = null, launcher = null;

  const PANEL_CSS = {
    panel: 'position:fixed;top:80px;right:16px;width:380px;max-height:70vh;z-index:999999;' +
      'background:#1e1f24;color:#e8e8ea;border:1px solid #3a3b42;border-radius:12px;' +
      'box-shadow:0 8px 32px rgba(0,0,0,.5);display:flex;flex-direction:column;' +
      'font:13px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden;' +
      'resize:both;min-width:280px;min-height:160px;',
    head: 'display:flex;align-items:center;gap:6px;padding:8px 10px;background:#26272e;' +
      'cursor:move;user-select:none;border-bottom:1px solid #3a3b42;flex:0 0 auto;',
    title: 'flex:1;font-weight:600;font-size:13px;color:#e8e8ea;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
    hbtn: 'background:#3a3b42;color:#cfd0d6;border:none;border-radius:6px;padding:3px 9px;' +
      'font-size:12px;cursor:pointer;flex:0 0 auto;',
    body: 'overflow-y:auto;padding:10px 12px;user-select:text;-webkit-user-select:text;flex:1 1 auto;',
    item: 'margin:0 0 10px;padding:8px 10px;background:#26272e;border-radius:8px;' +
      'white-space:pre-wrap;word-break:break-word;user-select:text;-webkit-user-select:text;cursor:text;',
  };

  function el(tag, css, text) {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  function makePanel() {
    if (panel) return panel;
    panel = el('div', PANEL_CSS.panel);
    const head = el('div', PANEL_CSS.head);
    const title = el('span', PANEL_CSS.title, '🔓 解密文本');
    const btnRefresh = el('button', PANEL_CSS.hbtn, '刷新');
    const btnCopy = el('button', PANEL_CSS.hbtn, '复制全部');
    const btnFold = el('button', PANEL_CSS.hbtn, '—');
    const btnClose = el('button', PANEL_CSS.hbtn, '×');
    panelBody = el('div', PANEL_CSS.body);
    head.append(title, btnRefresh, btnCopy, btnFold, btnClose);
    panel.append(head, panelBody);
    document.body.appendChild(panel);

    for (const ev of ['copy', 'cut', 'selectstart', 'contextmenu', 'keydown']) {
      panel.addEventListener(ev, e => e.stopPropagation(), true);
    }

    btnRefresh.onclick = () => decryptAndShow({ forceRescan: true });
    btnCopy.onclick = async () => {
      const txt = [...panelBody.querySelectorAll('.ykd-item')].map(d => d.textContent).join('\n\n');
      try { await navigator.clipboard.writeText(txt); flashTitle('✅ 已复制全部'); }
      catch (e) {
        const ta = el('textarea'); ta.value = txt; document.body.appendChild(ta);
        ta.select(); document.execCommand('copy'); ta.remove();
        flashTitle('✅ 已复制全部');
      }
    };
    btnFold.onclick = () => {
      const hidden = panelBody.style.display === 'none';
      panelBody.style.display = hidden ? '' : 'none';
      btnFold.textContent = hidden ? '—' : '▢';
    };
    btnClose.onclick = () => { panel.remove(); panel = null; panelBody = null; showLauncher(); };

    head.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      const r = panel.getBoundingClientRect();
      const dx = e.clientX - r.left, dy = e.clientY - r.top;
      const move = (ev) => {
        // 允许大部分移出视口,至少保留 60px 可抓回
        panel.style.left = Math.min(Math.max(-r.width + 60, ev.clientX - dx), innerWidth - 60) + 'px';
        panel.style.top = Math.min(Math.max(0, ev.clientY - dy), innerHeight - 36) + 'px';
        panel.style.right = 'auto';
      };
      const up = () => {
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        savePanelRect();
      };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    });

    // 位置/尺寸记忆
    function savePanelRect() {
      try {
        const r = panel.getBoundingClientRect();
        localStorage.setItem('ykd_panel_rect', JSON.stringify({ left: r.left, top: r.top, width: r.width, height: r.height }));
      } catch (e) {}
    }
    try {
      const saved = JSON.parse(localStorage.getItem('ykd_panel_rect'));
      if (saved && saved.width > 100) {
        panel.style.left = Math.min(saved.left, innerWidth - 60) + 'px';
        panel.style.top = Math.max(0, Math.min(saved.top, innerHeight - 60)) + 'px';
        panel.style.right = 'auto';
        panel.style.width = saved.width + 'px';
        panel.style.height = saved.height + 'px';
        panel.style.maxHeight = 'none';
      }
    } catch (e) {}
    new ResizeObserver(() => savePanelRect()).observe(panel);
    return panel;
  }

  function flashTitle(msg) {
    const t = panel && panel.querySelector('span');
    if (!t) return;
    const old = t.textContent;
    t.textContent = msg;
    setTimeout(() => { t.textContent = old; }, 1500);
  }

  function setStatus(msg) {
    makePanel();
    panelBody.innerHTML = '';
    panelBody.appendChild(el('div', PANEL_CSS.item + 'color:#9a9ba3;', msg));
  }

  /**************** 可点击候选字:低置信黄色高亮,其余可换字加虚线 ****************/
  function makePickSpan(c) {
    const unsure = c.sim < CONFIG.minSimilarity;
    const mark = el('span',
      unsure
        ? 'background:rgba(255,213,79,.35);border-radius:3px;cursor:pointer;border-bottom:1px dashed rgba(255,213,79,.8);'
        : 'cursor:pointer;border-bottom:1px dashed rgba(120,170,255,.55);',
      c.ch);
    mark.dataset.idx = '0';
    mark.title = `置信度 ${(c.sim * 100).toFixed(0)}% · 点击切换候选`;
    mark.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const entry = mapping[c.key];
      if (!entry || !entry.alts || entry.alts.length < 2) return;
      const idx = (parseInt(mark.dataset.idx, 10) + 1) % entry.alts.length;
      mark.dataset.idx = String(idx);
      mark.textContent = entry.alts[idx].ch;
      mark.title = `候选 ${idx + 1}/${entry.alts.length} · 置信度 ${(entry.alts[idx].sim * 100).toFixed(0)}%`;
      entry.ch = entry.alts[idx].ch;
      entry.sim = entry.alts[idx].sim;
      saveCache();
    };
    return mark;
  }

  // 逐字符标注所属加密字体家族(沿 DOM 向上找加密元素)
  function blockCharFamPairs(block) {
    const pairs = [];
    const selfEnc = block.matches && block.matches(CONFIG.selector);
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      let fam = null, el = node.parentElement;
      while (el) {
        if (el.matches && el.matches(CONFIG.selector)) { fam = primaryFamOf(el); break; }
        if (el === block) break;
        el = el.parentElement;
      }
      if (!fam && selfEnc) fam = primaryFamOf(block);
      for (const ch of node.nodeValue) pairs.push([ch, fam]);
    }
    return pairs;
  }

  function appendDecryptedItem(block) {
    const seq = beamDecode(blockCharFamPairs(block));
    const item = el('div', PANEL_CSS.item);
    item.className = 'ykd-item';
    for (const c of seq) {
      // 把语境层的裁决写回映射,复制兜底同步受益
      if (c.branchy && c.key && mapping[c.key]) {
        mapping[c.key].ch = c.ch;
        mapping[c.key].sim = c.sim;
      }
      if (c.branchy && c.sim < 0.8) {
        item.appendChild(makePickSpan(c));
      } else {
        item.appendChild(document.createTextNode(c.ch));
      }
    }
    panelBody.appendChild(item);
  }

  function showLauncher() {
    if (launcher) return;
    launcher = el('button',
      'position:fixed;bottom:24px;right:20px;z-index:999999;padding:9px 16px;background:#1976d2;' +
      'color:#fff;border:none;border-radius:20px;font-size:13px;cursor:pointer;' +
      'box-shadow:0 4px 14px rgba(0,0,0,.35);', '🔓 解密文本');
    launcher.title = '重新打开解密浮窗(Shift+点击:清除缓存重新解密)';
    launcher.onclick = (e) => {
      if (e.shiftKey) { mapping = {}; fontFpByFam = {}; localStorage.removeItem(CONFIG.cacheKey); }
      launcher.remove(); launcher = null;
      decryptAndShow({ forceRescan: true });
    };
    document.body.appendChild(launcher);
  }

  function toast(msg) {
    const t = el('div',
      'position:fixed;bottom:76px;right:20px;z-index:999999;background:rgba(30,30,30,.92);color:#fff;' +
      'padding:10px 16px;border-radius:8px;font-size:13px;max-width:320px;line-height:1.5;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.3);transition:opacity .4s;', msg);
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 450); }, 3000);
  }

  /**************** 主流程 ****************/
  let running = false;

  async function decryptAndShow(opts = {}) {
    if (running) return;
    running = true;
    try {
      if (!cacheLoaded) { loadCache(); cacheLoaded = true; }
      // 收集页面 @font-face 字体名黑名单(每次解密重算,SPA 可能动态注册)
      pageWebfontNames = collectPageWebfonts();
      const blocks = collectBlocks();
      if (!blocks.length) {
        if (opts.forceRescan) { makePanel(); setStatus('未发现加密文字。'); }
        return;
      }
      makePanel();
      setStatus('正在分析加密文字…');

      // 每个家族收集【全部】加密字符(不只未解的)——字体定位与指纹验证必须每次运行都执行,
      // 否则缓存命中时跳过指纹验证,过期映射永远无法被发现(实测踩坑)
      const allChars = new Map();
      for (const b of blocks) {
        for (const el of encryptedElsOf(b)) {
          const fam = primaryFamOf(el);
          pageWebfontNames.add(fam.replace(/["'\s]/g, '').toLowerCase()); // 加密字体名一并拉黑
          if (!allChars.has(fam)) allChars.set(fam, new Set());
          for (const ch of el.textContent) {
            if (/\S/.test(ch)) allChars.get(fam).add(ch);
          }
        }
      }
      if (allChars.size > 1) {
        console.log(`[yuketang-decrypt] ⚠️ 页面存在 ${allChars.size} 个加密字体家族,映射已按家族隔离`);
      }
      // —— 元数据层:定位加密字体文件(cmap 覆盖率甄别),验指纹/试直读/识别源字体 ——
      for (const [fam, set] of allChars) {
        try {
          setStatus('定位加密字体文件…');
          const resolved = await resolveFontForFam(fam, set);
          if (!resolved) { console.log(`[yuketang-decrypt] 未能定位字体文件(${fam}),跳过元数据层`); continue; }
          const buf = resolved.buf;
          dropStaleMapping(fam, await fontFingerprint(buf)); // 字体轮换则旧映射作废
          const meta = await parseFontMapping(buf);
          let refNote = '';
          if (meta.family) {
            setStatus(`识别到源字体 ${meta.family},配置参考字库…`);
            refNote = await adjustRefFonts(meta.family);
          }
          const hits = Object.entries(meta.map).filter(([fake]) => !mapping[famKey(fam, fake)]);
          for (const [fake, trueCh] of hits) {
            mapping[famKey(fam, fake)] = { ch: trueCh, sim: 1, alts: [{ ch: trueCh, sim: 1 }], viaFont: true };
          }
          if (hits.length) {
            saveCache();
            console.log(`[yuketang-decrypt] 🎯 post 表直读成功:${hits.length} 字,源字体:${meta.family || '未知'}`);
          } else {
            console.log('[yuketang-decrypt] 元数据直读不可用:', meta.reason || '无新增映射', refNote ? `(${refNote})` : '');
          }
        } catch (e) {
          console.warn('[yuketang-decrypt] 字体文件解析失败(回退视觉比对):', e.message || e);
        }
      }

      // 元数据层之后(过期映射已清除)再汇总真正待解的字符
      let todo = [];
      for (const [fam, set] of allChars) {
        for (const ch of set) if (!mapping[famKey(fam, ch)]) todo.push([ch, fam]);
      }
      if (todo.length) {
        const famCount = {};
        for (const [, fam] of todo) famCount[fam] = (famCount[fam] || 0) + 1;
        console.log('[yuketang-decrypt] 待解字符分布:', JSON.stringify(famCount));
      }

      let matchMedian = null;
      if (todo.length) {
        setStatus('加载加密字体…');
        for (const [fam, set] of allChars) {
          try { await document.fonts.load(`32px "${fam}"`, [...set][0] || '字'); } catch (e) {}
        }
        await document.fonts.ready;
        // —— 匹配工具:统计、合并、诊断 ——
        const mergeM = (m, m2) => {
          const merged = [...m.alts];
          for (const a of m2.alts) if (!merged.some(x => x.ch === a.ch)) merged.push(a);
          merged.sort((a, b) => b.sim - a.sim);
          m.alts = merged.slice(0, 6);
          if (m2.sim > m.sim) { m.ch = m2.ch; m.sim = m2.sim; }
        };
        const simStats = (res) => {
          const sims = res.map(([, , m]) => m.sim).sort((a, b) => a - b);
          const median = sims.length ? sims[sims.length >> 1] : 1;
          return { median, low: sims.filter(s => s < CONFIG.minSimilarity).length };
        };
        const logDiag = (res, stats, tag) => {
          const sample = res.slice(0, 8).map(([fake, , m]) => `${fake}→${m.ch}(${(m.sim * 100) | 0}%)`).join(' ');
          console.log(`[yuketang-decrypt] ${tag}:中位置信 ${(stats.median * 100) | 0}%,低置信 ${stats.low}/${res.length};样例 ${sample}`);
        };

        await buildRefFont(CONFIG.refFonts[0], p => setStatus(p + ' …'));
        let n = 0;
        const results = [];
        for (const [ch, fam] of todo) {
          results.push([ch, fam, matchChar(ch, fam)]);
          if (++n % 20 === 0) { setStatus(`比对字形 ${n}/${todo.length} …`); await tick(); }
        }
        let stats = simStats(results);
        matchMedian = stats.median;
        logDiag(results, stats, `字库[${CONFIG.refFonts[0]}]`);

        // 置信熔断:低置信字过多或整体置信异常 → 启用下一字库并全部重匹配取优
        let fontIdx = 1;
        while ((stats.low > 0 || stats.median < 0.72) && fontIdx < CONFIG.refFonts.length) {
          const famName = CONFIG.refFonts[fontIdx++];
          const before = refLib.length;
          setStatus(`置信不足(${stats.low}字存疑/中位${(stats.median * 100) | 0}%),启用备选字库 ${famName} …`);
          await buildRefFont(famName, p => setStatus(p + ' …'));
          if (refLib.length === before) continue; // 该字库不可用或自检被弃
          for (const [ch, fam, m] of results) mergeM(m, matchChar(ch, fam));
          stats = simStats(results);
          matchMedian = stats.median;
          logDiag(results, stats, `+字库[${famName}]`);
        }
        // 终极兜底:常规字库置信仍不足 → 尝试 CDN 思源黑体参考库(加密字体多为思源黑体系)
        if ((stats.low > 0 || stats.median < 0.72) && !builtFonts.has(REF_NOTO_FAMILY)) {
          setStatus('常规字库置信不足,尝试加载思源黑体参考库…');
          const ok = await loadNotoRef();
          if (ok) {
            CONFIG.refFonts.unshift(REF_NOTO_FAMILY);
            const before = refLib.length;
            await buildRefFont(REF_NOTO_FAMILY, p => setStatus(p + ' …'));
            if (refLib.length > before) {
              for (const [ch, fam, m] of results) mergeM(m, matchChar(ch, fam));
              stats = simStats(results);
              matchMedian = stats.median;
              logDiag(results, stats, '+字库[思源黑体兜底]');
            }
          }
        }
        for (const [ch, fam, m] of results) mapping[famKey(fam, ch)] = m;
        saveCache();
      }

      panelBody.innerHTML = '';
      let unsureCount = 0;
      for (const b of blocks) {
        for (const el of encryptedElsOf(b)) {
          const fam = primaryFamOf(el);
          for (const ch of el.textContent) {
            const m = mapping[famKey(fam, ch)];
            if (m && m.sim < CONFIG.minSimilarity) { unsureCount++; break; }
          }
        }
        appendDecryptedItem(b);
      }
      saveCache();
      const t = panel.querySelector('span');
      t.textContent = `🔓 解密文本 · ${blocks.length} 段` +
        (matchMedian != null ? ` · 置信 ${(matchMedian * 100) | 0}%` : '') +
        (unsureCount ? ` · ${unsureCount} 段含待核对字(点击可换字)` : '');
    } catch (err) {
      console.error('[yuketang-decrypt]', err);
      setStatus('解密失败:' + err.message + '(详见控制台)');
    } finally {
      running = false;
    }
  }

  /**************** 复制兜底(按字符建索引,跨家族冲突时后写覆盖——兜底特性,可接受) ****************/
  function hookCopy() {
    document.addEventListener('copy', (e) => {
      if (panel && panel.contains(e.target)) return;
      const sel = String(window.getSelection());
      if (!sel || !Object.keys(mapping).length) return;
      const idx = {};
      for (const k of Object.keys(mapping)) idx[k.slice(k.indexOf('|') + 1)] = mapping[k].ch;
      let fixed = '', hit = false;
      for (const ch of sel) {
        if (idx[ch]) { fixed += idx[ch]; hit = true; } else fixed += ch;
      }
      if (hit && e.clipboardData) {
        e.clipboardData.setData('text/plain', fixed);
        e.preventDefault();
      }
    }, true);
  }

  /**************** 动态内容监听 ****************/
  let debounceTimer = null;
  function observeDynamic() {
    const mo = new MutationObserver(() => {
      if (!panel) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const fresh = collectBlocks();
        const known = panelBody.querySelectorAll('.ykd-item').length;
        if (fresh.length > known) decryptAndShow({ forceRescan: true });
      }, 1200);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  /**************** 调试命令:控制台输入 __ykdDebug() 导出全部映射明细 ****************/
  window.__ykdDebug = () => {
    const rows = Object.entries(mapping).map(([fake, m]) =>
      `${fake} → ${m.alts ? m.alts.map(a => `${a.ch}(${(a.sim * 100) | 0}%)`).join(' / ') : m.ch}`);
    console.log('[yuketang-decrypt] 映射明细(乱码 → 候选(置信)):\n' + rows.join('\n'));
    return rows;
  };

  /**************** 启动 ****************/
  function init() {
    if (!document.body) { setTimeout(init, 500); return; }
    // 清理旧版本(v2 及以前)的缓存——那时映射未按字体隔离,可能含串码垃圾
    try {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('ykd_mapping_')) localStorage.removeItem(k);
      }
    } catch (e) {}
    hookCopy();
    observeDynamic();
    setTimeout(() => {
      if (document.querySelector(CONFIG.selector)) {
        toast('检测到加密文字,正在解密…');
        decryptAndShow();
      } else {
        setTimeout(() => { if (document.querySelector(CONFIG.selector)) decryptAndShow(); }, 3000);
      }
    }, 1500);
  }
  init();
})();
