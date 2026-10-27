# SwiftPDF

Read, edit, fill and sign PDFs — one codebase that ships as a **Windows desktop app** (installer + Microsoft Store MSIX) and an **Android app**.

## Features

**Read** – continuous scroll, zoom (buttons, Ctrl+wheel, pinch), fit width, find in document (Ctrl+F), page thumbnails, password-protected PDFs, dark mode.

**Edit**
- Add text (fonts: Sans/Serif/Mono, any size and color, multi-line)
- Edit existing text – tap a line in the PDF and retype it
- Draw, highlight, rectangles, ellipses, lines
- White-out (cover anything with white)
- Insert images and today's date
- Select, move, delete anything you added; undo/redo

**Fill forms** – text boxes, checkboxes, radio buttons and dropdowns become real inputs; values are written into the PDF's form fields on save.

**Organize pages** – rotate, delete, reorder (drag thumbnails or ↑/↓), insert blank pages, insert/merge pages from another PDF, extract selected pages to a new PDF.

**Sign** – draw (mouse, finger or pen), type (script fonts) or upload a signature image (white background removed). Signatures are saved for next time.

**Desktop extras** – registers as a PDF handler ("Open with SwiftPDF"), drag-and-drop to open or merge, Save / Save As, warns about unsaved changes.
**Android extras** – opens PDFs from other apps ("Open with"), saves to `Documents/SwiftPDF`, Share button.

## Building (Build Tool / GitHub Actions)

The workflow `.github/workflows/build.yml` runs on manual trigger (`workflow_dispatch`), so the PC Build Tool can start it:

```
gh workflow run "Build SwiftPDF" -R yasmanyferrerm-source/SwiftPDF
```

Each run publishes a GitHub Release `v<version>-build<run>` with:

| File | Use |
|---|---|
| `SwiftPDF-Setup-<ver>.exe` | Windows installer |
| `SwiftPDF-Store-<ver>.appx` | Upload to Microsoft Partner Center |
| `SwiftPDF-<ver>.apk` | Install on Android (sideload) |
| `SwiftPDF-<ver>-release.apk/.aab` | Signed Play Store builds (only when signing secrets are set) |

Bump `version` in `package.json` for a new version.

### Microsoft Store
The MSIX uses publisher `CN=89A5A13E-7E4F-44CA-A558-D9E4282A4BD1` and identity `yasmanyfmSoft.SwiftPDF`. Reserve the name **SwiftPDF** in Partner Center; if the Package Identity Name it gives you differs, update `build.appx.identityName` in `package.json`.

### Google Play signing (optional)
Add these repository secrets to also get a signed release APK and AAB:
`ANDROID_KEYSTORE_BASE64` (base64 of the .jks), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

## Local development

```
npm install
npm run dev          # browser at http://localhost:5173
npm start            # build + run the desktop app
npm run dist:win     # Windows installer into release/ (run on Windows)
npm run android:prepare   # then open android/ in Android Studio
```

## How it works

- **pdf.js** renders pages, reads text and form fields.
- **pdf-lib** writes the output: form values, page order/rotation, and every annotation is drawn into the real page content.
- **Electron** wraps it for Windows; **Capacitor** wraps it for Android.

## Known limitations

- *Edit text* covers the original line with white and writes the new text on top using a standard font (Helvetica/Times/Courier picked to match). The look is close but not always identical, it assumes a white background, and the original words remain in the file underneath (hidden, but still findable by copy/search).
- Characters outside the Western European set can't be written with the built-in fonts and become `?`.
- When pages are reordered, deleted or merged, filled form fields are flattened (made permanent) in the saved file. Without page changes, forms stay editable.
- PDFs with an owner/permissions password are saved with their pages as images.
- Signatures are visual (drawn/typed/image), not certificate-based digital signatures.
