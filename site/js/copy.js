// Copy buttons: <button data-copy="some-id"> copies the text of the element with that id (the Terminal
// install line). The button says "Copied" for two seconds. Where the clipboard is not allowed, the line
// is selected instead so the person can press Command-C.

/** The label a copy button shows after a click: "Copied" when the clipboard took the text, else a hint. */
export function copiedLabel(ok) {
  return ok ? 'Copied' : 'Press Command-C';
}

export function initCopyButtons() {
  for (const button of document.querySelectorAll('[data-copy]')) {
    const source = document.getElementById(button.dataset.copy);
    if (!source) continue;
    const label = button.textContent;
    button.addEventListener('click', async () => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(source.textContent.trim());
        ok = true;
      } catch {
        selectText(source); // no clipboard access (old browser, or not https): select it instead
      }
      button.textContent = copiedLabel(ok);
      setTimeout(() => { button.textContent = label; }, 2000);
    });
  }
}

/** Selects all the text inside an element. */
function selectText(element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}
