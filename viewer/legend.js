// legend.js: the map legend (swatches, overlay toggles). panel.js calls P.legend.setup() at load and on mode change.
// LAY-12c (b389): split out of panel.js; registers P.legend on window.C4PM_PANEL_PARTS (viewModel.js creates it).
(function(){
  'use strict';

  const P = window.C4PM_PANEL_PARTS;
  if (!P) return;
  const map = window.C4PM_MAP;

  // ===== Legend =====
  function setupLegend() {
    const legend = document.getElementById('legend');
    if (!legend) return;

    legend.innerHTML = '';

    // Swatches
    const swatchesDiv = document.createElement('div');
    swatchesDiv.style.display = 'flex';
    swatchesDiv.style.flexDirection = 'column';
    swatchesDiv.style.gap = '8px';

    // b142: the swatches come from the kind table (C4PM_MODE.legend): the arch kinds, plus the kinds of the current view (screen in io)
    const kinds = (window.C4PM_MODE ? window.C4PM_MODE.legend() : []).map(r => ({ label: r.label, varName: '--' + r.color }));

    kinds.forEach(kind => {
      const swatchRow = document.createElement('div');
      swatchRow.style.display = 'flex';
      swatchRow.style.alignItems = 'center';
      swatchRow.style.gap = '8px';
      swatchRow.style.fontSize = '12px';

      const swatch = document.createElement('div');
      swatch.style.width = '16px';
      swatch.style.height = '16px';
      swatch.style.borderRadius = '2px';
      swatch.style.background = 'var(' + kind.varName + ')';
      swatch.style.flexShrink = '0';
      swatchRow.appendChild(swatch);

      const label = document.createElement('span');
      label.textContent = kind.label;
      swatchRow.appendChild(label);

      swatchesDiv.appendChild(swatchRow);
    });
    legend.appendChild(swatchesDiv);

    // Overlay toggles
    const togglesDiv = document.createElement('div');
    togglesDiv.style.display = 'flex';
    togglesDiv.style.flexDirection = 'column';
    togglesDiv.style.gap = '8px';
    togglesDiv.style.marginTop = '12px';
    togglesDiv.style.paddingTop = '12px';
    togglesDiv.style.borderTop = '1px solid var(--line)';

    if (map && map.setOverlay && map.overlays) {
      const overlayNames = ['drift', 'findings', 'stubs'];
      if (window.C4PM_DATA && window.C4PM_DATA.board) overlayNames.push('board');   // P16-B29: only a page with a board lists it
      if (window.C4PM_DATA && window.C4PM_DATA.tests) overlayNames.push('tests');   // Phase 26 (T26-10): only a page with tests lists it
      overlayNames.forEach(name => {
        const label = document.createElement('label');
        label.style.display = 'flex';
        label.style.gap = '6px';
        label.style.alignItems = 'center';
        label.style.fontSize = '13px';
        label.style.cursor = 'pointer';
        label.style.userSelect = 'none';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = map.overlays[name] || false;
        checkbox.addEventListener('change', () => {
          map.setOverlay(name, checkbox.checked);
        });
        label.appendChild(checkbox);

        const labelText = document.createElement('span');
        labelText.textContent = name.charAt(0).toUpperCase() + name.slice(1);
        label.appendChild(labelText);

        togglesDiv.appendChild(label);
      });
    }
    legend.appendChild(togglesDiv);

    // Hints
    const hintsDiv = document.createElement('div');
    hintsDiv.style.fontSize = '12px';
    hintsDiv.style.color = 'var(--muted)';
    hintsDiv.style.marginTop = '12px';
    hintsDiv.style.paddingTop = '12px';
    hintsDiv.style.borderTop = '1px solid var(--line)';
    hintsDiv.textContent = 'scroll to zoom · drag to pan · double-click to dive';
    legend.appendChild(hintsDiv);
  }

  P.legend = { setup: setupLegend };
})();
