import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.mjs';

const statusEl = document.getElementById('status');
const processBtn = document.getElementById('processBtn');
const downloadPdfBtn = document.getElementById('downloadPdfBtn');
const downloadJsonBtn = document.getElementById('downloadJsonBtn');
const sourcePdfInput = document.getElementById('sourcePdf');
const propertyGrid = document.getElementById('propertyGrid');
const roomsWrap = document.getElementById('roomsWrap');
const preview = document.getElementById('preview');
const previewEmpty = document.getElementById('previewEmpty');
const jsonPreview = document.getElementById('jsonPreview');
const reportTitleInput = document.getElementById('reportTitle');
const reportSubtitleInput = document.getElementById('reportSubtitle');

let latestExtraction = null;
let logoDataUrlPromise = null;

const PROPERTY_STOP_LABELS = ['CREATED ON', 'LOCATION', 'TOTAL AREA', 'FLOORS', 'ROOMS'];
const CREATED_STOP_LABELS = ['LOCATION', 'TOTAL AREA', 'FLOORS', 'ROOMS'];
const LOCATION_STOP_LABELS = ['TOTAL AREA', 'FLOORS', 'ROOMS'];
const ROOMS_STOP_LABELS = ['WIDTH:', 'AREA:', 'THIS FLOOR PLAN'];

function setStatus(message, tone = 'info') {
  statusEl.style.display = 'block';
  statusEl.className = `status ${tone === 'error' ? 'error' : tone === 'warn' ? 'warn' : ''}`.trim();
  statusEl.textContent = message;
}

function clearStatus() {
  statusEl.style.display = 'none';
  statusEl.textContent = '';
  statusEl.className = 'status';
}

function normalizeSpaces(value) {
  return String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function titleCase(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatMultiline(value) {
  return escapeHtml(String(value || '-')).replaceAll('\n', '<br>');
}

function isStopLine(line, stopLabels) {
  const upper = normalizeSpaces(line).toUpperCase();
  return stopLabels.some((label) => upper.startsWith(label));
}

function findLineIndex(lines, label) {
  const target = label.toUpperCase();
  return lines.findIndex((line) => normalizeSpaces(line).toUpperCase() === target);
}

function collectBlock(lines, label, stopLabels) {
  const index = findLineIndex(lines, label);
  if (index < 0) {
    return null;
  }

  const values = [];
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = normalizeSpaces(lines[i]);
    if (!line) {
      continue;
    }
    if (isStopLine(line, stopLabels)) {
      break;
    }
    values.push(line);
  }

  return values.length ? values.join('\n') : null;
}

function extractWithRegex(text, regex) {
  const match = normalizeSpaces(text).match(regex);
  return match ? normalizeSpaces(match[1]) : null;
}

function findField(lines, labels) {
  const variants = Array.isArray(labels) ? labels : [labels];

  for (let i = 0; i < lines.length; i += 1) {
    const line = normalizeSpaces(lines[i]);

    for (const label of variants) {
      if (Array.isArray(label)) {
        const joined = label.map((_, offset) => normalizeSpaces(lines[i + offset])).join(' ');
        if (joined === label.join(' ')) {
          return findNextValue(lines, i + label.length - 1, label[label.length - 1]);
        }
      } else if (line.startsWith(label)) {
        return findNextValue(lines, i, label);
      }
    }
  }

  return null;
}

function findNextValue(lines, index, label) {
  const line = normalizeSpaces(lines[index]);
  const trailing = line.slice(label.length).trim();
  if (trailing) {
    return trailing;
  }

  for (let i = index + 1; i < lines.length; i += 1) {
    const candidate = normalizeSpaces(lines[i]);
    if (!candidate) {
      continue;
    }
    if (/^(PHOTO|PLEASE ADD LOCATION|INPUT TRICKLE VENT)/i.test(candidate)) {
      continue;
    }
    return candidate;
  }

  return null;
}

async function readPdf(file) {
  const buffer = await file.arrayBuffer();
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;
  const pages = [];

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const textContent = await page.getTextContent();
    const rawItems = textContent.items
      .filter((item) => item.str && item.str.trim())
      .map((item) => ({
        str: item.str.replace(/\s+/g, ' ').trim(),
        x: item.transform[4],
        y: item.transform[5]
      }));

    const rows = [];
    rawItems.forEach((item) => {
      let row = rows.find((existing) => Math.abs(existing.y - item.y) < 2.5);
      if (!row) {
        row = { y: item.y, items: [] };
        rows.push(row);
      }
      row.items.push(item);
    });

    rows.sort((a, b) => b.y - a.y);
    const lines = rows
      .map((row) => row.items.sort((a, b) => a.x - b.x).map((item) => item.str).join(' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    pages.push({
      pageNo,
      lines,
      text: normalizeSpaces(lines.join('\n'))
    });
  }

  return {
    name: file.name,
    pages,
    fullText: pages.map((page) => page.text).join('\n\n')
  };
}

function parseSummary(pdf) {
  const firstPage = pdf.pages[0] || { lines: [], text: '' };
  const lines = firstPage.lines.map((line) => normalizeSpaces(line));
  const firstPageText = normalizeSpaces(firstPage.text);
  const totalArea = extractWithRegex(firstPageText, /Total area(?:\s*m²)?[\s\S]{0,80}?(\d+(?:\.\d+)?)(?:\s*m²)?/i);
  const floors = extractWithRegex(firstPageText, /Floors[\s\S]{0,30}?(\d+)/i);
  const roomsSummary =
    collectBlock(lines, 'Rooms', ROOMS_STOP_LABELS) ||
    extractWithRegex(firstPageText, /Rooms[\s\S]{0,120}?([A-Za-z][A-Za-z0-9 ]+\s+\d+(?:\s+\d+)*)/i);

  return {
    report_name: reportTitleInput.value.trim() || 'D1 Ventilation',
    source_file: pdf.name,
    submitted_by: collectBlock(lines, 'SUBMITTED BY', PROPERTY_STOP_LABELS),
    created_on: collectBlock(lines, 'CREATED ON', CREATED_STOP_LABELS),
    location: collectBlock(lines, 'LOCATION', LOCATION_STOP_LABELS),
    total_area_m2: totalArea,
    floors,
    rooms_summary: roomsSummary
  };
}

function uniqueRoomLabel(baseName, index, totals) {
  return totals[baseName] > 1 ? `${baseName} ${index}` : baseName;
}

function parseOpeningsFromLines(lines) {
  const openings = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = normalizeSpaces(lines[i]);
    const match = line.match(/^(\d+)\s+([A-Z][A-Z ]+)$/);
    if (!match) {
      continue;
    }

    let dimensions = null;
    let distance = null;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j += 1) {
      const candidate = normalizeSpaces(lines[j]);
      if (!dimensions) {
        const dimensionMatch = candidate.match(/([\d.]+)\s*m\s*x\s*([\d.]+)\s*m/i);
        if (dimensionMatch) {
          dimensions = {
            width_m: Number(dimensionMatch[1]),
            height_m: Number(dimensionMatch[2])
          };
        }
      }

      if (!distance) {
        const distanceMatch = candidate.match(/([\d.]+)\s*m/i);
        if (/Distance to Floor/i.test(normalizeSpaces(lines[j - 1] || '')) && distanceMatch) {
          distance = Number(distanceMatch[1]);
        }
      }
    }

    openings.push({
      index: Number(match[1]),
      type: titleCase(normalizeSpaces(match[2])),
      width_m: dimensions?.width_m ?? null,
      height_m: dimensions?.height_m ?? null,
      distance_to_floor_m: distance
    });
  }

  return openings;
}

function parseRoomBlock(roomMatch, detailsText, displayName) {
  const detailLines = normalizeSpaces(detailsText).split('\n').map((line) => normalizeSpaces(line)).filter(Boolean);
  const normalizedDetails = normalizeSpaces(detailsText);

  return {
    room_name: displayName,
    floor: normalizeSpaces(roomMatch[2]),
    width_m: Number(roomMatch[3]),
    length_m: Number(roomMatch[4]),
    ceiling_height_m: Number(roomMatch[5]),
    area_m2: Number(roomMatch[6]),
    perimeter_m: Number(roomMatch[7]),
    window_opening_area:
      extractWithRegex(normalizedDetails, /Window opening area[\s\S]*?\n([^\n]+)/i) ||
      findField(detailLines, 'Window opening area( WxH)'),
    trickle_vent_dimensions:
      extractWithRegex(normalizedDetails, /Trickle vent dimensions[\s\S]*?\n([^\n]+)/i) ||
      findField(detailLines, [
        'Trickle vent dimensions (WxH).',
        'Trickle vent dimensions (WxH). (if more than 1 window present please specify and identify accordingly within your',
        ['Trickle vent dimensions (WxH). (if more than 1 window present please specify and identify accordingly within your', 'answer)']
      ]),
    window_opening_angle:
      extractWithRegex(normalizedDetails, /Window opening angle\s*\n([^\n]+)/i) ||
      findField(detailLines, 'Window opening angle'),
    fixed_ventilation:
      extractWithRegex(normalizedDetails, /Is there any fixed ventilation\?\s*\n([^\n]+)/i) ||
      findField(detailLines, 'Is there any fixed ventilation?'),
    ceiling_distance_check:
      extractWithRegex(normalizedDetails, /Is the ventilation system further than 400mm away from the ceiling\?[\s\S]*?\n([^\n]+)/i) ||
      findField(detailLines, 'Is the ventilation system further than 400mm away from the ceiling? (If no system present please ignore)'),
    background_distance_check:
      extractWithRegex(normalizedDetails, /Is the ventilation system further than 500mm away from background ventilation\?[\s\S]*?\n([^\n]+)/i) ||
      findField(detailLines, 'Is the ventilation system further than 500mm away from background ventilation? (If no system present please ignore)'),
    openings: parseOpeningsFromLines(detailLines)
  };
}

function looksLikeRoomHeader(lines, index) {
  const line = normalizeSpaces(lines[index]);
  const next = normalizeSpaces(lines[index + 1]);
  const geometry = normalizeSpaces(lines[index + 2]);
  const areaLine = normalizeSpaces(lines[index + 3]);

  if (!line || !next || !geometry || !areaLine) {
    return false;
  }

  if (!/floor/i.test(next)) {
    return false;
  }

  if (!/^WIDTH:/i.test(geometry)) {
    return false;
  }

  if (!/^AREA:/i.test(areaLine)) {
    return false;
  }

  return true;
}

function extractRoomGeometry(line, areaLine) {
  const geometryMatch = normalizeSpaces(line).match(/WIDTH:\s*([\d.]+)\s*m\s*[•·]?\s*LENGTH:\s*([\d.]+)\s*m\s*[•·]?\s*CEILING HEIGHT:\s*([\d.]+)\s*m/i);
  const areaMatch = normalizeSpaces(areaLine).match(/AREA:\s*([\d.]+)\s*m(?:²|2)?\s*[•·]?\s*PERIMETER:\s*([\d.]+)\s*m/i);

  if (!geometryMatch || !areaMatch) {
    return null;
  }

  return {
    width_m: Number(geometryMatch[1]),
    length_m: Number(geometryMatch[2]),
    ceiling_height_m: Number(geometryMatch[3]),
    area_m2: Number(areaMatch[1]),
    perimeter_m: Number(areaMatch[2])
  };
}

function parseRooms(pdf) {
  const totals = {};
  const rawRooms = [];

  pdf.pages.forEach((page) => {
    const lines = page.lines.map((line) => normalizeSpaces(line)).filter(Boolean);

    for (let i = 0; i < lines.length - 3; i += 1) {
      if (!looksLikeRoomHeader(lines, i)) {
        continue;
      }

      const baseName = normalizeSpaces(lines[i].replace(/^▼\s*/, ''));
      const floor = normalizeSpaces(lines[i + 1]);
      const geometry = extractRoomGeometry(lines[i + 2], lines[i + 3]);
      if (!geometry) {
        continue;
      }

      let j = i + 4;
      const detailLines = [];
      while (j < lines.length && !looksLikeRoomHeader(lines, j)) {
        detailLines.push(lines[j]);
        j += 1;
      }

      rawRooms.push({
        base_name: baseName,
        floor,
        detailsText: detailLines.join('\n'),
        ...geometry
      });
      i = j - 1;
    }
  });

  rawRooms.forEach((room) => {
    const baseName = room.base_name;
    totals[baseName] = (totals[baseName] || 0) + 1;
  });

  const current = {};

  return rawRooms.map((room) => {
    const baseName = room.base_name;
    current[baseName] = (current[baseName] || 0) + 1;
    const displayName = uniqueRoomLabel(baseName, current[baseName], totals);
    const roomMatch = [
      null,
      room.base_name,
      room.floor,
      String(room.width_m),
      String(room.length_m),
      String(room.ceiling_height_m),
      String(room.area_m2),
      String(room.perimeter_m)
    ];

    return parseRoomBlock(roomMatch, room.detailsText, displayName);
  });
}

function extractReport(pdf) {
  return {
    summary: parseSummary(pdf),
    rooms: parseRooms(pdf)
  };
}

function renderPreview(data) {
  preview.style.display = 'block';
  previewEmpty.style.display = 'none';
  propertyGrid.innerHTML = '';
  roomsWrap.innerHTML = '';

  const propertyOrder = [
    ['Submitted by', data.summary.submitted_by],
    ['Created on', data.summary.created_on],
    ['Location', data.summary.location],
    ['Total area', data.summary.total_area_m2 ? `${data.summary.total_area_m2} m²` : null],
    ['Floors', data.summary.floors],
    ['Rooms', data.summary.rooms_summary]
  ];

  propertyOrder.forEach(([key, value]) => {
    const div = document.createElement('div');
    div.className = 'kv';
    div.innerHTML = `<div class="k">${escapeHtml(key)}</div><div class="v">${formatMultiline(value)}</div>`;
    propertyGrid.appendChild(div);
  });

  data.rooms.forEach((room) => {
    const card = document.createElement('div');
    card.className = 'room-card';

    const facts = [
      ['Floor', room.floor],
      ['Width', `${room.width_m} m`],
      ['Length', `${room.length_m} m`],
      ['Ceiling height', `${room.ceiling_height_m} m`],
      ['Area', `${room.area_m2} m²`],
      ['Perimeter', `${room.perimeter_m} m`],
      ['Window opening area (W x H)', room.window_opening_area],
      ['Trickle vent dimensions (W x H)', room.trickle_vent_dimensions],
      ['Window opening angle', room.window_opening_angle],
      ['Fixed ventilation', room.fixed_ventilation],
      ['System 400 mm from ceiling', room.ceiling_distance_check],
      ['System 500 mm from background vent', room.background_distance_check]
    ];

    const openingsHtml = room.openings.length
      ? room.openings.map((opening) => `
          <div class="opening">
            <strong>${escapeHtml(`${opening.index}. ${opening.type}`)}</strong><br>
            ${escapeHtml(`${opening.width_m} m x ${opening.height_m} m`)}<br>
            ${escapeHtml(`Distance to floor: ${opening.distance_to_floor_m} m`)}
          </div>
        `).join('')
      : '<div class="mini">No doors or windows were extracted for this room.</div>';

    card.innerHTML = `
      <div class="room-head">
        <div>
          <h3>${escapeHtml(room.room_name)}</h3>
          <div class="sub">${escapeHtml(room.floor)}</div>
        </div>
      </div>
      <div class="facts">
        ${facts.map(([label, value]) => `<div class="fact"><b>${escapeHtml(label)}</b>${formatMultiline(value)}</div>`).join('')}
      </div>
      <div>
        <div class="section-title section-subtitle">Doors and windows</div>
        ${openingsHtml}
      </div>
    `;
    roomsWrap.appendChild(card);
  });

  jsonPreview.textContent = JSON.stringify(data, null, 2);
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function loadLogoDataUrl() {
  if (!logoDataUrlPromise) {
    logoDataUrlPromise = new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) {
          resolve(null);
          return;
        }
        context.drawImage(image, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = () => resolve(null);
      image.src = './domna-logo.png';
    });
  }

  return logoDataUrlPromise;
}

async function buildSummaryPdf(data) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const margin = 14;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - margin * 2;
  const logoDataUrl = await loadLogoDataUrl();
  let y = margin;

  function addPageIfNeeded(required = 14) {
    if (y + required > pageHeight - margin) {
      doc.addPage();
      y = margin;
    }
  }

  function textBlock(text, options = {}) {
    const {
      size = 10,
      bold = false,
      color = [32, 48, 73],
      x = margin,
      width = contentWidth,
      gap = 1.6
    } = options;

    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(...color);
    const lines = doc.splitTextToSize(String(text || '-'), width);
    const height = lines.length * (size * 0.42 + gap) + 1.2;
    addPageIfNeeded(height);
    doc.text(lines, x, y);
    y += height;
  }

  function labelValue(label, value) {
    const labelWidth = 44;
    addPageIfNeeded(8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(58, 74, 99);
    doc.text(`${label}:`, margin, y);
    doc.setFont('helvetica', 'normal');
    const lines = doc.splitTextToSize(String(value || '-'), contentWidth - labelWidth);
    doc.text(lines, margin + labelWidth, y);
    y += lines.length * 4.6 + 1.2;
  }

  function divider() {
    addPageIfNeeded(5);
    doc.setDrawColor(208, 216, 229);
    doc.line(margin, y, pageWidth - margin, y);
    y += 4;
  }

  doc.setFillColor(241, 246, 255);
  doc.roundedRect(margin, y, contentWidth, 31, 4, 4, 'F');
  if (logoDataUrl) {
    doc.addImage(logoDataUrl, 'PNG', margin + 5, y + 5, 26, 12);
  }
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(19, 54, 104);
  doc.text(reportTitleInput.value.trim() || 'D1 Ventilation', margin + 36, y + 10);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(63, 78, 102);
  const subtitle = reportSubtitleInput.value.trim() || 'Extracted from a single Domna ventilation report PDF';
  doc.text(doc.splitTextToSize(subtitle, contentWidth - 42), margin + 36, y + 17);
  y += 38;

  textBlock('Property details', { size: 13, bold: true, color: [23, 39, 64] });
  labelValue('Submitted by', data.summary.submitted_by);
  labelValue('Created on', data.summary.created_on);
  labelValue('Location', data.summary.location);
  labelValue('Total area', data.summary.total_area_m2 ? `${data.summary.total_area_m2} m²` : null);
  labelValue('Floors', data.summary.floors);
  labelValue('Rooms', data.summary.rooms_summary);

  divider();
  textBlock('Room schedule', { size: 13, bold: true, color: [23, 39, 64] });

  data.rooms.forEach((room, index) => {
    addPageIfNeeded(40);
    if (index > 0) {
      divider();
    }

    textBlock(room.room_name, { size: 12, bold: true, color: [19, 54, 104] });
    textBlock(room.floor, { size: 10, color: [96, 112, 134] });
    labelValue('Width', `${room.width_m} m`);
    labelValue('Length', `${room.length_m} m`);
    labelValue('Ceiling height', `${room.ceiling_height_m} m`);
    labelValue('Area', `${room.area_m2} m²`);
    labelValue('Perimeter', `${room.perimeter_m} m`);
    labelValue('Window opening area', room.window_opening_area);
    labelValue('Trickle vent dimensions', room.trickle_vent_dimensions);
    labelValue('Window opening angle', room.window_opening_angle);
    labelValue('Fixed ventilation', room.fixed_ventilation);
    labelValue('System 400 mm from ceiling', room.ceiling_distance_check);
    labelValue('System 500 mm from background vent', room.background_distance_check);

    if (room.openings.length) {
      textBlock('Doors and windows', { size: 11, bold: true, color: [23, 39, 64] });
      room.openings.forEach((opening) => {
        labelValue(
          `${opening.index}. ${opening.type}`,
          `${opening.width_m} m x ${opening.height_m} m, distance to floor ${opening.distance_to_floor_m} m`
        );
      });
    }
  });

  return doc;
}

processBtn.addEventListener('click', async () => {
  clearStatus();
  downloadPdfBtn.disabled = true;
  downloadJsonBtn.disabled = true;
  latestExtraction = null;

  const file = sourcePdfInput.files?.[0];
  if (!file) {
    setStatus('Please upload the report PDF before running the extraction.', 'warn');
    return;
  }

  processBtn.disabled = true;
  setStatus('Reading the report PDF and extracting the first-page summary...');

  try {
    const pdf = await readPdf(file);
    setStatus('Extracting room measurements, ventilation answers, and openings from the same PDF...');
    const extracted = extractReport(pdf);
    latestExtraction = extracted;
    renderPreview(extracted);
    setStatus(`Done. Extracted ${extracted.rooms.length} room entries for ${extracted.summary.report_name}. Review the preview, then download the Domna PDF or the JSON snapshot.`);
    downloadPdfBtn.disabled = false;
    downloadJsonBtn.disabled = false;
  } catch (error) {
    console.error(error);
    setStatus(`Extraction failed. ${error.message || error}`, 'error');
  } finally {
    processBtn.disabled = false;
  }
});

downloadPdfBtn.addEventListener('click', async () => {
  if (!latestExtraction) {
    return;
  }

  const doc = await buildSummaryPdf(latestExtraction);
  const blob = doc.output('blob');
  downloadBlob(blob, 'D1-Ventilation.pdf');
});

downloadJsonBtn.addEventListener('click', () => {
  if (!latestExtraction) {
    return;
  }

  const blob = new Blob([JSON.stringify(latestExtraction, null, 2)], { type: 'application/json' });
  downloadBlob(blob, 'D1-Ventilation.json');
});
