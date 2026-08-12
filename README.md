# ⛽ Fuel Tracker — PWA

A simple, clean, mobile-friendly **Fuel Tracker** Progressive Web App (PWA) built with HTML, CSS, and vanilla JavaScript. Track your fuel consumption, mileage, and expenses for Petrol and CNG vehicles — all data stays on your device.

> **Live Demo**: Deploy this repo to GitHub Pages and use it from any device!

---

## ✨ Features

- **Add, Edit, Delete** fuel entries
- **Fuel Types**: Petrol (litres) & CNG (kg)
- **Vehicle Types**: Car & Bike
- **Auto Average**: Calculates `km/L` or `km/kg` in real-time as you type
- **Summary Stats**: Total KM, fuel consumed, amount spent, overall mileage
- **History**: Filterable table (desktop) + responsive cards (mobile)
- **Dark / Light Theme** with persistent preference
- **Export** data as JSON or CSV
- **Import** data from a JSON backup
- **Offline Support** via Service Worker
- **Installable PWA** — add to home screen on any device
- **No backend required** — works entirely in the browser

---

## 📂 Project Structure

```
fuel-tracker/
├── index.html          # Main page
├── style.css           # Styles & design system
├── app.js              # Application logic
├── manifest.json       # PWA manifest
├── service-worker.js   # Offline caching
├── README.md
└── icons/
    ├── favicon.svg
    ├── icon-192.png
    └── icon-512.png
```

---

## 🚀 Run Locally

No build tools needed — just open the file in a browser:

### Option 1: Direct Open
Simply double-click `index.html` to open it in your browser.

> **Note**: Some PWA features (service worker, manifest) require serving over HTTP.

### Option 2: Local Server (recommended)
Use any simple HTTP server:

```bash
# Python 3
python -m http.server 8000

# Node.js (npx)
npx serve .

# VS Code
# Install "Live Server" extension, right-click index.html → "Open with Live Server"
```

Then open [http://localhost:8000](http://localhost:8000)

---

## 🌐 Deploy on GitHub Pages

1. **Create a GitHub repository** (e.g., `fuel-tracker`)

2. **Push the code**:
   ```bash
   git init
   git add .
   git commit -m "Initial commit - Fuel Tracker PWA"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/fuel-tracker.git
   git push -u origin main
   ```

3. **Enable GitHub Pages**:
   - Go to **Settings** → **Pages**
   - Under **Source**, select `main` branch and `/ (root)` folder
   - Click **Save**

4. Your app will be live at:
   ```
   https://YOUR_USERNAME.github.io/fuel-tracker/
   ```

---

## 💾 How Data Storage Works

| Feature | Details |
|---------|---------|
| **Primary Storage** | IndexedDB (browser database) |
| **Fallback** | localStorage (if IndexedDB is unavailable) |
| **Persistence** | Data survives page refreshes and browser restarts |
| **Privacy** | All data stays on YOUR device — nothing is sent to any server |
| **Backup** | Export to JSON/CSV anytime from the "Data Management" section |
| **Restore** | Import a previously exported JSON file to restore data |
| **Clearing** | Use "Clear All" to remove all entries |

> ⚠️ Clearing browser data (cookies/cache) will also clear your fuel history. Use the **Export** feature regularly to keep backups!

---

## 📱 Install as a PWA

### On Mobile (Chrome / Safari):
1. Open the app URL in your browser
2. Tap the **"Add to Home Screen"** prompt (or use the browser menu → "Install App")
3. The app appears on your home screen like a native app

### On Desktop (Chrome / Edge):
1. Open the app URL
2. Click the **install icon** (⊕) in the address bar
3. Click **"Install"**

Once installed, the app works **offline** — no internet required after the first visit.

---

## 🛠️ Tech Stack

- **HTML5** — semantic structure
- **CSS3** — custom properties, grid, flexbox, glassmorphism
- **Vanilla JavaScript** — zero dependencies
- **IndexedDB** — client-side database
- **Service Worker** — offline caching (stale-while-revalidate)
- **Web App Manifest** — PWA installability

---

## 📄 License

MIT — free to use, modify, and distribute.
