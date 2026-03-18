# PDF Room Summary Builder

Static browser app for merging two PDF sources into one summary PDF.

## Inputs

- **PDF 1**: floor plan / room geometry / openings
- **PDF 2**: condition report / ventilation assessment

## Current parsing rules

- Property details come from **PDF 2**.
- The **location block in PDF 2 is ignored**.
- Total room counters are ignored.
- Room geometry, notes, doors, windows, and distance to floor come from **PDF 1**.
- Room condition and ventilation data come from **PDF 2**.
- Duplicate bedrooms are matched by order: first bedroom in PDF 1 -> Bedroom 1 in PDF 2, second bedroom in PDF 1 -> Bedroom 2 in PDF 2.

## Deploy on Vercel

1. Create a GitHub repo.
2. Upload `index.html` and this `README.md`.
3. Import the repo into Vercel.
4. Deploy as a static site.

No build step is required for this version.

## Notes

This is a first-pass parser based on the supplied sample PDFs. If the supplier changes labels or page structure, extend the parser in `index.html` rather than replacing the entire app.
