// Stand runs edge to edge under the Mac's window buttons: Stand's own CSS makes
// room for them (html.mac-app), and a strip along the top drags the window.
// The strip goes first in the page so buttons and links in it stay clickable.
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("mac-app");
  const strip = document.createElement("div");
  strip.style.cssText = "position:fixed;top:0;left:0;right:0;height:40px;-webkit-app-region:drag;pointer-events:none;z-index:2147483647";
  document.body.prepend(strip);
});
