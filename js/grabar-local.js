(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const btnGrabarLocal = $("btnGrabarLocal");
  const btnDetenerLocal = $("btnDetenerLocal");
  const estadoLocal = $("estadoGrabacionLocal");
  const herramientas = $("herramientasLocal");
  const previewAudioLocal = $("previewAudioLocal");
  const inputInicio = $("recorteInicio");
  const inputFin = $("recorteFin");

  if (!btnGrabarLocal) return;

  let recLocal = null;
  let chunksLocal = [];
  let streamLocal = null;

  // bufferActual = el estado actual del audio local (se reemplaza al
  // recortar o al mejorar audio; nada de esto pasa solo, cada paso
  // necesita su propio clic).
  let bufferActual = null;
  let urlActual = null;

  btnGrabarLocal.addEventListener("click", iniciar);
  if (btnDetenerLocal) btnDetenerLocal.addEventListener("click", detener);

  $("btnMarcarInicio")?.addEventListener("click", () => {
    inputInicio.value = (previewAudioLocal.currentTime || 0).toFixed(1);
  });
  $("btnMarcarFin")?.addEventListener("click", () => {
    inputFin.value = (previewAudioLocal.currentTime || 0).toFixed(1);
  });
  $("btnRecortar")?.addEventListener("click", recortar);
  $("btnMejorarAudio")?.addEventListener("click", mejorarAudio);
  $("btnGuardarLocal")?.addEventListener("click", guardarEnComputadora);
  $("btnDescartarLocal")?.addEventListener("click", descartar);

  // ======================================================
  // GRABAR (captura simple y neutra, sin el EQ/compresor de la cabina)
  // ======================================================

  async function iniciar() {
    try {
      estado("🎙️ Pidiendo acceso al micrófono...");
      streamLocal = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });

      chunksLocal = [];
      recLocal = new MediaRecorder(streamLocal);
      recLocal.ondataavailable = (e) => { if (e.data.size > 0) chunksLocal.push(e.data); };
      recLocal.onstop = alDetener;
      recLocal.start();

      btnGrabarLocal.disabled = true;
      btnDetenerLocal.disabled = false;
      herramientas.style.display = "none";
      estado("🔴 Grabando — un consejo: deja ~1 segundo de silencio al inicio, así 'mejorar audio' puede medir mejor el ruido de fondo.");
    } catch (e) {
      console.error(e);
      estado("❌ No se pudo acceder al micrófono: " + e.message, true);
    }
  }

  function detener() {
    if (recLocal && recLocal.state !== "inactive") recLocal.stop();
    if (streamLocal) streamLocal.getTracks().forEach((t) => t.stop());
    btnGrabarLocal.disabled = false;
    btnDetenerLocal.disabled = true;
  }

  async function alDetener() {
    estado("⏳ Cargando grabación...");
    try {
      const blob = new Blob(chunksLocal, { type: recLocal.mimeType || "audio/webm" });
      const arrayBuffer = await blob.arrayBuffer();
      const ctxTemp = new (window.AudioContext || window.webkitAudioContext)();
      bufferActual = await ctxTemp.decodeAudioData(arrayBuffer);

      inputInicio.value = "0";
      inputFin.value = bufferActual.duration.toFixed(1);

      actualizarPreview();
      herramientas.style.display = "block";
      estado("✅ Lista para revisar. Nada se guarda todavía — usa los botones de abajo.");
    } catch (e) {
      console.error(e);
      estado("❌ Error al cargar la grabación: " + e.message, true);
    }
  }

  function actualizarPreview() {
    const wav = audioBufferAWav(bufferActual);
    if (urlActual) URL.revokeObjectURL(urlActual);
    urlActual = URL.createObjectURL(wav);
    previewAudioLocal.src = urlActual;
  }

  function descartar() {
    bufferActual = null;
    if (urlActual) { URL.revokeObjectURL(urlActual); urlActual = null; }
    previewAudioLocal.pause();
    previewAudioLocal.removeAttribute("src");
    previewAudioLocal.load();
    herramientas.style.display = "none";
    estado("🗑 Grabación local descartada.");
  }

  // ======================================================
  // RECORTAR (manual — solo al presionar el botón)
  // ======================================================

  function recortar() {
    if (!bufferActual) return;
    const inicio = parseFloat(inputInicio.value) || 0;
    const fin = parseFloat(inputFin.value) || bufferActual.duration;

    if (inicio < 0 || fin <= inicio || fin > bufferActual.duration + 0.01) {
      estado("❌ El rango de recorte no es válido.", true);
      return;
    }

    try {
      bufferActual = recortarBuffer(bufferActual, inicio, fin);
      inputInicio.value = "0";
      inputFin.value = bufferActual.duration.toFixed(1);
      actualizarPreview();
      estado("✂️ Audio recortado. Puedes seguir editando o guardarlo ya.");
    } catch (e) {
      console.error(e);
      estado("❌ Error al recortar: " + e.message, true);
    }
  }

  function recortarBuffer(buffer, inicioSeg, finSeg) {
    const sr = buffer.sampleRate;
    const inicioMuestra = Math.max(0, Math.floor(inicioSeg * sr));
    const finMuestra = Math.min(buffer.length, Math.floor(finSeg * sr));
    const numCanales = buffer.numberOfChannels;
    const ctxTemp = new (window.AudioContext || window.webkitAudioContext)();
    const nuevo = ctxTemp.createBuffer(numCanales, finMuestra - inicioMuestra, sr);
    for (let c = 0; c < numCanales; c++) {
      nuevo.copyToChannel(buffer.getChannelData(c).slice(inicioMuestra, finMuestra), c);
    }
    return nuevo;
  }

  // ======================================================
  // MEJORAR AUDIO — quitar ruido de fondo (manual, resta espectral,
  // mismo principio que el "Noise Reduction" de Audacity)
  // ======================================================

  const TAMANO_FRAME = 2048;
  const SEGUNDOS_PERFIL = 1;
  const FACTOR_RESTA = 1.3;  // qué tan agresivo. Súbelo si queda mucho ruido; bájalo si se oye "robótico"/con huecos.
  const PISO_MINIMO = 0.15;  // nunca deja la señal en menos del 15% del original (evita el "ruido musical" típico de este método)

  function mejorarAudio() {
    if (!bufferActual) return;
    estado("⏳ Quitando ruido de fondo (puede tardar unos segundos)...");
    // setTimeout para que el navegador alcance a pintar el mensaje antes
    // de ponerse a calcular (esto congela la pestaña un momento).
    setTimeout(() => {
      try {
        const original = bufferActual;
        let limpio = reducirRuido(original);
        // Restar ruido en todo el espectro también le quita volumen a la
        // voz, no solo al ruido — por eso el resultado sonaba muy bajo.
        // Aquí se sube el volumen del resultado para igualar el pico del
        // audio original.
        limpio = normalizarA(limpio, original);
        bufferActual = limpio;
        actualizarPreview();
        estado("🧹 Listo — ruido de fondo reducido y volumen normalizado. Si quedó muy agresivo o con huecos, dímelo y ajustamos el filtro.");
      } catch (e) {
        console.error(e);
        estado("❌ Error al mejorar el audio: " + e.message, true);
      }
    }, 50);
  }

  // Sube (o baja) el volumen de "buffer" para que su pico más alto se
  // parezca al de "referencia" — corrige la pérdida de volumen que deja
  // la resta espectral.
  function normalizarA(buffer, referencia) {
    const picoOriginal = picoAbsoluto(referencia);
    const picoNuevo = picoAbsoluto(buffer);
    if (picoNuevo < 1e-6 || picoOriginal < 1e-6) return buffer;
    const factor = Math.min(picoOriginal / picoNuevo, 6); // tope: no amplificar más de 6x
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const datos = buffer.getChannelData(c);
      for (let i = 0; i < datos.length; i++) {
        datos[i] = Math.max(-1, Math.min(1, datos[i] * factor));
      }
    }
    return buffer;
  }

  function picoAbsoluto(buffer) {
    let pico = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const datos = buffer.getChannelData(c);
      for (let i = 0; i < datos.length; i++) {
        const v = Math.abs(datos[i]);
        if (v > pico) pico = v;
      }
    }
    return pico;
  }

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
  // GUARDAR EN LA COMPUTADORA (manual — solo al presionar el botón)
  // ======================================================

  async function guardarEnComputadora() {
    if (!bufferActual) return;
    estado("⏳ Guardando...");
    try {
      const wav = audioBufferAWav(bufferActual);
      await guardarArchivo(wav, `grabacion-${Date.now()}.wav`);
      estado("✅ Guardado en tu computadora.");
    } catch (e) {
      console.error(e);
      estado("❌ " + e.message, true);
    }
  }

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
  // CODIFICAR A WAV (PCM 16-bit)
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
