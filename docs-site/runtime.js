(() => {
  const root = document.documentElement;
  const body = document.body;
  const themeButtons = [...document.querySelectorAll("[data-theme-toggle]")];
  const menuButton = document.querySelector("[data-menu-toggle]");
  const menuBackdrop = document.querySelector("[data-sidebar-backdrop]");
  const searchInput = document.querySelector("[data-search]");
  const searchResults = document.querySelector("[data-search-results]");
  let searchIndex = [];

  function setTheme(theme) {
    root.dataset.theme = theme;
    themeButtons.forEach((button) => {
      button.textContent = theme === "dark" ? "Light mode" : "Dark mode";
    });
    try {
      localStorage.setItem("oplogs-docs-theme", theme);
    } catch (_error) {
      // The selected theme still applies for this page.
    }
  }

  themeButtons.forEach((button) => {
    button.textContent = root.dataset.theme === "dark" ? "Light mode" : "Dark mode";
    button.addEventListener("click", () => {
      setTheme(root.dataset.theme === "dark" ? "light" : "dark");
    });
  });

  function setMenu(open) {
    body.classList.toggle("sidebar-open", open);
    menuButton?.setAttribute("aria-expanded", String(open));
  }

  menuButton?.addEventListener("click", () => setMenu(!body.classList.contains("sidebar-open")));
  menuBackdrop?.addEventListener("click", () => setMenu(false));

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setMenu(false);
      closeSearch();
    }
    if (
      event.key === "/" &&
      searchInput &&
      document.activeElement !== searchInput &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)
    ) {
      event.preventDefault();
      searchInput.focus();
    }
  });

  function closeSearch() {
    if (!searchResults || !searchInput) return;
    searchResults.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
  }

  function resultLink(item) {
    const link = document.createElement("a");
    link.className = "search-result";
    link.href = item.url;
    link.setAttribute("role", "option");

    const title = document.createElement("strong");
    title.textContent = item.title;
    const description = document.createElement("span");
    description.textContent = item.description;
    link.append(title, description);
    return link;
  }

  function renderSearch(query) {
    if (!searchResults || !searchInput) return;
    searchResults.replaceChildren();
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) {
      closeSearch();
      return;
    }

    const terms = normalized.split(/\s+/).filter(Boolean);
    const matches = searchIndex
      .map((item) => {
        const title = item.title.toLocaleLowerCase();
        const description = item.description.toLocaleLowerCase();
        const headings = item.headings.join(" ").toLocaleLowerCase();
        const haystack = `${item.title} ${item.description} ${item.headings.join(" ")} ${item.text}`.toLocaleLowerCase();
        const allTerms = terms.every((term) => haystack.includes(term));
        const score = allTerms
          ? terms.reduce((total, term) => {
              const occurrences = Math.min(4, haystack.split(term).length - 1);
              return total + occurrences + (title.includes(term) ? 8 : 0) + (headings.includes(term) ? 4 : 0) + (description.includes(term) ? 2 : 0);
            }, 0)
          : 0;
        return { item, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    if (matches.length) {
      for (const { item } of matches) searchResults.append(resultLink(item));
    } else {
      const empty = document.createElement("p");
      empty.className = "search-empty";
      empty.textContent = "No matching page";
      searchResults.append(empty);
    }
    searchResults.hidden = false;
    searchInput.setAttribute("aria-expanded", "true");
  }

  if (searchInput && searchResults) {
    fetch(body.dataset.searchIndex)
      .then((response) => {
        if (!response.ok) throw new Error(`search index returned ${response.status}`);
        return response.json();
      })
      .then((index) => {
        searchIndex = index;
        if (searchInput.value.trim()) renderSearch(searchInput.value);
      })
      .catch(() => {
        searchInput.placeholder = "Search unavailable";
      });

    searchInput.addEventListener("input", () => renderSearch(searchInput.value));
    searchInput.addEventListener("focus", () => {
      if (searchInput.value.trim()) renderSearch(searchInput.value);
    });
    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(".search-wrap")) closeSearch();
    });
  }

  async function writeClipboard(value) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const field = document.createElement("textarea");
    field.value = value;
    field.setAttribute("readonly", "");
    field.className = "clipboard-field";
    document.body.append(field);
    field.select();
    document.execCommand("copy");
    field.remove();
  }

  function showCopied(button, restingLabel) {
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = restingLabel;
    }, 1200);
  }

  document.querySelectorAll("[data-copy-code]").forEach((button) => {
    button.addEventListener("click", async () => {
      const source = button.closest("[data-code-block]")?.querySelector("code")?.textContent || "";
      await writeClipboard(source);
      showCopied(button, "copy");
    });
  });

  document.querySelectorAll("[data-copy-markdown]").forEach((button) => {
    button.addEventListener("click", async () => {
      const response = await fetch(button.dataset.copyMarkdown);
      if (!response.ok) throw new Error(`Markdown source returned ${response.status}`);
      await writeClipboard(await response.text());
      showCopied(button, "Copy as Markdown");
    });
  });

  const tocLinks = [...document.querySelectorAll(".toc li a")];
  if (tocLinks.length && "IntersectionObserver" in window) {
    const linksById = new Map(tocLinks.map((link) => [link.hash.slice(1), link]));
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (!visible) return;
        tocLinks.forEach((link) => link.classList.remove("is-active"));
        linksById.get(visible.target.id)?.classList.add("is-active");
      },
      { rootMargin: "-90px 0px -72% 0px", threshold: [0, 1] },
    );
    linksById.forEach((_link, id) => {
      const heading = document.getElementById(id);
      if (heading) observer.observe(heading);
    });
  }
})();
