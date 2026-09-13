// ==UserScript==
// @name         Deadshot.io Lite by SURAJ'S MOD
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Deadshot Lite by SURAJ'S MOD - Performance Mode + Experimental Frame Boost for Low-End Hardware
// @author       SURAJ
// @match        https://deadshot.io/*
// @grant        none
// @license      MIT
// @run-at       document-start
// @homepageURL  https://github.com/ajha9098/Deadshot-turbo
// @supportURL   https://github.com/ajha9098/Deadshot-turbo/issues
// @downloadURL  https://update.greasyfork.org/scripts/594253/Deadshotio%20Lite%20by%20SURAJS%20MOD.user.js
// @updateURL    https://update.greasyfork.org/scripts/594253/Deadshotio%20Lite%20by%20SURAJS%20MOD.meta.js
// ==/UserScript==
(function () {
    'use strict';

    const AD_SELECTORS = ['.adsbyvli', '[id^="banner"]', '[id^="google_ads_iframe"]'];
    const BLOCKED_URL_PATTERNS = [
        'ad-manager.js', 'pubads_impl', 'gpt.js', 'googlesyndication',
        'doubleclick', 'adsbygoogle'
    ];
    const STORAGE_KEY = 'surajmod_settings_v1';

    let fpsDisplay = null;
    let togglePanel = null;
    let lastFrameTime = performance.now();
    let frameCount = 0;
    let currentFps = 0;
    let rafId = null;
    let adObserver = null;
    let perfStyleTag = null;

    // ---------------------------------------------------------
    // Ad blocking (document-start, runs before page scripts)
    // ---------------------------------------------------------
    function isBlockedUrl(url) {
        if (!url) return false;
        return BLOCKED_URL_PATTERNS.some(p => url.includes(p));
    }

    function stubGoogletag() {
        const noop = () => {};
        const cmdArray = [];
        cmdArray.push = () => 0;
        window.googletag = {
            cmd: cmdArray,
            defineSlot: () => ({ addService: noop }),
            defineOutOfPageSlot: () => ({ addService: noop }),
            pubads: () => ({
                enableSingleRequest: noop, collapseEmptyDivs: noop,
                addEventListener: noop, removeEventListener: noop,
                refresh: noop, setTargeting: noop, disableInitialLoad: noop
            }),
            enableServices: noop, display: noop, destroySlots: noop, apiReady: true
        };
    }

    function blockAdScriptInjection() {
        const originalCreateElement = document.createElement.bind(document);
        document.createElement = function (tagName, ...args) {
            const el = originalCreateElement(tagName, ...args);
            if (typeof tagName === 'string' && tagName.toLowerCase() === 'script') {
                const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
                Object.defineProperty(el, 'src', {
                    configurable: true,
                    get() { return srcDescriptor.get.call(el); },
                    set(value) {
                        if (isBlockedUrl(value)) return;
                        srcDescriptor.set.call(el, value);
                    }
                });
            }
            return el;
        };
    }

    function blockAdFetches() {
        const originalFetch = window.fetch;
        if (originalFetch) {
            window.fetch = function (input, init) {
                const url = typeof input === 'string' ? input : input?.url;
                if (isBlockedUrl(url)) return Promise.resolve(new Response('', { status: 204 }));
                return originalFetch.call(this, input, init);
            };
        }
        const OriginalXHR = window.XMLHttpRequest;
        function PatchedXHR() {
            const xhr = new OriginalXHR();
            const originalOpen = xhr.open.bind(xhr);
            xhr.open = function (method, url, ...rest) {
                if (isBlockedUrl(url)) return originalOpen(method, 'data:text/plain,', ...rest);
                return originalOpen(method, url, ...rest);
            };
            return xhr;
        }
        window.XMLHttpRequest = PatchedXHR;
    }

    stubGoogletag();
    blockAdScriptInjection();
    blockAdFetches();

    // ---------------------------------------------------------
    // Experimental Frame Boost: reduce internal render resolution
    // so the GPU has fewer pixels to shade per frame. Must run at
    // document-start, before the game reads devicePixelRatio to
    // size its canvas, or this has no effect.
    // ---------------------------------------------------------
    function readFrameBoostPref() {
        try {
            const saved = JSON.parse(localStorage.getItem('surajmod_settings_v1'));
            return saved?.frameBoost ?? false;
        } catch {
            return false;
        }
    }

    function applyDevicePixelRatioOverride() {
        try {
            Object.defineProperty(window, 'devicePixelRatio', {
                configurable: true,
                get() { return 1; }
            });
        } catch (_) {
            // Some browsers may not allow redefining this; fail silently,
            // the rest of frame boost still helps.
        }
    }

    if (readFrameBoostPref()) {
        applyDevicePixelRatioOverride();
    }

    // Patch canvas context creation globally: fixes the Chrome console
    // hint about willReadFrequently, and disables smoothing (cheaper to
    // render, matches "rougher but faster" preference).
    (function patchCanvasContext() {
        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, attributes) {
            if (type === '2d') {
                attributes = Object.assign({}, attributes, { willReadFrequently: true });
            }
            const ctx = originalGetContext.call(this, type, attributes);
            if (ctx && type === '2d' && 'imageSmoothingEnabled' in ctx) {
                try { ctx.imageSmoothingEnabled = false; } catch (_) {}
            }
            return ctx;
        };
    })();

    // ---------------------------------------------------------
    // Settings
    // ---------------------------------------------------------
    function loadSettings() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
            return {
                adRemoval: saved?.adRemoval ?? true,
                fpsOverlay: saved?.fpsOverlay ?? true,
                perfMode: saved?.perfMode ?? true,
                frameBoost: saved?.frameBoost ?? false,
                panelVisible: saved?.panelVisible ?? true
            };
        } catch {
            return { adRemoval: true, fpsOverlay: true, perfMode: true, frameBoost: false, panelVisible: true };
        }
    }
    function saveSettings() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    }
    const settings = loadSettings();

    // ---------------------------------------------------------
    // Ad removal (DOM cleanup, observer-driven)
    // ---------------------------------------------------------
    function removeAds(root = document) {
        for (const selector of AD_SELECTORS) {
            const nodes = root.querySelectorAll(selector);
            for (let i = 0; i < nodes.length; i++) nodes[i].remove();
        }
    }
    function startAdRemoval() {
        if (adObserver) return;
        removeAds();
        adObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
                if (m.addedNodes.length) { removeAds(document); break; }
            }
        });
        adObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    function stopAdRemoval() {
        if (adObserver) { adObserver.disconnect(); adObserver = null; }
    }

    // ---------------------------------------------------------
    // Aggressive performance mode
    // Trades visual fidelity for frame rate on low-end integrated GPUs.
    // Honest limits: this cannot invent GPU power that doesn't exist,
    // it reduces render cost so the GPU you have goes further.
    // ---------------------------------------------------------
    function applyPerfMode(enable) {
        if (enable) {
            if (perfStyleTag) return;
            perfStyleTag = document.createElement('style');
            perfStyleTag.id = 'surajmod-perf-mode';
            perfStyleTag.textContent = `
                * {
                    box-shadow: none !important;
                    text-shadow: none !important;
                    filter: none !important;
                    backdrop-filter: none !important;
                    transition: none !important;
                    animation-duration: 0.01ms !important;
                }
                canvas {
                    image-rendering: pixelated;
                    image-rendering: -moz-crisp-edges;
                    image-rendering: crisp-edges;
                }
            `;
            document.head.appendChild(perfStyleTag);

            // Lower devicePixelRatio-driven canvas backing resolution where possible.
            // Many browser games read window.devicePixelRatio once at boot to size
            // their canvas backing store; scripts running after boot can't force a
            // re-read, but this covers games that check it on resize events.
            document.querySelectorAll('canvas').forEach(applyCanvasDownscale);
        } else {
            if (perfStyleTag) { perfStyleTag.remove(); perfStyleTag = null; }
            document.querySelectorAll('canvas').forEach(c => {
                c.style.imageRendering = '';
            });
        }
    }

    function applyCanvasDownscale(canvas) {
        // Only touch canvases that are actually large (the game canvas), not
        // small icon/UI canvases, to avoid breaking HUD elements.
        if (canvas.width > 400 && canvas.height > 300) {
            canvas.style.imageRendering = 'pixelated';
        }
    }

    // ---------------------------------------------------------
    // Experimental Frame Boost: shrink the canvas's actual pixel
    // buffer (backing store) while keeping its displayed CSS size the
    // same. The browser then upscales cheaply instead of the game
    // rendering every frame at full resolution. This can make click/aim
    // coordinates feel slightly off on games that don't recompute their
    // internal-to-display ratio correctly — test after enabling.
    // ---------------------------------------------------------
    const downscaledCanvases = new WeakMap(); // canvas -> original {w, h, cssW, cssH}
    const FRAME_BOOST_SCALE = 0.75;

    function downscaleCanvas(canvas) {
        if (canvas.width <= 400 || canvas.height <= 300) return; // skip small/UI canvases
        if (downscaledCanvases.has(canvas)) return; // already handled

        const rect = canvas.getBoundingClientRect();
        const original = {
            w: canvas.width,
            h: canvas.height,
            cssW: canvas.style.width || `${rect.width}px`,
            cssH: canvas.style.height || `${rect.height}px`
        };
        downscaledCanvases.set(canvas, original);

        canvas.style.width = original.cssW;
        canvas.style.height = original.cssH;
        canvas.width = Math.floor(original.w * FRAME_BOOST_SCALE);
        canvas.height = Math.floor(original.h * FRAME_BOOST_SCALE);
    }

    function restoreCanvas(canvas) {
        const original = downscaledCanvases.get(canvas);
        if (!original) return;
        canvas.width = original.w;
        canvas.height = original.h;
        canvas.style.width = '';
        canvas.style.height = '';
        downscaledCanvases.delete(canvas);
    }

    function applyFrameBoost(enable) {
        document.querySelectorAll('canvas').forEach(c => {
            if (enable) downscaleCanvas(c);
            else restoreCanvas(c);
        });
    }

    // Watch for canvases added after load (game re-init, resolution changes)
    function watchCanvases() {
        const obs = new MutationObserver((mutations) => {
            for (const m of mutations) {
                m.addedNodes.forEach(node => {
                    if (node.nodeName !== 'CANVAS') return;
                    if (settings.perfMode) applyCanvasDownscale(node);
                    if (settings.frameBoost) downscaleCanvas(node);
                });
            }
        });
        obs.observe(document.documentElement, { childList: true, subtree: true });
    }

    // ---------------------------------------------------------
    // FPS overlay
    // ---------------------------------------------------------
    function createFPSDisplay() {
        fpsDisplay = document.createElement('div');
        Object.assign(fpsDisplay.style, {
            position: 'fixed', bottom: '10px', right: '10px',
            backgroundColor: 'rgba(15, 15, 20, 0.75)', padding: '6px 12px',
            borderRadius: '8px', color: '#5eead4', fontSize: '13px',
            fontFamily: 'monospace', fontWeight: 'bold', zIndex: '2147483000',
            pointerEvents: 'none', letterSpacing: '0.5px',
            border: '1px solid rgba(94, 234, 212, 0.25)'
        });
        fpsDisplay.textContent = 'FPS: --';
        document.body.appendChild(fpsDisplay);
    }

    function updateFPS(now) {
        frameCount++;
        const elapsed = now - lastFrameTime;
        if (elapsed >= 1000) {
            currentFps = Math.round((frameCount * 1000) / elapsed);
            frameCount = 0;
            lastFrameTime = now;
            if (settings.fpsOverlay && fpsDisplay) {
                fpsDisplay.textContent = `FPS: ${currentFps}`;
                fpsDisplay.style.color = currentFps >= 45 ? '#5eead4' : currentFps >= 25 ? '#fbbf24' : '#f87171';
            }
        }
        rafId = requestAnimationFrame(updateFPS);
    }

    // ---------------------------------------------------------
    // Cosmetic slider tweak
    // ---------------------------------------------------------
    function changeSelectorBarColor() {
        const style = document.createElement('style');
        style.textContent = `
            .range::-webkit-slider-thumb { background: red !important; }
            .range::-moz-range-thumb    { background: red !important; }
            .range::-ms-thumb           { background: red !important; }
        `;
        document.head.appendChild(style);
    }

    // ---------------------------------------------------------
    // Panel UI
    // ---------------------------------------------------------
    function createTogglePanel() {
        togglePanel = document.createElement('div');
        togglePanel.id = 'surajmod-panel';
        Object.assign(togglePanel.style, {
            position: 'fixed', top: '14px', right: '14px', width: '220px',
            backgroundColor: 'rgba(15, 15, 22, 0.92)',
            backdropFilter: 'none',
            borderRadius: '12px', color: '#e5e7eb', fontSize: '13px',
            fontFamily: '-apple-system, "Segoe UI", sans-serif', zIndex: '2147483001',
            userSelect: 'none', border: '1px solid rgba(94, 234, 212, 0.2)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)', overflow: 'hidden'
        });

        const header = document.createElement('div');
        Object.assign(header.style, {
            padding: '10px 14px', background: 'linear-gradient(90deg, #0f766e, #134e4a)',
            fontWeight: '700', fontSize: '13px', color: '#f0fdfa',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center'
        });
        header.innerHTML = `<span style="letter-spacing:0.5px">✦ 𝗦𝗨𝗥𝗔𝗝'𝗦 𝗠𝗢𝗗</span><span style="font-size:10px;opacity:0.6;font-weight:400">.lite v2.0</span>`;
        togglePanel.appendChild(header);

        const body = document.createElement('div');
        Object.assign(body.style, { padding: '10px 14px 12px', display: 'flex', flexDirection: 'column', gap: '2px' });

        function makeToggle(label, desc, key, onChange) {
            const row = document.createElement('label');
            Object.assign(row.style, {
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '7px 0', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.06)'
            });

            const textWrap = document.createElement('div');
            const title = document.createElement('div');
            title.textContent = label;
            title.style.fontSize = '13px';
            const sub = document.createElement('div');
            sub.textContent = desc;
            sub.style.fontSize = '10px';
            sub.style.opacity = '0.5';
            sub.style.marginTop = '1px';
            textWrap.appendChild(title);
            textWrap.appendChild(sub);

            const switchWrap = document.createElement('div');
            Object.assign(switchWrap.style, {
                width: '34px', height: '18px', borderRadius: '9px',
                background: settings[key] ? '#0f766e' : 'rgba(255,255,255,0.15)',
                position: 'relative', transition: 'background 0.15s', flexShrink: '0'
            });
            const knob = document.createElement('div');
            Object.assign(knob.style, {
                width: '14px', height: '14px', borderRadius: '50%', background: '#fff',
                position: 'absolute', top: '2px', left: settings[key] ? '18px' : '2px',
                transition: 'left 0.15s'
            });
            switchWrap.appendChild(knob);

            row.addEventListener('click', (e) => {
                e.preventDefault();
                settings[key] = !settings[key];
                switchWrap.style.background = settings[key] ? '#0f766e' : 'rgba(255,255,255,0.15)';
                knob.style.left = settings[key] ? '18px' : '2px';
                saveSettings();
                onChange(settings[key]);
            });

            row.appendChild(textWrap);
            row.appendChild(switchWrap);
            body.appendChild(row);
        }

        makeToggle('Ad removal', 'Strips ad slots & requests', 'adRemoval', (v) => {
            if (v) startAdRemoval(); else stopAdRemoval();
        });
        makeToggle('Performance mode', 'Cuts effects for higher FPS', 'perfMode', (v) => {
            applyPerfMode(v);
        });
        makeToggle('Experimental Frame Boost', 'Lowers render res — reload after toggling', 'frameBoost', (v) => {
            applyFrameBoost(v);
        });
        makeToggle('FPS overlay', 'Shows live frame rate', 'fpsOverlay', (v) => {
            if (fpsDisplay) fpsDisplay.style.display = v ? 'block' : 'none';
        });

        const hint = document.createElement('div');
        hint.textContent = 'F1 to hide/show panel';
        Object.assign(hint.style, { fontSize: '10px', opacity: '0.4', marginTop: '8px', textAlign: 'center' });
        body.appendChild(hint);

        togglePanel.appendChild(body);
        document.body.appendChild(togglePanel);
    }

    function togglePanelVisibility() {
        if (!togglePanel) return;
        settings.panelVisible = !settings.panelVisible;
        togglePanel.style.display = settings.panelVisible ? 'block' : 'none';
        saveSettings();
    }

    function setupHotkey() {
        window.addEventListener('keydown', (e) => {
            if (e.key === 'F1') {
                e.preventDefault();
                togglePanelVisibility();
            }
        });
    }

    // ---------------------------------------------------------
    // Init
    // ---------------------------------------------------------
    function init() {
        createFPSDisplay();
        fpsDisplay.style.display = settings.fpsOverlay ? 'block' : 'none';

        changeSelectorBarColor();
        createTogglePanel();
        togglePanel.style.display = settings.panelVisible ? 'block' : 'none';
        setupHotkey();

        if (settings.adRemoval) startAdRemoval();
        if (settings.perfMode) applyPerfMode(true);
        if (settings.frameBoost) applyFrameBoost(true);
        watchCanvases();

        rafId = requestAnimationFrame(updateFPS);
    }

    window.addEventListener('load', init, { once: true });
    window.addEventListener('beforeunload', () => {
        if (rafId) cancelAnimationFrame(rafId);
        stopAdRemoval();
    });
})();
