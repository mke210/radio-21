(function () {
  "use strict";

  const config = { url: window.SUPABASE_URL, key: window.SUPABASE_ANON_KEY };
  if (!window.supabase || !config.url || config.url.includes("PEGAR")) return;

  const db = window.supabase.createClient(config.url, config.key);

  let todosEpisodios = [];
  let categoriaActual = "Todas";
  let temporadaActual = "Todas";
  let busquedaActual = "";

  const episodiosDiv = document.getElementById("episodios");
  const destacadoSection = document.getElementById("destacadoSection");
  const destacadoContenido = document.getElementById("destacadoContenido");
  const contador = document.getElementById("contadorEpisodios");
  const inputBuscar = document.getElementById("buscar");
  const filtroTemporada = document.getElementById("filtroTemporada");

  document.querySelectorAll(".cat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("activo"));
      btn.classList.add("activo");
      categoriaActual = btn.dataset.cat;
      renderEpisodios();
    });
  });

  inputBuscar.addEventListener("input", e => {
    busquedaActual = e.target.value.toLowerCase();
    renderEpisodios();
  });

  filtroTemporada.addEventListener("change", e => {
    temporadaActual = e.target.value;
    renderEpisodios();
  });

  cargarEpisodios();

  async function cargarEpisodios() {
    episodiosDiv.innerHTML = "<p class='small'>Cargando episodios...</p>";

    const { data, error } = await db
      .from("audios")
      .select("*")
      .eq("publicado", true)
      .order("creado_en", { ascending: false });

    if (error) {
      episodiosDiv.innerHTML = "<p>Error al cargar.</p>";
      return;
    }

    todosEpisodios = data || [];

    // Llenar filtro de temporadas
    const temporadas = [...new Set(todosEpisodios.map(e => e.temporada || "Temporada 1 - 2026"))];
    filtroTemporada.innerHTML = '<option value="Todas">🗓️ Todas las temporadas</option>';
    temporadas.forEach(t => {
      filtroTemporada.innerHTML += `<option value="${t}">${t}</option>`;
    });

    // Destacado
    const destacado = todosEpisodios.find(e => e.destacado);
    if (destacado) {
      destacadoSection.style.display = "block";
      destacadoContenido.innerHTML = "";
      destacadoContenido.appendChild(crearEpisodioCard(destacado));
    } else {
      destacadoSection.style.display = "none";
    }

    renderEpisodios();
  }

  function renderEpisodios() {
    episodiosDiv.innerHTML = "";

    let filtrados = todosEpisodios;

    if (categoriaActual !== "Todas") {
      filtrados = filtrados.filter(e => (e.categoria || "General") === categoriaActual);
    }

    if (temporadaActual !== "Todas") {
      filtrados = filtrados.filter(e => (e.temporada || "Temporada 1 - 2026") === temporadaActual);
    }

    if (busquedaActual) {
      filtrados = filtrados.filter(e =>
        e.titulo.toLowerCase().includes(busquedaActual) ||
        (e.alumno || "").toLowerCase().includes(busquedaActual) ||
        (e.descripcion || "").toLowerCase().includes(busquedaActual)
      );
    }

    contador.textContent = `${filtrados.length} episodio${filtrados.length !== 1 ? "s" : ""}`;

    if (!filtrados.length) {
      episodiosDiv.innerHTML = "<p class='small'>No hay episodios que coincidan.</p>";
      return;
    }

    filtrados.forEach(ep => episodiosDiv.appendChild(crearEpisodioCard(ep)));
  }

  function crearEpisodioCard(ep) {
    const card = document.createElement("article");
    card.className = "episodio-card";

    const coverHTML = ep.imagen
      ? `<img src="${ep.imagen}" alt="${ep.titulo}" class="episodio-cover" loading="lazy" />`
      : `<div class="episodio-cover-placeholder">🎧</div>`;

    const dur = ep.duracion ? formatearDuracion(ep.duracion) : "--:--";
    const fecha = new Date(ep.creado_en).toLocaleDateString();
    const liked = localStorage.getItem(likeKey(ep.id));

    card.innerHTML = `
      ${coverHTML}
      <div class="episodio-body">
        <h3 class="episodio-titulo">${ep.titulo}</h3>
        <div class="episodio-meta">
          <span class="episodio-cat">${ep.categoria || "General"}</span>
          <span class="temporada-badge">🗓️ ${ep.temporada || "Temporada 1 - 2026"}</span>
        </div>
        <div class="episodio-meta">
          <span>⏱ ${dur}</span>
          <span>📅 ${fecha}</span>
          <span>🎤 ${ep.alumno || "Anónimo"}</span>
        </div>
        <div class="episodio-meta">
          <span>▶ ${ep.reproducciones || 0} plays</span>
        </div>
        ${ep.descripcion ? `<p class="episodio-desc">${ep.descripcion}</p>` : ""}
        <div class="episodio-acciones">
          <button class="btn-like ${liked ? "liked" : ""}" data-id="${ep.id}">
            ❤ ${ep.likes || 0}
          </button>
        </div>
        <audio class="episodio-audio" controls preload="none" controlslist="nodownload" data-id="${ep.id}">
          <source src="${ep.url}" />
        </audio>
      </div>
    `;

    const audio = card.querySelector("audio");
    audio.addEventListener("play", () => incrementarReproduccion(ep.id), { once: true });

    const btnLike = card.querySelector(".btn-like");
    btnLike.addEventListener("click", () => toggleLike(ep, btnLike));

    return card;
  }

  async function toggleLike(ep, btn) {
    const liked = localStorage.getItem(likeKey(ep.id));
    const delta = liked ? -1 : 1;
    const nuevo = Math.max(0, (ep.likes || 0) + delta);

    const { error } = await db.from("audios").update({ likes: nuevo }).eq("id", ep.id);
    if (error) return;

    if (liked) localStorage.removeItem(likeKey(ep.id));
    else localStorage.setItem(likeKey(ep.id), "1");

    ep.likes = nuevo;
    btn.classList.toggle("liked", !liked);
    btn.innerHTML = `❤ ${nuevo}`;
  }

  function incrementarReproduccion(id) {
    const ep = todosEpisodios.find(e => e.id === id);
    if (!ep) return;
    const nuevo = (ep.reproducciones || 0) + 1;
    ep.reproducciones = nuevo;
    db.from("audios").update({ reproducciones: nuevo }).eq("id", id);
  }

  function likeKey(id) {
    return "p21_like_" + id;
  }

  function formatearDuracion(seg) {
    const m = Math.floor(seg / 60);
    const s = seg % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
})();