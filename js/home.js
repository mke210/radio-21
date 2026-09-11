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

  cargar();

  // ===== Carga contenido + programación de la cabina =====
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
      titulo.textContent = "Error al cargar";
      meta.textContent = e.message;
    }
  }

  function resolver(valor) {
    const tipo = valor.slice(0, 1);
    const id = valor.slice(2);
    return todas.find(x => x._tipo === tipo && x.id === id) || null;
  }

  function cargarPista(n, reproducir) {
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
    if (!playlist.length) return;
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
    if (!playlist.length) return;
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
    if (audio.paused) audio.play().then(() => { btnPlay.textContent = "⏸"; }).catch(() => {});
    else { audio.pause(); btnPlay.textContent = "▶"; }
  });

  btnNext.addEventListener("click", siguiente);

  btnMute.addEventListener("click", () => {
    audio.muted = !audio.muted;
    btnMute.textContent = audio.muted ? "🔇" : "🔊";
    setVibracion(audio.muted);
  });

  audio.addEventListener("play", () => { btnPlay.textContent = "⏸"; setGif(true); });
  audio.addEventListener("pause", () => { btnPlay.textContent = "▶"; });
  audio.addEventListener("ended", siguiente);
})();
