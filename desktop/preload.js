// Stand runs edge to edge with no title bar or window buttons: the page is marked
// html.mac-app for Stand's CSS, and a strip along the top drags the window.
// The strip goes first in the page so buttons and links in it stay clickable.
window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("mac-app");
  const strip = document.createElement("div");
  strip.style.cssText = "position:fixed;top:0;left:0;right:0;height:40px;-webkit-app-region:drag;pointer-events:none;z-index:2147483647";
  document.body.prepend(strip);
});
