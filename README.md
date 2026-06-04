# Asset ID Media Browser

A drone inspection image-to-pole matching tool built with React, TypeScript, Vite and Leaflet.

## Features

- Upload detections CSV, poles GeoJSON, and Autofly mission logs
- Automatic image-to-pole joining using haversine GPS distances
- Waypoint segmentation matching when flight logs include waypoint events
- Red image markers on the map for selected asset
- Unassigned images workflow with 3-candidate pole suggestion and manual override
- Enriched GeoJSON export with detection counts per pole
- Dark theme UI with left asset list, map centre, right detail pane

## Getting started

```bash
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

## Data inputs

| File | Format | Purpose |
|------|--------|---------|
| Detections CSV | `.csv` | Rows with filename, lat, lon, annotation-type, download-url |
| Poles GeoJSON | `.geojson` | FeatureCollection of pole points with Plant_ID / name properties |
| Mission logs | `.json` | Autofly flight record JSON files (one per mission, multi-select) |
