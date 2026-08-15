(() => {
  const root = document.documentElement;
  const body = document.body;
  const themeButton = document.querySelector("[data-theme-toggle]");
  const menuButton = document.querySelector("[data-menu-toggle]");
  const menuBackdrop = document.querySelector("[data-sidebar-backdrop]");
  const searchInput = document.querySelector("[data-search]");
  const searchResults = document.querySelector("[data-search-results]");
  let searchIndex = [];

  function setTheme(theme) {
    root.dataset.theme = theme;
    if (themeButton) themeButton.textContent = theme === "dark" ? "use light" : "use dark";
    try {
      localStorage.setItem("oplogs-docs-theme", theme);
    } catch (_error) {
      // The selected theme still applies for this page.
    }
  }

  if (themeButton) {
    themeButton.textContent = root.dataset.theme === "dark" ? "use light" : "use dark";
    themeButton.addEventListener("click", () => {
      setTheme(root.dataset.theme === "dark" ? "light" : "dark");
    });
  }

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
      empty.textContent = "no matching page";
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
        searchInput.placeholder = "search unavailable";
      });

    searchInput.addEventListener("input", () => renderSearch(searchInput.value));
    searchInput.addEventListener("focus", () => {
      if (searchInput.value.trim()) renderSearch(searchInput.value);
    });
    document.addEventListener("pointerdown", (event) => {
      if (!event.target.closest(".search-wrap")) closeSearch();
    });
  }

  document.querySelectorAll("[data-copy-code]").forEach((button) => {
    button.addEventListener("click", async () => {
      const source = button.closest("[data-code-block]")?.querySelector("code")?.textContent || "";
      await navigator.clipboard.writeText(source);
      button.textContent = "copied";
      window.setTimeout(() => {
        button.textContent = "copy";
      }, 1200);
    });
  });

  document.querySelector("[data-copy-link]")?.addEventListener("click", async (event) => {
    await navigator.clipboard.writeText(window.location.href);
    const button = event.currentTarget;
    button.textContent = "link copied";
    window.setTimeout(() => {
      button.textContent = "copy page link";
    }, 1200);
  });

  const journalExamples = {
    metric: {
      code: 'run.log({"train/loss": 0.184}, step=400)',
      status: "metric · indexed for charts",
    },
    media: {
      code: 'run.log({"samples": oplogs.Image("grid.png")}, step=400)',
      status: "media · rendered with its producing step",
    },
    artifact: {
      code: 'run.log({"model": oplogs.Artifact("model.pt", aliases=["latest"])})',
      status: "artifact · sha-256 addressed and aliased",
    },
  };

  const journalLab = document.querySelector("[data-journal-lab]");
  journalLab?.querySelectorAll("[data-journal-kind]").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.journalKind;
      const selected = journalExamples[kind];
      if (!selected) return;
      journalLab.querySelectorAll("[data-journal-kind]").forEach((candidate) => {
        candidate.setAttribute("aria-pressed", String(candidate === button));
      });
      journalLab.querySelector("[data-journal-code]").textContent = selected.code;
      journalLab.querySelector("[data-journal-status]").textContent = selected.status;
    });
  });

  const banner = document.querySelector("[data-banner]");
  if (banner && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    banner.addEventListener("pointermove", (event) => {
      const bounds = banner.getBoundingClientRect();
      const offset = ((event.clientX - bounds.left) / bounds.width - 0.5) * -1.2;
      banner.style.setProperty("--banner-shift", `${offset}%`);
    });
    banner.addEventListener("pointerleave", () => banner.style.setProperty("--banner-shift", "0%"));
  }

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
