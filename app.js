// app.js - Local SLM Chat using Transformers.js (ONNX Runtime Web WASM / CPU)
// Features:
// - Text-generation via @xenova/transformers using ONNX Runtime Web (WASM backend)
// - Custom base URL to fetch models from your own HTTP host (HF mirror/self-hosted)
// - Quantized toggle (tries 8-bit weights when available)
// - Experimental directory picker to help you confirm local files (still must be served via HTTP)
// - settings persisted in localStorage

let pipeline, env;
async function loadTransformers() {
  // Estrategia robusta y con sintaxis válida:
  // 1) Intentar import ESM desde CDN (+esm / esm.sh)
  // 2) Si falla, fetch + import desde Blob (evita ciertos problemas de CORS/headers)
  // 3) Intentar las mismas URLs a través del proxy local si está activo (npm run proxy)
  const cdnCandidates = [
    // JSPM: genera ESM con dependencias resueltas (evita "/npm/..." absolutos)
    'https://jspm.dev/@xenova/transformers@3.2.0',
    'https://jspm.dev/@xenova/transformers@3.2.1',
    'https://jspm.dev/@xenova/transformers@3.3.1',
    // GA (JSPM CDN estable) con build minificado
    'https://ga.jspm.io/npm:@xenova/transformers@3.2.1/dist/transformers.min.js',
    // jsDelivr dist ESM directo (import dinámico, no etiqueta script clásica)
    'https://cdn.jsdelivr.net/npm/@xenova/transformers@3.2.2/dist/transformers.min.js',
    'https://cdn.jsdelivr.net/npm/@xenova/transformers@3.2.0/dist/transformers.min.js',
    // jsDelivr +esm (puede emitir imports "/npm/..."; lo dejamos al final)
    'https://cdn.jsdelivr.net/npm/@xenova/transformers@3.3.1/+esm',
    'https://cdn.jsdelivr.net/npm/@xenova/transformers@latest/+esm',
    // esm.sh bundle (fallback)
    'https://esm.sh/@xenova/transformers@3.3.1?bundle',
    'https://esm.sh/@xenova/transformers@latest?bundle',
  ];
  const proxyBase = 'http://localhost:5174/proxy';

  // Si ya fue pre-cargado por index.html, úsalo y retorna.
  if (window.__TRANSFORMERS__) {
    const mod = window.__TRANSFORMERS__;
    pipeline = mod.pipeline || mod.default?.pipeline;
    env = mod.env || mod.default?.env;
    if (pipeline && env) {
      console.log('Transformers.js tomado de pre-carga global (index.html)');
      return;
    }
  }

  const candidates = [
    ...cdnCandidates,
    ...cdnCandidates.map((u) => `${proxyBase}/${u}`),
  ];

  async function tryImport(url) {
    return await import(/* @vite-ignore */ url);
  }

  async function tryBlob(url) {
    const res = await fetch(url, { cache: 'no-store', mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const code = await res.text();
    const blob = new Blob([code], { type: 'text/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      return await import(/* @vite-ignore */ blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }

  let lastErr;
  for (const url of candidates) {
    for (const loader of [tryImport, tryBlob]) {
      try {
        const mod = await loader(url);
        // Compatibilidad por si exporta default
        pipeline = mod.pipeline || mod.default?.pipeline;
        env = mod.env || mod.default?.env;
        if (pipeline && env) {
          console.log('Transformers.js cargado desde', url, 'vía', loader === tryImport ? 'import' : 'blob');
          return;
        }
        console.warn('Módulo cargado pero faltan APIs (pipeline/env). URL:', url);
      } catch (e) {
        lastErr = e;
        console.warn('Fallo al cargar Transformers.js desde', url, e?.message || e);
      }
    }
  }

  throw new Error(
    'No se pudo cargar @xenova/transformers desde CDNs ni proxy. ' +
    'Verifica tu conexión/red o inicia el proxy local con "npm run proxy" y vuelve a intentar. Último error: ' +
    (lastErr?.message || lastErr || 'desconocido')
  );
}
/* Desbloquea el input de URL base inmediatamente, sin esperar a la librería */
try {
  const base = document.getElementById('base-url');
  if (base) {
    base.disabled = false;
    base.readOnly = false;
  }
} catch {}
await loadTransformers();

// Configure ONNX Runtime Web WASM backend (CPU)
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.0/dist/';
// Use proxy (web worker) for WASM to avoid UI blocking where supported
env.backends.onnx.wasm.proxy = true;
// Enable SIMD if available
env.backends.onnx.wasm.simd = true;
// Set a reasonable default for threads
try {
  const cores = navigator.hardwareConcurrency || 2;
  env.backends.onnx.wasm.numThreads = Math.min(4, Math.max(1, cores - 1));
} catch (_) {}

 // Wrap fetch to detect HTML/error pages for model artifacts and fallback to a public mirror when possible.
 // Transformers.js will use env.fetch when provided.
{
  const baseFetch =
    typeof env.fetch === 'function'
      ? env.fetch
      : typeof fetch === 'function'
        ? fetch.bind(typeof window !== 'undefined' ? window : globalThis)
        : null;

  const HF = 'https://huggingface.co';
  const MIRROR = 'https://hf-mirror.com';

  async function tryMirrorIfHF(urlStr, options, originalRes) {
    if (!urlStr.startsWith(HF)) return null;
    const mirrorUrl = urlStr.replace(HF, MIRROR);
    console.warn('HTML/ERROR para artefacto; probando mirror:', mirrorUrl);
    const mRes = await baseFetch(mirrorUrl, options);
    // Validate mirror isn't HTML
    const mCT = (mRes.headers.get('content-type') || '').toLowerCase();
    let mSnippet = '';
    try { mSnippet = (await mRes.clone().text()).slice(0, 240).replace(/\s+/g, ' '); } catch {}
    const mirrorLooksHTML = mCT.includes('text/html') || /^</.test(mSnippet) || /<!doctype/i.test(mSnippet);
    if (!mRes.ok || mirrorLooksHTML) {
      // Return null to indicate failure; caller will throw a clearer error
      console.error('Mirror también inválido/HTML:', mirrorUrl, 'status=', mRes.status, 'CT=', mCT);
      return null;
    }
    return mRes;
  }

  if (baseFetch) {
    env.fetch = async (url, options) => {
      const res = await baseFetch(url, options);
      try {
        const ct = (res.headers.get('content-type') || '').toLowerCase();
        const urlStr = String(url);
        let looksHTML = false;

        if (urlStr.includes('/resolve/')) {
          const clone = res.clone();
          // Some hosts misreport content-type, so also sniff the start of the body.
          let snippet = '';
          try { snippet = (await clone.text()).slice(0, 240).replace(/\s+/g, ' '); } catch {}
          looksHTML = ct.includes('text/html') || /^</.test(snippet) || /<!doctype/i.test(snippet);

          if (looksHTML || !res.ok) {
            // Try mirror if this is an HF URL
            const mRes = await tryMirrorIfHF(urlStr, options, res);
            if (mRes) return mRes;

            // Otherwise, surface a clear error.
            const details = { url: urlStr, contentType: ct, status: res.status };
            console.error('Diagnóstico: Artefacto inválido (HTML/ERROR):', details);
            throw new Error(
              `Artefacto inválido (HTML/ERROR) para ${urlStr}. ` +
              `Si usas endpoint por defecto y tu red bloquea HF, prueba un mirror o desactiva filtros de red.`
            );
          }
        }
      } catch (e) {
        if (e instanceof Error) throw e; // propagate explicit errors
      }

      if (!res.ok) {
        console.warn('Diagnóstico: respuesta no OK', url, res.status, res.statusText);
      }
      return res;
    };
  }
}

const $ = (sel) => document.querySelector(sel);
const els = {
  modelId: $('#model-id'),
  btnLoad: $('#btn-load'),
  btnUnload: $('#btn-unload'),
  status: $('#status'),
  maxNew: $('#max-new-tokens'),
  temperature: $('#temperature'),
  topk: $('#top-k'),
  topp: $('#top-p'),
  messages: $('#messages'),
  form: $('#chat'),
  prompt: $('#prompt'),
  btnSend: $('#btn-send'),
  btnStop: $('#btn-stop'),
  // new controls
  useBaseUrl: $('#use-base-url'),
  baseUrl: $('#base-url'),
  useQuantized: $('#use-quantized'),
  btnPickDir: $('#btn-pick-dir'),
  dirPicker: $('#dir-picker'),
  dirCount: $('#dir-count'),
};

let generator = null; // pipeline instance
let isGenerating = false;
let shouldStop = false;

// Persist user options
const storageKey = 'slm-chat-settings';
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(storageKey) || '{}');
    if (s.modelId) els.modelId.value = s.modelId;
    if (s.maxNew) els.maxNew.value = s.maxNew;
    if (s.temperature) els.temperature.value = s.temperature;
    if (s.topk !== undefined) els.topk.value = s.topk;
    if (s.topp) els.topp.value = s.topp;

    if (s.useBaseUrl !== undefined && els.useBaseUrl) els.useBaseUrl.checked = !!s.useBaseUrl;
    if (s.baseUrl && els.baseUrl) els.baseUrl.value = s.baseUrl;
    if (s.useQuantized !== undefined && els.useQuantized) els.useQuantized.checked = !!s.useQuantized;

    toggleBaseUrlInput();
  } catch (_) {}
}
function saveSettings() {
  const s = {
    modelId: els.modelId?.value?.trim(),
    maxNew: Number(els.maxNew?.value),
    temperature: Number(els.temperature?.value),
    topk: Number(els.topk?.value),
    topp: Number(els.topp?.value),
    useBaseUrl: !!els.useBaseUrl?.checked,
    baseUrl: els.baseUrl?.value?.trim() || '',
    useQuantized: !!els.useQuantized?.checked,
  };
  localStorage.setItem(storageKey, JSON.stringify(s));
}

function setStatus(text) {
  els.status.textContent = text;
}

function setUIForLoading(loading) {
  els.btnLoad.disabled = loading;
  els.modelId.disabled = loading;
  els.btnUnload.disabled = loading || !generator;
}
function setUIForGeneration(active) {
  isGenerating = active;
  els.form.classList.toggle('busy', active);
  els.btnSend.disabled = active || !generator;
  els.btnStop.disabled = !active;
  els.prompt.disabled = active || !generator;
}

function toggleBaseUrlInput() {
  const enabled = !!els.useBaseUrl?.checked;
  if (!els.baseUrl) return;
  // Siempre editable y seleccionable; solo cambiamos estilo visual si está inactivo
  els.baseUrl.disabled = false;
  els.baseUrl.readOnly = false;
  els.baseUrl.classList.toggle('inactive', !enabled);
}

async function handlePickDirClick() {
  if (!els.dirPicker) return;
  els.dirPicker.click();
}

function handleDirPicked(ev) {
  const files = Array.from(ev.target.files || []);
  const count = files.length;
  if (els.dirCount) {
    const hasModelJson = files.some(f => /model\.json$/i.test(f.name));
    els.dirCount.textContent = count
      ? `${count} archivos seleccionados${hasModelJson ? ' (model.json detectado)' : ''}`
      : '';
  }
  // Note: Transformers.js fetches files via HTTP(S). Selected files cannot be passed directly.
  // Serve the directory with any static server and set its URL in "URL base".
  setStatus('Para usar archivos locales, sirve la carpeta con un servidor HTTP y configura "URL base".');
}

function appendMessage(role, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg ${role}`;
  const roleEl = document.createElement('div');
  roleEl.className = 'role';
  roleEl.textContent = role === 'user' ? 'Usuario' : 'Asistente';
  const pre = document.createElement('pre');
  pre.textContent = text || '';
  wrap.appendChild(roleEl);
  wrap.appendChild(pre);
  els.messages.appendChild(wrap);
  els.messages.scrollTop = els.messages.scrollHeight;
  return pre;
}

function buildPromptFromThread() {
  // Simple prompt format compatible with non-chat models
  const parts = [];
  const nodes = els.messages.querySelectorAll('.msg');
  nodes.forEach((node) => {
    const isUser = node.classList.contains('user');
    const content = node.querySelector('pre')?.textContent || '';
    parts.push(`${isUser ? 'User' : 'Assistant'}: ${content}`.trim());
  });
  parts.push('Assistant:');
  return parts.join('\n');
}
/**
 * Validate endpoint by checking both Hub API and config.json.
 * When using a custom base URL, many servers return HTML (SPA fallback) which breaks loading.
 * This function throws early with an actionable message if that happens.
 */
async function validateModelEndpoint(endpoint, modelId, isCustom = false, revision = 'main') {
  const repoPath = modelId.split('/').map(encodeURIComponent).join('/');

  // 1) If custom base URL is used, require Hugging Face API JSON to exist
  if (isCustom) {
    const apiUrl = `${endpoint}/api/models/${repoPath}`;
    const apiRes = await fetch(apiUrl, {
      method: 'GET',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
    });
    if (!apiRes.ok) {
      throw new Error(`El endpoint no es compatible con la API de HF: ${apiUrl} → HTTP ${apiRes.status}.`);
    }
    const apiCT = (apiRes.headers.get('content-type') || '').toLowerCase();
    const apiBody = await apiRes.text();
    try {
      JSON.parse(apiBody);
    } catch {
      const snippet = apiBody.slice(0, 200).replace(/\s+/g, ' ');
      if (apiCT.includes('text/html') || /^</.test(snippet) || /<!doctype/i.test(snippet)) {
        throw new Error(
          'Tu servidor devolvió HTML para /api/models. Para usar URL base personalizada, el host debe exponer la API de HF y no hacer SPA fallback.'
        );
      }
      throw new Error('La respuesta de /api/models no es JSON válido.');
    }
  }

  // 2) Always validate config.json under resolve path (static artifact)
  const cfgUrl = `${endpoint}/${repoPath}/resolve/${revision}/config.json`;
  const cfgRes = await fetch(cfgUrl, {
    method: 'GET',
    cache: 'no-store',
    headers: { 'Accept': 'application/json, text/plain;q=0.9, */*;q=0.1' },
  });
  if (!cfgRes.ok) {
    throw new Error(`No se encontró config.json en ${cfgUrl} (HTTP ${cfgRes.status}).`);
  }
  const cfgCT = (cfgRes.headers.get('content-type') || '').toLowerCase();
  const cfgText = await cfgRes.text();
  try {
    JSON.parse(cfgText);
  } catch {
    const snippet = cfgText.slice(0, 200).replace(/\s+/g, ' ');
    if (cfgCT.includes('text/html') || /^</.test(snippet) || /<!doctype/i.test(snippet)) {
      throw new Error(
        'El servidor devolvió HTML (probable index.html) para config.json. Debes servir artefactos en rutas tipo /{repo}/resolve/main/*.'
      );
    }
    throw new Error('config.json no es JSON válido en tu host.');
  }
}

async function loadModel() {
  saveSettings();
  const modelId = els.modelId.value.trim();
  if (!modelId) {
    alert('Ingresa el ID del modelo, por ejemplo Xenova/gpt2');
    return;
  }
  setUIForLoading(true);
  setStatus(`Cargando modelo ${modelId} (WASM/CPU)...`);
  try {
    // Determine endpoint (HF or custom). Validate when custom is used.
    let endpoint = 'https://huggingface.co';
    if (els.useBaseUrl?.checked) {
      let url = (els.baseUrl?.value || '').trim();
      if (!url) {
        throw new Error('URL base vacía. Desmarca "Usar URL base personalizada" o provee una URL válida.');
      }
      if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url.replace(/^\/+/, '');
      }
      endpoint = url.replace(/\/+$/, '');
    }
    env.HF_ENDPOINT = endpoint;
    const isCustom = !!els.useBaseUrl?.checked;

    // Validate endpoint by actually fetching and parsing config.json to avoid HTML fallbacks.
    // If default HF fails (network/HTML/blocked), try a known mirror.
    try {
      await validateModelEndpoint(endpoint, modelId, isCustom);
    } catch (vErr) {
      if (!isCustom) {
        const mirror = 'https://hf-mirror.com';
        try {
          await validateModelEndpoint(mirror, modelId, false);
          endpoint = mirror;
          env.HF_ENDPOINT = endpoint;
          console.warn('Usando mirror para modelos:', mirror);
        } catch {
          throw vErr; // keep original validation error
        }
      } else {
        throw vErr;
      }
    }

    // Try 8-bit weights if available, otherwise fallback automatically
    const quant = !!els.useQuantized?.checked;
    generator = await pipeline('text-generation', modelId, {
      quantized: quant,
      progress_callback: (evt) => {
        if (evt?.status === 'downloading' && typeof evt?.url === 'string') {
          setStatus(`Descargando: ${evt.url}`);
        }
      },
    });

    setStatus(`Modelo listo: ${modelId} (endpoint: ${env.HF_ENDPOINT})`);
    els.btnUnload.disabled = false;
    els.btnSend.disabled = false;
    els.prompt.disabled = false;
  } catch (err) {
    console.error(err);
    let msg = (err?.message || String(err));
    if (/Unexpected token <|text\/html|HTML/i.test(msg)) {
      msg = 'El servidor devolvió HTML en lugar de JSON/ONNX. Revisa "Usar URL base personalizada" y que tu host exponga rutas tipo /{repo}/resolve/main/*.';
    }
    alert('Error cargando el modelo: ' + msg);
    setStatus('Modelo no cargado.');
  } finally {
    setUIForLoading(false);
  }
}

function unloadModel() {
  generator = null;
  setStatus('Modelo descargado.');
  els.btnUnload.disabled = true;
  els.btnSend.disabled = true;
  els.prompt.disabled = true;
}

async function handleSubmit(e) {
  e.preventDefault();
  if (!generator) {
    alert('Primero carga un modelo.');
    return;
  }
  const userText = els.prompt.value.trim();
  if (!userText) return;
  els.prompt.value = '';
  appendMessage('user', userText);
  await generateAssistantReply();
}

async function generateAssistantReply() {
  if (!generator) return;
  if (isGenerating) return;
  setUIForGeneration(true);
  shouldStop = false;

  const max_new_tokens = Math.max(1, Number(els.maxNew.value) || 64);
  const temperature = Math.max(0, Number(els.temperature.value) || 0.7);
  const top_k = Math.max(0, Number(els.topk.value) || 50);
  const top_p = Math.max(0, Math.min(1, Number(els.topp.value) || 0.95));

  const outEl = appendMessage('assistant', '');
  const start = performance.now();

  try {
    const prompt = buildPromptFromThread();
    const options = {
      max_new_tokens,
      temperature,
      top_k,
      top_p,
      do_sample: temperature > 0,
      repetition_penalty: 1.1,
      // Return only the new text to keep streaming clean
      return_full_text: false,
      callback_function: (token) => {
        if (shouldStop) {
          throw new Error('GenerationStopped');
        }
        outEl.textContent += token;
        els.messages.scrollTop = els.messages.scrollHeight;
      },
    };

    const result = await generator(prompt, options);
    // In case callback wasn't available, ensure final text is shown
    if (Array.isArray(result) && result[0]?.generated_text && outEl.textContent.length === 0) {
      outEl.textContent = result[0].generated_text;
    }
    const dt = ((performance.now() - start) / 1000).toFixed(2);
    setStatus(`Generación completada en ${dt}s`);
  } catch (err) {
    if (String(err?.message || err).includes('GenerationStopped')) {
      setStatus('Generación detenida por el usuario.');
    } else {
      console.error(err);
      alert('Error durante la generación: ' + (err?.message || err));
      setStatus('Error durante la generación.');
    }
  } finally {
    setUIForGeneration(false);
  }
}

function stopGeneration() {
  if (!isGenerating) return;
  shouldStop = true;
}

// Wire events
els.btnLoad.addEventListener('click', loadModel);
els.btnUnload.addEventListener('click', unloadModel);
els.form.addEventListener('submit', handleSubmit);
els.btnStop.addEventListener('click', stopGeneration);
els.useBaseUrl?.addEventListener('change', () => { toggleBaseUrlInput(); saveSettings(); });
els.baseUrl?.addEventListener('input', saveSettings);
// Auto-habilitar al interactuar con el campo
els.baseUrl?.addEventListener('focus', () => {
  if (!els.useBaseUrl?.checked) {
    els.useBaseUrl.checked = true;
    toggleBaseUrlInput();
    saveSettings();
  }
});
els.baseUrl?.addEventListener('mousedown', () => {
  if (els.baseUrl?.readOnly) {
    els.useBaseUrl.checked = true;
    toggleBaseUrlInput();
    saveSettings();
  }
});
els.useQuantized?.addEventListener('change', saveSettings);
els.btnPickDir?.addEventListener('click', handlePickDirClick);
els.dirPicker?.addEventListener('change', handleDirPicked);

// Init UI
loadSettings();
// Disable chat until model is loaded
els.btnSend.disabled = true;
els.prompt.disabled = true;
setStatus('Modelo no cargado.');

// Help quick submit with Ctrl/Cmd+Enter
els.prompt.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    els.form.requestSubmit();
  }
});

// Preserve settings on changes
['change', 'input'].forEach((ev) => {
  [els.maxNew, els.temperature, els.topk, els.topp, els.modelId].forEach((el) => {
    el.addEventListener(ev, saveSettings);
  });
});