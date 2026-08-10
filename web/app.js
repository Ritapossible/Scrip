/**
 * Site menu.
 *
 * The markup ships open-able in HTML and this only toggles state, so a failed
 * or blocked script costs the menu button and nothing else - every destination
 * in the panel is also reachable from the inline links and the footer.
 */

(function () {
  "use strict";

  const toggle = document.querySelector("[data-menu-toggle]");
  const menu = document.querySelector("[data-menu]");
  const scrim = document.querySelector("[data-menu-scrim]");

  if (!toggle || !menu || !scrim) return;

  let open = false;

  function setOpen(next) {
    open = next;
    toggle.setAttribute("aria-expanded", String(next));
    toggle.setAttribute("aria-label", next ? "Close menu" : "Open menu");
    menu.classList.toggle("is-open", next);
    scrim.classList.toggle("is-open", next);
    // Hide from assistive tech when closed; visibility:hidden alone still
    // leaves the links in the tab order in some browsers.
    menu.setAttribute("aria-hidden", String(!next));
    document.body.classList.toggle("menu-open", next);

    if (next) {
      const first = menu.querySelector("a");
      if (first) first.focus();
    }
  }

  toggle.addEventListener("click", function () {
    setOpen(!open);
  });

  scrim.addEventListener("click", function () {
    setOpen(false);
  });

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && open) {
      setOpen(false);
      toggle.focus(); // returning focus to the trigger, not the top of the page
    }
  });

  // A same-page anchor does not reload, so the menu would otherwise stay open
  // over the section the reader just jumped to.
  menu.addEventListener("click", function (event) {
    if (event.target.closest("a")) setOpen(false);
  });

  setOpen(false);
})();
