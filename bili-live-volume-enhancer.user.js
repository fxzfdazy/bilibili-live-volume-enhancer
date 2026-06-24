// ==UserScript==
// @name         B站直播间音量增强
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  为B站直播间提供音量放大功能，各房间独立记忆音量，侧边悬浮隐藏面板。新增防爆音压缩器，另有隐藏播放器内的直播间ID水印功能。
// @author       fxzfdazy
// @match        *://live.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @license      MIT
// @homepageURL  https://github.com/xxx
// @supportURL   https://github.com/xxx
// @updateURL    https://raw.githubusercontent.com/xxx
// @downloadURL  https://raw.githubusercontent.com/xxx
// ==/UserScript==

(function() {
    'use strict';

    const match = location.pathname.match(/\/(\d+)/);
    if (!match) return;
    const roomId = match[1];

    // --- 1. 数据存储管理 (减少高频 IO) ---
    const Storage = {
        key: 'bili_live_volumes_v3',
        max: 50,
        getAll() {
            try { return JSON.parse(GM_getValue(this.key, '{}')); }
            catch { return {}; }
        },
        get(id) {
            return this.getAll()[id]?.gain ?? 1.0;
        },
        set(id, gain) {
            const data = this.getAll();
            if (gain === 1.0) {
                delete data[id];
            } else {
                data[id] = { gain, ts: Date.now() };
                const keys = Object.keys(data);
                if (keys.length > this.max) {
                    const oldest = keys.reduce((a, b) => data[a].ts < data[b].ts ? a : b);
                    delete data[oldest];
                }
            }
            GM_setValue(this.key, JSON.stringify(data));
        }
    };

    let currentGain = Storage.get(roomId);
    let currentPosY = GM_getValue('bili_live_vb_pos_y', 75);

    // 全局读取防爆音开关状态（默认开启）
    let compressorEnabled = GM_getValue('bili_live_compressor', true);

    // --- 音量与分贝转换器 ---
    const formatVolume = (gain) => {
        const percent = Math.round(gain * 100);
        if (gain === 0) return `0% (-∞ dB)`;
        const dB = (20 * Math.log10(gain)).toFixed(1);
        const sign = dB > 0 ? '+' : '';
        return `${percent}% (${sign}${dB} dB)`;
    };

    // --- 2. 核心音频处理 ---
    let audioCtx = null;
    // 映射表：存放 Video元素 -> { gain: GainNode, comp: DynamicsCompressorNode }
    const audioNodesMap = new WeakMap();

    // 应用压缩器参数
    function applyCompressorSettings(node, enabled) {
        if (enabled) {
            // 开启：阈值-1dB，高压缩比，快速响应防爆音
            node.threshold.value = -1.0;
            node.knee.value = 0;
            node.ratio.value = 20;
            node.attack.value = 0.003;
            node.release.value = 0.25;
        } else {
            // 关闭：阈值为0，比例为1（相当于直通，不压缩）
            node.threshold.value = 0;
            node.knee.value = 0;
            node.ratio.value = 1;
            node.attack.value = 0;
            node.release.value = 0;
        }
    }

    function initAudio(video) {
        if (video.dataset.veConnected === "true") return;
        video.dataset.veConnected = "true";

        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();

            const gainNode = audioCtx.createGain();
            const compressor = audioCtx.createDynamicsCompressor();
            const source = audioCtx.createMediaElementSource(video);

            // 初始化压缩器状态
            applyCompressorSettings(compressor, compressorEnabled);

            // 连接顺序：音频源 -> 增益节点 (放大) -> 压缩器 (防爆音) -> 扬声器
            source.connect(gainNode);
            gainNode.connect(compressor);
            compressor.connect(audioCtx.destination);

            gainNode.gain.value = currentGain;

            audioNodesMap.set(video, { gain: gainNode, comp: compressor });
        } catch (e) {
            console.warn('[音量增强] 音频节点接入失败(可能为跨域/备用流):', e);
        }
    }

    // 每秒轮询接入视频流
    setInterval(() => {
        document.querySelectorAll('video:not([muted])').forEach(video => {
            initAudio(video);
        });
    }, 1000);

    // 突破浏览器自动播放策略限制
    window.addEventListener('click', () => {
        if (audioCtx?.state === 'suspended') audioCtx.resume();
    }, { capture: true });

    // --- 3. UI与样式注入 ---
    GM_addStyle(`
        .web-player-icon-roomStatus { display: none !important; }

        #bili-ve-container {
            position: fixed; left: 0; top: ${currentPosY}%;
            transform: translateY(-50%); z-index: 999998;
            display: flex; align-items: center;
        }
        #bili-ve-trigger-zone {
            position: absolute; left: 0; top: -50px;
            width: 15px; height: 100px;
        }
        #bili-ve-icon-btn {
            position: absolute; left: -55px;
            width: 40px; height: 40px;
            background: #fff; color: #61666d;
            border: 1px solid #e3e5e7; border-left: none; border-radius: 0 8px 8px 0;
            display: flex; justify-content: center; align-items: center;
            cursor: grab; user-select: none;
            transition: left 0.3s cubic-bezier(0.4, 0, 0.2, 1), box-shadow 0.3s;
        }
        #bili-ve-icon-btn:active { cursor: grabbing; }
        #bili-ve-icon-btn:hover { color: #00AEEC; }
        #bili-ve-container:hover #bili-ve-icon-btn, #bili-ve-icon-btn.is-active {
            left: 0; box-shadow: 4px 0 12px rgba(0,0,0,0.12);
        }

        #bili-ve-panel {
            position: absolute; left: 55px; width: 240px; padding: 16px;
            background: #fff; border: 1px solid #e3e5e7; border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.1); display: none; box-sizing: border-box;
            font-family: sans-serif; color: #18191c; user-select: none; cursor: default;
        }
        #bili-ve-panel.is-visible { display: block; }

        .bili-ve-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 12px; font-size: 14px; font-weight: 500; }
        .bili-ve-value { color: #00AEEC; font-weight: bold; font-size: 13px; }

        .bili-ve-slider { -webkit-appearance: none; width: 100%; background: transparent; margin: 10px 0; }
        .bili-ve-slider::-webkit-slider-runnable-track { width: 100%; height: 4px; background: #e3e5e7; border-radius: 2px; cursor: pointer; }
        .bili-ve-slider::-webkit-slider-thumb {
            -webkit-appearance: none; width: 14px; height: 14px; margin-top: -5px;
            background: #00AEEC; border-radius: 50%; cursor: pointer;
            box-shadow: 0 2px 4px rgba(0, 174, 236, 0.3); transition: transform 0.1s;
        }
        .bili-ve-slider::-webkit-slider-thumb:hover { transform: scale(1.2); }

        .bili-ve-comp-toggle { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; padding-top: 10px; border-top: 1px solid #f0f1f3; font-size: 12px; color: #9499a0; }
        .bili-ve-switch { position: relative; width: 32px; height: 18px; background: #e3e5e7; border-radius: 9px; cursor: pointer; transition: background 0.2s; }
        .bili-ve-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; background: #fff; border-radius: 50%; transition: transform 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .bili-ve-switch.active { background: #00AEEC; }
        .bili-ve-switch.active::after { transform: translateX(14px); }

        .bili-ve-footer { display: flex; justify-content: space-between; margin-top: 10px; font-size: 12px; color: #9499a0; }
        .bili-ve-reset { color: #00AEEC; cursor: pointer; transition: opacity 0.2s; }
        .bili-ve-reset:hover { opacity: 0.8; }
    `);

    const container = document.createElement('div');
    container.id = 'bili-ve-container';
    container.innerHTML = `
        <div id="bili-ve-trigger-zone"></div>
        <div id="bili-ve-icon-btn" title="点击打开面板 / 长按拖拽位置">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
        </div>
        <div id="bili-ve-panel">
            <div class="bili-ve-header">
                <span>音量增强</span>
                <span class="bili-ve-value" id="bili-ve-val-display">${formatVolume(currentGain)}</span>
            </div>
            <input type="range" class="bili-ve-slider" id="bili-ve-slider-input" min="0" max="500" value="${Math.round(currentGain * 100)}">
            <div class="bili-ve-comp-toggle">
                <span>防爆音 (压缩器)</span>
                <div class="bili-ve-switch ${compressorEnabled ? 'active' : ''}" id="bili-ve-comp-switch" title="开启后可防止高音量破音失真"></div>
            </div>
            <div class="bili-ve-footer">
                <span>房间独立记忆</span>
                <span class="bili-ve-reset" id="bili-ve-reset-btn">恢复100%</span>
            </div>
        </div>
    `;
    document.body.appendChild(container);

    // --- 4. 交互与事件绑定 ---
    const $ = id => container.querySelector(id);
    const iconBtn = $('#bili-ve-icon-btn');
    const panel = $('#bili-ve-panel');
    const slider = $('#bili-ve-slider-input');
    const valDisplay = $('#bili-ve-val-display');
    const compSwitch = $('#bili-ve-comp-switch');

    let isPanelOpen = false;
    let dragState = { active: false, moved: false, startY: 0, startTopPx: 0, rafId: null };

    const togglePanel = () => {
        isPanelOpen = !isPanelOpen;
        panel.classList.toggle('is-visible', isPanelOpen);
        iconBtn.classList.toggle('is-active', isPanelOpen);
    };
    GM_registerMenuCommand("⚙️ 呼出/隐藏 设置面板", togglePanel);

    // 拖拽控制
    iconBtn.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        dragState.active = true;
        dragState.moved = false;
        dragState.startY = e.clientY;
        dragState.startTopPx = container.getBoundingClientRect().top + container.offsetHeight / 2;
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
        if (!dragState.active) return;
        const dy = e.clientY - dragState.startY;

        if (Math.abs(dy) > 3) {
            dragState.moved = true;
            if (isPanelOpen) togglePanel();
        }

        if (dragState.moved) {
            cancelAnimationFrame(dragState.rafId);
            dragState.rafId = requestAnimationFrame(() => {
                const newTop = Math.max(30, Math.min(window.innerHeight - 30, dragState.startTopPx + dy));
                container.style.top = `${(newTop / window.innerHeight) * 100}%`;
            });
        }
    });

    const stopDrag = () => {
        if (!dragState.active) return;
        dragState.active = false;
        document.body.style.userSelect = '';

        if (dragState.moved) {
            currentPosY = parseFloat(container.style.top);
            GM_setValue('bili_live_vb_pos_y', currentPosY);
        }
    };

    window.addEventListener('mouseup', stopDrag);
    window.addEventListener('blur', stopDrag);

    iconBtn.addEventListener('click', (e) => {
        if (dragState.moved) return e.preventDefault();
        togglePanel();
    });

    document.addEventListener('click', (e) => {
        if (isPanelOpen && !container.contains(e.target)) togglePanel();
    });

    // 滑动条调整 (防抖存盘)
    let saveTimer = null;
    slider.addEventListener('input', (e) => {
        const val = Number(e.target.value);
        currentGain = val / 100;

        valDisplay.textContent = formatVolume(currentGain);

        // 遍历所有抓取到的 video，更新专属的 GainNode
        document.querySelectorAll('video').forEach(video => {
            const nodes = audioNodesMap.get(video);
            if (nodes) nodes.gain.gain.value = currentGain;
        });

        if (audioCtx?.state === 'suspended') audioCtx.resume();

        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            Storage.set(roomId, currentGain);
        }, 300);
    });

    // 防爆音开关点击事件
    compSwitch.addEventListener('click', () => {
        compressorEnabled = !compressorEnabled;
        compSwitch.classList.toggle('active', compressorEnabled);
        GM_setValue('bili_live_compressor', compressorEnabled);

        // 实时更新所有已连接的压缩器节点
        document.querySelectorAll('video').forEach(video => {
            const nodes = audioNodesMap.get(video);
            if (nodes) applyCompressorSettings(nodes.comp, compressorEnabled);
        });
    });

    // 恢复默认
    $('#bili-ve-reset-btn').addEventListener('click', () => {
        slider.value = 100;
        slider.dispatchEvent(new Event('input'));
    });

})();