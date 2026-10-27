// Fillable form fields: drawn as real HTML inputs over the page.
import { state, beginChange, emit } from './state.js';
import { getWidgets } from './pdf.js';

function currentValue(docId, w) {
  const vals = state.forms[docId] || {};
  if (Object.prototype.hasOwnProperty.call(vals, w.fieldName)) return vals[w.fieldName];
  if (w.checkBox) return !!w.fieldValue && w.fieldValue !== 'Off' && (w.exportValue ? w.fieldValue === w.exportValue : true);
  if (w.radioButton) return w.fieldValue && w.fieldValue !== 'Off' ? w.fieldValue : null;
  if (Array.isArray(w.fieldValue)) return w.fieldValue[0] ?? '';
  return w.fieldValue ?? '';
}

function setValue(docId, name, value) {
  beginChange();
  if (!state.forms[docId]) state.forms[docId] = {};
  state.forms[docId][name] = value;
  emit('forms', { docId, name });
}

export async function renderForms(pv) {
  const { entry, formLayer } = pv;
  if (!entry.docId) { formLayer.replaceChildren(); return; }
  const vp = pv.vp;
  const widgets = await getWidgets(entry);
  if (pv.vp !== vp || !formLayer.isConnected) return; // a newer render took over
  formLayer.replaceChildren();
  const docId = entry.docId;
  for (const w of widgets) {
    const [x1, y1, x2, y2] = w.rect;
    const a = vp.convertToViewportPoint(x1, y1);
    const b = vp.convertToViewportPoint(x2, y2);
    const left = Math.min(a[0], b[0]); const top = Math.min(a[1], b[1]);
    const width = Math.abs(b[0] - a[0]); const height = Math.abs(b[1] - a[1]);
    if (width < 2 || height < 2) continue;
    const val = currentValue(docId, w);
    let input;
    if (w.fieldType === 'Btn' && w.checkBox) {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!val;
      input.addEventListener('change', () => setValue(docId, w.fieldName, input.checked));
    } else if (w.fieldType === 'Btn' && w.radioButton) {
      input = document.createElement('input');
      input.type = 'radio';
      input.name = `${docId}::${w.fieldName}`;
      input.checked = val != null && val === w.buttonValue;
      input.addEventListener('change', () => { if (input.checked) setValue(docId, w.fieldName, w.buttonValue); });
    } else if (w.fieldType === 'Ch') {
      input = document.createElement('select');
      if (!w.combo || w.multiSelect) input.size = 1;
      const opts = w.options || [];
      if (!opts.some((o) => o.exportValue === val)) input.append(new Option('', ''));
      for (const o of opts) input.append(new Option(o.displayValue ?? o.exportValue, o.exportValue));
      input.value = val ?? '';
      input.addEventListener('change', () => setValue(docId, w.fieldName, input.value));
    } else if (w.fieldType === 'Tx') {
      input = document.createElement(w.multiLine ? 'textarea' : 'input');
      if (!w.multiLine) input.type = w.password ? 'password' : 'text';
      input.value = val ?? '';
      if (w.maxLen) input.maxLength = w.maxLen;
      input.addEventListener('change', () => setValue(docId, w.fieldName, input.value));
      const fs = w.multiLine ? Math.min(14 * vp.scale, height * 0.8) : Math.max(8, Math.min(height * 0.68, 18 * vp.scale));
      input.style.fontSize = `${fs}px`;
      if (w.textAlignment === 1) input.style.textAlign = 'center';
      if (w.textAlignment === 2) input.style.textAlign = 'right';
    } else continue;
    input.className = 'form-field';
    input.title = w.alternativeText || w.fieldName;
    if (w.readOnly) input.disabled = true;
    Object.assign(input.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    input.addEventListener('keydown', (e) => e.stopPropagation());
    formLayer.append(input);
  }
}
