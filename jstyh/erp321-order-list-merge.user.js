// ==UserScript==
// @name         聚水潭订单列表 当前+归档 合并
// @namespace    jstyh.erp321.order.merge
// @version      1.3.0
// @description  拦截订单 LoadDataToJSON，并行请求归档，按 o_id 去重合并 datas 后返回
// @author       jstyh
// @match        https://www.erp321.com/*
// @match        https://*.erp321.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

/**
 * 请求差异（body 完全相同，仅 URL/Referer）：
 *   当前: .../list.aspx?_c=jst-epaas&epaas=true&ts___=...&am___=LoadDataToJSON
 *   归档: .../list.aspx?archive=true&no_data=true&_c=jst-epaas&epaas=true&ts___=...&am___=LoadDataToJSON
 *
 * 响应结构（已实测）：
 *   0|{"IsSuccess":true,"ReturnValue":"{\"dp\":{...},\"datas\":[...]}",...}
 *                    └─ ReturnValue 是 JSON 字符串，内含 dp + datas
 *   去重键: datas[].o_id（与 dp.Increament.KeyName 一致）
 */
(function () {
  'use strict';

  const CFG = {
    pathIncludes: '/app/order/order/list.aspx',
    log: true,
  };

  const log = (...a) => CFG.log && console.log('[订单合并]', ...a);

  // ==================== URL ====================
  function absUrl(url) {
    return new URL(url, location.origin);
  }

  function isCurrentLoadDataUrl(url) {
    try {
      const u = absUrl(url);
      if (!u.pathname.includes(CFG.pathIncludes)) return false;
      if (u.searchParams.get('archive') === 'true') return false;
      const am = u.searchParams.get('am___');
      if (am && am !== 'LoadDataToJSON') return false;
      return true;
    } catch {
      return false;
    }
  }

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
    u.searchParams.delete('ts___');
    u.searchParams.delete('am___');
    return u.toString();
  }

  // ==================== 解析 / 合并 ====================
  function safeJson(s) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  /**
   * 拆 "0|{...}" 外壳
   * @returns {{ prefix: string, envelope: object|null }}
   */
  function parseEnvelope(raw) {
    const text = String(raw == null ? '' : raw).replace(/^\uFEFF/, '');
    if (!text) return { prefix: '', envelope: null };

    let prefix = '';
    let jsonText = text;

    // 0|{json}
    const pipe = text.indexOf('|');
    if (pipe > 0 && pipe < 8 && /^\d+$/.test(text.slice(0, pipe))) {
      prefix = text.slice(0, pipe + 1);
      jsonText = text.slice(pipe + 1);
    }

    const envelope = safeJson(jsonText);
    return { prefix, envelope };
  }

  /**
   * 从 envelope 取出表格负载 { dp, datas }
   * ReturnValue 实测是 JSON 字符串
   */
  function getTablePayload(envelope) {
    if (!envelope || typeof envelope !== 'object') return null;

    let rv = envelope.ReturnValue;
    if (typeof rv === 'string') {
      rv = safeJson(rv);
    }
    if (!rv || typeof rv !== 'object') return null;
    if (!Array.isArray(rv.datas)) {
      // 兼容偶发空数据
      if (rv.datas == null) rv.datas = [];
      else return null;
    }
    return rv;
  }

  /** 按 o_id 去重合并，当前优先 */
  function mergeDatas(curDatas, arcDatas) {
    const seen = new Set();
    const out = [];
    let added = 0;

    const push = (row, fromArc) => {
      if (!row || typeof row !== 'object') return;
      const id = row.o_id;
      const key = id != null && id !== '' ? `o_id:${id}` : `json:${JSON.stringify(row)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(row);
      if (fromArc) added++;
    };

    (curDatas || []).forEach((r) => push(r, false));
    (arcDatas || []).forEach((r) => push(r, true));
    return { list: out, added };
  }

  /** 更新 dp.Increament.KeyValue 为列表中最小 o_id（增量分页） */
  function patchDp(dp, datas) {
    if (!dp || typeof dp !== 'object') return dp;
    const next = { ...dp };
    // 原接口 DataCount 常为 -1，保持不动，避免误导分页 UI
    if (next.Increament && typeof next.Increament === 'object') {
      const ids = (datas || [])
        .map((r) => r && r.o_id)
        .filter((v) => v != null && v !== '')
        .map(Number)
        .filter((n) => !Number.isNaN(n));
      if (ids.length) {
        next.Increament = {
          ...next.Increament,
          KeyName: next.Increament.KeyName || 'o_id',
          KeyValue: String(Math.min(...ids)),
        };
      }
    }
    return next;
  }

  /**
   * 合并两路完整响应文本 → 写回同结构字符串
   */
  function mergeResponses(currentRaw, archiveRaw) {
    const cur = parseEnvelope(currentRaw);
    const arc = parseEnvelope(archiveRaw);

    if (!cur.envelope) {
      log('当前响应解析失败，原样返回。预览:', String(currentRaw).slice(0, 160));
      return String(currentRaw);
    }

    const curTable = getTablePayload(cur.envelope);
    if (!curTable) {
      log('当前无 ReturnValue.datas，原样返回。keys:', Object.keys(cur.envelope));
      return String(currentRaw);
    }

    let arcDatas = [];
    if (arc.envelope) {
      const arcTable = getTablePayload(arc.envelope);
      if (arcTable) arcDatas = arcTable.datas || [];
      else log('归档无 datas，仅用当前');
    } else {
      log('归档响应解析失败，仅用当前');
    }

    const { list: merged, added } = mergeDatas(curTable.datas, arcDatas);

    const newTable = {
      ...curTable,
      dp: patchDp(curTable.dp, merged),
      datas: merged,
    };

    // 写回 envelope：ReturnValue 必须仍是「字符串」
    const outEnvelope = {
      ...cur.envelope,
      ReturnValue: JSON.stringify(newTable),
    };

    const out = (cur.prefix || '') + JSON.stringify(outEnvelope);
    log(
      `合并完成：当前 ${curTable.datas.length} + 归档新增 ${added} = ${merged.length}`
    );
    return out;
  }

  // ==================== 请求 ====================
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

  function buildArchiveHeaders(baseHeaders, requestUrl) {
    const h = { ...headersToObject(baseHeaders) };
    h.Referer = toArchiveReferer(requestUrl);
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
          const { envelope } = parseEnvelope(text);
          return envelope;
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

  // ==================== Hook XHR ====================
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

  // ==================== Hook fetch 兜底 ====================
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

  // 暴露合并函数，方便控制台自测
  window.__jstOrderMerge = { mergeResponses, parseEnvelope, getTablePayload };

  log('已注入 v1.3.0 — 按 o_id 合并 ReturnValue.datas');
})();
