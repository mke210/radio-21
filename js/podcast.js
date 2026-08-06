(function () {
  const config = {
    url: window.SUPABASE_URL,
    key: window.SUPABASE_ANON_KEY
  };

  if (!window.supabase) {
    alert("No se cargó la librería de Supabase.");
    return;
  }

  if (
    !config.url ||
    config.url.includes("PEGAR") ||
    !config.key ||
    config.key.includes("PEGAR")
  ) {
    alert("Configura primero js/config.js con tu URL y anon key de Supabase.");
    return;
  }

  const { createClient } = window.supabase;
  const db = createClient(config.url, config.key);

  const episodiosDiv = document.getElementById("episodios");

  cargarEpisodios();

  async function cargarEpisodios() {
    episodiosDiv.innerHTML = "<p class='small'>Cargando episodios...</p>";

    const { data, error } = await db
      .from("audios")
      .select("*")
      .eq("publicado", true)
      .order("creado_en", { ascending: false });

    if (error) {
      console.error(error);
      episodiosDiv.innerHTML = "<p>Error al cargar episodios.</p>";
      return;
    }

    if (!data || data.length === 0) {
      episodiosDiv.innerHTML =
        "<p class='small'>Todavía no hay episodios publicados.</p>";
      return;
    }

    episodiosDiv.innerHTML = "";

    data.forEach((episodio, index) => {
      const card = document.createElement("article");
      card.className = "episodio";

      const fecha = new Date(episodio.creado_en).toLocaleString();

      const titulo = document.createElement("h3");
      titulo.textContent = `${index + 1}. ${episodio.titulo}`;

      const meta = document.createElement("p");
      meta.className = "small";
      meta.textContent = `Alumno: ${episodio.alumno || "Anónimo"} — ${fecha}`;

      card.appendChild(titulo);
      card.appendChild(meta);

      if (episodio.descripcion) {
        const desc = document.createElement("p");
        desc.textContent = episodio.descripcion;
        card.appendChild(desc);
      }

      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = episodio.url;
      card.appendChild(audio);

      const enlace = document.createElement("a");
      enlace.href = episodio.url;
      enlace.target = "_blank";
      enlace.rel = "noopener";
      enlace.className = "small enlace";
      enlace.textContent = "Abrir o descargar audio";
      card.appendChild(enlace);

      episodiosDiv.appendChild(card);
    });
  }
})();