// Setup state definitions
let appState = {
    apiKey: '',
    assets: [], // Contains objects: { id, name, fileType, dataUrl (or array of dataUrls for PDF/CBZ), pageCount }
    selectedAssetId: null,
    selectedPageIndex: 0,

    scenes: [], // Contains scene timeline clips: { id, text, duration, startTime, assetId, pageIndex, crop: {x, y, w, h}, panelName, audioUrl, status }
    selectedSceneId: null,

    // Player properties
    isPlaying: false,
    playbackTime: 0,
    animationFrameId: null,
    audioElements: {}, // Audio elements for active TTS clips

    // Auto detection panels
    detectedPanels: [] // Bounding boxes for current selected image page [{x, y, w, h}]
};

// Crop tracking variables
let cropState = {
    isDragging: false,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    rect: null // Current crop rectangle coordinates in % normalized {x, y, w, h}
};

// Initialize PDFJS
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Setup onload hooks
window.addEventListener('load', () => {
    // Check for API keys in local storage
    const savedKey = localStorage.getItem('gemini_api_key');
    if (savedKey) {
        appState.apiKey = savedKey;
        document.getElementById('gemini-api-key').value = savedKey;
        document.getElementById('api-indicator').classList.remove('bg-red-500');
        document.getElementById('api-indicator').classList.add('bg-green-500');
    }

    // Bind Drag & Drop Events for assets import
    const dropzone = document.getElementById('dropzone');
    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('border-indigo-500'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('border-indigo-500'));
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('border-indigo-500');
        if (e.dataTransfer.files.length) {
            processUploadedFiles(e.dataTransfer.files);
        }
    });

    // Initialize Lucide Vector Icons
    lucide.createIcons();

    // Populate system speech fallback options
    populateSystemSpeechVoices();
    if (window.speechSynthesis) {
        window.speechSynthesis.onvoiceschanged = populateSystemSpeechVoices;
    }

    // Start up player loops
    initPlayerCanvas();

    // Setup mouse & touch listeners on the canvas cropper
    setupCropCanvasListeners();

    // Resize event listener for canvas adjusting
    window.addEventListener('resize', () => {
        renderCropStudio();
    });
});

function getEnabledAnimationStyles() {
    const styles = [];
    if (document.getElementById('animation-slide-up')?.checked) styles.push('slide-up');
    if (document.getElementById('animation-slide-down')?.checked) styles.push('slide-down');
    if (document.getElementById('animation-zoom')?.checked) styles.push('zoom');
    return styles.length ? styles : ['zoom'];
}

function getMediaSequence() {
    return appState.assets.flatMap(asset => asset.pages.map((pageUrl, pageIndex) => ({
        assetId: asset.id,
        pageIndex,
        pageUrl
    })));
}

function assignScenePresentation(scene, index = 0, forceRandomize = false) {
    const enabledStyles = getEnabledAnimationStyles();
    const selectedBgMode = document.getElementById('scene-bg-mode')?.value || appState.backgroundMode;
    const selectedBgColor = document.getElementById('scene-bg-color')?.value || appState.backgroundColor;

    if (forceRandomize || !scene.animationStyle || !enabledStyles.includes(scene.animationStyle)) {
           scene.animationStyle = enabledStyles[Math.floor(Math.random() * enabledStyles.length)] || enabledStyles[0];
    }

    scene.backgroundMode = selectedBgMode || 'solid';
    scene.backgroundColor = selectedBgColor || '#0b0d11';
}

function syncScenesToMedia(forceRandomize = false) {
    const mediaSequence = getMediaSequence();

    appState.scenes.forEach((scene, index) => {
        const media = mediaSequence.length ? mediaSequence[index % mediaSequence.length] : null;
        if (media) {
            scene.assetId = media.assetId;
            scene.pageIndex = media.pageIndex;
        } else if (!scene.assetId && appState.selectedAssetId) {
            scene.assetId = appState.selectedAssetId;
            scene.pageIndex = appState.selectedPageIndex || 0;
        }

        assignScenePresentation(scene, index, forceRandomize);
    });
}

function applyPresentationSettings() {
    appState.backgroundMode = document.getElementById('scene-bg-mode').value;
    appState.backgroundColor = document.getElementById('scene-bg-color').value;
    syncScenesToMedia(false);
    renderTimeline();
    renderScriptList();
    renderCropStudio();
}

async function buildAutoVideo() {
    if (appState.scenes.length === 0) {
        showToast("No Scenes", "Create or generate at least one scene first.", "error");
        return;
    }

    syncScenesToMedia(true);
    await refreshSceneCropsWithAi();
    renderTimeline();
    renderScriptList();
    renderCropStudio();

    if (appState.apiKey) {
        await generateAllTts();
    }

    switchView('player');
    startPlayer();
}

function extractDataUrlParts(dataUrl) {
    const commaIndex = dataUrl.indexOf(',');
    return {
        mimeType: dataUrl.slice(5, commaIndex),
        base64: dataUrl.slice(commaIndex + 1)
    };
}

function extractGeminiText(result) {
    const parts = result?.candidates?.[0]?.content?.parts || [];
    return parts.map(part => part?.text || '').join('').trim();
}

function parseGeminiJsonResult(result) {
    const rawText = extractGeminiText(result);
    if (!rawText) {
        throw new Error('Gemini returned an empty response');
    }

    const fencedMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidateText = (fencedMatch?.[1] || rawText).trim();

    try {
        return JSON.parse(candidateText);
    } catch (firstError) {
        const start = candidateText.indexOf('{');
        const end = candidateText.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return JSON.parse(candidateText.slice(start, end + 1));
        }
        throw firstError;
    }
}

async function generateAiCropSuggestionForScene(scene) {
    if (!appState.apiKey || !scene || !scene.assetId) return null;

    const asset = appState.assets.find(a => a.id === scene.assetId);
    if (!asset || !asset.pages?.[scene.pageIndex]) return null;

    const { mimeType, base64 } = extractDataUrlParts(asset.pages[scene.pageIndex]);
    const promptText = `
        You are framing a single manhwa recap shot for a vertical video edit.
        Use the page image and the narration context to choose the most important panel region.
        Narration context: "${scene.text}"

        Return one tight normalized crop box in percentages with the best framing for this scene.
        The crop must be within the page and should prefer a single panel or panel cluster that matches the narration.
        If multiple choices exist, choose the strongest match.
        Return only valid JSON.
    `;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${appState.apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: promptText },
                        { inlineData: { mimeType, data: base64 } }
                    ]
                }],
                generationConfig: {
                    responseMimeType: 'application/json',
                    responseSchema: {
                        type: 'OBJECT',
                        properties: {
                            crop: {
                                type: 'OBJECT',
                                properties: {
                                    x: { type: 'NUMBER' },
                                    y: { type: 'NUMBER' },
                                    w: { type: 'NUMBER' },
                                    h: { type: 'NUMBER' },
                                    label: { type: 'STRING' }
                                },
                                required: ['x', 'y', 'w', 'h']
                            }
                        },
                        required: ['crop']
                    }
                }
            })
        });

        if (!response.ok) throw new Error('AI crop request failed');

        const result = await response.json();
    const parsed = parseGeminiJsonResult(result);
        const crop = parsed?.crop;

        if (!crop) return null;

        return {
            x: Math.max(0, Math.min(100, crop.x)),
            y: Math.max(0, Math.min(100, crop.y)),
            w: Math.max(1, Math.min(100, crop.w)),
            h: Math.max(1, Math.min(100, crop.h)),
            label: crop.label || 'Gemini crop'
        };
    } catch (err) {
        console.error(err);
        return null;
    }
}

async function refreshSceneCropsWithAi() {
    if (!appState.apiKey || appState.scenes.length === 0) return;

    showToast("AI Cropping", "Analyzing scene frames with Gemini Vision...", "warning");

    for (const scene of appState.scenes) {
        const crop = await generateAiCropSuggestionForScene(scene);
        if (crop) {
            scene.crop = { x: crop.x, y: crop.y, w: crop.w, h: crop.h };
            scene.panelSuggestion = crop.label ? `${scene.panelSuggestion} | AI: ${crop.label}` : scene.panelSuggestion;
        }
    }
}

// Toggle Api Key configuration display
function toggleApiSettings() {
    const dropdown = document.getElementById('api-dropdown');
    dropdown.classList.toggle('hidden');
}

function saveApiKey() {
    const key = document.getElementById('gemini-api-key').value.trim();
    appState.apiKey = key;
    localStorage.setItem('gemini_api_key', key);
    toggleApiSettings();

    const indicator = document.getElementById('api-indicator');
    if (key) {
        indicator.className = "w-2 h-2 rounded-full bg-green-500";
        showToast("API Key Stored", "Your Gemini developer Key has been successfully saved in state.", "success");
    } else {
        indicator.className = "w-2 h-2 rounded-full bg-red-500";
        showToast("API Key Cleared", "The environment will fall back to local device voice synthesis and manual scripting.", "warning");
    }
}

// Generic Toast Notification
function showToast(title, message, type = 'success') {
    const toast = document.getElementById('toast');
    const iconContainer = document.getElementById('toast-icon-container');
    const titleEl = document.getElementById('toast-title');
    const msgEl = document.getElementById('toast-message');

    titleEl.textContent = title;
    msgEl.textContent = message;

    if (type === 'success') {
        iconContainer.className = "p-1 rounded-lg bg-green-500/20 text-green-400 border border-green-500/30";
        iconContainer.innerHTML = '<i data-lucide="check" class="w-4 h-4"></i>';
    } else if (type === 'warning') {
        iconContainer.className = "p-1 rounded-lg bg-yellow-500/20 text-yellow-400 border border-yellow-500/30";
        iconContainer.innerHTML = '<i data-lucide="alert-triangle" class="w-4 h-4"></i>';
    } else {
        iconContainer.className = "p-1 rounded-lg bg-red-500/20 text-red-400 border border-red-500/30";
        iconContainer.innerHTML = '<i data-lucide="x-circle" class="w-4 h-4"></i>';
    }
    lucide.createIcons();

    toast.classList.remove('translate-y-20', 'opacity-0');
    toast.classList.add('translate-y-0', 'opacity-100');

    setTimeout(() => {
        toast.classList.remove('translate-y-0', 'opacity-100');
        toast.classList.add('translate-y-20', 'opacity-0');
    }, 4000);
}

// Populate standard system Speech Voices
function populateSystemSpeechVoices() {
    if (!window.speechSynthesis) return;
    const voices = window.speechSynthesis.getVoices();
    const group = document.getElementById('local-voice-optgroup');
    group.innerHTML = '';

    voices.forEach(v => {
        if (v.lang.startsWith('en')) {
            const opt = document.createElement('option');
            opt.value = `local:${v.name}`;
            opt.textContent = `${v.name} (${v.lang})`;
            group.appendChild(opt);
        }
    });
}

// Handle uploaded file select
function handleFileSelect(event) {
    if (event.target.files.length) {
        processUploadedFiles(event.target.files);
        event.target.value = '';
    }
}

// Process various file types: Images, PDFs, and Zip/CBZs
async function processUploadedFiles(files) {
    showToast("Importing Files", `Scanning ${files.length} uploads...`, "warning");

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const extension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

        if (extension === '.pdf') {
            await parsePdfFile(file);
        } else if (extension === '.cbz' || extension === '.zip') {
            await parseCbzFile(file);
        } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
            await parseImageFile(file);
        } else {
            showToast("Unsupported Format", `Ignoring file ${file.name}`, "error");
        }
    }
    renderAssetList();
    syncScenesToMedia(false);
    if (appState.scenes.length > 0) {
        renderTimeline();
        renderScriptList();
        renderCropStudio();
    }
}

// Parse single direct images
function parseImageFile(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const asset = {
                id: 'img-' + Date.now() + Math.random().toString(36).substr(2, 5),
                name: file.name,
                fileType: 'image',
                pages: [e.target.result],
                pageCount: 1
            };
            appState.assets.push(asset);
            if (!appState.selectedAssetId) {
                selectAsset(asset.id, 0);
            }
            resolve();
        };
        reader.readAsDataURL(file);
    });
}

// Parse complex Comic Book CBZ files using JSZip
async function parseCbzFile(file) {
    try {
        const zip = new JSZip();
        const contents = await zip.loadAsync(file);
        const imagePromises = [];
        const filenames = Object.keys(contents.files).sort();

        for (const name of filenames) {
            const zipFile = contents.files[name];
            const extension = name.substring(name.lastIndexOf('.')).toLowerCase();
            if (!zipFile.dir && ['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
                const promise = zipFile.async('blob').then(blob => {
                    return new Promise((res) => {
                        const reader = new FileReader();
                        reader.onload = (ev) => res({ name, data: ev.target.result });
                        reader.readAsDataURL(blob);
                    });
                });
                imagePromises.push(promise);
            }
        }

        const resolvedImages = await Promise.all(imagePromises);
        // Sort pages alphabetically by zip internal structures
        resolvedImages.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true, sensitivity: 'base'}));

        if (resolvedImages.length === 0) {
            showToast("Empty CBZ File", "No direct image files detected in CBZ package.", "error");
            return;
        }

        const asset = {
            id: 'cbz-' + Date.now(),
            name: file.name,
            fileType: 'cbz',
            pages: resolvedImages.map(item => item.data),
            pageCount: resolvedImages.length
        };

        appState.assets.push(asset);
        if (!appState.selectedAssetId) {
            selectAsset(asset.id, 0);
        }
        showToast("CBZ Decompressed", `Extracted ${asset.pageCount} manhwa panels successfully.`, "success");
    } catch (err) {
        console.error(err);
        showToast("Extraction Failed", "Unable to parse CBZ structure", "error");
    }
}

// Render PDF pages on high-quality offscreen canvases
async function parsePdfFile(file) {
    try {
        const fileReader = new FileReader();
        const arrayBuffer = await new Promise((resolve) => {
            fileReader.onload = (e) => resolve(e.target.result);
            fileReader.readAsArrayBuffer(file);
        });

        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const pages = [];

        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: 1.5 });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.height = viewport.height;
            canvas.width = viewport.width;

            await page.render({ canvasContext: context, viewport: viewport }).promise;
            pages.push(canvas.toDataURL('image/jpeg', 0.8));
        }

        const asset = {
            id: 'pdf-' + Date.now(),
            name: file.name,
            fileType: 'pdf',
            pages: pages,
            pageCount: pdf.numPages
        };

        appState.assets.push(asset);
        if (!appState.selectedAssetId) {
            selectAsset(asset.id, 0);
        }
        showToast("PDF Render Complete", `Imported ${pdf.numPages} document pages into studio.`, "success");
    } catch (err) {
        console.error(err);
        showToast("PDF Rendering Failed", "Error rendering pages", "error");
    }
}

// Render Loaded Manhwa Asset List View
function renderAssetList() {
    const container = document.getElementById('asset-list-container');
    container.innerHTML = '';

    if (appState.assets.length === 0) {
        container.innerHTML = `
            <div class="text-center py-8 text-slate-500 text-xs">
                <i data-lucide="layers" class="w-10 h-10 mx-auto mb-2 text-studio-700"></i>
                No assets imported yet.
            </div>`;
        lucide.createIcons();
        return;
    }

    appState.assets.forEach(asset => {
        const item = document.createElement('div');
        item.className = "bg-studio-800/80 border border-studio-700/60 rounded-xl p-3 space-y-2";

        let iconName = 'image';
        if (asset.fileType === 'pdf') iconName = 'file-text';
        if (asset.fileType === 'cbz') iconName = 'book-open';

        item.innerHTML = `
            <div class="flex items-center justify-between">
                <div class="flex items-center space-x-2 truncate">
                    <i data-lucide="${iconName}" class="w-4 h-4 text-indigo-400 shrink-0"></i>
                    <span class="text-xs font-semibold text-slate-200 truncate" title="${asset.name}">${asset.name}</span>
                </div>
                <button onclick="removeAsset('${asset.id}')" class="text-slate-500 hover:text-red-400 p-0.5 rounded transition">
                    <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                </button>
            </div>
            <div class="text-[10px] text-slate-400 font-medium">${asset.pageCount} pages detected</div>
            <div class="grid grid-cols-4 gap-1.5 max-h-36 overflow-y-auto pt-1 pr-1">
                ${asset.pages.map((page, idx) => {
                    const isSelected = appState.selectedAssetId === asset.id && appState.selectedPageIndex === idx;
                    return `
                        <div onclick="selectAsset('${asset.id}', ${idx})" class="relative aspect-[3/4] bg-studio-950 rounded border ${isSelected ? 'border-indigo-500 ring-2 ring-indigo-600/30' : 'border-studio-700 hover:border-slate-500'} cursor-pointer overflow-hidden group transition">
                            <img src="${page}" class="w-full h-full object-cover">
                            <div class="absolute bottom-0 inset-x-0 bg-black/75 text-[8px] text-center text-slate-300 py-0.5 font-bold opacity-70 group-hover:opacity-100">${idx+1}</div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
        container.appendChild(item);
    });
    lucide.createIcons();
}

// Delete page asset
function removeAsset(id) {
    appState.assets = appState.assets.filter(a => a.id !== id);
    if (appState.selectedAssetId === id) {
        appState.selectedAssetId = null;
        appState.selectedPageIndex = 0;
    }
    renderAssetList();
    renderCropStudio();
}

// Load specific asset page into active cropping board
function selectAsset(id, pageIndex) {
    appState.selectedAssetId = id;
    appState.selectedPageIndex = pageIndex;

    // Re-render visual list highlight active item
    renderAssetList();

    // Re-render editor board
    renderCropStudio();

    // Automatically run panel auto-detection on selected page
    setTimeout(() => {
        runAutoPanelDetection();
    }, 100);
}

// Switch panel tabs view
function switchView(view) {
    const btnCrop = document.getElementById('tab-btn-crop');
    const btnPlayer = document.getElementById('tab-btn-player');
    const viewCrop = document.getElementById('view-crop');
    const viewPlayer = document.getElementById('view-player');

    if (view === 'crop') {
        btnCrop.className = "px-3 py-1.5 text-xs font-medium rounded-md transition bg-indigo-600 text-white shadow-md";
        btnPlayer.className = "px-3 py-1.5 text-xs font-medium rounded-md transition text-slate-400 hover:text-white";
        viewCrop.classList.remove('hidden');
        viewPlayer.classList.add('hidden');
        document.getElementById('panel-detector-controls').style.display = 'flex';
        // Sync latest scene changes to canvas
        renderCropStudio();
    } else {
        btnCrop.className = "px-3 py-1.5 text-xs font-medium rounded-md transition text-slate-400 hover:text-white";
        btnPlayer.className = "px-3 py-1.5 text-xs font-medium rounded-md transition bg-indigo-600 text-white shadow-md";
        viewCrop.classList.add('hidden');
        viewPlayer.classList.remove('hidden');
        document.getElementById('panel-detector-controls').style.display = 'none';
        initPlayerPlayback();
    }
}

// ----------------- AUTO-PANEL AUTOMATED CROPPING ENGINE -----------------
// Highly-efficient Gutter-Detection visual algorithm to split manhwa panels
async function runAutoPanelDetection() {
    const asset = appState.assets.find(a => a.id === appState.selectedAssetId);
    if (!asset) return;

    const pageUrl = asset.pages[appState.selectedPageIndex];
    const sensitivity = parseInt(document.getElementById('detector-sensitivity').value);
    document.getElementById('sensitivity-val').textContent = `${sensitivity}%`;

    const activeScene = appState.scenes.find(s => s.id === appState.selectedSceneId);
    if (appState.apiKey && activeScene) {
        const aiCrop = await generateAiCropSuggestionForScene(activeScene);
        if (aiCrop) {
            appState.detectedPanels = [
                {
                    x: aiCrop.x,
                    y: aiCrop.y,
                    w: aiCrop.w,
                    h: aiCrop.h
                }
            ];
            renderCropStudio();
            return;
        }
    }

    const img = new Image();
    img.src = pageUrl;
    img.onload = function() {
        // Setup scaled calculation canvas
        const detectCanvas = document.createElement('canvas');
        const ctx = detectCanvas.getContext('2d');

        // Keep dimensions scaled down for speedier image scanline scanning
        const scale = 400 / img.width;
        detectCanvas.width = 400;
        detectCanvas.height = img.height * scale;
        ctx.drawImage(img, 0, 0, detectCanvas.width, detectCanvas.height);

        const imgData = ctx.getImageData(0, 0, detectCanvas.width, detectCanvas.height);
        const pixels = imgData.data;
        const width = detectCanvas.width;
        const height = detectCanvas.height;

        // Thresholds configured from sensitivity slider
        const colorThreshold = 255 - (sensitivity * 2.2); // Sensitivity to white background gutters

        // Step 1: Analyze horizontal row profile vectors
        const isBackgroundRow = new Array(height);
        for (let y = 0; y < height; y++) {
            let totalLuminosity = 0;
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const r = pixels[idx];
                const g = pixels[idx + 1];
                const b = pixels[idx + 2];
                const luma = 0.299 * r + 0.587 * g + 0.114 * b;
                totalLuminosity += luma;
            }
            const avgLuma = totalLuminosity / width;
            // Usually backgrounds are white (>240) or pure black (<15) in manhwas
            isBackgroundRow[y] = (avgLuma > colorThreshold || avgLuma < (255 - colorThreshold));
        }

        // Step 2: Form solid vertical segments (panels block ranges)
        const panelYRanges = [];
        let inPanel = false;
        let startY = 0;

        for (let y = 0; y < height; y++) {
            if (!isBackgroundRow[y] && !inPanel) {
                inPanel = true;
                startY = y;
            } else if (isBackgroundRow[y] && inPanel) {
                inPanel = false;
                if (y - startY > 15) { // Minimum height of a real panel on canvas scale
                    panelYRanges.push({ startY: startY, endY: y });
                }
            }
        }
        if (inPanel && (height - startY > 15)) {
            panelYRanges.push({ startY: startY, endY: height });
        }

        // Step 3: Normalize back to percentages and store
        appState.detectedPanels = panelYRanges.map(range => {
            const topPct = (range.startY / height) * 100;
            const botPct = (range.endY / height) * 100;
            const heightPct = botPct - topPct;

            return {
                x: 0,
                y: topPct,
                w: 100,
                h: heightPct
            };
        });

        // Render bounding overlay boxes into Crop Interaction Layer
        renderCropStudio();
    };
}

// Render Canvas overlay box representation
function renderCropStudio() {
    const canvas = document.getElementById('crop-canvas');
    const ctx = canvas.getContext('2d');
    const emptyState = document.getElementById('crop-empty-state');
    const overlayContainer = document.getElementById('crop-interaction-overlay');
    overlayContainer.innerHTML = '';

    const asset = appState.assets.find(a => a.id === appState.selectedAssetId);
    if (!asset) {
        emptyState.classList.remove('hidden');
        return;
    }
    emptyState.classList.add('hidden');

    const pageUrl = asset.pages[appState.selectedPageIndex];
    const img = new Image();
    img.src = pageUrl;
    img.onload = function() {
        // Adjust workspace dimension sizes relative to viewing bounds
        const parent = canvas.parentElement;
        const parentW = parent.clientWidth - 32;
        const parentH = parent.clientHeight - 32;

        const ratio = img.width / img.height;
        let drawW = parentW;
        let drawH = parentW / ratio;

        if (drawH > parentH) {
            drawH = parentH;
            drawW = parentH * ratio;
        }

        canvas.width = drawW;
        canvas.height = drawH;

        // Render pure underlying page
        ctx.drawImage(img, 0, 0, drawW, drawH);

        // Overlay the user-defined crop zone box in yellow
        let sceneCrop = null;
        if (appState.selectedSceneId) {
            const activeScene = appState.scenes.find(s => s.id === appState.selectedSceneId);
            if (activeScene && activeScene.crop) {
                sceneCrop = activeScene.crop;
            }
        }

        if (sceneCrop) {
            const x = (sceneCrop.x / 100) * drawW;
            const y = (sceneCrop.y / 100) * drawH;
            const w = (sceneCrop.w / 100) * drawW;
            const h = (sceneCrop.h / 100) * drawH;

            // Draw a visual dim cover on outer boundary areas
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(0, 0, drawW, y); // Top dim
            ctx.fillRect(0, y + h, drawW, drawH - (y + h)); // Bottom dim
            ctx.fillRect(0, y, x, h); // Left dim
            ctx.fillRect(x + w, y, drawW - (x + w), h); // Right dim

            // Target crop focus frame outline
            ctx.strokeStyle = '#f59e0b';
            ctx.lineWidth = 3.5;
            ctx.setLineDash([]);
            ctx.strokeRect(x, y, w, h);

            // Tiny anchor corners representation
            ctx.fillStyle = '#f59e0b';
            ctx.fillRect(x - 4, y - 4, 8, 8);
            ctx.fillRect(x + w - 4, y - 4, 8, 8);
            ctx.fillRect(x - 4, y + h - 4, 8, 8);
            ctx.fillRect(x + w - 4, y + h - 4, 8, 8);
        }

        // Render the interactive overlay click-to-fit auto-panels
        const overlayW = overlayContainer.clientWidth;
        const overlayH = overlayContainer.clientHeight;

        // Map the active canvas rendering absolute offset inside the container overlay wrapper
        const canvasOffsetLeft = (overlayW - drawW) / 2;
        const canvasOffsetTop = (overlayH - drawH) / 2;

        appState.detectedPanels.forEach((panel, index) => {
            const el = document.createElement('div');
            el.className = "absolute border border-dashed border-green-500 hover:border-solid hover:border-2 hover:bg-green-500/10 cursor-pointer group transition duration-150";

            // Direct layout pixel settings
            el.style.left = `${canvasOffsetLeft + (panel.x / 100) * drawW}px`;
            el.style.top = `${canvasOffsetTop + (panel.y / 100) * drawH}px`;
            el.style.width = `${(panel.w / 100) * drawW}px`;
            el.style.height = `${(panel.h / 100) * drawH}px`;

            el.innerHTML = `
                <div class="absolute top-1.5 left-1.5 bg-green-500 text-slate-900 font-extrabold text-[9px] px-1 py-0.5 rounded opacity-0 group-hover:opacity-100 transition shadow">
                    Panel ${index + 1} - Fit & Crop
                </div>
            `;

            el.onclick = () => {
                applyAutoDetectToCrop(panel);
            };

            overlayContainer.appendChild(el);
        });
    };
}

// Click detection to crop transition
function applyAutoDetectToCrop(panelBounds) {
    if (!appState.selectedSceneId) {
        showToast("No Scene Selected", "Create or select a script timeline scene on the right to apply this panel.", "warning");
        return;
    }

    const activeScene = appState.scenes.find(s => s.id === appState.selectedSceneId);
    if (activeScene) {
        activeScene.crop = {
            x: panelBounds.x,
            y: panelBounds.y,
            w: panelBounds.w,
            h: panelBounds.h
        };
        activeScene.assetId = appState.selectedAssetId;
        activeScene.pageIndex = appState.selectedPageIndex;

        showToast("Perfect Auto-Crop Applied", `Fitted to Panel boundaries (H: ${Math.round(panelBounds.h)}%)`, "success");
        renderCropStudio();
        renderTimeline();
        renderScriptList();
    }
}

// Canvas Cropper Drag & Swipe Manual Setup
function setupCropCanvasListeners() {
    const overlay = document.getElementById('crop-interaction-overlay');

    overlay.addEventListener('mousedown', (e) => {
        // Ignore if clicked on a panel overlay item
        if (e.target !== overlay) return;

        const canvas = document.getElementById('crop-canvas');
        const overlayRect = overlay.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();

        // Compute click position relative to canvas itself
        const clickX = e.clientX - canvasRect.left;
        const clickY = e.clientY - canvasRect.top;

        if (clickX >= 0 && clickX <= canvasRect.width && clickY >= 0 && clickY <= canvasRect.height) {
            cropState.isDragging = true;
            cropState.startX = (clickX / canvasRect.width) * 100;
            cropState.startY = (clickY / canvasRect.height) * 100;
            cropState.currentX = cropState.startX;
            cropState.currentY = cropState.startY;
        }
    });

    overlay.addEventListener('mousemove', (e) => {
        if (!cropState.isDragging) return;

        const canvas = document.getElementById('crop-canvas');
        const canvasRect = canvas.getBoundingClientRect();

        const mouseX = e.clientX - canvasRect.left;
        const mouseY = e.clientY - canvasRect.top;

        // Restrict boundary clamp within active image frame limits
        const clampX = Math.max(0, Math.min(100, (mouseX / canvasRect.width) * 100));
        const clampY = Math.max(0, Math.min(100, (mouseY / canvasRect.height) * 100));

        cropState.currentX = clampX;
        cropState.currentY = clampY;

        // Temporarily store selection parameters directly into state object
        const x_min = Math.min(cropState.startX, cropState.currentX);
        const y_min = Math.min(cropState.startY, cropState.currentY);
        const width = Math.abs(cropState.startX - cropState.currentX);
        const height = Math.abs(cropState.startY - cropState.currentY);

        if (appState.selectedSceneId) {
            const activeScene = appState.scenes.find(s => s.id === appState.selectedSceneId);
            if (activeScene) {
                activeScene.crop = { x: x_min, y: y_min, w: width, h: height };
                activeScene.assetId = appState.selectedAssetId;
                activeScene.pageIndex = appState.selectedPageIndex;

                // Perform live updates
                const canvas = document.getElementById('crop-canvas');
                const ctx = canvas.getContext('2d');
                renderCropStudio();
            }
        }
    });

    window.addEventListener('mouseup', () => {
        if (cropState.isDragging) {
            cropState.isDragging = false;
            renderTimeline();
            renderScriptList();
        }
    });
}

function resetCrop() {
    if (appState.selectedSceneId) {
        const activeScene = appState.scenes.find(s => s.id === appState.selectedSceneId);
        if (activeScene) {
            activeScene.crop = { x: 0, y: 0, w: 100, h: 100 };
            renderCropStudio();
            renderTimeline();
            renderScriptList();
            showToast("Crop Reset", "Box reset to view full layout canvas scale.", "warning");
        }
    }
}

function applyCropToSelectedScene() {
    if (appState.selectedSceneId) {
        showToast("Crop Saved", "Scene bounding frame updated on timeline.", "success");
    } else {
        showToast("Select a Scene Clip", "Add a narration segment from script area first.", "error");
    }
}


// ----------------- RECAP TIMELINE & SCRIPT MANAGEMENT -----------------

function addScene(text = "Enter voiceover narration here...", duration = 5, customFields = {}) {
    const id = 'scene-' + Date.now() + Math.random().toString(36).substr(2, 4);

    // Calculate start time relative to existing timeline segments
    let startTime = 0;
    if (appState.scenes.length > 0) {
        const last = appState.scenes[appState.scenes.length - 1];
        startTime = last.startTime + last.duration;
    }

    const mediaSequence = getMediaSequence();
    const media = mediaSequence[appState.scenes.length] || null;

    const newScene = {
        id: id,
        text: text,
        duration: duration,
        startTime: startTime,
        assetId: customFields.assetId || media?.assetId || appState.selectedAssetId || (appState.assets[0]?.id || null),
        pageIndex: customFields.pageIndex ?? media?.pageIndex ?? appState.selectedPageIndex ?? 0,
        crop: customFields.crop || { x: 10, y: 15, w: 80, h: 50 },
        panelSuggestion: customFields.panelSuggestion || "A close-up view showing the characters action detail.",
        audioUrl: null,
        status: 'pending',
        animationStyle: customFields.animationStyle || null,
        backgroundMode: customFields.backgroundMode || null,
        backgroundColor: customFields.backgroundColor || null
    };

    appState.scenes.push(newScene);
    appState.selectedSceneId = id;

    renderScriptList();
    renderTimeline();
    updateTimelineTrackTimeDisplay();

    // Highlight asset page matches
    if (newScene.assetId) {
        selectAsset(newScene.assetId, newScene.pageIndex);
    }

    syncScenesToMedia(false);
}

// Delete visual segment from tracks
function removeScene(id, event) {
    if (event) event.stopPropagation();
    appState.scenes = appState.scenes.filter(s => s.id !== id);

    // Re-order starts & times sequential boundaries
    recalculateTimelineDurations();

    if (appState.selectedSceneId === id) {
        appState.selectedSceneId = appState.scenes[0]?.id || null;
    }

    renderScriptList();
    renderTimeline();
    updateTimelineTrackTimeDisplay();
}

function recalculateTimelineDurations() {
    let tracker = 0;
    appState.scenes.forEach(scene => {
        scene.startTime = tracker;
        tracker += scene.duration;
    });
}

// Draw Interactive Visual Timeline Strip representation
function renderTimeline() {
    const track = document.getElementById('timeline-track-container');
    const emptyMsg = document.getElementById('timeline-empty-message');

    // Clear prior dynamic layouts
    const previousCards = track.querySelectorAll('.scene-timeline-card');
    previousCards.forEach(c => c.remove());

    document.getElementById('timeline-scene-count').textContent = `${appState.scenes.length} Clips`;

    if (appState.scenes.length === 0) {
        emptyMsg.classList.remove('hidden');
        return;
    }
    emptyMsg.classList.add('hidden');

    appState.scenes.forEach((scene, index) => {
        const card = document.createElement('div');
        card.className = `scene-timeline-card flex-shrink-0 w-44 bg-studio-900 border ${appState.selectedSceneId === scene.id ? 'border-indigo-500 ring-2 ring-indigo-500/20' : 'border-studio-800 hover:border-studio-700'} rounded-xl p-2 cursor-pointer flex flex-col justify-between transition group`;
        card.onclick = () => selectScene(scene.id);

        // Try pulling thumbnail representation from crop metrics
        const asset = appState.assets.find(a => a.id === scene.assetId);
        const thumbnailPage = asset ? asset.pages[scene.pageIndex] : null;

        let startMin = Math.floor(scene.startTime / 60).toString().padStart(2, '0');
        let startSec = Math.floor(scene.startTime % 60).toString().padStart(2, '0');

        card.innerHTML = `
            <div class="space-y-1.5 flex-1 flex flex-col justify-between">
                <!-- Heading Metadata -->
                <div class="flex items-center justify-between text-[10px] font-bold text-slate-400">
                    <span>Clip #${index + 1}</span>
                    <span class="font-mono bg-studio-950 px-1.5 py-0.5 rounded border border-studio-800">${startMin}:${startSec}</span>
                </div>

                <!-- Visual thumbnail representing auto-crop frame -->
                <div class="relative aspect-video rounded-lg bg-studio-950 overflow-hidden border border-studio-800">
                    ${thumbnailPage ? `
                        <div class="absolute inset-0" style="background: url('${thumbnailPage}') no-repeat; background-size: ${100 / (scene.crop.w / 100)}% ${100 / (scene.crop.h / 100)}%; background-position: ${scene.crop.x}% ${scene.crop.y}%;"></div>
                    ` : `
                        <div class="w-full h-full flex flex-col items-center justify-center text-[9px] text-slate-600">
                            <i data-lucide="image-off" class="w-4 h-4 mb-0.5"></i>
                            No Image
                        </div>
                    `}
                </div>

                <!-- Subtitle text -->
                <p class="text-[10px] text-slate-300 font-medium truncate py-1">${scene.text}</p>
            </div>

            <!-- Actions Strip bottom -->
            <div class="flex items-center justify-between pt-1 border-t border-studio-800 text-[10px]">
                <div class="flex items-center space-x-1">
                    <i data-lucide="clock" class="w-3 h-3 text-slate-500"></i>
                    <input type="number" step="1" min="1" max="120" value="${scene.duration}" 
                        onchange="updateSceneDuration('${scene.id}', this.value)"
                        onclick="event.stopPropagation()"
                        class="w-8 bg-studio-950 border border-studio-800 rounded px-1 text-center text-slate-200 font-mono focus:outline-none focus:border-indigo-500">
                    <span class="text-slate-500">s</span>
                </div>
                <button onclick="removeScene('${scene.id}', event)" class="p-1 hover:bg-studio-800 rounded text-slate-500 hover:text-red-400 transition">
                    <i data-lucide="trash" class="w-3 h-3"></i>
                </button>
            </div>
        `;
        track.appendChild(card);
    });
    lucide.createIcons();
}

// Direct selection adjustments
function selectScene(id) {
    appState.selectedSceneId = id;
    renderTimeline();
    renderScriptList();

    const scene = appState.scenes.find(s => s.id === id);
    if (scene && scene.assetId) {
        selectAsset(scene.assetId, scene.pageIndex);
    }
}

function updateSceneDuration(id, value) {
    const num = Math.max(1, parseInt(value) || 5);
    const scene = appState.scenes.find(s => s.id === id);
    if (scene) {
        scene.duration = num;
        recalculateTimelineDurations();
        renderTimeline();
        renderScriptList();
        updateTimelineTrackTimeDisplay();
    }
}

// Render Sidebar Edit Script card list
function renderScriptList() {
    const container = document.getElementById('script-list-container');
    container.innerHTML = '';

    if (appState.scenes.length === 0) {
        container.innerHTML = `
            <div class="text-center py-12 text-slate-500 text-xs">
                <i data-lucide="clipboard-signature" class="w-12 h-12 mx-auto mb-2 text-studio-800"></i>
                Your script workspace is empty.<br>Click "AI Generate Recap Script" above.
            </div>`;
        lucide.createIcons();
        updateTimelineTrackTimeDisplay();
        return;
    }

    appState.scenes.forEach((scene, index) => {
        const card = document.createElement('div');
        const isActive = appState.selectedSceneId === scene.id;

        card.className = `p-3.5 rounded-xl border transition duration-150 ${isActive ? 'bg-studio-800/90 border-indigo-600/80 shadow-lg ring-1 ring-indigo-500/20' : 'bg-studio-900/40 border-studio-800 hover:border-studio-700'}`;
        card.onclick = () => selectScene(scene.id);

        card.innerHTML = `
            <div class="space-y-2">
                <div class="flex items-center justify-between text-[10px] font-bold text-slate-400">
                    <span class="flex items-center space-x-1">
                        <span class="bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 px-1.5 py-0.5 rounded">Scene ${index + 1}</span>
                        <span class="text-[9px] text-slate-500">Duration: ${scene.duration}s</span>
                    </span>
                    <div class="flex items-center space-x-2">
                        <button onclick="generateSingleTts('${scene.id}', event)" class="p-1 hover:bg-studio-800 rounded text-indigo-400 flex items-center space-x-1" title="Synthesize Voice Clip">
                            <i data-lucide="${scene.status === 'ready' ? 'volume-check' : 'volume-2'}" class="w-3.5 h-3.5"></i>
                            <span class="text-[8px] font-medium font-sans">${scene.status === 'ready' ? 'Ready' : 'Synthesize'}</span>
                        </button>
                        <button onclick="removeScene('${scene.id}', event)" class="text-slate-500 hover:text-red-400 p-1 rounded transition">
                            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                        </button>
                    </div>
                </div>

                <textarea rows="3" onchange="updateSceneText('${scene.id}', this.value)" onclick="event.stopPropagation()"
                    class="w-full bg-studio-950 border border-studio-800 text-xs text-slate-200 rounded-lg p-2.5 focus:outline-none focus:border-indigo-500 leading-relaxed font-medium"
                    placeholder="Write voiceover script segment here...">${scene.text}</textarea>

                <!-- Visual Panel Recommendation / Helper details -->
                <div class="text-[10px] bg-studio-950/40 border border-studio-800 p-2 rounded-lg flex items-start space-x-1.5">
                    <i data-lucide="sparkles" class="w-3.5 h-3.5 text-indigo-400 shrink-0 mt-0.5"></i>
                    <div class="w-full space-y-1">
                        <p class="text-slate-400 leading-relaxed italic"><strong>Visual suggestion:</strong> ${scene.panelSuggestion}</p>
                        <div class="flex items-center justify-between gap-2 text-[9px] text-slate-500">
                            <span>Motion: ${scene.animationStyle || 'zoom'}</span>
                            <span>BG: ${scene.backgroundMode || 'solid'}</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
    lucide.createIcons();
    updateTimelineTrackTimeDisplay();
}

function updateSceneText(id, value) {
    const scene = appState.scenes.find(s => s.id === id);
    if (scene) {
        scene.text = value.trim();
        scene.status = 'pending'; // Invalidate voice cache since text altered
        renderTimeline();
        updateTimelineTrackTimeDisplay();
    }
}

// Live stats update
function updateTimelineTrackTimeDisplay() {
    let totalWords = 0;
    let totalDuration = 0;

    appState.scenes.forEach(s => {
        totalWords += s.text.split(/\s+/).filter(Boolean).length;
        totalDuration += s.duration;
    });

    document.getElementById('script-stats-text').textContent = `Total script: ${totalWords} words | ${totalDuration}s`;

    // Sync timings to the preview engine
    const durationMin = Math.floor(totalDuration / 60).toString().padStart(2, '0');
    const durationSec = Math.floor(totalDuration % 60).toString().padStart(2, '0');
    document.getElementById('player-time-display').textContent = `00:00 / ${durationMin}:${durationSec}`;
}


// ----------------- CINEMATIC PREVIEW LIVE PLAYER ENGINE -----------------
let playerState = {
    startTime: 0,
    animationId: null,
    canvas: null,
    ctx: null
};

function initPlayerCanvas() {
    playerState.canvas = document.getElementById('player-canvas');
    playerState.ctx = playerState.canvas.getContext('2d');

    // Default 16:9 aspect frames settings
    playerState.canvas.width = 1280;
    playerState.canvas.height = 720;

    drawPlayerDefaultPlaceholder();
}

function drawPlayerDefaultPlaceholder() {
    const ctx = playerState.ctx;
    const w = playerState.canvas.width;
    const h = playerState.canvas.height;

    ctx.fillStyle = '#0b0d11';
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#1f242b';
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, 60, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#cbd1d6';
    ctx.beginPath();
    ctx.moveTo(w / 2 - 12, h / 2 - 20);
    ctx.lineTo(w / 2 - 12, h / 2 + 20);
    ctx.lineTo(w / 2 + 18, h / 2);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#9ba4ae';
    ctx.font = '24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Interactive Cinematic Studio', w / 2, h / 2 + 110);
    ctx.font = '14px sans-serif';
    ctx.fillText('Press play to synthesize narration voice and animate manhwa crops', w / 2, h / 2 + 140);
}

function togglePlayerPlayback() {
    if (appState.isPlaying) {
        pausePlayer();
    } else {
        startPlayer();
    }
}

function startPlayer() {
    if (appState.scenes.length === 0) {
        showToast("No Scenes", "Create a recap script before starting player.", "error");
        return;
    }
    appState.isPlaying = true;
    document.getElementById('player-play-btn').innerHTML = '<i data-lucide="pause" class="w-5 h-5 fill-current"></i>';
    lucide.createIcons();

    playerState.startTime = performance.now() - (appState.playbackTime * 1000);
    animatePlayerLoop();
    showToast("Playing Recap Studio", "Simulating camera pan-and-zoom and text-to-speech audio segments.", "success");
}

function pausePlayer() {
    appState.isPlaying = false;
    document.getElementById('player-play-btn').innerHTML = '<i data-lucide="play" class="w-5 h-5 fill-current"></i>';
    lucide.createIcons();

    if (playerState.animationId) {
        cancelAnimationFrame(playerState.animationId);
    }
    // Stop any playing voices
    if (window.speechSynthesis) {
        window.speechSynthesis.cancel();
    }
}

function initPlayerPlayback() {
    appState.playbackTime = 0;
    document.getElementById('player-progress-fill').style.width = '0%';
    drawPlayerDefaultPlaceholder();
}

// Loop engine tracking frame iterations
function animatePlayerLoop() {
    if (!appState.isPlaying) return;

    const totalDuration = appState.scenes.reduce((sum, s) => sum + s.duration, 0);
    if (totalDuration === 0) return;

    const elapsedSeconds = (performance.now() - playerState.startTime) / 1000;
    appState.playbackTime = elapsedSeconds;

    if (appState.playbackTime >= totalDuration) {
        appState.playbackTime = totalDuration;
        pausePlayer();
        initPlayerPlayback();
        return;
    }

    // Scrub Fill bar updating
    const progressPct = (appState.playbackTime / totalDuration) * 100;
    document.getElementById('player-progress-fill').style.width = `${progressPct}%`;

    // Display formatting timings
    let currentMin = Math.floor(appState.playbackTime / 60).toString().padStart(2, '0');
    let currentSec = Math.floor(appState.playbackTime % 60).toString().padStart(2, '0');
    let durationMin = Math.floor(totalDuration / 60).toString().padStart(2, '0');
    let durationSec = Math.floor(totalDuration % 60).toString().padStart(2, '0');
    document.getElementById('player-time-display').textContent = `${currentMin}:${currentSec} / ${durationMin}:${durationSec}`;

    // Render current active frame to screen
    renderActivePlayerFrame();

    playerState.animationId = requestAnimationFrame(animatePlayerLoop);
}

function scrubPlayer(event) {
    const bar = document.getElementById('player-scrub-bar');
    const rect = bar.getBoundingClientRect();
    const clickPct = (event.clientX - rect.left) / rect.width;

    const totalDuration = appState.scenes.reduce((sum, s) => sum + s.duration, 0);
    if (totalDuration === 0) return;

    appState.playbackTime = clickPct * totalDuration;
    document.getElementById('player-progress-fill').style.width = `${clickPct * 100}%`;

    if (appState.isPlaying) {
        playerState.startTime = performance.now() - (appState.playbackTime * 1000);
    } else {
        renderActivePlayerFrame();
    }
}

// Render dynamic image zoom/pan camera movements on Canvas
function renderActivePlayerFrame() {
    const ctx = playerState.ctx;
    const w = playerState.canvas.width;
    const h = playerState.canvas.height;

    // Find current active scene for playbackTime
    let accumulatedTime = 0;
    let activeScene = null;
    let sceneIndex = -1;

    for (let i = 0; i < appState.scenes.length; i++) {
        const s = appState.scenes[i];
        if (appState.playbackTime >= s.startTime && appState.playbackTime < (s.startTime + s.duration)) {
            activeScene = s;
            sceneIndex = i;
            break;
        }
    }

    if (!activeScene) {
        // Default fallback drawing blank frames
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        document.getElementById('subtitle-box').classList.add('opacity-0');
        return;
    }

    // Draw underlying asset cropped page
    const asset = appState.assets.find(a => a.id === activeScene.assetId);
    if (!asset) {
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#fff';
        ctx.font = '20px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Clip lacks associated image assets', w / 2, h / 2);
        return;
    }

    const imgUrl = asset.pages[activeScene.pageIndex];
    const img = new Image();
    img.src = imgUrl;

    // Setup subtitle overlay
    const subtitle = document.getElementById('subtitle-box');
    subtitle.textContent = activeScene.text;
    subtitle.classList.remove('opacity-0');

    // Trigger real-time Speech trigger for current scene segment
    triggerSpeechSegment(activeScene);

    if (img.complete) {
        const crop = activeScene.crop;
        const cropX = (crop.x / 100) * img.width;
        const cropY = (crop.y / 100) * img.height;
        const cropW = (crop.w / 100) * img.width;
        const cropH = (crop.h / 100) * img.height;

        const backgroundMode = activeScene.backgroundMode || appState.backgroundMode || 'solid';
        const backgroundColor = activeScene.backgroundColor || appState.backgroundColor || '#0b0d11';

        if (backgroundMode === 'blur') {
            ctx.save();
            ctx.filter = 'blur(28px) brightness(0.72) saturate(1.08)';
            ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, w, h);
            ctx.restore();
        } else {
            ctx.fillStyle = backgroundColor;
            ctx.fillRect(0, 0, w, h);
        }

        ctx.fillStyle = 'rgba(0, 0, 0, 0.14)';
        ctx.fillRect(0, 0, w, h);

        // Calculate camera animation progress inside active scene (0.0 to 1.0)
        const sceneProgress = (appState.playbackTime - activeScene.startTime) / activeScene.duration;

        // Select and apply zoom/pan kinetics
        const motionStyle = activeScene.animationStyle || document.getElementById('player-motion-style').value;
        let animatedCropX = cropX;
        let animatedCropY = cropY;
        let animatedCropW = cropW;
        let animatedCropH = cropH;

        if (motionStyle === 'subtle-zoom') {
            // Start zoomed in slightly, slowly pull back outwards (or vice versa)
            const zoomFactor = 1.05 - (sceneProgress * 0.05); // Zoom from 1.05x to 1.0x
            animatedCropW = cropW * zoomFactor;
            animatedCropH = cropH * zoomFactor;
            // Keep center aligned
            animatedCropX = cropX + (cropW - animatedCropW) / 2;
            animatedCropY = cropY + (cropH - animatedCropH) / 2;
        } else if (motionStyle === 'slide-down') {
            const slideOffset = -18 + (sceneProgress * 18);
            ctx.save();
            ctx.translate(0, slideOffset);
            ctx.drawImage(img, animatedCropX, animatedCropY, animatedCropW, animatedCropH, 0, 0, w, h);
            ctx.restore();
            return;
        } else if (motionStyle === 'slide-up') {
            const slideOffset = 18 - (sceneProgress * 18);
            ctx.save();
            ctx.translate(0, slideOffset);
            ctx.drawImage(img, animatedCropX, animatedCropY, animatedCropW, animatedCropH, 0, 0, w, h);
            ctx.restore();
            return;
        } else if (motionStyle === 'pan-down') {
            // Pan down slightly over time
            const maxPan = cropH * 0.1; // 10% height shift
            animatedCropY = cropY + (sceneProgress * maxPan);
        } else if (motionStyle === 'pan-up') {
            // Pan up slightly over time
            const maxPan = cropH * 0.1;
            animatedCropY = cropY + ((1 - sceneProgress) * maxPan);
        }

        // Protect boundaries clamp matching original canvas size aspect outputs
        ctx.drawImage(
            img,
            animatedCropX, animatedCropY, animatedCropW, animatedCropH,
            0, 0, w, h
        );
    }
}

// Track triggered speech clips to prevent double triggers
let lastTriggeredSceneId = null;

function triggerSpeechSegment(scene) {
    if (lastTriggeredSceneId === scene.id) return;
    lastTriggeredSceneId = scene.id;

    const speed = parseFloat(document.getElementById('narrator-speed').value);
    const selectedVoiceValue = document.getElementById('narration-voice-select').value;

    // Trigger standard Speech synthesis logic
    if (window.speechSynthesis) {
        window.speechSynthesis.cancel(); // Terminate ongoing synthetic audios

        // If user uploaded customized audio clips
        if (scene.audioUrl) {
            const audio = new Audio(scene.audioUrl);
            audio.playbackRate = speed;
            audio.play().catch(e => console.warn("Failed to autoplay project TTS audio clip", e));
            return;
        }

        // If selected Local Synthesis Voice
        if (selectedVoiceValue.startsWith('local:')) {
            const voiceName = selectedVoiceValue.replace('local:', '');
            const utterance = new SpeechSynthesisUtterance(scene.text);
            const voices = window.speechSynthesis.getVoices();
            const matchedVoice = voices.find(v => v.name === voiceName);

            if (matchedVoice) utterance.voice = matchedVoice;
            utterance.rate = speed;
            window.speechSynthesis.speak(utterance);
        } else {
            // Gemini TTS Fallback alert or direct triggering if synthesized audio exists
            // We generate live local fallback directly if not generated ahead of time
            const utterance = new SpeechSynthesisUtterance(scene.text);
            utterance.rate = speed;
            window.speechSynthesis.speak(utterance);
        }
    }
}


// ----------------- GEMINI RECAP GENERATION & TTS ENGINE -----------------

function openAiPromptModal() {
    document.getElementById('ai-prompt-modal').classList.remove('hidden');
}

function closeAiPromptModal() {
    document.getElementById('ai-prompt-modal').classList.add('hidden');
}

// Generate entire script directly from user parameters
async function triggerAiScriptGeneration() {
    if (!appState.apiKey) {
        showToast("API Key Required", "Provide your Gemini API Key in the top navigation bar configuration panel.", "error");
        return;
    }

    const title = document.getElementById('ai-recap-title').value.trim();
    const summary = document.getElementById('ai-recap-prompt').value.trim();

    if (!title || !summary) {
        showToast("Missing Fields", "Please populate both title and plot summary description.", "warning");
        return;
    }

    showToast("Generating Script", "Asking Gemini to construct optimized timeline and panel details...", "warning");
    closeAiPromptModal();

    // Setup prompt
    const promptText = `
        You are a professional webtoon/manhwa recap scriptwriter for TikTok and YouTube video recaps.
        Create a high-energy, exciting, chronological recap script for the manhwa: "${title}".
        Plot details provided by user: "${summary}".

        You must return a structured JSON response containing an array of narration scene clips.
        Each scene must have:
        1. "text": Spoken narrative script text (highly engaging style, fast pacing).
        2. "duration": estimated reading length in seconds (usually between 4 to 8 seconds).
        3. "panelSuggestion": Specific detailed visual instructions describing what visual panel fits best (e.g. "Close up action shot showing the main character summoning shadows", "A panoramic view of the dark gate interior").
        4. "crop": Suggested normalized percentage bounding box configuration { "x": percentage, "y": percentage, "w": percentage, "h": percentage } representing safe defaults to slice panels.

        Example format:
        {
          "scenes": [
            {
              "text": "In a world where gates unleash deadly monsters, ordinary hunters are humanity's only line of defense.",
              "duration": 6,
              "panelSuggestion": "The open wide-shot panel showing a glowing blue dungeon gate.",
              "crop": { "x": 0, "y": 10, "w": 100, "h": 40 }
            }
          ]
        }
        Make sure you return VALID JSON matching this schema.
    `;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${appState.apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: promptText }] }],
                generationConfig: {
                    responseMimeType: "application/json",
                    responseSchema: {
                        type: "OBJECT",
                        properties: {
                            scenes: {
                                type: "ARRAY",
                                items: {
                                    type: "OBJECT",
                                    properties: {
                                        text: { type: "STRING" },
                                        duration: { type: "NUMBER" },
                                        panelSuggestion: { type: "STRING" },
                                        crop: {
                                            type: "OBJECT",
                                            properties: {
                                                x: { type: "NUMBER" },
                                                y: { type: "NUMBER" },
                                                w: { type: "NUMBER" },
                                                h: { type: "NUMBER" }
                                            },
                                            required: ["x", "y", "w", "h"]
                                        }
                                    },
                                    required: ["text", "duration", "panelSuggestion", "crop"]
                                }
                            }
                        },
                        required: ["scenes"]
                    }
                }
            })
        });

        if (!response.ok) throw new Error("API call failed check validity.");
        const result = await response.json();

        // Parse returned JSON structure
        const parsed = parseGeminiJsonResult(result);

        if (parsed.scenes && parsed.scenes.length > 0) {
            // Flush existing scenes and populate
            appState.scenes = [];
            parsed.scenes.forEach(s => {
                addScene(s.text, s.duration, { crop: s.crop, panelSuggestion: s.panelSuggestion });
            });

            syncScenesToMedia(true);
            await refreshSceneCropsWithAi();

            showToast("Script Loaded", `Gemini successfully generated ${appState.scenes.length} recap segments.`, "success");
            renderScriptList();
            renderTimeline();
        }

    } catch (err) {
        console.error(err);
        showToast("Generation Failed", "API returned invalid or broken structures. Check connection/key status.", "error");
    }
}

// Generate Gemini TTS narration audios for individual scenes
async function generateSingleTts(sceneId, event) {
    if (event) event.stopPropagation();
    if (!appState.apiKey) {
        showToast("Fallback Synthesis Active", "Using local device voices. Provide key for high-fidelity audio.", "warning");
        return;
    }

    const scene = appState.scenes.find(s => s.id === sceneId);
    if (!scene) return;

    const voice = document.getElementById('narration-voice-select').value;
    if (voice.startsWith('local:')) {
        showToast("Local Voice", "No TTS API request needed for local speech synthesizers.", "warning");
        return;
    }

    showToast("Generating Voiceover", "Synthesizing AI narrator audio with Gemini high-fidelity voice...", "warning");

    try {
        // Request structure for gemini-2.5-flash-preview-tts
        const prompt = `Say in a natural, cinematic storytelling tone: ${scene.text}`;
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${appState.apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: {
                    responseModalities: ["AUDIO"],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: voice }
                        }
                    }
                },
                model: "gemini-2.5-flash-preview-tts"
            })
        });

        if (!response.ok) throw new Error("TTS Generation failed.");
        const result = await response.json();
        const inlineData = result.candidates?.[0]?.content?.parts?.[0]?.inlineData;

        if (inlineData && inlineData.data) {
            const rawPcmBase64 = inlineData.data;
            // Format PCM16 data into WAV file structure directly in client space
            const sampleRate = parseInt(inlineData.mimeType.split('rate=')[1]) || 24000;
            const wavBlob = pcm16ToWavBlob(rawPcmBase64, sampleRate);

            scene.audioUrl = URL.createObjectURL(wavBlob);
            scene.status = 'ready';

            showToast("Audio Rendered", "High-fidelity narrator voice linked to segment timeline.", "success");
            renderScriptList();
            renderTimeline();
        }

    } catch (e) {
        console.error(e);
        showToast("TTS Render Failed", "Falling back to local speech synthetics.", "error");
    }
}

async function generateAllTts() {
    if (!appState.apiKey) {
        showToast("API Key Needed", "Connect your Gemini API Key first.", "error");
        return;
    }
    showToast("Bulk Render Started", `Synthesizing voices for ${appState.scenes.length} clips sequentially...`, "warning");
    for (const s of appState.scenes) {
        await generateSingleTts(s.id);
    }
}

// Helper: Convert RAW PCM16 binary data stream directly to WAV formatting
function pcm16ToWavBlob(base64Data, sampleRate) {
    const rawBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
    const buffer = new ArrayBuffer(44 + rawBytes.length);
    const view = new DataView(buffer);

    // "RIFF" chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + rawBytes.length, true);
    writeString(view, 8, 'WAVE');

    // "fmt " sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size
    view.setUint16(20, 1, true); // AudioFormat PCM
    view.setUint16(22, 1, true); // NumChannels Mono
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, sampleRate * 2, true); // ByteRate (sampleRate * numChannels * bitsPerSample/8)
    view.setUint16(32, 2, true); // BlockAlign (numChannels * bitsPerSample/8)
    view.setUint16(34, 16, true); // BitsPerSample 16-bit

    // "data" sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, rawBytes.length, true);

    // Write actual PCM frame body
    for (let i = 0; i < rawBytes.length; i++) {
        view.setUint8(44 + i, rawBytes[i]);
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}


// ----------------- IMPORT & EXPORT SUITE WORKFLOW -----------------

function exportProject() {
    if (appState.scenes.length === 0) {
        showToast("Nothing to Export", "Build a timeline/script before saving.", "warning");
        return;
    }

    // Package project state params (excluding raw binary assets to optimize size)
    const packageData = {
        appId: 'manhwa-recap-studio-pro',
        version: '2.0',
        scenes: appState.scenes.map(s => ({
            text: s.text,
            duration: s.duration,
            crop: s.crop,
            panelSuggestion: s.panelSuggestion,
            pageIndex: s.pageIndex,
            animationStyle: s.animationStyle,
            backgroundMode: s.backgroundMode,
            backgroundColor: s.backgroundColor
        })),
        motionStyle: document.getElementById('player-motion-style').value,
        voice: document.getElementById('narration-voice-select').value,
        speed: document.getElementById('narrator-speed').value,
        backgroundMode: document.getElementById('scene-bg-mode')?.value || appState.backgroundMode,
        backgroundColor: document.getElementById('scene-bg-color')?.value || appState.backgroundColor,
        animationPool: getEnabledAnimationStyles()
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(packageData, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", "manhwa_recap_project.json");
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();

    showToast("Project Exported", "Project setup JSON download started.", "success");
}

function importProject(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const parsed = JSON.parse(e.target.result);
            if (parsed.appId !== 'manhwa-recap-studio-pro') {
                throw new Error("Invalid project structure configuration files.");
            }

            // Map configurations
            document.getElementById('player-motion-style').value = parsed.motionStyle || 'subtle-zoom';
            document.getElementById('narration-voice-select').value = parsed.voice || 'Zephyr';
            document.getElementById('narrator-speed').value = parsed.speed || '1.0';
            if (document.getElementById('scene-bg-mode')) {
                document.getElementById('scene-bg-mode').value = parsed.backgroundMode || 'solid';
            }
            if (document.getElementById('scene-bg-color')) {
                document.getElementById('scene-bg-color').value = parsed.backgroundColor || '#0b0d11';
            }
            appState.backgroundMode = parsed.backgroundMode || 'solid';
            appState.backgroundColor = parsed.backgroundColor || '#0b0d11';

            appState.scenes = [];
            parsed.scenes.forEach(s => {
                addScene(s.text, s.duration, {
                    crop: s.crop,
                    panelSuggestion: s.panelSuggestion,
                    pageIndex: s.pageIndex,
                    animationStyle: s.animationStyle,
                    backgroundMode: s.backgroundMode,
                    backgroundColor: s.backgroundColor
                });
            });

            syncScenesToMedia(true);

            showToast("Project Restored", `Loaded ${appState.scenes.length} timelines into active state.`, "success");
            renderScriptList();
            renderTimeline();
        } catch (err) {
            showToast("Import Broken", "Unable to parse valid project JSON state.", "error");
        }
    };
    reader.readAsText(file);
}