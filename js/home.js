(function () {
  "use strict";

  const db = window.P21_DB;
  if (!db) return;

  const $ = (id) => document.getElementById(id);

  const audio = $("pmAudio");
  const titulo = $("pmTitulo");
  const meta = $("pmMeta");
  const btnPrev = $("pmPrev");
  const btnPlay = $("pmPlay");
  const btnNext = $("pmNext");
  const btnMute = $("pmMute");
  const aviso = $("pmAviso");
  const gif = $("pmGif");

  let todas = [];
  let playlist = [];
  let indice = 0;
  let loopActivo = false;
  let desbloqueoActivo = false;

  // ===== Estado de transmisión en vivo =====
  let enVivo = false;
  let jitsiApi = null;
  let jitsiConectado = false;

  cargar();
  revisarEnVivo();
  setInterval(revisarEnVivo, 5000);
  try {
    db.channel("home-en-vivo")
      .on("postgres_changes", { event: "*", schema: "public", table: "config", filter: "id=eq.en_vivo" }, revisarEnVivo)
      .subscribe();
  } catch (e) {
    console.warn("Realtime no disponible, usando solo el sondeo cada 5s:", e);
  }

  // ======================================================
  // EN VIVO — detección + audio oculto (nunca se muestra nada de Jitsi)
  // ======================================================

  async function revisarEnVivo() {
    const { data, error } = await db.from("config").select("*").eq("id", "en_vivo").maybeSingle();
    if (error) return;
    const activa = !!(data && data.activa);
    if (activa && !enVivo) entrarModoEnVivo();
    else if (!activa && enVivo) salirModoEnVivo();
  }

  function entrarModoEnVivo() {
    enVivo = true;
    audio.pause();
    setGif(false);
    setVibracion(false);
    btnPrev.disabled = true;
    btnNext.disabled = true;
    titulo.textContent = "🔴 EN VIVO AHORA";
    meta.textContent = "Toca 🔊 para escuchar la transmisión";
    btnPlay.disabled = false;
    btnMute.disabled = false;
    btnPlay.textContent = "▶";
    btnMute.textContent = "🔇";
  }

  function salirModoEnVivo() {
    enVivo = false;
    desconectarJitsi();
    titulo.textContent = "Cargando contenido…";
    meta.textContent = "";
    cargar(); // retoma el bucle de música/episodios donde estaba antes
  }

  // Crea la conexión de Jitsi COMPLETAMENTE oculta (1x1px, invisible) —
  // solo para recibir el audio; nunca se ve nada de Jitsi en pantalla,
  // y el audio-only del lado del oyente hace que ni siquiera se pida
  // cámara/micrófono propios.
  function conectarJitsi() {
    if (jitsiConectado || !window.JITSI_ROOM) {
      console.warn("Podcast21 en vivo: no se pudo iniciar conexión.", { jitsiConectado, JITSI_ROOM: window.JITSI_ROOM });
      meta.textContent = "No se pudo conectar (revisa la consola del navegador).";
      return;
    }
    jitsiConectado = true;

    // PRUEBA: en vez de incrustarlo en un iframe (que se queda atorado,
    // probablemente por restricciones del navegador a terceros dentro de
    // un iframe), lo abrimos como pestaña propia — igual que ya funciona
    // para el locutor. Solo audio (startAudioOnly), sin barra de
    // herramientas, sin marca de agua.
    const params = [
      "config.prejoinPageEnabled=false",
      "config.startWithAudioMuted=true",
      "config.startWithVideoMuted=true",
      "config.startAudioOnly=true",
      "config.disableModeratorIndicator=true",
      "interfaceConfig.TOOLBAR_BUTTONS=[]",
      "interfaceConfig.SHOW_JITSI_WATERMARK=false"
    ].join("&");
    const url = `https://meet.jit.si/${encodeURIComponent(window.JITSI_ROOM)}#${params}`;

    jitsiApi = window.open(url, "podcast21_en_vivo", "width=340,height=220");
    if (!jitsiApi) {
      meta.textContent = "Tu navegador bloqueó la ventana emergente. Permite pop-ups para este sitio e intenta de nuevo.";
      jitsiConectado = false;
      return;
    }

    titulo.textContent = "🔴 EN VIVO AHORA";
    meta.textContent = "🔊 Escuchando en una ventana aparte (sin cámara, solo audio).";
    btnPlay.textContent = "⏸";
    btnMute.textContent = "🔊";
    aviso.classList.add("oculto");
  }

  function desconectarJitsi() {
    if (jitsiApi) {
      try { jitsiApi.close(); } catch (e) {}
      jitsiApi = null;
    }
    jitsiConectado = false;
    if (enVivo) {
      titulo.textContent = "🔴 EN VIVO AHORA";
      meta.textContent = "Toca 🔊 para escuchar la transmisión";
      btnPlay.textContent = "▶";
      btnMute.textContent = "🔇";
    }
  }

  // ===== Carga contenido + programación de la cabina (bucle normal) =====
  async function cargar() {
    try {
      const [rAud, rMus, rCfg] = await Promise.all([
        db.from("audios").select("*").eq("publicado", true).order("creado_en", { ascending: false }),
        db.from("musica").select("*").order("creado_en", { ascending: false }),
        db.from("config").select("*").eq("id", "player").maybeSingle()
      ]);

      const episodios = rAud.data || [];
      const musicas = rMus.data || [];

      todas = [
        ...musicas.map(m => ({ ...m, _tipo: "m" })),
        ...episodios.map(e => ({ ...e, _tipo: "e" }))
      ];

      const cfg = rCfg.data;

      // Playlist = selección de cabina; si no hay, todo el contenido
      playlist = (cfg && Array.isArray(cfg.sel) && cfg.sel.length)
        ? cfg.sel.map(resolver).filter(Boolean)
        : todas.slice();

      if (enVivo) return; // no pises la UI de "en vivo" con la del bucle normal

      if (!playlist.length) {
        titulo.textContent = "Aún no hay contenido";
        meta.textContent = "Sube música o graba episodios desde la cabina 🎙️";
        return;
      }

      loopActivo = !!(cfg && cfg.loop);

      // Arranca en la pista que la cabina dejó sonando
      const idx = playlist.findIndex(p => (p._tipo + ":" + p.id) === (cfg && cfg.last));
      indice = idx >= 0 ? idx : 0;

      btnPrev.disabled = false;
      btnPlay.disabled = false;
      btnNext.disabled = false;
      btnMute.disabled = false;

      audio.muted = true;
      setGif(true);
      setVibracion(true);
      cargarPista(indice, true);
    } catch (e) {
      console.error(e);
      if (!enVivo) {
        titulo.textContent = "Error al cargar";
        meta.textContent = e.message;
      }
    }
  }

  function resolver(valor) {
    const tipo = valor.slice(0, 1);
    const id = valor.slice(2);
    return todas.find(x => x._tipo === tipo && x.id === id) || null;
  }

  function cargarPista(n, reproducir) {
    if (enVivo) return;
    indice = n;
    const item = playlist[indice];
    if (!item) return;
    titulo.textContent = item.titulo;
    meta.textContent = item._tipo === "m"
      ? "🎵 Música · Biblioteca Podcast 21"
      : `🎤 ${item.alumno || "Anónimo"} · ${item.categoria || "General"}`;

    audio.src = item.url;
    if (reproducir) intentarReproduccion();
    else btnPlay.textContent = "▶";
  }

  function intentarReproduccion() {
    const prom = audio.play();
    if (!prom) return;
    prom
      .then(() => { btnPlay.textContent = "⏸"; })
      .catch(() => {
        btnPlay.textContent = "▶";
        reintentarCuandoListo();
        prepararDesbloqueo();
      });
  }

  function reintentarCuandoListo() {
    audio.addEventListener("canplay", function h() {
      audio.removeEventListener("canplay", h);
      audio.play().then(() => { btnPlay.textContent = "⏸"; }).catch(() => {});
    });
  }

  function prepararDesbloqueo() {
    if (desbloqueoActivo) return;
    desbloqueoActivo = true;
    const fn = () => {
      window.removeEventListener("pointerdown", fn);
      window.removeEventListener("keydown", fn);
      desbloqueoActivo = false;
      audio.play().then(() => { btnPlay.textContent = "⏸"; }).catch(() => {});
    };
    window.addEventListener("pointerdown", fn);
    window.addEventListener("keydown", fn);
  }

  // ===== Avanza en el orden programado (ya no al azar) =====
  function siguiente() {
    if (enVivo || !playlist.length) return;
    if (loopActivo) {
      indice = (indice + 1) % playlist.length;
      cargarPista(indice, true);
    } else if (indice < playlist.length - 1) {
      indice++;
      cargarPista(indice, true);
    } else {
      btnPlay.textContent = "▶";
    }
  }

  function anterior() {
    if (enVivo || !playlist.length) return;
    if (indice > 0) {
      indice--;
      cargarPista(indice, !audio.paused);
    }
  }

  function setGif(activo) {
    if (!gif) return;
    if (activo) { gif.src = "img/radio-anim.gif"; gif.classList.remove("oculto"); }
    else { gif.classList.add("oculto"); gif.src = ""; }
  }

  function setVibracion(activo) {
    if (activo) { btnMute.classList.add("vibrando"); aviso.classList.remove("oculto"); }
    else { btnMute.classList.remove("vibrando"); aviso.classList.add("oculto"); }
  }

  btnPrev.addEventListener("click", anterior);

  btnPlay.addEventListener("click", () => {
    if (enVivo) {
      if (jitsiConectado) desconectarJitsi();
      else conectarJitsi();
      return;
    }
    if (audio.paused) audio.play().then(() => { btnPlay.textContent = "⏸"; }).catch(() => {});
    else { audio.pause(); btnPlay.textContent = "▶"; }
  });

  btnNext.addEventListener("click", siguiente);

  btnMute.addEventListener("click", () => {
    if (enVivo) {
      if (jitsiConectado) desconectarJitsi();
      else conectarJitsi();
      return;
    }
    audio.muted = !audio.muted;
    btnMute.textContent = audio.muted ? "🔇" : "🔊";
    setVibracion(audio.muted);
  });

  audio.addEventListener("play", () => { if (!enVivo) { btnPlay.textContent = "⏸"; setGif(true); } });
  audio.addEventListener("pause", () => { if (!enVivo) btnPlay.textContent = "▶"; });
  audio.addEventListener("ended", siguiente);
})();
