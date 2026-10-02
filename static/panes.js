/* 側邊分頁主控台:.console-tab[data-pane="x"] ↔ .pane#pane-x。
 * 以網址 hash 記住目前分頁(#x),舊深連結可用 aliases 對應(例:#devices)。 */
(() => {
  function initConsole(root, { aliases = {}, onChange } = {}) {
    const tabs = [...root.querySelectorAll(".console-tab[data-pane]")];
    const ids = tabs.map((tab) => tab.dataset.pane);
    const nav = root.querySelector(".console-nav");
    nav?.setAttribute("role", "tablist");
    tabs.forEach((tab) => {
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", "pane-" + tab.dataset.pane);
      tab.addEventListener("click", () => show(tab.dataset.pane, true));
      tab.addEventListener("keydown", (event) => {
        const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
        if (!step) return;
        event.preventDefault();
        const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
        next.focus();
        show(next.dataset.pane, true);
      });
    });
    root.querySelectorAll(".pane").forEach((pane) => pane.setAttribute("role", "tabpanel"));

    let current = null;
    function resolve(name) {
      const key = aliases[name] || name;
      return ids.includes(key) ? key : ids[0];
    }
    function show(name, fromUser = false) {
      const id = resolve(name);
      if (id === current) return id;
      current = id;
      tabs.forEach((tab) => {
        const on = tab.dataset.pane === id;
        tab.setAttribute("aria-selected", String(on));
        tab.tabIndex = on ? 0 : -1;
        if (on && fromUser) tab.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
      root.querySelectorAll(".pane").forEach((pane) => {
        pane.classList.toggle("is-active", pane.id === "pane-" + id);
      });
      if (fromUser) history.replaceState(null, "", "#" + id);
      onChange?.(id);
      return id;
    }
    window.addEventListener("hashchange", () => show(decodeURIComponent(location.hash.slice(1))));
    show(decodeURIComponent(location.hash.slice(1)));
    return { show, get current() { return current; } };
  }

  /** 點擊即複製:把 text 寫入剪貼簿,並在 el 上閃示「已複製」。 */
  async function copyText(text, el) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    if (!el) return;
    const hint = el.querySelector(".copy-hint-text");
    el.classList.add("is-copied");
    if (hint) hint.textContent = "已複製";
    clearTimeout(el._copyTimer);
    el._copyTimer = setTimeout(() => {
      el.classList.remove("is-copied");
      if (hint) hint.textContent = "點一下複製";
    }, 1400);
  }

  /** 關閉所有已開啟的 .pop-menu;點選單外或按 Esc 時自動收起。 */
  function closeMenus(except) {
    document.querySelectorAll(".pop-menu:not([hidden])").forEach((menu) => {
      if (menu === except) return;
      menu.hidden = true;
      menu.parentElement?.querySelector("[aria-expanded]")?.setAttribute("aria-expanded", "false");
    });
  }
  function toggleMenu(button) {
    const menu = button.parentElement.querySelector(".pop-menu");
    if (!menu) return;
    const open = menu.hidden;
    closeMenus(menu);
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) {
      // 空間不足時往下展開
      menu.classList.remove("drop-down");
      if (menu.getBoundingClientRect().top < 70) menu.classList.add("drop-down");
      menu.querySelector("button, a")?.focus();
    }
  }
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".menu-wrap")) closeMenus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenus();
  });

  window.DashcamUI = Object.freeze({ initConsole, copyText, toggleMenu, closeMenus });
})();
