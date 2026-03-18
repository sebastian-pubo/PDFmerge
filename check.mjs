
    import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.mjs';
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.mjs';

    const statusEl = document.getElementById('status');
    const processBtn = document.getElementById('processBtn');
    const downloadPdfBtn = document.getElementById('downloadPdfBtn');
    const downloadJsonBtn = document.getElementById('downloadJsonBtn');
    const pdf1Input = document.getElementById('pdf1');
    const pdf2Input = document.getElementById('pdf2');
    const propertyGrid = document.getElementById('propertyGrid');
    const roomsWrap = document.getElementById('roomsWrap');
    const preview = document.getElementById('preview');
    const previewEmpty = document.getElementById('previewEmpty');
    const matchSummary = document.getElementById('matchSummary');
    const jsonPreview = document.getElementById('jsonPreview');
    const reportTitleInput = document.getElementById('reportTitle');
    const reportSubtitleInput = document.getElementById('reportSubtitle');

    let latestMerged = null;

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
        .replace(/[\u00A0]/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    function slugifyRoomName(name) {
      return String(name || '')
        .toLowerCase()
        .replace(/\(.*?\)/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function titleCase(value) {
      return String(value || '').toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
    }

    function escapeRegExp(value) {
      return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function maybeNumber(value) {
      const match = String(value || '').match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : null;
    }

    function asLineValue(lines, idx, label) {
      const line = lines[idx] || '';
      if (!line.startsWith(label)) return null;
      const trailing = line.slice(label.length).trim();
      if (trailing) return trailing;
      for (let i = idx + 1; i < lines.length; i += 1) {
        const candidate = (lines[i] || '').trim();
        if (!candidate) continue;
        if (/^Photo\b/i.test(candidate)) continue;
        if (/^Please add location/i.test(candidate)) continue;
        if (/^Input trickle vent/i.test(candidate)) continue;
        return candidate;
      }
      return null;
    }

    function findField(lines, labels) {
      const variants = Array.isArray(labels) ? labels : [labels];
      for (let i = 0; i < lines.length; i += 1) {
        const line = (lines[i] || '').trim();
        for (const label of variants) {
          if (Array.isArray(label)) {
            const joined = label.map((_, offset) => (lines[i + offset] || '').trim()).join(' ');
            const target = label.join(' ');
            if (joined === target) {
              return asLineValue(lines, i + label.length - 1, label[label.length - 1]);
            }
          } else if (line.startsWith(label)) {
            return asLineValue(lines, i, label);
          }
        }
      }
      return null;
    }

    function uniqueRoomLabel(baseName, count) {
      if (count <= 1) return baseName;
      return `${baseName} ${count}`;
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
        fullText: normalizeSpaces(pages.map((p) => p.text).join('\n\n'))
      };
    }

    function parsePdf1(pdf) {
      const property = {
        source_file: pdf.name,
        total_area_m2: null,
        floors: null,
        submitted_by: null,
        created_on: null,
        property_title: null,
        raw_location: null
      };

      const firstPageText = pdf.pages[0]?.text || '';
      property.property_title = (firstPageText.match(/^(.+?)\n/) || [null, null])[1] || null;
      property.submitted_by = (firstPageText.match(/SUBMITTED BY\n([^\n]+)/i) || [null, null])[1] || null;
      property.created_on = (firstPageText.match(/CREATED ON\n([^\n]+)/i) || [null, null])[1] || null;
      property.raw_location = (firstPageText.match(/LOCATION\n([\s\S]*?)\nTotal area/i) || [null, null])[1] || null;
      property.total_area_m2 = (pdf.fullText.match(/TOTAL AREA:\s*([\d.]+)\s*m²/i) || [null, null])[1] || null;
      property.floors = (pdf.fullText.match(/FLOORS:\s*(\d+)/i) || [null, null])[1] || null;

      const rooms = [];
      const duplicateCounter = {};

      for (const page of pdf.pages) {
        const roomMatch = page.text.match(/▼\s*([^\n\/]+)\n([^\n]+Floor)\nWIDTH:\s*([\d.]+)\s*m\s*•\s*LENGTH:\s*([\d.]+)\s*m\s*•\s*CEILING HEIGHT:\s*([\d.]+)\s*m\nAREA:\s*([\d.]+)\s*m²\s*•\s*PERIMETER:\s*([\d.]+)\s*m/i);
        if (!roomMatch) continue;

        const baseName = normalizeSpaces(roomMatch[1]);
        duplicateCounter[baseName] = (duplicateCounter[baseName] || 0) + 1;
        const displayName = uniqueRoomLabel(baseName, duplicateCounter[baseName]);
        const floor = normalizeSpaces(roomMatch[2]);
        const detailStartMatch = page.text.match(new RegExp(`▼\\s*${escapeRegExp(baseName)}\\/${escapeRegExp(floor)}\\n([\\s\\S]*?)THIS FLOOR PLAN`, 'i'));
        const detailsText = detailStartMatch ? detailStartMatch[1].trim() : '';

        let notes = null;
        if (/^Notes\n/i.test(detailsText)) {
          const notesMatch = detailsText.match(/^Notes\n([\s\S]*?)(?=\n\d+\s+[A-Z ]+\nDimensions|$)/i);
          notes = notesMatch ? normalizeSpaces(notesMatch[1]) : null;
        }

        const openingRegex = /(\d+)\s+([A-Z ]+)\nDimensions\n([\d.]+)\s*m\s*x\s*([\d.]+)\s*m\s*\(Width x Height\)\nDistance to Floor\n([\d.]+)\s*m/gi;
        const openings = [];
        let openingMatch;
        while ((openingMatch = openingRegex.exec(detailsText)) !== null) {
          openings.push({
            index: Number(openingMatch[1]),
            type: titleCase(normalizeSpaces(openingMatch[2])),
            width_m: Number(openingMatch[3]),
            height_m: Number(openingMatch[4]),
            distance_to_floor_m: Number(openingMatch[5])
          });
        }

        rooms.push({
          source: 'pdf1',
          base_name: baseName,
          room_name: displayName,
          floor,
          width_m: Number(roomMatch[3]),
          length_m: Number(roomMatch[4]),
          ceiling_height_m: Number(roomMatch[5]),
          area_m2: Number(roomMatch[6]),
          perimeter_m: Number(roomMatch[7]),
          notes,
          openings,
          match_key: slugifyRoomName(displayName),
          base_match_key: slugifyRoomName(baseName)
        });
      }

      return { property, rooms };
    }

    function parsePropertyDetailsPdf2(pdf) {
      const introText = pdf.pages.slice(0, 3).map((p) => p.text).join('\n\n');
      const lines = normalizeSpaces(introText).split('\n').map((line) => line.trim()).filter(Boolean);
      return {
        source_file: pdf.name,
        property_address: findField(lines, 'Property Address') || null,
        postcode: findField(lines, 'Postcode') || null,
        assessor_name_id: findField(lines, 'Assessor Name & ID') || null,
        inspection_date: findField(lines, 'Inspection Date') || null,
        house_type: findField(lines, 'House Type') || null,
        classification_type: findField(lines, 'Classification Type') || null,
        orientation_front: findField(lines, 'Orientation (front elevation)') || null,
        orientation_degrees: findField(lines, 'Orientation in degrees (front elevation)') || null,
        exposure_zone: findField(lines, 'Exposure Zone') || null,
        main_wall_construction: findField(lines, 'Main Wall Construction') || null,
        cavity_wall_depth_mm: findField(lines, 'Cavity wall depth (in mm)') || null,
        insulation_present: findField(lines, 'Is insulation present?') || null,
        insulation_type: findField(lines, 'Insulation type') || null,
        floor_type: findField(lines, 'Floor Type (Picture of airbricks if suspended timber is selected)') || null,
        material_type: findField(lines, 'Material Type') || null
      };
    }

    function isRoomHeader(line, nextLine = '') {
      const trimmed = (line || '').trim();
      const next = (nextLine || '').trim();
      const match = trimmed.match(/^(Hallway|Living Room|Kitchen|Laundry Room|Bedroom(?:\s+\d+)?|Bathroom(?:\s+\d+)?)\s+\d+\s*\/\s*\d+/i);
      if (!match) return false;
      const base = match[1].toLowerCase();
      if ((base === 'bedroom' || base === 'bathroom') && new RegExp(`^${match[1]}\\s+\\d+\\s+\\d+\\s*\\/\\s*\\d+`, 'i').test(next)) {
        return false;
      }
      return true;
    }

    function cleanBlockLines(lines) {
      return lines.map((line) => normalizeSpaces(line)).filter(Boolean);
    }

    function parseRoomBlock(header, blockLines) {
      const cleanLines = cleanBlockLines(blockLines);
      const roomName = normalizeSpaces(header.replace(/\s+\d+\s*\/\s*\d+.*$/, ''));
      const room = {
        source: 'pdf2',
        room_name: roomName,
        match_key: slugifyRoomName(roomName),
        base_match_key: slugifyRoomName(roomName.replace(/\s+\d+$/, '')),
        is_ensuite: findField(cleanLines, 'Is this an ensuite bathroom?'),
        bedroom_type: findField(cleanLines, 'Double or Single Bedroom?'),
        overall_condition: findField(cleanLines, 'Overall condition of the room'),
        defects: findField(cleanLines, 'Does the room have any defects? (ie. moisture damage, cracking in walls, etc.)'),
        has_windows: findField(cleanLines, 'Does the room have any windows?'),
        window_condition: findField(cleanLines, 'Condition of the windows'),
        has_trickle_vents: findField(cleanLines, 'Do the windows have trickle vents?'),
        trickle_vent_size_mm2: findField(cleanLines, 'Size of the trickle vents mm2'),
        windows_openable: findField(cleanLines, 'Are the windows openable?'),
        opening_type: findField(cleanLines, 'Specify opening type'),
        effective_opening_area_width: findField(cleanLines, 'Effective opening area width'),
        effective_opening_area_height: findField(cleanLines, 'Effective opening area width height'),
        ventilation_system: findField(cleanLines, 'Is there a ventilation system present in the room?'),
        ventilation_working: findField(cleanLines, 'Is the ventilation system in good working order?'),
        fan_background_distance_ok: findField(cleanLines, [['Are fans and background ventilators in the same room at', 'least 0.5m apart?'], 'Are fans and background ventilators in the same room at least 0.5m apart?']),
        extract_rate_measured: findField(cleanLines, 'Extract ventilation rate measured (mandatory)'),
        duct_diameter: findField(cleanLines, 'Duct diameter'),
        damp_mould_condensation: findField(cleanLines, [['Are there any visible or reported signs of damp, mould or', 'excessive condensation within the room?'], 'Are there any visible or reported signs of damp, mould or excessive condensation within the room?']),
        door_undercut_value: findField(cleanLines, 'Door undercut value (mandatory)'),
        open_flue_heating_appliance: findField(cleanLines, 'Is there any open flue heating appliances within the room?')
      };
      return room;
    }

    function parsePdf2(pdf) {
      const property = parsePropertyDetailsPdf2(pdf);
      const lines = pdf.pages.slice(4).flatMap((page) => page.lines.map((line) => line.trim()));
      const blocks = [];

      let currentHeader = null;
      let currentLines = [];
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const next = lines[i + 1] || '';
        if (isRoomHeader(line, next)) {
          if (currentHeader) blocks.push({ header: currentHeader, lines: currentLines });
          currentHeader = line;
          currentLines = [];
          continue;
        }
        if (currentHeader) currentLines.push(line);
      }
      if (currentHeader) blocks.push({ header: currentHeader, lines: currentLines });

      const rooms = blocks.map((block) => parseRoomBlock(block.header, block.lines));
      return { property, rooms };
    }

    function mergeData(pdf1Data, pdf2Data) {
      const mergedProperty = {
        property_address: pdf2Data.property.property_address || pdf1Data.property.property_title || null,
        postcode: pdf2Data.property.postcode || null,
        assessor_name_id: pdf2Data.property.assessor_name_id || null,
        inspection_date: pdf2Data.property.inspection_date || null,
        house_type: pdf2Data.property.house_type || null,
        classification_type: pdf2Data.property.classification_type || null,
        orientation_front: pdf2Data.property.orientation_front || null,
        orientation_degrees: pdf2Data.property.orientation_degrees || null,
        exposure_zone: pdf2Data.property.exposure_zone || null,
        main_wall_construction: pdf2Data.property.main_wall_construction || null,
        cavity_wall_depth_mm: pdf2Data.property.cavity_wall_depth_mm || null,
        insulation_present: pdf2Data.property.insulation_present || null,
        insulation_type: pdf2Data.property.insulation_type || null,
        floor_type: pdf2Data.property.floor_type || null,
        material_type: pdf2Data.property.material_type || null,
        total_area_m2: pdf1Data.property.total_area_m2 || null,
        floors: pdf1Data.property.floors || null,
        source_pdf1: pdf1Data.property.source_file,
        source_pdf2: pdf2Data.property.source_file
      };

      const pdf1Rooms = pdf1Data.rooms.map((room) => ({ ...room }));
      const unmatchedPdf2 = [];
      const matchLog = [];
      const usedPdf1Indexes = new Set();

      function findPdf1Index(pdf2Room) {
        let index = pdf1Rooms.findIndex((room, i) => !usedPdf1Indexes.has(i) && room.match_key === pdf2Room.match_key);
        if (index >= 0) return index;
        index = pdf1Rooms.findIndex((room, i) => !usedPdf1Indexes.has(i) && room.base_match_key === pdf2Room.base_match_key);
        return index;
      }

      for (const room2 of pdf2Data.rooms) {
        const idx = findPdf1Index(room2);
        if (idx < 0) {
          unmatchedPdf2.push(room2);
          matchLog.push(`Unmatched PDF 2 room: ${room2.room_name}`);
          continue;
        }
        usedPdf1Indexes.add(idx);
        const room1 = pdf1Rooms[idx];
        matchLog.push(`Matched ${room2.room_name} -> ${room1.room_name} (${room1.floor})`);
        room1.condition_data = { ...room2 };
      }

      const mergedRooms = pdf1Rooms.map((room) => ({
        ...room,
        condition_data: room.condition_data || null,
        matched: Boolean(room.condition_data)
      }));

      return {
        property: mergedProperty,
        rooms: mergedRooms,
        unmatched_pdf2_rooms: unmatchedPdf2,
        match_log: matchLog
      };
    }

    function renderPreview(data) {
      preview.style.display = 'block';
      previewEmpty.style.display = 'none';
      propertyGrid.innerHTML = '';
      roomsWrap.innerHTML = '';

      const propertyOrder = [
        ['Property address', data.property.property_address],
        ['Postcode', data.property.postcode],
        ['Assessor', data.property.assessor_name_id],
        ['Inspection date', data.property.inspection_date],
        ['House type', data.property.house_type],
        ['Classification', data.property.classification_type],
        ['Orientation', data.property.orientation_front],
        ['Orientation degrees', data.property.orientation_degrees],
        ['Exposure zone', data.property.exposure_zone],
        ['Main wall construction', data.property.main_wall_construction],
        ['Cavity wall depth', data.property.cavity_wall_depth_mm],
        ['Insulation present', data.property.insulation_present],
        ['Insulation type', data.property.insulation_type],
        ['Floor type', data.property.floor_type],
        ['Material type', data.property.material_type],
        ['Total area', data.property.total_area_m2 ? `${data.property.total_area_m2} m²` : null],
        ['Floors', data.property.floors]
      ];

      propertyOrder.forEach(([key, value]) => {
        const div = document.createElement('div');
        div.className = 'kv';
        div.innerHTML = `<div class="k">${key}</div><div class="v">${value || '-'}</div>`;
        propertyGrid.appendChild(div);
      });

      data.rooms.forEach((room) => {
        const card = document.createElement('div');
        card.className = 'room-card';
        const openingsHtml = room.openings.length
          ? room.openings.map((opening) => `
              <div class="opening">
                <strong>${opening.type}</strong><br>
                ${opening.width_m} m x ${opening.height_m} m<br>
                Distance to floor: ${opening.distance_to_floor_m} m
              </div>
            `).join('')
          : '<div class="mini">No openings extracted.</div>';

        const c = room.condition_data || {};
        const facts = [
          ['Floor', room.floor],
          ['Width', room.width_m ? `${room.width_m} m` : null],
          ['Length', room.length_m ? `${room.length_m} m` : null],
          ['Ceiling height', room.ceiling_height_m ? `${room.ceiling_height_m} m` : null],
          ['Area', room.area_m2 ? `${room.area_m2} m²` : null],
          ['Perimeter', room.perimeter_m ? `${room.perimeter_m} m` : null],
          ['Notes', room.notes],
          ['Overall condition', c.overall_condition],
          ['Defects', c.defects],
          ['Has windows', c.has_windows],
          ['Window condition', c.window_condition],
          ['Trickle vents', c.has_trickle_vents],
          ['Trickle vent size', c.trickle_vent_size_mm2],
          ['Windows openable', c.windows_openable],
          ['Ventilation system', c.ventilation_system],
          ['Ventilation working', c.ventilation_working],
          ['Extract rate', c.extract_rate_measured],
          ['Duct diameter', c.duct_diameter],
          ['Damp / mould / condensation', c.damp_mould_condensation],
          ['Door undercut', c.door_undercut_value]
        ];

        card.innerHTML = `
          <div class="room-head">
            <div>
              <h3>${room.room_name}</h3>
              <div class="sub">${room.matched ? 'Matched with PDF 2 room data' : 'No PDF 2 room match found'}</div>
            </div>
            <div class="sub">${room.floor || '-'}</div>
          </div>
          <div class="facts">
            ${facts.map(([label, value]) => `<div class="fact"><b>${label}</b>${value || '-'}</div>`).join('')}
          </div>
          <div>
            <div class="section-title" style="font-size:14px;margin-bottom:8px;">Openings</div>
            ${openingsHtml}
          </div>
        `;
        roomsWrap.appendChild(card);
      });

      matchSummary.textContent = data.match_log.join('\n') + (data.unmatched_pdf2_rooms.length ? `\n\nUnmatched PDF 2 rooms:\n${data.unmatched_pdf2_rooms.map((room) => `- ${room.room_name}`).join('\n')}` : '');
      jsonPreview.textContent = JSON.stringify(data, null, 2);
    }

    function downloadBlob(blob, fileName) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }

    function buildSummaryPdf(data) {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const margin = 15;
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const contentWidth = pageWidth - margin * 2;
      let y = margin;

      const title = reportTitleInput.value.trim() || 'Merged Property Room Summary';
      const subtitle = reportSubtitleInput.value.trim() || '';

      function addPageIfNeeded(required = 12) {
        if (y + required > pageHeight - margin) {
          doc.addPage();
          y = margin;
        }
      }

      function line(text, opts = {}) {
        const { size = 10, bold = false, color = [31, 41, 55], indent = 0 } = opts;
        doc.setFont('helvetica', bold ? 'bold' : 'normal');
        doc.setFontSize(size);
        doc.setTextColor(...color);
        const lines = doc.splitTextToSize(text || '-', contentWidth - indent);
        addPageIfNeeded(lines.length * (size * 0.45 + 1));
        doc.text(lines, margin + indent, y);
        y += lines.length * (size * 0.45 + 1) + 1.2;
      }

      function divider() {
        addPageIfNeeded(4);
        doc.setDrawColor(205, 213, 225);
        doc.line(margin, y, pageWidth - margin, y);
        y += 4;
      }

      function labelValue(label, value) {
        const labelText = `${label}: `;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(55, 65, 81);
        const labelWidth = doc.getTextWidth(labelText);
        const lines = doc.splitTextToSize(String(value || '-'), contentWidth - labelWidth);
        addPageIfNeeded(lines.length * 5 + 2);
        doc.text(labelText, margin, y);
        doc.setFont('helvetica', 'normal');
        doc.text(lines, margin + labelWidth, y);
        y += lines.length * 5 + 1;
      }

      doc.setFillColor(234, 242, 255);
      doc.roundedRect(margin, y, contentWidth, 24, 3, 3, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(18);
      doc.setTextColor(31, 79, 143);
      doc.text(title, margin + 5, y + 8);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10);
      doc.setTextColor(55, 65, 81);
      const subtitleLines = doc.splitTextToSize(subtitle || 'Generated summary', contentWidth - 10);
      doc.text(subtitleLines, margin + 5, y + 14);
      y += 30;

      line('Property details', { size: 14, bold: true, color: [17, 24, 39] });
      [
        ['Property address', data.property.property_address],
        ['Postcode', data.property.postcode],
        ['Assessor', data.property.assessor_name_id],
        ['Inspection date', data.property.inspection_date],
        ['House type', data.property.house_type],
        ['Classification type', data.property.classification_type],
        ['Orientation', data.property.orientation_front],
        ['Orientation degrees', data.property.orientation_degrees],
        ['Exposure zone', data.property.exposure_zone],
        ['Main wall construction', data.property.main_wall_construction],
        ['Cavity wall depth', data.property.cavity_wall_depth_mm],
        ['Insulation present', data.property.insulation_present],
        ['Insulation type', data.property.insulation_type],
        ['Floor type', data.property.floor_type],
        ['Material type', data.property.material_type],
        ['Total area', data.property.total_area_m2 ? `${data.property.total_area_m2} m²` : null],
        ['Floors', data.property.floors]
      ].forEach(([label, value]) => labelValue(label, value));

      divider();
      line('Room summaries', { size: 14, bold: true, color: [17, 24, 39] });

      data.rooms.forEach((room, idx) => {
        addPageIfNeeded(25);
        if (idx > 0) divider();
        line(room.room_name, { size: 12, bold: true, color: [31, 79, 143] });
        labelValue('Floor', room.floor);
        labelValue('Width', room.width_m ? `${room.width_m} m` : null);
        labelValue('Length', room.length_m ? `${room.length_m} m` : null);
        labelValue('Ceiling height', room.ceiling_height_m ? `${room.ceiling_height_m} m` : null);
        labelValue('Area', room.area_m2 ? `${room.area_m2} m²` : null);
        labelValue('Perimeter', room.perimeter_m ? `${room.perimeter_m} m` : null);
        labelValue('Notes', room.notes);

        line('Openings', { size: 11, bold: true, color: [17, 24, 39] });
        if (room.openings.length) {
          room.openings.forEach((opening) => {
            labelValue(opening.type, `${opening.width_m} m x ${opening.height_m} m; distance to floor ${opening.distance_to_floor_m} m`);
          });
        } else {
          labelValue('Openings', 'None extracted');
        }

        const c = room.condition_data || {};
        line('Condition and ventilation', { size: 11, bold: true, color: [17, 24, 39] });
        [
          ['Ensuite bathroom', c.is_ensuite],
          ['Bedroom type', c.bedroom_type],
          ['Overall condition', c.overall_condition],
          ['Defects', c.defects],
          ['Has windows', c.has_windows],
          ['Window condition', c.window_condition],
          ['Trickle vents', c.has_trickle_vents],
          ['Trickle vent size', c.trickle_vent_size_mm2],
          ['Windows openable', c.windows_openable],
          ['Opening type', c.opening_type],
          ['Effective opening area width', c.effective_opening_area_width],
          ['Effective opening area height', c.effective_opening_area_height],
          ['Ventilation system', c.ventilation_system],
          ['Ventilation working', c.ventilation_working],
          ['Fans and background vents 0.5 m apart', c.fan_background_distance_ok],
          ['Extract rate measured', c.extract_rate_measured],
          ['Duct diameter', c.duct_diameter],
          ['Damp / mould / excessive condensation', c.damp_mould_condensation],
          ['Door undercut', c.door_undercut_value],
          ['Open flue heating appliance', c.open_flue_heating_appliance]
        ].forEach(([label, value]) => {
          if (value) labelValue(label, value);
        });
      });

      return doc;
    }

    processBtn.addEventListener('click', async () => {
      clearStatus();
      downloadPdfBtn.disabled = true;
      downloadJsonBtn.disabled = true;
      latestMerged = null;

      const file1 = pdf1Input.files?.[0];
      const file2 = pdf2Input.files?.[0];
      if (!file1 || !file2) {
        setStatus('Please upload both PDFs before running the extraction.', 'warn');
        return;
      }

      processBtn.disabled = true;
      setStatus('Reading PDFs and extracting text...');

      try {
        const [pdf1, pdf2] = await Promise.all([readPdf(file1), readPdf(file2)]);
        setStatus('Parsing PDF 1 room geometry and PDF 2 room condition data...');
        const pdf1Data = parsePdf1(pdf1);
        const pdf2Data = parsePdf2(pdf2);
        const merged = mergeData(pdf1Data, pdf2Data);
        latestMerged = merged;
        renderPreview(merged);

        const matchedCount = merged.rooms.filter((room) => room.matched).length;
        const totalRooms = merged.rooms.length;
        const unmatchedCount = merged.unmatched_pdf2_rooms.length;
        setStatus(`Done. Parsed ${totalRooms} PDF 1 rooms, matched ${matchedCount}, unmatched PDF 2 rooms ${unmatchedCount}. Review the preview and then download the summary PDF.`);
        downloadPdfBtn.disabled = false;
        downloadJsonBtn.disabled = false;
      } catch (error) {
        console.error(error);
        setStatus(`Extraction failed. ${error.message || error}`, 'error');
      } finally {
        processBtn.disabled = false;
      }
    });

    downloadPdfBtn.addEventListener('click', () => {
      if (!latestMerged) return;
      const doc = buildSummaryPdf(latestMerged);
      const blob = doc.output('blob');
      downloadBlob(blob, 'merged-property-room-summary.pdf');
    });

    downloadJsonBtn.addEventListener('click', () => {
      if (!latestMerged) return;
      const blob = new Blob([JSON.stringify(latestMerged, null, 2)], { type: 'application/json' });
      downloadBlob(blob, 'merged-property-room-summary.json');
    });
  