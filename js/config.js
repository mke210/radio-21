// ======================================================
// CONFIGURACIÓN DE SUPABASE
// Escuela 21 de Noviembre - Esquipulas
// Proyecto de Informática del Profechan
// ======================================================

window.SUPABASE_URL = "https://kcynhfufhrkbuleapfro.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjeW5oZnVmaHJrYnVsZWFwZnJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5NzA3MjEsImV4cCI6MjEwMTU0NjcyMX0.49_qsBBjorhYMqovo2OBTRZ9BB_Wl-OdFS-MEjBJSOs";

window.JITSI_ROOM = "Cabina21NovProfechan";

// Conexión única compartida por toda la página
if (window.supabase && !window.SUPABASE_URL.includes("PEGAR")) {
  window.P21_DB = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
}