/**
 * Demo graph bootstrapper.
 * Loads graph-data.json, hydrates shim state, and launches the graph.
 */
import { hydrateFromJSON } from './shims/state.js';
import { showGraphPopup } from './graph.js';

// Provide a toastr shim (graph.js uses it for warnings)
if (!window.toastr) {
    window.toastr = {
        info: (msg) => console.log('[toastr:info]', msg),
        success: (msg) => console.log('[toastr:success]', msg),
        warning: (msg) => console.log('[toastr:warning]', msg),
        error: (msg) => console.error('[toastr:error]', msg),
    };
}

export async function launchGraph() {
    try {
        const resp = await fetch('graph-data.json');
        const data = await resp.json();
        hydrateFromJSON(data);
        await showGraphPopup();
    } catch (err) {
        console.error('Failed to launch graph:', err);
        const container = document.getElementById('dle-graph-container');
        if (container) container.innerHTML += '<p style="color:#f44;padding:20px;text-align:center;">Failed to load graph data.</p>';
    }
}
