// ==UserScript==
// @name         WB 商品数据窗口
// @namespace    http://tampermonkey.net/
// @version      13.2
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
            { label: '体积', path: 'volume', transform: v => (Number(v) / 10).toFixed(1) + ' 升' },
            { label: '尺寸体积', path: '__card__.package_volume' },
            { label: '重量', path: 'weight', transform: v => Number(v).toFixed(1) + ' kg' },
            { label: '库存', path: 'totalQuantity' },
            { label: '二级类目', path: '__card__.subj_name' },
            { label: '一级类目', path: '__card__.subj_root_name' },
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
        function indexProducts(data) {
            if (!isDetailRoute()) return 0;
            ensureDetailState();
            const products = data?.products || data?.data?.products || [];
            const time = Date.now();
            for (const p of products) {
                const id = String(p.id ?? p.nmId ?? p.nm_id ?? '');
                if (id) window.__WB_CAPTURED__[id] = { nm: id, time, data: p };
            }
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
        function storeCardData(url, data) {
            if (!data || !isDetailRoute()) return;
            ensureDetailState();
            const nm = getNmFromCardUrl(url) || getCurrentNmId();
            if (nm) window.__WB_CARD__[nm] = data;
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
                renderFields(null, false, '商品数据接口未返回，请刷新或稍后重试。');
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
            uninstallNetworkHooks();
            detailObserver?.disconnect();
            detailObserver = null;
            insertQueued = false;
            clearProductLoadTimeout();
            panelEl?.remove();
            panelEl = null;
            bodyEl = null;
            lastRenderedNm = null;
            panelClosed = false;
            window.__WB_CAPTURED__ = Object.create(null);
            window.__WB_CARD__ = Object.create(null);
            recoveredCardUrls.clear();
        }

        function ensurePanel() {
            if (panelEl) return;
            ensureDetailState();
            panelEl = document.createElement('div');
            panelEl.id = 'wb-data-panel';
            panelEl.style.cssText = `
                margin: 10px 0 0 0;
                width: 100%;
                box-sizing: border-box;
                background: #fff;
                color: #222;
                border-radius: 8px;
                box-shadow: 0 2px 10px rgba(0,0,0,.08);
                font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
                font-size: 12px;
                overflow: hidden;
                display: none;
            `;
            const header = document.createElement('div');
            header.style.cssText = `
                padding: 7px 10px;
                background: #cb11ab;
                color: #fff;
                font-weight: 600;
                font-size: 12px;
                display: flex;
                justify-content: space-between;
                align-items: center;
            `;
            const title = document.createElement('span');
            title.textContent = 'WB 商品数据';
            header.appendChild(title);
            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.setAttribute('aria-label', '关闭商品数据');
            closeBtn.textContent = '✕';
            closeBtn.style.cssText = `border:0; padding:0; background:transparent; color:inherit; cursor:pointer; font-size:12px; opacity:.85;`;
            closeBtn.onclick = () => {
                panelClosed = true;
                panelEl.style.display = 'none';
            };
            header.appendChild(closeBtn);
            bodyEl = document.createElement('div');
            bodyEl.style.cssText = `padding: 8px 10px;`;
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
                detailObserver.observe(document.body, {
                    childList: true,
                    subtree: true,
                });
            }
            lastRenderedNm = null;
            tryRender();
            loadRemoteCommissionData();
        }

        function switchPageMode() {
            const nextMode = isDetailRoute() ? 'detail' : null;
            if (nextMode === pageMode) {
                if (nextMode === 'detail') {
                    lastRenderedNm = null;
                    tryRender();
                    queueInsert();
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

        function renderFields(product, isLoading, message = '') {
            ensurePanel();
            if (!product) {
                bodyEl.innerHTML = isLoading
                    ? `<div style="color:#999">加载中…</div>`
                    : `<div style="color:#999">${message || '等待数据中…'}</div>`;
            } else {
                bodyEl.innerHTML = '';
                const nameEl = document.createElement('div');
                nameEl.textContent = product.name || '—';
                nameEl.style.cssText = `margin-bottom:6px; font-weight:600; color:#333; word-break:break-all; font-size:12px;`;
                bodyEl.appendChild(nameEl);

                const subjName = getByPath(product, '__card__.subj_name');
                const subjRootName = getByPath(product, '__card__.subj_root_name');
                const categoryData = findRemoteCategoryData(subjRootName, subjName);

                const appendFieldRow = (label, value) => {
                    const val = value === undefined || value === null || value === '' ? '—' : String(value);
                    const row = document.createElement('div');
                    row.style.cssText = `
                        display:flex; align-items:center; gap:6px;
                        padding:3px 0; border-bottom:1px dashed #eee;
                    `;
                    const labelEl = document.createElement('span');
                    labelEl.textContent = label;
                    labelEl.style.cssText = `color:#666; white-space:nowrap;`;
                    const valEl = document.createElement('span');
                    valEl.textContent = val;
                    valEl.style.cssText = `
                        font-weight:600; word-break:break-all; text-align:right;
                        flex:1; min-width:0;
                    `;
                    const copyBtn = document.createElement('button');
                    copyBtn.textContent = '复制';
                    copyBtn.style.cssText = `
                        flex-shrink:0; padding:2px 6px; font-size:11px;
                        background:#f3e6f1; color:#cb11ab;
                        border:1px solid #e7c9e3; border-radius:4px; cursor:pointer;
                    `;
                    copyBtn.onclick = (e) => {
                        e.stopPropagation();
                        copyText(val).then(() => {
                            copyBtn.textContent = '已复制';
                            setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
                        }).catch(() => alert('复制失败，请手动复制。'));
                    };
                    row.appendChild(labelEl);
                    row.appendChild(valEl);
                    row.appendChild(copyBtn);
                    bodyEl.appendChild(row);
                };

                for (const f of FIELDS) {
                    const raw = getByPath(product, f.path);
                    appendFieldRow(f.label, formatValue(f, raw));
                    if (f.path === '__card__.subj_name') {
                        appendFieldRow('二级类目（中文）', categoryData && categoryData.secondChinese);
                    } else if (f.path === '__card__.subj_root_name') {
                        appendFieldRow('一级类目（中文）', categoryData && categoryData.rootChinese);
                    }
                }

                // ===== 佣金行 =====
                const comm = (categoryData && categoryData.commission)
                    || (subjName ? findCommission(subjName) : null);

                const commRow = document.createElement('div');
                commRow.style.cssText = `
                    margin-top:6px; display:flex; flex-direction:column; gap:3px;
                    padding:4px 0; border-bottom:1px dashed #eee;
                `;
                const commLabel = document.createElement('div');
                commLabel.textContent = '佣金（按二级类目）';
                commLabel.style.cssText = `color:#666; font-size:11px;`;

                const commValueRow = document.createElement('div');
                commValueRow.style.cssText = `display:flex; gap:6px; align-items:center; flex-wrap:wrap;`;

                function mkTag(text, val, color) {
                    const el = document.createElement('span');
                    el.style.cssText = `
                        display:inline-flex; align-items:center; gap:3px;
                        padding:2px 6px; border-radius:4px; font-size:11px;
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
                    nf.style.cssText = `color:#999; font-size:11px;`;
                    commValueRow.appendChild(nf);
                }

                commRow.appendChild(commLabel);
                commRow.appendChild(commValueRow);
                bodyEl.appendChild(commRow);

                if (remoteCommissionStatus.kind !== 'loaded') {
                    const statusEl = document.createElement('div');
                    statusEl.textContent = remoteCommissionStatus.message;
                    statusEl.style.cssText = `
                        padding:4px 0; font-size:11px; line-height:1.4;
                        color:${remoteCommissionStatus.kind === 'error' ? '#b42318' : '#888'};
                    `;
                    bodyEl.appendChild(statusEl);
                }

                // ===== WB折扣 输入 =====
                const coefRow = document.createElement('div');
                coefRow.style.cssText = `
                    margin-top:6px; display:flex; align-items:center; gap:6px;
                    padding:4px 0; border-bottom:1px dashed #eee;
                `;
                const coefLabel = document.createElement('span');
                coefLabel.textContent = 'WB折扣';
                coefLabel.style.cssText = `color:#666; white-space:nowrap;`;

                const coefWrap = document.createElement('div');
                coefWrap.style.cssText = `
                    display:inline-flex; align-items:center;
                    height: 24px;
                    border: 1px solid #e0e0e0;
                    border-radius: 5px;
                    background: #fafafa;
                    padding: 0 6px;
                    transition: border-color .15s, box-shadow .15s, background .15s;
                `;

                const coefInput = document.createElement('input');
                coefInput.type = 'number';
                coefInput.step = '1';
                coefInput.min = '0';
                coefInput.max = '99';
                coefInput.value = String(getDiscountPercent());
                coefInput.style.cssText = `
                    width: 38px;
                    border: none;
                    outline: none;
                    background: transparent;
                    font-size: 12px;
                    font-weight: 600;
                    color: #cb11ab;
                    text-align: right;
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
                    font-size: 11px;
                    margin-left: 2px;
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

                const coefHint = document.createElement('span');
                coefHint.textContent = '售价 = 价格 / 100 / (1 - 折扣)';
                coefHint.style.cssText = `
                    color:#999; font-size:11px; margin-left:auto;
                    white-space:nowrap;
                `;

                coefRow.appendChild(coefLabel);
                coefRow.appendChild(coefWrap);
                coefRow.appendChild(coefHint);
                bodyEl.appendChild(coefRow);

                // ===== 两个按钮 =====
                const actionRow = document.createElement('div');
                actionRow.style.cssText = `margin-top:8px; display:flex; gap:6px;`;

                const budgetBtn = document.createElement('button');
                budgetBtn.textContent = '预算计算器';
                budgetBtn.style.cssText = `
                    flex:1; padding:6px 8px; font-size:12px; font-weight:600;
                    background:#cb11ab; color:#fff; border:none; border-radius:5px; cursor:pointer;
                `;
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
                actionRow.appendChild(budgetBtn);

                const copyRowBtn = document.createElement('button');
                copyRowBtn.textContent = '复制表格行';
                copyRowBtn.style.cssText = `
                    flex:1; padding:6px 8px; font-size:12px; font-weight:600;
                    background:#f3e6f1; color:#cb11ab;
                    border:1px solid #e7c9e3; border-radius:5px; cursor:pointer;
                `;
                copyRowBtn.onclick = (e) => {
                    e.stopPropagation();

                    const subjName = getByPath(product, '__card__.subj_name');
                    const comm = subjName ? findCommission(subjName) : null;
                    const fboCommission = (comm && comm[0] != null) ? comm[0] : '';

                    const weightRaw  = getByPath(product, 'weight');
                    const volumeRaw  = getByPath(product, 'volume');
                    const priceRaw   = pickProductPrice(product);
                    const priceStr   = priceRaw == null ? '' : String(priceRaw / 100);

                    const weight = (weightRaw == null || weightRaw === '') ? '' : Number(weightRaw);
                    const volume = (volumeRaw == null || volumeRaw === '') ? null : (Number(volumeRaw) / 10);
                    const dims   = volume != null ? LWH_RULE(volume) : { length: '', width: '', height: '' };

                    // 14 列：本FBO佣金 / 按重量 / 重量 / 长 / 宽 / 高 / 采购价(空) / 空×6 / 售价
                    const cells = [
                        fboCommission,   // 1
                        '按重量',        // 2
                        weight,          // 3
                        dims.length,     // 4
                        dims.width,      // 5
                        dims.height,     // 6
                        '',              // 7  采购价
                        '',              // 8
                        '',              // 9
                        '',              // 10
                        '',              // 11
                        '',              // 12
                        '',              // 13
                        priceStr         // 14 售价
                    ];

                    const line = cells.map(v => v == null ? '' : String(v)).join('\t');

                    console.log('[复制表格行] 内容:', JSON.stringify(line));

                    copyText(line).then(() => {
                        copyRowBtn.textContent = '已复制';
                        setTimeout(() => { copyRowBtn.textContent = '复制表格行'; }, 1200);
                    }).catch(() => alert('复制失败，请手动复制：\n' + line));
                };
                actionRow.appendChild(copyRowBtn);

                bodyEl.appendChild(actionRow);
            }
            insertIntoPage();
        }

        function findBuyBlock() {
            const btns = Array.from(document.querySelectorAll('button'));
            const target = btns.find(b => {
                const t = (b.textContent || '').trim();
                return t === 'Добавить в корзину' || t === 'Купить сейчас';
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
                        const r = up.getBoundingClientRect();
                        if (r.width >= 200 && r.width <= window.innerWidth * 0.8) {
                            return up;
                        }
                    }
                    return parent;
                }
                el = parent;
            }
            return null;
        }

        function normalizeVisibleText(value) {
            return String(value || '').replace(/[\u00a0\u202f]/g, ' ').replace(/\s+/g, ' ').trim();
        }

        function isHorizontalLayout(el) {
            const style = window.getComputedStyle(el);
            if ((style.display === 'flex' || style.display === 'inline-flex') && style.flexDirection.startsWith('row')) {
                return true;
            }
            if (style.display === 'grid' || style.display === 'inline-grid') {
                return style.gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length > 1;
            }
            return false;
        }

        function findActionGroup(buttons, root) {
            if (!buttons.length) return null;
            let group = buttons[0].parentElement;
            while (group && group !== root && !buttons.every(button => group.contains(button))) {
                group = group.parentElement;
            }
            return group && group !== root ? group : null;
        }

        function getAfterActionPoint(group, root) {
            let anchor = group;
            while (anchor.parentElement && anchor.parentElement !== root && isHorizontalLayout(anchor.parentElement)) {
                anchor = anchor.parentElement;
            }

            let parent = anchor.parentElement;
            if (!parent) return null;
            if (parent === root && isHorizontalLayout(root) && root.parentElement) {
                parent = root.parentElement;
                anchor = root;
            }

            let before = anchor.nextSibling;
            if (before === panelEl) before = panelEl.nextSibling;
            return { parent, before };
        }

        function findInsertionPoint() {
            if (pageMode !== 'detail') return null;
            const sellerInfo = document.querySelector('section[aria-label="Информация о продавце"]');
            const sellerWrap = sellerInfo && sellerInfo.parentElement;
            const summary = sellerWrap && sellerWrap.parentElement;
            if (summary) {
                const buttons = Array.from(summary.querySelectorAll('button'));
                const primaryActions = buttons.filter(b => {
                    const text = normalizeVisibleText(b.textContent);
                    return text === 'Добавить в корзину' || text === 'Купить сейчас';
                });
                const favoriteButton = buttons.find(b => b.getAttribute('aria-label') === 'Добавить в избранное');
                const actionButtons = primaryActions.length ? primaryActions : (favoriteButton ? [favoriteButton] : []);
                const actionGroup = findActionGroup(actionButtons, summary);
                if (actionGroup) {
                    const point = getAfterActionPoint(actionGroup, summary);
                    if (point) return point;
                }

                if (sellerWrap.parentElement) {
                    return { parent: sellerWrap.parentElement, before: sellerWrap };
                }
            }

            const buyBlock = findBuyBlock();
            if (buyBlock && buyBlock.parentElement) {
                let before = buyBlock.nextSibling;
                if (before === panelEl) before = panelEl.nextSibling;
                return { parent: buyBlock.parentElement, before };
            }

            const favoriteButton = document.querySelector('button[aria-label="Добавить в избранное"]');
            if (!favoriteButton) return null;
            const favoriteGroup = findActionGroup([favoriteButton], document.body);
            return favoriteGroup ? getAfterActionPoint(favoriteGroup, document.body) : null;
        }

        function insertIntoPage() {
            if (!panelEl || pageMode !== 'detail' || panelClosed) return;
            const point = findInsertionPoint();
            if (!point) return;

            if (panelEl.parentElement === point.parent && panelEl.nextSibling === point.before && panelEl.style.display === 'block') return;

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
            panelEl.style.overflowY = '';
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
            if (!rec) {
                scheduleProductLoadTimeout(nmId);
                renderFields(null, true);
                return;
            }
            clearProductLoadTimeout();
            const product = mergeCategory(rec.data, nmId);
            renderFields(product, false);
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
        function loadExistingDetailData() {
            if (pageMode !== 'detail' || !origFetch || !window.performance?.getEntriesByType) return;
            const urls = new Set();
            for (const entry of performance.getEntriesByType('resource')) {
                const url = String(entry?.name || '');
                if (url && url.includes(TARGET_DETAIL)) urls.add(url);
            }

            for (const url of urls) {
                if (recoveredDetailUrls.has(url)) continue;
                recoveredDetailUrls.add(url);
                origFetch(url, { credentials: 'include' })
                    .then(resp => resp.ok ? resp.json() : null)
                    .then(data => {
                        if (data && pageMode === 'detail' && isDetailRoute()) {
                            indexProducts(data);
                            onDataArrived();
                        }
                    })
                    .catch(() => {});
            }
        }

        function loadExistingCardData() {
            if (pageMode !== 'detail') return;
            const nmId = getCurrentNmId();
            if (!nmId || !origFetch || !window.performance?.getEntriesByType) return;

            const urls = new Set();
            for (const entry of performance.getEntriesByType('resource')) {
                const url = String(entry?.name || '');
                if (!url) continue;
                if (url.includes(TARGET_CARD)) {
                    if (getNmFromCardUrl(url) === nmId) urls.add(url);
                    continue;
                }
                const imageMarker = `/${nmId}/images/`;
                const imageIndex = url.indexOf(imageMarker);
                if (imageIndex >= 0) {
                    urls.add(url.slice(0, imageIndex) + `/${nmId}/info/ru/card.json`);
                }
            }
            urls.add(`${location.origin}/catalog/${nmId}/info/ru/card.json`);

            for (const url of urls) {
                if (recoveredCardUrls.has(url)) continue;
                recoveredCardUrls.add(url);
                origFetch(url, { credentials: 'include' })
                    .then(resp => resp.ok ? resp.json() : null)
                    .then(data => {
                        if (data && pageMode === 'detail' && isDetailRoute()) {
                            storeCardData(url, data);
                            onDataArrived();
                        }
                    })
                    .catch(() => {});
            }
        }
        function installNetworkHooks() {
            if (networkHooksInstalled) return;
            networkHooksInstalled = true;
            origFetch = PAGE_WINDOW.fetch;
            origOpen = PAGE_WINDOW.XMLHttpRequest.prototype.open;
            origSend = PAGE_WINDOW.XMLHttpRequest.prototype.send;

            if (typeof origFetch === 'function') {
                wrappedFetch = async function (...args) {
                    const resp = await origFetch.apply(this, args);
                    if (!isDetailRoute()) return resp;
                    try {
                        const url = (args[0] && args[0].url) || String(args[0] || '');
                        if (url.includes(TARGET_DETAIL)) {
                            const clone = resp.clone();
                            clone.json().then(data => {
                                if (isDetailRoute()) { indexProducts(data); onDataArrived(); }
                            }).catch(e => console.warn('[WB抓取] detail 解析失败', e));
                        }
                        if (url.includes(TARGET_CARD)) {
                            const clone = resp.clone();
                            clone.json().then(data => {
                                if (isDetailRoute()) {
                                    storeCardData(url, data);
                                    onDataArrived();
                                }
                            }).catch(e => console.warn('[WB抓取] card.json 解析失败', e));
                        }
                    } catch (e) {}
                    return resp;
                };
                PAGE_WINDOW.fetch = wrappedFetch;
            }

            wrappedOpen = function (method, url, ...rest) {
                this.__wb_url = String(url || '');
                return origOpen.call(this, method, url, ...rest);
            };
            wrappedSend = function (...args) {
                this.addEventListener('load', function () {
                    try {
                        if (!isDetailRoute()) return;
                        const url = String(this.__wb_url || '');
                        let data = null;
                        if (url.includes(TARGET_DETAIL) || url.includes(TARGET_CARD)) {
                            if (this.responseType === '' || this.responseType === 'text') data = JSON.parse(this.responseText);
                            else if (this.responseType === 'json') data = this.response;
                            else return;
                        }
                        if (url.includes(TARGET_DETAIL) && data) { indexProducts(data); onDataArrived(); }
                        if (url.includes(TARGET_CARD) && data) {
                            storeCardData(url, data);
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

        function uninstallNetworkHooks() {
            if (!networkHooksInstalled) return;
            if (wrappedFetch && PAGE_WINDOW.fetch === wrappedFetch) PAGE_WINDOW.fetch = origFetch;
            if (wrappedOpen && PAGE_WINDOW.XMLHttpRequest.prototype.open === wrappedOpen) PAGE_WINDOW.XMLHttpRequest.prototype.open = origOpen;
            if (wrappedSend && PAGE_WINDOW.XMLHttpRequest.prototype.send === wrappedSend) PAGE_WINDOW.XMLHttpRequest.prototype.send = origSend;
            networkHooksInstalled = false;
            origFetch = null;
            origOpen = null;
            origSend = null;
            wrappedFetch = null;
            wrappedOpen = null;
            wrappedSend = null;
        }

        if (isDetailRoute()) installNetworkHooks();
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
            if (pageMode === 'detail') {
                setTimeout(loadExistingDetailData, 100);
                setTimeout(loadExistingDetailData, 800);
                setTimeout(loadExistingDetailData, 2000);
                setTimeout(loadExistingCardData, 100);
                setTimeout(loadExistingCardData, 800);
                setTimeout(loadExistingCardData, 2000);
            }
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
