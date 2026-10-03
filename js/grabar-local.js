(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ======================================================
  // UTILIDADES COMPARTIDAS (puras, sin estado de UI)
  // ======================================================

  function formatearTiempo(seg) {
    seg = Math.max(0, seg);
    const m = Math.floor(seg / 60);
    const s = seg - m * 60;
    return `${m}:${s.toFixed(3).padStart(6, "0")}`;
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

  // --- Reducción de ruido: resta espectral (estilo "Noise Reduction" de Audacity) ---
  const TAMANO_FRAME = 2048;
  const SEGUNDOS_PERFIL = 1;
  const FACTOR_RESTA = 1.1;  // qué tan agresivo. Súbelo si queda mucho ruido; bájalo si se oye "robótico"/con huecos.
  const PISO_MINIMO = 0.25;  // nunca deja la señal en menos del 25% del original

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

  function igualarVolumen(buffer, referencia) {
    const rmsOriginal = rmsDe(referencia);
    const rmsNuevo = rmsDe(buffer);
    if (rmsNuevo < 1e-6 || rmsOriginal < 1e-6) return buffer;
    let factor = rmsOriginal / rmsNuevo;
    const picoNuevo = picoAbsoluto(buffer);
    const factorMaxSinSaturar = picoNuevo > 1e-6 ? 0.98 / picoNuevo : factor;
    factor = Math.min(factor, factorMaxSinSaturar, 10);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const datos = buffer.getChannelData(c);
      for (let i = 0; i < datos.length; i++) {
        datos[i] = Math.max(-1, Math.min(1, datos[i] * factor));
      }
    }
    return buffer;
  }

  function rmsDe(buffer) {
    let suma = 0, n = 0;
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const datos = buffer.getChannelData(c);
      for (let i = 0; i < datos.length; i++) { suma += datos[i] * datos[i]; n++; }
    }
    return n ? Math.sqrt(suma / n) : 0;
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

  // --- Codificar a MP3 (comprimido) para subir — WAV pesa demasiado
  // (varios MB por minuto) y se topaba con el límite de 60 MB del
  // Worker, además de tardar mucho en subir por lo pesado del archivo.
  function audioBufferAMp3(buffer, kbps) {
    kbps = kbps || 96;
    const lame = window.lamejs;
    if (!lame || !lame.Mp3Encoder) {
      throw new Error("El codificador de MP3 no cargó (revisa tu conexión a internet y recarga la página).");
    }

    const canales = buffer.numberOfChannels >= 2 ? 2 : 1;
    const sr = buffer.sampleRate;
    const encoder = new lame.Mp3Encoder(canales, sr, kbps);

    const izq = flotanteAInt16(buffer.getChannelData(0));
    const der = canales === 2 ? flotanteAInt16(buffer.getChannelData(1)) : null;

    const bloque = 1152; // tamaño de bloque recomendado por LAME
    const partes = [];
    for (let i = 0; i < izq.length; i += bloque) {
      const trozoIzq = izq.subarray(i, i + bloque);
      let mp3buf;
      if (canales === 2) {
        mp3buf = encoder.encodeBuffer(trozoIzq, der.subarray(i, i + bloque));
      } else {
        mp3buf = encoder.encodeBuffer(trozoIzq);
      }
      if (mp3buf.length > 0) partes.push(new Uint8Array(mp3buf));
    }
    const final = encoder.flush();
    if (final.length > 0) partes.push(new Uint8Array(final));

    return new Blob(partes, { type: "audio/mp3" });
  }

  function flotanteAInt16(datos) {
    const salida = new Int16Array(datos.length);
    for (let i = 0; i < datos.length; i++) {
      let m = Math.max(-1, Math.min(1, datos[i]));
      salida[i] = m < 0 ? m * 0x8000 : m * 0x7fff;
    }
    return salida;
  }

  async function guardarArchivoLocal(blob, nombreSugerido) {
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
  // FÁBRICA: un editor de recorte reutilizable (barra con manijas +
  // mejorar audio), para no duplicar la lógica entre la grabación nueva
  // y la edición de episodios ya publicados.
  // ======================================================

  function crearEditorRecorte(elIds) {
    const barra = $(elIds.barra);
    const manijaInicio = $(elIds.manijaInicio);
    const manijaFin = $(elIds.manijaFin);
    const elSeleccion = $(elIds.seleccion);
    const elTiempoInicio = $(elIds.tiempoInicio);
    const elTiempoFin = $(elIds.tiempoFin);
    const elDuracionTotal = $(elIds.duracionTotal);
    const audioEl = $(elIds.audio);
    const estadoEl = $(elIds.estado);

    if (!audioEl || !barra) return null;

    let bufferActual = null;
    let urlActual = null;
    let fracInicio = 0;
    let fracFin = 1;
    let arrastrando = null;

    if (manijaInicio) manijaInicio.addEventListener("pointerdown", (e) => iniciarArrastre(e, "inicio"));
    if (manijaFin) manijaFin.addEventListener("pointerdown", (e) => iniciarArrastre(e, "fin"));

    function iniciarArrastre(e, tipo) {
      e.preventDefault();
      arrastrando = tipo;
      document.addEventListener("pointermove", moverArrastre);
      document.addEventListener("pointerup", soltarArrastre);
    }

    function moverArrastre(e) {
      if (!arrastrando) return;
      const rect = barra.getBoundingClientRect();
      let frac = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
      frac = Math.max(0, Math.min(1, frac));
      if (arrastrando === "inicio") fracInicio = Math.min(frac, fracFin - 0.005);
      else fracFin = Math.max(frac, fracInicio + 0.005);
      actualizarBarra();
    }

    function soltarArrastre() {
      arrastrando = null;
      document.removeEventListener("pointermove", moverArrastre);
      document.removeEventListener("pointerup", soltarArrastre);
    }

    function actualizarBarra() {
      if (!manijaInicio || !manijaFin || !elSeleccion) return;
      const pInicio = (fracInicio * 100).toFixed(3) + "%";
      const pFin = (fracFin * 100).toFixed(3) + "%";
      manijaInicio.style.left = pInicio;
      manijaFin.style.left = pFin;
      elSeleccion.style.left = pInicio;
      elSeleccion.style.width = ((fracFin - fracInicio) * 100).toFixed(3) + "%";

      const dur = bufferActual ? bufferActual.duration : 0;
      if (elTiempoInicio) elTiempoInicio.textContent = formatearTiempo(fracInicio * dur);
      if (elTiempoFin) elTiempoFin.textContent = "-" + formatearTiempo((1 - fracFin) * dur);
    }

    function actualizarPreview() {
      const wav = audioBufferAWav(bufferActual);
      if (urlActual) URL.revokeObjectURL(urlActual);
      urlActual = URL.createObjectURL(wav);
      audioEl.src = urlActual;
    }

    function estado(t, err) {
      if (!estadoEl) return;
      estadoEl.textContent = t;
      estadoEl.classList.toggle("error", !!err);
    }

    function cargarBuffer(buffer) {
      bufferActual = buffer;
      fracInicio = 0;
      fracFin = 1;
      if (elDuracionTotal) elDuracionTotal.textContent = formatearTiempo(buffer.duration);
      actualizarBarra();
      actualizarPreview();
    }

    function recortar() {
      if (!bufferActual) return;
      const dur = bufferActual.duration;
      const inicio = Math.max(0, Math.min(fracInicio * dur, dur));
      const fin = Math.max(0, Math.min(fracFin * dur, dur));
      if (fin - inicio < 0.05) {
        estado("❌ Selecciona al menos un poco de audio (arrastra las manijas amarillas).", true);
        return;
      }
      try {
        bufferActual = recortarBuffer(bufferActual, inicio, fin);
        fracInicio = 0;
        fracFin = 1;
        if (elDuracionTotal) elDuracionTotal.textContent = formatearTiempo(bufferActual.duration);
        actualizarBarra();
        actualizarPreview();
        estado("✂️ Audio recortado. Puedes seguir editando o guardarlo ya.");
      } catch (e) {
        console.error(e);
        estado("❌ Error al recortar: " + e.message, true);
      }
    }

    function mejorar() {
      if (!bufferActual) return;
      estado("⏳ Quitando ruido de fondo (puede tardar unos segundos)...");
      setTimeout(() => {
        try {
          const original = bufferActual;
          let limpio = reducirRuido(original);
          limpio = igualarVolumen(limpio, original);
          bufferActual = limpio;
          actualizarPreview();
          estado("🧹 Listo — ruido reducido y volumen igualado al original.");
        } catch (e) {
          console.error(e);
          estado("❌ Error al mejorar el audio: " + e.message, true);
        }
      }, 50);
    }

    function reset() {
      bufferActual = null;
      if (urlActual) { URL.revokeObjectURL(urlActual); urlActual = null; }
      audioEl.pause();
      audioEl.removeAttribute("src");
      audioEl.load();
      fracInicio = 0; fracFin = 1;
      actualizarBarra();
      estado("");
    }

    return { cargarBuffer, obtenerBuffer: () => bufferActual, recortar, mejorar, reset, estado };
  }

  // ======================================================
  // EDITOR 1: grabación nueva (justo después de "Detener y guardar")
  // ======================================================

  const editorLocal = crearEditorRecorte({
    barra: "recorteBarra", manijaInicio: "manijaInicio", manijaFin: "manijaFin",
    seleccion: "recorteSeleccion", tiempoInicio: "recorteTiempoInicio", tiempoFin: "recorteTiempoFin",
    duracionTotal: "recorteDuracionTotal", audio: "previewAudioLocal", estado: "estadoGrabacionLocal"
  });

  if (editorLocal) {
    $("btnRecortar")?.addEventListener("click", editorLocal.recortar);
    $("btnMejorarAudio")?.addEventListener("click", editorLocal.mejorar);
    $("btnGuardarLocal")?.addEventListener("click", async () => {
      const buffer = editorLocal.obtenerBuffer();
      if (!buffer) return;
      editorLocal.estado("⏳ Guardando...");
      try {
        await guardarArchivoLocal(audioBufferAWav(buffer), `grabacion-${Date.now()}.wav`);
        editorLocal.estado("✅ Guardado en tu computadora.");
      } catch (e) {
        console.error(e);
        editorLocal.estado("❌ " + e.message, true);
      }
    });

    // Llamado desde app.js justo cuando "Detener y guardar" termina de
    // grabar — carga esa MISMA grabación aquí.
    window.P21_cargarTomaLocal = async function (blob) {
      editorLocal.estado("⏳ Preparando...");
      try {
        const arrayBuffer = await blob.arrayBuffer();
        const ctxTemp = new (window.AudioContext || window.webkitAudioContext)();
        const buffer = await ctxTemp.decodeAudioData(arrayBuffer);
        editorLocal.cargarBuffer(buffer);
        editorLocal.estado("Lista para recortar, mejorar o guardar en tu computadora.");
      } catch (e) {
        console.error(e);
        editorLocal.estado("❌ Error al preparar la grabación: " + e.message, true);
      }
    };

    window.P21_descartarTomaLocal = function () {
      editorLocal.reset();
    };
  }

  // ======================================================
  // EDITOR 2: episodios ya publicados (desde "Administrar episodios")
  // ======================================================

  const editorEpisodio = crearEditorRecorte({
    barra: "recorteBarraEp", manijaInicio: "manijaInicioEp", manijaFin: "manijaFinEp",
    seleccion: "recorteSeleccionEp", tiempoInicio: "recorteTiempoInicioEp", tiempoFin: "recorteTiempoFinEp",
    duracionTotal: "recorteDuracionTotalEp", audio: "previewAudioEpisodio", estado: "estadoEditarAudio"
  });

  let episodioActual = null; // { id, titulo, url, archivo }

  if (editorEpisodio) {
    $("btnRecortarEp")?.addEventListener("click", editorEpisodio.recortar);
    $("btnMejorarAudioEp")?.addEventListener("click", editorEpisodio.mejorar);
    $("btnCancelarEditarAudio")?.addEventListener("click", () => {
      editorEpisodio.reset();
      episodioActual = null;
      $("editAudioModal")?.close();
    });
    $("btnActualizarEpisodio")?.addEventListener("click", actualizarEpisodio);

    window.P21_abrirEditorEpisodio = async function (item) {
      episodioActual = item;
      const modal = $("editAudioModal");
      const tituloEl = $("editAudioTitulo");
      if (tituloEl) tituloEl.textContent = item.titulo || "";
      editorEpisodio.estado("⏳ Descargando el audio del episodio...");
      if (modal && modal.showModal) modal.showModal();

      try {
        const resp = await fetch(item.url);
        if (!resp.ok) throw new Error("No se pudo descargar el audio (" + resp.status + ")");
        const arrayBuffer = await resp.arrayBuffer();
        const ctxTemp = new (window.AudioContext || window.webkitAudioContext)();
        const buffer = await ctxTemp.decodeAudioData(arrayBuffer);
        editorEpisodio.cargarBuffer(buffer);
        editorEpisodio.estado("Listo — puedes recortar o mejorar el audio, y luego actualizar el episodio.");
      } catch (e) {
        console.error(e);
        editorEpisodio.estado("❌ Error al cargar el audio: " + e.message, true);
      }
    };
  }

  async function actualizarEpisodio() {
    if (!episodioActual || !editorEpisodio) return;
    const buffer = editorEpisodio.obtenerBuffer();
    if (!buffer) return;

    if (typeof window.P21_subirArchivoB2 !== "function" || !window.P21_DB) {
      editorEpisodio.estado("❌ Falta configuración (B2 o Supabase) para actualizar.", true);
      return;
    }

    editorEpisodio.estado("⏳ Comprimiendo a MP3...");
    try {
      const mp3 = audioBufferAMp3(buffer, 96);
      const nombreArchivo = `editado-${Date.now()}.mp3`;
      editorEpisodio.estado(`⏳ Subiendo (${(mp3.size / 1024 / 1024).toFixed(1)} MB)...`);
      const nuevaUrl = await window.P21_subirArchivoB2(mp3, nombreArchivo, "audios");

      const urlVieja = episodioActual.url;

      const { error } = await window.P21_DB.from("audios").update({
        url: nuevaUrl,
        archivo: nombreArchivo,
        duracion: Math.round(buffer.duration)
      }).eq("id", episodioActual.id);

      if (error) throw new Error(error.message);

      // Borra el archivo anterior en B2 (si era de B2; si era de
      // Supabase Storage de antes de la migración, se deja como está).
      if (typeof window.P21_borrarArchivoB2 === "function") {
        window.P21_borrarArchivoB2(urlVieja).catch(() => {});
      }

      editorEpisodio.estado("✅ Episodio actualizado.");
      if (typeof window.P21_refrescarTabla === "function") window.P21_refrescarTabla();

      setTimeout(() => {
        $("editAudioModal")?.close();
        editorEpisodio.reset();
        episodioActual = null;
      }, 900);
    } catch (e) {
      console.error(e);
      editorEpisodio.estado("❌ Error al actualizar: " + e.message, true);
    }
  }
})();
