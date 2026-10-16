// ==UserScript==
// @name         WB 商品数据窗口
// @namespace    http://tampermonkey.net/
// @version      14.0
// @updateURL    https://raw.githubusercontent.com/Kansasi-0749/commission-data/main/wb-product-panel.user.js
// @downloadURL  https://raw.githubusercontent.com/Kansasi-0749/commission-data/main/wb-product-panel.user.js
// @description  拦截 Wildberries 商品接口，显示商品数据；一键跳转预算计算器并自动填充重量/尺寸/售价/类目
// @match        https://www.wildberries.ru/*
// @match        https://yadmin.sanlindou.com/goods-shop/budget-calculator*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function () {
    'use strict';

    const BUDGET_URL = 'https://yadmin.sanlindou.com/goods-shop/budget-calculator';
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
    else if (location.hostname === 'yadmin.sanlindou.com') initBudgetCalculator();

    // ============================================================
    // WB 端
    // ============================================================
    function initWildberries() {

        const TARGET_DETAIL = '/__internal/u-card/cards/v4/detail';
        const TARGET_CARD   = '/info/ru/card.json';
        const PAGE_WINDOW = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
        function isDetailRoute() {
            return /^\/catalog\/\d+\/detail(?:\.aspx)?\/?$/i.test(location.pathname);
        }

        // 佣金表只从 GitHub 远程数据或油猴缓存加载。
        let COMMISSION_MAP = {};
        const __COMMISSION_NORM_CACHE = new Map();
        function normCategoryKey(s) {
            const raw = String(s || '');
            if (__COMMISSION_NORM_CACHE.has(raw)) return __COMMISSION_NORM_CACHE.get(raw);
            const key = raw
                .replace(/[（(].*?[)）]/g, '')
                .replace(/\s+/g, '')
                .toLowerCase();
            __COMMISSION_NORM_CACHE.set(raw, key);
            return key;
        }
        function findCommission(subjName) {
            const key = normCategoryKey(subjName);
            if (!key) return null;

            for (const [k, v] of Object.entries(COMMISSION_MAP)) {
                if (normCategoryKey(k) === key) return v;
            }
            for (const [k, v] of Object.entries(COMMISSION_MAP)) {
                if (normCategoryKey(k).includes(key)) return v;
            }
            return null;
        }

        // 佣金表只从 GitHub 远程文件或油猴缓存读取。
        const REMOTE_COMMISSION_URL = 'https://raw.githubusercontent.com/Kansasi-0749/commission-data/main/%E6%9C%AC%E5%9C%9FWB_%E7%B1%BB%E7%9B%AE%E4%BD%A3%E9%87%91.json';
        const REMOTE_COMMISSION_API_URL = 'https://api.github.com/repos/Kansasi-0749/commission-data/contents/%E6%9C%AC%E5%9C%9FWB_%E7%B1%BB%E7%9B%AE%E4%BD%A3%E9%87%91.json?ref=main';
        const REMOTE_COMMISSION_CACHE_KEY = 'wb_commission_github_v1';
        const REMOTE_COMMISSION_CACHE_TTL = 6 * 60 * 60 * 1000;
        let remoteCommissionLoadStarted = false;
        let remoteCommissionStatus = { kind: 'loading', message: '正在连接 GitHub 佣金表…' };
        let REMOTE_CATEGORY_MAP = {};
        let REMOTE_SECOND_CATEGORY_MAP = {};

        function normalizeCommissionMap(map) {
            const normalized = {};
            for (const [name, value] of Object.entries(map || {})) {
                const values = Array.isArray(value) ? value.map(Number) : [];
                if (name && values.length >= 3 && values.slice(0, 3).every(Number.isFinite)) {
                    normalized[name] = values.slice(0, 3);
                }
            }
            if (!Object.keys(normalized).length) throw new Error('佣金表没有有效记录');
            return normalized;
        }

        function makeRemoteCategoryKey(rootName, secondName) {
            const rootKey = normCategoryKey(rootName);
            const secondKey = normCategoryKey(secondName);
            return rootKey && secondKey ? rootKey + '\u0000' + secondKey : '';
        }

        function normalizeCategoryRecordMap(map) {
            const normalized = {};
            for (const [key, record] of Object.entries(map || {})) {
                if (!key || !record || typeof record !== 'object') continue;
                const commission = Array.isArray(record.commission)
                    ? record.commission.map(Number)
                    : [];
                const secondRussian = String(record.secondRussian || '').trim();
                if (!secondRussian || commission.length < 3 || !commission.slice(0, 3).every(Number.isFinite)) continue;
                normalized[key] = {
                    rootRussian: String(record.rootRussian || '').trim(),
                    rootChinese: String(record.rootChinese || '').trim(),
                    secondRussian,
                    secondChinese: String(record.secondChinese || '').trim(),
                    commission: commission.slice(0, 3),
                };
            }
            if (!Object.keys(normalized).length) throw new Error('类目表没有有效记录');
            return normalized;
        }

        function extractRemoteCommissionData(payload) {
            const categories = payload && payload.categories;
            if (!categories || typeof categories !== 'object') {
                throw new Error('佣金 JSON 缺少 categories');
            }

            const commissionMap = {};
            const categoryMap = {};
            const secondCandidates = {};
            for (const [rootRussian, firstCategory] of Object.entries(categories)) {
                const secondCategories = firstCategory && firstCategory['二级类目'];
                if (!secondCategories || typeof secondCategories !== 'object') continue;
                const rootChinese = firstCategory && firstCategory['中文'];
                for (const [secondRussian, record] of Object.entries(secondCategories)) {
                    const commission = record && record['佣金'];
                    if (!commission) continue;
                    const values = [
                        commission['本FBO'],
                        commission['本FBS'],
                        commission['跨FBS'],
                    ];
                    if (!values.every(value => Number.isFinite(Number(value)))) continue;

                    const categoryRecord = {
                        rootRussian,
                        rootChinese,
                        secondRussian,
                        secondChinese: record && record['中文'],
                        commission: values,
                    };
                    const categoryKey = makeRemoteCategoryKey(rootRussian, secondRussian);
                    if (categoryKey) categoryMap[categoryKey] = categoryRecord;

                    const secondKey = normCategoryKey(secondRussian);
                    if (secondKey) {
                        if (!Object.prototype.hasOwnProperty.call(secondCandidates, secondKey)) {
                            secondCandidates[secondKey] = categoryRecord;
                        } else if (secondCandidates[secondKey] !== null) {
                            const previous = secondCandidates[secondKey];
                            if (makeRemoteCategoryKey(previous.rootRussian, previous.secondRussian) !== categoryKey) {
                                secondCandidates[secondKey] = null;
                            }
                        }
                    }
                    commissionMap[secondRussian] = values;
                }
            }

            const uniqueSecondMap = {};
            for (const [key, record] of Object.entries(secondCandidates)) {
                if (record) uniqueSecondMap[key] = record;
            }

            return {
                commissionMap: normalizeCommissionMap(commissionMap),
                categoryMap: normalizeCategoryRecordMap(categoryMap),
                secondMap: normalizeCategoryRecordMap(uniqueSecondMap),
            };
        }

        function normalizeRemoteCommissionData(data) {
            if (!data || typeof data !== 'object') throw new Error('远程佣金数据为空');
            return {
                commissionMap: normalizeCommissionMap(data.commissionMap),
                categoryMap: normalizeCategoryRecordMap(data.categoryMap),
                secondMap: normalizeCategoryRecordMap(data.secondMap),
            };
        }

        function findRemoteCategoryData(rootName, secondName) {
            const exactKey = makeRemoteCategoryKey(rootName, secondName);
            if (exactKey && REMOTE_CATEGORY_MAP[exactKey]) return REMOTE_CATEGORY_MAP[exactKey];
            const secondKey = normCategoryKey(secondName);
            return secondKey ? (REMOTE_SECOND_CATEGORY_MAP[secondKey] || null) : null;
        }

        function requestRemoteCommission() {
            return new Promise((resolve, reject) => {
                if (typeof GM_xmlhttpRequest !== 'function') {
                    reject(new Error('GM_xmlhttpRequest 不可用'));
                    return;
                }
                const endpoints = [REMOTE_COMMISSION_URL, REMOTE_COMMISSION_API_URL];
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
                    if (!payload || !payload.categories) throw new Error('响应中没有 categories');
                    return payload;
                }

                function tryNextEndpoint() {
                    if (endpointIndex >= endpoints.length) {
                        reject(new Error(failures.join('；')));
                        return;
                    }

                    const url = endpoints[endpointIndex++];
                    const isApi = url === REMOTE_COMMISSION_API_URL;
                    try {
                        GM_xmlhttpRequest({
                            method: 'GET',
                            url,
                            headers: { Accept: 'application/json' },
                            timeout: 15000,
                            onload: response => {
                                if (response.status < 200 || response.status >= 300) {
                                    failures.push(`${isApi ? 'GitHub API' : 'GitHub Raw'} HTTP ${response.status}`);
                                    tryNextEndpoint();
                                    return;
                                }
                                try {
                                    resolve(parsePayload(response.responseText));
                                } catch (error) {
                                    failures.push(`${isApi ? 'GitHub API' : 'GitHub Raw'}: ${error.message}`);
                                    tryNextEndpoint();
                                }
                            },
                            onerror: () => {
                                failures.push(`${isApi ? 'GitHub API' : 'GitHub Raw'} 网络连接失败`);
                                tryNextEndpoint();
                            },
                            ontimeout: () => {
                                failures.push(`${isApi ? 'GitHub API' : 'GitHub Raw'} 请求超时`);
                                tryNextEndpoint();
                            },
                            onabort: () => {
                                failures.push(`${isApi ? 'GitHub API' : 'GitHub Raw'} 请求被取消`);
                                tryNextEndpoint();
                            },
                        });
                    } catch (error) {
                        failures.push(`${isApi ? 'GitHub API' : 'GitHub Raw'}: ${error.message}`);
                        tryNextEndpoint();
                    }
                }

                tryNextEndpoint();
            });
        }

        function applyRemoteCommissionData(data, source) {
            const normalized = normalizeRemoteCommissionData(data);
            COMMISSION_MAP = normalized.commissionMap;
            REMOTE_CATEGORY_MAP = normalized.categoryMap;
            REMOTE_SECOND_CATEGORY_MAP = normalized.secondMap;
            __COMMISSION_NORM_CACHE.clear();
            remoteCommissionStatus = { kind: 'loaded', message: '' };
            console.info('[WB佣金] 已加载', source, Object.keys(REMOTE_CATEGORY_MAP).length, '条');
            if (typeof tryRender === 'function') tryRender();
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
                .then(payload => {
                    const data = extractRemoteCommissionData(payload);
                    applyRemoteCommissionData(data, 'GitHub');
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
                    const hasCachedData = Object.keys(COMMISSION_MAP).length > 0;
                    remoteCommissionStatus = hasCachedData
                        ? { kind: 'warning', message: '远程更新失败，当前使用已缓存数据' }
                        : { kind: 'error', message: 'GitHub 连接失败：中文类目和佣金表未加载' };
                    console.error('[WB佣金] 远程表加载失败', error);
                    if (typeof tryRender === 'function') tryRender();
                });
        }

        const FIELDS = [
            { label: '体积', path: 'volume', transform: v => (Number(v) / 10).toFixed(1) + ' 升', compact: true },
            { label: '尺寸体积', path: '__card__.package_volume', compact: true },
            { label: '重量', path: 'weight', transform: v => Number(v).toFixed(1) + ' kg', compact: true },
            { label: '库存', path: 'totalQuantity', compact: true },
            { label: '上架时间', path: '__card__.create_date',
              transform: v => {
                  const d = new Date(v);
                  if (isNaN(d)) return String(v);
                  const p = n => String(n).padStart(2, '0');
                  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
              } },
        ];

        function getCurrentNmId() {
            const m = location.pathname.match(/\/catalog\/(\d+)\/detail/);
            return m ? m[1] : null;
        }
        function getSupplierId(product) {
            const raw = getByPath(product, 'supplierId');
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
            if (!card) return product;
            return { ...product, __card__: {
                subj_root_name: getCardField(card, ['subj_root_name', 'subjRootName', 'subject_root_name', 'subjectRootName']),
                subj_name: getCardField(card, ['subj_name', 'subjName', 'subject_name', 'subjectName']),
                create_date: getCardField(card, ['create_date', 'createDate', 'created_at', 'createdAt']),
                package_volume: getPackageVolume(card),
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

        function leaveDetailMode() {
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
                detailObserver = new MutationObserver(queueInsert);
                detailObserver.observe(document.documentElement, {
                    childList: true,
                    subtree: true,
                });
            }
            lastRenderedNm = null;
            tryRender();
            loadRemoteCommissionData();
            scheduleProductDataRecovery(getCurrentNmId());
        }

        function switchPageMode() {
            const nextMode = isDetailRoute() ? 'detail' : null;
            if (nextMode === pageMode) {
                if (nextMode === 'detail') {
                    lastRenderedNm = null;
                    tryRender();
                    queueInsert();
                    scheduleProductDataRecovery(getCurrentNmId());
                }
                return;
            }
            if (pageMode === 'detail') leaveDetailMode();
            pageMode = nextMode;
            if (pageMode === 'detail') enterDetailMode();
        }

        function handleRouteChange() {
            const href = location.href;
            if (href === lastRouteHref) return;
            lastRouteHref = href;
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
                const categoryData = findRemoteCategoryData(subjRootName, subjName);
                const measureGrid = document.createElement('div');
                measureGrid.style.cssText = `
                    display:grid; grid-template-columns:repeat(2,minmax(0,1fr));
                    gap:4px; align-items:stretch;
                `;
                bodyEl.appendChild(measureGrid);

                const appendFieldRow = (label, value, compact = false, trailing = null) => {
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
                            grid-column:1; color:#777; white-space:nowrap;
                            font-size:11px; line-height:1.2;
                        `;
                        row.appendChild(labelEl);
                    }
                    const valEl = document.createElement('span');
                    valEl.textContent = val;
                    valEl.style.cssText = `
                        grid-column:2; min-width:0; font-weight:600;
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

                const makeCardCopyButtons = () => {
                    const group = document.createElement('div');
                    group.style.cssText = `display:flex; align-items:center; gap:4px;`;
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
                        ? makeCardCopyButtons()
                        : null;
                    appendFieldRow(f.label, formatValue(f, raw), f.compact === true, cardCopyButtons);
                }

                // ===== 佣金行 =====
                const comm = (categoryData && categoryData.commission)
                    || (subjName ? findCommission(subjName) : null);

                const commRow = document.createElement('div');
                commRow.style.cssText = `
                    margin-top:4px; display:flex; align-items:center; gap:6px;
                    min-width:0; padding:4px 0; border-bottom:1px solid #eee;
                `;
                const commLabel = document.createElement('div');
                commLabel.textContent = '佣金';
                commLabel.style.cssText = `color:#666; font-size:11px; white-space:nowrap;`;

                const commValueRow = document.createElement('div');
                commValueRow.style.cssText = `display:flex; min-width:0; gap:3px; align-items:center; flex-wrap:wrap;`;

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
                    nf.textContent = subjName ? `未匹配到：${subjName}` : '（无二级类目）';
                    nf.style.cssText = `color:#999; font-size:12px;`;
                    commValueRow.appendChild(nf);
                }

                commRow.appendChild(commLabel);
                commRow.appendChild(commValueRow);
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
                    const commission = (categoryData && categoryData.commission)
                        || (subjName ? findCommission(subjName) : null);
                    const fboCommission = (commission && commission[0] != null) ? commission[0] : '';

                    const weightRaw = getByPath(product, 'weight');
                    const volumeRaw = getByPath(product, 'volume');
                    const priceRaw = pickProductPrice(product);
                    const priceStr = priceRaw == null ? '' : String(priceRaw / 100);
                    const weight = (weightRaw == null || weightRaw === '') ? '' : Number(weightRaw);
                    const volume = (volumeRaw == null || volumeRaw === '') ? null : (Number(volumeRaw) / 10);
                    const dims = volume != null ? LWH_RULE(volume) : { length: '', width: '', height: '' };

                    const cells = [
                        fboCommission,
                        '按重量',
                        weight,
                        dims.length,
                        dims.width,
                        dims.height,
                        '',
                        '',
                        '',
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
                        if (url.includes(TARGET_DETAIL) || url.includes(TARGET_CARD)) {
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

        async function main() {
            const weight = getParam('wb_weight');
            const volume = getParam('wb_volume');
            const price  = getParam('wb_price');
            const root   = getParam('wb_subj_root_name');
            const subj   = getParam('wb_subj_name');

            console.log('[预算填充] URL 参数:', { weight, volume, price, root, subj });
            if (!weight && !volume && !price && !subj) return;

            try {
                await fillWeight(weight);
                await fillVolume(volume);
                await fillPrice(price);
                await fillWbCategory(root, subj);
            } catch (e) {
                console.warn('[预算填充] 出错:', e);
            }
        }

        if (document.readyState === 'complete') setTimeout(main, 800);
        else window.addEventListener('load', () => setTimeout(main, 800));
    }

})();
