(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  function on(id, evento, fn) {
    const el = $(id);
    if (el) el.addEventListener(evento, fn);
  }

  const config = { url: window.SUPABASE_URL, key: window.SUPABASE_ANON_KEY };
  const configOk = config.url && !config.url.includes("PEGAR") && config.key && !config.key.includes("PEGAR");

  let db = null;
  if (!window.supabase) console.error("No se cargó Supabase.");
  else if (!configOk) console.error("Falta configurar js/config.js");
  else db = window.P21_DB || window.supabase.createClient(config.url, config.key);

  // ======================================================
  // SUBIDA Y BORRADO DE ARCHIVOS VÍA EL WORKER (BACKBLAZE B2)
  // ======================================================
  // nombreArchivo se pasa aparte porque los Blobs de grabación
  // (a diferencia de los File de un <input>) no tienen .name
  async function subirArchivoB2(blobOArchivo, nombreArchivo, folder) {
    if (!db) throw new Error("Falta configurar Supabase.");
    const { data: sesion } = await db.auth.getSession();
    const token = sesion && sesion.session && sesion.session.access_token;
    if (!token) throw new Error("Debes iniciar sesión para subir archivos.");

    const resp = await fetch(`${window.B2_WORKER_URL}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": blobOArchivo.type || "application/octet-stream",
        "X-Filename": nombreArchivo,
        "X-Folder": folder,
      },
      body: blobOArchivo,
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Error al subir archivo (${resp.status})`);
    }
    const { url } = await resp.json();
    return url;
  }

  async function borrarArchivoB2(publicUrl) {
    if (!publicUrl || !window.B2_WORKER_URL || !publicUrl.startsWith(window.B2_WORKER_URL)) return;
    if (!db) return;
    const { data: sesion } = await db.auth.getSession();
    const token = sesion && sesion.session && sesion.session.access_token;
    if (!token) return;
    const key = publicUrl.split("/file/")[1];
    if (!key) return;
    await fetch(`${window.B2_WORKER_URL}/file/${key}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  // ===== Claves de configuración persistente =====
  const LS = {
    loop: "p21_loop",
    sel: "p21_sel",
    last: "p21_last",
    vol: "p21_musicvol"
  };

  // ===== Estado general =====
  let audios = [];
  let musicas = [];
  let playlist = [];
  let indice = 0;
  let loopActivo = false;
  let iniciadoAuto = false;

  let ctx = null;

  // ===== Locutores (stream + cadena de procesamiento + analizador) =====
  const loc = {
    1: { stream: null, src: null, gain: null, gate: null, eqGraves: null, eqAgudos: null, compresor: null, limitador: null, an: null },
    2: { stream: null, src: null, gain: null, gate: null, eqGraves: null, eqAgudos: null, compresor: null, limitador: null, an: null }
  };

  // ===== Ajustes de la cadena de audio (edítalos aquí si hace falta afinar) =====
  const GANANCIA_ENTRADA = 2.5;       // ganancia general de cada locutor
  const UMBRAL_PUERTA_RUIDO = 0.02;   // ~ -34dB. Súbelo si deja pasar ruido de fondo; bájalo si corta la voz
  const PROFUNDIDAD_DUCKING = 0.08;   // cuánto volumen le queda a la música al hablar (0 = silencio total, 1 = no baja nada). 0.08 = casi inaudible.
  let workletListo = null;

  // ===== Grabación =====
  let rec = null;
  let chunks = [];
  let anMaster = null;
  let masterNode = null;
  let musicaConectada = false;
  let timerInt = null;
  let seg = 0;
  let pausado = false;

  // ===== Revisión previa =====
  let pendingBlob = null;
  let pendingDur = 0;

  // ===== Música local =====
  let musicPreview = null;
  let musicSrcNode = null;
  let musicGainNode = null;
  let musicAnalyser = null;

  // ===== Ducking =====
  let ultimaVoz = 0;

  // ======================================================
  // EVENTOS
  // ======================================================

  on("btnGrabar", "click", iniciarGrabacion);
  on("btnPausa", "click", pausarReanudar);
  on("btnDetener", "click", () => { if (rec && rec.state !== "inactive") rec.stop(); });

  on("btnGuardarPreview", "click", guardarPreview);
  on("btnDescartarPreview", "click", descartarPreview);

  on("btnMusica", "click", toggleMusica);
  on("btnQuitarMusica", "click", quitarMusicaLocal);
  on("musicaFile", "change", cargarMusicaLocal);
  on("musicaLoop", "change", () => { if (musicPreview) musicPreview.loop = $("musicaLoop").checked; });
  on("musicaVol", "input", () => {
    const v = parseFloat($("musicaVol").value);
    localStorage.setItem(LS.vol, String(v));
    // El valor real del gain lo aplica aplicarDucking() en el siguiente
    // cuadro (lee este mismo slider) — así solo hay un lugar escribiendo
    // el AudioParam, sin pisarse entre sí.
  });

  on("subirMusica", "change", subirMusicaDB);
  on("btnPlaySel", "click", reproducirSeleccion);
  on("btnLoopToggle", "click", toggleLoop);
  on("btnStop", "click", detenerReproduccion);
  on("btnActivarSonido", "click", activarSonido);
  on("btnActualizar", "click", () => cargarTodo());
  on("btnSalirAlAire", "click", iniciarTransmisionEnVivo);
  on("btnTerminarTransmision", "click", terminarTransmisionEnVivo);
  on("listaSeleccion", "change", () => { guardarSeleccionLocal(); guardarConfigRemota(); });

  on("editForm", "submit", guardarEdicion);
  on("categoria", "change", () => {
    const otra = $("categoriaOtra");
    if (!otra) return;
    otra.style.display = $("categoria").value === "__otra__" ? "block" : "none";
    if ($("categoria").value === "__otra__") otra.focus();
  });
  on("editCategoria", "change", () => {
    const otra = $("editCategoriaOtra");
    if (!otra) return;
    otra.style.display = $("editCategoria").value === "__otra__" ? "block" : "none";
    if ($("editCategoria").value === "__otra__") otra.focus();
  });
  on("btnCancelarEditar", "click", () => $("editModal").close());
  on("reproductor", "ended", alTerminarEpisodio);

  on("loc1Activo", "change", () => toggleLocutor(1));
  on("loc2Activo", "change", () => toggleLocutor(2));
  on("mic1", "change", async () => {
    if ($("loc1Activo").checked) { detenerLocutor(1); await asegurarLocutor(1); }
  });
  on("mic2", "change", async () => {
    if ($("loc2Activo").checked) { detenerLocutor(2); await asegurarLocutor(2); }
  });

  on("efecto1", "change", () => actualizarCadenaSalida(1));
  on("efecto2", "change", () => actualizarCadenaSalida(2));
  on("btnProbar1", "click", async () => { if (!loc[1].stream) await asegurarLocutor(1); toggleProbarVoz(1); });
  on("btnProbar2", "click", async () => { if (!loc[2].stream) await asegurarLocutor(2); toggleProbarVoz(2); });

  // Restaurar volumen de música guardado
  const volGuardado = localStorage.getItem(LS.vol);
  if (volGuardado && $("musicaVol")) $("musicaVol").value = volGuardado;

  cargarMics();
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener("devicechange", cargarMics);
  iniciarLoopSiempre();
  cargarTodo();

  function asegurarCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  // Carga (una sola vez) los módulos de audio personalizados: la puerta
  // de ruido y el cambiador de tono, como AudioWorklet. Se definen como
  // texto y se convierten en Blob para no necesitar archivos .js aparte.
  function cargarWorkletsAudio() {
    if (workletListo) return workletListo;
    const codigo = `
      class NoiseGateProcessor extends AudioWorkletProcessor {
        constructor(options) {
          super();
          const opts = options.processorOptions || {};
          this.threshold = opts.threshold || 0.02;
          this.attackMs = 10;
          this.releaseMs = 150;
          this.envelope = 0;
          this.gateOpen = 0;
        }
        process(inputs, outputs) {
          const input = inputs[0];
          const output = outputs[0];
          if (!input || !input[0]) return true;
          const inCh = input[0];
          const outCh = output[0];
          const attackCoef = Math.exp(-1 / (sampleRate * (this.attackMs / 1000)));
          const releaseCoef = Math.exp(-1 / (sampleRate * (this.releaseMs / 1000)));
          for (let i = 0; i < inCh.length; i++) {
            const sample = inCh[i];
            this.envelope = Math.max(Math.abs(sample), this.envelope * 0.999);
            const target = this.envelope > this.threshold ? 1 : 0;
            const coef = target > this.gateOpen ? attackCoef : releaseCoef;
            this.gateOpen = target + (this.gateOpen - target) * coef;
            outCh[i] = sample * this.gateOpen;
          }
          return true;
        }
      }
      registerProcessor("noise-gate-processor", NoiseGateProcessor);
    `;
    const blob = new Blob([codigo], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    workletListo = ctx.audioWorklet.addModule(url);
    return workletListo;
  }

  // ======================================================
  // "SONIDO DE LOCUTOR" (opcional, "Sonido normal" por defecto)
  // ======================================================
  // Equivalente construido con Web Audio nativo al combo que da el
  // sonido profesional de radio: EQ de presencia (3-5 kHz) + saturación
  // de cinta (calidez). Los plugins de pago mencionados (iZotope Nectar,
  // Waves, VoxessoR, Slate FG-X) son software de escritorio — no pueden
  // instalarse en una página web, pero esto persigue el mismo resultado.

  // Curva de saturación tipo cinta (equivalente casero a FerricTDS):
  // satura suavemente con tanh, dando calidez sin distorsión digital dura.
  function crearCurvaSaturacion(cantidad) {
    const n = 44100;
    const curva = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curva[i] = Math.tanh(cantidad * x) / Math.tanh(cantidad);
    }
    return curva;
  }

  function crearEfectoSaturacion(ctxAudio) {
    const entrada = ctxAudio.createGain();
    entrada.gain.value = 1.8; // empuja la señal hacia la curva
    const shaper = ctxAudio.createWaveShaper();
    shaper.curve = crearCurvaSaturacion(2.5);
    shaper.oversample = "4x";
    const salida = ctxAudio.createGain();
    salida.gain.value = 0.85; // compensa el volumen extra que mete la saturación
    entrada.connect(shaper);
    shaper.connect(salida);
    return { entrada, salida, extra: [shaper] };
  }

  // EQ gráfico simple tipo "presencia de locutor" (equivalente a Voxengo
  // Marvel GEQ para este uso): realza 3.5 kHz para claridad y un poco de
  // cuerpo en graves.
  function crearEfectoEQLocutor(ctxAudio) {
    const presencia = ctxAudio.createBiquadFilter();
    presencia.type = "peaking";
    presencia.frequency.value = 3500;
    presencia.Q.value = 1;
    presencia.gain.value = 4; // dB

    const calidezGraves = ctxAudio.createBiquadFilter();
    calidezGraves.type = "lowshelf";
    calidezGraves.frequency.value = 150;
    calidezGraves.gain.value = 2;

    presencia.connect(calidezGraves);
    return { entrada: presencia, salida: calidezGraves, extra: [] };
  }

  // Sonido de radio completo: EQ de presencia + saturación de cinta,
  // en cadena — el combo "EQ + compresión + saturación" que da el
  // timbre de locutor profesional (la compresión ya la aplica el
  // compresor/limitador que corre siempre, ver asegurarLocutor).
  function crearEfectoRadioProfesional(ctxAudio) {
    const eq = crearEfectoEQLocutor(ctxAudio);
    const sat = crearEfectoSaturacion(ctxAudio);
    eq.salida.connect(sat.entrada);
    return {
      entrada: eq.entrada,
      salida: sat.salida,
      extra: [eq.entrada, eq.salida, sat.entrada, sat.salida, ...sat.extra]
    };
  }

  const EFECTOS = {
    ninguno: null,
    radio: (c) => crearEfectoRadioProfesional(c),  // EQ + saturación (recomendado)
    saturacion: (c) => crearEfectoSaturacion(c),    // solo calidez
    eq: (c) => crearEfectoEQLocutor(c)              // solo presencia
  };

  let grabando = false;
  const monitoreando = { 1: false, 2: false };

  // Reconstruye lo que va DESPUÉS del limitador de un locutor: el efecto
  // elegido (si hay) y hacia dónde se conecta la salida (visualizador
  // siempre; grabación si está grabando; audífonos si está en modo prueba).
  function actualizarCadenaSalida(num) {
    const L = loc[num];
    if (!L.limitador || !ctx) return;

    if (L.efectoNodos) {
      L.efectoNodos.forEach(n => { try { n.disconnect(); } catch (e) {} });
    }
    try { L.limitador.disconnect(); } catch (e) {}

    const sel = $(`efecto${num}`);
    const tipo = sel ? sel.value : "ninguno";

    let ultimo = L.limitador;
    let nodosEfecto = [];

    if (tipo !== "ninguno" && EFECTOS[tipo]) {
      const construido = EFECTOS[tipo](ctx);
      ultimo.connect(construido.entrada);
      ultimo = construido.salida;
      nodosEfecto = [construido.entrada, construido.salida, ...(construido.extra || [])]
        .filter((v, i, a) => a.indexOf(v) === i);
    }

    L.efectoNodos = nodosEfecto;
    L.salidaFinal = ultimo;

    ultimo.connect(L.an);
    if (grabando && masterNode) ultimo.connect(masterNode);
    if (monitoreando[num]) ultimo.connect(ctx.destination);
  }

  function toggleProbarVoz(num) {
    monitoreando[num] = !monitoreando[num];
    const btn = $(`btnProbar${num}`);
    if (btn) btn.textContent = monitoreando[num] ? "🔇 Detener prueba" : "🎧 Probar (usa audífonos)";
    actualizarCadenaSalida(num);
  }

  // ======================================================
  // PERSISTENCIA DEL PLAYER
  // ======================================================

  function leerSeleccionGuardada() {
    try {
      const arr = JSON.parse(localStorage.getItem(LS.sel));
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }

  function guardarSeleccionLocal() {
    const marcados = [...document.querySelectorAll("#listaSeleccion input:checked")].map(c => c.value);
    localStorage.setItem(LS.sel, JSON.stringify(marcados));
  }

  async function guardarConfigRemota() {
    if (!db) return;
    const sel = [...document.querySelectorAll("#listaSeleccion input:checked")].map(c => c.value);
    const actual = playlist[indice];
    try {
      await db.from("config").upsert({
        id: "player",
        sel: sel,
        last: actual ? actual._tipo + ":" + actual.id : null,
        loop: loopActivo,
        actualizado_en: new Date().toISOString()
      });
    } catch (e) {
      console.error("No se pudo publicar la configuración:", e);
    }
  }

  function restaurarChecks() {
    const guardada = leerSeleccionGuardada();
    document.querySelectorAll("#listaSeleccion input").forEach(inp => {
      inp.checked = guardada.includes(inp.value);
    });
  }

  // ======================================================
  // LOCUTORES (con amplificación manual y constraints de estudio)
  // ======================================================

  async function toggleLocutor(num) {
    if ($(`loc${num}Activo`).checked) await asegurarLocutor(num);
    else detenerLocutor(num);
  }

  async function asegurarLocutor(num) {
    if (loc[num].stream) return;
    try {
      asegurarCtx();
      await cargarWorkletsAudio();

      const stream = await pedirMic($(`mic${num}`).value);
      const src = ctx.createMediaStreamSource(stream);

      // Ganancia de entrada — toda la amplificación vive aquí, ya que
      // el navegador no aplica su propio autoGainControl (ver pedirMic).
      const gain = ctx.createGain();
      gain.gain.value = GANANCIA_ENTRADA;

      // Puerta de ruido: silencia el micrófono cuando nadie habla,
      // para que no se cuele zumbido/ruido de fondo en los silencios.
      const gate = new AudioWorkletNode(ctx, "noise-gate-processor", {
        processorOptions: { threshold: UMBRAL_PUERTA_RUIDO }
      });

      // EQ ligero: un poco de cuerpo en graves y claridad en agudos.
      const eqGraves = ctx.createBiquadFilter();
      eqGraves.type = "lowshelf";
      eqGraves.frequency.value = 120;
      eqGraves.gain.value = 1;

      const eqAgudos = ctx.createBiquadFilter();
      eqAgudos.type = "highshelf";
      eqAgudos.frequency.value = 7000;
      eqAgudos.gain.value = 2;

      // Compresor: uniforma el volumen (acerca los picos altos y bajos).
      const compresor = ctx.createDynamicsCompressor();
      compresor.threshold.value = -24;
      compresor.knee.value = 30;
      compresor.ratio.value = 4;
      compresor.attack.value = 0.02;
      compresor.release.value = 0.25;

      // Limitador: tope duro contra saturación/clipping en gritos o picos.
      const limitador = ctx.createDynamicsCompressor();
      limitador.threshold.value = -3;
      limitador.knee.value = 0;
      limitador.ratio.value = 20;
      limitador.attack.value = 0.003;
      limitador.release.value = 0.1;

      const an = ctx.createAnalyser();
      an.fftSize = 512;

      src.connect(gain);
      gain.connect(gate);
      gate.connect(eqGraves);
      eqGraves.connect(eqAgudos);
      eqAgudos.connect(compresor);
      compresor.connect(limitador);
      // El final de la cadena (limitador → analizador/grabación/audífonos)
      // se conecta en actualizarCadenaSalida(), para poder insertar ahí
      // el efecto de voz elegido sin tener que reabrir el micrófono.

      loc[num] = { stream, src, gain, gate, eqGraves, eqAgudos, compresor, limitador, an, efectoNodos: [], salidaFinal: null };
      actualizarCadenaSalida(num);

      const track = stream.getAudioTracks()[0];
      const settings = track ? track.getSettings() : {};
      console.log(`Locutor ${num} conectado a:`, track && track.label, "deviceId:", settings.deviceId);
      cargarMics();
    } catch (e) {
      console.error(e);
      $(`loc${num}Activo`).checked = false;
      estadoGrabacion("No se pudo abrir el micrófono del locutor " + num + ".", true);
    }
  }

  function detenerLocutor(num) {
    const L = loc[num];
    if (L.stream) L.stream.getTracks().forEach(t => t.stop());
    try {
      if (L.src) L.src.disconnect();
      if (L.gain) L.gain.disconnect();
      if (L.gate) L.gate.disconnect();
      if (L.eqGraves) L.eqGraves.disconnect();
      if (L.eqAgudos) L.eqAgudos.disconnect();
      if (L.compresor) L.compresor.disconnect();
      if (L.limitador) L.limitador.disconnect();
      if (L.an) L.an.disconnect();
      if (L.efectoNodos) L.efectoNodos.forEach(n => { try { n.disconnect(); } catch (e) {} });
    } catch (e) {}
    monitoreando[num] = false;
    const btn = $(`btnProbar${num}`);
    if (btn) btn.textContent = "🎧 Probar (usa audífonos)";
    loc[num] = { stream: null, src: null, gain: null, gate: null, eqGraves: null, eqAgudos: null, compresor: null, limitador: null, an: null, efectoNodos: [], salidaFinal: null };
  }

  // ======================================================
  // DUCKING
  // ======================================================

  // Mide solo la banda de voz humana (300-3400Hz) en vez de todo el
  // volumen — así un ruido grave de fondo (motor de camión, tráfico)
  // no dispara el ducking como si alguien estuviera hablando.
  function nivelVozBanda(an) {
    if (!an || !ctx) return 0;
    const datos = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(datos);
    const nyquist = ctx.sampleRate / 2;
    const binHz = nyquist / datos.length;
    const iMin = Math.max(0, Math.floor(300 / binHz));
    const iMax = Math.min(datos.length - 1, Math.ceil(3400 / binHz));
    let suma = 0, n = 0;
    for (let i = iMin; i <= iMax; i++) { suma += datos[i]; n++; }
    return n ? (suma / n) / 255 : 0;
  }

  const UMBRAL_DUCKING = 0.15; // qué tan fuerte debe sonar la banda de voz para bajar la música. Súbelo si un ruido fuerte (camión, golpes) sigue bajando la música sin que nadie hable.

  function aplicarDucking() {
    if (!musicGainNode || !ctx) return;
    const nivel = Math.max(nivelVozBanda(loc[1].an), nivelVozBanda(loc[2].an));
    if (nivel > UMBRAL_DUCKING) ultimaVoz = Date.now();
    const conVoz = (Date.now() - ultimaVoz) < 800;
    const base = parseFloat($("musicaVol").value) || 0.5;
    const objetivo = conVoz ? base * PROFUNDIDAD_DUCKING : base;
    musicGainNode.gain.setTargetAtTime(objetivo, ctx.currentTime, 0.15);
  }

  function iniciarLoopSiempre() {
    const paso = () => {
      requestAnimationFrame(paso);
      dibujarBarras(loc[1].an, $("eq1"));
      dibujarBarras(loc[2].an, $("eq2"));
      dibujarRetro(musicAnalyser, $("eqMusica"));
      aplicarDucking();
      if (anMaster && rec && rec.state === "recording" && !pausado) {
        dibujarBarras(anMaster, $("eqMaster"));
      }
    };
    paso();
  }

  // ======================================================
  // CARGA + AUTO-INICIO
  // ======================================================

  async function cargarTodo() {
    await Promise.all([cargarAudios(), cargarMusicaDB()]);
    renderSeleccion();
    restaurarChecks();
    if (!iniciadoAuto) {
      iniciadoAuto = true;
      autoInicio();
    }
  }

  function autoInicio() {
    if (localStorage.getItem(LS.loop) === "1") {
      loopActivo = true;
      const btn = $("btnLoopToggle");
      if (btn) {
        btn.textContent = "🔁 Loop: ON";
        btn.classList.add("btn-gold");
        btn.classList.remove("btn-ghost");
      }
    }

    const selGuardada = leerSeleccionGuardada();
    playlist = selGuardada.length
      ? selGuardada.map(resolverItem).filter(Boolean)
      : listaCompleta();

    if (!playlist.length) {
      estadoReproduccion("Sin contenido todavía. Sube música o graba episodios.");
      return;
    }

    const ultimo = localStorage.getItem(LS.last);
    const idx = playlist.findIndex(p => (p._tipo + ":" + p.id) === ultimo);
    indice = idx >= 0 ? idx : 0;

    // Ya NO se reproduce solo al abrir la cabina — solo se deja listo
    // (fuente cargada) para que el usuario presione ▶ cuando quiera.
    const r = $("reproductor");
    r.src = playlist[indice].url;
    estadoReproduccion("Listo: " + playlist[indice].titulo + " — presiona ▶ Reproducir selección para sonar.");
  }

  // ======================================================
  // TRANSMISIÓN EN VIVO (Jitsi Meet, solo audio)
  // ======================================================
  // "Salir al aire" reutiliza tu grabación local de siempre (misma
  // limpieza de audio: puerta de ruido, EQ, compresor, limitador) — así
  // lo que se transmite en vivo también queda grabado, y al terminar
  // aparece la misma tarjeta de revisión para publicarlo con categoría,
  // portada, etc., exactamente como cualquier otro episodio.
  // Jitsi solo se usa para que la gente lo escuche en el momento; nunca
  // se activa video ni cámara, para ningún participante.

  async function iniciarTransmisionEnVivo() {
    if (!window.JITSI_ROOM) {
      estadoEnVivoUI("Falta configurar JITSI_ROOM en js/config.js.", true);
      return;
    }

    await iniciarGrabacion();
    if (!rec || rec.state === "inactive") return; // iniciarGrabacion falló (sin mic, sin título, etc.)

    // #config.startAudioOnly fuerza también tu propia ventana a solo-audio.
    // De cualquier forma: no actives tu cámara manualmente ahí dentro.
    window.open(
      `https://meet.jit.si/${encodeURIComponent(window.JITSI_ROOM)}#config.startAudioOnly=true`,
      "_blank",
      "noopener"
    );

    if (db) {
      const { error } = await db.from("config").upsert({
        id: "en_vivo",
        activa: true,
        iniciada_en: new Date().toISOString()
      });
      if (error) {
        estadoEnVivoUI("Grabando y transmitiendo, pero no se pudo avisar a los oyentes: " + error.message, true);
      }
    }

    const btnE = $("btnSalirAlAire");
    const btnT = $("btnTerminarTransmision");
    if (btnE) btnE.disabled = true;
    if (btnT) btnT.disabled = false;
    estadoEnVivoUI("🔴 EN VIVO — hablando y grabando a la vez. No actives tu cámara en la ventana de Jitsi. Presiona \"Terminar transmisión\" cuando acabes.");
  }

  async function terminarTransmisionEnVivo() {
    if (rec && rec.state !== "inactive") rec.stop(); // dispara el mismo flujo que "Detener y guardar"

    if (db) {
      const { error } = await db.from("config").upsert({ id: "en_vivo", activa: false });
      if (error) {
        estadoEnVivoUI("Transmisión detenida, pero hubo un error avisando a los oyentes: " + error.message, true);
      } else {
        estadoEnVivoUI("Transmisión finalizada. Revisa la grabación abajo para publicarla. Ya puedes cerrar la ventana de Jitsi.");
      }
    }

    const btnE = $("btnSalirAlAire");
    const btnT = $("btnTerminarTransmision");
    if (btnE) btnE.disabled = false;
    if (btnT) btnT.disabled = true;
  }

  function estadoEnVivoUI(t, err) {
    const el = $("estadoEnVivo");
    if (!el) return;
    el.textContent = t;
    el.classList.toggle("error", !!err);
  }

  function activarSonido() {
    const r = $("reproductor");
    r.muted = false;
    $("avisoSonido").classList.add("oculto");
    estadoReproduccion("🔊 Sonido activado.");
  }

  // ======================================================
  // BIBLIOTECA DE MÚSICA
  // ======================================================

  async function cargarMusicaDB() {
    if (!db) return;
    const { data, error } = await db.from("musica").select("*").order("creado_en", { ascending: false });
    if (!error) musicas = data || [];
  }

  async function subirMusicaDB() {
    const files = [...$("subirMusica").files];
    if (!files.length || !db) return;

    estadoReproduccion("📤 Subiendo música a la biblioteca...");

    for (const f of files) {
      const base = f.name.replace(/\.[^.]+$/, "");
      const nombre = `${Date.now()}-${slug(base)}.${extDesdeNombre(f.name)}`;

      let urlMusica;
      try {
        urlMusica = await subirArchivoB2(f, nombre, "musica");
      } catch (errUp) {
        console.error(errUp);
        continue;
      }

      await db.from("musica").insert({
        titulo: base,
        archivo: nombre,
        url: urlMusica
      });
    }

    $("subirMusica").value = "";
    estadoReproduccion("✅ Música guardada. Ya no se pierde al recargar.");
    await cargarMusicaDB();
    renderSeleccion();
    restaurarChecks();
  }

  async function borrarMusicaDB(id) {
    const item = musicas.find(m => m.id === id);
    if (!item || !confirm(`¿Eliminar "${item.titulo}" de la biblioteca?`)) return;

    if (item.url && window.B2_WORKER_URL && item.url.startsWith(window.B2_WORKER_URL)) {
      await borrarArchivoB2(item.url);
    } else if (item.archivo) {
      // Archivo viejo, subido antes de la migración a B2
      await db.storage.from("musica").remove([item.archivo]);
    }

    await db.from("musica").delete().eq("id", id);
    await cargarMusicaDB();
    renderSeleccion();
    restaurarChecks();
    estadoReproduccion("🗑 Pista eliminada de la biblioteca.");
  }

  // ======================================================
  // SELECCIÓN MIXTA
  // ======================================================

  function renderSeleccion() {
    const cont = $("listaSeleccion");
    if (!cont) return;
    cont.innerHTML = "";

    const g1 = document.createElement("div");
    g1.className = "grupo-titulo";
    g1.textContent = "🎵 Música";
    cont.appendChild(g1);

    if (!musicas.length) cont.appendChild(pSmall("Sin música subida. Usa 📤 Subir MP3."));
    musicas.forEach(m => {
      const fila = document.createElement("div");
      fila.className = "sel-item";
      fila.innerHTML = `<label class="sel-label"><input type="checkbox" value="m:${m.id}" /> <span>🎵 ${m.titulo}</span></label>`;
      const b = document.createElement("button");
      b.className = "btn btn-mini btn-del";
      b.textContent = "🗑";
      b.title = "Eliminar de la biblioteca";
      b.onclick = () => borrarMusicaDB(m.id);
      fila.appendChild(b);
      cont.appendChild(fila);
    });

    const g2 = document.createElement("div");
    g2.className = "grupo-titulo";
    g2.textContent = "🎙️ Episodios";
    cont.appendChild(g2);

    if (!audios.length) cont.appendChild(pSmall("Sin episodios todavía."));
    audios.forEach(a => cont.appendChild(itemSel("e:" + a.id, a.titulo)));
  }

  function itemSel(valor, texto) {
    const label = document.createElement("label");
    label.className = "sel-item";
    label.innerHTML = `<input type="checkbox" value="${valor}" /> <span>${texto}</span>`;
    return label;
  }

  function pSmall(t) {
    const p = document.createElement("p");
    p.className = "small";
    p.style.margin = "4px 0";
    p.textContent = t;
    return p;
  }

  function resolverItem(valor) {
    const tipo = valor.slice(0, 1);
    const id = valor.slice(2);
    if (tipo === "m") {
      const m = musicas.find(x => x.id === id);
      return m ? { ...m, _tipo: "m" } : null;
    }
    const e = audios.find(x => x.id === id);
    return e ? { ...e, _tipo: "e" } : null;
  }

  function listaCompleta() {
    return [
      ...musicas.map(m => ({ ...m, _tipo: "m" })),
      ...audios.map(a => ({ ...a, _tipo: "e" }))
    ];
  }

  function reproducirSeleccion() {
    const marcados = [...document.querySelectorAll("#listaSeleccion input:checked")].map(c => c.value);
    localStorage.setItem(LS.sel, JSON.stringify(marcados));

    playlist = marcados.length
      ? marcados.map(resolverItem).filter(Boolean)
      : listaCompleta();

    if (!playlist.length) { estadoReproduccion("No hay contenido para reproducir.", true); return; }

    indice = 0;
    reproducirActual();
    guardarConfigRemota();
  }

  function toggleLoop() {
    loopActivo = !loopActivo;
    localStorage.setItem(LS.loop, loopActivo ? "1" : "0");
    guardarConfigRemota();
    const btn = $("btnLoopToggle");
    btn.textContent = loopActivo ? "🔁 Loop: ON" : "🔁 Loop: OFF";
    btn.classList.toggle("btn-gold", loopActivo);
    btn.classList.toggle("btn-ghost", !loopActivo);
  }

  function alTerminarEpisodio() {
    if (!playlist.length) return;
    if (loopActivo) {
      indice = (indice + 1) % playlist.length;
      reproducirActual();
    } else if (indice < playlist.length - 1) {
      indice++;
      reproducirActual();
    } else {
      estadoReproduccion("Fin de la selección.");
    }
  }

  function reproducirActual() {
    const item = playlist[indice];
    if (!item) return;
    localStorage.setItem(LS.last, item._tipo + ":" + item.id);
    guardarConfigRemota();
    const r = $("reproductor");
    r.src = item.url;
    r.play().catch(() => {});
    estadoReproduccion(`Sonando: ${item.titulo}`);
  }

  function reproducirUno(id) {
    const item = audios.find(a => a.id === id);
    if (!item) return;
    playlist = [{ ...item, _tipo: "e" }];
    indice = 0;
    reproducirActual();
  }

  function detenerReproduccion() {
    const r = $("reproductor");
    r.pause();
    r.removeAttribute("src");
    r.load();
    estadoReproduccion("Detenido.");
  }

  // ======================================================
  // MICRÓFONOS
  // ======================================================

  async function cargarMics() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter(d => d.kind === "audioinput");
      ["mic1", "mic2"].forEach(id => {
        const sel = $(id);
        const val = sel.value;
        sel.innerHTML = '<option value="">Micrófono predeterminado</option>';
        mics.forEach((m, i) => {
          sel.innerHTML += `<option value="${m.deviceId}">${m.label || "Micrófono " + (i + 1)}</option>`;
        });
        sel.value = val;
      });
    } catch (e) { console.error(e); }
  }

  // Constraints de estudio: sin supresión de ruido, eco NI autoGainControl
  // (recortan la voz o compiten con la ganancia manual que ya aplicamos
  // más abajo con gain.gain.value). Toda la ganancia queda en un solo
  // lugar, así los dos locutores se comportan igual entre sí.
  async function pedirMic(deviceId) {
    const base = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };
    try {
      if (deviceId) {
        return await navigator.mediaDevices.getUserMedia({
          audio: Object.assign({ deviceId: { exact: deviceId } }, base)
        });
      }
      return await navigator.mediaDevices.getUserMedia({ audio: base });
    } catch (e) {
      console.warn("Constraints completas fallaron, reintentando simple:", e && e.name);
      return await navigator.mediaDevices.getUserMedia({ audio: true });
    }
  }

  // ======================================================
  // MÚSICA LOCAL
  // ======================================================

  function cargarMusicaLocal() {
    const f = $("musicaFile").files[0];
    if (!f) return;

    if (musicPreview) musicPreview.pause();
    musicPreview = new Audio(URL.createObjectURL(f));
    musicPreview.volume = 1;
    musicPreview.loop = $("musicaLoop").checked;

    if (musicSrcNode) {
      try { musicSrcNode.disconnect(); musicGainNode.disconnect(); musicAnalyser.disconnect(); } catch (e) {}
      musicSrcNode = musicGainNode = musicAnalyser = null;
    }
    if (ctx) construirGraficoMusica();

    $("musicaNombre").textContent = "🎵 " + f.name;
    $("btnMusica").disabled = false;
    $("btnMusica").textContent = "▶ Música";
    $("btnQuitarMusica").disabled = false;
  }

  function construirGraficoMusica() {
    if (!ctx || !musicPreview || musicSrcNode) return;
    musicSrcNode = ctx.createMediaElementSource(musicPreview);
    musicGainNode = ctx.createGain();
    musicGainNode.gain.value = parseFloat($("musicaVol").value);
    musicAnalyser = ctx.createAnalyser();
    musicAnalyser.fftSize = 64;
    musicSrcNode.connect(musicGainNode);
    musicGainNode.connect(musicAnalyser);
    musicAnalyser.connect(ctx.destination);
  }

  function toggleMusica() {
    if (!musicPreview) return;
    if (musicPreview.paused) {
      asegurarCtx();
      construirGraficoMusica();
      musicPreview.play();
      $("btnMusica").textContent = "⏸ Música";
    } else {
      musicPreview.pause();
      $("btnMusica").textContent = "▶ Música";
    }
  }

  function quitarMusicaLocal() {
    if (musicPreview) musicPreview.pause();
    musicPreview = null;
    if (musicSrcNode) {
      try { musicSrcNode.disconnect(); musicGainNode.disconnect(); musicAnalyser.disconnect(); } catch (e) {}
      musicSrcNode = musicGainNode = musicAnalyser = null;
    }
    $("musicaFile").value = "";
    $("musicaNombre").textContent = "Sin pista cargada";
    $("btnMusica").disabled = true;
    $("btnMusica").textContent = "▶ Música";
    $("btnQuitarMusica").disabled = true;
  }

  // ======================================================
  // ECUALIZADORES
  // ======================================================

  function dibujarRetro(an, canvas) {
    if (!canvas) return;
    const c2 = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    c2.clearRect(0, 0, W, H);
    const bars = 20, segs = 12;
    const bw = W / bars, segH = H / segs;
    let data = null;
    if (an) {
      data = new Uint8Array(an.frequencyBinCount);
      an.getByteFrequencyData(data);
    }
    const step = data ? Math.max(1, Math.floor(data.length / bars)) : 1;
    for (let i = 0; i < bars; i++) {
      const v = data ? data[i * step] / 255 : 0;
      const lit = Math.round(v * segs);
      for (let s = 0; s < segs; s++) {
        const y = H - (s + 1) * segH;
        c2.fillStyle = s < lit
          ? (s < 6 ? "#39d353" : s < 9 ? "#ffd300" : "#ff4136")
          : "rgba(255,255,255,0.06)";
        c2.fillRect(i * bw + 2, y + 1, bw - 4, segH - 2);
      }
    }
  }

  function dibujarBarras(an, canvas) {
    if (!an || !canvas) return;
    const data = new Uint8Array(an.frequencyBinCount);
    an.getByteFrequencyData(data);
    const c2 = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    c2.clearRect(0, 0, W, H);
    const bars = 24;
    const step = Math.max(1, Math.floor(data.length / bars));
    const bw = W / bars;
    for (let i = 0; i < bars; i++) {
      const v = data[i * step] / 255;
      const h = Math.max(2, v * H);
      c2.fillStyle = v > 0.7 ? "#e05252" : "#e3b64f";
      c2.fillRect(i * bw + 1, H - h, bw - 2, h);
    }
  }

  // ======================================================
  // GRABACIÓN
  // ======================================================

  async function iniciarGrabacion() {
    const titulo = $("titulo").value.trim();
    if (!titulo) { estadoGrabacion("Escribe un título.", true); return; }
    if (!db) { estadoGrabacion("Falta configurar Supabase.", true); return; }

    const loc1 = $("loc1Activo").checked;
    const loc2 = $("loc2Activo").checked;
    if (!loc1 && !loc2) { estadoGrabacion("Activa al menos un locutor.", true); return; }

    estadoGrabacion("Preparando sesión...");

    try {
      asegurarCtx();

      if (loc1) await asegurarLocutor(1);
      if (loc2) await asegurarLocutor(2);

      // Aviso si ambos locutores quedaron en el mismo micrófono
      if (loc1 && loc2 && loc[1].stream && loc[2].stream) {
        const t1 = loc[1].stream.getAudioTracks()[0];
        const t2 = loc[2].stream.getAudioTracks()[0];
        const id1 = t1 && t1.getSettings().deviceId;
        const id2 = t2 && t2.getSettings().deviceId;
        if (id1 && id1 === id2) {
          estadoGrabacion("⚠️ Ojo: los dos locutores están usando el mismo micrófono.");
        }
      }

      masterNode = ctx.createGain();
      anMaster = ctx.createAnalyser(); anMaster.fftSize = 64;
      const dest = ctx.createMediaStreamDestination();
      masterNode.connect(anMaster);
      masterNode.connect(dest);

      // Conectamos la salida YA PROCESADA (gate → EQ → compresor → limitador → efecto opcional)
      grabando = true;
      if (loc1) actualizarCadenaSalida(1);
      if (loc2) actualizarCadenaSalida(2);

      musicaConectada = false;
      if ($("musicaIncluir").checked) {
        if (!musicSrcNode && musicPreview) construirGraficoMusica();
        if (musicGainNode) {
          musicGainNode.connect(masterNode);
          musicaConectada = true;
        }
        // Bug corregido: antes la música solo sonaba si habías presionado
        // ▶ Música a mano; si solo la cargabas y dabas Grabar directo,
        // se conectaba al grafo pero nunca empezaba a reproducirse, así
        // que la grabación quedaba sin música. Ahora se auto-reproduce.
        if (musicPreview && musicPreview.paused) {
          musicPreview.play().catch(() => {});
          const btnM = $("btnMusica");
          if (btnM) btnM.textContent = "⏸ Música";
        }
      }

      chunks = [];
      rec = new MediaRecorder(dest.stream);
      rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      rec.onstop = () => {
        const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
        const dur = seg;
        limpiarSesion();
        setUIGrabacion("idle");
        mostrarPreview(blob, dur);
        estadoGrabacion("🎧 Escucha tu grabación y decide si publicarla.");
      };

      rec.start();
      seg = 0; pausado = false;
      iniciarTimer();
      setUIGrabacion("grabando");
      estadoGrabacion("Grabando sesión...");
    } catch (error) {
      console.error(error);
      limpiarSesion();
      setUIGrabacion("idle");
      estadoGrabacion(error.name === "NotAllowedError"
        ? "Permiso de micrófono denegado."
        : "Error al iniciar la sesión de grabación.", true);
    }
  }

  function pausarReanudar() {
    if (!rec) return;
    if (!pausado) {
      rec.pause();
      pausado = true;
      clearInterval(timerInt);
      $("btnPausa").textContent = "▶ Reanudar";
      estadoGrabacion("Grabación en pausa.");
    } else {
      rec.resume();
      pausado = false;
      iniciarTimer();
      $("btnPausa").textContent = "⏸ Pausa";
      estadoGrabacion("Grabando sesión...");
    }
  }

  // ======================================================
  // REVISIÓN PREVIA ANTES DE PUBLICAR
  // ======================================================

  function mostrarPreview(blob, dur) {
    pendingBlob = blob;
    pendingDur = dur;
    const card = $("previewCard");
    const aud = $("previewAudio");
    if (!card || !aud) return;
    aud.src = URL.createObjectURL(blob);
    card.style.display = "block";
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function ocultarPreview() {
    pendingBlob = null;
    pendingDur = 0;
    const card = $("previewCard");
    const aud = $("previewAudio");
    if (aud) { aud.pause(); aud.removeAttribute("src"); aud.load(); }
    if (card) card.style.display = "none";
  }

  async function guardarPreview() {
    if (!pendingBlob) return;
    const blob = pendingBlob;
    const dur = pendingDur;
    ocultarPreview();
    estadoGrabacion("Subiendo y guardando episodio...");
    await subirAudio(blob, dur);
  }

  function descartarPreview() {
    ocultarPreview();
    estadoGrabacion("🗑 Grabación descartada. Puedes grabar de nuevo.");
  }

  // ======================================================
  // LIMPIEZA DE SESIÓN
  // ======================================================

  function limpiarSesion() {
    grabando = false;
    if (loc[1].stream) actualizarCadenaSalida(1);
    if (loc[2].stream) actualizarCadenaSalida(2);
    try { if (musicaConectada && musicGainNode && masterNode) musicGainNode.disconnect(masterNode); } catch (e) {}
    musicaConectada = false;

    // La música de fondo se auto-reproducía al grabar; ahora se
    // detiene sola al terminar la sesión (Detener y guardar).
    if (musicPreview && !musicPreview.paused) {
      musicPreview.pause();
      const btnM = $("btnMusica");
      if (btnM) btnM.textContent = "▶ Música";
    }

    if (timerInt) clearInterval(timerInt);
    anMaster = null;
    masterNode = null;
    const c = $("eqMaster");
    if (c) c.getContext("2d").clearRect(0, 0, c.width, c.height);
  }

  function setUIGrabacion(modo) {
    if (modo === "grabando") {
      $("btnGrabar").disabled = true;
      $("btnGrabar").classList.add("recording");
      $("btnPausa").disabled = false;
      $("btnDetener").disabled = false;
    } else {
      $("btnGrabar").disabled = false;
      $("btnGrabar").classList.remove("recording");
      $("btnPausa").disabled = true;
      $("btnPausa").textContent = "⏸ Pausa";
      $("btnDetener").disabled = true;
      $("timer").textContent = "00:00";
    }
  }

  function iniciarTimer() {
    clearInterval(timerInt);
    timerInt = setInterval(() => {
      seg++;
      const m = String(Math.floor(seg / 60)).padStart(2, "0");
      const s = String(seg % 60).padStart(2, "0");
      $("timer").textContent = `${m}:${s}`;
    }, 1000);
  }

  // ======================================================
  // GUARDAR EPISODIO (subida vía B2, no Supabase Storage)
  // ======================================================

  function leerCategoria(idSelect, idOtra) {
    const sel = $(idSelect);
    if (!sel) return "General";
    if (sel.value === "__otra__") {
      const otra = $(idOtra);
      return (otra && otra.value.trim()) || "General";
    }
    return sel.value || "General";
  }

  async function subirAudio(blob, duracionSeg) {
    try {
      const titulo = $("titulo").value.trim();
      const alumno = $("alumno").value.trim() || "Anónimo";
      const descripcion = $("descripcion").value.trim();
      const categoria = leerCategoria("categoria", "categoriaOtra");
      const temporada = $("temporada").value.trim() || "Temporada 1 - 2026";
      const destacado = $("destacado").checked;
      const archivoImg = $("imagen").files[0];

      const extension = extensionDesdeBlob(blob);
      const archivo = `${Date.now()}-${slug(titulo)}.${extension}`;

      let urlAudio;
      try {
        urlAudio = await subirArchivoB2(blob, archivo, "audios");
      } catch (e1) {
        estadoGrabacion("Error al subir audio: " + e1.message, true);
        return;
      }

      let urlImagen = "";
      if (archivoImg) {
        const nombreImg = `${Date.now()}-${slug(titulo)}.jpg`;
        try {
          urlImagen = await subirArchivoB2(archivoImg, nombreImg, "portadas");
        } catch (eImg) {
          console.error("Error de portada:", eImg);
        }
      }

      const { error: err2 } = await db.from("audios").insert({
        titulo, alumno, descripcion, categoria, temporada, destacado,
        archivo, url: urlAudio, imagen: urlImagen,
        publicado: true, duracion: duracionSeg || 0
      });

      if (err2) { estadoGrabacion("Error al guardar.", true); return; }

      estadoGrabacion("✅ Episodio guardado correctamente.");
      ["titulo", "alumno", "descripcion"].forEach(id => $(id).value = "");
      $("imagen").value = "";
      $("destacado").checked = false;

      await cargarTodo();
    } catch (error) {
      console.error(error);
      estadoGrabacion("Error al guardar.", true);
    }
  }

  // ======================================================
  // TABLA / EDITAR / BORRAR
  // ======================================================

  async function cargarAudios() {
    if (!db) return;
    const { data, error } = await db.from("audios").select("*").order("creado_en", { ascending: false });
    if (error) { estadoGrabacion("Error al cargar: " + error.message, true); return; }
    audios = data || [];
    renderTabla();
  }

  function renderTabla() {
    const tbody = $("tablaAudios");
    if (!tbody) return;
    tbody.innerHTML = "";
    if (!audios.length) {
      tbody.innerHTML = "<tr><td colspan='5'>No hay episodios.</td></tr>";
      return;
    }
    audios.forEach(item => {
      const publicado = item.publicado !== false;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${item.titulo}</td>
        <td>${item.alumno || "Anónimo"}</td>
        <td><span class="temporada-badge">🗓️ ${item.temporada || "Temporada 1 - 2026"}</span></td>
        <td><span class="badge ${publicado ? "badge-on" : "badge-off"}">${publicado ? "Publicado" : "Oculto"}</span></td>
      `;
      const tdA = document.createElement("td");
      const acc = document.createElement("div");
      acc.className = "acciones";
      acc.appendChild(btnMini("Escuchar", "btn-blue", () => reproducirUno(item.id)));
      acc.appendChild(btnMini("Editar", "btn-edit", () => abrirEditar(item.id)));
      acc.appendChild(btnMini(publicado ? "Ocultar" : "Publicar", publicado ? "btn-hide" : "btn-pub", () => togglePublicar(item.id)));
      acc.appendChild(btnMini("Borrar", "btn-del", () => borrarAudio(item.id)));
      tdA.appendChild(acc);
      tr.appendChild(tdA);
      tbody.appendChild(tr);
    });
  }

  function btnMini(texto, clase, onclick) {
    const b = document.createElement("button");
    b.textContent = texto;
    b.className = "btn btn-mini " + clase;
    b.onclick = onclick;
    return b;
  }

  const CATEGORIAS_FIJAS = ["General", "Noticias", "Entrevistas", "Cultura", "Deportes", "Ciencia"];

  function abrirEditar(id) {
    const item = audios.find(a => a.id === id);
    if (!item) return;
    $("editId").value = item.id;
    $("editTitulo").value = item.titulo;
    $("editAlumno").value = item.alumno || "";
    $("editDescripcion").value = item.descripcion || "";

    const cat = item.categoria || "General";
    const otra = $("editCategoriaOtra");
    if (CATEGORIAS_FIJAS.includes(cat)) {
      $("editCategoria").value = cat;
      if (otra) { otra.style.display = "none"; otra.value = ""; }
    } else {
      $("editCategoria").value = "__otra__";
      if (otra) { otra.style.display = "block"; otra.value = cat; }
    }

    $("editTemporada").value = item.temporada || "Temporada 1 - 2026";
    $("editModal").showModal();
  }

  async function guardarEdicion(event) {
    event.preventDefault();
    const id = $("editId").value;
    const titulo = $("editTitulo").value.trim();
    const alumno = $("editAlumno").value.trim() || "Anónimo";
    const descripcion = $("editDescripcion").value.trim();
    const categoria = leerCategoria("editCategoria", "editCategoriaOtra");
    const temporada = $("editTemporada").value.trim() || "Temporada 1 - 2026";
    const archivoImg = $("editImagen").files[0];

    if (!titulo) { alert("Título vacío."); return; }

    let urlImagen = undefined;
    if (archivoImg) {
      const nombreImg = `${Date.now()}-edit.jpg`;
      try {
        urlImagen = await subirArchivoB2(archivoImg, nombreImg, "portadas");
      } catch (e) {
        console.error(e);
      }
    }

    const update = { titulo, alumno, descripcion, categoria, temporada };
    if (urlImagen) update.imagen = urlImagen;

    const { error } = await db.from("audios").update(update).eq("id", id);
    if (error) { alert("Error: " + error.message); return; }

    $("editModal").close();
    await cargarTodo();
  }

  async function togglePublicar(id) {
    const item = audios.find(a => a.id === id);
    if (!item) return;
    await db.from("audios").update({ publicado: !(item.publicado !== false) }).eq("id", id);
    await cargarTodo();
  }

  async function borrarAudio(id) {
    const item = audios.find(a => a.id === id);
    if (!item || !confirm(`¿Borrar "${item.titulo}"?`)) return;

    if (item.url && window.B2_WORKER_URL && item.url.startsWith(window.B2_WORKER_URL)) {
      await borrarArchivoB2(item.url);
    } else if (item.archivo) {
      // Archivo viejo, subido antes de la migración a B2
      await db.storage.from("audios").remove([item.archivo]);
    }

    await db.from("audios").delete().eq("id", id);
    detenerReproduccion();
    await cargarTodo();
  }

  // ======================================================
  // UTILIDADES
  // ======================================================

  function estadoGrabacion(t, err) {
    const el = $("estadoGrabacion");
    if (!el) return;
    el.textContent = t;
    el.classList.toggle("error", !!err);
  }

  function estadoReproduccion(t, err) {
    const el = $("estadoReproduccion");
    if (!el) return;
    el.textContent = t;
    el.classList.toggle("error", !!err);
  }

  function slug(t) {
    return t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "audio";
  }

  function extensionDesdeBlob(b) {
    if (!b || !b.type) return "webm";
    if (b.type.includes("mp4")) return "mp4";
    if (b.type.includes("ogg")) return "ogg";
    if (b.type.includes("mpeg")) return "mp3";
    return "webm";
  }

  function extDesdeNombre(n) {
    const m = n.match(/\.([a-z0-9]+)$/i);
    return m ? m[1].toLowerCase() : "mp3";
  }
})();
