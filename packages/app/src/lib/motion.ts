/**
 * Sliding selection plates. A container with `data-plate="<selector>"` gets
 * one `.plate` that glides to its first visible element matching the
 * selector; every `.seg` group gets one under its pressed button. The first
 * placement and a re-appearance snap; later moves glide (see `.plate`).
 * Plugins get the same plates by using the same attributes.
 */
function set(element: HTMLElement, key: string, value: string): void {
  if (element.style.getPropertyValue(key) !== value) {
    element.style.setProperty(key, value);
  }
}

const isOwn = (mutation: MutationRecord) =>
  mutation.target instanceof Element &&
  mutation.target.classList.contains("plate");

export function installMotion(root: Document): () => void {
  function place(): void {
    for (const seg of root.querySelectorAll<HTMLElement>(
      ".seg:not([data-plate])",
    )) {
      seg.dataset.plate = 'button[aria-pressed="true"]';
    }
    for (const box of root.querySelectorAll<HTMLElement>("[data-plate]")) {
      let plate = box.querySelector<HTMLElement>(":scope > .plate");
      if (!plate) {
        plate = root.createElement("span");
        plate.className = "plate";
        plate.setAttribute("aria-hidden", "true");
        box.prepend(plate);
        if (getComputedStyle(box).position === "static") {
          box.style.position = "relative";
        }
      }
      const selector = box.dataset.plate ?? "";
      const current = [...box.querySelectorAll<HTMLElement>(selector)].find(
        (element) => element.offsetParent !== null,
      );
      if (!current || box.offsetParent === null) {
        set(plate, "opacity", "0");
        delete plate.dataset.ready;
        continue;
      }
      // Layout offsets, not client rects: rows that are still animating in
      // would place the plate off by their transform.
      let x = 0;
      let y = 0;
      for (
        let node: HTMLElement | null = current;
        node && node !== box;
        node = node.offsetParent as HTMLElement | null
      ) {
        x += node.offsetLeft;
        y += node.offsetTop;
        if (!box.contains(node.offsetParent)) {
          x -= box.offsetLeft;
          y -= box.offsetTop;
          break;
        }
      }
      const isSnap = plate.dataset.ready === undefined;
      if (isSnap) plate.style.transition = "none";
      set(plate, "opacity", "1");
      set(plate, "--x", `${Math.round(x)}px`);
      set(plate, "--y", `${Math.round(y)}px`);
      set(plate, "--w", `${current.offsetWidth}px`);
      set(plate, "--h", `${current.offsetHeight}px`);
      if (isSnap) {
        plate.getBoundingClientRect();
        plate.style.transition = "";
        plate.dataset.ready = "1";
      }
    }
  }

  let queued = 0;
  const kick = () => {
    if (queued) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      place();
    });
  };
  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => !isOwn(mutation))) kick();
  });
  observer.observe(root.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-current", "aria-pressed", "class", "style"],
  });
  const view = root.defaultView;
  view?.addEventListener("resize", kick);
  void root.fonts?.ready.then(kick);
  kick();
  return () => {
    observer.disconnect();
    view?.removeEventListener("resize", kick);
    if (queued) cancelAnimationFrame(queued);
  };
}
