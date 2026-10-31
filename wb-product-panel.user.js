// ==UserScript==
// @name         WB 商品数据窗口
// @namespace    http://tampermonkey.net/
// @version      17.3.7
// @updateURL    https://raw.githubusercontent.com/Kansasi-0749/commission-data/main/wb-product-panel.user.js
// @downloadURL  https://raw.githubusercontent.com/Kansasi-0749/commission-data/main/wb-product-panel.user.js
// @description  拦截 Wildberries 商品接口，显示商品数据；一键跳转预算计算器并自动填充重量/尺寸/售价/类目；详情页/列表页/首页/店铺页/图片搜索页可分别开关
// @match        https://www.wildberries.ru/*
// @match        https://yadmin.sldeclat.com/goods-shop/budget-calculator*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @connect      gitee.com
// @connect      raw.giteeusercontent.com
// @connect      wbcontent.net
// @connect      feedback-bt.wildberries.ru
// @connect      questions.wildberries.ru
// @connect      wb.ru
// ==/UserScript==

(function () {
    'use strict';

    // 后台系统域名：yadmin.sldeclat.com（原 yadmin.sanlindou.com 已下线）。
    const BUDGET_HOST = 'yadmin.sldeclat.com';
    const BUDGET_URL = `https://${BUDGET_HOST}/goods-shop/budget-calculator`;
    const DEFAULT_DISCOUNT_PERCENT = 35;
    const LS_DISCOUNT_PERCENT = 'wb_budget_discount_percent';
    
    const LWH_RULE = (volume) => {
        const v = Number(volume);
        if (!isFinite(v)) return null;
        return { length: Math.round(v * 10), width: 10, height: 10 };
    };
    
    function getByPath(obj, path) {
        return path.split('.').reduce((acc, key) => {
            if (acc == null) return undefined;
            return acc[key];
        }, obj);
    }
    
    function pickProductPrice(product) {
        if (!product) return null;
        if (Array.isArray(product.sizes)) {
            for (const s of product.sizes) {
                if (s && s.price && s.price.product != null) {
                    const n = Number(s.price.product);
                    if (isFinite(n) && n > 0) return n;
                }
            }
        }
        const tryPaths = [
            'price.product', 'priceU', 'salePriceU',
            'sizes.0.price.product', 'sizes.0.price.total', 'sizes.0.priceU',
        ];
        for (const p of tryPaths) {
            const v = getByPath(product, p);
            if (v != null && v !== '' && Number(v) > 0) return Number(v);
        }
        return null;
    }
    
    function setInputValue(el, value) {
        if (!el) return false;
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }
    
    function waitFor(selector, timeout = 15000) {
        return new Promise((resolve, reject) => {
            const t0 = Date.now();
            (function loop() {
                const el = document.querySelector(selector);
                if (el) return resolve(el);
                if (Date.now() - t0 > timeout) return reject(new Error('timeout: ' + selector));
                setTimeout(loop, 200);
            })();
        });
    }
    
    function getParam(name) {
        try { return new URL(location.href).searchParams.get(name) || ''; }
        catch (e) { return ''; }
    }
    
    function getDiscountPercent() {
        const v = parseFloat(localStorage.getItem(LS_DISCOUNT_PERCENT));
        return isFinite(v) && v >= 0 && v < 100 ? v : DEFAULT_DISCOUNT_PERCENT;
    }
    function setDiscountPercent(v) {
        const n = parseFloat(v);
        if (isFinite(n) && n >= 0 && n < 100) {
            localStorage.setItem(LS_DISCOUNT_PERCENT, String(n));
        }
    }
    function calcSellPrice(productRaw, discountPercent) {
        if (productRaw == null || productRaw === '') return '';
        const d = Number(discountPercent);
        const denom = 1 - d / 100;
        if (!isFinite(denom) || denom <= 0) return '';
        return (Number(productRaw) / 100 / denom).toFixed(2);
    }
    
    if (location.hostname === 'www.wildberries.ru') initWildberries();
    else if (location.hostname === BUDGET_HOST) initBudgetCalculator();
    
    // ============================================================
    // WB 端
    // ============================================================
    function initWildberries() {
    
        const TARGET_DETAIL = '/__internal/u-card/cards/v4/detail';
        const TARGET_CARD   = '/info/ru/card.json';
        const SEARCH_PRODUCTS_URL = /\/__internal\/u-search\/[^?#]*\/search(?:[?#]|$)/i;
        // 商品集合接口不止搜索一种：首页推荐（u-recom）、店铺页、品牌页、图片搜索、类目页各走各的路径。
        // 命中任一即交给 indexListProducts 处理（它自己会做 products 数组的深度查找）。
        const LIST_PRODUCTS_URL = new RegExp(
            '\\/__internal\\/(?:u-[a-z0-9-]+\\/)?[^?#]*\\b(?:search|catalog|recom\\w*|sellers?|brands?)\\b' +
            '|(?:^|\\/)(?:sellers?|brands?|catalog)\\/v\\d+\\/catalog(?:[?#]|$)' +
            '|\\/\\/(?:catalog|u-catalog|search|u-search|u-recom|recom)\\.wb\\.ru\\/',
            'i',
        );
        function isListProductsUrl(url) {
            const text = String(url || '');
            if (!text || text.includes(TARGET_DETAIL) || text.includes(TARGET_CARD)) return false;
            return SEARCH_PRODUCTS_URL.test(text) || LIST_PRODUCTS_URL.test(text);
        }
        function isDetailRecommendUrl(url) {
            const text = String(url || '');
            return /\/u-recom(?:\/|[?#])/i.test(text)
                || /\/\/(?:u-recom|recom)\.wb\.ru\//i.test(text);
        }
        const PAGE_WINDOW = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
        // 详情页固定为 /catalog/{nmId}/detail[.aspx]。
        const DETAIL_ROUTE = /^\/catalog\/\d+\/detail(?:\.aspx)?\/?$/i;
        // 各类商品卡片网格页（命中即按列表页渲染，但归属不同页面类型，可分别开关）。
        const LIST_ROUTE_PATTERNS = [
            /^\/catalog(?:\/|$)/i,
            /^\/search(?:\/|$)/i,
            /^\/seller\/\d+(?:\/|$)/i,
            /^\/sellers?(?:\/|$)/i,
            /^\/brands?(?:\/|$)/i,
            /^\/brand\/\d+(?:\/|$)/i,
            /^\/stores?(?:\/|$)/i,
            /^\/promotions?(?:\/|$)/i,
            /^\/tags?(?:\/|$)/i,
        ];
        function isDetailRoute() {
            return DETAIL_ROUTE.test(location.pathname);
        }
        function isHomeRoute() {
            return location.pathname === '/' || location.pathname === '';
        }
        function isImageSearchRoute() {
            return /^\/search\/image(?:\/|$)/i.test(location.pathname);
        }
        function isSellerRoute() {
            return /^\/sellers?(?:\/|$)/i.test(location.pathname);
        }
        function isKnownListRoute() {
            return LIST_ROUTE_PATTERNS.some(pattern => pattern.test(location.pathname));
        }
    
        // 佣金表优先从远程文件读取（Gitee 优先，GitHub 保底），油猴缓存作为兜底。
        const REMOTE_COMMISSION_ENDPOINTS = [
            {
                label: 'Gitee Raw',
                url: 'https://gitee.com/liu-zhuanglin/wbcommission/raw/master/WB%E7%B1%BB%E7%9B%AE%E4%BD%A3%E9%87%91%E8%A1%A8.json',
            },
            {
                label: 'Gitee API',
                url: 'https://gitee.com/api/v5/repos/liu-zhuanglin/wbcommission/contents/WB%E7%B1%BB%E7%9B%AE%E4%BD%A3%E9%87%91%E8%A1%A8.json',
            },
            {
                label: 'GitHub Raw',
                url: 'https://raw.githubusercontent.com/Kansasi-0749/commission-data/main/WB%E7%B1%BB%E7%9B%AE%E4%BD%A3%E9%87%91%E8%A1%A8.json',
            },
            {
                label: 'GitHub API',
                url: 'https://api.github.com/repos/Kansasi-0749/commission-data/contents/WB%E7%B1%BB%E7%9B%AE%E4%BD%A3%E9%87%91%E8%A1%A8.json?ref=main',
            },
        ];
        const REMOTE_COMMISSION_CACHE_KEY = 'wb_commission_github_v4';
        const REMOTE_COMMISSION_CACHE_TTL = 6 * 60 * 60 * 1000;
        let remoteCommissionLoadStarted = false;
        let remoteCommissionStatus = { kind: 'loading', message: '正在连接远程佣金表…' };
        let REMOTE_CATEGORY_ID_MAP = {};
    
        function normalizeCategoryId(value) {
            if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : '';
            const raw = String(value == null ? '' : value).trim();
            if (!/^\d+$/.test(raw)) return '';
            const numeric = Number(raw);
            return Number.isSafeInteger(numeric) ? String(numeric) : '';
        }
    
        function makeRemoteIdCategoryKey(rootId, subjectId) {
            const rootKey = normalizeCategoryId(rootId);
            const subjectKey = normalizeCategoryId(subjectId);
            return rootKey && subjectKey ? rootKey + ':' + subjectKey : '';
        }
    
        function readCommissionValues(record) {
            const source = record && (record['佣金'] || record.commission);
            const values = Array.isArray(source)
                ? source.map(Number)
                : source && typeof source === 'object'
                    ? [source['本FBO'], source['本FBS'], source['跨FBS']].map(Number)
                    : [];
            return values.length >= 3 && values.slice(0, 3).every(Number.isFinite)
                ? values.slice(0, 3)
                : [];
        }
    
        function normalizeCategoryRecordMap(map) {
            const normalized = {};
            for (const [key, record] of Object.entries(map || {})) {
                if (!key || !record || typeof record !== 'object') continue;
                const rootId = normalizeCategoryId(record.rootId);
                const subjectId = normalizeCategoryId(record.subjectId);
                const commission = readCommissionValues(record);
                if (!rootId || !subjectId) continue;
                normalized[key] = {
                    rootId,
                    subjectId,
                    rootRussian: String(record.rootRussian || '').trim(),
                    rootChinese: String(record.rootChinese || '').trim(),
                    secondRussian: String(record.secondRussian || '').trim(),
                    secondChinese: String(record.secondChinese || '').trim(),
                    commission,
                };
            }
            if (!Object.keys(normalized).length) throw new Error('类目表没有有效记录');
            return normalized;
        }
    
        function extractRemoteCommissionData(payload) {
            if (!Array.isArray(payload)) throw new Error('佣金 JSON 必须是一级类目数组');
    
            const categoryMap = {};
            const seenRootIds = new Set();
            for (const root of payload) {
                const rootId = normalizeCategoryId(root && root.id);
                if (!rootId || !Array.isArray(root.childs)) continue;
                if (seenRootIds.has(rootId)) throw new Error(`重复的一级类目 ID：${rootId}`);
                seenRootIds.add(rootId);
                for (const child of root.childs) {
                    const subjectId = normalizeCategoryId(child && child.id);
                    if (!subjectId || normalizeCategoryId(child.parent) !== rootId) continue;
                    const categoryKey = makeRemoteIdCategoryKey(rootId, subjectId);
                    if (!categoryKey || Object.prototype.hasOwnProperty.call(categoryMap, categoryKey)) {
                        throw new Error(`重复或无效的类目 ID：${rootId}/${subjectId}`);
                    }
                    categoryMap[categoryKey] = {
                        rootId,
                        subjectId,
                        rootRussian: root.name,
                        rootChinese: root.parentName,
                        secondRussian: child.name,
                        secondChinese: child.subjectName,
                        commission: readCommissionValues(child),
                    };
                }
            }
            return {
                categoryMap: normalizeCategoryRecordMap(categoryMap),
            };
        }
    
        function normalizeRemoteCommissionData(data) {
            if (!data || typeof data !== 'object') throw new Error('远程佣金数据为空');
            const categoryMap = normalizeCategoryRecordMap(data.categoryMap);
            const idCategoryMap = Object.create(null);
            for (const record of Object.values(categoryMap)) {
                const byRoot = idCategoryMap[record.rootId] || (idCategoryMap[record.rootId] = Object.create(null));
                if (Object.prototype.hasOwnProperty.call(byRoot, record.subjectId)) {
                    throw new Error(`重复的类目 ID：${record.rootId}/${record.subjectId}`);
                }
                byRoot[record.subjectId] = record;
            }
            return { categoryMap, idCategoryMap };
        }
    
        function findRemoteCategoryData(rootId, subjectId) {
            const rootKey = normalizeCategoryId(rootId);
            const subjectKey = normalizeCategoryId(subjectId);
            if (!rootKey || !subjectKey) return null;
            return REMOTE_CATEGORY_ID_MAP[rootKey]?.[subjectKey] || null;
        }
    
        function findProductCommission(rootId, subjectId) {
            const record = findRemoteCategoryData(rootId, subjectId);
            return record && record.commission.length ? record.commission : null;
        }
    
        // 依次尝试 Gitee（Raw → API）、GitHub（Raw → API），任一成功即返回。
        function requestRemoteCommission() {
            return new Promise((resolve, reject) => {
                if (typeof GM_xmlhttpRequest !== 'function') {
                    reject(new Error('GM_xmlhttpRequest 不可用'));
                    return;
                }
                const failures = [];
                let endpointIndex = 0;
    
                function parsePayload(responseText) {
                    const text = String(responseText || '').replace(/^\uFEFF/, '').trim();
                    let payload = JSON.parse(text);
                    if (payload && payload.encoding === 'base64' && typeof payload.content === 'string') {
                        const binary = atob(payload.content.replace(/\s+/g, ''));
                        const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
                        payload = JSON.parse(new TextDecoder('utf-8').decode(bytes));
                    }
                    if (!Array.isArray(payload)) throw new Error('响应不是一级类目数组');
                    return payload;
                }
    
                function fail(label, reason) {
                    failures.push(`${label} ${reason}`);
                    console.warn(`[WB佣金] ${label} 失败：${reason}`);
                    tryNextEndpoint();
                }
    
                function tryNextEndpoint() {
                    if (endpointIndex >= REMOTE_COMMISSION_ENDPOINTS.length) {
                        reject(new Error(failures.join('；')));
                        return;
                    }
    
                    const endpoint = REMOTE_COMMISSION_ENDPOINTS[endpointIndex++];
                    const label = endpoint.label;
                    try {
                        GM_xmlhttpRequest({
                            method: 'GET',
                            url: endpoint.url,
                            headers: { Accept: 'application/json' },
                            timeout: 15000,
                            onload: response => {
                                if (response.status < 200 || response.status >= 300) {
                                    fail(label, `HTTP ${response.status}`);
                                    return;
                                }
                                try {
                                    resolve({ payload: parsePayload(response.responseText), label });
                                } catch (error) {
                                    // 解析失败不代表网络不可用，继续尝试下一个源。
                                    fail(label, error.message);
                                }
                            },
                            onerror: () => fail(label, '网络连接失败'),
                            ontimeout: () => fail(label, '请求超时'),
                            onabort: () => fail(label, '请求被取消'),
                        });
                    } catch (error) {
                        fail(label, error.message);
                    }
                }
    
                tryNextEndpoint();
            });
        }
    
        function requestRemoteText(url, withCredentials = false) {
            return new Promise((resolve, reject) => {
                if (typeof GM_xmlhttpRequest !== 'function') {
                    reject(new Error('GM_xmlhttpRequest 不可用'));
                    return;
                }
                try {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url,
                        headers: { Accept: 'application/json' },
                        withCredentials,
                        timeout: 20000,
                        onload: response => {
                            if (response.status < 200 || response.status >= 300) {
                                reject(new Error(`HTTP ${response.status}`));
                                return;
                            }
                            resolve(String(response.responseText || ''));
                        },
                        onerror: () => reject(new Error('网络连接失败')),
                        ontimeout: () => reject(new Error('请求超时')),
                        onabort: () => reject(new Error('请求被取消')),
                    });
                } catch (error) {
                    reject(error);
                }
            });
        }
    
        function resolveFeedbackHost(responseText) {
            const raw = String(responseText || '').trim();
            let payload;
            try { payload = JSON.parse(raw); }
            catch (error) {
                const normalizedRaw = raw.replace(/\\/g, '');
                try { payload = JSON.parse(normalizedRaw); }
                catch (parseError) { payload = normalizedRaw; }
            }
            const candidates = Array.isArray(payload) ? payload : [payload];
            for (const candidate of candidates) {
                if (typeof candidate !== 'string') continue;
                const normalized = candidate.replace(/\\/g, '').trim();
                const match = normalized.match(/^https?:\/\/feedback-view-(\d+)\.wb\.ru\/?$/i);
                if (match) return `https://feedback-view-${match[1]}.wb.ru`;
            }
            throw new Error('主机接口未返回有效的 feedback-view 地址');
        }
    
        function getFeedbackRows(payload) {
            if (Array.isArray(payload)) return payload;
            const queue = [payload];
            const seen = new Set();
            while (queue.length) {
                const current = queue.shift();
                if (!current || typeof current !== 'object' || seen.has(current)) continue;
                seen.add(current);
                if (Array.isArray(current.feedbacks)) return current.feedbacks;
                if (Array.isArray(current.data)) return current.data;
                if (current.data && typeof current.data === 'object') queue.push(current.data);
                if (current.result && typeof current.result === 'object') queue.push(current.result);
            }
            throw new Error('评论接口响应中没有 feedbacks 列表');
        }
    
        function getQuestionRows(payload) {
            if (Array.isArray(payload)) return payload;
            const queue = [payload];
            const seen = new Set();
            while (queue.length) {
                const current = queue.shift();
                if (!current || typeof current !== 'object' || seen.has(current)) continue;
                seen.add(current);
                for (const key of ['questions', 'items', 'data']) {
                    if (Array.isArray(current[key])) return current[key];
                }
                for (const key of ['data', 'result']) {
                    if (current[key] && typeof current[key] === 'object') queue.push(current[key]);
                }
            }
            throw new Error('问题接口响应中没有问题列表');
        }
    
        function xmlEscape(value) {
            return String(value == null ? '' : value)
                .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&apos;');
        }
    
        function splitFeedbackTimestamp(value) {
            const raw = String(value == null ? '' : value).trim();
            if (!raw) return ['', ''];
            const match = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/i);
            if (match) return [match[1], match[2]];
            return [raw, ''];
        }
    
        function buildFeedbackWorksheet(rows, fallbackNmId) {
            const headers = ['WB编号', '用户名', '星级', '评论内容', '卖家回复', '屏蔽', '尺码', '颜色', '评论日期', '评论时间', '更新日期', '更新时间', '状态ID'];
            const columnWidths = [14, 18, 8, 50, 50, 12, 12, 12, 14, 12, 14, 12, 10];
            const columnName = index => {
                let name = '';
                for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) {
                    name = String.fromCharCode(65 + (value - 1) % 26) + name;
                }
                return name;
            };
            const cellXml = (value, reference) =>
                `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
            const sheetRows = [headers, ...rows.map(feedback => {
                const [createdDate, createdTime] = splitFeedbackTimestamp(feedback?.createdDate);
                const [updatedDate, updatedTime] = splitFeedbackTimestamp(feedback?.updatedDate);
                return [
                    feedback?.nmid ?? feedback?.nmId ?? feedback?.nm_id ?? fallbackNmId,
                    feedback?.wbUserDetails?.name,
                    feedback?.productValuation,
                    feedback?.text,
                    feedback?.answer?.text,
                    feedback?.excludedFromRating?.isExcluded === true ? '屏蔽' : '',
                    feedback?.size,
                    feedback?.color,
                    createdDate,
                    createdTime,
                    updatedDate,
                    updatedTime,
                    feedback?.statusId,
                ];
            })];
            const rowXml = sheetRows.map((cells, rowIndex) => {
                const rowNumber = rowIndex + 1;
                const cellsXml = cells.map((value, columnIndex) =>
                    cellXml(value, `${columnName(columnIndex)}${rowNumber}`)
                ).join('');
                return `<row r="${rowNumber}">${cellsXml}</row>`;
            }).join('');
            const colsXml = columnWidths.map((width, index) =>
                `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
            ).join('');
            return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
                `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
                `<sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
                `<sheetFormatPr defaultRowHeight="15"/><cols>${colsXml}</cols><sheetData>${rowXml}</sheetData></worksheet>`;
        }
    
        function buildQuestionWorksheet(rows, fallbackNmId) {
            const headers = ['WB编号', '用户名', '问题内容', '卖家回复', '提问日期', '提问时间'];
            const columnWidths = [14, 18, 50, 50, 14, 12];
            const columnName = index => {
                let name = '';
                for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) {
                    name = String.fromCharCode(65 + (value - 1) % 26) + name;
                }
                return name;
            };
            const cellXml = (value, reference) =>
                `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
            const sheetRows = [headers, ...rows.map(question => {
                const [createdDate, createdTime] = splitFeedbackTimestamp(question?.createdDate);
                return [
                    question?.nmId ?? question?.nmid ?? question?.nm_id ?? fallbackNmId,
                    question?.wbUserDetails?.name,
                    question?.text,
                    question?.answer?.text,
                    createdDate,
                    createdTime,
                ];
            })];
            const rowXml = sheetRows.map((cells, rowIndex) => {
                const rowNumber = rowIndex + 1;
                const cellsXml = cells.map((value, columnIndex) =>
                    cellXml(value, `${columnName(columnIndex)}${rowNumber}`)
                ).join('');
                return `<row r="${rowNumber}">${cellsXml}</row>`;
            }).join('');
            const colsXml = columnWidths.map((width, index) =>
                `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
            ).join('');
            return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
                `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
                `<sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
                `<sheetFormatPr defaultRowHeight="15"/><cols>${colsXml}</cols><sheetData>${rowXml}</sheetData></worksheet>`;
        }
    
        // XLSX is a ZIP package; store its XML entries without compression.
        function createXlsxBlob(files) {
            const encoder = new TextEncoder();
            const crcTable = new Uint32Array(256);
            for (let index = 0; index < 256; index++) {
                let value = index;
                for (let bit = 0; bit < 8; bit++) {
                    value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
                }
                crcTable[index] = value >>> 0;
            }
            const crc32 = bytes => {
                let crc = 0xFFFFFFFF;
                for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
                return (crc ^ 0xFFFFFFFF) >>> 0;
            };
    
            const localParts = [];
            const centralParts = [];
            let localOffset = 0;
            for (const [name, content] of Object.entries(files)) {
                const nameBytes = encoder.encode(name);
                const data = encoder.encode(content);
                const checksum = crc32(data);
                const localHeader = new Uint8Array(30 + nameBytes.length);
                const localView = new DataView(localHeader.buffer);
                localView.setUint32(0, 0x04034B50, true);
                localView.setUint16(4, 20, true);
                localView.setUint16(6, 0x0800, true);
                localView.setUint32(14, checksum, true);
                localView.setUint32(18, data.length, true);
                localView.setUint32(22, data.length, true);
                localView.setUint16(26, nameBytes.length, true);
                localHeader.set(nameBytes, 30);
                localParts.push(localHeader, data);
    
                const centralHeader = new Uint8Array(46 + nameBytes.length);
                const centralView = new DataView(centralHeader.buffer);
                centralView.setUint32(0, 0x02014B50, true);
                centralView.setUint16(4, 20, true);
                centralView.setUint16(6, 20, true);
                centralView.setUint16(8, 0x0800, true);
                centralView.setUint32(16, checksum, true);
                centralView.setUint32(20, data.length, true);
                centralView.setUint32(24, data.length, true);
                centralView.setUint16(28, nameBytes.length, true);
                centralView.setUint32(42, localOffset, true);
                centralHeader.set(nameBytes, 46);
                centralParts.push(centralHeader);
                localOffset += localHeader.length + data.length;
            }
    
            const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
            const endRecord = new Uint8Array(22);
            const endView = new DataView(endRecord.buffer);
            const fileCount = centralParts.length;
            endView.setUint32(0, 0x06054B50, true);
            endView.setUint16(8, fileCount, true);
            endView.setUint16(10, fileCount, true);
            endView.setUint32(12, centralSize, true);
            endView.setUint32(16, localOffset, true);
    
            return new Blob([...localParts, ...centralParts, endRecord], {
                type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            });
        }
    
        function buildXlsxFiles(sheetName, worksheetXml) {
            return {
                '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
                    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
                    '<Default Extension="xml" ContentType="application/xml"/>' +
                    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
                    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
                    '</Types>',
                '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
                    '</Relationships>',
                'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
                    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
                    `<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
                'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
                    '</Relationships>',
                'xl/worksheets/sheet1.xml': worksheetXml,
            };
        }
    
        function saveXlsxFile(files, filename) {
            const blob = createXlsxBlob(files);
            const objectUrl = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        }
    
        // 评论/提问为空时不要生成空表，用这个错误让调用方给出「无数据」提示。
        function createEmptyDataError(message) {
            const error = new Error(message);
            error.wbEmptyData = true;
            return error;
        }
    
        async function downloadProductFeedback(imtId, nmId) {
            const hostResponse = await requestRemoteText(
                `https://feedback-bt.wildberries.ru/feedback/api/v2/host?imt=${encodeURIComponent(imtId)}`
            );
            const feedbackHost = resolveFeedbackHost(hostResponse);
            const feedbackText = await requestRemoteText(
                `${feedbackHost}/feedbacks/v2/${encodeURIComponent(imtId)}`
            );
            let feedbackRows;
            try {
                feedbackRows = getFeedbackRows(JSON.parse(feedbackText));
            } catch (error) {
                // 零评论商品可能连 feedbacks 字段都不返回
                console.debug('[WB导出] 评论响应无列表', error && error.message);
                throw createEmptyDataError('评论为空');
            }
            if (!feedbackRows.length) {
                throw createEmptyDataError('评论为空');
            }
            saveXlsxFile(buildXlsxFiles('评论', buildFeedbackWorksheet(feedbackRows, nmId)),
                `WB商品评论_${nmId || imtId}.xlsx`);
        }
    
        async function downloadProductQuestions(imtId, nmId) {
            const take = 30;
            const rows = [];
            const seen = new Set();
            let skip = 0;
            let reachedEnd = false;
    
            for (let page = 0; page < 1000; page++) {
                const url = `https://questions.wildberries.ru/api/v1/questions?imtId=${encodeURIComponent(imtId)}&take=${take}&skip=${skip}`;
                const payload = JSON.parse(await requestRemoteText(url, true));
                let pageRows;
                try {
                    pageRows = getQuestionRows(payload);
                } catch (error) {
                    // 零提问商品的响应里可能根本没有 questions 字段
                    console.debug('[WB导出] 提问响应无列表', error && error.message);
                    if (!rows.length) throw createEmptyDataError('提问为空');
                    reachedEnd = true;   // 后面几页结构异常时，按已经拿到的数据导出
                    break;
                }
                if (!pageRows.length) {
                    reachedEnd = true;
                    break;
                }
    
                let added = 0;
                for (const question of pageRows) {
                    const id = question?.id ?? question?.questionId ?? question?.question_id;
                    const signature = id == null ? JSON.stringify(question) : String(id);
                    if (seen.has(signature)) continue;
                    seen.add(signature);
                    rows.push(question);
                    added++;
                }
                skip += pageRows.length;
                if (pageRows.length < take || added === 0) {
                    reachedEnd = true;
                    break;
                }
            }
    
            if (!reachedEnd) throw new Error('问题分页超过安全上限');
            if (!rows.length) throw createEmptyDataError('提问为空');
            const files = buildXlsxFiles('提问', buildQuestionWorksheet(rows, nmId));
            saveXlsxFile(files, `WB商品提问_${nmId || imtId}.xlsx`);
        }
    
        function applyRemoteCommissionData(data, source) {
            const normalized = normalizeRemoteCommissionData(data);
            REMOTE_CATEGORY_ID_MAP = normalized.idCategoryMap;
            remoteCommissionStatus = { kind: 'loaded', message: '' };
            console.info('[WB佣金] 已加载', source, Object.keys(normalized.categoryMap).length, '条');
            if (typeof tryRender === 'function') tryRender();
            if (pageMode === 'list' || pageMode === 'detail') queueListRender();
        }
    
        function loadRemoteCommissionData() {
            if (remoteCommissionLoadStarted) return;
            remoteCommissionLoadStarted = true;
    
            let cached = null;
            try { cached = GM_getValue(REMOTE_COMMISSION_CACHE_KEY, null); } catch (e) {}
    
            if (cached && cached.data) {
                try {
                    applyRemoteCommissionData(cached.data, '本地缓存');
                    remoteCommissionStatus = { kind: 'loaded', message: '' };
                }
                catch (e) { cached = null; }
            }
    
            const savedAt = Number(cached && cached.savedAt);
            if (savedAt && Date.now() - savedAt < REMOTE_COMMISSION_CACHE_TTL) return;
    
            requestRemoteCommission()
                .then(({ payload, label }) => {
                    const data = extractRemoteCommissionData(payload);
                    applyRemoteCommissionData(data, label);
                    try {
                        GM_setValue(REMOTE_COMMISSION_CACHE_KEY, {
                            savedAt: Date.now(),
                            data,
                        });
                    } catch (e) {
                        console.warn('[WB佣金] 缓存写入失败', e);
                    }
                })
                .catch(error => {
                    const hasCachedData = Object.keys(REMOTE_CATEGORY_ID_MAP).length > 0;
                    remoteCommissionStatus = hasCachedData
                        ? { kind: 'warning', message: '远程更新失败，当前使用已缓存数据' }
                        : { kind: 'error', message: '远程佣金表连接失败：中文类目和佣金表未加载' };
                    console.error('[WB佣金] 远程表加载失败', error);
                    if (typeof tryRender === 'function') tryRender();
                    if (pageMode === 'list' || pageMode === 'detail') queueListRender();
                });
        }
    
        const FIELDS = [
            { label: '体积', path: 'volume', transform: v => (Number(v) / 10).toFixed(1) + ' 升', compact: true },
            { label: '尺寸体积', path: '__card__.package_volume', compact: true },
            { label: '重量', path: 'weight', transform: v => Number(v).toFixed(1) + ' kg', compact: true },
            { label: '库存', path: 'totalQuantity', compact: true },
            // 与搜索页保持一致：`2026-09-08（1个月）`，括号内是距今天数/月数。
            { label: '上架时间', path: '__card__.create_date', valueBold: true,
              transform: v => formatCreatedAtWithAge(v) },
        ];
    
        function getCurrentNmId() {
            const m = location.pathname.match(/\/catalog\/(\d+)\/detail/);
            return m ? m[1] : null;
        }
        function getSupplierId(product) {
            const supplier = getByPath(product, 'supplier');
            const raw = getByPath(product, 'supplierId')
                ?? getByPath(product, 'supplier_id')
                ?? (/^\d+$/.test(String(supplier ?? '').trim()) ? supplier : '');
            const id = raw == null ? '' : String(raw).trim();
            return /^\d+$/.test(id) && Number(id) > 0 ? id : '';
        }
        function getNmFromCardUrl(url) {
            const text = String(url || '');
            const pathMatch = text.match(/\/(\d+)\/info(?:\/|[?#])/i);
            if (pathMatch) return pathMatch[1];
            const queryMatch = text.match(/[?&](?:nm|nmId|nm_id)=(\d+)/i);
            return queryMatch ? queryMatch[1] : null;
        }
        function formatValue(field, value) {
            if (value === undefined || value === null) return '—';
            if (typeof field.transform === 'function') {
                try { return field.transform(value); }
                catch (e) { return String(value); }
            }
            if (field.path.startsWith('price.')) return (Number(value) / 100).toFixed(2) + ' ₽';
            if (field.unit) return value + ' ' + field.unit;
            if (typeof value === 'object') return JSON.stringify(value);
            return String(value);
        }
        function indexProducts(data, sourceUrl = '', requestNmId = '') {
            ensureDetailState();
            const products = [data?.products, data?.data?.products, data?.data?.data?.products]
                .find(Array.isArray) || [];
            const time = Date.now();
            for (const p of products) {
                if (!p || typeof p !== 'object') continue;
                const itemId = p.id ?? p.nmId ?? p.nm_id;
                const id = String(itemId || (products.length === 1 ? requestNmId : ''));
                if (id) {
                    window.__WB_CAPTURED__[id] = { nm: id, time, data: p };
                    if (sourceUrl) window.__WB_DETAIL_URLS__[id] = String(sourceUrl);
                }
            }
            if (sourceUrl && requestNmId && !window.__WB_DETAIL_URLS__[requestNmId]) {
                window.__WB_DETAIL_URLS__[requestNmId] = String(sourceUrl);
            }
            console.debug('[WB抓取] detail 响应已处理', {
                products: products.length,
                requestNmId,
                currentNmId: getCurrentNmId(),
                matchedCurrent: Boolean(window.__WB_CAPTURED__?.[getCurrentNmId()]),
            });
            return products.length;
        }
        const listProductsByNm = new Map();
        // 详情页推荐接口返回的商品 ID；仅这些卡片允许在详情页插入列表数据面板。
        const detailRecommendNmIds = new Set();
        const listCardDataByNm = new Map();
        const listCardLoadStarted = new Set();
        let listCardLoadQueue = Promise.resolve();
    
        // ===== 搜索页 card.json 补抓（basket CDN） =====
        // 搜索接口不返回上架时间，也不返回变体数（它的 colors 是颜色名），
        // 但商品图片和 card.json 都挂在 basket CDN 上，可以按 nmId 反推静态地址：
        //   vol  = floor(nmId / 100000)
        //   part = floor(nmId / 1000)
        //   https://basket-NN.wbcontent.net/vol{vol}/part{part}/{nmId}/info/ru/card.json
        // 例：1543592967 → vol 15435 → 命中 14982~15749 → basket-48
        //     https://basket-48.wbcontent.net/vol15435/part1543592/1543592967/info/ru/card.json
        // 主机按顺序命名 basket-01…basket-65，所以表里只存 vol 区间，主机序号 = 下标 + 1。
        // WB 新增 basket 时，从表尾追加区间即可。
        const BASKET_CDN_SUFFIX = '.wbcontent.net';
        const BASKET_VOL_RANGES = [
            [0, 143], [144, 287], [288, 431], [432, 719], [720, 1007],
            [1008, 1061], [1062, 1115], [1116, 1169], [1170, 1313], [1314, 1601],
            [1602, 1655], [1656, 1919], [1920, 2045], [2046, 2189], [2190, 2405],
            [2406, 2621], [2622, 2837], [2838, 3053], [3054, 3269], [3270, 3485],
            [3486, 3701], [3702, 3917], [3918, 4133], [4134, 4349], [4350, 4565],
            [4566, 4877], [4878, 5189], [5190, 5501], [5502, 5813], [5814, 6125],
            [6126, 6437], [6438, 6749], [6750, 7061], [7062, 7373], [7374, 7685],
            [7686, 7997], [7998, 8309], [8310, 8741], [8742, 9173], [9174, 9605],
            [9606, 10373], [10374, 11141], [11142, 11909], [11910, 12677], [12678, 13445],
            [13446, 14213], [14214, 14981], [14982, 15749], [15750, 16517], [16518, 17285],
            [17286, 18053], [18054, 18821], [18822, 19589], [19590, 20357], [20358, 21125],
            [21126, 21893], [21894, 22661], [22662, 23429], [23430, 24197], [24198, 24965],
            [24966, 25733], [25734, 26501], [26502, 27269], [27270, 28037], [28038, 28805],
        ];
    
        function getBasketHostByVol(vol) {
            for (let index = 0; index < BASKET_VOL_RANGES.length; index++) {
                const [from, to] = BASKET_VOL_RANGES[index];
                if (vol >= from && vol <= to) {
                    return `basket-${String(index + 1).padStart(2, '0')}${BASKET_CDN_SUFFIX}`;
                }
            }
            return '';
        }
    
        function buildBasketCardUrl(nmId) {
            const nm = Number(nmId);
            if (!Number.isSafeInteger(nm) || nm <= 0) return '';
            const vol = Math.floor(nm / 100000);
            const host = getBasketHostByVol(vol);
            if (!host) return '';
            const part = Math.floor(nm / 1000);
            return `https://${host}/vol${vol}/part${part}/${nm}/info/ru/card.json`;
        }
    
        // 依次尝试：CDN 直连（能命中浏览器缓存）→ 油猴请求（绕过 CORS）→ 同源接口。
        async function requestListCardJson(nmId) {
            const canFetch = typeof origFetch === 'function';
            const cdnUrl = buildBasketCardUrl(nmId);
    
            if (cdnUrl && canFetch) {
                try {
                    // CDN 是跨域静态资源：不能带 credentials，否则通配符 ACAO 会被浏览器拒绝。
                    const response = await origFetch.call(PAGE_WINDOW, cdnUrl, {
                        credentials: 'omit',
                        cache: 'force-cache',
                    });
                    if (response.ok) {
                        const data = await response.json();
                        if (data && typeof data === 'object') return data;
                    } else {
                        console.debug('[WB列表] basket 返回', response.status, nmId);
                    }
                } catch (error) {
                    console.debug('[WB列表] basket 直连失败，改用油猴请求', nmId, error && error.message);
                }
            }
    
            if (cdnUrl) {
                try {
                    const text = await requestRemoteText(cdnUrl);
                    const data = JSON.parse(String(text || '').replace(/^\uFEFF/, '').trim());
                    if (data && typeof data === 'object') return data;
                } catch (error) {
                    console.debug('[WB列表] basket 油猴请求失败', nmId, error && error.message);
                }
            }
    
            if (!canFetch) return null;
            const fallbackUrl = `${location.origin}/catalog/${nmId}/info/ru/card.json`;
            const response = await origFetch.call(PAGE_WINDOW, fallbackUrl, {
                credentials: 'include',
                cache: 'force-cache',
            });
            if (!response.ok) return null;
            const data = await response.json();
            return data && typeof data === 'object' ? data : null;
        }
    
        const LIST_CARD_MAX_ATTEMPTS = 3;
        const listCardLoadFailures = new Map();
    
        function noteListCardFailure(nmId) {
            const attempts = (listCardLoadFailures.get(nmId)?.attempts || 0) + 1;
            listCardLoadFailures.set(nmId, {
                attempts,
                nextAt: Date.now() + Math.min(attempts * 15000, 120000),
            });
        }
    
        function canRetryListCard(nmId) {
            const failure = listCardLoadFailures.get(nmId);
            if (!failure) return true;
            return failure.attempts < LIST_CARD_MAX_ATTEMPTS && Date.now() >= failure.nextAt;
        }
    
        function queueListCardDataLoads(nmIds) {
            // 列表页和详情页推荐卡都需要 card.json 补充上架时间、变体数等字段。
            if (pageMode !== 'list' && pageMode !== 'detail') return;
            const pending = [...new Set(nmIds)].filter(nmId => {
                // 详情页只允许补抓推荐接口返回的商品，避免触碰主商品及其他页面链接。
                if (pageMode === 'detail' && !detailRecommendNmIds.has(nmId)) return false;
                // 不再要求 listProductsByNm 里已有数据：图片搜索/店铺等页面的接口可能还没被识别，
                // 只要卡片渲染出来了，就先用 basket 的 card.json 兜底填充。
                return /^\d+$/.test(nmId) &&
                    !listCardDataByNm.has(nmId) && !listCardLoadStarted.has(nmId) &&
                    canRetryListCard(nmId);
            });
            if (!pending.length) return;
            pending.forEach(nmId => listCardLoadStarted.add(nmId));
            const queue = pending.slice();
            listCardLoadQueue = listCardLoadQueue.then(async () => {
                while (queue.length) {
                    const batch = queue.splice(0, 6);
                    await Promise.all(batch.map(async nmId => {
                        try {
                            const data = await requestListCardJson(nmId);
                            if (data) {
                                listCardDataByNm.set(nmId, data);
                                listCardLoadFailures.delete(nmId);
                            } else {
                                noteListCardFailure(nmId);
                            }
                        } catch (error) {
                            noteListCardFailure(nmId);
                            console.debug('[WB列表] card.json 补抓失败', nmId, error && error.message);
                        } finally {
                            listCardLoadStarted.delete(nmId);
                        }
                    }));
                    if (pageMode === 'list' || pageMode === 'detail') queueListRender();
                }
            });
        }
    
        // 接口版本很多（u-search / v4 / v5 / seller catalog …），products 数组的层级不固定，
        // 这里做有限深度的广度优先查找，避免每换一个接口就漏抓一次。
        function findProductsArray(payload) {
            if (!payload || typeof payload !== 'object') return [];
            const queue = [{ value: payload, depth: 0 }];
            const seen = new Set();
            while (queue.length) {
                const { value, depth } = queue.shift();
                if (!value || typeof value !== 'object' || seen.has(value)) continue;
                seen.add(value);
                if (Array.isArray(value.products)) return value.products;
                if (Array.isArray(value.data) && depth < 3 && value.data.length &&
                    value.data[0] && typeof value.data[0] === 'object' &&
                    ('id' in value.data[0] || 'nmId' in value.data[0] || 'nm_id' in value.data[0])) {
                    return value.data;
                }
                if (Array.isArray(value) && depth < 3) {
                    // 形如 { data: [ {...product} ] } 的返回
                    if (value.length && value[0] && typeof value[0] === 'object' &&
                        ('id' in value[0] || 'nmId' in value[0] || 'nm_id' in value[0])) return value;
                    for (const item of value.slice(0, 5)) queue.push({ value: item, depth: depth + 1 });
                    continue;
                }
                if (depth >= 3) continue;
                for (const key of ['data', 'result', 'payload', 'catalog', 'body']) {
                    if (value[key] && typeof value[key] === 'object') {
                        queue.push({ value: value[key], depth: depth + 1 });
                    }
                }
            }
            return [];
        }
    
        function indexListProducts(data, sourceUrl = '') {
            const products = findProductsArray(data);
            const nmIds = [];
            const detailPage = (isDetailRoute() || pageMode === 'detail') && isDetailRecommendUrl(sourceUrl);
            for (const product of products) {
                if (!product || typeof product !== 'object') continue;
                const rawId = product.id ?? product.nmId ?? product.nm_id;
                const nmId = rawId == null ? '' : String(rawId).trim();
                if (!/^\d+$/.test(nmId)) continue;
                listProductsByNm.set(nmId, product);
                nmIds.push(nmId);
                if (detailPage) detailRecommendNmIds.add(nmId);
            }
            queueListCardDataLoads(nmIds);
            console.debug('[WB列表] 商品集合响应已处理', {
                products: products.length,
                indexed: listProductsByNm.size,
                detailRecommendations: detailPage ? detailRecommendNmIds.size : 0,
                sourceUrl: String(sourceUrl).split('?')[0],
            });
            if (pageMode === 'list' || pageMode === 'detail') queueListRender();
            return products.length;
        }
        function parseMeasure(value) {
            const m = String(value || '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
            return m ? Number(m[0]) : null;
        }
        function getCardRoots(card) {
            const roots = [];
            const seen = new Set();
            const add = value => {
                if (!value || typeof value !== 'object' || seen.has(value)) return;
                seen.add(value);
                roots.push(value);
            };
            add(card);
            add(card?.data);
            add(card?.data?.data);
            add(card?.result);
            add(card?.result?.data);
            add(card?.card);
            add(card?.card?.data);
            return roots;
        }
        function getCardField(card, names) {
            for (const root of getCardRoots(card)) {
                for (const name of names) {
                    if (root[name] !== undefined && root[name] !== null && root[name] !== '') {
                        return root[name];
                    }
                }
            }
            return '';
        }
        // 变体数 = card.json 里 colors（同一 imt 下的 nmId 数组）的条目数。
        // 搜索接口返回的 colors 是颜色名列表，所以不能用它来数变体。
        function getCardVariantsCount(card) {
            for (const root of getCardRoots(card)) {
                if (Array.isArray(root.colors)) return root.colors.length;
                if (Array.isArray(root.full_colors)) return root.full_colors.length;
            }
            return null;
        }
        function getPackageVolume(card) {
            const names = [];
            for (const root of getCardRoots(card)) {
                for (const key of ['nm_colors_names', 'options']) {
                    if (Array.isArray(root[key])) names.push(...root[key]);
                }
                if (Array.isArray(root.grouped_options)) {
                    for (const group of root.grouped_options) {
                        if (Array.isArray(group?.options)) names.push(...group.options);
                    }
                }
            }
            const findValue = name => {
                const item = names.find(x => String(x?.name || '').trim() === name);
                return item ? parseMeasure(item.value) : null;
            };
    
            const length = findValue('Длина упаковки');
            const height = findValue('Высота упаковки');
            const width = findValue('Ширина упаковки');
            if (![length, height, width].every(Number.isFinite)) return '';
    
            const fmt = value => Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
            const volume = (length * width * height / 1000).toFixed(2);
            return `${fmt(length)}x${fmt(width)}x${fmt(height)}=${volume}升`;
        }
        function mergeCategory(product, nmId) {
            if (!product) return product;
            const card = window.__WB_CARD__?.[nmId];
            const getField = names => getCardField(product, names) || getCardField(card, names);
            return { ...product, __card__: {
                subject_root_id: getField(['subject_root_id', 'subjectRootId', 'subj_root_id', 'subjRootId']),
                subject_id: getField(['subject_id', 'subjectId', 'subj_id', 'subjId']),
                subj_root_name: getField(['subj_root_name', 'subjRootName', 'subject_root_name', 'subjectRootName']),
                subj_name: getField(['subj_name', 'subjName', 'subject_name', 'subjectName']),
                create_date: getCardField(card, ['create_date', 'createDate', 'created_at', 'createdAt'])
                    || getCardField(product, ['create_date', 'createDate', 'created_at', 'createdAt']),
                package_volume: card ? getPackageVolume(card) : getPackageVolume(product),
            }};
        }
        function storeCardData(url, data, requestNmId = '') {
            if (!data) return '';
            ensureDetailState();
            const nm = getNmFromCardUrl(url) || String(requestNmId || '');
            if (!nm) return '';
            window.__WB_CARD__[nm] = data;
            if (url) window.__WB_CARD_URLS__[nm] = String(url);
            console.debug('[WB抓取] card 响应已处理', {
                nmId: nm,
                currentNmId: getCurrentNmId(),
            });
            return nm;
        }
        function copyText(text) {
            if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
            return new Promise((resolve, reject) => {
                try {
                    const ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0;';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                    resolve();
                } catch (e) { reject(e); }
            });
        }
    
        // 轻量提示：传了锚点元素就贴着它显示（气泡 + 箭头），否则回退到页面底部居中。
        let toastEl = null;
        let toastTextEl = null;
        let toastArrowEl = null;
        let toastTimer = null;
        let toastFrame = 0;
        let toastAnchor = null;
        let toastVisible = false;
    
        function ensureToast() {
            if (toastEl) return;
            toastEl = document.createElement('div');
            toastEl.setAttribute('role', 'status');
            toastEl.setAttribute('aria-live', 'polite');
            toastEl.style.cssText = `
                position: fixed; left: 0; top: 0; z-index: 2147483000;
                max-width: min(320px, calc(100vw - 32px));
                box-sizing: border-box; padding: 8px 14px;
                border-radius: 8px;
                background: rgba(28, 28, 30, .92);
                color: #fff; font-size: 12px; line-height: 1.45;
                font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
                text-align: center; white-space: normal;
                box-shadow: 0 6px 20px rgba(0, 0, 0, .25);
                opacity: 0; transform: translateY(4px);
                transition: opacity .18s ease, transform .18s ease;
                pointer-events: none;
            `;
            toastTextEl = document.createElement('span');
            toastArrowEl = document.createElement('div');
            toastEl.append(toastTextEl, toastArrowEl);
        }
    
        function positionToast() {
            if (!toastEl || !toastEl.isConnected) return;
            const rect = toastEl.getBoundingClientRect();
            const width = rect.width;
            const height = rect.height;
            if (!width || !height) return;
    
            const vw = document.documentElement.clientWidth;
            const vh = document.documentElement.clientHeight;
            const margin = 8;
            const gap = 10;
            let left;
            let top;
    
            const anchor = toastAnchor && toastAnchor.isConnected ? toastAnchor : null;
            if (anchor) {
                const box = anchor.getBoundingClientRect();
                const anchorX = box.left + box.width / 2;
                left = anchorX - width / 2;
                top = box.top - height - gap;
                let arrowBelow = true;
                if (top < margin) {
                    // 上方放不下就翻到按钮下面，箭头改朝上
                    top = box.bottom + gap;
                    arrowBelow = false;
                }
                left = Math.max(margin, Math.min(left, vw - width - margin));
                top = Math.max(margin, Math.min(top, vh - height - margin));
    
                const arrowX = Math.max(14, Math.min(anchorX - left, width - 14));
                const arrowCss = `position:absolute; left:${Math.round(arrowX - 6)}px; width:0; height:0;` +
                    ' border-left:6px solid transparent; border-right:6px solid transparent;' +
                    (arrowBelow
                        ? ' top:100%; border-top:7px solid rgba(28,28,30,.92);'
                        : ' bottom:100%; border-bottom:7px solid rgba(28,28,30,.92);');
                // 从「无锚点」模式切回来时，把隐藏的箭头恢复出来
                if (toastArrowEl.style.display) toastArrowEl.style.display = '';
                if (toastArrowEl.__wbCss !== arrowCss) {
                    toastArrowEl.style.cssText = arrowCss;
                    toastArrowEl.__wbCss = arrowCss;
                }
            } else {
                left = (vw - width) / 2;
                top = vh - height - 24;
                if (toastArrowEl.style.display !== 'none') toastArrowEl.style.display = 'none';
            }
    
            const leftPx = Math.round(left) + 'px';
            const topPx = Math.round(top) + 'px';
            if (toastEl.style.left !== leftPx) toastEl.style.left = leftPx;
            if (toastEl.style.top !== topPx) toastEl.style.top = topPx;
        }
    
        function stopToastTracking() {
            if (toastFrame) window.cancelAnimationFrame(toastFrame);
            toastFrame = 0;
        }
    
        // 气泡显示的这段时间里跟着按钮走（滚动/布局变化都不会跑偏）
        function startToastTracking() {
            stopToastTracking();
            const tick = () => {
                toastFrame = 0;
                if (!toastVisible) return;
                positionToast();
                toastFrame = window.requestAnimationFrame(tick);
            };
            toastFrame = window.requestAnimationFrame(tick);
        }
    
        function hideToast() {
            if (toastTimer !== null) window.clearTimeout(toastTimer);
            toastTimer = null;
            toastVisible = false;
            stopToastTracking();
            if (!toastEl) return;
            toastEl.style.opacity = '0';
            toastEl.style.transform = 'translateY(4px)';
        }
    
        function showToast(message, anchor = null) {
            if (!message) return;
            ensureToast();
            if (!toastEl.isConnected) document.body.appendChild(toastEl);
            toastAnchor = anchor && anchor.isConnected ? anchor : null;
            if (toastTextEl.textContent !== message) toastTextEl.textContent = message;
            toastVisible = true;
            positionToast();
            toastEl.style.opacity = '1';
            toastEl.style.transform = 'translateY(0)';
            startToastTracking();
            if (toastTimer !== null) window.clearTimeout(toastTimer);
            toastTimer = window.setTimeout(hideToast, 2400);
        }
    
        // ===== 页面类型总开关浮标 =====
        // 五类页面可以各自开关；浮标常驻右下角，关掉某一类后也能随时改回去。
        let kindToggleEl = null;
        let kindToggleOpen = false;
    
        function ensureKindToggle() {
            if (kindToggleEl) return kindToggleEl;
            const root = document.createElement('div');
            root.id = 'wb-kind-toggle';
            root.style.cssText = `
                position:fixed; right:12px; bottom:12px; z-index:2147483000;
                font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;
            `;
    
            const menu = document.createElement('div');
            menu.style.cssText = `
                display:none; margin-bottom:6px; padding:8px 10px; min-width:184px;
                background:#fff; color:#222; border-radius:8px;
                box-shadow:0 4px 16px rgba(0,0,0,.16); border:1px solid #f0e0ee;
                font-size:12px; line-height:1.5;
            `;
    
            const title = document.createElement('div');
            title.textContent = '面板显示范围';
            title.style.cssText = `font-weight:600; color:#cb11ab; margin-bottom:4px;`;
            menu.appendChild(title);
    
            for (const [kind, meta] of Object.entries(PAGE_KINDS)) {
                const row = document.createElement('label');
                row.style.cssText = `display:flex; align-items:flex-start; gap:6px; padding:3px 0; cursor:pointer;`;
                const box = document.createElement('input');
                box.type = 'checkbox';
                box.checked = isPageKindEnabled(kind);
                box.dataset.wbKind = kind;
                box.style.cssText = `margin:2px 0 0; accent-color:#cb11ab; cursor:pointer;`;
                box.addEventListener('change', () => {
                    setPageKindEnabled(kind, box.checked);
                    applyPageKindChange();
                });
                const text = document.createElement('span');
                text.style.cssText = `min-width:0;`;
                const nameEl = document.createElement('span');
                nameEl.textContent = meta.label;
                nameEl.style.cssText = `font-weight:600;`;
                const descEl = document.createElement('span');
                descEl.textContent = ` ${meta.desc}`;
                descEl.style.cssText = `color:#999; font-size:11px;`;
                text.append(nameEl, descEl);
                row.append(box, text);
                menu.appendChild(row);
            }
    
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = '面板';
            button.title = '选择在哪些页面显示商品面板';
            button.style.cssText = `
                display:flex; align-items:center; justify-content:center; gap:4px;
                height:28px; padding:0 10px; margin-left:auto;
                background:#cb11ab; color:#fff; border:none; border-radius:14px;
                font-size:12px; font-weight:600; cursor:pointer;
                box-shadow:0 2px 8px rgba(203,17,171,.32); opacity:.92;
            `;
            button.addEventListener('click', event => {
                event.stopPropagation();
                kindToggleOpen = !kindToggleOpen;
                menu.style.display = kindToggleOpen ? 'block' : 'none';
            });
    
            root.append(menu, button);
            document.body.appendChild(root);
            kindToggleEl = root;
            return root;
        }
    
        function applyPageKindChange() {
            stopUnknownRouteProbe();
            if (pageMode === 'detail') leaveDetailMode();
            else if (pageMode === 'list') leaveListMode();
            pageMode = null;
            updatePageKindHint();
            switchPageMode();
        }
    
        // 当前页面类型被关闭时，给一条一次性提示，避免“以为脚本坏了”。
        let pageKindHintPath = '';
    
        function updatePageKindHint() {
            // SPA 会整块替换 body，浮标可能被一起删掉，这里顺手挂回去。
            if (kindToggleEl && !kindToggleEl.isConnected && document.body) {
                document.body.appendChild(kindToggleEl);
            }
            const kind = resolvePageKind();
            if (!kind || isPageKindEnabled(kind)) {
                pageKindHintPath = '';
                return;
            }
            const marker = `${kind}:${location.pathname}`;
            if (pageKindHintPath === marker) return;
            pageKindHintPath = marker;
            showToast(`${PAGE_KINDS[kind].label}面板已关闭，可在右下角「面板」里重新打开`);
        }
    
        let panelEl = null, bodyEl = null;
        let panelPlacementNm = null;
        let pageMode = null;
        let detailObserver = null;
        let insertQueued = false;
        let panelClosed = false;
        let lastRouteHref = location.href;
        let routeHooksInstalled = false;
        let routePollTimer = null;
        let productLoadTimer = null;
        let productLoadNm = null;
        let listObserver = null;
        let listRenderQueued = false;

        function isOwnedPanelNode(node) {
            const element = node && node.nodeType === 1 ? node : node?.parentElement;
            return Boolean(element?.closest?.('.wb-list-product-panel, #wb-data-panel'));
        }

        function mutationNeedsListRender(records) {
            return records.some(record => {
                if (isOwnedPanelNode(record.target)) return false;
                const changedNodes = [...record.addedNodes, ...record.removedNodes];
                return changedNodes.length === 0 || changedNodes.some(node => !isOwnedPanelNode(node));
            });
        }

        function queueListRender() {
            if (pageMode !== 'list' && pageMode !== 'detail') return;
            if (pageMode === 'detail' && !detailRecommendNmIds.size) return;
            if (listRenderQueued) return;
            listRenderQueued = true;
            requestAnimationFrame(() => {
                listRenderQueued = false;
                if (pageMode === 'list' || pageMode === 'detail') renderListPanels();
            });
        }
    
        function getNmFromCatalogHref(href) {
            const match = String(href || '').match(/\/catalog\/(\d+)\/detail(?:\.aspx)?(?:[/?#]|$)/i);
            return match ? match[1] : '';
        }
    
        function getListCardNmId(card) {
            for (const key of ['data-nm-id', 'data-popup-nm-id', 'data-nm', 'data-nmid']) {
                const value = card.getAttribute(key);
                if (value && /^\d+$/.test(value.trim())) return value.trim();
            }
            const link = card.matches('a[href*="/catalog/"]')
                ? card
                : card.querySelector('a[href*="/catalog/"]');
            return getNmFromCatalogHref(link?.getAttribute('href'));
        }
    
        // 卖家推荐区域使用另一套自定义 Swiper 卡片结构；这里不注入商品数据面板。
        // 同时覆盖 CSS Module 可能追加的后缀，避免依赖某一个固定 hash 类名。
        const SELLER_RECOMMENDATION_SELECTOR = [
            '[class*="product-page__seller-recommend"]',
            '[class*="seller-recommend"]',
            '[class*="premium-products"]',
        ].join(', ');

        function isSellerRecommendationNode(node) {
            if (!node || node.nodeType !== 1) return false;
            return Boolean(node.closest(SELLER_RECOMMENDATION_SELECTOR));
        }

        // 详情页的颜色/规格缩略图也带有商品详情链接和 data-nm-id，
        // 但它们不是推荐商品卡，不能把列表面板插进横向缩略图滑块。
        function isDetailVariantSlideNode(node) {
            if (pageMode !== 'detail' || !node || node.nodeType !== 1) return false;
            const slide = node.closest('.swiper-slide, [class*="slide--"]');
            if (!slide) return false;
            const variantImageSelector = '[class*="colorImage"], [class*="color-image"], [class*="color_image"]';
            const hasVariantImage = slide.matches(variantImageSelector) || Boolean(slide.querySelector(variantImageSelector));
            const hasCatalogLink = slide.matches('a[href*="/catalog/"]') || Boolean(slide.querySelector('a[href*="/catalog/"]'));
            return hasVariantImage && hasCatalogLink;
        }
    
        // 未知卡片结构时的兜底：从商品详情链接往上找一块尺寸合理的祖先当容器。
        // 只在精确选择器一个都没命中时才跑，避免给正常页面增加布局开销。
        function findGenericCardHost(link) {
            let node = link;
            for (let depth = 0; depth < 6; depth++) {
                node = node.parentElement;
                if (!node || node === document.body || node === document.documentElement) return null;
                const rect = node.getBoundingClientRect();
                if (rect.height >= 120 && rect.width >= 60) return node;
            }
            return null;
        }
    
        function getListProductCards() {
            const cards = [];
            const cardIndexesByNmId = new Map();
            const addCard = candidate => {
                if (!candidate || candidate === document.body || isSellerRecommendationNode(candidate)) return;
                const source = candidate;
                if (isDetailVariantSlideNode(source)) return;
                const node = candidate.tagName === 'A' ? candidate.parentElement : candidate;
                if (!node || isSellerRecommendationNode(node) || isDetailVariantSlideNode(node)) return;
                const card = node.matches('article.product-card, .product-card')
                    ? node
                    : node.closest('article.product-card, .product-card') || node;
                if (!card || isSellerRecommendationNode(card) || card.tagName === 'A' || isDetailVariantSlideNode(card)) return;
                const nmId = getListCardNmId(card) || getListCardNmId(source);
                if (!nmId) return;
                const existingIndex = cardIndexesByNmId.get(nmId);
                if (existingIndex !== undefined) {
                    const existingCard = cards[existingIndex][1];
                    if (existingCard === card || card.contains(existingCard)) return;
                    // WB 的推荐滑块常把同一商品同时标在 swiper-slide 和内层 article 上。
                    // 只保留更具体的内层卡片，避免两个容器反复抢同一个面板。
                    if (existingCard.contains(card)) cards[existingIndex] = [nmId, card];
                    return;
                }
                cardIndexesByNmId.set(nmId, cards.length);
                cards.push([nmId, card]);
            };
    
            document.querySelectorAll('article.product-card, article[data-nm-id], article[data-popup-nm-id], .product-card, [data-nm-id], [data-popup-nm-id], [data-nm], [data-nmid]')
                .forEach(addCard);
            document.querySelectorAll('a[href*="/catalog/"][href*="/detail"]')
                .forEach(link => addCard(link.closest('article.product-card, .product-card, [data-nm-id], [data-popup-nm-id], [data-nm], [data-nmid], article')));
    
            if (!cards.length) {
                // 完全认不出的版式（图片搜索/店铺新模板等）：用详情链接 + 几何尺寸兜底。
                document.querySelectorAll('a[href*="/catalog/"][href*="/detail"]')
                    .forEach(link => {
                        if (cards.length >= 200 || isSellerRecommendationNode(link) || isDetailVariantSlideNode(link)) return;
                        const nmId = getNmFromCatalogHref(link.getAttribute('href'));
                        if (!nmId) return;
                        const host = findGenericCardHost(link);
                        if (isSellerRecommendationNode(host) || isDetailVariantSlideNode(host)) return;
                        if (!host || cardIndexesByNmId.has(nmId)) return;
                        cardIndexesByNmId.set(nmId, cards.length);
                        cards.push([nmId, host]);
                    });
            }
            return cards;
        }
    
        function listDisplayValue(value) {
            return value == null || value === '' ? '—' : String(value);
        }
    
        // 详情页与列表页共用：`YYYY-MM-DD（距今天数/月数）`。
        function formatCreatedAtWithAge(value) {
            if (value == null || value === '') return '—';
            const raw = String(value).trim();
            const dateOnly = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
            let createdAt;
            if (dateOnly) {
                createdAt = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
            } else if (typeof value === 'number' || /^\d{10,13}$/.test(raw)) {
                const timestamp = Number(value);
                createdAt = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
            } else {
                createdAt = new Date(raw);
            }
            if (Number.isNaN(createdAt.getTime())) return '—';
    
            const year = createdAt.getFullYear();
            const month = createdAt.getMonth();
            const day = createdAt.getDate();
            const pad = number => String(number).padStart(2, '0');
            const dateText = `${year}-${pad(month + 1)}-${pad(day)}`;
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const createdDay = new Date(year, month, day);
            if (createdDay > today) return '—';
    
            let fullMonths = (today.getFullYear() - year) * 12 + today.getMonth() - month;
            const anchorMonth = month + fullMonths;
            const anchorYear = year + Math.floor(anchorMonth / 12);
            const normalizedAnchorMonth = (anchorMonth % 12 + 12) % 12;
            const lastDayOfAnchorMonth = new Date(anchorYear, normalizedAnchorMonth + 1, 0).getDate();
            const monthAnniversary = new Date(
                anchorYear,
                normalizedAnchorMonth,
                Math.min(day, lastDayOfAnchorMonth),
            );
            if (monthAnniversary > today) fullMonths--;
    
            let age;
            if (fullMonths >= 12) {
                const years = Math.floor(fullMonths / 12);
                const remainingMonths = fullMonths % 12;
                age = `${years}年${remainingMonths ? `${remainingMonths}个月` : ''}`;
            } else if (fullMonths >= 1) {
                age = `${fullMonths}个月`;
            } else {
                const elapsedDays = Math.round((Date.UTC(
                    today.getFullYear(), today.getMonth(), today.getDate(),
                ) - Date.UTC(year, month, day)) / 86400000);
                age = `${elapsedDays}天`;
            }
            return `${dateText}（${age}）`;
        }
    
        function makeListField(label, value, href = '') {
            const field = document.createElement('div');
            field.style.cssText = 'min-width:0;min-height:30px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:1px;padding:3px 5px;border-left:2px solid #e8c4e2;border-radius:4px;background:#f8f7f8;';
            const labelEl = document.createElement('span');
            labelEl.textContent = label;
            labelEl.style.cssText = 'color:#777;font-size:9px;line-height:1.1;';
            const valueEl = href ? document.createElement('a') : document.createElement('span');
            valueEl.textContent = listDisplayValue(value);
            valueEl.title = listDisplayValue(value);
            valueEl.style.cssText = 'display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#292929;font-size:11px;line-height:1.2;font-weight:600;';
            if (href) {
                valueEl.href = href;
                valueEl.target = '_blank';
                valueEl.rel = 'noopener noreferrer';
                valueEl.style.color = '#cb11ab';
                valueEl.addEventListener('click', event => event.stopPropagation());
            }
            field.append(labelEl, valueEl);
            return field;
        }
    
        function updateListPanel(panel, nmId, product) {
            // card.json 是列表页唯一稳定的数据源：店铺页/图片搜索的接口结构各不相同，
            // 拿不到 product 时至少还能从 card.json 里读出上架时间、类目、体积、变体数。
            const cardData = listCardDataByNm.get(nmId) || null;
            const supplierId = product
                ? getSupplierId(product)
                : String(getCardField(cardData, ['supplier_id', 'supplierId']) || '').trim();
            const supplierRaw = product
                ? (product.supplierName ?? product.supplier_name ?? product.supplier)
                : getCardField(cardData, ['supplier_name', 'supplierName', 'seller_name']);
            const supplierName = supplierRaw == null ? '' : String(supplierRaw).trim();
            // 变体数和上架时间一样，都以 card.json 为准（搜索接口的 colors 是颜色名，不能用来数变体）。
            const cardLoading = listCardLoadStarted.has(nmId);
            const variantsCount = getCardVariantsCount(cardData);
            const variantsText = variantsCount == null
                ? (cardLoading ? '读取中…' : '—')
                : variantsCount;
            const rootId = product?.subjectParentId ?? getCardField(cardData, ['subject_root_id', 'subjectRootId']);
            const subjectId = product?.subjectId ?? getCardField(cardData, ['subject_id', 'subjectId']);
            const categoryData = findRemoteCategoryData(rootId, subjectId);
            const rootCategory = categoryData?.rootChinese || '';
            const secondCategory = categoryData?.secondChinese || '';
            const createdDateRaw = getCardField(product, ['create_date', 'createDate', 'created_at', 'createdAt'])
                || getCardField(cardData, ['create_date', 'createDate', 'created_at', 'createdAt']);
            const createdAt = createdDateRaw
                ? formatCreatedAtWithAge(createdDateRaw)
                : (cardLoading ? '读取中…' : '—');
            const volumeRaw = product?.volume;
            const volume = volumeRaw == null || volumeRaw === '' || !Number.isFinite(Number(volumeRaw))
                ? (getPackageVolume(cardData) || '—')
                : `${(Number(volumeRaw) / 10).toFixed(1)} 升`;
            const weightRaw = product?.weight;
            const weight = weightRaw == null || weightRaw === '' || !Number.isFinite(Number(weightRaw))
                ? '—'
                : `${Number(weightRaw).toFixed(1)} kg`;
            const brandText = product?.brand ?? getCardField(cardData, ['brand', 'selling_brand_name']);
            const stockText = product?.totalQuantity ?? getCardField(cardData, ['totalQuantity', 'total_quantity']);
            const signature = JSON.stringify(product ? [
                nmId, brandText, supplierName, supplierId,
                rootCategory, secondCategory, stockText,
                volumeRaw, weightRaw, variantsCount, variantsText, createdDateRaw, createdAt,
            ] : [
                nmId, 'card-only', brandText, supplierName, supplierId,
                rootCategory, secondCategory, stockText, volume, weight,
                variantsCount, variantsText, createdDateRaw, createdAt,
            ]);
            if (panel.dataset.wbSignature === signature) return;
            panel.dataset.wbSignature = signature;
            const skuEl = panel.querySelector('.wb-list-panel-sku');
            const bodyEl = panel.querySelector('.wb-list-panel-body');
            if (skuEl) skuEl.textContent = `SKU ${nmId}`;
            if (!bodyEl) return;
            bodyEl.replaceChildren();
    
            if (!product && !cardData) {
                const loadingEl = document.createElement('div');
                loadingEl.textContent = cardLoading ? '正在读取商品数据…' : '未捕获到商品数据';
                loadingEl.style.cssText = 'grid-column:1/-1;padding:4px 2px;color:#777;font-size:11px;';
                bodyEl.appendChild(loadingEl);
                return;
            }
    
            const sellerText = listDisplayValue(supplierName || supplierId);
            const sellerUrl = supplierId ? `https://www.wildberries.ru/seller/${supplierId}` : '';
            const createdAtField = makeListField('上架时间', createdAt);
            createdAtField.style.gridColumn = '1 / -1';
            bodyEl.append(
                makeListField('品牌', brandText),
                makeListField('店铺', sellerText, sellerUrl),
                makeListField('一级类目', rootCategory),
                makeListField('二级类目', secondCategory),
                makeListField('库存', stockText),
                makeListField('变体', variantsText),
                makeListField('体积', volume),
                makeListField('重量', weight),
                createdAtField,
            );
        }
    
        function getListPanelHost(card) {
            // product-card__wrapper 在部分新版模板只是图片/媒体包装层。
            // 面板挂在这里会改变图片容器的尺寸，并触发滑块重新测量；挂到卡片根节点才稳定。
            return card;
        }
    
        function fixListCardHeight(card) {
            const catalogCards = [];
            if (card.matches('[class*="catalogCard--"]')) catalogCards.push(card);
            card.querySelectorAll('[class*="catalogCard--"]:not([class*="catalogSellerShelf--"])')
                .forEach(node => catalogCards.push(node));
            for (const catalogCard of catalogCards) {
                if (catalogCard.style.getPropertyValue('block-size') !== 'auto' ||
                    catalogCard.style.getPropertyPriority('block-size') !== 'important') {
                    catalogCard.style.setProperty('block-size', 'auto', 'important');
                }
                if (catalogCard.style.getPropertyValue('min-block-size') !== '0px' ||
                    catalogCard.style.getPropertyPriority('min-block-size') !== 'important') {
                    catalogCard.style.setProperty('min-block-size', '0', 'important');
                }
            }
        }
    
        function cleanupDuplicateListPanels(cards) {
            const canonicalCards = new Map(cards);
            const keptCards = new Set();
            document.querySelectorAll('.wb-list-product-panel').forEach(panel => {
                const nmId = panel.dataset.wbNmId || '';
                const canonicalCard = canonicalCards.get(nmId);
                if (!canonicalCard) return;
                const nearestCard = panel.closest('article.product-card, .product-card');
                if (nearestCard && nearestCard !== canonicalCard) {
                    panel.remove();
                    return;
                }
                if (keptCards.has(canonicalCard)) panel.remove();
                else keptCards.add(canonicalCard);
            });
        }

        function renderListPanels() {
            if (pageMode !== 'list' && pageMode !== 'detail') return;
            document.querySelectorAll('.wb-list-product-panel').forEach(panel => {
                if (isSellerRecommendationNode(panel)) panel.remove();
            });
            const allCards = getListProductCards();
            const cards = pageMode === 'detail'
                ? allCards.filter(([nmId]) => detailRecommendNmIds.has(nmId))
                : allCards;
            if (pageMode === 'detail') {
                // 详情页只清理不再属于推荐接口结果的面板，主商品面板不受影响。
                // 变体缩略图也可能带 data-nm-id，清理旧版本误插进 swiper 的面板。
                document.querySelectorAll('.wb-list-product-panel').forEach(panel => {
                    if (!detailRecommendNmIds.has(panel.dataset.wbNmId || '') ||
                        isDetailVariantSlideNode(panel)) panel.remove();
                });
            }
            cleanupDuplicateListPanels(cards);
            // 列表页和详情页推荐卡都按渲染出来的卡片补抓 basket card.json。
            // 先登记再渲染，第一帧就能显示「读取中…」；已加载/请求中/超过重试上限的会被内部过滤。
            queueListCardDataLoads(cards.map(([nmId]) => nmId));
            for (const [nmId, card] of cards) {
                fixListCardHeight(card);
                const host = getListPanelHost(card);
                if (!host || isSellerRecommendationNode(host) || isDetailVariantSlideNode(host)) continue;
                const panels = [...card.querySelectorAll('.wb-list-product-panel')];
                let panel = panels.find(item => item.dataset.wbNmId === nmId) || panels[0];
                for (const extra of panels) {
                    if (extra !== panel) extra.remove();
                }
                if (!panel) {
                    panel = document.createElement('div');
                    panel.className = 'wb-list-product-panel';
                    panel.dataset.wbNmId = nmId;
                    panel.style.cssText = 'box-sizing:border-box;width:calc(100% - 6px);margin:5px 3px 3px;overflow:hidden;position:relative;z-index:20;clear:left;border:1px solid #e8e9ea;border-radius:8px;background:#fff;color:#222;box-shadow:0 2px 10px rgba(0,0,0,.08);font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif;text-align:left;';
                    const header = document.createElement('div');
                    header.style.cssText = 'box-sizing:border-box;display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 8px;background:#cb11ab;color:#fff;font-size:11px;line-height:1.3;font-weight:600;';
                    const title = document.createElement('span');
                    title.textContent = 'WB 商品数据';
                    title.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                    const sku = document.createElement('span');
                    sku.className = 'wb-list-panel-sku';
                    sku.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;';
                    const skuActions = document.createElement('div');
                    skuActions.style.cssText = 'display:flex;align-items:center;gap:5px;min-width:0;flex:0 0 auto;';
                    const copyButton = document.createElement('button');
                    copyButton.type = 'button';
                    copyButton.textContent = '复制';
                    copyButton.title = '复制 SKU / WB 编号';
                    copyButton.setAttribute('aria-label', '复制 SKU / WB 编号');
                    copyButton.style.cssText = 'border:1px solid rgba(255,255,255,.65);border-radius:3px;padding:2px 5px;background:transparent;color:#fff;cursor:pointer;font:inherit;font-size:10px;line-height:1.2;';
                    copyButton.addEventListener('click', event => {
                        event.preventDefault();
                        event.stopPropagation();
                        const value = panel.dataset.wbNmId || nmId;
                        copyText(value).then(() => {
                            copyButton.textContent = '已复制';
                            setTimeout(() => {
                                if (copyButton.isConnected) copyButton.textContent = '复制';
                            }, 1200);
                        }).catch(() => {
                            copyButton.textContent = '失败';
                            setTimeout(() => {
                                if (copyButton.isConnected) copyButton.textContent = '复制';
                            }, 1200);
                        });
                    });
                    skuActions.append(sku, copyButton);
                    header.append(title, skuActions);
                    const body = document.createElement('div');
                    body.className = 'wb-list-panel-body';
                    body.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;padding:6px 7px;';
                    panel.append(header, body);
                }
                if (panel.parentElement !== host) host.appendChild(panel);
                panel.dataset.wbNmId = nmId;
                updateListPanel(panel, nmId, listProductsByNm.get(nmId) || null);
            }
        }
    
        function enterListMode() {
            if (pageMode !== 'list') return;
            if (!document.body) {
                setTimeout(enterListMode, 50);
                return;
            }
            if (!listObserver) {
                listObserver = new MutationObserver(records => {
                    if (mutationNeedsListRender(records)) queueListRender();
                });
                listObserver.observe(document.body, { childList: true, subtree: true });
            }
            loadRemoteCommissionData();
            queueListRender();
        }
    
        function leaveListMode() {
            listObserver?.disconnect();
            listObserver = null;
            listRenderQueued = false;
            document.querySelectorAll('.wb-list-product-panel').forEach(panel => panel.remove());
            listProductsByNm.clear();
            listCardDataByNm.clear();
            listCardLoadStarted.clear();
            listCardLoadFailures.clear();
            listCardLoadQueue = Promise.resolve();
        }
    
        function ensureDetailState() {
            if (!window.__WB_CAPTURED__ || typeof window.__WB_CAPTURED__ !== 'object') {
                window.__WB_CAPTURED__ = Object.create(null);
            }
            if (!window.__WB_CARD__ || typeof window.__WB_CARD__ !== 'object') {
                window.__WB_CARD__ = Object.create(null);
            }
            if (!window.__WB_DETAIL_URLS__ || typeof window.__WB_DETAIL_URLS__ !== 'object') {
                window.__WB_DETAIL_URLS__ = Object.create(null);
            }
            if (!window.__WB_CARD_URLS__ || typeof window.__WB_CARD_URLS__ !== 'object') {
                window.__WB_CARD_URLS__ = Object.create(null);
            }
        }
    
        function clearProductLoadTimeout() {
            if (productLoadTimer !== null) window.clearTimeout(productLoadTimer);
            productLoadTimer = null;
            productLoadNm = null;
        }
    
        function scheduleProductLoadTimeout(nmId) {
            if (productLoadTimer !== null && productLoadNm === nmId) return;
            clearProductLoadTimeout();
            productLoadNm = nmId;
            productLoadTimer = window.setTimeout(() => {
                productLoadTimer = null;
                if (pageMode !== 'detail' || getCurrentNmId() !== nmId) return;
                if (window.__WB_CAPTURED__?.[nmId]) return;
                if (window.__WB_CARD__?.[nmId]) {
                    renderFields(mergeCategory({}, nmId), false, '', '详情数据未返回，可点右上角刷新');
                } else {
                    renderFields(null, false, '商品数据接口未返回，请刷新或稍后重试。');
                }
            }, 10000);
        }
    
        function queueInsert() {
            if (insertQueued) return;
            insertQueued = true;
            requestAnimationFrame(() => {
                insertQueued = false;
                if (pageMode === 'detail' && panelEl && !panelClosed) insertIntoPage();
            });
        }
    
        function resetDetailRecommendations() {
            document.querySelectorAll('.wb-list-product-panel').forEach(panel => panel.remove());
            detailRecommendNmIds.clear();
            listProductsByNm.clear();
            listCardDataByNm.clear();
            listCardLoadStarted.clear();
            listCardLoadFailures.clear();
            listCardLoadQueue = Promise.resolve();
            listRenderQueued = false;
        }
    
        function leaveDetailMode() {
            resetDetailRecommendations();
            detailObserver?.disconnect();
            detailObserver = null;
            insertQueued = false;
            clearProductLoadTimeout();
            panelEl?.remove();
            panelEl = null;
            bodyEl = null;
            panelPlacementNm = null;
            lastRenderedNm = null;
            panelClosed = false;
            window.__WB_CAPTURED__ = Object.create(null);
            window.__WB_CARD__ = Object.create(null);
            window.__WB_DETAIL_URLS__ = Object.create(null);
            window.__WB_CARD_URLS__ = Object.create(null);
            recoveredCardUrls.clear();
            recoveredDetailUrls.clear();
        }
    
        function ensurePanel() {
            if (panelEl) return;
            ensureDetailState();
            panelEl = document.createElement('div');
            panelEl.id = 'wb-data-panel';
            panelEl.style.cssText = `
                margin: 0;
                width: 230px;
                max-width: calc(100vw - 24px);
                box-sizing: border-box;
                background: #fff;
                color: #222;
                border-radius: 8px;
                box-shadow: 0 2px 10px rgba(0,0,0,.08);
                font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
                font-size: 13px;
                overflow-x: hidden;
                overflow-y: auto;
                display: none;
            `;
            const header = document.createElement('div');
            header.style.cssText = `
                padding: 6px 8px;
                background: #cb11ab;
                color: #fff;
                font-weight: 600;
                font-size: 13px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            `;
            const title = document.createElement('span');
            title.textContent = 'WB 商品数据';
            header.appendChild(title);
            const headerActions = document.createElement('div');
            headerActions.style.cssText = `display:flex; align-items:center; gap:8px;`;
            const refreshBtn = document.createElement('button');
            refreshBtn.type = 'button';
            refreshBtn.setAttribute('aria-label', '刷新商品数据');
            refreshBtn.title = '重新读取页面已捕获的商品数据';
            refreshBtn.textContent = '↻';
            refreshBtn.style.cssText = `border:0; padding:0 2px; background:transparent; color:inherit; cursor:pointer; font-size:17px; line-height:1; opacity:.9;`;
            refreshBtn.onclick = async e => {
                e.stopPropagation();
                if (refreshBtn.disabled) return;
                const nmId = getCurrentNmId();
                if (!nmId) return;
                refreshBtn.disabled = true;
                refreshBtn.textContent = '…';
                try {
                    const found = await refreshProductData(nmId);
                    refreshBtn.textContent = found ? '✓' : '!';
                    refreshBtn.title = found ? '已从页面数据刷新' : '页面中尚未捕获当前商品数据';
                } catch (error) {
                    refreshBtn.textContent = '!';
                    refreshBtn.title = '读取页面商品数据失败，请查看控制台';
                    console.warn('[WB刷新] 读取已捕获商品数据失败', error);
                } finally {
                    window.setTimeout(() => {
                        refreshBtn.disabled = false;
                        refreshBtn.textContent = '↻';
                        refreshBtn.title = '重新读取页面已捕获的商品数据';
                    }, 1400);
                }
            };
            headerActions.appendChild(refreshBtn);
            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.setAttribute('aria-label', '关闭商品数据');
            closeBtn.textContent = '✕';
            closeBtn.style.cssText = `border:0; padding:0; background:transparent; color:inherit; cursor:pointer; font-size:15px; opacity:.85;`;
            closeBtn.onclick = () => {
                panelClosed = true;
                panelEl.style.display = 'none';
            };
            headerActions.appendChild(closeBtn);
            header.appendChild(headerActions);
            bodyEl = document.createElement('div');
            bodyEl.style.cssText = `padding: 6px 8px;`;
            panelEl.appendChild(header);
            panelEl.appendChild(bodyEl);
        }
    
        function enterDetailMode() {
            if (pageMode !== 'detail') return;
            installNetworkHooks();
            if (!document.body) {
                setTimeout(enterDetailMode, 50);
                return;
            }
            ensureDetailState();
            ensurePanel();
            panelClosed = false;
            if (!detailObserver && document.body) {
                detailObserver = new MutationObserver(records => {
                    queueInsert();
                    if (mutationNeedsListRender(records)) queueListRender();
                });
                detailObserver.observe(document.documentElement, {
                    childList: true,
                    subtree: true,
                });
            }
            lastRenderedNm = null;
            tryRender();
            queueListRender();
            loadRemoteCommissionData();
            scheduleProductDataRecovery(getCurrentNmId());
        }
    
        // ===== 页面类型（可分别开关）=====
        const PAGE_KINDS = {
            detail: { label: '详情页', desc: '/catalog/{nmId}/detail' },
            list: { label: '列表页', desc: '类目 / 搜索 / 品牌 / 促销网格' },
            home: { label: '首页', desc: 'wildberries.ru 首页推荐流' },
            seller: { label: '店铺页', desc: '/seller/{id}' },
            imageSearch: { label: '图片搜索页', desc: '/search/image' },
        };
        const PAGE_KIND_SETTING_KEY = 'wb_panel_page_kinds_v1';
        let pageKindEnabled = null;
    
        function readStoredPageKindEnabled() {
            let raw = null;
            try { raw = GM_getValue(PAGE_KIND_SETTING_KEY, null); } catch (e) {}
            if (!raw) {
                try { raw = JSON.parse(localStorage.getItem(PAGE_KIND_SETTING_KEY) || 'null'); } catch (e) {}
            }
            return raw && typeof raw === 'object' ? raw : null;
        }
    
        function getPageKindEnabled() {
            if (pageKindEnabled) return pageKindEnabled;
            const stored = readStoredPageKindEnabled() || {};
            pageKindEnabled = {};
            for (const kind of Object.keys(PAGE_KINDS)) {
                pageKindEnabled[kind] = stored[kind] !== false;
            }
            return pageKindEnabled;
        }
    
        function isPageKindEnabled(kind) {
            return Boolean(kind) && PAGE_KINDS[kind] && getPageKindEnabled()[kind] !== false;
        }
    
        function setPageKindEnabled(kind, enabled) {
            if (!PAGE_KINDS[kind]) return;
            pageKindEnabled = { ...getPageKindEnabled(), [kind]: Boolean(enabled) };
            try { GM_setValue(PAGE_KIND_SETTING_KEY, pageKindEnabled); } catch (e) {}
            try { localStorage.setItem(PAGE_KIND_SETTING_KEY, JSON.stringify(pageKindEnabled)); } catch (e) {}
        }
    
        // 路由无法识别时的兜底：直接用 DOM 证据判定是不是卡片网格页。
        // WB 上新模板很快（图片搜索 / 店铺新橱窗等），路径表追不上时就靠这个。
        function countDetailLinks() {
            return document.querySelectorAll('a[href*="/catalog/"][href*="/detail"]').length;
        }
        function hasProductCardEvidence() {
            return countDetailLinks() >= 4;
        }
    
        function resolvePageKind() {
            if (isDetailRoute()) return 'detail';
            if (isHomeRoute()) return 'home';
            if (isImageSearchRoute()) return 'imageSearch';
            if (isSellerRoute()) return 'seller';
            if (isKnownListRoute()) return 'list';
            // 非商品集合区（购物篮、订单…）也可能零星出现详情链接，要求有规模才判定为列表页。
            return hasProductCardEvidence() ? 'list' : null;
        }
    
        // 页面类型 → 工作模式。类型被关掉时返回 null，即不渲染任何面板。
        function resolvePageMode() {
            const kind = resolvePageKind();
            if (!kind || !isPageKindEnabled(kind)) return null;
            return kind === 'detail' ? 'detail' : 'list';
        }
    
        function switchPageMode() {
            const nextMode = resolvePageMode();
            if (nextMode === pageMode) {
                if (nextMode === 'detail') {
                    resetDetailRecommendations();
                    lastRenderedNm = null;
                    tryRender();
                    queueInsert();
                    scheduleProductDataRecovery(getCurrentNmId());
                } else if (nextMode === 'list') {
                    queueListRender();
                }
                if (nextMode) stopUnknownRouteProbe();
                else if (!resolvePageKind()) startUnknownRouteProbe();
                else stopUnknownRouteProbe();
                updatePageKindHint();
                return;
            }
            if (pageMode === 'detail') leaveDetailMode();
            else if (pageMode === 'list') leaveListMode();
            pageMode = nextMode;
            if (pageMode === 'detail') enterDetailMode();
            else if (pageMode === 'list') enterListMode();
            if (pageMode) stopUnknownRouteProbe();
            else if (!resolvePageKind()) startUnknownRouteProbe();
            else stopUnknownRouteProbe();
            updatePageKindHint();
        }
    
        // 首帧拿不到卡片（SPA 还没渲染完）时不能直接放弃，观察 DOM 直到出现卡片或离开该 URL。
        let unknownRouteProbe = null;
    
        function stopUnknownRouteProbe() {
            if (!unknownRouteProbe) return;
            unknownRouteProbe.disconnect();
            unknownRouteProbe = null;
        }
    
        function startUnknownRouteProbe() {
            if (unknownRouteProbe || !document.body) return;
            const probedPath = location.pathname;
            let queued = false;
            const evaluate = () => {
                queued = false;
                if (location.pathname !== probedPath) { // 用户已经切走了
                    stopUnknownRouteProbe();
                    return;
                }
                if (pageMode) { stopUnknownRouteProbe(); return; }
                if (!hasProductCardEvidence()) return;
                stopUnknownRouteProbe();
                switchPageMode();
            };
            unknownRouteProbe = new MutationObserver(() => {
                if (queued) return;
                queued = true;
                requestAnimationFrame(evaluate);
            });
            unknownRouteProbe.observe(document.body, { childList: true, subtree: true });
            console.info('[WB路由] 当前页面无法按路径识别，已启用 DOM 探测', location.pathname);
        }
    
        function handleRouteChange() {
            const href = location.href;
            if (href === lastRouteHref) return;
            lastRouteHref = href;
            stopUnknownRouteProbe();
            switchPageMode();
        }
    
        function installRouteHooks() {
            if (routeHooksInstalled) return;
            routeHooksInstalled = true;
            window.addEventListener('popstate', handleRouteChange);
            window.addEventListener('hashchange', handleRouteChange);
    
            // Some WB page/extension environments expose read-only History methods.
            // Poll the URL as a safe fallback instead of replacing pushState/replaceState.
            routePollTimer = window.setInterval(() => {
                if (location.href !== lastRouteHref) handleRouteChange();
            }, 400);
        }
    
        function renderFields(product, isLoading, message = '', detailPending = false) {
            ensurePanel();
            if (!product) {
                bodyEl.innerHTML = isLoading
                    ? `<div style="color:#999">加载中…</div>`
                    : `<div style="color:#999">${message || '等待数据中…'}</div>`;
            } else {
                bodyEl.innerHTML = '';
                if (detailPending) {
                    const pendingEl = document.createElement('div');
                    pendingEl.textContent = typeof detailPending === 'string'
                        ? detailPending
                        : '正在等待商品详情数据';
                    pendingEl.style.cssText = `margin-bottom:4px; color:#888; font-size:11px; line-height:1.3;`;
                    bodyEl.appendChild(pendingEl);
                }
                const subjName = getByPath(product, '__card__.subj_name');
                const subjRootName = getByPath(product, '__card__.subj_root_name');
                const subjRootId = getByPath(product, '__card__.subject_root_id');
                const subjectId = getByPath(product, '__card__.subject_id');
                const categoryData = findRemoteCategoryData(subjRootId, subjectId);
                const measureGrid = document.createElement('div');
                measureGrid.style.cssText = `
                    display:grid; grid-template-columns:repeat(2,minmax(0,1fr));
                    gap:4px; align-items:stretch;
                `;
                bodyEl.appendChild(measureGrid);
    
                const appendFieldRow = (label, value, compact = false, trailing = null, valueBold = false) => {
                    const val = value === undefined || value === null || value === '' ? '—' : String(value);
                    const row = document.createElement('div');
                    row.style.cssText = compact ? `
                        min-width:0; min-height:40px; box-sizing:border-box;
                        display:flex; flex-direction:column; justify-content:center; gap:2px;
                        padding:4px 6px; border-left:2px solid #e8c4e2; border-radius:4px;
                        background:#f8f7f8;
                    ` : `
                        min-width:0; display:grid;
                        grid-template-columns:${trailing ? 'auto minmax(0,1fr) auto' : 'auto minmax(0,1fr)'};
                        align-items:center; gap:${trailing ? '4px' : '6px'}; padding:4px 0;
                        border-bottom:1px solid #eee;
                    `;
                    if (label) {
                        const labelEl = document.createElement('span');
                        labelEl.textContent = label;
                        labelEl.style.cssText = `
                            grid-column:1; color:#777; font-weight:400; white-space:nowrap;
                            font-size:11px; line-height:1.2;
                        `;
                        row.appendChild(labelEl);
                    }
                    const valEl = document.createElement('span');
                    valEl.textContent = val;
                    valEl.style.cssText = `
                        grid-column:2; min-width:0; font-weight:${valueBold ? 700 : 600};
                        overflow-wrap:${trailing ? 'normal' : 'anywhere'};
                        white-space:${trailing ? 'nowrap' : 'normal'};
                        overflow:${trailing ? 'hidden' : 'visible'};
                        text-overflow:${trailing ? 'ellipsis' : 'clip'}; text-align:left;
                        font-size:${compact ? '13px' : (trailing ? '11px' : '12px')}; line-height:1.2;
                    `;
                    if (compact) row.appendChild(valEl);
                    else {
                        row.appendChild(valEl);
                    }
                    if (trailing) {
                        trailing.style.gridColumn = '3';
                        row.appendChild(trailing);
                    }
                    (compact ? measureGrid : bodyEl).appendChild(row);
                };
    
                const appendCategoryCell = (label, russianName, chineseName, canCopy = false) => {
                    const cell = document.createElement('div');
                    cell.style.cssText = `
                        min-width:0; padding:3px 0 4px;
                    `;
    
                    const labelEl = document.createElement('div');
                    labelEl.textContent = label;
                    labelEl.style.cssText = `color:#666; font-size:11px; line-height:1.2; margin-bottom:2px;`;
    
                    const valueRow = document.createElement('div');
                    valueRow.style.cssText = `
                        display:grid; grid-template-columns:${canCopy ? 'minmax(0,1fr) 32px' : 'minmax(0,1fr)'};
                        align-items:start; gap:4px; min-width:0;
                    `;
    
                    const russianEl = document.createElement('span');
                    russianEl.textContent = russianName == null || russianName === '' ? '—' : String(russianName);
                    russianEl.style.cssText = `
                        min-width:0; font-size:13px; line-height:1.25; font-weight:600;
                        overflow-wrap:anywhere;
                    `;
    
                    const chineseEl = document.createElement('div');
                    chineseEl.textContent = chineseName == null || chineseName === '' ? '—' : String(chineseName);
                    chineseEl.style.cssText = `
                        font-size:12px; line-height:1.25; font-weight:600;
                        color:#333; overflow-wrap:anywhere;
                    `;
    
                    const makeCopyButton = (value, title) => {
                        const copyBtn = document.createElement('button');
                        copyBtn.type = 'button';
                        copyBtn.textContent = '复制';
                        copyBtn.title = title;
                        copyBtn.style.cssText = `
                            width:32px; box-sizing:border-box; padding:3px 2px;
                            font-size:11px; line-height:1.2; white-space:nowrap;
                            background:#f3e6f1; color:#a30d89;
                            border:1px solid #e7c9e3; border-radius:4px; cursor:pointer;
                        `;
                        copyBtn.onclick = e => {
                            e.stopPropagation();
                            const text = String(value == null ? '' : value).trim() || '—';
                            copyText(text).then(() => {
                                copyBtn.textContent = '完成';
                                setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
                            }).catch(() => alert('复制失败，请手动复制。'));
                        };
                        return copyBtn;
                    };
    
                    valueRow.appendChild(russianEl);
                    if (canCopy) valueRow.appendChild(makeCopyButton(russianName, '复制二级类目俄语'));
    
                    const chineseRow = document.createElement('div');
                    chineseRow.style.cssText = `
                        display:${canCopy ? 'grid' : 'block'};
                        grid-template-columns:minmax(0,1fr) 32px;
                        align-items:start; gap:4px; min-width:0; margin-top:2px;
                    `;
                    chineseRow.appendChild(chineseEl);
                    if (canCopy) chineseRow.appendChild(makeCopyButton(chineseName, '复制二级类目中文'));
    
                    cell.appendChild(labelEl);
                    cell.appendChild(valueRow);
                    cell.appendChild(chineseRow);
                    return cell;
                };
    
                const appendCategoryGrid = () => {
                    const categoryGrid = document.createElement('div');
                    categoryGrid.style.cssText = `
                        display:grid; grid-template-columns:repeat(2,minmax(0,1fr));
                        column-gap:8px; align-items:start; margin:4px 0 2px;
                        padding:4px 0 3px; border-top:1px solid #eee;
                        border-bottom:1px solid #eee;
                    `;
                    categoryGrid.appendChild(appendCategoryCell(
                        '一级类目', subjRootName, categoryData && categoryData.rootChinese
                    ));
                    categoryGrid.appendChild(appendCategoryCell(
                        '二级类目', subjName, categoryData && categoryData.secondChinese, true
                    ));
                    bodyEl.appendChild(categoryGrid);
                };
    
                const makeButtonGroup = () => {
                    const group = document.createElement('div');
                    group.style.cssText = `display:flex; align-items:center; gap:4px; flex:0 0 auto;`;
                    return group;
                };
                // 评论 / 提问：挂在「佣金」行右侧
                const makeDownloadButtons = () => {
                    const group = makeButtonGroup();
                    const makeDownloadButton = (label, download) => {
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.textContent = label;
                        button.title = `下载当前商品${label}`;
                        button.style.cssText = `
                            flex:0 0 34px; width:34px; height:20px; box-sizing:border-box;
                            padding:1px 2px; font-size:11px; line-height:16px;
                            white-space:nowrap; background:#f3e6f1; color:#a30d89;
                            border:1px solid #e7c9e3; border-radius:4px; cursor:pointer;
                        `;
                        const readImtId = () => String(getCardField(
                            window.__WB_CARD__?.[getCurrentNmId()],
                            ['imt_id', 'imtId']
                        ) || '').trim();
                        button.disabled = !/^\d+$/.test(readImtId());
                        if (button.disabled) {
                            button.title = '卡片数据尚未加载或缺少 imt_id';
                            button.style.cssText += 'opacity:.55;cursor:not-allowed;';
                        }
                        button.onclick = async e => {
                            e.stopPropagation();
                            if (button.disabled) return;
                            const imtId = readImtId();
                            if (!/^\d+$/.test(imtId)) {
                                alert('当前商品卡片数据缺少有效的 imt_id。');
                                return;
                            }
                            button.disabled = true;
                            button.textContent = '…';
                            try {
                                await download(imtId, getCurrentNmId());
                                button.textContent = '完成';
                            } catch (error) {
                                if (error && error.wbEmptyData) {
                                    button.textContent = '无数据';
                                    button.title = error.message;
                                    showToast(error.message, button);
                                } else {
                                    button.textContent = '失败';
                                    alert(`${label}下载失败：${error.message || error}`);
                                }
                            } finally {
                                window.setTimeout(() => {
                                    if (!button.isConnected) return;
                                    button.disabled = false;
                                    button.textContent = label;
                                }, 1400);
                            }
                        };
                        return button;
                    };
                    group.appendChild(makeDownloadButton('评论', downloadProductFeedback));
                    group.appendChild(makeDownloadButton('提问', downloadProductQuestions));
                    return group;
                };
                // 标题 / 详情：留在「上架时间」行右侧
                const makeTextCopyButtons = () => {
                    const group = makeButtonGroup();
                    const addButton = (label, fieldName, title) => {
                        const button = document.createElement('button');
                        button.type = 'button';
                        button.textContent = label;
                        button.title = title;
                        button.style.cssText = `
                            flex:0 0 34px; width:34px; height:20px; box-sizing:border-box;
                            padding:1px 2px; font-size:11px; line-height:16px;
                            white-space:nowrap; background:#f3e6f1; color:#a30d89;
                            border:1px solid #e7c9e3; border-radius:4px; cursor:pointer;
                        `;
                        const cardValue = getCardField(
                            window.__WB_CARD__?.[getCurrentNmId()],
                            [fieldName]
                        );
                        button.disabled = !String(cardValue == null ? '' : cardValue).trim();
                        if (button.disabled) {
                            button.title = `${title}（卡片数据尚未加载）`;
                            button.style.cssText += 'opacity:.55;cursor:not-allowed;';
                        }
                        button.onclick = e => {
                            e.stopPropagation();
                            const currentValue = getCardField(
                                window.__WB_CARD__?.[getCurrentNmId()],
                                [fieldName]
                            );
                            const text = currentValue == null ? '' : String(currentValue);
                            if (!text.trim()) return;
                            copyText(text).then(() => {
                                button.textContent = '完成';
                                setTimeout(() => { button.textContent = label; }, 1200);
                            }).catch(() => alert('复制失败，请手动复制。'));
                        };
                        group.appendChild(button);
                    };
                    addButton('标题', 'imt_name', '复制商品标题');
                    addButton('详情', 'description', '复制商品详情');
                    return group;
                };
    
                for (const f of FIELDS) {
                    if (f.path === '__card__.create_date') appendCategoryGrid();
                    const raw = getByPath(product, f.path);
                    const cardCopyButtons = f.path === '__card__.create_date'
                        ? makeTextCopyButtons()
                        : null;
                    appendFieldRow(f.label, formatValue(f, raw), f.compact === true, cardCopyButtons, f.valueBold === true);
                }
    
                // ===== 佣金行 =====
                const comm = findProductCommission(subjRootId, subjectId);
    
                const commRow = document.createElement('div');
                commRow.style.cssText = `
                    margin-top:4px; display:flex; align-items:center; gap:6px;
                    min-width:0; padding:4px 0; border-bottom:1px solid #eee;
                `;
                const commLabel = document.createElement('div');
                commLabel.textContent = '佣金';
                commLabel.style.cssText = `color:#666; font-size:11px; white-space:nowrap;`;
    
                const commValueRow = document.createElement('div');
                // flex:1 让佣金标签占满中间，标签多了自己换行，右侧按钮不会被挤走
                commValueRow.style.cssText = `display:flex; flex:1 1 auto; min-width:0; gap:3px; align-items:center; flex-wrap:wrap;`;
    
                function mkTag(text, val, color) {
                    const el = document.createElement('span');
                    el.style.cssText = `
                        display:inline-flex; align-items:center; gap:3px;
                        padding:2px 4px; border-radius:4px; font-size:11px; line-height:1.2;
                        background:${color}12; color:${color};
                        border:1px solid ${color}33;
                    `;
                    el.innerHTML = `<span style="opacity:.75;">${text}</span><b>${val}</b>`;
                    return el;
                }
    
                if (comm) {
                    commValueRow.appendChild(mkTag('本FBO', comm[0], '#cb11ab'));
                    commValueRow.appendChild(mkTag('本FBS', comm[1], '#5b8def'));
                    commValueRow.appendChild(mkTag('跨FBS', comm[2], '#3aa76d'));
                } else {
                    const nf = document.createElement('span');
                    nf.textContent = categoryData
                        ? `无对应佣金：${subjName || subjectId}`
                        : subjRootId && subjectId
                            ? `未匹配类目 ID：${subjRootId}/${subjectId}`
                            : '缺少类目 ID';
                    nf.style.cssText = `color:#999; font-size:12px; min-width:0; overflow-wrap:anywhere;`;
                    commValueRow.appendChild(nf);
                }
    
                commRow.appendChild(commLabel);
                commRow.appendChild(commValueRow);
                // 评论 / 提问 下载按钮挪到佣金行右侧
                commRow.appendChild(makeDownloadButtons());
                bodyEl.appendChild(commRow);
    
                if (remoteCommissionStatus.kind !== 'loaded') {
                    const statusEl = document.createElement('div');
                    statusEl.textContent = remoteCommissionStatus.message;
                    statusEl.style.cssText = `
                        padding:3px 0; font-size:11px; line-height:1.3;
                        color:${remoteCommissionStatus.kind === 'error' ? '#b42318' : '#888'};
                    `;
                    bodyEl.appendChild(statusEl);
                }
    
                // ===== WB折扣 输入 =====
                const coefRow = document.createElement('div');
                coefRow.style.cssText = `
                    margin-top:3px; display:flex; align-items:center;
                    gap:2px; min-width:0; padding:3px 0;
                `;
    
                const coefLeft = document.createElement('div');
                coefLeft.style.cssText = `
                    display:flex; align-items:center; gap:2px;
                    flex:1 1 auto; min-width:0;
                `;
                const coefLabel = document.createElement('span');
                coefLabel.textContent = 'WB折扣';
                coefLabel.style.cssText = `
                    display:flex; align-items:center; justify-content:center;
                    flex:0 0 auto; height:24px; min-width:0; box-sizing:border-box;
                    color:#666; font-size:11.5px; line-height:1; white-space:nowrap;
                `;
    
                const coefWrap = document.createElement('div');
                coefWrap.style.cssText = `
                    display:flex; align-items:center; justify-content:center;
                    flex:1 1 48px; width:48px; min-width:42px; height:24px; box-sizing:border-box;
                    border: 1px solid #e0e0e0;
                    border-radius: 5px;
                    background: #fafafa;
                    padding: 0 1px;
                    transition: border-color .15s, box-shadow .15s, background .15s;
                `;
    
                const coefInput = document.createElement('input');
                coefInput.type = 'number';
                coefInput.step = '1';
                coefInput.min = '0';
                coefInput.max = '99';
                coefInput.value = String(getDiscountPercent());
                coefInput.style.cssText = `
                    width: 100%; min-width:0; flex:1 1 0; box-sizing:border-box;
                    border: none;
                    outline: none;
                    background: transparent;
                    font-size: 14px;
                    font-weight: 600;
                    color: #cb11ab;
                    text-align: center;
                    padding: 0;
                    -moz-appearance: textfield;
                    appearance: textfield;
                `;
                coefInput.classList.add('wb-no-spin');
                coefInput.addEventListener('wheel', e => e.preventDefault(), { passive: false });
    
                if (!document.getElementById('wb-no-spin-style')) {
                    const st = document.createElement('style');
                    st.id = 'wb-no-spin-style';
                    st.textContent = `
                        .wb-no-spin::-webkit-outer-spin-button,
                        .wb-no-spin::-webkit-inner-spin-button {
                            -webkit-appearance: none !important;
                            margin: 0 !important;
                        }
                        .wb-no-spin {
                            -moz-appearance: textfield !important;
                            appearance: textfield !important;
                        }
                    `;
                    document.head.appendChild(st);
                }
    
                const percentSign = document.createElement('span');
                percentSign.textContent = '%';
                percentSign.style.cssText = `
                    color: #999;
                    font-size: 12px;
                    margin-left: 1px;
                    user-select: none;
                `;
    
                coefInput.addEventListener('focus', () => {
                    coefWrap.style.borderColor = '#cb11ab';
                    coefWrap.style.background  = '#fff';
                    coefWrap.style.boxShadow   = '0 0 0 2px rgba(203,17,171,.12)';
                });
                coefInput.addEventListener('blur', () => {
                    coefWrap.style.borderColor = '#e0e0e0';
                    coefWrap.style.background  = '#fafafa';
                    coefWrap.style.boxShadow   = 'none';
                });
    
                coefInput.onchange = () => {
                    setDiscountPercent(coefInput.value);
                    coefInput.value = String(getDiscountPercent());
                };
    
                coefWrap.appendChild(coefInput);
                coefWrap.appendChild(percentSign);
    
                coefLeft.appendChild(coefLabel);
                coefLeft.appendChild(coefWrap);
                coefRow.appendChild(coefLeft);
    
                const actionGroup = document.createElement('div');
                actionGroup.style.cssText = `
                    display:flex; align-items:center; flex:0 0 60%;
                    gap:1px; min-width:0; margin-left:auto;
                `;
    
                const actionButtonStyle = `
                    display:flex; align-items:center; justify-content:center;
                    flex:1 1 0; width:0; min-width:0; height:24px; box-sizing:border-box;
                    margin:0; padding:0; font-size:10.5px; line-height:1; font-weight:600; white-space:nowrap;
                    background:#cb11ab; color:#fff; border:none;
                    border-radius:5px; cursor:pointer;
                `;
    
                const budgetBtn = document.createElement('button');
                budgetBtn.type = 'button';
                budgetBtn.textContent = '预算计算';
                budgetBtn.style.cssText = actionButtonStyle;
                budgetBtn.onclick = (e) => {
                    e.stopPropagation();
                    const weightRaw    = getByPath(product, 'weight');
                    const volumeRaw    = getByPath(product, 'volume');
                    const productRaw   = pickProductPrice(product);
                    const subjName     = getByPath(product, '__card__.subj_name');
                    const subjRootName = getByPath(product, '__card__.subj_root_name');
    
                    const weight = (weightRaw == null || weightRaw === '') ? '' : Number(weightRaw).toFixed(1);
                    const volume = (volumeRaw == null || volumeRaw === '') ? '' : (Number(volumeRaw) / 10).toFixed(1);
                    const discount = getDiscountPercent();
                    const price = calcSellPrice(productRaw, discount);
    
                    const url = new URL(BUDGET_URL);
                    if (weight) url.searchParams.set('wb_weight', weight);
                    if (volume) url.searchParams.set('wb_volume', volume);
                    if (price)  url.searchParams.set('wb_price', price);
                    if (subjRootName) url.searchParams.set('wb_subj_root_name', String(subjRootName));
                    if (subjName)     url.searchParams.set('wb_subj_name', String(subjName));
    
                    console.log('[WB预算] productRaw:', productRaw,
                                ' discount:', discount + '%',
                                ' price:', price,
                                ' root:', subjRootName, ' subj:', subjName,
                                ' URL:', url.toString());
                    window.open(url.toString(), '_blank');
                };
                actionGroup.appendChild(budgetBtn);
    
                const copyAllBtn = document.createElement('button');
                copyAllBtn.type = 'button';
                copyAllBtn.textContent = '复制全部';
                copyAllBtn.style.cssText = actionButtonStyle;
                copyAllBtn.onclick = e => {
                    e.stopPropagation();
    
                    const subjName = getByPath(product, '__card__.subj_name');
                    const subjRootId = getByPath(product, '__card__.subject_root_id');
                    const subjectId = getByPath(product, '__card__.subject_id');
                    const commission = findProductCommission(subjRootId, subjectId);
                    const fboCommission = (commission && commission[0] != null) ? commission[0] : '';
    
                    const weightRaw = getByPath(product, 'weight');
                    const volumeRaw = getByPath(product, 'volume');
                    const priceRaw = pickProductPrice(product);
                    const priceStr = priceRaw == null ? '' : String(priceRaw / 100);
                    const weight = (weightRaw == null || weightRaw === '') ? '' : Number(weightRaw);
                    const volume = (volumeRaw == null || volumeRaw === '') ? null : (Number(volumeRaw) / 10);
                    const dims = volume != null ? LWH_RULE(volume) : { length: '', width: '', height: '' };
                    const wbId = product?.id ?? product?.nmId ?? product?.nm_id ?? getCurrentNmId() ?? '';
                    const productUrl = wbId
                        ? `https://www.wildberries.ru/catalog/${wbId}/detail.aspx?targetUrl=MI`
                        : '';
    
                    const cells = [
                        fboCommission,
                        '按重量',
                        weight,
                        dims.length,
                        dims.width,
                        dims.height,
                        '',
                        '',
                        productUrl,
                        '',
                        '',
                        '',
                        '',
                        priceStr,
                    ];
                    const line = cells.map(value => value == null ? '' : String(value)).join('\t');
    
                    copyText(line).then(() => {
                        copyAllBtn.textContent = '已复制';
                        setTimeout(() => { copyAllBtn.textContent = '复制全部'; }, 1200);
                    }).catch(() => alert('复制失败，请手动复制：\n' + line));
                };
                actionGroup.appendChild(copyAllBtn);
    
                const supplierId = getSupplierId(product);
                const sellerHomeBtn = document.createElement('button');
                sellerHomeBtn.type = 'button';
                sellerHomeBtn.textContent = '店铺首页';
                sellerHomeBtn.title = supplierId
                    ? `打开店铺首页（${supplierId}）`
                    : '商品详情接口未返回有效 supplierId';
                sellerHomeBtn.style.cssText = actionButtonStyle;
                sellerHomeBtn.disabled = !supplierId;
                if (!supplierId) sellerHomeBtn.style.cssText += 'opacity:.55;cursor:not-allowed;';
                sellerHomeBtn.onclick = e => {
                    e.stopPropagation();
                    if (!supplierId) return;
                    window.open(
                        `https://www.wildberries.ru/seller/${supplierId}`,
                        '_blank',
                        'noopener,noreferrer'
                    );
                };
                actionGroup.appendChild(sellerHomeBtn);
                coefRow.appendChild(actionGroup);
                bodyEl.appendChild(coefRow);
            }
            insertIntoPage();
        }
    
        function findDetailAside() {
            const containers = Array.from(document.querySelectorAll(
                '[class^="productPageAsideSticky"], .product-page__aside-sticky'
            ));
            return containers.find(el => el.getClientRects().length > 0) || containers[0] || null;
        }
    
        function findBuyBlock() {
            const target = Array.from(document.querySelectorAll('button')).find(button => {
                const text = (button.textContent || '').trim();
                return text === 'Добавить в корзину' || text === 'Купить сейчас';
            });
            if (!target) return null;
    
            let el = target;
            for (let i = 0; i < 15 && el && el !== document.body; i++) {
                const parent = el.parentElement;
                if (!parent) break;
                const text = parent.textContent || '';
                if (text.includes('₽') || text.includes('Добавить в корзину') || text.includes('Купить сейчас')) {
                    const up = parent.parentElement;
                    if (up && up !== document.body) {
                        const rect = up.getBoundingClientRect();
                        if (rect.width >= 200 && rect.width <= window.innerWidth * 0.8) return up;
                    }
                    return parent;
                }
                el = parent;
            }
            return null;
        }
    
        function findInsertionPoint() {
            const aside = findDetailAside();
            if (aside) {
                return { parent: aside, before: aside.firstChild === panelEl ? panelEl.nextSibling : aside.firstChild };
            }
    
            const sellerInfo = document.querySelector('section[aria-label="Информация о продавце"]');
            const sellerWrap = sellerInfo && sellerInfo.parentElement;
            if (sellerWrap && sellerWrap.parentElement) {
                return { parent: sellerWrap.parentElement, before: sellerWrap };
            }
    
            const buyBlock = findBuyBlock();
            if (buyBlock && buyBlock.parentElement) {
                return { parent: buyBlock.parentElement, before: buyBlock };
            }
    
            const favoriteButton = document.querySelector('button[aria-label="Добавить в избранное"]');
            if (favoriteButton && favoriteButton.parentElement) {
                return { parent: favoriteButton.parentElement, before: favoriteButton };
            }
            return null;
        }
    
        function insertIntoPage() {
            if (!panelEl || pageMode !== 'detail' || panelClosed) return;
            const point = findInsertionPoint();
            if (!point) return;
    
            const nmId = getCurrentNmId();
            if (panelEl.parentElement === point.parent && panelEl.nextSibling === point.before &&
                panelEl.style.display === 'block' && panelPlacementNm === nmId) return;
    
            panelPlacementNm = nmId;
            panelEl.style.position = '';
            panelEl.style.right = '';
            panelEl.style.bottom = '';
            panelEl.style.top = '';
            panelEl.style.left = '';
            panelEl.style.zIndex = '';
            panelEl.style.width = '100%';
            panelEl.style.maxWidth = '100%';
            panelEl.style.minWidth = '0';
            panelEl.style.maxHeight = 'none';
            panelEl.style.margin = '0 0 10px';
            panelEl.style.overflowY = 'visible';
            panelEl.style.display = 'block';
    
            point.parent.insertBefore(panelEl, point.before);
        }
    
        let lastRenderedNm = null;
        function tryRender() {
            if (pageMode !== 'detail') return;
            const nmId = getCurrentNmId();
            if (!nmId) {
                clearProductLoadTimeout();
                renderFields(null, false);
                return;
            }
            if (nmId !== lastRenderedNm) {
                lastRenderedNm = nmId;
                scheduleProductLoadTimeout(nmId);
                renderFields(null, true);
            }
            const rec = window.__WB_CAPTURED__?.[nmId];
            const card = window.__WB_CARD__?.[nmId];
            if (!rec && !card) {
                scheduleProductLoadTimeout(nmId);
                renderFields(null, true);
                return;
            }
            if (rec) clearProductLoadTimeout();
            else scheduleProductLoadTimeout(nmId);
            const product = mergeCategory(rec ? rec.data : {}, nmId);
            renderFields(product, false, '', !rec);
        }
        function onDataArrived() { tryRender(); }
    
        const recoveredDetailUrls = new Set();
        const recoveredCardUrls = new Set();
        let networkHooksInstalled = false;
        let origFetch = null;
        let origOpen = null;
        let origSend = null;
        let wrappedFetch = null;
        let wrappedOpen = null;
        let wrappedSend = null;
        function getDetailRequestUrls(nmId) {
            const urls = new Set();
            const knownUrl = window.__WB_DETAIL_URLS__?.[nmId];
            if (knownUrl) urls.add(String(knownUrl));
    
            const entries = window.performance?.getEntriesByType
                ? performance.getEntriesByType('resource').map(entry => String(entry?.name || ''))
                    .filter(url => url.includes(TARGET_DETAIL))
                : [];
            const matching = entries.filter(url => getNmFromCardUrl(url) === nmId);
            for (const url of matching.slice(-3)) urls.add(url);
    
            if (!urls.size) {
                for (const url of entries.slice(-3)) urls.add(url);
            }
            return urls;
        }
    
        function getCardRequestUrls(nmId) {
            const urls = new Set();
            const knownUrl = window.__WB_CARD_URLS__?.[nmId];
            if (knownUrl) urls.add(String(knownUrl));
            if (window.performance?.getEntriesByType) {
                for (const entry of performance.getEntriesByType('resource')) {
                    const url = String(entry?.name || '');
                    if (!url) continue;
                    if (url.includes(TARGET_CARD) && getNmFromCardUrl(url) === nmId) {
                        urls.add(url);
                        continue;
                    }
                    const imageMarker = `/${nmId}/images/`;
                    const imageIndex = url.indexOf(imageMarker);
                    if (imageIndex >= 0) {
                        urls.add(url.slice(0, imageIndex) + `/${nmId}/info/ru/card.json`);
                    }
                }
            }
            urls.add(`${location.origin}/catalog/${nmId}/info/ru/card.json`);
            return urls;
        }
    
        function loadExistingDetailData(targetNmId = getCurrentNmId()) {
            if (pageMode !== 'detail' || !targetNmId || !origFetch || window.__WB_CAPTURED__?.[targetNmId]) return;
            for (const url of getDetailRequestUrls(targetNmId)) {
                if (recoveredDetailUrls.has(url)) continue;
                recoveredDetailUrls.add(url);
                origFetch.call(PAGE_WINDOW, url, { credentials: 'include', cache: 'no-store' })
                    .then(resp => resp.ok ? resp.json() : null)
                    .then(data => {
                        if (data) {
                            indexProducts(data, url, targetNmId);
                            onDataArrived();
                        }
                    })
                    .catch(error => console.debug('[WB补抓] detail 请求失败', error))
                    .finally(() => recoveredDetailUrls.delete(url));
            }
        }
    
        function loadExistingCardData(targetNmId = getCurrentNmId()) {
            if (pageMode !== 'detail' || !targetNmId || !origFetch || window.__WB_CARD__?.[targetNmId]) return;
            for (const url of getCardRequestUrls(targetNmId)) {
                if (recoveredCardUrls.has(url)) continue;
                recoveredCardUrls.add(url);
                origFetch.call(PAGE_WINDOW, url, { credentials: 'include', cache: 'no-store' })
                    .then(resp => resp.ok ? resp.json() : null)
                    .then(data => {
                        if (data) {
                            storeCardData(url, data, targetNmId);
                            onDataArrived();
                        }
                    })
                    .catch(error => console.debug('[WB补抓] card.json 请求失败', error))
                    .finally(() => recoveredCardUrls.delete(url));
            }
        }
    
        function scheduleProductDataRecovery(nmId) {
            if (!nmId) return;
            for (const delay of [100, 700, 1800]) {
                window.setTimeout(() => {
                    if (pageMode !== 'detail' || getCurrentNmId() !== nmId) return;
                    if (!window.__WB_CAPTURED__?.[nmId]) loadExistingDetailData(nmId);
                    if (!window.__WB_CARD__?.[nmId]) loadExistingCardData(nmId);
                }, delay);
            }
        }
    
        function refreshProductData(nmId) {
            if (!nmId || pageMode !== 'detail' || getCurrentNmId() !== nmId) return false;
    
            ensureDetailState();
            const hasDetail = Boolean(window.__WB_CAPTURED__?.[nmId]);
            const hasCard = Boolean(window.__WB_CARD__?.[nmId]);
            if (!hasDetail && !hasCard) return false;
    
            onDataArrived();
            return true;
        }
    
        function installNetworkHooks() {
            if (networkHooksInstalled) return;
            networkHooksInstalled = true;
            origFetch = PAGE_WINDOW.fetch;
            origOpen = PAGE_WINDOW.XMLHttpRequest.prototype.open;
            origSend = PAGE_WINDOW.XMLHttpRequest.prototype.send;
    
            if (typeof origFetch === 'function') {
                wrappedFetch = async function (...args) {
                    const input = args[0];
                    const url = (input && input.url) || String(input || '');
                    const requestNmId = getNmFromCardUrl(url) || getCurrentNmId() || '';
                    if (url.includes(TARGET_DETAIL) && requestNmId) {
                        ensureDetailState();
                        window.__WB_DETAIL_URLS__[requestNmId] = url;
                    }
                    const resp = await origFetch.apply(this, args);
                    if (!resp.ok) return resp;
                    try {
                        if (url.includes(TARGET_DETAIL)) {
                            const clone = resp.clone();
                            clone.json().then(data => {
                                indexProducts(data, url, requestNmId);
                                onDataArrived();
                            }).catch(e => console.warn('[WB抓取] detail 解析失败', e));
                        }
                        if (url.includes(TARGET_CARD)) {
                            const clone = resp.clone();
                            clone.json().then(data => {
                                storeCardData(url, data, requestNmId);
                                onDataArrived();
                            }).catch(e => console.warn('[WB抓取] card.json 解析失败', e));
                        }
                        if (isListProductsUrl(url)) {
                            const clone = resp.clone();
                            clone.json().then(data => indexListProducts(data, url))
                                .catch(e => console.warn('[WB列表] 列表响应解析失败', e));
                        }
                    } catch (e) {}
                    return resp;
                };
                PAGE_WINDOW.fetch = wrappedFetch;
            }
    
            wrappedOpen = function (method, url, ...rest) {
                this.__wb_url = String(url || '');
                this.__wb_nm = getNmFromCardUrl(this.__wb_url) || getCurrentNmId() || '';
                if (this.__wb_url.includes(TARGET_DETAIL) && this.__wb_nm) {
                    ensureDetailState();
                    window.__WB_DETAIL_URLS__[this.__wb_nm] = this.__wb_url;
                }
                return origOpen.call(this, method, url, ...rest);
            };
            wrappedSend = function (...args) {
                this.addEventListener('load', function () {
                    try {
                        if (this.status < 200 || this.status >= 300) return;
                        const url = String(this.__wb_url || '');
                        const requestNmId = String(this.__wb_nm || '');
                        let data = null;
                        if (url.includes(TARGET_DETAIL) || url.includes(TARGET_CARD) || isListProductsUrl(url)) {
                            if (this.responseType === '' || this.responseType === 'text') data = JSON.parse(this.responseText);
                            else if (this.responseType === 'json') data = this.response;
                            else return;
                        }
                        if (url.includes(TARGET_DETAIL) && data) {
                            indexProducts(data, url, requestNmId);
                            onDataArrived();
                        }
                        if (url.includes(TARGET_CARD) && data) {
                            storeCardData(url, data, requestNmId);
                            onDataArrived();
                        }
                        if (isListProductsUrl(url) && data) indexListProducts(data, url);
                    } catch (e) {
                        console.warn('[WB抓取] XHR 解析失败', e);
                    }
                });
                return origSend.apply(this, args);
            };
            PAGE_WINDOW.XMLHttpRequest.prototype.open = wrappedOpen;
            PAGE_WINDOW.XMLHttpRequest.prototype.send = wrappedSend;
        }
    
        installNetworkHooks();
        try {
            installRouteHooks();
        } catch (error) {
            console.warn('[WB路由] 路由监听初始化失败，将继续执行首次加载', error);
        }
        let bootstrapped = false;
        function bootstrap() {
            if (bootstrapped) return;
            if (!document.body) {
                setTimeout(bootstrap, 50);
                return;
            }
            bootstrapped = true;
            // 暂时关闭右下角「面板」设置按钮，保留页面类型逻辑供后续恢复。
            // try { ensureKindToggle(); } catch (error) { console.warn('[WB设置] 面板开关初始化失败', error); }
            switchPageMode();
        }
        window.addEventListener('DOMContentLoaded', bootstrap, { once: true });
        if (document.readyState !== 'loading') bootstrap();
    }
    
    // ============================================================
    // 预算计算器端
    // ============================================================
    function initBudgetCalculator() {
    
        async function fillWeight(weight) {
            if (!weight) return;
            const el = await waitFor('input[name="weight"]');
            setInputValue(el, weight);
            console.log('[预算填充] 重量已填:', weight);
        }
    
        async function fillVolume(volume) {
            if (!volume) return;
            const dims = LWH_RULE(volume);
            if (!dims) return;
            const lenEl = await waitFor('input[name="length"]');
            const widEl = await waitFor('input[name="width"]');
            const heiEl = await waitFor('input[name="height"]');
            setInputValue(lenEl, dims.length);
            setInputValue(widEl, dims.width);
            setInputValue(heiEl, dims.height);
            console.log('[预算填充] 尺寸已填:', dims);
        }
    
        async function fillPrice(price) {
            if (!price) { console.warn('[预算填充] wb_price 为空，跳过'); return; }
            const el = await waitFor('input[name="price"]');
            await new Promise(r => setTimeout(r, 300));
            setInputValue(el, price);
            try { if (window.layui && window.layui.form) window.layui.form.render(); } catch (e) {}
            console.log('[预算填充] 售价已填:', price);
        }
    
        async function fillWbCategory(rootName, subjName) {
            if (!subjName) return;
    
            const pageWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow)
                ? unsafeWindow
                : window;
            let tree = null;
            for (let i = 0; i < 100; i++) {
                tree = pageWindow.wb_category_tree || window.wb_category_tree;
                if (tree && tree.length) break;
                await new Promise(r => setTimeout(r, 200));
            }
            if (!tree || !tree.length) {
                console.warn('[预算填充] 页面类目树未就绪，等待 20 秒仍未找到 wb_category_tree');
                return;
            }
    
            const norm = s => String(s || '')
                .replace(/[（(].*?[)）]/g, '')
                .replace(/\s+/g, '')
                .toLowerCase();
            const key = norm(subjName);
            const rootKey = norm(rootName);
            if (!key) {
                console.warn('[预算填充] 二级类目名称为空，无法匹配');
                return;
            }
    
            const pickLabel = n => n.label ?? n.name ?? n.title ?? n.text ?? '';
            const pickValue = n => n.value ?? n.id ?? n.category_id ?? n.categoryId
                ?? n.subject_id ?? n.subjectId ?? n.subj_id ?? n.key ?? n.code ?? '';
            const pickKids  = n => n.children ?? n.child ?? n.nodes ?? n.list ?? [];
    
            const exactRoots = rootKey
                ? tree.filter(node => norm(pickLabel(node)) === rootKey)
                : [];
            const partialRoots = rootKey && !exactRoots.length
                ? tree.filter(node => {
                    const labelKey = norm(pickLabel(node));
                    return labelKey && labelKey.includes(rootKey);
                })
                : [];
            let scopedRoots = exactRoots.length ? exactRoots : partialRoots;
            if (!scopedRoots.length) scopedRoots = tree;
    
            function findMatches(roots, allowPartial) {
                const matches = [];
                function walk(nodes, path) {
                    if (!Array.isArray(nodes)) return;
                    for (const node of nodes) {
                        const label = String(pickLabel(node) || '').trim();
                        const currentPath = label ? path.concat(label) : path;
                        const labelKey = norm(label);
                        const matchesName = allowPartial
                            ? labelKey && labelKey.includes(key)
                            : labelKey === key;
                        const id = pickValue(node);
                        if (path.length > 0 && matchesName && id !== '' && id != null) {
                            matches.push({ id, labels: currentPath });
                        }
                        walk(pickKids(node), currentPath);
                    }
                }
                walk(roots, []);
    
                const unique = new Map();
                for (const match of matches) unique.set(String(match.id), match);
                return Array.from(unique.values());
            }
    
            let matches = findMatches(scopedRoots, false);
            if (!matches.length && scopedRoots !== tree) matches = findMatches(tree, false);
            if (!matches.length) matches = findMatches(scopedRoots, true);
            if (!matches.length && scopedRoots !== tree) matches = findMatches(tree, true);
            if (matches.length !== 1) {
                console.warn('[预算填充] 类目未能唯一匹配:', {
                    root: rootName,
                    subject: subjName,
                    matches: matches.map(match => ({ id: match.id, path: match.labels })),
                });
                return;
            }
    
            const { id: foundId, labels: foundLabels } = matches[0];
    
            console.log('[预算填充] 匹配到 id:', foundId, ' 路径:', foundLabels);
    
            let hidden;
            try { hidden = await waitFor('#wb_category_id', 10000); }
            catch (e) { console.warn('[预算填充] 未找到 #wb_category_id'); return; }
    
            setInputValue(hidden, String(foundId));
            console.log('[预算填充] 已写 #wb_category_id =', hidden.value);
    
            const wrap = hidden.closest('.layui-input-block') || hidden.parentElement;
            const visibleInput = wrap && wrap.querySelector('input.el-input__inner');
            if (visibleInput) {
                const fullText = foundLabels.join(' / ');
                setInputValue(visibleInput, fullText);
                console.log('[预算填充] 已写可视 input =', visibleInput.value);
            }
    
            try {
                if (pageWindow.layui && pageWindow.layui.form) pageWindow.layui.form.render();
            } catch (e) {}
        }
    
        function readBudgetParams() {
            return {
                wb_weight: getParam('wb_weight'),
                wb_volume: getParam('wb_volume'),
                wb_price: getParam('wb_price'),
                wb_subj_root_name: getParam('wb_subj_root_name'),
                wb_subj_name: getParam('wb_subj_name'),
            };
        }
    
        function hasBudgetParams(params) {
            return Object.values(params).some(Boolean);
        }
    
        async function main() {
            const params = readBudgetParams();
            if (!hasBudgetParams(params)) return;
    
            console.log('[预算填充] URL 参数:', params);
            try {
                await fillWeight(params.wb_weight);
                await fillVolume(params.wb_volume);
                await fillPrice(params.wb_price);
                await fillWbCategory(params.wb_subj_root_name, params.wb_subj_name);
            } catch (error) {
                console.warn('[预算填充] 出错:', error);
            }
        }
    
        if (document.readyState === 'complete') setTimeout(main, 800);
        else window.addEventListener('load', () => setTimeout(main, 800));
    }

})();
