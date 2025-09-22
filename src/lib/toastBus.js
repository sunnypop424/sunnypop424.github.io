// src/lib/toastBus.js
export function showToast(msg, type = "info") {
  // type: "info" | "success" | "warning" | "error"
  window.dispatchEvent(new CustomEvent("app:toast", { detail: { msg, type } }));
}
