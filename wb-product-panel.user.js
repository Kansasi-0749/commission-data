// ==UserScript==
// @name         WB 商品数据窗口
// @namespace    http://tampermonkey.net/
// @version      13.15
// @updateURL    https://raw.githubusercontent.com/Kansasi-0749/commission-data/main/wb-product-panel.user.js
// @downloadURL  https://raw.githubusercontent.com/Kansasi-0749/commission-data/main/wb-product-panel.user.js
// @description  拦截 Wildberries 商品接口，显示商品数据；在页面浮窗中调用预算接口并展示计算结果
// @match        https://www.wildberries.ru/*
// @match        https://yadmin.sanlindou.com/goods-shop/budget-calculator*
// @match        https://yadmin.sanlindou.com/goods-shop/budget-calc*
// @match        https://yadmin.sanlindou.com/site/login*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @connect      yadmin.sanlindou.com
// ==/UserScript==

(function () {
    'use strict';

    const BUDGET_CALC_URL = 'https://yadmin.sanlindou.com/goods-shop/budget-calc';
    const BUDGET_CATEGORY_TREE_KEY = 'wb_budget_category_tree_v1';
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

    function normalizeCategoryLabel(value) {
        return String(value || '')
            .replace(/[（(].*?[)）]/g, '')
            .replace(/\s+/g, '')
            .toLowerCase();
    }

    function flattenWbCategoryTree(tree) {
        const entries = [];
        const getLabel = node => String(node?.label ?? node?.name ?? node?.title ?? node?.text ?? '').trim();
        const getId = node => node?.value ?? node?.id ?? node?.category_id ?? node?.categoryId
            ?? node?.subject_id ?? node?.subjectId ?? node?.subj_id ?? node?.key ?? node?.code ?? '';
        const getChildren = node => node?.children ?? node?.child ?? node?.nodes ?? node?.list ?? [];

        function visit(nodes, rootName) {
            if (!Array.isArray(nodes)) return;
            for (const node of nodes) {
                const label = getLabel(node);
                const children = getChildren(node);
                const root = rootName || label;
                if (Array.isArray(children) && children.length) {
                    visit(children, root);
                } else if (rootName && label) {
                    const id = getId(node);
                    if (id !== '' && id != null) entries.push({ root, subject: label, id: String(id) });
                }
            }
        }

        visit(tree, '');
        return entries;
    }

    function cacheWbCategoryTree(tree) {
        if (typeof GM_setValue !== 'function' || !Array.isArray(tree)) return;
        const entries = flattenWbCategoryTree(tree);
        if (!entries.length) return;
        try { GM_setValue(BUDGET_CATEGORY_TREE_KEY, entries); }
        catch (error) { console.warn('[WB预算] 类目树缓存失败', error); }
    }

    function findWbCategoryId(product) {
        const root = getByPath(product, '__card__.subj_root_name');
        const subject = getByPath(product, '__card__.subj_name');
        if (root && subject && typeof GM_getValue === 'function') {
            try {
                const entries = GM_getValue(BUDGET_CATEGORY_TREE_KEY, []);
                if (Array.isArray(entries)) {
                    const rootKey = normalizeCategoryLabel(root);
                    const subjectKey = normalizeCategoryLabel(subject);
                    const matches = entries.filter(entry =>
                        normalizeCategoryLabel(entry.root) === rootKey
                        && normalizeCategoryLabel(entry.subject) === subjectKey
                    );
                    const ids = Array.from(new Set(matches.map(entry => String(entry.id))));
                    if (ids.length === 1) return ids[0];
                }
            } catch (error) {
                console.warn('[WB预算] 读取类目树缓存失败', error);
            }
        }

        const candidates = [
            'subjectId', 'subjectID', 'subject_id', 'subjId', 'subj_id',
            '__card__.subject_id', '__card__.subj_id', '__card__.wb_category_id',
        ];
        for (const path of candidates) {
            const value = getByPath(product, path);
            if (value !== '' && value != null) return String(value);
        }
        return '';
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
    else if (location.hostname === 'yadmin.sanlindou.com') {
        if (/^\/site\/login(?:\/|$)/i.test(location.pathname)) initBudgetLoginKeyboard();
        else if (/^\/goods-shop\/budget-(?:calc|calculator)(?:\/|$)/i.test(location.pathname)) initBudgetCalculator();
    }

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
                subject_id: getCardField(card, ['subjectId', 'subject_id', 'subjId', 'subj_id', 'subjectID']),
                wb_category_id: getCardField(card, ['wb_category_id', 'wbCategoryId']),
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
        let budgetModalEl = null;
        let budgetModalReturnFocus = null;
        let budgetFormEl = null;
        let budgetTitleEl = null;
        let budgetStatusEl = null;
        let budgetResultEl = null;
        let budgetSubmitEl = null;
        let lastRouteHref = location.href;
        let routeHooksInstalled = false;

        function ensureDetailState() {
            if (!window.__WB_CAPTURED__ || typeof window.__WB_CAPTURED__ !== 'object') {
                window.__WB_CAPTURED__ = Object.create(null);
            }
            if (!window.__WB_CARD__ || typeof window.__WB_CARD__ !== 'object') {
                window.__WB_CARD__ = Object.create(null);
            }
        }

        function closeBudgetModal() {
            if (!budgetModalEl || budgetModalEl.style.display === 'none') return;
            budgetModalEl.style.display = 'none';
            if (budgetModalReturnFocus?.isConnected) budgetModalReturnFocus.focus({ preventScroll: true });
            budgetModalReturnFocus = null;
        }

        function setBudgetStatus(message, kind) {
            if (!budgetStatusEl) return;
            budgetStatusEl.textContent = message || '';
            budgetStatusEl.style.color = kind === 'error' ? '#b42318'
                : kind === 'success' ? '#16803c' : '#666';
        }

        function formatCalculationValue(value, unit) {
            if (value === null || value === undefined || value === '') return '—';
            const number = Number(value);
            const text = Number.isFinite(number)
                ? number.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
                : String(value);
            return unit ? text + ' ' + unit : text;
        }

        function renderCalculationResults(responseData) {
            budgetResultEl.replaceChildren();
            const fieldRows = [
                ['category_commission_point', '类目佣金', '%'],
                ['start_logistics_cost', '首段物流', '₽'],
                ['end_logistics_cost', '末段物流', '₽'],
                ['warehousing_fee', '仓储费', '₽'],
                ['cost_price', '成本价', '₽'],
                ['handling_fee', '手续费', '₽'],
                ['tax', '税费', '₽'],
                ['profit', '利润', '₽'],
                ['rate', '收益率', ''],
                ['recommend_price', '建议售价', '₽'],
            ];

            function appendMarket(title, rows) {
                if (!Array.isArray(rows) || !rows.length) return;
                const section = document.createElement('section');
                section.style.cssText = 'margin-top:12px;';
                const heading = document.createElement('h3');
                heading.textContent = title;
                heading.style.cssText = 'margin:0 0 6px;font-size:13px;color:#333;';
                section.appendChild(heading);

                const scroller = document.createElement('div');
                scroller.style.cssText = 'overflow:auto;border:1px solid #e5e5e5;border-radius:4px;';
                const table = document.createElement('table');
                table.style.cssText = 'width:100%;min-width:560px;border-collapse:collapse;font-size:12px;';
                const thead = document.createElement('thead');
                const headRow = document.createElement('tr');
                const headings = ['指标', ...rows.map(item => item.fulfillment || '结果')];
                for (const label of headings) {
                    const th = document.createElement('th');
                    th.textContent = label;
                    th.style.cssText = 'padding:6px 8px;text-align:right;background:#f6f6f6;border-bottom:1px solid #e5e5e5;white-space:nowrap;';
                    if (label === '指标') th.style.textAlign = 'left';
                    headRow.appendChild(th);
                }
                thead.appendChild(headRow);
                table.appendChild(thead);

                const tbody = document.createElement('tbody');
                for (const [key, label, unit] of fieldRows) {
                    if (!rows.some(item => Object.prototype.hasOwnProperty.call(item, key))) continue;
                    const tr = document.createElement('tr');
                    const nameCell = document.createElement('th');
                    nameCell.textContent = label;
                    nameCell.style.cssText = 'padding:5px 8px;text-align:left;font-weight:500;color:#555;border-bottom:1px solid #eee;white-space:nowrap;';
                    tr.appendChild(nameCell);
                    for (const item of rows) {
                        const td = document.createElement('td');
                        td.textContent = formatCalculationValue(item[key], unit);
                        td.style.cssText = 'padding:5px 8px;text-align:right;border-bottom:1px solid #eee;white-space:nowrap;';
                        if (key === 'profit') td.style.color = Number(item[key]) < 0 ? '#b42318' : '#16803c';
                        if (key === 'recommend_price') td.style.fontWeight = '700';
                        tr.appendChild(td);
                    }
                    tbody.appendChild(tr);
                }
                table.appendChild(tbody);
                scroller.appendChild(table);
                section.appendChild(scroller);
                budgetResultEl.appendChild(section);
            }

            appendMarket('WB 计算结果', responseData?.wb);
            appendMarket('OZON 计算结果', responseData?.ozon);
            if (!budgetResultEl.childElementCount) {
                const empty = document.createElement('div');
                empty.textContent = '服务器未返回可展示的计算结果。';
                empty.style.cssText = 'padding:10px 0;color:#888;font-size:12px;';
                budgetResultEl.appendChild(empty);
            }
        }

        function gmRequest(options) {
            return new Promise((resolve, reject) => {
                if (typeof GM_xmlhttpRequest !== 'function') {
                    reject(new Error('油猴跨域请求接口不可用'));
                    return;
                }
                GM_xmlhttpRequest({
                    ...options,
                    anonymous: false,
                    onload: resolve,
                    onerror: () => reject(new Error('预算站网络请求失败')),
                    ontimeout: () => reject(new Error('预算站请求超时')),
                });
            });
        }

        async function getBudgetCsrfToken() {
            const response = await gmRequest({
                method: 'GET',
                url: BUDGET_CALC_URL,
                timeout: 20000,
                headers: { Accept: 'text/html,application/xhtml+xml' },
            });
            const finalUrl = String(response.finalUrl || '');
            const html = String(response.responseText || '');
            if (/\/site\/login(?:[/?#]|$)/i.test(finalUrl)) {
                throw new Error('预算站登录状态无效，请先在同一浏览器中登录预算站。');
            }
            if (response.status >= 400) {
                throw new Error('读取预算页失败，HTTP ' + response.status);
            }
            const page = new DOMParser().parseFromString(html, 'text/html');
            if (page.querySelector('input[type="password"]')) {
                throw new Error('预算站要求登录。请先在同一浏览器中登录预算站。');
            }
            return page.querySelector('meta[name="csrf-token"]')?.content
                || page.querySelector('input[name="_token"]')?.value
                || '';
        }

        async function postBudgetCalculation(payload) {
            const csrfToken = await getBudgetCsrfToken();
            const headers = {
                Accept: 'application/json, text/javascript, */*; q=0.01',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
            };
            if (csrfToken) headers['X-CSRF-TOKEN'] = csrfToken;

            const response = await gmRequest({
                method: 'POST',
                url: BUDGET_CALC_URL,
                timeout: 30000,
                headers,
                data: new URLSearchParams(payload).toString(),
            });
            const finalUrl = String(response.finalUrl || '');
            if (/\/site\/login(?:[/?#]|$)/i.test(finalUrl) || response.status === 401 || response.status === 403) {
                throw new Error('预算站登录状态失效，请先登录后重试。');
            }
            if (response.status === 419) {
                throw new Error('预算站安全令牌已过期，请刷新登录状态后重试。');
            }
            if (response.status < 200 || response.status >= 300) {
                throw new Error('计算请求失败，HTTP ' + response.status);
            }
            let result;
            try { result = JSON.parse(response.responseText || ''); }
            catch (error) { throw new Error('服务器返回的内容不是 JSON，无法解析计算结果。'); }
            if (Number(result?.status) !== 1) {
                throw new Error(result?.msg || '预算服务器计算失败。');
            }
            return result;
        }

        function defaultPackageDimensions(product) {
            const text = String(getByPath(product, '__card__.package_volume') || '');
            const match = text.match(/^\s*([\d.,]+)\s*[x×]\s*([\d.,]+)\s*[x×]\s*([\d.,]+)/i);
            if (match) {
                return {
                    length: match[1].replace(',', '.'),
                    width: match[2].replace(',', '.'),
                    height: match[3].replace(',', '.'),
                };
            }
            const volumeRaw = Number(getByPath(product, 'volume'));
            const fallback = Number.isFinite(volumeRaw) ? LWH_RULE(volumeRaw / 10) : null;
            return fallback || { length: '', width: '', height: '' };
        }

        function submitBudgetCalculation() {
            if (!budgetFormEl || !budgetSubmitEl) return;
            const payload = {};
            for (const name of [
                'cgoods_no', 'weight', 'purchase_price', 'length', 'width', 'height',
                'price', 'exchange_rate', 'is_lighting', 'ozon_category_name', 'wb_category_name',
            ]) {
                payload[name] = String(budgetFormEl.elements[name]?.value || '').trim();
            }
            const required = ['weight', 'purchase_price', 'length', 'width', 'height', 'price', 'exchange_rate', 'wb_category_name'];
            const missing = required.find(name => payload[name] === '');
            if (missing) {
                setBudgetStatus('请填写必需数据后再计算。', 'error');
                budgetFormEl.elements[missing]?.focus();
                return;
            }
            const numeric = ['weight', 'purchase_price', 'length', 'width', 'height', 'price', 'exchange_rate'];
            const invalid = numeric.find(name => !Number.isFinite(Number(payload[name])));
            if (invalid) {
                setBudgetStatus('重量、采购价、尺寸、售价和汇率必须是有效数字。', 'error');
                budgetFormEl.elements[invalid]?.focus();
                return;
            }

            budgetSubmitEl.disabled = true;
            budgetSubmitEl.textContent = '计算中…';
            budgetResultEl.replaceChildren();
            setBudgetStatus('正在提交到预算服务器…', 'loading');
            postBudgetCalculation(payload).then(result => {
                renderCalculationResults(result.data);
                setBudgetStatus(result.msg || '计算成功', 'success');
                try { GM_setValue('wb_budget_exchange_rate', payload.exchange_rate); } catch (error) {}
            }).catch(error => {
                setBudgetStatus(error.message || '计算失败', 'error');
            }).finally(() => {
                budgetSubmitEl.disabled = false;
                budgetSubmitEl.textContent = '开始计算';
            });
        }

        function ensureBudgetModal() {
            if (budgetModalEl) return;

            const dialog = document.createElement('section');
            dialog.id = 'wb-budget-calculator-float';
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-label', '预算计算器');
            dialog.style.cssText = 'position:fixed;top:84px;right:18px;z-index:2147483647;display:none;flex-direction:column;overflow:hidden;width:min(720px,calc(100vw - 24px));max-height:calc(100vh - 100px);box-sizing:border-box;background:#fff;border:1px solid #d7d7d7;border-radius:6px;box-shadow:0 12px 40px rgba(0,0,0,.22);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#222;';

            const header = document.createElement('header');
            header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;flex:0 0 42px;padding:0 12px;box-sizing:border-box;color:#fff;background:#cb11ab;cursor:move;touch-action:none;user-select:none;';
            const title = document.createElement('span');
            title.textContent = '预算计算器';
            title.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;';

            const closeButton = document.createElement('button');
            closeButton.type = 'button';
            closeButton.setAttribute('aria-label', '关闭预算计算器');
            closeButton.title = '关闭';
            closeButton.textContent = '✕';
            closeButton.style.cssText = 'display:grid;place-items:center;flex:0 0 30px;width:30px;height:30px;padding:0;border:0;color:inherit;background:transparent;font:400 18px/1 Arial,sans-serif;cursor:pointer;';
            closeButton.addEventListener('click', closeBudgetModal);
            header.append(title, closeButton);

            const body = document.createElement('div');
            body.style.cssText = 'overflow:auto;padding:12px;min-height:0;';
            const productTitle = document.createElement('div');
            productTitle.style.cssText = 'margin:0 0 10px;color:#555;font-size:12px;line-height:1.4;word-break:break-word;';
            body.appendChild(productTitle);

            const form = document.createElement('form');
            form.noValidate = true;
            const grid = document.createElement('div');
            grid.id = 'wb-budget-fields';
            grid.style.cssText = 'display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px;';

            function addField(name, labelText, value, type, options) {
                const wrapper = document.createElement('label');
                wrapper.style.cssText = 'display:flex;flex-direction:column;gap:3px;min-width:0;color:#555;font-size:11px;';
                const caption = document.createElement('span');
                caption.textContent = labelText;
                const input = options ? document.createElement('select') : document.createElement('input');
                input.name = name;
                if (options) {
                    for (const [optionValue, optionText] of options) {
                        const option = document.createElement('option');
                        option.value = optionValue;
                        option.textContent = optionText;
                        input.appendChild(option);
                    }
                } else {
                    input.type = type || 'text';
                    if (input.type === 'number') input.step = 'any';
                    input.autocomplete = 'off';
                }
                input.value = value == null ? '' : String(value);
                input.style.cssText = 'width:100%;height:32px;box-sizing:border-box;padding:5px 7px;border:1px solid #cfcfcf;border-radius:4px;background:#fff;color:#222;font-size:13px;';
                wrapper.append(caption, input);
                grid.appendChild(wrapper);
                return input;
            }

            addField('cgoods_no', '商品子编号', '', 'text');
            addField('weight', '重量（kg）', '', 'number');
            addField('purchase_price', '采购价', '', 'number');
            addField('length', '长度（cm）', '', 'number');
            addField('width', '宽度（cm）', '', 'number');
            addField('height', '高度（cm）', '', 'number');
            addField('price', '售价（₽）', '', 'number');
            addField('exchange_rate', '汇率', '14', 'number');
            addField('is_lighting', '商品类型', '0', 'select', [['0', '非灯具'], ['1', '灯具']]);
            addField('wb_category_name', 'WB 类目 ID', '', 'text');
            addField('ozon_category_name', 'OZON 类目 ID（可选）', '', 'text');
            form.appendChild(grid);

            const actionRow = document.createElement('div');
            actionRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:10px;';
            const submit = document.createElement('button');
            submit.type = 'submit';
            submit.textContent = '开始计算';
            submit.style.cssText = 'min-width:104px;height:34px;padding:0 12px;border:0;border-radius:4px;background:#12b8a6;color:#fff;font-size:12px;font-weight:600;cursor:pointer;';
            const status = document.createElement('span');
            status.setAttribute('role', 'status');
            status.style.cssText = 'min-width:0;color:#666;font-size:11px;line-height:1.4;';
            actionRow.append(submit, status);
            form.appendChild(actionRow);

            const result = document.createElement('div');
            result.id = 'wb-budget-results';
            result.style.cssText = 'margin-top:4px;';
            form.addEventListener('submit', event => {
                event.preventDefault();
                submitBudgetCalculation();
            });
            body.append(form, result);
            dialog.append(header, body);
            document.body.appendChild(dialog);

            const responsiveStyle = document.createElement('style');
            responsiveStyle.textContent = '@media(max-width:520px){#wb-budget-calculator-float{top:8px!important;right:8px!important;width:calc(100vw - 16px)!important;max-height:calc(100vh - 16px)!important}#wb-budget-fields{grid-template-columns:minmax(0,1fr)!important}}';
            document.head.appendChild(responsiveStyle);

            header.addEventListener('pointerdown', event => {
                if (event.target.closest('button')) return;
                event.preventDefault();
                const rect = dialog.getBoundingClientRect();
                const startX = event.clientX;
                const startY = event.clientY;
                const startLeft = rect.left;
                const startTop = rect.top;
                dialog.style.left = startLeft + 'px';
                dialog.style.top = startTop + 'px';
                dialog.style.right = 'auto';
                const onMove = moveEvent => {
                    const left = Math.max(0, Math.min(window.innerWidth - dialog.offsetWidth, startLeft + moveEvent.clientX - startX));
                    const top = Math.max(0, Math.min(window.innerHeight - 44, startTop + moveEvent.clientY - startY));
                    dialog.style.left = left + 'px';
                    dialog.style.top = top + 'px';
                };
                const onUp = () => {
                    window.removeEventListener('pointermove', onMove);
                    window.removeEventListener('pointerup', onUp);
                };
                window.addEventListener('pointermove', onMove);
                window.addEventListener('pointerup', onUp);
            });
            document.addEventListener('keydown', event => {
                if (event.key === 'Escape' && budgetModalEl?.style.display !== 'none') closeBudgetModal();
            });

            budgetModalEl = dialog;
            budgetFormEl = form;
            budgetTitleEl = productTitle;
            budgetStatusEl = status;
            budgetResultEl = result;
            budgetSubmitEl = submit;
        }

        function openBudgetModal(product) {
            ensureBudgetModal();
            if (budgetModalEl.style.display === 'none') {
                budgetModalReturnFocus = document.activeElement;
            }
            const dimensions = defaultPackageDimensions(product);
            const weight = Number(getByPath(product, 'weight'));
            const price = calcSellPrice(pickProductPrice(product), getDiscountPercent());
            let savedRate = '14';
            try {
                if (typeof GM_getValue === 'function') savedRate = GM_getValue('wb_budget_exchange_rate', '14');
            } catch (error) {}
            const values = {
                cgoods_no: '',
                weight: Number.isFinite(weight) ? String(weight) : '',
                purchase_price: '',
                length: dimensions.length,
                width: dimensions.width,
                height: dimensions.height,
                price,
                exchange_rate: savedRate,
                is_lighting: '0',
                ozon_category_name: '',
                wb_category_name: findWbCategoryId(product),
            };
            for (const [name, value] of Object.entries(values)) {
                const input = budgetFormEl.elements[name];
                if (input) input.value = value == null ? '' : String(value);
            }
            budgetTitleEl.textContent = product?.name || '当前商品';
            budgetResultEl.replaceChildren();
            budgetSubmitEl.disabled = false;
            budgetSubmitEl.textContent = '开始计算';
            setBudgetStatus(values.wb_category_name ? '已填入商品数据，可调整后计算。' : '请确认或填写 WB 类目 ID。', values.wb_category_name ? 'success' : 'loading');
            budgetModalEl.style.display = 'flex';
            budgetFormEl.elements.purchase_price?.focus({ preventScroll: true });
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
            closeBudgetModal();
            uninstallNetworkHooks();
            detailObserver?.disconnect();
            detailObserver = null;
            insertQueued = false;
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
                if (nextMode === 'detail') queueInsert();
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
            for (const method of ['pushState', 'replaceState']) {
                const original = history[method];
                if (typeof original !== 'function') continue;
                history[method] = function (...args) {
                    const result = original.apply(this, args);
                    handleRouteChange();
                    return result;
                };
            }
            window.addEventListener('popstate', handleRouteChange);
            window.addEventListener('hashchange', handleRouteChange);
        }

        function renderFields(product, isLoading) {
            ensurePanel();
            if (!product) {
                bodyEl.innerHTML = isLoading
                    ? `<div style="color:#999">加载中…</div>`
                    : `<div style="color:#999">等待数据中…</div>`;
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
                    openBudgetModal(product);
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
            if (!nmId) { renderFields(null, false); return; }
            if (nmId !== lastRenderedNm) {
                lastRenderedNm = nmId;
                renderFields(null, true);
            }
            const rec = window.__WB_CAPTURED__?.[nmId];
            if (!rec) { renderFields(null, true); return; }
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
        installRouteHooks();
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
    // 预算站登录页：让 Enter 明确触发登录按钮，避免触发验证码刷新按钮。
    function initBudgetLoginKeyboard() {
        const loginLabel = /登录|登入|login|sign\s*in|войти|вход/i;
        const passwordSelector = 'input[type="password"], input[autocomplete="current-password"]';

        function buttonLabel(button) {
            return [button.innerText, button.textContent, button.value,
                button.getAttribute('aria-label'), button.title]
                .filter(Boolean)
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
        }

        function findLoginButton(root) {
            return Array.from(root.querySelectorAll(
                'button, input[type="submit"], input[type="button"], [role="button"]'
            )).find(button => !button.disabled && loginLabel.test(buttonLabel(button)));
        }

        document.addEventListener('keydown', event => {
            if (event.key !== 'Enter' || event.repeat || event.isComposing || event.keyCode === 229) return;
            const input = event.target;
            if (!(input instanceof HTMLInputElement)) return;
            if (!['text', 'email', 'password', 'tel'].includes((input.type || 'text').toLowerCase())) return;

            const form = input.form || input.closest('form');
            const loginForm = form && form.querySelector(passwordSelector);
            const loginPageHasPassword = document.querySelector(passwordSelector);
            if (!loginForm && !loginPageHasPassword) return;

            const button = findLoginButton(form || document) || findLoginButton(document);
            if (!button) return;

            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            button.click();
        }, true);
    }

    // 预算计算器端
    // ============================================================
    function initBudgetCalculator() {
        let categoryTreeAttempts = 0;
        const categoryTreeTimer = setInterval(() => {
            categoryTreeAttempts += 1;
            const pageWindow = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
            const tree = pageWindow.wb_category_tree || window.wb_category_tree;
            if (Array.isArray(tree) && tree.length) {
                cacheWbCategoryTree(tree);
                clearInterval(categoryTreeTimer);
            } else if (categoryTreeAttempts >= 100) {
                clearInterval(categoryTreeTimer);
            }
        }, 200);

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
            cacheWbCategoryTree(tree);

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
