// Shim for SillyTavern's popup.js
export const POPUP_TYPE = { TEXT: 1, DISPLAY: 2 };

export async function callGenericPopup(content, type, title, opts) {
    // The graph.js creates its own DOM and passes it as `content`.
    // In the real ST, callGenericPopup wraps it in a dialog.
    // For the demo, we just append it to our container.
    const container = document.getElementById('dle-graph-container');
    if (!container) return;
    container.innerHTML = '';
    if (content instanceof HTMLElement) {
        container.appendChild(content);
    } else {
        container.innerHTML = String(content);
    }
    container.style.display = '';
    // Return a promise that never resolves (graph stays open until user closes)
    return new Promise(() => {});
}
