(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const btnGrabarLocal = $("btnGrabarLocal");
  const btnDetenerLocal = $("btnDetenerLocal");
  const estadoLocal = $("estadoGrabacionLocal");

  if (!btnGrabarLocal) return;

  let recLocal = null;
  let chunksLocal = [];
  let streamLocal = null;

  btnGrabarLocal.addEventListener("click", iniciar);
  if (btnDetenerLocal) btnDetenerLocal.addEventListener("click", detener);

  async function iniciar() {
    try {
      estado("🎙️ Pidiendo acceso al micrófono...");

      // Captura simple y neutra (sin el EQ/compresor/efectos de la
      // cabina) — la idea es que quede lo más "cruda" posible y que la
      // reducción de ruido de abajo haga el trabajo, para que después
      // la puedas editar tú mismo en Audacity si quieres.
      streamLocal = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });

      chunksLocal = [];
      recLocal = new MediaRecorder(streamLocal);
      recLocal.ondataavailable = (e) => { if (e.data.size > 0) chunksLocal.push(e.data); };
      recLocal.onstop = procesarYGuardar;
      recLocal.start();

      btnGrabarLocal.disabled = true;
      if (btnDetenerLocal) btnDetenerLocal.disabled = false;
      estado("🔴 Grabando — deja 1 segundo de silencio antes de hablar, así se mide el ruido de fondo para limpiarlo después.");
    } catch (e) {
      console.error(e);
      estado("❌ No se pudo acceder al micrófono: " + e.message, true);
    }
  }

  function detener() {
    if (recLocal && recLocal.state !== "inactive") recLocal.stop();
    if (streamLocal) streamLocal.getTracks().forEach((t) => t.stop());
    btnGrabarLocal.disabled = false;
    if (btnDetenerLocal) btnDetenerLocal.disabled = true;
  }

  async function procesarYGuardar() {
    estado("⏳ Procesando (quitando ruido de fondo, puede tardar unos segundos)...");
    try {
      const blob = new Blob(chunksLocal, { type: recLocal.mimeType || "audio/webm" });
      const arrayBuffer = await blob.arrayBuffer();

      const ctxTemp = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuffer = await ctxTemp.decodeAudioData(arrayBuffer);

      const limpio = reducirRuido(audioBuffer);
      const wavBlob = audioBufferAWav(limpio);

      await guardarArchivo(wavBlob, `grabacion-${Date.now()}.wav`);
      estado("✅ Listo — guardado y limpiado de ruido de fondo.");
    } catch (e) {
      console.error(e);
      estado("❌ Error al procesar: " + e.message, true);
    }
  }

  // ======================================================
  // GUARDAR ARCHIVO (deja elegir carpeta si el navegador lo permite;
  // si no, descarga normal a la carpeta de Descargas)
  // ======================================================
  async function guardarArchivo(blob, nombreSugerido) {
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: nombreSugerido,
          types: [{ description: "Audio WAV", accept: { "audio/wav": [".wav"] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (e) {
        if (e.name === "AbortError") throw new Error("Cancelado.");
        console.warn("No se pudo usar el selector de carpeta, se descarga normal:", e);
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nombreSugerido;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ======================================================
  // REDUCCIÓN DE RUIDO — resta espectral (mismo principio que el
  // "Noise Reduction" de Audacity): mide el ruido en el primer
  // segundo, y lo resta del resto de la grabación.
  // ======================================================
  const TAMANO_FRAME = 2048;
  const SEGUNDOS_PERFIL = 1;
  const FACTOR_RESTA = 1.8;  // qué tan agresivo. Súbelo si queda mucho ruido; bájalo si se oye "robótico"/con huecos.
  const PISO_MINIMO = 0.08;  // nunca deja la señal en menos del 8% del original (evita el "ruido musical" típico de este método)

  function reducirRuido(audioBuffer) {
    const sr = audioBuffer.sampleRate;
    const numCanales = audioBuffer.numberOfChannels;

    const canalesSalida = [];
    for (let c = 0; c < numCanales; c++) {
      canalesSalida.push(procesarCanal(audioBuffer.getChannelData(c), sr));
    }

    const ctxTemp = new (window.AudioContext || window.webkitAudioContext)();
    const bufferFinal = ctxTemp.createBuffer(numCanales, canalesSalida[0].length, sr);
    for (let c = 0; c < numCanales; c++) bufferFinal.copyToChannel(canalesSalida[c], c);
    return bufferFinal;
  }

  function procesarCanal(canal, sr) {
    const N = TAMANO_FRAME;
    const hop = N / 2;
    const ventana = ventanaHann(N);

    // --- Perfil de ruido: promedio de magnitud en el primer segundo ---
    const nMuestrasPerfil = Math.min(canal.length, Math.floor(SEGUNDOS_PERFIL * sr));
    const perfil = new Float64Array(N);
    let nFramesPerfil = 0;
    for (let i = 0; i + N <= nMuestrasPerfil; i += hop) {
      const mag = magnitudDeFrame(canal, i, N, ventana);
      for (let k = 0; k < N; k++) perfil[k] += mag[k];
      nFramesPerfil++;
    }
    if (nFramesPerfil > 0) {
      for (let k = 0; k < N; k++) perfil[k] /= nFramesPerfil;
    }

    // --- Resta espectral con overlap-add ---
    const salida = new Float64Array(canal.length);
    const sumaVentanas = new Float64Array(canal.length);

    for (let i = 0; i + N <= canal.length; i += hop) {
      const re = new Float64Array(N);
      const im = new Float64Array(N);
      for (let j = 0; j < N; j++) re[j] = canal[i + j] * ventana[j];
      fftRadix2(re, im, false);

      for (let k = 0; k < N; k++) {
        const mag = Math.hypot(re[k], im[k]);
        if (mag < 1e-9) continue;
        const magLimpia = Math.max(mag - FACTOR_RESTA * perfil[k], PISO_MINIMO * mag);
        const escala = magLimpia / mag;
        re[k] *= escala;
        im[k] *= escala;
      }

      fftRadix2(re, im, true);
      for (let j = 0; j < N; j++) {
        salida[i + j] += re[j] * ventana[j];
        sumaVentanas[i + j] += ventana[j] * ventana[j];
      }
    }

    for (let i = 0; i < salida.length; i++) {
      if (sumaVentanas[i] > 1e-6) salida[i] /= sumaVentanas[i];
    }

    return Float32Array.from(salida);
  }

  function magnitudDeFrame(canal, inicio, N, ventana) {
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let j = 0; j < N; j++) re[j] = (canal[inicio + j] || 0) * ventana[j];
    fftRadix2(re, im, false);
    const mag = new Float64Array(N);
    for (let k = 0; k < N; k++) mag[k] = Math.hypot(re[k], im[k]);
    return mag;
  }

  function ventanaHann(N) {
    const w = new Float64Array(N);
    for (let i = 0; i < N; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
    return w;
  }

  // FFT/IFFT radix-2 in-place (Cooley-Tukey). n debe ser potencia de 2.
  function fftRadix2(re, im, invertir) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (invertir ? 2 : -2) * Math.PI / len;
      const wRe = Math.cos(ang), wIm = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let curRe = 1, curIm = 0;
        for (let j = 0; j < half; j++) {
          const uRe = re[i + j], uIm = im[i + j];
          const tRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
          const tIm = re[i + j + half] * curIm + im[i + j + half] * curRe;
          re[i + j] = uRe + tRe; im[i + j] = uIm + tIm;
          re[i + j + half] = uRe - tRe; im[i + j + half] = uIm - tIm;
          const nRe = curRe * wRe - curIm * wIm;
          const nIm = curRe * wIm + curIm * wRe;
          curRe = nRe; curIm = nIm;
        }
      }
    }
    if (invertir) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  // ======================================================
  // CODIFICAR A WAV (PCM 16-bit) — sin depender de librerías externas
  // ======================================================
  function audioBufferAWav(buffer) {
    const numCanales = buffer.numberOfChannels;
    const sr = buffer.sampleRate;
    const numMuestras = buffer.length;
    const bloqueAlign = numCanales * 2;
    const dataSize = numMuestras * bloqueAlign;

    const arr = new ArrayBuffer(44 + dataSize);
    const vista = new DataView(arr);

    escribirStr(vista, 0, "RIFF");
    vista.setUint32(4, 36 + dataSize, true);
    escribirStr(vista, 8, "WAVE");
    escribirStr(vista, 12, "fmt ");
    vista.setUint32(16, 16, true);
    vista.setUint16(20, 1, true);
    vista.setUint16(22, numCanales, true);
    vista.setUint32(24, sr, true);
    vista.setUint32(28, sr * bloqueAlign, true);
    vista.setUint16(32, bloqueAlign, true);
    vista.setUint16(34, 16, true);
    escribirStr(vista, 36, "data");
    vista.setUint32(40, dataSize, true);

    const canales = [];
    for (let c = 0; c < numCanales; c++) canales.push(buffer.getChannelData(c));

    let offset = 44;
    for (let i = 0; i < numMuestras; i++) {
      for (let c = 0; c < numCanales; c++) {
        let m = Math.max(-1, Math.min(1, canales[c][i]));
        m = m < 0 ? m * 0x8000 : m * 0x7fff;
        vista.setInt16(offset, m, true);
        offset += 2;
      }
    }

    return new Blob([arr], { type: "audio/wav" });
  }

  function escribirStr(vista, offset, str) {
    for (let i = 0; i < str.length; i++) vista.setUint8(offset + i, str.charCodeAt(i));
  }

  function estado(t, err) {
    if (!estadoLocal) return;
    estadoLocal.textContent = t;
    estadoLocal.classList.toggle("error", !!err);
  }
})();
