// ==UserScript==
// @name         聚水潭订单列表 当前+归档 合并
// @namespace    jstyh.erp321.order.merge
// @version      1.2.0
// @description  拦截订单 LoadDataToJSON，并行请求归档列表，按 o_id 去重合并后返回页面
// @author       jstyh
// @match        https://www.erp321.com/*
// @match        https://*.erp321.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/**
 * 真实流量差异（其余 header/body 相同）：
 *
 * 当前:
 *   /app/order/order/list.aspx?_c=jst-epaas&epaas=true&ts___=...&am___=LoadDataToJSON
 *   Referer: .../list.aspx?_c=jst-epaas&epaas=true
 *
 * 归档:
 *   /app/order/order/list.aspx?archive=true&no_data=true&_c=jst-epaas&epaas=true&ts___=...&am___=LoadDataToJSON
 *   Referer: .../list.aspx?archive=true&no_data=true&_c=jst-epaas&epaas=true
 *
 * Body: application/x-www-form-urlencoded
 *   __VIEWSTATE / __CALLBACKID=JTable1 / __CALLBACKPARAM={Method:LoadDataToJSON,...}
 *   分页增量键: _jt_page_increament_key_name=o_id
 */
(function () {
  'use strict';

  const CFG = {
    pathIncludes: '/app/order/order/list.aspx',
    // 去重：页面增量键就是 o_id
    idKeys: ['o_id', 'so_id', 'order_id', 'id'],
    // JTable 常见数据路径
    listPaths: [
      ['datas'],
      ['data'],
      ['dp', 'data'],
      ['dp', 'datas'],
      ['ReturnValue', 'datas'],
      ['ReturnValue', 'data'],
      ['ReturnValue', 'dp', 'data'],
      ['d', 'datas'],
      ['d', 'data'],
    ],
    countPaths: [
      ['dataCount'],
      ['datacount'],
      ['dp', 'dataCount'],
      ['dp', 'datacount'],
      ['ReturnValue', 'dataCount'],
      ['ReturnValue', 'dp', 'dataCount'],
    ],
    log: true,
  };

  const log = (...a) => CFG.log && console.log('[订单合并]', ...a);

  // ---------- URL ----------
  function absUrl(url) {
    return new URL(url, location.origin);
  }

  /** 当前列表（非归档）的 LoadDataToJSON */
  function isCurrentLoadDataUrl(url) {
    try {
      const u = absUrl(url);
      if (!u.pathname.includes(CFG.pathIncludes)) return false;
      if (u.searchParams.get('archive') === 'true') return false;
      // URL 带 am___=LoadDataToJSON，或后续靠 body 再确认
      const am = u.searchParams.get('am___');
      if (am && am !== 'LoadDataToJSON') return false;
      return true;
    } catch {
      return false;
    }
  }

  /** body 里必须是 JTable LoadDataToJSON，避免误拦同页其它回调 */
  function isLoadDataBody(body) {
    if (body == null) return false;
    const s = typeof body === 'string' ? body : String(body);
    return (
      s.includes('LoadDataToJSON') ||
      s.includes('Method%22%3A%22LoadDataToJSON') ||
      s.includes('Method":"LoadDataToJSON')
    );
  }

  function toArchiveUrl(url) {
    const u = absUrl(url);
    // 与抓包一致：archive / no_data 放在最前也可，顺序不影响
    u.searchParams.set('archive', 'true');
    u.searchParams.set('no_data', 'true');
    if (u.searchParams.has('ts___')) {
      u.searchParams.set('ts___', String(Date.now()));
    }
    return u.toString();
  }

  function toArchiveReferer(url) {
    const u = absUrl(url);
    u.searchParams.set('archive', 'true');
    u.searchParams.set('no_data', 'true');
    // referer 不带 ts___ / am___
    u.searchParams.delete('ts___');
    u.searchParams.delete('am___');
    return u.toString();
  }

  // ---------- 解析 ASP.NET 回调 / JSON ----------
  /**
   * 拆回调外壳，保留前缀以便写回页面。
   * 常见：纯 JSON  或  0|{...}  或  0|#|...（失败时）
   */
  function unwrapPayload(raw) {
    const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '');
    if (!text) return { prefix: '', jsonText: '', obj: null };

    // 纯 JSON
    if (text[0] === '{' || text[0] === '[') {
      const obj = safeJson(text);
      return { prefix: '', jsonText: text, obj };
    }

    // n|{json}
    const pipe = text.indexOf('|');
    if (pipe > 0 && pipe < 8 && /^\d+$/.test(text.slice(0, pipe))) {
      const prefix = text.slice(0, pipe + 1);
      const rest = text.slice(pipe + 1);
      if (rest[0] === '{' || rest[0] === '[') {
        return { prefix, jsonText: rest, obj: safeJson(rest) };
      }
      // 非 JSON 回调结果，不合并
      return { prefix, jsonText: rest, obj: null };
    }

    return { prefix: '', jsonText: text, obj: safeJson(text) };
  }

  function safeJson(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  function getByPath(obj, path) {
    let cur = obj;
    for (const k of path) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[k];
    }
    return cur;
  }

  function setByPath(obj, path, value) {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i];
      if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
      cur = cur[k];
    }
    cur[path[path.length - 1]] = value;
  }

  /** ReturnValue 有时是 JSON 字符串，展开后再找列表 */
  function normalizeRoot(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (typeof obj.ReturnValue === 'string') {
      const inner = safeJson(obj.ReturnValue);
      if (inner && typeof inner === 'object') {
        // 不破坏外层字段，挂一个解析结果供查找；写回时再序列化
        obj = { ...obj, __rvObj: inner };
      }
    }
    return obj;
  }

  function findListMeta(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const roots = [obj];
    if (obj.__rvObj) roots.push(obj.__rvObj);
    if (typeof obj.ReturnValue === 'object' && obj.ReturnValue) {
      roots.push(obj.ReturnValue);
    }

    for (const root of roots) {
      for (const path of CFG.listPaths) {
        const val = getByPath(root, path);
        if (Array.isArray(val)) {
          return { root, path, list: val, isRv: root === obj.__rvObj };
        }
      }
      if (Array.isArray(root)) {
        return { root, path: null, list: root, isRv: false };
      }
    }
    return null;
  }

  function findCountPath(root) {
    if (!root || typeof root !== 'object') return null;
    for (const path of CFG.countPaths) {
      const val = getByPath(root, path);
      if (
        typeof val === 'number' ||
        (typeof val === 'string' && val !== '' && !Number.isNaN(Number(val)))
      ) {
        return path;
      }
    }
    return null;
  }

  function rowKey(row) {
    if (row == null || typeof row !== 'object') return `raw:${row}`;
    for (const k of CFG.idKeys) {
      if (row[k] != null && row[k] !== '') return `${k}:${row[k]}`;
    }
    try {
      return `json:${JSON.stringify(row)}`;
    } catch {
      return `rnd:${Math.random()}`;
    }
  }

  function mergeLists(a, b) {
    const seen = new Set();
    const out = [];
    let added = 0;
    for (const row of a) {
      const k = rowKey(row);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(row);
    }
    for (const row of b) {
      const k = rowKey(row);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(row);
      added++;
    }
    return { list: out, added };
  }

  /**
   * 合并两路响应文本，保留当前响应的回调前缀（如 "0|"）
   */
  function mergeResponses(currentRaw, archiveRaw) {
    const curWrap = unwrapPayload(currentRaw);
    const arcWrap = unwrapPayload(archiveRaw);

    if (!curWrap.obj) {
      log('当前响应无法解析 JSON，原样返回。预览:', String(currentRaw).slice(0, 120));
      return String(currentRaw);
    }
    if (!arcWrap.obj) {
      log('归档响应无法解析 JSON，仅返回当前');
      return String(currentRaw);
    }

    let curObj = normalizeRoot(curWrap.obj);
    let arcObj = normalizeRoot(arcWrap.obj);

    const curMeta = findListMeta(curObj);
    const arcMeta = findListMeta(arcObj);

    if (!curMeta && !arcMeta) {
      log('未找到 datas/dp.data 等数组字段。当前 keys:', Object.keys(curObj));
      return String(currentRaw);
    }

    const curList = curMeta ? curMeta.list : [];
    const arcList = arcMeta ? arcMeta.list : [];
    const { list: merged, added } = mergeLists(curList, arcList);

    // 写回：优先写当前结构
    let writeRoot = curObj;
    let writePath = curMeta && curMeta.path;

    if (curMeta && curMeta.isRv) {
      // 列表在 ReturnValue 字符串内部
      writeRoot = curObj.__rvObj;
      writePath = curMeta.path;
      if (writePath) setByPath(writeRoot, writePath, merged);
      const cPath = findCountPath(writeRoot);
      if (cPath) setByPath(writeRoot, cPath, merged.length);
      else writeRoot.dataCount = merged.length;
      curObj.ReturnValue = JSON.stringify(writeRoot);
      delete curObj.__rvObj;
    } else if (curMeta && writePath) {
      setByPath(curObj, writePath, merged);
      const cPath = findCountPath(curObj);
      if (cPath) setByPath(curObj, cPath, merged.length);
      else if (!Array.isArray(curObj)) curObj.dataCount = merged.length;
      delete curObj.__rvObj;
    } else if (Array.isArray(curObj)) {
      curObj = merged;
    } else if (arcMeta && arcMeta.path) {
      // 当前无数据、归档有
      setByPath(curObj, arcMeta.path, merged);
      curObj.dataCount = merged.length;
      delete curObj.__rvObj;
    } else {
      curObj.datas = merged;
      curObj.dataCount = merged.length;
      delete curObj.__rvObj;
    }

    const jsonText = JSON.stringify(curObj);
    log(
      `合并完成：当前 ${curList.length} + 归档新增 ${added} = ${merged.length}`,
      curWrap.prefix ? `(前缀 ${JSON.stringify(curWrap.prefix)})` : ''
    );
    return curWrap.prefix + jsonText;
  }

  // ---------- 请求 ----------
  function headersToObject(headers) {
    if (!headers) return {};
    const skip = (k) => {
      const l = String(k).toLowerCase();
      return l === 'content-length' || l === 'host' || l === 'cookie';
    };
    const o = {};
    if (headers instanceof Headers) {
      headers.forEach((v, k) => {
        if (!skip(k)) o[k] = v;
      });
      return o;
    }
    if (Array.isArray(headers)) {
      headers.forEach(([k, v]) => {
        if (!skip(k)) o[k] = v;
      });
      return o;
    }
    if (typeof headers === 'object') {
      Object.keys(headers).forEach((k) => {
        if (!skip(k)) o[k] = headers[k];
      });
    }
    return o;
  }

  /** 归档请求：body 原样，只改 URL + Referer */
  function buildArchiveHeaders(baseHeaders, requestUrl) {
    const h = { ...headersToObject(baseHeaders) };
    // 抓包里归档 referer 带 archive/no_data
    h.Referer = toArchiveReferer(requestUrl);
    // 保证表单 POST 头
    if (!h['Content-Type'] && !h['content-type']) {
      h['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    }
    if (!h['X-Requested-With'] && !h['x-requested-with']) {
      h['X-Requested-With'] = 'XMLHttpRequest';
    }
    return h;
  }

  const XHR = XMLHttpRequest.prototype;
  const rawOpen = XHR.open;
  const rawSend = XHR.send;
  const rawSetRequestHeader = XHR.setRequestHeader;

  function nativeXhrText(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      const n = new XMLHttpRequest();
      rawOpen.call(n, method, url, true);
      Object.entries(headers || {}).forEach(([k, v]) => {
        try {
          rawSetRequestHeader.call(n, k, v);
        } catch (_) {}
      });
      n.onload = () =>
        resolve({
          status: n.status,
          statusText: n.statusText,
          text: n.responseText,
        });
      n.onerror = () => reject(new Error('xhr network error'));
      n.ontimeout = () => reject(new Error('xhr timeout'));
      rawSend.call(n, body);
    });
  }

  async function loadBoth(method, url, headers, body) {
    const archiveUrl = toArchiveUrl(url);
    const curHeaders = headersToObject(headers);
    const arcHeaders = buildArchiveHeaders(headers, url);

    log('当前', method, url);
    log('归档', method, archiveUrl);

    const [cur, arc] = await Promise.all([
      nativeXhrText(method, url, curHeaders, body),
      nativeXhrText(method, archiveUrl, arcHeaders, body).catch((e) => {
        log('归档失败，仅用当前', e);
        return null;
      }),
    ]);

    if (!arc || arc.status >= 400) {
      log('归档无效 status=', arc && arc.status);
      return cur;
    }

    return {
      status: cur.status,
      statusText: cur.statusText,
      text: mergeResponses(cur.text, arc.text),
    };
  }

  function paintXhrSuccess(xhr, pack) {
    const text = pack.text;
    Object.defineProperty(xhr, 'readyState', { configurable: true, get: () => 4 });
    Object.defineProperty(xhr, 'status', {
      configurable: true,
      get: () => pack.status || 200,
    });
    Object.defineProperty(xhr, 'statusText', {
      configurable: true,
      get: () => pack.statusText || 'OK',
    });
    Object.defineProperty(xhr, 'responseText', {
      configurable: true,
      get: () => text,
    });
    Object.defineProperty(xhr, 'response', {
      configurable: true,
      get: () => {
        if ((xhr.responseType || '') === 'json') {
          const w = unwrapPayload(text);
          return w.obj != null ? w.obj : safeJson(text);
        }
        return text;
      },
    });

    if (typeof xhr.onreadystatechange === 'function') {
      try {
        xhr.onreadystatechange(new Event('readystatechange'));
      } catch (_) {}
    }
    try {
      xhr.dispatchEvent(new Event('readystatechange'));
    } catch (_) {}
    if (typeof xhr.onload === 'function') {
      try {
        xhr.onload(new Event('load'));
      } catch (_) {}
    }
    try {
      xhr.dispatchEvent(new Event('load'));
      xhr.dispatchEvent(new Event('loadend'));
    } catch (_) {}
  }

  function paintXhrError(xhr, err) {
    log('失败', err);
    Object.defineProperty(xhr, 'readyState', { configurable: true, get: () => 4 });
    Object.defineProperty(xhr, 'status', { configurable: true, get: () => 0 });
    if (typeof xhr.onerror === 'function') {
      try {
        xhr.onerror(new Event('error'));
      } catch (_) {}
    }
    try {
      xhr.dispatchEvent(new Event('error'));
      xhr.dispatchEvent(new Event('loadend'));
    } catch (_) {}
  }

  // ---------- hook XHR（抓包是 XHR） ----------
  XHR.open = function (method, url) {
    this.__merge = {
      method: (method || 'GET').toUpperCase(),
      url: typeof url === 'string' ? url : String(url),
      headers: {},
      maybe: isCurrentLoadDataUrl(url),
    };
    return rawOpen.apply(this, arguments);
  };

  XHR.setRequestHeader = function (k, v) {
    if (this.__merge) this.__merge.headers[k] = v;
    return rawSetRequestHeader.apply(this, arguments);
  };

  XHR.send = function (body) {
    const meta = this.__merge;
    const hit =
      meta &&
      meta.maybe &&
      (isLoadDataBody(body) ||
        absUrl(meta.url).searchParams.get('am___') === 'LoadDataToJSON');

    if (!hit) return rawSend.apply(this, arguments);

    const xhr = this;
    log('拦截 XHR LoadDataToJSON');

    (async () => {
      try {
        const pack = await loadBoth(meta.method, meta.url, meta.headers, body);
        paintXhrSuccess(xhr, pack);
      } catch (e) {
        paintXhrError(xhr, e);
      }
    })();
  };

  // ---------- hook fetch（兜底） ----------
  const rawFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input && input.url;
    if (!url || !isCurrentLoadDataUrl(url)) return rawFetch(input, init);

    const method = (
      (init && init.method) ||
      (typeof input === 'object' && input.method) ||
      'GET'
    ).toUpperCase();

    let body = init && init.body;
    if (body == null && typeof input === 'object' && input.clone) {
      try {
        body = await input.clone().text();
      } catch {
        body = undefined;
      }
    }

    if (
      !isLoadDataBody(body) &&
      absUrl(url).searchParams.get('am___') !== 'LoadDataToJSON'
    ) {
      return rawFetch(input, init);
    }

    log('拦截 fetch LoadDataToJSON');
    try {
      const headers = headersToObject(
        (init && init.headers) || (typeof input === 'object' && input.headers)
      );
      const pack = await loadBoth(method, url, headers, body);
      return new Response(pack.text, {
        status: pack.status || 200,
        statusText: pack.statusText || 'OK',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    } catch (e) {
      log('fetch 合并失败，回退', e);
      return rawFetch(input, init);
    }
  };

  log('已注入 v1.2.0 — 拦截当前列表并合并归档');
})();