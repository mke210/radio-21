(function () {
  "use strict";

  const config = { url: window.SUPABASE_URL, key: window.SUPABASE_ANON_KEY };
  if (!window.supabase || !config.url || config.url.includes("PEGAR")) return;

  const db = window.P21_DB || window.supabase.createClient(config.url, config.key);

  const $ = (id) => document.getElementById(id);

  const audio = $("pmAudio");
  const img = $("pmImg");
  const ph = $("pmPh");
  const titulo = $("pmTitulo");
  const meta = $("pmMeta");
  const btnPlay = $("pmPlay");
  const btnNext = $("pmNext");
  const btnMute = $("pmMute");
  const aviso = $("pmAviso");

  let episodios = [];
  let indice = -1;

  cargar();

  async function cargar() {
    const { data, error } = await db
      .from("audios").select("*")
      .eq("publicado", true)
      .order("creado_en", { ascending: false });

    if (error || !data || !data.length) {
      titulo.textContent = "Aún no hay episodios";
      meta.textContent = "Graba el primero desde la cabina 🎙️";
      return;
    }

    episodios = data;
    btnPlay.disabled = false;
    btnNext.disabled = false;
    btnMute.disabled = false;

    aleatorio();
  }

  function aleatorio() {
    let n;
    do { n = Math.floor(Math.random() * episodios.length); }
    while (n === indice && episodios.length > 1);
    indice = n;

    const ep = episodios[indice];
    titulo.textContent = ep.titulo;
    meta.textContent = `🎤 ${ep.alumno || "Anónimo"} · ${ep.categoria || "General"}`;

    if (ep.imagen) {
      img.src = ep.imagen;
      img.style.display = "block";
      ph.style.display = "none";
    } else {
      img.style.display = "none";
      ph.style.display = "flex";
    }

    audio.src = ep.url;
    audio.muted = true;
    audio.play()
      .then(() => { btnPlay.textContent = "⏸"; setVibracion(true); })
      .catch(() => { btnPlay.textContent = "▶"; });
  }

  // ===== GIF: se activa con play, se oculta con pausa =====
  function setGif(activo) {
    const gif = $("pmGif");
    const gifPh = $("pmGifPh");
    if (!gif || !gifPh) return;
    if (activo) {
      gif.src = "img/radio-anim.gif";
      gif.classList.remove("oculto");
      gifPh.classList.add("oculto");
    } else {
      gif.classList.add("oculto");
      gifPh.classList.remove("oculto");
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
  audio.addEventListener("pause", () => { btnPlay.textContent = "▶"; setGif(false); });
  audio.addEventListener("ended", aleatorio);
})();