# LUME Inventory v7 — Professional Stock Management

Internal stock app for **Mediouna (Central Hub)** and **Socrate Hub**.

## Quick start (Option A — Local / VS Code)

1. Open this folder in VS Code
2. Install **Live Server** extension (or use any static server)
3. Right-click `index.html` → **Open with Live Server**
4. Login:
   - Email: `mehdi@lume.ma`
   - Password: `Belfattah0016`

> **Important:** Use `http://localhost` (Live Server), not `file://` — password hashing requires a secure context.

## File structure

```
lume_inventory/
├── index.html          # App shell + modals
├── styles.css          # LUME black/white UI
├── app.js              # Full application logic
├── products-data.js    # Master catalog (170 products)
├── README.md
└── supabase/
    ├── schema.sql      # Option B database schema
    └── MIGRATION.md    # Team deployment plan
```

## Features

- Products from `products-data.js` merged with local stock by SKU
- Safe localStorage (never crashes on corrupted data)
- Admin: receive, transfer, adjust, BL bulk receive, create/edit/soft-delete/restore
- Sales: sell from Socrate only
- Full movement history with filters + CSV export
- Export/import JSON backup + export current stock CSV
- Visual product scan search
- Role-based UI (admin vs sales)

## Data safety

- Products are **never overwritten** on startup — only merged by SKU
- Corrupted localStorage keys recover gracefully
- Auto backup before storage migration
- Soft-delete preserves stock in archive for restore

## GitHub upload

```bash
cd lume_inventory_v6_1_csv_data_linked_fixed
git init
git add index.html styles.css app.js products-data.js README.md supabase/
git commit -m "LUME Inventory v7 — safe storage rebuild"
git branch -M main
git remote add origin https://github.com/YOUR_USER/lume-inventory.git
git push -u origin main
```

Enable **GitHub Pages**: Settings → Pages → Source: `main` branch → `/ (root)`.

## Option B — Team version (Supabase)

See `supabase/schema.sql` and `supabase/MIGRATION.md` for:
- Database tables + RLS policies
- Shared stock for all team members
- Real authentication and roles
- Migration from localStorage

## QA checklist

| # | Test | Expected |
|---|---|---|
| 1 | Fresh browser, empty localStorage | 170 products load |
| 2 | Set `lume_inventory_deleted_products_v6_clean` = `null` | No crash |
| 3 | Set products key = `null` | No crash, catalog loads |
| 4 | Login | Workspace opens |
| 5 | Products appear | Grid renders |
| 6 | Search | Filters instantly |
| 7 | Product modal | Opens with stock |
| 8 | Sale from Socrate | Socrate qty decreases only |
| 9 | Sale > Socrate stock | Blocked with error |
| 10 | Receive stock | Hub qty increases |
| 11 | Transfer M→S | Mediouna down, Socrate up |
| 12 | Transfer > Mediouna | Blocked |
| 13 | Adjustment | Replaces hub qty |
| 14 | History | Before/after recorded |
| 15 | Export backup | JSON downloads |
| 16 | Import backup | Data restored |
| 17 | Custom product | Survives reload |
| 18 | Soft-delete + restore | Hidden then back |
| 19 | Sales user | Admin UI hidden |
| 20 | Normal use | No console errors |
