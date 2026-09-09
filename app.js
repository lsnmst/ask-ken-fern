// ---------------------------------------------------------------------
// Ask Ken Fern — client-side logic
// No backend: geocoding via Nominatim, spatial lookup via a static
// SQLite file queried through HTTP range requests (sql.js-httpvfs).
// ---------------------------------------------------------------------

const RESOLUTION = 5;              // must match the resolution used when building the DB
const SEARCH_RING = 1;             // 0 = exact cell only, 1 = cell + immediate neighbours
const DB_URL = "./ask_ken_fern.sqlite";
const WORKER_URL = "./sqlite.worker.js";
const WASM_URL = "./sql-wasm.wasm";


const PAGE_SIZE = 20;
let currentPage = 1;
let currentSpecies = [];
let currentPlace = "";

const form = document.getElementById("search-form");
const input = document.getElementById("place-input");
const button = document.getElementById("search-button");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

let dbWorkerPromise = null;
const geocodeCache = new Map();


const nonColonisedInfo =
  document.getElementById("non-colonised-info");

const nonColonisedTip =
  document.getElementById("non-colonised-tip");


function positionNonColonisedTip() {
  if (!nonColonisedInfo || !nonColonisedTip) {
    return;
  }

  const termRect =
    nonColonisedInfo.getBoundingClientRect();

  const margin = 12;
  const gap = 10;

  const tipWidth =
    nonColonisedTip.offsetWidth;

  const tipHeight =
    nonColonisedTip.offsetHeight;

  let left = termRect.left;
  let top = termRect.bottom + gap;

  if (
    left + tipWidth >
    window.innerWidth - margin
  ) {
    left =
      window.innerWidth -
      tipWidth -
      margin;
  }

  if (left < margin) {
    left = margin;
  }

  if (
    top + tipHeight >
    window.innerHeight - margin
  ) {
    top =
      termRect.top -
      tipHeight -
      gap;
  }

  if (top < margin) {
    top = margin;
  }

  nonColonisedTip.style.left =
    `${left}px`;

  nonColonisedTip.style.top =
    `${top}px`;
}


function openNonColonisedTip(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }

  nonColonisedInfo.setAttribute(
    "aria-expanded",
    "true"
  );

  nonColonisedTip.hidden = false;

  requestAnimationFrame(() => {
    positionNonColonisedTip();

    nonColonisedTip.classList.add(
      "is-visible"
    );
  });
}


function closeNonColonisedTip() {
  nonColonisedInfo.setAttribute(
    "aria-expanded",
    "false"
  );

  nonColonisedTip.classList.remove(
    "is-visible"
  );

  nonColonisedTip.hidden = true;
}


function toggleNonColonisedTip(event) {
  const isOpen =
    nonColonisedInfo.getAttribute(
      "aria-expanded"
    ) === "true";

  if (isOpen) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    closeNonColonisedTip();
  } else {
    openNonColonisedTip(event);
  }
}


nonColonisedInfo.addEventListener(
  "click",
  toggleNonColonisedTip
);


nonColonisedInfo.addEventListener(
  "keydown",
  (event) => {

    if (
      event.key === "Enter" ||
      event.key === " "
    ) {
      event.preventDefault();
      event.stopPropagation();

      toggleNonColonisedTip();
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeNonColonisedTip();
    }
  }
);


document.addEventListener(
  "click",
  (event) => {

    if (
      !nonColonisedInfo.contains(event.target) &&
      !nonColonisedTip.contains(event.target)
    ) {
      closeNonColonisedTip();
    }
  }
);


window.addEventListener(
  "resize",
  () => {

    if (
      nonColonisedInfo.getAttribute(
        "aria-expanded"
      ) === "true"
    ) {
      positionNonColonisedTip();
    }
  }
);


window.addEventListener(
  "scroll",
  () => {

    if (
      nonColonisedInfo.getAttribute(
        "aria-expanded"
      ) === "true"
    ) {
      positionNonColonisedTip();
    }
  },
  true
);


const inputError = document.getElementById("input-error");
form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const place = input.value.trim();

  // Custom validation
  if (!place) {
    inputError.textContent =
      "Please, tell me where you are, then I'll look for edible plants.";

    input.classList.add("input--error");
    input.focus();

    return;
  }

  inputError.textContent = "";
  input.classList.remove("input--error");

  button.disabled = true;
  resultsEl.innerHTML = "";

  setStatus("Looking up that place…");


  try {
    const location = await geocode(place);

    if (!location) {
      setStatus(
        `Couldn't find "${place}". Try a nearby city or a more specific name.`,
        "error"
      );
      return;
    }

    setStatus(
      `Searching wild food records near ${location.displayName}…`
    );

    const species = await findSpeciesNear(
      location.lat,
      location.lon
    );

    setStatus("");

    renderResults(
      location.displayName,
      species
    );

    scrollToResultsOnMobile();

  } catch (err) {
    console.error(err);

    setStatus(
      err.message ||
      "Something went wrong. Please try again.",
      "error"
    );

  } finally {
    button.disabled = false;
  }
});

async function detectFileLength(url) {
  const res = await fetch(url, { headers: { Range: "bytes=0-0" } });
  const contentRange = res.headers.get("Content-Range"); // e.g. "bytes 0-0/60211200"
  if (contentRange) {
    const total = contentRange.split("/")[1];
    if (total && total !== "*") return parseInt(total, 10);
  }
  const len = res.headers.get("Content-Length");
  if (len) return parseInt(len, 10);
  return null;
}

function getDbWorker() {
  if (!dbWorkerPromise) {
    dbWorkerPromise = (async () => {
      const fileLength = await detectFileLength(DB_URL);
      if (!fileLength) {
        throw new Error(
          "Couldn't determine the database file size from the server. Range requests may not be supported here."
        );
      }
      return createDbWorker(
        [
          {
            from: "url",
            config: {
              serverMode: "full",
              url: DB_URL,
              requestChunkSize: 4096,
              fileLength,
            },
          },
        ],
        WORKER_URL,
        WASM_URL
      );
    })();
  }
  return dbWorkerPromise;
}

const speciesImagePreview =
  document.getElementById("species-image-preview");

const speciesImagePreviewImg =
  document.getElementById(
    "species-image-preview-img"
  );

const speciesImagePreviewCredit =
  document.getElementById(
    "species-image-preview-credit"
  );

let previewImageSrc = null;

function setupSpeciesImageHover(card, species) {
  const thumbnail =
    species.gbif_image_thumbnail_url;

  if (!thumbnail) return;

  card.addEventListener(
    "mouseenter",
    () => {
      speciesImagePreviewImg.src = thumbnail;

      speciesImagePreviewImg.alt =
        species.scientific_name ||
        species.common_name ||
        "";

      const creditParts = [];

      if (species.gbif_image_credit) {
        creditParts.push(
          species.gbif_image_credit
        );
      }

      if (species.gbif_image_license) {
        creditParts.push(
          species.gbif_image_license
        );
      }

      speciesImagePreviewCredit.textContent =
        creditParts.join(" · ");

      speciesImagePreview.classList.add(
        "is-visible"
      );

      speciesImagePreview.setAttribute(
        "aria-hidden",
        "false"
      );

      previewImageSrc = thumbnail;
    }
  );

  card.addEventListener(
    "mousemove",
    (event) => {
      positionSpeciesPreview(
        event.clientX,
        event.clientY
      );
    }
  );

  card.addEventListener(
    "mouseleave",
    () => {
      speciesImagePreview.classList.remove(
        "is-visible"
      );

      speciesImagePreview.setAttribute(
        "aria-hidden",
        "true"
      );

      previewImageSrc = null;
    }
  );
}

// --- mobile species image preview -------------------------------------

let mobileSpeciesObserver = null;
let mobileVisibleSpecies = new Map();

function setupMobileSpeciesImageObserver() {
  // Solo mobile
  if (window.innerWidth > 480) {
    return;
  }

  // Evita di creare più observer
  if (mobileSpeciesObserver) {
    mobileSpeciesObserver.disconnect();
  }

  mobileVisibleSpecies.clear();

  const cards = resultsEl.querySelectorAll(".species");

  if (!cards.length) {
    hideMobileSpeciesPreview();
    return;
  }

  mobileSpeciesObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const card = entry.target;

        if (entry.isIntersecting) {
          mobileVisibleSpecies.set(card, entry.intersectionRatio);
        } else {
          mobileVisibleSpecies.delete(card);
        }
      }

      updateMobileSpeciesPreview();
    },
    {
      root: null,
      rootMargin: "-20% 0px -20% 0px",
      threshold: [0, 0.25, 0.5, 0.75, 1]
    }
  );

  cards.forEach((card) => {
    mobileSpeciesObserver.observe(card);
  });

  updateMobileSpeciesPreview();
}

function updateMobileSpeciesPreview() {
  if (window.innerWidth > 480) {
    return;
  }

  let bestCard = null;
  let bestRatio = 0;

  for (const [card, ratio] of mobileVisibleSpecies.entries()) {
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestCard = card;
    }
  }

  if (!bestCard) {
    hideMobileSpeciesPreview();
    return;
  }

  const thumbnail =
    bestCard.dataset.imageThumbnail;

  const credit =
    bestCard.dataset.imageCredit || "";

  const license =
    bestCard.dataset.imageLicense || "";

  if (!thumbnail) {
    hideMobileSpeciesPreview();
    return;
  }

  showMobileSpeciesPreview(
    thumbnail,
    bestCard.dataset.imageAlt || "",
    credit,
    license
  );
}

function showMobileSpeciesPreview(
  thumbnail,
  alt,
  credit,
  license
) {
  if (!speciesImagePreview) {
    return;
  }

  speciesImagePreviewImg.src = thumbnail;
  speciesImagePreviewImg.alt = alt;

  const creditParts = [];

  if (credit) {
    creditParts.push(credit);
  }

  if (license) {
    creditParts.push(license);
  }

  speciesImagePreviewCredit.textContent =
    creditParts.join(" · ");

  speciesImagePreview.classList.add(
    "is-mobile-visible"
  );

  speciesImagePreview.setAttribute(
    "aria-hidden",
    "false"
  );
}

function hideMobileSpeciesPreview() {
  if (!speciesImagePreview) {
    return;
  }

  speciesImagePreview.classList.remove(
    "is-mobile-visible"
  );

  speciesImagePreview.setAttribute(
    "aria-hidden",
    "true"
  );
}

function cleanupMobileSpeciesImageObserver() {
  if (mobileSpeciesObserver) {
    mobileSpeciesObserver.disconnect();
    mobileSpeciesObserver = null;
  }

  mobileVisibleSpecies.clear();
}

window.addEventListener("resize", () => {
  if (window.innerWidth <= 480) {
    setupMobileSpeciesImageObserver();
  } else {
    cleanupMobileSpeciesImageObserver();
    hideMobileSpeciesPreview();
  }
});

function positionSpeciesPreview(
  mouseX,
  mouseY
) {
  const gap = 18;

  const width =
    speciesImagePreview.offsetWidth || 192;

  const height =
    speciesImagePreview.offsetHeight || 250;

  let left = mouseX + gap;
  let top = mouseY + gap;

  if (
    left + width >
    window.innerWidth - 10
  ) {
    left = mouseX - width - gap;
  }

  if (
    top + height >
    window.innerHeight - 10
  ) {
    top = mouseY - height - gap;
  }

  left = Math.max(
    10,
    Math.min(
      left,
      window.innerWidth - width - 10
    )
  );

  top = Math.max(
    10,
    Math.min(
      top,
      window.innerHeight - height - 10
    )
  );

  speciesImagePreview.style.left =
    `${left}px`;

  speciesImagePreview.style.top =
    `${top}px`;
}

function setStatus(message, tone) {
  statusEl.textContent = message || "";
  if (tone) {
    statusEl.setAttribute("data-tone", tone);
  } else {
    statusEl.removeAttribute("data-tone");
  }
}

function scrollToResultsOnMobile() {
  requestAnimationFrame(() => {
    const top =
      resultsEl.getBoundingClientRect().top +
      window.scrollY -
      20;

    window.scrollTo({
      top,
      behavior: "smooth"
    });
  });
}

// --- geocoding (OpenStreetMap Nominatim) --------------------------------

async function geocode(place) {
  const key = place.trim().toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  const url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=en&q=" +
    encodeURIComponent(place);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Location search is temporarily unavailable. Please try again shortly.");
  }
  const data = await res.json();
  if (!data.length) return null;

  const result = {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    displayName: data[0].display_name,
  };
  geocodeCache.set(key, result);
  return result;
}

// --- H3 grid helpers -----------------------------------------------------

// H3 cell indexes are 64-bit and exceed JS's safe integer range (2^53).
// We keep them as BigInt and interpolate them as literal integers directly
// into the SQL text, never through a bound parameter that could coerce
// them to a lossy JS Number.
function hexCellToDecimalString(h3HexIndex) {
  return BigInt("0x" + h3HexIndex).toString();
}

function cellsAroundLocation(lat, lon) {
  const centerCell = h3.latLngToCell(lat, lon, RESOLUTION);
  const ring = h3.gridDisk(centerCell, SEARCH_RING);
  return ring.map(hexCellToDecimalString);
}

// --- data lookup ------------------------------------------------------

async function findSpeciesNear(lat, lon) {
  const worker = await getDbWorker();
  const cellIds = cellsAroundLocation(lat, lon);

  const cellRows = await worker.db.query(
    `SELECT species_json
     FROM cell_species
     WHERE h3_cell IN (${cellIds.join(",")})`
  );

  // Merge species across the returned cells:
  // sum occurrence counts and keep the most recent sighting year.
  const merged = new Map();

  for (const row of cellRows) {
    const entries = JSON.parse(row.species_json);

    for (const entry of entries) {
      const existing = merged.get(entry.id);

      if (existing) {
        existing.count += entry.n;

        if (
          entry.y &&
          (!existing.year || entry.y > existing.year)
        ) {
          existing.year = entry.y;
        }
      } else {
        merged.set(entry.id, {
          count: entry.n,
          year: entry.y || null,
        });
      }
    }
  }

  if (merged.size === 0) {
    return [];
  }

  const plantIds = [...merged.keys()];

  const [speciesRows, edibilityRows] = await Promise.all([
    worker.db.query(
      `SELECT
         plant_id,
         scientific_name,
         common_name,
         family,
         source_url,
         edibility_rating,
         gbif_image_url,
         gbif_image_thumbnail_url
       FROM species
       WHERE plant_id IN (${plantIds.join(",")})`
    ),

    worker.db.query(
      `SELECT
         plant_id,
         part,
         use,
         preparation,
         condition,
         notes
       FROM edibility_details
       WHERE plant_id IN (${plantIds.join(",")})`
    ),
  ]);

  const detailsByPlant = new Map();

  for (const row of edibilityRows) {
    if (!detailsByPlant.has(row.plant_id)) {
      detailsByPlant.set(row.plant_id, []);
    }

    detailsByPlant.get(row.plant_id).push(row);
  }

  const results = speciesRows.map((s) => ({
    ...s,
    occurrenceCount: merged.get(s.plant_id).count,
    lastSeenYear: merged.get(s.plant_id).year,
    details: detailsByPlant.get(s.plant_id) || [],
    randomFactor: Math.random(),
  }));

  // Nuovo ranking.
  sortResults(results);

  return results;
}

/* -----------------------------
   Text helpers
----------------------------- */

function cleanText(text) {
  return (text || "")
    .replace(/\s+/g, " ")
    .replace(/\s+\./g, ".")
    .trim();
}

function splitValues(value) {
  return (value || "")
    .split(";")
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
}

function humanizePart(part) {
  const labels = {
    fruit: "Fruit",
    seed: "Seeds",
    leaf: "Leaves",
    root: "Roots",
    flower: "Flowers",
    shoot: "Shoots",
    stem: "Stems",
    bulb: "Bulbs",
    tuber: "Tubers",
    bark: "Bark",
    rhizome: "Rhizomes",
    sap: "Sap",
    cambium: "Cambium",
    young: "Young growth"
  };

  return splitValues(part)
    .map(p => labels[p] || p.charAt(0).toUpperCase() + p.slice(1))
    .join(" + ");
}

function humanizePreparation(preparation) {
  const labels = {
    raw: "raw",
    cooked: "cooked",
    dried: "dried",
    ground: "ground",
    roasted: "roasted",
    boiled: "boiled",
    fried: "fried",
    powdered: "powdered",
    tea: "tea",
    juice: "juice",
    extract: "extract"
  };

  return splitValues(preparation)
    .map(p => labels[p] || p)
    .join(" · ");
}

function humanizeCondition(condition) {
  const labels = {
    young: "young",
    immature: "immature",
    ripe: "ripe",
    unripe: "unripe",
    fresh: "fresh",
    dried: "dried"
  };

  return splitValues(condition)
    .map(c => labels[c] || c)
    .join(" · ");
}

/* -----------------------------
   Edible-part grouping
----------------------------- */

function getPartSet(details) {
  const parts = new Set();

  for (const detail of details || []) {
    for (const part of splitValues(detail.part)) {
      parts.add(part);
    }
  }

  return parts;
}

function groupDetailsByPart(details) {
  const groups = new Map();

  for (const detail of details || []) {
    const parts = splitValues(detail.part);

    /*     
    if (!parts.length) {
          const key = "other";
    
          if (!groups.has(key)) {
            groups.set(key, []);
          }
    
          groups.get(key).push(detail);
          continue;
        } 
    */

    for (const part of parts) {
      if (!groups.has(part)) {
        groups.set(part, []);
      }

      groups.get(part).push(detail);
    }
  }

  return groups;
}


/* -----------------------------
   Ranking
----------------------------- */

function getRandomFactor() {
  return Math.random();
}

function getRankingScore(species) {
  const rating = Number(species.edibility_rating) || 0;
  const occurrence = Math.max(
    0,
    Number(species.occurrenceCount) || 0
  );

  const parts = getPartSet(species.details);

  /*
   * 1. EDIBILITY
   *
   * 3 -> 0
   * 4 -> 2.5
   * 5 -> 5
   */
  const ratingScore =
    Math.max(0, 5 - rating) * 1.5;


  /*
   * 2. RARITY
   *
   * 1 occourrence  -> ~4.0
   * 2              -> ~3.4
   * 5              -> ~2.3
   * 10             -> ~1.7
   * 50             -> ~0.7
   * 100            -> ~0.5
   *
   */
  const rarityScore =
    4 / Math.sqrt(occurrence + 1);


  /*
   * 3. GEOGRAPHICAL PRESENCE
   */
  const frequencyScore =
    0.35 * Math.log1p(occurrence);


  /*
   * 4. DIVERSITY
   */
  const diversityBonus =
    Math.min(parts.size, 5) * 0.8;


  /*
   * 5. PENALITY FOR "ONLY FRUITS"
   */
  const hasFruit = parts.has("fruit");
  const hasOtherParts = parts.size > 1;

  const fruitPenalty =
    hasFruit && !hasOtherParts
      ? 2.5
      : hasFruit
        ? 0.8
        : 0;

  /*
   * 6. RANDOMIZATION
   *
   * randomFactor: 0 → 1
   * randomBonus: 0 → 1.2
   */
  const randomBonus =
    (species.randomFactor ?? 0.5) * 1.2;

  return (
    ratingScore +
    rarityScore +
    frequencyScore +
    diversityBonus -
    fruitPenalty +
    randomBonus
  );
}


function sortResults(results) {
  return results.sort((a, b) => {
    const scoreDiff =
      getRankingScore(b) -
      getRankingScore(a);

    if (Math.abs(scoreDiff) > 0.001) {
      return scoreDiff;
    }

    /*
     * Tie-breaker
     */
    return (
      (a.occurrenceCount || 0) -
      (b.occurrenceCount || 0)
    );
  });
}


function sortResults(results) {
  return results.sort((a, b) => {
    const scoreDiff =
      getRankingScore(b) - getRankingScore(a);

    if (Math.abs(scoreDiff) > 0.001) {
      return scoreDiff;
    }

    return (
      (b.occurrenceCount || 0) -
      (a.occurrenceCount || 0)
    );
  });
}


/* -----------------------------
   Human-readable detail
----------------------------- */

function renderDetail(detail) {
  const span = document.createElement("span");
  span.className = "edibility-meta";

  const preparation = humanizePreparation(
    detail.preparation || detail.use
  );

  const condition = humanizeCondition(detail.condition);

  const meta = [];

  if (preparation) {
    meta.push(preparation);
  }

  if (condition) {
    meta.push(condition);
  }

  span.textContent = meta.join(" · ");

  return span;
}


/* -----------------------------
   Render all edible information
   grouped by edible part
----------------------------- */

function renderEdibility(details) {
  const container = document.createElement("div");
  container.className = "edibility-details";

  const groups = groupDetailsByPart(details);

  const partOrder = [
    "fruit",
    "seed",
    "leaf",
    "shoot",
    "stem",
    "flower",
    "root",
    "tuber",
    "bulb",
    "rhizome",
    "bark",
    "sap",
    "cambium"
  ];

  const orderedGroups = [...groups.entries()].sort(
    ([a], [b]) => {
      const ia = partOrder.indexOf(a);
      const ib = partOrder.indexOf(b);

      const va = ia === -1 ? 999 : ia;
      const vb = ib === -1 ? 999 : ib;

      return va - vb;
    }
  );

  for (const [part, partDetails] of orderedGroups) {
    const section = document.createElement("section");
    section.className = "edible-part";

    const heading = document.createElement("h4");
    heading.textContent = humanizePart(part);

    section.appendChild(heading);

    const list = document.createElement("span");
    list.className = "edible-part__list"

    const seen = new Set();

    for (const detail of partDetails) {
      const key = [
        detail.part || "",
        detail.preparation || "",
        detail.condition || "",
        detail.notes || ""
      ].join("|");

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      list.appendChild(renderDetail(detail));
    }

    if (list.children.length) {
      section.appendChild(list);
    }

    container.appendChild(section);
  }

  return container;
}

// --- rendering ----------------------------------------------------------

function ratingDots(rating) {
  const filled = Math.max(0, Math.min(5, rating || 0));
  let out = "";
  for (let i = 0; i < 5; i++) {
    out += i < filled ? "●" : '<span class="dim">●</span>';
  }
  return out;
}

function renderResults(place, species, page = 1) {
  resultsEl.innerHTML = "";

  currentSpecies = species || [];
  currentPlace = place;
  currentPage = page;

  if (currentSpecies.length === 0) {
    resultsEl.innerHTML = `
      <p class="result-meta">
        No edible species have been recorded near
        ${escapeHtml(place)}
        yet in this dataset.
        That doesn't mean nothing grows there. GBIF's coverage varies by region and the results are limited to Europe.
      </p>
    `;
    return;
  }

  const totalResults = currentSpecies.length;
  const totalPages = Math.ceil(totalResults / PAGE_SIZE);

  // Mantiene la pagina sempre valida
  currentPage = Math.max(1, Math.min(currentPage, totalPages));

  const start = (currentPage - 1) * PAGE_SIZE;
  const end = start + PAGE_SIZE;

  const visibleResults = currentSpecies.slice(start, end);
  preloadSpeciesImages(visibleResults);

  // Meta informazioni
  const meta = document.createElement("p");
  meta.className = "result-meta";

  if (totalPages > 1) {
    meta.textContent =
      `Showing ${start + 1}–${Math.min(end, totalResults)} of ${totalResults} edible species recorded near ${place}.`;
  } else {
    meta.textContent =
      `${totalResults} edible species recorded near ${place}.`;
  }

  resultsEl.appendChild(meta);

  // Cards
  for (const s of visibleResults) {
    const card = document.createElement("article");
    card.className = "species";

    if (s.gbif_image_thumbnail_url) {
      setupSpeciesImageHover(card, s);

      // Dati utilizzati dal preview mobile
      card.dataset.imageThumbnail =
        s.gbif_image_thumbnail_url;

      card.dataset.imageCredit =
        s.gbif_image_credit || "";

      card.dataset.imageLicense =
        s.gbif_image_license || "";

      card.dataset.imageAlt =
        s.scientific_name ||
        s.common_name ||
        "";
    }

    const head = document.createElement("div");
    head.className = "species__head";

    const nameBlock = document.createElement("div");

    const name = document.createElement("h3");
    name.className = "species__name";
    name.textContent =
      s.common_name || s.scientific_name;

    nameBlock.appendChild(name);

    const sci = document.createElement("p");
    sci.className = "species__sci";
    sci.textContent = s.common_name
      ? `${s.scientific_name}${s.family ? " · " + s.family : ""}`
      : s.family || "";

    nameBlock.appendChild(sci);
    head.appendChild(nameBlock);

    card.appendChild(head);

    if (s.details.length) {
      card.appendChild(
        renderEdibility(s.details)
      );
    }

    if (s.source_url) {
      const link = document.createElement("a");
      link.className = "species__link";
      link.href = s.source_url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent =
        "Full profile on Plants For A Future →";

      card.appendChild(link);
    }

    resultsEl.appendChild(card);
  }

  // Paginazione
  if (totalPages > 1) {
    resultsEl.appendChild(
      renderPagination(totalPages)
    );
  }

  if (window.innerWidth <= 480) {
    requestAnimationFrame(() => {
      setupMobileSpeciesImageObserver();
    });
  }
}


function preloadSpeciesImages(species) {
  for (const s of species.slice(0, 5)) {
    const url =
      s.gbif_image_thumbnail_url;

    if (!url) continue;

    const img = new Image();
    img.src = url;
  }
}

function renderPagination(totalPages) {
  const nav = document.createElement("nav");
  nav.className = "pagination";
  nav.setAttribute("aria-label", "Results pagination");

  // Previous
  const previous = document.createElement("button");
  previous.type = "button";
  previous.className = "pagination__button";
  previous.textContent = "← Previous";
  previous.disabled = currentPage === 1;

  previous.addEventListener("click", () => {
    if (currentPage > 1) {
      renderResults(
        currentPlace,
        currentSpecies,
        currentPage - 1
      );

      scrollToResults();
    }
  });

  nav.appendChild(previous);

  // Numeri pagina
  const pages = getPaginationPages(
    currentPage,
    totalPages
  );

  for (const page of pages) {
    if (page === "...") {
      const ellipsis = document.createElement("span");
      ellipsis.className = "pagination__ellipsis";
      ellipsis.textContent = "…";
      nav.appendChild(ellipsis);
      continue;
    }

    const pageButton = document.createElement("button");
    pageButton.type = "button";
    pageButton.className = "pagination__button";
    pageButton.textContent = page;

    if (page === currentPage) {
      pageButton.classList.add("is-active");
      pageButton.setAttribute("aria-current", "page");
    }

    pageButton.addEventListener("click", () => {
      renderResults(
        currentPlace,
        currentSpecies,
        page
      );

      scrollToResults();
    });

    nav.appendChild(pageButton);
  }

  // Next
  const next = document.createElement("button");
  next.type = "button";
  next.className = "pagination__button";
  next.textContent = "Next →";
  next.disabled = currentPage === totalPages;

  next.addEventListener("click", () => {
    if (currentPage < totalPages) {
      renderResults(
        currentPlace,
        currentSpecies,
        currentPage + 1
      );

      scrollToResults();
    }
  });

  nav.appendChild(next);

  return nav;
}

function getPaginationPages(current, total) {
  if (total <= 7) {
    return Array.from(
      { length: total },
      (_, i) => i + 1
    );
  }

  const pages = [];

  pages.push(1);

  if (current > 4) {
    pages.push("...");
  }

  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  for (let i = start; i <= end; i++) {
    pages.push(i);
  }

  if (current < total - 3) {
    pages.push("...");
  }

  pages.push(total);

  return pages;
}

function scrollToResults() {
  resultsEl.scrollIntoView({
    behavior: "smooth",
    block: "start"
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- form wiring ----------------------------------------------------

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const place = input.value.trim();

  if (!place) return;

  button.disabled = true;
  resultsEl.innerHTML = "";

  setStatus("Looking up that place…");

  try {
    const location = await geocode(place);

    if (!location) {
      setStatus(
        `Couldn't find "${place}". Try a nearby city or a more specific name.`,
        "error"
      );
      return;
    }

    setStatus(
      `Searching wild food records near ${location.displayName}…`
    );

    const species = await findSpeciesNear(
      location.lat,
      location.lon
    );

    setStatus("");

    renderResults(
      location.displayName,
      species
    );
  } catch (err) {
    console.error(err);

    setStatus(
      err.message ||
      "Something went wrong. Please try again.",
      "error"
    );
  } finally {
    button.disabled = false;
  }
});

// Warm up the DB worker as soon as the page loads, so the first search
// doesn't pay the WASM initialization cost.
getDbWorker().catch((err) => console.error("DB init failed:", err));
