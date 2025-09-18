# SLM Chat (ONNX Runtime Web + WASM, CPU)

Chat mínimo para probar modelos SLM/LLM directamente en el navegador usando ONNX Runtime Web (backend WebAssembly). Todo corre localmente en tu dispositivo (CPU). Sin backends externos.

Archivos:
- [index.html](index.html)
- [app.js](app.js)
- [styles.css](styles.css)

## Características

- Carga de modelos vía `@xenova/transformers` (ONNX) con backend WASM (CPU).
- Streaming de tokens con `callback_function`.
- Parámetros de decodificación: `max_new_tokens`, `temperature`, `top_k`, `top_p`.
- Opción “quantized” (8-bit) si está disponible para el modelo.
- URL base personalizada para espejos/mirror de Hugging Face o self-host.
- Persistencia de opciones en `localStorage`.
- Selector de carpeta (experimental) para ayudarte a validar archivos locales (no carga directa de `file://`).

## Requisitos

- Navegador moderno (Chrome/Edge/Brave/Firefox reciente).
- Conectividad a internet si vas a descargar modelos desde CDN/Hugging Face/mirror.
- Si deseas servir los archivos localmente, evita `python -m http.server` (por CORS/headers). Usa alguna de las opciones que siguen.

## Servir la app (sin Python)

La app debe servirse por HTTP(s) para que el navegador pueda importar módulos ES y para evitar restricciones `file://`.

Opciones con Node.js:

1) http-server (recomendado para habilitar COOP/COEP)
- Instalar y ejecutar sin instalar globalmente:
  npx http-server -p 5173 --cors -c-1 -H "Cross-Origin-Opener-Policy: same-origin" -H "Cross-Origin-Embedder-Policy: require-corp"

- Abre: http://localhost:5173/

2) serve
- Ejecutar:
  npx serve -l 5173

- Abre: http://localhost:5173/

Notas:
- Los encabezados COOP/COEP permiten `SharedArrayBuffer`, que ONNX Runtime usa para multi-thread (si el navegador lo soporta). Si tu servidor no agrega esos headers, seguirá funcionando en 1 hilo (más lento, pero funcional).
- Aun sin COOP/COEP, la demo funciona (con menos rendimiento).

## Uso básico

1) Inicia el servidor estático (ver arriba).
2) Abre la app en tu navegador.
3) En el campo “Modelo” puedes probar con algo pequeño:
   - `Xenova/gpt2` (base segura para pruebas).
4) Clic en “Cargar modelo”.
5) Escribe tu mensaje y clic en “Enviar”. Observa el streaming de tokens.
6) “Detener” cancela la generación en curso.

Los controles:
- max_new_tokens: cantidad máxima de tokens a generar.
- temperature: aleatoriedad. En 0, greedy.
- top_k/top_p: muestreo por núcleo o probabilidad acumulada.
- quantized: intenta pesos 8-bit (si el modelo lo soporta).

## Carga desde URL base personalizada

El control “Usar URL base personalizada” te permite redefinir el endpoint que `@xenova/transformers` usará para descargar los artefactos del modelo. Pensado para:
- Mirrors de Hugging Face (con la misma estructura de rutas).
- Tu propio host con una estructura compatible.

Cómo funciona:
- Internamente se establece `env.HF_ENDPOINT = <tu_url_base>`.
- Transformers.js formará URLs estilo Hugging Face. Por tanto, tu servidor debe exponer rutas compatibles, p. ej.:
  <base>/Xenova/gpt2/resolve/main/tokenizer.json
  <base>/Xenova/gpt2/resolve/main/model.onnx
  ...

Sugerencias para self-host:
- Descarga los archivos del repo del modelo (desde la web de Hugging Face).
- Reprodúcelos en tu servidor con la estructura:
  /<ID_DEL_REPO>/resolve/<REVISION>/<ARCHIVOS>
  Ejemplo:
  /Xenova/gpt2/resolve/main/tokenizer.json
  /Xenova/gpt2/resolve/main/model.onnx
- Luego, en la app, marca “Usar URL base personalizada” y coloca la raíz de tu host, p. ej.:
  http://localhost:8000

Importante:
- No uses rutas `file://`. El navegador bloqueará las lecturas cruzadas sin un servidor HTTP.
- Si no replicas la estructura de rutas al estilo Hugging Face, la descarga fallará.

## Carpeta local (experimental)

El botón “Cargar desde carpeta (experimental)” y el selector de directorio sirven para:
- Ver cuántos archivos tienes y si `model.json`/artefactos están presentes.
- NO carga directamente el modelo desde el File System (las librerías esperan `fetch`/HTTP).

Para usar archivos locales realmente:
- Sirve esa carpeta con un servidor HTTP (ej. `npx http-server`).
- Asegúrate de exponer la estructura compatible con “resolve/main”.
- Configura la “URL base personalizada” apuntando a ese host.

## Detalles técnicos relevantes

En [app.js](app.js) se configuran parámetros del runtime:
- `env.backends.onnx.wasm.wasmPaths` apunta al CDN de `onnxruntime-web`.
- `env.backends.onnx.wasm.proxy = true` usa Web Worker (cuando está disponible).
- `env.backends.onnx.wasm.simd = true` activa SIMD si el navegador lo soporta.
- `env.backends.onnx.wasm.numThreads` intenta usar varios hilos si `crossOriginIsolated`.

Generación:
- Se usa `pipeline('text-generation', modelId, { quantized })`.
- Streaming de tokens con `callback_function` acumulando en la UI.
- `return_full_text: false` para mostrar solo lo nuevo del asistente.

Prompting:
- Se construye un prompt simple “User/Assistant” a partir del historial del panel. Esto es suficientemente genérico para modelos que no requieren plantillas chat especiales. Si usas modelos Instruct/Chat con plantillas específicas, adáptalo en [app.js](app.js:160) donde se arma el prompt.

## Modelos recomendados para empezar

- `Xenova/gpt2` (pequeño, rápido de bajar, buena compatibilidad).
- Evita modelos “grandes” en primeras pruebas; pueden requerir mucha RAM y tardar en WASM/CPU.

## Rendimiento

- WASM CPU es portátil pero limitado. Velocidades dependen de tu CPU y navegador.
- Para aprovechar multi-thread:
  - Sirve la app con COOP/COEP (ver comando http-server arriba).
  - Asegúrate de que el navegador muestre `window.crossOriginIsolated === true`.
- Reduce `max_new_tokens` y/o sube `temperature` para respuestas más cortas y baratas.
- Quantized 8-bit puede ayudar en memoria/velocidad, si el modelo lo soporta.

## Solución de problemas

- “CORS” o “blocked by CORS policy”:
  - Sirve la app y/o los modelos por HTTP.
  - Añade `--cors` si usas `http-server`.
- “ERR_FAILED” al importar `app.js`:
  - Asegúrate de no abrir `index.html` con `file://`.
- Muy lento o se queda “pensando”:
  - Bajá `max_new_tokens`.
  - Probá con `Xenova/gpt2`.
  - Verifica si estás en 1 hilo (sin COOP/COEP).
- “No encuentra archivos del modelo” con URL base:
  - Revisa que la estructura `<base>/{repo}/resolve/{revision}/<file>` exista.
  - Si usas un mirror, confirma compatibilidad con rutas de Hugging Face.

## Scripts útiles (opcional)

Si usas Node, podés agregar un `package.json` con scripts de servidor estático. Ejemplo con `http-server`:
- npx http-server -p 5173 --cors -c-1 -H "Cross-Origin-Opener-Policy: same-origin" -H "Cross-Origin-Embedder-Policy: require-corp"

## Estado actual

- UI y lógica base listas.
- Loader con:
  - ID de modelo (ej. `Xenova/gpt2`)
  - URL base personalizada (para mirrors/self-host)
  - Toggle “quantized”
  - Selector de carpeta (experimental, no carga directa)
- Verificación en el navegador queda para el final según lo solicitado.


## Proxy local de CORS (si tu red/mirror bloquea CORS)

Si ves errores del tipo “has been blocked by CORS policy” al descargar artefactos (p. ej. config.json, tokenizer.json, model.onnx) desde Hugging Face o mirrors, puedes usar el proxy local incluido para evitar CORS durante el desarrollo.

Pasos:
1) Inicia el proxy:
   - npm run proxy
   - El proxy queda escuchando en: http://localhost:5174

2) En la app, marca “Usar URL base personalizada” y coloca:
   - http://localhost:5174/proxy/https://huggingface.co

3) Carga un modelo pequeño (ej: Xenova/gpt2) y prueba.

Notas:
- El proxy agrega Access-Control-Allow-Origin: * y retransmite las cabeceras necesarias para descargas de archivos grandes.
- También funciona con mirrors, por ejemplo:
  - http://localhost:5174/proxy/https://hf-mirror.com
- Uso recomendado solo para desarrollo local. No lo expongas a internet sin controles.

Comandos útiles actualizados:
- Servidor estático con COOP/COEP: npx http-server -p 5173 --cors -c-1 -H "Cross-Origin-Opener-Policy: same-origin" -H "Cross-Origin-Embedder-Policy: require-corp"
- Alternativa simple: npx serve -l 5173
- Proxy CORS local: npm run proxy
