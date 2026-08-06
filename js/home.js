(function () {
  "use strict";

  const config = { url: window.SUPABASE_URL, key: window.SUPABASE_ANON_KEY };
  if (!window.supabase || !config.url || config.url.includes("PEGAR")) return;

  const db = window.P21_DB || window.supabase.createClient(config.url, config.key);

  const $ = (id) => document.getElementById(id);

  const audio = $("pmAudio");
  const titulo = $("pmTitulo");
  const meta = $("pmMeta");
  const btnPlay = $("pmPlay");
  const btnNext = $("pmNext");
  const btnMute = $("pmMute");
  const aviso = $("pmAviso");
  const gif = $("pmGif");

  let pool = [];
  let indice = -1;

  cargar();

  // ===== Carga episodios Y música de la biblioteca =====
  async function cargar() {
    const [rAud, rMus] = await Promise.all([
      db.from("audios").select("*").eq("publicado", true).order("creado_en", { ascending: false }),
      db.from("musica").select("*").order("creado_en", { ascending: false })
    ]);

    const episodios = rAud.data || [];
    const musicas = rMus.data || [];

    pool = [
      ...musicas.map(m => ({ ...m, _tipo: "m" })),
      ...episodios.map(e => ({ ...e, _tipo: "e" }))
    ];

    if (!pool.length) {
      titulo.textContent = "Aún no hay contenido";
      meta.textContent = "Sube música o graba episodios desde la cabina 🎙️";
      return;
    }

    btnPlay.disabled = false;
    btnNext.disabled = false;
    btnMute.disabled = false;

    // El GIF se muestra desde que abre la página
    setGif(true);

    aleatorio();
  }

  function aleatorio() {
    let n;
    do { n = Math.floor(Math.random() * pool.length); }
    while (n === indice && pool.length > 1);
    indice = n;

    const item = pool[indice];
    titulo.textContent = item.titulo;
    meta.textContent = item._tipo === "m"
      ? "🎵 Música · Biblioteca Podcast 21"
      : `🎤 ${item.alumno || "Anónimo"} · ${item.categoria || "General"}`;

    audio.src = item.url;

    // Intenta sonar CON sonido; si el navegador lo bloquea,
    // inicia silenciado y avisa (cualquier clic activa el sonido)
    audio.muted = false;
    audio.play()
      .then(() => { btnPlay.textContent = "⏸"; })
      .catch(() => {
        audio.muted = true;
        audio.play()
          .then(() => { btnPlay.textContent = "⏸"; setVibracion(true); })
          .catch(() => { btnPlay.textContent = "▶"; });
      });
  }

  // ===== Cualquier clic en la página activa el sonido =====
  function desbloquearSonido(e) {
    // No intervenir si el clic fue en los controles del reproductor
    if (e.target.closest(".pm-controls")) return;
    if (audio.muted && !audio.paused) {
      audio.muted = false;
      btnMute.textContent = "🔊";
      setVibracion(false);
    }
    window.removeEventListener("click", desbloquearSonido);
    window.removeEventListener("keydown", desbloquearSonido);
  }
  window.addEventListener("click", desbloquearSonido);
  window.addEventListener("keydown", desbloquearSonido);

  // ===== GIF visible desde la apertura =====
  function setGif(activo) {
    if (!gif) return;
    if (activo) {
      gif.src = "img/radio-anim.gif";
      gif.classList.remove("oculto");
    } else {
      gif.classList.add("oculto");
      gif.src = "";
    }
  }

  function setVibracion(activo) {
    if (activo) {
      btnMute.classList.add("vibrando");
      aviso.classList.remove("oculto");
    } else {
      btnMute.classList.remove("vibrando");
      aviso.classList.add("oculto");
    }
  }

  btnPlay.addEventListener("click", () => {
    if (audio.paused) { audio.play(); btnPlay.textContent = "⏸"; }
    else { audio.pause(); btnPlay.textContent = "▶"; }
  });

  btnNext.addEventListener("click", aleatorio);

  btnMute.addEventListener("click", () => {
    audio.muted = !audio.muted;
    btnMute.textContent = audio.muted ? "🔇" : "🔊";
    setVibracion(audio.muted);
  });

  audio.addEventListener("play", () => { btnPlay.textContent = "⏸"; setGif(true); });
  audio.addEventListener("ended", aleatorio);
})();